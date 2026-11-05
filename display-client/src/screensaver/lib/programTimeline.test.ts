import { describe, it, expect } from 'vitest';

import {
  resolveProgramPosition,
  resolveCurrentDaypart,
  splitDaypart,
  msSinceLocalMidnight,
  DAY_MS,
  type DayProgram,
  type Daypart,
  type ProgramItem,
} from './programTimeline';

function item(id: string, offset_ms: number, duration_ms: number, extra: Partial<ProgramItem> = {}): ProgramItem {
  return { id, kind: 'track', offset_ms, duration_ms, ncm_id: id, title: id, ...extra };
}

// 单时段铺满全天，块由 A(0..4000) + B(4000..10000) 组成，blockMs=10000
function loopingProgram(): DayProgram {
  return {
    date: '2026-06-07',
    dayparts: [
      {
        key: 'all_day',
        name: '全天',
        start_ms: 0,
        end_ms: DAY_MS,
        block_duration_ms: 10000,
        items: [item('A', 0, 4000), item('B', 4000, 6000)],
      },
    ],
  };
}

describe('resolveProgramPosition', () => {
  it('空节目单 / 无时段 → null', () => {
    expect(resolveProgramPosition(null, 0)).toBeNull();
    expect(resolveProgramPosition({ date: 'x', dayparts: [] }, 1000)).toBeNull();
  });

  it('块内第一项，seek = 块内偏移', () => {
    const pos = resolveProgramPosition(loopingProgram(), 2000)!;
    expect(pos.item.id).toBe('A');
    expect(pos.seekMs).toBe(2000);
    expect(pos.nextResolveInMs).toBe(2000); // A 还剩 2000ms
  });

  it('块内第二项，seek 落在 item 内', () => {
    const pos = resolveProgramPosition(loopingProgram(), 5000)!;
    expect(pos.item.id).toBe('B');
    expect(pos.seekMs).toBe(1000); // p=5000, B.offset=4000
    expect(pos.nextResolveInMs).toBe(5000); // B 还剩 6000-1000
  });

  it('循环：超过一个块长后按模回绕', () => {
    // p = 14000 % 10000 = 4000 → B 起点
    const pos = resolveProgramPosition(loopingProgram(), 14000)!;
    expect(pos.item.id).toBe('B');
    expect(pos.seekMs).toBe(0);
    // p = 23000 % 10000 = 3000 → A 内
    const pos2 = resolveProgramPosition(loopingProgram(), 23000)!;
    expect(pos2.item.id).toBe('A');
    expect(pos2.seekMs).toBe(3000);
  });

  it('时段边界封顶 nextResolveInMs', () => {
    const prog: DayProgram = {
      date: '2026-06-07',
      dayparts: [
        {
          key: 'tiny',
          name: '小时段',
          start_ms: 0,
          end_ms: 5000, // 5s 后切下一个时段
          block_duration_ms: 10000,
          items: [item('X', 0, 10000)],
        },
        { key: 'rest', name: '其余', start_ms: 5000, end_ms: DAY_MS, block_duration_ms: 3000, items: [item('Y', 0, 3000)] },
      ],
    };
    const pos = resolveProgramPosition(prog, 4000)!;
    expect(pos.item.id).toBe('X');
    expect(pos.seekMs).toBe(4000);
    // item 还剩 6000，但时段只剩 1000 → 取 1000
    expect(pos.nextResolveInMs).toBe(1000);
  });

  it('按 msOfDay 选中正确时段', () => {
    const prog: DayProgram = {
      date: '2026-06-07',
      dayparts: [
        { key: 'a', name: 'A段', start_ms: 0, end_ms: 21600000, block_duration_ms: 4000, items: [item('A', 0, 4000)] },
        { key: 'b', name: 'B段', start_ms: 21600000, end_ms: DAY_MS, block_duration_ms: 4000, items: [item('B', 0, 4000)] },
      ],
    };
    expect(resolveProgramPosition(prog, 1000)!.daypart.key).toBe('a');
    expect(resolveProgramPosition(prog, 21600000)!.daypart.key).toBe('b');
    expect(resolveProgramPosition(prog, 21600000 + 1000)!.daypart.key).toBe('b');
  });

  it('该时段无 item → null', () => {
    const prog: DayProgram = {
      date: '2026-06-07',
      dayparts: [{ key: 'empty', name: '空', start_ms: 0, end_ms: DAY_MS, block_duration_ms: 0, items: [] }],
    };
    expect(resolveProgramPosition(prog, 10000)).toBeNull();
  });

  it('msOfDay 落在时段缝隙（未覆盖）→ null', () => {
    const prog: DayProgram = {
      date: '2026-06-07',
      dayparts: [{ key: 'a', name: 'A', start_ms: 0, end_ms: 1000, block_duration_ms: 1000, items: [item('A', 0, 1000)] }],
    };
    expect(resolveProgramPosition(prog, 5000)).toBeNull();
  });
});

describe('msSinceLocalMidnight', () => {
  it('按本地时分秒毫秒折算', () => {
    const d = new Date(2026, 5, 7, 3, 44, 37, 500); // 本地 03:44:37.500
    expect(msSinceLocalMidnight(d)).toBe(3 * 3600000 + 44 * 60000 + 37 * 1000 + 500);
  });
});

