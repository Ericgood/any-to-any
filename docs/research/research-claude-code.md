# Claude Code 外部通信接入点调研

- **调研日期**: 2026-08-05
- **本机版本**: Claude Code 2.1.198（官方最新 changelog 已到 2.1.222）
- **核实来源**: 官方文档 code.claude.com/docs、官方 changelog（github.com/anthropics/claude-code）、本机 CLI `--help` 实测、本机 `~/.claude/` 目录实测
- **标注约定**: 未标注即为【事实】（有文档/实测依据）；不确定处显式标注【推测】

---

## TL;DR

1. **官方已经正面回答了「外部系统如何把消息送进一个运行中的 Claude Code session」**：答案是 **Channels**（research preview，v2.1.80+）——一个声明 `claude/channel` capability 的 MCP server 通过 `notifications/claude/channel` 把事件推进当前 session，Claude 空闲时立即开新回合处理，忙时排队。官方已有 Telegram / Discord / iMessage / fakechat 插件，自建 webhook channel 有完整官方教程。
2. **跨设备操控官方路径是 Remote Control**（research preview）：本地 CLI session 经 Anthropic API 中继，由 claude.ai/code 网页和 Claude 手机 App 收发消息、批准权限。仅限 claude.ai 订阅登录，无公开第三方 API。
3. **程序化双向通信的 GA 正门是 stream-json 双向 stdio**：`claude -p --input-format stream-json --output-format stream-json` 是一个长驻双向流（Agent SDK 即封装于此），支持多轮注入、interrupt、控制协议。
4. **逐轮注入的最稳妥方式**：`claude -p --resume <session-id>`，session 全量存在 `~/.claude/projects/<路径编码>/<uuid>.jsonl`，跨进程可续。
5. **Hooks 已扩到约 30 个事件**，多数支持 `additionalContext` 注入上下文；`PreToolUse` 可用 `updatedInput` 改写工具入参，`PostToolUse` 可用 `updatedToolOutput` 改写结果，`UserPromptSubmit` 可拦截 prompt；hook 类型含 command / **http（直接 POST 你的服务器）** / mcp_tool / prompt / agent。
6. **交互式 REPL 无官方注入 API**（feature request 开放中，issue #27441）；社区标准做法是 `tmux send-keys`。
7. **Agent teams / SendMessage 仅限同一 lead session、同一台机器**：teammate 是同机独立进程，信箱是本地文件 `~/.claude/teams/{team}/inboxes/{name}.json`，无官方跨机 agent 通信。
8. **MCP server 主动推送支持度**：channels 通知（专有扩展）✅、elicitation（v2.1.76+）✅、roots/list_changed ✅、WebSocket transport（适合服务器推送场景）✅；**MCP sampling 无任何支持迹象**。
9. **出站**：hooks（Stop/Notification/PostToolUse + curl/http hook）、channel reply tool、stream-json 输出流、transcript jsonl tail、`claude mcp serve`（把 CC 工具暴露为 MCP server，但无 agent loop）。

---

## 1. Hooks 全景

来源: https://code.claude.com/docs/en/hooks （以及 hooks-guide）

### 1.1 全部 hook 事件（2.1.x 现状，远多于早期的 8 个）

