/**
 * daily-email-summary.ts
 *
 * Runs three times a day: 8:00am, 1:00pm, 5:00pm.
 * Each run fetches ONLY emails that arrived since the previous run,
 * analyzes each one individually with Ollama, then appends a
 * timestamped section to today's Obsidian note.
 *
 * State: data/email-fetch-state.json
 *   Tracks the last fetch timestamp per profile so each run knows
 *   exactly where to pick up from. No emails are double-processed.
 *
 * Output: Obsidian/Daily Summaries/YYYY-MM-DD.md
 *   8am  → creates note + Morning section
 *   1pm  → appends Afternoon section
 *   5pm  → appends Evening section
 */

import * as dotenv from "dotenv";
import * as path from "path";
import * as fs from "fs";
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

import { fetchEmailsSince, EmailSummary } from "../tools/gmail";
import { writeNote } from "../tools/obsidian";
import {
  checkOllamaAvailable,
  analyzeEmail,
  generateDigest,
  EmailAnalysis,
} from "../lib/ollama";

// ── Config ──────────────────────────────────────────────────────────────────

const PROFILES = ["personal", "work"] as const;

// State file — tracks last fetch timestamp per profile
const STATE_FILE = path.resolve(__dirname, "../../data/email-fetch-state.json");

// On the very first run ever, fetch emails from the past 24 hours
const FIRST_RUN_LOOKBACK_HOURS = 24;

// ── State management ─────────────────────────────────────────────────────────

interface FetchState {
  lastFetch: Record<string, number>; // profileId → Unix timestamp in seconds
}

function loadState(): FetchState {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, "utf-8");
      return JSON.parse(raw) as FetchState;
    }
  } catch {
    console.warn("  ⚠️  Could not read state file — starting fresh");
  }
  return { lastFetch: {} };
}

function saveState(state: FetchState): void {
  const dir = path.dirname(STATE_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
}

function getLastFetchTime(state: FetchState, profileId: string): number {
  if (state.lastFetch[profileId]) {
    return state.lastFetch[profileId];
  }
  // First run ever — look back 24 hours
  const lookback = Date.now() / 1000 - FIRST_RUN_LOOKBACK_HOURS * 3600;
  return Math.floor(lookback);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function todayISO(): string {
  return new Date().toISOString().split("T")[0];
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });
}

function getRunLabel(): string {
  const hour = new Date().getHours();
  if (hour < 11) return "🌅 Morning (8:00am)";
  if (hour < 14) return "☀️ Afternoon (12:00pm)";
  return "🌆 Evening (4:00pm)";
}

function getCurrentTime(): string {
  return new Date().toLocaleTimeString("en-US", {
    hour: "numeric", minute: "2-digit", hour12: true,
  });
}

function isFirstRunOfDay(): boolean {
  return new Date().getHours() < 11;
}

function formatTimestamp(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleTimeString("en-US", {
    hour: "numeric", minute: "2-digit", hour12: true,
  });
}

// ── Per-profile processing ────────────────────────────────────────────────

interface ProfileResult {
  label:        string;
  emails:       EmailSummary[];
  analyses:     Array<{ email: EmailSummary; analysis: EmailAnalysis }>;
  digest:       string;
  fetchFailed:  boolean;
  sinceTime:    number;
}

async function processProfile(
  profileId: string,
  sinceTimestamp: number
): Promise<ProfileResult> {
  const label = profileId.charAt(0).toUpperCase() + profileId.slice(1);
  console.log(`\n── ${label} Gmail ──────────────────────────`);
  console.log(`  Fetching emails since ${formatTimestamp(sinceTimestamp)}...`);

  // Step 1: Fetch all emails since last run
  let emails: EmailSummary[] = [];
  let fetchFailed = false;

  try {
    emails = await fetchEmailsSince(sinceTimestamp, profileId);
    console.log(`  ✅ ${emails.length} new email(s)`);
  } catch (err) {
    console.error(`  ❌ Fetch failed:`, err);
    fetchFailed = true;
    return { label, emails: [], analyses: [], digest: "", fetchFailed, sinceTime: sinceTimestamp };
  }

  if (emails.length === 0) {
    return {
      label, emails: [], analyses: [], digest: "",
      fetchFailed: false, sinceTime: sinceTimestamp,
    };
  }

  // Step 2: Analyze each email individually
  console.log(`  Analyzing ${emails.length} email(s)...`);
  const analyses: Array<{ email: EmailSummary; analysis: EmailAnalysis }> = [];

  for (let i = 0; i < emails.length; i++) {
    const email = emails[i];
    process.stdout.write(`    [${i + 1}/${emails.length}] ${email.subject.slice(0, 45).padEnd(45)} `);

    try {
      const analysis = await analyzeEmail(
        `${email.senderName} <${email.senderEmail}>`,
        email.subject,
        email.snippet
      );
      analyses.push({ email, analysis });
      process.stdout.write(analysis.isActionable ? "⚡\n" : "✓\n");
    } catch (err) {
      process.stdout.write("⚠️\n");
      analyses.push({
        email,
        analysis: {
          summary:      email.snippet.slice(0, 80) || email.subject,
          actionItems:  [],
          isActionable: false,
        },
      });
    }
  }

  // Step 3: Overall digest
  let digest = "";
  if (emails.length > 1) {
    console.log(`  Generating digest...`);
    try {
      const summaries = analyses.map((a) => a.analysis.summary);
      digest = await generateDigest(summaries, `${label} Gmail`);
      console.log(`  ✅ Digest done`);
    } catch (err) {
      console.error(`  ❌ Digest failed:`, err);
      digest = "";
    }
  }

  const actionableCount = analyses.filter((a) => a.analysis.isActionable).length;
  console.log(`  ✅ Done — ${actionableCount} actionable`);

  return { label, emails, analyses, digest, fetchFailed: false, sinceTime: sinceTimestamp };
}

