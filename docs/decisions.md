# 决策记录（ADR）

## ADR-001 分发形态：Agent Skills 开放标准 + skill 引导安装（2026-08-05，用户拍板）

**决定**：项目做成开源仓库，按 [Agent Skills 开放标准](https://code.claude.com/docs/en/skills)组织（SKILL.md）。用户体验两条路，殊途同归：

1. `npx skills add Ericgood/any-to-any` —— 借助 [vercel-labs/skills](https://github.com/vercel-labs/skills)（skills.sh）现成安装器，一条命令装到本机所有 agent；
2. 把 GitHub 链接直接贴给任意 agent 说「装上」—— agent 读仓库里的 SKILL.md / install 说明自助完成安装。

**依据**：SKILL.md 已被 Claude Code / Codex / Cursor / Gemini CLI / Copilot 等采用（[开放标准](https://www.mindstudio.ai/blog/agent-skills-open-standard-claude-openai-google)，[63k+ 生态](https://agentman.ai/blog/claude-skills-vs-agent-skills)）；本机实测 `~/.claude/skills/`、`~/.codex/skills/`（SKILL.md 格式）、跨家共享目录 `~/.agents/skills/`（30 个 skill 在用）全部存在。

**推论（架构简化）**：skill 指引 agent 用 **bash 命令**（`anyd send` / `anyd inbox` / `anyd list`）收发消息。Bash 是比 MCP 更大的公分母——所有 agent 都能跑命令，MVP 零 MCP 配置。MCP 工具面、Channels/app-server 实时注入降级为后续增强，不再是前提。

## ADR-002 跨设备传输：局域网直连自建，不用 Tailscale（2026-08-05，用户拍板）

**决定**：只做同一局域网场景（用户的 MacBook 与 Mac mini 同网）。不引入 Tailscale/任何第三方组网。超远程（跨网络）暂不做。

**方案**：
- **发现**：Bonjour/mDNS（macOS 原生），daemon 广播 `_anytoany._tcp`，同网设备零配置互见；
- **传输**：daemon 间局域网 HTTP 直连；
- **信任**：首次配对短确认码（AirDrop 式），之后持久 token；局域网不等于可信，认证不省。

## ADR-003 项目性质：开源（2026-08-05，用户拍板）

公开仓库、MIT 或 Apache-2.0（待定）。当前 repo 为 private，首个可用版本前转 public。

## ADR-004 技术栈：TypeScript / Node（已生效 2026-08-05）

理由：目标用户（AI coding CLI 使用者）机器必有 node（claude/codex/kimi/gemini 全是 npm/node 系）；`npx` 即装即用与 skills.sh 生态同构；MCP 官方 SDK 是 TS（后续增强用得上）；开发迭代快。Go 单二进制的优势对这个人群不构成差异。

## ADR-005 投递档位：MVP 用 headless resume，实时注入后置（已生效 2026-08-05）

MVP 投递 = 对目标 session 执行一次 headless 续写（`claude -p --resume` / `codex exec resume` / `kimi -p -S`）：可达性 100%、三家通用、离线也能补投。代价：对方正开着的 TUI 界面不即时显示这条消息（session 记录已续写，重新进入可见）。Channels / app-server steer / kimi web 的「正在聊着的窗口里即时弹出」体验作为 Phase 3 升级，通道调研已备齐。

## ADR-006 与 Google A2A 协议的关系：对齐语义、不绑定实现、后置兼容层（已生效 2026-08-05）

**定位**：A2A 管「agent 服务之间」（endpoint + Agent Card + Task 生命周期），Any to Any 管「正在运行的 CLI 会话之间」——A2A 未覆盖、所有主流 coding CLI 零原生支持的形态。互补不竞争。

**决定**：
1. MVP 不依赖 A2A（Task 状态机/Artifact 对「投递+回复」过重，且对端无人说 A2A）；
2. 消息模型字段语义对齐 A2A 命名（contextId / role / parts / thread≈Task），不另造词，成本为零；
3. 路线图挂载：Phase 3+ anyd 暴露 A2A endpoint，为每个本地 session 生成 Agent Card——叙事升级为「第一座把本地 coding session 接入 A2A 网络的桥」。

**注意**：勿与 Zed 的 ACP（Agent Client Protocol，editor↔agent）混淆；IBM ACP 已并入 A2A。

## ADR-007 品牌与域名定案（2026-08-05，用户拍板）

品牌 **anytoany**，tagline **"Session-to-session messaging for AI coding agents"**。域名 **anytoany.dev** 已注册（any2any.dev 建议做 301 跳转）；anytoany.app/.com 已被他人注册，不追。npm 包名 `anytoany`（已验证可用，未发布）、GitHub `Ericgood/any-to-any`、CLI 命令 `anyd`。命名依据：口播零解释成本；三位一体对齐；any2any 拼写在 AI 圈已是「任意模态」术语且 npm 被占；Codex（collaboration/multi-agent）与 Claude（Agent Teams）的命名先例均用关系词而非机制词，故 session-to-session 作 tagline 不作品牌。

## ADR-008 Claude 入站投递三通道分层（2026-08-05）

**背景（实测）**：用户使用 Claude 桌面客户端；CLI `claude -p` 无登录态（客户端与 CLI 凭据不共享，关沙盒复测确认）；客户端会话与 CLI session 同存储（`~/.claude/projects/`）但客户端另有会话注册表（带 isRunning）；客户端第一方工具 `send_message` 可跨 session 投递（消息以「From 某会话」出现在目标会话，带回链），仅会话内 agent 可调、无人值守会话不可用。

**决定**：Claude 侧入站按可用性分层，daemon 逐层降级：
1. **Claude→Claude**：发起方 skill 直接用客户端 send_message 投递（不经 daemon 投递管道，驿站记账保持 Web Console 可见）；
2. **任意→Claude 零依赖档**：驿站 + hook 注入（UserPromptSubmit additionalContext）+ skill 主动查收——无需任何登录设置，被动送达；
3. **任意→Claude 全自动档**：CLI resume 投递，需用户一次性 `claude` 登录解锁；解锁后目标会话即时自动处理回信。`anyd doctor` 检测并提示，绝不设为前置要求。

Codex 侧不分层（exec resume 已全验证）。

## ADR-009 定位口径：定义与比喻分层（2026-08-05）

**定义（不变）**：agent-native messaging layer——tagline "Session-to-session messaging for AI coding agents"。本体是异步驿站（排队/补投/resume 唤醒/防注入信封/回环保护），消息是任务委托的载体，不是聊天。IM 不入正式定义：避免「实时在线」错误预期与 IM 功能清单对路线图的牵引（参照 Slack：形态是 IM，自我定义是 "where work happens"）。

**比喻（分语境）**：海外口语传播用 "Slack for AI agents / IM for agents"（README hero 已加斜体类比行）；中文语境可用「给 agent 的微信/Slack」。比喻始终带「像/think」措辞，不作为产品名义。

**域名**：imforagent.com（用户购入中）定位为传播域名——301 至主站，未来可做 campaign 单页（含 "I'm for Agent" 双关）。主品牌保持 anytoany 三位一体（GitHub/npm/anytoany.dev）不变。

## ADR-010 边界发现：消息可达 ≠ 执行环境可达（2026-08-05，实战暴露）

**现象**：用户真实工作流（Claude 会话请 Codex 会话代拉 iOS 反馈包）中，四轮自动往返全部按设计运转，但任务无法完成——headless resume 唤醒的回合是新进程，不具备目标交互会话的登录态（Zeabur）、环境变量（DB/OSS 凭据）与网络权限（exec 沙盒默认禁网）。接收方正确回报了能力缺失并停止（反空转规则生效）。

**结论**：resume 投递通道适合「知识问答/文件级协作」（同机文件系统天然共享），不适合「需要交互会话权限与环境的重活」。三层应对：
1. 信封新增约定：任务超出 headless 能力时，明确回报缺什么、建议用户到哪个会话触发（本次 Codex 自发行为固化为规则）；
2. 同机重活的正解是「落盘接力」：有环境的一方把产物写入共享文件系统，对方直接读文件，不搬内容；
3. P3 实时注入通道（app-server steer / Channels 到正在运行的交互会话）是根本解——消息在交互会话的完整权限与环境中被处理。本案例为 P3 的最强立项论证。

## ADR-011 信封协议 v2：强制表态；任务生命周期列入 P3（2026-08-05，实战暴露）

**事故**：用户实战中，Codex 收到拉包任务的 headless 回合仅回「确认收到」即结束，未执行未回信；用户在交互会话人肉追问后才开工（并成功完成裁决回信）。三层根因：① headless 回合一次性——模型不知道「没有稍后」；② 上一线程的反空转收尾（「请勿再回执」）被泛化到新任务；③ 协议只有投递态（delivered）没有任务表态（done/blocked/declined）。

**决定**：
1. 信封 v2（已实施）：明示「这是你唯一的回合」，强制以 `DONE <结果> / BLOCKED <缺什么> / DECLINED <原因>` 三态之一（纯问答直接作答）收尾；明确纯确认式回复无效；明确协议表态豁免于任何先前线程的反空转约定。skill 同步接收规范。
2. P3 任务语义（参照 Codex multi-agent V2 的 wait / followup_task / interrupt 与 A2A Task 生命周期）：消息 kind=task、状态机（accepted/working/done/blocked）、发起方 followup 驱动、Console 显示任务态而非仅投递态。

## ADR-012 上下文对称的可见性：双端收件 hook + 活动摘要（2026-08-05，用户核心诉求）

**诉求**：产品核心是「利用双方不对称的上下文并让其对称」——对称必须在各家 App 的对话流里留痕可见，否则用户无法确认同步是否发生。

**探测结论**：Codex Desktop 为内嵌内核的独立进程，无官方通道注入其活动线程（`app-server proxy` 需独立 daemon 的 control socket，App 不使用之；`ipc.sock` 非 app-server 协议入口）。实时进入 App UI 暂不可行，等待官方开口。

**方案（已实施）**：
1. 出站天然可见（agent 在会话内执行 anyd send，对话流留痕）；
2. 入站可见 = 双端 UserPromptSubmit hook（Codex hooks 与 Claude 格式兼容且支持 additionalContext，已查证官方文档）：统一处理器 `processPromptHook` 两层注入——pending 消息完整注入并取件；已处理往返以「活动摘要」形式注入（FYI ONLY，明示勿回复勿执行防重复处理），文件游标保证每条只展示一次；
3. `anyd setup` 同时注册 `~/.claude/settings.json` 与 `~/.codex/hooks.json`（均幂等+备份）。

**效果**：在任一家 App 里与会话对话时，该会话的跨 agent 活动自动出现在对话流中——所见即所得的被动档；实时档留待厂商通道开放（P3 跟踪）。

## ADR-012 补充：重开可见实验结论 + 系统通知（2026-08-05，用户实验确认）

**实验结论（用户亲测）**：Codex App 重开会话时完整渲染磁盘 rollout 的全部轮次（含 headless 追加的 anytoany 往返）——用户层可见性 = 「重开可见」，非实时。App 运行中不热载外部轮次。

**补全方案（已实施）**：daemon 在消息成功投递到本机会话时发 macOS 系统通知（「@codex:某会话 收到新消息——重新打开该会话可见」），每会话 60 秒节流，`--no-notify` 可关。用户层可见性最终形态 = 系统通知（即时知道）+ 重开会话（App 内完整回看）+ Web Console（实时全景）+ hook 摘要（模型层知情）。实时进入 App UI 待厂商开放注入通道（P3 跟踪）。

## ADR-013 实时通道双模定案：共享 app-server（主）+ tmux 注入（兜底）（2026-08-05，两轮调研+实证）

**背景**：用户否决「通知+重开」体验；官方 `codex inject` 提案 closed not planned；Desktop App 确凿无外部注入路径（single-writer 约束 + #25914 实测失败）。完整调研见 docs/research/research-codex-live-inject.md。

**模式 A（协议模式，主推）**：`anyd live codex` = 起共享 `codex app-server --listen unix://<sock>`（仅 loopback/UDS，绝不绑 0.0.0.0——Origin 实测未鉴权连入风险）+ 以官方参数 `codex --remote <sock>` 启动 TUI 挂上共享运行时。投递走 JSON-RPC `turn/start` / `turn/steer`（in-flight 追加）：协议级可靠、多行无坑、UI 可见（已知 #15320 外部 turn 重绘可能延迟，内容最终出现）。参照实现 kcosr/codex-threads（send/steer/自愈 resume）。

**模式 B（tmux 兜底）**：对未走 --remote 的 tmux TUI 用 load-buffer + paste-buffer -p 注入。已实证可行（R7），但 #4446 实锤流式期间输入会被忽略而非排队——必须 capture-pane 忙碌检测 + 空闲重试，仅作兜底。

**通道矩阵定案**：app-server live（实时/可见/全环境/协议级）＞ tmux 注入（实时/可见/按键级）＞ headless resume（可达，重开可见+通知）＞ 驿站排队（离线）。Desktop App 场景维持 resume+通知+hook 摘要，跟踪 #25914/#17101 等官方动向。用户心智不变：想让哪个会话实时可协作，用 `anyd live codex` 启动它。