| 分组 | 事件 | 能否阻塞 | 关键专有输出 |
|---|---|---|---|
| 会话 | `SessionStart`（matcher: startup/resume/clear/compact/fork） | 否 | `additionalContext`、**`initialUserMessage`**（注入一条初始用户消息）、`watchPaths`、`sessionTitle`、`reloadSkills`；stdout 注入上下文 |
| 会话 | `Setup`（--init/--maintenance） | 否 | `additionalContext` |
| 会话 | `SessionEnd`（matcher: clear/logout/prompt_input_exit/...） | 否 | 仅清理用途 |
| 回合 | `UserPromptSubmit` | **是**（exit 2 或 `decision:"block"`） | `additionalContext`；stdout 注入上下文。**不能改写 prompt 文本**（无 updatedPrompt 字段），只能拦截或附加上下文 |
| 回合 | `UserPromptExpansion`（斜杠命令展开时） | 是 | `additionalContext` |
| 回合 | `Stop`（Claude 结束响应时；输入含 `last_assistant_message`） | **是**（exit 2 强制继续干活） | `additionalContext` |
| 回合 | `StopFailure`（API 错误终止回合；matcher: rate_limit/overloaded/...） | 否（输出被忽略） | — |
| 工具 | `PreToolUse`（matcher=工具名/正则） | **是** | `permissionDecision`(allow/deny/ask/defer) + **`updatedInput`（改写工具入参）** + `additionalContext` |
| 工具 | `PostToolUse` | 否（已执行） | **`updatedToolOutput`（改写工具结果）**、`decision:"block"`（把 reason 喂回给 Claude）、`additionalContext` |
| 工具 | `PostToolUseFailure` | 否 | `additionalContext` |
| 工具 | `PostToolBatch`（一批并行工具全部完成后） | 是（可停 agentic loop） | — |
| 权限 | `PermissionRequest`（需要权限决策时） | **是** | `decision.behavior`(allow/deny) + `updatedInput` |
| 权限 | `PermissionDenied`（auto-mode 分类器拒绝后） | 否 | `retry: true` |
| 子代理 | `SubagentStart` / `SubagentStop`（matcher=agent 类型） | 否 / 是 | `additionalContext`（Start 的 stdout 注入） |
| 任务/团队 | `TaskCreated` / `TaskCompleted` / `TeammateIdle` | **是**（exit 2 阻止/打回） | 质量门用 |
| 配置/文件 | `ConfigChange`、`InstructionsLoaded`、`FileChanged`（watch 文件）、`DirectoryAdded`（v2.1.203+）、`CwdChanged` | ConfigChange 可阻塞 | 副作用为主 |
| Worktree | `WorktreeCreate` / `WorktreeRemove` | Create 可失败 | `worktreePath` |
| 压缩 | `PreCompact` / `PostCompact` | Pre 可阻塞 | — |
| MCP | `Elicitation` / `ElicitationResult`（v2.1.76+） | 是 | `action`(accept/decline/cancel) + `content`（自动填表） |
| 显示 | `Notification`（matcher: permission_prompt/idle_prompt/**agent_needs_input**/**agent_completed**/elicitation_*/auth_success） | 否 | 出站通知的主挂点 |
| 显示 | `MessageDisplay` | 否 | `displayContent`（只改屏显不改 transcript） |

### 1.2 关键机制

- **hook 输入**（stdin JSON 或 HTTP POST body）：`session_id`、`prompt_id`、`transcript_path`（→ 全量对话 jsonl 路径！）、`cwd`、`permission_mode`、`hook_event_name`、子代理场景加 `agent_id`/`agent_type`。这让任何 hook 都天然知道「哪个 session、transcript 在哪」。
- **公共输出字段**：`continue`(false=整体停止)、`stopReason`、`suppressOutput`、`systemMessage`、`terminalSequence`。
- **exit code**：0=成功（此时才解析 stdout JSON）；2=阻塞错误（stderr 喂回给 Claude）；其他=非阻塞错误。
- **hook 类型**（重要）：`command`（shell）、**`http`（POST JSON 到任意 URL，等 JSON 响应）**、`mcp_tool`（调 MCP 工具当 hook）、`prompt`（让小模型做 yes/no 判定）、`agent`（起子代理判定，实验）。`http` 型 hook 本身就是一条官方出站通道。
- **异步 hook**：`"async": true` 后台跑不阻塞；`"asyncRewake": true` 后台跑、exit 2 时**唤醒 Claude** 并把 stderr/stdout 作为 system reminder 展示——即「后台任务完成后叫醒 agent」的官方原语。
- **结论（对本项目）**：hooks 可以「注入上下文 + 拦截改写工具层 + 出站上报」，但**不能凭空发起新回合**（除 asyncRewake 的唤醒语义和 Stop hook 的强制续跑外）；`UserPromptSubmit` 能拦不能改写正文。

## 2. Headless / 编程化

来源: https://code.claude.com/docs/en/headless 、 https://code.claude.com/docs/en/cli-reference 、 https://code.claude.com/docs/en/agent-sdk/overview 、 https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode （本机 `claude --help` 实测一致）

### 2.1 `claude -p`

