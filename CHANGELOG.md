# Changelog

所有重大变更记录于此，新条目在上。格式：`## YYYY-MM-DD — 标题` + 要点。

## 2026-08-06 — 🎉 跨设备双机链路端到端全通（MacBook ↔ Mac mini，含 ZCode）

- **P2 跨设备目标真机达成**：MacBook `@macbook` ↔ Mac mini `@mini` 配对（同 token fp）、mDNS 互发现、目录聚合（本机 4045 + mini 38 会话）、跨机投递与回信回流全链路实测通过——探针消息 MacBook → mini 的 ZCode「sunogate开发」会话，ZCode 真实执行并回报正确工作目录，回信跨机回流 MacBook 驿站
- **ZCode auth 打通**：CLI OAuth 服务端未上线（全路径探测 404，最新引擎同），定案走 Coding Plan API key（官方文档背书：key 为 ZCode 官方连接方式、与 App 同订阅配额池、`api.z.ai/api/anthropic` 端点）；`~/.zcode/cli/config.json` 结构自反编译确认并双机配置，本机 headless PONG 冒烟 + 真实投递均通过
- **分发定案：dist 构建产物随仓库入库，git 安装零编译**——mini 真机连踩两坑（npm git-dep 构建环境 `tsc not found`；`npx -y tsc` 误拉 npm 上同名废包）后拍板；prepare 改为 dist 缺失才构建；CLAUDE.md 增约定「改 src 提交前必须 build 并连 dist 一起提交」
- mini 部署模式验证：任务说明贴给 mini 的 Codex，由对端 agent 自主安装+验收——「贴给任何 agent 就能装」的分发理念首次真机闭环
- peer 目录按 host:port 去重（设备改名/幽灵广播不再让同一台机器聚合两次）；虚拟 user 收件人的回信直接标记 delivered（驿站即收件箱，console 不再误报红色 failed）
- @any 跨机物化生效：`any-mini-zcode-sunogate` 等 mini 会话自动出现在 MacBook 的 Claude `@` 补全

## 2026-08-06 — ZCode adapter（第四家：智谱 Z.ai）+ mDNS 稳定性根治

- **新 adapter：ZCode**（智谱 Z.ai 桌面 ADE，用户称 Z code）——发现读 `~/.zcode/cli/db/db.sqlite`（readonly，App/CLI 同库同 id，三种子代理形态过滤），投递用 App 内置引擎 `zcode.cjs --resume sess_xxx --mode build --prompt`（显式非 yolo，安全底线）；mini 侧零新安装。调研+实测报告见 docs/research/research-zcode.md（含 0.15.2 引擎七条勘误：--max-turns/--settings 未实装、login 端点已 404、ZCODE_MODEL 可用、runtime 不接 shared credentials 等）
- 投递 auth 待用户侧一次性动作：升级 ZCode App 跑 `zcode login`，或 Z.ai 控制台取 API key 手配 cli/config.json（结构已反编译确认，文档附模板）
- webui 品牌库 +1：ZCode 官方黑底 Z 图标（App icon 提取），26 家
- **mDNS 再修两刀（首连排障续）**：publish 加 `probe: false`——同名幽灵记录（异常死亡 daemon 未发 goodbye）会让名字探测抛不可捕获异常炸掉进程，直接宣告接管即可；browser 加 30s 周期 re-query——初始 query 会被静默丢失且永不重发，daemon 此前只能「偷听」他机触发的响应（实测 35s 内自主稳定发现 mini）
- `anyd stop` 加 pgrep 兜底：pid 文件丢失时按进程名找回 daemon
- **破案**：三次「pid 文件失踪 → stop 失明」的真凶是 setup.test.ts 里一段直打真实 `~/.anytoany/` 的 pidfile 测试——每跑一次 vitest 就覆盖+删除线上 daemon 的 pid 文件。已删（由隔离 home 的 pidfile.test.ts 替代），教训入 tasks/lessons.md
- 冒烟坦白：验证 `ZCODE_DATA_BASE_DIR` 隔离时看错信号（目录创建 ≠ db 隔离），2 条空 smoke 会话进入用户真实 ZCode 会话列表（标题 `[anytoany] adapter smoke test`，App 内可删）

## 2026-08-06 — 局域网首连排障：mDNS 双实例修复 + 设备身份固化

