# Phase 3 规格 — Kimi Code adapter（第五家：Moonshot 月之暗面）

> 创建：2026-08-10 · 最后更新：2026-08-10
> 状态：已实施（本机 kimi 0.32.0 真机端到端通过：发现 7 会话 + 探针会话投递 + marker 回信干净解析）。母调研：[research-kimi-zcode-qcode.md](../research/research-kimi-zcode-qcode.md)
> 动机：用户要用 MacBook 的 Codex ↔ Mac mini 终端里的 Kimi Code 协作（kimi 只能终端运行）。

## 1. 发现（listSessions）

- 数据源：`$ANYTOANY_KIMI_BIN 无关` — 读 `~/.kimi-code/session_index.jsonl`（每行一条 JSON）。
- **真实字段（v0.32.0 实测，仅三个）**：`sessionId`（`session_<uuid>`，resume 直接用）· `sessionDir`（会话目录绝对路径）· `workDir`（cwd）。**无标题、无时间戳**。
- 映射：`sessionId` 原样 · `cwd = workDir` · `title = basename(workDir)`（80 截断，无则 `untitled`）· `lastActiveAt = stat(sessionDir).mtimeMs`（目录不存在则 0）。
- 按 sessionId 去重（后行胜）、按 mtime 降序。索引缺失/不可读 → `[]`（未装 kimi 的机器静默跳过）。
- 无需子代理过滤：kimi 子代理运行记录存于会话目录内 `agents/` 子目录，**不作为顶层 session 进索引**（与 codex/zcode 不同，反而更简单）。

## 2. 投递（deliver）

- 引擎解析优先级：`ANYTOANY_KIMI_BIN` → PATH 上 `kimi` → `~/.kimi-code/bin/kimi`（单二进制，163MB）。
- argv：`kimi -S <sessionId> -p <envelope> --output-format stream-json`（cwd = workDir，有则传）。
- **权限模型与 ZCode 相反、无需提权**：默认 `-p` 已自动执行工具（实测创建文件成功），非只读；且 **`-p` 不能与 `-y`/`--yolo`/`--auto`/`--plan` 组合**（CLI 直接报错 `Cannot combine --prompt with --yolo`，v0.32.0 实测）——adapter 绝不传这些旗标，机主提权在此不适用也不可用。
- 超时 300s；失败取 stderr 尾部 500 字符。

## 3. 回信解析（关键）

kimi `--output-format stream-json` 每行一条消息 JSON。实测一个「用工具的回合」形状：

```
{"role":"assistant","content":""}                      ← 将调用工具，空正文
{"role":"tool","content":"Wrote 1 bytes to x.txt"}     ← 工具结果
{"role":"assistant","content":"<<<ANYTOANY_REPLY>>> …"}← 终态 assistant，含 marker
{"role":"meta","type":"session.resume_hint","content":"To resume: kimi -r …"} ← 尾部提示
```

adapter 只取 `role==='assistant'` 且 content 非空的行拼接为 `output`——**排除 tool 结果与 meta resume_hint**，否则「To resume this session…」会污染 marker 之后的回信（text 模式还有 `• ` 前缀，故用 stream-json）。

## 4. 联动面

- `defaultAdapters()` 注册第五家 → 目录扫描、@any 物化（`any-kimi-*` / 跨机 `any-<device>-kimi-*`）、hook digest、webui 自动生效。
- webui：`kimi` 品牌色/logo 早已在 25 家品牌库中（`#7C3AED`），无需新增。
- 收件可见性（P3 跟踪）：kimi 有 19 事件 hooks（`UserPromptSubmit` 可注入 context，与 Claude 同构）；实时通道升级路径为 `kimi web` REST/WS（`POST /sessions/{id}/prompts` + `:steer` + 程序化审批 `/approvals`）——同类最强，留待 P3。

## 5. 验收

1. 单测：fixture `session_index.jsonl` → 字段映射/mtime 排序/缺失返回空/坏行跳过；deliver 断言 argv（stream-json、无 -y/--auto）、stream-json 回信解析（排除 tool+meta）、stderr 尾部。（6 测试，全绿）
2. 真机（本机 kimi 0.32.0）：`listSessions` 发现真实会话；向 scratch 探针会话真实投递，kimi 执行 + marker 回信干净解析（不碰用户真实会话，实测通过）。
3. 跨机：mini 更新 anytoany 后，MacBook 侧 `anyd list` 出现 `@<mini>/kimi/...`；Codex→mini Kimi 首条真实消息由用户发起验证。