- `claude -p "prompt"`，支持 stdin 管道（上限 10MB，v2.1.128+）；`--output-format text|json|stream-json`；`--json-schema` 结构化输出（结果在 `structured_output` 字段）；`--max-budget-usd`；`--fallback-model`；退出码可判成败。
- `--bare`：跳过 hooks/插件/CLAUDE.md/keychain 的最小模式，官方推荐用于脚本/SDK 调用（未来会成为 `-p` 默认）。注意 `--bare` 只认 `ANTHROPIC_API_KEY`。
- 权限：`--allowedTools`、`--permission-mode`（含 `dontAsk`）、`--dangerously-skip-permissions`、`--permission-prompt-tool <mcp工具>`（让一个 MCP 工具代答权限询问——**外部系统程序化接管权限决策的官方口子**）。

### 2.2 会话持久化与续接（跨进程注入的基石）

- **存储位置（本机实测）**：`~/.claude/projects/<cwd 路径编码>/<session-uuid>.jsonl`（全量事件流，含 user/assistant 消息、`queue-operation` 入队记录等），旁边有 `<session-uuid>/subagents/`、`<session-uuid>/tool-results/` 子目录；提示历史在 `~/.claude/history.jsonl`；项目登记在 `~/.claude.json`。
- `-c/--continue`：续当前目录最近会话；`-r/--resume <uuid|名字>`：续指定会话（按 ID 时只搜当前项目目录及其 worktree）；`--session-id <uuid>` 指定新会话 ID；`--fork-session` 续时另开新 ID；`--no-session-persistence` 不落盘。
- **多轮注入模式（GA、最稳）**：`claude -p "..." --output-format json | jq -r .session_id` 拿到 ID，之后每轮 `claude -p "新消息" --resume <id>`。官方 headless 文档明确给了这个模式。
- 【推测】同一 session 同时只能被一个进程跑；并发写同一 jsonl 无保护，外部系统应对每个 session 做串行队列。

### 2.3 stream-json 双向流（真正的长连接双向通道）

- `claude -p --input-format stream-json --output-format stream-json`：stdin 持续接收 NDJSON 用户消息，stdout 持续输出事件。用户消息形如（SDK 文档原样）：
  `{"type":"user","message":{"role":"user","content":[...]}}`（content 可含 image base64）。
- 辅助 flag：`--replay-user-messages`（stdin 的用户消息回显到 stdout 作确认）、`--include-partial-messages`（token 级增量）、`--include-hook-events`（hook 生命周期事件入流）、`--forward-subagent-text`（v2.1.211+，子代理文本/思考入流，嵌套层级带 `parent_tool_use_id` 可重建树）。
- 输出流首条 `system/init` 事件带 session_id、模型、工具、MCP server 状态、`capabilities` 数组（如 `interrupt_receipt_v1`，用于特性探测）；还有 `system/api_retry` 等事件；末条 `result` 带费用与 session 元数据。
- **控制协议**：stdin 还接受 `control_request`（changelog 实证：interrupt、`set_model` 等载荷；SDK 的 interrupt/setPermissionMode 即走此协议）。流式输入模式支持消息排队与实时打断；单条模式不支持。
- CJK 多字节切块曾有乱码 bug，v2.1.14x 已修（changelog）。

### 2.4 Agent SDK（TypeScript / Python）

- 包名：`@anthropic-ai/claude-agent-sdk`（TS）、`claude-agent-sdk`（Python）。本质是**把 Claude Code CLI 作为子进程 + stream-json 协议封装**；官方明言其他语言就直接跑 `claude -p` 子进程。
- 两种输入模式：单条 `query(prompt)`（可 `continue`/`resume` 续会话）与**流式 AsyncGenerator**（推荐，长驻 session：排队、打断、图片、权限回调）。Python 另有 `ClaudeSDKClient`（connect / `query()` / `receive_response()` / interrupt）。
- 能力对齐 CLI：内置工具、hooks（SDK 内注册回调）、subagents、MCP、权限回调 `canUseTool`、sessions（resume/fork）、skills/CLAUDE.md 自动加载、`createSdkMcpServer` 进程内自定义工具。
- 注意：Anthropic 不允许第三方产品用 claude.ai 登录/订阅额度跑 SDK，需 API key。
- 【推测】SDK 与 CLI 共用 `~/.claude/projects/` 存储，故 CLI 开的会话可被 SDK resume、反之亦然（文档称 sessions 机制同源；未见明文反例）。

### 2.5 背景 agent（同机异步注入的官方形态）

