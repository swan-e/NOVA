import { calendar } from "@googleapis/calendar";
import { loadProfile, getGoogleAuth } from "../lib/profiles";
import { readSchedulingPreferences, getEffectiveSleep, getEffectiveMeal } from "../lib/config";
import { TIMEZONE } from "../lib/env";

// ── Types ──────────────────────────────────────────────────────────────────

export interface CalendarEvent {
  id: string;
  summary: string;
  calendarName: string;   // which sub-calendar it came from e.g. "GYM", "Class Schedule"
  calendarId: string;
  start: string;
  end: string;
  description?: string;
  isAllDay: boolean;
}

export interface UserCalendar {
  id: string;
  name: string;
  primary: boolean;
}

export interface FreeSlot {
  start: string;
  end: string;
  durationMinutes: number;
  weight: "prime" | "high" | "medium";
  label: string;
  date: string;
}

export interface WeekSummary {
  weekStart: string;
  weekEnd: string;
  events: CalendarEvent[];
  totalScheduledMinutes: number;
  totalWeekMinutes: number;
  freeSlots: FreeSlot[];
  percentScheduled: number;
  byDay: DaySummary[];
  calendarBreakdown: Record<string, number>; // calendarName -> event count
}

export interface DaySummary {
  date: string;
  dayName: string;
  events: CalendarEvent[];
  scheduledMinutes: number;
  freeSlots: FreeSlot[];
}

export interface NewEvent {
  summary: string;
  startDateTime: string;
  endDateTime: string;
  description?: string;
  isAllDay?: boolean;
  calendarName?: string;  // which sub-calendar to add to. defaults to primary
}

// ── Client factory ─────────────────────────────────────────────────────────

function getCalendarClient(profileId?: string) {
  const profile = loadProfile(profileId);
  const auth = getGoogleAuth(profile);
  return calendar({ version: "v3", auth });
}

// ── Calendar list ──────────────────────────────────────────────────────────

/**
 * Returns all calendars the user has — primary + all sub-calendars.
 * This is how we discover Class Schedule, GYM, Monthly, etc.
 */
export async function listAllCalendars(profileId?: string): Promise<UserCalendar[]> {
  const calendar = getCalendarClient(profileId);
  const res = await calendar.calendarList.list();
  const items = res.data.items ?? [];
  return items.map((c) => ({
    id: c.id ?? "",
    name: c.summary ?? "Untitled",
    primary: c.primary ?? false,
  }));
}

/**
 * Formats the calendar list for display — useful to show the user
 * which calendars were found and are being read.
 */
export async function formatCalendarList(profileId?: string): Promise<string> {
  const calendars = await listAllCalendars(profileId);
  const lines = ["Your Google Calendars:", ""];
  for (const c of calendars) {
    lines.push(`  ${c.primary ? "★" : "•"} ${c.name}${c.primary ? " (primary)" : ""}`);
  }
  return lines.join("\n");
}

// ── Read ───────────────────────────────────────────────────────────────────

/**
 * Lists events from ALL calendars, sorted by start time.
 * timeMin defaults to now (upcoming only). Pass start of day for full-day queries.
 */
export async function listUpcomingEvents(
  profileId?: string,
  maxResults = 10,
  timeMin?: string,   // ISO string — defaults to now if omitted
  timeMax?: string,   // ISO string — omit for open-ended upcoming
): Promise<string> {
  const calendars = await listAllCalendars(profileId);
  const calendarClient = getCalendarClient(profileId);
  const from = timeMin ?? new Date().toISOString();

  const allEvents: CalendarEvent[] = [];

  await Promise.all(
    calendars.map(async (cal) => {
      try {
        const res = await calendarClient.events.list({
          calendarId: cal.id,
          timeMin: from,
          ...(timeMax && { timeMax }),
          maxResults,
          singleEvents: true,
          orderBy: "startTime",
        });
        const items = res.data.items ?? [];
        for (const e of items) {
          allEvents.push({
            id: e.id ?? "",
            summary: e.summary ?? "(no title)",
            calendarName: cal.name,
            calendarId: cal.id,
            start: e.start?.dateTime ?? e.start?.date ?? "",
            end: e.end?.dateTime ?? e.end?.date ?? "",
            description: e.description ?? undefined,
            isAllDay: !e.start?.dateTime,
          });
        }
      } catch {
        // Skip calendars we can't read
      }
    })
  );

  allEvents.sort((a, b) => a.start.localeCompare(b.start));

  const shown = allEvents.slice(0, maxResults);
  if (shown.length === 0) return "No events found.";

  return shown
    .map((e) => {
      const start = formatTime(e.start);
      const end = formatTime(e.end);
      const range = start && end ? `${start} – ${end}` : start || formatDateTime(e.start);
      return `• [${e.calendarName}] ${e.summary} — ${range}`;
    })
    .join("\n");
}

