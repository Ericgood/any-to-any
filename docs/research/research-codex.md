# OpenAI Codex CLI 多 Session / 多 Agent 协作能力调研报告

- 调研日期：2026-08-05
- 本机版本：codex-cli **0.144.0**（npm `@openai/codex`，2026-07-09 发布；并非「2026 年初」——0.144.0 是 2026 年 7 月的版本）
- 最新稳定版：**0.146.0**（2026-07-29）；0.147.0 处于 alpha
- 证据来源：本机二进制/帮助文本/`~/.codex` 目录实测 + 官方文档（developers.openai.com/codex → 现跳转 learn.chatgpt.com/docs）+ GitHub release notes + 社区资料。**【事实】= 有一手证据；【推测】= 合理推断，未直接验证。**

---

## TL;DR

1. Codex 没有「任意两个独立 session 互相 @」的功能；用户描述的其实是 **Multi-agent / Subagents（collab 工具）**：一个根 session 内 spawn 出的每个 agent 都是一个真正的独立 session（独立 rollout 文件、有昵称、可 resume），agent 之间用 `send_message` / `followup_task`（V2）或 `send_input`（V1）互发消息——定向靠工具参数（task path / 昵称），**不是**用户在输入框打 `@`（TUI 的 `@` 至今只能 mention 文件/skill/图片/plugin；`@agentname` 语法只是 issue #12047 的提案）。
2. 该机制是**同一进程内**的协作（共享文件系统 + 进程内 mailbox），不能跨两个独立启动的 codex 进程。
3. 外部系统把消息注入 Codex 的官方通道非常齐全：`codex exec` / `codex exec resume`（headless）、`codex mcp-server`（`codex` + `codex-reply` 两个 MCP 工具，可按 threadId 续写任意会话）、**app-server JSON-RPC**（87 个方法，含 `thread/resume` 可 rejoin 正在运行的线程、`turn/start`、`turn/steer` 向进行中的 turn 注入输入、`thread/inject_items`）。
4. 取出消息的通道：`--json` 事件流、rollout JSONL 文件、`notify` 回调（agent-turn-complete）、hooks（PreToolUse…Stop，格式与 Claude Code hooks 高度兼容）、app-server 事件通知。
5. 云端（Codex cloud）是独立的云容器任务体系（`codex cloud exec/status/list/diff/apply`）；跨设备实时控制本地 session 走「macOS Codex 桌面 App + ChatGPT 手机 App 配对（remote-control）」，与 CLI 本地 session 数据（纯本地磁盘）是两套东西。

---

## Q1. 跨 session 的 @ / 协作功能：叫什么、怎么用、什么版本、什么机制

### 1.1 官方名称与版本

| 名称 | Feature flag | 0.144.0 状态（本机实测） | 引入/稳定时间 |
|---|---|---|---|
| Multi-agent V1（文档称 Subagents） | `multi_agent` | **stable, 默认开启** | 【推测】experimental 形态出现于 2025 年末~2026 年初（`collaboration_modes`、`multi_agent_mode` 等旧 flag 在 0.144.0 中已标 removed），2026 上半年转 stable；未找到确切首发版本号 |
| Multi-agent V2 | `multi_agent_v2` | under development（默认关，可手动开） | **0.145.0（2026-07-22）标记 stable（opt-in）**，release note 原文：“Stabilized the opt-in multi-agent V2 experience with configurable sub-agent models, reasoning levels, concurrency, restored roles, and improved agent navigation”【事实】 |

官方文档页：learn.chatgpt.com/docs/agent-configuration/subagents（原 developers.openai.com/codex/concepts/subagents）。

### 1.2 工具集（agent 互发消息的真正机制）

从 0.144.0 二进制字符串与本机 session 日志中直接确认【事实】：

