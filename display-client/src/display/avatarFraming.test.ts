/**
 * 展示台左栏 Live2D 形象的取景(2026-09-30 / 10-01)。
 *
 * 维护者第一句:「在左侧的位置保持居中,有背景的最好不要露出背景的边缘来,就是铺满,但是角色的显示上,主体要完整」。
 * 看了第一版效果图(10-01)纠正:「大部分都不太行,底部都是黑的,没有覆盖满;几个没有背景的,应该是小腿下半截
 * 在屏幕之外的……下面的八月十二是盖在上面的」。
 * 于是:有背景的铺满(黄历压在画面上;头顶在画面里 > 底部铺满 > 左右 > 顶边);角色头顶在画面里、小腿下半截可以出屏;没背景的同样放大到小腿出屏。
 */
import { describe, expect, it } from 'vitest';
import { LEG_CROP, backdropFor, frameAvatar, type FrameInput } from './avatarFraming';

function place(input: FrameInput, frame: { scale: number; x: number; y: number }, box: { x0: number; y0: number; x1: number; y1: number }) {
  const { w, h } = input.model;
  return {
    left: frame.x + box.x0 * w * frame.scale,
    top: frame.y + box.y0 * h * frame.scale,
    right: frame.x + box.x1 * w * frame.scale,
    bottom: frame.y + box.y1 * h * frame.scale,
  };
}

const PHONE = { view: { w: 288, h: 393 } };
const DESK = { view: { w: 396, h: 800 } };
const EPS = 0.5;

describe('没有背景的形象(纯角色)', () => {
  const input: FrameInput = { ...PHONE, model: { w: 1000, h: 2000 }, subject: { x0: 0.1, y0: 0, x1: 0.9, y1: 1 }, backdrop: null };
  it('★头顶在画面里、左右居中', () => {
    const s = place(input, frameAvatar(input), input.subject);
    expect(s.top).toBeGreaterThanOrEqual(-EPS);
    expect(Math.abs((s.left + s.right) / 2 - 144)).toBeLessThan(1);
  });
  it('★放大到小腿下半截出屏(不是整个人缩在上面一小块)', () => {
    const s = place(input, frameAvatar(input), input.subject);
    const height = s.bottom - s.top;
    expect(s.bottom).toBeGreaterThan(393);
    expect((393 - s.top) / height).toBeGreaterThanOrEqual(1 - LEG_CROP - 0.02);
    expect((393 - s.top) / height).toBeLessThan(1);
  });
  it('★坐姿 / 很宽的角色(九尾狐、三花猫)也按高度放大,两侧可以出屏 —— 不再缩在上半截「飘在半空」(10-01)', () => {
    const wide: FrameInput = { ...input, model: { w: 2000, h: 1000 } };
    const s = place(wide, frameAvatar(wide), wide.subject);
    expect(s.top).toBeGreaterThanOrEqual(-EPS);
    expect(s.bottom).toBeGreaterThan(393);
    expect(Math.abs((s.left + s.right) / 2 - 144)).toBeLessThan(1);
  });
  it('★legCrop = 0:主体框只框到「必须露出来的那段」(坐姿框到大腿),它的下沿贴住画面底 —— 不再悬在半空(10-01 第四轮)', () => {
    const seated: FrameInput = { ...input, subject: { x0: 0.15, y0: 0.03, x1: 0.85, y1: 0.6 }, legCrop: 0 };
    const s = place(seated, frameAvatar(seated), seated.subject);
    expect(s.top).toBeGreaterThanOrEqual(-EPS);
    expect(Math.abs(s.bottom - 393)).toBeLessThan(1);
  });
  it('还可以再放大一档(zoom):头顶仍在画面里', () => {
    const base = frameAvatar(input);
    const z = frameAvatar({ ...input, zoom: 1.3 });
    expect(z.scale).toBeCloseTo(base.scale * 1.3);
    expect(place(input, z, input.subject).top).toBeGreaterThanOrEqual(-EPS);
  });
});

