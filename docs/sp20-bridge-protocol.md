# Experimental CODESYS SP20 file bridge protocol v1

This is a local ScriptEngine adapter, not the official CODESYS MCP server. It is
restricted to independently created test projects under this repository's
`artifacts` directory. It exposes source operations and offline full Application
compilation, but no Python execution, online PLC operations, save, open, close,
or project-switch action. Reads and compilation never save or switch projects.
Threaded ScriptEngine use is explicitly marked expert-only and unsupported in the
installed SP20 API documentation; live acceptance must be recorded separately.

## Startup

Launch a **new** GUI process, using the installed SP20 executable and profile:

```text
CODESYS.exe --Profile="CODESYS V3.5 SP20 Patch 6" --runscript="<repo>\scripts\sp20_bridge.py" --scriptargs="<absolute bootstrap.json>"
```

Use a fresh IPC directory and UUID for every session. The bridge refuses a process
that already has a primary project or an IPC directory with `session.lock`. It
never saves or closes another project. `open` requires an already prepared,
independent copy; `create` requires a nonexistent destination. Example bootstrap:

```json
{
  "protocolVersion": 1,
  "ipcDirectory": "C:\\path\\to\\repo\\artifacts\\sp20-bridge\\SESSION_UUID",
  "sessionId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "nonce": "at-least-32-random-characters-from-the-client",
  "projectPath": "C:\\path\\to\\repo\\artifacts\\sandbox.project",
  "mode": "open",
  "isolatedTestProject": true
}
```

The script initializes the project on the primary thread, starts its worker and
returns. The worker performs a successful primary-thread callback before writing
`ready.json`. A ready file is evidence of successful startup, not proof that the
process remains live. Its fields are `protocolVersion`, `status: "ready"`,
`sessionId`, `nonce`, `pid`, `projectIdentity`, `actions`, `startedAt`, `adapter`,
`officialMcp: false`, `isolatedTestProject: true`. Treat `projectIdentity` as an
opaque object and copy it exactly; it currently includes path, handle and a
session instance UUID. The server checks the current primary handle and path
before every request.

## Request/response files

Clients atomically rename a complete UTF-8 JSON file to `<uuid>.req.json` in the
IPC directory. UUIDs must use canonical lowercase form. Do not write directly to
the final filename. Maximum request size is 4 MiB. Use one in-flight request per
session. The server processes queued files by modification time then name; this
is not a transactional queue or a guaranteed ordering across clients.

```json
{
  "protocolVersion": 1,
  "id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "sessionId": "copy from ready",
  "nonce": "copy from ready",
  "pid": 12345,
  "projectIdentity": {"path": "copy exact object", "handle": 42, "instanceId": "copy"},
  "action": "read",
  "args": {"path": "/Device/PLC Logic/Application/PLC_PRG"},
  "createdAt": "2026-10-23T15:00:00.000Z",
  "deadlineUtc": "2026-10-23T15:00:30.000Z"
}
```

Both times are optional UTC ISO 8601, ending `Z`. `deadlineUtc` is checked again
on the primary thread immediately before dispatch. The response filename is
`<uuid>.res.json`. It echoes all identity fields and includes `id`, `ok`,
`completedAt`, and either `result` or `error: {code,message,partial,details?}`.
Clients must verify every echoed identity and the exact request UUID. Preserve
the raw request and response as evidence. `ok` alone does not claim compilation,
native save, reopen verification, or simulation.

The nonce guards against accidental cross-session delivery; filesystem access
permissions are the actual local security boundary. Another process with access
to the directory can read the nonce. This is not an authentication server.

## Actions

| Action | Arguments | Result |
| --- | --- | --- |
| `ping` | `{}` | `pong`, current bound identity, capture time |
| `project_info` | `{}` | Bound identity, projectPath, rootPath `/`, `savedByBridge:false` |
| `list` | `{}` | `objects`, `treeComplete:true`, `rootChildrenSha256`, `inventorySha256`, capture time |
| `read` | `{path}` | Exact source record described below |
| `replace_st` | `{path,expectedSha256,declaration,implementation}` | `verified:true`, `saved:false`, `beforeSha256`, `readback` |
| `create_st` | `{parentPath,name,kind,expectedChildrenSha256,declaration,implementation}` | `created:true`, `verified:true`, `saved:false`, `readback` |
| `compile` | `{applicationPath,fullBuild:true}` | Full Application rebuild result, diagnostic counts/messages and `success`; no PLC connection or native save |

`list.objects` records `path,parentPath,name,id,typeGuid,isApplication,
hasDeclaration,hasImplementation,childrenSha256`. Paths start at `/` and use
nonlocalized IDE names; each segment escapes `~` as `~0` and `/` as `~1`.
When siblings have the same name, each ambiguous segment appends `~2` and its
full object GUID after escaping the name. For example, a folder and an action
both named `Motion` resolve as `Motion~2<folder-guid>` and
`Motion~2<action-guid>`. A literal `~2` in an IDE name is escaped as `~02`, so it
cannot collide with a selector. Bare ambiguous names fail instead of selecting
an arbitrary object. The resolver requires the exact name and matching GUID;
duplicate sibling name/GUID pairs still fail. GUIDs need not be globally unique
across different parents. Tree traversal is bounded to 128 levels and 20,000 nodes.

