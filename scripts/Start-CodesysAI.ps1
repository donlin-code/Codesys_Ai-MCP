#requires -Version 5.1
<#
.SYNOPSIS
Run the toolkit environment check; optionally open the specified SP22 IDE.
.DESCRIPTION
Does not install packages, change permissions, activate licenses, open user projects,
download to a PLC, enable MCP automatically, or modify Codex configuration.
#>
[CmdletBinding()]
param(
    [string]$IdeRoot = 'D:\Program Files\CODESYS 3.5.22.30',
    [string]$Profile = 'CODESYS V3.5 SP22 Patch 3',
    [string]$Bridge,
    [string]$NodePath,
    [switch]$StartIde
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$cliPath = Join-Path $projectRoot 'dist\src\cli.js'
if (-not (Test-Path -LiteralPath $cliPath -PathType Leaf)) {
    throw 'Build output is missing. In the toolkit directory run npm install, then npm run build, using a trusted Node.js 22+ runtime.'
}
$nodeExecutable = if ($NodePath) {
    if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) { throw '-NodePath must name an existing Node executable.' }
    (Resolve-Path -LiteralPath $NodePath).ProviderPath
} else { (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source }
$nodeVersion = & $nodeExecutable --version
if ($LASTEXITCODE -ne 0 -or ($nodeVersion -join '') -notmatch '^v(\d+)\.') { throw 'Cannot determine Node.js version.' }
if ([int]$Matches[1] -lt 22) { throw "Node.js 22+ is required; found $nodeVersion" }
Write-Host "Node runtime: $nodeExecutable ($nodeVersion)"

if ($StartIde) {
    if ($Profile -notmatch '^CODESYS V3\.5 SP22(?: Patch \d+)?$') { throw 'This launcher requires an SP22 profile.' }
    $ideDirectory = [IO.Path]::GetFullPath($IdeRoot)
    if (-not (Test-Path -LiteralPath (Join-Path $ideDirectory 'Common\CODESYS.exe') -PathType Leaf)) {
        $ideDirectory = Join-Path $ideDirectory 'CODESYS'
    }
    $ideExecutable = Join-Path $ideDirectory 'Common\CODESYS.exe'
    $profileFile = Join-Path $ideDirectory "Profiles\$Profile.profile.xml"
    if (-not (Test-Path -LiteralPath $ideExecutable -PathType Leaf)) { throw 'Specified CODESYS.exe was not found.' }
    if (-not (Test-Path -LiteralPath $profileFile -PathType Leaf)) { throw 'Specified SP22 profile file was not found.' }
    $alreadyRunning = @(Get-Process -Name CODESYS -ErrorAction SilentlyContinue | Where-Object { $_.Path -ieq $ideExecutable })
    if ($alreadyRunning.Count -gt 0) {
        Write-Host 'This IDE installation is already running. Use that window; only one enabled MCP server is supported.'
    } else {
        # -StartIde explicitly asks for an interactive window; no project or login command is passed.
        Start-Process -FilePath $ideExecutable -ArgumentList ('--Profile="' + $Profile + '"') -WindowStyle Normal | Out-Null
        Write-Host 'Opened SP22. Select an isolated test project and enable MCP Server through Tools.'
    }
}

$cliArguments = @($cliPath, 'doctor', '--ide-root', $IdeRoot)
if ($Bridge) { $cliArguments += @('--bridge', $Bridge) }
Push-Location -LiteralPath $projectRoot
try {
    & $nodeExecutable @cliArguments
    $doctorExitCode = $LASTEXITCODE
} finally { Pop-Location }
exit $doctorExitCode
