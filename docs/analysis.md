# Any to Any — 调研汇总与架构分析

> 基于 docs/research/ 下 5 份调研报告（2026-08-05）。本文是决策文档：先给结论，再给依据。

## TL;DR

1. **这事可做，且生态位是空的。** 「跨设备 + 跨厂商 CLI + session 级互 @」三合一没有现成项目；最接近的 mcp_agent_mail（2.1k★）缺推送和跨设备寻址，a2abridge 架构同构但极早期。
2. **出站是送分题：MCP 是全行业公分母。** Claude Code / Codex / Kimi / Gemini / Q 全是 MCP client——装同一个 MCP server，agent 就有了 `send / inbox / list_agents` 工具，「发消息」天然解决。
3. **入站（最后一公里）是本项目的真正内核，而且每家都有正门**：Claude Code 有 Channels（MCP 通知直入会话，空闲即触发新回合）；Codex 有 app-server JSON-RPC（`turn/steer` 打断注入、经 `ipc.sock`）；Kimi 有 `kimi web` REST（`POST sessions/{id}/prompts`）。谁都不需要 tmux 野路子（但保留它当兜底）。
4. **推荐架构：每设备一个 daemon（anyd）+ 轻量 relay + 统一 MCP 工具面 + 每家一个注入 adapter**，消息模型用「邮箱语义」（ack / 离线补投 / 线程化），实时推送做成增强而非前提。
5. MVP 先在一台 Mac 上打通 Claude Code ↔ Codex 互 @，第二步跨设备（Tailscale 或自建 WS relay），第三步做 @ 语法糖与信任机制。

## 1. 需求的精确定义

用户要的是一个「**会话级消息系统**」，不是编排平台：

- **寻址**：`@<设备>/<agent>:<session>`，如 `@mini/codex:前端重构`。三层目录：用户 → 设备 → session。
- **投递**：消息到达目标 session 的上下文里，目标 agent 像收到用户插话一样处理它。
- **双向**：对方能 reply，回复回到发起方 session，可多轮。
- **异步容忍**：目标忙时排队，目标离线时留信箱，回来补投。
- 参考系：Codex 的 multi-agent 互通（但仅限它自己进程内的 agent 树）——我们要把这个体验推广到跨厂商、跨设备。

## 2. 四家 CLI 接入点矩阵（调研核心结论）

| 能力 | Claude Code 2.1.198 | Codex 0.144+ | Kimi Code | Q CLI（日落）/ Z Code |
|---|---|---|---|---|
| **入站·实时推送** | ✅ Channels：MCP server 发 `notifications/claude/channel`，空闲即触发新回合、忙则排队（research preview，需 dev flag） | ✅ app-server JSON-RPC：`thread/resume` rejoin 运行中线程、`turn/start` 发消息、`turn/steer` 打断注入；传输 stdio / `ipc.sock` / remote-control WS | ✅ `kimi web`：本地 REST+WS，`POST sessions/{id}/prompts`、`prompts:steer`、程序化 approvals | ❌ 均无 |
| **入站·headless 续写** | ✅ `claude -p --resume <id>`；stream-json 双向长驻 | ✅ `codex exec resume <threadId> "msg"` | ✅ `kimi -p -S <id>`（实测通过） | Q：resume 仅按 cwd；Z：无 |
| **出站·MCP client** | ✅ stdio/SSE/HTTP | ✅ stdio/streamable HTTP | ✅ stdio/HTTP/SSE+OAuth | Q ✅ / Z ❌ |
| **出站·hooks/notify** | ✅ 约 30 hook 事件，含 `http` hook、`asyncRewake` | ✅ hooks stable（与 CC 格式兼容）+ `notify` turn 结束回调 | ✅ 19 hook 事件，可注入 context | Q ✅ hooks / Z ❌ |
| **session 发现** | `~/.claude/projects/<路径>/<uuid>.jsonl` | `session_index.jsonl`（id+线程名）+ sqlite | `session_index.jsonl`（id+workDir） | Q：SQLite / Z：无 |
| **自身作为 server** | `claude mcp serve`（只借工具，无会话通道） | ✅ `codex mcp-server`：`codex` / `codex-reply` 工具（threadId 续写） | ✅ `kimi web` + ACP + 官方 SDK（Go/Node/Py） | ❌ |

