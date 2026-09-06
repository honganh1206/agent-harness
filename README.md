# Agent configuration

Shared agent skills and Pi configuration.

## Linux

Install Node.js 22 or later, npm, and Bun. Clone with submodules, then run the installer:

```sh
git clone --recurse-submodules git@github.com:honganh1206/agent-skills.git "$HOME/projects/agent-skills"
"$HOME/projects/agent-skills/install.sh"
```

The installer links:

- `~/.agents/skills` to `skills/`
- `~/.claude/skills` to `skills/`
- `~/.claude/hooks` and `~/.claude/settings.json` to `claude/`
- `~/.pi/agent/extensions` to `pi/agent/extensions/`

By default, it installs package dependencies. Use `install.sh --skip-dependencies` only when they are already installed. It also merges the absolute local package paths into `~/.pi/agent/settings.json` without changing other Pi preferences. Authentication, trust data, sessions, caches, and browser profiles stay local and are not version-controlled.

## Windows

Run `pi/bootstrap-windows.ps1` from PowerShell. See [`pi/README.md`](pi/README.md).
