# 本地数据协议 v1

这些是辅助 CLI 的文件格式，不是 MCP 的工具参数。官方 SP22 工具调用必须根据安装版本的 `tools/list` 绑定；本项目 SP20 适配器使用 `codesys_*` 工具名。原始证据保留实际工具名，不把实验适配器改名成官方工具。

运行 `node scripts/demo.mjs` 可生成一套完整、可运行的离线示例，包括 baseline、changes、batch、六种事件及报告。所有示例明确为 `origin: fixture`，不得改标签充当 IDE 证据。

## Snapshot

```json
{
  "schemaVersion": 1,
  "origin": "ide",
  "capturedAt": "2026-10-23T10:00:00.000Z",
  "identity": {
    "projectPath": "C:\\Projects\\McpSmoke.project",
    "applicationPath": "Device.Application",
    "ideVersion": "3.5.22.30",
    "pluginVersion": "ACTUAL_INSTALLED_VERSION"
  },
  "treeComplete": true,
  "inventory": [{"path":"Device.Application.GVL_McpSmoke","type":"GVL","language":"ST"}],
  "objects": [{
    "path":"Device.Application.GVL_McpSmoke","type":"GVL","language":"ST",
    "status":"read","complete":true,
    "text":"VAR_GLOBAL\n    xReady : BOOL;\nEND_VAR\n",
    "evidenceIds":["read-1"]
  }],
  "evidence": [{
    "id":"read-1","tool":"get_structured_text_content",
    "arguments":{"exampleOnly":"replace with the actual raw call"},
    "result":{"exampleOnly":"replace with the actual unmodified response"},
    "capturedAt":"2026-10-23T09:59:59.000Z"
  }]
}
```

上面的占位 result 故意不能通过校验：真实 IDE 快照必须保留实际原始响应，并在其字符串字段中精确找到完整源码（支持 MCP `content[].text` 中嵌套 JSON）。不能截取片段后声明是全文，不能手工补造 evidence。工具编排应直接转存结果。

- `inventory` 必须来自已采集的工程树；包含不可读、图形或库对象时也保留对应条目。可选 `parentPath` 必须是清单内的父对象或当前 Application。
- `status` 为 `read / unread / unsupported / protected`。后三者需要 `reason`，且不能携带待写入 text。
- 已读对象必须 `complete:true`。`sha256` 可由校验器计算；若提供则必须匹配原始 UTF-8 文本。中文、换行和尾部换行不会静默改写。
- IDE 源码 evidence 为 `get_structured_text_content` 或 `codesys_read_object`，实际参数中的 `path / objectPath / object_path` 必须等于该对象路径。其他参数结构用 evidence 的 `sourceBinding:{pathPointer:"/实际字段"}` 映射；不能用父对象或另一对象的返回冒充当前对象。
- `totalLines` 与一基闭区间 `ranges:[{startLine,endLine}]` 可由完整单响应生成；若显式填写则严格检查总行数、连续性及覆盖。
- 分页需增加 `chunks:[{startLine,endLine,evidenceId}]`，按顺序无重叠覆盖完整 text。每页 evidence 要有实际分页范围（当前适配 `startLine/endLine` 或 `start_line/end_line`），源码逐片精确匹配，最后一页必须明确结束。未知 offset/limit 语义须先根据实际 schema 添加适配，不能猜测。
- `treeComplete:false` 时整体覆盖率未知；报告仍给出已知清单的读取比例。保护库和不支持对象不会被隐藏以凑成100%。
- 可选 `references:[{path,sha256,role}]` 记录框架说明、源码基准或CSV的路径、内容指纹和用途。

SP20 可用 `snapshot capture --config <current-session.json> --out <snapshot.json>` 直接采集。多个 Application 时显式提供 `--application <真实路径>`。工具保留原始树和读取返回，并将图形或完整性未证明的对象列为 unsupported；树清单在采集前后保持一致也不表示源码是原子采集。

快照对象的 `sha256` 是合并文本的 SHA256；SP20 读接口 `result.sha256` 则是声明 + NUL + 实现的 SHA256。写入 `expectedSha256` 必须使用最新读接口值，不能替换成快照哈希。

## ChangeRequest 与 Batch

`batch prepare --snapshot baseline.json --changes changes.json --out batch.json` 使用以下修改请求：

```json
{
  "schemaVersion":1,
  "changes":[{
    "path":"Device.Application.GVL_McpSmoke",
    "type":"GVL",
    "language":"ST",
    "text":"VAR_GLOBAL\n    xReady : BOOL := TRUE;\nEND_VAR\n"
  }]
}
```

必须提供目标完整新文本。已有对象要求基线全文已读；新增对象要求工程树完整且对象不存在；禁止隐式改变类型/语言。第一版支持 create/replace，不提供删除、重命名或图形编辑批次。实际 MCP 写入后的回读必须与计划全文一致。SP20 结果证据支持 `codesys_replace_st` / `codesys_create_st`，校验原始声明/实现、工程身份、基线指纹及回读，不接受仅把 outcome 写成 applied。

生成的 Batch 保存 baseline、不可变 plan 和 events。plan 绑定工程身份、来源、基线快照、操作顺序、修改前后文本及哈希。`diff --batch` 展示该计划。修改 plan 后原确认不能继续使用，必须重新 prepare。

本地 JSON 不是数字签名或权限凭证；校验保证正常流程中的一致性，不防止人手工伪造整个证据文件。

## 事件