结论：**Claude Code、Codex、Kimi 三家均可实现「真推送」入站；全部主流 CLI 均可实现 MCP 出站。** Z Code 是闭源桌面 ADE 无接入面（接 GLM 生态应走其白名单开源 CLI）；Q 在日落，直接面向继任者 Kiro（有 ACP）。

## 3. 关键设计问题

### 3.1 最后一公里：消息如何「进入」目标 session

四条通道，按体验从好到差，**做成 adapter 分层，逐家择优**：

1. **原生推送**（Channels / app-server steer / kimi web prompts）——消息即时进入运行中会话；忙时由 CLI 自己排队。体验 = Codex 内部互 @。
2. **headless 续写**（`--resume` / `exec resume` / `-p -S`）——目标 session 不在运行也能投递：daemon 拉起一次续写回合，处理完消息即退出。**这是离线补投的实现，也是最通用的保底正门。**
3. **hook 注入**（UserPromptSubmit 等带 `additionalContext`）——用户下次说话时消息随上下文带入。被动，作为「顺带提醒」增强。
4. **tmux send-keys**——对任何 CLI 通用的最后兜底（本机已装 tmux）。脆弱（依赖 UI 状态），默认关闭。

注意：1 与 2 的本质区别是「消息进入**正在交互的那个上下文**」vs「消息进入**该 session 的延续**」。对用户而言 2 的效果是：mini 上的 Codex 处理了消息并回了信，但 mini 屏幕上那个 TUI 界面不一定同步显示（rollout 已续写，重新 attach 可见）。MVP 用 2 保证可达性，用 1 升级实时性。

### 3.2 出站：agent 怎么发消息

统一 MCP server（stdio 起步），暴露最小工具集（借鉴 mcp_agent_mail 的成熟设计）：

- `list_agents()` — 查目录：谁在线、哪些 session 可寻址
- `send_message(to, body, thread_id?)` — @ 某 session，返回投递状态
- `check_inbox()` / `reply(thread_id, body)` — 收件与线程化回复

同一个 server 二进制，注册进每家 CLI 的 MCP 配置（`~/.claude.json` / `~/.codex/config.toml` / kimi 配置），**一次实现，五家通用**。

### 3.3 跨设备传输

| 选项 | 评价 |
|---|---|
| **Tailscale 组网 + daemon 互访** | 零服务器、E2E 加密、NAT 穿透白送。用户自家设备场景最合拍。**推荐起步。** |
| 自建轻量 relay（WS hub） | 部署在任一台常开设备/小 VPS；无 Tailscale 依赖，但要自己管 TLS/认证。作为 Phase 2 备选。 |
| 借 happy 的开源 E2EE 中继 | 有现成轮子但引入其整个体系，先借设计不借依赖。 |
| GitHub/git 作总线 | 延迟与冲突都不合适，否。 |

MVP 顺序：同机（Unix socket，零传输问题）→ Tailscale 跨机 → 可选自建 relay。

### 3.4 寻址与目录

- 各 CLI 的 session 索引文件现成（见矩阵），daemon 定时扫描 + 文件监听，聚合成本机目录；relay 层聚合成全网目录。
- 命名：设备名（hostname 或自定义别名）/ agent 类型 / session（线程名或 id 前缀，Codex 0.146+ 支持命名 session，Claude 可用项目路径+摘要，Kimi 用 workDir）。
- `@mini/codex:前端重构` 解析优先级：精确 id > 线程名模糊匹配 > 最近活跃。歧义时返回候选列表让发起方 agent 澄清。

## 4. 候选架构对比

### 方案 A：纯共享邮箱（mcp_agent_mail 模式）
一个 MCP server 存邮箱，agent 主动查收。
- ✅ 实现量最小，一天能跑通
- ❌ 没有推送：对方不查就永远收不到 ——「@ 了没人理」，不满足刚需的核心体验
- 定位：**它的消息模型值得抄，但不能只做它**

### 方案 B：daemon + adapter + 邮箱语义（推荐）
每设备一个 `anyd`：本机 session 目录 + 收件后按 CLI 类型走原生注入 adapter；MCP 工具面统一出站；跨设备走 Tailscale/relay；消息持久化成邮箱（ack/补投/线程）。
- ✅ 唯一能同时满足「@ 即达」「离线补投」「跨设备」「五家通吃」的形态
- ✅ 每家都用官方通道，不碰 UI 注入，稳定性可控
- ❌ 实现量最大；Channels 是 research preview（需 `--dangerously-load-development-channels`，API 可能变）
- 风险缓解：每个 adapter 都有 headless-resume 降级路径，preview API 变了也不失联