- 修复 `startPeerRegistry` 同一 Bonjour 实例先 publish 后 find 导致 browser 查询失效的问题（daemon 只能「偷听」他机触发的响应，无法自主发现 peer）——publisher 与 finder 拆为独立实例，A/B 对照实验实证
- 新增 `pickLanAddress` 地址优选：优先 RFC1918 私网段，排除代理 TUN 假地址（198.18.0.0/15）、link-local、loopback——此前「取第一个 IPv4」在开代理的机器上会把 relay 路由进黑洞
- 设备名首次派生即落盘（`~/.anytoany/device-name`）：macOS hostname 会因局域网重名自动加后缀漂移，而设备名是跨机路由身份，漂移即断路（实测同机漂出三个名字）
- `anyd peers` 重写：优先查询运行中 daemon 的权威 peer 表（新增 loopback 端点 `GET /api/peers`，含配对状态与自身指纹），daemon 不在时降级为只浏览不发布的被动扫描（修复 port 0 发布崩溃）
- pid 文件归属校验：exit 清理只删自己写入的记录；`anyd start` 绑定端口前先探测占用——此前因端口冲突死亡的 starter 会覆盖并删除正主 daemon 的 pid 文件，导致 `anyd stop` 失明
- 全部 TDD：净增 13 个测试，124/124 通过

## 2026-08-05 — ADR-013 修订：实时通道双模（共享 app-server 为主，tmux 为兜底）

- 子代理调研报告完整落盘（research-codex-live-inject.md，26+ 来源）：发现协议级正路——`codex app-server --listen` 共享 daemon + 官方参数 `codex --remote` 挂载 TUI + 外部 turn/start/steer（kcosr/codex-threads 已验证此架构）
- 实锤 tmux 流派坑：#4446 流式输出期间注入会被忽略而非排队——tmux 降为兜底通道，必须忙碌检测
- 安全红线：app-server socket 仅 UDS/loopback（Origin 实测 0.0.0.0 未鉴权可连入执行命令）
- Desktop App 确凿无解（single-writer + #25914），维持 resume+通知+hook 摘要组合，跟踪官方 issue

## 2026-08-05 — tmux 实时通道定案（ADR-013）：官方无注入计划，tmux 注入实证成功

- 调研落盘（research-codex-live-inject.md）：官方 `codex inject` 提案 closed not planned；社区请愿 Channels 等价物无承诺——短期无官方通道
- R7 实证：tmux 中的 Codex TUI 经 send-keys 注入 = 实时 + 对话流原生可见 + 完整交互环境（连带解决 ADR-010 headless 无环境问题）；TUI 原生 steer 排队兜底忙碌场景
- ADR-013：新增 tmux 投递通道（anyd tmux 启动器 + 映射表零猜测关联 + bracketed paste 防多行提前提交），优先级高于 resume；实现进行中
- 文档卫生：合并 decisions.md 中三条重复 ADR-012，删除已被证伪的幻觉"实证"表述；滞留 delivering 消息手动落账

## 2026-08-05 — 上下文对称可见性（ADR-012）+ @any 寻址层（Phase 2.5）

- **双端收件 hook**：统一 processPromptHook 服务 Claude 与 Codex（查证 Codex UserPromptSubmit 同构支持），setup 同时注册两家配置；pending 完整注入 + 已处理往返的 FYI 知情摘要（游标防重复、明示勿再响应）——headless 协同活动在两家 App 对话流中可见；Codex 会话经驿站实证「hook 消息已在 App 对话流可见」
- 探测结论存档：Codex Desktop 内嵌内核无官方注入通道（app-server 122 方法 schema 已导出，daemon-hosted 场景留 P3）
- **@any 寻址层**：daemon 自动把活跃对端会话物化为 ~/.claude/agents/any-* 投递代理（预绑定精确 id、用户补全选中即确认、幂等增删不碰用户文件）——Claude 输入框打 @any 即见候选；docs/specs/phase2.5-at-mention.md
- mailbox 新增 recentActivity；107 测试全绿

## 2026-08-05 — 品牌视觉库扩至 25 家主流 coding agent（用户任务）

- 官方矢量（simple-icons/Wikimedia，品牌色填充）：Claude / Codex(OpenAI 花环) / Kimi / Gemini / Cursor / Windsurf / Cline / Warp / Qwen / JetBrains / Copilot / OpenCode / Trae(字节) / iMessage / Ollama
- 品牌位图（GitHub 官方头像/官网 favicon，data URI 内嵌）：OpenClaw / Aider / Zed / Goose(Block) / Roo Code / Grok(xAI) / Devin / Qoder(阿里) / CodeBuddy(腾讯) / Kiro(AWS)
- avatar 三级渲染：官方矢量 → 品牌位图 → 字母色块兜底；全部内嵌零外链，页面仍为 64KB 单文件
- 修正认知：用户所指 Q Code 为阿里 Qoder（非 Amazon Q）；WorkBuddy 即腾讯 CodeBuddy