**V1 工具**（`core/src/tools/handlers/multi_agents/`）：
- `spawn_agent` — 生成子 agent（继承当前模型；提示词明确要求「用户明确要求 subagents/并行时才用」）
- `send_input` — 给已存在的 agent 发消息/追加任务（“send message existing agent subagent follow up interrupt redirect queue target”）
- `wait_agent` — 等待 agent 达到最终状态
- `resume_agent` — 重新打开已关闭的 agent
- `close_agent` — 关闭 agent

**V2 工具**（`core/src/tools/handlers/multi_agents_v2/`，0.144.0 二进制里已内置，flag 打开即用）：
- `spawn_agent`（必填 `task_name`，可选 `agent_type`/`model`/`reasoning_effort`/`fork_turns`）
- `send_message` — “Send a message to an existing agent. The message will be delivered promptly. **Does not trigger a new turn**”（不能发给 `/root`）
- `followup_task` — “Send a follow-up task to an existing non-root target agent and **trigger a turn if it is idle**”
- `wait` — mailbox 语义：“Wait for a **mailbox update** from any live agent, including queued messages and final-status notifications”
- `list_agents` — 按 task-path 前缀过滤列出活跃 agent
- `interrupt_agent` — 打断 agent 当前 turn

**定向（“艾特”）方式**：V2 用**层级任务路径**，如 `/root/research/api`；在 `/root/task1` 下 spawn `task_3` 得到 `/root/task1/task_3`，之后可用相对名 `task_3` 或绝对路径引用【事实，二进制内工具说明原文】。每个 agent 还会分配人类可读**昵称**（本机 rollout 文件里实见 `"agent_nickname": "Boyle"`；角色配置支持 `nickname_candidates`）【事实】。

### 1.3 用户侧用法（命令/UI）

- 自然语言驱动：在对话里说「spawn 一个 agent 做 X / 让 researcher 去查 Y」，由模型调用上述工具。Codex 不会自动 spawn，需明确要求【事实，官方 subagents 文档】。
- TUI：`/agent` 切换活跃 agent 线程；`Alt+Left/Right` 在线程间移动；父线程打开的 V2 子线程为**只读**，父 agent 通过 collab 工具沟通【事实：官方文档 + danielvaughan 指南】。
- 打字时 `Enter` = steer（立刻打断注入）、`Tab` = queue（排队等本 turn 结束）——这是对**当前线程**的 steering，不是跨线程 @【事实】。
- 配置（config.toml）【事实，官方文档 + exsesx 博客】：
  ```toml
  [features]
  multi_agent_v2 = true          # 0.145+；0.144 也可试开（under development）

  [agents]
  enabled = true                  # 默认 true
  max_concurrent_threads_per_session = 8
  default_subagent_model = "..."
  default_subagent_reasoning_effort = "..."

  [agents.researcher]             # 自定义角色（V2）
  description = "Audit primary sources..."
  config_file = "./agents/researcher.toml"
  nickname_candidates = ["Ada", "Grace"]
  ```
- 角色文件：`~/.codex/agents/*.toml`（个人）或 `<repo>/.codex/agents/*.toml`（项目），字段 `name`/`description`/`developer_instructions`，可选 `model`、`model_reasoning_effort`、`sandbox_mode`、`mcp_servers` 等；内置角色 `default`/`worker`/`explorer`【事实：官方文档 + 本机 `~/.codex/agents/planner.toml` 实测同格式】。

### 1.4 「@」的真相

- **TUI 输入框的 `@` 不能艾特 agent/session**。0.144.0 二进制中 mentions_v2 的序列化标记只有 `[mention:`（文件路径）、`[skill:`、`[local_image:`；openai/codex 的 “unified mentions” 系列 PR（#27499 等）覆盖 files/skills/plugins/apps，无 agent【事实】。
- `@agentname` / `@teamname` / `@team/agent` 语法出自 **issue #12047**——这是 2026 年的**功能提案**（multi-agent TUI overhaul：命名 agent、团队、@mention 消息路由、共享 team inbox），截至 0.146.0 未发布【事实：issue 内容；结论「未发布」基于 0.146.0 release notes 与 PR 检索，接近事实】。
- 因此用户说的「不同 session 之间可以互相艾特」最准确的对应物是：**同一根会话内，多个 agent 线程（每个都是独立持久化的 session）之间用 send_message/followup_task 互相定向发消息**；「艾特」是对 task path/昵称定向的口语化描述。