- `claude --bg "任务"`：以背景 agent 启动立刻返回，`claude agents` 打开管理视图（可 attach、回复、停止），`claude agents --json [--all]` 供脚本读取状态。
- v2.1.198：背景 session 需要输入或完成时**触发 `Notification` hook**（matcher `agent_needs_input` / `agent_completed`）——背景任务的出站信号已打通 hook。
- `--brief`：启用 `SendUserMessage` 工具（agent 主动向用户发消息的工具，配合 SDK/背景场景）。

## 3. MCP

来源: https://code.claude.com/docs/en/mcp 、 https://code.claude.com/docs/en/channels 、 https://code.claude.com/docs/en/channels-reference

### 3.1 作为 MCP client

- 传输：**stdio**、**HTTP**（推荐，`streamable-http` 为别名；支持 OAuth，`claude mcp login/logout`）、**SSE（已弃用）**、**WebSocket**（`type:"ws"`，文档明言「适合需要主动向 Claude 推事件的远程 server」，但不支持 OAuth 和 `--transport` flag，需 `claude mcp add-json` 配置）。
- 配置层级：`claude mcp add`（local/user scope，存 `~/.claude.json`）、项目 `.mcp.json`（需批准）、`--mcp-config` + `--strict-mcp-config`（会话级）、企业 managed-mcp。claude.ai 账号登录时 **claude.ai connectors 自动可用**。
- stdio server 环境里有 `CLAUDE_PROJECT_DIR`；支持 `roots/list` 且目录集变化时发 `notifications/roots/list_changed`（v2.1.203+）。
- 工具结果上限 `MAX_MCP_OUTPUT_TOKENS`（默认 25k token）；工具可自声明 `_meta["anthropic/maxResultSizeChars"]`（上限 50 万字符）、`_meta["anthropic/requiresUserInteraction"]`（强制逐次人工确认，v2.1.199+）、`_meta["anthropic/alwaysLoad"]`。

### 3.2 `claude mcp serve`（Claude Code 作为 MCP server）

- `claude mcp serve` 起一个 **stdio MCP server**，静默运行；可配进 Claude Desktop 等任何 MCP client。
- **只暴露 Claude Code 的工具**（View/Edit/LS/Bash 等），由调用方 client 自己负责确认逻辑。**没有 agent loop、不进入任何已有 session**——它是「借工具」不是「对话通道」，不能用它给某个运行中的会话发消息。

### 3.3 Server → Client 主动推送支持度

| 机制 | 支持 | 说明 |
|---|---|---|
| **channels 通知**（`notifications/claude/channel`，Claude 专有扩展） | ✅ v2.1.80+（research preview） | 唯一能「把消息推进对话」的机制，见 §5.1 |
| elicitation（`elicitation/create`） | ✅ v2.1.76+ | server 中途向用户要结构化输入，弹表单/浏览器；可用 `Elicitation` hook 自动应答（→ 可编程化） |
| roots/list_changed | ✅ v2.1.203+ | 目录集同步 |
| prompts / resources / tools 动态发现 | ✅ | MCP prompts 成为 `/mcp__server__prompt` 命令；resources 可 `@` 引用 |
| **sampling**（server 反向借 LLM） | ❌ | 官方 MCP 文档与全部 changelog **零提及**；【推测】未实现 |
| 普通 notification 推进对话 | ❌ | 非 channel 声明的 server 即使发通知也不会进入会话（channels 文档：未列入 `--channels` 的 server 消息被静默丢弃） |

## 4. 多 agent / teams

来源: https://code.claude.com/docs/en/sub-agents 、 https://code.claude.com/docs/en/agent-teams 、 https://code.claude.com/docs/en/remote-control 、本机 `~/.claude/teams/` 实测

### 4.1 Subagents（Agent tool）

- 同一进程内派生，独立上下文，结果汇报给父 agent；v2.1.198 起**默认后台运行**（父 agent 继续干活，完成时收通知；并发上限默认 20，`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`）。`SendMessage({to: name})` 可继续与已派生的 agent 对话。**仅限同一 session 树内。**

### 4.2 Agent teams（实验）

