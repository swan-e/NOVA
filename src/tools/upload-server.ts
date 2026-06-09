/**
 * upload-server.ts
 *
 * Lightweight Express server that accepts receipt photo/PDF uploads
 * and saves them to the shared receipts/ folder for MCP processing.
 *
 * No AI, no tokens — just a secure file drop.
 *
 * Auth: X-Upload-Key header must match UPLOAD_SECRET_KEY in .env
 */

import express, { Request, Response, NextFunction } from "express";
import multer from "multer";
import * as path from "path";
import * as fs from "fs";
import * as crypto from "crypto";

// ─── Config ───────────────────────────────────────────────────────────────────

const PORT         = parseInt(process.env.UPLOAD_PORT ?? "4000", 10);
const SECRET_KEY   = process.env.UPLOAD_SECRET_KEY;
const RECEIPTS_DIR = process.env.RECEIPTS_DIR ?? "/app/receipts";

if (!SECRET_KEY) {
  console.error("UPLOAD_SECRET_KEY is not set in .env — refusing to start.");
  process.exit(1);
}

// Ensure receipts directory exists
fs.mkdirSync(RECEIPTS_DIR, { recursive: true });

// ─── Multer (file handling) ───────────────────────────────────────────────────

const ALLOWED_TYPES: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png":  ".png",
  "image/webp": ".webp",
  "application/pdf": ".pdf",
};

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, RECEIPTS_DIR),
  filename:    (_req, file, cb) => {
    // Timestamp + random suffix to avoid collisions
    const ts     = new Date().toISOString().replace(/[:.]/g, "-");
    const rand   = crypto.randomBytes(4).toString("hex");
    const ext    = ALLOWED_TYPES[file.mimetype] ?? path.extname(file.originalname);
    cb(null, `receipt_${ts}_${rand}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB max
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

// ── Auth middleware ───────────────────────────────────────────────────────────

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const provided = req.headers["x-upload-key"];
  // Constant-time comparison to prevent timing attacks
  if (
    typeof provided !== "string" ||
    !crypto.timingSafeEqual(
      Buffer.from(provided),
      Buffer.from(SECRET_KEY as string)
    )
  ) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

// ── Health check (no auth — used by Docker and Cloudflare) ───────────────────

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// ── Upload endpoint ───────────────────────────────────────────────────────────

app.post(
  "/upload",
  requireAuth,
  upload.single("receipt"),
  (req: Request, res: Response) => {
    if (!req.file) {
      res.status(400).json({ error: "No file received." });
      return;
    }

    console.log(`[upload] ${req.file.filename} (${(req.file.size / 1024).toFixed(1)} KB)`);

    res.json({
      success:  true,
      filename: req.file.filename,
      path:     `/app/receipts/${req.file.filename}`,
      message:  "Receipt saved. Ask Claude Code to process it when ready.",
    });
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
  console.log(`Saving files to: ${RECEIPTS_DIR}`);
});