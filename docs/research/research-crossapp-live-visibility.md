# 调研：让收到的跨 agent 消息「自己冒进各家 App 的可见对话」的天花板

> 创建：2026-08-16 · 最后更新：2026-08-16
> 触发：闪电说安卓开发中 Codex↔Claude 协作，操作者无法判断 Codex「还在干活 / 卡住 / 干完」（只能读 git commit 时间戳猜）。用户点破机制：不是改造界面，是**用 agent 自己的嘴**在它自己的循环里把消息念出来。
> 方法：三个子代理并行调研 Codex / Kimi / OpenCode（各一家），一手核查已安装 CLI + 官方文档 + 本仓库既有 research + GitHub issues。

## 0. 问题

把发给某会话的跨 agent 消息，**不用操作者手动触发**，就显示进那个 agent App 自己的可见对话里。今天只有 Claude Code 能自动做到；Codex/Kimi 走 headless resume 投递是**隐形的**（[#28259](https://github.com/openai/codex/issues/28259)：resume 续写了 transcript 但交互 UI 不刷新）。问：Codex/Kimi/OpenCode 各能做到多「自动」。

## 1. 关键洞察（最重要，决定整套方向）

surface 的正确机制**不是「外部把 turn 塞进 App」**（那条撞 #28259，是死路），而是**「agent 自己在它的回合循环里 pull 一下、把收到的话念出来」**：

- **agent 自己的输出永远渲染**——它自己跑命令、自己念结果，天生可见。**#28259 只坑「外部注入的 turn」，管不着 agent 自己嘴里说出来的话。** 这正是 ADR-019 `anyd monitor` 成立的根基。
- 所以 **surface 本身是免费的**：任何 agent 只要在自己回合里跑 `anyd pull` / `anyd monitor` 并叙述结果，就可见、就绕开了 #28259。
- **真正要解的只剩一件**：怎么让 agent **不用人提醒、自己就周期性地去 pull**（auto-nudge）。下面就是各家 auto-nudge 的天花板。

## 2. 能力矩阵

| App | 自己回合里 pull+念（普适 surface） | 自动挂后台监听 | **自动提醒自己去 pull（不用人）** |
|---|---|---|---|
| **Claude Code** | ✅ | hook | ✅ 已实现（prompt hook 注入 + UI 会渲染） |
| **OpenCode** | ✅ | ✅ 插件开机自 load | ✅ **最强**：插件跑 watcher + 直接推进可见对话；或外部 daemon POST 进会话 |
| **Kimi** | ✅ | ✅ SessionStart | ⚠️ **半自动**：真 60s `SessionHeartbeat` 计时器可戳它/弹通知，但文字只能在 `UserPromptSubmit` 注入、hook 输出只进模型不渲染 |
| **Codex** | ✅ | ✅ SessionStart hook | ⚠️ **存疑**：SessionStart 能塞「去跑 monitor」指令，但**会不会在无用户输入时真跑一轮未验**；外部注入撞 #28259，官方相关请求已 closed |

## 3. 每家细节 + 出处

### Codex — 天花板最低
- **hooks 系统**（Claude-Code 兼容，`hooks=stable`）：`SessionStart / SessionEnd / UserPromptSubmit / PreToolUse / PostToolUse / Stop / …`，配 `~/.codex/hooks.json` 或 config.toml `[hooks]`；首跑信任哈希存 `[hooks.state]`。**本机已见** SessionStart block。SessionStart 的 command 可 `nohup anyd monitor &`。出处：本机 `~/.codex/hooks.json`、`config.toml`；learn.chatgpt.com/docs/hooks；DeepWiki openai/codex 3.11。
- **三堵墙**（surface 不了）：① hooks 是**生命周期触发**，没有「消息到了」这种事件；② hook 输出 `additionalContext` **只进模型上下文、交互 UI 不渲染**（本仓库 `research-codex-live-inject.md` 已一手确认）；③ 外部塞 turn 撞 **#28259（open）**。功能请求 **[#11415 `codex inject`（closed / not planned）](https://github.com/openai/codex/issues/11415)**、**[#8707 `/cron`（closed / not planned）](https://github.com/openai/codex/issues/8707)**、#17543 / #22003（open 无动作，作者自述「session 不自醒，输出要显式 poll 才出」）。
- **app-server / remote-control**（`~/.codex/ipc/ipc.sock` 或 `ws://127.0.0.1:9742`）有 `turn/start` / `thread/inject_items`——外部**能**推 turn，**但**只对 `codex --remote <sock>`（连共享 `codex app-server --listen`）起的会话有效，正常起的 TUI 够不着，且仍 #28259 lag。`notify`（config.toml）是出站的。
- **anytoany 的现实选择**（最强信号）：Claude 侧 hook 挂在 `UserPromptSubmit`（`src/setup.ts`），不是 SessionStart——即「hook 自动挂 monitor 但输出不可见」这条本就走不通；ADR-019 monitor 明确**软/agent 驱动**。

### Kimi — 居中
- **hooks 完整**（config.toml `[[hooks]]`，~20 事件）。官方原话：**「只有 PreToolUse / Stop / UserPromptSubmit 有影响主流程的返回值……其余 observation-only、fire-and-forget」**，且**只有 UserPromptSubmit 的 stdout 追加进 context**。出处：moonshotai.github.io/kimi-code/en/customization/hooks（+ changelog）。
- **`SessionStart`**：新开/resume 后触发、无需用户输入，command 可拉起 `anyd monitor`；但 `Can Inject Context: No`。
- **`SessionHeartbeat`**：**「会话存活时每 60 秒触发，且仅当配置了该事件时计时器才跑」**——一个不靠用户输入的真·墙钟计时器（比 Claude Code 还多这一个）；同样 observation-only、不能注入文字。
- **`kimi web`**：本地 REST/WS（默认 127.0.0.1:58627，bearer）有 `POST /sessions/{id}/prompts` 与 `…:steer`；**但驱动的是 web 前端的会话，不是用户跑的终端 TUI**（另一模式）。`kimi acp` = ACP server 供外部客户端（Zed/JetBrains）嵌入。
- TUI 同样**不从磁盘刷新**（与 Codex 同病，本仓库 reload/SKILL.md、decisions.md 已记）。
- **最强 auto-nudge**：SessionStart 挂 monitor + `SessionHeartbeat`(60s)→ 弹桌面通知/bell → 把人拉回来敲一句 → UserPromptSubmit 注入。即「心跳叮你、下一回合才真显」。

### OpenCode — 天花板最高（唯一原生「自己冒进对话」）
- **插件系统**：`.opencode/plugin/` 或全局 `~/.config/opencode/plugin/`，或 opencode.json `"plugin": ["pkg"]`——**开机自 load**；`Plugin = (input) => Promise<Hooks>`，body 是任意 JS（**可跑持久 watcher**，`fs.watch`/poll，或经注入的 `$` 流式跑 `anyd monitor`），`dispose()` 清理。事件总线 `event?({event})` 收 `session.created / session.idle / message.updated / …`。
- **surface 进可见对话**：注入的 `client` 是完整 opencode SDK。两条：① **`client.tui.appendPrompt({text})` + `submitPrompt()`**（驱动 TUI，可见；OpenCode 官方 IDE 插件就用这个）或 `client.tui.showToast`（被动提示）；② `client.session.prompt(...)` 跑一轮。
- **外部推**：`opencode serve` = 无头 HTTP server（正常 `opencode` 也内嵌 server，TUI 只是客户端）。外部 daemon 可 `POST /tui/append-prompt`（可见）或 `/session/:id/message`（无头），SSE `GET /event` 观察。
- **坑**：[#8564](https://github.com/sst/opencode/issues/8564)「TUI 不渲染 prompt_async 端点推来的消息」——保险起见走 `/tui/*` 而非裸 `session.prompt`。
- 出处：opencode.ai/docs（server / sdk / plugins）；github.com/sst/opencode；context7 `/anomalyco/opencode`、`/anomalyco/opencode-sdk-js`。

## 4. 结论（天花板排序）

- **OpenCode 最高**：真·自动挂 + 真·把消息推进可见对话（插件 or server push）。**唯一原生做到「消息自己冒进对话、不用人」的一家。**
- **Kimi 居中**：能自动挂 + 60s 心跳提醒（半自动：叮你 → 你敲 → 显示），但文字不能自动冒。
- **Codex 最低**：能自动挂进程，但**没有把「到了」自己冒出来的原生通道**；官方把相关请求都 closed。
- **Claude 已解**：当驾驶舱。
- **普适兜底**：网页控制台（agent 无关、全实时、免疫上面所有毛病）。

## 5. 待验证 / 不确定

- **Codex（唯一没底的点）**：SessionStart hook 的 `additionalContext` 能否让 Codex 在**无用户输入**时就真跑一个 model turn 去启动 monitor——**未实测**。验法：加临时 SessionStart hook 返回 `additionalContext:"run anyd monitor now"`，不打字，观察它动不动、TUI 显不显示。若不自触发，则 Codex **没有**原生自动挂可见 monitor，只剩「agent 软循环叙述 / UserPromptSubmit 注入 / daemon 隐形 resume（观察面移到控制台）」。
- OpenCode #8564 是否已修（prompt_async 渲染）未证实；插件目录 `plugin` vs `plugins` 拼写文档不一；未真机验证。
- Kimi `SessionHeartbeat` 等为近期新增，行为可能演进；「只 3 个 blockable、只 UserPromptSubmit 注入」的规则跨版本稳定。

（子代理原始报告存本会话 task 输出；本文件为汇总。）
