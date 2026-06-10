import Anthropic from "@anthropic-ai/sdk";
import { sheets as sheetsClient } from "@googleapis/sheets";
import { drive as driveClient } from "@googleapis/drive";
import type { sheets_v4 } from "@googleapis/sheets";
import type { drive_v3 } from "@googleapis/drive";
import * as fs from "fs";
import * as path from "path";
import { loadProfile, getGoogleAuth } from "../lib/profiles.js";
import { listR2Receipts, downloadFromR2, deleteFromR2 } from "../R2.js";
import * as os from "os";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TransactionOverrides {
  date?:        string;
  amount?:      number;
  description?: string;
  type?:        "income" | "expense";
  source?:      string;      // income only
  expenseType?: string;      // expense only: Want / Need / Savings
  category?:    string;      // expense only
}

interface ParsedTransaction {
  date:         string;      // YYYY-MM-DD
  amount:       number;
  description:  string;
  type:         "income" | "expense";
  source?:      string;      // income only  — A–D: Date, Amount, Description, Source
  expenseType?: string;      // expense only — E–I: Date, Amount, Description, Type, Category
  category?:    string;      // expense only
}

interface SheetSettings {
  categories:    string[];
  incomeSources: string[];
  expenseTypes:  string[];
}

type SheetsClient = sheets_v4.Sheets;
type DriveClient  = drive_v3.Drive;

// ─── Clients ──────────────────────────────────────────────────────────────────
// Reuses the "personal" profile from config/profiles.json — same OAuth2 client
// as gmail.ts and calendar.ts. No separate credentials needed.

let _sheets: SheetsClient | undefined;
let _drive:  DriveClient  | undefined;

function getSheetsClient(): SheetsClient {
  if (!_sheets) {
    const auth = getGoogleAuth(loadProfile("personal"));
    _sheets = sheetsClient({ version: "v4", auth });
  }
  return _sheets;
}

function getDriveClient(): DriveClient {
  if (!_drive) {
    const auth = getGoogleAuth(loadProfile("personal"));
    _drive = driveClient({ version: "v3", auth });
  }
  return _drive;
}

function getSpreadsheetId(): string {
  const id = process.env.FINANCE_SPREADSHEET_ID;
  if (!id) throw new Error("FINANCE_SPREADSHEET_ID is not set in .env.");
  return id;
}

// ─── Sheet Helpers ────────────────────────────────────────────────────────────

function tabName(date: Date): string {
  return date.toLocaleString("en-US", { month: "long", year: "numeric" });
}

function tabNameFromString(monthYear?: string): string {
  if (!monthYear) return tabName(new Date());

  const normalized = monthYear.trim();

  // "June 2026" or "june 2026"
  if (/^[A-Za-z]+ \d{4}$/.test(normalized)) {
    const d = new Date(`${normalized} 1`);
    if (!isNaN(d.getTime())) {
      return d.toLocaleString("en-US", { month: "long", year: "numeric" });
    }
  }
  // "06/2026"
  const slashMatch = normalized.match(/^(\d{1,2})\/(\d{4})$/);
  if (slashMatch) {
    const d = new Date(parseInt(slashMatch[2], 10), parseInt(slashMatch[1], 10) - 1, 1);
    return d.toLocaleString("en-US", { month: "long", year: "numeric" });
  }
  // "2026-06"
  const isoMatch = normalized.match(/^(\d{4})-(\d{2})$/);
  if (isoMatch) {
    const d = new Date(parseInt(isoMatch[1], 10), parseInt(isoMatch[2], 10) - 1, 1);
    return d.toLocaleString("en-US", { month: "long", year: "numeric" });
  }

  throw new Error(
    `Could not parse month/year from "${monthYear}". ` +
    `Use formats like "June 2026", "06/2026", or "2026-06".`
  );
}

// ─── Settings Reader ──────────────────────────────────────────────────────────

