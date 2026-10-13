# 调研：把消息送进「正在运行的会话」—— 社区与官方的最新解法（2026-10）

> 创建：2026-10-13 · 最后更新：2026-10-13

**起因**：daemon 日志 251 次投递失败，**0 次**出在设备之间的传输上，全部卡在最后一公里，也就是把消息塞进对方会话这一步（Codex 写锁冲突、活会话假失败、CLI 版本错位、登录过期、超时）。所以要找的是「门铃」：让消息进入**正在运行的 App**，而不是从外面 headless resume 硬塞。本次核查官方新能力与 GitHub 社区同类项目。

## TL;DR

1. **Claude 这边，官方门铃已经有了**：Claude Code v2.1.224（2026-08-07）起内置跨会话消息。每个会话（**含桌面 App 会话**）绑定一个本机 Unix socket 收件箱；**空闲会话收到消息会自动起一轮**；外部进程可以往里写。本机已验证：注册表 `~/.claude/sessions/<pid>.json` 带 `sessionId`、`messagingSocketPath`、`status`、`entrypoint: "claude-desktop"`、`version`。
2. **社区已经有人把它当正式通道跑通了**：agents-can-communicate（ACC，131★）在 2026-09-25 做了实测并在 PR #202 落地。做法是往 socket 写一条只起唤醒作用的帧，会话醒来后，由已有的 `UserPromptSubmit` hook 把消息正文送进去。同时它**整个弃用了 Channels 路线**。这和 anytoany 现成的 pull hook **一一对应**：只需加一个「按门铃」动作。
3. **Codex 桌面版：整个社区都还卡着**。Desktop 对每个打开过的线程长期持有写锁（[openai/codex#37450](https://github.com/openai/codex/issues/37450)，open，无官方回应，**没有给外部客户端的 attach 路径**）。ACC 的 README 原话大意是「Codex App 里的对话在下一轮才收到」，agent-talk 能唤醒空闲会话，但前提是用它的启动器把 TUI 挂到 app-server daemon 上，Desktop 不行。官方新命令 `codex queue`（v0.149+，PR #39092，走 `thread/queue/add`）能往已有会话排队，**但它与 Desktop 写锁的关系没有文档说明**，需要实验。
4. **Claude Channels 不适合 anytoany**：自定义 channel 不在白名单，必须用 `--dangerously-load-development-channels` 启动（违反本项目「不碰 `--dangerously-*`」的原则），且只在启动时带参数的交互式会话里生效，桌面 App 会话用不上。ACC 也因此弃用。

## 1. Claude Code：官方跨会话收件箱（推荐采用）

来源：[官方文档 cross-session-messaging](https://code.claude.com/docs/en/cross-session-messaging)；实测细节：[ACC issue #130](https://github.com/automatis-tools/agents-can-communicate/issues/130)。

- **版本**：macOS/Linux v2.1.224+，满足即默认开启。本机 App 为 2.1.295。
- **发现**：`~/.claude/sessions/<pid>.json`。本机实测字段：`sessionId`、`cwd`、`messagingSocketPath`（如 `/tmp/cc-socks/12794.sock`）、`status`（idle/busy）、`kind`、`entrypoint`（`claude-desktop`）、`version`、`peerProtocol: 1`。同目录 `<pid>.<hash>.key` 是 token，**不读、不转发**。
- **投递语义**（官方）：空闲会话直接起新一轮；忙碌会话在 tool call 之间读，不打断正在跑的工具。限制：上限约 100 万字符，有突发限流，每个发件人有去重和限频。
- **线协议**（ACC 实测，2026-09-25，Claude Code 2.1.282）：连上 socket，可选发一行 `{"type":"auth","token":…}`（macOS 可省），再发一行 JSON：`type:"user"`、`message:{role,content}`、`msg_id`、`priority: now|next|later`。可选 `<cross-session-message from="uds:…" from-name="…">` 包装，用来提供发件人名与回信地址。⚠️ 这一层**不在官方文档里**，属于社区抓包结论，接入时要做版本门控和失败回退。
- **信任 / 权限（关键）**：接收方被告知「来自另一个会话，不是用户」。外来消息不能批准权限、不能改配置。默认按两边的权限模式决定：**接收方是 bypass 模式时，外来消息会被扣下等批准**。桌面 App 弹不出对话框，扣到 `dialogExpiry`（默认 5 分钟）后就丢掉。本机用户常开 Bypass permissions，所以**机主需要自己设 `crossSessionInbound: "accept"`**。anytoany **不得**伪造 `from-mode="bypass"`，那等于绕过安全闸。ACC 也明确不声明自己证明不了的模式。
- **跨机**：官方支持 Claude↔Claude 跨机，但走 Anthropic 服务器 + Remote Control，且只限 Claude 家族。anytoany 的 LAN 直连仍有价值（跨厂商、不出内网）。

**对 anytoany 的意义**：ADR-023 让活会话「留 pending，等用户下次打字由 pull hook 带进去」。有了收件箱门铃后，可以变成**几秒内自动送达**：daemon 按 `sessionId` 找到 socket，写一条唤醒帧，会话起一轮，`UserPromptSubmit` 触发，现有 pull hook 注入正文。注册表里的 `version` 还能给 ADR-025 提供**活会话的确切版本**。

## 2. Codex：桌面版写锁是公认死结

- **写锁**：0.147 起一个线程只允许一个写者，锁文件在 `~/.codex/thread-writer-locks/<thread>.lock`（本机 15 个）。Desktop 打开过的线程一直不放，彻底退出 App 才释放（[#37450](https://github.com/openai/codex/issues/37450)，2026-10-13 仍有 0.162.1 的新报告）。同类报告：[#40558](https://github.com/openai/codex/issues/40558)、[#44449](https://github.com/openai/codex/issues/44449)、[#52675](https://github.com/openai/codex/issues/52675)。
- **非官方绕路**：#37450 里有人往 `$CODEX_HOME/app-server-control/app-server-control.sock` 发 JSON-RPC（`initialize` → `thread/resume` → `turn/start`）。**前提是 Desktop 用的是这个 daemon**。本机这个 socket 是一个指向不存在文件的失效链接，说明 Desktop 跑的是自己的私有 app-server，此路不通（与 2026-08-05 的结论 [research-codex-live-inject.md](research-codex-live-inject.md) 一致）。
- **`codex queue`**（[PR #39092](https://github.com/openai/codex/pull/39092)，2026-08-17 合并；本机 0.157.1 已有）：`codex queue --thread <uuid|name> --message <text>`，走 app-server `thread/queue/add`。agent-bridge（ismakov-dh）、openmsg 用它投 Codex。**未知点**：Desktop 持锁时，排进去的消息会不会被 Desktop 自己的 server 消费。社区也有「排队消息不发送」的 bug 报告（[#49081](https://github.com/openai/codex/issues/49081)、[#51069](https://github.com/openai/codex/issues/51069)）。值得在一个**专门新建的测试线程**上做一次受控实验，按 lessons 2026-08-05 的规矩用强校验定位新线程，绝不碰用户真实线程。
- **结论**：Codex 桌面版的实时唤醒，目前没有任何社区项目做到。现实最优就是 ADR-026 的「下一轮收到」，加上若实验成功、用 `codex queue` 替换 `exec resume` 投递**关闭的**线程。持续关注 #37450。

## 3. 社区同类项目（2026-10-13 快照）

| 项目 | ★ | 做法 | 备注 |
|---|---|---|---|
| [agents-can-communicate](https://github.com/automatis-tools/agents-can-communicate)（ACC） | 131 | Claude：收件箱 socket 唤醒 + hook；Codex：下一轮 | 1806 commits，最成熟；只做本机；MIT，声明永久非商业 |
| [agent-talk](https://github.com/xhluca/agent-talk) | 192 | hooks；Codex 空闲唤醒需自带 launcher 挂 daemon | Desktop 不适用 |
| [coder/agentapi](https://github.com/coder/agentapi) | — | 虚拟终端 + 屏幕抓取，HTTP 控制 TUI | 只适用于它自己启动的 TUI；消息边界靠推断 |
| [openmsg](https://github.com/marciob/openmsg) | 1 | Claude 收件箱 socket；Codex `codex queue` | 小项目，思路与 ACC 一致 |
| [agent-bridge (ismakov-dh)](https://github.com/ismakov-dh/agent-bridge) | 0 | Codex hooks + `codex queue`；Claude 走非官方 peer 协议把 Codex 注册进 ListAgents | 自承「非官方协议，版本间会变」 |
| [agent-exchange](https://github.com/summationai/agent-exchange)、[agent-peers](https://github.com/ThomasMarcelis/agent-peers)、[agent-bridge (kodaas)](https://github.com/kodaas/agent-bridge)、[open-agent-bridge](https://github.com/kevinArgueta96/open-agent-bridge) | — | 本机 socket / MCP / 签名加密 | 未逐一核实 |

**共同点**：几乎全部只做本机；最难的都是「送进正在运行的会话」，而大家在 Claude 上收敛到同一个官方收件箱，在 Codex 桌面版上都卡在写锁。anytoany 的差异点在于**跨设备 LAN + 持久信箱（确认 / 重试 / 死信）+ 多厂商**。

## 4. 建议（待写 ADR 后执行）

1. **P0 Claude 门铃**：daemon 投递本机 Claude 活会话时，先按 `sessionId` 在注册表里找 socket，写唤醒帧；失败回退到现状（pending + pull hook）。在 `anyd doctor` 里检查并提示 `crossSessionInbound`。
2. **P1 Codex `codex queue` 受控实验**：在新建测试线程上验证三种情形：关闭的线程、Desktop 打开的线程、空闲线程。成立就替换 `exec resume`。
3. **P2 跟踪上游**：订阅 openai/codex#37450；Channels 进白名单或开放自定义 channel 前不碰。
4. **安全对齐**：官方对跨会话消息的定位是「不能批准、不能改配置、权限照常弹」，与 ADR-016 的「信任队友」需要对一次口径。anytoany 注入的正文同样应声明来源，不冒充用户。

## 说明

部分项目的细节来自 README 摘要与 issue 页面，**未克隆源码逐行核实**。收件箱线协议是社区抓包结论，非官方文档。动手前需在本机对一个测试会话实测。
