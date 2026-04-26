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
export {};
//# sourceMappingURL=google-auth.d.ts.map