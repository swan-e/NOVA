/**
 * morning-briefing.ts
 *
 * Runs once every morning at 7:00 AM via Ofelia.
 * Fetches today's calendar events (Google Calendar) and tasks (Notion),
 * uses Ollama to write a clean intro summary, then writes a single
 * Obsidian note under Daily Briefings/YYYY-MM-DD.md.
 *
 * If Ollama is down, skips AI formatting and writes raw data directly
 * so the note always gets created no matter what.
 *
 * Output: Obsidian/Daily Briefings/YYYY-MM-DD.md
 */

import * as dotenv from "dotenv";
import * as path from "path";
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

import { listTodayEvents }         from "../tools/calendar";
import { listTasks, NotionTask }   from "../tools/notion";
import { writeNote }               from "../tools/obsidian";
import { checkOllamaAvailable }    from "../lib/ollama";

// ── Config ───────────────────────────────────────────────────────────────────

const PROFILE    = "personal";
const NOTE_FOLDER = "Daily Briefings";

// ── Helpers ──────────────────────────────────────────────────────────────────

function todayISO(): string {
  return new Date().toISOString().split("T")[0];
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });
}

function getCurrentTime(): string {
  return new Date().toLocaleTimeString("en-US", {
    hour: "numeric", minute: "2-digit", hour12: true,
  });
}

function formatTaskLine(t: NotionTask): string {
  const time = t.due && t.due.includes("T")
    ? formatTimeRange(t.due, t.endDue ?? undefined)
    : "";
  const cat  = t.category ? ` [${t.category}]` : "";
  const notes = t.notes   ? ` — ${t.notes.slice(0, 60)}` : "";
  return `- [ ] ${time ? `${time} — ` : ""}${t.taskName}${cat}${notes}`;
}

function formatTimeRange(start: string, end?: string): string {
  const fmt = (iso: string) =>
    new Date(iso).toLocaleTimeString("en-US", {
      hour: "numeric", minute: "2-digit", hour12: true,
      timeZone: process.env.TIMEZONE ?? "America/New_York",
    });
  return end ? `${fmt(start)} – ${fmt(end)}` : fmt(start);
}

// ── Ollama summarize ─────────────────────────────────────────────────────────

/**
 * Asks Ollama for a short 1-2 sentence "tone for the day" intro based on
 * what's on the schedule. Lightweight prompt — no analysis, just framing.
 */
async function generateBriefingIntro(
  dateLabel: string,
  eventLines: string[],
  taskLines: string[]
): Promise<string> {
  const OLLAMA_HOST  = process.env.OLLAMA_HOST ?? "http://host.docker.internal:11434";
  const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "llama3";

  const scheduleText = [
    eventLines.length > 0 ? `Calendar:\n${eventLines.join("\n")}` : "No calendar events.",
    taskLines.length  > 0 ? `Tasks:\n${taskLines.join("\n")}`     : "No tasks due today.",
  ].join("\n\n");

  const prompt = [
    `Today is ${dateLabel}.`,
    `Here is the schedule:\n${scheduleText}`,
    ``,
    `Write a single short sentence (max 20 words) that sets the tone for the day.`,
    `Be direct. No filler. No "Good morning". Just the essence of the day.`,
    `Reply with only that one sentence, nothing else.`,
  ].join("\n");

  const res = await fetch(`${OLLAMA_HOST}/api/generate`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({
      model:  OLLAMA_MODEL,
      prompt,
      stream: false,
    }),
  });

  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
  const data = await res.json() as { response: string };
  return data.response.trim();
}

// ── Build note ───────────────────────────────────────────────────────────────

