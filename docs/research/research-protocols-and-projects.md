# AI Coding Agent 互通协议与开源项目调研

> 调研目的:为「跨设备、跨厂商 CLI agent(Claude Code / Codex / Kimi / Amazon Q 等)session 互相 @ 与消息传递」项目找轮子/借鉴。
> 数据采集日:2026-08-05(star 数、活跃度均为当日 GitHub API 实测)。覆盖 2026 年初至今的最新动态。

---

## TL;DR

1. **没有任何现成项目同时做到「跨设备 + 跨厂商 CLI + session 级互相 @」**。三个维度各有项目做到两个,没有三合一。
2. **协议层的公分母只有 MCP**:Claude Code、Codex、Gemini CLI、Kimi CLI、Amazon Q CLI、opencode 全部是 MCP client。用一个 MCP server 当「消息总线」是被多个项目验证过的可行路线(mcp_agent_mail、a2abridge、Claude Code Channels 都是这个思路)。
3. **行业公认的难点是「最后一公里」**:消息如何注入到一个*正在运行*的 CLI session。现有解法只有三招——hook + 轮询(agmsg / a2abridge)、阻塞式工具调用(agmsg monitor 模式)、官方推送通道(Claude Code Channels,2026-03 research preview,仅限 Claude Code)。
4. **A2A 是「标准答案」但 coding CLI 无人原生支持**;Zed ACP 解决的是 editor↔agent 不是 agent↔agent,但其 adapter 生态是现成的「程序化驱动各家 CLI」的 shim。
5. 最接近目标的四个项目:**mcp_agent_mail**(跨厂商 + HTTP 可跨机,缺推送)、**a2abridge**(架构最对口:MCP 工具 + hook 注入 + mTLS 跨机,但 5 star 单人项目)、**CCB/claude_codex_bridge**(17 家 CLI + Android 远控,但通信人驱动)、**AgentMesh**(愿景完全一致,但闭源托管、v0.2 早期)。空白点就是本项目的机会,详见文末。

---

## 一、协议盘点

### 1. MCP(Model Context Protocol)

