import * as dotenv from "dotenv";
import path from "path";

// Load .env from project root regardless of where the process is started from
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

/**
 * Reads a required environment variable.
 * Throws clearly if it's missing so you know exactly what to add to .env
 */
export function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) {
    throw new Error(
      `Missing required environment variable: ${key}\n` +
      `Add it to your .env file. See .env.example for reference.`
    );
  }
  return val;
}

/**
 * Reads an optional environment variable.
 * Returns the fallback value if not set.
 */
export function optionalEnv(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

export const TIMEZONE = optionalEnv("TIMEZONE", "America/New_York");