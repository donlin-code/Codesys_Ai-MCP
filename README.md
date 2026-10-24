# donlinxg_MCP

[简体中文](README.md) | [English](README.en.md)

CODESYS AI 工程助手 **v0.1.0**：通过 stdio MCP 让 AI 读取、分析和编辑独立测试工程中的 ST 代码，并获取完整编译诊断。

当前提供 **CODESYS V3.5 SP20 Patch 6 实验适配器**，使用已安装的官方 Scripting API。它不是 CODESYS 官方 SP22 MCP 插件，也不是安装到 IDE 的 `.package` 扩展。

## 下载与环境

- [源码包 ZIP](donlinxg_MCP-0.1.0-source.zip)：源码、测试、文档及三对象 smoke 示例。
- [下载校验清单](DOWNLOAD-SHA256.json)：ZIP 字节数和 SHA256。
- [验证记录](VALIDATION.json)：自动化测试范围和结果。

运行环境：Windows、Node.js 22+、CODESYS SP20 Patch 6 和可用的 Scripting API。运行包带编译结果和生产依赖；Node.js、CODESYS 不随包分发。下载源码包后，也可通过 `npm ci` 和 `npm run build` 构建。

解压后的 README、docs/、workflows/ 和 config/ 提供完整说明，SHA256SUMS.json 提供逐文件校验。

## 快速开始

在解压后的工具包根目录运行 PowerShell：

```powershell
$toolkitNode = (Get-Command node).Source
.\scripts\Start-SP20Bridge.ps1 -Project 'D:\Projects\Test.project' `
  -Ide 'D:\Program Files\CODESYS 3.5.20.60\CODESYS\Common\CODESYS.exe' `
  -Profile 'CODESYS V3.5 SP20 Patch 6'
.\scripts\Configure-SP20Mcp.ps1 -NodePath $toolkitNode -RegisterCodex
```

启动器另建工程副本并绑定独立 IDE。刷新 MCP 后，让 AI 先读取工程身份、Application 对象树及完整 ST 源码，明确未覆盖对象，再分析和提出差异。其他 stdio 客户端参考包内 config/mcp.example.json。

## 功能

| MCP 工具 | 用途 |
|---|---|
| `codesys_project_info` | 核对绑定工程身份 |
| `codesys_list_objects` | 遍历对象树和子对象 |
| `codesys_read_object` | 读取原始声明、实现和源码指纹 |
| `codesys_replace_st` | 检查基线后替换 ST 源码 |
| `codesys_create_st` | 检查父节点后创建 ST 对象 |
| `codesys_compile` | 完整 Application 编译与诊断 |
| `codesys_reconcile_write` | 核对结果未知的写入，避免重复提交 |

支持 POU、GVL、DUT、独立方法和 ST Action 等文本对象。图形实现、受保护库及未知语言明确列为未覆盖，摘要不能代替源码全文。CLI 另提供快照、覆盖报告、差异、批次记录和 SP22 前置检查。

## 编辑流程

**展示具体差异 → 确认该批计划哈希 → 重读并核对基线 → 逐项写入和回读 → 完整编译 → 用户保存、关闭重开 → 再次核对。**

审批由对话工作流执行，MCP 服务自身不强制审批。采用单编辑者约定，不保证 IDE 锁、多对象事务或完整自动回滚。超时先核对实际状态，额外编译修复需要新批次。写入、回读、编译、保存重开和运行行为分别记录。

## 验证与边界

本地 76 项 Node 测试、36 项 Python 桥合同测试通过，运行包 CLI 启动及 ZIP 哈希核验通过。本轮打包未重新执行真实 IDE 测试；历史 SP20 读写、冲突拒绝、对象创建和编译结论，以及独立保存重开测试见包内 docs/acceptance.md。编译通过不代表运动行为正确。

不提供 PLC 登录、下载、启动、强制 I/O 或自动保存。SP22 官方插件/许可/真实连接、Modbus、OPC UA、OEM 适配与独立 UI 未交付。现场工程、业务源码、原始分析和连接凭据不在分发范围。

仓库未授予开源许可证；第三方依赖保留各自许可证文件。
