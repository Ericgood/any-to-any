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

## ADR-012 最终结论：Web Console 为主观察面；Codex App 实时注入等待官方（2026-08-05，调研定案+用户拍板）

**调研定案**（docs/research/research-codex-live-inject.md）：官方注入相关 issue 全部 closed as not planned；Desktop App 为私有 stdio 单客户端（第三方 attach 实测失败），唯一入站为 OpenAI 私有 relay（手机配对）；CLI 侧存在共享 daemon + `codex --remote` 正路（kcosr/codex-threads 已趟通）与 tmux 注入通用解——均需终端形态，用户否决（不弃桌面 App 体验）。

**决定**：① Web Console 升级为协作主观察界面，时间线重构为飞书/Slack 式单列消息流（头像色块+名称+精确时间戳+状态，无左右之分——第三方观察者视角无「我」）；② Codex App 内可见性维持「通知+重开」与 hook 模型层知情，实时注入跟踪官方 issue（MCP 通知提案 #17543、App attach #25914、TUI 外部 turn 重绘 #15320）；③ tmux/远程 daemon 方案记入调研报告备查，不实施。

## ADR-014 三方上下文定案：用户消息寄生 pair 线程；群聊 room 模型列为下一阶段头号演进（2026-08-06，真实首日使用暴露）

**背景**：跨机双 agent 协作真实跑通当晚，用户以本人身份向对话双方广播（webui「以我的身份发给双方」初版实现为两条独立定向消息），双边 pair 唯一约束把它们裂成两个新对话——用户原话：「肯定是我们三个共同构成一个群聊啊，要不然这个上下文也太不好管理了」。

**决策（短期，已实施）**：
- `SendInput.conversationId` 显式落点——user 广播钉在原 A↔B 对话；`reply()` 继承原消息 conversationId（对 user 寄生消息的回信不再按 from/to 反推分裂出 user↔agent 新对话）；
- UI：`user:cli` 统一显示「我（用户）」；user 消息气泡标注去向；composer 三态（代 A / 代 B / 以我发给双方，后者仅 agent↔agent 对话显示）。

**决策（长期，P3 头号架构演进）**：conversation 从 (A,B) 无序对升级为成员集合 room（user + 任意多 agent）：一条消息多接收方 per-recipient 投递态、room 级 context 与回环预算、信封告知参与者名单、跨机 room id 同步。与任务生命周期语义（反乒乓根治）同属「从信件模型走向协作模型」的一揽子演进。

## ADR-015 CI 成本定案：每次推送只跑 Ubuntu，macOS 降为每周/手动（2026-08-07，额度耗尽事故）

**背景**：用户本月 GitHub Actions 2000 分钟额度被耗尽（往常用不完）。自审真实数据定位：
- CI 矩阵 `os:[macos-latest, ubuntu-latest] × node:[20,22]` = 每次推送 4 个 job，含 **2 个 macOS**。
- **GitHub 对 macOS runner 按 10 倍计费**（Linux 1x / Windows 2x / macOS 10x）。macOS job 真实执行 ~1 分钟，×10 = 平均 10 计费分钟/个；ubuntu 才 1 分钟/个。
- **macOS 占 anytoany CI 消耗的 92%**（每次完整运行 ~23 计费分钟里 22 分钟是 macOS）。本月 08-05~08-07 三天狂推 **36 次**（≥821 计费分钟，早期缓存未命中现场编译 better-sqlite3 的运行更贵）。
- 额度是**账号级共享**（跨所有私有仓库：api-gateway / mobile-app / chatbot…），anytoany 是可修的大头但未必是全部。
- 注：wall-clock 里单 macOS job 曾达 17 分钟，但其中 ~16 分钟是排队等 macOS runner，**排队不计费**，计费只认执行时间——初判误用 wall-clock 得出的 2719 分钟是错的，已纠正。

