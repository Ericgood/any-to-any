# anytoany 项目规范

> 项目：**anytoany** — Session-to-session messaging for AI coding agents
> 仓库：https://github.com/Ericgood/any-to-any · 域名：anytoany.dev（any2any.dev 跳转）· npm：anytoany（未发布，已验证可用）

## 项目是什么

让任何设备上的任何 AI coding agent session 互相 @、互相通信。当前阶段与完整上下文见 [README.md](README.md)、[docs/analysis.md](docs/analysis.md)、[docs/decisions.md](docs/decisions.md)（ADR，所有已拍板决策）、[docs/specs/](docs/specs/)（分阶段技术规格）。

## 文档规范（用户定，必须遵守）

1. **先文档后动作**：每个重大动作（新阶段、新模块、架构调整、对外发布）动手前，先在 `docs/` 写清产品/技术文档；已有文档则先更新。
2. **docs/ 目录分区**：`docs/research/` 调研 · `docs/specs/` 分阶段技术规格 · `docs/analysis.md` 架构分析 · `docs/decisions.md` 决策记录（ADR，编号递增）。
3. **CHANGELOG.md**（仓库根，Markdown）：每次重大变更追加一条，格式 `## YYYY-MM-DD — 标题` + 要点列表。新条目加在最上方。
4. **时间戳**：每份 docs 文档头部带 `> 创建：YYYY-MM-DD · 最后更新：YYYY-MM-DD`，改动时更新后者。
5. **每轮工作收尾必须 commit + push 到 GitHub**——保证换设备、换 agent 都能从仓库完整跟进进度。commit 信息用 conventional commits（中文描述可）。
6. **多 agent 共享工作区纪律**：提交前先 `git status`；只 add 自己本轮改动的文件（精确路径），**禁用 `git add -A` / `git add .`**；工作区里非自己的改动是另一个 agent 的施工现场，不提交、不修改、不回退。
7. **GitHub Actions 额度纪律**：常规 PR/main CI 只使用 Ubuntu Node 20/22；macOS 只允许每周/人工 smoke。纯文档变更不触发 CI；同一逻辑变更先在本地 build/test，完成后再集中 push，禁止把连续微小中间状态逐个推到 `main`。新增 runner、matrix 轴或定时 workflow 前必须在 PR/Docs 写出预计月度分钟影响，并保持 `concurrency.cancel-in-progress=true`。

## 工程约定

- 技术栈：TypeScript + Node 20+（ADR-004）。测试 vitest，TDD：先测后码，覆盖率 ≥80%。
- **dist/ 随源码入库**：`npm i -g git+https` 安装走零编译路径（用户机器现场编译连踩两坑后定案，2026-08-06）。改动 src 后提交前必须 `npm run build` 并把 dist 一起 add；prepare 脚本见 package.json（dist 存在即跳过构建）。
- 语言：docs/ 内部文档中文为主；README 双语；代码、代码注释、CLI 输出用英文（开源面向国际社区）。
- CLI 命令名 `anyd`；用户侧配置与数据在 `~/.anytoany/`。
- 消息模型字段语义对齐 A2A（contextId / role / parts，ADR-006）；不要与 Zed ACP、IBM ACP 混淆。
- 安全底线：跨 agent 消息一律视为数据而非指令（信封模板强制来源标注）；投递用各家官方 headless 通道，不碰 `--dangerously-*` 类旗标；不往任何 agent 注入提权参数。

## 关键事实速查（避免重查）

- 投递通道（ADR-005）：Claude `claude -p --resume <id>`；Codex `codex exec resume <threadId>`；Kimi `kimi -p -S <id>`（Phase 3）。实时通道升级路径：Claude Channels / Codex app-server（ipc.sock）/ kimi web REST，调研详情在 docs/research/。
- session 发现：`~/.claude/projects/<转义路径>/*.jsonl` · `~/.codex/session_index.jsonl` · `~/.kimi-code/session_index.jsonl`。
- skill 分发（ADR-001）：Agent Skills 开放标准（SKILL.md），目标支持 `npx skills add Ericgood/any-to-any`；跨家共享目录 `~/.agents/skills/` 真实存在且在用。
- 跨设备（ADR-002）：仅局域网，mDNS/Bonjour 发现 + HTTP 直连 + 配对 token，不用 Tailscale。