/**
 * Lists ALL events for a specific day (midnight to midnight).
 * Used for "what's my schedule today" — includes past events.
 * Defaults to today if no date provided.
 */
export async function listTodayEvents(
  profileId?: string,
  date?: string,        // ISO date YYYY-MM-DD, defaults to today
): Promise<string> {
  const day = date ?? new Date().toISOString().split("T")[0];
  const timeMin = new Date(`${day}T00:00:00`).toISOString();
  const timeMax = new Date(`${day}T23:59:59`).toISOString();
  return listUpcomingEvents(profileId, 50, timeMin, timeMax);
}


export async function getWeekSummary(
  profileId?: string,
  weekStartDate?: string
): Promise<WeekSummary> {
  const calendars = await listAllCalendars(profileId);
  const calendar = getCalendarClient(profileId);
  const weekStart = weekStartDate ?? getThisMonday();
  const weekEnd = addDays(weekStart, 7);

  const timeMin = new Date(`${weekStart}T00:00:00`).toISOString();
  const timeMax = new Date(`${weekEnd}T00:00:00`).toISOString();

  const allEvents: CalendarEvent[] = [];

  await Promise.all(
    calendars.map(async (cal) => {
      try {
        const res = await calendar.events.list({
          calendarId: cal.id,
          timeMin,
          timeMax,
          singleEvents: true,
          orderBy: "startTime",
        });
        const items = res.data.items ?? [];
        for (const e of items) {
          allEvents.push({
            id: e.id ?? "",
            summary: e.summary ?? "(no title)",
            calendarName: cal.name,
            calendarId: cal.id,
            start: e.start?.dateTime ?? e.start?.date ?? "",
            end: e.end?.dateTime ?? e.end?.date ?? "",
            description: e.description ?? undefined,
            isAllDay: !e.start?.dateTime,
          });
        }
      } catch {
        // Skip unreadable calendars
      }
    })
  );

  allEvents.sort((a, b) => a.start.localeCompare(b.start));

  // Build day-by-day breakdown
  const byDay: DaySummary[] = [];
  for (let i = 0; i < 7; i++) {
    const date = addDays(weekStart, i);
    const dayEvents = allEvents.filter((e) => e.start.startsWith(date));
    const scheduledMinutes = dayEvents.reduce((sum, e) => sum + getEventDurationMinutes(e), 0);
    const freeSlots = await getFreeSlotsForDay(date, dayEvents);
    byDay.push({ date, dayName: getDayName(date), events: dayEvents, scheduledMinutes, freeSlots });
  }

  // Calendar breakdown — how many events per sub-calendar
  const calendarBreakdown: Record<string, number> = {};
  for (const e of allEvents) {
    calendarBreakdown[e.calendarName] = (calendarBreakdown[e.calendarName] ?? 0) + 1;
  }

  const totalScheduledMinutes = byDay.reduce((s, d) => s + d.scheduledMinutes, 0);
  const totalWeekMinutes = 7 * 24 * 60;

  return {
    weekStart, weekEnd,
    events: allEvents,
    totalScheduledMinutes, totalWeekMinutes,
    freeSlots: byDay.flatMap((d) => d.freeSlots),
    percentScheduled: Math.round((totalScheduledMinutes / totalWeekMinutes) * 100),
    byDay,
    calendarBreakdown,
  };
}

/**
 * Formats the week summary as a dashboard for Claude to present on Sunday.
 */
