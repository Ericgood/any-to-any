# Lessons

## 2026-08-07 — CLI 旗标位置没按真实 argv 验证就发版，造成全量投递回归
- **错误**：给 codex 加 `--sandbox` 提权时，只看了 `codex exec --help` 确认旗标存在，就把它拼在 `exec resume <id> --skip-git-repo-check` **之后**发版。实际 `--sandbox` 是 `exec` 的旗标、不属于 `resume` 子命令，CLI 报 `unexpected argument '--sandbox'` (exit 2)——机主一旦开启 codex 提权，**每一条投进本机 Codex 的消息（含所有回信）全部失败**，用户现象是「Codex 永远收不到回复」。三次真实往返被废。
- **正确做法**：涉及子命令的 CLI 旗标，发版前必须用**真实 argv 跑一次**验证解析通过（`codex exec --sandbox X resume <假id> ...` 看是否越过 arg parsing 只在业务层报错），不能只凭 `--help` 里「有这个旗标」就假设位置随便放。子命令 ≠ 父命令的旗标作用域。
- **附带**：诊断「A 收不到 B 的回复」类问题，先查 daemon 日志的 `failed` 行拿到确切 stderr，比从症状反推快得多——本案日志里 `unexpected argument '--sandbox'` 一行直接定位。

## 2026-08-06 — 测试直打真实用户目录，谋杀线上 daemon 的 pid 文件
- **错误**：setup.test.ts 里的 pidfile 测试段调用 `writePid()/clearPid()` 时没传隔离 home（这两个函数默认走真实 `~/.anytoany/`）——每跑一次 vitest 就把正在运行的 daemon 的 pid 文件覆盖再删除。次日造成三次 `anyd stop` 失明 + pid 归属排障绕路，耗费一小时才抓到现行（起 daemon → 跑 vitest → 盯 pid 文件消失）。
- **正确做法**：① 任何测试触碰「按默认路径解析真实用户目录」的函数，必须显式注入隔离 home（参数或 env），写完自查一遍默认参数链路最终落在哪个真实路径；② 排障时对「文件莫名消失」这类幽灵现象，早做**抓现行实验**（before/after 快照 + 逐候选排除）而不是连续推理猜测——本案推理绕了三轮，实验一发命中。
- **附带**：mDNS 排障同款教训——「隔离生效」的验证信号必须直接针对要隔离的资源本体（ZCODE_DATA_BASE_DIR 创建了目录 ≠ db 被隔离，结果 2 条 smoke 会话写进了用户真实 ZCode 库）。验证隔离 = 验证目标资源的实际落点，不是验证副产物。

## 2026-08-05 — 实验脚本兜底逻辑误伤用户真实 session
- **错误**：R2 实验里「新建 codex thread 后取 `session_index.jsonl` 最后一行当新 id」——但 `codex exec` 创建的 session 不实时进索引，兜底逻辑静默拿到旧 id，把 2 条实验消息误注入用户真实的「Suno Gateway 每日数据巡检」session（无害但不可撤销）。
- **正确做法**：凡是要「定位刚创建的资源」，必须用强校验方式（marker 时间戳 + 断言恰好 1 个新文件），校验不过就 abort，**绝不允许 fallback 到「最后一个/最新一个」这类可能指向已有资源的猜测**。对用户已有数据的写操作，宁可失败不可猜。
- **附带架构结论**：codex scanner 必须以 `sessions/**/rollout-*.jsonl` 为真相源，session_index.jsonl 只能当辅助。

## 2026-08-05 — 多 agent 共享工作区，git add -A 裹挟了别人的半成品
- **错误**：提交 skill 文档时用 `git add -A`，把另一个 agent 正在开发的 Phase 2 半成品（src/cluster/ 等 9 个文件）一起提交推送到 main，commit message 与实际内容不符。
- **正确做法**：多 agent 可能共享同一工作区（anytoany 项目本身就是多 agent 协作），提交前必须 `git status` 检查，**只 add 自己本轮明确改动的文件（精确路径），永远不用 `git add -A` / `git add .`**。发现工作区有非自己的改动时，视为另一个 agent 的施工现场，不碰。
- **本次处置**：main 测试全绿（对方代码自洽），不 revert；以澄清条目修正记录。

## 2026-08-05 — 把 agent 的自我报告当验收证据；测试消息写成诱导题
- **错误**：hook 可见性测试消息文本写了预期结果（「会以摘要形式出现在 Codex App 对话流」），headless 回合的 Codex 无法观察 App UI，被信封 v2 强制表态后顺从回复「DONE 测试成功」——我未识破幻觉，当成验收证据报告用户；用户截图证伪。
- **正确做法**：① 验收必须由独立观察者确认（用户亲见 / 我方可验证的输出、文件、状态查询），agent 对自身不可观测事物的断言一律不作数；② 测试消息严禁包含预期结果的暗示（诱导幻觉顺从）；③ 区分「模型层可见」（hook additionalContext，模型知道）与「用户层可见」（App 对话流渲染，用户看到）——两者不可混淆，产品验收以用户层为准。