### 1.5 实现机制

【事实】
- **进程内协作，非跨进程 IPC，非云端**：collab 工具 handler 在 `codex-core` 内；`max_concurrent_threads_per_session` 限制的是整棵树的并发线程数；V2 所有 agent 共享同一工作目录/文件系统，立即看到彼此的编辑（官方/博客一致）。
- **每个 agent 线程都是真 session**：独立 rollout 文件 `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`，首行 `session_meta` 含 `parent_thread_id`、`thread_source: "subagent"`、`source.subagent.thread_spawn{depth, agent_path, agent_nickname, agent_role}`（本机实测）；sqlite 状态库（`state_5.sqlite`）threads 表含 `agent_nickname/agent_role/agent_path/thread_source` 列；spawn 边持久化（“failed to persist thread-spawn edge”），支持 cold resume 后恢复子线程（“failed to resume descendant thread”）。
- **只在 Codex 内部使用**：确认。这些是发给模型的内部工具，没有对外命令行入口可以直接「以另一个 session 的身份」发消息；外部注入要走 app-server（见 Q4）。
- 【推测】V1 对 coding 子任务的提示词提到 “edit files directly in its **forked workspace**” 和 “review the **uploaded changes**”，暗示某些配置下（如远程/云执行器）子 agent 用 fork 的工作区再合并；本地默认仍是共享工作区。

---

## Q2. 自动化接入点全景：headless、resume、session 存储、config.toml

### 2.1 `codex exec`（headless）【事实：本机 `--help` + 官方 non-interactive 文档】

```
codex exec [OPTIONS] [PROMPT]
codex exec resume [SESSION_ID|THREAD_NAME] [PROMPT]   # --last 取最近
```
- 输出契约：进度走 stderr，**stdout 只打印最终 agent 消息**，适合管道。
- 关键参数：
  - `--json`：stdout 改为 JSONL 事件流
  - `-o/--output-last-message <path>`：最终消息另存文件
  - `--output-schema <path>`：按 JSON Schema 产出结构化结果
  - `--ephemeral`：不落盘 session 文件
  - `-s/--sandbox read-only|workspace-write|danger-full-access`（默认 read-only）
  - `-C/--cd <DIR>`、`--add-dir <DIR>`、`--skip-git-repo-check`
  - `-m/--model`、`-p/--profile`（叠加 `$CODEX_HOME/<name>.config.toml`）、`-c key=value`（点路径覆盖任意配置）、`--enable/--disable <FEATURE>`
  - `--ignore-user-config`、`--ignore-rules`、`-i/--image`
  - `--dangerously-bypass-approvals-and-sandbox`（CI 外部沙箱用）
- stdin：`codex exec -` 全量从 stdin 读；「参数 prompt + 管道 stdin」会把 stdin 追加为 `<stdin>` 块。
- 环境变量 `CODEX_API_KEY` 可单次注入 key。
- 典型用法：
  ```bash
  npm test 2>&1 | codex exec "summarize failing tests and propose fix"
  codex exec resume --last "fix the race conditions you found"
  codex exec resume 019xxxxx-... "继续，补上单测"
  ```

### 2.2 Session（thread）机制与磁盘格式【事实：本机实测】

