# 调研报告：向运行中的 OpenAI Codex 会话实时注入外部消息（且 UI 可见）

*调研时点：2026-08-05。核心问题：外部进程如何把一条消息实时送进「正在运行的 Codex 会话」，并在其 UI（Desktop App 或 CLI TUI）对话流里对用户可见。*
*已确认的失败路径（前提，不再重复验证）：`codex exec resume` 写盘但 App 不热载；`codex app-server proxy` 需独立 daemon 的 control socket（App 不用）；hooks additionalContext 进模型上下文但 UI 不渲染。*

---

## TL;DR

1. **官方没有「向任意运行中会话注入」的通用能力**。`codex inject` 类请求被官方**关闭为 not planned**（[#11415](https://github.com/openai/codex/issues/11415)、[#8707](https://github.com/openai/codex/issues/8707)、[#17101](https://github.com/openai/codex/issues/17101)）。
2. **CLI TUI 有一条协议级正路**：让 TUI 以 `codex --remote <socket>` 挂到共享的 `codex app-server --listen` daemon 上，外部客户端对同一 thread 调 `turn/start` / `turn/steer`，消息进入同一运行时、TUI 端可见——这正是第三方工具 **kcosr/codex-threads** 的工作方式。已知缺陷：部分版本 TUI 对「外部发起的 turn」**不完全实时重绘**（[#15320](https://github.com/openai/codex/issues/15320)，附社区参考补丁），内容最终会出现但可能延迟。
3. **默认启动的 `codex` TUI（不带 --remote）运行时在进程内，外部完全摸不到**；官方在 [Discussion #11959](https://github.com/openai/codex/discussions/11959) 被问「standalone TUI 会不会迁到 app-server 运行时以支持多客户端实时同步」，未见承诺。
4. **Desktop App 至今没有任何受支持的外部注入路径**：它以 stdio 方式 spawn 私有 app-server（单客户端），外部客户端连自建实例只能看到磁盘历史、`thread/loaded/list` 为空、`turn/interrupt` 报 thread not found（[#25914](https://github.com/openai/codex/issues/25914)，open 无回应）。连第一方跨端实时同步都有 bug（[#32466](https://github.com/openai/codex/issues/32466)）。唯一入站通道是 ChatGPT 手机端经 OpenAI 私有 relay（Codex Remote，2026-06-25 GA），协议未公开。
5. **当前普适最优解仍是 tmux send-keys 流派**（gastown 的 `gt nudge`、ccgram、CCB 均如此）：对默认 TUI 100% 用户可见、零侵入，代价是要处理输入框状态/多行/流式期间被忽略（[#4446](https://github.com/openai/codex/issues/4446)）等可靠性坑。**工程化更优解**是改用「共享 daemon + `codex --remote` TUI + turn/start」架构。**Desktop App 场景无解，只能等官方**（盯 #25914 / #17543）。

---

## 一、Codex GitHub issues / discussions 全景

### 1.1 「外部注入」直接相关的 issue（均为事实，链接可查）

| Issue | 内容 | 状态（2026-08 时点） |
|---|---|---|
| [#11415](https://github.com/openai/codex/issues/11415) | 请求 `codex inject <session> --text "..."` 从外部向已有会话发 prompt（automation/orchestration 场景，提案里还包括 socket/localhost listener backend） | **Closed as not planned**（2026-02-11 开） |
| [#8707](https://github.com/openai/codex/issues/8707) | `/cron`：会话内定时把消息当作用户输入注入 | **Closed as not planned** |
| [#17101](https://github.com/openai/codex/issues/17101) | 请求 TUI 可用的 session-control 原语（明确对标 Claude 的 channel 工作流）；指出 `codex exec --json` 的 thread_id 无法用 `codex-reply` 跨进程续接 | **Closed**，无维护者回应；app-server 被称为「长期集成路径」（2026-04-08 开） |
| [#12689](https://github.com/openai/codex/issues/12689) | 语音转文字想把动态文本注入活动 TUI 会话，没有任何入口 | Open |
| [#22003](https://github.com/openai/codex/issues/22003) | 后台命令完成后把输出自动注入活动会话；作者试了 file-watcher 原型，**「session 不会自己醒来，只有显式 poll 之后输出才出现」**；现状依赖 tmux send-keys | Open（2026-05-10），无维护者行动 |
| [#4446](https://github.com/openai/codex/issues/4446) | 最终答案流式输出期间发送的消息「在 UI 里被插进流式文本中间，然后被忽略而不是排队」 | Open。**对 tmux 注入流派是重要坑** |

### 1.2 多客户端 / 共享 thread 实时性相关（对「协议正路」最关键）

| Issue | 内容 | 状态 |
|---|---|---|
| [#15320](https://github.com/openai/codex/issues/15320) | **「App-server TUI 不完全反映共享 thread 上外部发起的 live turn」**（v0.116.0）：共享会话上下文正确（模型看得到），但活动 TUI 可能不实时重绘外部 turn，内容之后才出现；issue 里附了社区 reference patch | Open |
| [#21551](https://github.com/openai/codex/issues/21551) | RFC：peer-client 与 live TUI thread 共存。作者自己打了 3 文件的本地补丁（`codex_thread.rs` 事件 fanout 等）实现多订阅者实时分发，demo 了 **TUI / desktop web / phone web 三端各自发 turn、其余两端实时可见** | **Closed**（2026-05-07 开），未见维护者回应 |
| [#25914](https://github.com/openai/codex/issues/25914) | 请求文档化「app-server 客户端如何发现并 attach 到活动的 Codex Desktop thread」。作者实测：对 Desktop 捆绑的 codex 二进制自起 app-server，`thread/list`/`thread/read` 能看到磁盘历史，但 `thread/loaded/list` 返回空、对推测的活动 thread 调 `turn/interrupt` 报 "thread not found"——**持久化 thread 绑不到 Desktop UI 的活动 turn** | Open，无维护者回应 |
| [#32466](https://github.com/openai/codex/issues/32466) | Desktop 26.707 对共享 thread 的 live turn 更新丢失，直到在 VS Code 打开同一 thread | Open。说明**第一方跨端 live sync 自己都还不稳** |
| [#16614](https://github.com/openai/codex/issues/16614) | 自定义 app-server 客户端建的 thread 会出现在 Desktop 历史里（被标成 "vscode"）——**磁盘/历史层互通，但非实时** | Open |
| [Discussion #11959](https://github.com/openai/codex/discussions/11959) | 路线图追问：standalone TUI 会否迁移到 app-server-backed runtime 实现多客户端 live sync。现状结论：**「live sync 是进程本地的，除非客户端共享同一个 app-server runtime；跨进程只有经 rollout/resume/read 的最终一致」** | 无官方承诺 |

### 1.3 `thread/inject_items` / `turn/steer` 的官方定义（事实）

来源：[app-server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)、[官方 App Server 文档](https://developers.openai.com/codex/app-server)、[PR #17703](https://github.com/openai/codex/pull/17703)（2026-04-13 合并）：

- `turn/steer`：**"add user input to an already in-flight regular turn without starting a new turn; returns the active turnId that accepted the input"**。不接受 model/cwd/sandbox 覆盖；review/compaction turn 会拒绝。
- `thread/inject_items`（PR 里also `turn/inject_items` 及其拼写别名）：**"append raw Responses API items to a loaded thread's model-visible history without starting a user turn"**——注意措辞是 **model-visible history**，不承诺 UI 渲染；且只作用于**本进程已 load 的 thread**。
- 传输：stdio（默认）、`--listen ws://IP:PORT`（README 标注 experimental/unsupported）、`--listen unix://PATH`；每连接必须先 `initialize`。
- 关键约束：**"Only one app-server process can hold a paginated thread open for writing at a time"**——两个 app-server 进程（比如 Desktop 的和你自建的）不能同时写同一 thread。这从协议层解释了为什么「自起 app-server 去碰 Desktop 的活动 thread」走不通。
- **没有找到任何人从外部对 Desktop App 成功用过 `thread/inject_items`/`turn/steer` 的公开案例**；#25914 是最接近的尝试且失败。这两个方法只在「你自己的客户端连你自己可达的 app-server」场景下有效（事实）。

---

## 二、`codex remote-control`：daemon、手机配对、第三方可否接入

事实（来源：[官方 Remote connections 文档](https://developers.openai.com/codex/remote-connections)、[danielvaughan v0.130 分析](https://codex.danielvaughan.com/2026/05/09/codex-cli-v0130-remote-control-headless-agent-services-thread-pagination/)、[OpenAI 公告](https://openai.com/index/work-with-codex-from-anywhere/)）：

- `codex remote-control start` 是 **app-server 的带默认值封装**：默认在 `ws://127.0.0.1:9742` 起 WebSocket 监听 + capability-token 鉴权，启动横幅打印连接 URL 和 token 路径。"Under the hood it still starts the same app-server process — the same JSON-RPC 2.0 protocol."
- **第三方可以接入这个 daemon 的本地 socket**：v0.130 文章直接给了 Python WebSocket 客户端例子（JSON-RPC 2.0 + initialize 握手），可 `turn/steer`（支持 `expectedTurnId`）。也就是说 remote-control daemon 本身对本机第三方是开放的（带 token）。
- 手机遥控链路：daemon 额外向 OpenAI 基础设施**出站**连 `wss://.../wham/remote/control/server`（QR/短码配对，OpenAI relay 中转，10 分钟空闲超时；Codex Remote 2026-06-25 GA）。**relay 协议未公开**，第三方想冒充手机端需逆向 + 以 ChatGPT 设备身份鉴权——不现实（推测：无人公开做成过，未搜到案例）。
- **与 Desktop App 的关系（部分事实+推测）**：官方文档说手机可以 "continue existing ones / steer active work" 于连接的 host。但 Desktop 本地会话用的是自己 stdio spawn 的 app-server 实例；[#23699](https://github.com/openai/codex/issues/23699) 显示 Desktop 在 SSH 远程主机上自管 app-server 生命周期（`codex app-server --listen unix://`），重启时会丢掉 remote-control 模式、把「能被手机遥控的 app-server」替换成普通实例——说明 Desktop 与 remote-control daemon 是**两套纠缠但不合一的路径**。配对/掉线 bug 频出（[#23403](https://github.com/openai/codex/issues/23403)、[#22851](https://github.com/openai/codex/issues/22851)、[#31117](https://github.com/openai/codex/issues/31117)）。
- **推测**：即便你连上 remote-control daemon 的本地 socket，你触达的也是**该 daemon 进程里的 thread**，不是 Desktop App stdio 实例里的活动 thread（受 single-writer 约束）。它解决的是「headless 会话被多端遥控」，不解决「注入 Desktop App 正开着的会话」。
- 安全注脚：[Origin Technology "Codex on the Wire"](https://www.originhq.com/research/codex-on-the-wire) 实测 0.125.0 在 `0.0.0.0` 绑定时命令行给了 auth 标志**未鉴权客户端仍能连入**，连入者可建 thread/执行命令/读写文件——把 `--listen` 当集成面时务必只绑 loopback/unix socket。

---

## 三、第三方项目如何与运行中的 Codex 交互

### 3.1 kcosr/codex-threads（协议流派，最接近「正解」）

[github.com/kcosr/codex-threads](https://github.com/kcosr/codex-threads)。CLI：创建/搜索/读 transcript/**控制** app-server threads。

- 架构（README 原文要求）：`codex app-server --listen "$CODEX_SOCK"`（UDS 或 WS）起共享 daemon；**交互式 TUI 用 `codex --remote "$CODEX_SOCK" --cd "$PWD"` 挂上同一 socket**；codex-threads 指向同一 socket。
- 注入命令:`send THREAD_ID PROMPT`（走 `turn/start`，起后续 turn）、`steer THREAD_ID TURN_ID PROMPT`（走 `turn/steer`）、`new`。带自愈：遇 "unloaded thread" 错误自动 `thread/resume` 后重试一次。
- 明确边界（README 原文）：**"Codex sessions started without `--remote` are not on that shared server, so codex-threads cannot list, inspect, or control them"**；**不支持 Desktop App**。
- 可见性：同一 daemon 内同一 thread，TUI 作为订阅端接收 turn 事件流——外部 send 的消息会进入 TUI 对话流（结合 #15320：**部分版本对外部 turn 的实时重绘不完整，内容可能延迟出现**，此为该路径唯一已知可见性坑）。
- `codex --remote` 为官方 flag（[CLI reference](https://developers.openai.com/codex/cli/reference)），支持 ws://、wss://、unix://，适用于 codex/resume/fork 等子命令。

### 3.2 CCB（SeemSeam/claude_codex_bridge，「17 家 CLI」的那个）

[github.com/SeemSeam/claude_codex_bridge](https://github.com/SeemSeam/claude_codex_bridge)。多智能体 CLI 工作台，协调 **17+ CLI 家族**（Codex、Claude、Gemini、Grok、Kimi、Qwen、Cursor、Copilot、Crush、Kiro、Pi、Z.ai、OpenCode、Antigravity、Droid…）。

- 机制：**每个 agent 是一个可见的原生终端 pane（"every agent is a full native terminal with visible layout control and direct takeover"）**，后台 daemon 维持项目状态；`/ask` 在 agent 间投递请求，支持 A→B→C 等协作图。
- 注入本质上是终端层投递（配文件态 ask/回执监测——release note 提到 "Codex ask completion now uses no-progress time so actively growing long-session files do not fail"，即**靠监控 Codex session 文件增长来判断回复完成**）。可靠性工程：pane 重生后 90 秒观察期并挂起队列、回调修复候选有界化等。
- 结论：CCB 属于 tmux/终端注入流派的重度工程化版本，UI 天然可见（消息就是敲进对方终端的）。

### 3.3 ccgram（Telegram ↔ tmux/herdr 桥）

[github.com/alexei-led/ccgram](https://github.com/alexei-led/ccgram)。"It sits on top of your terminal multiplexer (tmux or herdr), not any agent SDK." 支持 Claude Code/Codex/Gemini/Pi/Shell。README 直言投递**非原子**："A session can still change after that guard and before Herdr dispatches, so delivery is not atomic and may be indeterminate after this post-guard race."——终端注入的固有竞态被第三方自己承认。

### 3.4 agentapi（coder/agentapi）

[github.com/coder/agentapi](https://github.com/coder/agentapi)。给 Claude Code/Goose/Aider/Gemini/Amp/**Codex** 提供统一 HTTP API：**内存内终端仿真器**把 API 调用翻译成按键、对终端快照做 diff 把输出解析回消息。本质仍是「往 TUI 打字」，只是把 tmux 换成了自管 PTY——注入内容在（它托管的）TUI 里可见，但代价是**agent 必须由 agentapi 启动**，不能附着到用户已开的会话。

### 3.5 Gas Town（steveyegge/gastown）

[github.com/steveyegge/gastown](https://github.com/steveyegge/gastown)、[Yegge 的 Welcome to Gas Town](https://steve-yegge.medium.com/welcome-to-gas-town-4f25ee16dd04)、[Inside Gas Town](https://www.augusteo.com/blog/inside-gas-town/)：

- 消息 = **文件系统 mail（git 背书的 hook/inbox）** + **`gt nudge` 实时戳**。nudge 的本质就是 **tmux send-keys 模拟用户输入**（"a tmux send-keys that fires... simulating user input"，并"works around some debounce issues with tmux send-keys"）。Yegge 称之为 "physics over politeness"：**agent 被训练成等人类输入，系统提示词解不开，必须让它「看到输入到达」**——这句话是对本调研核心问题最精辟的注脚。
- 对 Claude Code 额外用 `.claude/settings.json` hooks 做 mail 注入；其他 runtime 用启动后 `gt prime` / `gt mail check --inject` 兜底。

### 3.6 Remodex（iPhone 遥控 Codex）

[remodex.site](https://www.remodex.site/)、[github.com/Emanuele-web04/remodex](https://github.com/Emanuele-web04/remodex)：Mac 上跑 bridge（连本机 Codex/app-server）+ WebSocket relay + iOS App，X25519/Ed25519/AES-256-GCM 端到端加密，QR 配对。定位是**自建「手机遥控自己 bridge 起的会话」**，与 Codex Remote 同构——同样不触达用户已开的 Desktop/裸 TUI 会话。

---

## 四、Codex 的 MCP 层：通知 / elicitation / sampling

- **MCP server 主动通知注入会话：没有，只有提案**。[#17543](https://github.com/openai/codex/issues/17543)（2026-04-12 开，open，无维护者行动）提议「把 MCP custom notifications 转成活动会话的 user submission 并走 TUI 通知路径显示」——恰好就是 Claude Code Channels 的 Codex 版，涉及 codex-rmcp-client / codex-mcp / codex-tui 三层。**未实现**。
- **Elicitation：已支持（限工具调用期间）**。[PR #17043](https://github.com/openai/codex/pull/17043)（2026-04-08 合并）给 rmcp 客户端加了 elicitation round-trip（前置请求 [#13405](https://github.com/openai/codex/issues/13405)、[#6992](https://github.com/openai/codex/issues/6992)）。这是 **server→client 的表单/确认请求**，发生在活动交互中，不能用来无端推送一条对话消息。
- **Sampling：Codex 未支持，且 MCP 规范已弃用**——[MCP 2026-07-28 规范](https://blog.modelcontextprotocol.io/posts/2026-07-28/)把 sampling 标记 deprecated、计划移除（server→client 请求改走 MRTR 设计）。此路已死。
- **结论（事实）**：想在 Codex 里复刻 Claude Code Channels（MCP 通知直接进会话上下文并触发回合），当前唯一载体是给 #17543 加权重或自己 fork 实现（#21551 作者证明了 fanout 补丁量级不大：3 个文件）。

对照：**Claude Code Channels**（2026-03-20 前后随版本发布，research preview，`--channels` 启用；MCP server 声明 `claude/channel` capability、推 `notifications/claude/channel`，双向 channel 暴露 reply tool。来源：[datastudios 综述](https://www.datastudios.org/post/claude-code-channels-what-it-is-how-it-works-and-how-to-use-it-with-mcp-telegram-and-discord)）。它自己也有投递可靠性 bug 可引以为鉴：每会话只送达第一条（[claude-code#38736](https://github.com/anthropics/claude-code/issues/38736)）、只有 turn 间隙窗口内到达的消息被投递、处理中到达即永久丢失（[#45563](https://github.com/anthropics/claude-code/issues/45563)）、stream-json 模式静默丢弃（[#55896](https://github.com/anthropics/claude-code/issues/55896)）。**即便是「官方做了」的形态，队列语义也是最难做对的部分**。

---

## 五、tmux / 终端注入流派：实践与坑

实践者：gastown（`gt nudge`）、ccgram、CCB、[primeline-ai/claude-tmux-orchestration](https://github.com/primeline-ai/claude-tmux-orchestration)、[tmux "War Room"](https://lugha.substack.com/p/beyond-the-chatbox-orchestrating)（libtmux + 共享 comms 文件 + `<OVER>` 结束标记）、agentapi（自管 PTY 泛化版）。共识做法与坑：

1. **send-keys 分两步**：`tmux send-keys -l '<正文>'`（literal 模式防止内容被解析成键名）+ 单独一次 `send-keys Enter`。合并一条会与 TUI 输入缓冲竞态（primeline 文档明确写明）。
2. **多行消息**：literal 模式整段发或 bracketed paste；避免逐行 Enter 触发提前提交。
3. **状态检测是最大短板**：没有可靠的「TUI 空闲/忙」信号，主流做法是 `capture-pane` 抓屏 + 启发式（spinner/提示符特征）或干脆固定延时；ccgram 承认投递非原子。CCB 用「session 文件无增长时间」判断 Codex 回合结束。
4. **Codex 专属坑**：最终答案流式输出期间敲入的消息会**显示在 UI 里但被忽略、不排队**（[#4446](https://github.com/openai/codex/issues/4446)）——注入前必须确认不在流式收尾阶段；输入框有草稿时注入会拼接污染；`/` 开头内容可能触发命令补全弹窗。
5. **可见性满分**：这是唯一让「默认方式启动的 TUI」显示外部消息的办法——消息就是被「打」进去的，用户看到的与亲手输入无异。
6. **不适用 Desktop App**（无终端）。macOS 对应物是 Accessibility/AppleScript 把文本敲进 Desktop 输入框——**推测可行、未见公开成功案例**，且窗口焦点/输入法/更新改版风险大。

---

## 六、其他人解决「实时推消息进运行中 coding agent 且 UI 可见」的思路汇总

- **协议共享运行时派**：kcosr/codex-threads（Codex 现实版）；#21551 RFC（fork 补丁实现三端 co-presence）。Claude 侧对应物即 Channels。
- **终端物理注入派**：gastown/ccgram/CCB/agentapi/tmux-orchestrator——「让 agent 看到输入到达」。
- **文件信箱 + 唤醒派**：gastown mail、War Room comms 文件、#22003 的 inbox watcher——共同结论：**Codex 不会自己醒**，必须配一个物理唤醒（nudge/send-keys）或显式 poll。
- **给 Codex 的同类 feature request 及状态**：`codex inject`（#11415，closed not planned）、session-control 原语（#17101，closed）、MCP 通知注入（#17543，**open，最值得盯**）、后台输出注入（#22003，open）、Desktop thread 发现/attach（#25914，**open，Desktop 场景唯一希望**）、TUI 外部 turn 重绘（#15320，open 带参考补丁）、TUI 迁 app-server runtime（Discussion #11959，无承诺）。

---

## 可行路径排序（用户可见性 × 可靠性 × 实现成本，5 分制）

| # | 路径 | 可见性 | 可靠性 | 成本 | 综合 | 判定 |
|---|---|---|---|---|---|---|
| 1 | **tmux send-keys 注入 CLI TUI**（-l literal + 独立 Enter + capture-pane 状态启发式；参考 gastown nudge/ccgram） | 5（原生显示） | 3（竞态、#4446、状态检测启发式） | 5（几十行脚本） | **★ 当前最优通用解** | 立即可用，附着于用户已开的默认 TUI，无需改变启动方式 |
| 2 | **共享 app-server daemon + `codex --remote` TUI + 外部 `turn/start`/`turn/steer`**（kcosr/codex-threads 现成） | 4（协议内投递；#15320 部分版本重绘延迟） | 4（官方协议、可重试、结构化） | 3（必须改用 `codex app-server --listen` + `--remote` 启动 TUI；只绑 unix://loopback） | **★ 工程化最优解** | 若可控制用户的启动方式，这是长期正解；对已存在的普通会话无效 |
| 3 | `codex remote-control` daemon（ws://127.0.0.1:9742 + token）+ 第三方 JSON-RPC 客户端 | 3（触达 daemon 内 thread；手机/自建前端可见，**默认 TUI/Desktop 不可见**） | 4 | 3 | 备选 | 适合 headless 编排，不解决「注入用户面前的 UI」 |
| 4 | Desktop App：macOS Accessibility/AppleScript 把文本敲进输入框 | 5（若成功） | 2（推测未验证；焦点/改版脆弱） | 3 | Desktop 唯一 DIY | 无公开成功案例（推测项） |
| 5 | `thread/inject_items` / hooks additionalContext / `codex exec resume` 写盘 | 1（仅模型上下文/磁盘，UI 不渲染或需重开） | 4 | 2 | 仅作上下文补给 | 与已确认失败路径同类，不满足「UI 可见」 |
| 6 | MCP 通知注入（#17543）/ TUI 外部 turn 完整重绘（#15320 patch）/ Desktop attach API（#25914） | 5（若官方落地） | — | 0（等待）或 fork 自维护（#21551 证明 3 文件补丁可行） | **等官方项** | 订阅这三个 issue；#17543 是 Channels 对等物，最值得投票/催 |

**一句话结论**：CLI 场景短期用 tmux send-keys（做好状态检测与 #4446 规避），中期迁到共享 app-server daemon + `codex --remote` 架构（codex-threads 已趟通）；Desktop App 场景当前无受支持路径，等 #25914/#17543，急用只能试 UI 自动化（未验证）。

---

## 附：主要来源

- Codex issues/PR/discussion：[#11415](https://github.com/openai/codex/issues/11415)、[#8707](https://github.com/openai/codex/issues/8707)、[#17101](https://github.com/openai/codex/issues/17101)、[#12689](https://github.com/openai/codex/issues/12689)、[#22003](https://github.com/openai/codex/issues/22003)、[#4446](https://github.com/openai/codex/issues/4446)、[#15320](https://github.com/openai/codex/issues/15320)、[#21551](https://github.com/openai/codex/issues/21551)、[#25914](https://github.com/openai/codex/issues/25914)、[#32466](https://github.com/openai/codex/issues/32466)、[#16614](https://github.com/openai/codex/issues/16614)、[#17543](https://github.com/openai/codex/issues/17543)、[PR #17703](https://github.com/openai/codex/pull/17703)、[PR #17043](https://github.com/openai/codex/pull/17043)、[#13405](https://github.com/openai/codex/issues/13405)、[#6992](https://github.com/openai/codex/issues/6992)、[#23699](https://github.com/openai/codex/issues/23699)、[#23403](https://github.com/openai/codex/issues/23403)、[#22851](https://github.com/openai/codex/issues/22851)、[#31117](https://github.com/openai/codex/issues/31117)、[Discussion #11959](https://github.com/openai/codex/discussions/11959)
- 官方文档/公告：[App Server](https://developers.openai.com/codex/app-server)、[app-server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)、[Remote connections](https://developers.openai.com/codex/remote-connections)、[CLI reference](https://developers.openai.com/codex/cli/reference)、[Work with Codex from anywhere](https://openai.com/index/work-with-codex-from-anywhere/)
- 深度分析：danielvaughan Codex KB（[JSON-RPC 协议 3/28](https://codex.danielvaughan.com/2026/03/28/codex-app-server-json-rpc-protocol/)、[WS/远程 3/31](https://codex.danielvaughan.com/2026/03/31/codex-cli-app-server-remote-websocket/)、[完全指南 4/15](https://codex.danielvaughan.com/2026/04/15/codex-app-server-complete-guide/)、[v0.130 remote-control 5/9](https://codex.danielvaughan.com/2026/05/09/codex-cli-v0130-remote-control-headless-agent-services-thread-pagination/)）、[Origin "Codex on the Wire"](https://www.originhq.com/research/codex-on-the-wire)
- 第三方项目：[kcosr/codex-threads](https://github.com/kcosr/codex-threads)、[SeemSeam/claude_codex_bridge (CCB)](https://github.com/SeemSeam/claude_codex_bridge)、[alexei-led/ccgram](https://github.com/alexei-led/ccgram)、[coder/agentapi](https://github.com/coder/agentapi)、[steveyegge/gastown](https://github.com/steveyegge/gastown)（[Yegge 博文](https://steve-yegge.medium.com/welcome-to-gas-town-4f25ee16dd04)、[Inside Gas Town](https://www.augusteo.com/blog/inside-gas-town/)）、[Remodex](https://www.remodex.site/)、[primeline claude-tmux-orchestration](https://github.com/primeline-ai/claude-tmux-orchestration)、[tmux War Room](https://lugha.substack.com/p/beyond-the-chatbox-orchestrating)
- Claude Channels 对照：[datastudios 综述](https://www.datastudios.org/post/claude-code-channels-what-it-is-how-it-works-and-how-to-use-it-with-mcp-telegram-and-discord)、[claude-code#38736](https://github.com/anthropics/claude-code/issues/38736)、[#45563](https://github.com/anthropics/claude-code/issues/45563)、[#55896](https://github.com/anthropics/claude-code/issues/55896)、[MCP 2026-07-28 规范](https://blog.modelcontextprotocol.io/posts/2026-07-28/)

*推测项已在文中显式标注（Desktop 与 remote-control daemon 关系细节、macOS UI 自动化可行性、relay 协议逆向难度）；其余均有链接来源。*
