/**
 * split-fork (tmux edition)
 *
 * Forks the current pi session into a NEW pi process running in a new tmux
 * pane (split to the right). The fork copies the current session branch into a
 * fresh session file, so the new pane starts with the same context but evolves
 * independently.
 *
 * Requires: running inside a tmux session.
 * Original macOS/Ghostty version by mitsuhiko; this is a Linux/tmux adaptation.
 *
 * Usage: /split-fork [optional prompt to send in the new pane]
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { existsSync, promises as fs } from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

function shellQuote(value: string): string {
	if (value.length === 0) return "''";
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function getPiInvocationParts(): string[] {
	const currentScript = process.argv[1];
	if (currentScript && existsSync(currentScript)) {
		return [process.execPath, currentScript];
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return [process.execPath];
	}

	return ["pi"];
}

function buildPiCommand(sessionFile: string | undefined, prompt: string): string {
	const commandParts = [...getPiInvocationParts()];

	if (sessionFile) {
		commandParts.push("--session", sessionFile);
	}

	if (prompt.length > 0) {
		commandParts.push("--", prompt);
	}

	return commandParts.map(shellQuote).join(" ");
}

async function createForkedSession(ctx: ExtensionCommandContext): Promise<string | undefined> {
	const sessionFile = ctx.sessionManager.getSessionFile();
	if (!sessionFile) {
		return undefined;
	}

	const sessionDir = path.dirname(sessionFile);
	const branchEntries = ctx.sessionManager.getBranch();
	const currentHeader = ctx.sessionManager.getHeader();

	const timestamp = new Date().toISOString();
	const fileTimestamp = timestamp.replace(/[:.]/g, "-");
	const newSessionId = randomUUID();
	const newSessionFile = path.join(sessionDir, `${fileTimestamp}_${newSessionId}.jsonl`);

	const newHeader = {
		type: "session",
		version: currentHeader?.version ?? 3,
		id: newSessionId,
		timestamp,
		cwd: currentHeader?.cwd ?? ctx.cwd,
		parentSession: sessionFile,
	};

	const lines = [JSON.stringify(newHeader), ...branchEntries.map((entry) => JSON.stringify(entry))].join("\n") + "\n";

	await fs.mkdir(sessionDir, { recursive: true });
	await fs.writeFile(newSessionFile, lines, "utf8");

	return newSessionFile;
}

export default function (pi: ExtensionAPI): void {
	pi.registerCommand("split-fork", {
		description: "Fork this session into a new pi process in a right-hand tmux pane. Usage: /split-fork [optional prompt]",
		handler: async (args, ctx) => {
			if (!process.env.TMUX) {
				ctx.ui.notify("/split-fork requires running inside a tmux session.", "warning");
				return;
			}

			const wasBusy = !ctx.isIdle();
			const prompt = args.trim();
			const forkedSessionFile = await createForkedSession(ctx);
			const piCommand = buildPiCommand(forkedSessionFile, prompt);

			// Keep the pane alive if pi exits, so errors stay visible.
			const paneCommand = `${piCommand}; ec=$?; if [ "$ec" -ne 0 ]; then echo; echo "[pi exited with code $ec — press enter to close]"; read _; fi`;

			const result = await pi.exec("tmux", [
				"split-window",
				"-h", // split to the right
				"-c",
				ctx.cwd,
				paneCommand,
			]);

			if (result.code !== 0) {
				const reason = result.stderr?.trim() || result.stdout?.trim() || "unknown tmux error";
				ctx.ui.notify(`Failed to open tmux split: ${reason}`, "error");
				if (forkedSessionFile) {
					ctx.ui.notify(`Forked session was created: ${forkedSessionFile}`, "info");
				}
				return;
			}

			if (forkedSessionFile) {
				const fileName = path.basename(forkedSessionFile);
				const suffix = prompt ? " and sent prompt" : "";
				ctx.ui.notify(`Forked to ${fileName} in a new tmux pane${suffix}.`, "info");
				if (wasBusy) {
					ctx.ui.notify("Forked from current committed state (in-flight turn continues in original session).", "info");
				}
			} else {
				ctx.ui.notify("Opened a new tmux pane (no persisted session to fork).", "warning");
			}
		},
	});
}
