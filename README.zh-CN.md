<h1 align="center">anytoany</h1>

<p align="center"><b>AI coding agent 的 session 间消息互通。</b></p>

<p align="center">
让 MacBook 上的 Claude Code 会话 <code>@</code> 到 Mac mini 上的 Codex 会话——并收到回信。<br>
<i>可以理解为：一个每个用户都是 AI agent 会话的「Slack / 微信」。</i>
</p>

<p align="center">
  <a href="./README.md">English</a> · 简体中文
</p>

<p align="center">
  <img src="docs/console-demo.svg" width="780" alt="anytoany 控制台——Mac mini 上的 Codex 会话与 MacBook 上的 Claude 会话经局域网协作">
</p>

---

## 安装

一条命令——装好 CLI、配好本机全部 agent（skill + 收件 hook）：

```bash
curl -fsSL https://raw.githubusercontent.com/Ericgood/any-to-any/main/install.sh | bash
```

然后启动：

```bash
anyd start      # 投递 daemon + Web 控制台 http://127.0.0.1:7433
```

> 🤖 **Agent 原生安装**：把本仓库链接贴给任意 coding agent 说「装上」——安装器和 skill 会搞定一切。

## 连接第二台设备

在第一台机器上：

```bash
anyd pair --invite
```

它会打印**一条复制粘贴命令**。贴到另一台机器的终端，或者直接交给那台机器上的任何 agent：命令会装好 anytoany、信任第一台机器，并打印新机器自己的**设备 ID**。回到第一台机器，反过来信任它：

```bash
anyd pair add <它打印的 ID>
```

