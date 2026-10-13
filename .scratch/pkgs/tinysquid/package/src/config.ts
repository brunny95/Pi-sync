import { promises as fs } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { PERIODS, parsePeriodList, type Period } from "./periods.ts";

const CONFIG_FILE = "opencode_go_usage_settings.json";

export interface Config {
  workspaceId: string;
  /** Empty = unset. Stored normalized (bare `st_…` session id). */
  sessionCookie: string;
  footerEnabled: boolean;
  footerPeriods: Period[];
  footerCountdowns: boolean;
  refreshMinutes: number;
}

export const DEFAULT_CONFIG: Config = {
  workspaceId: "",
  sessionCookie: "",

  footerEnabled: true,
  footerPeriods: [...PERIODS],
  footerCountdowns: false,

  refreshMinutes: 3,
};

/** Extract a `wrk_…` id from a bare id or a full dashboard URL. */
export function normalizeWorkspaceId(raw: string): string | null {
  const match = raw.match(/wrk_[A-Za-z0-9]+/);
  return match ? match[0] : null;
}

/**
 * Normalize user-provided session into a bare `st_…` session id.
 * Accepted: bare value (`st_…`), `__Host-console_session=…` pair, or a full
 * `Cookie:` header line containing the pair.
 */
export function normalizeSessionCookie(raw: string): string {
  const value = raw
    .trim()
    .replace(/^cookie:\s*/i, "")
    .trim();
  return normalizeSessionId(value) ?? value;
}

function normalizeSessionId(value: string): string | null {
  const match = value.match(/st_[A-Za-z0-9-]+/);
  return match ? match[0] : null;
}

export function configPath(): string {
  return join(getAgentDir(), CONFIG_FILE);
}

function mergeConfig(raw: unknown): Config {
  const config: Config = { ...DEFAULT_CONFIG, footerPeriods: [...PERIODS] };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return config;

  const r = raw as Record<string, unknown>;
  if (typeof r.workspaceId === "string")
    config.workspaceId = r.workspaceId.trim();
  if (typeof r.sessionCookie === "string")
    config.sessionCookie = r.sessionCookie.trim();
  // Migration: pre-0.2.0 configs stored the old `auth` cookie under
  // `authCookie`. Its value is useless against the new API, but keep the
  // workspace id so the user only has to re-enter the session.
  else if (typeof r.authCookie === "string")
    config.sessionCookie = r.authCookie.trim();
  if (typeof r.footerEnabled === "boolean")
    config.footerEnabled = r.footerEnabled;
  if (Array.isArray(r.footerPeriods)) {
    const { periods } = parsePeriodList(r.footerPeriods.join(","));
    config.footerPeriods = periods;
  }
  if (typeof r.footerCountdowns === "boolean")
    config.footerCountdowns = r.footerCountdowns;
  if (
    typeof r.refreshMinutes === "number" &&
    Number.isFinite(r.refreshMinutes) &&
    r.refreshMinutes > 0
  ) {
    config.refreshMinutes = Math.min(
      60,
      Math.max(1, Math.round(r.refreshMinutes)),
    );
  }
  return config;
}

export async function loadConfig(): Promise<Config> {
  try {
    return mergeConfig(JSON.parse(await fs.readFile(configPath(), "utf8")));
  } catch {
    return mergeConfig(undefined);
  }
}

export async function saveConfig(config: Config): Promise<void> {
  const path = configPath();
  const tmp = `${path}.tmp`;

  await fs.mkdir(getAgentDir(), { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(config, null, 2) + "\n", {
    mode: 0o600,
  });
  await fs.rename(tmp, path);
}

/** Create the default config file on first load so the schema is discoverable. */
export async function ensureConfigFile(): Promise<void> {
  try {
    await fs.access(configPath());
  } catch {
    try {
      await saveConfig(mergeConfig(undefined));
    } catch (err) {
      console.error("[opencode-go] could not create default config:", err);
    }
  }
}

// env vars win over the config file.
export interface Credentials {
  workspaceId: string;
  sessionCookie: string;
}

export function resolveCreds(config: Config): Credentials | null {
  const workspaceId = (
    process.env.OPENCODE_GO_WORKSPACE_ID ??
    config.workspaceId ??
    ""
  ).trim();
  const sessionCookie = (
    process.env.OPENCODE_GO_SESSION_COOKIE ??
    config.sessionCookie ??
    ""
  ).trim();
  return workspaceId && sessionCookie ? { workspaceId, sessionCookie } : null;
}
