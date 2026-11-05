'use strict';

// 来源:Aiboo origin/main 7c55ce12 server/services/volcAsr.cjs
// 本机版改动:
//   1. 凭证不再读 settingsStore/env,改走 services/voiceCredentials.cjs(RTC 供应商的 asr* 字段 → 默认火山 TTS 的 appid/accessToken);
//   2. DEFAULT_HOTWORDS 清空:Aiboo 那份是掌机游戏术语(道馆/馆主…),事务官用不上;调用方仍可按次传 hotwords;
//   3. uid 改成 butler。协议帧编解码原样。

/**
 * 火山引擎「大模型流式语音识别」(sauc bigmodel) 一句话转写适配。
 *
 * 把一段完整 PCM(16k/16bit/单声道) 走 WebSocket 二进制协议发给火山，拿最终识别文字。
 * 协议：bytedance v3 双向流式。帧 = [4B header][?4B sequence][4B payloadSize][payload]。
 *
 * 凭证只从环境变量读，绝不硬编码/入库：
 *   VOLC_ASR_APP_ID / VOLC_ASR_ACCESS_TOKEN / VOLC_ASR_RESOURCE_ID(默认 volc.bigasr.sauc.duration)
 */

const zlib = require('node:zlib');
const crypto = require('node:crypto');
const WebSocket = require('ws');

// 地址可换,见 lib/endpoints.cjs。
const WS_URL = require('../lib/endpoints.cjs').volcAsrWsUrl();

// 消息类型(高 4 位)
const MSG_FULL_CLIENT = 0b0001;
const MSG_AUDIO_ONLY = 0b0010;
const MSG_FULL_SERVER = 0b1001;
const MSG_SERVER_ACK = 0b1011;
const MSG_SERVER_ERROR = 0b1111;
// 标志位(低 4 位)
const FLAG_POS_SEQUENCE = 0b0001; // 带正序号、非最后
const FLAG_NEG_WITH_SEQUENCE = 0b0011; // 带序号且为最后一包
// 序列化 / 压缩
const SER_JSON = 0b0001;
const SER_RAW = 0b0000;
const COMP_GZIP = 0b0001;

const PCM_CHUNK_BYTES = 16000 * 2 * 0.2; // 200ms @16k/16bit/mono = 6400 字节

function buildFrame({ messageType, flags, serialization, compression, sequence, payload }) {
  const header = Buffer.from([
    (0b0001 << 4) | 0b0001, // version=1, headerSize=1(=>4字节)
    (messageType << 4) | flags,
    (serialization << 4) | compression,
    0x00,
  ]);
  const parts = [header];
  if (flags === FLAG_POS_SEQUENCE || flags === FLAG_NEG_WITH_SEQUENCE) {
    const seqBuf = Buffer.alloc(4);
    seqBuf.writeInt32BE(sequence, 0);
    parts.push(seqBuf);
  }
  const sizeBuf = Buffer.alloc(4);
  sizeBuf.writeUInt32BE(payload.length, 0);
  parts.push(sizeBuf, payload);
  return Buffer.concat(parts);
}

/** 解析服务器帧 → { messageType, code, payload(Buffer|object) }。 */
function parseFrame(buf) {
  const headerSize = (buf[0] & 0x0f) * 4;
  const messageType = (buf[1] >> 4) & 0x0f;
  const flags = buf[1] & 0x0f;
  const compression = buf[2] & 0x0f;
  let offset = headerSize;

  let code = 0;
  if (messageType === MSG_SERVER_ERROR) {
    code = buf.readUInt32BE(offset);
    offset += 4;
  } else if (flags === FLAG_POS_SEQUENCE || flags === FLAG_NEG_WITH_SEQUENCE) {
    offset += 4; // 跳过 sequence
  }

  const size = buf.readUInt32BE(offset);
  offset += 4;
  let payload = buf.subarray(offset, offset + size);
  if (compression === COMP_GZIP && payload.length > 0) {
    try { payload = zlib.gunzipSync(payload); } catch { /* 原样 */ }
  }
  let json = null;
  try { json = JSON.parse(payload.toString('utf8')); } catch { /* 非 JSON */ }
  return { messageType, flags, code, json, raw: payload };
}

