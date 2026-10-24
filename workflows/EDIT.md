# 按已授权批次编辑

1. 核对独立测试副本、基线及恢复位置。读取当前工程/Application 身份和目标源码，形成 baseline snapshot；SP20 用已绑定测试实例，不操作用户原工程。
2. 生成 changes.json，包含本批目标的完整新文本、路径、类型、语言。先 `batch prepare` 再 `diff --batch`，展示对象范围、实际差异、验证和恢复方式。
3. 使用用户对该具体批次已有的明确授权，记录真实回复和计划哈希为 approve 事件。相同且未改变的已授权批次不重复请求；仅要求分析不构成写入授权。
4. 写入前重新读取工程身份、全部目标及已改目标，形成新的 snapshot。start 事件通过基线检查后执行写入。SP20 替换用最新 `codesys_read_object.result.sha256` 作为 `expectedSha256`，创建用父节点 `childrenSha256`；不能用快照合并文本哈希代替源码读接口哈希。
5. SP20 使用 `codesys_replace_st` / `codesys_create_st`，官方 SP22 按其实际 schema 使用写工具。保存原始工具名称、参数和返回；不要把实验工具改名成官方工具后记证据。批次验证同时校验提交源码、工程身份和回读。
6. 工具返回后记录 result。无回应/超时记 unknown，先用 `codesys_reconcile_write` 核对并重新读取，不直接重试。下一项写入前上一项必须 readback verified。明确失败或回读不符停止本批，保留已改、未改和未知状态。
7. 全部回读一致后显式完整编译。SP20 调用 `codesys_compile`，实际 Application 路径配合 `fullBuild:true`；官方 SP22 用实装 `check_for_errors` schema。保留原始参数、完整诊断、完成时间及参与编译的源码快照；`success:false` 不能因 MCP 传输成功而记作编译通过。
8. 需要额外代码修复时生成新批次并展示实际差异；原有授权不隐式扩展到其他对象。恢复也保留独立记录，不清空失败历史。
9. 用户在绑定 IDE 中保存并关闭测试实例。SP20 用 `Start-SP20Bridge.ps1 -Project <原测试副本路径> -ReopenSavedCopy` 为同一文件建立新会话，重新连接 MCP 后读取比较；该参数只允许工具包 artifacts 内已有副本。确认实际保存重开、身份及源码一致后记录 reopened。省略该参数会复制到新路径；跨副本验证需另保留源文件哈希和前后对比，不能改写旧身份强行通过事件。
10. 生成 report，分别汇报修改、回读、完整编译、保存重开，以及逻辑/仿真验证范围。当前桥不自动保存，也不执行 PLC 登录、下载、启动或强制 I/O。

CLI 记录示例：

```powershell
node dist/src/cli.js batch prepare --snapshot baseline.json --changes changes.json --out batch.json
node dist/src/cli.js diff --batch batch.json --out preview.diff
node dist/src/cli.js batch record --batch batch.json --event approval.json
node dist/src/cli.js batch record --batch batch.json --event start-op-1.json
# 执行实际 MCP 写入，原始返回保存为 result-op-1.json。
node dist/src/cli.js batch record --batch batch.json --event result-op-1.json
node dist/src/cli.js batch verify --batch batch.json --phase readback --evidence readback-op-1.json
node dist/src/cli.js batch verify --batch batch.json --phase compile --evidence compile.json
# 仅对实际完成保存重开、且身份及全文证据一致的事件执行：
node dist/src/cli.js batch verify --batch batch.json --phase reopened --evidence reopened.json
node dist/src/cli.js report --batch batch.json --out result.md
```

事件及 SP20 完整编译 JSON Pointer 见 `docs/data-format.md`。CLI 只能检查提交给它的证据，不是权限网关，不能阻止其他客户端绕过流程写 IDE。v0.1 采用单编辑者约定，不承诺原子工程锁。
