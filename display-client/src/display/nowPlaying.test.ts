/**
 * 展示台音乐卡上写什么(2026-09-30,维护者:「音乐和播客现在格式坏的」)。
 *
 * 复现:电台在放 DJ 口播段、或者通勤播客在放某位主播那一段时,`dj.playing` 是
 * `{ kind: 'tts', role, text }` —— **没有 title / artist**。展示台只认歌名,于是正在出声的时候
 * 卡片上写的是「未在播放 / —」。
 */
import { describe, expect, it } from 'vitest';
import { nowPlayingText } from './nowPlaying';

const track = { kind: 'track' as const, queue_item_id: 't1', title: '晴天', artist: '周杰伦', duration_ms: 269000 };
const djTalk = { kind: 'tts' as const, queue_item_id: 'd1', role: 'DJ', text: '接下来这首歌送给还在加班的你。', duration_ms: 8000 };
const hostLine = { kind: 'tts' as const, queue_item_id: 's3', role: '机车妹', text: '今天先聊千问办公那张小卡片,它想当 Agent 入口。', duration_ms: 9000 };

describe('音乐卡写什么', () => {
  it('放歌:歌名 + 歌手', () => {
    expect(nowPlayingText({ mode: 'focus', status: 'connected', playing: track })).toEqual({ title: '晴天', sub: '周杰伦', live: true });
  });
  it('★复现:电台 DJ 口播段 —— 不能写「未在播放」,写谁在说、说什么', () => {
    const text = nowPlayingText({ mode: 'focus', status: 'connected', playing: djTalk });
    expect(text.title).not.toBe('未在播放');
    expect(text.live).toBe(true);
    expect(text.title).toBe('DJ 在说');
    expect(text.sub).toBe('接下来这首歌送给还在加班的你。');
  });
  it('★复现:通勤播客某位主播那一段 —— 标题是在聊的那张话题卡,下一行「主播:原话」', () => {
    const text = nowPlayingText({
      mode: 'commute', status: 'connected', playing: hostLine, currentTopicId: 'k1',
      topics: [{ id: 'k1', title: '千问办公这张小卡片,成为了Agent入口?' }],
    });
    expect(text).toEqual({ title: '千问办公这张小卡片,成为了Agent入口?', sub: '机车妹:今天先聊千问办公那张小卡片,它想当 Agent 入口。', live: true });
  });
  it('通勤播客没有对得上的话题卡:标题写「通勤播客」', () => {
    expect(nowPlayingText({ mode: 'commute', status: 'connected', playing: hostLine }).title).toBe('通勤播客');
  });
  it('没在出声时如实说为什么:播客还在准备 / 本期播完 / 节目单还没生成 / 连不上电台', () => {
    expect(nowPlayingText({ mode: 'commute', status: 'connected', playing: null, segment: { title: '通勤播客准备中…' } }))
      .toEqual({ title: '通勤播客准备中…', sub: '播客', live: false });
    expect(nowPlayingText({ mode: 'focus', status: 'connected', playing: null }).title).toBe('今天的节目单还没生成好');
    expect(nowPlayingText({ mode: 'focus', status: 'connecting', playing: null }).title).toBe('在连电台…');
    expect(nowPlayingText({ mode: 'focus', status: 'error', playing: null }).title).toBe('电台连不上');
  });
  it('歌名缺了也不写空:退回口播原话或「在放」', () => {
    expect(nowPlayingText({ mode: 'focus', status: 'connected', playing: { kind: 'track', queue_item_id: 'x', duration_ms: 1 } }).title).toBe('在放');
  });
});
