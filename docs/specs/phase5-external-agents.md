# Phase 5 技术规格 —— 外部 agent 接入（注册式身份 + 拉取型投递）

> 创建：2026-09-17 · 最后更新：2026-09-17
> 决策依据：[ADR-024](../decisions.md)（含闪电说桌面端源码调研的全部证据链）
> 首个接入方：闪电说桌面版（agent 名 `sds`）

## 0. 要解决什么

anytoany 现有的四个 agent（claude/codex/zcode/kimi）都靠 **CLI headless resume** 投递。但 GUI 型 agent（桌面 App 里的助手）没有这种通道：

- 它们的 session 不在磁盘上以我们能扫的格式存在，或存在但不该由我们去写；
- 它们的 shell 环境往往被沙箱和最小 PATH 限制，跑不了 `anyd`；
- 它们通常**零自驱**，无法被外部唤醒。

结论：给这类 agent 一条**注册 + 拉取**的通用通道。它们主动报到（注册）、主动来取（拉取），anytoany 只负责把它们变成**可寻址的一等目标**。

## 1. 术语

| 词 | 含义 |
|---|---|
| **外部 agent** | anytoany 没有 `DeliveryAdapter` 的 agent。只能拉取，不能被推送 |
| **注册** | 外部 agent 声明「我这个 session 存在，叫这个名字」，写进 `~/.anytoany/registered/` |
| **拉取型投递** | 发给它的消息**停在 `pending`**，dispatcher 不 claim，等它自己来取 |

## 2. 数据模型

### 2.1 注册记录

路径：`~/.anytoany/registered/<agent>-<safeSessionId>.json`（`safe()` 同 `src/daemon/monitor.ts`：非 `[A-Za-z0-9._-]` 一律转 `_`）

```ts
interface ExternalSession {
  agent: string;        // 校验 ^[a-z][a-z0-9-]{1,31}$，且不在保留名内
  sessionId: string;    // 原始 id（未转义），外部 agent 自己提供
  title: string;        // 人类可读名，用于 @-target 模糊匹配；缺省 = agent 名
  cwd: string;          // 可空字符串
  registeredAt: number; // epoch ms，首次注册时间，后续 upsert 不变
  lastSeenAt: number;   // epoch ms，每次 register 刷新
}
```

**保留名**：`user`、`claude`、`codex`、`kimi`、`zcode`。`user` 是 mailbox-as-inbox 的 sink（`dispatcher.ts:76,103`），其余四个有真实投递适配器——注册同名会造成目录里两个来源的 session 混淆。一律拒绝。

**TTL = 7 天**。超过 TTL 的记录**不出现在目录里**，但**文件保留**；再次 `register` 即复活（`registeredAt` 不变，`lastSeenAt` 刷新）。理由：注册是长期身份，不是 monitor 那种 10 秒活跃心跳；但一个卸载了的 App 不该永远占着 `@sds` 这个地址。

### 2.2 与 SessionInfo 的映射

```
ExternalSession → SessionInfo { agent, sessionId, title, cwd, lastActiveAt: lastSeenAt }
```
无 `device`（外部 agent 一律本机；跨设备由对端 daemon 各自注册）。

## 3. 模块契约

### 3.1 `src/registry/external.ts`

| 函数 | 输入 | 输出 | 边界条件 |
|---|---|---|---|
| `register` | `{agent, sessionId, title?, cwd?}`, `opts?:{home,now}` | `ExternalSession` | agent 非法/保留 → 抛 `Error`；`sessionId` 空 → 抛；已存在 → upsert（保留 `registeredAt`），**返回新对象，不原地改** |
| `unregister` | `agent, sessionId` | `void` | 文件不存在 → 静默成功（幂等） |
| `listRegistered` | `opts?:{home,now,ttlMs,includeStale}` | `ExternalSession[]` | 目录不存在 → `[]`；单个文件损坏 → **跳过该条，不整体失败**；默认过滤 stale |
| `isRegisteredSession` | `sessionId` | `boolean` | 只按 sessionId 查（dispatcher 的 skip 回调只拿得到 sessionId）；**不看 TTL**——过期的仍不该被 headless 投递 |

### 3.2 `src/adapters/registered.ts`

`createRegisteredAdapter(opts?) : AgentAdapter` —— `agent` 字段为 `'external'`（仅用于 `listAllSessions` 的错误归因，不参与寻址）；`listSessions()` = `listRegistered()` 映射成 `SessionInfo[]`。**刻意不实现 `deliver`**。

### 3.3 dispatcher

`DispatcherOptions` 新增 `isPullOnly?: (sessionId: string) => boolean`，并入已有 skip：

```ts
const skipLocal = (toSession, toDevice) =>
  !toDevice && ((opts.isMonitored?.(toSession) ?? false)
             || (opts.isSessionLive?.(toSession) ?? false)
             || (opts.isPullOnly?.(toSession) ?? false));
```

**不变量**：发给已注册 session 的消息，`status` 恒为 `pending`、`attempts` 恒为 `0`，直到被拉取。

### 3.4 daemon HTTP（loopback-only 区，`server.ts:179` 之后）

