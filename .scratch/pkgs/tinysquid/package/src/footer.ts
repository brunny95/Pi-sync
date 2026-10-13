import type {
  ExtensionUIContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  colorPercent,
  formatCountdownCompact,
  formatPercent,
  uiTheme,
} from "./format.ts";
import { PERIOD_SHORT } from "./periods.ts";
import type { UsageStore } from "./state.ts";

const STATUS_KEY = "opencode-go";

/** Build the footer status line text, or undefined to hide the line. */
export function footerText(
  store: UsageStore,
  theme: Theme | undefined,
): string | undefined {
  const config = store.current;
  const dim = (text: string) => (theme ? theme.fg("dim", text) : text);
  if (!config.footerEnabled) return undefined;
  if (!store.credentials)
    return dim("OpenCode Go: not configured · /opencode-go help");
  const meters = store.usage;
  if (meters.length === 0) {
    const lastError = store.error;
    if (lastError)
      return theme
        ? theme.fg("warning", `OpenCode Go: ${lastError}`)
        : `OpenCode Go: ${lastError}`;
    return dim("OpenCode Go: loading…");
  }
  if (config.footerPeriods.length === 0) return undefined;

  const byPeriod = new Map(meters.map((m) => [m.period, m]));
  const parts: string[] = [];
  for (const period of config.footerPeriods) {
    const meter = byPeriod.get(period);
    if (!meter) continue;
    let part = `${dim(PERIOD_SHORT[period])} ${colorPercent(theme, meter.percent, formatPercent(meter.percent))}`;
    if (config.footerCountdowns) {
      const countdown = formatCountdownCompact(meter.resetsAt);
      if (countdown) part += dim(` (${countdown})`);
    }
    parts.push(part);
  }
  if (parts.length === 0) return dim("OpenCode Go: (no usage data)");
  let text = `${dim("OpenCode Go")} ${parts.join(dim(" · "))}`;
  if (store.error) text += dim(" · stale");
  return text;
}

/** Re-render the extension status line on the built-in footer. */
export function renderFooter(
  store: UsageStore,
  ui: ExtensionUIContext | undefined,
): void {
  if (!ui) return;
  ui.setStatus(STATUS_KEY, footerText(store, uiTheme(ui)));
}
