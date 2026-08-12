# GitHub Actions 月度额度异常消耗审计与治理

> 创建：2026-08-09 · 最后更新：2026-08-09

## 1. 结论

本月 2,000 分钟额度被提前耗尽，不是单次异常重跑造成，而是两项 CI 设计叠加：

1. **千机（`Ericgood/any-to-any`）每次推送同时运行 2 个 macOS job 和 2 个 Linux job。** 2026-08-05 至 2026-08-07 有 36 次 `push` workflow；macOS 在私有仓库中的分钟折算约为 Linux 的 10 倍，是本次额度耗尽的首要原因。
2. **Suno Gateway（`Ericgood/api-gateway`）在每个 PR 上先构建 4 个大型 Docker image，合并到 `main` 后再构建并发布同样 4 个 image。** 质量检查需要保留，但 PR 阶段的 4-image 重复构建没有发布产物，属于可消除消耗。

这不是业务流量导致，也不是 Vercel/生产服务器消耗；是私有仓库的 GitHub-hosted runner 设计过重，加上短时间大量小提交触发 CI。

## 2. 证据与口径

审计窗口：`2026-08-01 00:00 BJT` 至 `2026-08-09`。

数据来源：GitHub workflow run/job/step API、仓库 workflow 文件和 Git 历史。当前 `gh` token 没有读取个人 Billing 总账所需的 `user` scope，因此下表是不包含排队时间的 step execution 复核估算，不冒充 GitHub Billing 页面最终账单。

审计过程中曾直接用 job 的 `started_at → completed_at` wall-clock 估算千机为 2,700 分钟以上；逐 step 复核后确认其中包含 macOS runner 排队等待，不能计入执行分钟，已撤销该错误数字。以后 Actions 成本审计必须优先使用 Billing usage report；权限不足时只能汇总实际 step execution，不能拿 job wall-clock 代替。

GitHub 官方规则：

- 私有仓库使用 GitHub-hosted runner 会消耗账户月度分钟；GitHub Free 每月包含 2,000 分钟，账期开始时重置。
- 每个 job 的 billable execution time 向上取整到整分钟。
- macOS runner 的单位价格/历史分钟折算显著高于 Linux；GitHub 当前基准价为 macOS `$0.062/min`、Linux 2-core `$0.006/min`，约 10.3 倍。

官方文档：

- <https://docs.github.com/en/billing/concepts/product-billing/github-actions>
- <https://docs.github.com/en/actions/how-tos/monitor-workflows/view-job-execution-time>

### 2.1 账户内主要仓库

| 仓库 | workflow runs | 原始 runner wall time | 估算额度影响 | 主要原因 |
| --- | ---: | ---: | ---: | --- |
| `any-to-any` | 36 | wall-clock 约 223 分钟 | **至少约 821 分钟** | 2 macOS + 2 Linux 的每-push matrix；macOS 10x 放大 |
| `api-gateway` | 87 | wall-clock 约 390 分钟 | **约 940 Linux 分钟（上界估算）** | PR 和 main 都构建 4 个 image；高频小 PR 重复构建 |
| `webapp-new` | 12 | 约 19 分钟 | 约 27 分钟 | repository dispatch，非主因 |
| `webapp-db-backups` | 8 | 约 16 分钟 | 约 20 分钟 | 定时备份，非主因 |

额度耗尽后，后续 workflow 虽然仍显示 run/failed，但许多 job 没有真正分配 runner，不能简单把 run 数乘平均时长。上述估算按实际启动的 job 计算。

### 2.2 千机的具体浪费

旧 `.github/workflows/ci.yml` 在每次 `main` push 和每个 PR 上执行：

```text
macos-latest / Node 20
macos-latest / Node 22
ubuntu-latest / Node 20
ubuntu-latest / Node 22
```

36 次 push 的实际 step execution 复核显示：常规完整运行约消耗 23 个折算分钟，其中约 22 分钟来自两个 macOS job；三天累计至少约 821 分钟，早期 cache miss 的原生模块编译会更高。

其中 macOS 两条轴约占千机单次 CI 额度影响的 **92%**。常规 TypeScript build/vitest 在 Linux 已能覆盖绝大多数提交；macOS 兼容性有价值，但没有必要在每次小推送上重复跑两个 Node 版本。

### 2.3 Gateway 的具体浪费

Gateway 的 `Container image` workflow 已有 paths filter 和 concurrency cancel，但 PR 阶段仍在质量检查后构建：

- `app`
- `browser`
- `chrome-stable-canary`
- `chrome-stable-recovery`

PR 构建不 push image；合并到 `main` 后又构建并发布一遍。2026-08-01 起约 41 个 PR、44 个 main push，加上少量手动运行：

