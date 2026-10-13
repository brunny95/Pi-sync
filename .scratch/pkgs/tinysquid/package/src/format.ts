import type { Theme } from "@earendil-works/pi-coding-agent";

/** "3d 4h" / "1h 12m" / "42m" / "resets now". */
export function formatCountdown(
  resetsAt: string | null,
  now = Date.now(),
): string | null {
  if (!resetsAt) return null;
  const target = Date.parse(resetsAt);
  if (!Number.isFinite(target)) return null;
  const ms = target - now;
  if (ms <= 0) return "resets now";
  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function formatCountdownCompact(
  resetsAt: string | null,
  now = Date.now(),
): string | null {
  const countdown = formatCountdown(resetsAt, now);
  if (countdown === null || countdown === "resets now") return countdown;
  return countdown.replace(/\s+/g, "");
}

/** 42 → "42%", 0.7 → "0.7%", 62.5 → "62.5%". */
export function formatPercent(percent: number): string {
  const rounded = Math.round(percent * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}%` : `${rounded.toFixed(1)}%`;
}

export function bar(percent: number, width = 10): string {
  const clamped = Math.min(100, Math.max(0, percent));
  const filled = Math.round((clamped / 100) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

/** ANSI SGR escape sequence (foreground/background color resets). */
// no-control-regex bans the \x1b escape in a regex string, so build the ESC
// char at runtime instead.
const ANSI_SGR_RE = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*m`, "g");

/** Visible length of a string after stripping ANSI SGR escape sequences. */
export function visibleLength(text: string): number {
  return text.replace(ANSI_SGR_RE, "").length;
}

/** Pad `text` with trailing spaces so its visible width equals `width`. */
export function padVisible(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleLength(text)));
}

// ctx.ui.theme exists at runtime but is not in the type defs (checked at 0.86.1).
export function uiTheme(ui: unknown): Theme | undefined {
  return (ui as { theme?: Theme }).theme;
}

export function colorPercent(
  theme: Theme | undefined,
  percent: number,
  text: string,
): string {
  if (!theme) return text;
  if (percent >= 90) return theme.fg("error", text);
  if (percent >= 70) return theme.fg("warning", text);
  return theme.fg("dim", text);
}
