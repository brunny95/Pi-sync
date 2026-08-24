/**
 * Usage Extension — Show token usage and cost across sessions
 *
 * /usage              → current project, all time
 * /usage all          → all projects, all time
 * /usage 7d           → current project, last 7 days
 * /usage today        → current project, today only
 * /usage all 7d       → all projects, last 7 days
 * /usage --full       → show all sessions (no 20-session cap)
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { getMarkdownTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";

// ── Types ──

interface SessionUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	reasoning: number;
	costTotal: number;
}

interface SessionInfo {
	file: string;
	date: string;
	slug: string;
	topic: string;
	models: string[];
	usage: SessionUsage;
	messageCount: number;
}

interface ProjectGroup {
	slug: string;
	displayName: string;
	sessions: SessionInfo[];
	usage: SessionUsage;
}

interface ReportData {
	scope: string;
	timeLabel: string;
	projects: ProjectGroup[];
	totals: SessionUsage;
	totalSessions: number;
	showAllSessions: boolean;
}

// ── Helpers ──

function cwdToSlug(cwd: string): string {
	return `--${cwd.replace(/\//g, "-")}--`;
}

function slugToDisplay(slug: string): string {
	// --srv-network_home-abo-Desktop-BLM41-n-v21-- → ~/Desktop/BLM41-n-v21
	const inner = slug.replace(/^--/, "").replace(/--$/, "");
	const home = homedir().replace(/\//g, "-");
	if (inner === home) return "~/";
	if (inner.startsWith(home + "-")) {
		return "~/" + inner.slice(home.length + 1).replace(/-/g, "/");
	}
	return "/" + inner.replace(/-/g, "/");
}

function parseTimeFilter(arg: string): Date | null {
	if (arg === "today") {
		const d = new Date();
		d.setHours(0, 0, 0, 0);
		return d;
	}
	const match = arg.match(/^(\d+)([dwm])$/);
	if (!match) return null;
	const [, n, unit] = match;
	const now = new Date();
	if (unit === "d") now.setDate(now.getDate() - Number(n));
	if (unit === "w") now.setDate(now.getDate() - Number(n) * 7);
	if (unit === "m") now.setMonth(now.getMonth() - Number(n));
	return now;
}

function dateFromFilename(filename: string): Date | null {
	// 2026-08-24T06-29-38-436Z_... → 2026-08-24T06:29:38.436Z
	const match = filename.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_/);
	if (!match) return null;
	const [, y, mo, d, h, mi, s, ms] = match;
	return new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}.${ms}Z`);
}

function emptyUsage(): SessionUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, reasoning: 0, costTotal: 0 };
}

function addUsage(target: SessionUsage, source: SessionUsage): void {
	target.input += source.input;
	target.output += source.output;
	target.cacheRead += source.cacheRead;
	target.cacheWrite += source.cacheWrite;
	target.totalTokens += source.totalTokens;
	target.reasoning += source.reasoning;
	target.costTotal += source.costTotal;
}

function fmt(n: number): string {
	return n.toLocaleString("en-US");
}

function fmtCost(n: number): string {
	return `$${n.toFixed(2)}`;
}

function truncate(s: string, maxLen: number): string {
	if (s.length <= maxLen) return s;
	return s.slice(0, maxLen - 1) + "…";
}

// ── Session parsing ──

function parseSessionFile(filepath: string, slug: string): SessionInfo | null {
	let raw: string;
	try {
		raw = readFileSync(filepath, "utf-8");
	} catch {
		return null;
	}

	const lines = raw.split("\n").filter(Boolean);
	const usage = emptyUsage();
	const models = new Map<string, number>();
	let topic = "";
	let messageCount = 0;
	let date = "";

	// Extract date from filename
	const fname = basename(filepath);
	const d = dateFromFilename(fname);
	if (d) {
		date = d.toISOString().slice(0, 10);
	}

	for (const line of lines) {
		let entry: any;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}

		if (entry.type === "message" && entry.message) {
			const msg = entry.message;

			// First user message → topic
			if (msg.role === "user" && !topic) {
				const content = msg.content;
				if (Array.isArray(content)) {
					const textPart = content.find((p: any) => p.type === "text");
					if (textPart) topic = textPart.text.replace(/\n/g, " ").trim();
				} else if (typeof content === "string") {
					topic = content.replace(/\n/g, " ").trim();
				}
			}

			// Assistant messages → usage
			if (msg.role === "assistant" && msg.usage) {
				messageCount++;
				const u = msg.usage;
				usage.input += u.input || 0;
				usage.output += u.output || 0;
				usage.cacheRead += u.cacheRead || 0;
				usage.cacheWrite += u.cacheWrite || 0;
				usage.totalTokens += u.totalTokens || 0;
				usage.reasoning += u.reasoning || 0;
				if (u.cost && typeof u.cost.total === "number") {
					usage.costTotal += u.cost.total;
				}

				// Track model usage
				const model = msg.model || "unknown";
				models.set(model, (models.get(model) || 0) + 1);
			}
		}

		// Also count usage from BTW custom entries
		if (entry.type === "custom" && entry.customType === "btw-thread-entry" && entry.data?.usage) {
			const u = entry.data.usage;
			usage.input += u.input || 0;
			usage.output += u.output || 0;
			usage.cacheRead += u.cacheRead || 0;
			usage.cacheWrite += u.cacheWrite || 0;
			usage.totalTokens += u.totalTokens || 0;
			usage.reasoning += u.reasoning || 0;
			if (u.cost && typeof u.cost.total === "number") {
				usage.costTotal += u.cost.total;
			}
		}
	}

	// Sort models by usage count, most used first
	const sortedModels = [...models.entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m);

	return {
		file: filepath,
		date,
		slug,
		topic: topic || "(no topic)",
		models: sortedModels.length > 0 ? sortedModels : ["unknown"],
		usage,
		messageCount,
	};
}

function scanSessions(sessionsDir: string, slugFilter: string | null, cutoff: Date | null): SessionInfo[] {
	if (!existsSync(sessionsDir)) return [];

	const sessions: SessionInfo[] = [];
	let slugs: string[];

	try {
		slugs = readdirSync(sessionsDir);
	} catch {
		return [];
	}

	for (const slug of slugs) {
		if (slugFilter && slug !== slugFilter) continue;

		const dirPath = join(sessionsDir, slug);
		let files: string[];
		try {
			files = readdirSync(dirPath).filter((f) => f.endsWith(".jsonl"));
		} catch {
			continue;
		}

		for (const file of files) {
			// Time filter via filename
			if (cutoff) {
				const fileDate = dateFromFilename(file);
				if (fileDate && fileDate < cutoff) continue;
			}

			const info = parseSessionFile(join(dirPath, file), slug);
			if (info) sessions.push(info);
		}
	}

	// Sort newest first
	sessions.sort((a, b) => b.date.localeCompare(a.date));
	return sessions;
}

// ── Report formatting ──

function buildReport(sessions: SessionInfo[], scope: string, timeLabel: string, showAll: boolean): ReportData {
	const projectMap = new Map<string, ProjectGroup>();
	const totals = emptyUsage();
	let totalSessions = 0;

	for (const s of sessions) {
		totalSessions++;
		addUsage(totals, s.usage);

		let group = projectMap.get(s.slug);
		if (!group) {
			group = { slug: s.slug, displayName: slugToDisplay(s.slug), sessions: [], usage: emptyUsage() };
			projectMap.set(s.slug, group);
		}
		group.sessions.push(s);
		addUsage(group.usage, s.usage);
	}

	const projects = [...projectMap.values()].sort((a, b) => b.usage.costTotal - a.usage.costTotal);

	return { scope, timeLabel, projects, totals, totalSessions, showAllSessions: showAll };
}

function formatReport(data: ReportData): string {
	const lines: string[] = [];

	// Header
	lines.push(`## 📊 Usage Summary`);
	lines.push(`**Scope:** ${data.scope} · ${data.timeLabel} · ${data.totalSessions} session${data.totalSessions !== 1 ? "s" : ""}`);
	lines.push("");

	// Grand totals
	lines.push("| Metric | Value |");
	lines.push("|---|---|");
	lines.push(`| Total tokens | ${fmt(data.totals.totalTokens)} |`);
	lines.push(`| ├─ Input | ${fmt(data.totals.input)} |`);
	lines.push(`| ├─ Output | ${fmt(data.totals.output)} |`);
	lines.push(`| ├─ Cache read | ${fmt(data.totals.cacheRead)} |`);
	lines.push(`| ├─ Cache write | ${fmt(data.totals.cacheWrite)} |`);
	lines.push(`| └─ Reasoning | ${fmt(data.totals.reasoning)} |`);
	lines.push(`| **Total cost** | **${fmtCost(data.totals.costTotal)}** |`);
	lines.push("");

	// Per-project (only when multiple projects)
	if (data.projects.length > 1) {
		lines.push("### By project");
		lines.push("| Project | Sessions | Tokens | Cost |");
		lines.push("|---|---|---|---|");
		for (const p of data.projects) {
			lines.push(`| ${truncate(p.displayName, 35)} | ${p.sessions.length} | ${fmt(p.usage.totalTokens)} | ${fmtCost(p.usage.costTotal)} |`);
		}
		lines.push("");
	}

	// Per-session detail
	const allSessions = data.projects.flatMap((p) => p.sessions).sort((a, b) => b.date.localeCompare(a.date));
	const maxShow = data.showAllSessions ? allSessions.length : 20;
	const shown = allSessions.slice(0, maxShow);
	const hidden = allSessions.length - shown.length;

	lines.push(`### Recent sessions${hidden > 0 ? ` (${shown.length} of ${allSessions.length}, use \`--full\` for all)` : ""}`);
	lines.push("| Date | Model | Tokens | Cost | Topic |");
	lines.push("|---|---|---|---|---|");
	for (const s of shown) {
		const model = s.models[0] || "unknown";
		lines.push(`| ${s.date} | ${model} | ${fmt(s.usage.totalTokens)} | ${fmtCost(s.usage.costTotal)} | ${truncate(s.topic, 40)} |`);
	}
	lines.push("");

	return lines.join("\n");
}

// ── Extension ──

export default function (pi: ExtensionAPI) {
	const mdTheme = getMarkdownTheme();

	pi.registerMessageRenderer<ReportData>("usage-report", (message, _options, _theme) => {
		const details = message.details;
		if (!details) return undefined;
		const md = formatReport(details);
		return new Markdown(md, 1, 0, mdTheme);
	});

	pi.registerCommand("usage", {
		description: "Show token usage and cost. Args: [all] [today|Nd|Nw|Nm] [--full]",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);

			let showAll = false;
			let showFull = false;
			let cutoff: Date | null = null;
			const unknown: string[] = [];

			for (const part of parts) {
				if (part === "all") {
					showAll = true;
				} else if (part === "--full") {
					showFull = true;
				} else {
					const tf = parseTimeFilter(part);
					if (tf) {
						cutoff = tf;
					} else {
						unknown.push(part);
					}
				}
			}

			if (unknown.length > 0) {
				ctx.ui.notify(`Unknown args: ${unknown.join(", ")}. Usage: /usage [all] [today|7d|30d] [--full]`, "error");
				return;
			}

			const sessionsDir = join(homedir(), ".pi", "agent", "sessions");
			const slugFilter = showAll ? null : cwdToSlug(ctx.cwd);
			const scope = showAll ? "all projects" : "current project";

			let timeLabel = "all time";
			if (cutoff) {
				const arg = parts.find((p) => p !== "all" && p !== "--full") || "";
				timeLabel = arg === "today" ? "today" : `last ${arg}`;
			}

			// Scan
			ctx.ui.notify("Scanning sessions...", "info");
			const sessions = scanSessions(sessionsDir, slugFilter, cutoff);

			if (sessions.length === 0) {
				ctx.ui.notify(`No sessions found (${scope}, ${timeLabel}).`, "warning");
				return;
			}

			const report = buildReport(sessions, scope, timeLabel, showFull);

			pi.sendMessage(
				{
					customType: "usage-report",
					content: `Usage report: ${report.totalSessions} sessions, ${fmtCost(report.totals.costTotal)} total`,
					display: true,
					details: report,
				},
				{ triggerTurn: false },
			);
		},
	});
}
