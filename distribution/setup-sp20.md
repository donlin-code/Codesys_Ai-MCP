# SP20 连接说明

完整命令见根目录 README。先安装 Node.js 22+ 和 CODESYS SP20 Patch 6，确认 Scripting API 可用，并准备一个已保存的测试工程。

`scripts/Start-SP20Bridge.ps1` 接受必填 `-Project`，可用 `-Ide` 和 `-Profile` 指定本机安装。它另建工程副本、启动独立 IDE、等待桥就绪，在 `artifacts/sp20-bridge/current-session.json` 保存连接定位。旧绑定 IDE 仍运行时会拒绝切换。

`scripts/Configure-SP20Mcp.ps1 -NodePath <node.exe绝对路径>` 先握手再输出配置；加 `-RegisterCodex` 注册独立名称，已存在的配置不会被覆盖。也可使用 `config/mcp.example.json` 配置 stdio 客户端。

故障排查：

- 找不到 CODESYS.exe：明确传入真实安装路径。
- Bridge 不就绪：检查新生成目录的 startup-error.json、IDE 弹窗和 Scripting API；不把超时视为连接成功。
- 握手失败：检查独立 IDE 是否还在运行、配置是否指向当前会话；不要复用或分享旧 nonce。
- 源码冲突：重新读取、重新生成差异和新批次，不覆盖人工修改。
- 写入结果未知：先调用核对工具和源码读取，不重复提交写入。

用户保存并关闭测试 IDE 后，可对工具包 artifacts 内的原副本使用 `-ReopenSavedCopy` 重新打开同一文件并建立新会话；省略该选项会再次复制。保存、编译和重开核验是不同步骤。
