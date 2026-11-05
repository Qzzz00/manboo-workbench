'use strict';

// 这个音色**会不会念中文**(2026-09-28,卡 VC)。
//
// ## 出事那一晚
//
// 维护者本机 19:2x 在电话里换音色:「给我换客服类的」→ 爽朗少年 →「换」→ 小何 →「换」→
// 小天 →「只要女生的再换」→ 工人换成了**英文女声 Dacey**(`en_female_dacey_uranus_bigtts`),
// 后来又到 **Stokie**。从那一刻起每一句中文都是:
//
//     volcengine TTS HTTP 400 code=3011 TTSInvalidText: unsupported language
//
// 开场白预合成 10 趟全失败,他打过去**一直没声音**,以为 TTS 坏了。
// 这不是音色没开通,也不是额度用完 —— 是**我们把一个只会念英文的嗓子换给了说中文的人**。
//
// ## 三条线,这个文件管前两条
//
//   ① 候选只给会念中文的(`speaksChinese` + `mark`);
//   ② 换之前**先拿一句中文真合一次**(`CHINESE_PROBE_TEXT` + `meansCannotSpeakChinese`),
//      合不出来就不换;
//   ③ 兜底退回上一个能用的音色 —— 那一条在工人那头(channel-worker/src/voiceRescue.ts)。
//
// ## 「会不会念中文」怎么判
//
// 目录(`voices-catalog.json`)里每条带 `lang` 与 `accent`,都是火山自己给的那一格:
// 95 条是「中文 / 普通话」,3 条是「英文 / 英语」(Tim、Dacey、Stokie),1 条「中文 / 未标」。
//
//   · lang / accent 里出现「中」「普通话」「多语」 → **会**;
//   · lang 是别的单一语种(英文 / 日文 / 韩文 / 西语…) → **不会**;
//   · 一格都没有(复刻音色 S_/BV、换了供应商) → **不知道**(undefined)。
//
// **「不知道」不是「不会」**:复刻音色多半就是中文的,凭这一格把它划掉等于凭空少掉半张表。
// 不知道的那些照给,但换之前那一句中文探针照试(见 routes/api/callVoice.cjs)。

const volcTtsErrors = require('./volcTtsErrors.cjs');

/**
 * 探针那一句。**要短**:每换一次音色就要花账号的字数,而它只用来问一件事
 * ——「这个嗓子念不念中文」。三个汉字就足够让火山回 3011。
 */
const CHINESE_PROBE_TEXT = '你好';

/** lang / accent 里出现这些字 = 会念中文。「多语种」按火山自己的写法也一并认。 */
const CHINESE_WORDS = /中文|中英|普通话|国语|汉语|mandarin|chinese|zh/i;
/** 明确是别的单一语种。认得出来才算「不会」,认不出来一律「不知道」。 */
const OTHER_LANG_WORDS = /英文|英语|日文|日语|韩文|韩语|西语|西班牙|法语|葡萄牙|俄语|德语|阿拉伯|印尼|越南|泰语|english|japanese|korean|spanish/i;
/** 标着多语种的:按「会念中文」算(火山的多语种音色都带中文)。 */
const MULTI_LANG_WORDS = /多语种|多语言|multi/i;

/** 标签缺席时目录里写的那两个字 —— 当成「没这一格」。 */
function meaningful(value) {
  const text = String(value == null ? '' : value).trim();
  return text === '' || text === '未标' ? '' : text;
}

/**
 * 这个音色会不会念中文。`true` / `false` / `undefined`(不知道)。
 *
 * 入参是一条 `{ lang, accent, speaks_chinese }`。`speaks_chinese` 已经有了就照它 ——
 * 上游(8792)说了算,这里不再自己推一遍。
 */
function speaksChinese(voice) {
  const one = voice || {};
  if (typeof one.speaks_chinese === 'boolean') return one.speaks_chinese;
  const lang = meaningful(one.lang);
  const accent = meaningful(one.accent);
  const both = `${lang} ${accent}`;
  if (MULTI_LANG_WORDS.test(both)) return true;
  if (CHINESE_WORDS.test(both)) return true;
  if (OTHER_LANG_WORDS.test(both)) return false;
  return undefined;
}

/** 一串音色挨个贴上 `speaks_chinese`。判不出来的**不贴这一格**(缺席就是「不知道」)。 */
function mark(voices) {
  return (voices || []).map((one) => {
    const known = speaksChinese(one);
    return known === undefined ? { ...one } : { ...one, speaks_chinese: known };
  });
}

/**
 * 这条报错是不是「这个嗓子念不了这段中文」那一类(火山 `3011 TTSInvalidText`)。
 * 表在 volcTtsErrors.cjs,**这里不抄第二份**。
 */
function meansCannotSpeakChinese(message) {
  return volcTtsErrors.explain(message).kind === 'text_rejected';
}

module.exports = {
  CHINESE_PROBE_TEXT,
  speaksChinese,
  mark,
  meansCannotSpeakChinese,
};
