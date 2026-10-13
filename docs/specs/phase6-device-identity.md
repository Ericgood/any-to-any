# Phase 6 技术规格 —— 设备身份与加密（照抄 Syncthing）

> 创建：2026-10-13 · 最后更新：2026-10-13
> 决策依据：[ADR-028](../decisions.md)；对照资料：[Syncthing Security](https://docs.syncthing.net/users/security.html)

## 1. 文件与数据

| 路径 | 内容 | 权限 |
|---|---|---|
| `~/.anytoany/identity/key.pem` | Ed25519 私钥（PKCS#8 PEM） | 0600，目录 0700 |
| `~/.anytoany/identity/cert.pem` | 自签名 X.509 v3 证书，CN=`anytoany`，有效期到 9999-12-31 | 0644 |
| `~/.anytoany/trusted-devices.json` | `{"devices":[{"id","name","tier":"owner","addedAt"}]}` | 0600 |
| `~/.anytoany/cluster-token` | **作废**（不再读取，可删） | — |

**设备 ID**：`base32(sha256(certDER))`，RFC 4648 字母表、无填充，共 52 字符，每 7 个一组用 `-` 连接（8 组，最后一组 3 位）。输入时忽略大小写、空格和 `-`。界面短 ID = 前 7 位。

## 2. 证书生成（零依赖）

Node 能生成 Ed25519 密钥，但不能签发证书，所以手写 DER：
`Certificate ::= SEQUENCE { tbsCertificate, signatureAlgorithm(1.3.101.112), BIT STRING signature }`。
TBS 包括：v3（`[0] INTEGER 2`）、16 字节随机正整数序列号、算法 Ed25519、issuer = subject = `CN=anytoany`、有效期（`UTCTime` 起始，`GeneralizedTime 99991231235959Z` 结束）、`SubjectPublicKeyInfo`（直接用 `publicKey.export({type:'spki',format:'der'})`）。签名用 `crypto.sign(null, tbs, privateKey)`。

## 3. 传输

- **控制台**：`http://127.0.0.1:7433`，只绑 loopback（不再绑 `0.0.0.0`）。原 `/api/peer/*` 路由从这里移除。
- **peer 服务**：`https://0.0.0.0:7434`（`--peer-port` 可改），TLS 1.3，`requestCert: true`、`rejectUnauthorized: false`，在请求处理里自行核对：
  - 没有客户端证书 → 401；
  - 指纹不在信任名单 → 403，并把对方记为**待配对请求**（`x-anytoany-device` 头里的自报名称、来源地址、时间），供 `anyd peers` 展示；
  - 指纹在名单内 → 交给 peer 路由处理（`info` / `sessions` / `messages` / `collab`）；`messages` 的 `from.device` 改写为信任名单登记的名字。
- **peer 客户端**：`tls.connect`（出示本机证书，`rejectUnauthorized: false`）→ `secureConnect` 后核对服务端指纹 == 期望 ID 且在信任名单内 → 才用 `http.request({ createConnection: () => socket })` 发请求。核对失败立即销毁 socket，**一个字节都不发**。
- **mDNS TXT**：`{ device, id, pp }`（pp = peer 端口）。

## 4. CLI

| 命令 | 作用 |
|---|---|
| `anyd pair` | 显示本机设备名、设备 ID，以及给对方的配对命令 |
| `anyd pair add <ID> [--name <n>]` | 信任一台设备（档位 `owner`）。不给名字时：先查 daemon 的 mDNS 结果和待配对请求，查不到用 `device-<短ID>` |
| `anyd pair remove <ID或名字>` | 取消信任 |
| `anyd pair list` | 信任名单 |
| `anyd pair --invite` | 新设备一行安装：`… install.sh \| bash -s -- --trust <本机ID> --trust-name <本机名>` |
| `anyd pair --set/--show` | 已作废，打印新流程 |
| `anyd peers` | 局域网发现的设备：已配对 / 未配对（附 ID 和 `pair add` 命令）/ 待配对请求 |

信任名单每次请求重新读取（按文件 mtime 缓存），`pair add/remove` 无需重启 daemon。

## 5. 测试

- **单元**：证书能被 `X509Certificate` 解析、公钥验签通过、Ed25519、自签；ID 稳定、格式化与规范化互逆、非法输入被拒；文件权限 0600/0700；信任名单增删、按名字或 ID 删除、mtime 缓存。
- **传输（真 TLS，单机双身份）**：已信任双方 → 200；未信任客户端 → 403 并记入待配对；客户端期望 ID ≠ 服务端证书 → 拒绝，且服务端未收到任何请求；无客户端证书 → 401。
- **路由**：转发消息的 `from.device` 被改写为登记名；`collab` 合并；`sessions` 聚合。
- **端到端**：两个 daemon（不同 `ANYTOANY_HOME` / 端口）互相 `pair add` → 跨实例投递 → 回信反向路由；未配对时 relay 失败且报错清晰。旧的 lan-smoke 脚本改为新配对流程。
