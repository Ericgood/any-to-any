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

## ADR-004 技术栈：TypeScript / Node（建议，待用户确认）

理由：目标用户（AI coding CLI 使用者）机器必有 node（claude/codex/kimi/gemini 全是 npm/node 系）；`npx` 即装即用与 skills.sh 生态同构；MCP 官方 SDK 是 TS（后续增强用得上）；开发迭代快。Go 单二进制的优势对这个人群不构成差异。

## ADR-005 投递档位：MVP 用 headless resume，实时注入后置（建议，待用户确认）

MVP 投递 = 对目标 session 执行一次 headless 续写（`claude -p --resume` / `codex exec resume` / `kimi -p -S`）：可达性 100%、三家通用、离线也能补投。代价：对方正开着的 TUI 界面不即时显示这条消息（session 记录已续写，重新进入可见）。Channels / app-server steer / kimi web 的「正在聊着的窗口里即时弹出」体验作为 Phase 3 升级，通道调研已备齐。
