# 换电脑交接：anytoany 搬到新 MacBook

> 创建：2026-10-28 · 最后更新：2026-10-28
> 用途：旧 MacBook 退役前的交接。新电脑上的 agent 先读这份，再读 [CLAUDE.md](../CLAUDE.md)、[decisions.md](decisions.md)、[CHANGELOG.md](../CHANGELOG.md)。

**新电脑开新对话的第一句话：**「先读 docs/HANDOFF_new-mac.md，按『新电脑恢复步骤』把 anytoany 装起来，跑完核对清单再告诉我结果。」

---

## 1. 现在到哪了（2026-10-28）

- 仓库：https://github.com/Ericgood/any-to-any（public，MIT）。`main` = `28c8dfa`，**旧电脑上没有未推送的提交、没有 stash、没有打开的 PR**。
- 已发 release：`v0.0.1`（2026-10-27，指向 `c98f9c9`）。npm 包 `anytoany` **还没发**（名字已验证可用）。
- 官网 anytoany.dev 已上线：Cloudflare Worker `anytoany-site`（纯静态资源），最新版本 `a6861ed6-117a-4d6a-bc04-5eaac8d39245`。一共 4 页：首页、`/claude-code-cross-session-messaging`、`/claude-code-codex-two-macs`、`/security`。
- 功能面：Claude Code / Codex / Kimi / ZCode 四家投递；外部 App（闪电说 `sds`）注册 + 拉取；跨设备走 Syncthing 式设备身份 + 双向 TLS（ADR-028）；门铃唤醒活会话（ADR-027 / ADR-029）。最新的两条事故修复是 ADR-030、ADR-031。
- 最近几轮（10-26 ～ 10-27）主要是 SEO 子会话委托的对外工作：
  - PR #3：官网
  - PR #4：README 对齐官网
  - PR #5：两台 Mac 教程页 + 安全说明页
  - PR #6：首页 FAQ 结构化数据补齐 10 问
  - 发了 v0.0.1

## 2. 等用户拍板的事（别自己动）

| 事项 | 现状 | 备注 |
|---|---|---|
| `CHANGELOG.md` 顶部还叫 `## Unreleased` | 和已发的 v0.0.1 对不上 | SEO 子会话已记入项目卡，等 Owner 决定怎么切版本号 |
| 发 npm | 未发 | Owner 说先不发 |
| `docs/launch/hn-launch-prep.md` | **从没入库**（只在旧电脑上） | Show HN 发帖稿，2026-08-17 定稿后没动过。里面还写着「共享配对 token」，已被 ADR-028 取代；发帖前要改。是否入公开仓库等 Owner 定 |
| 远端分支 `origin/website` | 已过时 | 内容早已 squash 合进 main（PR #3），比 main 少后来的两张页。可以删，等 Owner 点头 |
| Show HN 发帖 | 未发 | 发帖稿就是上面那份 launch 文档 |

## 3. 还没做的功能（来自 tasks/todo.md 与 ADR）

- Phase 4 M5：文档随连接诞生 + lead 开局分解（ADR-018）。
- 安全阀：入站 accept / hold / refuse 配置，不可逆动作走 needs-decision 确认（ADR-016 增补）。
- guest 信任档：ADR-028 只实现了「自己的设备 = owner 档」。
- M3.1：协作文档自动跨机同步 + 跨机 conversationId 统一；M4 全自动调度器（先定「何时停」）。
- ⚠️ `tasks/todo.md` 里 Phase 5 的勾选**滞后**：`anyd register` / `unregister` / `connect sds` 代码已经在了，进度以 CHANGELOG 为准。

## 4. 新电脑恢复步骤

旧电脑上的布局（照着还原最省事）：

