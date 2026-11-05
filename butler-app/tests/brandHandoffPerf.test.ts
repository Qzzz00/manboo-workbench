/** @vitest-environment jsdom */
/**
 * 串联真机打点回报(手机,2026-09-24 第五轮):配对那一刻还没有通道 → 先攒着;会话开起来挂上发送器就送走;挂着时直接送。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setHandoffPerfSender, startBrandHandoff } from '../src/brand/brandHandoff';

afterEach(() => { setHandoffPerfSender(null); vi.useRealTimers(); vi.restoreAllMocks(); });

function stubCanvas() {
  const ctx = new Proxy({}, {
    get: (_, key) => key === 'createImageData' ? (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }) : () => {},
    set: () => true,
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
  (globalThis as { CanvasRenderingContext2D?: unknown }).CanvasRenderingContext2D ??= function Ctx() {};
}

describe('手机打点回报', () => {
  it('没有发送器时攒一份,挂上就送(side=phone);挂着时下一份直接送', () => {
    stubCanvas();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance'] });
    const first = startBrandHandoff(null);
    expect(first).not.toBeNull();
    vi.advanceTimersByTime(4000);
    const sent: { side: string }[] = [];
    setHandoffPerfSender(p => sent.push(p));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.side).toBe('phone');
    startBrandHandoff(null);
    vi.advanceTimersByTime(4000);
    expect(sent).toHaveLength(2);
  });
});
