# Lessons

## 2026-08-05 — 实验脚本兜底逻辑误伤用户真实 session
- **错误**：R2 实验里「新建 codex thread 后取 `session_index.jsonl` 最后一行当新 id」——但 `codex exec` 创建的 session 不实时进索引，兜底逻辑静默拿到旧 id，把 2 条实验消息误注入用户真实的「Suno Gateway 每日数据巡检」session（无害但不可撤销）。
- **正确做法**：凡是要「定位刚创建的资源」，必须用强校验方式（marker 时间戳 + 断言恰好 1 个新文件），校验不过就 abort，**绝不允许 fallback 到「最后一个/最新一个」这类可能指向已有资源的猜测**。对用户已有数据的写操作，宁可失败不可猜。
- **附带架构结论**：codex scanner 必须以 `sessions/**/rollout-*.jsonl` 为真相源，session_index.jsonl 只能当辅助。
