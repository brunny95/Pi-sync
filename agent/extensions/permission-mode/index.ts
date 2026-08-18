/**
 * Permission Mode Extension (Claude-Code style)
 *
 * Adds three permission modes that gate what the agent is allowed to do,
 * toggled with a keyboard shortcut (default: Shift+Tab) or the /mode command.
 *
 *   auto         (default) The agent can do anything without asking.
 *   accept-edit  The agent may READ/search freely, but must ask before any
 *                edit/write or file-mutating bash command.
 *   manual       The agent must ask permission before EVERY tool action,
 *                including reads.
 *
 * Cycle order: auto -> accept-edit -> manual -> auto
 *
 * Configuration:
 *   - Change CYCLE_SHORTCUT below to rebind the toggle key.
 *     NOTE: "shift+tab" is bound by default to "cycle thinking level".
 *     Registering it here overrides that while this extension is loaded.
 *     Good conflict-free alternatives: "ctrl+shift+m", "alt+m".
 *   - Start in a specific mode with:  pi --permission-mode manual
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ── Configuration ───────────────────────────────────────────────────────────

/** Key that cycles through the permission modes. */
const CYCLE_SHORTCUT = "shift+tab";

type Mode = "auto" | "accept-edit" | "manual";
const MODES: Mode[] = ["auto", "accept-edit", "manual"];

/** Built-in read-only tools that are always safe in accept-edit mode. */
const READ_TOOLS = new Set<string>(["read", "ls", "grep", "find", "list", "glob", "tree"]);

/** Built-in tools that modify files. */
const WRITE_TOOLS = new Set<string>(["edit", "write", "multiedit", "apply_patch"]);

// Bash commands that only read state (allowed without asking in accept-edit).
const SAFE_BASH = [
	/^\s*(cat|head|tail|less|more|bat)\b/,
	/^\s*(ls|pwd|tree|stat|file|wc|du|df)\b/,
	/^\s*(grep|rg|find|fd|ag)\b/,
	/^\s*(echo|printf|env|printenv|date|cal|uptime|whoami|id|uname|which|whereis|type)\b/,
	/^\s*(ps|top|htop|free)\b/,
	/^\s*(sort|uniq|diff|jq|awk|cut|column)\b/,
	/^\s*sed\s+-n/,
	/^\s*git\s+(status|log|diff|show|branch|remote|ls-|config\s+--get)/,
	/^\s*(npm|yarn|pnpm)\s+(list|ls|view|info|why|outdated|audit)\b/,
	/^\s*(node|python|python3|go|cargo|rustc|java|deno|bun)\s+(--version|version)/,
];

function isSafeBash(command: string): boolean {
	return SAFE_BASH.some((p) => p.test(command));
}

// ── Extension ────────────────────────────────────────────────────────────────

