// @ts-nocheck
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  listTasks,
  getWeekTasks,
  addTask,
  addTaskBatch,
  markTaskComplete,
  markTaskCompleteByName,
  deleteTask,
  deleteTaskByName,
  formatTaskList,
  formatCategoryOptions,
  getDatabaseSchema,
} from "./tools/notion";

import {
  readNote,
  writeNote,
  listNotes,
  searchNotes,
  appendToDailyNote,
} from "./tools/obsidian";

import {
  getWeekSummary,
  formatWeekDashboard,
  createEvent,
  createEventBatch,
  updateEvent,
  listUpcomingEvents,
  listTodayEvents,
  formatCalendarList,
  deleteEvent,
  deleteEventBatch,
} from "./tools/calendar";

import {
  fetchEmailBatch,
  deleteEmails,
  deleteAllBySender,
  deleteAllByCompany,
  formatBatchForTriage,
  fetchRawEmailsForSummary,
} from "./tools/gmail";

import { addJobApplication, editJobApplication } from "./tools/jobs";

import { addTransaction, getFinanceSettings } from "./tools/finance";
import type { TransactionOverrides } from "./tools/finance";

import { addLifestyleOverride } from "./lib/config";

// ── Server ─────────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "nova-mcp",
  version: "1.0.0",
});

// ── Gmail Tools ────────────────────────────────────────────────────────────

server.tool(
  "gmail_triage",
  "Fetch a batch of unread emails formatted for triage. Claude will display them and ask which to delete.",
  {
    profile:    z.enum(["personal", "work"]).optional().describe("Which Gmail account. Defaults to personal."),
    batchSize:  z.number().min(1).max(50).optional().describe("How many emails to show at once. Default 20."),
    pageToken:  z.string().optional().describe("Token for next page of results."),
    query:      z.string().optional().describe("Gmail search query. Default: is:unread"),
  },
  async ({ profile, batchSize, pageToken, query }) => {
    const batch = await fetchEmailBatch(profile, batchSize, pageToken, query);
    return {
      content: [{
        type: "text",
        text: formatBatchForTriage(batch) +
          (batch.nextPageToken ? `\n\n[nextPageToken: ${batch.nextPageToken}]` : ""),
      }],
    };
  }
);

server.tool(
  "gmail_delete",
  "Delete (trash) specific emails by their IDs. Use after the user selects which emails to remove.",
  {
    messageIds: z.array(z.string()).describe("Array of Gmail message IDs to trash."),
    profile:    z.enum(["personal", "work"]).optional(),
  },
  async ({ messageIds, profile }) => {
    const result = await deleteEmails(messageIds, profile);
    return {
      content: [{
        type: "text",
        text: `Deleted ${result.deleted} email(s).` +
          (result.failed > 0 ? ` ${result.failed} failed.` : ""),
      }],
    };
  }
);

server.tool(
  "gmail_delete_by_sender",
  "Delete all emails from a specific sender email address.",
  {
    senderEmail: z.string().describe("Full email address e.g. newsletter@company.com"),
    profile:     z.enum(["personal", "work"]).optional(),
  },
  async ({ senderEmail, profile }) => {
    const result = await deleteAllBySender(senderEmail, profile);
    return {
      content: [{
        type: "text",
        text: result.deleted === 0
          ? `No emails found from ${senderEmail}.`
          : `Deleted ${result.deleted} email(s) from ${senderEmail}.`,
      }],
    };
  }
);

server.tool(
  "gmail_delete_by_company",
  "Delete all emails matching a company name (matches sender domain).",
  {
    companyName: z.string().describe("Company name e.g. LinkedIn, Notion, Figma"),
    profile:     z.enum(["personal", "work"]).optional(),
  },
  async ({ companyName, profile }) => {
    const result = await deleteAllByCompany(companyName, profile);
    return {
      content: [{
        type: "text",
        text: result.deleted === 0
          ? `No emails found matching "${companyName}".`
          : `Deleted ${result.deleted} email(s) matching "${companyName}".`,
      }],
    };
  }
);

