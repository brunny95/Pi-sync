import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { ensureConfigFile, loadConfig, DEFAULT_CONFIG } from "./config.ts";
import { createSubcommandAutocompleteInstaller } from "./autocomplete.ts";
import {
  registerOpencodeGoCommand,
  SUBCOMMANDS,
  type UiRef,
} from "./commands.ts";
import { renderFooter } from "./footer.ts";
import { PERIODS } from "./periods.ts";
import { UsageStore } from "./state.ts";

/**
 * Composition root: create the store, wire the command and session events,
 * and keep the footer in sync with store changes. All feature logic lives in
 * the modules under src/.
 */
export default function opencodeGoUsage(pi: ExtensionAPI): void {
  const store = new UsageStore({
    ...DEFAULT_CONFIG,
    footerPeriods: [...PERIODS],
  });
  const uiRef: UiRef = { ui: null };
  const installAutocomplete = createSubcommandAutocompleteInstaller(
    "opencode-go",
    () =>
      SUBCOMMANDS.map((s) => ({
        value: s.value,
        description: s.description,
      })),
  );

  // Any store mutation re-renders the extension status line.
  store.subscribe(() => renderFooter(store, uiRef.ui ?? undefined));

  registerOpencodeGoCommand(pi, store, uiRef);

  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    uiRef.ui = ctx.ui;

    installAutocomplete(ctx);

    store.setConfig(await loadConfig());
    await ensureConfigFile();

    // instant hint / previous state; fetch updates it
    renderFooter(store, ctx.ui);

    store.startTimer();

    // initial pull as fire-and-forget to be non-blocking.
    void store.refresh();
  });

  pi.on("turn_end", async () => {
    // we want to keep the store in-sync with usage.
    void store.refresh();
  });

  pi.on("session_shutdown", () => {
    store.stopTimer();
  });
}
