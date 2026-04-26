import { gmail as gmailClient } from "@googleapis/gmail";
import { loadProfile, getGoogleAuth } from "../lib/profiles";

// ── Types ──────────────────────────────────────────────────────────────────

export interface EmailSummary {
  id: string;
  from: string;
  senderName: string;
  senderEmail: string;
  company: string;
  subject: string;
  date: string;
  snippet: string;
}

export interface BatchResult {
  emails: EmailSummary[];
  totalUnread: number;
  nextPageToken?: string;
}

export interface DeleteResult {
  deleted: number;
  failed: number;
  ids: string[];
}

// ── Client factory ─────────────────────────────────────────────────────────

function getGmailClient(profileId?: string) {
  const profile = loadProfile(profileId);
  const auth = getGoogleAuth(profile);
  return gmailClient({ version: "v1", auth });
}

// ── Fetch ──────────────────────────────────────────────────────────────────

/**
 * Fetches a batch of unread emails for display in Claude Code triage session.
 * Returns structured summaries — not full bodies, just enough to decide.
 */
export async function fetchEmailBatch(
  profileId?: string,
  batchSize = 20,
  pageToken?: string,
  query = "is:unread"
): Promise<BatchResult> {
  const gmail = getGmailClient(profileId);

  const profile = await gmail.users.getProfile({ userId: "me" });
  const totalUnread = profile.data.messagesTotal ?? 0;

  const listRes = await gmail.users.messages.list({
    userId: "me",
    maxResults: batchSize,
    q: query,
    ...(pageToken && { pageToken }),
  });

  const messages = listRes.data.messages ?? [];
  const emails = await fetchMessageDetails(gmail, messages);

  return {
    emails,
    totalUnread,
    nextPageToken: listRes.data.nextPageToken ?? undefined,
  };
}

/**
 * Fetches all unread emails received since a given Unix timestamp (seconds).
 * Used by daily-email-summary.ts for incremental fetching — each run
 * only processes emails that arrived since the previous run.
 * Pages through all results with no cap.
 */
export async function fetchEmailsSince(
  since: number,
  profileId?: string
): Promise<EmailSummary[]> {
  const gmail = getGmailClient(profileId);
  const query = `is:unread after:${since}`;

  const allMessages: Array<{ id?: string | null }> = [];
  let pageToken: string | undefined;

  do {
    const listRes = await gmail.users.messages.list({
      userId: "me",
      maxResults: 100,
      q: query,
      ...(pageToken && { pageToken }),
    });

    allMessages.push(...(listRes.data.messages ?? []));
    pageToken = listRes.data.nextPageToken ?? undefined;
  } while (pageToken);

  if (allMessages.length === 0) return [];

  const emails = await fetchMessageDetails(gmail, allMessages);

  // Return oldest first so Obsidian note reads chronologically
  return emails.sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
  );
}

/**
 * Fetches all emails from a specific sender.
 */
export async function fetchEmailsBySender(
  senderEmail: string,
  profileId?: string
): Promise<EmailSummary[]> {
  const result = await fetchEmailBatch(profileId, 50, undefined, `from:${senderEmail}`);
  return result.emails;
}

/**
 * Fetches emails from all senders matching a company name.
 */
export async function fetchEmailsByCompany(
  companyName: string,
  profileId?: string
): Promise<EmailSummary[]> {
  const result = await fetchEmailBatch(profileId, 50, undefined, `from:${companyName}`);
  return result.emails;
}

// ── Delete ─────────────────────────────────────────────────────────────────

/**
 * Moves a list of email IDs to trash.
 */
export async function deleteEmails(
  messageIds: string[],
  profileId?: string
): Promise<DeleteResult> {
  const gmail = getGmailClient(profileId);
  let deleted = 0;
  let failed = 0;
  const ids: string[] = [];

  const chunks = chunkArray(messageIds, 10);
  for (const chunk of chunks) {
    await Promise.all(
      chunk.map(async (id) => {
        try {
          await gmail.users.messages.trash({ userId: "me", id });
          deleted++;
          ids.push(id);
        } catch {
          failed++;
        }
      })
    );
  }

  return { deleted, failed, ids };
}

