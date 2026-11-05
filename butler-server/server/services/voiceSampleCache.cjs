'use strict';

// 样音缓存(2026-09-23,Ben:「要么就是你先播给他听」)。
//
// 电话里换音色,他要**先听见**才挑得动。听一个音色 = 用那个音色合一句固定的自我介绍。
// 合一句要 1~2 秒,三个就是四五秒 —— 第二次再来一遍同样的四五秒就纯属白等,
// 因为**这一句话是固定的**:同一个音色合出来的字节每次都一样。
//
// 所以这里把它落盘一次,以后秒出:
//
//     <uploads>/voice-samples/<provider_type>/<voice_id>/<sha1(文本)>.<encoding>
//
// ## 只缓存这一句
//
// 缓存的门是 {@link isSampleText}:**文本必须是 {@link SAMPLE_TEXT} 的一段**。
// 为什么不是「缓存所有 TTS」:那是个无底洞(每句话都不一样),而且电话里说过的话落盘
// 是另一件要他点头的事。这里只认死这一句,盘上最多 99 个音色 × 几段,顶天几兆。
//
// ## 为什么按「一段」而不是整句
//
// 工人那边是**按句合成**的(sentences.ts 会在逗号处切一刀),8792 收到的常常是
// 「老板你好,我是你的事务官,」这样的半句。所以门放宽成「是那一句里的一段」——
// 仍然有界(就这一句话的几种切法),又真的能命中。
//
// 缓存坏了(盘满、权限、文件被删)一律**当没缓存**:合一次就是了,绝不因为缓存把声音弄没。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { UPLOADS_BASE } = require('../db.cjs');

/**
 * 样音那一句。**固定不变** —— 变一次,盘上所有缓存一起失效(键里有它的 sha1)。
 * 写成自我介绍的口吻:他听的是「这个嗓子说话像不像回事」,不是内容。
 */
const SAMPLE_TEXT = '老板你好,我是你的事务官,平时就用这个声音跟你说话。';

function sampleDir() {
  return process.env.VOICE_SAMPLE_DIR
    ? path.resolve(process.env.VOICE_SAMPLE_DIR)
    : path.join(UPLOADS_BASE, 'voice-samples');
}

/** 这段文本值不值得缓存:**必须是样音那一句里的一段**(见文件头)。 */
function isSampleText(text) {
  const t = String(text || '').trim();
  if (t === '') return false;
  return SAMPLE_TEXT.includes(t);
}

function keyPath(providerType, voiceId, encoding, text) {
  const safeType = String(providerType || 'unknown').replace(/[^\w-]/g, '_');
  const safeVoice = String(voiceId || 'unknown').replace(/[^\w.-]/g, '_');
  const safeEnc = String(encoding || 'bin').replace(/[^\w]/g, '_');
  const hash = crypto.createHash('sha1').update(String(text), 'utf8').digest('hex').slice(0, 16);
  return path.join(sampleDir(), safeType, safeVoice, `${hash}.${safeEnc}`);
}

/** 盘上有就拿回来;没有 / 读不动 → undefined(调用方照常去合)。 */
function read(providerType, voiceId, encoding, text) {
  if (!isSampleText(text)) return undefined;
  try {
    const file = keyPath(providerType, voiceId, encoding, text);
    const buf = fs.readFileSync(file);
    return buf.length > 0 ? buf : undefined;
  } catch {
    return undefined;
  }
}

/** 落一份。**写不成不报错**(缓存是加速,不是功能);回 true/false 只给用例看。 */
function write(providerType, voiceId, encoding, text, buffer) {
  if (!isSampleText(text)) return false;
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return false;
  try {
    const file = keyPath(providerType, voiceId, encoding, text);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // 先写临时文件再改名:半截文件被当成完整样音播出去,是一段噪音。
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, buffer);
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/** 这个音色的样音**已经在盘上了吗**(给 `POST /api/voices/sample` 回一句实话用)。 */
function has(providerType, voiceId, encoding) {
  return read(providerType, voiceId, encoding, SAMPLE_TEXT) !== undefined;
}

module.exports = { SAMPLE_TEXT, isSampleText, read, write, has, sampleDir, keyPath };