describe('带场景背景的形象', () => {
  const scene: FrameInput = {
    ...PHONE, model: { w: 1000, h: 1000 },
    subject: { x0: 0.3, y0: 0.2, x1: 0.55, y1: 0.85 },
    backdrop: { x0: 0.15, y0: 0.1, x1: 0.85, y1: 0.9 },
  };
  function covers(input: FrameInput) {
    const f = frameAvatar(input);
    const b = place(input, f, input.backdrop!);
    return b.left <= EPS && b.top <= EPS && b.right >= input.view.w - EPS && b.bottom >= input.view.h - EPS;
  }
  it('★场景够大时四边铺满,底部不露黑(手机、桌面)', () => {
    expect(covers(scene)).toBe(true);
    expect(covers({ ...scene, ...DESK })).toBe(true);
  });
  it('★场景够高时角色头顶在画面里', () => {
    for (const input of [scene, { ...scene, ...DESK }]) {
      const s = place(input, frameAvatar(input), input.subject);
      expect(s.top).toBeGreaterThanOrEqual(-EPS);
    }
  });
  it('★场景上半截不规则(四边全铺就得切头)时:头顶保住、底部照样铺满,顶边 / 左右让出来', () => {
    // 不透明区从 0.45 才开始,角色头在 0.1。
    const low: FrameInput = { ...scene, subject: { x0: 0.4, y0: 0.1, x1: 0.8, y1: 0.9 }, backdrop: { x0: 0.4, y0: 0.45, x1: 0.85, y1: 0.9 } };
    const f = frameAvatar(low);
    const b = place(low, f, low.backdrop!);
    const s = place(low, f, low.subject);
    expect(s.top).toBeGreaterThanOrEqual(-EPS);
    expect(b.bottom).toBeGreaterThanOrEqual(393 - EPS);
  });
  it('★手动微调(nudge,按画框比例):往右下挪,底部仍铺满(61 和服长椅「整体要朝右朝下」)', () => {
    const base = frameAvatar(scene);
    const moved = frameAvatar({ ...scene, nudge: { x: 0.08, y: 0.05 } });
    expect(moved.x).toBeGreaterThan(base.x);
    expect(moved.y).toBeGreaterThanOrEqual(base.y);
    expect(place(scene, moved, scene.backdrop!).bottom).toBeGreaterThanOrEqual(393 - EPS);
  });
  it('角色尽量左右居中(背景够宽时)', () => {
    const s = place(scene, frameAvatar(scene), scene.subject);
    expect(Math.abs((s.left + s.right) / 2 - 144)).toBeLessThan(3);
  });
  it('画框量不出尺寸(0)时不给 NaN', () => {
    const f = frameAvatar({ ...scene, view: { w: 0, h: 0 } });
    expect(Number.isFinite(f.scale) && Number.isFinite(f.x) && Number.isFinite(f.y)).toBe(true);
  });
});

describe('按左栏宽高比挑背景框', () => {
  const set = { phone: { x0: 0.1, y0: 0.1, x1: 0.6, y1: 0.8 }, desk: { x0: 0.3, y0: 0.1, x1: 0.6, y1: 0.9 } };
  it('手机横屏左栏(288×393)用 phone 那一个,桌面左栏(396×800)用 desk 那一个', () => {
    expect(backdropFor(set, { w: 288, h: 393 })).toBe(set.phone);
    expect(backdropFor(set, { w: 396, h: 800 })).toBe(set.desk);
  });
  it('纯角色没有背景框', () => {
    expect(backdropFor(null, { w: 288, h: 393 })).toBeNull();
  });
});

describe('竖屏首页:半身(bust)', () => {
  // 10-01 维护者看竖屏首页:「竖屏只留上半身嘛,而且现在完全切断的也好丑啊」。竖屏那一格又宽又矮(390×~390),全身塞进去人很小。
  const WIDE = { view: { w: 390, h: 390 } };
  const tall: FrameInput = { ...WIDE, model: { w: 1000, h: 2000 }, subject: { x0: 0.1, y0: 0, x1: 0.9, y1: 1 }, backdrop: null, crop: 'bust' };
  it('★头顶在画面里,画面底边落在主体半高附近(头到腰),左右居中', () => {
    const f = frameAvatar(tall);
    const s = place(tall, f, tall.subject);
    expect(s.top).toBeGreaterThanOrEqual(-EPS);
    expect(s.top).toBeLessThan(390 * 0.1);
    const shown = (390 - s.top) / (s.bottom - s.top);
    expect(shown).toBeGreaterThan(0.4);
    expect(shown).toBeLessThan(0.6);
    expect((s.left + s.right) / 2).toBeCloseTo(195, 0);
  });
  it('★带背景的:照样四边铺满;不因为「背景底边要贴画面底」把人缩回全身', () => {
    const scene: FrameInput = { ...WIDE, model: { w: 1000, h: 1000 }, subject: { x0: 0.3, y0: 0.2, x1: 0.55, y1: 0.85 }, backdrop: { x0: 0.15, y0: 0.1, x1: 0.85, y1: 0.9 }, crop: 'bust' };
    const f = frameAvatar(scene);
    const b = place(scene, f, scene.backdrop!);
    expect(b.left <= EPS && b.top <= EPS && b.right >= 390 - EPS && b.bottom >= 390 - EPS).toBe(true);
    const s = place(scene, f, scene.subject);
    expect(s.top).toBeGreaterThanOrEqual(-EPS);
    expect(s.bottom).toBeGreaterThan(390 * 1.4);
  });
  it('横屏左栏那几个的手调(zoom / nudge)在半身里不用', () => {
    const a = frameAvatar(tall);
    expect(frameAvatar({ ...tall, zoom: 1.3, nudge: { x: 0.2, y: 0.1 } })).toEqual(a);
  });
  it('★坐姿(legCrop 0,主体框只到大腿)放下得多些 —— 不是只剩一颗头(10-01 九尾狐)', () => {
    const seated = { ...tall, legCrop: 0 };
    const s = place(seated, frameAvatar(seated), seated.subject);
    const shown = (390 - s.top) / (s.bottom - s.top);
    expect(shown).toBeGreaterThan(0.7);
    expect(shown).toBeLessThan(0.9);
  });
});