### 方案 C：终端包装层（agentapi/tmux 模式）
把每个 CLI 包在 HTTP/tmux 壳里，注入当用户输入。
- ✅ 万能通用，连没有任何 API 的 CLI 都能接
- ❌ 侵入用户工作流（必须从壳里启动）、脆弱（TUI 变了就断）、消息与用户输入混淆
- 定位：**只做 B 里的兜底 adapter，不做主干**

**结论：B 为主干，吸收 A 的消息模型，C 降级为可选 adapter。**

## 5. 推荐架构（目标形态）

```
┌─ MacBook ────────────────────────────┐      ┌─ Mac mini ──────────────────┐
│  Claude Code ──┐                     │      │                ┌── Codex    │
│  Codex ────────┼─ MCP 工具面(出站)    │      │   MCP 工具面 ───┼── Kimi     │
│  Kimi ─────────┘        │            │      │       │        └── …        │
│                    anyd(daemon)      │◄────►│  anyd(daemon)               │
│  目录: session_index 聚合 │            │ Tailscale / relay                  │
│  注入 adapter(入站):      │            │      │  注入 adapter:              │
│   claude→Channels/resume ┘           │      │   codex→app-server(ipc.sock)│
│   codex→app-server       兜底: tmux   │      │   kimi→kimi web REST        │
└──────────────────────────────────────┘      └─────────────────────────────┘
        消息模型: 邮箱(持久化/ack/离线补投/thread)   寻址: @设备/agent:session
```

## 6. MVP 分期

**Phase 1 — 同机跨 agent 打通（验证核心价值）**
单 Mac 上：`anyd` 最小版（目录扫描 + SQLite 邮箱 + Unix socket）；MCP server 三工具（list/send/inbox）；两个 adapter：Codex（`codex exec resume` 起步，再升 app-server）+ Claude Code（`claude -p --resume` 起步，再升 Channels）。验收：Claude Code 里 `@codex:xxx` 发问，Codex 处理并回信，Claude Code 收到回复。

**Phase 2 — 跨设备**
Tailscale 内 daemon 互访（mTLS/token 认证），全网目录聚合，离线补投。验收：MacBook 的 Claude Code @ 到 Mac mini 的 Codex 并收到回复。

**Phase 3 — 体验与安全**
@ 语法糖（各家 skill/slash command 统一 `@` 书写体验）、Kimi adapter、Channels/app-server 实时化、防回环风暴（TTL/深度限制）、消息来源标识与提示注入防护（收到的消息以受信标记包裹、默认只读建议不自动执行）、已读回执。

## 7. 主要风险

1. **Channels 是 research preview**：需 dev flag，API 可能变。缓解：resume 降级路径永远保留。
2. **提示注入与信任**：跨 agent 消息本质是「一个 LLM 给另一个 LLM 下指令」。必须：消息带来源签名、收方以数据而非指令框定（受信包裹 + 建议「先复述再执行」约定）、敏感操作仍走各家自己的权限审批。
3. **回环风暴**：A@B、B 又 @A 无限循环。缓解：thread 深度上限、速率限制、循环检测。
4. **版本漂移**：五家 CLI 迭代都快（Q 在日落、Codex 0.146 已加命名 session）。缓解：adapter 隔离变化面 + CI 定期冒烟。

## 8. 待用户决策

1. **MVP 的两家先锋**：建议 Claude Code + Codex（你的主力，接入面也最全）。Kimi 第三个跟上？
2. **跨设备传输**：你两台 Mac 是否已用/愿意用 Tailscale？（是 → Phase 2 零服务器；否 → 自建 relay 放常开的 Mac mini）
3. **技术栈**：daemon+MCP server 建议 TypeScript（生态：MCP SDK 官方、五家 CLI 半数是 Node）或 Go（单二进制分发爽）。倾向？
4. **实时性优先级**：MVP 接受「resume 续写」的秒级异步（对方 TUI 不一定即时可见），还是必须一步到位上 Channels/app-server 实时注入？
