// 老 WebView 兼容补丁（如 Android 8.1 出厂 Chrome 61）。
// @vitejs/plugin-legacy 的 modernPolyfills 只补 ECMAScript（core-js）：globalThis、
// Promise.allSettled、Object.fromEntries、Array.flatMap、String.matchAll、structuredClone 等。
// 下面这些属于 Web 平台 API，不在 core-js 范围，需手动兜底。必须在任何业务代码前执行。
// AbortController / AbortSignal：Chrome 66+ 才有；apiClient 每次请求都 new AbortController()，
// Chrome 61 上会直接 ReferenceError 导致所有 API 请求（含登录）失败。此 polyfill 自带存在性守卫，
// 现代浏览器不受影响。必须最先引入。
import 'abortcontroller-polyfill/dist/abortcontroller-polyfill-only';
import ResizeObserverPolyfill from 'resize-observer-polyfill';
import { ReadableStream, WritableStream, TransformStream } from 'web-streams-polyfill';

// Streams API：TransformStream/ReadableStream/WritableStream 需 Chrome 67+，被依赖库用到
{
  const s = globalThis as unknown as Record<string, unknown>;
  if (typeof s.ReadableStream === 'undefined') s.ReadableStream = ReadableStream;
  if (typeof s.WritableStream === 'undefined') s.WritableStream = WritableStream;
  if (typeof s.TransformStream === 'undefined') s.TransformStream = TransformStream;
}

// ResizeObserver：Chrome 64+ 才有
if (typeof window !== 'undefined' && !('ResizeObserver' in window)) {
  (window as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverPolyfill;
}

// crypto.randomUUID：Chrome 92+ 才有；用 getRandomValues（Chrome 61 已支持）实现 RFC4122 v4
const g = globalThis as unknown as { crypto?: Crypto & { randomUUID?: () => string } };
if (g.crypto && typeof g.crypto.getRandomValues === 'function' && typeof g.crypto.randomUUID !== 'function') {
  g.crypto.randomUUID = function randomUUID() {
    const b = g.crypto!.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h: string[] = [];
    for (let i = 0; i < 16; i++) h.push((b[i] + 0x100).toString(16).slice(1));
    return `${h[0]}${h[1]}${h[2]}${h[3]}-${h[4]}${h[5]}-${h[6]}${h[7]}-${h[8]}${h[9]}-${h[10]}${h[11]}${h[12]}${h[13]}${h[14]}${h[15]}` as `${string}-${string}-${string}-${string}-${string}`;
  };
}
