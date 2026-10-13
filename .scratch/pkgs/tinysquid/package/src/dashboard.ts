/**
 * API fetch + parse.
 *
 * opencode.ai exposes a usage API at `/console/api/go/status`. The route is
 * served by the console backend and requires:
 *
 *   Cookie: __Host-console_session=st_…
 *   x-org-id: <wrk_… org id>
 *
 * The response JSON carries `access.meters` with `limitMicroCents` /
 * `usedMicroCents` per period, plus `startsAt`/`resetsAt` timestamps. Every
 * meter carries its own `resetsAt`, the monthly meter included. A null
 * `resetsAt` means the period has not opened yet ("starts on first use" in the
 * console). Use the monthly meter's `resetsAt`, not `access.endsAt`: during a
 * retrying renewal the grace period runs past `endsAt`, so the two dates
 * differ. `access.endsAt` is the billing period end, and the fallback when the
 * monthly meter carries no `resetsAt`. The extension reports percentages and
 * countdowns only (never dollar amounts).
 *
 *   "meters": {
 *     "fiveHour": { "resetsAt": "…", "limitMicroCents": "1200000000",
 *                   "usedMicroCents": "1138760", … },
 *     "week":     { "resetsAt": "…", … },
 *     "month":    { "resetsAt": "…", "limitMicroCents": "6000000000",
 *                   "usedMicroCents": "1138760" }
 *   }
 */

import { normalizeWorkspaceId } from "./config.ts";

const ORIGIN = "https://opencode.ai";
const STATUS_PATH = "/console/api/go/status";
const REQUEST_TIMEOUT_MS = 20_000;
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export interface UsageMeter {
  period: import("./periods.ts").Period;
  /** 0-100, clamped. May carry decimals (0.7 means 0.7%). */
  percent: number;
  /** ISO timestamp of rollover, or null when the period is not open. */
  resetsAt: string | null;
}

export type FetchFailure =
  | { kind: "timeout" }
  | { kind: "network"; detail: string }
  | { kind: "unauthorized" }
  | { kind: "http"; status: number }
  | { kind: "no-payload" };

/** Meter key in the response → canonical period. */
const METER_KEYS: { key: string; period: UsageMeter["period"] }[] = [
  { key: "fiveHour", period: "5h" },
  { key: "week", period: "weekly" },
  { key: "month", period: "monthly" },
];

/** Extract a `st_…` session id from a bare value or a `Cookie:` header line. */
export function normalizeSessionCookie(raw: string): string | null {
  const match = raw.match(/st_[A-Za-z0-9-]+/);
  return match ? match[0] : null;
}

export function parseStatusPayload(payload: unknown): UsageMeter[] {
  if (typeof payload !== "object" || payload === null) return [];
  const access = (payload as Record<string, unknown>).access;
  if (typeof access !== "object" || access === null) return [];
  const a = access as Record<string, unknown>;
  const meters = a.meters;
  if (typeof meters !== "object" || meters === null) return [];
  const record = meters as Record<string, unknown>;
  // `access.endsAt` is the billing period end, used only as the fallback for
  // a monthly meter that carries no `resetsAt`.
  const periodEnd = typeof a.endsAt === "string" && a.endsAt ? a.endsAt : null;

  const parsed: UsageMeter[] = [];
  for (const { key, period } of METER_KEYS) {
    const meter = record[key];
    if (typeof meter !== "object" || meter === null) continue;
    const m = meter as Record<string, unknown>;

    const limit = Number(m.limitMicroCents);
    const used = Number(m.usedMicroCents);
    if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(used)) {
      continue;
    }

    // Never substitute the billing period end for a null `resetsAt`: a null
    // means the period has not opened yet, and the 5h meter would show the
    // monthly reset.
    const ownResetsAt =
      typeof m.resetsAt === "string" && m.resetsAt ? m.resetsAt : null;
    const resetsAt = ownResetsAt ?? (period === "monthly" ? periodEnd : null);

    parsed.push({
      period,
      percent: Math.min(100, Math.max(0, (used / limit) * 100)),
      resetsAt,
    });
  }

  return parsed;
}

/** Fetch the status endpoint and parse it. Throws FetchFailure on any problem. */
export async function fetchUsage(
  workspaceId: string,
  sessionCookie: string,
  origin = ORIGIN,
): Promise<UsageMeter[]> {
  const orgId = normalizeWorkspaceId(workspaceId) ?? workspaceId;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${origin}${STATUS_PATH}`, {
      headers: {
        Cookie: `__Host-console_session=${normalizeSessionCookie(sessionCookie) ?? sessionCookie}`,
        "x-org-id": orgId,
        "User-Agent": USER_AGENT,
        Accept: "application/json",
      },
      signal: controller.signal,
      redirect: "manual",
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw { kind: "timeout" } as FetchFailure;
    }

    throw {
      kind: "network",
      detail: err instanceof Error ? err.message : String(err),
    } as FetchFailure;
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 401 || response.status === 403) {
    throw { kind: "unauthorized" } as FetchFailure;
  }

  if (!response.ok)
    throw { kind: "http", status: response.status } as FetchFailure;

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw { kind: "no-payload" } as FetchFailure;
  }

  const meters = parseStatusPayload(payload);
  if (meters.length === 0) {
    // A 200 that parses but carries no meters means the auth shape is wrong.
    // That covers a wrong cookie or a changed payload schema: auth-shaped to
    // the user either way.
    throw { kind: "unauthorized" } as FetchFailure;
  }

  return meters;
}

export function describeFailure(failure: unknown): string {
  const f = failure as FetchFailure;

  switch (f?.kind) {
    case "timeout":
      return "request timed out";
    case "network":
      return `network error: ${f.detail}`;
    case "unauthorized":
      return "session expired, set a fresh one with /opencode-go session-cookie";
    case "http":
      return `HTTP ${f.status}`;
    case "no-payload":
      return "no usage data in response, opencode.ai API may have changed";
    default:
      return failure instanceof Error ? failure.message : String(failure);
  }
}
