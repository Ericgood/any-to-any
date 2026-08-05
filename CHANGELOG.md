# Changelog

所有重大变更记录于此，新条目在上。格式：`## YYYY-MM-DD — 标题` + 要点。

## 2026-08-05 — 项目规范建立与 Phase 1 计划定稿

- 建立项目规范（CLAUDE.md）：先文档后动作、docs/ 分区、CHANGELOG 制度、时间戳、每轮收尾必推 GitHub
- 新增 docs/specs/phase1-mvp.md：Phase 1（同机 Claude Code ↔ Codex 互 @）完整技术规格与里程碑
- 品牌定案：anytoany + tagline "Session-to-session messaging for AI coding agents"；域名 anytoany.dev 已注册（any2any.dev 跳转）；npm 包名 anytoany 验证可用
- ADR-004（TypeScript）、ADR-005（resume 投递）、ADR-006（A2A 对齐）随开工生效

## 2026-08-05 — 方向决策（ADR-001 ~ ADR-006）

- ADR-001 分发形态：Agent Skills 开放标准 + skill 引导安装（`npx skills add`），agent 侧走 bash 命令，MVP 零 MCP 配置
- ADR-002 跨设备：仅局域网（mDNS 发现 + HTTP 直连 + 配对 token），不用 Tailscale
- ADR-003 开源项目；ADR-006 与 Google A2A 协议：对齐语义、不绑定实现、后置兼容层
- 与 A2A 定位厘清：A2A 管 agent 服务层，anytoany 管运行中会话层，互补不竞争

## 2026-08-05 — 调研完成、仓库创建

- 四路并行调研 + 本机实测，5 份报告落盘 docs/research/：Codex 互 @ 实为进程内 multi-agent（跨 session @ 仅是提案）；Claude Channels / Codex app-server / kimi web 三家均有官方推送入站通道；三家均有 headless resume；「跨设备+跨厂商+session 级互 @」三合一无现成项目
- docs/analysis.md：接入点矩阵、三方案对比、推荐 daemon+adapter+邮箱语义架构、MVP 分期
- 创建 GitHub 仓库 Ericgood/any-to-any（private，首个可用版本前转 public）
