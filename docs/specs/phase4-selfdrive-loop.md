# Phase 4 — 自驱协作循环（self-driving loop）实现 spec

> 创建：2026-08-14 · 最后更新：2026-08-14
> 决策依据：[ADR-020](../decisions.md)（发条=daemon、法官=lead、看产出定生死、只在真卡住/超 1 小时问操作者）
> 上游：[ADR-017/018](../decisions.md)（小本本=状态本体、单写者 lead、文档随连接诞生）、[phase4-collab-doc.md](./phase4-collab-doc.md)
> 互补：[ADR-019](../decisions.md)（monitor=可见性；本 spec=驱动力）

## 0. 一句话

让"要连续干的活"自己一圈圈往前跑，daemon 当发条驱动、按**产物**判断有没有在前进，只有**连续 K 圈没产出 + 真卡信号**或**跑满 1 小时**才停下、写总结、回头问操作者本人（`@user:cli`）。

## 1. 目标 / 非目标

**目标**
- 派活后 agent **自己续跑**，不靠操作者人肉催（治真实事故：会话 62f1741f #13–16，worker 搭完架子干等、未按 ETA 续跑）。
- 停下来问人的门槛取"精一点"：**先自试 K=2 圈**，只有真卡才升级。
- 双保险：语义停（看产出）+ 硬顶（1 小时封顶）。

**非目标（v1 明确不做）**
- 不在 Codex App 里做实时可见（#28259 是 Codex 的锅；观察面走网页控制台）。
- governor **不独立复核** worker 声称的产物（不去 `git` 验 sha 真假）——v1 信"写在本本上、且必须具体"的产物，深度核实留 v1.1。
- 跨设备 auto-run 不做（谁的 daemon 当发条更绕）——v1 **只驱动同机 owner**，跨机列 backlog。
- 不解析自由文本 ETA。"反复跳票"在 v1 归并进"连续 K 圈无产出"这一个机械信号（见 §5）。

## 2. 六块积木（依赖顺序）

| # | 积木 | 大小 | 依赖 |
|---|------|------|------|
| 0 | `@user:cli` 永不死信（升级通道焊死） | 小 | — |
| 1 | 任务加"模式"标签（design vs execute/autoRun） | 小 | — |
| 2+3+4 | 自驱调度器（发条 + 机械检测 + 法官升级） | 大（发动机） | 0,1 |
| 5 | skill 更新（worker 写产物式进度、别只回"收到"） | 中 | 1,2 |

逐块单独测、单独提交。

## 3. 数据模型变更

### 3.1 `CollabTask` 加字段 — `src/collab/doc.ts` L24–36
解析器不用动（L193 浅拷贝，新字段自动 round-trip；序列化 header L133–139 已含整个 `tasks`）。新增（全部可选，向后兼容）：

```ts
export interface CollabTask {
  id: string; owner: string; state: TaskState; step?: string; note?: string; updated: string;
  // ── 自驱新增（可选）──
  autoRun?: boolean;              // true = 上发条（execute 型）；缺省/false = 不驱动（design 型）
  startedAt?: string;            // 首次被发条驱动的 ISO 时间 → 1h 硬顶基准
  lastTickAt?: string;          // 上次发条驱动时间（控制节奏）
  stallCount?: number;          // 连续「无产出」圈数
  productFingerprint?: string;  // 上次观测到的产物指纹（比对是否前进）
  blockerFingerprint?: string;  // 上次 BLOCKED 的坎指纹（判「同坎反复撞」）
  blockerRepeat?: number;       // 同坎连续次数
}
```

`TaskState`（L13，不变）：`assigned | working | done | blocked | needs-decision | failed`。
- 发条**只驱动** `state ∈ {assigned, working}` 且 `autoRun === true` 的任务。
- 升级时把 `state` 置 `needs-decision`（已存在的态），发条随即**停手**（不再驱动 needs-decision）。

### 3.2 `MachineConfig` 加键 — `src/machine-config.ts` L11–14
```ts
export interface MachineConfig {
  zcode?: { deliverMode?: string; deliverTimeoutSec?: number };
  codex?: { sandbox?: string; deliverTimeoutSec?: number };
  autorun?: {
    enabled?: boolean;          // 总开关，默认 true
    tickIntervalSec?: number;   // 发条节拍，默认 60，clamp [15, 600]
    maxRetries?: number;        // K：无产出先自试几圈，默认 2，clamp [0, 10]
    maxWallClockSec?: number;   // 硬顶，默认 3600，clamp [60, 86400]
  };
}
```
读取沿用 `readMachineConfig(file)`（L20–27，吞错→`{}`），与 `codex.deliverTimeoutSec` 同款 clamp（参考 `src/adapters/codex.ts` L11–14）。

## 4. Piece 0 — `@user:cli` 永不死信

