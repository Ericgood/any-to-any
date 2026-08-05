# Any to Any

**Session-to-session messaging for AI coding agents.**

让任何设备上的任何 AI coding agent，都能互相 @、互相对话——cross-device, cross-vendor. Let a Claude Code session on your MacBook `@` a Codex session on your Mac mini, and get a reply back.

## 问题

同一个项目，往往同时被多个 agent 在多台设备上开发：

- MacBook 上的 Claude Code 在改后端
- Mac mini 上的 Codex 在调前端
- 某台机器上的 Kimi Code / Z Code / Q Code 在跑另一块

它们彼此完全隔离。信息要靠人肉在中间复制粘贴：把 A 的结论贴给 B，把 B 的报错贴回 A。人成了 agent 之间的「网线」。

Codex 已经有 session 互相 @ 的功能，但只限它自己内部的 session。跨厂商、跨设备，没有人做。

## 目标体验

**安装**（任选其一，装一次全家生效）：

```
npx skills add Ericgood/any-to-any
```

或者把本仓库链接贴给你的任意 agent，说「装上」。

**使用**——在任意一个 agent 的对话里：

```
@mini/codex:前端重构 worker.js 的重定向规则我改成 301 了，你那边路由测试帮我跑一下
```

- 消息被路由到 Mac mini 上那个叫「前端重构」的 Codex session
- 对方 agent 收到消息、处理、回复
- 回复回到发起方 session，双方可以来回多轮

核心语义：**session 级寻址**（设备 / agent / session 三段式）+ **异步消息投递** + **双向会话**。

## 形态

- **一份 skill**（[Agent Skills 开放标准](https://code.claude.com/docs/en/skills)，SKILL.md）：教会每家 agent @ 的语法、何时查收、如何回复——Claude Code / Codex / Cursor / Gemini CLI 等都认这个格式
- **一个 daemon（`anyd`）**：session 目录、消息邮箱、投递引擎；agent 通过 skill 指引的 bash 命令与它交互（`anyd send` / `anyd inbox`），**零 MCP 配置**
- **局域网直连**：Bonjour/mDNS 自动发现同网设备，daemon 间 HTTP 直连 + 配对 token，无任何第三方服务

## 快速开始（Phase 1：同机 Claude Code ↔ Codex）

```bash
# 在仓库目录（npm 发版前）
npm install && npm run build && npm link

anyd setup      # 装 skill 到 ~/.claude、~/.codex、~/.agents + 注册 Claude 收件 hook
anyd doctor     # 环境自检
anyd start      # 启动投递 daemon + Web 控制台 http://127.0.0.1:7433
```

然后在任意一个 agent 会话里说：`@codex:某个会话 帮我看看 X`——skill 会引导它完成寻址与发送；或直接打开 [控制台](http://127.0.0.1:7433) 用「＋ 新建对话」让两个 session 连线。

常用命令：

```bash
anyd list                 # 本机可寻址的 session（Claude + Codex 混排）
anyd conversations        # 已建立的连接
anyd send "@codex:前端" "消息" --from "@claude:后端"
anyd inbox --take         # 查收并标记送达
anyd flush                # 无 daemon 时手动投递一轮
anyd status / stop        # daemon 状态 / 停止
```

> Claude 会话自动处理消息（而非等用户下次说话时带入）需要 CLI 登录态：终端跑一次 `claude` 登录即可解锁，不做也不影响其余功能（详见 [ADR-008](docs/decisions.md)）。

## 跨设备（Phase 2：同一局域网）

在第二台设备（如 Mac mini）上：

```bash
# 1. 安装（同快速开始）；然后加入同一集群：
anyd pair --set <第一台机器上 anyd pair --show 打出的 token>
anyd pair --name mini        # 可选：起个好记的设备名
anyd start                   # 两台都跑着 daemon
```

之后两台设备通过 mDNS 自动互相发现（`anyd peers` 查看），目录自动聚合——在 MacBook 的任意 agent 里直接：

```
@mini/codex:前端重构 worker.js 我改好了，你那边跑下测试
```

消息经局域网直连投递到 mini 上的 Codex 会话，回信自动路由回来。零第三方服务、零云端，token 不同的设备互相不可见内容（HTTP 401）。

## 当前状态

🚧 Phase 1 收尾：同机互 @ 全链路已跑通（Codex↔Codex 双向、Claude→Codex 单向 + 回信入站）。官网：[anytoany.dev](https://anytoany.dev)（建设中）

- [docs/specs/phase1-mvp.md](docs/specs/phase1-mvp.md) — **Phase 1 技术规格（当前施工图）** + [Web Console 附件](docs/specs/phase1-webui.md)
- [docs/decisions.md](docs/decisions.md) — 已拍板的关键决策（ADR-001~008）
- [docs/analysis.md](docs/analysis.md) — 架构方案分析与推荐
- [docs/research/](docs/research/) — 各 agent CLI 的接入点调研 + 协议与现有项目盘点
- [CHANGELOG.md](CHANGELOG.md) — 重大变更记录

## 非目标（当前阶段）

- 不做 agent 编排/任务分发平台（gastown、Vibe Kanban 已有）
- 不做远程手机控制（omnara、happy 已有）
- 只做一件事：**session 之间的寻址与消息互通**
