"use strict";
/**
 * google-auth.ts
 *
 * One-time script to generate Google OAuth refresh tokens.
 * Run once per Gmail account (personal, work).
 *
 * Usage:
 *   npx ts-node scripts/google-auth.ts personal
 *   npx ts-node scripts/google-auth.ts work
 *
 * What it does:
 *   1. Opens a local server on port 3000
 *   2. Prints a URL — open it in your browser
 *   3. You log in with the correct Google account
 *   4. Google redirects back with an auth code
 *   5. Script exchanges the code for a refresh token
 *   6. Prints the refresh token — paste it into your .env
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const http = __importStar(require("http"));
const url = __importStar(require("url"));
const googleapis_1 = require("googleapis");
const dotenv = __importStar(require("dotenv"));
const path = __importStar(require("path"));
dotenv.config({ path: path.resolve(__dirname, "../.env") });
// ── Config ──────────────────────────────────────────────────────────────────
const SCOPES = [
    "https://www.googleapis.com/auth/gmail.modify", // read + delete emails
    "https://www.googleapis.com/auth/calendar", // read + write calendar
];
const PORT = 3000;
const REDIRECT_URI = `http://localhost:${PORT}/oauth/callback`;
// ── Helpers ─────────────────────────────────────────────────────────────────
function getEnvPrefix(profile) {
    const map = {
        personal: "PERSONAL",
        work: "WORK",
    };
    const prefix = map[profile.toLowerCase()];
    if (!prefix) {
        console.error(`\nUnknown profile: "${profile}"`);
        console.error(`Valid profiles: ${Object.keys(map).join(", ")}`);
        process.exit(1);
    }
    return prefix;
}
function requireVar(key) {
    const val = process.env[key];
    if (!val) {
        console.error(`\nMissing .env variable: ${key}`);
        console.error(`Add it to your .env file before running this script.`);
        process.exit(1);
    }
    return val;
}
// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
    const profile = process.argv[2];
    if (!profile) {
        console.error("\nUsage: npx ts-node scripts/google-auth.ts <profile>");
        console.error("Example: npx ts-node scripts/google-auth.ts personal");
        process.exit(1);
    }
    const prefix = getEnvPrefix(profile);
    const clientId = requireVar(`${prefix}_GOOGLE_CLIENT_ID`);
    const clientSecret = requireVar(`${prefix}_GOOGLE_CLIENT_SECRET`);
    const oauth2Client = new googleapis_1.google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);
    const authUrl = oauth2Client.generateAuthUrl({
        access_type: "offline",
        scope: SCOPES,
        prompt: "consent", // forces refresh token to be returned every time
    });
    console.log("\n─────────────────────────────────────────────────");
    console.log(`  Google OAuth Setup — ${profile.toUpperCase()} profile`);
    console.log("─────────────────────────────────────────────────");
    console.log("\n1. Open this URL in your browser:");
    console.log(`\n   ${authUrl}\n`);
    console.log("2. Sign in with your", profile, "Google account");
    console.log("3. Grant the requested permissions");
    console.log("4. You'll be redirected back automatically\n");
    console.log("Waiting for callback on http://localhost:" + PORT + " ...\n");
    // Start local server to catch the OAuth redirect
    const refreshToken = await waitForCallback(oauth2Client);
    console.log("\n─────────────────────────────────────────────────");
    console.log("  SUCCESS — Refresh token generated");
    console.log("─────────────────────────────────────────────────");
    console.log(`\nAdd this to your .env file:\n`);
    console.log(`${prefix}_GOOGLE_REFRESH_TOKEN=${refreshToken}`);
    console.log("\n─────────────────────────────────────────────────\n");
    process.exit(0);
}
function waitForCallback(oauth2Client) {
    return new Promise((resolve, reject) => {
        const server = http.createServer(async (req, res) => {
            if (!req.url?.startsWith("/oauth/callback"))
                return;
            const params = new url.URL(req.url, `http://localhost:${PORT}`).searchParams;
            const code = params.get("code");
            const error = params.get("error");
            if (error) {
                res.writeHead(400);
                res.end(`<h2>Auth error: ${error}</h2><p>Check your terminal.</p>`);
                server.close();
                reject(new Error(`OAuth error: ${error}`));
                return;
            }
            if (!code) {
                res.writeHead(400);
                res.end("<h2>No code returned.</h2><p>Try again.</p>");
                server.close();
                reject(new Error("No auth code in callback"));
                return;
            }
            try {
                const { tokens } = await oauth2Client.getToken(code);
                const refreshToken = tokens.refresh_token;
                if (!refreshToken) {
                    res.writeHead(400);
                    res.end("<h2>No refresh token.</h2><p>Try revoking access at myaccount.google.com/permissions and running again.</p>");
                    server.close();
                    reject(new Error("No refresh token returned. Revoke app access and retry with prompt: consent."));
                    return;
                }
                res.writeHead(200);
                res.end(`
          <h2>✅ Success!</h2>
          <p>Your refresh token has been printed in the terminal.</p>
          <p>You can close this tab.</p>
        `);
                server.close();
                resolve(refreshToken);
            }
            catch (err) {
                res.writeHead(500);
                res.end(`<h2>Token exchange failed</h2><pre>${err}</pre>`);
                server.close();
                reject(err);
            }
        });
        server.listen(PORT, () => { });
        server.on("error", (err) => {
            if (err.code === "EADDRINUSE") {
                console.error(`\nPort ${PORT} is already in use.`);
                console.error("Close whatever is running on that port and try again.");
            }
            reject(err);
        });
    });
}
main().catch((err) => {
    console.error("\nFatal error:", err.message);
    process.exit(1);
});
//# sourceMappingURL=google-auth.js.map