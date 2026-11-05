import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// pixi-live2d-display/cubism4 在 import 时就要 window.Live2DCubismCore;把 core 脚本喂进 jsdom 全局。
const core = readFileSync(resolve(__dirname, '../public/live2dcubismcore.min.js'), 'utf8');
(0, eval)(`${core};globalThis.Live2DCubismCore = Live2DCubismCore;`);

afterEach(() => {
  cleanup();
});

// jsdom 没有 matchMedia;竖屏为默认。
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  window.matchMedia = (query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; },
  }) as unknown as MediaQueryList;
}

// jsdom 没有 PointerEvent(「按住说话」全靠它)。补一个最小实现:只要 clientY 与 pointerId 能传进来就够测手势。
if (typeof window !== 'undefined' && typeof (window as unknown as { PointerEvent?: unknown }).PointerEvent !== 'function') {
  class PointerEventPolyfill extends MouseEvent {
    readonly pointerId: number;
    readonly pointerType: string;
    constructor(type: string, init: MouseEventInit & { pointerId?: number, pointerType?: string } = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
      this.pointerType = init.pointerType ?? 'touch';
    }
  }
  (window as unknown as { PointerEvent: unknown }).PointerEvent = PointerEventPolyfill;
  (globalThis as unknown as { PointerEvent: unknown }).PointerEvent = PointerEventPolyfill;
}
// jsdom 的指针捕获会对没按下的 pointerId 抛错;测试里不需要真捕获,给个空的。
if (typeof Element !== 'undefined') {
  Element.prototype.setPointerCapture = function setPointerCapture() {};
  Element.prototype.releasePointerCapture = function releasePointerCapture() {};
  Element.prototype.hasPointerCapture = function hasPointerCapture() { return false; };
}