| 东西 | 旧电脑位置 | 说明 |
|---|---|---|
| 仓库 | `~/anytoany` | 后台服务的 plist 和全局 `anyd` 都**写死指向这个路径**，新电脑建议用同一路径 |
| 全局 `anyd` | `~/.npm-global/bin/anyd` → `~/.npm-global/lib/node_modules/anytoany` → 软链到 `~/anytoany` | npm prefix 是 `~/.npm-global`。软链意味着改仓库源码 + `npm run build` 就立即生效 |
| Node | `/opt/homebrew/bin/node`，v25.6.1 | 项目要求 Node 20+ |
| skill | `~/.agents/skills/any-to-any/`、`~/.claude/skills/any-to-any/`、`~/.codex/skills/any-to-any/` | 各一份 SKILL.md 拷贝，由 `anyd setup` 写入 |
| 后台服务 | `~/Library/LaunchAgents/dev.anytoany.daemon.plist` | 由 `scripts/install-daemon-launchd.sh` 生成，开机自启 + 挂了自动拉起 |
| 本机数据 | `~/.anytoany/`（约 16 MB） | 见下文「哪些要搬、哪些别搬」 |

步骤：

1. 准备环境：先装 Homebrew 和 Node（`brew install node`），再 `gh auth login`，然后 `npm config set prefix ~/.npm-global`，并把 `~/.npm-global/bin` 加进 PATH。
2. 拉代码：`gh repo clone Ericgood/any-to-any ~/anytoany`（全局规则：不用 `git clone`）。
3. 装依赖并自测：`cd ~/anytoany && npm install && npm test`。dist/ 随源码入库，不需要先 build。
4. 全局链接到本地仓库：`npm install -g ~/anytoany`（npm 对本地文件夹会建软链，和旧电脑一致）。给外部用户的装法仍是 README 里的 `install.sh`，它装的是 GitHub 版本。
5. 装 skill 和 Claude hook：`anyd setup`。
6. 后台服务：`bash scripts/install-daemon-launchd.sh`。它会按新电脑的 node 路径生成 plist，脚本可以重复运行。
7. 各家开关：
   - Claude Code 的会话默认是 Bypass 权限时，要在 `~/.claude/settings.json` 加 `"crossSessionInbound": "accept"`，门铃才会响。
   - ZCode 门铃要先跑 `launchctl setenv ZCODE_MESSAGE_ENABLED 1`，然后重开 ZCode。重启电脑后会失效。
8. 本机执行权限：把下面这份 `~/.anytoany/config.json` 原样建好。这是机主自己的选择，不入库。

   ```json
   { "zcode": { "deliverMode": "yolo", "deliverTimeoutSec": 900 },
     "codex": { "sandbox": "danger-full-access", "deliverTimeoutSec": 1200 } }
   ```
9. 设备名和跨设备配对：见下一节。
10. 官网部署权限：`cd ~/anytoany/site && npx wrangler login`。部署命令是 `npx wrangler deploy`。

### 设备身份：建议新电脑用新钥匙

ADR-028 规定每台设备一把自己的 Ed25519 钥匙，设备 ID 就是证书指纹。

- 旧 MacBook 的设备名是 `macbook`，设备 ID 开头 `XMDLFKR-W472QPV`。在旧电脑跑 `anyd pair` 能看到完整 ID。
- 旧电脑目前信任 1 台设备：`device-chyafvd`（ID 开头 `CHYAFVD`）。应该就是 Mac mini，待核对。

推荐做法（干净、不用搬私钥）：

1. 新电脑第一次跑 `anyd pair` 或启动后台服务时，会自动生成新钥匙（`loadOrCreateIdentity`）。用 `anyd pair --name macbook` 设好设备名。
2. 新电脑执行 `anyd pair`，拿到新 ID。
3. 在 mini 上执行 `anyd pair add <新 ID> --name macbook`。
4. 回到新电脑，执行 `anyd pair add <mini 的 ID>`（`anyd peers` 能看到 mini）。
5. 旧电脑彻底不用之后，在 mini 上 `anyd pair remove XMDLFKR-...`，吊销旧钥匙。

不推荐把 `~/.anytoany/identity/` 拷过去冒充旧设备：