/** 从 WAV Buffer 取 PCM data 段（无 RIFF 头则原样当 PCM）。 */
function extractPcm(buf) {
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF') {
    let p = 12;
    while (p + 8 <= buf.length) {
      const id = buf.toString('ascii', p, p + 4);
      const sz = buf.readUInt32LE(p + 4);
      if (id === 'data') return buf.subarray(p + 8, p + 8 + sz);
      p += 8 + sz + (sz & 1);
    }
  }
  return buf;
}

/**
 * 领域热词 → 火山 corpus.context 的 JSON 串。
 *
 * 为什么要它（2026-07-31 Ben 真机）：ASR 把专有名词系统性听错——「道馆馆主」→
 * 「爆管转主」、「大钳蟹」→「大前蟹」、「佩雷市」→「佩雷斯」。专有名词一错，
 * 军师这边既检索不到、也答非所问。军师服务端已有一层同音纠错兜底
 * (strategist/server/app/chat/transcript.py)，但那是事后补救；热词是让 ASR
 * **一开始就别听错**，两者叠加。
 *
 * 格式（火山文档）：context 传 JSON **字符串**，形如
 *   {"hotwords":[{"word":"道馆"},{"word":"馆主"}]}
 * 上限 200 token，超出自动截断；直传优先级高于预注册词表 boosting_table_id。
 * ★这里按字符数保守裁剪：中文大致 1 字 ≈ 1 token，留足余量避免被静默截断
 * （被截断时火山不会报错，表现为「配了但没效果」，极难发现）。
 */
const HOTWORD_CHAR_BUDGET = 120;

// 本机版没有默认热词(Aiboo 那份是掌机游戏术语)。事务官要认的专有名词(项目名、人名)
// 由调用方按次经 hotwords 传入;以后要固定一份可以在这里加。
const DEFAULT_HOTWORDS = [];

function buildCorpus(extraHotwords = []) {
  const seen = new Set();
  const words = [];
  let chars = 0;
  const take = (list) => {
    for (const w of list) {
      const word = String(w || '').trim();
      // 单字热词会把大量同音字一起拉偏，火山文档也不建议；一律跳过。
      if (word.length < 2 || seen.has(word)) continue;
      // ★跳过而不是 break：后面可能还有更短的塞得下，没理由为一个长词把余量浪费掉。
      if (chars + word.length > HOTWORD_CHAR_BUDGET) continue;
      seen.add(word);
      words.push({ word });
      chars += word.length;
    }
  };
  // 顺序=优先级：游戏专属词更值钱（见下方测试）。通用词只占 39 字，
  // 而调用方那边（strategist/server/app/chat/hotwords.py）把专属词裁到了 75 字，
  // 两边加起来 114 < 预算，正常情况下谁也挤不掉谁。
  take(extraHotwords);
  take(DEFAULT_HOTWORDS);
  if (!words.length) return undefined;
  return { context: JSON.stringify({ hotwords: words }) };
}

/**
 * 等多久算超时。**跟着音频长度走**(2026-09-21 会议模式真跑量出来的)。
 *
 * 原来写死 20 秒。那对「一句话」够用(通话里一句最多几秒),但会议模式按 45 秒一段喂进来时
 * **稳定超时**:本机实测火山这条流式识别大约 0.55 倍实时 —— 41 秒的音频要 24 秒才出最终结果,
 * 20 秒的闸刚好把它切掉,表现是 502 asr_failed,而音频本身一点毛病都没有(同一段换短一点就过)。
 *
 * 现在:20 秒打底,再按「音频秒数 × 1.5 + 10 秒」取大的那个。
 * **短句的行为一个字没变** —— 几秒的音频算出来还是 20 秒。
 */
function asrTimeoutMs(pcmBytes) {
  const seconds = pcmBytes / (16000 * 2); // 16k / 16bit / mono
  return Math.max(20000, Math.round(seconds * 1500) + 10000);
}

