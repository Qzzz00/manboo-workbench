# workbench-core · 座机服务

v3 评审稿 §5.1「核心出壳」的目标进程。**阶段 1(卡 A)**只做两件事,插件一行逻辑不改:

1. **站在插件前面转发一切**:所有 HTTP 请求与 WS 升级(`/helper`、`/live`)原样转给插件。
   方法、路径与查询串、头、体、状态码、流式响应都不改;上游不在时 HTTP 与 WS 升级都回 `502` 和一句人话,不编数据。不用 503:8791 的契约里 503 已经表示「这项能力本机没配」,手机会据此关掉语音 60 秒。
2. **把插件 `/live` 的广播翻成一条只读事件流**:内存里的环,不落盘、可丢。

## 自己的两条口(只给本机来源)

| 口 | 回什么 |
|---|---|
| `GET /snapshot` | `{ epoch, snapshot_seq, upstream: { connected, changed_at }, state }`。`state` 是插件最近一份 `/state` 的镜像,上游从没连上过时是 `null`。上游断开时镜像保留上次的样子,`connected` 为 `false`。 |
| `GET /events?since=<seq>[&epoch=<epoch>]` | SSE。先发一帧 `event: hello`(epoch、last_seq),再回放 `seq > since` 的缓冲,之后实时推。每帧 `id: <seq>`,`data` 是 `{seq, ts, topic, kind, payload}`。也认 `Last-Event-ID`。 |

`since` 早于缓冲、晚于最新、或 `epoch` 对不上(座机服务重启过)时回 `410`,终端重取 `/snapshot` 再续。

事件主题:

- `state.<顶层键>`:`kind` 为 `set`(payload 是新值)或 `unset`。只出变了的键。
- `live.<kind>`:插件其余一次性广播(`event`、`call`、`ring`、`actor_note` 等),`kind` 为 `message`,payload 原样。心跳 `ping` 不进流。
- `core.upstream`:`up` / `down`。

快照加续流的重建规则就是 `src/translate.ts` 的 `applyEvent`。

## 环境变量

| 变量 | 缺省 | 说明 |
|---|---|---|
| `CORE_PORT` | `8791` | 监听端口 |
| `CORE_HOST` | `127.0.0.1` | 监听地址;生产对调后用 `0.0.0.0` |
| `CORE_UPSTREAM` | `http://127.0.0.1:8790` | 插件的回环地址 |
| `CORE_UPSTREAM_REMOTE` | 不设 | 非本机来源转到哪。不设时一律 `403`;`interface` = 客户端进来的那块网卡的本机地址加上游端口 |
| `CORE_KEEP_EVENTS` | `2000` | 环里最多留几条;另有 64 MB 的字节上限 |

**为什么非本机来源要单独处理**:插件按 socket 远端地址判断是不是本机,回环来源不认设备令牌。经座机服务转过去的请求在插件眼里全是 `127.0.0.1`。所以非本机来源绝不能转到回环那条上游,配置与服务各拦一道。

## 开发

```bash
pnpm install
```

```bash
pnpm test
```

```bash
pnpm typecheck
```

```bash
pnpm build
```

产物是一个零依赖的 `lib/core.js`。对着真实插件试跑时用别的端口:

```bash
CORE_PORT=8793 CORE_UPSTREAM=http://127.0.0.1:8791 ~/.dsh/node/bin/node lib/core.js
```

```bash
node scripts/measure-latency.mjs http://127.0.0.1:8791 http://127.0.0.1:8793 120
```

`ledger/` 子目录归卡 B(账的骨架),本目录的进程与端口归卡 A。launchd 模板在 `deploy/ai.deepseek.workbench-core.plist`,端口对调的步骤在 `docs/交接-1020-卡A-座机服务骨架.md`。
