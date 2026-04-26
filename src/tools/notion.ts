import { Client } from "@notionhq/client";
import { loadProfile } from "../lib/profiles";

// ── Types ──────────────────────────────────────────────────────────────────

export interface NotionTask {
  id: string;
  taskName: string;
  status: boolean;        // true = done
  category: string | null;
  notes: string | null;
  due: string | null;     // ISO date or datetime
  endDue: string | null;  // ISO date or datetime — end of window
}

export interface NewTask {
  taskName: string;
  category?: string;
  notes?: string;
  due?: string;           // ISO date YYYY-MM-DD or datetime YYYY-MM-DDThh:mm:ss
  endDue?: string;        // ISO date or datetime — end of the task window e.g. "2026-04-03T20:00:00"
}

export interface DatabaseSchema {
  categoryOptions: string[];
}

// ── Client factory ─────────────────────────────────────────────────────────

function getNotionClient(profileId?: string) {
  const profile = loadProfile(profileId);
  if (!profile.notionApiKey) {
    throw new Error(
      `Notion API key not set for profile "${profileId ?? "personal"}".\n` +
      `Add PERSONAL_NOTION_API_KEY to your .env file.`
    );
  }
  return new Client({ auth: profile.notionApiKey });
}

function getDatabaseId(profileId?: string): string {
  const profile = loadProfile(profileId);
  if (!profile.notionDatabaseId) {
    throw new Error(
      `Notion Database ID not set for profile "${profileId ?? "personal"}".\n` +
      `Add PERSONAL_NOTION_DATABASE_ID to your .env file.`
    );
  }
  return profile.notionDatabaseId;
}

// ── Schema inspection ──────────────────────────────────────────────────────

/**
 * Fetches the database schema to get current select options dynamically.
 * This means adding a new Category in Notion automatically works —
 * nothing is hardcoded here.
 */
export async function getDatabaseSchema(profileId?: string): Promise<DatabaseSchema> {
  const notion = getNotionClient(profileId);
  const dbId = getDatabaseId(profileId);

  const db = await notion.databases.retrieve({ database_id: dbId });
  const props = db.properties as Record<string, any>;

  // Fetch Category select options dynamically
  const categoryProp = props["Category"];
  const categoryOptions: string[] = categoryProp?.select?.options?.map(
    (o: any) => o.name
  ) ?? [];

  return {
    categoryOptions,
  };
}

// ── Read ───────────────────────────────────────────────────────────────────

/**
 * Lists tasks from the sprint board.
 * Can filter by completion status and/or category.
 */
export async function listTasks(
  profileId?: string,
  options: {
    showCompleted?: boolean;
    category?: string;
    dueBefore?: string;   // ISO date — show tasks due before this date
  } = {}
): Promise<NotionTask[]> {
  const notion = getNotionClient(profileId);
  const dbId = getDatabaseId(profileId);

  const filters: any[] = [];

  // Filter by completion — Notion "Status" type uses status filter not checkbox
  if (!options.showCompleted) {
    filters.push({
      property: "Status",
      status: { does_not_equal: "Done" },
    });
  }

  // Filter by category
  if (options.category) {
    filters.push({
      property: "Category",
      select: { equals: options.category },
    });
  }

  // Filter by due date
  if (options.dueBefore) {
    filters.push({
      property: "Due",
      date: { before: options.dueBefore },
    });
  }

  const res = await notion.databases.query({
    database_id: dbId,
    filter: filters.length === 1
      ? filters[0]
      : filters.length > 1
        ? { and: filters }
        : undefined,
    sorts: [
      { property: "Due", direction: "ascending" },
    ],
  });

  return res.results.map((page: any) => parseTask(page));
}

/**
 * Gets tasks for a specific week (due within the week range).
 */
