# 调研报告：Kimi Code CLI / ZCode / Amazon Q Developer CLI 可扩展性与自动化接入点

- 调研日期：2026-08-05
- 调研目的：评估外部系统能否与这三个 coding agent CLI 收发消息（自动化接入）
- 方法：官方文档 + GitHub 仓库 + **本机实测**（Kimi Code v0.32.0 已安装于 `~/.kimi-code/`，做了 headless、resume、web server API 三项实测；`q` 与 zcode 本机未安装，仅文档调研）
- 标注约定：无标注 = 已核实事实；**[推测]** = 合理推断；**[未核实]** = 存疑待验证

---

## A. Kimi Code CLI（Moonshot AI 月之暗面）

### A1. 开源情况 / 技术栈 / 是否 fork

- **开源，MIT 许可**。仓库：https://github.com/MoonshotAI/kimi-code ，文档：https://moonshotai.github.io/kimi-code/
- **技术栈：TypeScript**（Node ≥ 24、pnpm monorepo），对外以**单二进制**分发（本机实测：`~/.kimi-code/bin/kimi` 为 163MB Mach-O arm64 可执行文件，另捆绑了 `fd`）。
- **Kimi CLI 与 Kimi Code 的关系**：同一团队的两代产品。前代 **MoonshotAI/kimi-cli 是 Python 实现**（Apache-2.0，pyproject/uv，约 11k stars），官方声明 "Kimi CLI is evolving into Kimi Code CLI"，kimi-cli 逐步退役（"gradually wound down"），安装 kimi-code 时自动迁移旧配置与 session（另有 `kimi migrate` 命令）。
  - 来源：https://github.com/MoonshotAI/kimi-cli 、https://github.com/MoonshotAI/kimi-code/blob/main/README.zh-CN.md
- **不是任何开源 CLI 的 fork**：TS 版为自研重写（前代也是自研 Python）。媒体报道亦称其为"Built in TypeScript"的新代码库（https://www.marktechpost.com/2026/06/06/moonshot-ai-releases-kimi-code-cli-a-terminal-ai-coding-agent-built-in-typescript-for-next-gen-agents/ ）。
- 本机配置 `~/.kimi-code/config.toml`（TOML）：多 provider/model 声明式配置，默认模型 `kimi-code/k3`（1M context），另有 kimi-for-coding（K2.7）等。

### A2. MCP client 支持

- 配置文件 `mcp.json` 两级：**用户级 `~/.kimi-code/mcp.json`**、**项目级 `.kimi-code/mcp.json`**（项目级优先）。
- **transport 三种：stdio（本地子进程）、HTTP（streamable，推荐）、SSE（legacy，`transport: "sse"`）**。
- 认证：`headers` 自定义头、`bearerTokenEnvVar` 环境变量、**OAuth**（`/mcp-config login <server>` 浏览器授权）。
- 交互管理：`/mcp-config`（增删改）、`/mcp`（连接状态）。
- 来源：https://moonshotai.github.io/kimi-code/en/customization/mcp.html

### A3. Hooks / context 注入

- **有完整 hooks 机制，共 19 个事件**，配置在 `config.toml` 的 `[[hooks]]` 数组（字段：`event` / `matcher`(regex) / `command` / `timeout` 1–600s）。
- **可阻断事件 3 个：`UserPromptSubmit`、`PreToolUse`、`Stop`**；观察型事件包括 `UserPromptQueued`、`TurnStarted`、`PostToolUse`、`PostToolUseFailure`、`PermissionRequest`、`PermissionResult`、`SessionStart`、`SessionEnd`、`SessionHeartbeat`、`SubagentStart`、`SubagentStop`、`TaskStarted`、`StopFailure`、`Interrupt`、`PreCompact`、`PostCompact`、`Notification`。
- 协议与 Claude Code 高度同构：**stdin 收 JSON**（`hook_event_name`、`session_id`、`cwd` + 事件字段），**exit 0 放行 / exit 2 阻断**，stdout 可返回 JSON（`permissionDecision`）；**`UserPromptSubmit` 的 stdout 可注入 context**；fail-open 设计（超时/报错默认放行）。
- 来源：https://moonshotai.github.io/kimi-code/en/customization/hooks.html

