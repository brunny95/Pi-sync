import {
  normalizeSessionCookie,
  normalizeWorkspaceId,
  resolveCreds,
  saveConfig,
  type Config,
} from "./config.ts";
import { describeFailure, fetchUsage, type UsageMeter } from "./dashboard.ts";
import { type Period } from "./periods.ts";

/**
 * Owns the extension's mutable state (config, meters, fetch error) and the
 * refresh engine: single-flight fetch + TTL timer. Mutations validate,
 * persist, then notify subscribers; the composition root subscribes to
 * re-render the footer. UI/theme live outside the store.
 */
export class UsageStore {
  private config: Config;
  private meters: UsageMeter[] = [];
  private lastError: string | null = null;
  private lastFetchedAt = 0;
  private inFlight: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private listeners = new Set<() => void>();

  /** Interval that checks the cache TTL. Fetches only happen when the TTL passed. */
  private static readonly TICK_MS = 30_000;

  constructor(config: Config) {
    this.config = config;
  }

  get current(): Readonly<Config> {
    return this.config;
  }

  get usage(): readonly UsageMeter[] {
    return this.meters;
  }

  get error(): string | null {
    return this.lastError;
  }

  get credentials() {
    return resolveCreds(this.config);
  }

  /** ISO timestamp of the last successful fetch, for "stale" display. */
  get fetchedAt(): number {
    return this.lastFetchedAt;
  }

  /** Adopt the persisted config loaded at session start (does not re-save). */
  setConfig(config: Config): void {
    this.config = config;
    this.notify();
  }

  /** Store an already-normalized workspace id. Validation stays in the command layer. */
  async setWorkspaceId(id: string): Promise<void> {
    this.config.workspaceId = id;
    await saveConfig(this.config);
    this.notify();
  }

  async setSessionCookie(rawCookie: string): Promise<void> {
    this.config.sessionCookie = normalizeSessionCookie(rawCookie);
    await saveConfig(this.config);
    this.notify();
  }

  /** `null` toggles the current value. */
  async setFooterEnabled(on: boolean | null): Promise<void> {
    this.config.footerEnabled = on ?? !this.config.footerEnabled;
    await saveConfig(this.config);
    this.notify();
  }

  async setFooterPeriods(periods: Period[]): Promise<void> {
    this.config.footerPeriods = periods;
    await saveConfig(this.config);
    this.notify();
  }

  /** `null` toggles the current value. */
  async setFooterCountdowns(on: boolean | null): Promise<void> {
    this.config.footerCountdowns = on ?? !this.config.footerCountdowns;
    await saveConfig(this.config);
    this.notify();
  }

  async setRefreshInterval(minutes: number): Promise<void> {
    this.config.refreshMinutes = minutes;
    await saveConfig(this.config);
    this.restartTimer();
    this.notify();
  }

  async disconnect(): Promise<void> {
    this.config.workspaceId = "";
    this.config.sessionCookie = "";
    await saveConfig(this.config);
    this.meters = [];
    this.lastError = null;
    this.lastFetchedAt = 0;
    this.notify();
  }

  private async doFetch(): Promise<void> {
    const creds = resolveCreds(this.config);
    if (!creds) {
      this.meters = [];
      this.lastError = null;
      this.lastFetchedAt = 0;
      return;
    }

    const workspaceId = normalizeWorkspaceId(creds.workspaceId);
    if (!workspaceId) {
      this.meters = [];
      this.lastError = "invalid workspace id (expected wrk_…)";
      return;
    }

    try {
      this.meters = await fetchUsage(workspaceId, creds.sessionCookie);
      this.lastFetchedAt = Date.now();
      this.lastError = null;
    } catch (err) {
      this.lastError = describeFailure(err); // keep meters: views mark them stale
    }
  }

  /** Single-flight refresh: concurrent triggers reuse the running fetch. */
  refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.doFetch()
      .catch((err) => {
        console.error("[opencode-go] refresh failed:", err);
      })
      .finally(() => {
        this.inFlight = null;
        this.notify();
      });
    return this.inFlight;
  }

  startTimer(): void {
    this.restartTimer();
  }

  stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private restartTimer(): void {
    this.stopTimer();
    this.timer = setInterval(() => {
      if (
        this.lastFetchedAt === 0 ||
        Date.now() - this.lastFetchedAt >= this.config.refreshMinutes * 60_000
      ) {
        void this.refresh();
      }
    }, UsageStore.TICK_MS);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
