'use strict';

// 「他挑过的 / 他不要的」(2026-09-23,Ben:「下次别再推同一批」)。
//
// 一个 JSON 文件,不建表:这是**一张短名单**(几十个 id),没有查询、没有关联、没有并发写。
// 为它加一张 sqlite 表要跟着加建表语句、迁移和一套 store —— 第一版 YAGNI(AGENTS.md)。
//
//     <BUTLER_HOME>/voice-picks.json   { "picked": [id…], "passed": [id…] }
//
// 语义:
//   · `picked` —— 他真选中过的(`PUT /api/voices/current` 顺手记一条)。**最近的在前**。
//   · `passed` —— 念给他听过、他没要的。挑下一批时往后排,**不是永久拉黑**:
//     库里只有 99 个,真拉黑几轮之后就没得挑了。
//
// 读不出来 / 写不成一律当**空名单**:这是「挑得更顺手」,不是功能本身,不该挡住换音色。

const fs = require('node:fs');
const path = require('node:path');
const { butlerHome } = require('../config.cjs');

/** 两张名单各留这么多条。够覆盖「别再推同一批」,又不会让文件长出来。 */
const MAX_KEPT = 60;

function filePath() {
  return process.env.VOICE_PICKS_PATH
    ? path.resolve(process.env.VOICE_PICKS_PATH)
    : path.join(butlerHome(), 'voice-picks.json');
}

function normalizeIds(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const one of raw) {
    const id = typeof one === 'string' ? one.trim() : '';
    if (id !== '' && !out.includes(id)) out.push(id);
  }
  return out.slice(0, MAX_KEPT);
}

function read() {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
    return { picked: normalizeIds(raw.picked), passed: normalizeIds(raw.passed) };
  } catch {
    return { picked: [], passed: [] };
  }
}

function save(next) {
  try {
    const file = filePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

/** 最近的在前、去重、截断。 */
function prepend(list, ids) {
  return normalizeIds([...ids, ...list]);
}

/** 他选中了这一个。**同时把它从「不要的」里拿掉** —— 他改主意了,那条记录就过期了。 */
function recordPicked(voiceId) {
  const id = String(voiceId || '').trim();
  if (id === '') return read();
  const now = read();
  const next = {
    picked: prepend(now.picked, [id]),
    passed: now.passed.filter((one) => one !== id),
  };
  save(next);
  return next;
}

/** 这几个念过了他没要。**已经选中过的不记**(他挑过就是挑过,不该被一次「听听下一个」抹掉)。 */
function recordPassed(voiceIds) {
  const ids = normalizeIds(voiceIds);
  if (ids.length === 0) return read();
  const now = read();
  const fresh = ids.filter((one) => !now.picked.includes(one));
  if (fresh.length === 0) return now;
  const next = { picked: now.picked, passed: prepend(now.passed, fresh) };
  save(next);
  return next;
}

module.exports = { MAX_KEPT, filePath, read, recordPicked, recordPassed };
