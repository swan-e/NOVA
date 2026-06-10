/**
 * upload-server.ts
 *
 * Lightweight Express server that accepts receipt photo/PDF uploads.
 * - Saves to local /app/receipts as backup
 * - Uploads to Cloudflare R2 for MCP access
 *
 * No AI, no tokens — just a secure file drop.
 * Auth: X-Upload-Key header must match UPLOAD_SECRET_KEY in .env
 */

import express, { Request, Response, NextFunction } from "express";
import multer from "multer";
import * as path from "path";
import * as fs from "fs";
import * as crypto from "crypto";
import { uploadToR2 } from "./R2.js";

// ─── Config ───────────────────────────────────────────────────────────────────

const PORT         = parseInt(process.env.PORT ?? process.env.UPLOAD_PORT ?? "4000", 10);
const SECRET_KEY   = process.env.UPLOAD_SECRET_KEY;
const RECEIPTS_DIR = process.env.RECEIPTS_DIR ?? "/app/receipts";

if (!SECRET_KEY) {
  console.error("UPLOAD_SECRET_KEY is not set in .env — refusing to start.");
  process.exit(1);
}

fs.mkdirSync(RECEIPTS_DIR, { recursive: true });

// ─── Multer ───────────────────────────────────────────────────────────────────

const ALLOWED_TYPES: Record<string, string> = {
  "image/jpeg":      ".jpg",
  "image/png":       ".png",
  "image/webp":      ".webp",
  "application/pdf": ".pdf",
};

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, RECEIPTS_DIR),
  filename:    (_req, file, cb) => {
    const ts   = new Date().toISOString().replace(/[:.]/g, "-");
    const rand = crypto.randomBytes(4).toString("hex");
    const ext  = ALLOWED_TYPES[file.mimetype] ?? path.extname(file.originalname);
    cb(null, `receipt_${ts}_${rand}${ext}`);
  },
});

const upload = multer({
  storage,
  limits:     { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_TYPES[file.mimetype]) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${file.mimetype}. Use JPG, PNG, WEBP, or PDF.`));
    }
  },
});

// ─── App ──────────────────────────────────────────────────────────────────────

const app = express();

// ── Auth ──────────────────────────────────────────────────────────────────────

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const provided = req.headers["x-upload-key"];
  if (
    typeof provided !== "string" ||
    !crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(SECRET_KEY as string))
  ) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

// ── Health check ──────────────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// ── Upload ────────────────────────────────────────────────────────────────────

app.post(
  "/upload",
  requireAuth,
  upload.single("receipt"),
  async (req: Request, res: Response) => {
    if (!req.file) {
      res.status(400).json({ error: "No file received." });
      return;
    }

    const localPath = req.file.path;
    const filename  = req.file.filename;

    // Use today's date for R2 folder path since we don't OCR here
    const today = new Date().toISOString().split("T")[0]; // YYYY-MM-DD

    try {
      // Upload to R2 — local file stays as backup regardless of outcome
      const r2Key = await uploadToR2(localPath, filename, today);

      console.log(`[upload] ${filename} (${(req.file.size / 1024).toFixed(1)} KB) → R2: ${r2Key}`);

      res.json({
        success:  true,
        filename,
        r2Key,
        message: "Receipt saved locally and uploaded to R2. Ask Claude Code to process it when ready.",
      });
    } catch (err) {
      // R2 upload failed — local backup still exists, don't lose the file
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[upload] R2 upload failed for ${filename}: ${msg}`);
      console.error(`[upload] Local backup preserved at: ${localPath}`);

      res.status(500).json({
        error:    "R2 upload failed — file saved locally as backup.",
        filename,
        localPath,
        details:  msg,
      });
    }
  }
);

// ── Error handler ─────────────────────────────────────────────────────────────

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error(`[error] ${err.message}`);
  res.status(400).json({ error: err.message });
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Receipt upload server running on port ${PORT}`);
  console.log(`Local backup dir: ${RECEIPTS_DIR}`);
});