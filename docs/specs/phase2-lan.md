# Phase 2 技术规格 — 局域网跨设备（MacBook ↔ Mac mini）

> 创建：2026-08-05 · 最后更新：2026-08-05
> 状态：实施中。前置：Phase 1 已完成（同机全链路验证）。决策依据：ADR-002（仅局域网、不用 Tailscale、自建发现+直连+配对）。

## 0. 目标

MacBook 上的任意 agent 会话 `@mini/codex:前端重构 <消息>`，Mac mini 上的目标会话收到、处理、回信回到发起方——两台 Mac 同一局域网，零第三方服务。

## 1. 架构：daemon 对等互联（无中心）

```
MacBook anyd ──────────── mDNS 广播/发现 ─────────── Mac mini anyd
  │  _anytoany._tcp (设备名、端口、指纹)                    │
  │                                                      │
  │  ── POST /api/peer/messages (X-Anytoany-Token) ──►    │
  │  ◄─ GET  /api/peer/sessions (聚合远程目录) ──────      │
  本地驿站+投递（Phase 1 原样）                     本地驿站+投递
```

- **发现**：`bonjour-service`（纯 JS）广播/浏览 `_anytoany._tcp`，TXT 记录带 `device`（设备名）与 `fp`（token 指纹前 8 位，用于配对状态判断）。
- **传输**：复用 Phase 1 的 HTTP server。**安全分层**：server 改绑 `0.0.0.0`，但非 `/api/peer/*` 路由仅接受 loopback 来源（Web Console 与本地 CLI 不暴露）；`/api/peer/*` 要求 `X-Anytoany-Token` 与本机 cluster token 一致，否则 401。
- **配对（MVP）**：共享 token 文件 `~/.anytoany/cluster-token`。`anyd pair --show` 显示本机 token（首次自动生成）；在另一台机器 `anyd pair --set <token>` 写入同一 token → 两台互认。TXT 的 `fp` 一致即显示「已配对」。
- **消息路由**：SessionRef 增加可选 `device`；dispatcher 投递前判断：目标 device 为空或等于本机名 → Phase 1 本地 adapter；否则查 peer 表 → `POST /api/peer/messages` 把消息转交对方 daemon（对方入自己驿站，其 dispatcher 完成本地最后一公里投递与回信；回信按 from.device 反向路由回来）。
- **目录聚合**：`anyd list` / `/api/sessions` 返回 本地目录 + 每个已配对 peer 的 `/api/peer/sessions`（带 `device` 字段）；resolve 支持 `@device/agent:frag`（device 匹配设备名前缀，大小写不敏感）。

## 2. 数据与兼容

- `messages` 表加列 `from_device TEXT` / `to_device TEXT`（空 = 本机）；SQLite `ALTER TABLE` 幂等迁移。
- 转交给 peer 的消息在**发起方驿站**记 `delivered`（含 `relayed-to:<device>` 备注）；投递责任移交对方驿站（对方有完整状态机）。回信是新消息从对方发起，`context_id` 原样携带保持线程。
- 回环保护按 context 计数在各自驿站独立生效；`context_id` 全局 uuid 不冲突。

## 3. CLI/UI 变化

- `anyd pair --show` / `--set <token>` / `anyd peers`（发现的设备与配对状态）。
- `anyd list` 输出带设备前缀：`@mini/codex:前端重构 [019f…] (2m ago)`；本机不带前缀。
- target 语法 `@<device>/<agent>[:<frag>]` 全线打通（resolve 的 `unsupported_device` 分支替换为真实解析）。
- Web Console：session 下拉与对话列表显示设备徽标；其余不变（数据仍来自本地驿站+聚合目录）。
- skill 更新：说明 `@设备/agent` 寻址。

## 4. 测试与验收

- 单测：device 路由判定、peer 转交序列化、token 校验（401 路径）、目录聚合合并/去重、resolve 带 device 全分支、迁移幂等。
- 集成（单机模拟双设备）：两个 daemon 实例（不同端口/不同 db/不同设备名/同 token），A 实例驿站消息 → 转交 B 实例 → B 本地投递给真实 codex 会话 → 回信反向路由回 A。mDNS 用直连 peer 地址注入替代（`--peer host:port` 调试参数），mDNS 本身单独冒烟。
- **真双机验收（用户参与）**：Mac mini 上 `npm i -g`（或 clone+link）→ `anyd setup` → `anyd pair --set <MacBook 的 token>` → `anyd start`；MacBook 侧 `anyd peers` 看到 mini → `anyd send "@mini/codex:xxx" ...` 闭环。

## 5. 明确不做（P2）

跨网段/公网、NAT 穿透、E2EE（局域网 + token 已够 MVP；升级留 P3+）、>2 台设备的网状优化（协议天然支持多台，不特殊处理）、mini 上的自动安装（用户手动跑三条命令）。
