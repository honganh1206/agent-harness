[CmdletBinding()]
param(
    [string]$RepositoryRoot = (Split-Path -Parent $PSScriptRoot),
    [switch]$SkipDependencies
)

$ErrorActionPreference = 'Stop'

function Assert-Command {
    param([string]$Name, [string]$Purpose)

    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "'$Name' is required to $Purpose. Install it, restart PowerShell, and run this script again."
    }
}

function Invoke-External {
    param([string]$File, [string[]]$Arguments)

    & $File @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed with exit code ${LASTEXITCODE}: $File $($Arguments -join ' ')"
    }
}

function Set-Junction {
    param([string]$Path, [string]$Target)

    if (Test-Path -LiteralPath $Path) {
        $item = Get-Item -LiteralPath $Path -Force
        if ($item.LinkType -ne 'Junction') {
            throw "Refusing to replace existing non-junction path: $Path"
        }
        Remove-Item -LiteralPath $Path -Force
    }

    New-Item -ItemType Junction -Path $Path -Target $Target | Out-Null
    Write-Host "Linked $Path -> $Target"
}

Assert-Command -Name 'pi' -Purpose 'configure Pi'
Assert-Command -Name 'git' -Purpose 'verify the agent configuration submodules'

$RepositoryRoot = (Resolve-Path -LiteralPath $RepositoryRoot).Path
$piRoot = Join-Path $RepositoryRoot 'pi'
$packageRoot = Join-Path $piRoot 'pi-packages'
$extensionSource = Join-Path $piRoot 'agent\extensions'
$skillSource = Join-Path $RepositoryRoot 'skills'

$packagePaths = @(
    (Join-Path $packageRoot 'pi-mcp-adapter'),
    (Join-Path $packageRoot 'rpiv-mono\packages\rpiv-ask-user-question'),
    (Join-Path $packageRoot 'rpiv-mono\packages\rpiv-todo'),
    (Join-Path $packageRoot 'context-mode')
)

$requiredPaths = @($piRoot, $packageRoot, $extensionSource, $skillSource) + $packagePaths
$requiredPaths | ForEach-Object {
    if (-not (Test-Path -LiteralPath $_)) {
        throw "Missing required path: $_`nClone the repository with --recurse-submodules, then run: git -C '$RepositoryRoot' submodule update --init --recursive"
    }
}

$submoduleStatus = git -C $RepositoryRoot submodule status --recursive
if ($LASTEXITCODE -ne 0 -or ($submoduleStatus | Where-Object { $_ -match '^-' })) {
    throw "Pi package submodules are not ready. Run: git -C '$RepositoryRoot' submodule update --init --recursive"
}

$piAgent = Join-Path $HOME '.pi\agent'
$agentsRoot = Join-Path $HOME '.agents'
New-Item -ItemType Directory -Force -Path $piAgent, $agentsRoot | Out-Null

Set-Junction -Path (Join-Path $piAgent 'extensions') -Target $extensionSource
Set-Junction -Path (Join-Path $agentsRoot 'skills') -Target $skillSource

$settingsPath = Join-Path $piAgent 'settings.json'
$settings = [ordered]@{}
if (Test-Path -LiteralPath $settingsPath) {
    try {
        $existing = Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json
        foreach ($property in $existing.PSObject.Properties) {
            $settings[$property.Name] = $property.Value
        }
    }
    catch {
        throw "Cannot parse existing Pi settings at $settingsPath. Fix or remove the file before continuing."
    }
}
$settings['packages'] = $packagePaths
$settings | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $settingsPath -Encoding utf8
Write-Host "Wrote $settingsPath"

if (-not $SkipDependencies) {
    Assert-Command -Name 'npm' -Purpose 'install Pi package dependencies'
    Assert-Command -Name 'bun' -Purpose 'install context-mode dependencies'

    Invoke-External -File 'npm' -Arguments @('ci', '--prefix', (Join-Path $packageRoot 'pi-mcp-adapter'))
    Invoke-External -File 'npm' -Arguments @('ci', '--prefix', (Join-Path $packageRoot 'rpiv-mono'))
    Invoke-External -File 'bun' -Arguments @('install', '--cwd', (Join-Path $packageRoot 'context-mode'), '--frozen-lockfile')
}

Write-Host ''
Write-Host 'Pi configuration is ready. Restart Pi, then configure your provider with /login or /settings.'