export async function getWeekTasks(
  weekStart: string,
  weekEnd: string,
  profileId?: string
): Promise<NotionTask[]> {
  const notion = getNotionClient(profileId);
  const dbId = getDatabaseId(profileId);

  const res = await notion.databases.query({
    database_id: dbId,
    filter: {
      and: [
        { property: "Due", date: { on_or_after: weekStart } },
        { property: "Due", date: { before: weekEnd } },
      ],
    },
    sorts: [{ property: "Due", direction: "ascending" }],
  });

  return res.results.map((page: any) => parseTask(page));
}

/**
 * Gets all completed tasks for a week — used by weekly-review.ts.
 */
export async function getCompletedTasksForWeek(
  weekStart: string,
  weekEnd: string,
  profileId?: string
): Promise<NotionTask[]> {
  const notion = getNotionClient(profileId);
  const dbId = getDatabaseId(profileId);

  const res = await notion.databases.query({
    database_id: dbId,
    filter: {
      and: [
        { property: "Status", status: { equals: "Done" } },
        { property: "Due", date: { on_or_after: weekStart } },
        { property: "Due", date: { before: weekEnd } },
      ],
    },
  });

  return res.results.map((page: any) => parseTask(page));
}

// ── Write ──────────────────────────────────────────────────────────────────

/**
 * Adds a single task to the sprint board.
 */
export async function addTask(
  task: NewTask,
  profileId?: string
): Promise<string> {
  const notion = getNotionClient(profileId);
  const dbId = getDatabaseId(profileId);

  // Validate category against live options if provided
  if (task.category) {
    const schema = await getDatabaseSchema(profileId);
    if (!schema.categoryOptions.includes(task.category)) {
      return (
        `Category "${task.category}" not found.\n` +
        `Available: ${schema.categoryOptions.join(", ")}`
      );
    }
  }

  const properties: Record<string, any> = {
    "Task name": {
      title: [{ text: { content: task.taskName } }],
    },
    "Status": {
      status: { name: "Not started" },
    },
  };

  if (task.category) {
    properties["Category"] = { select: { name: task.category } };
  }

  if (task.notes) {
    properties["Notes"] = {
      rich_text: [{ text: { content: task.notes } }],
    };
  }

  if (task.due) {
    const hasTime = task.due.includes("T");
    const hasEndTime = task.endDue?.includes("T") ?? false;
    properties["Due"] = {
      date: {
        start: task.due,
        ...(task.endDue && { end: task.endDue }),
        ...(hasTime || hasEndTime ? { time_zone: "America/New_York" } : {}),
      },
    };
  }

  await notion.pages.create({
    parent: { database_id: dbId },
    properties,
  });

  const timeRange = task.due
    ? task.endDue
      ? ` — ${task.due} to ${task.endDue}`
      : ` — due ${task.due}`
    : "";

  return `✅ Task added: "${task.taskName}"${timeRange}${task.category ? ` [${task.category}]` : ""}`;
}

/**
 * Adds multiple tasks in one call — used by sunday-planning.ts.
 */
export async function addTaskBatch(
  tasks: NewTask[],
  profileId?: string
): Promise<string> {
  const results: string[] = [];
  for (const task of tasks) {
    try {
      results.push(await addTask(task, profileId));
    } catch (err) {
      results.push(`❌ Failed: "${task.taskName}" — ${err}`);
    }
  }
  return results.join("\n");
}

/**
 * Marks a task as complete by its Notion page ID.
 */
export async function markTaskComplete(
  taskId: string,
  profileId?: string
): Promise<string> {
  const notion = getNotionClient(profileId);
  await notion.pages.update({
    page_id: taskId,
    properties: {
      "Status": { status: { name: "Done" } },
    },
  });
  return `✅ Task marked complete`;
}

/**
 * Finds tasks by partial name match. Used to resolve a name to an ID
 * before completing or deleting when the user doesn't have the page ID.
 */
