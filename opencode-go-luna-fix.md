# Fix: `gpt-5.6-luna` missing from `opencode-go` in pi

**Date:** 2026-08-20
**Commit:** `d1d9283` in `~/Scripts/Pi-sync`

## Symptom

`/model` in pi showed no Luna for the OpenCode Go subscription. `opencode-go`
listed only 7 models: `glm-5`, `glm-5.1`, `kimi-k2.5`, `mimo-v2-pro`,
`mimo-v2-omni`, `qwen3.5-plus`, `qwen3.6-plus`.

## Root cause

`opencode-go` was provided by the third-party extension
[`awtotty/pi-opencode`](https://github.com/awtotty/pi-opencode), installed as a
git package in `settings.json`:

```json
"packages": [
  "npm:@gotgenes/pi-anthropic-auth",
  "npm:pi-caveman",
  "git:https://github.com/awtotty/pi-opencode.git"
]
```

The extension hardcodes its own model lists (`src/index.ts`,
`GO_OPENAI_MODELS` for Go). pi's provider composition
(`provider-composer.js`, `applyExtension`) **replaces** the entire built-in
catalog when an extension provides a `models` array, so the extension's stale
7-model list shadowed pi's maintained `opencode-go` catalog.

Meanwhile, the subscription itself **did** expose Luna: querying
`https://opencode.ai/zen/go/v1/models` with the API key returned
`gpt-5.6-luna`, and pi's built-in `opencode-go` catalog already contained it
with full metadata (openai-responses API, 2x-usage pricing, 1.05M context).

## Fix applied

1. Edited `~/Scripts/Pi-sync/agent/settings.json` (symlinked from
   `~/.pi/agent/settings.json`): removed the
   `git:https://github.com/awtotty/pi-opencode.git` package entry.
2. Committed the change in the Pi-sync repo (`d1d9283`).
3. Verified with `pi --list-models`.

## Result

- Extension-only providers removed: `opencode-zen`, `opencode-zen-anthropic`,
  `opencode-go-anthropic`.
- Built-in providers remain, maintained by the pi team + pi.dev remote catalog:
  - `opencode` (OpenCode Zen, credit-based) — full model list
  - `opencode-go` (OpenCode Go, subscription) — now 20 models including
    `gpt-5.6-luna` (1.1M context, 128K max output, thinking, images)
- `gpt-5.6-luna` on Go consumes 2x subscription credits (built-in catalog).

## Notes

- `models.json` would not have worked as a fix: an extension `models` array
  overrides custom models too.
- Pre-existing uncommitted change `agent/npm/package-lock.json` left untouched
  (unrelated to this fix).
- Push/sync to other machines: `~/Scripts/Pi-sync/sync.sh` or `git push`.
- In a running pi session, reopen `/model`; restart pi if the list is cached.
