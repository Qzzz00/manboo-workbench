'use strict';

// **音色单按这个账号实取**(2026-09-27,卡 VO)。维护者原话:
// 「我现在已经正式开通了,音色列表是全的,你最好重新去取一遍,而不是只靠记忆做事。」
//
// ## 在这之前是什么样
//
// `volcVoiceCatalog.json` 是一份**静态表**,99 条全写着 `supported: true` ——
// 那是按记忆/老控制台抄的,不是按账号取的。于是 2026-09-26 出过这么一天:
// 她在电话里报出「知性灿灿」,换过去,下一句一个字都没有(那一档当时没开通,
// 火山回 `45000292`)。**列一个换不成的名字,比少列一个更糟**。
//
// ## 现在怎么取
//
// 火山**没有**「列出本账号已开通的公版大模型音色」的官方接口(查证见
// docs/交接-0927-音色列表按账号实取.md 第一节;`ListMegaTTSTrainStatus` 只管声音复刻,
// 而且要 AK/SK —— 这台机器上的钥匙是中转下发的 appid+token,压根没有 AK/SK)。
// 所以退到卡上写的那条后路:**对每个候选音色试合一句极短文本**,看火山回什么。
//
//   · 合成成功                      → 能用
//   · `not granted` / `45000292` 额度 → **不能用**,划掉,并记下一句人话(为什么、去哪开)
//   · 并发 / 网络 / 语种不对 / 看不懂 → **这次没问出来**,不划掉(volcTtsErrors.meansInconclusive)
//
// 探针那句话**按音色的语种挑**(PROBE_TEXT_BY_LANG)。09-27 第一次实取时拿中文去喂
// 三个英文音色(Tim / Dacey / Stokie),火山回 `3011 TTSInvalidText:unsupported language` ——
// 那不是「没开通」,是我们问错了。这一条是那次实取直接换来的。
//
// ## 结果怎么存
//
// 一份 JSON 落在 BUTLER_HOME 下(`voice-availability.json`),**带取的时刻**。
// 读的时候三种口径,一句都不含糊:
//
//   · 取到过且没过期 → 只列取回来能用的;
//   · 取到过但过期了 → 照列,**说明是上次几点取的**,同时在后台重取一遍;
//   · 一次都没取到   → 列静态表,**明说「这次没取到」**,不假装它是实取的。
//
// 这一份里**没有任何密钥**:只有音色 id、能不能用、为什么不能用。

const fs = require('node:fs');
const path = require('node:path');
const { DB_PATH } = require('../db.cjs');
const volcTtsErrors = require('./volcTtsErrors.cjs');

/** 多久算过期 —— 过期只是「顺手再取一遍」,不是「不许用」。 */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * 探针那一句,**按语种**。挑短的:一次实取要跑几十上百条,每条都要花账号的字数。
 * 语种取自目录里的 `lang`(火山自己给的),认不出来的用 `default`(中文)。
 */
const PROBE_TEXT_BY_LANG = {
  zh: '你好',
  en: 'Hello.',
  ja: 'こんにちは',
  ko: '안녕하세요',
  es: 'Hola.',
  default: '你好',
};

function probeTextFor(lang) {
  const key = String(lang || '').trim().toLowerCase().split(/[-_]/)[0];
  return PROBE_TEXT_BY_LANG[key] || PROBE_TEXT_BY_LANG.default;
}

function stateFile() {
  return process.env.VOICE_AVAILABILITY_FILE
    ? path.resolve(process.env.VOICE_AVAILABILITY_FILE)
    : path.join(path.dirname(DB_PATH), 'voice-availability.json');
}

