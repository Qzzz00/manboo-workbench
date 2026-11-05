# DSH 会话 V4 夹具(卡 U3,2026-09-25)

## 这两份文件是怎么来的

**不是手写的,也不是抄源码猜的**:用 `~/.dsh/runtime-next`(U1 按 0.1.7-rc.2 锁定清单装的那一份真运行时)
里**上游自己的编解码器**生成,再用**上游自己的校验器**验过才落下来的。生成脚本就在旁边:`生成脚本.mjs`。

用到的上游导出(全部来自 `@deepseek-ai/…@0.1.7-rc.2` 的 `lib/index.js`):

| 干什么 | 谁 |
|---|---|
| 会话头编码 | `dsh-session-format-catalog` 的 `sessionFormatCatalog.encodeCurrentHeader` |
| 事件行编码 | 同上的 `encodeCurrentEvent`(上游 `eventLine()` 就是 `JSON.stringify(encodeCurrentEvent(e))`) |
| 文件名 | `dsh-session-format` 的 `sessionFormatLogFilename(4)` → `session.v4.jsonl` |
| 逐行准入校验 | `dsh-session-format-v3-to-v4` 的 `assertV4RowAdmission` |
| 全局关系校验 | 同上的 `assertReleasedV4Relationships` |
| 代号与事件词表 | `dsh-session` 的 `SESSION_FORMAT_VERSION`(= 4)、`KNOWN_SESSION_EVENT_TYPES` |

后三项正是上游读会话时 `SessionLogScanner` 逐行做的事(`session-persistence-jsonl/src/format.ts`),
所以这两份文件**能被 0.1.7 自己的读取器接受**,不是「形状差不多」的仿制品。

## 里面有什么

- `session.v4.jsonl` —— 一条主会话,18 行,刻意把升级后会碰到的每一种都摆进去了:
  - 人真说的一句(`source.kind === 'user'`);
  - 模型答的两段,各带 `data.usage`(给用量对账用)与 `data.message.source.model`;
  - 一次写类工具:`assistant/message` 里的 `tool-call` 块 + `tool/call` + **V4 的一等 `tool` 角色**
    `tool/result`(V3 那个 `tool-result` 包装块已退役);
  - **后台任务做完唤醒的那条 notice**(`source` = `{kind:'tool-jobs', form:'notice', summary}`),
    后面紧跟第二个回合 —— 评估第四节唯一要接的那一条就是它;
  - 一条**时间上下文**系统消息(`source.kind === 'time-context'`),代表要滤掉的那一类;
  - `session/title`、`request/header`、`request/context`、`step/*`、`turn/*`。
- `subagent.session.v4.jsonl` —— 一条**子代理**会话,头上带 `origin: "subagent"` 与
  `parentSession: "session-u3main"`(0.1.7 里子代理就是一条普通会话,没有 `subagents/` 目录)。

## 什么时候该换掉

U4 灰度里起 3081 真跑出会话之后,可以把这两份换成真机文件(同一个目录、同样的名字),
用例不用改一个字 —— 它们只按名字读这个目录。换之前这两份就是取证依据。

**不要**把维护者真实会话的原文拷进来(只读纪律:真实会话只读、不存原文)。