## 2026-08-05 — 官方品牌 logo 头像

- 头像从字母色块升级为官方 logo 内嵌 SVG：Claude 星芒 / OpenAI 花环（Codex）/ Kimi / Gemini（来源：simple-icons + Wikimedia Commons 官方 symbol；零外链，全部内嵌）
- 未收录品牌自动回退字母色块（OpenAI 系已被 simple-icons 应商标政策移除，花环取自 Commons 官方 2025 symbol）；README 增补商标归属注脚
- 备用 logo 已入库（OpenCode/Copilot/Ollama/Moonshot），未来 adapter 接入即配

## 2026-08-05 — Web Console 升级为主观察界面：飞书式消息流（用户拍板）

- 调研定案：Codex 官方注入 issue 全部 closed as not planned，Desktop App 无第三方通道；终端系方案（tmux 注入/共享 daemon+--remote）被用户否决——Web Console 正式成为协作主观察面
- 时间线重构：飞书/Slack 式单列消息流——色块头像（C/X/K/G）+ 发送者名称 + 精确时间戳（HH:MM）+ 状态尾注 + 跨天分隔线；废除微信式左右气泡（第三方观察者视角无「我」）
- 新增调研报告 docs/research/research-codex-live-inject.md（可行路径排序与跟踪 issue 清单）

## 2026-08-05 — 可见性闭环收尾：重开可见实证 + macOS 系统通知

- 用户实验确认：Codex App 重开会话完整渲染 headless 追加的往返轮次（用户层可见 = 重开可见，非实时；App 运行中不热载）
- 新增系统通知：daemon 投递成功即弹 macOS 通知提醒「重开该会话可见」（每会话 60s 节流，--no-notify 可关）
- 教训入档：agent 对自身不可观测事物的断言不作数（Codex 幻觉 DONE 事件）；信封防幻觉条款上线
- 110 测试全绿

## 2026-08-05 — @any 寻址层 + 双端可见性（ADR-012，用户核心诉求驱动）

- **@any 寻址层（Phase 2.5）**：daemon 自动把活跃对端会话物化为 `any-` 前缀的 agent 定义（~/.claude/agents/），进入 Claude Code 的 @ 补全列表——用户打 @any 即见候选、选中即确认（预绑定精确 id 零误投）；随目录自动增删、绝不触碰用户自有 agents；首批 10 个已生成并热加载实证
- **双端收件 hook（上下文对称可见性）**：查证 Codex 支持 UserPromptSubmit+additionalContext（与 Claude 同构）；统一 hook 处理器两层注入——pending 完整注入取件 + 已处理往返的活动摘要（FYI 防重复处理、游标去重）；setup 同时注册双端 hook；实测 Codex App 会话摘要注入成功
- 探测记录：Codex Desktop 内嵌内核无官方注入通道（app-server proxy 需独立 daemon；实时档留待官方开口，P3 跟踪）
- 107 测试全绿

## 2026-08-05 — 信封协议 v2：强制表态（ADR-011，实战事故驱动）

- 事故：Codex headless 回合对任务仅「确认收到」即结束（不执行不回信），需用户人肉追问才开工——根因：回合一次性无「稍后」、反空转规则被泛化、协议无任务表态
- 信封 v2：明示「唯一回合」，强制 DONE/BLOCKED/DECLINED 三态收尾，确认式回复无效，协议表态豁免反空转约定；skill 同步接收规范并重新分发
- 任务生命周期（参照 Codex multi-agent wait/followup/interrupt 与 A2A Task）列入 P3；100 测试全绿

## 2026-08-05 — ADR-010：消息可达 ≠ 执行环境可达（实战边界发现）

- 用户真实工作流四轮自动往返全部按设计运转（每分钟一轮），但暴露 headless 回合缺目标会话的凭据/环境/网络——接收方正确回报缺失并停止
- 结论：resume 通道适合知识问答与落盘接力；重活的根本解是 P3 实时注入交互会话（本案例为最强立项论证）

## 2026-08-05 — 修复：Codex 子代理线程混入可寻址目录（用户实投失败反馈）