- 交互恢复：`codex resume [SESSION_ID|SESSION_NAME] [PROMPT]`（`--last`、`--all`），`codex fork`（分叉）、`codex archive/unarchive/delete`（按 id 或 name 管理）。0.146.0 起可在 `/new`、`/clear` 时**命名 session**、pin 线程、多个「side conversations」并行切换。
- 磁盘布局（`$CODEX_HOME` 默认 `~/.codex/`）：
  - `sessions/YYYY/MM/DD/rollout-<ISO时间>-<uuid7>.jsonl` — 每 session 一个 JSONL「rollout」；首行 `{"type":"session_meta","payload":{id, cwd, originator, cli_version, source, parent_thread_id, thread_source, agent_nickname, base_instructions, ...}}`，后续为逐条事件/条目。
  - `session_index.jsonl` — 每行 `{id, thread_name, updated_at}` 的索引。
  - `state_5.sqlite` / `logs_2.sqlite` / `goals_1.sqlite` / `memories_1.sqlite` — 结构化状态（threads 表含名称、agent 元数据、rollout path），`history.jsonl` — 提示历史。
  - `archived_sessions`（归档）、`ipc/ipc.sock`（app-server 控制 socket，见 Q4）。

### 2.3 config.toml 结构（`~/.codex/config.toml`）【事实：本机真实配置 + 帮助文本】

顶层：`model`、`model_reasoning_effort`、`service_tier`、`notify = ["program", "arg"...]`、`approval_policy`、`sandbox_mode` 等。
表段：
- `[model_providers.<name>]`：`base_url`/`wire_api`/token 等自定义供应商
- `[projects."<abs path>"] trust_level = "trusted"`：目录信任
- `[features] <flag> = true/false`：与 `codex features list` 对应
- `[agents]` 与 `[agents.<role>]`：见 Q1
- `[mcp_servers.<name>]`：见 Q3
- `[hooks.state]`：hooks 信任哈希（配 `hooks.json`）
- `[shell_environment_policy]`、`[tui]`、`[desktop]`（桌面 App 共用同一份配置）
- Profiles：`$CODEX_HOME/<name>.config.toml` + `-p <name>` 分层叠加；任意键可用 `-c foo.bar=value` 临时覆盖；`--strict-config` 严格校验。

---

## Q3. MCP 支持

### 3.1 作为 MCP client【事实：官方 MCP 文档 + 本机 `codex mcp --help`】

- 子命令：`codex mcp list|get|add|remove|login|logout`（`login/logout` 处理 OAuth）。
- stdio 服务器：
  ```toml
  [mcp_servers.context7]
  command = "npx"
  args = ["-y", "@upstash/context7-mcp"]
  # 可选 env / cwd / env_vars / startup_timeout_sec / enabled
  ```
- Streamable HTTP 服务器：`url`（必填）+ `auth = "oauth" | "chatgpt"` 或 `bearer_token_env_var` / `http_headers`。
- CLI 快捷：`codex mcp add <name> -- <command...>`；配置在桌面 App / CLI / IDE 扩展间共享。

### 3.2 把 Codex 暴露为 MCP server【事实：本机 0.144.0 实测（stdio JSON-RPC 探测）】

`codex mcp-server`（stdio）— serverInfo `codex-mcp-server 0.144.0`，恰好暴露 **2 个工具**：

1. `codex` — “Run a Codex session”。入参：`prompt`（必填）、`model`、`cwd`、`sandbox`、`approval-policy`、`base-instructions`、`developer-instructions`、`compact-prompt`、`config`（覆盖任意 config.toml 键）。**返回 `{threadId, content}`**。
2. `codex-reply` — “Continue a Codex conversation by providing the thread id and prompt”。入参：`threadId` + `prompt`（旧字段 `conversationId` 已废弃）。返回 `{threadId, content}`。

结论：任何 MCP 客户端（Claude Code、其他 agent）都能把 Codex 当工具调用，并**凭 threadId 跨调用续接同一会话**。注意 `codex mcp` ≠ MCP server（那是管理外部 server 的子命令）；server 模式是 `codex mcp-server`。功能更全的程序化接口是 app-server（Q4）。

---

## Q4. hooks / 通知 / 向运行中 session 注入消息

### 4.1 `notify` 回调【事实：本机 config + 二进制字符串】

