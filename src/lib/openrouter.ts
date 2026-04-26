/**
 * openrouter.ts
 *
 * Thin wrapper around the OpenRouter API.
 * All AI calls in scripts and workflows go through here.
 *
 * Used by:
 *   - src/scripts/daily-email-summary.ts  → callOpenRouter, extractActionItems
 *   - src/scripts/weekly-review.ts        → callOpenRouter
 *   - src/workflows/sunday-planning.ts    → callOpenRouter
 *
 * Model:
 *   Default: google/gemini-2.0-flash-exp:free
 *   Override globally via OPENROUTER_MODEL env var, or per-call via options.model.
 *
 * Rate limiting:
 *   Free models have tight per-minute limits. 429s are retried with
 *   exponential backoff. Callers should also add deliberate delays
 *   between sequential calls (see INTER_CALL_DELAY_MS in scripts).
 *
 * Docs: https://openrouter.ai/docs
 */

import * as dotenv from "dotenv";
dotenv.config();

// ── Types ──────────────────────────────────────────────────────────────────

export interface OpenRouterOptions {
  /** System prompt to set context/persona for the call. */
  systemPrompt?: string;
  /** Max tokens to generate. Default: 500. */
  maxTokens?: number;
  /** Temperature 0–1. Lower = more deterministic. Default: 0.3. */
  temperature?: number;
  /** Model override. Falls back to OPENROUTER_MODEL env, then DEFAULT_MODEL. */
  model?: string;
}

export interface OpenRouterMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

// ── Constants ──────────────────────────────────────────────────────────────

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1/chat/completions";

// Best free model available — strong quality, good rate limits for free tier.
// Change via OPENROUTER_MODEL in .env if you want to swap without touching code.
const DEFAULT_MODEL = "google/gemini-2.0-flash-exp:free";

// Retry config for 429 responses
const MAX_RETRIES = 4;
const BASE_BACKOFF_MS = 5000; // 5s, 10s, 20s, 40s — generous for free tier limits

const APP_TITLE = "NOVA MCP";
const APP_URL   = "https://github.com/nova-mcp";

// ── Helpers ────────────────────────────────────────────────────────────────

function getApiKey(): string {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    throw new Error(
      "OPENROUTER_API_KEY is not set.\n" +
      "Add it to your .env file:\n" +
      "  OPENROUTER_API_KEY=sk-or-v1-..."
    );
  }
  return key;
}

function resolveModel(override?: string): string {
  return override ?? process.env.OPENROUTER_MODEL ?? DEFAULT_MODEL;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Core call ──────────────────────────────────────────────────────────────

/**
 * Makes a completion call to OpenRouter.
 * Retries on 429 with exponential backoff — important for free tier models.
 *
 * @param userContent  The user message — raw text, email dumps, context blocks, etc.
 * @param options      Optional system prompt, model, token, temperature overrides.
 * @returns            The assistant's reply as a plain string.
 */
export async function callOpenRouter(
  userContent: string,
  options: OpenRouterOptions = {}
): Promise<string> {
  const apiKey = getApiKey();
  const model  = resolveModel(options.model);

  const messages: OpenRouterMessage[] = [];
  if (options.systemPrompt) {
    messages.push({ role: "system", content: options.systemPrompt });
  }
  messages.push({ role: "user", content: userContent });

  const body = {
    model,
    messages,
    max_tokens:  options.maxTokens  ?? 500,
    temperature: options.temperature ?? 0.3,
  };

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const backoff = BASE_BACKOFF_MS * Math.pow(2, attempt - 1);
      console.warn(`  ⏳ Rate limited — retrying in ${backoff / 1000}s (attempt ${attempt}/${MAX_RETRIES})...`);
      await sleep(backoff);
    }

    let response: Response;
    try {
      response = await fetch(OPENROUTER_BASE_URL, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type":  "application/json",
          "HTTP-Referer":  APP_URL,
          "X-Title":       APP_TITLE,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new Error(`OpenRouter network error: ${err}`);
    }

    // 429 — rate limited, retry
    if (response.status === 429) {
      // Honour Retry-After header if present
      const retryAfter = response.headers.get("Retry-After");
      if (retryAfter) {
        const waitMs = (parseInt(retryAfter, 10) || 10) * 1000;
        console.warn(`  ⏳ Retry-After: ${retryAfter}s`);
        await sleep(waitMs);
      }
      lastError = new Error(
        `OpenRouter rate limited (429) after ${attempt + 1} attempt(s). Model: ${model}`
      );
      continue;
    }

    // Other errors — throw immediately, don't retry
    if (!response.ok) {
      let detail = "";
      try {
        const errBody = await response.json() as any;
        detail = errBody?.error?.message ?? JSON.stringify(errBody);
      } catch {
        detail = await response.text();
      }
      throw new Error(`OpenRouter API error ${response.status}: ${detail}\nModel: ${model}`);
    }

    // Success
    const data = await response.json() as OpenRouterResponse;
    const text = data.choices?.[0]?.message?.content;
    if (!text) {
      throw new Error(
        `OpenRouter returned no content.\n` +
        `Response: ${JSON.stringify(data).slice(0, 300)}`
      );
    }
    return text.trim();
  }

  throw lastError ?? new Error(`OpenRouter failed after ${MAX_RETRIES} retries. Model: ${model}`);
}

// ── Convenience helpers ────────────────────────────────────────────────────

/**
 * Extracts a flat list of action items from raw email text.
 * Used by daily-email-summary.ts.
 */
export async function extractActionItems(rawEmails: string): Promise<string[]> {
  if (!rawEmails || rawEmails === "No unread emails.") return [];

  const response = await callOpenRouter(rawEmails, {
    systemPrompt: [
      "You are extracting action items from a list of emails.",
      "Return ONLY a JSON array of short action item strings.",
      "Each string should be a clear, specific task (max 10 words).",
      "Include only genuine action items — ignore newsletters, notifications, and FYIs.",
      "If there are no action items, return an empty array: []",
      "Respond with ONLY valid JSON. No explanation, no markdown, no backticks.",
    ].join("\n"),
    maxTokens: 300,
    temperature: 0.1,
  });

  const clean = response.replace(/```json|```/g, "").trim();

  try {
    const parsed = JSON.parse(clean);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    console.warn("⚠️  extractActionItems: JSON parse failed, attempting line fallback.");
    return clean
      .split("\n")
      .map((line) => line.replace(/^[-•*\d.]+\s*/, "").trim())
      .filter((line) => line.length > 3 && line.length < 120);
  }
}

/**
 * Summarizes a block of text into a short paragraph.
 */
export async function summarize(
  content: string,
  instruction = "Summarize this content in 2-3 concise sentences."
): Promise<string> {
  return callOpenRouter(content, {
    systemPrompt: instruction,
    maxTokens: 200,
    temperature: 0.2,
  });
}

/**
 * Asks OpenRouter a direct question and returns the answer as a string.
 */
export async function ask(question: string, model?: string): Promise<string> {
  return callOpenRouter(question, { model, maxTokens: 200, temperature: 0.2 });
}

// ── OpenRouter response type ───────────────────────────────────────────────

interface OpenRouterResponse {
  id: string;
  model: string;
  choices: Array<{
    message: { role: string; content: string };
    finish_reason: string;
    index: number;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}