import type {
  ExtensionCommandContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { configPath } from "./config.ts";
import {
  bar,
  colorPercent,
  formatCountdown,
  formatPercent,
  padVisible,
} from "./format.ts";
import { PERIOD_LABEL } from "./periods.ts";
import type { UsageStore } from "./state.ts";

const WIDGET_KEY = "opencode-go";

/** Build the usage table shown by /opencode-go usage. */
export function tableLines(
  store: UsageStore,
  theme: Theme | undefined,
): string[] {
  const creds = store.credentials;
  const title = `OpenCode Go Usage${creds ? ` (${creds.workspaceId})` : ""}`;
  const lines: string[] = [theme ? theme.fg("accent", title) : title];

  if (!creds) {
    lines.push("Not configured. Set up with:");
    lines.push("  /opencode-go workspace-id <wrk_… or dashboard URL>");
    lines.push(
      "  /opencode-go session-cookie (prompts; keeps the cookie out of session history)",
    );
    lines.push(
      "Or export OPENCODE_GO_WORKSPACE_ID and OPENCODE_GO_SESSION_COOKIE.",
    );
    lines.push("/opencode-go close hides this panel");
    return lines;
  }

  const meters = store.usage;
  if (meters.length === 0) {
    const lastError = store.error;
    lines.push(lastError ? `Error: ${lastError}` : "Loading…");
    lines.push("/opencode-go close hides this panel");
    return lines;
  }

  const headers = ["Window", "Usage", "Resets in"];
  const rows = meters.map((meter) => {
    const label = PERIOD_LABEL[meter.period];
    const percent = formatPercent(meter.percent);
    const usage = `${bar(meter.percent)} ${percent}`;
    const usageColored = `${bar(meter.percent)} ${colorPercent(theme, meter.percent, percent)}`;
    const resets = formatCountdown(meter.resetsAt) ?? "—";
    return { label, usage, usageColored, resets };
  });

  const widths = [
    Math.max(headers[0].length, ...rows.map((r) => r.label.length)),
    Math.max(headers[1].length, ...rows.map((r) => r.usage.length)),
    Math.max(headers[2].length, ...rows.map((r) => r.resets.length)),
  ];
  const border = `+${widths.map((w) => "-".repeat(w + 2)).join("+")}+`;
  const headerCells = headers.map((h, i) => padVisible(h, widths[i]));

  lines.push(border);
  lines.push(`| ${headerCells.join(" | ")} |`);
  lines.push(border);
  for (const row of rows) {
    const cells = [row.label, row.usageColored, row.resets].map((cell, i) =>
      padVisible(cell, widths[i]),
    );
    lines.push(`| ${cells.join(" | ")} |`);
  }
  lines.push(border);
  if (store.error) lines.push(`Stale: ${store.error}`);
  lines.push("/opencode-go close hides this panel");
  return lines;
}

/** Build the /opencode-go help panel: commands + current config status. */
export function helpLines(
  store: UsageStore,
  theme: Theme | undefined,
): string[] {
  const config = store.current;
  const creds = store.credentials;
  const dim = (text: string) => (theme ? theme.fg("dim", text) : text);
  const status = [
    creds ? `connected to ${creds.workspaceId}` : "not configured",
    `footer ${config.footerEnabled ? "on" : "off"}`,
    config.footerPeriods.length > 0
      ? config.footerPeriods.join("/")
      : "no periods",
    `reset timer ${config.footerCountdowns ? "on" : "off"}`,
    `refresh ${config.refreshMinutes}m`,
  ].join(" · ");
  const commands: [cmd: string, args: string, description: string][] = [
    ["usage", "", "show the usage table (default)"],
    ["workspace-id", "<id|url>", "set the workspace id"],
    ["session-cookie", "[value]", "set the session cookie (no arg = prompt)"],
    ["footer", "<on|off>", "footer status line visibility"],
    [
      "footer-stats",
      "<list>",
      "footer periods: 5h, weekly, monthly, all, clear",
    ],
    ["footer-reset-timer", "<on|off>", "reset countdown timer in the footer"],
    ["refresh-interval", "<1-60>", "background refresh TTL (minutes)"],
    ["disconnect", "", "forget workspace id + cookie"],
    ["close", "", "hide this panel"],
    ["help", "", "show commands + current config"],
  ];
  const commandWidth = Math.max(
    ...commands.map(([cmd, args]) => (args ? `${cmd} ${args}` : cmd).length),
  );
  return [
    theme
      ? theme.fg("accent", "OpenCode Go: commands")
      : "OpenCode Go: commands",
    ...commands.map(([cmd, args, description]) => {
      const left = args ? `${cmd} ${args}` : cmd;
      return `  ${left.padEnd(commandWidth)}  ${description}`;
    }),
    dim(`Status: ${status}`),
    dim(`Config: ${configPath()}`),
    dim("Env overrides: OPENCODE_GO_WORKSPACE_ID, OPENCODE_GO_SESSION_COOKIE"),
    "/opencode-go close hides this panel",
  ];
}

/** Show a panel above the editor, or print it in headless mode. */
export function showPanel(lines: string[], ctx: ExtensionCommandContext): void {
  if (!ctx.hasUI) {
    console.log(lines.join("\n"));
    return;
  }
  if (ctx.mode === "tui") {
    // String-array widgets are capped at 10 lines in the interactive TUI;
    // render through the component factory so long panels (help) show fully.
    ctx.ui.setWidget(
      WIDGET_KEY,
      () => ({
        invalidate() {},
        render() {
          return lines;
        },
      }),
      { placement: "aboveEditor" },
    );
  } else {
    // RPC mode supports string arrays only and ignores factory functions.
    ctx.ui.setWidget(WIDGET_KEY, lines, { placement: "aboveEditor" });
  }
}

/** Hide the panel. */
export function closePanel(ctx: ExtensionCommandContext): void {
  if (ctx.hasUI) ctx.ui.setWidget(WIDGET_KEY, undefined);
}
