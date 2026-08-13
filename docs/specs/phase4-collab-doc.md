# Phase 4 规格 — 协作层：共享上下文文档 + 任务生命周期（跨厂商弱一致版）

> 创建：2026-08-13 · 最后更新：2026-08-13
> 状态：**M1–M4（半自动）已落地 + M5（文档随连接诞生）进行中**（2026-08-13）；M4 全自动 + M3.1 规划中。母决策：[ADR-017](../decisions.md)、**[ADR-018](../decisions.md)（建档时机演进）** · 相关：ADR-014（room）、ADR-016（信任）
> 一句话：把「消息即一切」升级为「**共享文档为状态、消息为事件、一个 lead 主导、跨机同步**」，让两个（乃至多个）agent 能像两个人一样先对齐、再分工、边干边汇报、把活干完。

## 0. 为什么现在做

前三阶段解决了「能不能通」（发现/投递/跨设备/五家 adapter）。真实使用暴露的是「**通了却协作不起来**」：

- **重活一轮干不完**：headless resume 是**一轮**，超时被杀（已加机主可配超时兜底，但一轮终有上限）。
- **agent 两轮之间无状态**：被 resume 时不记得上下文，全靠会话历史或写下来的东西。
- **lead 看不到 worker 进度**：派出去就是黑盒，不知道干到哪、要不要调整（连单厂商 Codex 都有此病，[issue #16900](https://github.com/openai/codex/issues/16900)）。
- **过度客气死循环**：两个 agent 互发「我在等你」烧 token（反乒乓已止血，但根因是缺协作结构）。

目标：让「先对齐上下文 → 分工 → 边干边按轮汇报 → 事事有回应」这套**人际协作范式**，在**跨厂商、跨设备、agent 无状态**的现实约束下成立。

## 1. 竞品定位（调研结论，决定我们抄什么、不抄什么）

| 系统 | 协作模型 | 共享上下文 | 进度可见性 | 我们的关系 |
|---|---|---|---|---|
| **Codex subagents**（[docs](https://learn.chatgpt.com/docs/agent-configuration/subagents)） | manager 派 N worker，**阻塞等全部再汇总** | `AGENTS.md`（静态）+ 汇总；无一等公民 plan 文档 | 单 turn 内**基本看不到**（[#16900](https://github.com/openai/codex/issues/16900)） | 单厂商内部编排，封闭，抄不了 |
| **Claude Code agent teams**（[docs](https://code.claude.com/docs/en/agent-teams)） | **1 lead + N teammate**，各独立 session | **共享 task list**（三态+依赖+file-lock claim）+ mailbox 直连 | 干完自动 idle 通知 lead | **最完整的样板，重点借鉴** |
| **Claude cross-session messaging**（[docs](https://code.claude.com/docs/en/cross-session-messaging)） | ListAgents + SendMessage | 无（纯消息） | tool call 间读消息不打断 | **anytoany 的同厂商版**，投递语义对标 |
| **anytoany（本阶段）** | 跨厂商 1 lead + N worker | **协作文档（本 spec）** | turn 边界 summary + 任务状态 | 跨厂商/跨设备**弱一致**版 |

**能抄的**（跨厂商也成立）：共享 task 文件的最小状态机、file-lock 防抢占、turn 边界的 done/blocked 通知、plain-text envelope、消息≠授权的安全阀。
**抄不了的**（靠单厂商同进程内部状态）：共享 context window、fork 对方 thread、非破坏性暂停对方 turn、跨厂商实时 streaming、自动 merge 单 PR。**本阶段坚决不碰这些，避免做成幻觉。**

## 2. 设计原则

1. **弱一致优先**：跨厂商只做「文件约定 + turn 边界 summary」，不追求强一致 thread tree。
2. **文档是状态，消息是事件**：重内容永远落文档；消息短、指向文档。
3. **单写者**：一份文档正文只有一支笔（lead），worker 只 append 自己的段。
4. **plain-text envelope 不变**：结构化协作语义走文档的机读区，不塞进消息（跨厂商传结构化对象不可靠）。
5. **进度按产物不按时间**：LLM 估不准时间；进度 = 完成第几步 / 产出什么文件。
6. **信任队友 + 安全阀**：ADR-016 默认信任不变，叠加可选 inbound 分级 + 不可逆动作确认。

## 3. 核心概念

- **协作文档（collab doc）**：每个 conversation 一份 Markdown，协作的**状态本体**。
- **消息 = 事件/门铃**：如「计划更新了，看 §plan」「done 第 2 块，写进度段了」——短，指向文档。
- **两个视图**：控制台的**消息流** = 易逝事件（谁几点戳谁）；**文档面板** = 持久状态（计划/todo/进度）。

## 4. 协作文档结构（single-writer 正文 + append-only 进度段 + 机读状态区）

`~/.anytoany/collab/<conversationId>.md`（**M1 已落地的实际格式**）：

```markdown
---
{
  "conversationId": "17c34304-4158-4cf0-9a47-30bea28b84ef",
  "lead": "@claude:web-app",
  "updated": "2026-08-13T10:20:00.000Z",
  "tasks": [
    { "id": "t1", "owner": "@codex:api",      "state": "working", "step": "2/4", "updated": "2026-08-13T10:18:00Z" },
    { "id": "t2", "owner": "@claude:web-app", "state": "blocked", "note": "等 t1 的 /auth 契约", "updated": "…" }
  ]
}
---

（lead 独占正文：目标 / 关键背景 / 分工 / 决策日志，自由 markdown）

## Progress — @codex:api           <!-- 只有 @codex:api 能 append -->

- 10:12Z 开工：读 authMiddleware → 加 /auth/refresh → 测 → 交契约，分 4 步
- 10:18Z 2/4：/auth/refresh 已写，返回 {token,exp}

## Progress — @claude:web-app       <!-- 只有 @claude:web-app 能 append -->

- 10:06Z 待 t1 契约，先搭 interceptor 骨架
```

- **机读区 = front-matter 内的一段 JSON**（不是手写 YAML）。理由：JSON 是 YAML 严格子集 → 既人类可读、未来 YAML 工具也认；且用内置 `JSON.parse` 零依赖、零手写引号 bug（ISO 时间戳带冒号、note 带 unicode）；serialize/parse 保证 round-trip。lead 维护，供控制台渲染「B 在干，第 2/4 块」。
- **正文**：lead 独占（目标/分工/决策），存为一段不透明 markdown。
- **每个 agent 一段 `## Progress — <agent>`**（英文标题，面向跨厂商/国际化）：**只有该 agent append**，天然无写冲突。
- **落盘一致性**：写走「文件锁（O_EXCL）→ 读改 → 写临时文件 → rename」原子替换；非 lead 改正文/任务在模型层直接抛错。

## 5. 所有权与并发

- **lead 单写正文**（含 front-matter）。lead 由 **ADR-016 的操作者指定**（「让 A 带 B」即 A 为 lead）；未指定时默认发起方，或用户在控制台选「更强的那个」。
- **worker 只 append 自己的进度段**。想改正文/分工 → **发消息给 lead**，lead 整合。
- **file-lock claim**（借鉴 Claude teams）：写文档前取文件锁（`<conv>.md.lock`），避免同机两写者竞态；跨机由 single-writer + relay 串行化规避。
- **lead 挂了怎么办**（开放）：控制台可「转交 lead」；或超时无 lead 活动则允许操作者接管。

## 6. 任务生命周期状态机

对齐 Codex cloud（queued/running/completed）+ Claude teams（pending/in-progress/completed）+ A2A Task：

```
assigned ──> working(n/m) ──> done
                │  │
                │  └─> blocked(<缺什么>)      # 等依赖/凭据/用户
                └────> needs-decision(<问题>) # 要 lead 拍板
       任一 ──> failed(<原因>)
```

- 每次交接更新 front-matter 的 `state`/`step`。
- 控制台按状态渲染徽章；`anyd` 增 `anyd collab <conv>`（看文档 + 任务态）。
- 这**不是**强一致分布式状态机，就是 lead 维护的一份声明；worker 的真实状态以它 append 的进度段为准。

## 7. 回合制协作协议（把 AI 四差异变成规则，写进 skill）

**0. 对齐优先——协作第一步就建/填小本本（ADR-018，主模型）**：小本本**随连接诞生**——首条 agent↔agent 消息通了，daemon 就自动建一份（以那条诉求为种子内容，lead=发起方）。lead 的**开局第一动作 = 把操作者的诉求分解进小本本**（目标 + 分工 + 任务），**按量**：一次性小活一行诉求 + 顶多一个任务，大活才 full 分解。发起方理想是**在 @ 对方之前**就 `collab init`+`plan`+`task` 建好+分解；即便忘了，auto-create 也保证文档从第一条消息起就在、信封带 footer，lead 下一轮补分解。控制台「Create/Edit」按钮**降级为兜底**（agent 没建、或人工想改）。**「事后手动建」是被推翻的旧路径。**

1. **每 turn 一块**：worker 收到「读 §context，干 t1，进度写 §进度」→ 在一轮内干**一块**（能一轮完成的量）→ append 进度 + 下一步 → 回 `DONE 第n块` 或 `BLOCKED <缺什么>`。**不做一轮超时会丢的重活**。
2. **进度按步不按时**：不报「大概 2 小时」，报「分 4 步，已完成 2 步」。
3. **FYI vs 请求**：纯状态更新（我干完了 X）自动闭环，回 `NOOP`；只有含**新请求/问题**才要求对方回。（承接反乒乓 + Claude「消息≠授权」精神。）
4. **lead 读进度 → 决策 → 推进下一块**：谁去 resume worker 干下一块？见 §11 M4（自动调度 vs 人工/lead 主动）。

## 8. 跨设备文档同步（本阶段独有价值）

- 文档存双机各一份 `~/.anytoany/collab/<conv>.md`；**跟随消息 relay**：lead 每次更新正文 → 事件消息带上文档新版本（或 diff）→ relay 到对端写入。
- single-writer 保证正文只有 lead 改；worker 的进度段变更也随其回信 relay 回 lead 机合并入对端副本。
- 冲突面极小（每段单写者）；用 `updated` 时间戳 + 段级归属做最后仲裁。
- 这正是同机「写同一个文件」做不到的部分——**anytoany 的跨设备中继天生补这块**。

## 9. 安全（ADR-016 增补）

- 默认信任队友不变（单操作者集群前提）。
- **叠加可选 inbound 分级**（借鉴 Claude cross-session）：`~/.anytoany/config.json` 增 `inbound: accept | hold | refuse`（默认 accept）；`hold` = 跨机消息先在控制台待用户放行。
- **不可逆动作确认**：ADR-016 已要求「不可逆破坏性动作须确认」——协作协议里明确：写文档/跑测试等可逆动作直接做；删数据/改生产/动系统须回 `needs-decision` 让 lead 或用户确认。

## 10. 与现有的关系

- 复用 **conversation**（ADR-014 room）：协作文档挂在 conversationId 下。
- 复用 **信任模型**（ADR-016）：lead 指定 = 操作者授权。
- 复用**机主超时/落盘**（本轮修复）：重活走文档交接，超时也不丢产物。
- 复用 **@any 寻址**：lead/worker 都是已寻址会话。
- **文件交接**（agent 自行发明）→ 升为协作文档这一等公民。

## 11. 分期里程碑（MVP 优先，每步可独立验收）

- **M1 · 同机协作文档** ✅（2026-08-13）：`src/collab/{doc,lock,store}.ts`（纯模型 + O_EXCL 文件锁 + 原子写）；lead 单写正文 + worker append 进度段 + 单写者强制；`anyd collab init/show/list/plan/task/progress/lead`；投递信封在有文档时追加 SHARED PLAN footer（指针式，不内联全文）；skill 增回合制协议。48 测试绿 + 真机 CLI 冒烟全过。**范围决策**：创建走显式 `collab init`（非每条消息自动建），auto-create-on-first-message 挪 M2。**未碰跨设备。**
- **M2 · 任务生命周期 + 控制台** ✅（2026-08-13）：控制台加「Shared plan」面板（任务徽章按状态染色 / plan / 逐 agent 进度 / 可折叠）+ 对话列表 📋 标记；`GET /api/collab`、`GET /api/collab/:id`；SSE 轮询纳入文档 `updated`（CLI 改文档→控制台自动刷新）。任务状态机模型 + `anyd collab` 在 M1 已落地。**建档保持显式 `collab init`**（用户拍板不做自动建）。
- **M3 · 跨设备文档同步** ✅（2026-08-13）：`merge.ts` 收敛合并（lead 区 last-writer-wins + 进度段按 agent 取更满一份 + 确定性 tie-break）；`store.merge()`；`POST /api/peer/collab`（token 门禁）；`pushCollabDoc`；`anyd collab sync <id> --to @device`（显式 push 式,git push 语义,幂等安全）。双机键同一 conversationId。+11 测试含双 daemon 真机 HTTP 收敛证明。**范围收窄**：本轮做的是**显式 push 同步**而非「随消息自动 relay」——后者要 conversationId 跨机统一（收端 mailbox 采用发起端 id），牵动路由语义,拆到 **M3.1** 单独做,连带受端信封 footer / 控制台面板的跨设备关联。今日受端经 `collab show/list` 可见同步来的文档。
- **M4 · 推进调度·半自动** ✅（2026-08-13）：控制台每个未完成任务加「▶ Continue」→ `POST /api/collab/:id/advance {taskId}` → 解析 owner label 为 session → 发一条 pin 在协作对话上的「继续下一块」nudge（投递带 SHARED PLAN footer）。**操作者点触发,不自循环**。**全自动调度器**（干完自动唤醒下一块）留后——见 §12 开放问题#1,风险是跑飞/无限推进,需先定「何时停」。
- **M5 · 文档随连接诞生 + lead 开局分解**（ADR-018，2026-08-13，进行中）：**推翻 M1/M2 期「手动建为主」**。daemon 在首条 agent↔agent 消息投递时自动建种子文档（body=诉求，lead=发起方）；skill 把「对齐+分解诉求」设为协作**第一步**；控制台 Create/Edit 降级为兜底。硬机制（连接即有壳）+ 软提示（lead 开局填肉）配合。

## 12. 明确不做 / 开放问题

**本阶段不做**：多 lead、实时协同编辑、>2 agent 的复杂 room（先 2 方 + user）、跨厂商 streaming 监督、暂停对方 turn、自动 merge。

**开放问题（需边做边定）**：
1. **推进调度**：worker 干完一块，谁负责触发下一块？（M4 核心难点）
2. **大文档 token 成本**：每轮把整份文档塞进 envelope 会涨 token——是否只传 diff / 相关段？
3. **lead 失活**：lead 会话关了/挂了，协作怎么继续？（转交/接管机制）
4. **跨机一致性**：relay 丢包/乱序时文档如何收敛？（段级 last-writer-wins 是否够）
5. **与各家原生 subagent 的边界**：worker 内部还能再派自己的 subagent，anytoany 只看到顶层——是否够用？

---

**出处**：Codex [subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents) / [#16900](https://github.com/openai/codex/issues/16900) / [#34809 pause](https://github.com/openai/codex/issues/34809) · Claude [agent teams](https://code.claude.com/docs/en/agent-teams) / [cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging) · [app-server 指南](https://gist.github.com/oneryalcin/ee2c27e2d8aa040da8fbe7eebcc2ecea)