- 根因：用户从选择器选中的 codex 会话实为 multi-agent v2 的 sub-agent 线程，Codex 官方拒绝对其直接注入（app-server -32600 "direct input is not allowed for sub-agents"）
- 修复：scanner 依据 session_meta 的 `thread_source=subagent` / `parent_thread_id` 过滤全部子代理线程（不可寻址即不出现）；fixture + 用例防回归
- 附带修复：deliver 错误日志曾截取 stderr 前 500 字符（全是 banner），真错误在尾部被吃——改取尾部 500 字符
- 99 测试全绿

## 2026-08-05 — 修复会话选择器三连问题（用户 MacBook 实测反馈）

- 根因修复：codex session_index 的 updated_at 可陈旧数周（桌面 App 使用会话不更新 index），scanner 曾单信 index 导致活跃会话被排序沉底——改为取 index 时间与 rollout mtime 的较大者（实证：「闪电说IOS 开发」从三周前位置回到 24 分钟前）
- Web Console「新建对话」下拉换为搜索式选择器：关键词过滤（标题/agent/目录/设备/id）、按活跃降序、显示目录与相对时间、限 30 条
- daemon 目录聚合（本地+远端）后统一按活跃排序；98 测试全绿

## 2026-08-05 — 定位口径定稿（ADR-009）

- 定义与比喻分层：正式定义 agent-native messaging layer；海外传播比喻 "Slack for AI agents"、中文语境可用微信类比；README 双版 hero 加斜体类比行
- imforagent.com 定为传播域名（301 到主站），主品牌 anytoany 三位一体不变

## 2026-08-05 — 一键安装与 README 第一屏引导（OpenClaw 式）

- 新增 install.sh：`curl … | bash` 一条命令 = 安装（git 直装 + prepare 自动构建）+ anyd setup 全配置；支持 `--join <token> --name <device>` 参数
- 新增 `anyd pair --invite`：直接打印「贴到另一台设备终端（或贴给那边的 agent）」的完整命令（安装器+token），跨设备对齐一步到位
- README（英/中）重排：Install / Link a second device / Send your first message 三节前置到第一屏；旧安装内容折叠为 manual setup
- 修复 badge 渲染事故：img alt 含 `>` 被 GitHub HTML 解析截断致溢出裸文本（用户截图报告）

## 2026-08-05 — 开源标准化：英文主体 README + 完整社区脚手架

- README 重写为英文主体（badges/架构图/安全模型/路线图/agent 支持矩阵），新增 README.zh-CN.md 中文版互链
- 新增开源标配：CONTRIBUTING.md（含多 agent 共享工作区家规与 adapter 开发指南）、SECURITY.md（私密漏洞报告 + 设计不变量）、CODE_OF_CONDUCT.md、GitHub Actions CI（macOS/Ubuntu × Node 20/22）、issue/PR 模板
- package.json 补 keywords/author/bugs；GitHub repo 补 description/homepage/topics

## 2026-08-05 — Phase 2 完成：局域网跨设备互通（LAN SMOKE PASS）

