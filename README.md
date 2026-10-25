> **v0.3.0-dev.1 开发版已发布**：[下载 ZIP](https://github.com/donlin-code/Codesys_Ai-MCP/releases/tag/v0.3.0-dev.1) · [中文指南](https://github.com/donlin-code/Codesys_Ai-MCP/releases/download/v0.3.0-dev.1/v03-guide.md) · [English](https://github.com/donlin-code/Codesys_Ai-MCP/releases/download/v0.3.0-dev.1/v03-guide.en.md) · [验收矩阵](https://github.com/donlin-code/Codesys_Ai-MCP/releases/download/v0.3.0-dev.1/acceptance-v03.md)。新增轻量 MCP、通用 CLI、源码索引、工作线程诊断、选中对象刷新及官方 SP22 只读探测。**官方安装器在 cpsrt.dll 中崩溃，SP22 工程适配及三路线性能对比尚未完成，默认仍保留 SP20。** 核心包约6.9 MB，完整运行包约57.1 MB；不要使用 GitHub 自动生成的 Source code 包代替明确命名的发行 ZIP。展开源码仍是历史版本。

# PLC工匠 AI · PLC Artisan AI · v0.2

**让 AI 读取、分析和修改 CODESYS ST 工程，并在本地工作台审阅全过程。**

[English](README.en.md) · [详细使用说明](https://github.com/donlin-code/Codesys_Ai-MCP/releases/download/v0.2.0-rc.1/v02-guide.md) · [验收与限制](https://github.com/donlin-code/Codesys_Ai-MCP/releases/download/v0.2.0-rc.1/acceptance-v02.md) · [标准规则](https://github.com/donlin-code/Codesys_Ai-MCP/releases/download/v0.2.0-rc.1/standards-policy.md) · [GitHub](https://github.com/donlin-code/Codesys_Ai-MCP)
> 新版下载：[v0.2.0-rc.1 压缩包](https://github.com/donlin-code/Codesys_Ai-MCP/releases/tag/v0.2.0-rc.1)。按发布要求，新版源码和运行依赖仅放在 ZIP 中；仓库中原有展开目录保留历史版本，不代表 v0.2 源码。

提供两种入口：Codex 等 MCP 客户端，以及可以自行配置模型的 React 网页工作台。两个入口共用工程服务、基线检查与批次执行通道。

当前为 **v0.2 验收候选版**：SP20 Patch 6 真实读取及批量性能已验证；网页批准后的三对象原生创建、逐项回读和完整编译已通过（0错误/0警告）。负例诊断、保存重开及行为回归仍待验收。SP20 使用本项目的实验 Scripting API 适配器，SP22 官方插件与 OEM 软件保持未验证。

## 能做什么

| 功能 | 实现 |
| --- | --- |
| 工程读取 | 工程树、完整声明和实现、GUID、每批至多 25 对象、完整分页、双遍新鲜度核验、进度和缺口 |
| 本地分析 | ST 词法和部分语法解析、引用查询、可能的间接写入、初值/保持变量、多写入、状态入口和周期调用线索 |
| 受控编辑 | 源码草稿、完整差异、不可变计划、网页人工批准、30 分钟有效期、实时冲突检查、签名操作、逐项回读 |
| 工作台 AI | OpenAI 兼容 Chat/Responses、Anthropic、Gemini；流式工具调用、取消、用量、本轮源码发送范围确认 |
| 运行数据 | Modbus TCP FC01/02/03/04；OPC UA 端点发现、分页浏览、属性读取、订阅、证书信任；质量、时间、趋势和 CSV |
| 回归与资料 | 气缸/初始化/轴握手离线模型，IDE 测试骨架与人工证据导入，授权目录文本检索，本地 Git 检查点 |
| 标准约束 | IEC 61131、61158/61784、62541、安全、集成与 62443 的适用范围及生成检查建议 |

真实工程相同范围采集：149 个完整 ST 对象、212,465 字节，每种模式运行三次。顺序读取中位 124.088 秒，批量读取 41.833 秒，减少 **66.3%**；IDE 请求 307→15。两种模式均保留完整性与源码复核。这是本版顺序/批量传输对比，并非对旧发布包的二进制基准；不能推算所有工程都能达到相同提升。

## 运行包快速开始

需要 Windows、外部安装的 **Node.js 22+** 和本机 **CODESYS V3.5 SP20 Patch 6**。运行包已含编译结果、网页和生产依赖，不包含 Node、用户工程或会话凭据。

1. 将运行包完整解压到可写目录，例如 `C:\Tools\PLC-Artisan-AI`。
2. 从已经保存的 `.project` 建立独立测试副本。启动脚本会再次复制，原工程保持只读。
3. 在该目录运行：

```powershell
.\scripts\Start-SP20Bridge.ps1 -Project 'D:\Test\sample.project'
.\scripts\Start-Workbench.ps1
```

默认 IDE 位置是 `D:\Program Files\CODESYS 3.5.20.60\CODESYS\Common\CODESYS.exe`，Profile 是 `CODESYS V3.5 SP20 Patch 6`。安装位置不同可传 `-Ide` 和 `-Profile`。Node 不在 PATH 时，工作台脚本可传 `-Node 'C:\path\node.exe'`。

启动后在工作台连接 `artifacts/sp20-bridge/current-session.json`，核对测试工程与会话，选择 Application 并采集源码。升级桥接代码后，已运行的 IDE 工作者不会自动热更新；先人工保存/关闭测试 IDE，再重新启动桥接。

### 接入 MCP

```powershell
.\scripts\Configure-SP20Mcp.ps1 -RegisterCodex
```

其他客户端参照 `config/mcp.example.json`，将 Node、MCP 入口和桥接配置改为本机绝对路径。入口为 `dist/src/mcp-server.js`，它连接同一个本地服务。

示例请求：

> 先核对工程身份，采集指定 Application 的完整 ST，列出未覆盖对象；对用户指定变量追踪直接、可能间接及配置线索，给出带行号的建议。只准备差异，等待我在工作台批准。

MCP 保留 `codesys_list_objects`、`codesys_read_object`、`codesys_replace_st`、`codesys_create_st` 和 `codesys_compile`，增加批量读取、上下文、引用、规则、批次和结果核对接口。写工具必须携带有效批次参数；**没有 MCP/模型批准工具**。旧 v0.1 证据 CLI 的授权记录不能作为新版本授权。

## 固定工作流

**测试副本 → 采集 → 分析/草稿 → 规则检查 → 完整差异 → 人工批准 → 即时回读基线 → 逐项写入并回读 → 完整编译 → 回归 → 人工保存重开。**

会话改变、GUID 改变、源码改变、计划被改、批准过期均拒绝写入。超时或结果未知时保留待核实状态，不重复写入。编译修复与恢复也必须建立新批次。没有多对象原子事务、IDE 编辑锁或自动完整回滚；同一时刻保持一个工程编辑者。

## 代码标准与边界

默认生成 IEC 61131-3:2013 / GB/T 15969.3-2017 兼容 ST，使用已经验证的 SP20 能力。新增代码采用四空格、关键字大写、明确类型/单位和中文意图注释；已有接口与命名优先保留。2025 新类型和字符串能力须经目标编译器验证才启用，不生成 IL。

规则目录还覆盖 IEC 61131-8/-10、61158/61784、62541、61508/62061、ISO 13849-1、61784-3、62264、61512、62714、62443 等。它们进入生成约束并给出适用性检查，**不代表实现全部现场总线、安全协议或整机认证**。仅包含规则摘要与标准标识，不复制标准全文。

静态分析是保守线索，未支持语法会列为缺口；IDE 编译器负责最终语法与类型判断。FUNCTION、INTERFACE、PROPERTY/访问器及非结构体 DUT 尚待逐类型原生验收，当前保持关闭。

## 本地通信与回归

```powershell
.\scripts\Start-ProtocolMocks.ps1
```

启动本机 Modbus TCP `127.0.0.1:1502`（Unit ID 1）和 OPC UA `opc.tcp://127.0.0.1:4841/donlinxg-mock`。通信页导入明确点表，不猜测地址、字序或 NodeId。默认周期 500 ms，最小 100 ms；UA 需要显式选择安全模式，陌生证书不能自动信任。

离线模型绑定源码指纹并标记模型前提，不执行任意 ST、不模拟伺服物理运动。IDE 骨架包含确定输入序列和断言，必须人工接线到隔离被测实例并操作仿真。离线、人工仿真与设备数据分别报告。

## 模型与本地数据

工作台默认中文，可切换英文。外部模型首次发送及范围/供应商变化需要预览确认。API Key 使用当前 Windows 用户 DPAPI 加密，或引用环境变量；不进入工程工具输出。HTTP 模型端点仅允许本机回环，外部使用 HTTPS。

服务仅绑定 `127.0.0.1`，浏览器审批使用会话、同源和 CSRF 检查。模型工具不提供任意 shell/脚本。流程约束不隔离具有同一 Windows 用户文件权限的其他程序。

原始工程证据仅保存在本地 `artifacts`，其中可能含业务源码和传输凭据，不能直接分享。发布脚本只打包白名单内容，并扫描凭据与工程文件。不含 PLC 下载、启动、强制、寄存器写入或 UA 方法调用。

## 源码开发与发布

```powershell
npm ci
npm test
python tests/sp20-bridge-contract.py
npm run build:web
npm run test:web
npm run package:release
```

源码发行包的 `npm test` 使用通用夹具；本工作区完整测试还覆盖未发布的自有框架素材。发布需 Python 3、PowerShell 和用于无头测试的 Edge。可通过 `MCP_TEST_PYTHON` 指定解释器。

发布生成源码 ZIP、含生产依赖的运行 ZIP、逐文件 SHA256、下载校验和与本轮验证记录。能力只有具备相应证据才标为已验证；真实 PLC、OEM、云供应商凭据调用及 IDE 行为验收状态详见验收矩阵。
