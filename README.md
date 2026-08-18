# pi-config

Mirror of my [`pi`](https://pi.dev) configuration across machines, using a git
repo as the single source of truth. Selected paths under `~/.pi/agent/` are
symlinks into this repo, so editing config = editing repo files.

## What's tracked
- `agent/APPEND_SYSTEM.md` — custom system prompt
- `agent/settings.json`, `agent/keybindings.json`
- `agent/npm/{package.json,package-lock.json}` — extension deps
- `agent/extensions/<name>/` — custom extensions
- `agent/skills/<name>/` — skills (if any)

## Not tracked (local only, see `.gitignore`)
`auth.json` (secrets), `models-store.json` (cache), `bin/`, `npm/node_modules/`,
`sessions/`.

## Usage
```bash
./sync.sh               # link + commit leftovers + pull + npm install + push
./sync.sh --adopt NAME  # pull a live extension into the repo, then link it
```

### New machine
```bash
git clone <this-repo> ~/pi-config
~/pi-config/sync.sh     # links config, runs npm install
# start pi, log in once (creates local auth.json)
```

### New extension
Create it in `~/pi-config/agent/extensions/<name>/`, then `./sync.sh`.

### Conflict
`sync.sh` stops. Resolve in `~/pi-config`, `git rebase --continue`, re-run `./sync.sh`.
