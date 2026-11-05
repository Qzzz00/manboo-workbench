'use strict';

// 企业微信机器人的回调(2026-10-21,协作区阶段五;维护者定先接企微)。
//
// 机器人与今天的企微**窗口**适配(`im: 'wecom'`)是两条路:窗口读写是替她在她的企微里说;
// 机器人是群里的一个成员,群里 @它一句 = 建便签 / 派活(映射同频道设计稿 2.4),办完回执回群。
//
// ## 验签与加解密(企业微信「回调配置」那套)
//
//   msg_signature = sha1( sort([Token, timestamp, nonce, Encrypt]).join('') )
//   AESKey        = base64decode(EncodingAESKey + '=')         —— 32 字节;IV = AESKey 前 16 字节
//   明文           = 16 字节随机 | 4 字节网络序长度 | 消息 | ReceiveId,PKCS#7 按 32 字节补齐,AES-256-CBC
//
// 智能机器人(aibot)的消息体是 JSON(`{encrypt}` 外壳,解出来是 `{msgid, chatid, from:{userid}, text:{content}, response_url}`),
// ReceiveId 为空串;自建应用的外壳是 XML(`<Encrypt>`)。两种外壳都收,解出来只认 JSON 那种。
//
// ## 密钥只从中转环境变量读
//
// `RELAY_WECOM_TOKEN`、`RELAY_WECOM_ENCODING_AES_KEY`、`RELAY_WECOM_RECEIVE_ID`(可空)。
// 不进仓库、不进库、不进日志、不进任何回包;/health 只回「配了没有」。没配 → 回调 503。

const crypto = require('node:crypto');

function wecomConfigOf(env = process.env) {
  const token = typeof env.RELAY_WECOM_TOKEN === 'string' && env.RELAY_WECOM_TOKEN.trim() !== '' ? env.RELAY_WECOM_TOKEN.trim() : undefined;
  const aesKey = typeof env.RELAY_WECOM_ENCODING_AES_KEY === 'string' && env.RELAY_WECOM_ENCODING_AES_KEY.trim() !== ''
    ? env.RELAY_WECOM_ENCODING_AES_KEY.trim() : undefined;
  const receiveId = typeof env.RELAY_WECOM_RECEIVE_ID === 'string' ? env.RELAY_WECOM_RECEIVE_ID.trim() : '';
  return { token, aesKey, receiveId };
}

function wecomConfigured(config) {
  return config?.token !== undefined && config?.aesKey !== undefined && config.aesKey.length === 43;
}

function signatureOf(token, timestamp, nonce, encrypt) {
  return crypto.createHash('sha1').update([token, String(timestamp), String(nonce), String(encrypt)].sort().join(''), 'utf8').digest('hex');
}

function verifySignature(config, { signature, timestamp, nonce, encrypt }) {
  if (typeof signature !== 'string' || typeof encrypt !== 'string' || encrypt === '') return false;
  const expected = signatureOf(config.token, timestamp ?? '', nonce ?? '', encrypt);
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature.toLowerCase(), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function keyOf(aesKey) {
  const key = Buffer.from(`${aesKey}=`, 'base64');
  if (key.length !== 32) throw new Error('EncodingAESKey 不是 43 位');
  return key;
}

/** 解密。ReceiveId 对不上(配了的话)→ 抛错。 */
function decrypt(config, encrypt) {
  const key = keyOf(config.aesKey);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, key.subarray(0, 16));
  decipher.setAutoPadding(false);
  const raw = Buffer.concat([decipher.update(Buffer.from(encrypt, 'base64')), decipher.final()]);
  const pad = raw[raw.length - 1];
  if (pad < 1 || pad > 32) throw new Error('补位不对');
  const content = raw.subarray(16, raw.length - pad);
  const length = content.readUInt32BE(0);
  if (4 + length > content.length) throw new Error('长度不对');
  const message = content.subarray(4, 4 + length).toString('utf8');
  const receiveId = content.subarray(4 + length).toString('utf8');
  if (config.receiveId !== '' && receiveId !== config.receiveId) throw new Error('ReceiveId 不对');
  return message;
}

/** 加密(回包与测试用)。 */
function encrypt(config, message, random = crypto.randomBytes(16)) {
  const key = keyOf(config.aesKey);
  const body = Buffer.from(message, 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length, 0);
  const plain = Buffer.concat([random, len, body, Buffer.from(config.receiveId, 'utf8')]);
  const pad = 32 - (plain.length % 32);
  const padded = Buffer.concat([plain, Buffer.alloc(pad, pad)]);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, key.subarray(0, 16));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]).toString('base64');
}

/** 外壳里取密文:JSON `{encrypt}` 或 XML `<Encrypt><![CDATA[…]]></Encrypt>`。 */
function encryptOf(body) {
  if (body !== null && typeof body === 'object' && typeof body.encrypt === 'string') return body.encrypt;
  if (typeof body === 'string') {
    const m = /<Encrypt>\s*(?:<!\[CDATA\[)?([^<\]]+)(?:\]\]>)?\s*<\/Encrypt>/i.exec(body);
    if (m !== null) return m[1].trim();
    try { const parsed = JSON.parse(body); if (typeof parsed?.encrypt === 'string') return parsed.encrypt; }
    catch { /* 不是 JSON */ }
  }
  return undefined;
}

/** 群里 @机器人 时正文开头带「@机器人名 」,去掉。 */
function stripMention(content) {
  return String(content ?? '').replace(/^\s*(@\S+\s*)+/, '').trim();
}

/**
 * 一句话 → 做什么(机械规则,不经模型;同频道设计稿 2.4 的口径):
 *   「绑定 ABCD2345」      → 把这个群绑到绑定码对应的频道
 *   「派给 <名片名>:正文」 → agent.dispatch 到工作室里叫这个名字的 Agent 名片
 *   别的                   → 建便签(task.create 到绑定人的座机服务),同时在频道里留一条
 */
function commandOf(content) {
  const line = stripMention(content);
  let m = /^绑定\s*([A-Za-z0-9]{8})$/.exec(line);
  if (m !== null) return { kind: 'bind', code: m[1].toUpperCase() };
  m = /^派给\s*([^:：\s]+)\s*[:：]\s*([\s\S]+)$/.exec(line);
  if (m !== null) return { kind: 'dispatch', agent: m[1].trim(), text: m[2].trim() };
  if (line === '') return { kind: 'empty' };
  return { kind: 'note', text: line };
}

/** 便签标题 = 正文首句(同「单发 = 建待办」那一行)。 */
function firstSentence(value, max = 60) {
  const head = String(value).split(/[\n。！？!?]/)[0].trim() || String(value).trim();
  return head.length > max ? `${head.slice(0, max)}…` : head;
}

/** response_url 只认企微自己的域名(防有人借机器人回调让中转去打任意地址)。 */
function isWecomResponseUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (url.hostname === 'qyapi.weixin.qq.com' || url.hostname.endsWith('.weixin.qq.com'));
  }
  catch { return false; }
}

module.exports = {
  wecomConfigOf,
  wecomConfigured,
  signatureOf,
  verifySignature,
  decrypt,
  encrypt,
  encryptOf,
  stripMention,
  commandOf,
  firstSentence,
  isWecomResponseUrl,
};
