import path from "path";
import { requireEnv, optionalEnv } from "./env";
import { readConfig } from "./config";
import { OAuth2Client } from "google-auth-library";

// ── Types ──────────────────────────────────────────────────────────────────

export interface ProfileConfig {
  displayName: string;
  email: string;
  timezone: string;
  obsidianSubfolder: string;
  tools: string[];
  envPrefix: string;
}

export interface ProfilesFile {
  profiles: Record<string, ProfileConfig>;
  defaultProfile: string;
}

export interface ResolvedProfile extends ProfileConfig {
  id: string;
  googleClientId: string;
  googleClientSecret: string;
  googleRefreshToken: string;
  notionApiKey: string | null;
  notionDatabaseId: string | null;
  obsidianVaultPath: string | null;
}

// ── Profile loader ─────────────────────────────────────────────────────────

/**
 * Loads a profile by ID, merging config metadata with secrets from .env.
 * Falls back to the defaultProfile if no ID is provided.
 * Google credentials are required. Notion and Obsidian are optional
 * and will be null if not yet configured.
 */
export function loadProfile(profileId?: string): ResolvedProfile {
  const file = readConfig<ProfilesFile>("profiles.json");
  const id = profileId ?? file.defaultProfile;
  const profile = file.profiles[id];

  if (!profile) {
    const available = Object.keys(file.profiles).join(", ");
    throw new Error(
      `Profile "${id}" not found in config/profiles.json.\n` +
      `Available profiles: ${available}`
    );
  }

  const p = profile.envPrefix;

  return {
    ...profile,
    id,
    // Google — required, will throw clearly if missing
    googleClientId:     requireEnv(`${p}_GOOGLE_CLIENT_ID`),
    googleClientSecret: requireEnv(`${p}_GOOGLE_CLIENT_SECRET`),
    googleRefreshToken: requireEnv(`${p}_GOOGLE_REFRESH_TOKEN`),
    // Notion — optional until Phase 4
    notionApiKey:      process.env[`${p}_NOTION_API_KEY`] ?? null,
    notionDatabaseId:  process.env[`${p}_NOTION_DATABASE_ID`] ?? null,
    // Obsidian — optional until Phase 4
    obsidianVaultPath: process.env["OBSIDIAN_VAULT_PATH"] ?? null,
  };
}

/**
 * Returns a list of all available profile IDs.
 */
export function listProfiles(): string[] {
  const file = readConfig<ProfilesFile>("profiles.json");
  return Object.keys(file.profiles);
}

// ── Google auth helper ─────────────────────────────────────────────────────

/**
 * Returns an authenticated Google OAuth2 client for the given profile.
 * Used by both gmail.ts and calendar.ts.
 */
export function getGoogleAuth(profile: ResolvedProfile): OAuth2Client {
  const auth = new OAuth2Client(
    profile.googleClientId,
    profile.googleClientSecret
  );
  auth.setCredentials({ refresh_token: profile.googleRefreshToken });
  return auth;
}