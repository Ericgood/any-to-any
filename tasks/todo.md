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
