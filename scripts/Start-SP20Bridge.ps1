[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$Project,
  [string]$Ide = 'D:\Program Files\CODESYS 3.5.20.60\CODESYS\Common\CODESYS.exe',
  [string]$Profile = 'CODESYS V3.5 SP20 Patch 6',
  [switch]$ReopenSavedCopy
)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$current = Join-Path $root 'artifacts\sp20-bridge\current-session.json'
if (Test-Path -LiteralPath $current) {
  $previous = Get-Content -LiteralPath $current -Raw | ConvertFrom-Json
  $previousReady = Join-Path $previous.ipcDirectory 'ready.json'
  if (Test-Path -LiteralPath $previousReady) {
    $oldReady = Get-Content -LiteralPath $previousReady -Raw | ConvertFrom-Json
    if (Get-Process -Id $oldReady.pid -ErrorAction SilentlyContinue) {
      throw "The previous bound IDE is still running (PID $($oldReady.pid)). Save and close that test IDE before starting another bound session."
    }
  }
}
$source = (Resolve-Path -LiteralPath $Project).ProviderPath
if ([IO.Path]::GetExtension($source) -ine '.project') { throw 'Expected a saved .project file' }
if (-not (Test-Path -LiteralPath $Ide -PathType Leaf)) { throw 'CODESYS.exe missing' }
$sessionId = [Guid]::NewGuid().ToString()
$ipc = Join-Path $root "artifacts\sp20-bridge\$sessionId"
New-Item -ItemType Directory -Path $ipc | Out-Null
if ($ReopenSavedCopy) {
  $artifactPrefix = ([IO.Path]::GetFullPath((Join-Path $root 'artifacts'))).TrimEnd('\') + '\'
  if (-not $source.StartsWith($artifactPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw '-ReopenSavedCopy only opens an existing copy inside this toolkit artifacts directory'
  }
  $copy = $source
} else {
  $copy = Join-Path $ipc 'workspace.project'
  Copy-Item -LiteralPath $source -Destination $copy
}
$rng = [Security.Cryptography.RandomNumberGenerator]::Create()
$bytes = New-Object byte[] 32
$rng.GetBytes($bytes)
$rng.Dispose()
$config = [ordered]@{protocolVersion=1;ipcDirectory=$ipc;sessionId=$sessionId;nonce=([BitConverter]::ToString($bytes).Replace('-','').ToLowerInvariant());projectPath=$copy;mode='open';isolatedTestProject=$true}
$bootstrap = Join-Path $ipc 'bootstrap.json'
[IO.File]::WriteAllText($bootstrap, ($config | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
$script = Join-Path $root 'scripts\sp20_bridge.py'
# No --noUI: a separate GUI IDE must service primary-thread callbacks.
$arguments = @('--Profile="' + $Profile + '"', '--runscript="' + $script + '"', '--scriptargs="' + $bootstrap + '"')
$process = Start-Process -FilePath $Ide -ArgumentList $arguments -WindowStyle Hidden -PassThru
[ordered]@{pid=$process.Id;config=$bootstrap;project=$copy;source=$source;sourceSha256=(Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant();startedAt=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $ipc 'launch.json') -Encoding UTF8
$deadline = [DateTime]::UtcNow.AddSeconds(120)
while (-not (Test-Path -LiteralPath (Join-Path $ipc 'ready.json'))) {
  if (Test-Path -LiteralPath (Join-Path $ipc 'startup-error.json')) { throw (Get-Content -LiteralPath (Join-Path $ipc 'startup-error.json') -Raw) }
  if ([DateTime]::UtcNow -gt $deadline -or $process.HasExited) { throw "Bridge not ready. Inspect $ipc; process was not killed." }
  Start-Sleep -Milliseconds 250
  $process.Refresh()
}
$ready = Get-Content -LiteralPath (Join-Path $ipc 'ready.json') -Raw | ConvertFrom-Json
if ($ready.pid -ne $process.Id -or $ready.sessionId -ne $sessionId) { throw 'Ready identity differs from launched IDE' }
$temporary = $current + '.' + [Guid]::NewGuid().ToString() + '.tmp'
[IO.File]::WriteAllText($temporary, ($config | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
if ([IO.File]::Exists($current)) {
  try { [IO.File]::Replace($temporary, $current, [NullString]::Value) }
  catch [IO.IOException] {
    # Some Windows file watchers allow writes but deny ReplaceFile deletion.
    # A reader racing this fallback fails JSON/session validation before any IDE call.
    [IO.File]::WriteAllText($current, ($config | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
    if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
  }
} else { [IO.File]::Move($temporary, $current) }
Write-Output ([ordered]@{pid=$process.Id;config=$bootstrap;currentConfig=$current;project=$copy;readyFile=(Join-Path $ipc 'ready.json')} | ConvertTo-Json)