function buildNote(
  today: string,
  time: string,
  eventText: string,
  tasks: NotionTask[],
  intro: string | null
): string {
  const dateLabel = formatDate(today);

  // Parse event lines from the formatted string calendar.ts returns
  // Each line looks like: • [CalendarName] Event Title — 3:00 PM – 4:30 PM
  const eventLines = eventText
    .split("\n")
    .filter((l) => l.startsWith("•"))
    .map((l) => {
      // Strip the [CalendarName] prefix for cleaner display
      return l.replace(/^•\s*\[[^\]]+\]\s*/, "- ");
    });

  // Split tasks: timed vs untimed
  const timedTasks    = tasks.filter((t) => t.due && t.due.includes("T"));
  const untimedTasks  = tasks.filter((t) => !t.due || !t.due.includes("T"));

  const lines: string[] = [
    `# 📅 ${dateLabel}`,
    `*Generated at ${time}*`,
    ``,
  ];

  // Ollama intro line — or fallback notice if unavailable
  if (intro) {
    lines.push(`> ${intro}`, ``);
  } else {
    lines.push(`> *Ollama unavailable — AI summary skipped. Raw data below.*`, ``);
  }

  lines.push(`---`, ``);

  // ── Schedule ──
  lines.push(`## 🗓 Schedule`, ``);

  if (eventLines.length === 0 && timedTasks.length === 0) {
    lines.push(`*No scheduled events or timed tasks today.*`, ``);
  } else {
    // Merge events and timed tasks, sort by time string
    // Events already have time in their label; timed tasks get formatted
    const timedTaskLines = timedTasks.map((t) => {
      const range = formatTimeRange(t.due!, t.endDue ?? undefined);
      const cat   = t.category ? ` [${t.category}]` : "";
      return `- [ ] ${range} — ${t.taskName}${cat}`;
    });

    // Combine and sort — both start with "- " and have time as first token
    const allTimed = [...eventLines, ...timedTaskLines].sort((a, b) => {
      const getTime = (line: string) => {
        const match = line.match(/(\d{1,2}:\d{2}\s?[AP]M)/i);
        if (!match) return "";
        return new Date(`1970-01-01 ${match[1]}`).getTime().toString();
      };
      return getTime(a).localeCompare(getTime(b));
    });

    lines.push(...allTimed, ``);
  }

  // ── Tasks ──
  lines.push(`## ✅ Tasks`, ``);

  if (tasks.length === 0) {
    lines.push(`*No tasks due today.*`, ``);
  } else {
    if (untimedTasks.length > 0) {
      lines.push(...untimedTasks.map(formatTaskLine), ``);
    }
    if (untimedTasks.length === 0 && timedTasks.length > 0) {
      // All tasks are timed — already shown in schedule, just reference them
      lines.push(`*All tasks for today are listed in the schedule above.*`, ``);
    }
  }

  lines.push(`---`, ``);

  return lines.join("\n");
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const today     = todayISO();
  const time      = getCurrentTime();
  const notePath  = `${NOTE_FOLDER}/${today}`;
  const dateLabel = formatDate(today);

  console.log(`\nMorning Briefing — ${dateLabel}`);
  console.log(`Time: ${time}`);

  // ── Fetch calendar events ──
  console.log(`\nFetching calendar events...`);
  let eventText = "";
  try {
    eventText = await listTodayEvents(PROFILE, today);
    const count = (eventText.match(/^•/gm) ?? []).length;
    console.log(`  ✅ ${count} event(s)`);
  } catch (err) {
    console.error(`  ❌ Calendar fetch failed:`, err);
    eventText = "";
  }

  // ── Fetch Notion tasks due today ──
  console.log(`Fetching Notion tasks...`);
  let tasks: NotionTask[] = [];
  try {
    // Fetch tasks due today or earlier (catches overdue too)
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tasks = await listTasks(PROFILE, {
      showCompleted: false,
      dueBefore: tomorrow.toISOString().split("T")[0],
    });
    console.log(`  ✅ ${tasks.length} task(s)`);
  } catch (err) {
    console.error(`  ❌ Notion fetch failed:`, err);
    tasks = [];
  }

  // ── Ollama intro (optional — falls back gracefully) ──
  let intro: string | null = null;
  console.log(`\nChecking Ollama...`);
  try {
    await checkOllamaAvailable();
    console.log(`  ✅ Ollama ready — generating intro...`);

    const eventLines = eventText
      .split("\n")
      .filter((l) => l.startsWith("•"))
      .map((l) => l.replace(/^•\s*\[[^\]]+\]\s*/, ""));

    const taskLines = tasks.map((t) => {
      const time = t.due && t.due.includes("T")
        ? `${formatTimeRange(t.due, t.endDue ?? undefined)} — `
        : "";
      return `${time}${t.taskName}${t.category ? ` [${t.category}]` : ""}`;
    });

    intro = await generateBriefingIntro(dateLabel, eventLines, taskLines);
    console.log(`  ✅ Intro: "${intro}"`);
  } catch (err) {
    console.warn(`  ⚠️  Ollama unavailable — skipping intro (${err})`);
    intro = null;
  }

  // ── Build and write note ──
  const content = buildNote(today, time, eventText, tasks, intro);

  console.log(`\nWriting to Obsidian: ${notePath}.md`);
  try {
    await writeNote(notePath, content, { profileId: PROFILE });
    console.log(`✅ Briefing note created`);
  } catch (err) {
    console.error(`❌ Obsidian write failed:`, err);
    console.log(`\n── FALLBACK OUTPUT ──\n`);
    console.log(content);
  }

  console.log(`\nDone.`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});