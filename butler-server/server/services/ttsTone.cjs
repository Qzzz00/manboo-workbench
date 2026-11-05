'use strict';

// 语气 → 火山参数(2026-10-02,卡「声音与形象跟着话走」)。
//
// ## 为什么有这一份
//
// 工人从这一版起会在 `/api/tts` 与 `/api/tts/stream` 的 body 里带一格 `tone`
// (短列表的主人是 channel-worker/src/tts/tone.ts:calm / happy / care / sorry / urgent / soft / ask),
// 外加可选的一句 ≤20 字自然语言指令 `toneNote`。这个文件把那一格翻成火山认的三样:
//
//   · `audio_params.emotion`      —— 情绪枚举(V1 大模型音色与 2.0 音色同名那一格);
//   · `audio_params.emotion_scale`—— 强度 1–5(火山缺省 4);
//   · `additions.context_texts[0]`—— **一句自然语言的语气指令**,2.0 音色(seed-tts-2.0)专有。
//
// ## 三条纪律
//
//   ① **映射放配置,不写死**(STELLA #501 的做法)。表在 services/toneMap.json;
//      `BUTLER_TTS_TONE_MAP` 指向另一份 JSON 就整张换掉 —— 真机上调语气不改代码、不发版。
//   ② **没有对应就退回中性**:认不得的 tone → 三样全缺席,请求体与 10-01 逐字相同。
//      «缺席» 不是 `emotion: 'neutral'`:给不支持情绪的音色传一个值会让整段合成失败(3011 那一类)。
//   ③ **她写的那句指令优先**。`toneNote` 在的话就用它,不用表里那句 —— 表是缺省,她更具体。
//      长度在工人那头已经掐过(≤20 字),这里再掐一次:网上来的东西不信任。
//
// 纯函数 + 一次文件读。读不动 / 解不开就当**整张表没有**(所有 tone 都退回中性),
// 绝不抛 —— 一张配置文件坏掉不该让她说不出话。

const fs = require('node:fs');
const path = require('node:path');

/** 自然语言指令最多几个字。与 channel-worker/src/tts/tone.ts 的 `TONE_NOTE_MAX` 同一个数。 */
const TONE_NOTE_MAX = 20;

/** 火山的 `emotion_scale` 合法区间(文档:1–5,缺省 4)。 */
const SCALE_MIN = 1;
const SCALE_MAX = 5;

const DEFAULT_MAP_FILE = path.join(__dirname, 'toneMap.json');

let cached;

function mapFile() {
  const fromEnv = process.env.BUTLER_TTS_TONE_MAP;
  return typeof fromEnv === 'string' && fromEnv.trim() !== '' ? fromEnv.trim() : DEFAULT_MAP_FILE;
}

/** 整张表。读不动就是一张空表(= 所有语气都退回中性)。**绝不抛**。 */
function loadMap() {
  const file = mapFile();
  if (cached !== undefined && cached.file === file) return cached.table;
  let table = { tones: {}, defaultScale: undefined };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const tones = raw && typeof raw.tones === 'object' && raw.tones !== null ? raw.tones : {};
    table = {
      tones,
      defaultScale: clampScale(raw && raw.default_emotion_scale),
    };
  } catch (error) {
    // 缺省那一份是跟着代码走的,读不到基本只会是「有人把 BUTLER_TTS_TONE_MAP 指歪了」。
    console.warn('[butler-server] 语气映射表读不了,这一轮起所有语气退回中性', { file, message: error && error.message });
  }
  cached = { file, table };
  return table;
}

/** 测试与热改配置用:把缓存清掉,下一次重新读文件。 */
function reset() {
  cached = undefined;
}

function clampScale(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(SCALE_MAX, Math.max(SCALE_MIN, Math.round(n)));
}

function cleanNote(value) {
  if (typeof value !== 'string') return undefined;
  const said = value.trim();
  if (said === '' || said.length > TONE_NOTE_MAX) return undefined;
  return said;
}

/**
 * 语气 → 要往火山发的那三样。
 *
 * @param {string} [tone] 短列表 id(大小写与空白不计)。认不得 → 全缺席。
 * @param {string} [note] 她写的那一句 ≤20 字指令。在的话**盖掉**表里那句。
 * @returns {{emotion?: string, emotionScale?: number, contextText?: string}}
 */
function resolveTone(tone, note) {
  const said = typeof tone === 'string' ? tone.trim().toLowerCase() : '';
  const table = loadMap();
  const row = said === '' ? undefined : table.tones[said];
  const override = cleanNote(note);
  // 认不得这个语气:**连她写的那句指令也不用** —— 一句没有语气托底的指令上去,
  // 2.0 音色会按字面演,而那常常比中性更怪(「用试探的语气」配一句报错很诡异)。
  if (row === undefined || row === null || typeof row !== 'object') return {};
  const emotion = typeof row.emotion === 'string' && row.emotion.trim() !== '' ? row.emotion.trim() : undefined;
  const scale = emotion === undefined ? undefined : (clampScale(row.emotion_scale) ?? table.defaultScale);
  const contextText = override ?? cleanNote(row.context_text);
  return {
    ...(emotion === undefined ? {} : { emotion }),
    ...(scale === undefined ? {} : { emotionScale: scale }),
    ...(contextText === undefined ? {} : { contextText }),
  };
}

/** 这张表这会儿认得哪几个语气(给 /health 与诊断包看;**不含取值**,那是配置)。 */
function knownTones() {
  return Object.keys(loadMap().tones).sort();
}

module.exports = {
  resolveTone,
  knownTones,
  reset,
  TONE_NOTE_MAX,
  SCALE_MIN,
  SCALE_MAX,
  DEFAULT_MAP_FILE,
};