**现状**（`src/daemon/dispatcher.ts`，`dispatchOnce`）：
- L60–73 **路由**先跑：若 `to.device` 是外机 → 走 `relay` 分支，relay 没配 → `fail(...)`（L62/L69）。
- L77–81：`to.agent === 'user'` → `markDelivered` 进 user-inbox（**永不死信**，但只有走到这里才有效）。
- L90–93：目录查不到 → `fail('target session not found: @user:cli')`。
- `fail()` → `markFailed`（mailbox.ts L382–397），`attempts >= MAX_ATTEMPTS(3)` 或 terminal → `dead`。

**问题**：给操作者的信若带了外机 device、或走到目录查找，会绕过 L77 的永不死信路径 → 进 relay-fail 或 L92 → 最终 `dead`。全库 5 条死信里 2 条即 `target session not found: @user:cli`。

**修**：把"user 目标 = 本机 inbox 永不死信"提到**所有会 fail 的分支之前**，且对 device 无条件成立。
- 在 `dispatchOnce` 路由段最前面加：`if (claimed.to.agent === 'user') → markDelivered(user-inbox) → return true`（无视 device / relay 配置）。
- 语义：操作者是集群主人，给他的信永远落本机收件箱（控制台/inbox 可见），**永不 relay、永不 dead**。
- 附带：给历史那 2 条 dead 的 `@user:cli` 提供一次性 `retry()`（dead→pending，mailbox.ts L317–327）——可选，non-blocking。

**测**（`test/dispatcher.test.ts` 款式，fake clock + `:memory:` + stub directory + fakeAdapter）：
1. `to = @user:cli`、目录里**无** user 会话 → `dispatchOnce` 返回 delivered（非 dead），emit `delivered/user-inbox`。
2. `to = @user:cli` 且带**外机 device** + relay **未配** → 仍 delivered，**不** fail、**不** relay。
3. 回归：`to = @codex:...` 目录查不到 → 仍照旧 `fail`（不受影响）。

## 5. Piece 1 — 任务模式（design vs execute）

- `CollabTask.autoRun`（§3.1）。**lead 决定**：分解诉求时，把"要连续干几小时的活"标 `autoRun:true`，把"问一句答一句/一次性"标为缺省（design）。
- 承接 ADR-020 决策 #1"design 往返 vs execute 任务"的分野——**只有 execute 上发条**，避免问答型被反复捅。
- 落地：`store.upsertTask`（store.ts L165）已能写任意 `CollabTask` 字段；lead 侧新增 CLI 糖 `anyd collab task <id> --auto`（等价 `upsertTask({autoRun:true})`），或直接在 skill 里教 lead 用现有 `task` 命令带该字段。
- 无 lead 显式标注时**默认不驱动**（保守：宁可不自动，也不误跑）。

**测**：`upsertTask({autoRun:true})` round-trip（读回仍为 true）；序列化/反序列化保真（collab-store/doc 测试款式）。

## 6. Piece 2+3+4 — 自驱调度器（发动机）

### 6.1 挂哪
新增 `src/daemon/autorun.ts` 导出 `startAutoRun(opts, { intervalMs })`，返回 `stop()`。
在 daemon 装配处与 `startDispatcher` 并列启动 —— `src/cli.ts` L241–263（`isMonitored / collab / directory / relay / mailbox` 全在 scope）。**自成一个慢定时器**（默认 60s），不塞进 dispatcher 的 1s 投递循环。

### 6.2 谁扮谁
- **worker** = `task.owner`（被发条驱动去干下一截）。
- **法官** = `doc.lead`（只在"疑似卡住"的边界被叫一次，做判断）。
- **升级对象** = `@user:cli`。

### 6.3 唤醒原语（复用，不碰 adapter）
调度器**不直接调 adapter**，而是像 `/api/collab/:id/advance`（`src/daemon/server.ts` L285–333）那样**投一条 nudge 消息**，交给现有 dispatcher 投递：
```ts
mailbox.send({ from:{agent:'user',sessionId:'cli'}, to, text: nudge, via:'autorun', conversationId })
```
（`from` 用 `user:cli` 承接 advance 的既有语义；`to` = worker 或 lead。）

### 6.4 每一拍（对每个 `autoRun && state∈{assigned,working}` 的任务）
```
0. 总开关 autorun.enabled=false → 跳过。
1. 硬顶：now - startedAt > maxWallClockSec(3600) → 升级(见 4.) 「跑满 1h 未完成」，停。
2. isMonitored(owner 的本机 session) → 跳过本拍（活会话在场，别双驱动；沿用 dispatcher.ts L42–47 的 gate）。
3. 跨机 owner（to.device 非本机）→ v1 跳过（backlog）。
4. 节流：now - lastTickAt < tickIntervalSec → 跳过。
5. 机械检测「有没有产出真东西」：
     fp = fingerprint(该 task 的 worker 进度段最新条目 + task.step)
     若 fp !== productFingerprint → 有产出：productFingerprint=fp; stallCount=0; blockerRepeat=0;
        → 发一条 worker nudge「继续 task X 的下一截，读小本本，干完把产物记进你的进度段」; lastTickAt=now.
     否则（无产出）→ stallCount++。
6. 卡信号判定：
     hardBlock = 最近一次该 worker 对本 task 回 BLOCKED 且 blockerRepeat >= 2（同坎连撞）
     if hardBlock → 直接升级(见 4.)（硬卡，别再烧圈）。
     elif stallCount < maxRetries(K=2) → 再自试一圈：发 worker nudge「上一圈没见到新产物，换个打法把这截做出来，或说清卡在哪(BLOCKED)」; lastTickAt=now.
     else（stallCount >= K）→ 叫法官：governor-tick。
7. governor-tick（叫 doc.lead 判一次，仅在疑似卡住时——省钱）：
     发 lead nudge「task X 连续 K 圈没有新产物（判据：progress by product）。你判断：
        (a) 给个不同方向让 worker 再试 → 回一句新指令；
        (b) 这活确实卡死/方向错 → 你写一段给操作者的总结(目标/已完成/卡在哪/让他定夺的具体问题或选项)，我来把它投给操作者。」
     lead 若回 (a) → stallCount=0，继续循环；若回 (b) → 把该总结投 @user:cli，task.state=needs-decision，停驱动。
```

