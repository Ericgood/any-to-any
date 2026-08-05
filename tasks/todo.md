# Any to Any — 跨设备跨 Agent 的 session 互通

## 需求（用户原话提炼）
- 多设备（MacBook / Mac mini）+ 多 agent（Claude Code / Codex / Kimi Code / Z Code / Q Code）同时开发同一项目
- 痛点：agent 之间无法沟通，用户要手动复制粘贴中转
- 目标：在 A 设备的 A agent 里 `@` 到 B 设备的 B agent 的某个 session，消息能送达，且能来回通信、协作
- 参考：Codex 的跨 session @ 功能（但仅限 Codex 内部）
- 定位：刚需，认真做。项目名 Any to Any

## 本轮计划
- [x] 环境探测（本机 CLI：claude 2.1.198 / codex 0.144.0 / kimi / gemini；gh 已登录 Ericgood）
- [ ] 调研 1：Codex CLI 的跨 session 协作 / @ 机制、自动化接入点
- [ ] 调研 2：Claude Code 的外部消息注入 / hooks / MCP / SDK 接入点
- [ ] 调研 3：Kimi Code / Z Code / Q Code 的可扩展性（MCP、hooks、headless）
- [ ] 调研 4：现有协议（MCP / A2A / ACP）与开源项目盘点，找现成轮子
- [ ] 分析：候选架构对比 + 推荐方案（docs/analysis.md）
- [ ] 建 GitHub 仓库 any-to-any，推送调研+分析
- [ ] 与用户对齐落地方案（待用户回复）

## Review
（完成后补）