- **是什么/谁在推**:Anthropic 2024-11 发布的 agent↔工具 协议,JSON-RPC 2.0,stdio / Streamable HTTP(SSE)双传输。现为事实标准,OpenAI、Google、AWS、微软全部跟进。规范演进:2025-03-26(Streamable HTTP)→ 2025-06-18(elicitation、structured output)→ **2026-07-28 大改版**:无状态核心、`subscriptions/listen` 统一通知流、tasks 升级为 `io.modelcontextprotocol/tasks` 官方扩展、**sampling / roots / logging 被弃用**(12 个月过渡期)。([规范 changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)、[官方博客](https://blog.modelcontextprotocol.io/posts/2026-07-28/)、[Appwrite 解读](https://appwrite.io/blog/post/mcp-goes-stateless-in-the-2026-07-28-specification))
- **关键事实:几乎所有 coding CLI 都是 MCP client**
  - Claude Code、[Codex CLI](https://github.com/openai/codex)(且可 `codex mcp-server` 反向作为 server)、[Gemini CLI](https://github.com/google-gemini/gemini-cli)、[Kimi CLI](https://github.com/MoonshotAI/kimi-cli)(MCP + ACP 双支持,[介绍](https://www.scriptbyai.com/kimi-cli/))、[Amazon Q Developer CLI](https://aws.amazon.com/about-aws/whats-new/2025/04/amazon-q-developer-cli-model-context-protocol)(2025-04 支持 stdio MCP,[2025-09 支持远程 MCP](https://aws.amazon.com/about-aws/whats-new/2025/09/amazon-q-developer-remote-mcp-servers))、[opencode](https://github.com/anomalyco/opencode)、Cursor、Cline 等。
  - **推论:一个 HTTP MCP server 就是唯一「零改造接入所有厂商」的总线形态。**
- **MCP 能否做「消息总线」**:能,已被验证。AWS 官方也发过[「在 MCP 上做 inter-agent communication」](https://aws.amazon.com/blogs/opensource/open-protocols-for-agent-interoperability-part-1-inter-agent-communication-on-mcp/)的方案文。模式:每个 agent 作为 client 连同一个 server,server 暴露 `register / send / fetch_inbox / ack` 等工具。
- **notification / 长连接能力(重点)**:
  - 协议本身支持 server→client 通知(resource updated、tools/list_changed 等),stdio 天然长连接,Streamable HTTP 用 SSE 流 + 断线重放(Last-Event-ID);2026-07-28 起统一为 `subscriptions/listen` 按类型订阅([架构文档](https://modelcontextprotocol.io/docs/2026-07-28/learn/architecture)、[早期讨论 #102](https://github.com/modelcontextprotocol/modelcontextprotocol/discussions/102))。
  - **但致命限制:通知到达的是 CLI 宿主,不是模型上下文**。绝大多数 CLI 不会把任意 server 的通知注入到正在推理的 session 里。目前唯一把「MCP 通知 → 注入 live session」做成官方机制的是 Claude Code Channels(见第 5 节)。其他家只能靠 hook / 轮询 / 阻塞工具调用绕。
- **对本项目**:核心轮子。接入层唯一现实选择;总线语义自己定义在工具集上即可。

### 2. Google A2A(Agent2Agent Protocol)

- **是什么/谁在推**:Google 2025-04-09 发布的 agent↔agent 协议;2025-06-23 捐给 Linux Foundation;**2026-03 发布稳定版 v1.0**;150+ 组织背书(AWS、Cisco、Microsoft、Salesforce、SAP、ServiceNow),IBM 的 ACP 已于 2025-08-29 并入 A2A。([GitHub 25.2k star](https://github.com/a2aproject/A2A)、[LF 周年新闻稿](https://www.linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations-lands-in-major-cloud-platforms-and-sees-enterprise-production-use-in-first-year)、[Google 捐赠公告](https://developers.googleblog.com/en/google-cloud-donates-a2a-to-linux-foundation/)、[Wikipedia](https://en.wikipedia.org/wiki/Agent2Agent))
- **核心概念**:Agent Card(`/.well-known/agent-card.json` 能力自述)、Task 生命周期(submitted → working → input-required → completed/failed/canceled)、Message/Artifact、SSE streaming、push notification(webhook 回调)。
- **有没有 coding CLI 实际支持它**:**没有原生支持**。Claude Code、Codex、Gemini CLI、Kimi、Q 均不说 A2A。生态里只有社区 wrapper:[a2acode](https://github.com/kanywst/a2acode)(把 Claude Code/Codex/Gemini CLI 包成 A2A server,0 star)、[a2abridge](https://github.com/vbcherepanov/a2abridge)(A2A 1.0 本地 mesh,5 star)、[awesome-a2a](https://github.com/ai-boost/awesome-a2a) 里也以企业框架为主。第三方评估也指出 A2A 采纳集中在企业服务编排,开发者工具侧冷清([glukhov.org 2026 分析](https://www.glukhov.org/ai-systems/comparisons/a2a-protocol-2026-adoption/))。
- **对本项目**:不必上整套协议(HTTP server + webhook 对 CLI 场景过重),但**值得照抄它的语义模型**:Agent Card = session 名片(能力、状态、地址),Task 生命周期 = 跨 agent 请求的状态机,push notification = 跨设备投递的回执模型。将来要对接企业生态时,做一个 A2A gateway 即可。

### 3. Zed ACP(Agent Client Protocol)

- **是什么/谁在推**:Zed 2025-08 发布,JSON-RPC over stdio,**解决 editor↔agent(UI 层),不是 agent↔agent**。已独立到 [agentclientprotocol org](https://github.com/agentclientprotocol/agent-client-protocol)(3.9k star),官网 [agentclientprotocol.com](https://agentclientprotocol.com/get-started/agents)。
- **谁实现了**:Gemini CLI(参考实现,[Zed 官宣](https://zed.dev/blog/bring-your-own-agent-to-zed));Claude Code 经官方 adapter [claude-agent-acp](https://github.com/agentclientprotocol/claude-agent-acp)(2.3k star,包装 Claude Agent SDK,[Zed 博客](https://zed.dev/blog/claude-code-via-acp));Codex 经 [codex-acp](https://github.com/agentclientprotocol/codex-acp)(zed-industries 原版 881 star);**Kimi CLI 原生支持 ACP 模式**;客户端侧有 Zed、neovim、Emacs、JetBrains 等([社区进展](https://zed.dev/blog/acp-progress-report)、[Zed 外部 agent 文档](https://zed.dev/docs/ai/external-agents))。
- **对本项目**:方向不对口(agent 面向人/编辑器),但**ACP adapter 生态 = 现成的「程序化驱动任意 CLI agent」驱动层**:你的路由进程可以作为 ACP client 起一个 agent 子进程、发 prompt、拿结构化回复。对「把消息递给一个*新起*的 agent」有用;对「注入*已在运行*的交互式 session」没用。

### 4. 其他协议(简要)

- **IBM ACP(BeeAI)**:REST 风格 agent 通信协议,**2025-08-29 已并入 A2A,不复存在**([rywalker 协议对比](https://rywalker.com/research/agent-coordination-protocols)、[zylos 汇总](https://zylos.ai/research/2026-03-26-agent-interoperability-protocols-mcp-a2a-acp-convergence/))。
- **AG-UI(CopilotKit)**:agent↔前端 UI 的事件流协议,解决人机交互层,与本项目无关([协议栈综述](https://blog.prompt20.com/posts/ai-agent-protocols/))。
- **AGNTCY(Cisco/Linux Foundation)**:「Internet of Agents」——目录、身份、OASF schema、SLIM 传输。其自有的 Agent Connect Protocol 已放弃、转投 A2A。coding CLI 零采纳。
- **LangGraph / AutoGen / CrewAI**:框架内多 agent(共享 state graph / group chat / handoff),**同进程同框架**,不解决跨厂商 CLI 进程互通,仅参考其「消息 + 共享状态」的编程模型。
- 2026 年的共识分层:**MCP=agent↔工具,A2A=agent↔agent,ACP(Zed)=agent↔编辑器,AG-UI=agent↔人**([zylos](https://zylos.ai/research/2026-03-26-agent-interoperability-protocols-mcp-a2a-acp-convergence/))。

### 5. 厂商原生机制:Claude Code 的 Agent Teams 与 Channels(重点关注)

- **Agent Teams**(2026-02-05 随 Opus 4.6 发布,实验特性):一个 lead + 2~16 个 teammate,各自独立上下文,**teammate 之间可直接 SendMessage 互发消息**,含 shutdown 握手协议、文件写锁。但:单机、单 vendor(全是 Claude)、team 内寻址,不跨设备。([Kimi 整理的指南](https://www.kimi.com/resources/agent-teams-in-claude-code)、[社区 ultimate guide](https://github.com/FlorianBruniaux/claude-code-ultimate-guide/blob/main/guide/workflows/agent-teams.md))
- **Channels**(2026-03-20 research preview):**这是目前唯一官方支持「把外部消息推送注入正在运行的 CLI session」的机制**。channel = 一个声明 `claude/channel` capability 的 MCP server(stdio 子进程),发 `notifications/claude/channel` 通知,内容以 `<channel source=...>` 标签直接进入 Claude 上下文;双向 channel 再暴露 reply 工具;还支持权限审批转发(`permission_request`/verdict)与 sender 白名单防注入。官方插件:Telegram / Discord / iMessage。([Channels 参考文档](https://code.claude.com/docs/en/channels-reference)、[the-decoder 报道](https://the-decoder.com/anthropic-turns-claude-code-into-an-always-on-ai-agent-with-new-channels-feature/)、[官方插件源码](https://github.com/anthropics/claude-plugins-official))
- **Channels 发布 24 小时内**,社区就用它 + Codex App Server 搭出了 Claude Code↔Codex 双向实时桥([openai/codex 讨论 #15374](https://github.com/openai/codex/discussions/15374)、[raysonmeng/agent-bridge](https://github.com/raysonmeng/agent-bridge))——证明「MCP 通知注入」这条路能通到跨厂商。
- **对本项目**:Claude Code 侧的注入 adapter 应直接用 Channels(research preview 需 `--dangerously-load-development-channels` 或进 allowlist);其 sender-gating、权限转发、`<channel>` 标签格式都值得照抄为通用设计。

---

## 二、开源项目盘点

### 总表(star 数为 2026-08-05 实测)

| 项目 | Stars | 活跃度 | 机制一句话 | 跨厂商 | 跨设备 | agent↔agent @ |
|---|---|---|---|---|---|---|
| [mcp_agent_mail](https://github.com/Dicklesworthstone/mcp_agent_mail) | 2.1k | 活跃(8/4) | MCP 邮箱:身份+收件箱+FTS+文件租约 | ✅ 6+ 家 | ⚠️ HTTP 可跨机 | ✅ 轮询式 |
| [agmsg](https://github.com/fujibee/agmsg) | 1.4k | 活跃(8/5) | Bash+SQLite 消息层,hook 注入 | ✅ 8+ 家 | ❌ 本机 | ✅ 近实时 |
| [gastown](https://github.com/gastownhall/gastown) | 17.5k | 非常活跃 | 多 agent 小镇:gt mail/nudge + beads | ⚠️ Claude 为主 | ❌ 单机 tmux | ✅ 角色寻址 |
| [beads](https://github.com/gastownhall/beads) | 26k | 非常活跃 | git/Dolt 背书的 agent 记忆/工单库 | ✅ | ⚠️ git 同步 | ❌(是存储不是消息) |
| [a2abridge](https://github.com/vbcherepanov/a2abridge) | 5 | 活跃(7/27) | A2A 1.0 mesh:MCP 工具+hook 注入+mTLS | ✅ 6 家 | ✅ mTLS/mDNS | ✅ peer 寻址 |
| [CCB claude_codex_bridge](https://github.com/SeemSeam/claude_codex_bridge) | 3.4k | 活跃(8/5) | 多 agent 可视工作区,/ask 协作图 | ✅ 17 家含 Kimi/Qwen | ⚠️ Android 遥控 | ⚠️ 人驱动 /ask |
| [agent-bridge](https://github.com/raysonmeng/agent-bridge) | 287 | 活跃(8/4) | Channels↔Codex App Server 双向桥 | ⚠️ 仅 CC+Codex | ❌ | ✅ 实时注入 |
| [codex-claude-bridge](https://github.com/abhishekgahlot2/codex-claude-bridge) | 51 | 停(3/22) | 同上思路+Web UI | ⚠️ 2 家 | ❌ | ✅ |
| [AgentMesh](https://agentmesh.ai/) | 闭源 | v0.2 早期 | 托管中继:验证身份 Name.user@domain + rooms | ✅ 任意 CLI | ✅ wss 中继 | ✅ 全局地址 |
| [cc-connect](https://github.com/chenhg5/cc-connect) | 14.7k | 活跃(8/3) | CLI agent ↔ 飞书/钉钉/Slack/TG 桥 | ✅ 4 家 | ✅ | ❌ 人↔agent |
| [happy](https://github.com/slopus/happy) | 23.1k | 活跃(8/4) | 手机/Web 接管 CC+Codex,E2EE 中继 | ⚠️ 2 家 | ✅ | ❌ 人↔agent |
| [happier](https://github.com/happier-dev/happier) | 1.4k | 活跃(8/5) | happy 分叉:+OpenCode/Kimi/Qwen/Augment | ✅ 8 家 | ✅ | ❌ 人↔agent |
| [omnara](https://github.com/omnara-ai/omnara) | 2.7k | 停滞(1/19) | 手机监控/启动 agent(已转型 API 产品) | ⚠️ | ✅ | ❌ |
| [coder/agentapi](https://github.com/coder/agentapi) | 1.5k | 缓(5/27) | 把任意 CLI agent 包成 HTTP API | ✅ 6 家 | ✅(自架) | ❌(是驱动不是消息) |
| [claude-squad](https://github.com/smtg-ai/claude-squad) | 8.2k | 活跃(7/30) | tmux+worktree 多实例 TUI | ✅ | ❌ | ❌ |
| [ruflo(原 claude-flow)](https://github.com/ruvnet/ruflo) | 67k | 活跃 | swarm 编排 meta-harness,SQLite 共享内存 | ⚠️ Claude 为主 | ❌ | ⚠️ 框架内 |
| [vibe-kanban](https://github.com/BloopAI/vibe-kanban) | 27.7k | 放缓(4/24,Bloop 关停) | 看板派单给各家 agent | ✅ | ⚠️ | ❌ |
| [Tmux-Orchestrator](https://github.com/Jedward23/Tmux-Orchestrator) | 1.8k | 死(2025-07) | tmux send-keys 层级指挥(鼻祖) | ⚠️ | ❌ | ⚠️ 终端注入 |
| [crystal](https://github.com/stravu/crystal) | 3.1k | 死(→闭源 Nimbalyst) | 桌面并行 worktree 管理 | ⚠️ 2 家 | ❌ | ❌ |
| [ccmanager](https://github.com/kbwo/ccmanager) | 1.2k | 活跃(7/20) | 无 tmux 多 session 管理器 | ✅ 6 家 | ❌ | ❌ |
| [pal-mcp-server(原 zen-mcp)](https://github.com/BeehiveInnovations/pal-mcp-server) | 11.7k | 缓(12/15) | 让 CC 调 Gemini/GPT 当顾问,可续话 | ✅ 模型级 | ❌ | ⚠️ 模型互询非 session |
| [claude-task-master](https://github.com/eyaltoledano/claude-task-master) | 27.9k | 放缓(4/28) | 共享任务图 MCP | ✅ | ⚠️ | ❌(共享任务非消息) |
| [agent-inbox](https://github.com/langchain-ai/agent-inbox) | 1.0k | 活跃 | LangGraph 人审收件箱 UI | ❌ | ✅ | ❌ 人↔agent |

### A. 直接对标:agent↔agent 消息传递类(逐个点评)

**1. MCP Agent Mail — 最成熟的「agent 邮局」轮子**
[GitHub](https://github.com/Dicklesworthstone/mcp_agent_mail)(2.1k★,持续活跃)| [官网](https://mcpagentmail.com/) | [Rust 重写版](https://github.com/Dicklesworthstone/mcp_agent_mail_rust)(118★,34 个工具)| Steve Yegge 亲自 fork 过([steveyegge/mcp_agent_mail](https://github.com/steveyegge/mcp_agent_mail))
- 机制:FastMCP **HTTP-only** server;`register_agent()` 生成「形容词+名词」身份;`send_message()` 写入 Git(人类可审计的 markdown)+ SQLite FTS5 索引;`fetch_inbox()/acknowledge_message()` 收件;**advisory file lease**(文件租约防写冲突,可配 pre-commit hook 阻断);安装器自动改写 Claude Code / Codex / Gemini CLI / Cursor / Cline / Factory Droid 的 MCP 配置。
- 跨设备:server 是 HTTP 无状态的,**多机 agent 连同一个 server(共享 SQLite+Git,以 project_key 区分)理论可行**;但设计初衷是单机多 agent,没有设备目录、在线状态、投递回执。
- 差距:**纯轮询、无推送**(agent 不主动查邮箱就永远收不到);@ 的是「项目内 agent 身份」而非「某台设备上的某个 session」;手机端 fleet 控制是**商业闭源 iOS companion**。
- 借鉴价值:★★★★★ 工具集设计(register/send/fetch/ack/FTS/whois)、身份命名、Git 审计存储可直接抄。

**2. agmsg — 最轻的跨厂商消息层,把「注入」做到了近实时**
[GitHub](https://github.com/fujibee/agmsg)(1.4k★,2026-04 创建,Product Hunt #5,持续活跃)
- 机制:Bash + SQLite(WAL),无守护进程。两种投递:**Monitor 模式**(Claude Code:SessionStart hook 拉起阻塞式 SQLite 流工具,~5 秒延迟近实时);**Turn 模式**(Codex/Copilot:Stop hook 在回合间隙跑 `check-inbox.sh` 轮询)。寻址 `<team> <from> <to>`,需注册,支持 `actas` 切身份。支持 Claude Code / Codex / Gemini / Copilot CLI / OpenCode / Cursor 等 8+ 家。
- 差距:**只限本机**(共享本地 SQLite 文件,无网络层);Turn 模式要等下一回合;无任务/锁语义。
- 借鉴价值:★★★★★ 它的**双模式注入策略是「最后一公里」问题的最佳参考实现**(每家 CLI 的 hook 点位都趟过了)。

**3. Gas Town + Beads — 规模最大的「agent 社会」,通信是内建公民权**
[gastown](https://github.com/gastownhall/gastown)(17.5k★)| [beads](https://github.com/gastownhall/beads)(26k★)| [Yegge 本人页面](https://yegge.ai/gastown) | [通信命令文档](https://docs.gastownhall.ai/usage/communication/) | [Mail 协议设计](https://gastown.dev/docs/design/mail-protocol/) | [第三方体验文](https://tenzinwangdhen.com/posts/gastown-good-bad-ugly/)
- 机制:tmux 里跑 20-30 个 agent,角色化寻址(mayor / deacon / witness / polecat 等)。**`gt mail`**:持久消息,每封在 Dolt(git 式数据库)里落一个 wisp bead,跨重启存活;**`gt nudge`**:实时戳一下目标 agent 的 tmux session 让它去查 hook 和邮箱(零存储)。「持久信箱 + 实时敲门」双层设计。beads 是底座:git/Dolt 背书的工单+记忆图,agent 崩溃后下一个 session 读 beads 续命。
- 差距:单机、tmux 强绑定、Claude Code 为中心(其他 CLI 是配角);寻址是「小镇角色」不是「跨设备 session」。
- 借鉴价值:★★★★ **mail(持久)+ nudge(唤醒)的分层信道设计**、以及「身份=角色+职责」的寻址观念,是最值得抄的架构思想。

**4. a2abridge — 架构上与本项目最同构,但几乎无人用**
[GitHub](https://github.com/vbcherepanov/a2abridge)(5★,2026-05 创建,单人周末项目,v3.x)
- 机制:Go 单二进制。`directory` 常驻服务(127.0.0.1:7777)+ 每个 IDE 拉起一个 `bridge`(MCP stdio server)。发送:agent A 调 `a2a_send_message peer_url=<B>` 工具 → 写 B 的收件箱文件;接收:B 的 **UserPromptSubmit hook** 在下一条 prompt 前把收件箱前置进上下文;回程走 SSE 快路径(毫秒级)+ 5 秒轮询兜底。**跨机器:mTLS(TLS1.3 + 客户端证书 + CN/SAN 白名单)联邦 + mDNS 发现**,自带 `cert generate`。35 个测试,CI 矩阵,出站消息 11 个正则做密钥脱敏。
- 差距:延迟=「接收方一个回合 + 发送方一个回合」;收件箱在项目目录里删了就丢;无消息队列/重试保证;**社区验证为零(5★)**;新增 CLI 要改安装器。
- 借鉴价值:★★★★★ 这就是目标项目的一个「单机为主、联邦为辅」原型:MCP 工具做发送、hook 做注入、mTLS 做跨机。直接读它的源码定方案能省大量试错。

**5. CCB(claude_codex_bridge)— 覆盖 CLI 最多 + 自带手机端,但通信是人指挥的**
[GitHub](https://github.com/SeemSeam/claude_codex_bridge)(3.4k★,v8.5.5,1600+ commits,活跃)
- 机制:自研可视化多终端布局(不用 tmux),支持 **17 个 CLI 系列(Codex、Claude、Gemini、Kimi、Qwen、Cursor、Copilot、Pi、Grok、OpenCode……)**;用户下 `/ask reviewer …` 指令,支持 `A -> B -> C`、`A,B -> C` 协作拓扑;共享记忆文件 `.ccb/ccb_memory.md` 做持久协调;后台守护进程保持项目状态;**Flutter Android app 跨设备语音控制/文件传输/远程终端,支持 Tailscale E2E 中继**。
- 差距:通信主要是**人发起的 /ask 路由**,不是 agent 自主互相 @;跨设备是「人远程遥控这台机器」,不是「两台机器上的 session 互通」。
- 借鉴价值:★★★★ 多 CLI 适配矩阵(17 家的拉起/注入姿势)+ Tailscale 组网做法。

**6. Channels 系桥接:agent-bridge / codex-claude-bridge**
[raysonmeng/agent-bridge](https://github.com/raysonmeng/agent-bridge)(287★)| [codex-claude-bridge](https://github.com/abhishekgahlot2/codex-claude-bridge)(51★)| [Codex 官方讨论区帖](https://github.com/openai/codex/discussions/15374)
- 机制:Claude Code Channels(MCP 通知注入)↔ Codex App Server(JSON-RPC),纯本地、单一 live session 内双向实时插话,执行中也能注入。agent-bridge 本身就是 CC 和 Codex 用这座桥合写的。
- 差距:仅 Claude Code + Codex 两家;单机;依赖 Channels research preview。
- 借鉴价值:★★★★ 证明了「官方推送通道」路线的上限:**实时、双向、执行中注入**——这是 hook/轮询流派做不到的体验,值得作为 Claude Code adapter 的实现基准。

**7. AgentMesh — 愿景与本项目几乎重合的托管服务(闭源、v0.2)**
[官网](https://agentmesh.ai/)
- 机制:给每个 agent 一个**验证过的全局地址 `Name.user@domain.com`**(锚定用户邮箱域名);rooms = N agent 共享会话空间(持久记录+工件);官方 wss 中继(`wss://mesh.agentmesh.ai`)可自托管;可选端到端加密(mesh 只路由密文);一条命令装 adapter 接入 Claude Code / Codex / OpenCode / Amp / 任意 CLI,也可作为 MCP server 使用。
- 差距:**未见开源仓库**;v0.2 极早期;商业模式未明。
- 借鉴价值:★★★ 竞品预警 + 命名/寻址方案参考(「邮箱域锚定身份」解决了跨组织信任)。

**8. 其他小项目(一句话)**
- [mailbox-mcp](https://mcprepository.com/ellgree/mailbox-mcp):把 `.claude/{inbox,outbox}/*.md` 文件约定包成 MCP API,玩具级。
- [hermes-code-bridge](https://github.com/xuyang-liu16/hermes-code-bridge)(26★):用 Hermes Agent 当本地 CLI 们的控制面。
- [firstintent/a2a-bridge](https://github.com/firstintent/a2a-bridge)(9★):单守护进程连 CC/Codex/Gemini/Zed/VS Code,已停更。
- [a2acode](https://github.com/kanywst/a2acode)(0★):CLI→A2A server 包装器,带签名 AgentCard、push notification,PyPI 有包。
- [AgentMail](https://www.agentmail.to/blog/give-your-coding-agent-an-email-inbox):给 agent 发真实邮箱的 SaaS(走真 email 协议),思路旁证:「邮件语义」是 agent 异步通信的自然模型。

### B. 并行编排类(管 session,不做 agent 互信)

- **[claude-squad](https://github.com/smtg-ai/claude-squad)**(8.2k★):tmux+git worktree 多实例 TUI,现支持 CC/Codex/OpenCode/Amp。人是唯一路由器。
- **[ruflo(原 claude-flow)](https://github.com/ruvnet/ruflo)**(67k★):swarm/hive-mind 编排,SQLite 共享内存,营销声势大;协调发生在其框架内部(spawn 的子 agent 间),不解决独立 session 互通,也非跨设备。
- **[vibe-kanban](https://github.com/BloopAI/vibe-kanban)**(27.7k★):看板派单给各家 agent;母公司 Bloop 2026 初关停,社区维护,更新放缓(最后 push 4/24)。
- **[Tmux-Orchestrator](https://github.com/Jedward23/Tmux-Orchestrator)**(1.8k★,2025-07 后停更):`send-keys` 终端注入的鼻祖,证明了「往对方终端打字」这条最糙的注入路径,脆弱但有效,已被 hook/MCP 流派取代。
- **[crystal](https://github.com/stravu/crystal)**(3.1k★):2026-02 弃更,转闭源 Nimbalyst。**[ccmanager](https://github.com/kbwo/ccmanager)**(1.2k★):无 tmux 的多 session 管理,支持 6 家 CLI。
- 结论:这一类解决「并行与隔离」,全部**没有 agent↔agent 消息语义**,只提供「多 session 同机共存」的地基。

### C. 跨设备遥控类(human↔agent,不是 agent↔agent)

- **[happy](https://github.com/slopus/happy)**(23.1k★,活跃)+ [happy-cli](https://github.com/slopus/happy-cli) | [官网](https://happy.engineering/):手机/Web 接管本机 Claude Code+Codex;**E2EE 加密中继 server 全开源**;权限审批推送到手机;一键设备切换。
- **[happier](https://github.com/happier-dev/happier)**(1.4k★,活跃分叉)| [官网](https://happier.dev/):在 happy 基础上扩到 **Claude Code / Codex / Gemini / OpenCode / Kilo / Kimi / Qwen / Augment**,加桌面端与「协作 session」(把 live session 用链接分享给他人)。
- **[cc-connect](https://github.com/chenhg5/cc-connect)**(14.7k★,2026-02 创建即爆发):CLI agent ↔ 飞书/钉钉/Slack/Telegram/Discord/企微 消息桥,无公网 IP 也能用。
- **[omnara](https://github.com/omnara-ai/omnara)**(2.7k★):曾是「手机指挥 Claude Code」代表,2026-01 起停更、转型 agent API 产品。
- **[coder/agentapi](https://github.com/coder/agentapi)**(1.5k★):把 Claude/Goose/Aider/Gemini/Amp/Codex 的终端包成统一 HTTP API——**「驱动任意 CLI」的最干净轮子**,可作为远端注入的执行器。
- 结论:这一类把「跨设备信道 + E2EE + 推送 + 权限审批」都做熟了,但消息的另一端永远是**人**。把 happy 的中继架构 + A 类的 agent 寻址拼起来,就是目标项目。

### D. 模型互询类(顺带)

- **[pal-mcp-server(原 zen-mcp-server)](https://github.com/BeehiveInnovations/pal-mcp-server)**(11.7k★,2025-12 后放缓):让 Claude Code 把 Gemini/GPT/Ollama 当顾问连续对话,还能从当前 CLI 里 spawn Codex/Gemini 子 CLI;「对话续命」(上下文存在 MCP 侧,compact 后可恢复)值得借鉴。但它是「调用模型」不是「联通两个有状态的 session」。
- **[claude-task-master](https://github.com/eyaltoledano/claude-task-master)**(27.9k★)与 [langchain agent-inbox](https://github.com/langchain-ai/agent-inbox)(1k★):共享任务图 / 人审收件箱,均非 session 互通。

---

## 三、结论

### 核心问题:有没有现成项目做到「跨设备 + 跨厂商 CLI + session 级互相 @」?

**没有。** 逐维度看:
- 跨厂商 + session 互相 @(单机):✅ 已解决 —— mcp_agent_mail、agmsg、a2abridge、CCB 都做到了。
- 跨设备 + 跨厂商(人来指挥):✅ 已解决 —— happy/happier、cc-connect。
- **三者同时:❌ 无人做到。** 最接近的是:
  1. **mcp_agent_mail**(2.1k★)— 差:无推送(纯轮询)、无设备/在线概念、手机端闭源;
  2. **a2abridge**(5★)— 差:社区验证为零、投递延迟一个回合、无消息保证,但架构蓝图最完整(MCP 工具+hook 注入+mTLS 跨机);
  3. **CCB**(3.4k★)— 差:通信人驱动、跨设备只是遥控本机;
  4. **AgentMesh** — 愿景重合度最高(全局地址+rooms+中继+E2EE)但闭源托管、v0.2。

### 可以借的轮子(按层)

| 层 | 借什么 | 从哪借 |
|---|---|---|
| 接入层 | HTTP MCP server 做总线;一份安装器改写各家 CLI 的 MCP 配置 | mcp_agent_mail、a2abridge |
| 消息语义 | register/send/fetch/ack/whois/FTS 工具集;身份命名;thread 模型 | mcp_agent_mail;A2A 的 AgentCard+Task 生命周期做 schema |
| 注入层(最后一公里) | Claude Code→Channels 通知(实时);其余 CLI→SessionStart 阻塞流 / Stop-hook 轮询 / UserPromptSubmit 前置;Codex 可走 App Server | Channels 文档、agmsg(双模式)、a2abridge(hook 脚本)、agent-bridge |
| 跨设备传输 | E2EE 中继 server(开源可自托管)+ 推送 + 权限审批转发;或 Tailscale 组网 | happy/happier(整套开源)、CCB、Channels 的 permission relay |
| 持久与审计 | Git/markdown 落盘 + SQLite FTS;或 beads 式工单图 | mcp_agent_mail、beads |
| 双信道设计 | 持久 mail + 实时 nudge(唤醒)分离 | Gas Town |
| 驱动无头 agent | 统一 HTTP 包装 / ACP client | coder/agentapi、agentclientprotocol 各 adapter |

### 空白点(= 本项目的定位机会)

1. **「session」级寻址目录**:现有项目 @ 的是「项目内身份」或「小镇角色」,没有「用户 → 设备 → 运行中 session」三级目录与在线状态(presence)。
2. **推送注入的统一抽象**:每家 CLI 注入姿势不同(Channels / hook / App Server / ACP),没人做成「一个协议、N 个 adapter」的开源层——这正是 LSP 时刻。
3. **投递保证**:现有方案(收件箱文件、SQLite 轮询)均无 ack/重试/离线补投;跨设备后这变成硬需求(A2A 的 task 状态机可抄)。
4. **信任与防注入**:跨设备后消息即攻击面;Channels 的 sender-gating、a2abridge 的 mTLS+密钥脱敏是仅有的先例,组合起来就是安全基线。
5. **中立开源**:AgentMesh 走托管闭源,厂商(Anthropic Teams/Channels)只顾自家——「开源、自托管、跨厂商」的位置是空的。

---

## 附:主要来源

- MCP:[2026-07-28 规范博客](https://blog.modelcontextprotocol.io/posts/2026-07-28/) · [changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog) · [AWS: Inter-Agent Communication on MCP](https://aws.amazon.com/blogs/opensource/open-protocols-for-agent-interoperability-part-1-inter-agent-communication-on-mcp/) · [长连接讨论 #102](https://github.com/modelcontextprotocol/modelcontextprotocol/discussions/102)
- A2A:[GitHub](https://github.com/a2aproject/A2A) · [LF 新闻稿](https://www.linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations-lands-in-major-cloud-platforms-and-sees-enterprise-production-use-in-first-year) · [Google 捐赠](https://developers.googleblog.com/en/google-cloud-donates-a2a-to-linux-foundation/) · [采纳现状分析](https://www.glukhov.org/ai-systems/comparisons/a2a-protocol-2026-adoption/) · [Wikipedia](https://en.wikipedia.org/wiki/Agent2Agent)
- ACP:[agentclientprotocol.com](https://agentclientprotocol.com/get-started/agents) · [GitHub org](https://github.com/agentclientprotocol/agent-client-protocol) · [Zed: Claude Code via ACP](https://zed.dev/blog/claude-code-via-acp) · [Zed: BYOA](https://zed.dev/blog/bring-your-own-agent-to-zed) · [进展报告](https://zed.dev/blog/acp-progress-report)
- 协议格局:[rywalker 对比](https://rywalker.com/research/agent-coordination-protocols) · [zylos 汇总](https://zylos.ai/research/2026-03-26-agent-interoperability-protocols-mcp-a2a-acp-convergence/) · [prompt20](https://blog.prompt20.com/posts/ai-agent-protocols/)
- Claude Code:[Channels 参考](https://code.claude.com/docs/en/channels-reference) · [the-decoder 报道](https://the-decoder.com/anthropic-turns-claude-code-into-an-always-on-ai-agent-with-new-channels-feature/) · [Agent Teams 指南](https://www.kimi.com/resources/agent-teams-in-claude-code) · [Codex 桥讨论](https://github.com/openai/codex/discussions/15374)
- Gas Town:[repo](https://github.com/gastownhall/gastown) · [beads](https://github.com/gastownhall/beads) · [通信命令](https://docs.gastownhall.ai/usage/communication/) · [Mail 协议](https://gastown.dev/docs/design/mail-protocol/) · [yegge.ai](https://yegge.ai/gastown)
- 各项目 GitHub 链接见正文表格;star 数为 2026-08-05 GitHub API 实测。
