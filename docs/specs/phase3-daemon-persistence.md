# Phase 3 规格 — daemon 持久化（launchd，macOS）

> 创建：2026-08-12 · 最后更新：2026-08-12
> 状态：已实施（MacBook 装 launchd LaunchAgent，KeepAlive 复活实测通过）。动机：真实事故——本机 daemon 静默死亡导致「本机通信通不了」。

## 1. 问题（真实事故）

用户本机（MacBook）发消息给同机 codex 会话，`anyd send` 回执「排队完成，daemon 目前离线，回复会在 daemon 启动后自动送达」——消息进了队列，但**没有 daemon 在跑去投递**，于是永远发不出去。表象是「连本机通信都通不了」，实为**投递进程缺席**。

根因：daemon 之前只用 `nohup anyd start &` 手启，进程生命周期系于启动它的 shell / 会话；一旦被系统、登出、休眠或误 stop 干掉，就**死了不再复活**，队列里的消息全部滞留。mini 早已用 launchd 托管所以稳，MacBook 没做。

## 2. 方案：launchd LaunchAgent + KeepAlive

`~/Library/LaunchAgents/dev.anytoany.daemon.plist`：

- `ProgramArguments`：`<node 绝对路径> <dist/cli.js 绝对路径> start`（launchd 无 shell/PATH，须绝对路径；anyd shim 是符号链接，解析到真身 `dist/cli.js` 直接跑）。
- `RunAtLoad=true`：登录即起。
- `KeepAlive=true` + `ThrottleInterval=10`：**死了自动拉起**（≥10s 一次，防崩溃风暴）。
- **`EnvironmentVariables.PATH`（关键）**：daemon 投递靠 spawn `codex`/`kimi`/`claude`/`node`(zcode)，launchd 默认 PATH 极简会导致「command not found」投递失败——必须把各家二进制所在目录全烤进去（`/opt/homebrew/bin`、`~/.npm-global/bin`、`~/.kimi-code/bin` 等，由安装脚本按 `command -v` 实测推导）。
- `StandardOut/ErrorPath`：`~/.anytoany/daemon.log`（与 CLI 读的同一份）。

## 3. 安装 / 移除

- 安装（幂等，任意 Mac 一条命令，自动解析本机路径）：`bash scripts/install-daemon-launchd.sh`
- 移除持久化：`launchctl unload ~/Library/LaunchAgents/dev.anytoany.daemon.plist && rm "$_"`
- **注意**：托管后 `anyd stop` 只是杀进程，KeepAlive 会立刻复活——要真正停，用 `launchctl unload`。

## 4. 验收

1. `launchctl list | grep anytoany` 显示已注册、exit code 0；`anyd status` 为 running。
2. **复活实测**：`kill -9 <pid>` 后等 ≤ ThrottleInterval，`pgrep` 出现**新 pid**（实测 18569→18736 自动复活）。
3. 端到端：滞留队列的真实消息在 daemon 恢复后由 `recoverStale` 重投成功（实测用户 sunoprompt→codex 消息 delivered）。

## 5. 待办（跨平台）

Linux（systemd user unit）、开机自启的等价方案留待需要时补；当前用户集群为双 Mac，launchd 覆盖。可考虑 `anyd setup --persist` 内建命令封装此脚本（P3）。