- PR 侧约 407 分钟，其中 4-image 构建约 329 分钟；
- main push 约 502 分钟；
- workflow dispatch 约 31 分钟。

PR 质量检查应保留，PR image 构建改为本地 Docker/特定手动验收；正式不可变 image 只在 `main` 或明确手动 dispatch 构建。

## 3. 冻结治理方案

### 3.1 千机

常规 PR/main CI：

- 仅 `ubuntu-latest`；
- 保留 Node 20/22 两个版本；
- 增加同分支 concurrency，后推送取消旧 run；
- Markdown/docs-only 变更不触发 CI。

macOS 兼容性：

- 从常规 matrix 移出；
- 每周一次或人工 `workflow_dispatch`，只跑 Node 22；
- 若 macOS smoke 失败再定向修复，禁止靠反复重跑碰运气。

提交纪律：

- 一个逻辑变更在本地先完成 build/test，再形成一次可审查 push；
- 不为每个微小中间状态直接 push `main`；
- 功能分支 + PR + squash 为默认；
- workflow matrix、runner OS 或新定时任务变更必须在 PR 中注明预计月度分钟影响。

### 3.2 Suno Gateway

- PR 只跑 `quality`；
- 4-image matrix 仅在 `main` 和人工 dispatch 执行；
- 保留 paths filter、不可变 digest、provenance、SBOM 和 build cache；
- Dockerfile/镜像变化的 PR 在本地或一次人工 dispatch 验证，不能恢复为每个 PR 全量构建。

## 4. 预期效果

按本月同等提交频率估算：

- 千机：单次常规 push 从约 23 个折算分钟降到约 2 分钟（约省 90%）；即使加每周 macOS smoke，也应远低于旧方案。
- Gateway：消除约 329 分钟 PR image 重复构建，保留约 78 分钟 PR quality 和正式 main image 发布。
- 按本月 36 次千机 push 和 41 个 Gateway PR 估算，仅已识别的两项就可避免 **1,100+ 分钟/月**；若保持更高提交频率，节省会继续增加。

实际消耗仍受提交次数、cache 命中和 runner 时间影响；月底应以 GitHub Billing usage report 复核。

## 5. 验收与防回归

- 静态测试必须断言千机常规 matrix 不包含 macOS、macOS 只允许 schedule/dispatch、并发取消和 docs-only 过滤存在。
- Gateway release pipeline 测试必须断言 image build job 不在 PR 事件执行。
- 本地执行千机 `npm run build && npm test`；Gateway 执行定向 release test、typecheck、lint、test、build。
- GitHub 额度已经耗尽时，不能把“job 因 billing 未启动”当成 CI 通过；应明确记录为外部闸门，等待账期重置或用户调整预算后再验证一次真实 Actions run。

## 6. 实施与本地验收

`2026-08-09 BJT`：

- 千机实现 commit `a008ba2` 已将常规 CI 收缩为 Ubuntu Node 20/22，并新增每周/手动 macOS smoke；后续补丁让 `pull_request` 的 docs-only 变更也被过滤。
- `CLAUDE.md` 固化 Actions 额度纪律：本地完成再集中 push、禁止连续微小中间状态逐个推 main、新增 runner/matrix/定时任务必须先估月度成本。
- `test/ci-policy.test.ts` 先在缺少 PR docs filter 时失败，补齐后转绿。
- 本地 `npm run build`、完整 `npm test`（18 files / 147 tests）与 `git diff --check` 通过。
- Gateway 已以独立分支增加 release pipeline 静态契约和 PR image-build guard；未混入千机业务代码。
- PR [#1](https://github.com/Ericgood/any-to-any/pull/1) 合并为 `main@e66990e`。PR 与 main 的真实 Actions 均只启动 Ubuntu Node 20/22；main run [`31297385396`](https://github.com/Ericgood/any-to-any/actions/runs/31297385396) 全绿，两个 job 分别约 1.6 分钟和 0.3 分钟，没有启动 macOS job，现场验证单次折算成本从约 23 分钟降到约 2 分钟。
- Gateway PR [#118](https://github.com/Ericgood/api-gateway/pull/118) 的真实 PR run 只执行 quality，并将 4-target image job 标记为 skipped；合并为 `main@96b6c4e` 后，main run [`31297385637`](https://github.com/Ericgood/api-gateway/actions/runs/31297385637) 才构建并发布四个镜像，验证“PR 不重复构建、main 保持发布能力”。
- 每周 macOS smoke 尚未到首次定时窗口；该项由下一次周一 schedule 自然验证，不为验收主动消耗 macOS 额度。
