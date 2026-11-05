'use strict';

// 诊断包存放位(2026-10-21,内测发版底座)。
//
// 以前诊断包是电脑生成、微信传给统筹。内测之后体验的人不一定在维护者身边,于是改成:
// 手机或电脑上按一下「发诊断包」→ 电脑打好包(白名单与脱敏照旧,在设备那一头做)→ 传到这里 →
// 回一个**六位编号**给她;统筹拿编号来取。
//
// ## 谁能传、谁能取
//
// 传:**只认设备令牌**(同 /v1/diag/report 那一道门,不看模型额度)。
// 取:管理员令牌(`RELAY_ADMIN_TOKEN`)取谁的都行 —— 统筹走这一条;设备令牌只取得到**自己账号**的,
//     别人的与不存在的说同一句 404。所以编号猜中了也没用:没有那把钥匙什么都拿不到。
//
// ## 存在哪、存多久
//
// 文件落在 `RELAY_HOME/diag-packs/<编号>.zip`(systemd 的 ReadWritePaths 圈着 RELAY_HOME),
// 账在 `diag_packs` 表里。**7 天**后自动消失:每次传、取时顺手清一遍(行与文件一起),
// 不靠谁记得去删 —— 它是排障材料,不是业务数据。
//
// ## 包里有什么
//
// 中转**不打开它**:内容的白名单与脱敏在设备那一头(workbench-plugin/src/server/diagnostics/pack.ts),
// 这里只认「是不是 zip」(开头四个字节)与大小。

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DIAG_PACK_RETENTION_DAYS = 7;
/** 一个包最大多大。设备那头整包未压缩封顶 40MB(pack.ts 的 TOTAL_BYTES),压完只会更小;多给一点余量。 */
const DIAG_PACK_MAX_BYTES = 48 * 1024 * 1024;
/** 每台设备 24 小时内最多传几个。正常是一天一两个;循环出错的机器不该把服务器的盘写满。 */
const DIAG_PACK_PER_DAY = 10;
/** 编号用的字:去掉 0 O 1 I L U 这几个念出来、抄下来容易错的。 */
const DIAG_PACK_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
const DIAG_PACK_CODE_LENGTH = 6;
const DIAG_PACK_CODE_RE = /^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{6}$/;
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

function newDiagPackCode() {
  const bytes = crypto.randomBytes(DIAG_PACK_CODE_LENGTH);
  let code = '';
  for (const byte of bytes) code += DIAG_PACK_ALPHABET[byte % DIAG_PACK_ALPHABET.length];
  return code;
}

/** 她念的、统筹抄的那一串 → 规范的编号。认不出就 undefined。大小写、空格、横杠都不算数。 */
function normalizeDiagPackCode(raw) {
  if (typeof raw !== 'string') return undefined;
  const code = raw.replace(/[\s-]/g, '').toUpperCase();
  return DIAG_PACK_CODE_RE.test(code) ? code : undefined;
}

function looksLikeZip(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= ZIP_MAGIC.length && buffer.subarray(0, ZIP_MAGIC.length).equals(ZIP_MAGIC);
}

function packFileOf(dir, code) {
  return path.join(dir, `${code}.zip`);
}

/** 这台设备从 `since` 起传了几个。 */
function countDiagPacksSince(db, tokenHash, since) {
  const row = db.prepare('SELECT COUNT(*) AS n FROM diag_packs WHERE token_hash = ? AND received_at >= ?')
    .get(tokenHash, since.toISOString());
  return Number(row?.n ?? 0);
}

/**
 * 落一个包。先写临时文件再改名(断在半路不会留下一个半截的 zip 被人取走),
 * 编号撞了就换一个(六位、三十个字,七天内撞上的机会极小,但不靠运气)。
 */
function storeDiagPack(db, dir, { tokenHash, prefix, account, deviceId, version, bytes, now }) {
  fs.mkdirSync(dir, { recursive: true });
  let code = newDiagPackCode();
  for (let tries = 0; db.prepare('SELECT 1 FROM diag_packs WHERE code = ?').get(code) !== undefined; tries += 1) {
    if (tries > 20) throw new Error('编号一直撞,这不该发生');
    code = newDiagPackCode();
  }
  const file = packFileOf(dir, code);
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, bytes);
  fs.renameSync(tmp, file);
  const expiresAt = new Date(now.getTime() + DIAG_PACK_RETENTION_DAYS * 86_400_000);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  db.prepare(
    'INSERT INTO diag_packs (code, token_hash, prefix, account, device_id, version, bytes, sha256, received_at, expires_at)'
    + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(code, tokenHash, prefix, account, deviceId, version, bytes.length, sha256, now.toISOString(), expiresAt.toISOString());
  return { code, bytes: bytes.length, sha256, expires_at: expiresAt.toISOString() };
}

/** 一个没过期的包的账(没有就 undefined)。 */
function findDiagPack(db, code, now) {
  return db.prepare('SELECT * FROM diag_packs WHERE code = ? AND expires_at > ?').get(code, now.toISOString());
}

/** 清掉过期的:行与文件一起。回清了几个。文件已经不在了不算错。 */
function pruneDiagPacks(db, dir, now) {
  const stale = db.prepare('SELECT code FROM diag_packs WHERE expires_at <= ?').all(now.toISOString());
  for (const { code } of stale) {
    try { fs.rmSync(packFileOf(dir, code), { force: true }); }
    catch { /* 删不掉的下一次再删 */ }
  }
  db.prepare('DELETE FROM diag_packs WHERE expires_at <= ?').run(now.toISOString());
  return stale.length;
}

module.exports = {
  DIAG_PACK_RETENTION_DAYS,
  DIAG_PACK_MAX_BYTES,
  DIAG_PACK_PER_DAY,
  DIAG_PACK_CODE_RE,
  newDiagPackCode,
  normalizeDiagPackCode,
  looksLikeZip,
  packFileOf,
  countDiagPacksSince,
  storeDiagPack,
  findDiagPack,
  pruneDiagPacks,
};