A source record contains `path,id,declaration,implementation,hasDeclaration,
hasImplementation,text,sha256,complete:true,capturedAt`. Both source components
are strings. Absent implementations are empty strings. `text` equals
`declaration + (implementation nonempty ? "\n" + implementation : "")`.
PLCopen metadata includes `sourceKind`, `language`, `sourceComplete` and
`languageSource`; a recognized POU additionally includes `pouType` (`program`,
`functionBlock` or `function`) from its XML attribute. An ST action has
`sourceKind:"ACTION"`, no declaration, and a textual implementation. Snapshot
capture classifies it from `sourceKind`, never from an empty declaration alone.

`sha256` is lowercase SHA256 of **exact UTF-8 declaration + NUL + exact UTF-8
implementation returned by the IDE**. Reads and hashes perform no whitespace or
newline normalization. New input text is normalized from CRLF/CR to LF because
SP20 `ScriptTextDocument` documents LF normalization; readback then compares each
component exactly, including trailing whitespace and terminal newlines. `null`
implementation is accepted as empty. No `.strip()` or approximate match is used.
The caller should use LF when preparing a concrete write plan.

Creation supports `PROGRAM`, `FUNCTION_BLOCK`, `GVL`, `DUT` (Structure template)
and `METHOD` (parent must have a FUNCTION_BLOCK declaration), plus `ACTION`.
ACTION requires a PLCopen-confirmed PROGRAM or FUNCTION_BLOCK parent,
`declaration:""` (even whitespace is rejected), and ST implementation text.
It calls `parent.create_action(name=name, language=ImplementationLanguages.st)`;
there is no `ACTION ... END_ACTION` declaration wrapper. The existing parent
scope supplies variables. Functions, GVLs, folders and unrecognized parents
are rejected before creation. New names currently
require ASCII IEC identifiers. The `expectedChildrenSha256` is copied from the
parent's latest `childrenSha256` (`rootChildrenSha256` for `/`). It fingerprints
the exact immediate child names and IDs, sorted by name and ID. The bridge refuses
missing/stale baselines or a case-insensitively matching existing name.

Source reads expose textual content. The adapter does not independently identify
every pre-existing IEC implementation language, validate IEC syntax, infer a
return type, or guarantee compilation. Newly created POUs/methods explicitly use
the SP20 `ImplementationLanguages.st` API. DUT, GVL, POU, method and action creation have
separate native API calls. Declaration-only objects cannot receive implementation
text. Treat arbitrary imported graphical objects as outside live acceptance.

An already running bridge keeps the code loaded at startup. Updating the local
Python file or the MCP schema does not add ACTION creation to an older session;
it has no arbitrary script, import or hot-reload action. Existing complete ST
actions can already be read and replaced with `declaration:""`. Do not close an
IDE with unsaved changes to upgrade it; preserve its state and coordinate the
normal native save/reopen and new isolated session separately.

## Failure, timeout and lifetime

Writes of declaration and implementation are separate native operations; they
are not atomic. On a partial failure, `ok:false`, `partial:true` and any available
readback are returned. Do not interpret a partial failure as rollback. A stale
baseline fails before either source component is written.

The server preserves requests and responses and records `<uuid>.started.json`
before dispatch. It will not execute a UUID whose response exists. A lost client
connection or client timeout leaves the execution outcome unknown: retain the
request, do not resend under a fresh UUID, and re-read/reconcile actual source
before a new plan. A primary-thread dispatch exceeding 120 seconds returns
`EXECUTION_UNKNOWN` and stops the worker. The queued callback may still execute;
the worker does not cancel it. Inspect/reconcile the IDE before starting a new
bridge session. Never reuse a session directory after a crash.

The foreground worker stops when the IDE window closes or when `stop.json`
contains the exact `sessionId` and `nonce`. Stopping the worker leaves the IDE and
project open, and does not save. Errors appear in `startup-error.json`,
`worker-error.json`, and `bridge.log`. No background-thread writes to stdout are
used because older watcher implementations observed IDE instability there.

## Validation scope and provenance

`tests/sp20-bridge-contract.py` uses a small ScriptEngine double to exercise
identity, project binding, raw hashes, conflict rejection, partial errors, exact
readback, parent baselines, and action restrictions. These tests do not establish
native ScriptEngine, threading, packaging or MCP-client acceptance.

API signatures were checked against the installed SP20 files
`ScriptSystem.pyi`, `ScriptProjects.pyi`, `ScriptTreeObject.pyi`,
`ScriptIecLanguageObjectContainer.pyi`, and `ScriptTextualObject.pyi`. The
installed `ScriptIecLanguageObjectContainer.pyi` documents
`create_action(self, name, language=None)` and explicitly states that actions
cannot be added to GVLs or Functions. Its signature was also checked against
the installed ScriptEngine3.dll 4.1.0.0 and ScriptEngine.chm. This establishes API
availability; the new ACTION creation path still needs separate live acceptance.
The
foreground worker / primary-thread dispatch pattern was informed by
[luke-harriman/Codesys-MCP](https://github.com/luke-harriman/Codesys-MCP) and the
existing local plcwright watcher. Request execution and protocol are implemented
independently and expose no arbitrary script executor.
