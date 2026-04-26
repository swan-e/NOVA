import fs from "fs";
import path from "path";
import { loadProfile } from "../lib/profiles";

// ── Vault path ─────────────────────────────────────────────────────────────

function getVaultPath(profileId?: string): string {
  const profile = loadProfile(profileId);
  if (!profile.obsidianVaultPath) {
    throw new Error(
      `Obsidian vault path not set.\n` +
      `Add OBSIDIAN_VAULT_PATH to your .env file.`
    );
  }
  // Inside Docker, use the mounted path instead of Windows path
  if (process.env.OBSIDIAN_VAULT_INTERNAL) {
    return process.env.OBSIDIAN_VAULT_INTERNAL;
  }
  return profile.obsidianVaultPath;
}

function resolvePath(vaultPath: string, notePath: string): string {
  // Ensure .md extension
  const withExt = notePath.endsWith(".md") ? notePath : `${notePath}.md`;
  return path.join(vaultPath, withExt);
}

// ── Read ───────────────────────────────────────────────────────────────────

/**
 * Reads a note from the vault by relative path.
 * e.g. "Weekly Reviews/2025-03-24" or "Personal/ideas"
 */
export async function readNote(
  notePath: string,
  profileId?: string
): Promise<string> {
  const vault = getVaultPath(profileId);
  const fullPath = resolvePath(vault, notePath);

  if (!fs.existsSync(fullPath)) {
    return `Note not found: ${notePath}`;
  }

  return fs.readFileSync(fullPath, "utf-8");
}

/**
 * Lists all notes in a folder within the vault.
 */
export async function listNotes(
  folderPath = "",
  profileId?: string
): Promise<string> {
  const vault = getVaultPath(profileId);
  const fullPath = path.join(vault, folderPath);

  if (!fs.existsSync(fullPath)) {
    return `Folder not found: ${folderPath || "(vault root)"}`;
  }

  const entries = fs.readdirSync(fullPath, { withFileTypes: true });
  const lines: string[] = [`Notes in ${folderPath || "vault root"}:`, ""];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      lines.push(`  📁 ${entry.name}/`);
    } else if (entry.name.endsWith(".md")) {
      lines.push(`  📄 ${entry.name.replace(".md", "")}`);
    }
  }

  return lines.join("\n");
}

/**
 * Searches all notes in the vault for a keyword.
 * Returns list of matching note paths.
 */
export async function searchNotes(
  query: string,
  profileId?: string
): Promise<string> {
  const vault = getVaultPath(profileId);
  const results: string[] = [];

  function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".md")) {
        const content = fs.readFileSync(full, "utf-8");
        if (content.toLowerCase().includes(query.toLowerCase())) {
          results.push(path.relative(vault, full).replace(/\\/g, "/"));
        }
      }
    }
  }

  walk(vault);

  if (results.length === 0) return `No notes found matching "${query}"`;
  return `Found in ${results.length} note(s):\n${results.map((r) => `  • ${r}`).join("\n")}`;
}

// ── Write ──────────────────────────────────────────────────────────────────

/**
 * Writes a note to the vault.
 * Creates the folder structure if it doesn't exist.
 * By default overwrites — set append: true to add to existing note.
 */
export async function writeNote(
  notePath: string,
  content: string,
  options: { append?: boolean; profileId?: string } = {}
): Promise<string> {
  const vault = getVaultPath(options.profileId);
  const fullPath = resolvePath(vault, notePath);
  const dir = path.dirname(fullPath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  if (options.append && fs.existsSync(fullPath)) {
    fs.appendFileSync(fullPath, "\n\n" + content, "utf-8");
    return `✅ Appended to: ${notePath}`;
  }

  fs.writeFileSync(fullPath, content, "utf-8");
  return `✅ Written: ${notePath}`;
}

/**
 * Writes a weekly review note.
 * Always goes to Weekly Reviews/YYYY-MM-DD.md
 * Called by weekly-review.ts Docker script.
 */
export async function writeWeeklyReview(
  weekStartDate: string,
  content: string,
  profileId?: string
): Promise<string> {
  const notePath = `Weekly Reviews/${weekStartDate}`;
  return writeNote(notePath, content, { profileId });
}

/**
 * Writes the daily email summary.
 * Goes to Daily Summaries/YYYY-MM-DD.md
 * Called by daily-email-summary.ts Docker script.
 */
export async function writeDailySummary(
  date: string,
  content: string,
  profileId?: string
): Promise<string> {
  const notePath = `Daily Summaries/${date}`;
  return writeNote(notePath, content, { profileId });
}

/**
 * Appends a quick note or idea to today's daily note.
 * Creates it if it doesn't exist.
 */
export async function appendToDailyNote(
  content: string,
  profileId?: string
): Promise<string> {
  const today = new Date().toISOString().split("T")[0];
  const notePath = `Daily/${today}`;
  return writeNote(notePath, content, { append: true, profileId });
}