- 全链路实证（单机双 daemon 模拟 alpha/beta 双设备）：alpha 驿站 → token 校验 relay → beta 驿站 → beta 本地投递真实 Codex 会话 → LAN_ACK 回信 → relay 回 alpha → **经 Claude resume 注入真实发起会话**（用户登录后全自动档跨设备同场实证）
- 能力清单：`@设备/agent:会话` 三段寻址；mDNS 自动发现（`_anytoany._tcp`）+ 共享 token 配对（`anyd pair --show/--set/--name`，不同 token 401 隔离）；daemon 间 HTTP 直连 relay（视角翻转，context 跨机保线程）；目录聚合（`anyd list` 显示远端设备前缀）；`/api/send` 目标解析端点 + CLI send 委托 daemon；ANYTOANY_HOME 实例隔离；recoverStale 崩溃恢复（delivering 滞留重入队）
- 安全分层：本地控制台端点严格 loopback-only（非环回 403）；仅 /api/peer/* 对局域网开放且强制 token
- Web Console 与 skill 同步支持 device 标注与 @device/ 语法；97 测试全绿
- Mac mini 真双机验收待用户执行（README「跨设备」三条命令）

## 2026-08-05 — 澄清 3f2abaa 提交范围 + 多 agent 工作区纪律入规范

- 澄清：commit 3f2abaa 除 skill 反空转规则外，还意外包含了另一 agent 进行中的 Phase 2 局域网代码（docs/specs/phase2-lan.md、src/cluster/、device 字段改造、cluster 测试）——系 `git add -A` 裹挟所致；main 测试全绿（90 个），内容自洽故不回退
- 规范新增（CLAUDE.md 第 6 条）：多 agent 共享工作区纪律——精确路径提交，禁用 git add -A；教训入 tasks/lessons.md

## 2026-08-05 — 治理 agent 空转客套（skill 反空转规则）

- 实测暴露新模式：r2c 会话反复发「确认/状态同步」类零增量新消息，每条开新 context，绕过按线程计数的回环保护
- SKILL.md 新增 Anti-chatter 规则：仅在有新信息/问题/请求时发送；线程目标达成即停止；不回复是合法响应（已重新分发到三个 skill 目录）
- conversation 级速率限制记入 P2 加固待办；Claude 端以连续两轮不回复实施断链

## 2026-08-05 — 验收现场：全自动闭环实证 + 双注入竞争修复

- 用户完成一次性 claude CLI 登录 → 全自动档实证：Codex 确认消息由 `claude -p --resume` 直接唤醒 Claude 会话处理（本条目所在回合即该投递）；彩蛋 thread 三条消息全 delivered，Claude↔Codex 双向全自动闭环完成
- hook 活体演示成功：用户说话瞬间 UserPromptSubmit 注入 Codex 消息，Claude 当场回执
- 修复双注入竞争：hook 取件曾连 dispatcher 投递中（delivering）的消息一并抢走，致同一消息 resume+hook 双注入；inbox 增 pendingOnly，hook 只取 strictly-pending（82 测试全绿）

## 2026-08-05 — Phase 2 核心完成：局域网跨设备互通（单机双 daemon 全链路实证）

- device 寻址全线贯通：`@设备/agent:片段` 三段式解析、SessionRef/驿站/conversations 均带 device（SQLite 幂等迁移）
- 对等互联：mDNS 广播发现（bonjour-service）+ 静态 peer 注入（--peer，启动时查 /api/peer/info 取真名）；配对 = 共享 token（`anyd pair --show/--set/--name`，指纹进 TXT）
- 安全分层：server 绑 0.0.0.0 后，非 /api/peer/* 路由强制 loopback-only；peer 路由强制 X-Anytoany-Token（401 拒绝）
- relay 路由：dispatcher 按 to.device 分流——本机走 adapter，远端 POST 交给对方 daemon（视角翻转，contextId 保线程，回信反向路由）
- CLI send 委托 daemon（/api/send，聚合目录才能解析远端目标），daemon 离线降级本地解析；`ANYTOANY_HOME` 隔离实例数据
- **单机双 daemon 冒烟实证全链路**：alpha 聚合 beta 的 4167 个远端 session → @beta/codex 投递 relay 成功 → beta 本地投递真实 Codex 会话 → LAN_ACK 回信反向 relay 回 alpha → alpha 用 Claude resume 把回信真实注入发起方会话（Claude 全自动档登录后首战，实际送达）
- 冒烟暴露并修复崩溃恢复缺口：daemon 死在投递中会让消息悬挂 delivering 永不重试——启动时 recoverStale() 重置进重试通道（at-least-once）
- 测试 97 个全绿；真双机验收待用户在 Mac mini 上执行（README 已有三条命令指引）

## 2026-08-05 — M4+M5+M6 完成：Phase 1 全线落地，等待用户验收

- **M4 双向回路**：SKILL.md（Agent Skills 标准，装入 ~/.claude、~/.codex、~/.agents 三目录并被本会话热加载实证）；Claude 收件 hook（UserPromptSubmit 注入，anyd setup 一键注册、幂等、带备份）；冒烟 SMOKE PASS——Codex↔Codex 双向往返 3 条消息全部 delivered，对方按软约束主动终止连锁
- **M5 Web Console**：daemon 集成 HTTP+SSE 服务（127.0.0.1:7433，零依赖 node:http）；IM 双栏界面（对话列表/左右气泡/投递状态/失败重试/新建对话/身份切换代发）浏览器实测通过；技术选型修订：零构建单文件 HTML 取代 Vite+React（理由：npm 包零构建链、CSP 友好、~400 行可控）
- **M6 收尾**：anyd doctor（8 项自检全 ✓）/ setup / status / stop / flush；README 快速开始；LICENSE (MIT)；npm link 全局可用
- 冒烟带出的真实修复：exec 层改 spawn+stdin ignore（claude CLI stdin 警告）；uuid v7 同秒前缀撞车实证歧义候选机制；回环保护实战拦截 5 连锁（首轮冒烟）
- 测试 81 个全绿，覆盖率 行 92.7% / 分支 80% / 函数 98.4%（达标 ≥80%）
- 遗留待用户：验收现场触发 hook 活体演示（驿站已留 1 条 pending 消息）；可选一次性 claude CLI 登录解锁全自动档；repo 转 public 与 npm publish 待用户过目后执行

## 2026-08-05 — M3 完成：投递引擎全链路真实跑通

- dispatcher（claim→目录定位→信封→adapter 投递→状态回写→stdout 回复自动入站）+ claude/codex 两家 deliver（argv 直传无 shell 注入面）+ 失败退避 30s——累计 62 测试全绿
- R3 定案：REPLY 标记方案（对方在输出末尾 `<<<ANYTOANY_REPLY>>>` 回复，daemon 解析代为入站）——零权限依赖，headless 沙盒不需写驿站
- **真机里程碑：首次跨厂商 agent 对话闭环 3/4 步**——Claude 会话消息 → 真实投进 Codex 会话 → Codex 理解协议并回信 → 回信自动入站；最后一步（回信送回 Claude）按预期卡在 CLI 未登录（ADR-008 通道 2/3 在 M4 解决）
- `anyd start` 前台 daemon：目录缓存 30s、逐条投递日志、SIGINT 优雅退出

## 2026-08-05 — M2 完成：消息驿站（mailbox）与 conversations

- SQLite 驿站落地：messages 状态机（pending→delivering→delivered/failed→dead，3 次重试）、conversations 无序配对、回环保护（context 深度 12 / 每分钟 6 条）——TDD 12 用例，累计 42 测试全绿
- CLI 四命令接通：anyd send（@ 目标与 --from 均走三级解析）/ inbox（--take 取件即送达）/ reply（继承线程与对话）/ conversations
- 真机验证：第一条消息入驿站（本 Claude 会话 → Codex 实验会话），conversations 正确显示配对
- 术语约定：对用户称「消息驿站」（mailbox 非 email，快递驿站语义：存储-补投-记录-状态）
- 重要环境发现（ADR-008 方向）：用户走 Claude 桌面客户端，CLI 无登录态；客户端原生 send_message 工具可 Claude↔Claude 直投（含 isRunning 状态）；Claude 入站定为三通道分层（客户端 send_message / hook 注入零依赖 / CLI resume 一次性登录解锁全自动）

## 2026-08-05 — M1 完成：session 目录与 @ 寻址

- adapters（claude/codex）的 listSessions + 聚合 scanner + resolveTarget 三级匹配（id 前缀 > 标题子串 > 目录名子串），TDD 30 测试全绿
- 关键实现决策：Claude 的 cwd 从 jsonl 内容读（目录名转义不可靠，实测有目录名与真实 cwd 不一致的 session）；title 取最后一条 custom-title；Codex 以 rollout 文件为真相源、session_index 仅补充 thread_name
- `anyd list` 真机验证：混合列出本机 4157 个真实 session（含正在进行的本会话），全扫 1.7s，默认 --limit 20

## 2026-08-05 — M0 完成：脚手架 + 通道实验结论

- 脚手架就绪：TypeScript + vitest + commander CLI 骨架（`anyd` 七个子命令占位），build/test 全绿
- R2（Codex）风险全解除：resume 携带历史 ✓、cwd 无关 ✓、并发双 resume 无冲突 ✓；发现 headless thread 不实时进 session_index，scanner 改以 rollout 文件名为真相源
- R1（Claude）：id 稳定不漂移 ✓、强依赖 cwd ✓（adapter 必须 cd 到项目目录）；「历史携带」待用户真实终端验证（scripts/experiments/verify-claude-resume.sh）
- 环境事实：Claude 认证在 Keychain → daemon 必须跑在用户登录环境；实验误注入教训记入 tasks/lessons.md

## 2026-08-05 — Web Console 纳入 Phase 1；开工

- 新增 docs/specs/phase1-webui.md：本地可视化控制台（IM 双栏、对话=session 配对、SSE 实时、页面新建连接/代发/重试）——定位：产品可理解性 + 实时监控 + agent 内 @ 失败时的人工兜底
- phase1-mvp.md 同步修订：新增 conversations（连接）数据模型与 `anyd conversations` 命令；skill 改为「先查已连接列表」；里程碑扩至 M6（M5=Web Console）
- Phase 1 动工：M0 脚手架 + R1/R2 通道实验

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
