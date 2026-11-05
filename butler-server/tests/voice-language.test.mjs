// 「这个音色会不会念中文」(2026-09-28,卡 VC)。
//
// 真机那一晚:电话里一路「换」下去,换到英文女声 Dacey / Stokie,从此每一句中文都
// `3011 TTSInvalidText: unsupported language`,他打过去一直没声音。
// 这一组钉住那条判断本身:中文的算会、英文的算不会、**判不出来的算「不知道」而不是「不会」**。
import { describe, expect, it } from 'vitest';
import { require } from './_setup.mjs';

const voiceLanguage = require('../server/services/voiceLanguage.cjs');
const catalog = require('../server/services/voices-catalog.json');

const byId = new Map(catalog.voices.map(v => [v.id, v]));

describe('speaksChinese', () => {
  it('★目录里那三个英文音色一律「不会」—— 就是它们让电话整通没声音', () => {
    for (const id of ['en_male_tim_uranus_bigtts', 'en_female_dacey_uranus_bigtts', 'en_female_stokie_uranus_bigtts']) {
      expect(voiceLanguage.speaksChinese(byId.get(id)), id).toBe(false);
    }
  });

  it('★中文音色会念中文(默认那个 vivi 在内)', () => {
    expect(voiceLanguage.speaksChinese(byId.get('zh_female_vv_uranus_bigtts'))).toBe(true);
    expect(voiceLanguage.speaksChinese(byId.get('saturn_zh_female_cancan_tob'))).toBe(true);
  });

  it('目录里 95 条中文音色一条都没被误判成「不会」', () => {
    const wrong = catalog.voices
      .filter(v => v.lang === '中文')
      .filter(v => voiceLanguage.speaksChinese(v) === false);
    expect(wrong).toEqual([]);
  });

  it('★一格都没有(复刻音色)→ undefined,**不当成「不会」**', () => {
    expect(voiceLanguage.speaksChinese({ id: 'S_abc123' })).toBeUndefined();
    expect(voiceLanguage.speaksChinese({ id: 'x', lang: '未标', accent: '未标' })).toBeUndefined();
  });

  it('标着多语种的算会念中文', () => {
    expect(voiceLanguage.speaksChinese({ lang: '多语种' })).toBe(true);
  });

  it('上游已经说了 speaks_chinese 就照它,不自己再推一遍', () => {
    expect(voiceLanguage.speaksChinese({ lang: '英文', speaks_chinese: true })).toBe(true);
    expect(voiceLanguage.speaksChinese({ lang: '中文', speaks_chinese: false })).toBe(false);
  });
});

describe('mark', () => {
  it('会 / 不会的贴上这一格,不知道的**不贴**(缺席就是不知道)', () => {
    const marked = voiceLanguage.mark([
      { id: 'a', lang: '中文' },
      { id: 'b', lang: '英文' },
      { id: 'c' },
    ]);
    expect(marked[0].speaks_chinese).toBe(true);
    expect(marked[1].speaks_chinese).toBe(false);
    expect('speaks_chinese' in marked[2]).toBe(false);
  });
});

describe('meansCannotSpeakChinese', () => {
  it('★真机那条原话认得出来', () => {
    expect(voiceLanguage.meansCannotSpeakChinese(
      'volcengine TTS HTTP 400 code=3011 TTSInvalidText: unsupported language',
    )).toBe(true);
  });

  it('没开通 / 额度用完 / 太挤都**不算**这一类(那三件事不该按语种处理)', () => {
    expect(voiceLanguage.meansCannotSpeakChinese('HTTP 403 requested resource not granted')).toBe(false);
    expect(voiceLanguage.meansCannotSpeakChinese('code=45000292 quota exceeded for types: text_words_lifetime')).toBe(false);
    expect(voiceLanguage.meansCannotSpeakChinese('code=3001 quota exceeded for types: concurrency')).toBe(false);
  });
});