export async function findTasksByName(
  name: string,
  profileId?: string
): Promise<NotionTask[]> {
  const tasks = await listTasks(profileId, { showCompleted: false });
  const lower = name.toLowerCase();
  return tasks.filter((t) => t.taskName.toLowerCase().includes(lower));
}

/**
 * Marks a task complete by name search. If multiple tasks match, returns
 * a list so the user can clarify. If exactly one matches, completes it.
 */
export async function markTaskCompleteByName(
  name: string,
  profileId?: string
): Promise<string> {
  const matches = await findTasksByName(name, profileId);

  if (matches.length === 0) {
    return `❌ No incomplete task found matching "${name}".`;
  }

  if (matches.length > 1) {
    const list = matches
      .map((t, i) => `  ${i + 1}. "${t.taskName}"${t.due ? ` — due ${t.due}` : ""}${t.category ? ` [${t.category}]` : ""} (ID: ${t.id})`)
      .join("\n");
    return `⚠️ Multiple tasks match "${name}":\n${list}\n\nUse notion_mark_complete with the exact ID to specify which one.`;
  }

  return markTaskComplete(matches[0].id, profileId);
}

/**
 * Deletes (archives) a Notion task by page ID.
 * Notion API archives pages rather than hard-deleting them.
 */
export async function deleteTask(
  taskId: string,
  profileId?: string
): Promise<string> {
  const notion = getNotionClient(profileId);
  await notion.pages.update({
    page_id: taskId,
    archived: true,
  });
  return `🗑️ Task deleted`;
}

/**
 * Deletes a task by name search. If multiple match, lists them for clarification.
 */
export async function deleteTaskByName(
  name: string,
  profileId?: string
): Promise<string> {
  const matches = await findTasksByName(name, profileId);

  if (matches.length === 0) {
    return `❌ No incomplete task found matching "${name}".`;
  }

  if (matches.length > 1) {
    const list = matches
      .map((t, i) => `  ${i + 1}. "${t.taskName}"${t.due ? ` — due ${t.due}` : ""}${t.category ? ` [${t.category}]` : ""} (ID: ${t.id})`)
      .join("\n");
    return `⚠️ Multiple tasks match "${name}":\n${list}\n\nUse notion_delete_task with the exact ID to specify which one.`;
  }

  return deleteTask(matches[0].id, profileId);
}

// ── Formatting ─────────────────────────────────────────────────────────────

/**
 * Formats task list for display in Claude Code.
 */
export function formatTaskList(tasks: NotionTask[], title = "Tasks"): string {
  if (tasks.length === 0) return `No tasks found.`;

  const lines = [`${title} (${tasks.length})`, "─".repeat(40)];

  for (const t of tasks) {
    const check = t.status ? "✅" : "⬜";
    const due = t.due
      ? t.endDue
        ? ` — ${t.due} to ${t.endDue}`
        : ` — due ${t.due}`
      : "";
    const cat = t.category ? ` [${t.category}]` : "";
    const notes = t.notes ? `\n     ${t.notes.slice(0, 80)}` : "";
    lines.push(`${check} ${t.taskName}${cat}${due}${notes}`);
  }

  return lines.join("\n");
}

/**
 * Formats available category options for Claude to present when adding tasks.
 */
export async function formatCategoryOptions(profileId?: string): Promise<string> {
  const schema = await getDatabaseSchema(profileId);
  return `Available categories: ${schema.categoryOptions.join(", ")}`;
}

// ── Utilities ──────────────────────────────────────────────────────────────

function parseTask(page: any): NotionTask {
  const props = page.properties;
  return {
    id: page.id,
    taskName: props["Task name"]?.title?.[0]?.text?.content ?? "(untitled)",
    status: props["Status"]?.status?.name === "Done",
    category: props["Category"]?.select?.name ?? null,
    notes: props["Notes"]?.rich_text?.[0]?.text?.content ?? null,
    due: props["Due"]?.date?.start ?? null,
    endDue: props["Due"]?.date?.end ?? null,
  };
}