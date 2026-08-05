# Phase 1 规格附件 — Web Console（本地可视化控制台）

> 创建：2026-08-05 · 最后更新：2026-08-05（晚间迭代）
> 状态：已纳入 Phase 1（里程碑 M5）。母文档：[phase1-mvp.md](phase1-mvp.md)

## 0. 为什么必须有（用户定调）

1. **可理解**：纯后端没人看得懂这项目是干嘛的；打开 localhost 一眼看到「哪些 session 在互相说话」，产品自解释。
2. **可监控**：实时看到消息流、投递状态，`@` 通没通一目了然。
3. **可兜底**：agent 会话里 @ 不动（目标读不到、解析歧义等）时，人在页面上直接建立连接、代发消息——**外部环境把事办了**。
4. **反哺 skill**：页面上建立过的连接成为「已连接列表」，agent 唤起 skill 时优先看到可选的现成对话对象（低频操作，预连接体验最优）。

## 1. 产品形态：IM 式双栏（微信隐喻）

```
┌───────────┬──────────────────────────────────┐
│ 对话列表    │  claude:后端重构 ↔ codex:前端重构    │
│ ┌───────┐ │ ┌──────────────────────────────┐ │
│ │🟠↔⚫ ...│ │ │ 🟠 claude → @codex: 我把重定向  │ │
│ │最新摘要·2m│ │ │    改成 301 了，帮我跑下路由测试  │ │
│ ├───────┤ │ │         ✓ delivered · 14:02   │ │
│ │🟠↔🟣 ...│ │ │ ⚫ codex → @claude: 12 个用例    │ │
│ └───────┘ │ │    全绿，报告如下…    ✓ · 14:04  │ │
│ [Sessions] │ └──────────────────────────────┘ │
│ [+ 新建对话]│  [以 claude:后端重构 的身份发送… ▸]   │
└───────────┴──────────────────────────────────┘
```

- **左栏 = conversation 列表**：每项一个 session 配对（`A ↔ B`），显示双方 agent 色标（Claude 橙 / Codex 黑 / Kimi 紫 / Gemini 蓝）、session 标题、最新消息摘要、相对时间、投递失败红点。按最新活动排序。
- **右侧 = 选中对话的消息时间线**：A 恒左、B 恒右（创建时发起方为 A）；每条气泡带发送方色标、正文、时间、投递状态（pending ⏳ / delivering ⏫ / delivered ✓ / failed ⚠ 可点重试）。SSE 实时追加，无需刷新。
- **新建对话**：两个下拉框（从本机 session 目录选 A、选 B，显示 agent+标题+项目目录+最后活跃）+ 首条消息文本框 → 发送即建立连接并投递。
- **对话内代发**：底部输入框，人以 A 或 B 的身份（切换器）插话——本质与 agent 调 `anyd send` 同一管道，`parts` 里标注 `via: "webui"`。
- **Sessions 页**（左栏底部入口）：本机全部已发现 session 的目录表，可从任一 session 快捷发起新对话。
- 单页应用、无登录（仅绑 127.0.0.1）、中文界面为主。

## 2. 技术方案

- 前端：Vite + React + TypeScript，手写轻样式（不引组件库）；构建产物入 npm 包，由 anyd daemon 在同端口静态托管：`http://127.0.0.1:7433/`。开发期 `vite dev` proxy 到 daemon。
- 实时：`GET /api/events`（SSE，原生 EventSource）。事件：`message.created` / `message.status`（含投递态迁移）/ `directory.updated`。
- REST（全部 127.0.0.1-only，与 CLI 共用 daemon 内部服务层）：
  - `GET /api/sessions` — session 目录
  - `GET /api/conversations` — 对话列表（含最新消息与未达数）
  - `GET /api/conversations/:id/messages` — 时间线
  - `POST /api/messages` `{from:{agent,session}, to:{agent,session}, text}` — 发消息；不存在该配对时自动创建 conversation（即「新建对话」）
  - `POST /api/messages/:id/retry` — 失败重投
- 数据模型增量（母文档 §4 同步修订）：新表 `conversations`（id、a/b 两侧 agent+session、created_at、last_message_at；(A,B) 无序对唯一）；`messages` 增加 `conversation_id`。`context_id` 保留管「一问一答线程」，回环保护按 context 计数不变。
- skill 联动：CLI 增 `anyd conversations [--json]`；SKILL.md 指引改为「先查已连接对话 → 命中直接 send；未命中再 `anyd list` 全量解析」。

## 3. 验收（并入母文档 §1，编号续 9-12）

9. `anyd start` 后浏览器打开 `127.0.0.1:7433` 见双栏界面；已有消息历史正确按对话分组。
10. 页面「新建对话」选 claude session × codex session 发首条 → 目标被投递、回复回流，时间线实时出现双向气泡（不刷新页面）。
11. agent 侧 `anyd send` 的消息 1 秒内实时出现在页面对应对话中。
12. `anyd conversations` 列出该连接；Claude Code 内唤起 skill 能读到这个「已连接列表」。

## 4. 明确不做（Phase 1）

多人群聊（>2 参与方）、跨设备 session 展示（P2 随局域网一起来）、鉴权（P2 配对 token 时统一）、消息搜索、暗色主题以外的主题定制、移动端适配。


## 5. 实施后迭代记录（2026-08-05 晚，用户反馈驱动）

- **§1 的微信式左右双栏已废弃**：实际实现为飞书/Slack 式单列消息流——第三方观察者视角无「我」，左右之分不成立（用户设计判断）。每条消息 = 品牌头像 + 彩色名称 + 精确时间戳（HH:MM）+ 状态尾注 + 跨天日期分隔线。
- 「新建对话」的 select 下拉替换为搜索式选择器（关键词过滤 标题/agent/目录/设备/id，按活跃降序，30 条上限）。
- 品牌视觉库：25 家主流 coding agent 的官方 logo 内嵌（矢量 15 家 + 位图 10 家），三级渲染兜底（矢量→位图→字母色块），页面保持零外链单文件（64KB）。
- 定位升级（ADR-012）：Web Console 由「监控台+兜底」升格为**协作主观察界面**——Codex Desktop App 无第三方注入通道（调研定案），App 内实时可见性等待官方。
