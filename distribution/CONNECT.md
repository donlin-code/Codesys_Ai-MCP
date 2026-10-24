# 连接工作流

1. 按 README 和 `docs/setup-sp20.md` 从已保存的测试工程启动独立 SP20 桥，核对握手成功。
2. 调用 `codesys_project_info` 核对工程和 Application，不凭窗口标题认定绑定成功。
3. 枚举对象树并读取一个完整 ST 对象，保存原始返回。分析遵循 ANALYZE，编辑遵循 EDIT。
4. SP22 辅助配置使用 `scripts/Configure-CodesysMcp.ps1`；官方插件、管理员安装和有效 PDE 权益需另行满足，不能把本 SP20 桥视为官方 SP22 服务。
