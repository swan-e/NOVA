# Nova — MCP Orchestration Guide

This file tells Claude how to route every request to the correct Nova tool.
Read this before every session. Never guess — follow these rules exactly.

---

## Core Mental Model

| Concept              | System              | Tools to use                          |
|----------------------|---------------------|---------------------------------------|
| **Tasks**            | Notion              | `notion_*`                            |
| **Events**           | Google Calendar     | `calendar_*`                          |
| **Schedule reads**   | Both                | `notion_week_tasks` + `calendar_list_upcoming` (always both, merged) |
| **Email**            | Gmail               | `gmail_*`                             |
| **Notes**            | Obsidian            | `obsidian_*`                          |
| **Job applications** | Google Sheets       | `jobs_*`                              |
| **Finances**         | Google Sheets       | `finance_*`                           |

---

## Routing Rules

### "Add a task" / "Remind me to..." / "Put X on my list"
→ **Notion** — use `notion_add_task` or `notion_add_batch_tasks`
→ Always call `notion_categories` first if no category is specified and one seems relevant

### "Schedule X" / "Add X to my calendar" / "Block time for X"
→ **Google Calendar** — use `calendar_create_event` or `calendar_create_batch`

### "What's my schedule today" / "Full day" / "What do I have today"
→ Full day — past and future both. Always query both:
  1. `calendar_today` — all Google Calendar events midnight to midnight
  2. `notion_list_tasks` with `dueBefore` set to end of today — all tasks for today
→ Present merged, sorted chronologically, with time ranges

### "What's coming up" / "What do I have next" / "What's left today"
→ From now forward only. Always query both:
  1. `calendar_list_upcoming` — Google Calendar events from now
  2. `notion_list_tasks` — Notion tasks from now
→ Present merged, sorted chronologically, with time ranges

### "What's my schedule this week" / "Any conflicts" / "Week overview"
→ Full week. Always query both:
  1. `notion_week_tasks` — tasks for the week
  2. `calendar_week_summary` — Google Calendar week view
→ Present merged and sorted

### "Move X to Y time" / "Change the title of X" / "Update my event"
→ `calendar_update_event` — only provide the fields being changed, all others are preserved
→ Always get the event ID first via `calendar_today` or `calendar_list_upcoming` before updating

### "Write a note" / "Save this to Obsidian" / "Add to my daily note"
→ **Obsidian** — use `obsidian_write` or `obsidian_append_daily`

### "Log a job" / "I applied to X" / "Add job application" / "Mark application as completed"
→ **Google Sheets** — use `jobs_add_application`
→ Always use profile: "work"
→ Always ask for sheetName if not specified (e.g. "SWE", "Internships")
→ Default submissionPlatform: "Company Website" unless stated otherwise
→ Default completionDate: today unless stated otherwise
→ Default status: "Completed" unless stated otherwise
→ Required: job title, company. Include location, URL, salary when provided.

### "Update job" / "Edit my application" / "Change status of X" / "Mark X as blocked"
→ **Google Sheets** — use `jobs_edit_application`
→ Always use profile: "work"
→ Use findCompany to locate the row, use findJob to narrow if multiple rows match
→ Only send the fields being changed — all others are preserved from the existing row
→ Always ask for sheetName if not specified

### "Add this receipt" / "Log this expense" / "I spent X" / "Upload receipt"
→ **Finance** — use `finance_add_transaction`
→ **Always default to current month tab** unless user specifies a different month
→ Call `finance_get_settings` first if unsure which category/source/type to use
→ If user provides a file path, pass it directly — do not modify the path

### "What receipts are pending" / "What's in the receipts folder"
→ **Finance** — use `finance_list_receipts`

### "What are my categories" / "What income sources do I have" / "Show finance settings"
→ **Finance** — use `finance_get_settings`

---

## Word Mappings

These words always mean Notion tasks, never calendar events:
- task, to-do, todo, reminder, item, thing to do, on my list

These words always mean Google Calendar events, never Notion:
- event, appointment, meeting, block, schedule, put on the calendar

These words mean a schedule view — always query BOTH Notion and Google Calendar:
- "what's on my calendar", "what do I have", "what's coming up", "this week", "today's schedule", "my schedule"

These words mean a job application log entry — use `jobs_add_application`:
- "applied to", "submitted application", "log a job", "add job", "I applied"

These words mean editing an existing job row — use `jobs_edit_application`:
- "update job", "edit application", "change status", "mark as blocked", "mark as in progress", "update my application"

These words mean a finance transaction — use `finance_add_transaction`:
- "receipt", "expense", "I spent", "I paid", "log this purchase", "add transaction", "upload receipt"

---

## Available Tools (full list)

