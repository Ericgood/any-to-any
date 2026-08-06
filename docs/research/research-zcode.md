# 调研：ZCode（智谱 Z.ai 桌面 ADE）接入通道

> 创建：2026-08-06 · 最后更新：2026-08-06
> 结论：**可接 adapter，且是 Claude/Codex 之外最顺的一家**。发现 = 读一个 SQLite；投递 = 一条 `--resume --prompt` 命令；App/CLI 天然同存储（投递后桌面 App 内直接可见）。

## 1. 身份判定

「Z code」= **ZCode**，智谱 AI（Z.ai / bigmodel.cn）出品的 Agentic Development Environment 桌面客户端，2025-12-26 发布，3.0（2026-06）起自研 Agent 内核 + GLM-5.2。不是 Zed 编辑器。

证据（本机实测 + 官方）：
- `/Applications/ZCode.app/Contents/Info.plist`：`CFBundleIdentifier = dev.zcode.app`，v3.5.3，Electron
- `~/.zcode/v2/config.json` provider：`builtin:zai-coding-plan` / `builtin:bigmodel-coding-plan`（国际/国内双品牌）
- 官网 https://zcode.z.ai/en/docs/install（最新 v3.6.5，仅分发桌面 App，**无独立 CLI 渠道**；npm 上 `zai-cli` 等为第三方无关包）

**关键架构事实**：桌面 App 是壳，引擎是 App 内打包的 12MB Node CLI bundle：
`/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`（shebang node，内部代号 `zcode-cli`，引擎 0.15.x，数据模型为 OpenCode 系近亲）。完整终端 TUI + headless 接口俱全。

## 2. 会话发现（硬要求 1）✅

唯一数据源 `~/.zcode/cli/db/db.sqlite`（WAL；App 与 CLI 共用同一套 session id，已验证 App 侧 `~/.zcode/v2/tasks-index.sqlite` 的 task_id 与 CLI 侧 session.id 一致）。

`session` 表关键列（本机实测）：

| 字段 | 格式/样例 |
|---|---|
| `id` | `sess_<uuid4>`；子代理 `sess_subagent_agent_<uuid>` |
| `project_id` | `proj_users-gongzhen-suno-gateway`（路径小写连字符化） |
| `directory` | cwd 绝对路径 |
| `title` | 首条输入生成（`title_source` 注明来源） |
| `time_created`/`time_updated` | epoch **毫秒** |
| `task_type` | `interactive` 主会话 / `subagent_child`（须过滤） |
| `parent_id` | 子会话指向父会话（须过滤） |

消息正文在 `message`/`part` 表（data 列 JSON）。`~/.zcode/cli/rollout/model-io-sess_*.jsonl` 只是模型 I/O 调试日志，非权威转录。**必须只读打开**（App 常驻时 WAL 持续写入）。

## 3. headless 投递（硬要求 2）✅

从 `zcode.cjs` 内嵌帮助文本提取（offset 3827075，非猜测）：

```
zcode --prompt <text>        # 无头单轮（不开 TUI）
  -p, --print                # 位置参数形式的无头单轮
  --resume <sessionId>       # "Resume a persisted session by sessionId (sess_...)"
  -c, --continue             # 续接当前目录最近会话
  --cwd <path>               # 指定工作目录（可异地调起）
  --mode <mode>              # build/edit/plan/yolo；--prompt 时默认 yolo(!)
  --max-turns <n> --allowed-tools --disallowed-tools --json --settings <path>
```

投递 argv 范式：

```bash
node "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs" \
  --cwd /path/to/project --resume sess_xxx --mode build --max-turns 25 \
  --prompt "<anytoany envelope>"
```

其他能力（bundle 实证）：
- **`zcode app-server`**：ZCode Protocol，JSON-RPC over stdio（version 1，`sessionUnavailable:-32004`）——与 Codex app-server 同构，实时通道升级路径现成
- **Hooks**：事件名与 Claude Code 同款——`SessionStart`/`UserPromptSubmit`/`PreToolUse`/`PostToolUse`，支持 project/plugin hooks（收件可见性可复用现有方案）
- **内置 session mailbox 子系统**：`ZCODE_MAILBOX_ROOT`（默认 `~/.zcode/mailbox`），受内部环境门控未激活——持续跟踪
- 环境变量：`ZCODE_API_KEY`、`ZCODE_DATA_BASE_DIR`、`ZCODE_BASE_URL`