server.tool(
  "gmail_summarize",
  "Fetch recent unread emails as raw text for summarization. Used by daily summary script.",
  {
    profile:    z.enum(["personal", "work"]).optional(),
    maxResults: z.number().optional().describe("Max emails to fetch. Default 15."),
  },
  async ({ profile, maxResults }) => {
    const text = await fetchRawEmailsForSummary(profile, maxResults);
    return { content: [{ type: "text", text }] };
  }
);

// ── Calendar Tools ────────────────────────────────────────────────────────

server.tool(
  "calendar_list_calendars",
  "List all your Google calendars — primary plus all sub-calendars like GYM, Class Schedule, Monthly, etc.",
  {
    profile: z.enum(["personal", "work"]).optional(),
  },
  async ({ profile }) => {
    const text = await formatCalendarList(profile);
    return { content: [{ type: "text", text }] };
  }
);

server.tool(
  "calendar_delete_event",
  "Delete a calendar event by name. Optionally specify a date to narrow the search.",
  {
    summary: z.string().describe("Event name or partial name to search for"),
    date: z.string().optional().describe("ISO date YYYY-MM-DD to narrow search to a specific day"),
    profile: z.enum(["personal", "work"]).optional(),
  },
  async ({ summary, date, profile }) => {
    const text = await deleteEvent(summary, profile, date);
    return { content: [{ type: "text", text }] };
  }
);

server.tool(
  "calendar_delete_batch",
  "Delete multiple calendar events at once.",
  {
    events: z.array(z.object({
      summary: z.string(),
      date: z.string().optional().describe("ISO date YYYY-MM-DD"),
    })),
    profile: z.enum(["personal", "work"]).optional(),
  },
  async ({ events, profile }) => {
    const text = await deleteEventBatch(events, profile);
    return { content: [{ type: "text", text }] };
  }
);

server.tool(
  "calendar_week_summary",
  "Get a full week summary dashboard — events, free slots, scheduled vs free time breakdown. Use this at the start of Sunday planning.",
  {
    profile:          z.enum(["personal", "work"]).optional(),
    weekStartDate:    z.string().optional().describe("ISO date YYYY-MM-DD. Defaults to this Monday."),
    freeTimeTargetHours: z.number().optional().describe("How many free hours the user wants this week."),
  },
  async ({ profile, weekStartDate, freeTimeTargetHours }) => {
    const summary = await getWeekSummary(profile, weekStartDate);
    const dashboard = formatWeekDashboard(summary, freeTimeTargetHours ?? 40);
    return { content: [{ type: "text", text: dashboard }] };
  }
);

server.tool(
  "calendar_list_upcoming",
  "List upcoming calendar events from now forward.",
  {
    profile:    z.enum(["personal", "work"]).optional(),
    maxResults: z.number().optional(),
  },
  async ({ profile, maxResults }) => {
    const text = await listUpcomingEvents(profile, maxResults);
    return { content: [{ type: "text", text }] };
  }
);

server.tool(
  "calendar_today",
  "List ALL events for a specific day from midnight to midnight — includes past events. Use this for 'what's my schedule today' or 'full day view'. For 'what's coming up' or 'what's next', use calendar_list_upcoming instead.",
  {
    profile: z.enum(["personal", "work"]).optional(),
    date:    z.string().optional().describe("ISO date YYYY-MM-DD. Defaults to today."),
  },
  async ({ profile, date }) => {
    const text = await listTodayEvents(profile, date);
    return { content: [{ type: "text", text }] };
  }
);

