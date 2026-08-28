# pi-config

Mirror of my [`pi`](https://pi.dev) configuration across machines, using a git
repo as the single source of truth. Most paths under `~/.pi/agent/` are
symlinks into this repo, so editing config = editing repo files. The exception
is `settings.json`, which is **generated** from a shared file plus a
per-machine file (see below).

## What's tracked
- `agent/APPEND_SYSTEM.md` — custom system prompt
- `agent/keybindings.json`
- `agent/settings.json` — **shared** settings (`theme`, `packages`, `hideThinkingBlock`, ...)
- `agent/settings.local.<hostname>.json` — **per-machine** settings (`defaultProvider`, `defaultModel`, `defaultThinkingLevel`, `lastChangelogVersion`)
- `agent/settings.local.example.json` — template for new machines
- `agent/npm/{package.json,package-lock.json}` — extension deps
- `agent/extensions/<name>/` — custom extensions
- `agent/skills/<name>/` — skills (if any)

`sync.sh` merges `agent/settings.json` + `agent/settings.local.<hostname>.json`
into the live `~/.pi/agent/settings.json`. That keeps shared config (like the
`packages` list) in sync while letting each machine keep its own default
model/provider.

## Not tracked (local only, see `.gitignore`)
`auth.json` (secrets), `models-store.json` (cache), `bin/`, `npm/node_modules/`,
`sessions/`.

## Usage
```bash
./sync.sh               # merge settings + link + commit leftovers + pull + npm + push
./sync.sh --adopt NAME  # pull a live extension into the repo, then link it
```

### New machine
```bash
git clone <this-repo> ~/pi-config
~/pi-config/sync.sh     # creates settings.local.<hostname>.json from the example
# edit ~/pi-config/agent/settings.local.<hostname>.json to set this machine's
# default provider/model, then run ~/pi-config/sync.sh again
# start pi, log in once (creates local auth.json)
```

### New extension
Create it in `~/pi-config/agent/extensions/<name>/`, then `./sync.sh`.

### Change this machine's default model
Use `/model` in pi, or edit `agent/settings.local.<hostname>.json`, then run
`./sync.sh`. This never affects the other machine.

### Conflict
`sync.sh` stops. Resolve in `~/pi-config`, `git rebase --continue`, re-run `./sync.sh`.