通用形状：`{"type":"approve","at":"ISO时间","data":{...}}`。事件按发生顺序追加，不能提前写“成功”。`batch record` 接收所有类型；`batch verify --phase ... --evidence ...` 接收回读、编译和重开事件。

| type | data 必填字段 | 规则 |
|---|---|---|
| `approve` | `actor:"user"`、`confirmation`、`planHash` | 记录用户对该差异的真实确认 |
| `start` | `operationId`、`snapshot` | 确认后新采集；核对所有目标基线及已改内容，通过后才执行写入 |
| `result` | `operationId`、`outcome`、`evidence` | outcome 为 applied/failed/unknown；evidence 含 tool、arguments、result 原文 |
| `readback` | `operationId`、`snapshot` | 对已尝试写入的目标判定 verified/failed/unknown；不一致停止 |
| `compile` | `mode:"full"`、`snapshot`、`sourceSnapshotHash`、`toolError`、`errorCount`、`warningCount`、`diagnostics`、`evidence`；官方工具另需 `bindings` | 所有目标回读一致后，显式调用完整编译；总数与原始诊断一致 |
| `reopened` | `snapshot`、`savedAndReopened:true`、`confirmation` | 用户实际保存、关闭重开后再次读取，全文与计划一致 |

每个 snapshot 都是完整内嵌的 Snapshot，不是文件路径。时间需包含时区；操作快照必须在前次操作/确认之后采集，距事件不超过5分钟。IDE目标原始读取证据的时间也必须更新，不能只改快照时间。新增对象还需要新采集的 `browse_project_tree` 或 `codesys_list_objects` 证据；SP20 创建的父节点指纹必须来自该实时树。

`diagnostics` 中每项为 `{severity:"error"|"warning"|"info",message,objectPath?,line?}`。evidence 的 tool 为 `check_for_errors` 或 `codesys_compile`；保存实际参数、原始返回和 `capturedAt`。编译时间必须晚于源快照采集，`sourceSnapshotHash` 必须匹配。保存重开时比较编译时的整个已观察清单与源码，包括未修改的依赖。

`mode:"full"` 不能单独证明完整编译。`bindings` 使用 JSON Pointer 将归一化字段绑定到真实原始参数/返回：`fullBuildArgument`、`errorCountResult`、`warningCountResult`、`diagnosticsResult`。完整编译参数值须为 true 或 "full"；错误/警告数必须精确相同；诊断条数、级别和文本逐条核对。原始诊断字段名不同可用 `severityKey/messageKey` 映射。Pointer支持穿过 MCP `content[].text` 内的 JSON。

官方 `check_for_errors` 必须取得实装 tools/list 和实际返回后设置 bindings。若返回是非结构化文本、参数值或诊断格式不在上述适配范围，需先补明确的解析适配器；当前工具会拒绝声称通过，不猜测。demo 的 `fixtureFullBuild` 是演示字段，不能发送给真实工具。

SP20 `codesys_compile` 的实际参数为 `{"applicationPath":"<真实 Application 路径>","fullBuild":true}`。MCP `content[0].text` 是包含 `ok`、`projectIdentity` 和 `result` 的 JSON；result 中有 `applicationPath`、`fullBuild`、`rebuildReturned`、`success`、`exception`、`diagnostics`、`errorCount`、`warningCount`、`saved:false`、`plcConnected:false` 和 `completedAt`。传输成功或 `ok:true` 不足以证明编译通过，必须核对 `success`、`rebuildReturned`、错误数及异常。

原生适配器可直接校验固定返回结构；显式填写 bindings 时必须完整填写以下四个 Pointer，不能只提供字段别名：

```json
{
  "fullBuildArgument":"/fullBuild",
  "errorCountResult":"/content/0/text/result/errorCount",
  "warningCountResult":"/content/0/text/result/warningCount",
  "diagnosticsResult":"/content/0/text/result/diagnostics",
  "severityKey":"severity",
  "messageKey":"text"
}
```

诊断的 Error/Fatal/FatalError 归一化为 error，Warning 为 warning，Text/Info/Information 为 info；文本按 `text` 或适配器提供的 `message` 原文逐条对应。保留所有诊断，不能只保留错误。校验同时要求实际 Application、工程路径、完成时间和编译源快照一致。

`reopened` 事件沿用同一工程身份。SP20 启动脚本的 `-ReopenSavedCopy` 可为 artifacts 内已保存副本建立新会话并保持工程路径；默认启动仍复制到新路径。跨副本时不得改写新证据的路径来满足旧批次，需要另保存复制源文件哈希和前后源码对比，并在报告中说明其范围。

工具调用本身失败时可用 `toolError:true` 与原始失败结果，错误/警告数允许 null，bindings不要求；其状态只能为 failed，不能凭空填零错误。

CLI 在写入结果未知时禁止继续或重复 start，允许先回读查明。明确失败或回读不符会停止整批。修复/恢复应新建批次，不清空原失败历史。

## 文件和退出码

新输出默认 `CreateNew`，不覆盖已有证据。批次追加使用 `.lock` 和同目录临时文件替换；这是本地记录锁，不是 CODESYS 工程锁。异常退出遗留 lock 时，先核对无写入进程，再清理该单个锁文件。

- `0`：该本地操作成功。
- `1`：输入、证据、状态流转或文件操作错误。
- `2`：doctor 缺前置条件、快照覆盖不完整、或批次尚未完成真实验收。

fixture 即使演示状态全部成功，`batch verify` 仍返回2，不能据此宣布真实 IDE 验收通过。
