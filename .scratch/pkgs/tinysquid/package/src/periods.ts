/** One of the three usage windows on the OpenCode Go plan. */
export const PERIODS = ["5h", "weekly", "monthly"] as const;
export type Period = (typeof PERIODS)[number];

/** Accept user input for a period: canonical names plus common aliases. */
export const PERIOD_ALIASES: Record<string, Period> = {
  "5h": "5h",
  "5hr": "5h",
  rolling: "5h",
  weekly: "weekly",
  wk: "weekly",
  week: "weekly",
  monthly: "monthly",
  mo: "monthly",
  month: "monthly",
};

export const PERIOD_LABEL: Record<Period, string> = {
  "5h": "Rolling 5h",
  weekly: "Weekly",
  monthly: "Monthly",
};

export const PERIOD_SHORT: Record<Period, string> = {
  "5h": "5h",
  weekly: "wk",
  monthly: "mo",
};

/** Map comma-separated user tokens to periods; returns the unknown tokens. */
export function parsePeriodList(spec: string): {
  periods: Period[];
  unknown: string[];
} {
  const mapped: Period[] = [];
  const unknown: string[] = [];
  for (const token of spec
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean)) {
    const period = PERIOD_ALIASES[token];
    if (period) {
      if (!mapped.includes(period)) mapped.push(period);
    } else {
      unknown.push(token);
    }
  }
  return { periods: PERIODS.filter((p) => mapped.includes(p)), unknown };
}

/**
 * pi replaces the ENTIRE argument prefix with `value`, so value completions
 * must carry the full argument text (subcommand included), like the built-in
 * /model and /thinking commands do.
 */
export function completeSubcommandValues(
  sub: string,
  argumentPrefix: string,
): { value: string; label: string }[] {
  const trailingSpace = /\s$/.test(argumentPrefix);
  const parts = argumentPrefix.trim().split(/\s+/).filter(Boolean);
  const last = parts[parts.length - 1] ?? "";
  const prefix = trailingSpace || parts.length < 2 ? "" : last;

  let values: string[] = [];
  if (sub === "footer" || sub === "footer-reset-timer") values = ["on", "off"];
  if (sub === "footer-stats")
    values = ["5h", "weekly", "monthly", "all", "clear"];
  return values
    .filter((value) => value.startsWith(prefix))
    .map((value) => ({ value: `${sub} ${value}`, label: value }));
}
