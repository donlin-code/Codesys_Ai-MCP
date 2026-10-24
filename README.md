# donlinxg_MCP

CODESYS AI 工程助手 **v0.1.0**，提供 ST 工程读取、分析、修改和完整编译接口。

这是 **SP20 Patch 6 实验 Scripting MCP 适配器**，不是官方 SP22 IDE 插件。依赖 Windows、Node.js 22+、已安装 CODESYS 及可用的 Scripting API。

## 下载

| 文件 | 用途 |
|---|---|
| [运行包 ZIP](donlinxg_MCP-0.1.0-runtime.zip) | 解压即用，带编译结果和生产依赖；不含 Node.js |
| [源码 ZIP](donlinxg_MCP-0.1.0-source.zip) | 通用工具源码、测试、文档与 smoke 示例；开发前运行 npm ci |
| [下载校验清单](DOWNLOAD-SHA256.json) | ZIP 的字节数及 SHA256 |
| [本次验证记录](VALIDATION.json) | 自动化验证范围与结果 |

当前仓库以完整 ZIP 分发；解压后根目录 README、docs/、workflows/ 和 config/ 提供完整连接及操作说明。源码包和运行包均含逐文件 SHA256SUMS.json。

## 开始使用

解压运行包，在其根目录打开 PowerShell：

```powershell
$toolkitNode = (Get-Command node).Source
.\scripts\Start-SP20Bridge.ps1 -Project 'D:\Projects\Test.project' `
  -Ide 'D:\Program Files\CODESYS 3.5.20.60\CODESYS\Common\CODESYS.exe' `
  -Profile 'CODESYS V3.5 SP20 Patch 6'
.\scripts\Configure-SP20Mcp.ps1 -NodePath $toolkitNode -RegisterCodex
```

启动器创建独立工程副本。刷新 MCP 后，让 AI 读取工程身份、Application 对象树和 ST 源码，先分析再给出修改差异。其他 stdio 客户端可参考包内 config/mcp.example.json。

支持 POU、GVL、DUT、独立方法和 ST Action 等文本对象；未覆盖对象明确报告。包括工程树/读取、指纹冲突检查、替换/创建、未知写入核对、完整编译，以及源码快照、差异、批次记录和报告 CLI。

工程修改流程：**展示差异 → 确认该批计划 → 重新读取核对基线 → 逐项写入和回读 → 完整编译 → 用户保存、重开 → 核对**。审批由对话工作流执行，MCP 服务自身不强制审批；单编辑者使用，不保证事务或自动回滚。

本次干净源码目录的 76 项 Node 测试、36 项 Python 桥合同测试通过，运行包 CLI 启动及 ZIP 哈希核验通过。本次打包未重新执行真实 IDE 测试；历史本机 SP20 读写/编译结论及未完成范围见包内 docs/acceptance.md。编译通过不代表运动行为通过。

不提供 PLC 登录、下载、启动、强制 I/O 或自动保存。SP22 官方插件/许可/真实连接、Modbus、OPC UA、OEM 适配与独立 UI 未交付。

现场工程、业务源码、分析记录和活动连接凭据已排除。仓库未授予开源许可证；第三方依赖保留各自许可证文件。
