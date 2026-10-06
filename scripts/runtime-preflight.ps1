[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [string]$OutputPath
)

# Read-only inventory for a Windows Codex host. This script never reads Codex
# configuration/auth files, never starts a server, and never changes services
# or firewall rules. Without -OutputPath it writes JSON to stdout only.

function Protect-UserPath {
    param([string]$PathValue)
    if ([string]::IsNullOrWhiteSpace($PathValue)) { return $PathValue }
    $profilePath = [Environment]::GetFolderPath('UserProfile')
    if (-not [string]::IsNullOrWhiteSpace($profilePath)) {
        return $PathValue.Replace($profilePath, '%USERPROFILE%')
    }
    return $PathValue
}

function Invoke-SafeProbe {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )
    $outputLines = @()
    $exitCode = $null
    $errorText = $null
    try {
        $outputLines = @(& $FilePath @Arguments 2>&1 | ForEach-Object { $_.ToString() })
        if ($null -ne $LASTEXITCODE) { $exitCode = [int]$LASTEXITCODE }
    }
    catch {
        $errorText = $_.Exception.Message
    }
    return [ordered]@{
        arguments = $Arguments
        exitCode = $exitCode
        output = $outputLines
        error = $errorText
    }
}

$codexCommand = Get-Command -Name 'codex' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
$nodeCommand = Get-Command -Name 'node' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
$hostCommand = Get-Command -Name 'codex-code-mode-host' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
$execServerCommand = Get-Command -Name 'codex-exec-server' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1

$codexInfo = $null
if ($null -ne $codexCommand) {
    $codexPath = $codexCommand.Source
    $codexInfo = [ordered]@{
        path = Protect-UserPath $codexPath
        version = Invoke-SafeProbe -FilePath $codexPath -Arguments @('--version')
        appServerHelp = Invoke-SafeProbe -FilePath $codexPath -Arguments @('app-server', '--help')
        execServerHelp = Invoke-SafeProbe -FilePath $codexPath -Arguments @('exec-server', '--help')
    }
}

if ($null -eq $hostCommand -and $null -ne $codexCommand) {
    $candidateHost = Join-Path -Path (Split-Path -Parent $codexCommand.Source) -ChildPath 'codex-code-mode-host.exe'
    if (Test-Path -LiteralPath $candidateHost -PathType Leaf) {
        $hostCommand = [pscustomobject]@{ Source = $candidateHost }
    }
}

if ($null -eq $execServerCommand -and $null -ne $codexCommand) {
    $candidateExecServer = Join-Path -Path (Split-Path -Parent $codexCommand.Source) -ChildPath 'codex-exec-server.exe'
    if (Test-Path -LiteralPath $candidateExecServer -PathType Leaf) {
        $execServerCommand = [pscustomobject]@{ Source = $candidateExecServer }
    }
}

$hostInfo = $null
if ($null -ne $hostCommand) {
    $hostInfo = [ordered]@{
        path = Protect-UserPath $hostCommand.Source
        help = Invoke-SafeProbe -FilePath $hostCommand.Source -Arguments @('--help')
    }
}

$execServerInfo = $null
if ($null -ne $execServerCommand) {
    $execServerInfo = [ordered]@{
        path = Protect-UserPath $execServerCommand.Source
        help = Invoke-SafeProbe -FilePath $execServerCommand.Source -Arguments @('--help')
    }
}

$nodeInfo = $null
if ($null -ne $nodeCommand) {
    $nodeInfo = [ordered]@{
        path = Protect-UserPath $nodeCommand.Source
        version = Invoke-SafeProbe -FilePath $nodeCommand.Source -Arguments @('--version')
    }
}

$sshdInfo = $null
try {
    $sshd = Get-Service -Name 'sshd' -ErrorAction Stop
    $sshdInfo = [ordered]@{
        installed = $true
        status = [string]$sshd.Status
        startType = [string]$sshd.StartType
    }
}
catch {
    $sshdInfo = [ordered]@{
        installed = $false
        status = $null
        startType = $null
    }
}

$report = [ordered]@{
    reportVersion = 1
    collectedAtUtc = [DateTime]::UtcNow.ToString('o')
    operatingSystem = [ordered]@{
        platform = [Environment]::OSVersion.Platform.ToString()
        version = [Environment]::OSVersion.Version.ToString()
        versionString = [Environment]::OSVersion.VersionString
    }
    powershell = [ordered]@{
        version = $PSVersionTable.PSVersion.ToString()
        edition = $PSVersionTable.PSEdition
    }
    codex = $codexInfo
    codeModeHost = $hostInfo
    execServer = $execServerInfo
    node = $nodeInfo
    sshdService = $sshdInfo
    safety = [ordered]@{
        configFilesRead = $false
        authFilesRead = $false
        serverStarted = $false
        systemConfigurationChanged = $false
    }
}

$json = $report | ConvertTo-Json -Depth 10
if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    Write-Output $json
}
else {
    $resolvedOutputPath = [System.IO.Path]::GetFullPath($OutputPath)
    Set-Content -LiteralPath $resolvedOutputPath -Value $json -Encoding UTF8
    Write-Output $resolvedOutputPath
}
