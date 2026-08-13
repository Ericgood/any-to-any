# anytoany — 任务追踪

> 项目规范见 CLAUDE.md；当前施工图见 docs/specs/phase1-mvp.md

## 已完成
- [x] 2026-08-05 四路调研 + 本机实测（docs/research/ 5 份）
- [x] 2026-08-05 架构分析（docs/analysis.md）与仓库创建
- [x] 2026-08-05 决策 ADR-001~007（分发/局域网/开源/TS/resume/A2A/品牌域名）
- [x] 2026-08-05 项目规范（CLAUDE.md + CHANGELOG.md 制度）
- [x] 2026-08-05 Phase 1 技术规格（docs/specs/phase1-mvp.md）

## Phase 1（等用户审阅 spec 后开工）
- [x] M0 脚手架（TS+vitest+CLI 骨架，build/test 全绿）+ 通道实验（R2 全解除；R1 剩「历史携带」待用户终端验证）
- [x] M1 directory：scanner ×2 + resolve（TDD 30 测试绿，anyd list 真机验证 4157 sessions）
- [x] M2 mailbox 驿站：SQLite 状态机 + conversations + CLI 四命令（42 测试绿，真机首条消息入站）
- [x] M3 dispatcher + adapter ×2 + 信封（62 测试绿；真机 Claude→Codex 投递成功且 Codex 回信自动入站）
- [x] M4 双向回路 + skill + hook + 冒烟（SMOKE PASS：Codex↔Codex 三消息全 delivered）
- [x] M5 Web Console（浏览器实测：双栏/气泡/状态/重试/SSE 全通）
- [x] M6 收尾：doctor 8 项全✓ / setup / README / LICENSE / npm link（publish 留用户）

## Phase 2.5（2026-08-05 完成）
- [x] @any 寻址层：sync-agents 自动物化 + 预绑定精确 id（spec: docs/specs/phase2.5-at-mention.md）
- [x] 信封 v2 强制表态（DONE/BLOCKED/DECLINED）
- [x] 双端收件 hook + 活动摘要（Codex App 内可见性）

## 2026-08-05 晚（可见性与体验战役，全部完成）
- [x] 信封 v2 强制表态 + 防幻觉条款（ADR-011）
- [x] 双端收件 hook + 活动摘要 + macOS 通知（ADR-012）
- [x] Codex 实时注入调研定案（官方 not planned，跟踪 issue 清单在研报）
- [x] Web Console 飞书式单列消息流 + 搜索选择器 + 25 家品牌 logo 库
- [x] @any 寻址层（含临时目录过滤）

## 待办池（Phase 2+）
- [x] P2 跨设备核心：device 寻址/mDNS 发现/HTTP 直连/token 配对/relay 路由/目录聚合（真双机验收待用户在 mini 执行）
- [ ] P2 launchd 常驻 + npx skills add 分发
- [ ] P3 实时注入升级（Claude Channels / Codex app-server / kimi web）
- [ ] P2 加固：conversation 级速率限制——回环保护按 context 计数，agent 反复开新线程的「状态同步空转」是盲区（2026-08-05 r2c 实测暴露）
- [ ] P3 Kimi / Gemini adapter；投递专用权限 profile（硬隔离）
- [ ] P3+ A2A 兼容层（anyd 暴露 endpoint + Agent Card）
- [ ] 官网 anytoany.dev 上线；any2any.dev 301 跳转

## Review（2026-08-05 Phase 1 完成轮）
Phase 1 M0-M6 全部完成：81 测试全绿（覆盖率 92.7/80/98.4），Codex↔Codex 双向冒烟 PASS，Claude→Codex 真投递成功，Codex→Claude hook 链路验证通过（驿站留有活体演示消息）。Web Console 浏览器实测。教训两条入 lessons.md（资源定位禁猜测兜底；mtime 不可信用文件名时间戳）。待用户：验收、可选 claude 登录、repo 转 public、npm publish。

## Review（2026-08-05 规范与计划轮）
规范落地：先文档后动作 / docs 分区 / CHANGELOG 带时间戳 / 每轮必推 GitHub——已写入 CLAUDE.md 成为项目章程。Phase 1 spec 含验收脚本、模块边界、数据模型、信封防注入、TDD 计划、五个里程碑与四项风险的首日实验方案。下一步：用户审阅 spec → M0 开工。

