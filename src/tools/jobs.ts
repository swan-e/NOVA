// @ts-nocheck
import { sheets as sheetsClient } from "@googleapis/sheets";
import { loadProfile, getGoogleAuth } from "../lib/profiles";

const SPREADSHEET_ID = process.env.JOB_SPREADSHEET_ID;
const SHEET_NAME = process.env.JOB_SHEET_NAME || "Sheet1";

function getSheetsClient(profileId?: string) {
  const profile = loadProfile(profileId);
  const auth = getGoogleAuth(profile);
  return sheetsClient({ version: "v4", auth });
}

export async function addJobApplication(
  data: {
    job: string;
    company: string;
    status?: string;
    submissionPlatform?: string;
    location?: string;
    completionDate?: string;
    website?: string;
    notes?: string;
  },
  profileId?: string
) {
  if (!SPREADSHEET_ID) throw new Error("JOB_SPREADSHEET_ID env var not set.");

  const sheetName = data.sheetName ?? SHEET_NAME; 
  const sheets = getSheetsClient(profileId);

  const row = [
    data.job,
    data.company,
    data.status ?? "Completed",
    data.submissionPlatform ?? "Company Website",
    data.location ?? "UNKNOWN",
    data.completionDate ?? new Date().toLocaleDateString("en-US"),
    data.website ?? "UNKNOWN",
    data.notes ?? "",
  ];

  const response = await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!A:H`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [row] },
  });

  return response.data.updates?.updatedRange ?? "unknown range";
}

export async function editJobApplication(
  data: {
    findCompany: string;
    findJob?: string;
    sheetName?: string;
    job?: string;
    company?: string;
    status?: string;
    submissionPlatform?: string;
    location?: string;
    completionDate?: string;
    website?: string;
    notes?: string;
  },
  profileId?: string
): Promise<string> {
  if (!SPREADSHEET_ID) throw new Error("JOB_SPREADSHEET_ID env var not set.");

  const sheetName = data.sheetName ?? SHEET_NAME;
  const sheets = getSheetsClient(profileId);

  // Fetch all rows
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!A:H`,
  });

  const rows = res.data.values ?? [];

  // Find last matching row (skip header row 0) so duplicates resolve to most recent
  const rowIndex = rows.findLastIndex((row, i) => {
    if (i === 0) return false;
    const companyMatch = row[1]?.toLowerCase().includes(data.findCompany.toLowerCase());
    const jobMatch = data.findJob ? row[0]?.toLowerCase().includes(data.findJob.toLowerCase()) : true;
    return companyMatch && jobMatch;
  });

  if (rowIndex === -1) {
    return `❌ No row found matching company "${data.findCompany}"${data.findJob ? ` and job "${data.findJob}"` : ""}.`;
  }

  // Merge existing row with updates
  const existing = rows[rowIndex];
  const updated = [
    data.job               ?? existing[0] ?? "",
    data.company           ?? existing[1] ?? "",
    data.status            ?? existing[2] ?? "",
    data.submissionPlatform ?? existing[3] ?? "",
    data.location          ?? existing[4] ?? "",
    data.completionDate    ?? existing[5] ?? "",
    data.website           ?? existing[6] ?? "",
    data.notes             ?? existing[7] ?? "",
  ];

  // rowIndex is 0-based, Sheets rows are 1-based, +1 for header
  const sheetRow = rowIndex + 1;

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!A${sheetRow}:H${sheetRow}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [updated] },
  });

  return `✅ Updated row ${sheetRow}: **${updated[0]}** at **${updated[1]}**`;
}