// ── Build Obsidian content ────────────────────────────────────────────────

function buildDayHeader(today: string): string {
  return [
    `# Daily Email Summary`,
    `**${formatDate(today)}**`,
    ``,
    `---`,
    ``,
  ].join("\n");
}

function buildProfileSection(result: ProfileResult): string {
  const lines: string[] = [`### ${result.label} Gmail`, ``];

  if (result.fetchFailed) {
    lines.push(`*Failed to fetch — check Google auth.*`, ``);
    return lines.join("\n");
  }

  if (result.emails.length === 0) {
    lines.push(`*No new emails since ${formatTimestamp(result.sinceTime)}.*`, ``);
    return lines.join("\n");
  }

  // Digest (only if more than one email)
  if (result.digest) {
    lines.push(`**Digest**`, result.digest, ``);
  }

  // Per-email breakdown
  lines.push(`**${result.emails.length} new email(s)**`, ``);
  for (const { email, analysis } of result.analyses) {
    const tag = analysis.isActionable ? " ⚡" : "";
    lines.push(`- **${email.senderName}** — ${analysis.summary}${tag}`);
    for (const item of analysis.actionItems) {
      lines.push(`  - [ ] ${item}`);
    }
  }

  lines.push(``);
  return lines.join("\n");
}

function buildRunSection(
  runLabel: string,
  time: string,
  profileResults: ProfileResult[]
): string {
  return [
    `## ${runLabel}`,
    `*Fetched at ${time}*`,
    ``,
    ...profileResults.map(buildProfileSection),
    `---`,
    ``,
  ].join("\n");
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const today   = todayISO();
  const runLabel = getRunLabel();
  const time    = getCurrentTime();
  const isFirst = isFirstRunOfDay();
  const notePath = `Daily Summaries/${today}`;
  const nowSeconds = Math.floor(Date.now() / 1000);

  console.log(`\nDaily Email Summary — ${runLabel}`);
  console.log(`Date: ${formatDate(today)}`);
  console.log(`Mode: ${isFirst ? "Creating new note" : "Appending to existing note"}`);

  // Load state — tells us when each profile was last fetched
  const state = loadState();

  // Check Ollama
  console.log(`\nChecking Ollama...`);
  try {
    await checkOllamaAvailable();
    console.log(`  ✅ Ollama ready`);
  } catch (err) {
    console.error(`  ❌ ${err}`);
    process.exit(1);
  }

  // Process each profile
  const profileResults: ProfileResult[] = [];
  for (const profileId of PROFILES) {
    const sinceTimestamp = getLastFetchTime(state, profileId);
    const result = await processProfile(profileId, sinceTimestamp);
    profileResults.push(result);

    // Update state immediately after each profile so partial runs still save progress
    if (!result.fetchFailed) {
      state.lastFetch[profileId] = nowSeconds;
      saveState(state);
    }
  }

  // Build and write to Obsidian
  const runSection = buildRunSection(runLabel, time, profileResults);

  console.log(`\nWriting to Obsidian: ${notePath}.md`);
  try {
    if (isFirst) {
      const fullContent = buildDayHeader(today) + runSection;
      await writeNote(notePath, fullContent, { profileId: "personal" });
      console.log(`✅ Note created`);
    } else {
      await writeNote(notePath, runSection, { append: true, profileId: "personal" });
      console.log(`✅ Section appended`);
    }
  } catch (err) {
    console.error("❌ Obsidian write failed:", err);
    console.log("\n── FALLBACK OUTPUT ──\n");
    console.log(runSection);
  }

  console.log("\nDone.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});