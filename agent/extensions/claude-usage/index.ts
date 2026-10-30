/**
 * Claude usage — live status-bar counter for a Claude subscription (OAuth login).
 *
 * Footer:  `Claude 5/8%`  = 5-hour session % / weekly %.
 * Colour:  normal < 70%, warning >= 70%, error >= 90% (worst of the two).
 * Shown only when the current model's provider is "anthropic" and it has auth.
 *
 * Commands:
 *   /claude-usage   detailed panel with reset countdowns (+ per-model weekly if present)
 *   /claude-status  toggle the footer indicator (persisted)
 *
 * Endpoint (undocumented, same one Claude Code's /usage uses):
 *   GET https://api.anthropic.com/api/oauth/usage
 *   Authorization: Bearer <oauth access token>, anthropic-beta: oauth-2025-04-20
 *   -> { five_hour:{utilization,resets_at}, seven_day:{...}, seven_day_opus?:{...}, seven_day_sonnet?:{...} }
 *
 * Refresh: session_start, model_select, and after turns (debounced, and at most
 * once per MIN_INTERVAL_MS to stay clear of the endpoint's rate limit).
 * API-key logins have no such limits: the indicator then just stays hidden.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const STATUS_KEY = "claude-usage";
const PROVIDER = "anthropic";
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CONFIG_PATH = join(getAgentDir(), "claude-usage.json");
const MIN_INTERVAL_MS = 30_000;

type Bucket = { utilization: number | null; resets_at: string | null };
type UsageResponse = {
	five_hour?: Bucket | null;
	seven_day?: Bucket | null;
	seven_day_opus?: Bucket | null;
	seven_day_sonnet?: Bucket | null;
};

function loadVisible(): boolean {
	try {
		if (!existsSync(CONFIG_PATH)) return true;
		return (JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as { visible?: boolean }).visible !== false;
	} catch {
		return true;
	}
}

function saveVisible(visible: boolean): void {
	try {
		writeFileSync(CONFIG_PATH, JSON.stringify({ visible }, null, 2) + "\n", "utf8");
	} catch {}
}

function formatResetsIn(iso: string | null | undefined): string {
	if (!iso) return "?";
	const diff = new Date(iso).getTime() - Date.now();
	if (!Number.isFinite(diff)) return "?";
	if (diff <= 0) return "now";
	const mins = Math.round(diff / 60000);
	if (mins < 60) return `${mins}m`;
	if (mins < 1440) {
		const h = Math.floor(mins / 60);
		const m = mins % 60;
		return m === 0 ? `${h}h` : `${h}h ${m}m`;
	}
	const d = Math.floor(mins / 1440);
	const h = Math.floor((mins % 1440) / 60);
	return h === 0 ? `${d}d` : `${d}d ${h}h`;
}

const pct = (b: Bucket | null | undefined): number | null =>
	typeof b?.utilization === "number" ? Math.round(b.utilization) : null;

export default function (pi: ExtensionAPI) {
	let cached: UsageResponse | null = null;
	let lastFetch = 0;
	let isFetching = false;
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;
	let visible = loadVisible();

	const isActive = (ctx: ExtensionContext): boolean =>
		visible && ctx.model?.provider === PROVIDER && ctx.modelRegistry.getProviderAuthStatus(PROVIDER).configured;

	function safeSetStatus(ctx: ExtensionContext, value: string | undefined) {
		try {
			ctx.ui.setStatus(STATUS_KEY, value);
		} catch {}
	}

	function color(theme: ExtensionContext["ui"]["theme"], text: string, worst: number | null): string {
		try {
			if (worst !== null && worst >= 90) return theme.fg("error", text);
			if (worst !== null && worst >= 70) return theme.fg("warning", text);
			return theme.fg("mdHeading", text);
		} catch {
			return text;
		}
	}

	function render(u: UsageResponse | null, theme: ExtensionContext["ui"]["theme"]): string {
		if (!u) return color(theme, "Claude --", null);
		const s = pct(u.five_hour);
		const w = pct(u.seven_day);
		const worst = Math.max(s ?? 0, w ?? 0);
		return color(theme, `Claude ${s ?? "-"}/${w ?? "-"}%`, worst);
	}

	async function fetchUsage(ctx: ExtensionContext): Promise<UsageResponse> {
		const token = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER);
		if (!token) throw new Error("no Anthropic credentials");

		const controller = new AbortController();
		const t = setTimeout(() => controller.abort(), 8000);
		let onAbort: (() => void) | undefined;
		if (ctx.signal) {
			if (ctx.signal.aborted) controller.abort();
			else {
				onAbort = () => controller.abort();
				ctx.signal.addEventListener("abort", onAbort, { once: true });
			}
		}
		try {
			const res = await fetch(USAGE_URL, {
				headers: {
					authorization: `Bearer ${token}`,
					"anthropic-beta": "oauth-2025-04-20",
					accept: "application/json",
					"user-agent": "pi-claude-usage",
				},
				signal: controller.signal,
			});
			if (res.status === 401 || res.status === 403)
				throw new Error(`${res.status} — not a Claude subscription (OAuth) login?`);
			if (res.status === 429) throw new Error("429 rate limited, will retry later");
			if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
			const json = (await res.json()) as UsageResponse;
			if (!json.five_hour && !json.seven_day) throw new Error("unexpected usage response shape");
			return json;
		} finally {
			clearTimeout(t);
			if (onAbort && ctx.signal) ctx.signal.removeEventListener("abort", onAbort);
		}
	}

	async function refresh(ctx: ExtensionContext, force = false) {
		if (!isActive(ctx)) {
			safeSetStatus(ctx, undefined);
			return;
		}
		// Always paint what we have; only hit the network when due.
		if (cached) safeSetStatus(ctx, render(cached, ctx.ui.theme));
		if (isFetching) return;
		if (!force && Date.now() - lastFetch < MIN_INTERVAL_MS) return;
		isFetching = true;
		lastFetch = Date.now();
		try {
			cached = await fetchUsage(ctx);
			safeSetStatus(ctx, render(cached, ctx.ui.theme));
		} catch {
			safeSetStatus(ctx, render(cached, ctx.ui.theme));
		} finally {
			isFetching = false;
		}
	}

	function scheduleRefresh(ctx: ExtensionContext) {
		if (debounceTimer) clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => {
			debounceTimer = null;
			void refresh(ctx).catch(() => {});
		}, 800);
	}

	function clearTimer() {
		if (debounceTimer) {
			clearTimeout(debounceTimer);
			debounceTimer = null;
		}
	}

	// --- lifecycle ---

	pi.on("session_start", async (_evt, ctx) => {
		visible = loadVisible();
		if (!isActive(ctx)) {
			safeSetStatus(ctx, undefined);
			return;
		}
		safeSetStatus(ctx, color(ctx.ui.theme, "Claude …", null));
		await refresh(ctx, true);
	});

	pi.on("model_select", async (_evt, ctx) => {
		if (!isActive(ctx)) {
			clearTimer();
			safeSetStatus(ctx, undefined);
			return;
		}
		await refresh(ctx, true);
	});

	pi.on("turn_end", async (_evt, ctx) => {
		if (isActive(ctx)) scheduleRefresh(ctx);
	});

	pi.on("agent_settled", async (_evt, ctx) => {
		if (isActive(ctx)) scheduleRefresh(ctx);
	});

	pi.on("session_shutdown", async (_evt, ctx) => {
		clearTimer();
		safeSetStatus(ctx, undefined);
	});

	// --- /claude-usage ---

	pi.registerCommand("claude-usage", {
		description: "Show Claude subscription usage (5-hour session / weekly)",
		handler: async (_args, ctx) => {
			if (!ctx.modelRegistry.getProviderAuthStatus(PROVIDER).configured) {
				ctx.ui.notify("Anthropic not configured — log in with /login first", "warning");
				return;
			}
			try {
				const u = await fetchUsage(ctx);
				cached = u;
				lastFetch = Date.now();
				if (isActive(ctx)) safeSetStatus(ctx, render(u, ctx.ui.theme));

				const line = (label: string, b: Bucket | null | undefined) => {
					const p = pct(b);
					if (p === null) return null;
					return `   ${label.padEnd(15)}${String(p).padStart(3)}% — resets in ${formatResetsIn(b?.resets_at)}`;
				};
				const lines = [
					"Claude usage:",
					line("Session (5h)", u.five_hour),
					line("Weekly", u.seven_day),
					line("Weekly Sonnet", u.seven_day_sonnet),
					line("Weekly Opus", u.seven_day_opus),
					"",
					"   Toggle the footer indicator with /claude-status",
				].filter((l): l is string => l !== null);
				ctx.ui.notify(lines.join("\n"), "info");
			} catch (e) {
				ctx.ui.notify(`Claude usage fetch failed: ${e instanceof Error ? e.message : String(e)}`, "error");
			}
		},
	});

	// --- /claude-status ---

	pi.registerCommand("claude-status", {
		description: "Toggle the Claude usage indicator in the footer",
		handler: async (_args, ctx) => {
			visible = !visible;
			saveVisible(visible);
			if (!visible) {
				clearTimer();
				safeSetStatus(ctx, undefined);
				ctx.ui.notify("Claude usage: off — hidden from status bar", "info");
			} else if (isActive(ctx)) {
				ctx.ui.notify("Claude usage: on — fetching…", "info");
				await refresh(ctx, true);
			} else {
				ctx.ui.notify("Claude usage: on — will appear when an Anthropic model is selected", "info");
			}
		},
	});
}
