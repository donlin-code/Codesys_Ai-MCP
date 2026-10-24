# donlinxg_MCP

[简体中文](README.md) | [English](README.en.md)

CODESYS AI engineering toolkit **v0.1.0**. A stdio MCP adapter lets AI clients read, analyze and edit Structured Text (ST) in an isolated test project and obtain full compilation diagnostics.

The current implementation is an **experimental CODESYS V3.5 SP20 Patch 6 adapter**, using the installed official Scripting API. It is not the official CODESYS SP22 MCP server or an IDE `.package` extension.

## Downloads and requirements

- [Source ZIP](donlinxg_MCP-0.1.0-source.zip): source, tests, documentation and a three-object smoke example.
- [Archive checksums](DOWNLOAD-SHA256.json): ZIP sizes and SHA256 hashes.
- [Validation record](VALIDATION.json): automated verification scope and results.

Requirements: Windows, Node.js 22+, CODESYS SP20 Patch 6 and an available Scripting API. Runtime packages include compiled JavaScript and production dependencies. Node.js and CODESYS are not bundled. You can also extract the source ZIP and run `npm ci` followed by `npm run build`.

The extracted README, docs/, workflows/ and config/ contain full instructions; SHA256SUMS.json contains per-file hashes. Most detailed workflow documentation is currently in Chinese.

## Quick start

Open PowerShell in the extracted toolkit directory:

```powershell
$toolkitNode = (Get-Command node).Source
.\scripts\Start-SP20Bridge.ps1 -Project 'D:\Projects\Test.project' `
  -Ide 'D:\Program Files\CODESYS 3.5.20.60\CODESYS\Common\CODESYS.exe' `
  -Profile 'CODESYS V3.5 SP20 Patch 6'
.\scripts\Configure-SP20Mcp.ps1 -NodePath $toolkitNode -RegisterCodex
```

The launcher creates a separate project copy and binds an independent running IDE. Refresh the client's MCP tools, then ask AI to identify the project, traverse the Application tree, read complete supported ST source and report uncovered objects before proposing edits. Other stdio clients can use config/mcp.example.json from the package.

## Features

| MCP tool | Purpose |
|---|---|
| `codesys_project_info` | Identify the bound project |
| `codesys_list_objects` | Traverse the object tree and children |
| `codesys_read_object` | Read exact declarations, implementations and fingerprints |
| `codesys_replace_st` | Replace ST source after checking its baseline |
| `codesys_create_st` | Create an ST object after checking the parent |
| `codesys_compile` | Rebuild a complete Application and return diagnostics |
| `codesys_reconcile_write` | Reconcile uncertain writes without repeating them |

Supported text objects include POUs, GVLs, DUTs, methods and ST Actions. Graphical implementations, protected libraries and unknown languages are explicitly reported as uncovered. Summaries never replace complete source text. The CLI also provides snapshots, coverage reports, diffs, batch records and SP22 prerequisite checks.

## Editing workflow

**Show the exact diff → approve that batch's plan hash → reread and check the baseline → write and read back each object → perform full compilation → let the user save, close and reopen → reread and compare.**

Approval is enforced by the conversational workflow, not by the MCP server itself. Use one editor at a time. There is no IDE lock, multi-object transaction or automatic complete rollback. Reconcile timeouts before proceeding; additional compilation fixes require a new approved batch. Writing, readback, compilation, persistence and runtime behavior are separate verification results.

## Validation and limits

Local validation passed 76 Node tests, 36 Python bridge contract tests, runtime CLI startup and ZIP hash checks. Live IDE tests were not rerun during this packaging pass. Historical local SP20 read/write, conflict rejection, object creation, compilation and separate save/reopen results are described in docs/acceptance.md inside the package. Successful compilation does not prove correct motion behavior.

The toolkit does not provide PLC login, download, start, forced I/O or automatic saving. Official SP22 add-on/license/live connection, Modbus, OPC UA, OEM compatibility and a standalone UI are not delivered. Customer projects, business source, raw analyses and session credentials are excluded from distribution.

No open-source license has been granted for this repository. Third-party dependencies retain their respective license files.
