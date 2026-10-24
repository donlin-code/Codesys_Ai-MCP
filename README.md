# 🔧 Codesys - Ai MCP

#### 让 AI 读懂 CODESYS 工程，也能把修改写回工程里

[简体中文](README.md) · [English](README.en.md) · [下载](https://github.com/donlin-code/donlinxg_MCP/releases/tag/v0.1.0) · [问题反馈](https://github.com/donlin-code/donlinxg_MCP/issues)

这是我围绕 PLC 编程做的一套 AI 接入工具。查程序、追信号、改 ST 代码，往往要在 IDE 和聊天窗口之间反复复制粘贴；这套工具把 AI 客户端和 CODESYS 接起来，让分析、修改和编译能接着做下去。

目前先做透一件事：**读工程 → 找问题 → 展示差异 → 确认后修改 → 回读 → 完整编译。**

> **v0.1.0 · 实验版**：当前实现针对 **CODESYS V3.5 SP20 Patch 6**，使用已安装的官方 Scripting API。它是本项目的实验 MCP 适配器，不是 CODESYS 官方 SP22 MCP 插件。请从独立测试工程开始。

---

## 📋 目录

| 模块 | 一句话 | 说明 |
| --- | --- | --- |
| 🔍 工程读取与分析 | 读取对象树和 ST 全文，定位问题并说明覆盖范围 | [查看](#read) |
| ✏️ ST 修改与验证 | 绑定源码基线，逐项写入、回读和完整编译 | [查看](#edit) |
| 🧾 快照与批次记录 | 保留源码、差异、执行结果和覆盖报告 | [查看](#evidence) |
| 📦 安装与连接 | 获取工具、启动独立 IDE、配置 MCP 客户端 | [查看](#install) |
| 💬 使用示例 | 从“帮我看程序”到“确认这一批修改” | [查看](#examples) |
| 🧭 支持范围与计划 | 已经验证什么，后面准备做什么 | [查看](#scope) |

---

<a id="read"></a>
## 🔍 工程读取与分析

让 AI 先看到程序本身，再讨论怎么改。

- 核对绑定的工程和 Application，遍历对象树及子对象。
- 读取自有 ST 的声明、实现及独立方法、Action 等文本对象。
- 保留完整源文本、对象路径和内容指纹，让分析建议定位到具体对象。
- 对图形实现、受保护库、未知语言和读取失败对象明确报告未覆盖。

可以用它梳理状态机、追踪信号赋值、检查初始化，或整理一组功能块的调用关系。AI 的逻辑判断仍需结合 I/O 映射、任务顺序和实际运行验证；源码读完不等于整机问题已经查清。

<a id="edit"></a>
## ✏️ ST 修改与验证

> **先看具体改了什么，确认这一批，再写入。**

```text
读取基线 → 展示差异 → 用户确认计划哈希 → 重新读取
    → 指纹一致 → 逐项写入、回读 → 完整编译
    → 用户保存、关闭重开 → 再次核对
```

| 情况 | 处理方式 |
| --- | --- |
| 确认后又有人工改动 | 写前重读；目标指纹变化就停止，重新展示差异 |
| 连续修改多个对象 | 上一项回读一致后，才继续下一项 |
| 写入超时或结果未知 | 先核对实际内容，不直接重试写入 |
| 编译发现额外问题 | 保留完整诊断，修复另建新批次 |
| 需要确认保存结果 | 用户保存并关闭重开后，再读源码比较 |

**确认由对话工作流执行，MCP 服务本身不强制用户审批。** CLI 也不能约束其他客户端。第一版采用单编辑者约定，不保证 IDE 锁、多对象原子事务或完整自动回滚。

<a id="evidence"></a>
## 🧾 快照与批次记录

辅助 CLI 整理本地证据，实际工程读写和编译通过 MCP 完成。

| 命令 | 作用 |
| --- | --- |
| `bridge status` | 检查当前 SP20 桥接会话 |
| `snapshot capture/validate` | 采集并校验对象清单、完整源码和原始返回 |
| `diff` | 展示快照差异或具体修改批次 |
| `batch prepare/record/verify` | 生成计划，记录确认、执行和验证结果 |
| `report` | 输出源码覆盖或批次验证报告 |
| `doctor` | 检查官方 SP22 MCP 文件前置条件，不代表已连接 |

写入成功、回读一致、编译通过、保存重开一致和运行行为通过，分别记录。摘要不能代替源码全文，测试替身不能冒充真实 IDE 证据。

---

<a id="install"></a>
## 📦 安装与连接

### 1. 准备环境

| 项目 | 要求 |
| --- | --- |
| 系统 | Windows，PowerShell 5.1+ |
| Node.js | 22 或更新版本 |
| CODESYS | V3.5 SP20 Patch 6，Scripting API 可用 |
| 工程 | 已保存的 `.project` 测试工程，启动器会另建副本 |
| AI 客户端 | 支持 stdio MCP；提供 Codex 配置脚本，其他客户端需自行核验 |

仓库当前为私有，下载或克隆需要访问权限。Node.js、CODESYS 和第三方许可证不随工具包提供。

### 2. 获取工具

推荐使用 [v0.1.0 发行页](https://github.com/donlin-code/donlinxg_MCP/releases/tag/v0.1.0)：

| 文件 | 用途 |
| --- | --- |
| `donlinxg_MCP-0.1.0-runtime.zip` | 直接使用，带编译结果和生产依赖，无需 npm install |
| `donlinxg_MCP-0.1.0-source.zip` | 阅读或二次开发，构建前运行 npm ci |
| `DOWNLOAD-SHA256.json` | 校验下载的 ZIP |
| `VALIDATION.json` | 查看这次发行的本地验证范围 |

请先解压再运行。包内 `SHA256SUMS.json` 提供逐文件校验。

也可以从源码构建：

```powershell
git clone https://github.com/donlin-code/donlinxg_MCP.git
cd donlinxg_MCP
npm ci
npm run build
```

### 3. 启动独立工程副本

在工具包根目录打开 PowerShell，按实际安装路径修改参数：

```powershell
$toolkitNode = (Get-Command node).Source
.\scripts\Start-SP20Bridge.ps1 -Project 'D:\Projects\Test.project' `
  -Ide 'D:\Program Files\CODESYS 3.5.20.60\CODESYS\Common\CODESYS.exe' `
  -Profile 'CODESYS V3.5 SP20 Patch 6'
```

脚本复制工程、启动独立 GUI IDE，并生成 `artifacts/sp20-bridge/current-session.json`。等待就绪后再连接；旧绑定 IDE 仍运行时，启动器会拒绝切换。

### 4. 配置 AI 客户端

Codex 已安装且命令可用时：

```powershell
.\scripts\Configure-SP20Mcp.ps1 -NodePath $toolkitNode -RegisterCodex
```

脚本先握手，再注册 `codesys-sp20-ai`，已有同名配置会保留。省略 `-RegisterCodex` 可只检查连接并输出配置。随后刷新 MCP 工具或新开对话。

其他 stdio MCP 客户端参考 [配置示例](config/mcp.example.json)，把 Node、服务入口和 `current-session.json` 改为本机绝对路径。服务入口为 `dist/src/mcp-server.js --config <配置文件>`。

### 5. 先验证一次读取

```powershell
node dist/src/cli.js bridge status --config artifacts/sp20-bridge/current-session.json
node dist/src/cli.js snapshot capture --config artifacts/sp20-bridge/current-session.json --out artifacts/first-snapshot.json
node dist/src/cli.js report --snapshot artifacts/first-snapshot.json --out artifacts/first-coverage.md
```

先核对工程身份，再看覆盖报告。存在多个 Application 时，采集需指定 `--application '<实时对象路径>'`。

---

<a id="examples"></a>
## 💬 可以这样使用

### 只分析，不改代码

```text
使用 codesys-sp20-ai 核对工程身份，读取 Application 下指定文件夹的全部自有 ST 对象及子对象。
列出未覆盖内容，检查初始化、状态迁移、信号复位和多处赋值问题。
每条建议给出对象路径、相关源码、影响和验证方法，先不要修改。
```

### 排查上电后输出异常

```text
检查指定 DO 的声明初值、所有直接及间接赋值、启动初始化和每周期覆盖顺序。
区分源码中已证实的原因，以及仍需检查的 I/O 映射、保持变量、强制状态或硬件行为。
只读取和分析，不操作现场输出。
```

### 准备一批 ST 修改

```text
根据刚才的问题生成一个修改批次，展示目标对象、完整差异和计划哈希。
等我确认后重新读取目标，核对基线，逐项写入、回读并完整编译。
如果出现冲突、写入失败或结果未知，停止后续操作并报告状态。
```

### MCP 工具一览

| 工具 | 作用 |
| --- | --- |
| `codesys_project_info` | 读取绑定工程身份 |
| `codesys_list_objects` | 读取对象树及父节点指纹 |
| `codesys_read_object` | 读取原始声明、实现和源码指纹 |
| `codesys_replace_st` | 检查源码基线后替换 ST |
| `codesys_create_st` | 检查父节点后新建 ST 对象 |
| `codesys_compile` | 对指定 Application 完整重编译并返回诊断 |
| `codesys_reconcile_write` | 核对未知写入，不重复执行写入 |

---

<a id="scope"></a>
## 🧭 支持范围与后续计划

| 内容 | 当前状态 |
| --- | --- |
| SP20 Patch 6 工程树、ST 读取、替换、创建和完整编译 | 本机独立测试副本已验证 |
| POU、GVL、DUT、独立方法、ST Action | 已覆盖相应文本操作，逐对象核验语言和完整性 |
| 旧源码指纹冲突拒绝、故意编译错误检测 | 本机测试已验证 |
| 保存、关闭重开和源码核对 | 独立原生 Scripting 测试已验证，由用户执行保存步骤 |
| 官方 SP22 MCP | 提供配置辅助，插件安装、PDE 许可和真实连接待验证 |
| InoProShop / EcoStruxure Motion Expert | 后续分别验证，尚不宣称兼容 |
| 气缸、轴和整机行为回归 | 尚未完成 IDE 仿真或实际运动验收 |
| Modbus、OPC UA、Git、技术文档检索、工作台 UI | 后续扩展，尚未集成为本工具功能 |

本地验证通过 **76 项 Node 测试、36 项 Python 桥合同测试**，并检查运行包 CLI 和 ZIP 哈希。合同测试使用 ScriptEngine 替身；历史真实 IDE 结果和限制见 [验证范围](docs/acceptance.md)。本轮打包没有重新运行现场工程，编译通过也不等于运行行为通过。

后续先补运行数据读取和仿真回归，再做版本管理、文档检索与工作台界面，最后逐个验证 OEM 适配。

**当前工具不提供 PLC 登录、下载、启动、强制 I/O、图形语言编辑、无界面工程处理或自动保存。**

---

## ❓ 常见问题

**需要官方 SP22 MCP 插件或 PDE 许可吗？** 当前 SP20 路线使用 Scripting API；官方 SP22 路线另行依赖其插件和有效 PDE 权益，二者分开核验。

**关闭 CODESYS 后还能继续读吗？** 不能。服务依赖绑定的 IDE 实例，关闭后需重启桥。其他打开的 IDE 窗口不一定是当前绑定工程。

**AI 改完就保存了吗？** 没有。写入和编译不自动保存。用户保存并关闭测试 IDE 后，可按 [连接说明](docs/setup-sp20.md) 重开同一副本并核对。

**能保证读到全部代码吗？** 只能保证通过完整性核验的读取范围。报告会列出图形实现、受保护内容、失败或未知语言对象，不会把它们算成已读全文。

**会改到原工程或控制现场设备吗？** 启动器另建工程副本，桥绑定该副本；接口不提供现场运行控制。请核对工程身份，并保留自己的基线备份。

---

## 🗂️ 工具结构

```text
donlinxg_MCP/
├── README.md / README.en.md     # 中英文介绍
├── src/                        # TypeScript MCP 与证据 CLI
├── scripts/                    # IDE 启动、配置、Scripting 桥与打包
├── tests/                      # Node 测试与 Python 桥合同测试
├── workflows/                  # 连接、分析、批次编辑规则
├── docs/                       # 数据格式、桥接协议与验证范围
├── config/                     # 通用 stdio MCP 配置示例
├── examples/smoke/             # 三对象 ST 源码示例
├── distribution/               # 可复用发行说明模板
└── artifacts/                  # 本地工程副本和证据，不提交
```

示例源码需要导入自己的测试工程并重新验证。工程文件、业务框架、原始现场分析、IPC/bootstrap 和会话凭据不随通用工具分发。

## 🛠️ 开发与验证

```powershell
npm ci
npm test
python tests/sp20-bridge-contract.py
npm run package:release
```

Python 3 仅用于开发阶段的桥合同测试。`package:release` 构建并生成源码目录、含锁定生产依赖的运行目录及逐文件哈希；ZIP 是另外生成的发行资产。

修改工程操作规则时，请同时更新测试和文档。没有真实 IDE 证据的结果，应保留为离线测试或准备材料。

---

## 🌟 关于

这套工具从我自己查 PLC 程序、改 ST 功能块的需求做起。目标是把工程读写和验证一步步做扎实，再扩展到更多 PLC 工具和数据接口。

有问题或建议，欢迎在 [Issues](https://github.com/donlin-code/donlinxg_MCP/issues) 中说明 IDE 版本、复现步骤和脱敏后的诊断，请勿上传会话凭据或现场工程。也可以看看我的另一个项目：[🧰 Donlinxg Skills](https://github.com/donlin-code/donlinxg-skills)。

**许可**：本仓库暂未授予开源许可证，第三方依赖按各自许可证使用。

Made by [Donlinxg](https://github.com/donlin-code)