### A4. Headless / resume / session 存储

- **`kimi -p "<prompt>"` 非交互模式**，`--output-format text | stream-json`（JSON lines：assistant 消息含 `tool_calls`，随后 tool 消息与后续 assistant 消息）。
- **本机实测**：`kimi -p "Reply with exactly one word: PONG" --output-format stream-json` 输出：
  ```json
  {"role":"assistant","content":"PONG"}
  {"role":"meta","type":"session.resume_hint","session_id":"session_8df9...","command":"kimi -r session_8df9...","content":"To resume this session: ..."}
  ```
  每次 `-p` 调用都会落盘一个 session 并回吐 `session.resume_hint`。
- **headless resume 实测成功**：`kimi -S <session_id> -p "上一条你回了什么"` 正确答出 "PONG" —— **`-p` 可与 `-S`（按 id resume）/`-c`（continue 当前目录最近 session）组合**，外部系统可实现多轮对话。另有别名 `-r`。
- 限制：文档载明 `-p` 不能与 `--yolo`/`--auto`/`--plan` 组合 **[未核实：print 模式下工具审批的默认行为]**。
- 其他 headless 相关：`--agent <name>` / `--agent-file <md>` 指定 agent profile 启动、`--skills-dir`、`--add-dir`。
- **session 存储（本机实测）**：`~/.kimi-code/sessions/wd_<工作区名>_<hash>/session_<uuid>/`（内含 `wire.jsonl` 完整历史），索引 `~/.kimi-code/session_index.jsonl`，工作区注册表 `~/.kimi-code/workspaces.json`；`kimi export [sessionId]` 可导出 ZIP；`kimi vis` 浏览器可视化 session。
- 来源：`kimi --help` 本机输出、https://moonshotai.github.io/kimi-code/en/reference/kimi-command.html

### A5. Agent 间通信 / 多 session 协作

- **Sub-agents**：Markdown + YAML frontmatter 定义（`name`/`description`/`tools`/`disallowedTools`/`override`），目录优先级：项目 `.kimi-code/agents/`（或 `.agents/agents/`）> 用户 `~/.kimi-code/agents/` > 插件 > 内置；主 agent 自动或按指示调度。
- **subagent 之间无直接通信**：各自独立 context，仅接收任务描述、仅回传最终结果（与 Claude Code Task 模型一致）；运行记录持久化到 session 目录 `agents/` 子目录。
- 无内置的跨 session / 跨实例消息机制。**[推测]** web server 的 `/sessions/{id}/children`（GET/POST）端点对应父子 session（subagent 任务）结构，外部可借此编排"多 session 树"，但这不是对等 agent 通信。
- 来源：https://moonshotai.github.io/kimi-code/en/customization/agents.html + 本机 OpenAPI 实测

### A6. Server / SDK 暴露能力（三条通道，同类产品中最强）

1. **ACP server：`kimi acp`** —— 以 Agent Client Protocol（JSON-RPC over stdio）作为 server 运行，供 Zed / JetBrains 等 ACP client 驱动；前代 kimi-cli 也早已支持 ACP。
2. **本地 REST + WebSocket server：`kimi web`** —— 默认 `127.0.0.1:58627`，**bearer token 鉴权**（启动时打印，`rotate-token` 轮换），`--host` 可绑 0.0.0.0（附 DNS-rebinding 防护、远程 shutdown/PTY 默认关闭等安全开关）。**本机实测 `GET /openapi.json`（"Kimi Code Server API 0.32.0"）关键端点**：
   - `POST /api/v1/sessions`（建会话）、`GET /api/v1/sessions`
   - **`POST /api/v1/sessions/{id}/prompts`（发消息）**、`POST .../prompts:steer`（运行中转向）
   - `GET .../messages`、`.../transcript`、`.../status`、`.../snapshot`、`.../goal`、`.../tasks`
   - **`GET .../approvals` + `POST .../approvals/{approval_id}`（程序化审批工具调用）**、`.../questions`（回答 agent 提问）
   - `.../children`（子 session）、`.../terminals`（PTY）、`/api/v1/files`、`/api/v1/mcp/servers`、`/api/v1/models`、`/api/v1/providers`、`POST /api/v1/shutdown`
   - WebSocket（`GET /asyncapi.json`）：单通道 `kimiCodeWebSocket`，双向 `sendServerMessages` / `receiveClientMessages` 流式收发。
   - server 实例记录于 `~/.kimi-code/server/instances/`。