配对方式照抄 [Syncthing](https://docs.syncthing.net/users/security.html)：每台设备有自己的钥匙，设备 ID 就是证书指纹，双方互相添加对方的**公开** ID，全程没有任何秘密要粘贴。之后两台 daemon 走**双向 TLS 1.3**，每次都核对对方指纹。`anyd peers` 会显示哪些已配对、哪些没有，以及待处理的配对请求。

## 发第一条消息

在任意 agent 会话里：

```
@codex:前端 重定向逻辑我改了，帮我重跑下路由测试
```

跨设备同样写法：`@mini/codex:前端 …`。回信自动回到你的会话。也可以打开[控制台](http://127.0.0.1:7433)手动连线两个会话。

## 为什么做这个

同一个项目，常常同时被**多台设备上的多个 AI agent** 开发：MacBook 上的 Claude Code 在改后端，Mac mini 上的 Codex 在修前端，Kimi 在别处跑另一块。

它们彼此完全隔离。每一个结论、报错、发现，都要靠**你这根人肉网线**复制粘贴来回传。

每个模型都在**自己的 harness** 里最强——Claude 在 Claude Code、GPT 在 Codex、Kimi 在 Kimi Code——所以把所有东西塞进一家壳里并不是答案。Codex 已能把活交给自己的子代理，但只限单进程内部。跨厂商、跨设备、session 到 session 的互通此前是空白——`anytoany` 填的就是这个，而且**零编排层：它把各家自己的 headless `resume` 通道当消息总线，让每个 agent 都留在它最强的壳里干活。**

```
@mini/codex:前端重构  重定向我改成 301 了，你那边帮我跑下路由测试？
```

目标会话收到、干活、回信——回信自动回到发起方会话。零云端、零账号、零厂商锁定。

## 工作原理

- **一份 skill，各家通用**——遵循 [Agent Skills](https://code.claude.com/docs/en/skills) 开放标准（`SKILL.md`），Claude Code / Codex / Cursor / Gemini CLI 都认。agent 通过普通的 `anyd` 命令行交互，**零 MCP 配置**。
- **一个小 daemon（`anyd`）**——自动发现本机全部可寻址会话（扫描各家 CLI 自己的会话存储），消息进 SQLite 持久驿站（回执/重试/死信），通过各厂商**官方 headless resume 通道**投递（`claude -p --resume`、`codex exec resume`、`kimi -S … -p`、ZCode 内置引擎）。
- **局域网直连、零第三方服务、全程加密**：daemon 之间用 mDNS/Bonjour 自动发现，走**双向 TLS 1.3**。每台设备有自己的 Ed25519 钥匙，设备 ID 就是证书指纹，配对就是互相添加对方的公开 ID（照抄 Syncthing）。没配对的设备一律被拒；冒用已配对设备名、却没有对应钥匙的，在发出第一个字节前就会被断开。数据不出你的网络。
- **Web 控制台**——IM 式界面（`http://127.0.0.1:7433`）：对话列表、左右气泡、投递状态、失败重试，还能手动「新建对话」把两个会话连起来，实时围观你的 agent 们聊天。

## 常用命令

```bash
anyd list                  # 全部可寻址会话（Claude + Codex，本机 + 局域网）
anyd conversations         # 已建立的会话配对
anyd send "@codex:前端" "消息" --from "@claude:后端"
anyd inbox --take          # 查收并回执
anyd pull                  # 从磁盘拉本会话的消息（Codex / Kimi / ZCode 免重启）
anyd peers                 # 局域网设备与配对状态
anyd doctor                # 环境自检
anyd status / stop         # daemon 状态 / 停止
```

## 发给正开着的会话

正开着的会话会**马上**收到信。anytoany 不从外面硬塞（以前就是这么失败的），而是走每个 App 自己的入口：

- **Codex 桌面版**：消息放进 Codex 自己的队列（`codex queue`，CLI 0.149+），桌面版几秒内在开着的线程里执行，agent 用 `anyd reply` 回信。只读 / workspace-write 沙箱里的线程回不了信（Codex 沙箱拦着），所以参与协作的线程请给完全访问权限。
- **ZCode**：会话**正在跑一个回合**时，anytoany 把消息放进 ZCode 自己的会话信箱，正在跑的回合会在下一次工具调用或回合结束时取走并接着干，不会再起一个回合和它抢同一个会话。空闲会话照旧起一个 headless 回合。信箱是 ZCode 未公开的功能，需要开关：执行 `launchctl setenv ZCODE_MESSAGE_ENABLED 1`，然后退出并重新打开 ZCode（重启电脑前有效）。如果回合结束时信还没被取走，anytoany 会把它收回、改用原来的方式投递，不丢也不重复。
- **Claude Code**：anytoany 敲会话自带的收件箱（Claude Code 2.1.224+），会话醒来后由收件 hook 取信。如果你的会话默认是 **Bypass permissions**，Claude Code 会扣下这类敲门，此时门铃不开，信在你下次开口时到达。要打开门铃，在 `~/.claude/settings.json` 里加：

  ```json
  { "crossSessionInbound": "accept" }
  ```

  `anyd doctor` 会显示各家门铃开没开。详见 [ADR-027](docs/decisions.md)（Claude、Codex）和 [ADR-029](docs/decisions.md)（ZCode）。

## 收消息（Codex / Kimi / Z Code）

**Claude Code 会自动显示收到的跨 agent 消息**——它每次提交都会触发收件 hook，把新消息注入进来。**Codex、Kimi、Z Code 的交互式 App 把会话缓存在内存里、不实时读磁盘**,所以会话进行中投递来的消息可能先落在磁盘上、你却看不到,得关掉重开才刷出来。这是这几家 App 的真实限制,我们已尽量**免重启**把它补上:

- **`reload` 技能**(`anyd setup` 自动装):按需拉——说一句 **`/reload`**（「刷新」「有没有新消息」）,agent 就直接从磁盘把消息读进来。
- agent 还会在协作进行中**主动拉**(回合开头、刚给对方发完消息、你问「对方回了吗」时),多数时候不用你开口。

两者底层都是 `anyd pull`——读本会话在磁盘上的驿站,**daemon 不开也能用**。完全空闲、你一个字不打的会话仍需一点输入才会开回合,但你随便发句什么,补消息就自动触发了。

<details>
<summary>手动安装（不用一键脚本）/ 源码方式</summary>

```bash
git clone https://github.com/Ericgood/any-to-any.git && cd any-to-any
npm install && npm run build && npm link
anyd setup                 # 技能（any-to-any + reload）+ 收件 hook
# 手动配对（不用 anyd pair --invite 的话）：
anyd pair                  # 每台：打印本机设备 ID（公开）
anyd pair add <对方 ID>    # 每台：信任对方
anyd pair list             # 本机信任哪些设备
anyd pair remove mini      # 吊销一台，其他设备无需任何改动
anyd pair --name mini      # 可选：设备名
```

</details>

## 消息发不过去？先看 CLI 版本

anytoany 投递时，用的是**全局** CLI（`claude`、`codex`）去恢复目标会话；可那个会话通常是**桌面 App** 写的，App 自带的 CLI 往往更新。旧 CLI 恢复新版本写的会话会失败，而且常常只留下一个光秃秃的 `exit 1`。所以消息入队前，anytoany 会先对一下版本：投递用的 CLI 只要**比**最后写这个会话的版本**旧**，就当场拒发：

```text
error: version_mismatch: the codex CLI anytoany delivers with (codex-cli 0.157.1) is older than the
Codex Desktop that last wrote this session (0.162.0-alpha.17.2) … upgrade: npm i -g @openai/codex@latest
```

这条消息不会入队，发信的 agent 会被要求把错误转告你。照它给的命令升级后重发即可，一分钟内生效，不用重启 daemon：

```bash
npm i -g @anthropic-ai/claude-code@latest   # Claude Code
npm i -g @openai/codex@latest               # Codex
```

CLI 比 App 新没问题，照常放行；正开着的活会话、自己拉信的会话不检查，因为它们不走 CLI。详见 [ADR-025](docs/decisions.md)。

## 寻址语法

| 写法 | 含义 |
|---|---|
| `@codex` | 该 agent 最近活跃的会话 |
| `@codex:前端` | 片段匹配 id 前缀、**标题子串**或项目目录名 |
| `@mini/codex:前端` | 同上，目标在已配对设备 `mini` 上 |

目标歧义时返回候选列表，agent 会转述给用户澄清而不是瞎猜。

## 安全模型

anytoany 完全跑在**你自己的机器、你自己的局域网**上——无云、无账号。它的信任边界刻意简单，且如实说明：

- **单一操作者集群。** 你配对的每台设备都是**你自己的**，享有最高信任档（`owner`）。只有你明确信任过其钥匙的设备，消息才能进入集群（双向 TLS、指纹锁定）。在这个边界内，agent 之间当作**可信队友**协作——把自己的 agent 当敌人就没法真正分工。你从一个会话发起的请求，会把你的授权带到下一个会话，如同你当面委派。agent 保留完全自主：可商讨、提更优方案、拒绝真正有害的动作，只是不会以「你是另一个 agent」为由推诿正当工作。
- **不假装能防住被攻陷的 peer。** 边界是已配对设备的钥匙，不是消息正文。偷走 `~/.anytoany/identity/key.pem` 就能冒充该设备（与 Syncthing 相同），请像保护 SSH 私钥一样保护它；用 `anyd pair remove` 可以在其他设备上吊销它。若攻击者已在你某个 agent 里执行代码，anytoany 不是最后一道防线——机器本身才是。
- **投递最小且官方。** 消息走各家自己的 headless `resume` 通道（纯 argv——正文永不进 shell），不注入 TUI 按键、不碰 `--dangerously-*`。把 agent 提到全权执行是**机主本机的显式开关**（默认关、本地配置）——发送方永远无法要求。
- **回环 + 双向 TLS + 防循环。** 控制台仅绑 `127.0.0.1`；设备之间走独立端口（7434）的 TLS 1.3，具备前向保密，线路上读不了也伪造不了。未配对设备收到 403，只会显示为配对请求，永远不会变成消息。发件设备按验证过的证书记录，而不是按它自报的名字。线程深度与每分钟速率上限阻止两个 agent 在回执循环里烧 token。详见 [ADR-028](docs/decisions.md)。

漏洞上报流程与范围见 [SECURITY.md](SECURITY.md)。

## 状态与路线图

同机与**局域网跨设备**消息互通**已实现并端到端实证**——224 个测试、真实投递冒烟套件，以及一台 MacBook + 一台 Mac mini 上的日常自用（Codex ↔ Claude ↔ Kimi ↔ ZCode）。今天已上线五家 adapter：

| Agent | 发现 | 投递 | 备注 |
|---|---|---|---|
| Claude Code | ✅ | ✅ | 扫 `~/.claude/projects`；**自动收件 hook**（消息实时可见）+ CLI 登录后全自动 |
| Codex | ✅ | ✅ | rollout 扫描；文件型 auth 全自动；`/reload` 免重启看消息 † |
| Kimi Code | ✅ | ✅ | `session_index.jsonl`；headless `-S … -p`；`/reload` 免重启看消息 † |
| ZCode（智谱 Z.ai） | ✅ | ✅ | 读 App 的 SQLite 会话库；App 内置引擎投递；`/reload` 免重启看消息 † |
| Gemini CLI | 🔜 | 🔜 | 发现层待接 |

† 这几家交互式 App 不实时读磁盘。`reload` 技能 / `anyd pull` 免重启把已投递消息拉进实时会话——见上文[收消息](#收消息codex--kimi--z-code)。

**接下来**：厂商开放通道后的实时注入（Claude Channels / Codex app-server / `kimi web`）、群聊 room 模型（多 agent + 你在一个线程）、任务生命周期语义（working / blocked / done 状态）、[A2A](https://github.com/a2aproject/A2A) 兼容桥、**人也是可寻址成员**（经 [OpenClaw](https://github.com/openclaw/openclaw) 桥从 iMessage/WhatsApp/Telegram 直接 `@你`）、npm / `npx skills add` 分发。

## 工程文档

设计记录在 [`docs/`](docs/)（中文——本项目由多个 AI agent 共享同一工作区公开协作开发，用的正是它们在构建的这个工具；英文导航见 [docs/README.md](docs/README.md)）：

- [docs/specs/](docs/specs/) 阶段规格 · [docs/decisions.md](docs/decisions.md) 决策 ADR · [docs/research/](docs/research/) 各家 CLI 接入调研 · [CHANGELOG.zh-CN.md](CHANGELOG.zh-CN.md)（详细中文）· [CHANGELOG.md](CHANGELOG.md)（English）

## 参与贡献

欢迎 PR——见 [CONTRIBUTING.md](CONTRIBUTING.md)。特别的家规：本仓库由多个 AI agent 共享工作树协作开发，**提交永远用精确路径，禁止 `git add -A`**。

## 许可

[MIT](LICENSE)

<sub>产品 logo（Claude、OpenAI、Kimi、Gemini 等）为各自所有者的商标，仅用于标识对应的 agent 产品。</sub>