- `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` 启用。lead + teammates，每个 teammate 是**独立的 Claude Code 进程**（同一台机器），显示模式 in-process / tmux / iTerm2 panes（`teammateMode` / `--teammate-mode`）。
- **通信 = 本地文件**：信箱 `~/.claude/teams/{team-name}/inboxes/{agent-name}.json`（读时校验格式，坏条目剔除）；团队配置 `~/.claude/teams/{team-name}/config.json`（本机实测含 members[]、agentId、leadSessionId、tmuxPaneId、cwd）；共享任务列表 `~/.claude/tasks/{team-name}/`（文件锁防抢任务）。team 名为 `session-<sessionID前8位>`。
- 硬边界：**一个 session 只有一个 team、team 不跨 session、不跨机器**；lead 固定；teammate 不能嵌套建队；`/resume` 不恢复 in-process teammates。config.json 官方警告勿手工编辑（会被覆盖）。
- `SendMessage` 的安全语义：接收方被明确告知消息来自另一个 Claude session 而非用户；不能代用户批权限（v2.1.222 起 SendMessage 内容还要过权限分类器）。
- 【推测】外部进程直接往 inbox JSON 写消息可能被投递（格式对的话），但这是未文档化 hack，随时会变，不可靠。

### 4.3 官方跨设备能力（全部经 Anthropic 云中继，无点对点）

- **Remote Control**（research preview，全平台计划可用；Team/Enterprise 需管理员开启）：
  - 启动：`claude remote-control`（**server mode**：常驻等连接，`--spawn same-dir|worktree|session`，`--capacity` 默认 32 并发 session）／`claude --remote-control [name]`（交互 session 同时可远程）／会话内 `/remote-control`／VS Code。
  - 连接端：claude.ai/code 网页、Claude iOS/Android App（扫二维码/session URL）。**可远程发消息、看子代理/workflow 进度、批准权限、传图片文件**（下载到本机变 `@` 文件引用）；多设备同时在线同步。
  - 传输：本机**只发出站 HTTPS**（注册 + 轮询 + 流式中继），transcript 存 Anthropic 服务器以同步；无入站端口。要求 claude.ai OAuth 登录（API key/`setup-token` 不行）、`ANTHROPIC_BASE_URL` 必须是 api.anthropic.com、不可用于 Bedrock/Vertex/Foundry；进程被杀 session 即死（远程机上配合 tmux/screen 保活）；断网约 10 分钟超时。
  - 手机推送：`/config` 里开「Push when Claude decides / when actions required」；`CLAUDE_CLIENT_PRESENCE_FILE` 控制在座免推。Trusted Devices（Team/Enterprise beta）绑定设备+生物验证。
  - 【推测】Remote Control 的中继协议是 claude.ai 私有协议，无公开第三方 API，外部程序不能冒充客户端接入。
- **Claude Code on the web**（claude.ai/code 云沙箱）：全新云端 session，从 GitHub clone，不是本地 session。**Slack** `@Claude` 同样起云 session。**Dispatch**（Desktop）：手机 App 发任务 → 本机 Desktop 起 session。
- 不存在 `--remote` flag；正确名字是 `--remote-control`。

## 5. 向运行中 session 注入消息的现实手段

### 5.1 官方正门：Channels（research preview，v2.1.80+）

来源: https://code.claude.com/docs/en/channels 、 https://code.claude.com/docs/en/channels-reference

- **定义**：channel = 与 Claude Code 同机、由 CC 以 stdio 子进程方式拉起的 MCP server，声明 `capabilities.experimental["claude/channel"]: {}` 后，可随时调用 `mcp.notification({method: "notifications/claude/channel", params: {content, meta}})` 把事件推进**当前打开的 session**。
- **到达形态**：模型收到 `<channel source="名字" 各meta键=值>正文</channel>`；终端显示为 `← 来源: 摘要` 一行。**Claude 空闲则立即开新回合处理；忙则排队，下回合合并送达**（官方原文：Events queue into the session and are processed in order）。
- **双向**：server 再暴露一个普通 MCP 工具（如 `reply`），Claude 调它把回复发回去（server instructions 里教它带上 `chat_id`）。
- **权限中继**：声明 `claude/channel/permission` 后，权限弹窗会以 `notifications/claude/channel/permission_request`（request_id/tool_name/description/input_preview）推给 channel，远端回 `notifications/claude/channel/permission`（request_id + behavior allow/deny）即可远程批准——终端弹窗同时保留，先到先得。
- **启用**：`claude --channels plugin:telegram@claude-plugins-official ...`（官方插件：telegram / discord / imessage / fakechat，装为 plugin）；自建的用 `claude --dangerously-load-development-channels server:<mcp名>`。两个 flag 在 preview 期间**不出现在 `--help` 里但可用**。
- **限制**：需 claude.ai 或 Console API key 认证（Bedrock/Vertex/Foundry 不可用）；Team/Enterprise 需管理员 `channelsEnabled: true`；`--channels` 只认 Anthropic 维护的 allowlist（自建长期走 development flag，或企业 `allowedChannelPlugins`）；仅 session 打开期间收信（常驻需求要配 tmux/背景进程）；发件人 allowlist 是防注入的强制实践；`-p` 模式下会禁用 AskUserQuestion/plan 审批等需终端的工具以免卡死。协议标注「可能变」。
- **官方 webhook 示例**：文档给了完整单文件 `webhook.ts`（Bun + @modelcontextprotocol/sdk，本地 HTTP 端口收 POST → notification 进 session；SSE 出站），即「任何能发 HTTP POST 的外部系统 → Claude Code session」的官方参考实现。