### 6.5 fingerprint（v1 启发式，诚实）
`fingerprint(task)` = 稳定 hash（如 djb2/sha1 前 12 位）of `task.step + '' + <worker 该轮进度段最新条目文本>`。
- 逼"具体产物"靠 **skill**（§7）教 worker 写"wrote &lt;file&gt; / &lt;sha&gt; / n/m"，并推进 `task.step`（n/m）。
- 局限：纯启发式，分不清"具体"与"啰嗦但变了字"。缓解：`task.step`（n/m）前进是强信号；配 §6.4 的 K 圈容忍 + 硬顶；深度复核留 v1.1。

### 6.6 升级动作（`escalate(task, summaryText)`）
- `mailbox.send({from:{agent:'user',sessionId:'cli'}? or lead, to:@user:cli, text: summaryText, via:'autorun-escalate', conversationId})`。
  - 靠 Piece 0 保证这条**永不 dead**。
- `store.upsertTask({...task, state:'needs-decision'})`。
- 控制台 SSE 已 watch 文档 `updated`，操作者在控制台即见 needs-decision + 总结。

### 6.7 破坏性动作红线（ADR-016 不松）
nudge 文案显式重申：**不可逆/破坏性动作（删数据、动生产、改系统态）不自动执行**，一律 `needs-decision` 升级确认——自动循环不等于自动批准。

## 7. Piece 5 — skill 更新（`skills/any-to-any/SKILL.md`）
- **worker**：收到 autorun nudge → **直接干下一截产物**，把"wrote &lt;file&gt; / &lt;sha&gt; / n/m"记进自己进度段；干不动就回 `BLOCKED <确切缺啥>`。**严禁只回"收到/审计完成"然后等**（直接治 #16 的纠正）。
- **lead**：分解诉求时给"连续干的活"标 `autoRun`；被 governor-tick 叫到时，要么给新方向，要么写操作者总结——**别自己跟 worker 空对空**。
- 重申"progress by product, not time"是**判据**不是建议（发条据此判生死）。

## 8. 配置（`~/.anytoany/config.json`）
```json
{ "autorun": { "enabled": true, "tickIntervalSec": 60, "maxRetries": 2, "maxWallClockSec": 3600 } }
```
全部有保守默认；缺文件/缺键 → 默认值。机主可整体 `enabled:false` 一键关。

## 9. 测试计划（TDD，先红后绿，≥80%）
- **Piece 0**：§4 三例（dispatcher.test.ts 款式）。
- **Piece 1**：autoRun 字段 round-trip（collab-store/doc 款式）。
- **Piece 2+3+4**（新增 `test/autorun.test.ts`，fake clock + `:memory:` + stub directory/collab store + fakeAdapter + 注入 `isMonitored`）：
  1. 有产出（fingerprint 变）→ 发 worker nudge、stallCount 归零。
  2. 无产出 1 圈（stallCount=1 < K）→ 再自试、**不**升级。
  3. 无产出到 stallCount>=K → 叫 governor（发 lead nudge）。
  4. 同坎 BLOCKED 连撞 2 次 → **直接**升级、置 needs-decision。
  5. 硬顶：now 越过 startedAt+3600s → 强制升级。
  6. isMonitored(owner)=true → 跳过（不 nudge）。
  7. 跨机 owner → 跳过。
  8. 升级信投 `@user:cli` 且**不 dead**（串起 Piece 0）。
  9. `autoRun` 未标注的任务**从不**被驱动。

## 10. 边界 / 风险 / deferred（记录在案）
- fingerprint 是启发式，会误判（假"有产出"/假"卡住"）→ 靠 K 容忍 + 硬顶 + 控制台可围观打断兜。
- 成本：每次 nudge/governor = 一次 headless 回合。语义停省钱、硬顶封顶。
- 跨设备 auto-run、结构化 ETA 跳票、governor 独立复核产物真伪 → **v1.1+ backlog**。
- monitor 在场时本任务本拍不驱动——若 worker 既不被 monitor、又 idle 不接 nudge，靠硬顶+升级兜底。