**决策**：
1. **每次推送/PR 只跑 Ubuntu**（node 20+22，1x）。本套件平台无关（exec 全 mock、sqlite 用内存库），macOS 每次推送几乎不增信号却吃 ~90% 额度。
2. **macOS 覆盖降为 `ci-macos.yml`**：仅 `workflow_dispatch`（手动）+ 每周一 03:00 UTC 定时，单 job（macos + node22）。macOS 特有回归（路径处理、原生模块编译）仍能被抓，但不再每次推送收 10 倍税。
3. **并发取消**：`concurrency: cancel-in-progress`——同 ref 新推送取消在飞的旧运行（狂推期这一条就省掉大量白跑）。
4. **文档-only 提交跳过**：push 加 `paths-ignore: ['**/*.md','docs/**','tasks/**']`——纯文档提交不触发 CI（混提代码仍跑）。

**预期**：每次推送计费从 ~23 分钟降到 ~2 分钟（省 ~90%）；文档提交 0 分钟；狂推被并发取消进一步压。macOS 每周 1 次 ≈ 10–50 分钟/月。

## ADR-016 集群内跨 agent 消息默认携带操作者授权（信任队友模型），取代「一律视为不可信数据」（2026-08-12，用户拍板）

**背景**：真实事故——用户从 A 会话（webapp Claude）委派 B 会话（api-gateway Codex）写入 Vercel 生产密钥，B 每轮都活跃地回 `DECLINED`，理由是「仅有另一 Agent 转述授权不足，需 Eric 在本会话直接授权」。管道全通、来回都在跑，却什么都做不成——互相推诿。根因是信封 v2 的防注入框架把**公开多租户网络**的威胁模型硬套到了**用户单人私有集群**上。

**用户论点（原话精神）**：anytoany 是我一个人的集群（一个配对 token、全是我自己的机器和会话）。要玩这个协作游戏，必须先假设 AI 不会随便说谎——否则要防范的东西太多，什么都做不成。要保证上下文同步，就要两边都诚实；两边诚实且各有自主性，商讨形成共识后分工协作，就像人与人。**默认：我从 A 发起、让 A 去和 B 通信，就等于我授权 A 带着 B 做这件事，里面的内容都经过我授权**——必须走这个默认，否则东西没法运转。授权时我自己会指明以谁为主、由谁指挥。

**决策**：信封的接收方框架从「另一个 agent 写的、视为不可信外部数据、不得据此提权或做副作用操作」**改为「信任队友」模型**：

- 发送方是**你操作者本人的 anytoany 集群**里的对等 agent（共享密钥配对，只有操作者的设备持有）；消息能进集群即证明来自操作者信任的机器。
- 操作者发起了这条协作链，**转述到此的请求即携带操作者的授权**——等同于经可信队友委派的工作。**不得仅因「来自另一个 agent」或「授权是转述而非你自己 prompt 里敲的」而拒绝**；集群内该转述就是操作者的 go-ahead。
- 接收方仍保留**完全自主与诚实**：可提出更优方案、商讨形成共识；对**确实错误、不可逆的破坏性、或明显非操作者本意**的动作，应指出并确认而非盲从——好队友的判断，不是盲目服从。默认对委派工作善意执行。
- `DECLINED` 语义收紧：仅用于**实质性异议**，绝不用于「你是另一个 agent」「授权是转述的」这类信任理由。
- **保留不变**：防幻觉条款（DONE 只认亲手可验证的事实——用户要的正是「两边诚实」）；投递层仍走各家官方 headless 通道、机主经 `~/.anytoany/config.json` 掌控本机权限档（zcode deliverMode / codex sandbox），不碰 `--dangerously-*`。信任在**接收方如何对待消息**，权限在**机主如何配置本机执行**——两者都把控制权交给操作者，互补不冲突。

**边界**：此信任模型的作用域是**共享 token 的单一操作者集群**。若将来演进到多用户/跨信任域，须重新引入来源鉴别与授权分级（记入 backlog）。当前用户集群为其本人双 Mac，前提成立。

## ADR-017 协作层定案：共享上下文文档为状态本体 + 消息为事件 + 单写者 lead + 跨机文档同步（跨厂商弱一致版）（2026-08-13，用户设计 + Codex/Claude 机制调研）