function resolveCreds() {
  // 懒加载:纯帧编解码单测不触发 DB 打开。
  const { db } = require('../db.cjs');
  return require('./voiceCredentials.cjs').resolveAsrCreds(db);
}

/**
 * 转写一段音频。
 * @param {Buffer} audioBuffer WAV 或裸 PCM(16k/16bit/mono)
 * @param {object} [creds]
 * @returns {Promise<string>} 识别文字；空结果抛 Error('EMPTY_TRANSCRIPT')
 */
function transcribe(audioBuffer, creds = resolveCreds(), hotwords = []) {
  const { appId, accessToken, resourceId } = creds;
  if (!appId || !accessToken) {
    return Promise.reject(new Error('VOLC_ASR credentials not configured'));
  }
  const pcm = extractPcm(audioBuffer);

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL, {
      headers: {
        'X-Api-App-Key': appId,
        'X-Api-Access-Key': accessToken,
        'X-Api-Resource-Id': resourceId,
        'X-Api-Request-Id': crypto.randomUUID(),
        'X-Api-Connect-Id': crypto.randomUUID(),
      },
    });

    let finalText = '';
    let settled = false;
    const done = (err, text) => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch { /* ignore */ }
      if (err) reject(err);
      else if (text) resolve(text);
      else reject(new Error('EMPTY_TRANSCRIPT'));
    };
    const graceMs = asrTimeoutMs(pcm.length);
    const timer = setTimeout(() => done(new Error(`ASR 超时(等了 ${Math.round(graceMs / 1000)} 秒)`)), graceMs);

    ws.on('open', () => {
      const reqJson = {
        user: { uid: 'butler' },
        audio: { format: 'pcm', rate: 16000, bits: 16, channel: 1 },
        request: {
          model_name: 'bigmodel', enable_itn: true, enable_punc: true, result_type: 'full',
          // 领域热词：见 buildCorpus。没有热词时整个字段省略，不发空 corpus。
          ...(buildCorpus(hotwords) ? { corpus: buildCorpus(hotwords) } : {}),
        },
      };
      const gz = zlib.gzipSync(Buffer.from(JSON.stringify(reqJson)));
      ws.send(buildFrame({
        messageType: MSG_FULL_CLIENT, flags: FLAG_POS_SEQUENCE,
        serialization: SER_JSON, compression: COMP_GZIP, sequence: 1, payload: gz,
      }));

      // 分片发 PCM
      let seq = 1;
      for (let off = 0; off < pcm.length; off += PCM_CHUNK_BYTES) {
        const chunk = pcm.subarray(off, off + PCM_CHUNK_BYTES);
        const isLast = off + PCM_CHUNK_BYTES >= pcm.length;
        seq += 1;
        ws.send(buildFrame({
          messageType: MSG_AUDIO_ONLY,
          flags: isLast ? FLAG_NEG_WITH_SEQUENCE : FLAG_POS_SEQUENCE,
          serialization: SER_RAW, compression: COMP_GZIP,
          sequence: isLast ? -seq : seq,
          payload: zlib.gzipSync(chunk),
        }));
      }
    });

    ws.on('message', (data) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      const { messageType, flags, code, json } = parseFrame(buf);
      if (messageType === MSG_SERVER_ERROR) {
        clearTimeout(timer);
        return done(new Error(`火山 ASR 错误(${code}): ${json?.message || ''}`));
      }
      if (messageType === MSG_FULL_SERVER || messageType === MSG_SERVER_ACK) {
        const text = json?.result?.text;
        if (typeof text === 'string' && text) finalText = text;
        if (flags === FLAG_NEG_WITH_SEQUENCE) {
          clearTimeout(timer);
          return done(null, finalText);
        }
      }
    });

    ws.on('error', (err) => { clearTimeout(timer); done(new Error(`火山 ASR 连接失败: ${err.message}`)); });
    ws.on('close', () => { clearTimeout(timer); done(null, finalText); });
  });
}

module.exports = { transcribe, extractPcm, buildFrame, parseFrame, resolveCreds, buildCorpus, DEFAULT_HOTWORDS, asrTimeoutMs };
