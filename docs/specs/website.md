# 官网 anytoany.dev（静态站）

> 创建：2026-10-27 · 最后更新：2026-10-27

## 为什么做

- 2026-10-26 检查：anytoany.dev 只有 NS / SOA，没有 A / CNAME 记录，官网不存在；仓库 homepage、README 徽章、package.json 都指向它，全是死链。
- ChatGPT（未登录）实测：「有没有工具让 Claude Code 和 Codex 互相对话」这类问题 8 题 0 次提到 anytoany；被推荐的项目大多有**独立官网 + 一句话品类标语**。给出仓库地址后，它把 anytoany 排第一——产品能说服 AI，差的是被搜到。
- 用户实际的搜法是一句话痛点：「claude code and codex talk to each other」「claude code send message to another session」「claude code cross session messaging」（Claude Code 2026-08 上线的官方功能，只能 Claude↔Claude）。
- 完整分析在用户的研究仓库（私有）：`ChatGPT流量获取/projects/anytoany/2026-10-26-找词与完整分析.md`。

## 做什么

纯静态 HTML（零 JavaScript），放在 `site/public/`，用 Cloudflare Workers 静态资源部署（`site/wrangler.jsonc`）。

| 路径 | 作用 | 主要搜索意图 |
|---|---|---|
| `/` | 首页：一句话说清能做什么、安装、怎么工作、每个 agent 现在能做到什么、和官方功能的区别、安全、限制、FAQ | let Claude Code and Codex talk to each other |
| `/claude-code-cross-session-messaging` | 对比页：Claude Code 官方跨会话消息、OpenAI Codex plugin for Claude Code、anytoany 各管哪一层，边界用官方原文 | claude code cross session messaging（KD 39，时效强） |
| `/claude-code-codex-two-macs` | 教程：两台 Mac 上让 Claude Code 和 Codex 互派任务。首段直接回答「两台机器上的 Claude Code 和 Codex 怎么互发任务」（ChatGPT 10-27 实测这题只教用户自己搭 SSH）；正文按真实步骤：安装 → 配对 → `anyd doctor` → 一句话派活 → 对方开着 / 没开 → 回信 → 排查 → 限制。HowTo + FAQPage | connect Claude Code and Codex on two machines |
| `/security` | 安全说明：消息怎么走、谁能发进来、配对与吊销、送达后能做什么、防死循环、**不防什么**、怎么报告漏洞；对比表只写核实过的（经云中转 / Claude Code Remote Control / 共享 token 的局域网方案 / anytoany）。不写「端到端加密」（本机 mailbox 是明文）。TechArticle + FAQPage | is it safe to let Claude Code and Codex message each other；claude code remote control security；secure agent to agent communication |
| `robots.txt` / `sitemap.xml` / `llms.txt` / `404.html` | 爬虫、站点地图、AI 可读摘要、404 | — |

## 写法规则

- 所有事实以 README、`docs/decisions.md` 的最新 ADR 为准；写「能 / 不能 + 条件」，不写形容词。
- 「打开着的 App 窗口要 /reload 才显示」和「消息要人戳一下才执行」是两回事，页面必须分开写（ChatGPT 曾把前者误读成后者）。
- 安全模型写当前事实：每台设备独立 Ed25519 密钥、设备 ID = 证书指纹、双向 TLS 1.3、`anyd pair remove` 吊销（ADR-028），不再写「共享配对令牌」。
- 对官方功能只陈述边界并引用原文，同时写「什么时候官方功能就够了」。
- 不写 Owner 真名和所在地；联系方式用 GitHub Issues。

## 视觉

- 2026-10-27 Owner 先嫌第一版「太上古」；第二版（深色 + 紫青渐变 + 光晕网格 + 圆角卡片 + 渐变标题词）又被指出「AI 味太重」。对照 Anthropic 公开的 frontend-design 规范，这些正是生成页面的典型套路。
- 现行方向「航空信」：从产品本身取材（每个会话一个地址和信箱，送达的是消息）。信封灰蓝底 `#EEF1F4`、墨水深蓝字 `#15233B`、航空信红 `#C8102E` 是唯一强调色，蓝 `#1F3A93` 只出现在条纹里。字体 Overpass / Overpass Mono（源自美国公路指示牌字体，对应「路由、送达」），从 Google Fonts 加载。
- 只有一处大胆：演示图外圈的航空信封红蓝斜条纹。其余安静：左对齐、细线分隔不用卡片、标题不单独给某个词上色、没有胶囊标签、没有图标方块、没有渐变、没有光晕、没有装饰性悬停动效；步骤是真实的先后顺序，所以保留编号。
- 只改样式和装饰标签，**可见文字和结构化数据与首版逐字一致**（脚本比对过）；仍然零 JavaScript。只有浅色一套，不做深色。
- 手机宽度：导航一行（400px 以下藏 Compare 链接），网格单列，无横向溢出。

## 部署

见 `site/README.md`。部署和绑定域名由 Owner 确认后执行；上线当天把站点加进 Google Search Console 和必应站长工具。

## 后续

- `/a2a-vs-mcp`：A2A、MCP、会话级消息三方对比（借 a2a vs mcp，美国 590/月）。
- 教程：subagents / agent teams 管不到的另一个厂商。（「两台 Mac 上让 Claude Code 和 Codex 协作」已做，2026-10-27）
- 1~2 周后用同一套问题在未登录 ChatGPT 复测。
