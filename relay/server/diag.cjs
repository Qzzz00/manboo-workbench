'use strict';

// 远程错误上报(2026-09-22)。**这一块存在的理由只有一条**:
// Ben 把工作台装到一台新 Mac 上脱机跑,统筹不在那台机器前面。他那头出了错,
// 我们这头得看得见 —— 否则"修复和优化"都只能靠他念屏幕上的字。
//
// ## 存什么、不存什么
//
// 存:版本号、哪个组件、哪一类、界面上显示的那个短编号、一句报错、栈前 20 行、
// 最近 50 行日志、设备说的时刻。
// **不存**:用户说过的话、文件内容、任何凭据。设备那一头在发之前已经擦过一遍
// (workbench-plugin/src/server/diagnostics/redact.ts),这里再擦一遍 —— 见下。
//
// ## 为什么中转要再擦一遍(scrubDiagText)
//
// 擦一遍的代价是几个正则,漏一次的代价是一把钥匙在服务器上躺 30 天。
// 而且这两头是分开发布的:设备上跑的可能是三个月前那一版插件,它的规则表比这里旧。
// 所以这里的规则**只认最明确的那几种形状**(wb_ 令牌、sk- Key、Bearer 头、JWT、
// `?token=`、`/Users/<名字>/`),不做"看着像随机串就擦"那种猜 —— 猜错了是把报错本身擦没了。
//
// ## 为什么按 token_hash 限频,而不是按 IP
//
// 一台机器崩溃循环时,一分钟能刷几百条。限频要绑在**设备**上:同一台不管换几个网,
// 一小时就 20 条。设备那头超了会自己合并计数(`merged`),所以封顶不会让信息整个丢掉,
// 只会让它变成"这一小时同一个错发生了 137 次"这一行。
//
// ## 保留 30 天
//
// 它是排障材料,不是业务数据。30 天之后自动消失,**不需要谁记得去删** ——
// 读和写的时候各清一次(清的是 received_at 过期的行,按服务器的时钟算,
// 不按设备说的 at 算:设备的时钟可能是错的,而错的时钟不该让一行赖着不走)。

const crypto = require('node:crypto');

/** 认得的组件。闭集 —— 写别的一律 400,免得日后库里出现一堆拼错的名字。 */
const DIAG_COMPONENTS = ['plugin', 'worker', 'butler', 'shell', 'client'];

/**
 * 认得的几类。前四类是**机器自己报的错**,与卡上那四句一一对应:
 * - `unhandled`      没人接的异常 / promise
 * - `crash_restart`  崩了又被拉起来
 * - `update_failed`  热更新失败
 * - `call_closed`    通话会话异常关闭
 *
 * 第五类是**人说的**(2026-09-28,卡 FB):
 * - `feedback`       用户说了一句「工作台这里不对」,事务官整理成一条发回来。
 *   走同一条路、同一道脱敏、同一个限频,只多两格:`said`(她的原话)与 `context`(当时的模板 / 布局)。
 *   **本体的毛病不派她的 Agent 改**是 2026-09-27 17:20 的拍板,这一类就是那条规矩的出口。
 *
 * 与插件那头 `src/diag.ts` 的 `DIAG_KINDS` 一字不差 —— 两头对不上就落不了库。
 */
const DIAG_KINDS = ['unhandled', 'crash_restart', 'update_failed', 'call_closed', 'feedback'];

/** 留多久。到期的行在下一次读写时被清掉。 */
const DIAG_RETENTION_DAYS = 30;

/** 每台设备每小时的条数上限。超了 429,设备那头自己合并计数。 */
const DIAG_PER_HOUR = 20;

const MAX_MESSAGE = 500;
const MAX_STACK_LINES = 20;
const MAX_STACK_LINE = 300;
const MAX_LOG_LINES = 50;
const MAX_LOG_LINE = 500;
/** 反馈那一类多的两格各自的上限。原话按一句算,模板 / 布局那一行更短。 */
const MAX_SAID = 500;
const MAX_CONTEXT = 300;

