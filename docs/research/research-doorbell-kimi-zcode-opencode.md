# 调研：Kimi / ZCode / OpenCode 的「门铃」—— 怎么把消息送进正开着的会话

> 创建：2026-10-13 · 最后更新：2026-10-13
> 前情：ADR-027 已给 Claude（官方收件箱 socket）和 Codex（`codex queue` 进 Desktop 队列）装上门铃。本篇查剩下三家。
> 方法：本机实测（Kimi 0.41.0、ZCode App 3.11.2 / CLI 0.16.5）+ ZCode 开源仓库源码 + 官方文档与 issue。OpenCode 本机未安装，仅文档调研。

## TL;DR

| | 正开着时能马上送达吗 | 入口 | 空闲会话能被叫醒吗 | 证据 |
|---|---|---|---|---|
| **ZCode** | **能（回合中 / 回合结束 / 下次开口）** | 原生会话信箱：往 `~/.zcode/mailbox/<会话>/unread/` 写 JSON 文件；需环境变量 `ZCODE_MESSAGE_ENABLED=1` | 不能（只在三个时点领取） | **本机 CLI 实测成功 + 对照组成立**；桌面版待验证 |
| **OpenCode** | **能（架构天生支持）** | 终端界面本身就是本地服务的客户端：`POST /session/:id/prompt_async` | 能（服务端直接起回合，界面通过事件流看到） | 官方文档；本机未安装，**未实测** |
| **Kimi（终端界面）** | **不能** | 无。终端界面自带运行时，外部无入口。官方 issue [#4112](https://github.com/MoonshotAI/kimi-code/issues/4112)（2026-10-03，open，无回应）提的正是这个需求 | — | issue 原文 |
| **Kimi（`kimi web` 网页界面）** | **能** | `POST /api/v1/sessions/{id}/prompts`，回合中可 `prompts:steer`；实例登记在 `~/.kimi-code/server/instances/*.json` | 能 | 本机读到 0.41.0 的 OpenAPI |

**最值得做的是 ZCode**：原生信箱零依赖、实测可用，而且能在回合中途送达，这一点比 Claude / Codex 的门铃还细。**OpenCode** 架构最干净，但 anytoany 还没有它的适配器，要先装上实测。**Kimi** 的终端界面目前没有路，只能等官方。

## 1. ZCode：原生会话信箱（未公开功能）

**来源**：本机 `ZCode.app/Contents/Resources/glm/zcode.cjs`（CLI 0.16.5），对照开源仓库 [zai-org/ZCode](https://github.com/zai-org/ZCode)（Apache-2.0，2026-09 开源）的 `apps/zcode-cli/packages/core/src/hooks/session-mailbox.ts`、`adapters/src/mailbox/index.ts`、`bootstrap/src/app/create-app.ts`。

- **开关**：`app-config-options.ts` 中 `env.ZCODE_MESSAGE_ENABLED === "1" || "true"`，默认关闭。
- **位置**：`ZCODE_MAILBOX_ROOT`，默认 `~/.zcode/mailbox`；每个会话一个目录 `<sess_…>/unread/` 和 `read/`，按文件名排序，每次最多领取 20 封。
- **信件格式**（`parseEnvelope` 严格校验）：`{ "version": 1, "messageId", "fromSessionId", "toSessionId", "content", "createdAt" }`，全部为字符串。
- **领取时点**（内置钩子 `builtin.sessionMailbox.drain`）：
  - `UserPromptSubmit`：用户开口时，作为附加上下文注入；
  - `PostToolUse`：**回合进行中**，作为待处理输入插进当前回合；
  - `Stop`：回合结束时注入并 `continue: true`，即**带着信继续干**。
  - 注入形态：`<session-message source="mailbox" message_id=… from_session=… created_at=…>`。
  - **完全空闲、停在输入框的会话不会被叫醒。**
- **本机实测（一次性测试会话，plan 模式，不碰用户真实会话）**：
  1. 在测试目录建会话 `sess_149a52e6…`，用 anytoany 的 ZCode 扫描器按 cwd 唯一定位（恰好 1 个）。
  2. 往 `unread/` 放一封信（要求回复里带 `MAILBOX-OK-7731`）→ 带开关续接并发一句普通的话 → **回复里带出令牌，信件从 `unread/` 移到 `read/`**。
  3. 对照组：不带开关重复一次 → 令牌**没有**出现，信件**留在** `unread/`。测试信箱随后已清理。
- **桌面版**：用同一个运行时，以子进程方式启动 `glm/zcode.cjs app-server --stdio`，只额外设置了 `ELECTRON_RUN_AS_NODE`。桌面版服务层**没有**注入自己的信箱实现（全仓库只有 CLI 的 `create-app.ts` 会创建它）。因此推断：只要 ZCode 启动时环境里带着开关，桌面会话也会读这个信箱。**未实测**，需要用 `open --env ZCODE_MESSAGE_ENABLED=1 -a ZCode` 启动一次来验证，这一步要征得用户同意。
- **桌面版里还有一套正在建设的东西**：`packages/services` 有 `SessionMessageSendRequested` / `deliverSessionMessage`（ZCode 自家「会话 A 发信给会话 B」的管道），其中一个实现目前直接返回 `unsupported`；另有给手机 / 机器人通道用的「任务命令队列」，会在任务空闲时自行消费。这些都是 ZCode 内部协议，外部暂时接不进来，值得跟踪。
- **风险**：未公开、靠环境变量开启，版本之间可能变化。好在源码公开，可以跟踪；接入时要做格式校验和失败回退（写信失败就退回现在的 `--resume` 投递）。

## 2. OpenCode：终端界面就是本地服务的客户端

**来源**：[官方 Server 文档](https://opencode.ai/docs/server/)、[CLI 文档](https://opencode.ai/docs/cli/)。

- 运行 `opencode` 会同时启动服务和终端界面，**终端界面是这个服务的客户端**。服务默认用**随机端口**，可用 `--port` / `--hostname` 固定。也可以先 `opencode serve`（默认 `127.0.0.1:4096`），再用 `opencode attach` 把终端界面接上去。
- **投递**：`POST /session/:id/prompt_async`（返回 204，异步）或 `POST /session/:id/message`（同步，等结果，可以直接拿到回信）。
- **界面控制**：`/tui/append-prompt` + `/tui/submit-prompt`（相当于替用户在输入框打字并回车）、`/tui/show-toast`。
- **事件**：`GET /event`（SSE），可用来确认对方读到、做完。
- **认证**：设置 `OPENCODE_SERVER_PASSWORD` 后启用 HTTP Basic，默认不启用。
- **发现难点**：终端界面的端口是随机的，文档没有给出发现机制（只有 `serve --mdns`）。可行做法：① 用 `lsof` 找 opencode 进程的监听端口，再用 `GET /global/health` 确认身份；② 建议用户固定端口；③ `serve --mdns`。
- **现状**：anytoany **还没有 OpenCode 适配器**（会话发现和投递都没有）。好消息是它的投递方式本身就是「门铃」：服务端直接跑这一回合，开着的终端界面通过事件流实时显示，不存在写锁冲突。社区也有 [ACP 接入运行中服务的 PR #52075](https://github.com/anomalyco/opencode/pull/52075)，说明「多客户端共享一个服务」是官方方向。

## 3. Kimi：终端界面没有入口，网页界面有

- **终端界面（`kimi`）**：运行时在进程内，外部没有入口。[issue #4112](https://github.com/MoonshotAI/kimi-code/issues/4112)（2026-10-03，open，无维护者回应、无关联 PR）明确写着 Server API 的提交接口「只对 `kimi web` 启动的会话有效，接不进已在运行的交互会话」，并提议 `kimi queue --session … --message …`，与 Codex 的 `codex queue` 同构。本机 0.41.0 的 `kimi session` 只有 `list`。
- **网页界面（`kimi web`）**：本机 0.41.0 的 OpenAPI 包含 `POST /api/v1/sessions/{session_id}/prompts`（submitPrompt）、`POST …/prompts:steer`（回合中插话）、`GET /api/v1/sessions/{id}/status`、`approvals` / `questions`。实例登记在 `~/.kimi-code/server/instances/<id>.json`（`host`、`port`、`pid`、`heartbeat_at`）；令牌在 `~/.kimi-code/server.token`（0600）。如果用户平时在 Kimi 网页界面里工作，anytoany 可以「找到实例 → 带令牌 POST」，消息会实时出现并开始执行。
- **兜底**：Kimi 有与 Claude 同构的 `UserPromptSubmit` 钩子（19 种事件），但 **anytoany 目前没给 Kimi / ZCode 装收件钩子**，只靠 skill 里的 `anyd pull`。装上 Kimi 钩子至少能做到「下次开口自动收到」。

## 4. 建议（排序）

1. **ZCode 信箱门铃**：投递 ZCode 活会话时写信箱文件，写失败就退回 `--resume`；`anyd doctor` 提示开关。桌面版需要用户配合验证一次（带开关启动 ZCode）。这是这三家里收益 / 成本比最高的。
2. **OpenCode 适配器**：新增发现与投递（`prompt_async` / `message` + 端口发现）。先征得同意安装 OpenCode，再实测。
3. **Kimi**：先装 `UserPromptSubmit` 收件钩子（做到下次开口收到）；网页界面会话的实时投递可以接；终端界面实时投递等官方 #4112，可以去 issue 下补充我们的使用场景。

## 说明

- ZCode 信箱是未公开功能，结论来自源码和本机实测，不是官方文档。
- 调研过程中，`kimi web` 的启动日志在工具输出里打印了 Kimi 本地服务令牌（只能本机访问）。稳妥起见可执行 `kimi web rotate-token` 换掉。
