import fs from "fs";
import path from "path";

// Config files live here relative to the project root
const CONFIG_DIR = path.resolve(__dirname, "../../config");

// ── Types ──────────────────────────────────────────────────────────────────

export type OverrideScope = "day" | "week" | "forward";

export interface LifestyleOverride {
  id: string;
  type: "sleep" | "meal";
  scope: OverrideScope;
  date?: string;          // scope: "day"  — ISO date YYYY-MM-DD
  weekOf?: string;        // scope: "week" — ISO date of that Sunday
  fromDate?: string;      // scope: "forward"
  meal?: string;          // which meal if type === "meal"
  bedtime?: string;
  wakeTime?: string;
  windowStart?: string;
  windowEnd?: string;
  durationMinutes?: number;
  reason?: string;
  createdAt: string;
}

export interface LifestyleConfig {
  sleep: {
    defaultBedtime: string;
    defaultWakeTime: string;
    minimumHours: number;
    windDownBufferMinutes: number;
  };
  meals: Record<string, {
    enabled: boolean;
    windowStart: string;
    windowEnd: string;
    durationMinutes: number;
    intervalHours?: number;
  }>;
  overrides: {
    active: LifestyleOverride[];
  };
}

export interface SchedulingPreferences {
  taskWindows: Array<{
    start: string;
    end: string;
    weight: "prime" | "high" | "medium";
    label: string;
  }>;
  protectedWindows: Array<{
    start: string;
    end: string;
    label: string;
    overridable: boolean;
  }>;
  taskPlacementOrder: string;
  slotGranularityMinutes: number;
  downtimeBufferMinutes: number;
  maxDailyTaskHours: number;
}

// ── Core read/write ────────────────────────────────────────────────────────

/**
 * Read any config file by filename.
 * Returns typed result — caller provides the expected shape via generic.
 */
export function readConfig<T>(filename: string): T {
  const filePath = path.join(CONFIG_DIR, filename);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Config file not found: ${filePath}`);
  }
  const raw = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(raw) as T;
}

/**
 * Write any config file by filename.
 * Overwrites the full file — always pass the complete config object.
 */
export function writeConfig<T>(filename: string, data: T): void {
  const filePath = path.join(CONFIG_DIR, filename);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

// ── Lifestyle helpers ──────────────────────────────────────────────────────

export function readLifestyle(): LifestyleConfig {
  return readConfig<LifestyleConfig>("lifestyle.json");
}

/**
 * Adds a lifestyle override (sleep or meal change).
 * Claude calls this when you say "move my bedtime tonight" etc.
 */
export function addLifestyleOverride(
  override: Omit<LifestyleOverride, "id" | "createdAt">
): LifestyleOverride {
  const config = readLifestyle();
  const newOverride: LifestyleOverride = {
    ...override,
    id: generateId(),
    createdAt: new Date().toISOString(),
  };
  config.overrides.active.push(newOverride);
  writeConfig("lifestyle.json", config);
  return newOverride;
}

/**
 * Removes expired day/week overrides.
 * Called automatically at the start of Sunday planning.
 */
export function purgeExpiredOverrides(): number {
  const config = readLifestyle();
  const today = todayISO();
  const thisWeekSunday = getCurrentSundayISO();

  const before = config.overrides.active.length;

  config.overrides.active = config.overrides.active.filter((o) => {
    if (o.scope === "day" && o.date && o.date < today) return false;
    if (o.scope === "week" && o.weekOf && o.weekOf < thisWeekSunday) return false;
    return true;
  });

  const removed = before - config.overrides.active.length;
  if (removed > 0) writeConfig("lifestyle.json", config);
  return removed;
}

/**
 * Resolves the effective sleep schedule for a given date,
 * applying any active overrides in priority order.
 */
export function getEffectiveSleep(date: string): {
  bedtime: string;
  wakeTime: string;
  windDownBufferMinutes: number;
} {
  const config = readLifestyle();
  const base = {
    bedtime: config.sleep.defaultBedtime,
    wakeTime: config.sleep.defaultWakeTime,
    windDownBufferMinutes: config.sleep.windDownBufferMinutes,
  };

  // Find the most specific applicable override (day > week > forward)
  const overrides = config.overrides.active
    .filter((o) => o.type === "sleep")
    .filter((o) => isOverrideActiveForDate(o, date));

  const priority = { day: 3, week: 2, forward: 1 };
  overrides.sort((a, b) => (priority[b.scope] ?? 0) - (priority[a.scope] ?? 0));

  const best = overrides[0];
  if (!best) return base;

  return {
    bedtime: best.bedtime ?? base.bedtime,
    wakeTime: best.wakeTime ?? base.wakeTime,
    windDownBufferMinutes: base.windDownBufferMinutes,
  };
}

/**
 * Resolves the effective meal config for a given meal and date.
 */
export function getEffectiveMeal(
  mealName: string,
  date: string
): { enabled: boolean; windowStart: string; windowEnd: string; durationMinutes: number } {
  const config = readLifestyle();
  const base = config.meals[mealName];
  if (!base) throw new Error(`Unknown meal: ${mealName}`);

  const overrides = config.overrides.active
    .filter((o) => o.type === "meal" && o.meal === mealName)
    .filter((o) => isOverrideActiveForDate(o, date));

  const priority = { day: 3, week: 2, forward: 1 };
  overrides.sort((a, b) => (priority[b.scope] ?? 0) - (priority[a.scope] ?? 0));

  const best = overrides[0];
  if (!best) return base;

  return {
    enabled: base.enabled,
    windowStart: best.windowStart ?? base.windowStart,
    windowEnd: best.windowEnd ?? base.windowEnd,
    durationMinutes: best.durationMinutes ?? base.durationMinutes,
  };
}

// ── Scheduling preferences ─────────────────────────────────────────────────

export function readSchedulingPreferences(): SchedulingPreferences {
  return readConfig<SchedulingPreferences>("scheduling-preferences.json");
}

// ── Utilities ──────────────────────────────────────────────────────────────

function isOverrideActiveForDate(override: LifestyleOverride, date: string): boolean {
  switch (override.scope) {
    case "day":
      return override.date === date;
    case "week":
      return override.weekOf === getCurrentSundayISO();
    case "forward":
      return !!override.fromDate && override.fromDate <= date;
    default:
      return false;
  }
}

function todayISO(): string {
  return new Date().toISOString().split("T")[0];
}

function getCurrentSundayISO(): string {
  const d = new Date();
  const day = d.getDay();
  const sunday = new Date(d);
  sunday.setDate(d.getDate() - day);
  return sunday.toISOString().split("T")[0];
}

function generateId(): string {
  // Simple unique ID without external dependency
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}