### Gmail
- `gmail_triage` — fetch unread emails for triage
- `gmail_delete` — trash emails by ID
- `gmail_delete_by_sender` — trash all from a sender address
- `gmail_delete_by_company` — trash all matching a company name
- `gmail_summarize` — raw email text for summarization

### Google Calendar
- `calendar_today` — **full day view**, all events midnight to midnight (use for "today's schedule", "full day")
- `calendar_list_upcoming` — events from now forward only (use for "what's next", "what's coming up")
- `calendar_update_event` — update title, time, description, or location of an existing event (requires event ID)
- `calendar_create_event` — create a single event
- `calendar_create_batch` — create multiple events
- `calendar_delete_event` — delete event by name
- `calendar_delete_batch` — delete multiple events
- `calendar_list_calendars` — list all sub-calendars
- `calendar_week_summary` — full week dashboard with free time analysis

### Notion
- `notion_list_tasks` — list tasks, with optional filters
- `notion_week_tasks` — tasks due this week
- `notion_add_task` — add a single task
- `notion_add_batch_tasks` — add multiple tasks at once
- `notion_mark_complete` — mark a task done by page ID
- `notion_categories` — list valid category options
- `notion_db_schema` — inspect database schema

### Obsidian
- `obsidian_read` — read a note by path
- `obsidian_write` — write or append to a note
- `obsidian_list` — list notes in a folder
- `obsidian_search` — search all notes by keyword
- `obsidian_append_daily` — append to today's daily note

### Jobs
- `jobs_add_application` — log a new job application row to Google Sheets
  - Required: `job` (title), `company`, `sheetName` (e.g. "SWE", "Internships")
  - Optional: `status`, `submissionPlatform`, `location`, `completionDate` (MM/DD/YYYY), `website`, `salary`, `profile`
  - Defaults: status → "Completed", submissionPlatform → "Company Website", completionDate → today, profile → "work"

- `jobs_edit_application` — edit an existing job application row in Google Sheets
  - Required: `findCompany`, `sheetName`
  - Optional: `findJob` (narrow search), any field to update
  - Only fields you provide will be changed — all others stay as-is

### Finance
- `finance_add_transaction` — OCR a receipt photo or PDF and append to the transactions sheet
  - **Always default to current month tab** unless user explicitly specifies a different month
  - Current month tab format: full month name + year e.g. "June 2026"
  - Pass `monthYear` only when user says "add this to March" or "this was from last month"
  - Expenses → columns E–I, Income → columns A–D
  - Supported file types: JPG, PNG, WEBP, PDF
  - File path is the absolute path on the server e.g. `/app/receipts/receipt_2026-06-09.jpg`

- `finance_list_receipts` — list all unprocessed receipt files waiting in `/app/receipts/`
  - Call this before processing to see what's pending
  - Use returned filenames to build the full path for `finance_add_transaction`

- `finance_get_settings` — read current dropdown options from the Settings sheet
  - Call this if unsure which category/source/type to use for a transaction
  - Shows all valid values for Category, Source (income), and Type (expense)

### Config
- `config_update_lifestyle` — update sleep or meal schedule overrides

---

## Display Format

→ **Schedule output:**
  - Always show time ranges: "3:00 PM – 4:30 PM" not "3:00 PM"
  - If end time unknown: "3:00 PM – ?"
  - Use three columns when tabling: Time Range | Event/Task | Type
  - Sort all items chronologically regardless of source
  - Never answer a schedule question from only one source

→ **Finance output:**
  - Always confirm tab name, row number, and Drive link after adding a transaction
  - If OCR parsed fields seem wrong, show them and ask user to confirm before writing

---

## Profiles
- `personal` — default for everything unless the user says "work"
- `work` — work Gmail, work calendar, and all job sheet operations

---

## Rules
1. For any schedule question, always call both `notion_week_tasks` AND `calendar_list_upcoming` (or `calendar_week_summary`). Never answer from one source alone.
2. Never add a task to Google Calendar. Tasks go to Notion.
3. Never add an event to Notion. Events go to Google Calendar.
4. When in doubt whether something is a task or event, ask: "Should I add this as a Notion task or a calendar event?"
5. Always use `notion_categories` before `notion_add_task` if the category isn't already known from context.
6. When a time is specified for a Notion task, always pass it in the `due` field as `YYYY-MM-DDThh:mm:ss` — never put time in the task name.
7. When logging or editing a job application, always use `jobs_*` tools with profile: "work". Never use Notion tasks for job tracking.
8. Always ask for `sheetName` when using any `jobs_*` tool if it hasn't been specified.
9. For finance transactions, always default to the current month. Never ask which month unless the user explicitly mentions a different one.
10. Always call `finance_list_receipts` before processing receipts so you know exactly which files are pending.