describe('resolveCurrentDaypart', () => {
  const prog: DayProgram = {
    date: '2026-06-07',
    dayparts: [
      { key: 'a', name: 'A段', start_ms: 0, end_ms: 21600000, block_duration_ms: 0, items: [] },
      { key: 'b', name: 'B段', start_ms: 21600000, end_ms: DAY_MS, block_duration_ms: 0, items: [] },
    ],
  };
  it('按 msOfDay 命中时段', () => {
    expect(resolveCurrentDaypart(prog, 0)!.key).toBe('a');
    expect(resolveCurrentDaypart(prog, 21599999)!.key).toBe('a');
    expect(resolveCurrentDaypart(prog, 21600000)!.key).toBe('b');
  });
  it('空/缝隙 → null', () => {
    expect(resolveCurrentDaypart(null, 0)).toBeNull();
    expect(
      resolveCurrentDaypart({ date: 'x', dayparts: [{ key: 'a', name: 'A', start_ms: 0, end_ms: 1000, block_duration_ms: 0, items: [] }] }, 5000),
    ).toBeNull();
  });
});

describe('splitDaypart', () => {
  function tts(id: string, role?: string): ProgramItem {
    return { id, kind: 'tts', offset_ms: 0, duration_ms: 8000, audio_url: `/x/${id}.mp3`, role };
  }
  it('intro 取 role=intro 的口播，歌曲保序', () => {
    const dp: Daypart = {
      key: 'd', name: 'D', start_ms: 0, end_ms: DAY_MS, block_duration_ms: 0,
      items: [tts('greet', 'greet'), item('A', 0, 1000), tts('intro1', 'intro'), item('B', 0, 1000)],
    };
    const { intro, tracks } = splitDaypart(dp);
    expect(intro!.id).toBe('intro1');
    expect(tracks.map((t) => t.id)).toEqual(['A', 'B']);
  });
  it('无 intro 角色时退回第一条口播；无口播时 intro=null', () => {
    const dp1: Daypart = {
      key: 'd', name: 'D', start_ms: 0, end_ms: DAY_MS, block_duration_ms: 0,
      items: [tts('first'), item('A', 0, 1000)],
    };
    expect(splitDaypart(dp1).intro!.id).toBe('first');
    const dp2: Daypart = {
      key: 'd', name: 'D', start_ms: 0, end_ms: DAY_MS, block_duration_ms: 0,
      items: [item('A', 0, 1000), item('B', 0, 1000)],
    };
    expect(splitDaypart(dp2).intro).toBeNull();
    expect(splitDaypart(dp2).tracks.map((t) => t.id)).toEqual(['A', 'B']);
  });
});

describe('resolveCurrentDaypart：节目单缝隙回落', () => {
  // 复刻真机上抓到的形状：后端 focus 单在 11:00–14:00 整段没有时段。
  const H = 3600000;
  const gappy = {
    date: '2026-08-19',
    dayparts: [
      { key: 'late_night', name: '深夜电台', start_ms: 0, end_ms: 6 * H, block_duration_ms: 1, items: [{ id: 'a' }] },
      { key: 'morning', name: '早间唤醒', start_ms: 6 * H, end_ms: 11 * H, block_duration_ms: 1, items: [{ id: 'b' }] },
      { key: 'afternoon', name: '午后时光', start_ms: 14 * H, end_ms: 18 * H, block_duration_ms: 1, items: [{ id: 'c' }] },
    ],
  } as unknown as Parameters<typeof resolveCurrentDaypart>[0];

  it('落在时段内时照常返回该时段', () => {
    expect(resolveCurrentDaypart(gappy, 7 * H)?.key).toBe('morning');
  });

  it('默认行为不变：落在缝隙返回 null', () => {
    expect(resolveCurrentDaypart(gappy, 13 * H)).toBeNull();
  });

  it('开了回落：缝隙里接上「刚播完」的那个时段，而不是哑掉', () => {
    expect(resolveCurrentDaypart(gappy, 13 * H, { fallbackToNearest: true })?.key).toBe('morning');
  });

  it('早于所有时段时取最先开始的那个', () => {
    const late = {
      date: '2026-08-19',
      dayparts: [
        { key: 'afternoon', name: '午后', start_ms: 14 * H, end_ms: 18 * H, block_duration_ms: 1, items: [{ id: 'c' }] },
      ],
    } as unknown as Parameters<typeof resolveCurrentDaypart>[0];
    expect(resolveCurrentDaypart(late, 2 * H, { fallbackToNearest: true })?.key).toBe('afternoon');
  });

  it('所有时段都没曲目时仍然返回 null，不硬凑一个空时段', () => {
    const empty = {
      date: '2026-08-19',
      dayparts: [{ key: 'x', name: 'x', start_ms: 0, end_ms: H, block_duration_ms: 0, items: [] }],
    } as unknown as Parameters<typeof resolveCurrentDaypart>[0];
    expect(resolveCurrentDaypart(empty, 13 * H, { fallbackToNearest: true })).toBeNull();
  });
});
