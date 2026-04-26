/**
 * calendar-reminder.ts
 *
 * Docker script — runs every Sunday morning via Ofelia.
 * Creates a planning reminder event on your calendar for that evening.
 *
 * Logic:
 *   - First Sunday of the month → "⚙️ Configure your month"
 *   - Any other Sunday         → "⚙️ Configure your week"
 *
 * Schedule (set in docker/ofelia.ini):
 *   0 8 * * 0   (8:00am every Sunday)
 */

import * as dotenv from "dotenv";
import * as path from "path";
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

import { createReminderEvent } from "../tools/calendar";

// ── Config ──────────────────────────────────────────────────────────────────

const PROFILES = ["personal"] as const;

const REMINDER_HOUR = 18;        // 6pm
const REMINDER_DURATION = 60;    // 60 minutes

const WEEKLY_TITLE  = "⚙️ Configure your week";
const MONTHLY_TITLE = "⚙️ Configure your month";

// ── Helpers ─────────────────────────────────────────────────────────────────

function isFirstSundayOfMonth(date: Date): boolean {
  if (date.getDay() !== 0) return false;
  return date.getDate() <= 7;
}

function todayISO(): string {
  return new Date().toISOString().split("T")[0];
}

function buildEventTime(date: string, hour: number, durationMinutes: number): {
  start: string;
  end: string;
} {
  const pad = (n: number) => String(n).padStart(2, "0");
  const endHour = Math.floor((hour * 60 + durationMinutes) / 60);
  const endMin = (hour * 60 + durationMinutes) % 60;
  return {
    start: `${date}T${pad(hour)}:00:00`,
    end:   `${date}T${pad(endHour)}:${pad(endMin)}:00`,
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const today = new Date();
  const todayStr = todayISO();

  if (today.getDay() !== 0) {
    console.log(`Skipping — today is not Sunday (day ${today.getDay()})`);
    process.exit(0);
  }

  const isFirstSunday = isFirstSundayOfMonth(today);
  const title = isFirstSunday ? MONTHLY_TITLE : WEEKLY_TITLE;
  const { start, end } = buildEventTime(todayStr, REMINDER_HOUR, REMINDER_DURATION);

  console.log(`\nCalendar Reminder Script`);
  console.log(`Date:  ${todayStr}`);
  console.log(`Type:  ${isFirstSunday ? "Monthly planning" : "Weekly planning"}`);
  console.log(`Event: "${title}" at ${start}\n`);

  for (const profileId of PROFILES) {
    try {
      const result = await createReminderEvent(title, todayStr, profileId);
      console.log(`[${profileId}] ${result}`);
    } catch (err) {
      console.error(`[${profileId}] Failed:`, err);
      process.exit(1);
    }
  }

  console.log("\nDone.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});