```toml
notify = ["/path/to/program", "extra-arg"]
```
turn 结束时 Codex 以 JSON 作为最后一个参数调用该程序；事件类型 `agent-turn-complete`，字段含 `thread-id`、`turn-id`、`cwd`、`input-messages`、`last-assistant-message`（二进制内 `legacy_notify` 模块）。单向、仅 turn 级、无法回注消息。

### 4.2 Hooks（0.144.0 已 stable）【事实：feature flag + 本机 hooks.json + 官方 hooks 文档】

- 位置：`~/.codex/hooks.json` 或 `~/.codex/config.toml`（用户级）、`<repo>/.codex/hooks.json`（项目级）、plugin manifest。
- 事件：`PreToolUse`、`PostToolUse`、`PermissionRequest`、`UserPromptSubmit`、`PreCompact`、`PostCompact`、`SessionStart`、`SessionEnd`、`Stop`、`SubagentStart`、`SubagentStop`。
- I/O：stdin 收 JSON（`session_id`、`transcript_path`、`agent_transcript_path`、`cwd`、`hook_event_name`、`model`、`turn_id`、事件专有字段）；stdout 返回 `{continue, stopReason, systemMessage, hookSpecificOutput}`；PreToolUse 可阻断工具调用（“Command blocked by PreToolUse hook”）。
- 信任机制：非托管 hook 首次运行前须在 `/hooks` 里审核信任，哈希写入 config.toml `[hooks.state] trusted_hash`；`--dangerously-bypass-hook-trust` 可绕过（自动化用）。默认超时 600s；输出超 ~2500 token 落盘。
- **与 Claude Code hooks 格式高度兼容**（同样的事件名/matcher/JSON 结构；本机同一份 hooks.json 直接复用了 Claude 脚本）。另有 `/import` 与 app-server `externalAgentConfig/import` 可导入 Claude Code / Cursor 的设置、MCP、sessions。

### 4.3 向正在运行的交互式 session 注入消息 —— **官方途径 = app-server**

【事实：本机 `codex app-server generate-json-schema` 导出的协议（87 个方法）】

- `codex app-server`：stdio 上的 JSON-RPC 服务；`codex app-server daemon start|stop|bootstrap|enable-remote-control`：本地常驻守护进程；`codex app-server proxy`：把 stdio 转发到**控制 socket**（本机存在 `~/.codex/ipc/ipc.sock`）；`codex remote-control start|stop|pair`：开启远程控制并生成配对码；TUI 可 `codex --remote ws://host:port` 连远程 app-server（TUI 本身已构建在 app-server 架构上，flag `tui_app_server` 标记 removed=永久启用）。
- 与注入直接相关的方法：
  - `thread/list`、`thread/loaded/list`、`thread/read`：发现会话（含**正在运行**的）
  - `thread/resume`：三种恢复方式（thread_id / history / path）；**“If thread_id identifies a running thread, app-server rejoins that thread”**——可以直接挂到运行中的线程上
  - `turn/start {threadId, input[], ...}`：给空闲线程发新消息（= 外部发起一个 turn，可临时覆盖 model/cwd/approvalPolicy 等）
  - `turn/steer {threadId, expectedTurnId, input[]}`：**向进行中的 turn 注入用户输入**（带活跃 turn 前置校验）
  - `turn/interrupt`、`thread/inject_items`（“Append raw Responses API items to the thread history without starting a user turn”）、`thread/name/set`、`thread/fork`、`thread/rollback`、`review/start`、`fuzzyFileSearch`、`command/exec` 等。
  - 服务端反向通知：`thread/realtime/started`、item/turn 事件流等。
