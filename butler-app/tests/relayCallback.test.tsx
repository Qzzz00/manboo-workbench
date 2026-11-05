/**
 * 「回话来了」那一通在手机这一侧(2026-09-27,卡 CB)。
 *
 * 维护者原话:「我在手机上问了事务官,理论上事务官去问了对应的 AI 之后,**事务官得回电话给我**。」
 *
 * 手机这一半要做三件事,这一份逐条钉:
 * ① 来电页上**说得出为什么打来**(「回话来了」),那一行小字说清接起来会发生什么;
 * ② **他没接的时候那句回话不能跟着电话一起消失** —— 未接来电里留着原话,首页那一行也看得到;
 * ③ 线上那条 `ring` 认得出这一类(老手机认不出就当没收到,不会乱弹一个来电页)。
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MissedCalls } from '../src/call/MissedCalls';
import {
  RING_REASON_HINTS,
  RING_REASON_TITLES,
  missedLatestText,
  missedSayText,
  parseCallLog,
  type CallLogView,
} from '../src/call/incomingModel';
import { parseWbchInbound } from '../src/channel/channelProtocol';

vi.mock('@capacitor/app', () => ({
  App: { getLaunchUrl: async () => ({ url: '' }), addListener: async () => ({ remove: async () => {} }) },
}));

const SAY = '你手机上让我捎的那句话,它回了。它的原话:正在写交接,大概还要十分钟';

function log(patch: Record<string, unknown> = {}): CallLogView {
  return parseCallLog({
    entries: [{
      id: 'c-1',
      reason: 'relay',
      item_id: 'relay:r-1a2b3c',
      title: 'Claude 「Desktop-workbench 统筹交接」',
      note: SAY,
      at: '2026-09-27T10:05:00.000Z',
      state: 'missed',
      ...patch,
    }],
    missed: 1,
    config: { done_call: false },
  });
}

describe('来电页:说得出为什么打来', () => {
  it('★理由那一行是「回话来了」,与工作台、与工人逐字相同', () => {
    expect(RING_REASON_TITLES.relay).toBe('回话来了');
  });

  it('那一行小字说清接起来会发生什么:听回话,不接也留得住', () => {
    expect(RING_REASON_HINTS.relay).toContain('回了什么');
    expect(RING_REASON_HINTS.relay).toContain('未接来电');
    // 不装作要他决定什么(这一通只是转述)
    expect(RING_REASON_HINTS.relay).not.toContain('批准');
  });

  it('线上那条 ring 认得出这一类(缺字段的照旧当没收到)', () => {
    const msg = parseWbchInbound(JSON.stringify({
      type: 'ring', call_id: 'c-1', reason: 'relay', item_id: 'relay:r-1', title: 'Claude 「统筹交接」', note: SAY, at: 'x', silent: false, until: 1,
    }));
    expect(msg).toMatchObject({ type: 'ring', reason: 'relay', note: SAY });
    expect(parseWbchInbound(JSON.stringify({ type: 'ring', call_id: 'c-1', reason: '乱写', title: 'x' }))).toBeNull();
  });
});

describe('★他没接:那句回话留在未接来电里', () => {
  it('未接那一行下面就是那边回的原话', () => {
    render(<MissedCalls log={log()} onCallBack={async () => ({ ok: true })} onClear={async () => ({ ok: true })} />);
    expect(screen.getByText('回话来了')).toBeTruthy();
    expect(document.querySelector('.ba-missed__say')?.textContent).toBe(SAY);
  });

  it('首页那一行(收着的那一条)也看得到原话', () => {
    // 只摆 missedLatestText 读的那几格;其余 CallLogEntry 字段它不看(类型上补齐,免得 tsc -b 把出包挡住)。
    const group = { reason: 'relay' as const, title: 'Claude 「统筹交接」', latest: { id: 'c-1', item_id: 'relay:r-1', title: 'Claude 「统筹交接」', at: '2026-09-27T03:00:00.000Z', state: 'missed', reason: 'relay' as const, note: SAY } } as Parameters<typeof missedLatestText>[0];
    expect(missedLatestText(group)).toBe(`最近:回话来了 Claude 「统筹交接」 · ${SAY}`);
  });

  it('别的几类没有这一行(它们的内容在事项上,不在电话里)', () => {
    expect(missedSayText({ reason: 'confirm', note: '两件交付物' })).toBeNull();
    expect(missedSayText({ reason: 'relay', note: '   ' })).toBeNull();
    render(<MissedCalls
      log={log({ reason: 'confirm', item_id: 't-1', title: '把首页文案改一版' })}
      onCallBack={async () => ({ ok: true })}
      onClear={async () => ({ ok: true })}
    />);
    expect(document.querySelector('.ba-missed__say')).toBeNull();
  });

  it('这一通回拨得了(不是「完成」那一类,服务端也不拒)', () => {
    render(<MissedCalls log={log()} onCallBack={async () => ({ ok: true })} onClear={async () => ({ ok: true })} />);
    expect(document.querySelector('.ba-missed__back')).toBeTruthy();
  });
});
