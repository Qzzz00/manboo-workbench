/**
 * 形象舞台的自救规则(10-01 维护者真机:「左右切换模型容易显示不出来,我现在是触发横屏竖屏之后才能恢复渲染,还出现过黑色剪影」)。
 */
import { describe, expect, it } from 'vitest';
import { createTextureLedger, isSameAvatar, isStalled } from './renderGuard';

describe('同一个形象不重载', () => {
  it('★id 与包地址都一样 = 同一个(来回快滑回到正在显示的那个,不该再载一份)', () => {
    expect(isSameAvatar({ id: 'moxi', base: 'a/' }, { id: 'moxi', base: 'a/' })).toBe(true);
  });
  it('下了新版(包地址变了)算不同', () => {
    expect(isSameAvatar({ id: 'moxi', base: 'a/' }, { id: 'moxi', base: 'b/' })).toBe(false);
    expect(isSameAvatar({ id: 'moxi', base: 'a/' }, { id: 'ougen_5', base: 'a/' })).toBe(false);
  });
});

describe('画面卡住了没有', () => {
  const base = { now: 10_000, visible: true, showing: true, lost: false, shownSince: 0 };
  it('★模型在上屏、页面可见,2.5 秒没画出一帧 = 卡住(要重建画布再载一次,不用等转屏)', () => {
    expect(isStalled({ ...base, lastFrameAt: 7_000 })).toBe(true);
    expect(isStalled({ ...base, lastFrameAt: 9_000 })).toBe(false);
  });
  it('★WebGL 上下文丢了 = 卡住', () => {
    expect(isStalled({ ...base, lastFrameAt: 9_999, lost: true })).toBe(true);
  });
  it('页面不可见 / 尺寸为 0(切到别的页)、粒子球、刚上屏不到 2.5 秒:不算', () => {
    expect(isStalled({ ...base, lastFrameAt: 0, visible: false })).toBe(false);
    expect(isStalled({ ...base, lastFrameAt: 0, showing: false })).toBe(false);
    expect(isStalled({ ...base, lastFrameAt: 0, shownSince: 9_000 })).toBe(false);
  });
});

describe('贴图记账(同一地址的贴图被缓存成同一份,谁都不能替别人销毁)', () => {
  it('★同一个模型同时载了两份(壳又递了一次列表),先作废的那份放手时不销毁 —— 另一份还在用(10-01 真机黑影的根因)', () => {
    const ledger = createTextureLedger<{ id: number }>();
    const t = { id: 1 };
    ledger.retain([t]);
    ledger.retain([t]);
    expect(ledger.release([t])).toEqual([]);
    expect(ledger.release([t])).toEqual([t]);
  });
  it('没人用了才销毁;同一份在一个模型里出现两次也只记一次', () => {
    const ledger = createTextureLedger<{ id: number }>();
    const a = { id: 1 };
    const b = { id: 2 };
    ledger.retain([a, a, b]);
    expect(ledger.release([a, a, b])).toEqual([a, b]);
    expect(ledger.release([a])).toEqual([]);
  });
});
