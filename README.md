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

## 当前状态

🚧 Phase 1 实施中：同机 Claude Code ↔ Codex 互 @。官网：[anytoany.dev](https://anytoany.dev)（建设中）

- [docs/specs/phase1-mvp.md](docs/specs/phase1-mvp.md) — **Phase 1 技术规格（当前施工图）**
- [docs/decisions.md](docs/decisions.md) — 已拍板的关键决策（ADR-001~007）
- [docs/analysis.md](docs/analysis.md) — 架构方案分析与推荐
- [docs/research/](docs/research/) — 各 agent CLI 的接入点调研 + 协议与现有项目盘点
- [CHANGELOG.md](CHANGELOG.md) — 重大变更记录

## 非目标（当前阶段）

- 不做 agent 编排/任务分发平台（gastown、Vibe Kanban 已有）
- 不做远程手机控制（omnara、happy 已有）
- 只做一件事：**session 之间的寻址与消息互通**
