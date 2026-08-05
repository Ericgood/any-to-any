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
- [ ] M3 dispatcher + adapter ×2 + 信封
- [ ] M4 双向回路 + skill + 冒烟（§1 验收 1-8）
- [ ] M5 Web Console（SSE+REST+IM 双栏，附件验收 9-12）
- [ ] M6 收尾：文档、anyd doctor、npm 发版（可选）

## 待办池（Phase 2+）
- [ ] P2 跨设备：mDNS 发现 + HTTP 直连 + 配对 token
- [ ] P2 launchd 常驻 + npx skills add 分发
- [ ] P3 实时注入升级（Claude Channels / Codex app-server / kimi web）
- [ ] P3 Kimi / Gemini adapter；投递专用权限 profile（硬隔离）
- [ ] P3+ A2A 兼容层（anyd 暴露 endpoint + Agent Card）
- [ ] 官网 anytoany.dev 上线；any2any.dev 301 跳转

## Review（2026-08-05 规范与计划轮）
规范落地：先文档后动作 / docs 分区 / CHANGELOG 带时间戳 / 每轮必推 GitHub——已写入 CLAUDE.md 成为项目章程。Phase 1 spec 含验收脚本、模块边界、数据模型、信封防注入、TDD 计划、五个里程碑与四项风险的首日实验方案。下一步：用户审阅 spec → M0 开工。
