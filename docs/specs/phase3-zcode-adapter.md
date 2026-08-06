# Phase 3 规格 — ZCode adapter（第三家：智谱 Z.ai）

> 创建：2026-08-06 · 最后更新：2026-08-06
> 状态：已实施（发现+投递管道实测通过；投递的模型层 auth 待用户侧动作——见母调研 §7.7，升级 App 跑 `zcode login` 或手配 API key）。母调研：[research-zcode.md](../research/research-zcode.md)
> 动机：用户要用 MacBook 的 Codex ↔ Mac mini 的 ZCode 跨机通信（两台机都装了 ZCode 桌面客户端）。
> 实测调整：argv 去掉 `--max-turns`（0.15.2 解析器不认，见母调研 §7.1）；db 路径固定不随 `ZCODE_DATA_BASE_DIR`（§7.3）。

## 1. 发现（listSessions）

- 数据源：`$ZCODE_DATA_BASE_DIR|~/.zcode` + `/cli/db/db.sqlite`，better-sqlite3 **readonly** 打开（App 常驻 WAL 写入中），查完即关。
- 查询 `SELECT * FROM session`，JS 层宽松过滤（防版本列漂移整查询失败）：
  - 排除 `task_type = 'subagent_child'`、`parent_id` 非空、id 前缀 `sess_subagent`（对齐 Codex 子代理过滤经验：子会话拒收直接输入）
- 映射：`sessionId = id`（保留 `sess_` 前缀，resume 直接可用）· `title = title || basename(directory) || 'untitled'`（80 截断）· `cwd = directory` · `lastActiveAt = time_updated`（已是 ms）。
- db 打不开/表不存在 → 返回 `[]`（未装 ZCode 的机器静默跳过）。

## 2. 投递（deliver）

- 引擎解析优先级：`ANYTOANY_ZCODE_BIN` env → PATH 上的 `zcode`（当前官方无此分发，预留）→ `/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`。`.cjs` 用 `node` 执行。
- argv：`--cwd <cwd>（有则传）--resume <sessionId> --mode build --max-turns 25 --prompt <envelope>`
- **安全底线：显式 `--mode build`**——`--prompt` 无头默认 yolo（跳过全部权限确认），绝不隐式继承；build 为 ZCode 常规工作模式，等价 codex exec 默认权限层级。
- **权限模式与机主授权（2026-08-07 增补，真实协作暴露）**：build 模式下需确认的工具在无头回合会被直接拒绝（无人点确认）→ 会话事实只读，Codex 指挥 ZCode 写系统即卡死。定案：**机主显式提权**——目标机器的 `~/.anytoany/config.json` 写 `{ "zcode": { "deliverMode": "yolo" } }`（白名单校验 plan/edit/build/yolo，非法值回退 build；每次投递实时读盘，改配置免重启）。提权决定权只在机主手里，发消息的 agent 永远无法指定模式。风险边界如实告知：开启后该机被唤起的 ZCode 回合无确认执行命令，信封防注入是提示层非强制层，仅建议在自有集群（token 独享）内开启。此为「投递级权限档案」（P3）第一块砖。
- 超时 300s；失败取 stderr 尾部 500 字符（错误在横幅回显之后，对齐 codex 经验）。
- 不用 `--json`：回信抽取靠 stdout 文本中的 REPLY_MARKER，JSON 转义会污染 marker 之后的正文。

## 3. 联动面

- `defaultAdapters()` 注册第三家 → 目录扫描、@any 物化（`any-zcode-*`）、hook digest、webui 自动生效。
- webui：`AGENT_COLORS['zcode']` + `AGENT_LOGOS['zcode']`（App icon 提取位图，三级兜底走位图层）。
- 收件可见性（P3 跟踪）：ZCode 有 Claude 同款 `UserPromptSubmit` hook——`anyd setup` 未来可加 ZCode hook 安装；`app-server`（ZCode Protocol）与门控中的原生 mailbox 是实时通道升级路径。

## 4. 验收

1. 单测：fixture SQLite 建 `session` 表——interactive 入选、subagent 三种形态全过滤、title/cwd/时间映射正确、db 缺失返回空；deliver 断言 argv（含 `--mode build` 非 yolo）、错误含 stderr 尾部。
2. 真机（本机装有 ZCode 3.5.3）：`ZCODE_DATA_BASE_DIR` 隔离环境跑通「创建 → resume 续接」全流程（不碰用户真实会话库写入）；真实库只做只读扫描验证。
3. 跨机：mini 更新 anytoany 后，MacBook 侧 `anyd list` 出现 `@<mini>/zcode/...` 条目；Codex→ZCode 首条真实消息由用户发起验证（不注入测试消息到真实会话）。
