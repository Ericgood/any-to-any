# Changelog

所有重大变更记录于此，新条目在上。格式：`## YYYY-MM-DD — 标题` + 要点。

## 2026-08-05 — 澄清 3f2abaa 提交范围 + 多 agent 工作区纪律入规范

- 澄清：commit 3f2abaa 除 skill 反空转规则外，还意外包含了另一 agent 进行中的 Phase 2 局域网代码（docs/specs/phase2-lan.md、src/cluster/、device 字段改造、cluster 测试）——系 `git add -A` 裹挟所致；main 测试全绿（90 个），内容自洽故不回退
- 规范新增（CLAUDE.md 第 6 条）：多 agent 共享工作区纪律——精确路径提交，禁用 git add -A；教训入 tasks/lessons.md

## 2026-08-05 — 治理 agent 空转客套（skill 反空转规则）

- 实测暴露新模式：r2c 会话反复发「确认/状态同步」类零增量新消息，每条开新 context，绕过按线程计数的回环保护
- SKILL.md 新增 Anti-chatter 规则：仅在有新信息/问题/请求时发送；线程目标达成即停止；不回复是合法响应（已重新分发到三个 skill 目录）
- conversation 级速率限制记入 P2 加固待办；Claude 端以连续两轮不回复实施断链

## 2026-08-05 — 验收现场：全自动闭环实证 + 双注入竞争修复

- 用户完成一次性 claude CLI 登录 → 全自动档实证：Codex 确认消息由 `claude -p --resume` 直接唤醒 Claude 会话处理（本条目所在回合即该投递）；彩蛋 thread 三条消息全 delivered，Claude↔Codex 双向全自动闭环完成
- hook 活体演示成功：用户说话瞬间 UserPromptSubmit 注入 Codex 消息，Claude 当场回执
- 修复双注入竞争：hook 取件曾连 dispatcher 投递中（delivering）的消息一并抢走，致同一消息 resume+hook 双注入；inbox 增 pendingOnly，hook 只取 strictly-pending（82 测试全绿）

## 2026-08-05 — Phase 2 核心完成：局域网跨设备互通（单机双 daemon 全链路实证）

- device 寻址全线贯通：`@设备/agent:片段` 三段式解析、SessionRef/驿站/conversations 均带 device（SQLite 幂等迁移）
- 对等互联：mDNS 广播发现（bonjour-service）+ 静态 peer 注入（--peer，启动时查 /api/peer/info 取真名）；配对 = 共享 token（`anyd pair --show/--set/--name`，指纹进 TXT）
- 安全分层：server 绑 0.0.0.0 后，非 /api/peer/* 路由强制 loopback-only；peer 路由强制 X-Anytoany-Token（401 拒绝）
- relay 路由：dispatcher 按 to.device 分流——本机走 adapter，远端 POST 交给对方 daemon（视角翻转，contextId 保线程，回信反向路由）
- CLI send 委托 daemon（/api/send，聚合目录才能解析远端目标），daemon 离线降级本地解析；`ANYTOANY_HOME` 隔离实例数据
- **单机双 daemon 冒烟实证全链路**：alpha 聚合 beta 的 4167 个远端 session → @beta/codex 投递 relay 成功 → beta 本地投递真实 Codex 会话 → LAN_ACK 回信反向 relay 回 alpha → alpha 用 Claude resume 把回信真实注入发起方会话（Claude 全自动档登录后首战，实际送达）
- 冒烟暴露并修复崩溃恢复缺口：daemon 死在投递中会让消息悬挂 delivering 永不重试——启动时 recoverStale() 重置进重试通道（at-least-once）
- 测试 97 个全绿；真双机验收待用户在 Mac mini 上执行（README 已有三条命令指引）

## 2026-08-05 — M4+M5+M6 完成：Phase 1 全线落地，等待用户验收

- **M4 双向回路**：SKILL.md（Agent Skills 标准，装入 ~/.claude、~/.codex、~/.agents 三目录并被本会话热加载实证）；Claude 收件 hook（UserPromptSubmit 注入，anyd setup 一键注册、幂等、带备份）；冒烟 SMOKE PASS——Codex↔Codex 双向往返 3 条消息全部 delivered，对方按软约束主动终止连锁
- **M5 Web Console**：daemon 集成 HTTP+SSE 服务（127.0.0.1:7433，零依赖 node:http）；IM 双栏界面（对话列表/左右气泡/投递状态/失败重试/新建对话/身份切换代发）浏览器实测通过；技术选型修订：零构建单文件 HTML 取代 Vite+React（理由：npm 包零构建链、CSP 友好、~400 行可控）
- **M6 收尾**：anyd doctor（8 项自检全 ✓）/ setup / status / stop / flush；README 快速开始；LICENSE (MIT)；npm link 全局可用
- 冒烟带出的真实修复：exec 层改 spawn+stdin ignore（claude CLI stdin 警告）；uuid v7 同秒前缀撞车实证歧义候选机制；回环保护实战拦截 5 连锁（首轮冒烟）
- 测试 81 个全绿，覆盖率 行 92.7% / 分支 80% / 函数 98.4%（达标 ≥80%）
- 遗留待用户：验收现场触发 hook 活体演示（驿站已留 1 条 pending 消息）；可选一次性 claude CLI 登录解锁全自动档；repo 转 public 与 npm publish 待用户过目后执行

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
