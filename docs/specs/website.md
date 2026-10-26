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
| `robots.txt` / `sitemap.xml` / `llms.txt` / `404.html` | 爬虫、站点地图、AI 可读摘要、404 | — |

## 写法规则

- 所有事实以 README、`docs/decisions.md` 的最新 ADR 为准；写「能 / 不能 + 条件」，不写形容词。
- 「打开着的 App 窗口要 /reload 才显示」和「消息要人戳一下才执行」是两回事，页面必须分开写（ChatGPT 曾把前者误读成后者）。
- 安全模型写当前事实：每台设备独立 Ed25519 密钥、设备 ID = 证书指纹、双向 TLS 1.3、`anyd pair remove` 吊销（ADR-028），不再写「共享配对令牌」。
- 对官方功能只陈述边界并引用原文，同时写「什么时候官方功能就够了」。
- 不写 Owner 真名和所在地；联系方式用 GitHub Issues。

## 视觉

- 2026-10-27 Owner 嫌第一版「太上古」，改成深色为主的开发者工具风（跟随系统也有浅色版）：渐变强调色（紫 → 青）、首屏网格 + 光晕背景、演示图放进窗口框、功能和安全用卡片网格、安装命令做成终端窗口、步骤做成时间线、表格圆角卡片并高亮 anytoany 列、FAQ 手风琴。
- 只改样式和装饰标签（Logo、窗口框、图标、高亮类名），**可见文字和结构化数据不变**；仍然零 JavaScript、不加载外部字体。
- 手机宽度：导航保持一行（420px 以下藏 Compare 链接，正文里有对比章节），卡片单列，无横向溢出。

## 部署

见 `site/README.md`。部署和绑定域名由 Owner 确认后执行；上线当天把站点加进 Google Search Console 和必应站长工具。

## 后续

- `/a2a-vs-mcp`：A2A、MCP、会话级消息三方对比（借 a2a vs mcp，美国 590/月）。
- 教程：两台 Mac 上让 Claude Code 和 Codex 协作；subagents / agent teams 管不到的另一个厂商。
- 1~2 周后用同一套问题在未登录 ChatGPT 复测。
