# 全工程分析工作流

1. 按 CONNECT 核对当前工程身份。每个 Application 单独建立 snapshot；分析阶段只读工程。
2. SP20 使用下方 `snapshot capture` 通过真实 MCP 自动采集，保留工具名称、参数、原始返回、时间和完整源文本。官方 SP22 按实装 schema 调用并直接转存证据，不根据记忆重写源码。
3. 遍历工程树直到结束，包含非 ST 和不可读对象。SP20 树证据为 `codesys_list_objects`，官方工具适配为 `browse_project_tree`。未遍历全或采集前后树指纹变化时 `treeComplete=false`，整体覆盖率未知。
4. 读取自有 ST 声明、实现和独立子对象；明确父子归属，避免嵌套文本重复计数。SP20 读取证据为 `codesys_read_object`，官方工具适配为 `get_structured_text_content`。图形程序只有声明文本时不得算完整 ST 覆盖；源语言和完整性需以实际返回为准。
5. 完整单响应源码必须与原始返回的字符串字段精确对应。分页保留每页行范围与证据ID，校验连续性；详见 data-format。没有完整性证据就标记 unread/unsupported/protected 并说明原因。
6. 编译库/保护库使用可用签名及文档，标明实现未读取。按实际工具补充库、设备/I/O、任务信息；接口尚未覆盖的配置明确列入报告。
7. 对快照运行 validate 和 report。不能删掉缺失对象或截断部分以达到100%。原始证据保留本地；分享时另生成脱敏副本，避免泄露会话凭据和工程路径。
8. 对用户选定的框架文档记录路径、SHA256和用途作为 references，逐模块核对实现。源码与设计冲突时引用双方位置。
9. 输出 findings.md：对象路径、源码、影响、证据性质（静态/编译/运行）、建议修改和验证场景。完整编译通过也不证明状态机或设备运行行为正确。

SP20 自动采集示例：

```powershell
node dist/src/cli.js snapshot capture --config artifacts/sp20-bridge/current-session.json --out artifacts/run-001/snapshot.json
node dist/src/cli.js snapshot validate --input artifacts/run-001/snapshot.json
node dist/src/cli.js report --snapshot artifacts/run-001/snapshot.json --out artifacts/run-001/coverage.md
```

存在多个 Application 时需指定 `--application '<实时对象路径>'`。需要明确 Node 路径的本机环境见 `docs/setup-sp20.md`。

自动采集前后比较工程树指纹，但不是 IDE 原子快照，树不变也不能证明期间所有源码都没变化。同轮工程发生变化时重新采集受影响源码和证据；编辑前必须再次读取最新目标。完整读取范围与编译、仿真、持久化分别报告。
