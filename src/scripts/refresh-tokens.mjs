#!/usr/bin/env node

/**
 * refresh-tokens.mjs
 * 
 * Launches a local OAuth flow for personal and/or work Google accounts,
 * then automatically updates the refresh tokens in your .env file.
 * 
 * Usage:
 *   node src/scripts/refresh-tokens.mjs          # refreshes both accounts
 *   node src/scripts/refresh-tokens.mjs personal # refreshes personal only
 *   node src/scripts/refresh-tokens.mjs work     # refreshes work only
 */

import http from "http";
import path from "path";
import fs from "fs";
import { execSync } from "child_process";
import { OAuth2Client } from "google-auth-library";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.resolve(__dirname, "../../.env");
const PORT = 3000;
const REDIRECT_URI = `http://localhost:${PORT}/oauth/callback`;

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/spreadsheets",
];

// ── .env helpers ─────────────────────────────────────────────────────────────

function readEnv() {
  return fs.readFileSync(ENV_PATH, "utf8");
}

function getEnvVar(content, key) {
  const match = content.match(new RegExp(`^${key}=(.*)$`, "m"));
  return match?.[1]?.trim() ?? null;
}

function setEnvVar(content, key, value) {
  const regex = new RegExp(`^(${key}=).*$`, "m");
  if (regex.test(content)) {
    return content.replace(regex, `$1${value}`);
  }
  // Key doesn't exist — append it
  return content.trimEnd() + `\n${key}=${value}\n`;
}

// ── OAuth flow ────────────────────────────────────────────────────────────────

function getRefreshToken(clientId, clientSecret) {
  return new Promise((resolve, reject) => {
    const oAuth2Client = new OAuth2Client(clientId, clientSecret, REDIRECT_URI);

    const authUrl = oAuth2Client.generateAuthUrl({
      access_type: "offline",
      prompt: "consent", // force new refresh token every time
      scope: SCOPES,
    });

    // Open browser
    console.log("\n📋 Open this URL in the correct Google profile:\n");
    console.log(authUrl);
    console.log();

    // Local server to catch the callback
    const server = http.createServer(async (req, res) => {
      if (!req.url?.startsWith("/oauth/callback")) return;

      const url = new URL(req.url, `http://localhost:${PORT}`);
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");

      if (error) {
        res.end(`<h2>Auth failed: ${error}</h2><p>You can close this tab.</p>`);
        server.close();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }

      try {
        const { tokens } = await oAuth2Client.getToken(code);
        res.end("<h2>✅ Authenticated! You can close this tab.</h2>");
        server.close();
        resolve(tokens.refresh_token);
      } catch (err) {
        res.end(`<h2>Token exchange failed</h2><pre>${err.message}</pre>`);
        server.close();
        reject(err);
      }
    });

    server.listen(PORT, () => {
      console.log(`⏳ Waiting for Google to redirect to localhost:${PORT}...`);
    });

    server.on("error", (err) => {
      reject(new Error(`Server error: ${err.message}`));
    });
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function refreshProfile(prefix, label) {
  console.log(`\n${"─".repeat(50)}`);
  console.log(`🔑 Refreshing ${label} account (${prefix}_*)`);
  console.log("─".repeat(50));

  let env = readEnv();
  const clientId = getEnvVar(env, `${prefix}_GOOGLE_CLIENT_ID`);
  const clientSecret = getEnvVar(env, `${prefix}_GOOGLE_CLIENT_SECRET`);

  if (!clientId || !clientSecret) {
    console.error(`❌ Missing ${prefix}_GOOGLE_CLIENT_ID or ${prefix}_GOOGLE_CLIENT_SECRET in .env`);
    process.exit(1);
  }

  const refreshToken = await getRefreshToken(clientId, clientSecret);

  if (!refreshToken) {
    console.error("❌ No refresh token returned. Make sure 'prompt: consent' is set and this is a new auth.");
    process.exit(1);
  }

  // Re-read .env in case it changed, then update
  env = readEnv();
  const updated = setEnvVar(env, `${prefix}_GOOGLE_REFRESH_TOKEN`, refreshToken);
  fs.writeFileSync(ENV_PATH, updated, "utf8");

  console.log(`✅ ${label} refresh token updated in .env`);
}

async function main() {
  const target = process.argv[2]; // "personal", "work", or undefined (both)

  if (!fs.existsSync(ENV_PATH)) {
    console.error(`❌ .env not found at ${ENV_PATH}`);
    process.exit(1);
  }

  if (!target || target === "personal") {
    await refreshProfile("PERSONAL", "Personal");
  }

  if (!target || target === "work") {
    await refreshProfile("WORK", "Work");
  }

  console.log("\n✅ Done! Rebuild and restart Docker to pick up the new tokens:");
  console.log("   npm run build && docker cp build/. nova-mcp:/app/build/ && docker restart nova-mcp\n");
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
