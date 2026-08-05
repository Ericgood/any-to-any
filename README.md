# Any to Any

**让任何设备上的任何 AI coding agent，都能互相 @、互相对话。**

Cross-device, cross-vendor session messaging for AI coding agents — let a Claude Code session on your MacBook `@` a Codex session on your Mac mini, and get a reply back.

## 问题

同一个项目，往往同时被多个 agent 在多台设备上开发：

- MacBook 上的 Claude Code 在改后端
- Mac mini 上的 Codex 在调前端
- 某台机器上的 Kimi Code / Z Code / Q Code 在跑另一块

它们彼此完全隔离。信息要靠人肉在中间复制粘贴：把 A 的结论贴给 B，把 B 的报错贴回 A。人成了 agent 之间的「网线」。

Codex 已经有 session 互相 @ 的功能，但只限它自己内部的 session。跨厂商、跨设备，没有人做。

## 目标体验

在任意一个 agent 的对话里：

```
@mini/codex:前端重构 worker.js 的重定向规则我改成 301 了，你那边路由测试帮我跑一下
```

- 消息被路由到 Mac mini 上那个叫「前端重构」的 Codex session
- 对方 agent 收到消息、处理、回复
- 回复回到发起方 session，双方可以来回多轮

核心语义：**session 级寻址**（设备 / agent / session 三段式）+ **异步消息投递** + **双向会话**。

## 当前状态

🔬 调研阶段。见：

- [docs/research/](docs/research/) — 各 agent CLI 的接入点调研 + 协议与现有项目盘点
- [docs/analysis.md](docs/analysis.md) — 架构方案分析与推荐

## 非目标（当前阶段）

- 不做 agent 编排/任务分发平台（gastown、Vibe Kanban 已有）
- 不做远程手机控制（omnara、happy 已有）
- 只做一件事：**session 之间的寻址与消息互通**
