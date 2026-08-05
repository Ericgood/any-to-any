# 决策记录（ADR）

## ADR-001 分发形态：Agent Skills 开放标准 + skill 引导安装（2026-08-05，用户拍板）

**决定**：项目做成开源仓库，按 [Agent Skills 开放标准](https://code.claude.com/docs/en/skills)组织（SKILL.md）。用户体验两条路，殊途同归：

1. `npx skills add Ericgood/any-to-any` —— 借助 [vercel-labs/skills](https://github.com/vercel-labs/skills)（skills.sh）现成安装器，一条命令装到本机所有 agent；
2. 把 GitHub 链接直接贴给任意 agent 说「装上」—— agent 读仓库里的 SKILL.md / install 说明自助完成安装。

**依据**：SKILL.md 已被 Claude Code / Codex / Cursor / Gemini CLI / Copilot 等采用（[开放标准](https://www.mindstudio.ai/blog/agent-skills-open-standard-claude-openai-google)，[63k+ 生态](https://agentman.ai/blog/claude-skills-vs-agent-skills)）；本机实测 `~/.claude/skills/`、`~/.codex/skills/`（SKILL.md 格式）、跨家共享目录 `~/.agents/skills/`（30 个 skill 在用）全部存在。

**推论（架构简化）**：skill 指引 agent 用 **bash 命令**（`anyd send` / `anyd inbox` / `anyd list`）收发消息。Bash 是比 MCP 更大的公分母——所有 agent 都能跑命令，MVP 零 MCP 配置。MCP 工具面、Channels/app-server 实时注入降级为后续增强，不再是前提。

## ADR-002 跨设备传输：局域网直连自建，不用 Tailscale（2026-08-05，用户拍板）

**决定**：只做同一局域网场景（用户的 MacBook 与 Mac mini 同网）。不引入 Tailscale/任何第三方组网。超远程（跨网络）暂不做。

**方案**：
- **发现**：Bonjour/mDNS（macOS 原生），daemon 广播 `_anytoany._tcp`，同网设备零配置互见；
- **传输**：daemon 间局域网 HTTP 直连；
- **信任**：首次配对短确认码（AirDrop 式），之后持久 token；局域网不等于可信，认证不省。

## ADR-003 项目性质：开源（2026-08-05，用户拍板）

公开仓库、MIT 或 Apache-2.0（待定）。当前 repo 为 private，首个可用版本前转 public。

## ADR-004 技术栈：TypeScript / Node（已生效 2026-08-05）

理由：目标用户（AI coding CLI 使用者）机器必有 node（claude/codex/kimi/gemini 全是 npm/node 系）；`npx` 即装即用与 skills.sh 生态同构；MCP 官方 SDK 是 TS（后续增强用得上）；开发迭代快。Go 单二进制的优势对这个人群不构成差异。

## ADR-005 投递档位：MVP 用 headless resume，实时注入后置（已生效 2026-08-05）

MVP 投递 = 对目标 session 执行一次 headless 续写（`claude -p --resume` / `codex exec resume` / `kimi -p -S`）：可达性 100%、三家通用、离线也能补投。代价：对方正开着的 TUI 界面不即时显示这条消息（session 记录已续写，重新进入可见）。Channels / app-server steer / kimi web 的「正在聊着的窗口里即时弹出」体验作为 Phase 3 升级，通道调研已备齐。

## ADR-006 与 Google A2A 协议的关系：对齐语义、不绑定实现、后置兼容层（已生效 2026-08-05）

**定位**：A2A 管「agent 服务之间」（endpoint + Agent Card + Task 生命周期），Any to Any 管「正在运行的 CLI 会话之间」——A2A 未覆盖、所有主流 coding CLI 零原生支持的形态。互补不竞争。

**决定**：
1. MVP 不依赖 A2A（Task 状态机/Artifact 对「投递+回复」过重，且对端无人说 A2A）；
2. 消息模型字段语义对齐 A2A 命名（contextId / role / parts / thread≈Task），不另造词，成本为零；
3. 路线图挂载：Phase 3+ anyd 暴露 A2A endpoint，为每个本地 session 生成 Agent Card——叙事升级为「第一座把本地 coding session 接入 A2A 网络的桥」。

**注意**：勿与 Zed 的 ACP（Agent Client Protocol，editor↔agent）混淆；IBM ACP 已并入 A2A。

## ADR-007 品牌与域名定案（2026-08-05，用户拍板）

品牌 **anytoany**，tagline **"Session-to-session messaging for AI coding agents"**。域名 **anytoany.dev** 已注册（any2any.dev 建议做 301 跳转）；anytoany.app/.com 已被他人注册，不追。npm 包名 `anytoany`（已验证可用，未发布）、GitHub `Ericgood/any-to-any`、CLI 命令 `anyd`。命名依据：口播零解释成本；三位一体对齐；any2any 拼写在 AI 圈已是「任意模态」术语且 npm 被占；Codex（collaboration/multi-agent）与 Claude（Agent Teams）的命名先例均用关系词而非机制词，故 session-to-session 作 tagline 不作品牌。

## ADR-008 Claude 入站投递三通道分层（2026-08-05）

**背景（实测）**：用户使用 Claude 桌面客户端；CLI `claude -p` 无登录态（客户端与 CLI 凭据不共享，关沙盒复测确认）；客户端会话与 CLI session 同存储（`~/.claude/projects/`）但客户端另有会话注册表（带 isRunning）；客户端第一方工具 `send_message` 可跨 session 投递（消息以「From 某会话」出现在目标会话，带回链），仅会话内 agent 可调、无人值守会话不可用。

**决定**：Claude 侧入站按可用性分层，daemon 逐层降级：
1. **Claude→Claude**：发起方 skill 直接用客户端 send_message 投递（不经 daemon 投递管道，驿站记账保持 Web Console 可见）；
2. **任意→Claude 零依赖档**：驿站 + hook 注入（UserPromptSubmit additionalContext）+ skill 主动查收——无需任何登录设置，被动送达；
3. **任意→Claude 全自动档**：CLI resume 投递，需用户一次性 `claude` 登录解锁；解锁后目标会话即时自动处理回信。`anyd doctor` 检测并提示，绝不设为前置要求。

Codex 侧不分层（exec resume 已全验证）。