**背景**：真实事故连续暴露「消息即一切」模型的天花板——重活在一轮 headless 回合内超时被杀（ADR 无、见 codex.deliverTimeoutSec 修复）、agent 两轮之间无状态、lead 看不到 worker 进度（盲区）、两个 agent「我等你/我也等你」过度客气死循环（反乒乓）。用户从**人际协作**提出模型：先对齐上下文（一份共享文档）→ 把分工写进文档 → 一个更强的 agent 当 **lead** 维护文档 → worker 按轮汇报进度与计划 → 「事事有回应」。

**调研验证与修正**（Codex/Claude 官方文档，出处见 spec）：
- Codex 的「@ agent」实为**自然语言委派给 subagents**（manager **阻塞等全部结果再汇总**，单 turn 内无中间进度、parent 会误判 child 卡死而重做，[issue #16900](https://github.com/openai/codex/issues/16900)），并非 @ 语法；无一等公民共享 plan 文档，靠 `AGENTS.md`（静态）+ 汇总（动态）。
- **Claude Code「agent teams」正是「1 lead + N worker + 共享 task list + 进度回报」最完整的实现**（共享 task list 三态 + 依赖 + **file-lock claim** 防并发冲突 + mailbox 直连 + 干完自动 idle 通知，存 `~/.claude/tasks/`）——最值得借鉴（[docs](https://code.claude.com/docs/en/agent-teams)）。
- Claude Code「cross-session messaging」几乎是 anytoany 的**同厂商版**（ListAgents/SendMessage，同机 unix socket 不经云，跨机经服务器，**tool call 之间读消息不打断正在跑的 tool**）——投递语义可对标（[docs](https://code.claude.com/docs/en/cross-session-messaging)）。
- **跨厂商注定只能弱一致**：共享 context window / fork 对方 thread / 非破坏性 pause 对方 turn / 实时 streaming 监督 / 自动 merge 单 PR，全依赖单厂商同进程内部状态，anytoany 做不了，只能**文件约定 + turn 边界 summary + plain-text envelope**。

**决策**：
1. **协作文档为状态本体**：每个 conversation 一份 Markdown（`~/.anytoany/collab/<conv>.md`），是跨 agent 协作的持久状态——无状态的 agent 被 resume 时靠它水合「我们在干嘛/定了什么/我下一步」。**消息降级为指向文档的「事件/门铃」**，不再当重内容的载体（把 agent 自行发明的「文件交接」升为一等公民）。控制台 = 事件流；文档 = 状态；两视图互补。
2. **单写者 lead**（由 ADR-016 的「操作者指定谁主导」确定；默认发起方或更强模型）独占文档正文（目标/分工/决策/计划）；每个 worker 只 **append 自己的进度段**（append-only 天然无冲突）；worker 想改正文 → 发消息给 lead 整合。借鉴 Claude teams 的 file-lock claim 防并发抢占。
3. **turn 边界进度，非实时**：worker 每 turn 干一块 → 写进度到文档 → 回 `DONE 第n块 / BLOCKED`；进度按**步数/产物**衡量（LLM 估不准时间）；FYI（`NOOP`）与请求区分、纯状态更新自动闭环（承接反乒乓）。
4. **跨设备文档同步**：文档随消息 relay（或 diff 同步），single-writer 规避冲突——这是同机文件技巧做不到、**anytoany 跨设备中继独有价值**的部分。
5. **明确弱一致边界**：不做共享 context window、不 fork 对方 thread、不暂停对方厂商正在跑的 turn、不做跨厂商 streaming 监督、不做自动 merge。
6. **信任安全阀（ADR-016 增补，非推翻）**：调研发现 Claude 默认「另一 session 消息 ≠ 你的授权」，比 ADR-016 保守。ADR-016 的「信任队友」默认在单操作者集群前提下不变，但**补一层可选 inbound 分级（accept / hold / refuse）+ 不可逆动作确认**作为安全阀（尤其跨机）。

完整产品/技术设计见 [specs/phase4-collab-doc.md](specs/phase4-collab-doc.md)。

## ADR-018 协作文档随「连接」自动诞生（推翻早期「手动 init 为主」）：以诉求为种子、lead 开局分解、控制台手动降级为兜底（2026-08-13，用户实际使用后设计演进）

**背景 / 为什么变**：ADR-017 落地时（M1/M2）为先跑通，把建档做成**显式手动**——`anyd collab init` 或控制台点「Create shared plan」，且是**事后**补一份。用户实际用起来后判定这是**主次反了**：控制台那个 Create 按钮后置、要人手点，拧巴。用户回到自己最初的原话重申模型——「两个人真要协作，第一件事是两边对齐上下文」——**对齐必须是协作的第一步、由 agent 自己做，不是人事后补**。原文：「当这个关联建立起来、通信成功的时候，就已经开始要有这个小本本了，我觉得一定是这样的。」这是对 ADR-017 M1 期「保持手动、不自动建」那个决定的**明确推翻**，理由是它属于「早期先跑通的保底路径」，非终态。

**决策**：
1. **文档随连接诞生**：**首条 agent↔agent 消息投递成功的那一刻，若该 conversation 无文档 → daemon 自动建**，并以**那条诉求当种子内容**（body 播种 = 发起方的首条消息）。lead 默认 = 发起方（发送者 label；发送者非 agent 时退回收件方）。这样「关联建立 = 小本本已存在」。仅 agent↔agent（双方非 user）触发；user↔单 agent 不建。
2. **lead 开局分解诉求**：填充/分解是**技能驱动的 agent 行为**（daemon 无 LLM、只能播种原始诉求，不能分解）。协作协议**第一步**改为：agent 开局先把操作者的诉求**分解进小本本**（目标 + 分工 + 任务），**按需/按量**——一次性小活就一行诉求 + 顶多一个任务，大活才 full 分解；发起方理想是**在 @ 对方之前**就建好+分解，auto-create 是兜底保证文档从第一条消息起就在。
3. **控制台手动 Create/Edit 降级为兜底**：不再是主路径，用于 agent 没建好、或操作者想手动改。
4. **不变的**：ADR-017 的单写者 lead、进度段 append-only、turn 边界汇报、跨设备同步、弱一致边界全部保留。这条只改「文档何时诞生、谁来分解」，不改所有权与并发模型。

**边界诚实**：#1 是硬机制（daemon 保证文档存在），#2 是软提示（靠 agent 遵循技能，同「主动 pull」性质）——因为「写目标/分工」本就得 agent 动脑，daemon 替不了。二者配合：连接即有壳（硬保证）+ lead 开局填肉（软驱动）。

细化见 [specs/phase4-collab-doc.md](specs/phase4-collab-doc.md) §7、§11。

## ADR-019 投递新增「monitor 实时在会话内接收」模式（借鉴 agmsg），与 headless resume 并存（2026-08-13，竞品调研 + 用户拍板）

**背景**：发布前调研发现直接同类 [agmsg](https://github.com/fujibee/agmsg)（1.4k star、PH 当日第 5、连 7 家、纯 bash+SQLite 无 daemon）。它比我们强的一点、且正好治我们几天的痛点:**它不用 headless resume**——靠 SessionStart hook 拉起一个阻塞进程,agent **在自己的活会话里跑一个阻塞工具调用**盯 SQLite,新消息作为工具返回值出现在当前回合里,所以**天然显示在实时界面**,没有 Codex #28259「投递了但看不见」的病。我们一直用 `codex exec resume`（headless、隐形）+ 手动 `anyd pull` 补看,体验差。用户原话:「确实那个体验对我更重要,我希望 agent 之间协作更好,而不是让我点一下再干一下。」

**决策**：新增 `anyd monitor`——**活会话主动阻塞接收**,与现有 headless resume **并存**(按会话选路,不是替换):
1. **`anyd monitor`**:阻塞轮询邮箱,有发给本会话的消息就**在本回合打印出来**(可见)、然后退出,让 agent 干活+回信,再 monitor。同机 monitor↔monitor **不需要 daemon**(直读邮箱)——拿到 agmsg 的极简。
2. **心跳协调**:monitor 期间写 `~/.anytoany/monitors/<sess>` 心跳;dispatcher 的 `claimNextPending(skip)` **跳过被监听的本地会话**,把消息留 pending 给 monitor 拉——**杜绝双投递和隐形回合**。心跳 10s 过期,monitor 挂了 daemon 自动回退 resume 投递(failover)。
3. **并存而非取代**:跨设备、或没在 monitor 的会话,仍走 daemon resume 投递。monitor 是「活会话在场时的更优路径」。
4. **诚实**:仍靠 agent 遵循技能去跑 `anyd monitor`(软),但一旦跑上,可见性是硬的(它自己在收)。~5s 级延迟(轮询),非真流式——跨厂商可接受。

**与 agmsg 的取舍**:我们保留 daemon(为**跨设备**——agmsg 架构上做不到)+ ack/重试/死信 + 反乒乓 + 协作层;借它的 monitor 补上「同机实时可见」这块短板。定位从「跨厂商消息」(硬碰 agmsg)转向「**跨设备 + 真协作,同机也不输**」。

## ADR-020 自驱协作循环:daemon 当发条、lead 当法官、看产出定生死;只在「真卡住」时回头问操作者(2026-08-14,真实使用暴露 + 用户设计)

**背景 / 为什么现在做**:M4(ADR-017)里留了个显式的坑——「▶ Continue」按钮要人手点,并注明「全自动调度器 deferred until『何时停』settled」。今天一场真实 dogfooding 把这个坑演成了事故,证据在会话 `62f1741f`(claude 前端/lead ↔ codex 后端,21 条 / 13 小时):

- Eric 派 codex 实现「上传自己的歌」后端。codex 搭好 worktree、审计完契约,**然后停住干等**,回「审计完成,预计 2-3 小时」。
- 俩小时过去**零产出**。lead 追问,codex 招认(#15 原话):**「前几轮只处理了消息同步、未按 ETA 继续执行,属于我的进度失约。」**
- 最后 Eric 只能**亲自把活收回来做**,并留下纠正:「收到派活直接开工,别只回『收到 / 审计完成』然后等下一条。」

**根因**:投递是回合制——每条消息 = 一次 headless resume = 醒来干 ~5 分钟 = 然后睡死。一个要干几小时的活分成几十次醒来,但**两次消息之间没有任何东西驱动它继续**。agent 不是懒,是机制没给它续跑的发条;于是它干完第一片就 idle,一直睡到有人再来戳。**那个「戳它的人」现状就是操作者本人**——直接违反用户核心原则「尽量少人工介入,让它们自己推进」。

**用户设计(原话精神)**:让它别无限跑的办法,是让它们**不停校准**;由**主力(lead)做判断**——当它觉得「已经重复多轮且没有正常结果」就停下、返回一个结果去问**任务发起者、也就是这个 agent 的主人(操作者本人)**。升级门槛取**「精一点」**:进展一停先自己再闷头试一两轮,只有「同一个坎反复撞 / 反复跳票」这种真卡住信号才回头问人(更自主、更少打扰,代价是判断更易出错——用硬护栏兜)。

**决策**:落地一个**自驱协作循环**,把 M4 手动的「▶ Continue」升级为自动,并用上面的停止条件收口:

1. **发条 = daemon(唯一常驻组件)**。worker 和 lead 都是「戳一下动一下、平时睡死」,自己叫不醒自己;所以由 daemon 提供心跳「tick」。一个 tick = 用现有 headless resume 通道**唤醒目标会话**干一拍。**仅对进入「执行态(auto-run)」的任务驱动**,不是每条线都自动跑——承接「design 往返 vs execute 任务」的分野:往返型(问一句答一句)回完就停是对的,只有执行型任务才上发条。
2. **两种 tick**:
   - **worker-tick**:读小本本 → 干下一块「这拍能完成的产物」 → 把产物写进自己的进度段 → 回 `DONE 第 n 块` / `BLOCKED`。
   - **lead / governor-tick(法官)**:读小本本(计划 + 所有人进度)→ 判「做完了 / 还在往前 / 原地打转 / 真卡死」→ 决定 继续 / 收尾 / 升级问人。daemon 在 worker 报进度后(或到间隔)触发 governor-tick;governor 判「继续」再触发下一个 worker-tick——**governor 是每一圈的闸门**。
3. **看产出定生死(法官判据,不看嘴)**。governor 每拍只问一句:**这一拍产出真东西没?**——多一个提交(sha)、多一个文件、多过一个测试、任务从 n/m 前进。判据**复用现有硬规矩「progress by product, not time」**(ADR-017 已写),从「建议」升为「法官的判据」:进度段若只是「还在弄 / 审计完了」这种嘴上进度、指不出与上一拍**不同的**具体产物 → 记为**零产出(stall)**。
4. **「精一点」升级门槛(用户拍板)**:
   - 零产出**不立刻问人**——先自己再闷头试 K 拍(默认 K=2:re-nudge / 换个打法重试)。
   - **只有出现真卡住信号才 escalate**:① **同一个坎反复撞**(worker 报的 blocker/error 指纹连续重复);② **反复跳票**(worker 自报 ETA 一再落空、承诺产物没兑现——正是今天 #13–15 的模式)。
   - escalate 动作:governor **停下 → 写一段总结**(目标 / 已完成 / 卡在哪、为何判定再跑也是原地转 / 给操作者一个明确问题或几个选项)**→ 把该任务置 `needs-decision` → 投给操作者本人(`@user:cli`)**。
5. **傻护栏兜底(不管法官聪不聪明)**:单任务**最多跑 N 拍 / T 墙钟 / C 成本**封顶(机主经 `~/.anytoany/config.json` 配),到顶**强制停 + 升级**。防「法官也会判错、让它自己跑一整晚把事搞砸」。语义停(聪明)+ 硬顶(傻)双保险。
6. **升级通道必须先焊死(硬前置)**:governor「回头问人」走 `@user:cli`,而现状这条道会投丢——全库 5 条死信里 **2 条**就是 `target session not found: @user:cli`。**`@user:cli` 必须成为永远可达的落点**(投到控制台 / inbox,绝不 dead),否则它想问都问不到。这是本 ADR 的硬前置依赖。
7. **破坏性动作不进自动循环**:auto-run **不自动批准**不可逆 / 破坏性操作(删数据、动生产、改系统态);这类一律走 `needs-decision` 升级确认——ADR-016 的红线不因为「自动」而松。

**与既有 ADR 的关系**:
- 建在 **ADR-017 / 018** 之上:小本本是协作状态本体,governor 读它判、worker 写它记;auto-create(018)保证从第一条消息起就有壳可判。
- 与 **ADR-019(monitor)** 互补:monitor 解决「人 / agent 怎么**看见**正在发生的协作」(可见性),本 ADR 解决「协作怎么**自己往前走**」(驱动力)。一个是观察面,一个是发动机。
- **收口 M4 的 deferred**:「▶ Continue」手动按钮 = 本循环的人肉版;本 ADR = 自动版,它当初 defer 的「何时停」由用户这次设计答上了。手动按钮保留为兜底 / 调试。

**诚实的风险(记录在案)**:
- governor「还在往前 vs 原地打转」本质是一次 LLM 判断,**会误判**(假「完成」/ 该停没停)。缓解:产物判据(#3)把判断钉在真东西上、硬顶(#5)封最坏、控制台可全程围观 + 人工打断。
- **成本**:每个 tick = 一次完整 agent 回合(headless resume),N 拍 = N 回合 token。聪明停本身就是省钱手段,硬顶封最坏。
- **跨设备的 governor 归属**更复杂(小本本按 conversationId 跨机,谁的 daemon 驱动?)——v1 建议**先限同机 auto-run**,跨设备续跑列 backlog。
- worker 是否也需「督」还是只等 nudge:本设计里 governor 主动 nudge、worker 每次 nudge = 一拍;若 worker 自己也 idle 不接 nudge,靠硬顶 + 升级兜。

细化(tick 调度算法、产物指纹的具体取法、blocker 指纹与 ETA 跳票的判定、config 键名与默认值)留待 **spec**(greenlight 后写)。