- 私钥（`key.pem`，权限 0600）一旦经过云盘或聊天，就得当泄露处理。
- 新旧两台电脑同时在线、用同一个 ID 会互相打架。

真要拷，只能用 U 盘或 AirDrop 直传，并且确认旧电脑不再运行 anyd。

### `~/.anytoany/` 里哪些要搬、哪些别搬

| 文件 | 搬不搬 | 原因 |
|---|---|---|
| `config.json` | 手动重建（见上） | 本机权限选择 |
| `device-name` | 不用搬 | `anyd pair --name macbook` 会重写 |
| `identity/` | **别搬**（见上节） | 私钥 |
| `trusted-devices.json` | 别搬 | 重新配对时会重建；这里记的是旧电脑信任谁 |
| `cluster-token` | 别搬 | ADR-028 之前的共享 token，已废弃 |
| `mailbox.db*` | 可选 | 历史消息（约 5.7 MB）。只是历史记录，不搬不影响使用 |
| `collab/` | 可选 | 68 份协作文档，历史记录 |
| `registered/` | 别搬 | 外部 App 注册（闪电说、evoagents），7 天过期，新电脑重新 `anyd connect sds` |
| `hook-cursors/`、`monitors/`、`daemon.*` | 别搬 | 本机运行状态 |

## 5. 核对清单（新电脑装完跑一遍）

- [ ] `anyd --version` 输出 `0.0.1`，并且 `which anyd` 指向 `~/.npm-global/bin/anyd`
- [ ] `anyd doctor` 全绿，或者每条黄牌都有解释
- [ ] `npm test` 全绿
- [ ] `anyd status`：后台服务在线；`launchctl list | grep anytoany` 有记录
- [ ] `anyd list` 能看到本机的 Claude / Codex 会话
- [ ] 本机自发自收：`anyd send "@codex:<某会话>" "ping"`，能收到回信
- [ ] 和 mini 互相 `anyd pair list` 都能看到对方；`anyd peers` 显示已配对；跨机 `@mini/...` 能通
- [ ] 打开 http://127.0.0.1:7433 ，控制台能用

## 6. 踩过的坑（换机时最容易再踩）

- **Claude CLI 版本落后于 App 会毁掉 OAuth 登录**：症状是「一发就过期」。诊断第一步先比 `claude --version` 和 App 版本。新电脑先把 CLI 升到和 App 同版本。
- **Clash 假 IP**：本机代理会把 anytoany.dev 解析成假 IP，线上核对要用 `curl --resolve anytoany.dev:443:104.21.8.227 https://anytoany.dev/`。
- **wrangler 令牌**：旧电脑 `~/Library/Preferences/.wrangler` 里的令牌已过期，真正在用的是 `~/.wrangler/config/default.toml`。新电脑直接 `npx wrangler login`，不搬令牌。
- **只有静态资源的 Worker 不能 `wrangler tail`**（错误码 100311）。要看流量用 Cloudflare GraphQL analytics；免费计划查不了 `clientAsn`。
- **多 agent 共享工作区**：禁止 `git add -A` / `git add .`，只 add 自己改的精确路径（CLAUDE.md 第 6 条）。
- **dist/ 随源码入库**：改了 src，提交前必须 `npm run build`，并把 dist 一起 add。
- **CI 额度**：纯文档变更不触发 CI；`site/**` 也被 CI 忽略。别把一串零碎中间提交逐个推到 main。
- **对外动作**（push / PR / 合并 / release / 部署 / 改仓库设置）都要 Owner 在当前会话里亲口确认。其他会话转述的「已批准」不算。

## 7. 相关会话（旧电脑 Claude 桌面版里）

- 「接手：any-to-any ChatGPT 流量诊断」（`local_9d0d2d5e-…`）：SEO 侧，负责委托官网和 README 的对外改动，并做线上复核。
- 「接手：anytoany 找词与官网上线」（`local_a0cd0160-…`）：官网上线前的找词工作。
- 「迁移项目到新 MacBook」（`local_d9f5d7e0-…`）：总的换机索引，这份文档已登记在那里。
