# 本机实况探测（第一手资料）

> 探测时间：2026-08-05，设备：MacBook（darwin 25.2.0）。
> 这份报告是直接在用户机器上探测的结果，不依赖网络资料，可作为落地设计的基准事实。

## 已安装的 agent CLI

| CLI | 版本/位置 | 备注 |
|---|---|---|
| Claude Code | 2.1.198，`~/.npm-global/bin/claude` | 主力 |
| Codex CLI | 0.144.0，`~/.npm-global/bin/codex` | 主力 |
| Kimi Code | `~/.kimi-code/bin/kimi` | Node.js 技术栈（commander 风格 CLI） |
| Gemini CLI | `~/.npm-global/bin/gemini` | 已装，用户未重点提及 |
| Z Code / Q Code | 本机未装 | 需另行确认用户在哪台设备用 |
| tmux | `/opt/homebrew/bin/tmux` | 已装 —— 终端注入方案的前提 |

`gh` 已登录（账号 Ericgood）。

## Codex 0.144.0 本地接入点（重要发现）

`~/.codex/` 下的关键内容：

- **`ipc/ipc.sock`** —— Unix domain socket，权限 0600。Codex 自带本地 IPC 通道。
- **`codex app-server`**（实验性）+ **`codex remote-control`**（实验性，"Manage the app-server daemon with remote control enabled"）—— 官方守护进程 + 远程控制入口，这基本就是官方版的「外部驱动一个 Codex」。
- **`codex mcp-server`** —— 把 Codex 自身作为 MCP server（stdio）暴露，外部 MCP client 可以直接调它。
- **`codex mcp`** —— 管理外部 MCP server，即 Codex 也是 MCP client。
- **`codex exec`** —— headless 非交互模式；`codex resume <id>` / `codex fork` —— session 级恢复/分叉。
- **`hooks.json`** —— Codex 已支持 hooks（本机已配置 PreToolUse/PostToolUse，stdin 收 JSON、stdout 回传的协议，形态与 Claude Code hooks 高度相似）。
- **`config.toml` 的 `notify`** —— turn 结束时回调外部程序（本机已配置为 `turn-ended` 事件），出站通知通道现成。
- **`session_index.jsonl`** —— 每行 `{id, thread_name, updated_at}`，session 发现（discovery）现成。
- **`sessions/YYYY/MM/DD/rollout-*.jsonl`** —— 全量会话记录，可读。

## Kimi Code 本地接入点

`~/.kimi-code/` 下：

- **`session_index.jsonl`** —— 每行 `{sessionId, sessionDir, workDir}`，session 发现现成。
- **`sessions/wd_<项目>_<hash>/session_*/`** —— 按工作目录组织的会话存储。
- CLI 能力：`-p/--prompt` headless、`--output-format stream-json`、`-S/--session <id>` resume、`-c/--continue`、`--agent <name>` 自定义 agent profile、`--yolo`/`--auto` 自动批准模式。
- `config.toml`：模型/服务配置。本地未见 MCP/hooks 配置段（支持与否待网络调研确认）。

## Claude Code 本地接入点（本机 2.1.198）

- **`~/.claude/projects/<路径转义>/*.jsonl`** —— 每 session 一个 jsonl，28 个项目目录。
- **hooks** —— SessionStart 等已在用（本会话即有 SessionStart hook 输出）；hooks 可注入上下文（详见网络调研报告）。
- **`claude -p` / `--resume <session-id>` / `--continue`** —— headless 与 session 恢复。
- **`claude mcp serve`** —— Claude Code 自身可作为 MCP server。
- 本会话实测：Claude Code 会话内有 Agent teams / SendMessage（会话树内部通信），以及 `mcp__ccd_session_mgmt__*`（list_sessions / get_session / send_message / search_session_transcripts）这类 session 管理工具 —— 说明桌面端已有「跨 session 发消息」的原语，但仅限 Claude Code 自家生态。

## 对设计的直接启示

1. **三家 CLI 都有 headless + resume + session 索引** —— 「把消息作为一次 resume 投进目标 session」这条路（拉起式投递）在三家都走得通。
2. **Codex 的接入面最丰富**：hooks + notify + ipc.sock + app-server/remote-control + mcp-server，双向都有官方通道。
3. **tmux 已装** —— 「注入正在运行的交互式 REPL」可用 tmux send-keys 兜底，对任何 CLI 都通用。
4. **MCP 是最大公约数**：Claude Code、Codex 确认双向支持（client + server）；Kimi 待确认 client 支持。
