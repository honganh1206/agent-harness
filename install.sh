#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
agent_dir=${PI_CODING_AGENT_DIR:-"$HOME/.pi/agent"}
skip_dependencies=false
if [ "${1:-}" = "--skip-dependencies" ]; then
    skip_dependencies=true
elif [ "$#" -ne 0 ]; then
    printf 'Usage: %s [--skip-dependencies]\n' "$0" >&2
    exit 2
fi

link_config() {
    source=$1
    destination=$2
    if [ -e "$destination" ] && [ ! -L "$destination" ]; then
        printf 'Refusing to replace non-symlink path: %s\n' "$destination" >&2
        return 1
    fi
    ln -sfn "$source" "$destination"
    printf 'Linked %s -> %s\n' "$destination" "$source"
}

mkdir -p "$HOME/.agents" "$HOME/.claude" "$agent_dir"
link_config "$repo_root/skills" "$HOME/.agents/skills"
link_config "$repo_root/skills" "$HOME/.claude/skills"
link_config "$repo_root/claude/hooks" "$HOME/.claude/hooks"
link_config "$repo_root/claude/settings.json" "$HOME/.claude/settings.json"
link_config "$repo_root/pi/agent/extensions" "$agent_dir/extensions"

REPO_ROOT=$repo_root AGENT_DIR=$agent_dir python3 - <<'PY'
import json
import os
from pathlib import Path

root = Path(os.environ["REPO_ROOT"])
path = Path(os.environ["AGENT_DIR"]) / "settings.json"
settings = json.loads(path.read_text()) if path.exists() else {}
settings["packages"] = [
    str(root / "pi/pi-packages/pi-mcp-adapter"),
    str(root / "pi/pi-packages/rpiv-mono/packages/rpiv-ask-user-question"),
    str(root / "pi/pi-packages/rpiv-mono/packages/rpiv-todo"),
    str(root / "pi/pi-packages/context-mode"),
]
path.write_text(json.dumps(settings, indent=2) + "\n")
PY

printf 'Updated %s/settings.json\n' "$agent_dir"

if [ "$skip_dependencies" = false ]; then
    command -v npm >/dev/null 2>&1 || { printf 'npm is required\n' >&2; exit 1; }
    command -v bun >/dev/null 2>&1 || { printf 'bun is required\n' >&2; exit 1; }
    npm ci --prefix "$repo_root/skills/dev-browser"
    npm ci --prefix "$repo_root/pi/agent/extensions/sandbox"
    npm ci --prefix "$repo_root/pi/pi-packages/pi-mcp-adapter"
    npm ci --prefix "$repo_root/pi/pi-packages/rpiv-mono"
    (cd "$repo_root/pi/pi-packages/context-mode" && bun install --frozen-lockfile)
fi
