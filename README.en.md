# 🔧 Donlinxg MCP

#### Let AI read your CODESYS project—and write reviewed changes back to it

[简体中文](README.md) · [English](README.en.md) · [Downloads](https://github.com/donlin-code/donlinxg_MCP/releases/tag/v0.1.0) · [Issues](https://github.com/donlin-code/donlinxg_MCP/issues)

I built this toolkit around everyday PLC work: understanding existing programs, tracing signals and editing ST without repeatedly copying code between the IDE and a chat window. It connects an AI client to CODESYS so analysis, edits and compilation can follow one workflow.

The first goal is specific: **read the project → find issues → show the diff → approve the batch → edit → read back → rebuild.**

> **v0.1.0 · Experimental**: the current adapter targets **CODESYS V3.5 SP20 Patch 6**, using the installed official Scripting API. This is a project-developed MCP adapter, not the official CODESYS SP22 MCP server. Start with an isolated test project.

---

## 📋 Contents

| Module | In one sentence | Details |
| --- | --- | --- |
| 🔍 Project reading and analysis | Read the object tree and full ST source with explicit coverage | [Details](#read) |
| ✏️ ST editing and verification | Check the baseline, write each object, read back and rebuild | [Details](#edit) |
| 🧾 Snapshots and batch records | Keep source, diffs, execution results and coverage reports | [Details](#evidence) |
| 📦 Setup and connection | Get the toolkit, start an isolated IDE and configure MCP | [Details](#install) |
| 💬 Example requests | Move from a program review to an approved edit batch | [Details](#examples) |
| 🧭 Support and roadmap | See what has been verified and what remains planned | [Details](#scope) |

---

<a id="read"></a>
## 🔍 Project reading and analysis

Give AI the program itself before discussing changes.

- Identify the bound project and Application, then traverse objects and children.
- Read declarations, implementations, independent methods and ST Actions.
- Preserve exact source text, object paths and fingerprints for traceable findings.
- Explicitly report graphical implementations, protected libraries, unknown languages and read failures as uncovered.

Use it to review state machines, trace assignments, examine initialization or understand a group of function blocks. Findings still need I/O mapping, task order and runtime checks where relevant. Reading source does not establish a complete machine diagnosis.

<a id="edit"></a>
## ✏️ ST editing and verification

> **Review the actual changes, approve that batch, then write.**

```text
Read baseline → show diff → approve plan hash → reread
    → check fingerprint → write and read back each object → rebuild
    → user saves, closes and reopens → compare source again
```

| Situation | Behavior |
| --- | --- |
| Someone edits the target after approval | Reread before writing; a changed fingerprint stops the batch |
| Multiple objects need changes | Continue only after the previous object's readback matches |
| A write times out or has an uncertain result | Reconcile actual contents before retrying |
| Compilation reveals additional issues | Preserve diagnostics; additional fixes need a new batch |
| Persistence needs verification | Reread after the user saves, closes and reopens the project |

**Approval belongs to the conversational workflow; the MCP server itself does not enforce human approval.** The CLI cannot constrain other clients. Use one editor at a time. There is no IDE lock, multi-object atomic transaction or automatic complete rollback.

<a id="evidence"></a>
## 🧾 Snapshots and batch records

The CLI organizes local evidence. Actual project reads, writes and compilation go through MCP.

| Command | Purpose |
| --- | --- |
| `bridge status` | Check the current SP20 bridge session |
| `snapshot capture/validate` | Capture and verify inventory, complete source and raw responses |
| `diff` | Show snapshot differences or an exact edit batch |
| `batch prepare/record/verify` | Prepare a plan and record approval, execution and verification |
| `report` | Generate coverage or batch verification reports |
| `doctor` | Check official SP22 MCP file prerequisites; not a live connection check |

Writing, matching readback, compilation, persistence and runtime behavior are separate results. Summaries do not replace full source, and test doubles do not count as live IDE evidence.

---

<a id="install"></a>
## 📦 Setup and connection

### 1. Requirements

| Item | Requirement |
| --- | --- |
| System | Windows, PowerShell 5.1+ |
| Node.js | 22 or later |
| CODESYS | V3.5 SP20 Patch 6 with an available Scripting API |
| Project | A saved `.project` test project; the launcher creates another copy |
| AI client | stdio MCP support; a Codex helper is included, other clients need verification |

This repository is currently private, so downloads and cloning require access. Node.js, CODESYS and third-party license entitlements are not included.

### 2. Get the toolkit

Use the [v0.1.0 release](https://github.com/donlin-code/donlinxg_MCP/releases/tag/v0.1.0):

| File | Use |
| --- | --- |
| `donlinxg_MCP-0.1.0-runtime.zip` | Ready to run: compiled output and production dependencies; no npm install |
| `donlinxg_MCP-0.1.0-source.zip` | Source and development; run npm ci before building |
| `DOWNLOAD-SHA256.json` | Verify downloaded ZIP files |
| `VALIDATION.json` | Review the local release verification scope |

Extract before running scripts. Each package includes a per-file `SHA256SUMS.json` manifest.

To build from the repository:

```powershell
git clone https://github.com/donlin-code/donlinxg_MCP.git
cd donlinxg_MCP
npm ci
npm run build
```

### 3. Start an isolated project copy

Open PowerShell in the toolkit root. Adjust the paths to your installation:

```powershell
$toolkitNode = (Get-Command node).Source
.\scripts\Start-SP20Bridge.ps1 -Project 'D:\Projects\Test.project' `
  -Ide 'D:\Program Files\CODESYS 3.5.20.60\CODESYS\Common\CODESYS.exe' `
  -Profile 'CODESYS V3.5 SP20 Patch 6'
.\scripts\Configure-SP20Mcp.ps1 -NodePath $toolkitNode -RegisterCodex
```

The launcher copies the project, starts an independent GUI IDE and creates `artifacts/sp20-bridge/current-session.json`. Wait for readiness. It refuses to switch while the previous bound IDE is still running.

### 4. Configure the AI client

The final command above registers `codesys-sp20-ai` when Codex is installed and its command is available. It checks the handshake first and preserves existing entries with that name. Omit `-RegisterCodex` to check the connection and print configuration only. Refresh MCP tools or start a new conversation afterward.

Other stdio clients can use [the configuration example](config/mcp.example.json). Replace the Node, server and session paths with absolute local paths. The server entry is `dist/src/mcp-server.js --config <configuration file>`.

### 5. Verify a read first

```powershell
node dist/src/cli.js bridge status --config artifacts/sp20-bridge/current-session.json
node dist/src/cli.js snapshot capture --config artifacts/sp20-bridge/current-session.json --out artifacts/first-snapshot.json
node dist/src/cli.js report --snapshot artifacts/first-snapshot.json --out artifacts/first-coverage.md
```

Check project identity before reading the coverage report. With multiple Applications, specify `--application '<actual object path>'` during capture.

---

<a id="examples"></a>
## 💬 Example requests

### Analyze without editing

```text
Use codesys-sp20-ai to verify project identity and read all owned ST objects
and children in the selected Application folders. Report uncovered content.
Review initialization, state transitions, resets and multiple assignments.
Include object paths, source, impact and verification steps. Do not edit yet.
```

### Investigate an unexpected startup output

```text
Check the selected DO's declaration initializer, direct and indirect assignments,
startup logic and cyclic overwrite order. Separate source-proven findings from
I/O mapping, retained values, forcing or hardware behavior that still need checks.
Read and analyze only; do not operate physical outputs.
```

### Prepare an ST edit batch

```text
Prepare one batch for the findings above. Show targets, the full diff and plan hash.
After approval, reread targets, check the baseline, write and read back each object,
then perform a full rebuild. Stop and report conflicts, failures or uncertain results.
```

### MCP tools

| Tool | Purpose |
| --- | --- |
| `codesys_project_info` | Read the bound project identity |
| `codesys_list_objects` | Read the object tree and parent fingerprints |
| `codesys_read_object` | Read exact declarations, implementations and source fingerprints |
| `codesys_replace_st` | Replace ST after checking its baseline |
| `codesys_create_st` | Create an ST object after checking the parent |
| `codesys_compile` | Fully rebuild the selected Application and return diagnostics |
| `codesys_reconcile_write` | Reconcile an uncertain write without repeating it |

---

<a id="scope"></a>
## 🧭 Support and roadmap

| Area | Current status |
| --- | --- |
| SP20 Patch 6 tree, ST reads, replacement, creation and full compilation | Verified locally in isolated test copies |
| POUs, GVLs, DUTs, independent methods and ST Actions | Corresponding text operations supported; check each object's language and completeness |
| Stale-source rejection and intentional compilation errors | Verified in local tests |
| Saving, reopening and comparing source | Verified in separate native Scripting tests; the user performs saving |
| Official SP22 MCP | Setup helpers provided; installation, PDE entitlement and live connection remain unverified |
| InoProShop / EcoStruxure Motion Expert | Future individual validation; compatibility is not claimed |
| Cylinder, axis and machine behavior | Simulation and actual motion acceptance remain incomplete |
| Modbus, OPC UA, Git, documentation retrieval and workbench UI | Future integrations, not delivered toolkit features |

Local verification passed **76 Node tests and 36 Python bridge contract tests**, plus runtime CLI and ZIP hash checks. Contract tests use a ScriptEngine double. See [validation scope](docs/acceptance.md) for historical live IDE results and limits. Packaging did not rerun a customer machine project, and compilation does not prove runtime behavior.

Next steps prioritize runtime data reading and simulation regression, followed by version control, documentation retrieval and a workbench UI, then individual OEM adapters.

**The toolkit does not provide PLC login, download, start, forced I/O, graphical-language editing, headless project processing or automatic saving.**

---

## ❓ FAQ

**Do I need the official SP22 MCP add-on or PDE entitlement?** The current SP20 route uses the Scripting API. The official SP22 route separately requires its add-on and valid PDE entitlement.

**Can I keep reading after closing CODESYS?** No. The service depends on its bound IDE. Restart the bridge after closing it; another open IDE window is not necessarily the bound project.

**Does an edit save the project?** No. Writes and compilation do not save. After saving and closing the test IDE, follow [the connection notes](docs/setup-sp20.md) to reopen the same copy and compare source.

**Does it read every implementation?** Only source with verified completeness counts as read. Graphical, protected, failed and unknown-language objects remain explicit coverage gaps.

**Will it change my original project or control hardware?** The launcher creates a copy and binds the bridge to it. The interface does not provide PLC runtime control. Check project identity and keep your baseline backup.

---

## 🗂️ Toolkit structure

```text
donlinxg_MCP/
├── README.md / README.en.md     # Chinese and English overviews
├── src/                        # TypeScript MCP server and evidence CLI
├── scripts/                    # Launchers, configuration, bridge and packaging
├── tests/                      # Node and Python bridge contract tests
├── workflows/                  # Connection, analysis and editing rules
├── docs/                       # Data format, protocol and validation scope
├── config/                     # Generic stdio MCP configuration example
├── examples/smoke/             # Three-object ST source example
├── distribution/               # Reusable release documentation templates
└── artifacts/                  # Local project copies and evidence; not committed
```

Import examples into your own test project and verify them again. Customer projects, business frameworks, raw captures, IPC/bootstrap files and session credentials are excluded from generic distributions. Most detailed workflow documentation is currently in Chinese.

## 🛠️ Development and verification

```powershell
npm ci
npm test
python tests/sp20-bridge-contract.py
npm run package:release
```

Python 3 is needed only for development contract tests. `package:release` builds source and runtime directories, includes locked production dependencies and writes per-file hashes. ZIP archives are generated separately as release assets.

Update tests and documentation when changing engineering operations. Results without live IDE evidence must remain labeled as offline tests or preparation material.

---

## 🌟 About

This toolkit started with my own need to review PLC programs and edit ST function blocks. The goal is to make project access and verification dependable before adding more tools and data interfaces.

Open an [issue](https://github.com/donlin-code/donlinxg_MCP/issues) with your IDE version, reproduction steps and sanitized diagnostics. Do not upload credentials or customer projects. You can also visit my other project: [🧰 Donlinxg Skills](https://github.com/donlin-code/donlinxg-skills).

**License:** no open-source license has been granted for this repository. Dependencies retain their respective licenses.

Made by [Donlinxg](https://github.com/donlin-code)
