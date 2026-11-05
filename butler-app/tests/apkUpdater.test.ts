/**
 * 在 App 里下载并装上新手机包(2026-10-03,卡 claude/phone-in-app-update)。
 *
 * 真下载、真算 sha256、真调起系统安装器都在原生那件插件里
 * (android/app/src/main/java/ai/ben/butler/ApkUpdatePlugin.java)。这一份钉的是**外壳的判断**:
 * 没原生桥怎么说、校验码对不上**绝不往下走**、没给安装权限时说什么、进度怎么往上报。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  APK_UPDATE_NEED_PERMISSION_CODE,
  APK_UPDATE_NO_NATIVE_TEXT,
  downloadAndInstall,
  readApkInfo,
  type ApkUpdateNative,
} from '../src/update/apkUpdater';
import { PHONE_UPDATE_NEED_PERMISSION_TEXT, PHONE_UPDATE_SHA_MISMATCH_TEXT } from '../src/update/phoneUpdate';

const SHA = 'a'.repeat(64);
const OFFER = { version: '0.4.91', url: 'https://api.aibooo.cn/updates/0.4.91/app.apk', size: 33_554_432, sha256: SHA };

function fakeNative(over: Partial<ApkUpdateNative> = {}): ApkUpdateNative & { installed: string[]; removed: number } {
  const installed: string[] = [];
  const base = {
    installed,
    removed: 0,
    async info() { return { versionName: '0.4.90', versionCode: 40_090, canInstall: true }; },
    async download() { return { path: '/data/app.apk', bytes: OFFER.size, sha256: SHA }; },
    async install({ path }: { path: string }) { installed.push(path); },
    async openInstallPermission() { /* 系统设置那一页 */ },
    async addListener() { return { remove: async () => { base.removed += 1; } }; },
    ...over,
  };
  return base as ApkUpdateNative & { installed: string[]; removed: number };
}

describe('readApkInfo', () => {
  it('原生报的那三格原样读出来', async () => {
    expect(await readApkInfo(fakeNative())).toEqual({ versionName: '0.4.90', versionCode: 40_090, canInstall: true });
  });

  it('没原生桥(浏览器里调试、老手机包)就 undefined,不吵', async () => {
    expect(await readApkInfo(null)).toBeUndefined();
    expect(await readApkInfo(fakeNative({ info: async () => { throw new Error('没这个实现'); } }))).toBeUndefined();
  });
});

describe('downloadAndInstall', () => {
  it('★一条路走通:下 → 核校验码 → 调起系统安装器', async () => {
    const native = fakeNative();
    const seen: Array<[number, number]> = [];
    const r = await downloadAndInstall({ native, offer: OFFER, onProgress: (a, b) => seen.push([a, b]) });
    expect(r).toEqual({ ok: true });
    expect(native.installed).toEqual(['/data/app.apk']);
    expect(seen).toEqual([]); // 这份假原生不发进度事件
  });

  it('★进度事件照原样往上报,走完把监听摘掉(不留着漏)', async () => {
    let emit: ((d: { received?: number; total?: number }) => void) | undefined;
    const native = fakeNative({
      async addListener(_event: 'progress', handler: (d: { received?: number; total?: number }) => void) {
        emit = handler;
        return { remove: async () => { native.removed += 1; } };
      },
      async download() {
        emit?.({ received: 1024, total: OFFER.size });
        emit?.({ received: 2048 });
        return { path: '/data/app.apk', bytes: OFFER.size, sha256: SHA };
      },
    } as unknown as Partial<ApkUpdateNative>);
    const seen: Array<[number, number]> = [];
    const r = await downloadAndInstall({ native, offer: OFFER, onProgress: (a, b) => seen.push([a, b]) });
    expect(r.ok).toBe(true);
    // total 没报就当 0(界面上那句话于是只说下了多少)
    expect(seen).toEqual([[1024, OFFER.size], [2048, 0]]);
    expect(native.removed).toBe(1);
  });

  it('★校验码对不上:不装,一句话说清是路上坏了', async () => {
    const native = fakeNative({ async download() { return { path: '/data/app.apk', bytes: 1, sha256: 'b'.repeat(64) }; } });
    const r = await downloadAndInstall({ native, offer: OFFER });
    expect(r).toEqual({ ok: false, error: PHONE_UPDATE_SHA_MISMATCH_TEXT });
    expect(native.installed).toEqual([]);
  });

  it('★原生那边什么都没报出校验码:也不装(核不了不等于核过了)', async () => {
    const native = fakeNative({ async download() { return { path: '/data/app.apk', bytes: 1 }; } });
    const r = await downloadAndInstall({ native, offer: OFFER });
    expect(r.ok).toBe(false);
    expect(native.installed).toEqual([]);
  });

  it('下下来的文件在哪儿都没说:不装', async () => {
    const native = fakeNative({ async download() { return { sha256: SHA }; } });
    const r = await downloadAndInstall({ native, offer: OFFER });
    expect(r.ok).toBe(false);
    expect(native.installed).toEqual([]);
  });

  it('★清单那份没给校验码:压根不下(连一个字节都不下)', async () => {
    const download = vi.fn();
    const native = fakeNative({ download } as unknown as Partial<ApkUpdateNative>);
    const r = await downloadAndInstall({ native, offer: { ...OFFER, sha256: undefined } });
    expect(r.ok).toBe(false);
    expect(download).not.toHaveBeenCalled();
  });

  it('★下载失败:原因原样带出来,不劝她去官网', async () => {
    const native = fakeNative({ async download() { throw new Error('连不上 api.aibooo.cn(这会儿没网)'); } });
    const r = await downloadAndInstall({ native, offer: OFFER });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('应当失败');
    expect(r.error).toContain('连不上 api.aibooo.cn(这会儿没网)');
    expect(r.error).not.toContain('aibooo.cn/');
  });

  it('★系统还没允许「安装未知应用」:单独一档,界面好给一颗去系统设置的键', async () => {
    const native = fakeNative({
      async install() {
        const err = new Error('还不允许安装未知应用') as Error & { code?: string };
        err.code = APK_UPDATE_NEED_PERMISSION_CODE;
        throw err;
      },
    });
    const r = await downloadAndInstall({ native, offer: OFFER });
    if (r.ok) throw new Error('应当失败');
    expect(r.needPermission).toBe(true);
    expect(r.error).toBe(PHONE_UPDATE_NEED_PERMISSION_TEXT);
  });

  it('★没有原生那条路(浏览器里、或者装的是 10-03 之前的手机包):说清这一次得去官网', async () => {
    const r = await downloadAndInstall({ native: null, offer: OFFER });
    expect(r).toEqual({ ok: false, error: APK_UPDATE_NO_NATIVE_TEXT });
    expect(APK_UPDATE_NO_NATIVE_TEXT).toContain('官网');
  });
});
