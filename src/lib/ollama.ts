/**
 * ollama.ts
 *
 * Thin wrapper around the local Ollama API.
 * Used for scheduled scripts (daily summary, weekly review).
 *
 * Processes emails one at a time — avoids payload size issues and
 * gives better quality results than batching everything together.
 *
 * Requires Ollama running: https://ollama.com
 * Set OLLAMA_HOST in .env to point to a remote server when ready.
 *
 * Used by:
 *   - src/scripts/daily-email-summary.ts
 *   - src/scripts/weekly-review.ts
 */

import * as dotenv from "dotenv";
dotenv.config();

// ── Types ──────────────────────────────────────────────────────────────────

export interface OllamaOptions {
  /** System prompt to set context/persona. */
  systemPrompt?: string;
  /** Max tokens to generate. Default: 200. */
  maxTokens?: number;
  /** Temperature 0–1. Lower = more deterministic. Default: 0.3. */
  temperature?: number;
  /** Model override. Falls back to OLLAMA_MODEL env, then default. */
  model?: string;
}

export interface EmailAnalysis {
  summary: string;           // one sentence summary
  actionItems: string[];     // extracted action items, empty if none
  isActionable: boolean;     // true if any action items found
}

// ── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_MODEL = "llama3.2:3b";
const DEFAULT_HOST  = "http://localhost:11434";

// Keep model loaded for 10 min between calls — prevents mid-script unloading
const KEEP_ALIVE = "10m";

// ── Helpers ────────────────────────────────────────────────────────────────

function resolveModel(override?: string): string {
  return override ?? process.env.OLLAMA_MODEL ?? DEFAULT_MODEL;
}