3. **官方 Agent SDK：https://github.com/MoonshotAI/kimi-agent-sdk** —— **Go / Node.js / Python** 三语言（`npm install @moonshot-ai/kimi-agent-sdk`、`pip install kimi-agent-sdk`、`go get .../go`），定位与 Claude Agent SDK 类似："thin, language-native clients" 复用 CLI 的配置/tools/skills/MCP，支持多轮对话、实时流式、审批上抛、**注册自定义工具**。**[推测]** 底层通过拉起 CLI 进程或连接其本地 server 通信（文档未明说传输机制）。

**结论（A）**：接入面最完整——headless+stream-json、按 id resume、19 事件 hooks、REST/WS server（含程序化审批与 steer）、ACP、3 语言 SDK 全齐。

---

## B. ZCode（智谱 Z.ai / Zhipu）

### B1. 产品定性：不是 CLI，是闭源桌面 ADE

- **官方名 ZCode**，定位 **ADE（Agentic Development Environment，智能体开发环境）桌面应用**，官网 zcode.z.ai（macOS arm64/x64、Windows x64/ARM64 安装包；Linux 内测）。2025-12-26 发布。
- **闭源**：客户端未公开源码，未找到官方 GitHub 仓库（zai-org 组织下为模型仓库，无 ZCode/CLI 仓库）。其 Skill / MCP / Plugin 扩展机制可自定义，但本体非开源。
- 评测明确："不是 IDE 插件，也不是命令行工具"。
- **演进（回答"是否 opencode 定制版"）**：
  - 早期（2025-12 发布时）：**可视化管理主流 CLI 的 GUI 壳**——在图形界面里统一调用 Claude Code、Codex、Gemini CLI 等；当时有文章记载其 **MCP 配置"直接复用 Claude Code 的标准配置文件"（`~/.claude/settings.json` 与项目 `.claude/settings.json`）**，即依附于被管 CLI 的生态。
  - **ZCode 3.0（2026-06，随 GLM-5.2 发布）："全面切换自研 ZCode Agent 内核"**，深度适配 GLM-5.2（1M context），新增分组任务工作区、Zread 知识库。
  - **[推测]** 因此 ZCode 不是 opencode 的 fork：早期是"包装第三方 CLI 的壳"，3.x 起为（官方宣称的）自研内核；"自研"说法来自官方宣传口径，内核实际血统无法从外部验证 **[未核实]**。
- **Z.ai 没有第一方开源 coding CLI**。GLM Coding Plan 的 CLI 玩法 = 官方支持的**第三方工具白名单**：Claude Code、Cline、OpenCode、Roo Code、Goose、Crush、OpenClaw、Kilo Code（Claude Code 走 Anthropic 兼容端点，其余走 OpenAI 兼容端点），并明确"不得在支持工具范围外使用套餐"。ZCode 本身用 GLM Coding Plan 账号授权、直接扣套餐额度。
- 来源：https://segmentfault.com/a/1190000048082001 、https://www.cnblogs.com/youring2/p/21143184 、https://zhuanlan.zhihu.com/p/1987989693485323062 、https://cloud.tencent.com/developer/news/4083028 、https://docs.z.ai/devpack/tool/others 、https://z.ai/subscribe 、https://docs.bigmodel.cn/cn/coding-plan/tool/opencode 、https://www.digitalapplied.com/blog/glm-5-2-zai-flagship-coding-plan-release