export default function permissionModeExtension(pi: ExtensionAPI): void {
	let mode: Mode = "auto";

	pi.registerFlag("permission-mode", {
		description: "Initial permission mode: auto | accept-edit | manual",
		type: "string",
		default: "auto",
	});

	function label(m: Mode): string {
		switch (m) {
			case "auto":
				return "● auto";
			case "accept-edit":
				return "✎ accept-edit";
			case "manual":
				return "✋ manual";
		}
	}

	function color(m: Mode): "success" | "warning" | "error" {
		return m === "auto" ? "success" : m === "accept-edit" ? "warning" : "error";
	}

	function updateStatus(ctx: ExtensionContext): void {
		ctx.ui.setStatus("permission-mode", ctx.ui.theme.fg(color(mode), label(mode)));
	}

	function persist(): void {
		pi.appendEntry("permission-mode", { mode });
	}

	function setMode(next: Mode, ctx: ExtensionContext, announce = true): void {
		mode = next;
		updateStatus(ctx);
		persist();
		if (announce) {
			const help =
				next === "auto"
					? "Agent can act freely."
					: next === "accept-edit"
						? "Reads allowed; edits & mutating commands need approval."
						: "Every action needs approval.";
			ctx.ui.notify(`Permission mode: ${label(next)} — ${help}`, "info");
		}
	}

	function cycle(ctx: ExtensionContext): void {
		const idx = MODES.indexOf(mode);
		setMode(MODES[(idx + 1) % MODES.length], ctx);
	}

	// Human-readable summary of what a tool call will do (for the prompt).
	function summarize(toolName: string, input: Record<string, unknown>): string {
		if (toolName === "bash") return `$ ${String(input.command ?? "").slice(0, 200)}`;
		if (WRITE_TOOLS.has(toolName) || READ_TOOLS.has(toolName)) {
			const path = input.path ?? input.file ?? input.filename;
			if (path) return `${toolName}: ${String(path)}`;
		}
		return toolName;
	}

	// Ask the user to approve a single tool call.
	// Returns a block result if denied, or undefined to allow.
	async function requestApproval(
		ctx: ExtensionContext,
		toolName: string,
		summary: string,
	): Promise<{ block: true; reason: string } | undefined> {
		if (!ctx.hasUI) {
			// Non-interactive (print/JSON mode): can't ask, so deny to stay safe.
			return {
				block: true,
				reason: `Blocked: permission mode "${mode}" requires approval for "${toolName}", but no interactive UI is available.`,
			};
		}

		const choice = await ctx.ui.select(`Permission (${label(mode)}) — allow this action?\n${summary}`, [
			"Allow once",
			"Deny",
			"Allow all (switch to auto)",
		]);

		if (choice === "Allow once") return undefined;
		if (choice === "Allow all (switch to auto)") {
			setMode("auto", ctx);
			return undefined;
		}
		return {
			block: true,
			reason: `User denied "${toolName}" (permission mode: ${mode}). Do not retry; wait for further instructions.`,
		};
	}

	// Gate every tool call according to the active mode.
	pi.on("tool_call", async (event, ctx) => {
		if (mode === "auto") return; // unrestricted

		const toolName = event.toolName;
		const input = (event.input ?? {}) as Record<string, unknown>;
		const summary = summarize(toolName, input);

		if (mode === "manual") {
			return await requestApproval(ctx, toolName, summary);
		}

		// mode === "accept-edit": reads are free, mutations need approval.
		if (READ_TOOLS.has(toolName)) return;

		if (toolName === "bash") {
			const command = String(input.command ?? "");
			if (isSafeBash(command)) return; // read-only command
			return await requestApproval(ctx, toolName, summary);
		}

		if (WRITE_TOOLS.has(toolName)) {
			return await requestApproval(ctx, toolName, summary);
		}

		// Unknown / custom tools: be conservative and ask.
		return await requestApproval(ctx, toolName, summary);
	});

	// Toggle shortcut (default Shift+Tab).
	pi.registerShortcut(CYCLE_SHORTCUT, {
		description: "Cycle permission mode (auto → accept-edit → manual)",
		handler: async (ctx) => cycle(ctx),
	});

	// /mode command: open a picker.
	pi.registerCommand("mode", {
		description: "Set the permission mode (auto | accept-edit | manual)",
		handler: async (args, ctx) => {
			const requested = args.trim().toLowerCase();
			if (MODES.includes(requested as Mode)) {
				setMode(requested as Mode, ctx);
				return;
			}
			const choice = await ctx.ui.select("Select permission mode", [
				"auto — do anything without asking",
				"accept-edit — read freely, ask before edits",
				"manual — ask before every action",
			]);
			if (!choice) return;
			const picked = choice.split(" ")[0] as Mode;
			setMode(picked, ctx);
		},
	});

	// Initialize on session start; restore persisted mode if present.
	pi.on("session_start", async (_event, ctx) => {
		const flag = String(pi.getFlag("permission-mode") ?? "auto").toLowerCase();
		if (MODES.includes(flag as Mode)) mode = flag as Mode;

		const entries = ctx.sessionManager.getEntries();
		const last = entries
			.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "permission-mode")
			.pop() as { data?: { mode?: Mode } } | undefined;
		if (last?.data?.mode && MODES.includes(last.data.mode)) {
			mode = last.data.mode;
		}

		updateStatus(ctx);
	});
}