async function readSettings(): Promise<SheetSettings> {
  const spreadsheetId = getSpreadsheetId();
  const sheets        = getSheetsClient();

  const headerRes = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "Settings!A1:Z1",
  });

  const headers: string[] = (headerRes.data.values?.[0] ?? []).map(
    (h: unknown) => String(h).trim().toUpperCase()
  );

  async function colValues(header: string): Promise<string[]> {
    const colIdx = headers.indexOf(header);
    if (colIdx === -1) return [];
    const colLetter = String.fromCharCode(65 + colIdx);
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `Settings!${colLetter}2:${colLetter}200`,
    });
    return (res.data.values ?? [])
      .flat()
      .map((v: unknown) => String(v).trim())
      .filter(Boolean);
  }

  const [categories, incomeSources, expenseTypes] = await Promise.all([
    colValues("CATEGORY"),  // A — expense categories
    colValues("SOURCE"),    // B — income sources
    colValues("TYPE"),      // C — expense types (Want/Need/Savings)
  ]);

  return { categories, incomeSources, expenseTypes };
}

// ─── OCR via Claude Vision ────────────────────────────────────────────────────

async function ocrReceipt(
  filePath: string,
  settings: SheetSettings
): Promise<ParsedTransaction> {
  const ext     = path.extname(filePath).toLowerCase();
  const isImage = [".jpg", ".jpeg", ".png", ".webp"].includes(ext);
  const isPdf   = ext === ".pdf";

  if (!isImage && !isPdf) {
    throw new Error(`Unsupported file type: ${ext}. Use JPG, PNG, WEBP, or PDF.`);
  }

  const base64    = fs.readFileSync(filePath).toString("base64");
  const mediaType = isPdf           ? "application/pdf"
                  : ext === ".png"  ? "image/png"
                  : ext === ".webp" ? "image/webp"
                  : "image/jpeg";

  const anthropic = new Anthropic();

  const systemPrompt = `You are a receipt and invoice parser. Extract transaction data and return ONLY valid JSON.

Available expense categories: ${settings.categories.join(", ")}
Available income sources: ${settings.incomeSources.join(", ")}
Available expense types: ${settings.expenseTypes.join(", ")} (label expenses as Want/Need/Savings)

Return this exact JSON shape — no markdown, no explanation:
{
  "date": "YYYY-MM-DD",
  "amount": 0.00,
  "description": "merchant or payer name + brief what",
  "type": "expense" or "income",
  "source": "closest match from income sources (income only, else null)",
  "expenseType": "Want, Need, or Savings (expense only, else null)",
  "category": "closest match from expense categories (expense only, else null)"
}

Rules:
- date: use receipt date, default to today if not found
- amount: always positive
- description: concise, max 60 chars
- Income has NO category — set category to null for income
- Needs are essentials (rent, groceries, utilities, medical)
- Savings are transfers to savings/investments
- Everything else is a Want`;

  type ImageMediaType = "image/jpeg" | "image/png" | "image/webp";
  type PdfMediaType   = "application/pdf";

  const contentBlock = isPdf
    ? ({
        type:   "document",
        source: { type: "base64", media_type: mediaType as PdfMediaType, data: base64 },
      } as const)
    : ({
        type:   "image",
        source: { type: "base64", media_type: mediaType as ImageMediaType, data: base64 },
      } as const);

  const response = await anthropic.messages.create({
    model:      "claude-haiku-4-5-20251001",
    max_tokens: 512,
    system:     systemPrompt,
    messages: [
      {
        role: "user",
        content: [
          contentBlock,
          { type: "text", text: "Parse this receipt/invoice into the JSON format specified." },
        ],
      },
    ],
  });

  // Narrow the union to text-only blocks without relying on SDK namespace types
  type TextBlock = { type: "text"; text: string };
  const isTextBlock = (b: unknown): b is TextBlock =>
    typeof b === "object" &&
    b !== null &&
    (b as Record<string, unknown>).type === "text" &&
    typeof (b as Record<string, unknown>).text === "string";

  const raw = (response.content as unknown[])
    .filter(isTextBlock)
    .map((b) => b.text)
    .join("")
    .replace(/```json|```/g, "")
    .trim();

  const parsed = JSON.parse(raw) as ParsedTransaction;

  // Always enforce the current year — receipts are assumed to be current.
  // OCR frequently misreads 2-digit years (e.g. "06/04/26" → 2025 or 2025).
  // Keep the parsed month and day but replace the year with the current year.
  if (parsed.date) {
    const currentYear = new Date().getFullYear();
    const [, month, day] = parsed.date.split("-");
    if (month && day) {
      parsed.date = `${currentYear}-${month}-${day}`;
    } else {
      parsed.date = new Date().toISOString().split("T")[0];
    }
  }

  return parsed;
}