### B2. MCP client

- 支持，在桌面客户端内配置；评测称支持**三种类型：stdio、HTTP/SSE、完整 JSON 配置**导入；需在智谱开放平台取 API Key 的说法针对其内置 MCP 市场 **[未核实：官方文档对 transport 的精确表述]**。
- **[推测]** 3.x 自研内核自带 MCP client；1.x/2.x 时代实际复用被管 CLI（如 Claude Code）的 MCP 配置。

### B3. Hooks / context 注入

- **未发现任何 hooks 机制**（公开资料无 UserPromptSubmit/Stop 类事件、无生命周期命令注入点）。扩展手段仅 Skill / Plugin / MCP。

### B4. Headless / 非交互 / session

- **无 headless、无 CLI 入口**（应用内提供"命令行面板"是给用户在 GUI 里跑 shell 命令，不是对外的非交互模式）。
- session/workspace：以本地项目目录为工作区，长程任务在 GUI 内管理；无对外可编程的 session 存取接口。

### B5. 多端 / 多人协作（其特色，但走云端）

- **Bot Channel**：**飞书 / 微信 Bot 可加入某个 workspace**，群里 @bot 触发与推进任务；**Remote**（手机端）与 Bot 可同时接入同一 workspace，多人协作推进同一长程任务。
- 这是外部"收发消息"的唯一现实通道，但**经由智谱云中转、绑定官方 IM 生态**，无公开 API/webhook 文档供第三方系统仿照接入 **[未核实：Bot Channel 是否有开放 API]**。

### B6. Server / SDK

- **无**：不暴露本地 server，无 SDK，无 ACP。

**结论（B）**：ZCode 对本地自动化接入基本封闭（无 CLI/headless/hooks/server）；外部消息接入只有飞书/微信 Bot Channel 这一封闭通道。若目标是"与 GLM 生态的 coding agent 通信"，现实路径是绕开 ZCode，用 GLM Coding Plan 支持的开源 CLI（如 OpenCode/Claude Code 接 Z.ai 端点），拿它们的成熟自动化接口。

---

## C. Q Code = Amazon Q Developer CLI（AWS，命令 `q`）

### C0. 重要前提：产品已进入日落期

- 开源仓库 https://github.com/aws/amazon-q-developer-cli **已停止主动维护（仅安全补丁）**；产品线迁移到 **Kiro CLI（`kiro-cli`，闭源）**。时间线：**2026-05-15 停止新注册，2027-04-30 全面停服**；迁移时 `~/.aws/amazonq` 的 agents/prompts 自动拷贝到 `~/.kiro`，MCP 配置拷到 `~/.kiro/settings/mcp.json`。该 GitHub 仓库的 issue 区现同时承接 kiro-cli 反馈。
- 来源：https://github.com/aws/amazon-q-developer-cli 、https://kiro.dev/docs/cli/migrating-from-q/ 、https://www.digitalapplied.com/blog/amazon-q-to-kiro-migration-playbook 、https://cloudvisor.co/amazon-q-developer-to-kiro-migration/

### C1. 开源 / 技术栈 / 是否 fork

- **开源，MIT + Apache-2.0 双许可**；**Rust** 为主（核心 crate `chat_cli`，`cargo run --bin chat_cli`）+ 少量 TypeScript。AWS 自研，**非 fork**。

### C2. MCP client

- 两套配置：
  1. **Custom agents（现行推荐）**：agent JSON（**全局 `~/.aws/amazonq/cli-agents/*.json`**，项目 `.amazonq/cli-agents/*.json`，文件名即 agent 名）内 `mcpServers` 字段：`{"git": {"command": "git-mcp", "args": [], "env": {...}, "timeout": 120000}}`。
  2. **Legacy**：`useLegacyMcpJson: true` 时加载全局 `~/.aws/amazonq/mcp.json` + workspace `cwd/.amazonq/mcp.json`。
