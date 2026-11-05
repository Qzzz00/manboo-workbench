// 应声 —— **手机这一侧**(2026-10-02,卡「声音与形象跟着话走」第 5 件)。
//
// 这一组钉五件(ackAudio.ts 的四条纪律 + 那几声本身):
//   ① 他正说着、收到信号 → **当场放**(不再等:等已经在工人那头等过 2.4 秒了);
//   ② **他一停就不放**;正放着他停了 → 当场掐;
//   ③ **她一开口就掐**;
//   ④ 上一声还在放 → 不叠第二声;
//   ⑤ 那几声是 3~5 条、每条都短,而且 id 与工人的 ACK_LINE_IDS 逐字相同。
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ACK_LINES, createAckAudio, type AckSkipReason } from '../src/call/ackAudio';
import { FillerBag } from '../src/call/fillerAudio';
import { parseWbchInbound } from '../src/channel/channelProtocol';

function harness() {
  const played: string[] = [];
  const skipped: AckSkipReason[] = [];
  const stop = vi.fn();
  let settle: (() => void) | undefined;
  const audio = createAckAudio({
    play: () => new Promise<void>((resolve) => { settle = resolve; }),
    stop,
    onPlayed: (line) => played.push(line.id),
    onSkipped: (reason) => skipped.push(reason),
    // 牌堆钉死顺序:第一张就是表里第一条。
    bag: new FillerBag(ACK_LINES, () => 0),
  });
  return { audio, played, skipped, stop, finish: () => settle?.() };
}

describe('那几声', () => {
  it('3~5 条,每条都是短短一口,id 与工人那份逐字相同', () => {
    expect(ACK_LINES.length).toBeGreaterThanOrEqual(3);
    expect(ACK_LINES.length).toBeLessThanOrEqual(5);
    for (const line of ACK_LINES) expect(line.text.length).toBeLessThanOrEqual(4);
    const worker = readFileSync(join(process.cwd(), '..', 'channel-worker', 'src', 'backchannel.ts'), 'utf8');
    const listed = /export const ACK_LINE_IDS: readonly string\[\] = \[([^\]]+)\]/.exec(worker)?.[1] ?? '';
    const ids = [...listed.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
    expect(ACK_LINES.map((line) => line.id)).toEqual(ids);
  });
});

describe('他正说着 → 当场放', () => {
  it('放的是工人点名那一声', () => {
    const h = harness();
    h.audio.userSpeaking(true);
    h.audio.signal({ round: 1, line: 'ack-3' });
    expect(h.played).toEqual(['ack-3']);
  });

  it('没点名 / 点了一个认不得的 → 自己从牌堆挑', () => {
    const h = harness();
    h.audio.userSpeaking(true);
    h.audio.signal({ round: 1 });
    expect(h.played).toHaveLength(1);
    expect(ACK_LINES.map((line) => line.id)).toContain(h.played[0]);
  });
});

describe('**他一停就不放**', () => {
  it('信号到的时候他已经停口了 → 一声都不放', () => {
    const h = harness();
    h.audio.userSpeaking(true);
    h.audio.userSpeaking(false);
    h.audio.signal({ round: 1 });
    expect(h.played).toEqual([]);
    expect(h.skipped).toEqual(['he-stopped']);
  });

  it('压根没报过「他在说」(老接线)→ 也不放', () => {
    const h = harness();
    h.audio.signal({ round: 1 });
    expect(h.played).toEqual([]);
    expect(h.skipped).toEqual(['he-stopped']);
  });

  it('正放着他停了 → 当场掐', () => {
    const h = harness();
    h.audio.userSpeaking(true);
    h.audio.signal({ round: 1 });
    expect(h.stop).not.toHaveBeenCalled();
    h.audio.userSpeaking(false);
    expect(h.stop).toHaveBeenCalledTimes(1);
  });
});

describe('**她一开口就掐**', () => {
  it('她那条字幕到了 → 掐', () => {
    const h = harness();
    h.audio.userSpeaking(true);
    h.audio.signal({ round: 1 });
    h.audio.butlerSpoke();
    expect(h.stop).toHaveBeenCalledTimes(1);
  });

  it('没在放的时候掐一下也不出错', () => {
    const h = harness();
    h.audio.butlerSpoke();
    expect(h.stop).not.toHaveBeenCalled();
  });
});

describe('不叠第二声', () => {
  it('上一声还在放 → 跳过', () => {
    const h = harness();
    h.audio.userSpeaking(true);
    h.audio.signal({ round: 1, line: 'ack-1' });
    h.audio.signal({ round: 1, line: 'ack-2' });
    expect(h.played).toEqual(['ack-1']);
    expect(h.skipped).toEqual(['still-playing']);
  });

  it('上一声放完了,下一条照放', async () => {
    const h = harness();
    h.audio.userSpeaking(true);
    h.audio.signal({ round: 1, line: 'ack-1' });
    h.finish();
    await Promise.resolve();
    await Promise.resolve();
    h.audio.signal({ round: 1, line: 'ack-2' });
    expect(h.played).toEqual(['ack-1', 'ack-2']);
  });
});

describe('放不出来 / 拆掉', () => {
  it('音频放不出来 → 记一笔,不抛', async () => {
    const skipped: AckSkipReason[] = [];
    const audio = createAckAudio({
      play: () => Promise.reject(new Error('放不出来')),
      stop: () => {},
      onSkipped: (reason) => skipped.push(reason),
    });
    audio.userSpeaking(true);
    audio.signal({ round: 1 });
    await Promise.resolve();
    await Promise.resolve();
    expect(skipped).toEqual(['play-failed']);
  });

  it('dispose 之后一声都不放', () => {
    const h = harness();
    h.audio.userSpeaking(true);
    h.audio.dispose();
    h.audio.signal({ round: 1 });
    expect(h.played).toEqual([]);
  });
});

describe('信号那一条', () => {
  it('解析得出来;没有轮号就当没收到', () => {
    expect(parseWbchInbound(JSON.stringify({ type: 'backchannel', round: 3, at: 99, line: 'ack-2' })))
      .toEqual({ type: 'backchannel', round: 3, at: 99, line: 'ack-2' });
    expect(parseWbchInbound(JSON.stringify({ type: 'backchannel', at: 99 }))).toBeNull();
  });
});

describe('接线', () => {
  const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

  it('通话那一层收信号、按本机麦克风掐、她开口也掐', () => {
    const call = read('src/call/livekitCall.ts');
    expect(call).toContain('channel.onBackchannel');
    expect(call).toContain('ack?.userSpeaking(speaking)');
    expect(call).toContain('ack?.butlerSpoke()');
    // **不进字幕、不进纪要**:应声那一路不碰 transcript / onUtterance。
    expect(call).not.toContain('ack?.signal({ round: signal.round }); events.onUtterance');
  });

  it('按音色对齐那一路**不碰应声那几声**(进房不会一次打出十一条合成)', () => {
    expect(read('src/call/fillerVoiceCache.ts')).toContain('FILLER_VOICE_LINES');
    expect(read('src/call/fillerAudio.ts')).toContain("FILLER_LINES.filter((line) => line.kind !== 'ack')");
  });
});