## Phase 4 — 协作层（共享上下文文档 + 任务生命周期）· 规划 2026-08-13

> 母文档：docs/specs/phase4-collab-doc.md · docs/decisions.md ADR-017
> 一句话：文档为状态、消息为事件、一个 lead 主导、跨机同步。让 agent 像两个人一样先对齐再分工、边干边按轮汇报。

- [x] **M1 同机协作文档**（2026-08-13，48 测试绿 + CLI 真机冒烟全过）：`~/.anytoany/collab/<conv>.md`（JSON front-matter + lead 正文 + `## Progress — <agent>` 段）；`src/collab/{doc,lock,store}.ts` 纯函数模型 + O_EXCL 文件锁 + 原子写；单写者强制（非 lead 改计划直接报错）；`anyd collab init/show/list/plan/task/progress/lead`；投递信封在有文档时追加 SHARED PLAN footer（不内联全文，省 token）；skill 增回合制协议。**范围决策**：文档创建走显式 `collab init`（不是每条消息自动建，避免污染 collab/ 目录）——auto-create-on-first-message 挪到 M2 配合控制台落地。
- [x] **M2 任务生命周期 + 控制台**（2026-08-13，+4 测试绿 + 浏览器冒烟全过）：server 增 `GET /api/collab`（列表，供对话列表 📋 标记）+ `GET /api/collab/:id`（单文档，不存在返回 {doc:null} 不 404）；SSE 轮询纳入 collab 文档 `updated`——CLI 改文档时控制台自动刷新（真机验证:CLI append 进度→2.5s 内面板自动出现新行）；webui 加「Shared plan」面板（任务徽章按状态染色 / plan / 逐 agent 进度 / 可折叠）。**建档保持显式 `collab init`**（用户拍板不做自动建）。任务状态机模型 + `anyd collab` 已在 M1 落地。
- [x] **M3 跨设备文档同步**（2026-08-13，+11 测试绿 + 双 daemon 真机 HTTP 冒烟收敛）：`src/collab/merge.ts` 收敛合并（lead 区 last-writer-wins + 进度段按 agent 取更满的一份 + 平局确定性 tie-break，两机互推后收敛到同一状态,7 测试含收敛/幂等证明）；`store.merge()`（首见落盘原样、再合并不丢更新）；`POST /api/peer/collab`（token 门禁,收端 parse+merge+broadcast）；`pushCollabDoc` 客户端；`anyd collab sync <id> --to @device`（经本机 daemon 发现 peer 后直推,git push 式显式同步）。双机键同一 conversationId。**范围**：同步是显式 push（非自动 relay 挂载）；自动同步 + 跨设备信封/控制台关联 = M3.1 待做（需 conversationId 跨机统一）。真机验证脚本见 scripts/verify-m3-crossdevice.sh。
- [x] **M4 推进调度·半自动**（2026-08-13，+2 测试绿 + 浏览器冒烟）：控制台每个未完成任务加「▶ Continue」按钮 → `POST /api/collab/:id/advance {taskId}` → 解析任务 owner label 为 session → 发一条「继续 task X,读共享计划、干下一块、记进度」的 nudge，pin 在协作对话上(投递时带 SHARED PLAN footer)。**操作者点触发,天然不自循环**。真机冒烟:点 t1 的 Continue → 线程里出现发往 @codex owner 的 pending nudge。**全自动调度器**(自己触发下一块)明确留后——风险高,要防跑飞。
- [ ] **M5 文档随连接诞生 + lead 开局分解**（ADR-018，推翻 M1/M2「手动为主」）：daemon 首条 agent↔agent 投递自动建种子文档（body=诉求，lead=发起方）；skill 把「对齐+分解诉求」设为协作第一步（按量分解）；控制台 Create/Edit 降级为兜底。硬机制（连接即有壳）+ 软提示（lead 填肉）。
- [ ] **安全阀**：config 增 inbound accept/hold/refuse（默认 accept）+ 不可逆动作走 needs-decision 确认（ADR-016 增补）

**开放问题（边做边定）**：推进调度归谁 · 大文档 token 成本（只传 diff？）· lead 失活转交 · 跨机一致性收敛 · 与各家原生 subagent 的边界

**明确不做（本阶段）**：多 lead / 实时协同编辑 / >2 方复杂 room / 跨厂商 streaming 监督 / 暂停对方 turn / 自动 merge
