# Changelog

所有重大变更记录于此，新条目在上。格式：`## YYYY-MM-DD — 标题` + 要点。

## 2026-08-05 — M3 完成：投递引擎全链路真实跑通

- dispatcher（claim→目录定位→信封→adapter 投递→状态回写→stdout 回复自动入站）+ claude/codex 两家 deliver（argv 直传无 shell 注入面）+ 失败退避 30s——累计 62 测试全绿
- R3 定案：REPLY 标记方案（对方在输出末尾 `<<<ANYTOANY_REPLY>>>` 回复，daemon 解析代为入站）——零权限依赖，headless 沙盒不需写驿站
- **真机里程碑：首次跨厂商 agent 对话闭环 3/4 步**——Claude 会话消息 → 真实投进 Codex 会话 → Codex 理解协议并回信 → 回信自动入站；最后一步（回信送回 Claude）按预期卡在 CLI 未登录（ADR-008 通道 2/3 在 M4 解决）
- `anyd start` 前台 daemon：目录缓存 30s、逐条投递日志、SIGINT 优雅退出

## 2026-08-05 — M2 完成：消息驿站（mailbox）与 conversations

- SQLite 驿站落地：messages 状态机（pending→delivering→delivered/failed→dead，3 次重试）、conversations 无序配对、回环保护（context 深度 12 / 每分钟 6 条）——TDD 12 用例，累计 42 测试全绿
- CLI 四命令接通：anyd send（@ 目标与 --from 均走三级解析）/ inbox（--take 取件即送达）/ reply（继承线程与对话）/ conversations
- 真机验证：第一条消息入驿站（本 Claude 会话 → Codex 实验会话），conversations 正确显示配对
- 术语约定：对用户称「消息驿站」（mailbox 非 email，快递驿站语义：存储-补投-记录-状态）
- 重要环境发现（ADR-008 方向）：用户走 Claude 桌面客户端，CLI 无登录态；客户端原生 send_message 工具可 Claude↔Claude 直投（含 isRunning 状态）；Claude 入站定为三通道分层（客户端 send_message / hook 注入零依赖 / CLI resume 一次性登录解锁全自动）

## 2026-08-05 — M1 完成：session 目录与 @ 寻址

- adapters（claude/codex）的 listSessions + 聚合 scanner + resolveTarget 三级匹配（id 前缀 > 标题子串 > 目录名子串），TDD 30 测试全绿
- 关键实现决策：Claude 的 cwd 从 jsonl 内容读（目录名转义不可靠，实测有目录名与真实 cwd 不一致的 session）；title 取最后一条 custom-title；Codex 以 rollout 文件为真相源、session_index 仅补充 thread_name
- `anyd list` 真机验证：混合列出本机 4157 个真实 session（含正在进行的本会话），全扫 1.7s，默认 --limit 20

## 2026-08-05 — M0 完成：脚手架 + 通道实验结论

- 脚手架就绪：TypeScript + vitest + commander CLI 骨架（`anyd` 七个子命令占位），build/test 全绿
- R2（Codex）风险全解除：resume 携带历史 ✓、cwd 无关 ✓、并发双 resume 无冲突 ✓；发现 headless thread 不实时进 session_index，scanner 改以 rollout 文件名为真相源
- R1（Claude）：id 稳定不漂移 ✓、强依赖 cwd ✓（adapter 必须 cd 到项目目录）；「历史携带」待用户真实终端验证（scripts/experiments/verify-claude-resume.sh）
- 环境事实：Claude 认证在 Keychain → daemon 必须跑在用户登录环境；实验误注入教训记入 tasks/lessons.md

## 2026-08-05 — Web Console 纳入 Phase 1；开工

- 新增 docs/specs/phase1-webui.md：本地可视化控制台（IM 双栏、对话=session 配对、SSE 实时、页面新建连接/代发/重试）——定位：产品可理解性 + 实时监控 + agent 内 @ 失败时的人工兜底
- phase1-mvp.md 同步修订：新增 conversations（连接）数据模型与 `anyd conversations` 命令；skill 改为「先查已连接列表」；里程碑扩至 M6（M5=Web Console）
- Phase 1 动工：M0 脚手架 + R1/R2 通道实验

## 2026-08-05 — 项目规范建立与 Phase 1 计划定稿

- 建立项目规范（CLAUDE.md）：先文档后动作、docs/ 分区、CHANGELOG 制度、时间戳、每轮收尾必推 GitHub
- 新增 docs/specs/phase1-mvp.md：Phase 1（同机 Claude Code ↔ Codex 互 @）完整技术规格与里程碑
- 品牌定案：anytoany + tagline "Session-to-session messaging for AI coding agents"；域名 anytoany.dev 已注册（any2any.dev 跳转）；npm 包名 anytoany 验证可用
- ADR-004（TypeScript）、ADR-005（resume 投递）、ADR-006（A2A 对齐）随开工生效

## 2026-08-05 — 方向决策（ADR-001 ~ ADR-006）

- ADR-001 分发形态：Agent Skills 开放标准 + skill 引导安装（`npx skills add`），agent 侧走 bash 命令，MVP 零 MCP 配置
- ADR-002 跨设备：仅局域网（mDNS 发现 + HTTP 直连 + 配对 token），不用 Tailscale
- ADR-003 开源项目；ADR-006 与 Google A2A 协议：对齐语义、不绑定实现、后置兼容层
- 与 A2A 定位厘清：A2A 管 agent 服务层，anytoany 管运行中会话层，互补不竞争

## 2026-08-05 — 调研完成、仓库创建

- 四路并行调研 + 本机实测，5 份报告落盘 docs/research/：Codex 互 @ 实为进程内 multi-agent（跨 session @ 仅是提案）；Claude Channels / Codex app-server / kimi web 三家均有官方推送入站通道；三家均有 headless resume；「跨设备+跨厂商+session 级互 @」三合一无现成项目
- docs/analysis.md：接入点矩阵、三方案对比、推荐 daemon+adapter+邮箱语义架构、MVP 分期
- 创建 GitHub 仓库 Ericgood/any-to-any（private，首个可用版本前转 public）
