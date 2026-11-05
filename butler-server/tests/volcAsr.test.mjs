// 火山 ASR 二进制协议帧编解码(取材 Aiboo server/services/volcAsr.test.cjs,node:test → vitest)。不联网。
import { describe, expect, it } from 'vitest';
import zlib from 'node:zlib';
import { require, tempHome } from './_setup.mjs';

tempHome('volc-asr');
const { buildFrame, parseFrame, extractPcm, buildCorpus, DEFAULT_HOTWORDS, asrTimeoutMs } = require('../server/services/volcAsr.cjs');

const MSG_FULL_SERVER = 0b1001;
const FLAG_NEG_WITH_SEQUENCE = 0b0011;
const SER_JSON = 0b0001;
const COMP_GZIP = 0b0001;

describe('volcAsr 帧编解码', () => {
  it('buildFrame + parseFrame:gzip JSON + 序号往返一致', () => {
    const obj = { result: { text: '你好世界' } };
    const payload = zlib.gzipSync(Buffer.from(JSON.stringify(obj)));
    const frame = buildFrame({ messageType: MSG_FULL_SERVER, flags: FLAG_NEG_WITH_SEQUENCE, serialization: SER_JSON, compression: COMP_GZIP, sequence: -5, payload });
    const parsed = parseFrame(frame);
    expect(parsed.messageType).toBe(MSG_FULL_SERVER);
    expect(parsed.flags).toBe(FLAG_NEG_WITH_SEQUENCE);
    expect(parsed.json).toEqual(obj);
  });

  it('extractPcm:从 WAV 取 data 段;裸 PCM 原样', () => {
    const pcm = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
    const header = Buffer.alloc(44);
    header.write('RIFF', 0, 'ascii');
    header.writeUInt32LE(36 + pcm.length, 4);
    header.write('WAVE', 8, 'ascii');
    header.write('fmt ', 12, 'ascii');
    header.writeUInt32LE(16, 16);
    header.write('data', 36, 'ascii');
    header.writeUInt32LE(pcm.length, 40);
    expect(extractPcm(Buffer.concat([header, pcm]))).toEqual(pcm);
    expect(extractPcm(Buffer.from([9, 9, 9, 9]))).toEqual(Buffer.from([9, 9, 9, 9]));
  });

  it('本机版没有默认热词;调用方传的热词进 corpus.context(JSON 字符串),单字与重复跳过', () => {
    expect(DEFAULT_HOTWORDS).toEqual([]);
    expect(buildCorpus([])).toBeUndefined();
    const c = buildCorpus(['工作台', '火', '工作台', '事务官']);
    expect(typeof c.context).toBe('string');
    expect(JSON.parse(c.context).hotwords.map((h) => h.word)).toEqual(['工作台', '事务官']);
  });
});

describe('超时跟着音频长度走(2026-09-21:会议模式按 45 秒一段喂进来时,写死的 20 秒稳定超时)', () => {
  const secondsOf = (seconds) => seconds * 16000 * 2;

  it('短句照旧 20 秒 —— 通话那条路的行为一个字没变', () => {
    expect(asrTimeoutMs(secondsOf(1))).toBe(20000);
    expect(asrTimeoutMs(secondsOf(5))).toBe(20000);
    expect(asrTimeoutMs(0)).toBe(20000);
  });

  it('长段按 1.5 倍实时 + 10 秒放宽:41 秒的音频等到 71 秒', () => {
    expect(asrTimeoutMs(secondsOf(41))).toBe(71500);
    expect(asrTimeoutMs(secondsOf(55))).toBe(92500);
  });

  it('单调不减(音频越长,闸只会越松)', () => {
    let last = 0;
    for (let seconds = 0; seconds <= 60; seconds += 3) {
      const now = asrTimeoutMs(secondsOf(seconds));
      expect(now).toBeGreaterThanOrEqual(last);
      last = now;
    }
  });
});
