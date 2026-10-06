[CmdletBinding()]
param([string]$RuntimeRoot = (Join-Path $env:LOCALAPPDATA 'AgentBridgeRuntime'))
$ErrorActionPreference = 'Stop'
# Installs an isolated, version-pinned runtime. It does not alter the global CLI,
# ChatGPT credentials, SSH service, firewall or an existing Codex environment.
$npmCommand = Get-Command npm.cmd -CommandType Application -ErrorAction SilentlyContinue
if ($null -eq $npmCommand) { throw 'Please install Node.js LTS with npm, then run this script again.' }
New-Item -ItemType Directory -Force -Path $RuntimeRoot | Out-Null
& $npmCommand.Source install --prefix $RuntimeRoot --no-audit --no-fund --save-exact '@openai/codex@0.160.0'
if ($LASTEXITCODE -ne 0) { throw 'The pinned Codex runtime installation failed.' }
$runtimeCommand = Join-Path $RuntimeRoot 'node_modules\.bin\codex.cmd'
if (-not (Test-Path -LiteralPath $runtimeCommand -PathType Leaf)) { throw 'The installed Codex launcher is missing.' }
$runtimeVersion = (& $runtimeCommand --version | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $runtimeVersion -ne 'codex-cli 0.160.0') { throw 'Runtime version verification failed.' }
[ordered]@{
    version = $runtimeVersion
    appRuntimeExecutable = $runtimeCommand
    loginInstruction = 'Use the same Windows user whose Codex is already signed in with ChatGPT. If needed, run this launcher with login on Windows.'
    sshInstruction = 'The Mac App starts app-server through SSH. This script does not open network ports or change SSH settings.'
    credentialsRead = $false
    globalCliChanged = $false
} | ConvertTo-Json