// ─── Google Drive Upload ──────────────────────────────────────────────────────

async function uploadReceiptToDrive(filePath: string, date: string): Promise<string> {
  const drive             = getDriveClient();
  const [yearStr, monthStr] = date.split("-");
  const monthName         = new Date(parseInt(yearStr, 10), parseInt(monthStr, 10) - 1, 1)
    .toLocaleString("en-US", { month: "long" });

  async function findOrCreateFolder(name: string, parentId?: string): Promise<string> {
    const q = parentId
      ? `name='${name}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`
      : `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;

    const res      = await drive.files.list({ q, fields: "files(id)" });
    const existing = res.data.files?.[0]?.id;
    if (existing) return existing;

    const created = await drive.files.create({
      requestBody: {
        name,
        mimeType: "application/vnd.google-apps.folder",
        ...(parentId ? { parents: [parentId] } : {}),
      },
      fields: "id",
    });

    const newId = created.data.id;
    if (!newId) throw new Error(`Failed to create Drive folder: ${name}`);
    return newId;
  }

  const receiptsId = await findOrCreateFolder("Receipts");
  const yearId     = await findOrCreateFolder(yearStr, receiptsId);
  const monthId    = await findOrCreateFolder(`${monthName} ${yearStr}`, yearId);

  const ext      = path.extname(filePath);
  const baseName = path.basename(filePath, ext);
  const mimeType = ext === ".pdf" ? "application/pdf" : "image/jpeg";

  const uploaded = await drive.files.create({
    requestBody: { name: `${date}_${baseName}${ext}`, parents: [monthId] },
    media:       { mimeType, body: fs.createReadStream(filePath) },
    fields:      "id,webViewLink",
  });

  return uploaded.data.webViewLink ?? `https://drive.google.com/file/d/${uploaded.data.id}`;
}

// ─── Append Row to Sheet ──────────────────────────────────────────────────────
// Income:  A–D (Date, Amount, Description, Source)        headers row 4, data from row 5
// Expense: E–I (Date, Amount, Description, Type, Category) headers row 4, data from row 5
//
// Uses values.get to find the next empty row from row 5 downward (respecting
// the two independent sections), then values.update to write the exact row.
// This prevents Google Sheets append from writing to row 1 instead of row 5+.

async function findNextRow(tab: string, startRow: number, anchorCol: string): Promise<number> {
  const spreadsheetId = getSpreadsheetId();
  const range = `'${tab}'!${anchorCol}${startRow}:${anchorCol}2000`;
  const res   = await getSheetsClient().spreadsheets.values.get({ spreadsheetId, range });
  // Count filled rows from startRow — next empty is startRow + filled count
  return startRow + (res.data.values ?? []).length;
}

async function appendToSheet(
  tab:         string,
  transaction: ParsedTransaction,
  driveLink:   string
): Promise<number> {
  const spreadsheetId = getSpreadsheetId();
  const sheets        = getSheetsClient();
  const isIncome      = transaction.type === "income";

  // Income:  A–D | Expense: E–I
  // Headers at row 4, data starts at row 5 — never write above row 5
  const DATA_START    = 5;
  const anchorCol     = isIncome ? "A" : "E";
  const endCol        = isIncome ? "D" : "I";

  const nextRow = await findNextRow(tab, DATA_START, anchorCol);

  const row: (string | number)[] = isIncome
    ? [transaction.date, transaction.amount, transaction.description, transaction.source ?? ""]
    : [transaction.date, transaction.amount, transaction.description, transaction.expenseType ?? "", transaction.category ?? ""];

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range:            `'${tab}'!${anchorCol}${nextRow}:${endCol}${nextRow}`,
    valueInputOption: "USER_ENTERED",
    requestBody:      { values: [row] },
  });

  // Attach Drive receipt link as a cell note on the Date cell
  const sheetMeta = await sheets.spreadsheets.get({ spreadsheetId });
  const sheetId   = sheetMeta.data.sheets?.find(
    (s) => s.properties?.title === tab
  )?.properties?.sheetId;

  if (sheetId !== undefined) {
    const colIndex = isIncome ? 0 : 4; // A=0, E=4
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{
          updateCells: {
            range: {
              sheetId,
              startRowIndex:    nextRow - 1,
              endRowIndex:      nextRow,
              startColumnIndex: colIndex,
              endColumnIndex:   colIndex + 1,
            },
            rows:   [{ values: [{ note: `Receipt: ${driveLink}` }] }],
            fields: "note",
          },
        }],
      },
    });
  }

  return nextRow;
}