## 4. 认证：文件型，App/CLI 共享

- `~/.zcode/v2/credentials.json`（`oauth:zai:access_token`、`zcodejwttoken`）——纯文件非 Keychain，headless 天然可用
- CLI 自证共享：「/logout — Remove the **shared** Z.AI login credentials」
- 备选：`ZCODE_API_KEY` env / `zcode login --no-browser`

## 5. 风险

1. **默认 yolo**：`--prompt` 无头默认 `--mode yolo`（跳过权限确认）。adapter **必须显式传 `--mode`**——对齐「不注入提权参数」红线
2. **SQLite 并发**：发现层只读无虞；App 正在跑同 session 时 `--resume` 行为未验证（App 有 Singleton 锁，engine 侧未见会话级锁）
3. **版本漂移**：App 3.5.3 / 官网 3.6.5，CLI 接口未公开文档化（社区亦确认），升级可能变；好在 schema 有 `schema_migration` 表、帮助文案保留多个 legacy 兼容旗标
4. App/CLI 会话互通**已确认**——反而是优势：投递后用户在桌面 App 里直接看到

## 6. mini 侧部署要求

**不用装任何新东西**：mini 已装桌面客户端 → 引擎就在 App bundle 里；前提是 Node 20+（anytoany 本身要求）+ App 内登录过一次（凭证落盘）。

## 7. 引擎 0.15.2 实测勘误（2026-08-06 冒烟，App 3.5.3 内置引擎）

真机跑通/跑挂后的硬情报，修正 §3 的帮助文案信息：

1. **帮助文案超前于解析器**：`--max-turns`、`--settings` 在 help 里但解析器拒收（`Unknown option`）——adapter 不使用；轮数由 exec 300s 超时兜底。
2. **`ZCODE_MODEL` 环境变量可用**：`ZCODE_MODEL="zai/GLM-5.2"` 直接指定模型目标（`ZCODE_` 前缀通用 env 配置层实存）。
3. **`ZCODE_DATA_BASE_DIR` 只隔离 credentials，不隔离 `cli/db`**（实测：设了它，session 仍写真实库——冒烟因此在用户真实库留下 2 条空会话，教训入 tasks/lessons.md）。adapter 的 db 路径因此固定 `~/.zcode/cli/db/db.sqlite`。
4. **CLI 用户配置结构**（bundle 反编译确认，OpenCode 风格）：`~/.zcode/cli/config.json` = `{ "model": { "main": "zai/GLM-5.2" }, "provider": { "zai": { "kind": "anthropic", "options": { "baseURL": "https://api.z.ai/api/anthropic", "apiKey": "..." }, "models": { "GLM-5.2": {} } } } }`。我最初猜的 `{main:{provider,model}}` 是 registry 内部形态，不是文件格式。
5. **runtime 不接 shared credentials**：`resolveApiKey` 三级 = config apiKey → `apiKeyEnv`（anthropic kind 默认 `ANTHROPIC_API_KEY`，注意会误吃真 Claude key，勿用 env 方式）→ 报错。`~/.zcode/v2/credentials.json` 的 oauth token（加密存储）只有 App 场景注入。
6. **`zcode login` 在 0.15.2 已死**：其 OAuth 端点 `POST https://zcode.z.ai/api/v1/oauth/cli/init` 实测 404（服务端已下线该版本端点）→「OAuth response is not valid JSON」。
7. **auth 的两条可行路**：a) 升级 ZCode App（官网 3.6.5，新引擎大概率带新 OAuth 端点，login 一次即自动生成含 key 的 config.json）；b) Z.ai 控制台取 API key，按 §7.4 结构手写 config.json。二选一之后 headless 管道即通（发现/隔离/参数层已全部实测通过，只差模型层 auth）。

Sources: [ZCODE Docs](https://zcode.z.ai/en/docs/install) · [智谱 ZCode 3.0 发布](https://zhuanlan.zhihu.com/p/2052115075520008864) · [paseo#1670](https://github.com/getpaseo/paseo/issues/1670) · 本机 `/Applications/ZCode.app` + `~/.zcode/`（v3.5.3 实测）
