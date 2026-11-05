/**
 * AIDJ 通勤播客的播放状态机(2026-09-22,src/feed/aidjModel.ts)。
 *
 * 全是纯函数,一行 DOM 都不碰。盯住四条:
 *   - **五种状态说五句不同的话**(能播 / 关着 / 还没生成 / 是昨天那期 / 连不上);
 *     一句「暂不可用」把它们糊在一起等于什么都没说;
 *   - **不循环** —— 它是一期节目,不是电台;
 *   - 没有音频的那一段**留着**,按字数停留照样往下走;
 *   - 时长前面那个「约」是真的:`estimated_total_ms` 是 Aiboo 按字数估的,不是真时长。
 *
 * 假数据照 2026-09-21 真取到的那份写(见 `docs/设计-资讯播客接AIDJ-2026-09-22.md` 第五节)。
 */
import { describe, expect, it } from 'vitest';
import {
  canPlay, clampIndex, dwellMs, fallbackNote, isFinished, isTextOnly, nextIndex, nextPlayableIndex,
  programTitle, progressLabel, segmentAt, topicAt, EMPTY_AIDJ,
  type AidjProgram, type AidjSegment, type AidjView,
} from '../src/feed/aidjModel';

function seg(over: Partial<AidjSegment> = {}): AidjSegment {
  return {
    id: 's1', speaker: '机车妹', text: '早啊各位!',
    audio_url: 'http://your-aiboo-host:3456/uploads/tts/a.mp3',
    duration_ms: 5500, tier: 'opening', topic_id: 't1', ...over,
  };
}

function program(over: Partial<AidjProgram> = {}): AidjProgram {
  return {
    date: '2026-09-21',
    status: 'ready',
    topics: [{ id: 't1', title: 'Gemini 安全测试', summary: '…', url: 'https://x.example/1', source: 'MarkTechPost' }],
    segments: [seg(), seg({ id: 's2', speaker: '刘飞', text: '先说第一条。', duration_ms: 4500 })],
    hosts: ['机车妹', '刘飞'],
    estimated_total_ms: 10000,
    ...over,
  };
}

function view(over: Partial<AidjView> = {}): AidjView {
  return { ...EMPTY_AIDJ, status: 'ready', program: program(), fetched_at: 1, ...over };
}

describe('canPlay / fallbackNote', () => {
  it('ready 且有段落才播', () => {
    expect(canPlay(view())).toBe(true);
    expect(fallbackNote(view())).toBeUndefined();
  });

  it('ready 但一段都没有 → 不播', () => {
    expect(canPlay(view({ program: program({ segments: [] }) }))).toBe(false);
  });

  it('关着 → 说是关着,不说"取不到"', () => {
    expect(fallbackNote(view({ status: 'off', program: undefined }))).toContain('关着');
  });

  it('今天还没生成 → 说清它每天早上 7 点跑', () => {
    const note = fallbackNote(view({ status: 'empty', program: undefined }));
    expect(note).toContain('7 点');
  });

  it('是昨天那期 → **原样带出服务端那句**(带日期)', () => {
    const note = fallbackNote(view({ status: 'stale', program: undefined, error: 'Aiboo 上最新的一期是 2026-09-20 的' }));
    expect(note).toBe('Aiboo 上最新的一期是 2026-09-20 的');
  });

  it('连不上 → 原样带出错误原话,不粉饰', () => {
    const note = fallbackNote(view({ status: 'error', program: undefined, error: '连不上 Aiboo(http://…):socket hang up' }));
    expect(note).toContain('socket hang up');
  });

  it('服务端没给原话时才用我们那句兜底', () => {
    expect(fallbackNote(view({ status: 'error', program: undefined }))).toContain('取不到');
  });
});

describe('按序播', () => {
  it('一段接一段', () => {
    const p = program();
    expect(nextIndex(p, 0)).toBe(1);
    expect(segmentAt(p, 1)?.speaker).toBe('刘飞');
  });

  it('**播完就停,不循环**(它是一期节目,不是电台)', () => {
    const p = program();
    expect(nextIndex(p, 1)).toBe(2);
    expect(isFinished(p, 2)).toBe(true);
    expect(nextIndex(p, 2)).toBe(2);
    expect(segmentAt(p, 2)).toBeUndefined();
  });

  it('下标越界(跳段连点)夹回合法范围', () => {
    const p = program();
    expect(clampIndex(p, -5)).toBe(0);
    expect(clampIndex(p, 99)).toBe(1);
    expect(clampIndex(program({ segments: [] }), 3)).toBe(0);
  });
});

describe('没有音频的那一段', () => {
  it('按字数停留,但不少于 2.6 秒', () => {
    expect(dwellMs(seg({ audio_url: undefined, text: '短', duration_ms: 0 }))).toBe(2600);
    const long = '这是一段很长的口播'.repeat(4);
    expect(dwellMs(seg({ audio_url: undefined, text: long, duration_ms: 0 }))).toBe(long.length * 170);
  });

  it('找下一段有音频的;整期都没有就 undefined', () => {
    const p = program({ segments: [seg({ audio_url: undefined }), seg({ id: 's2' })] });
    expect(nextPlayableIndex(p, 0)).toBe(1);
    expect(isTextOnly(p)).toBe(false);

    const none = program({ segments: [seg({ audio_url: undefined }), seg({ id: 's2', audio_url: undefined })] });
    expect(nextPlayableIndex(none, 0)).toBeUndefined();
    expect(isTextOnly(none)).toBe(true);
  });

  it('空节目不算「只有文字」(那是「没有节目」)', () => {
    expect(isTextOnly(program({ segments: [] }))).toBe(false);
  });
});

describe('显示的字', () => {
  it('标题带上几位主播', () => {
    expect(programTitle(program())).toBe('今天的资讯播客·机车妹 / 刘飞');
    expect(programTitle(program({ hosts: [] }))).toBe('今天的资讯播客');
  });

  it('进度是「第 n/N 段 · 约 x 分钟」——**「约」是因为那个数是 Aiboo 按字数估的**', () => {
    expect(progressLabel(program({ estimated_total_ms: 11 * 60_000 }), 0)).toBe('第 1/2 段 · 约 11 分钟');
  });

  it('估不出时长就只报段数,不编一个分钟数', () => {
    expect(progressLabel(program({ estimated_total_ms: 0 }), 1)).toBe('第 2/2 段');
  });

  it('播完之后进度停在最后一段,不显示「第 3/2 段」', () => {
    // 这份假数据只有 10 秒,四舍五入到 0 分钟 → 按上一条的规矩只报段数。
    expect(progressLabel(program(), 2)).toBe('第 2/2 段');
    expect(progressLabel(program({ estimated_total_ms: 11 * 60_000 }), 2)).toBe('第 2/2 段 · 约 11 分钟');
  });

  it('当前这一段在讲哪张卡片;没有 topic_id 就**不硬塞第一张**', () => {
    expect(topicAt(program(), 0)?.title).toBe('Gemini 安全测试');
    expect(topicAt(program({ segments: [seg({ topic_id: undefined })] }), 0)).toBeUndefined();
    expect(topicAt(program({ segments: [seg({ topic_id: '不存在' })] }), 0)).toBeUndefined();
  });
});