- **transport：本地 stdio + 远程 HTTP（可 OAuth 或免认证）**。`/tools` 查看工具与加载状态，`q settings mcp.initTimeout <ms>` 调初始化超时；`/prompts` 与 `@prompt-name` 使用 MCP prompts。
- 来源：https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/qdev-mcp.html 、https://github.com/aws/amazon-q-developer-cli/blob/main/docs/agent-format.md 、https://aws.amazon.com/blogs/devops/extend-the-amazon-q-developer-cli-with-mcp/

### C3. Hooks / context 注入

- **有，两个体系**：
  1. **Context hooks**：跑 shell 命令并把 **stdout 注入对话 context**；两类触发——**conversation start**（会话开始一次、全程保留）与 **per prompt**（每条用户消息前）。来源：https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/command-line-context-hooks.html
  2. **Agent hooks**（agent JSON `hooks` 字段）：**触发点 `agentSpawn` / `userPromptSubmit` / `preToolUse` / `postToolUse` / `stop`**，每条含 `command`（必填）与 `matcher`（可选，匹配工具名，用于 pre/postToolUse），工具调用信息经 stdin 传给命令。agentSpawn/userPromptSubmit 的输出作为 context 注入。
- **[未核实]** `preToolUse` 能否像 Claude Code 那样以 exit code 阻断工具调用——agent-format.md 未写明阻断语义。

### C4. Headless / resume / session 存储

- **headless：`q chat --no-interactive [--trust-all-tools] "<prompt>"`**；prompt 必须作为参数传入（**不支持管道 stdin**，issue #2195）；已知缺陷：no-interactive 下仍可能卡在等待交互（issue #1951）。无 JSON 输出格式（纯文本）。
- **resume：`q chat --resume`** —— 对话**按工作目录自动保存**，回到该目录续聊；另有 `/save` `/load` 手动导出/加载。**不支持按 session id resume**（只认 cwd 维度；issue #1871 记载 `q --resume` 与 `q chat --resume` 行为不一致的 bug）。
- **session 存储：SQLite** —— macOS `~/Library/Application Support/amazon-q/data.sqlite3`，Linux `${XDG_DATA_HOME:-~/.local/share}/amazon-q/data.sqlite3`。
- 来源：https://aws.amazon.com/blogs/devops/exploring-the-latest-features-of-the-amazon-q-developer-cli/ 、https://github.com/aws/amazon-q-developer-cli/issues/808 、/issues/2195 、/issues/1951 、/issues/1871 、https://dev.to/torifukukaiou/measuring-chat-count-after-hitting-the-amazon-q-developer-claude-sonnet-4-pro-limit-48e7 、https://builder.aws.com/content/2uKLVWiD6gv8qlxeCX0rRcImjj2/managing-conversations-resume-load-and-save-context-in-amazon-q-developer-cli

### C5. Agent 间通信 / 多 session 协作

- **无**。custom agents 是"配置 profile"（工具白名单+hooks+MCP+prompt），一次一个；无并发 subagent、无跨 session 消息机制。

### C6. Server / SDK / ACP

- 经典 `q` CLI：**无 server 模式、无 SDK、无 ACP**。
- **继任者 Kiro CLI 补上了 ACP**：`kiro-cli acp` 以 JSON-RPC over stdio 运行 ACP server（Zed/JetBrains 等接入，支持 slash commands、MCP tools、session 管理扩展；ACP 规范 2026-06 达 1.0）。Kiro CLI 亦有 headless 模式（2026-04 加入）。已知 bug：ACP 模式下 MCP 工具不可用（issue #3640，已关闭）。
- 来源：https://kiro.dev/docs/cli/acp/ 、https://zed.dev/acp/agent/kiro-cli 、https://kiro.dev/blog/kiro-adopts-acp/ 、https://github.com/aws/amazon-q-developer-cli/issues/3640

