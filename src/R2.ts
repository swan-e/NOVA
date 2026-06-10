/**
 * r2.ts
 *
 * Shared Cloudflare R2 client used by both upload-server.ts and finance.ts.
 * R2 is S3-compatible so we use the AWS SDK v3 S3 client.
 *
 * Bucket structure:
 *   receipts/2026/June 2026/receipt_2026-06-09_abc123.jpg
 */

import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, ListObjectsV2Command, HeadObjectCommand } from "@aws-sdk/client-s3";
import * as fs from "fs";
import * as path from "path";
import { Readable } from "stream";

// ─── Config ───────────────────────────────────────────────────────────────────

function getR2Client(): S3Client {
  const accountId        = process.env.R2_ACCOUNT_ID;
  const accessKeyId      = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey  = process.env.R2_SECRET_ACCESS_KEY;

  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error(
      "Missing R2 credentials. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, " +
      "and R2_SECRET_ACCESS_KEY in .env."
    );
  }

  return new S3Client({
    region:   "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
}

function getBucketName(): string {
  const bucket = process.env.R2_BUCKET_NAME;
  if (!bucket) throw new Error("R2_BUCKET_NAME is not set in .env.");
  return bucket;
}

// ─── Key builder ──────────────────────────────────────────────────────────────
// receipts/2026/June 2026/filename.jpg

export function buildR2Key(filename: string, date: string): string {
  const [yearStr, monthStr] = date.split("-");
  const monthName = new Date(parseInt(yearStr, 10), parseInt(monthStr, 10) - 1, 1)
    .toLocaleString("en-US", { month: "long" });
  return `receipts/${yearStr}/${monthName} ${yearStr}/${filename}`;
}

// ─── Operations ───────────────────────────────────────────────────────────────

/**
 * Upload a local file to R2.
 * Returns the R2 key the file was stored under.
 */
export async function uploadToR2(
  localPath: string,
  filename:  string,
  date:      string,
  note?:     string
): Promise<string> {
  const client   = getR2Client();
  const bucket   = getBucketName();
  const key      = buildR2Key(filename, date);
  const body     = fs.readFileSync(localPath);
  const ext      = path.extname(filename).toLowerCase();
  const mimeType = ext === ".pdf"  ? "application/pdf"
                 : ext === ".png"  ? "image/png"
                 : ext === ".webp" ? "image/webp"
                 : "image/jpeg";

  await client.send(new PutObjectCommand({
    Bucket:      bucket,
    Key:         key,
    Body:        body,
    ContentType: mimeType,
    // Store note as object metadata — retrieved when MCP lists receipts
    ...(note ? { Metadata: { note } } : {}),
  }));

  return key;
}

/**
 * Download a file from R2 to a local temp path.
 * Returns the local file path.
 */
export async function downloadFromR2(key: string, destDir: string): Promise<string> {
  const client   = getR2Client();
  const bucket   = getBucketName();
  const filename = path.basename(key);
  const destPath = path.join(destDir, filename);

  const res  = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const body = res.Body;

  if (!body) throw new Error(`Empty response body for R2 key: ${key}`);

  await new Promise<void>((resolve, reject) => {
    const stream = fs.createWriteStream(destPath);
    (body as Readable).pipe(stream);
    stream.on("finish", resolve);
    stream.on("error", reject);
  });

  return destPath;
}

/**
 * Delete a file from R2 after successful processing.
 */
export async function deleteFromR2(key: string): Promise<void> {
  const client = getR2Client();
  const bucket = getBucketName();
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

/**
 * List all pending receipt files in R2 under the receipts/ prefix.
 * Returns array of { key, filename, folder } objects.
 */
export async function listR2Receipts(): Promise<{ key: string; filename: string; folder: string; note?: string }[]> {
  const client = getR2Client();
  const bucket = getBucketName();

  const res = await client.send(new ListObjectsV2Command({
    Bucket: bucket,
    Prefix: "receipts/",
  }));

  const objects = (res.Contents ?? []).filter((obj) => obj.Key);

  // Fetch metadata for each object to retrieve note if present
  const results = await Promise.all(
    objects.map(async (obj) => {
      const key      = obj.Key!;
      const parts    = key.split("/");
      const filename = parts[parts.length - 1];
      const folder   = parts.slice(0, -1).join("/");

      try {
        const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        const note = head.Metadata?.["note"];
        return { key, filename, folder, ...(note ? { note } : {}) };
      } catch {
        return { key, filename, folder };
      }
    })
  );

  return results;
}