| 方法 路径 | 请求体 | 响应 | 说明 |
|---|---|---|---|
| `POST /api/inbox` | `{agent, sessionId, register?, title?, cwd?}` | `201 {count, text, messages}` | `register:true` → 先注册/续期再取信。取信复用 `collectInbox()`（`hooks/prompt-hook.ts:83`），连 ADR-022 死信恢复一起继承；`text` 是渲染好的可直接朗读内容 |
| `POST /api/register` | `{agent, sessionId, title?, cwd?}` | `201 {session}` | 非法 agent 名 → `400` |
| `GET /api/sessions?q=&agent=&limit=` | — | `200 {sessions}` | **无参数时行为与改前逐字节一致**（web console 依赖）。有参数才过滤截断 |
| `POST /api/send` | 不变 | 不变 | 已支持原始 `from:{agent,sessionId}`（`server.ts:352`），无需改动 |

`q` 匹配 `title` 或 `cwd` 的大小写不敏感子串；`limit` 上限 200，非法值忽略。

### 3.5 CLI

```
anyd register --agent <name> --session <id> [--title <t>] [--cwd <dir>]
anyd unregister --agent <name> --session <id>
anyd list                      # 外部 agent 行尾标注 (external, pull-only)
anyd pull --session "@sds:..."  # 无需改动，本来就 agent-agnostic（cli.ts:601）
anyd setup sds [--apply] [--uninstall]
```

### 3.6 `src/daemon/external-notify.ts`

`startExternalInboxNotifier({mailbox, listRegistered, notifier, intervalMs=5000, now?}) : {stop()}`

每 `intervalMs` 扫一遍注册 session 的 `pending` 消息，对**未通知过**的 id 发一条 macOS 通知。已通知 id 记内存 `Set`；**构造时先把当前所有 pending 塞进 Set**（避免 daemon 重启重播积压）。无注册 session 时直接返回、零查询。

## 4. 闪电说（`sds`）接入契约

### 4.1 路径解析（`src/integrations/sds.ts`）

```
APP_HOME  = ~/Library/Application Support/Shandianshuo
workspace = APP_HOME/migrations/workspace-location-v1.json 的 .workspacePath，缺省 APP_HOME/workspace
skillDir  = <workspace>/library/skills/anytoany/     ← 目录名即权威 name（storage.rs:200-203）
stateFile = APP_HOME/skills/skills-state.json        ← 键 "voice_assistant/anytoany"
agentsMd  = <workspace>/AGENTS.md
```

### 4.2 `anyd setup sds` 行为

| 场景 | 行为 |
|---|---|
| 默认（无 `--apply`） | **只打印**将写入的三处内容与 diff，零磁盘写入 |
| `--apply` | 写三处。SKILL.md 全量覆盖；`skills-state.json` 只加/改 `voice_assistant/anytoany` 一个键，其余键**逐字保留**；`AGENTS.md` 只替换 `<!-- anytoany:begin -->…<!-- anytoany:end -->` 之间，块外内容**逐字保留**，文件不存在则创建 |
| 重复 `--apply` | 幂等，结果一致 |
| `--uninstall` | 删 skill 目录、删 state 里那一个键、删 AGENTS.md 里那一个块。**其余一律不动** |
| APP_HOME 不存在 | 报错并提示「未检测到闪电说」，退出码 1，零写入 |

### 4.3 助手侧最终命令

```bash
SID="${DSH_SESSION_ID:-${SHANDIANSHUO_DSH_SESSION_ID:-main}}"

# 收信
curl -s -m 10 -X POST http://127.0.0.1:7433/api/inbox -H 'content-type: application/json' \
  -d "{\"agent\":\"sds\",\"sessionId\":\"$SID\",\"register\":true,\"title\":\"闪电说助手\"}"

# 发信
curl -s -m 30 -X POST http://127.0.0.1:7433/api/send -H 'content-type: application/json' \
  -d "{\"target\":\"@codex:sunoprompt\",\"from\":{\"agent\":\"sds\",\"sessionId\":\"$SID\"},\"text\":\"...\"}"
```

`SID` 的回退链：源码注入的是 `SHANDIANSHUO_DSH_SESSION_ID`（`dsh_runtime.rs:1627`），装机版观察到 shell 里还有 DSH 自己注入的 `DSH_SESSION_ID`——两个都试，都没有则退到字面量 `main`（助手只有一个固定 session，退化可用）。

## 5. 明确的非目标

- **不做**闪电说原生 session 扫描适配器（理由见 ADR-024）
- **不做**推送注入（remote.mux / ACP / headless / Inbox 五条通道全部查证不可用）
- **不改** `anyd` 默认存储位置，**不改** `anyd send/pull` 现有行为
- **不承诺**外部 agent 的秒级收信——口径是「消息在它下一回合被取回」

## 6. 验收

1. `npm test` 全绿，新增模块覆盖 ≥80%
2. `anyd register --agent sds --session probe-1` → `anyd list` 出现并标 `(external, pull-only)`
3. 端到端：`@sds:probe-1` → 真 codex session → 回信 → `POST /api/inbox` 取回；DB 里该消息全程 `pending`/`attempts=0`
4. `anyd setup sds` dry-run 零写入；`--apply` 后在闪电说里说「有我的消息吗」能自己跑通
5. 反向：Claude Code 里 `@sds` 发一条 → 弹 macOS 通知 → 闪电说下一轮取到