**结论（C）**：接入面"够用但过时"——headless + cwd-resume + context/agent hooks + MCP 可拼出自动化管线，但无 server/SDK、resume 不能指定 id、且产品 2027-04 停服；新集成应直接面向 Kiro CLI（含 ACP + headless）。

---

## 接入可行性对比表

| 能力 | Kimi Code CLI（`kimi`） | ZCode（智谱桌面 ADE） | Amazon Q Dev CLI（`q`） |
|---|---|---|---|
| **MCP client** | ✅ stdio / HTTP / SSE + OAuth；`~/.kimi-code/mcp.json` + 项目级 | ✅（GUI 内配置；称支持 stdio/HTTP/SSE）| ✅ stdio + 远程 HTTP(OAuth)；agent JSON `mcpServers` / legacy `mcp.json` |
| **Hooks** | ✅ 19 事件；UserPromptSubmit/PreToolUse/Stop 可阻断；stdout 注入 context | ❌ 无 | ✅ context hooks（stdout 注入）+ agentSpawn/userPromptSubmit/preToolUse/postToolUse/stop；阻断语义未核实 |
| **Headless** | ✅ `kimi -p` + `--output-format stream-json`（实测通过） | ❌ 无 CLI 入口 | ✅ `q chat --no-interactive`（纯文本、不吃管道、有已知 bug） |
| **Resume（编程可用）** | ✅ `-S/-r <session_id>` 或 `-c`，**可与 `-p` 组合**（实测通过）；session 明文存 `~/.kimi-code/sessions/` | ⚠️ 仅 GUI 内 workspace 续任务，无编程接口 | ⚠️ `q chat --resume` 仅按 cwd，最近一条；SQLite 存储 |
| **Server / SDK 模式** | ✅✅ `kimi acp`（ACP/stdio）+ `kimi web`（REST+WS，含发消息/steer/审批端点，实测）+ Go/Node/Python SDK | ❌ 无 server/SDK/ACP；仅飞书/微信 Bot Channel（云端封闭通道） | ❌ 无（ACP 在继任者 `kiro-cli acp` 上） |
| **Agent 间通信** | ⚠️ subagents 单向（无互通）；server 有 children-session 端点 | ⚠️ 多人经 Bot Channel 共推同一任务（云端） | ❌ 无 |
| **外部系统收发消息综合评级** | **优**（四条通道：headless / REST+WS / ACP / SDK） | **差**（仅官方 IM Bot 通道） | **中**（headless+hooks 可拼；产品日落中，建议面向 Kiro CLI） |

---

## 附：接入实测勘误（2026-08-10，kimi 0.32.0，建 adapter 时验证）

对照 A 节调研，本机实装再验，修正/补强三点：

1. **`-p` 与 `-y`/`--auto`/`--plan` 互斥已确证**：`kimi -y -p …` 报 `error: Cannot combine --prompt with --yolo`，`--auto` 同样报错。A4 当时标「未核实」的审批默认行为现已明确——**默认 `-p` 直接自动执行工具**（实测创建文件成功），无需也无法用旗标提权（与 ZCode「build 只读需机主提 yolo」正相反）。
2. **session_index.jsonl 字段极简**：仅 `sessionId`/`sessionDir`/`workDir`，**无标题无时间戳**——adapter 标题取 `basename(workDir)`、活跃度取 `stat(sessionDir).mtime`。
3. **stream-json 回信解析**：终态 `role:assistant` 行含 marker，其后紧跟 `role:meta` 的 `session.resume_hint`（"To resume this session…"）——必须只取 assistant 非空 content 拼接，排除 tool 与 meta，否则污染回信。text 模式另有 `• ` 前缀，故 adapter 统一用 stream-json。

实现见 [phase3-kimi-adapter.md](../specs/phase3-kimi-adapter.md)。真机端到端通过（发现 7 会话 + 探针投递 + marker 回信干净解析）。
