[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$NodePath, [switch]$RegisterCodex, [string]$CodexPath)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$config = Join-Path $root 'artifacts\sp20-bridge\current-session.json'
$server = Join-Path $root 'dist\src\mcp-server.js'
$node = (Resolve-Path -LiteralPath $NodePath).ProviderPath
& $node (Join-Path $root 'dist\src\cli.js') bridge status --config $config
if ($LASTEXITCODE -ne 0) { throw 'Live bridge handshake failed; configuration was not changed' }
function TomlString([string]$value) { return '"' + $value.Replace('\','\\').Replace('"','\"') + '"' }
$snippet = "[mcp_servers.codesys-sp20-ai]`ncommand = $(TomlString $node)`nargs = [$(TomlString $server), `"--config`", $(TomlString $config)]`nstartup_timeout_sec = 100`ntool_timeout_sec = 120`n"
Write-Output $snippet
if ($RegisterCodex) {
  $codex = if ($CodexPath) { (Resolve-Path -LiteralPath $CodexPath).ProviderPath } else { (Get-Command codex -CommandType Application | Select-Object -First 1).Source }
  $raw = & $codex mcp list --json
  if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect existing MCP entries' }
  $servers = ConvertFrom-Json -InputObject ($raw -join "`n")
  if (@($servers | Where-Object { $_.name -eq 'codesys-sp20-ai' }).Count -gt 0) { throw 'codesys-sp20-ai already exists; preserved. It uses current-session.json across restarts.' }
  & $codex mcp add codesys-sp20-ai -- $node $server --config $config
  if ($LASTEXITCODE -ne 0) { throw 'MCP registration failed' }
  Write-Host 'Registered codesys-sp20-ai. Open a new Codex conversation or refresh MCP tools to load it.'
}