server.tool(
  "calendar_create_event",
  "Create a single calendar event.",
  {
    summary:       z.string().describe("Event title"),
    startDateTime: z.string().describe("ISO 8601 e.g. 2025-04-01T09:00:00"),
    endDateTime:   z.string().describe("ISO 8601 e.g. 2025-04-01T10:00:00"),
    description:   z.string().optional(),
    isAllDay:      z.boolean().optional(),
    calendarName:  z.string().optional(),
    profile:       z.enum(["personal", "work"]).optional(),
    force:         z.boolean().optional().describe("Skip conflict check and create anyway"),
  },
  async ({ profile, force, ...event }) => {
    const text = await createEvent(event, profile, force ?? false);
    return { content: [{ type: "text", text }] };
  }
);

server.tool(
  "calendar_create_batch",
  "Create multiple calendar events at once. Use when the user gives you several events to add.",
  {
    events: z.array(z.object({
      summary:       z.string(),
      startDateTime: z.string(),
      endDateTime:   z.string(),
      description:   z.string().optional(),
      isAllDay:      z.boolean().optional(),
      calendarName:  z.string().optional().describe("Sub-calendar name e.g. GYM, Class Schedule"),
    })),
    profile: z.enum(["personal", "work"]).optional(),
  },
  async ({ events, profile }) => {
    const text = await createEventBatch(events, profile);
    return { content: [{ type: "text", text }] };
  }
);

server.tool(
  "calendar_update_event",
  "Update an existing calendar event. Only the fields you provide will be changed — all others stay the same. Runs conflict detection on new times unless force is true. Get the event ID from calendar_today or calendar_list_upcoming.",
  {
    eventId:       z.string().describe("Google Calendar event ID. Get this from calendar_today or calendar_list_upcoming."),
    summary:       z.string().optional().describe("New event title"),
    startDateTime: z.string().optional().describe("New start time ISO 8601 e.g. 2025-04-01T09:00:00"),
    endDateTime:   z.string().optional().describe("New end time ISO 8601 e.g. 2025-04-01T10:00:00"),
    description:   z.string().optional().describe("New description. Pass empty string to clear it."),
    location:      z.string().optional().describe("New location. Pass empty string to clear it."),
    force:         z.boolean().optional().describe("Skip conflict check and update anyway"),
    profile:       z.enum(["personal", "work"]).optional(),
  },
  async ({ eventId, profile, force, ...updates }) => {
    const text = await updateEvent(eventId, updates, profile, force ?? false);
    return { content: [{ type: "text", text }] };
  }
);



server.tool(
  "config_update_lifestyle",
  "Update sleep or meal schedule. Use when the user says things like 'move my bedtime tonight' or 'skip lunch today' or 'shift breakfast going forward'.",
  {
    type:           z.enum(["sleep", "meal"]).describe("What to update"),
    scope:          z.enum(["day", "week", "forward"]).describe("day = just today, week = this week, forward = permanent"),
    date:           z.string().optional().describe("ISO date YYYY-MM-DD. Required for scope: day"),
    weekOf:         z.string().optional().describe("ISO date of the Sunday. Required for scope: week"),
    fromDate:       z.string().optional().describe("ISO date. Required for scope: forward"),
    meal:           z.string().optional().describe("Which meal: breakfast, lunch, dinner, snacks"),
    bedtime:        z.string().optional().describe("New bedtime HH:MM"),
    wakeTime:       z.string().optional().describe("New wake time HH:MM"),
    windowStart:    z.string().optional().describe("Meal window start HH:MM"),
    windowEnd:      z.string().optional().describe("Meal window end HH:MM"),
    durationMinutes: z.number().optional(),
    reason:         z.string().optional().describe("Short reason, stored for context"),
  },
  async (args) => {
    const override = await addLifestyleOverride(args);
    const scopeLabel = {
      day:     `for ${args.date ?? "today"}`,
      week:    `for this week`,
      forward: `going forward from ${args.fromDate ?? "today"}`,
    }[args.scope];

    return {
      content: [{
        type: "text",
        text: `Updated ${args.type} schedule ${scopeLabel}.\nOverride ID: ${override.id}`,
      }],
    };
  }
);

