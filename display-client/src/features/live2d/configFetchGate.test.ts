import { describe, expect, it } from 'vitest';
import { createConfigFetchGate } from './configFetchGate.ts';

function makeGate(cooldownMs = 10_000) {
  let t = 0;
  const gate = createConfigFetchGate({ cooldownMs, now: () => t });
  const advance = (ms: number) => { t += ms; };
  return { gate, advance, now: () => t };
}

describe('configFetchGate 并发闸门', () => {
  it('silent in-flight 期间手动 force 不被吞，而是排队补跑', () => {
    const { gate } = makeGate();
    // silent 登录同步开始跑
    expect(gate.submit({ targetId: 'a', force: false, silent: true })).toEqual({ kind: 'run' });
    // 用户在途双击 force → 不丢，登记排队
    expect(gate.submit({ targetId: 'a', force: true, silent: false })).toEqual({ kind: 'queue' });
    // 当前 run 结束 → 需要补跑一次
    expect(gate.settled('a')).toEqual({ rerun: true, silent: false });
  });

  it('同一角色在途期间连续双击只补跑一次，不并发打爆', () => {
    const { gate } = makeGate();
    gate.submit({ targetId: 'a', force: false, silent: true });
    gate.submit({ targetId: 'a', force: true, silent: false });
    gate.submit({ targetId: 'a', force: true, silent: false });
    gate.submit({ targetId: 'a', force: true, silent: false });
    // 补跑登记被覆盖，只 settle 出一次 rerun
    const settled = gate.settled('a');
    expect(settled).toEqual({ rerun: true, silent: false });
    // 补跑结束，不再有待补跑
    expect(gate.settled('a')).toEqual({ rerun: false, silent: false });
  });

  it('不同角色互不阻塞：A 在途时 B 的 force 直接 run', () => {
    const { gate } = makeGate();
    gate.submit({ targetId: 'a', force: false, silent: true });
    expect(gate.submit({ targetId: 'b', force: true, silent: false })).toEqual({ kind: 'run' });
  });

  it('冷却只挡非 force；force 永远 run', () => {
    const { gate, advance } = makeGate();
    gate.submit({ targetId: 'a', force: false, silent: true }); // run → 在途
    gate.settled('a'); // 完成本次，让出在途
    gate.markFetched('a'); // 冷却起点
    // 冷却期内 silent 被挡
    expect(gate.submit({ targetId: 'a', force: false, silent: true })).toEqual({ kind: 'skip', reason: 'cooldown' });
    // 冷却期内 force 直接 run
    expect(gate.submit({ targetId: 'a', force: true, silent: false })).toEqual({ kind: 'run' });
    gate.settled('a');
    // 冷却期过后 silent 恢复可跑
    advance(10_001);
    expect(gate.submit({ targetId: 'a', force: false, silent: true })).toEqual({ kind: 'run' });
  });

  it('排队补跑的 force 保留原 silent 语义（双击非静默）', () => {
    const { gate } = makeGate();
    gate.submit({ targetId: 'a', force: false, silent: true });
    gate.submit({ targetId: 'a', force: true, silent: false });
    const settled = gate.settled('a');
    expect(settled.rerun).toBe(true);
    expect(settled.silent).toBe(false);
  });
});