- 现成参考实现：第三方 CLI **kcosr/codex-threads**——通过 UDS（`unix:///...sock`）或 `ws://`/`wss://` 连 app-server，提供 `list/show/messages/send THREAD_ID PROMPT/steer THREAD_ID TURN_ID PROMPT/interrupt/name/fork` 等命令，证明该链路可用【事实：项目 README】。
- 【推测】边界：在普通终端单独跑的 `codex` TUI 进程，其线程托管在**自己进程内**的 app-server 实例；外部要注入，需要该线程由共享 daemon 托管（桌面 App 的会话即如此）或 TUI 以 `--remote` 连到 daemon。对「另一个终端里已经跑着的裸 TUI session」，未验证 ipc.sock 是否总是可达它——把「一定可注入任意运行中 TUI」当作未证实。
- 另有批量 fanout：`spawn_agents_on_csv` 工具（每行 CSV spawn 一个 worker 子 agent，指令模板 `{column}` 插值，输出合并回 CSV；不支持远程环境）【事实：二进制字符串】。

---

## Q5. Codex 云端与 CLI 的关系、跨设备能力

【事实：官方 cloud 文档 + 本机 `codex cloud --help` + openai.com 博客/社区教程】

- **Codex cloud**：云端隔离容器里并行跑任务（环境可配置依赖/变量/setup 步骤）；可从 web、GitHub PR、Linear、Slack 发起；与本地 session 相互独立。
- CLI 接口：
  ```bash
  codex cloud list / status <task>
  codex cloud exec --env <ENV_ID> [--branch <b>] [--attempts N] "任务描述"   # 无 TUI 提交
  codex cloud diff <task>     # 看统一 diff
  codex cloud apply <task>    # 把云端产出的 diff 应用到本地工作树（也有顶层 codex apply）
  ```
- **跨设备**：
  - 云任务天然跨设备（web / IDE / CLI / 手机都能看）。
  - 本地 session 的跨设备**实时控制**走「**macOS Codex 桌面 App** 开启 remote control（Settings > Connections，扫码或 `codex remote-control pair` 配对码）→ ChatGPT 手机 App 连接 host」；手机能看到并驱动 host 上的本地 sessions，密钥/环境变量留在 host，手机断开任务继续跑。CLI/IDE/web 不能充当被配对的 host（只有桌面 App 可以，Windows 版暂不支持）。
  - CLI 的本地 session 数据（rollouts/sqlite）**纯本地磁盘，不自动云同步**【推测：未发现任何同步机制的证据；桌面 App 与 ChatGPT 侧的线程有各自的云侧存在，0.144.0 changelog 提到「Resumed ChatGPT threads」属于 ChatGPT 集成场景】。

---

## 对 Any-to-Any 项目的接入点结论

外部系统与 Codex 互通，可用机制按推荐顺序：

**送消息进去：**
1. **`codex exec` / `codex exec resume <threadId|name> "msg"`**——最简单可靠的官方 headless 通道；一次一个 turn；`--json` 同时拿到全事件流；threadId 可从 `--json` 事件或 `~/.codex/session_index.jsonl` 获取。适合「异步信箱→逐 turn 驱动」模型。
2. **`codex mcp-server`（stdio MCP）**——给 agent 系统（如 Claude Code `claude mcp add codex -- codex mcp-server`）用：`codex` 工具开新会话拿 `threadId`，`codex-reply` 持续对话。天然适合 agent↔agent 桥。
3. **app-server JSON-RPC（`codex app-server` stdio / daemon+`~/.codex/ipc/ipc.sock` / `remote-control` WebSocket）**——唯一能对**正在运行**的会话做事的官方通道：`thread/list` 发现、`thread/resume` rejoin、`turn/start` 发消息、`turn/steer` 打断注入、`thread/inject_items` 无 turn 注入上下文。参考实现：github.com/kcosr/codex-threads。要长期驻留建议 `codex app-server daemon start`（可 `enable-remote-control`）。
4. Codex 内部的 spawn_agent/send_message/followup_task 只在单个根会话的 agent 树内可用，**不适合**作为外部系统间总线（但可以在 prompt 里指示 Codex 用它并行干活）。
5. 云侧：`codex cloud exec` 提交、`cloud diff/apply` 取回。