### 5.2 官方间接手段

- **Remote Control**：人在其他设备发消息（见 §4.3），是「人类注入」不是「程序注入」。
- **`-p --resume` 逐轮追加**：外部系统可对任一历史 session 追加一轮（§2.2）——不是注入「正在运行」的进程，而是把同一份对话续跑一轮。
- **Hooks 搭便车**：`UserPromptSubmit`/`SessionStart`/`Stop` hook 读外部信箱（文件/HTTP）后以 `additionalContext` 注入、或 Stop hook exit 2 + stderr 指令让 Claude 继续处理新到消息——只能在已有回合边界触发，无法凭空开回合；`asyncRewake` 可在后台任务出错时唤醒。
- **背景 agent attach**：`claude agents` 视图可对背景 session 回复（终端交互，非 API）。
- 【实测旁证】Claude Desktop 内部有 `ccd_session_mgmt` MCP（list_sessions / send_message / search_session_transcripts），说明 Desktop 场景存在会话间发消息的内部机制——**未公开文档化，不可依赖**【推测】。

### 5.3 官方明确缺口与社区手段

- **缺口**：向运行中的交互式 REPL 注入输入没有官方 API/socket/named pipe。GitHub 上正是这个 feature request：anthropics/claude-code **issue #27441**「Inter-agent message injection — allow external processes to send prompts to a running Claude Code session」（开放中）。
- **社区标准做法：`tmux send-keys`**——把 Claude Code 跑在 tmux pane 里，外部 `tmux send-keys -t <pane> -l "文本"` + 单独发 `Enter`，注意起 session 后 sleep、避免提交碰撞（0.3s 延迟）。围绕它的编排项目如 primeline-ai/claude-tmux-orchestration、各类 orchestrator gist；第三方远控产品（Happy、Omnara、claude-code-remote 等）【推测】原理为 PTY 包装或 SDK/`-p` 循环。脆弱点：时序、TUI 变化、焦点，无投递确认。
- **出站通知模式（成熟）**：`Notification` hook（matcher: `permission_prompt` 权限等待、`idle_prompt` 空闲等输入、`agent_needs_input`、`agent_completed`）+ `Stop` hook，command 型 hook 里 `curl ntfy.sh/xxx`（或 Telegram Bot API、Pushover）即可把「需要你了」推到手机——社区广泛使用，官方 hooks 机制完全支持；`http` 型 hook 可免写脚本直接 POST。
- **transcript 监听**：hook 输入自带 `transcript_path`，外部 `tail -f` 该 jsonl 即可全量旁听会话（格式未承诺稳定【推测】）。

---

## 对 Any-to-Any 项目的接入点结论

目标场景：外部进程/另一台设备 ⇄ Claude Code session 双向送取消息。按**可靠性排序**（GA > preview > 社区 hack）：

### 入站（外部 → Claude Code）

