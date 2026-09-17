# 用闪电说指挥 Claude Code 和 Codex

> 创建：2026-09-17 · 最后更新：2026-09-17
> 这份文档是给**闪电说用户**看的，可以直接转发。技术决策见 [ADR-024](../decisions.md)。

## 这是什么

[anytoany](https://github.com/Ericgood/any-to-any) 让你电脑上不同的 AI coding agent 会话互相发消息。接上之后，**闪电说助手就成了你的总驾驶舱**：你对它说话，它把活派给 Claude Code、Codex、Kimi、Z Code 的具体会话，干完了再把结果讲给你听。

你会这样用它：

> **你**：让 Codex 那个 sunoprompt 的会话去看看登录页那个报错，修完告诉我
>
> **闪电说**：已经发过去了。
>
> *（过一会儿）*
>
> **你**：刚才那个怎么样了？
>
> **闪电说**：Codex 回了 —— 报错是 token 刷新的竞态，已经改好并跑过测试，DONE。

好处是**每个模型待在自己最擅长的壳里**：Claude 在 Claude Code 里、GPT 在 Codex 里，你不用挨个切窗口，用嘴指挥就行。

## 先确认你用得上

**前提：你电脑上已经在用至少一个 AI coding agent** —— Claude Code、Codex、Kimi Code 或 Z Code。

anytoany 是把这些**已有的会话**连起来，它自己不提供任何 AI 能力。如果你还没在用这些工具，装了也没有对象可以派活。

系统要求：macOS + Node.js 20 以上。

## 三步接上

### 1. 装 anytoany

打开「终端」App，粘贴这一行回车：

```bash
curl -fsSL https://raw.githubusercontent.com/Ericgood/any-to-any/main/install.sh | bash
```

它会装好 `anyd` 命令、给你机器上的各个 agent 配好技能、把后台服务跑起来。装完你会看到一句提示：**检测到闪电说**，以及下一步的命令。

### 2. 接上闪电说

```bash
anyd connect sds
```

这条**只预览不写入** —— 它会列出将要动哪三个文件。看清楚了再执行：

```bash
anyd connect sds --apply
```

它往闪电说自己的数据目录写三样东西：一个技能文件、一个技能开关（手动放进去的技能默认是关的，必须写这个开关才会生效）、以及 `AGENTS.md` 里一段带标记的说明。**标记块以外你自己写的内容一个字都不会动。**

### 3. 重启闪电说

退出闪电说再打开。然后直接对它说：

> 有我的消息吗

它应该会去查一下收件箱。没有新消息就会告诉你没有 —— 这就说明接通了。

## 开始用

**派活**（它会先问你要发给谁，或者你直接说清楚）：

> 让 Claude Code 那个 anytoany 项目的会话把 README 的安装部分重写一下

**查回信**：

> 那边回了吗？

**看有哪些会话可以派**：

> 我现在有哪些 agent 会话可以用？

派活的时候**把话说完整** —— 对方看不到你和闪电说的对话，它只能看到你发过去的那段文字。

## 两个必须知道的限制

**1. 回信不是实时推给你的，是你下次开口时它去取。**

闪电说助手没有后台定时任务，不主动醒来。所以它不会突然弹出来告诉你"Codex 回你了"。不过 anytoany 会在有新消息时**弹一条 macOS 系统通知**提醒你 —— 你看到通知，打开闪电说问一句，它就把回信取回来了。

**2. 闪电说关掉的时候收不到，但消息不会丢。**

消息存在本机数据库里排队等着，下次你打开闪电说、说句话，它一次性全取回来。

## 出问题了怎么查

```bash
anyd doctor
```

会逐项检查，其中有一行专门看闪电说：

- `✓ 闪电说 assistant (external agent) — connected` → 一切正常
- `✗ … skill present but DISABLED in 闪电说` → 技能被关了，重跑 `anyd connect sds --apply`
- `✗ … run: anyd connect sds --apply` → 还没接上

其他常见情况：

| 现象 | 原因 | 怎么办 |
|---|---|---|
| 闪电说说"连不上 anytoany 服务" | 后台服务没跑 | `anyd status` 看状态，没跑就 `anyd start` |
| 它说找不到你要发的那个会话 | 名字对不上 | 先问它"我有哪些会话可以用"，再用列出来的名字 |
| 重启后还是没反应 | 技能没加载 | `anyd doctor` 看那一行；必要时重跑 `anyd connect sds --apply` 再重启 |

## 不想用了

```bash
anyd connect sds --uninstall --apply
```

只删它装的那三样（技能文件、那一个开关键、`AGENTS.md` 里那段标记块），你自己的技能和内容不动。

## 关于隐私

- **消息不出你的电脑。** 收发都走 `127.0.0.1` 本地回环，代码里强制只接受本机连接，消息存在本机 SQLite 里。
- **不需要注册任何账号**，anytoany 没有服务器。
- 跨设备（比如 MacBook 指挥 Mac mini）要**两台机器配对同一个 token**，而且只走局域网直连 —— token 不对直接 401。

## 想深入

- 项目主页与完整文档：[github.com/Ericgood/any-to-any](https://github.com/Ericgood/any-to-any)
- 为什么闪电说走 HTTP 而不是命令行、为什么收信做不到实时：[ADR-024](../decisions.md)（含逐条源码证据）
- 技术规格：[docs/specs/phase5-external-agents.md](../specs/phase5-external-agents.md)