export function formatWeekDashboard(summary: WeekSummary, freeTimeTargetHours: number): string {
  const scheduledHrs = (summary.totalScheduledMinutes / 60).toFixed(1);
  const freeTargetPct = Math.round((freeTimeTargetHours / 168) * 100);

  const lines = [
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `  WEEK OF ${formatDateRange(summary.weekStart, summary.weekEnd)}`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    ``,
    `SCHEDULED TIME`,
    `  Total week:       168 hrs`,
    `  Already booked:   ${scheduledHrs} hrs (${summary.percentScheduled}%)`,
    `  Your free target: ${freeTimeTargetHours} hrs (${freeTargetPct}%)`,
    `  Truly free:       ${(168 - Number(scheduledHrs) - freeTimeTargetHours).toFixed(1)} hrs`,
    ``,
    `BY CALENDAR`,
  ];

  for (const [name, count] of Object.entries(summary.calendarBreakdown)) {
    lines.push(`  • ${name}: ${count} event${count !== 1 ? "s" : ""}`);
  }

  lines.push(``, `BY DAY`);
  for (const day of summary.byDay) {
    const hrs = (day.scheduledMinutes / 60).toFixed(1);
    const bar = makeBar(day.scheduledMinutes, 8 * 60);
    const slots = day.freeSlots.filter((s) => s.weight === "prime" || s.weight === "high").length;
    lines.push(`  ${day.dayName.padEnd(4)} ${bar}  ${hrs} hrs | ${slots} open slots`);
  }

  lines.push(``, `EVENTS THIS WEEK`);
  if (summary.events.length === 0) {
    lines.push(`  None scheduled yet`);
  } else {
    for (const day of summary.byDay) {
      if (day.events.length === 0) continue;
      lines.push(`  ${day.dayName} ${day.date}`);
      for (const e of day.events) {
        const time = e.isAllDay ? "All day" : formatTime(e.start);
        lines.push(`    ${time.padEnd(8)} [${e.calendarName}] ${e.summary}`);
      }
    }
  }

  lines.push(``, `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  return lines.join("\n");
}

// ── Write ──────────────────────────────────────────────────────────────────

function getTimezoneOffset(): string {
  // Returns current UTC offset for America/New_York e.g. "-04:00" or "-05:00"
  const now = new Date();
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    timeZoneName: "shortOffset",
  });
  const parts = formatter.formatToParts(now);
  const offset = parts.find(p => p.type === "timeZoneName")?.value ?? "GMT-4";
  // Convert "GMT-4" to "-04:00"
  const match = offset.match(/GMT([+-]\d+)/);
  if (!match) return "-05:00";
  const hours = parseInt(match[1]);
  return `${hours >= 0 ? "+" : "-"}${String(Math.abs(hours)).padStart(2, "0")}:00`;
}

/**
 * Checks for conflicts across ALL calendars for a given time window.
 * Skips all-day events (birthdays, holidays, etc.) to avoid false positives.
 * Optionally excludes a specific event ID (used during updates so the event
 * doesn't conflict with its own current time slot).
 */
async function checkConflictsAcrossAllCalendars(
  calendarClient: ReturnType<typeof getCalendarClient>,
  calendars: UserCalendar[],
  timeMin: string,
  timeMax: string,
  excludeEventId?: string
): Promise<Array<{ summary: string; start: string; calendarName: string }>> {
  const conflicts: Array<{ summary: string; start: string; calendarName: string }> = [];

  await Promise.all(
    calendars.map(async (cal) => {
      try {
        const res = await calendarClient.events.list({
          calendarId: cal.id,
          timeMin,
          timeMax,
          singleEvents: true,
          orderBy: "startTime",
        });
        for (const e of res.data.items ?? []) {
          if (
            e.status === "cancelled"       ||  // deleted events
            !e.start?.dateTime             ||  // skip all-day events (no dateTime = all-day)
            e.id === excludeEventId            // skip the event being updated
          ) continue;
          conflicts.push({
            summary:      e.summary ?? "(no title)",
            start:        e.start.dateTime,
            calendarName: cal.name,
          });
        }
      } catch {
        // Skip calendars we can't read
      }
    })
  );

  return conflicts;
}


export async function createEvent(event: NewEvent, profileId?: string, force = false): Promise<string> {
  const calendar = getCalendarClient(profileId);
  const startWithOffset = event.startDateTime + getTimezoneOffset();
  const endWithOffset = event.endDateTime + getTimezoneOffset();

  const calendars = await listAllCalendars(profileId);
  let targetCalendarId = "primary";

  if (event.calendarName) {
    const match = calendars.find(
      (c) => c.name.toLowerCase() === event.calendarName!.toLowerCase()
    );
    if (match) {
      targetCalendarId = match.id;
    } else {
      return `Calendar "${event.calendarName}" not found. Available: ${calendars.map((c) => c.name).join(", ")}`;
    }
  }

  if (!event.isAllDay && !force) {
    const conflicts = await checkConflictsAcrossAllCalendars(
      calendar, calendars, startWithOffset, endWithOffset
    );
    if (conflicts.length > 0) {
      const conflictList = conflicts
        .map((c) => `"${c.summary}" [${c.calendarName}] at ${formatDateTime(c.start)}`)
        .join(", ");
      return `⚠️ Conflict detected: ${conflictList}. Create "${event.summary}" anyway? If yes, tell me to force it.`;
    }
  }

  await calendar.events.insert({
    calendarId: targetCalendarId,
    requestBody: {
      summary: event.summary,
      description: event.description,
      start: event.isAllDay
        ? { date: event.startDateTime.split("T")[0] }
        : { dateTime: event.startDateTime, timeZone: TIMEZONE },
      end: event.isAllDay
        ? { date: event.endDateTime.split("T")[0] }
        : { dateTime: event.endDateTime, timeZone: TIMEZONE },
    },
  });

  const calLabel = event.calendarName ? `[${event.calendarName}]` : "[Primary]";
  return `✅ Created: ${calLabel} "${event.summary}" on ${formatDateTime(startWithOffset)}`;
}

/**
 * Creates multiple events in one call.
 */
export async function createEventBatch(events: NewEvent[], profileId?: string): Promise<string> {
  const results: string[] = [];
  for (const event of events) {
    try {
      results.push(await createEvent(event, profileId));
    } catch (err) {
      results.push(`❌ Failed: "${event.summary}" — ${err}`);
    }
  }
  return results.join("\n");
}

/**
 * Creates a planning reminder event on the primary calendar.
 */
export async function createReminderEvent(
  summary: string,
  date: string,
  profileId?: string
): Promise<string> {
  return createEvent({
    summary,
    startDateTime: `${date}T18:00:00`,
    endDateTime: `${date}T19:00:00`,
    description: "Auto-created by Personal MCP. Open Claude Code to start planning.",
  }, profileId);
}


/**
 * Updates an existing calendar event by ID.
 * Accepts any subset of fields — only provided fields are changed.
 * Runs conflict detection on the new time slot if start/end are being changed,
 * unless force is true.
 */
export async function updateEvent(
  eventId: string,
  updates: {
    summary?: string;
    startDateTime?: string;
    endDateTime?: string;
    description?: string;
    location?: string;
    calendarName?: string;
  },
  profileId?: string,
  force = false
): Promise<string> {
  const calendarClient = getCalendarClient(profileId);
  const calendars = await listAllCalendars(profileId);

  // Find which calendar this event lives in
  let targetCalendarId: string | null = null;
  let existingEvent: any = null;

  for (const cal of calendars) {
    try {
      const res = await calendarClient.events.get({ calendarId: cal.id, eventId });
      if (res.data) {
        targetCalendarId = cal.id;
        existingEvent = res.data;
        break;
      }
    } catch {
      // Not in this calendar, keep looking
    }
  }

  if (!targetCalendarId || !existingEvent) {
    return `❌ Event ID "${eventId}" not found in any calendar. Use calendar_today or calendar_list_upcoming to get the correct event ID.`;
  }

  // If changing time, run conflict detection against the target calendar
  if ((updates.startDateTime || updates.endDateTime) && !force) {
    const newStart = updates.startDateTime
      ? updates.startDateTime + getTimezoneOffset()
      : existingEvent.start?.dateTime ?? existingEvent.start?.date;
    const newEnd = updates.endDateTime
      ? updates.endDateTime + getTimezoneOffset()
      : existingEvent.end?.dateTime ?? existingEvent.end?.date;

    const conflicts = await checkConflictsAcrossAllCalendars(
      calendarClient, calendars, newStart, newEnd, eventId
    );

    if (conflicts.length > 0) {
      const conflictList = conflicts
        .map((c) => `"${c.summary}" [${c.calendarName}] at ${formatDateTime(c.start)}`)
        .join(", ");
      return `⚠️ Conflict detected: ${conflictList}. Update "${existingEvent.summary}" anyway? If yes, tell me to force it.`;
    }
  }

  // Build the patch — only include fields that were provided
  const patch: Record<string, any> = {};

  if (updates.summary)       patch.summary     = updates.summary;
  if (updates.description !== undefined) patch.description = updates.description;
  if (updates.location !== undefined)    patch.location    = updates.location;

  if (updates.startDateTime) {
    patch.start = { dateTime: updates.startDateTime + getTimezoneOffset(), timeZone: TIMEZONE };
  }
  if (updates.endDateTime) {
    patch.end = { dateTime: updates.endDateTime + getTimezoneOffset(), timeZone: TIMEZONE };
  }

  await calendarClient.events.patch({
    calendarId: targetCalendarId,
    eventId,
    requestBody: patch,
  });

  const updatedFields = Object.keys(updates).join(", ");
  const newStart = updates.startDateTime ?? existingEvent.start?.dateTime ?? existingEvent.start?.date ?? "";
  const newEnd   = updates.endDateTime   ?? existingEvent.end?.dateTime   ?? existingEvent.end?.date   ?? "";
  const timeRange = newStart ? ` — ${formatTime(newStart)}${newEnd ? ` – ${formatTime(newEnd)}` : ""}` : "";

  return `✅ Updated "${updates.summary ?? existingEvent.summary}"${timeRange} (changed: ${updatedFields})`;
}



async function getFreeSlotsForDay(date: string, existingEvents: CalendarEvent[]): Promise<FreeSlot[]> {
  const prefs = readSchedulingPreferences();
  const sleep = getEffectiveSleep(date);
  const breakfast = getEffectiveMeal("breakfast", date);
  const lunch = getEffectiveMeal("lunch", date);
  const dinner = getEffectiveMeal("dinner", date);

  const blocked: Array<{ start: number; end: number }> = [];

  blocked.push({ start: 0, end: timeToMinutes(sleep.wakeTime) });
  blocked.push({ start: timeToMinutes(sleep.bedtime) - sleep.windDownBufferMinutes, end: 24 * 60 });

  if (breakfast.enabled) blocked.push({ start: timeToMinutes(breakfast.windowStart), end: timeToMinutes(breakfast.windowStart) + breakfast.durationMinutes });
  if (lunch.enabled) blocked.push({ start: timeToMinutes(lunch.windowStart), end: timeToMinutes(lunch.windowStart) + lunch.durationMinutes });
  if (dinner.enabled) blocked.push({ start: timeToMinutes(dinner.windowStart), end: timeToMinutes(dinner.windowStart) + dinner.durationMinutes });

  for (const pw of prefs.protectedWindows) {
    blocked.push({ start: timeToMinutes(pw.start), end: pw.end === "23:59" ? 24 * 60 : timeToMinutes(pw.end) });
  }

  for (const e of existingEvents) {
    if (!e.isAllDay && e.start && e.end) {
      const startTime = e.start.split("T")[1]?.slice(0, 5);
      const endTime = e.end.split("T")[1]?.slice(0, 5);
      if (startTime && endTime) {
        blocked.push({ start: timeToMinutes(startTime), end: timeToMinutes(endTime) });
      }
    }
  }

  const freeSlots: FreeSlot[] = [];
  const granularity = prefs.slotGranularityMinutes;

  for (const window of prefs.taskWindows) {
    const windowStart = timeToMinutes(window.start);
    const windowEnd = timeToMinutes(window.end);
    let cursor = windowStart;
    while (cursor + granularity <= windowEnd) {
      const slotEnd = cursor + granularity;
      const isBlocked = blocked.some((b) => cursor < b.end && slotEnd > b.start);
      if (!isBlocked) {
        freeSlots.push({
          start: minutesToTime(cursor),
          end: minutesToTime(slotEnd),
          durationMinutes: granularity,
          weight: window.weight as "prime" | "high" | "medium",
          label: window.label,
          date,
        });
      }
      cursor += granularity;
    }
  }

  return freeSlots;
}

// ── Delete ──────────────────────────────────────────────────────────────

/**
 * Deletes a calendar event by searching for it by name and approximate time.
 * Returns a confirmation or error message.
 */
export async function deleteEvent(
  summary: string,
  profileId?: string,
  date?: string,
): Promise<string> {
  const calendars = await listAllCalendars(profileId);
  const calendarClient = getCalendarClient(profileId);

  const timeMin = date
    ? new Date(`${date}T00:00:00`).toISOString()
    : new Date().toISOString();
  const timeMax = date
    ? new Date(`${date}T23:59:59`).toISOString()
    : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days ahead

  const matches: Array<{ calendarId: string; calendarName: string; eventId: string; summary: string; start: string }> = [];

  await Promise.all(
    calendars.map(async (cal) => {
      try {
        const res = await calendarClient.events.list({
          calendarId: cal.id,
          timeMin,
          timeMax,
          singleEvents: true,
          orderBy: "startTime",
          q: summary, // Google Calendar search query
        });
        for (const e of res.data.items ?? []) {
          if (e.status !== "cancelled" && e.summary?.toLowerCase().includes(summary.toLowerCase())) {
            matches.push({
              calendarId: cal.id,
              calendarName: cal.name,
              eventId: e.id ?? "",
              summary: e.summary ?? "",
              start: e.start?.dateTime ?? e.start?.date ?? "",
            });
          }
        }
      } catch {
        // Skip unreadable calendars
      }
    })
  );

  if (matches.length === 0) {
    return `❌ No event found matching "${summary}"${date ? ` on ${date}` : " in the next 30 days"}.`;
  }

  if (matches.length > 1) {
    const list = matches
      .map((m, i) => `  ${i + 1}. [${m.calendarName}] "${m.summary}" on ${formatDateTime(m.start)}`)
      .join("\n");
    return `⚠️ Multiple events found matching "${summary}":\n${list}\n\nPlease specify the date or be more specific so I know which one to delete.`;
  }

  // Exactly one match — delete it
  const match = matches[0];
  await calendarClient.events.delete({
    calendarId: match.calendarId,
    eventId: match.eventId,
  });

  return `🗑️ Deleted: [${match.calendarName}] "${match.summary}" on ${formatDateTime(match.start)}`;
}

/**
 * Deletes multiple events by name in one call.
 */
export async function deleteEventBatch(
  summaries: Array<{ summary: string; date?: string }>,
  profileId?: string
): Promise<string> {
  const results: string[] = [];
  for (const { summary, date } of summaries) {
    try {
      results.push(await deleteEvent(summary, profileId, date));
    } catch (err) {
      results.push(`❌ Failed to delete "${summary}" — ${err}`);
    }
  }
  return results.join("\n");
}

// ── Utilities ──────────────────────────────────────────────────────────────

function timeToMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + (m ?? 0);
}

function minutesToTime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function getEventDurationMinutes(event: CalendarEvent): number {
  if (event.isAllDay) return 0;
  return (new Date(event.end).getTime() - new Date(event.start).getTime()) / 60000;
}

function formatDateTime(iso: string): string {
  if (!iso) return "";
  if (iso.length === 10) return iso; 
  return new Date(iso).toLocaleString("en-US", {
    weekday: "short", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true,
    timeZone: TIMEZONE, 
  });
}

function formatTime(iso: string): string {
  if (!iso || iso.length === 10) return "";
  return new Date(iso).toLocaleTimeString("en-US", {
    hour: "numeric", minute: "2-digit", hour12: true,
    timeZone: TIMEZONE, 
  });
}

function formatDateRange(start: string, end: string): string {
  const s = new Date(start);
  const e = new Date(end);
  return `${s.toLocaleDateString("en-US", { month: "long", day: "numeric" })} – ${e.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}`;
}

function makeBar(minutes: number, maxMinutes: number): string {
  const filled = Math.round((minutes / maxMinutes) * 8);
  return "█".repeat(Math.max(0, filled)) + "░".repeat(Math.max(0, 8 - filled));
}

function getThisMonday(): string {
  const d = new Date();
  const day = d.getDay();
  const monday = new Date(d);
  monday.setDate(d.getDate() - ((day + 6) % 7));
  return monday.toISOString().split("T")[0];
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0];
}

function getDayName(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-US", { weekday: "short" });
}