/** 界面编号的形状:组件缩写(2~4 个大写字母)+ 横杠 + 6 位。生成在插件那边,这里只认形状。 */
const CODE_RE = /^[A-Z]{2,4}-[0-9A-Z]{6}$/;

/**
 * 第二张网。**顺序有讲究**:先擦带标签的(`token=`、`Bearer`),再擦按前缀认得出的
 * (`wb_`、`sk-`),最后擦路径里的用户名 —— 反过来的话 `/Users/example/` 里的 ben 会先被
 * 别的规则吃掉一半,留下半截更难读。
 */
function scrubDiagText(text) {
  if (typeof text !== 'string' || text === '') return '';
  return text
    // Authorization: Bearer <随便什么>
    .replace(/(Bearer\s+)\S+/gi, '$1…')
    // ?token=… / &access_token=… / "api_key": "…" / secret=…
    .replace(/((?:access_)?token|api[_-]?key|secret|password)(["']?\s*[:=]\s*["']?)[A-Za-z0-9._~+/=-]{8,}/gi, '$1$2…')
    // 我们自己那把设备令牌:只留前缀
    .replace(/\bwb_[A-Za-z0-9_-]{8,}/g, 'wb_…')
    // OpenAI / DeepSeek 形状的 Key
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-…')
    // JWT(LiveKit 的进房凭证就是这个形状)
    .replace(/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, 'eyJ…')
    // 家目录里的用户名。**路径本身要留着**(排障全靠它),换掉的只是那一段名字。
    .replace(/\/Users\/[^/\s"'`]+/g, '/Users/<用户>')
    .replace(/\/home\/[^/\s"'`]+/g, '/home/<用户>');
}

function textOf(value, max) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max);
}

/** 一个字符串数组 → 擦过、截过、掐过的那几行。`take` 是 'head' 或 'tail'。 */
function linesOf(value, { max, maxLine, take }) {
  if (!Array.isArray(value)) return [];
  const all = value
    .filter(line => typeof line === 'string')
    .map(line => scrubDiagText(line.replace(/\s+$/, '')))
    .filter(line => line !== '')
    .map(line => (line.length <= maxLine ? line : line.slice(0, maxLine)));
  return take === 'head' ? all.slice(0, max) : all.slice(-max);
}

/**
 * 请求体 → 一条能落库的上报。**任何一处形状不对都不抛**:
 * 认不出的组件与种类是 400(它们是闭集,写错了说明调用方有 bug,该让他知道);
 * 别的字段一律"读不懂就当没说" —— 一条报错不该因为时间戳写歪了而整个丢掉。
 */
function parseDiagReport(body) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, status: 400, error: 'body 要是一个 JSON 对象。', code: 'bad_body' };
  }
  const raw = body;
  if (!DIAG_COMPONENTS.includes(raw.component)) {
    return {
      ok: false,
      status: 400,
      error: `component 只认这几个:${DIAG_COMPONENTS.join('、')}。`,
      code: 'bad_component',
    };
  }
  if (!DIAG_KINDS.includes(raw.kind)) {
    return { ok: false, status: 400, error: `kind 只认这几个:${DIAG_KINDS.join('、')}。`, code: 'bad_kind' };
  }
  const code = typeof raw.code === 'string' && CODE_RE.test(raw.code.trim()) ? raw.code.trim() : '';
  const atMs = typeof raw.at === 'string' ? Date.parse(raw.at) : Number.NaN;
  const merged = Number.isInteger(raw.merged) && raw.merged > 0 ? Math.min(raw.merged, 100_000) : 1;
  return {
    ok: true,
    value: {
      version: textOf(raw.version, 32),
      component: raw.component,
      kind: raw.kind,
      code,
      message: scrubDiagText(textOf(raw.message, MAX_MESSAGE)).slice(0, MAX_MESSAGE),
      stack: linesOf(raw.stack, { max: MAX_STACK_LINES, maxLine: MAX_STACK_LINE, take: 'head' }),
      log: linesOf(raw.log, { max: MAX_LOG_LINES, maxLine: MAX_LOG_LINE, take: 'tail' }),
      merged,
      // 反馈那一类多的两格(2026-09-28,卡 FB)。报错那四类不带它们,读不懂就当没说 ——
      // **再擦一遍**:她可能把一段带路径 / 带 Key 的字直接粘进了那句话里。
      ...(typeof raw.said === 'string' && raw.said.trim() !== ''
        ? { said: scrubDiagText(textOf(raw.said, MAX_SAID)).slice(0, MAX_SAID) }
        : {}),
      ...(typeof raw.context === 'string' && raw.context.trim() !== ''
        ? { context: scrubDiagText(textOf(raw.context, MAX_CONTEXT)).slice(0, MAX_CONTEXT) }
        : {}),
      ...(Number.isFinite(atMs) ? { at: new Date(atMs).toISOString() } : {}),
    },
  };
}

/** 这台设备从 `since` 起报了几条。限频靠它。 */
function countDiagReportsSince(db, tokenHash, since) {
  const row = db.prepare('SELECT COUNT(*) AS n FROM diag_reports WHERE token_hash = ? AND received_at >= ?')
    .get(tokenHash, since.toISOString());
  return Number(row?.n ?? 0);
}

/** 落一行。`id` 是随机的,不由调用方说 —— 免得两台机器撞主键。 */
function insertDiagReport(db, { tokenHash, account, deviceId, prefix, report, now }) {
  const id = crypto.randomUUID();
  db.prepare(
    'INSERT INTO diag_reports (id, token_hash, prefix, account, device_id, version, component, kind, code,'
    + ' message, stack, log, merged, at, received_at, said, context)'
    + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    id, tokenHash, prefix, account, deviceId,
    report.version, report.component, report.kind, report.code,
    report.message, report.stack.join('\n'), report.log.join('\n'), report.merged,
    report.at ?? now.toISOString(), now.toISOString(),
    // 没有就写 NULL(不是空串):库里一眼看得出"这一类本来就没有这一格"。
    report.said ?? null, report.context ?? null,
  );
  return id;
}

/** 清掉过期的。回清了几行(部署自检时看得见"它真的在清")。 */
function pruneDiagReports(db, now, days = DIAG_RETENTION_DAYS) {
  const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
  const info = db.prepare('DELETE FROM diag_reports WHERE received_at < ?').run(cutoff);
  return Number(info.changes ?? 0);
}

/**
 * 管理员那一头看到的行。**没有 token_hash** —— 它是令牌的哈希,虽然反不出明文,
 * 但也没有任何理由出现在一个用来读报错的接口里。
 */
function diagReportRows(db, { device, account, kind, limit }) {
  const clauses = [];
  const args = [];
  if (device !== undefined) { clauses.push('device_id = ?'); args.push(device); }
  if (account !== undefined) { clauses.push('account = ?'); args.push(account); }
  // 只看反馈 / 只看某一类报错:`GET /v1/diag/reports?kind=feedback` 就是统筹拉「反馈给开发者」那一份。
  if (kind !== undefined) { clauses.push('kind = ?'); args.push(kind); }
  const where = clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`;
  args.push(limit);
  return db.prepare(
    'SELECT id, prefix, account, device_id, version, component, kind, code, message, stack, log, merged, at, received_at,'
    + ' said, context'
    + ` FROM diag_reports${where} ORDER BY received_at DESC, rowid DESC LIMIT ?`,
  ).all(...args).map(row => ({
    ...row,
    stack: row.stack === '' ? [] : String(row.stack).split('\n'),
    log: row.log === '' ? [] : String(row.log).split('\n'),
  }));
}

/** 定长比较。管理员令牌不长,但没有理由让它可被计时猜出来。 */
function adminTokenMatches(expected, given) {
  if (typeof expected !== 'string' || expected === '') return false;
  if (typeof given !== 'string' || given === '') return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(given, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = {
  DIAG_COMPONENTS,
  DIAG_KINDS,
  MAX_SAID,
  MAX_CONTEXT,
  DIAG_RETENTION_DAYS,
  DIAG_PER_HOUR,
  scrubDiagText,
  parseDiagReport,
  countDiagReportsSince,
  insertDiagReport,
  pruneDiagReports,
  diagReportRows,
  adminTokenMatches,
};