**取消息出来：**
1. `codex exec --json` 的 JSONL 事件流 / `-o` 最终消息文件 / `--output-schema` 结构化输出。
2. 监听 `~/.codex/sessions/**.jsonl`（rollout 追加写）与 `session_index.jsonl`——被动、零侵入，任何 session（含交互式 TUI）都会写。
3. `notify` 配置：turn 结束回调外部程序（JSON 含 thread-id/last-assistant-message）——最轻量的「说完了叫我」。
4. **hooks**（stable）：`PostToolUse`/`Stop`/`SessionEnd`/`SubagentStop` 等事件把 JSON 推给任意脚本→转发到消息总线；与 Claude Code hooks 同构，两边可复用一套桥接脚本。
5. app-server 的服务器通知流（thread/turn/item 事件）——需要保持连接，信息最全。

**一句话**：想复刻「session 互相艾特」，正确做法不是找 Codex 的 @ 功能（不存在跨进程版），而是用 **app-server 的 `turn/start`/`turn/steer`** 或 **`codex exec resume`** 把消息路由到目标 threadId——Any-to-Any 的总线可以把每个 Codex thread 当作一个可寻址信箱（threadId/thread_name 即地址）。

---

## 来源

官方：
- https://developers.openai.com/codex/cli （→ https://learn.chatgpt.com/docs/codex/cli）
- https://developers.openai.com/codex/concepts/subagents （→ https://learn.chatgpt.com/docs/agent-configuration/subagents）
- https://learn.chatgpt.com/docs/non-interactive-mode （codex exec）
- https://learn.chatgpt.com/docs/hooks
- https://learn.chatgpt.com/docs/extend/mcp
- https://learn.chatgpt.com/docs/cloud
- https://github.com/openai/codex/releases/tag/rust-v0.144.0 、rust-v0.145.0 、rust-v0.146.0
- https://github.com/openai/codex/issues/12047 （@mention 提案）
- https://github.com/openai/codex/discussions/3898 、 https://github.com/openai/codex/discussions/11041 、 https://github.com/openai/codex/discussions/9200
- https://openai.com/index/work-with-codex-from-anywhere/

社区/第三方：
- https://exsesx.dev/blog/en/codex-agents-v2 （Agents V2 / 0.145.0）
- https://codex.danielvaughan.com/2026/04/11/codex-cli-multi-agent-orchestration-v2-complete-guide/
- https://codex.danielvaughan.com/2026/04/08/codex-cli-tui-shortcuts-slash-commands/
- https://codex.danielvaughan.com/2026/05/09/codex-cli-v0130-remote-control-headless-agent-services-thread-pagination/
- https://github.com/kcosr/codex-threads
- https://www.gradually.ai/en/changelogs/codex-cli/ 、 https://ppcbasic.com/changelog/codex/0.144.0/
- https://knightli.com/en/2026/05/16/codex-mobile-remote-access-chatgpt-app/ 、 https://www.verdent.ai/guides/codex-in-chatgpt-mobile

本机一手证据（codex-cli 0.144.0, macOS arm64）：
- `codex --help` 全子命令、`codex exec|resume|fork|mcp|mcp-server|app-server|cloud|remote-control|features --help`
- `codex features list`（multi_agent=stable、multi_agent_v2=under development、hooks=stable、mentions_v2=stable 等）
- `codex mcp-server` stdio JSON-RPC 实测（tools/list 返回 codex / codex-reply）
- `codex app-server generate-json-schema` 导出的 87 方法协议（thread/resume、turn/steer、thread/inject_items 等）
- `~/.codex/` 目录：sessions rollout JSONL（session_meta 含 parent_thread_id/agent_nickname）、session_index.jsonl、config.toml、hooks.json、ipc/ipc.sock、agents/*.toml、state_5.sqlite
- codex 原生二进制 strings（collab 工具描述原文、hooks 事件名、legacy_notify 字段、mentions_v2 序列化标记、spawn_agents_on_csv）
