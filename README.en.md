> **v0.3.0-dev.1 development build**: [ZIP downloads](https://github.com/donlin-code/Codesys_Ai-MCP/releases/tag/v0.3.0-dev.1) · [English guide](https://github.com/donlin-code/Codesys_Ai-MCP/releases/download/v0.3.0-dev.1/v03-guide.en.md) · [中文](https://github.com/donlin-code/Codesys_Ai-MCP/releases/download/v0.3.0-dev.1/v03-guide.md) · [Acceptance](https://github.com/donlin-code/Codesys_Ai-MCP/releases/download/v0.3.0-dev.1/acceptance-v03.md). Lightweight MCP, generic CLI, source indexing, worker diagnostics, selected-object refresh and official SP22 read-only discovery. **Official installation crashed in cpsrt.dll; native SP22 adaptation and three-route comparisons remain blocked. SP20 stays the backend.** Download the named core (~6.9 MB), full runtime (~57.1 MB) or source ZIP. Expanded repository sources and the content below are historical.

# PLC Artisan AI · PLC工匠 AI · v0.2

**Read, analyze and edit CODESYS ST projects with AI, with a local workbench for source review and approval.**

[简体中文](README.md) · [Operator guide](https://github.com/donlin-code/Codesys_Ai-MCP/releases/download/v0.2.0-rc.1/v02-guide.md) · [Acceptance](https://github.com/donlin-code/Codesys_Ai-MCP/releases/download/v0.2.0-rc.1/acceptance-v02.md) · [Standards policy](https://github.com/donlin-code/Codesys_Ai-MCP/releases/download/v0.2.0-rc.1/standards-policy.md) · [GitHub](https://github.com/donlin-code/Codesys_Ai-MCP)
> Download the [v0.2.0-rc.1 ZIP packages](https://github.com/donlin-code/Codesys_Ai-MCP/releases/tag/v0.2.0-rc.1). The new source and runtime are distributed as ZIPs; existing expanded repository folders remain historical and do not represent v0.2.

Use an MCP client such as Codex, or configure a model directly in the React workbench. Both entry points share one engineering service and the same guarded editing path.

**v0.2 acceptance candidate:** real SP20 reads and batch-read performance are verified. A human approved the exact three-object smoke plan in the workbench; native creation, independent readback and the associated full build passed with zero errors and warnings. Negative diagnostics, save/reopen and behavior regression still require separate acceptance. The SP20 adapter uses the installed Scripting API and is experimental. It is not the official SP22 MCP. SP22 and OEM adapters remain unverified.

## Included capabilities

| Area | Implementation |
| --- | --- |
| Collection | Tree, exact declaration/implementation, object identity, batches up to 25, complete paging, second-pass freshness checks, progress and gaps |
| Analysis | ST lexer and partial parser, references and potential indirect writes, startup values/retained data, multiple writers, state-entry and cyclic-call findings |
| Editing | Drafts, complete diffs, immutable plans, human browser approval, 30-minute expiry, fresh baselines, signed one-use operations and independent readback |
| Web AI | OpenAI-compatible Chat/Responses, Anthropic and Gemini; native streaming tools, cancellation, usage and explicit source-scope consent |
| Telemetry | Modbus TCP FC01/02/03/04; OPC UA discovery, paged browsing, attribute reads, subscriptions and certificate trust; quality, timestamps, trends and CSV |
| Regression | Source-bound cylinder/initialization/axis reference models, IDE harness drafts, manual evidence import, authorized document search and local Git checkpoints |
| Standards | Applicable language, exchange, communication, safety, integration and security references injected into generation guidance |

A real SP20 collection of 149 complete ST objects / 212,465 bytes was measured three times per mode. Median duration was 124.088 seconds sequentially and 41.833 seconds in batches: **66.3% lower**, with 307→15 IDE requests. Both modes retained full-source and freshness checks. This compares sequential and batched transport in v0.2, not an old release binary; results are project-specific.

## Quick start: prepared runtime

Requirements: Windows, an external **Node.js 22+** installation and **CODESYS V3.5 SP20 Patch 6**. The runtime includes compiled code, the built website and production dependencies. Node, user projects and credentials are excluded.

Extract the complete runtime to a writable directory, then run from that directory:

```powershell
.\scripts\Start-SP20Bridge.ps1 -Project 'D:\Test\sample.project'
.\scripts\Start-Workbench.ps1
```

The launcher copies an already saved `.project` into a separate test session. It does not edit the original. Defaults: `D:\Program Files\CODESYS 3.5.20.60\CODESYS\Common\CODESYS.exe`, profile `CODESYS V3.5 SP20 Patch 6`. Override `-Ide` and `-Profile` for your installation. Pass `-Node 'C:\path\node.exe'` to the workbench script if Node is not on PATH.

In the workbench, connect `artifacts/sp20-bridge/current-session.json`, verify the project/session identity, select an Application and collect source. Bridge code upgrades require a fresh IDE worker: manually save/close the old test IDE first; an already running worker does not hot-reload scripts.

### MCP clients

```powershell
.\scripts\Configure-SP20Mcp.ps1 -RegisterCodex
```

For other clients, adapt `config/mcp.example.json` with absolute local paths. The stdio entry is `dist/src/mcp-server.js`; it connects to the shared local service.

Existing read/write tool names remain. New tools provide status, capabilities, batch collection, context, references, rules and batch execution. Write tools require approved batch/operation parameters. **No model or MCP approval tool exists.** Historical v0.1 evidence-CLI approvals cannot authorize v0.2 edits.

## Engineering workflow

**Test copy → collect → analyze/draft → rule checks → full diff → human approval → fresh baseline → write/read back each item → full build → regression → manual save/reopen.**

Changed sessions, GUIDs, source, plan hashes and expired approvals reject writes. Unknown outcomes stay unresolved and are never retried automatically. Fixes and recovery require new batches. There is no multi-object atomic transaction, IDE edit lock or automatic full rollback. Use one engineering editor at a time.

Compilation, readback, persistence and runtime behavior are separate evidence categories. A successful build does not prove saved source or correct machine behavior.

## Standards and code generation

The default target is IEC 61131-3:2013 / GB/T 15969.3-2017-compatible ST using verified SP20 capabilities. New code uses four spaces, uppercase keywords, explicit types/units and Chinese intent comments. Preserve existing external interfaces and naming. Target-verified compiler support is required before enabling 2025-only features. IL is not generated.

The catalogue includes IEC 61131-8/-10, IEC 61158/61784, IEC 62541, IEC 61508/62061, ISO 13849-1, IEC 61784-3, IEC 62264/61512/62714 and IEC 62443, plus related references. It supplies applicability checks and generation guidance, not complete fieldbus/safety protocol implementations, licensed standards text or system certification.

The analyzer is conservative and partial; unsupported syntax is reported as a gap. The IDE remains the syntax/type authority. FUNCTION, INTERFACE, PROPERTY/accessors and non-structure DUT creation remain gated until each passes native creation, readback and compilation acceptance.

## Protocol mocks and regression

```powershell
.\scripts\Start-ProtocolMocks.ps1
```

Starts local Modbus TCP at `127.0.0.1:1502` (Unit ID 1) and OPC UA at `opc.tcp://127.0.0.1:4841/donlinxg-mock`. Import explicit point maps; addresses, word/byte order and NodeIds are never guessed. Default period: 500 ms, minimum: 100 ms. Choose UA security explicitly and confirm the certificate fingerprint before trusting it.

Offline reference models bind source fingerprints and state their assumptions. They do not execute arbitrary ST or simulate servo physics. Generated IDE harnesses contain deterministic inputs and assertions, but require reviewed manual wiring to an isolated DUT and manual IDE simulation. Offline, human-reported IDE and device evidence remain separate.

## Models, privacy and boundaries

The UI defaults to Chinese and offers English. Preview and approve each external model request, including its provider and exact source excerpts. Provider keys use Windows CurrentUser DPAPI encryption or environment references. Remote model endpoints require HTTPS; HTTP is restricted to loopback endpoints.

The service binds only to `127.0.0.1`. Browser control requires a session, same origin and CSRF validation. Model tools expose neither arbitrary scripts nor shells. These controls do not isolate other programs with the same Windows user's file access.

Local `artifacts` may contain proprietary source and transport credentials; never share it wholesale. Release packaging uses an allowlist and scans for credentials and native projects. There are no PLC download/start/force operations, Modbus writes or UA method calls.

## Build, test and release

```powershell
npm ci
npm test
python tests/sp20-bridge-contract.py
npm run build:web
npm run test:web
npm run package:release
```

The source distribution uses generic fixtures for `npm test`; this private workspace additionally checks existing framework examples that are excluded from releases. Release checks need Python 3, PowerShell and Edge for headless browser tests. Set `MCP_TEST_PYTHON` if necessary.

Outputs include source/runtime ZIPs, per-file SHA256 manifests, download checksums and validation records. Production dependencies are bundled with their licenses; Node and development dependencies are not bundled in the runtime. Consult the acceptance matrix for actual evidence and remaining native/cloud/OEM/real-device checks.