// ── Notion Tools ──────────────────────────────────────────────────────────

server.tool(
  "notion_list_tasks",
  "List tasks from the Notion sprint board. Can filter by category or completion status.",
  {
    profile:       z.enum(["personal", "work"]).optional(),
    showCompleted: z.boolean().optional().describe("Include completed tasks. Default false."),
    category:      z.string().optional().describe("Filter by category e.g. Study, Project"),
    dueBefore:     z.string().optional().describe("ISO date — show tasks due before this date"),
  },
  async ({ profile, showCompleted, category, dueBefore }) => {
    const tasks = await listTasks(profile, { showCompleted, category, dueBefore });
    const text = formatTaskList(tasks, "Sprint Board Tasks");
    return { content: [{ type: "text", text }] };
  }
);

server.tool(
  "notion_add_task",
  "Add a single task to the Notion sprint board.",
  {
    taskName:  z.string(),
    category:  z.string().optional().describe("Must match an existing category. Use notion_categories to see options."),
    notes:     z.string().optional(),
    due:       z.string().optional().describe("ISO date YYYY-MM-DD or datetime YYYY-MM-DDThh:mm:ss. Always include time if the user specifies one — never put time in the task name."),
    endDue:    z.string().optional().describe("End of the task window. ISO date or datetime YYYY-MM-DDThh:mm:ss. Use when the user gives a range e.g. '6–8 PM'. Never put the end time in the task name."),
    profile:   z.enum(["personal", "work"]).optional(),
  },
  async ({ profile, ...task }) => {
    const text = await addTask(task, profile);
    return { content: [{ type: "text", text }] };
  }
);

server.tool(
  "notion_add_batch_tasks",
  "Add multiple tasks to the Notion sprint board at once. Use during Sunday planning.",
  {
    tasks: z.array(z.object({
      taskName: z.string(),
      category: z.string().optional(),
      notes:    z.string().optional(),
      due:      z.string().optional().describe("ISO date YYYY-MM-DD or datetime YYYY-MM-DDThh:mm:ss. Always include time if the user specifies one — never put time in the task name."),
      endDue:   z.string().optional().describe("End of the task window. ISO date or datetime YYYY-MM-DDThh:mm:ss. Use when the user gives a range e.g. '6–8 PM'. Never put the end time in the task name."),
    })),
    profile: z.enum(["personal", "work"]).optional(),
  },
  async ({ tasks, profile }) => {
    const text = await addTaskBatch(tasks, profile);
    return { content: [{ type: "text", text }] };
  }
);

server.tool(
  "notion_mark_complete",
  "Mark a task as complete. Accepts either a task name (searches for it) or an exact Notion page ID. If multiple tasks match the name, lists them for clarification.",
  {
    taskName: z.string().optional().describe("Partial or full task name to search for. Use this when you don't have the page ID."),
    taskId:   z.string().optional().describe("Exact Notion page ID. Use this when you have it from notion_list_tasks."),
    profile:  z.enum(["personal", "work"]).optional(),
  },
  async ({ taskName, taskId, profile }) => {
    if (taskId) {
      const text = await markTaskComplete(taskId, profile);
      return { content: [{ type: "text", text }] };
    }
    if (taskName) {
      const text = await markTaskCompleteByName(taskName, profile);
      return { content: [{ type: "text", text }] };
    }
    return { content: [{ type: "text", text: "❌ Provide either taskName or taskId." }] };
  }
);

