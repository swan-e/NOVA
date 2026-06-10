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

  if (/^[A-Za-z]+ \d{4}$/.test(normalized)) {
    const d = new Date(`${normalized} 1`);
    if (!isNaN(d.getTime())) {
      return d.toLocaleString("en-US", { month: "long", year: "numeric" });
    }
  }
  const slashMatch = normalized.match(/^(\d{1,2})\/(\d{4})$/);
  if (slashMatch) {
    const d = new Date(parseInt(slashMatch[2], 10), parseInt(slashMatch[1], 10) - 1, 1);
    return d.toLocaleString("en-US", { month: "long", year: "numeric" });
  }
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
    colValues("CATEGORY"),
    colValues("SOURCE"),
    colValues("TYPE"),
  ]);

  return { categories, incomeSources, expenseTypes };
}

// ─── OCR via Claude Vision ────────────────────────────────────────────────────

async function ocrReceipt(
  filePath: string,
  settings: SheetSettings,
  note?:    string
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

  const anthropic  = new Anthropic();
  const noteContext = note ? `\nUser note: "${note}"` : "";

  const systemPrompt = `Receipt parser. Return ONLY valid JSON, no markdown.

Categories: ${settings.categories.join(", ")}
Income sources: ${settings.incomeSources.join(", ")}
Expense types: ${settings.expenseTypes.join(", ")}${noteContext}

JSON shape:
{"date":"YYYY-MM-DD","amount":0.00,"description":"merchant + what (max 60 chars)","type":"expense|income","source":"income source or null","expenseType":"Want|Need|Savings or null","category":"expense category or null"}

Rules:
- Default to "expense". Only use "income" for pay stubs, bank transfers received, Venmo/Zelle received, refunds.
- User note above overrides your classification if it specifies income/expense or source.
- Restaurants/takeout/food delivery = expense, Want. Groceries/supermarket = expense, Need.
- Needs: rent, groceries, utilities, medical, transport to work. Savings: investment/savings transfers. All else: Want.
- Income has no category (null). Expenses need category + expenseType.
- date: use month/day from receipt — year is always ${new Date().getFullYear()}.`;

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
    max_tokens: 256,
    system:     systemPrompt,
    messages: [
      {
        role: "user",
        content: [
          contentBlock,
          { type: "text", text: "Parse this receipt." },
        ],
      },
    ],
  });

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

  // Always enforce current year — keep parsed month/day, replace year
  if (parsed.date) {
    const currentYear    = new Date().getFullYear();
    const [, month, day] = parsed.date.split("-");
    parsed.date = (month && day)
      ? `${currentYear}-${month}-${day}`
      : new Date().toISOString().split("T")[0];
  }

  return parsed;
}

// ─── Google Drive Upload ──────────────────────────────────────────────────────

async function uploadReceiptToDrive(filePath: string, date: string): Promise<string> {
  const drive               = getDriveClient();
  const [yearStr, monthStr] = date.split("-");
  const monthName           = new Date(parseInt(yearStr, 10), parseInt(monthStr, 10) - 1, 1)
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
// Income:  A–D (Date, Amount, Description, Source)          headers row 4, data from row 5
// Expense: E–I (Date, Amount, Description, Type, Category)   headers row 4, data from row 5
//
// Google-recommended padding approach: always append to column A with
// INSERT_ROWS, but prepend 4 empty strings for expenses so the data lands
// in columns E–I. Income gets no padding (writes A–D directly).
// Sheet expands automatically. One API call, no scanning needed.

async function appendToSheet(
  tab:         string,
  transaction: ParsedTransaction,
  driveLink:   string
): Promise<number> {
  const spreadsheetId = getSpreadsheetId();
  const sheets        = getSheetsClient();
  const isIncome      = transaction.type === "income";

  const incomeRow: (string | number)[] = [
    transaction.date,
    transaction.amount,
    transaction.description,
    transaction.source ?? "",
  ];

  const expenseRow: (string | number)[] = [
    "", "", "", "",                    // pad A–D so data lands at E–I
    transaction.date,
    transaction.amount,
    transaction.description,
    transaction.expenseType ?? "",
    transaction.category ?? "",
  ];

  const row = isIncome ? incomeRow : expenseRow;

  const appendRes = await sheets.spreadsheets.values.append({
    spreadsheetId,
    range:            `'${tab}'!A5`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody:      { values: [row] },
  });

  // Parse written row number from response e.g. "June 2026!A7:I7" → 7
  const updatedRange = appendRes.data.updates?.updatedRange ?? "";
  const rowMatch     = updatedRange.match(/(\d+):/);
  const nextRow      = rowMatch ? parseInt(rowMatch[1], 10) : 0;

  // Attach Drive receipt link as a cell note on the correct Date cell
  if (nextRow > 0) {
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
  }

  return nextRow;
}

// ─── Exported Functions (called by index.ts server.tool registrations) ────────

export async function addTransaction(
  r2Key:      string,
  monthYear?: string,
  overrides?: TransactionOverrides,
  note?:      string
): Promise<string> {
  const tmpDir    = os.tmpdir();
  const localPath = await downloadFromR2(r2Key, tmpDir);

  try {
    const settings  = await readSettings();
    let transaction = await ocrReceipt(localPath, settings, note);

    if (overrides) {
      transaction = { ...transaction, ...overrides } as ParsedTransaction;
    }

    const tab       = tabNameFromString(monthYear);
    const driveLink = await uploadReceiptToDrive(localPath, transaction.date);

    fs.unlinkSync(localPath);
    await deleteFromR2(r2Key);

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
    if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
    throw err;
  }
}

export async function processAllReceipts(monthYear?: string): Promise<string> {
  const pending: { key: string; filename: string; folder: string; note?: string }[] = await listR2Receipts();

  if (pending.length === 0) {
    return "📭 No pending receipts in R2.";
  }

  const lines: string[] = [`📬 Processing ${pending.length} receipt(s)...`, ""];
  let succeeded = 0;
  let failed    = 0;

  for (const { key, filename, note } of pending) {
    try {
      const result = await addTransaction(key, monthYear, undefined, note);
      lines.push(`✅ ${filename}`);
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
  const pending: { key: string; filename: string; folder: string; note?: string }[] = await listR2Receipts();

  if (pending.length === 0) {
    return "📭 No pending receipts in R2.";
  }

  const lines: string[] = [
    `📁 ${pending.length} pending receipt(s) in R2:`,
    "",
  ];

  pending.forEach(({ key, filename, folder, note }, i) => {
    lines.push(`  ${i + 1}. ${filename}`);
    lines.push(`     Key:    ${key}`);
    lines.push(`     Folder: ${folder}`);
    if (note) lines.push(`     Note:   ${note}`);
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