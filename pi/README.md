# Pi configuration

This directory stores the Pi configuration source for this agent configuration repository.
Pi does not load `pi/settings.json` directly.

## Windows installation

1. Install Node.js 22 or later, npm, Bun, Git, and Pi.
2. Clone this repository with its submodules.
3. Run the bootstrap script from PowerShell.

```powershell
git clone --recurse-submodules <repository-url> "$HOME\projects\agent-skills"
& "$HOME\projects\agent-skills\pi\bootstrap-windows.ps1"
```

If the repository already exists, update its submodules first.

```powershell
git -C "$HOME\projects\agent-skills" submodule update --init --recursive
& "$HOME\projects\agent-skills\pi\bootstrap-windows.ps1"
```

The script creates these global Pi paths:

- `%USERPROFILE%\.pi\agent\settings.json`
- `%USERPROFILE%\.pi\agent\extensions`
- `%USERPROFILE%\.agents\skills`

It writes absolute paths for the local Pi packages.
It creates junctions for extensions and skills.
It installs package dependencies, including the sandbox extension runtime, unless you specify `-SkipDependencies`.

The sandbox extension is version-controlled at `pi/agent/extensions/sandbox`. The global Pi extensions path is linked to `pi/agent/extensions`, so Pi auto-discovers it. On Linux, the sandbox also requires `bubblewrap`, `socat`, and `ripgrep`.

Use `-SkipDependencies` only when the package dependencies already exist.

```powershell
& "$HOME\projects\agent-skills\pi\bootstrap-windows.ps1" -SkipDependencies
```

The script will not replace a normal directory or file with a junction.
Remove or move that path before you run the script again.

Restart Pi after the script completes.
Then use `/login` or `/settings` to configure your provider.