server.tool(
  "notion_delete_task",
  "Delete (archive) a Notion task. Accepts either a task name (searches for it) or an exact Notion page ID. If multiple tasks match the name, lists them for clarification.",
  {
    taskName: z.string().optional().describe("Partial or full task name to search for."),
    taskId:   z.string().optional().describe("Exact Notion page ID from notion_list_tasks."),
    profile:  z.enum(["personal", "work"]).optional(),
  },
  async ({ taskName, taskId, profile }) => {
    if (taskId) {
      const text = await deleteTask(taskId, profile);
      return { content: [{ type: "text", text }] };
    }
    if (taskName) {
      const text = await deleteTaskByName(taskName, profile);
      return { content: [{ type: "text", text }] };
    }
    return { content: [{ type: "text", text: "❌ Provide either taskName or taskId." }] };
  }
);

server.tool(
  "notion_categories",
  "List available Category options from your Notion database. Always call this before adding tasks to get valid category names.",
  {
    profile: z.enum(["personal", "work"]).optional(),
  },
  async ({ profile }) => {
    const text = await formatCategoryOptions(profile);
    return { content: [{ type: "text", text }] };
  }
);

server.tool(
  "notion_week_tasks",
  "Get all tasks due this week from Notion. Used in Sunday planning dashboard.",
  {
    weekStart: z.string().describe("ISO date YYYY-MM-DD — start of the week"),
    weekEnd:   z.string().describe("ISO date YYYY-MM-DD — end of the week"),
    profile:   z.enum(["personal", "work"]).optional(),
  },
  async ({ weekStart, weekEnd, profile }) => {
    const tasks = await getWeekTasks(weekStart, weekEnd, profile);
    const text = formatTaskList(tasks, `Tasks for week of ${weekStart}`);
    return { content: [{ type: "text", text }] };
  }
);

// ── Obsidian Tools ─────────────────────────────────────────────────────────

server.tool(
  "obsidian_read",
  "Read a note from the Obsidian vault by relative path.",
  {
    notePath: z.string().describe("Relative path e.g. 'Weekly Reviews/2025-03-24' or 'Daily/2025-03-19'"),
    profile:  z.enum(["personal", "work"]).optional(),
  },
  async ({ notePath, profile }) => {
    const text = await readNote(notePath, profile);
    return { content: [{ type: "text", text }] };
  }
);

server.tool(
  "obsidian_write",
  "Write or append to a note in the Obsidian vault. Creates folders automatically.",
  {
    notePath: z.string().describe("Relative path e.g. 'Daily/2025-03-19'"),
    content:  z.string(),
    append:   z.boolean().optional().describe("Append to existing note instead of overwriting. Default false."),
    profile:  z.enum(["personal", "work"]).optional(),
  },
  async ({ notePath, content, append, profile }) => {
    const text = await writeNote(notePath, content, { append, profileId: profile });
    return { content: [{ type: "text", text }] };
  }
);

server.tool(
  "obsidian_list",
  "List notes in a folder within the Obsidian vault.",
  {
    folderPath: z.string().optional().describe("Relative folder path. Defaults to vault root."),
    profile:    z.enum(["personal", "work"]).optional(),
  },
  async ({ folderPath, profile }) => {
    const text = await listNotes(folderPath, profile);
    return { content: [{ type: "text", text }] };
  }
);

server.tool(
  "obsidian_search",
  "Search all notes in the Obsidian vault for a keyword.",
  {
    query:   z.string(),
    profile: z.enum(["personal", "work"]).optional(),
  },
  async ({ query, profile }) => {
    const text = await searchNotes(query, profile);
    return { content: [{ type: "text", text }] };
  }
);

server.tool(
  "obsidian_append_daily",
  "Append a quick note or idea to today's daily note in Obsidian.",
  {
    content: z.string(),
    profile: z.enum(["personal", "work"]).optional(),
  },
  async ({ content, profile }) => {
    const text = await appendToDailyNote(content, profile);
    return { content: [{ type: "text", text }] };
  }
);

// ── Jobs Tools ─────────────────────────────────────────────────────────────

