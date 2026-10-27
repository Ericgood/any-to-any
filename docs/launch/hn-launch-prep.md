# Hacker News 发布准备 — anytoany

> 创建：2026-08-13 · 最后更新：2026-10-28
> 2026-10-28：跨设备与信任模型的说法按 ADR-028 改写（旧的「共享配对 token」已作废，现为每台设备一把钥匙 + 双向 TLS）；其余内容仍是 08-17 定稿，发帖前再核一遍数字。
> 依据：HN Algolia API 真实数据(近 30–90 天 Show HN,按分排序 + 读了同类头部帖的正文与评论)。
> 一句话:anytoany 正好落在 2026 年 HN **最热的品类(AI coding agent 基础设施)**里,而它的**具体细分(跨厂商、跨设备的 agent 互发消息)几乎没人做过**——热品类 + 差异化,是好牌。

## ★ 最终版(2026-08-17 — 发帖直接用这版)

**标题:** `Show HN: Anytoany – stop copy-pasting between AI coding agents and machines`
**仓库:** https://github.com/Ericgood/any-to-any (PUBLIC · MIT) · **Hero GIF:** `docs/anytoany-demo.gif`(README 已用)

**正文(英文,贴 Show HN 的 text 字段):**

```
For months, my most annoying daily chore was copy-pasting between AI coding agents.

On one machine I keep Claude Code and Codex working the same project. Every time one says something, I paste it to the other so they stay in sync — dozens of times a day.

Across machines it got absurd. A Codex session on my MacBook and a Kimi session on my Mac mini, same project. The two Macs share a clipboard through one Apple account, but it's flaky, and when it dropped my fallback was to message the text to myself on Telegram and paste it back out on the other Mac. Telegram as a clipboard, between two computers on the same desk.

When I found out Codex sessions can message each other I got genuinely excited — but it only works between Codex's own sub-agents, in one process. So I built the general version.

Anytoany lets any agent session send a message to any other — across vendors and across machines — and the reply lands back in the session you asked from. Five agents work today: Claude Code, Codex, Kimi, ZCode (Gemini next).

In practice I never type "@" targets. I keep one Claude Code session as my cockpit and just tell it, out loud: "use anytoany to have the Codex session working on the iOS app do X." Claude relays it to that exact session, the work runs there, and the reply comes home to my Claude. Under the hood a target is just an address like @codex:ios, but the way I actually use it is plain language to the one agent I already have open.

How it works — no orchestration layer: a small daemon (anyd) finds every agent session on a machine by reading each CLI's own session store, queues messages in a local SQLite mailbox (ack/retry/dead-letter), and delivers them through each vendor's official headless-resume channel (claude -p --resume, codex exec resume, kimi -S … -p) — argv only, no shell, no --dangerously-*. Cross-device is copied from Syncthing: each machine has its own Ed25519 key, its device ID is the certificate fingerprint, you pair two machines by adding each other's ID, and they talk mutual TLS 1.3 directly over the LAN (mDNS for discovery). No cloud, no accounts, nothing leaves your network. Agents drive it through plain anyd shell commands via an Agent Skills SKILL.md, so there's no MCP server to run.

There's also a newer coordination layer: two agents can share a plan doc to split a task, and the daemon can keep nudging the work forward on its own, stopping to ask me only when it's genuinely stuck. This part is early, but it already runs on my real projects daily.

On visibility, honestly: the other agents' interactive apps (Codex, Kimi) don't reliably refresh to show a turn delivered to them headlessly — a known Codex desktop bug (openai/codex#28259). A message can be delivered and acted on yet not appear in that app's window until you nudge it. That's exactly why my workflow is Claude-as-cockpit plus a local, loopback-only web console that shows the whole exchange live — I don't rely on the other apps' UIs to stay in the loop. (There's also a manual anyd pull, and agents can narrate incoming messages themselves with anyd monitor.)

Other honest limits: it's pre-1.0. Delivery is turn-based, not real-time streaming — cross-vendor, that's a hard ceiling until vendors open live channels. No native Windows yet (WSL works). The trust model is deliberately simple: one operator, their own paired devices, one LAN — inside that boundary agents treat each other as trusted teammates. A device you haven't paired is refused, and each device can be revoked on its own (anyd pair remove). It does not try to defend against an already-compromised peer.

There's a same-machine cousin, agmsg, that also launched recently — it's messaging-only on one box, while anytoany is cross-device with a coordination layer. Its "monitor" idea for making messages show up live is good, and I borrowed it.

The meta bit: this is largely built by the agents it connects — several of them on two Macs, coordinating through the very tool they're building. The commit log and docs/ are candid about the bugs that shaped it.

MIT, 266 tests. Repo: https://github.com/Ericgood/any-to-any. I'd love feedback on the delivery model and the trust boundary specifically.
```