/** 盘上那一份。没有 / 坏了 / 形状不对 → undefined,**永不抛**(取不到只是「这次没取到」)。 */
function read() {
  try {
    const raw = fs.readFileSync(stateFile(), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return undefined;
    if (typeof parsed.fetched_at !== 'string' || !parsed.voices || typeof parsed.voices !== 'object') return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/** 落盘。写不成只记一行,**不抛**:实取的结果丢了顶多下次再取一遍。 */
function write(state) {
  try {
    const file = stateFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    return true;
  } catch (err) {
    console.warn('[butler-server] 音色实取结果没落盘', { message: (err && err.message) || '没说原因' });
    return false;
  }
}

/** 测试与「重取一次」用:把盘上那份扔了。只删自己写的那一个文件。 */
function clear() {
  try { fs.rmSync(stateFile(), { force: true }); } catch { /* 删不掉就算了 */ }
}

function isStale(state, now = Date.now()) {
  if (!state) return true;
  const at = Date.parse(state.fetched_at);
  return !Number.isFinite(at) || now - at > MAX_AGE_MS;
}

/** 取的那一刻,说成人话(「上次 10:24 取到的」里的那个时刻)。 */
function fetchedAtLabel(state) {
  if (!state) return undefined;
  const at = new Date(state.fetched_at);
  if (Number.isNaN(at.getTime())) return undefined;
  const pad = (n) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

// ── 实取 ────────────────────────────────────────────────────────────────────

/** 同一时刻只跑一趟(两个页面同时打开会同时来敲)。 */
let inflight;
/** 跑到哪儿了(给「正在重取」那一格)。 */
let progress;

/**
 * 真的去取一遍。
 *
 * @param {object} args
 * @param {object} args.provider    已经解析好的 TTS 供应商(带 config)。这里**不读也不记**它的 config。
 * @param {Array}  args.catalog     候选音色,形如 `[{ id, name, lang, scene }]`。
 * @param {Function} args.synthesize `({ provider, text, voice, encoding }) => Promise<{buffer}>`。
 * @param {Function} [args.now]
 * @returns {Promise<object>} 新的 state(已落盘)。
 */
async function refresh({ provider, catalog, synthesize, now = Date.now }) {
  if (inflight) return inflight;
  const started = now();
  progress = { done: 0, total: catalog.length, started_at: new Date(started).toISOString() };
  inflight = (async () => {
    const voices = {};
    let ok = 0;
    let unavailable = 0;
    let inconclusive = 0;
    for (const item of catalog) {
      const text = probeTextFor(item.lang);
      try {
        await synthesize({ provider, text, voice: item.id, encoding: 'mp3' });
        voices[item.id] = { ok: true };
        ok += 1;
      } catch (err) {
        // 上游原话已经由调用方 redact 过(见 routes/admin/ttsVoices.cjs);这一层只分类。
        const message = (err && err.message) || '';
        const explained = volcTtsErrors.explain(message);
        if (volcTtsErrors.meansUnavailable(message)) {
          voices[item.id] = { ok: false, kind: explained.kind, why: volcTtsErrors.humanLine(message) };
          unavailable += 1;
        } else {
          // 没问出来 ≠ 不能用。照留在单子里,但标明这一条**没验上**。
          voices[item.id] = { ok: true, inconclusive: true, kind: explained.kind, why: volcTtsErrors.humanLine(message) };
          inconclusive += 1;
        }
      }
      progress = { ...progress, done: progress.done + 1 };
    }
    const state = {
      provider_type: provider.provider_type,
      fetched_at: new Date(started).toISOString(),
      method: 'probe',
      probe_note: '火山没有「列出本账号已开通音色」的接口,这一份是逐个试合一句极短文本取回来的。',
      // ok = 真合出声的;inconclusive = 这次没问出来(照列);unavailable = 划掉的。
      // listed = 单子上还剩几个 = ok + inconclusive。
      counts: { total: catalog.length, ok, inconclusive, unavailable, listed: ok + inconclusive },
      voices,
    };
    write(state);
    return state;
  })();
  try {
    return await inflight;
  } finally {
    inflight = undefined;
    progress = undefined;
  }
}

/** 这会儿正在重取吗(给回包里那一格)。 */
function refreshing() {
  return inflight === undefined ? undefined : { ...progress };
}

// ── 读:把静态目录裁成「取回来能用的」 ───────────────────────────────────────

/**
 * `{ voices, availability }`。
 *
 * - 取到过 → 只留 `ok` 的那些(`inconclusive` 的算 ok,理由见文件头);
 * - 没取到过 → 原样全给,`availability.fetched_at` 是 null,`note` 明说这次没取到。
 *
 * **永远不空手**:一次都没取到时给静态表 + 一句实话,总比电话里一个音色都报不出来强。
 */
function applyTo(providerType, voices, { state = read(), now = Date.now() } = {}) {
  const usable = state && state.provider_type === providerType ? state : undefined;
  if (!usable) {
    return {
      voices,
      availability: {
        fetched_at: null,
        method: null,
        note: '这次没取到这个账号真开通了哪些音色,下面列的是本地清单(可能有换不成的)。',
        ...(refreshing() === undefined ? {} : { refreshing: refreshing() }),
      },
    };
  }
  const kept = voices.filter((v) => {
    const row = usable.voices[v.id];
    // 实取那一份里没有这条(目录后来加的)→ 留着,但它不是「实取确认过」的。
    return row === undefined ? true : row.ok === true;
  });
  const stale = isStale(usable, now);
  const label = fetchedAtLabel(usable);
  return {
    voices: kept.map((v) => {
      const row = usable.voices[v.id];
      if (row === undefined) return { ...v, probed: false };
      return { ...v, probed: true, ...(row.inconclusive === true ? { probe_inconclusive: true } : {}) };
    }),
    availability: {
      fetched_at: usable.fetched_at,
      method: usable.method,
      counts: usable.counts,
      stale,
      note: stale
        ? `这次没取到,列的是上次 ${label} 取到的那一份(已经过期,正在后台重取)。`
        : `下面这些是 ${label} 向火山逐个试出来、这个账号真能用的。`,
      ...(refreshing() === undefined ? {} : { refreshing: refreshing() }),
    },
  };
}

module.exports = {
  MAX_AGE_MS,
  PROBE_TEXT_BY_LANG,
  probeTextFor,
  stateFile,
  read,
  write,
  clear,
  isStale,
  fetchedAtLabel,
  refresh,
  refreshing,
  applyTo,
};