| # | 机制 | 状态 | 适用形态 | 关键限制 |
|---|---|---|---|---|
| 1 | `claude -p --resume <id>` 逐轮续跑（或 Agent SDK resume） | **GA，最稳** | 信箱/总线驱动的「每条消息一轮」；跨进程、可从任意本机进程发起 | 不是注入正在运行的进程；每轮冷启动；同 session 需串行排队；目录绑定 |
| 2 | stream-json 双向 stdio 常驻进程（`-p --input-format stream-json --output-format stream-json`，即 Agent SDK 底座） | **GA** | 由我们的桥接进程**托管** CC session：随时写入用户消息、interrupt、读全量事件流 | 消息只能来自持有 stdin 的父进程 → 桥接进程本身要做网络端（这正是 Any-to-Any 桥的形态）|
| 3 | **Channels**（自建 webhook channel MCP server） | research preview（v2.1.80+） | 唯一能把消息推进「已打开的交互 session」的官方机制；HTTP POST 即达；带权限中继 | 需 claude.ai/Console 认证；自建长期依赖 `--dangerously-load-development-channels`；协议可能变；仅 session 存活期间 |
| 4 | Hooks 信箱（UserPromptSubmit/Stop/SessionStart 读外部队列 → additionalContext / exit 2） | GA | 给已有对话「捎带」外部消息；零额外依赖 | 只能搭回合边界的便车，不能主动开回合；对空闲 session 无效 |
| 5 | Remote Control | research preview | 人从手机/网页操控本机 session | 无公开 API，仅官方客户端；须 claude.ai 订阅登录 |
| 6 | tmux send-keys | 社区惯例 | 对**任何** CLI agent（含 codex/kimi 等）通用的最后手段 | 脆弱、无确认、依赖 TUI 稳定 |
| 7 | 直写 agent-teams inbox 文件 | 未文档化 hack | — | 不推荐；格式/生命周期随版本变【推测】 |

### 出站（Claude Code → 外部）

| # | 机制 | 状态 | 说明 |
|---|---|---|---|
| 1 | Hooks 出站（Stop/Notification/PostToolUse/SessionEnd 的 command/`http` hook） | **GA，最稳** | 回合结束、需要输入、工具执行等全部生命周期事件可 POST 到任意端点；输入含 session_id/transcript_path |
| 2 | 给 CC 配一个「send」MCP 工具（指向我们的消息总线） | GA | 让 Claude 主动发消息成为一次工具调用；**这是跨 agent 的最大公约数**——codex/kimi 等只要支持 MCP client 即可接同一总线 |
| 3 | stream-json stdout / SDK 消息流 | GA | 托管形态下天然获得全量结构化输出（含子代理 `--forward-subagent-text`） |
| 4 | Channel reply tool | preview | 双向 channel 的回复路径 |
| 5 | tail transcript jsonl（`~/.claude/projects/...`） | 实测可行 | 旁听用；格式无兼容承诺【推测】 |
| 6 | `claude mcp serve` | GA | 只是把 CC 工具借给别的 client 用，**不是**会话通道；不适合本需求 |

### 综合判断（【推测】部分为架构建议）

- **Claude Code 是当前主流 CLI agent 里外部接入点最全的**：channels（推入正在运行的会话）+ hooks（全生命周期出站/注入）+ stream-json 双向 + resume，四层齐备。
- 对 Any-to-Any（多 agent、多设备互通）的推荐组合：**跨 agent 公共层用「MCP send 工具 + 文件/HTTP 信箱 + 每 agent 的 resume/续跑命令」**（所有 agent 都有等价物）；**Claude Code 专属增强层用 channels（实时推入）+ Stop/Notification hooks（实时推出）**；跨设备传输自建（channels 的 webhook receiver 天然就是网络入口），不依赖 Remote Control 的封闭中继。

---

## 主要来源

- Hooks 参考: https://code.claude.com/docs/en/hooks
- Headless/编程化: https://code.claude.com/docs/en/headless
- CLI 参考: https://code.claude.com/docs/en/cli-reference
- MCP: https://code.claude.com/docs/en/mcp
- Channels: https://code.claude.com/docs/en/channels ／ 自建协议: https://code.claude.com/docs/en/channels-reference
- Remote Control: https://code.claude.com/docs/en/remote-control
- Agent teams: https://code.claude.com/docs/en/agent-teams ；Subagents: https://code.claude.com/docs/en/sub-agents
- Agent SDK: https://code.claude.com/docs/en/agent-sdk/overview ／ streaming: https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode
- Changelog: https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md （关键版本：channels 2.1.80、权限中继 2.1.81、elicitation 2.1.76、`--forward-subagent-text` 2.1.211、背景 agent Notification hook 2.1.198）
- 外部注入 feature request: https://github.com/anthropics/claude-code/issues/27441
- 社区 tmux 编排示例: https://github.com/primeline-ai/claude-tmux-orchestration
- 本机实测: `claude --help`（v2.1.198）、`~/.claude/projects/`、`~/.claude/teams/`、`~/.claude/tasks/`