// ─── Exported Functions (called by index.ts server.tool registrations) ────────

export async function addTransaction(
  r2Key:      string,
  monthYear?: string,
  overrides?: TransactionOverrides
): Promise<string> {
  // Download from R2 to a local temp file for OCR
  const tmpDir    = os.tmpdir();
  const localPath = await downloadFromR2(r2Key, tmpDir);

  try {
    const settings  = await readSettings();
    let transaction = await ocrReceipt(localPath, settings);

    if (overrides) {
      transaction = { ...transaction, ...overrides } as ParsedTransaction;
    }

    const tab = tabNameFromString(monthYear);

    // Upload to Drive — confirmed link comes back before we delete anything
    const driveLink = await uploadReceiptToDrive(localPath, transaction.date);

    // Both Drive upload and sheet write succeeded — safe to clean up
    fs.unlinkSync(localPath);          // remove temp file
    await deleteFromR2(r2Key);         // remove from R2 (now in Drive permanently)

    const row = await appendToSheet(tab, transaction, driveLink);

    const lines: string[] = [
      `✅ Transaction added to "${tab}" (row ${row})`,
      ``,
      `  Type:        ${transaction.type}`,
      `  Date:        ${transaction.date}`,
      `  Amount:      $${transaction.amount.toFixed(2)}`,
      `  Description: ${transaction.description}`,
    ];

    if (transaction.type === "income") {
      lines.push(`  Source:       ${transaction.source ?? "—"}`);
    } else {
      lines.push(`  Expense type: ${transaction.expenseType ?? "—"}`);
      lines.push(`  Category:     ${transaction.category ?? "—"}`);
    }

    lines.push(``, `  Receipt saved to Drive: ${driveLink}`);
    lines.push(`  Removed from R2 ✓`);
    return lines.join("\n");

  } catch (err) {
    // Clean up temp file on error — R2 file is preserved as backup
    if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
    throw err;
  }
}

/**
 * Process all pending receipts in R2.
 * Downloads each, OCRs, uploads to Drive, logs to sheet, deletes from R2.
 */
export async function processAllReceipts(monthYear?: string): Promise<string> {
  const pending = await listR2Receipts();

  if (pending.length === 0) {
    return "📭 No pending receipts in R2.";
  }

  const lines: string[] = [`📬 Processing ${pending.length} receipt(s)...`, ""];
  let succeeded = 0;
  let failed    = 0;

  for (const { key, filename } of pending) {
    try {
      const result = await addTransaction(key, monthYear);
      lines.push(`✅ ${filename}`);
      // Extract just the row/tab line from the result for brevity
      const summary = result.split("\n").find(l => l.startsWith("✅"));
      if (summary) lines.push(`   ${summary.replace("✅ ", "")}`);
      lines.push("");
      succeeded++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      lines.push(`❌ ${filename}: ${msg}`);
      lines.push("");
      failed++;
    }
  }

  lines.push(`─────────────────────────`);
  lines.push(`Processed: ${succeeded} succeeded, ${failed} failed`);
  return lines.join("\n");
}

export async function listPendingReceipts(): Promise<string> {
  const pending = await listR2Receipts();

  if (pending.length === 0) {
    return "📭 No pending receipts in R2.";
  }

  const lines: string[] = [
    `📁 ${pending.length} pending receipt(s) in R2:`,
    "",
  ];

  pending.forEach(({ filename, folder }, i) => {
    lines.push(`  ${i + 1}. ${filename}`);
    lines.push(`     Folder: ${folder}`);
  });

  return lines.join("\n");
}

export async function getFinanceSettings(): Promise<string> {
  const settings = await readSettings();
  return [
    "📋 Finance Settings",
    "",
    `Categories (${settings.categories.length}):     ${settings.categories.join(", ")}`,
    `Income Sources (${settings.incomeSources.length}): ${settings.incomeSources.join(", ")}`,
    `Expense Types (${settings.expenseTypes.length}):   ${settings.expenseTypes.join(", ")}`,
  ].join("\n");
}