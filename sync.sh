#!/usr/bin/env bash
# Mirror pi config via git + symlinks. Idempotent all-rounder.
#   ./sync.sh               link -> commit leftovers -> pull -> npm -> push
#   ./sync.sh --adopt NAME  move a live extension into the repo, then link it
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Windows (Git Bash/MSYS): HOME may be redirected, but pi reads %USERPROFILE%\.pi\agent.
IS_WIN=0
case "$(uname -s 2>/dev/null)" in MINGW*|MSYS*|CYGWIN*) IS_WIN=1 ;; esac
if [ "$IS_WIN" = 1 ]; then
  export MSYS=winsymlinks:nativestrict   # real symlinks or fail (never silent copies)
  TARGET="$(cygpath -u "${USERPROFILE:-$HOME}")/.pi/agent"
else
  TARGET="$HOME/.pi/agent"
fi
STAMP="$(date +%Y%m%d-%H%M%S)"
HOST="$(hostname -s 2>/dev/null || hostname)"

say() { printf '%s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
has_remote()   { git -C "$REPO_DIR" remote get-url origin >/dev/null 2>&1; }
has_upstream() { git -C "$REPO_DIR" rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; }

# Create dst -> src. On Windows without Developer Mode/admin, symlinks are
# refused, so fall back to a junction (dirs) or hard link (files); both need
# no privileges and are recognised by `-ef` below.
make_link() {
  local src="$1" dst="$2"
  ln -s "$src" "$dst" 2>/dev/null && return 0
  [ "$IS_WIN" = 1 ] || { ln -s "$src" "$dst"; return; }
  if [ -d "$src" ]; then
    cmd.exe //c mklink //J "$(cygpath -w "$dst")" "$(cygpath -w "$src")" >/dev/null
  else
    cmd.exe //c mklink //H "$(cygpath -w "$dst")" "$(cygpath -w "$src")" >/dev/null
  fi
}

link() {
  local src="$1" dst="$2"
  [ -e "$src" ] || return 0
  mkdir -p "$(dirname "$dst")"
  if [ "$dst" -ef "$src" ]; then
    return 0
  fi
  if [ -f "$dst" ] && [ ! -L "$dst" ] && [ -f "$src" ] && cmp -s "$src" "$dst"; then
    rm -f "$dst"          # identical stale copy/broken hard link: no backup needed
  elif [ -e "$dst" ] || [ -L "$dst" ]; then
    mv "$dst" "$dst.bak.$STAMP"
    say "backed up  $dst -> $dst.bak.$STAMP"
  fi
  make_link "$src" "$dst" || die "cannot link $dst -> $src"
  say "linked     $dst -> $src"
}

ensure_links() {
  link "$REPO_DIR/agent/APPEND_SYSTEM.md"      "$TARGET/APPEND_SYSTEM.md"
  link "$REPO_DIR/agent/keybindings.json"      "$TARGET/keybindings.json"
  link "$REPO_DIR/agent/npm/package.json"      "$TARGET/npm/package.json"
  link "$REPO_DIR/agent/npm/package-lock.json" "$TARGET/npm/package-lock.json"
  local base d name
  for base in extensions skills; do
    [ -d "$REPO_DIR/agent/$base" ] || continue
    for d in "$REPO_DIR/agent/$base"/*/; do
      [ -d "$d" ] || continue
      name="$(basename "$d")"
      link "${d%/}" "$TARGET/$base/$name"
    done
  done
}

adopt() {
  local name="$1"
  local live="$TARGET/extensions/$name"
  local dest="$REPO_DIR/agent/extensions/$name"
  [ -d "$live" ]  || die "no live extension at $live"
  [ -L "$live" ]  && die "$live is already a symlink (already managed)"
  [ -e "$dest" ]  && die "$dest already exists in the repo"
  mkdir -p "$REPO_DIR/agent/extensions"
  mv "$live" "$dest"
  say "adopted    $name into repo"
  link "$dest" "$live"
}

adopt_live_settings() {
  # Fold settings pi wrote directly into the live file (e.g. /model or
  # `pi install`) back into their homes: machine keys -> settings.local.<host>.json,
  # everything else -> the shared settings.json tracked in this repo.
  local shared="$REPO_DIR/agent/settings.json"
  local local_f="$REPO_DIR/agent/settings.local.$HOST.json"
  local live="$TARGET/settings.json"
  [ -f "$shared" ] || return 0
  [ -f "$live" ] || return 0
  [ -L "$live" ] && return 0
  python3 - "$shared" "$local_f" "$live" <<'PY'
import json, sys
MACHINE_KEYS = ("defaultProvider", "defaultModel", "defaultThinkingLevel", "lastChangelogVersion")
shared_path, local_path, live_path = sys.argv[1], sys.argv[2], sys.argv[3]

def load(p):
    try:
        with open(p) as f:
            return json.load(f)
    except Exception:
        return {}

def dump(p, obj):
    with open(p, "w") as f:
        json.dump(obj, f, indent=2)
        f.write("\n")

shared = load(shared_path)
local = load(local_path)
live = load(live_path)

local_changed = False
for k in MACHINE_KEYS:
    if k in live and live[k] != local.get(k):
        local[k] = live[k]
        local_changed = True

shared_changed = False
for k, v in live.items():
    if k not in MACHINE_KEYS and shared.get(k) != v:
        shared[k] = v
        shared_changed = True

if local_changed:
    dump(local_path, local)
    print("adopted    machine settings -> %s" % local_path)
if shared_changed:
    dump(shared_path, shared)
    print("adopted    shared settings  -> %s" % shared_path)
PY
}

generate_settings() {
  # Build the live ~/.pi/agent/settings.json from the shared repo file plus
  # this machine's local defaults.
  local shared="$REPO_DIR/agent/settings.json"
  local local_f="$REPO_DIR/agent/settings.local.$HOST.json"
  local example="$REPO_DIR/agent/settings.local.example.json"
  local live="$TARGET/settings.json"
  [ -f "$shared" ] || return 0
  if [ ! -f "$local_f" ]; then
    if [ -f "$example" ]; then
      cp "$example" "$local_f"
      say "created    $local_f (from example; edit for this machine)"
    else
      printf '{}\n' > "$local_f"
      say "created    $local_f (empty)"
    fi
  fi
  if [ -L "$live" ]; then
    mv "$live" "$live.bak.$STAMP"
    say "backed up  $live -> $live.bak.$STAMP"
  fi
  python3 - "$shared" "$local_f" "$live" <<'PY'
import json, sys
shared_path, local_path, live_path = sys.argv[1], sys.argv[2], sys.argv[3]

def load(p):
    try:
        with open(p) as f:
            return json.load(f)
    except Exception:
        return {}

shared = load(shared_path)
local = load(local_path)
merged = {**shared, **local}
with open(live_path, "w") as f:
    json.dump(merged, f, indent=2)
    f.write("\n")
PY
  say "merged     $live <- $shared + $local_f"
}

npm_install_if_needed() {
  local pre="$1" post="$2" need=0
  [ -d "$TARGET/npm/node_modules" ] || need=1
  [ "$need" = 1 ] || ( cd "$TARGET/npm" && npm ls --depth=0 >/dev/null 2>&1 ) || need=1   # declared deps missing
  if [ -n "$pre" ] && [ "$pre" != "$post" ]; then
    git -C "$REPO_DIR" diff --name-only "$pre" "$post" -- agent/npm/ | grep -q . && need=1
  fi
  if [ "$need" = 1 ]; then
    say "npm install..."
    ( cd "$TARGET/npm" && npm install )
  fi
}

# ---- main ----
case "${1:-}" in
  --adopt) [ -n "${2:-}" ] || die "usage: $0 --adopt <extension-name>"; adopt "$2" ;;
  "")      : ;;
  *)       die "unknown option: $1" ;;
esac

ensure_links
adopt_live_settings
generate_settings

cd "$REPO_DIR" || die "cannot cd to $REPO_DIR"
[ -d .git ] || die "$REPO_DIR is not a git repo (clone or init first)"

# hybrid commit: sweep up whatever is still uncommitted
if ! git diff --quiet || ! git diff --cached --quiet || \
   [ -n "$(git ls-files --others --exclude-standard)" ]; then
  git add -A
  git commit -m "sync: $HOST $STAMP" >/dev/null
  say "committed  local changes ($HOST $STAMP)"
fi

PRE="$(git rev-parse HEAD 2>/dev/null || true)"
if has_remote && has_upstream; then
  git pull --rebase --autostash \
    || die "pull/rebase conflict. Fix in $REPO_DIR, then: git rebase --continue"
fi
POST="$(git rev-parse HEAD 2>/dev/null || true)"

ensure_links                       # link anything new the pull brought in
generate_settings                  # rebuild live settings after pull
npm_install_if_needed "$PRE" "$POST"

if has_remote; then
  if has_upstream; then
    if [ -n "$(git rev-list '@{u}..HEAD' 2>/dev/null)" ]; then
      git push || die "push failed. Check credentials/network, then re-run."
      say "pushed"
    fi
  else
    git push -u origin "$(git symbolic-ref --short HEAD)" \
      || die "push failed (setting upstream). Check credentials/network, then re-run."
    say "pushed (upstream set)"
  fi
fi

say "sync complete."