function resolveHost(): string {
  return process.env.OLLAMA_HOST ?? DEFAULT_HOST;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Health check ───────────────────────────────────────────────────────────

/**
 * Checks Ollama is running and the target model is pulled.
 * Call at script startup to fail fast with a clear message.
 */
export async function checkOllamaAvailable(model?: string): Promise<void> {
  const host        = resolveHost();
  const targetModel = resolveModel(model);

  let data: { models: Array<{ name: string }> };
  try {
    const res = await fetch(`${host}/api/tags`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json() as { models: Array<{ name: string }> };
  } catch (err: any) {
    throw new Error(
      `Ollama is not running or not reachable at ${host}.\n` +
      `Start it with: ollama serve\n` +
      `Error: ${err.message}`
    );
  }

  const available = data.models.map((m) => m.name);
  const isAvailable = available.some(
    (name) => name === targetModel || name.startsWith(targetModel.split(":")[0])
  );

  if (!isAvailable) {
    throw new Error(
      `Model "${targetModel}" is not pulled.\n` +
      `Run: ollama pull ${targetModel}\n` +
      `Available: ${available.join(", ") || "none"}`
    );
  }
}

// ── Core call ──────────────────────────────────────────────────────────────

/**
 * Makes a single completion call to Ollama.
 * Kept small and focused — callers pass one email at a time.
 */
export async function callOllama(
  userContent: string,
  options: OllamaOptions = {}
): Promise<string> {
  const host  = resolveHost();
  const model = resolveModel(options.model);

  const body = {
    model,
    prompt: options.systemPrompt
      ? `${options.systemPrompt}\n\n${userContent}`
      : userContent,
    stream:     false,
    keep_alive: KEEP_ALIVE,
    options: {
      temperature: options.temperature ?? 0.3,
      num_predict: options.maxTokens  ?? 200,
    },
  };

  let response: Response;
  try {
    response = await fetch(`${host}/api/generate`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(
      `Ollama network error — is Ollama running?\n` +
      `Start it with: ollama serve\n` +
      `Error: ${err}`
    );
  }

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Ollama API error ${response.status}: ${detail}`);
  }

  const data = await response.json() as OllamaResponse;
  if (!data.response) {
    throw new Error(`Ollama returned no content.`);
  }

  return data.response.trim();
}

// ── Per-email analysis ─────────────────────────────────────────────────────

/**
 * Analyzes a single email — summary + action items in one call.
 * Returns structured result so the caller can format however it wants.
 *
 * Asks for JSON to get structured output in one round trip.
 */
export async function analyzeEmail(
  from: string,
  subject: string,
  snippet: string,
  options?: OllamaOptions
): Promise<EmailAnalysis> {
  const emailText = [
    `From: ${from}`,
    `Subject: ${subject}`,
    `Preview: ${snippet}`,
  ].join("\n");

  const response = await callOllama(emailText, {
    systemPrompt: [
      "Analyze this email and respond with ONLY a JSON object. No explanation, no markdown.",
      "Schema:",
      '{ "summary": "one sentence summary of the email", "actionItems": ["action 1", "action 2"] }',
      "Rules:",
      "- summary: one clear sentence, max 20 words",
      "- actionItems: only real tasks the recipient needs to do. Empty array [] if none.",
      "- Ignore newsletters, notifications, marketing, and FYIs — they have no action items.",
    ].join("\n"),
    maxTokens:   300,
    temperature: 0.1,
    ...options,
  });

  // Extract JSON — local models sometimes add preamble
  const jsonMatch = response.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    // Fallback: treat the whole response as a summary, no action items
    return {
      summary:      response.slice(0, 100),
      actionItems:  [],
      isActionable: false,
    };
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]) as {
      summary?: string;
      actionItems?: string[];
    };
    const actionItems = (parsed.actionItems ?? []).filter(
      (item): item is string => typeof item === "string" && item.length > 0
    );
    return {
      summary:      parsed.summary ?? response.slice(0, 100),
      actionItems,
      isActionable: actionItems.length > 0,
    };
  } catch {
    return {
      summary:      response.slice(0, 100),
      actionItems:  [],
      isActionable: false,
    };
  }
}

/**
 * Generates a short overall digest from individual email summaries.
 * Called once after all emails are analyzed — tiny payload, very fast.
 */
export async function generateDigest(
  summaries: string[],
  profileLabel: string,
  options?: OllamaOptions
): Promise<string> {
  if (summaries.length === 0) return "No emails to summarize.";

  const bulletList = summaries.map((s, i) => `${i + 1}. ${s}`).join("\n");

  return callOllama(bulletList, {
    systemPrompt:
      `You are writing a 2-sentence digest of ${profileLabel} emails for today. ` +
      `Based on the email summaries below, write what matters most. ` +
      `Be concise. No bullet points.`,
    maxTokens:   150,
    temperature: 0.3,
    ...options,
  });
}

// ── Weekly review helper ───────────────────────────────────────────────────

/**
 * Generates a weekly review narrative from task and calendar data.
 * Used by weekly-review.ts — larger payload is fine here since it
 * runs once on Sunday with no tight time constraint.
 */
export async function generateWeeklyReview(
  context: string,
  weekRange: string,
  options?: OllamaOptions
): Promise<string> {
  return callOllama(context, {
    systemPrompt: [
      `Write a personal weekly review for the week of ${weekRange}.`,
      `Based on the completed tasks, incomplete tasks, and calendar events:`,
      `1. Briefly narrate what was accomplished (2-3 sentences).`,
      `2. Note any wins or patterns.`,
      `3. Mention what carried over and why.`,
      `4. End with 1-2 focus suggestions for next week.`,
      `Use markdown headers (##). Keep it under 350 words.`,
      `Only reference what is in the data — do not invent anything.`,
    ].join("\n"),
    maxTokens:   600,
    temperature: 0.4,
    ...options,
  });
}

// ── Ollama response type ───────────────────────────────────────────────────

interface OllamaResponse {
  model:        string;
  response:     string;
  done:         boolean;
  done_reason?: string;
}