**相比 8-13 初稿的改动(本会话拍板):**
- 标题定 **A**(复制粘贴痛点)。
- **用法纠正(重要)**:不是 `@` 门面,是「对一个 Claude 主会话说人话,它替你转」——正文加了 "In practice I never type @ targets" 段;README 标语 + GitHub description 已同步改。
- **可见性 → 最佳实践**:Claude 当驾驶舱 + 网页控制台,不指望其他 app 界面自刷(#28259)。
- 新卖点:协作层 / 自驱循环(诚实标注「还早」)。
- **agmsg** 主动预答 + credit 它的 monitor 思路。
- 数字:~230 → **266** 测试。
- `install.sh` 已加固(EACCES 提示 + `anyd` 不在 PATH 的兜底解析)。
- **GIF 已生成** → `docs/anytoany-demo.gif`(逐帧 headless Chrome 渲染 + ffmpeg,已设为 README hero)。

**发帖前还差(需人工 / 真环境):**
- [ ] 在**干净 Mac** 上真跑一遍 `curl … | bash`(HN 会当场试;install.sh 已加固但没真机验过)。
- [ ] 排**美东周二–周四 8–10am**,清 3–4 小时守评论区。

（下面 §0–§7 是 8-13 的原始调研与打法,仍然有效,备查。）

---

## 0. 结论(TL;DR)

- **品类很热**:近 60 天 agent 基础设施类 Show HN 一大把 200–900 分:Clawk(给 agent 一次性 VM,226)、Oak(为 agent 设计的 Git,216)、Smart routing in Claude/Codex/Cursor(216)、Juggler(开源 GUI coding agent,280)、Ante(单文件离线 coding agent,163)。
- **我们的细分几乎空白**:近 90 天"agent 互通/多智能体编排"只有 3 帖,且**全是单厂商(只服务 Claude Code)、分都不高(77–85)**。**没人做"任意 agent ↔ 任意 agent、跨厂商、跨设备"**。差异化成立。
- **标题公式**:`Show HN: <名字> – <具体到能想象的一句话>`。赢家都**点名已知锚点**(Claude/Codex/Cursor、"X 的替代品")或**给鲜明反差/惊人具体**。
- **正文公式**:一句话说清是什么 → 个人化的"为什么做"(真实痛点) → 技术差异点 → **诚实列局限**(HN 特别吃这套)。
- **必须预答**评论里 100% 会问的:「为什么不直接用 X?」「怎么实现的?」「跟 Y 有啥区别?」「安全吗?」。

## 1. 真实数据:近一月 Show HN 头部(标杆)

| 分 | 评 | 日期 | 标题 |
|---|---|---|---|
| 2935 | 360 | 07-19 | I replaced a $120k bowling center system with $1,600 in ESP32s |
| 1680 | 415 | 07-31 | Elevators |
| 1033 | 239 | 07-22 | Bento – An entire PowerPoint in one HTML file |
| 919 | 345 | 07-29 | Open-source engine running Gemma 4 26B in 2 GB RAM on M-series |
| 484 | 229 | 07-23 | Echo – Fable-level results at 1/3 the cost using open-weight models |

**同类(anytoany 的邻居,直接对标)**:

| 分 | 评 | 标题 | 学它什么 |
|---|---|---|---|
| 280 | 119 | Juggler – open-source GUI coding agent, **by the creator of [known tool]** | 「by the creator of」=可信度背书 |
| 226 | 49 | Clawk – Give coding agents a disposable Linux VM, **not your laptop** | 鲜明反差、点明价值 |
| 216 | 46 | Oak – **Git alternative** designed for agents | 用已知物(Git)锚定新受众(agent) |
| 216 | 44 | Smart model routing directly in **Claude, Codex and Cursor** | **点名 anytoany 也连的那几家** |
| 163 | 90 | Ante, a coding agent **in a single binary that runs offline** | 具体技术卖点(单文件/离线) |

## 2. 从头部帖正文/评论里学到的(证据)

**正文(作者自述)的赢家结构**(读了 Smart-routing、Oak 的原帖):
- **第一句直接说做了什么**:"We built a model router that plugs into coding agents (Claude Code, Codex, Cursor…)"。不铺垫。
- **个人化的为什么**:Smart-routing——"Opus 4.7 一发布我们成本暴涨…不想为所有请求都用 Opus"。真实、具体、有数字。
- **技术差异点**:Oak——"virtual mounts,agent 不用下整个 repo"。一句点破独特性。
- **诚实列局限**:Oak——"still early, **no Windows build**, no CI, no issues, no comments"。**HN 极其吃"作者主动认怂"这套**,增加可信度、也把评论引导到建设性方向。

**评论 100% 会问的(必须提前预答)**——真实摘录:
- **「为什么不直接用现成的 X?」**(最高频):Clawk 第一条评论就是"why not just a docker container"。
- **「怎么实现的?」**:"How did you implement the firewall without root?"——HN 要技术深度。
- **「跟 Y 有啥区别?」**:"What's the difference from Cursor's 'auto' mode?"
- **对核心价值的质疑**:Smart-routing 一堆"我不觉得这能省钱,cache miss 反而更贵"。**他们会戳你的价值主张**,要有硬答案。
- **安全**:凡是让 agent 自动干活的,必有人担心("agent 会不会越权/逃逸")。

## 3. anytoany 的标题(3 选 1,可再调)

> 规则:`Show HN:` 前缀必带;≤80 字符最佳;点名 Claude/Codex;给出"跨设备"这个惊人点。

- **A(推荐,痛点直击 —— 用户拍板这是最有共鸣的点)**:
  `Show HN: Anytoany – stop copy-pasting between AI coding agents and machines`
- **B(具体场景,同样强)**:
  `Show HN: Anytoany – let a Claude Code session @ a Codex session on another Mac`
- **C(锚定 Codex 的 @)**:
  `Show HN: Anytoany – Codex's @, extended to every coding agent across machines`

**A 最强**:直击"复制粘贴之苦"这个人人有共鸣的具体痛点。HN 特别吃"我受够了 X 所以做了 Y"(证据:近月 "tired of opening 2 tabs for every HN link, so I made a userscript" 拿 433 分)。**打法:A 做标题,B 的具体场景放正文第一段做画面**。

## 4. anytoany 的正文 / 第一条评论(草稿,英文,直接可用)

> 放在 Show HN 的 text 字段,或发帖后立刻作为自己的第一条评论。

```
For months, my most annoying daily chore was copy-pasting between AI coding
agents.

On one machine: I keep Claude Code and Codex both working the same project on my
MacBook. Every time one of them says anything, I paste it over to the other so
they stay in sync — dozens of times a day. I really did not want to be doing
this.

Across machines it got absurd. A Codex session on my MacBook and a Kimi session
on my Mac mini would be working the same project. The two Macs share a clipboard
through the same Apple account — but it's flaky, and when it dropped, my fallback
was to message the text to myself on Telegram and paste it back out on the other
side. Telegram as a clipboard, between two computers on the same desk.

When I found out Codex sessions could message each other, I got genuinely
excited — this looked like it could fix my problem. But it only works between
Codex's own sub-agents, inside one process. So I built the general version.

Anytoany lets any agent session `@` any other — across vendors and across
machines — and the reply lands back in the session you asked from. A Claude Code
session on my MacBook can `@codex:api` a Codex session on my Mac mini; the
request runs in that Codex session and the reply comes home to my Claude
session. Five agents work today: Claude Code, Codex, Kimi, ZCode (Gemini next).

How it works — no orchestration layer: a tiny daemon (`anyd`) discovers every
agent session on a machine by reading each CLI's own session store, queues
messages in a local SQLite mailbox (ack/retry/dead-letter), and delivers them
through each vendor's official headless resume channel (`claude -p --resume`,
`codex exec resume`, `kimi -S … -p`) — argv only, no shell interpolation, no
`--dangerously-*`. Cross-device is Syncthing-style: a per-device Ed25519 key,
device ID = certificate fingerprint, pairing by exchanging IDs, mutual TLS 1.3
over the LAN (mDNS discovery). No cloud, no accounts, nothing leaves your network. Agents
drive it through plain `anyd` shell commands via an Agent Skills SKILL.md, so
there's no MCP server to run.

Honest limitations: it's pre-1.0. Delivery is turn-based, not real-time
streaming — cross-vendor, that's a hard ceiling until vendors open live
channels. Interactive apps (Codex/Kimi/ZCode) don't reliably refresh to show a
turn that was delivered headlessly (this is a known Codex desktop bug,
openai/codex#28259); there's a manual `anyd pull` to surface the exchange. No
native Windows yet (WSL works). The trust model is deliberately simple: one
operator, their own paired devices, one LAN — inside that boundary agents treat
each other as trusted teammates. Unpaired devices are refused; each device can
be revoked on its own. It does NOT try to defend against an already-compromised
peer.

The meta bit: it's largely built BY the agents it connects — several AI coding
agents on two Macs, coordinating through the very tool they're building. The
commit log and docs/ are candid about the bugs that shaped the design.

MIT, ~230 tests. Repo: <GITHUB_URL>. I'd love feedback on the delivery model
and the trust boundary specifically.
```

## 5. 预答弹药(评论区秒回,提前备好)

- **「为什么不用 MCP?」** → MCP 是给**单个 agent 的上下文**挂工具的协议;anytoany 是**不同 agent / 不同进程 / 不同机器之间**的会话互发消息,是另一层。而且零服务器要跑。
- **「为什么不直接用 Codex subagents?」** → 那是**单进程、单厂商**;这是**跨厂商 + 跨设备**。Codex 的 @ 只在一个 Codex 进程里;我把它扩到所有家 + 局域网。
- **「为什么不用共享文件 / git / Slack 转?」** → 我就是这么手动干的(复制粘贴),这正是它消灭的痛点:它**唤醒目标那个确切会话**去处理、再把回信**路由回发起会话**,不用人肉中转。
- **「跟 Claude 的 cross-session messaging 有啥区别?」** → 那是**Claude 单厂商、同机**;这是**跨厂商 + 跨局域网**。
- **「让 agent 互相发消息不危险吗?」** → 只走各家**官方 headless 通道**(argv 传参、不进 shell、不用 `--dangerously`);全权限执行是**机主每台机器显式 opt-in、默认关**;跨设备照抄 Syncthing:每台设备一把自己的 Ed25519 钥匙、设备 ID = 证书指纹、互加 ID 才算配对、设备间双向 TLS 1.3,没配对的设备直接拒,丢了一台能单独吊销(`anyd pair remove`),边界是操作者自己配对过的设备 + 局域网;**不假装能防已被攻破的 agent**——这点写在 SECURITY.md 里。
- **「Windows 能用吗?」** → 原生还不行(spawn 解析 `.cmd` 的坑);现实是 WSL 里跑。(诚实)
- **「实时吗?」** → 不,回合制;跨厂商的硬天花板。厂商开放实时通道后能升级。
- **「怎么发现会话的?」** → 读各家 CLI 自己的会话存储(`~/.claude/projects`、`~/.codex/sessions` 等),不侵入。

## 6. 时机与互动打法

- **发帖时间**:美东周二–周四 **上午 8–10 点**(HN 美国早高峰)。避开周末和周五。
- **发完守 3–4 小时**:**每条评论都快速回**——头部帖作者无一例外高互动(Clawk/Oak/Smart-routing 评论数都 40–120)。前 1–2 小时的互动决定能不能上首页。
- **来源用 GitHub 链接**(必须开源、可点进去)。
- **强烈建议配一个 30 秒 GIF/短视频**:从 Claude 会话 `@codex` → 对面处理 → 回信自动回到本会话。头部帖普遍有 demo,视觉证据涨分明显。我们已有控制台 + docs/console-demo.svg,补个动图最好。
- **别自吹**:HN 反感营销腔。正文越诚实、越技术、越"这是我挠自己痒做的",越涨分。

## 7. 发布前 checklist

- [ ] README 首屏标语与 HN 标题一致(现有:"Session-to-session messaging for AI coding agents")。
- [ ] 录一个 30 秒 GIF:`@codex` 跨会话 → 回信自动返回;放 README 顶部 + 发帖时贴。
- [ ] 在**一台干净机器**上验证 `install.sh` 一条命令能装成(HN 用户会当场试)。
- [ ] 第 4/5 节的正文 + 预答弹药存成可复制文本,发帖时手边。
- [ ] 仓库 Issues 开着、CONTRIBUTING.md 在、LICENSE(MIT)在。
- [ ] 选定标题(倾向 A),排到美东周二–周四上午。
- [ ] 清出 3–4 小时专门守评论区。
- [ ] (可选)发帖前一天把 README 的"已知局限"再核一遍(诚实是 HN 的加分项,也避免评论区打脸)。

---

**下一步建议**:先把这份草稿(标题 A + 第 4 节正文)按你的真实口吻改一版(你比我更知道那个"Codex @ 是今年最爽功能"的真实感受),再补个 30 秒动图。改好我可以帮你在干净环境验 install.sh、并把动图脚本走一遍。
