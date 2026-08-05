# Phase 2.5 规格 — @any 寻址层（用户确认式补全）

> 创建：2026-08-05 · 最后更新：2026-08-05
> 状态：已实施（2026-08-05）。增补：候选集过滤临时目录会话（/tmp、/private/tmp、/var/folders——冒烟残留不入补全列表）。动机：用户提出（见 ADR 系列实战反馈）——agent 自由模糊寻址有误投风险，应由用户在补全里亲手确认目标；且 Claude Code 输入框的 `@` 补全被文件引用占用，需要能「占位」的机制。

## 0. 核心洞察（用户方案 + 机制验证）

Claude Code 的 `@` 补全会列出 `~/.claude/agents/` 下的全部 agent。因此：**把每个可寻址的目标会话物化成一个 `any-` 前缀的 agent 定义文件**，用户打 `@any` 时补全列表全是我们的条目，越输越精确——已手工验证（any-codex-ios 热加载成功、出现在补全与 agent 列表）。

选中即确认：每个 agent 文件**生成时预绑定精确 session id**，被 @ 到的投递代理零模糊匹配、零自由发挥——从机制上排除误投。

## 1. 自动同步（daemon 职责）

daemon 每次目录刷新后执行 `syncMentionAgents`：

- **候选集**：非 claude 的本机+远端活跃会话（codex/kimi/gemini…），按 lastActiveAt 取 TOP 8/agent 类型；加上已连接对话（conversations）的全部对端（不论排名）。claude↔claude 暂不物化（客户端有原生 send_message；避免 4000+ 会话污染补全）。
- **命名**：`any-[<device>-]<agent>-<cwd 目录名或标题的 ascii 化>`，冲突追加 id 前 4 位；全小写 kebab。例：`any-codex-shandianshuo-ios`、`any-mini-codex-frontend`。
- **文件内容**：frontmatter（name、description 含标题/目录/活跃时间、tools: Bash、model: haiku——投递代理用最便宜模型）+ 投递代理 prompt（精确 target、自我定位发起方、verbatim 转发、失败如实报告、不做任何其他事）。
- **卫生纪律**：只创建/更新/删除 `any-` 前缀文件；内容不变不写盘；消失的会话对应文件删除；绝不触碰用户自己的 agents。

## 2. 安全模型（回应误投批评）

- @any-xxx 路径：目标预绑定，用户选中即确认——主推路径；
- 自然语言路径（skill anyd send）保留但收紧：**未建立过对话的新目标，agent 必须先向用户展示解析结果（标题+id+目录）确认后再发**；已连接对话直接发（skill 同步该规则）。

## 3. Codex 侧对应（待办）

Codex 自定义 agent 为 TOML 定义，`@` 提及支持度与热加载行为待实测；先行方案：Codex 会话内自然语言触发（skill 已通）。实测通过后在 `~/.codex/` 对应目录物化 `any-claude-*` 系列。

## 4. 验收

1. daemon 运行中，`~/.claude/agents/` 出现 `any-codex-*` 系列且随会话活跃度自动增删；
2. Claude Code 输入框打 `@any` 补全列出全部条目，选中 + 消息 → 投递到预绑定会话，驿站可查、回信回流；
3. 用户自有 agents 文件零触碰（测试断言）。