export async function deleteAllBySender(
  senderEmail: string,
  profileId?: string
): Promise<DeleteResult> {
  const emails = await fetchEmailsBySender(senderEmail, profileId);
  const ids = emails.map((e) => e.id);
  if (ids.length === 0) return { deleted: 0, failed: 0, ids: [] };
  return deleteEmails(ids, profileId);
}

export async function deleteAllByCompany(
  companyName: string,
  profileId?: string
): Promise<DeleteResult> {
  const emails = await fetchEmailsByCompany(companyName, profileId);
  const ids = emails.map((e) => e.id);
  if (ids.length === 0) return { deleted: 0, failed: 0, ids: [] };
  return deleteEmails(ids, profileId);
}

// ── Summarize ─────────────────────────────────────────────────────────────

/**
 * Fetches recent unread emails as raw text for summarization.
 */
export async function fetchRawEmailsForSummary(
  profileId?: string,
  maxResults = 15
): Promise<string> {
  const { emails } = await fetchEmailBatch(profileId, maxResults);
  if (emails.length === 0) return "No unread emails.";
  return emails
    .map(
      (e, i) =>
        `[${i + 1}] From: ${e.senderName} <${e.senderEmail}>\n` +
        `Subject: ${e.subject}\n` +
        `Date: ${e.date}\n` +
        `Preview: ${e.snippet}`
    )
    .join("\n\n---\n\n");
}

// ── Formatting ─────────────────────────────────────────────────────────────

/**
 * Formats a batch of emails as a readable triage list for Claude to present.
 */
export function formatBatchForTriage(batch: BatchResult): string {
  const { emails, totalUnread } = batch;
  if (emails.length === 0) return "No unread emails found.";

  const lines = [
    `📬 Showing ${emails.length} of ${totalUnread} unread emails\n`,
    "─".repeat(50),
  ];

  emails.forEach((e, i) => {
    lines.push(
      `\n[${i + 1}] ${e.senderName} <${e.senderEmail}>` +
        (e.company ? ` — ${e.company}` : "") +
        `\n    Subject: ${e.subject}` +
        `\n    Date:    ${e.date}` +
        `\n    Preview: ${e.snippet.slice(0, 120)}${e.snippet.length > 120 ? "..." : ""}`
    );
  });

  lines.push(
    "\n" + "─".repeat(50),
    '\nReply with the numbers you want to delete (e.g. "1, 3, 5")',
    'or "all" to delete all shown, or "skip" to move to the next batch.'
  );

  return lines.join("\n");
}

// ── Internal helpers ───────────────────────────────────────────────────────

/**
 * Fetches full metadata for a list of message stubs in parallel.
 * Shared by fetchEmailBatch and fetchEmailsSince.
 */
async function fetchMessageDetails(
  gmail: ReturnType<typeof gmailClient>,
  messages: Array<{ id?: string | null }>
): Promise<EmailSummary[]> {
  return Promise.all(
    messages
      .filter((m) => m.id)
      .map(async (msg) => {
        const full = await gmail.users.messages.get({
          userId: "me",
          id: msg.id!,
          format: "metadata",
          metadataHeaders: ["Subject", "From", "Date"],
        });

        const headers = full.data.payload?.headers ?? [];
        const get = (name: string) =>
          headers.find((h) => h.name === name)?.value ?? "";

        const fromRaw = get("From");
        const { name, email, company } = parseFrom(fromRaw);

        return {
          id: msg.id!,
          from: fromRaw,
          senderName: name,
          senderEmail: email,
          company,
          subject: get("Subject") || "(no subject)",
          date: get("Date"),
          snippet: full.data.snippet ?? "",
        };
      })
  );
}

function parseFrom(raw: string): {
  name: string;
  email: string;
  company: string;
} {
  const match = raw.match(/^"?([^"<]*)"?\s*<?([^>]+)>?$/);
  const name = match?.[1]?.trim() ?? raw;
  const email = match?.[2]?.trim() ?? raw;
  const domain = email.split("@")[1] ?? "";
  const company = domain.split(".")[0] ?? "";
  return {
    name: name || email,
    email,
    company: company.charAt(0).toUpperCase() + company.slice(1),
  };
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}