server.tool(
  "jobs_add_application",
  "Log a job application to Google Sheets. Specify sheetName to target a specific tab (e.g. 'SWE', 'Internships').",
  {
    job:                z.string(),
    company:            z.string(),
    status:             z.enum(["Completed", "Blocked", "In Progress", "Not Started"]).optional(),
    submissionPlatform: z.string().optional().describe("Where you applied. Defaults to 'Company Website'."),
    location:           z.string().optional(),
    completionDate:     z.string().optional().describe("MM/DD/YYYY — defaults to today"),
    website:            z.string().optional(),
    salary:              z.string().optional(),
    worksheet:          z.enum(["fulltime", "intern"]).optional().describe("Which spreadsheet to target. Defaults to 'fulltime'."),
    sheetName:          z.string().optional().describe("Tab name in the spreadsheet e.g. 'SWE', 'Internships'. Defaults to JOB_SHEET_NAME env var."),
    profile:            z.enum(["personal", "work"]).optional(),
  },
  async (data) => {
    const range = await addJobApplication(data, data.profile);
    return {
      content: [{
        type: "text",
        text: `✅ Logged **${data.job}** at **${data.company}** → ${range}`,
      }],
    };
  }
);

server.tool(
  "jobs_edit_application",
  "Edit an existing job application row in Google Sheets. Find the row by company and/or job title, then update any fields.",
  {
    findCompany:        z.string().describe("Company name to search for"),
    findJob:            z.string().optional().describe("Job title to narrow the search if multiple rows match the same company"),
    worksheet:          z.enum(["fulltime", "intern"]).optional().describe("Which spreadsheet to target. Defaults to 'fulltime'."),
    sheetName:          z.string().optional().describe("Tab name e.g. 'SWE'. Defaults to JOB_SHEET_NAME env var."),
    job:                z.string().optional(),
    company:            z.string().optional(),
    status:             z.enum(["Completed", "Blocked", "In Progress", "Not Started"]).optional(),
    submissionPlatform: z.string().optional(),
    location:           z.string().optional(),
    completionDate:     z.string().optional(),
    website:            z.string().optional(),
    salary:              z.string().optional(),
    profile:            z.enum(["personal", "work"]).optional(),
  },
  async (data) => {
    const result = await editJobApplication(data, data.profile);
    return { content: [{ type: "text", text: result }] };
  }
);

// ── Finance Tools ──────────────────────────────────────────────────────────

server.tool(
  "finance_add_transaction",
  "Upload a receipt photo or PDF invoice, OCR it, and append it to the transactions sheet. Defaults to current month tab unless monthYear is specified.",
  {
    filePath:  z.string().describe("Absolute path to the receipt image (JPG/PNG/WEBP) or PDF."),
    monthYear: z.string().optional().describe('Override target month tab e.g. "June 2026". Defaults to current month.'),
    overrides: z.object({
      date:        z.string().optional().describe("Override parsed date (YYYY-MM-DD)"),
      amount:      z.number().optional().describe("Override parsed amount"),
      description: z.string().optional().describe("Override parsed description"),
      type:        z.enum(["income", "expense"]).optional().describe("Override income/expense classification"),
      source:      z.string().optional().describe("Income source override (income only)"),
      expenseType: z.string().optional().describe("Want/Need/Savings override (expense only)"),
      category:    z.string().optional().describe("Category override (expense only)"),
    }).optional().describe("Manually override any OCR-parsed fields before writing to the sheet."),
  },
  async ({ filePath, monthYear, overrides }) => {
    const text = await addTransaction(filePath, monthYear, overrides as TransactionOverrides);
    return { content: [{ type: "text" as const, text }] };
  }
);

server.tool(
  "finance_get_settings",
  "Read current dropdown options from the Settings sheet — categories, income sources, and expense types.",
  {},
  async () => {
    const text = await getFinanceSettings();
    return { content: [{ type: "text" as const, text }] };
  }
);

// ── Start ──────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("NOVA MCP server running on stdio");
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});