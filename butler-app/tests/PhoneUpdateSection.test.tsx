/**
 * 设置 → 关于与更新 里「手机包」那一格(2026-10-03,卡 claude/phone-in-app-update)。
 *
 * 09-28 卡 UP 那一版是「一节、一个动作、包指官网」——
 * 这一版还是**一节、一个动作**,只是那个动作从「打开官网」换成「下载并安装」。
 * 官网降成最后一行小字:下不动时还有退路,但不再是唯一的路。
 */
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { PHONE_UPDATE_HANDED_OVER_TEXT, PhoneUpdateSection } from '../src/update/PhoneUpdateSection';
import { OFFICIAL_SITE, PHONE_UPDATE_SHA_MISMATCH_TEXT, type PhoneApkState } from '../src/update/phoneUpdate';
import { APK_UPDATE_NEED_PERMISSION_CODE, type ApkUpdateNative } from '../src/update/apkUpdater';
import { resetPhoneBuildStampCache } from '../src/update/buildStamp';

const SHA = 'a'.repeat(64);
const APK = { version: '0.4.91', url: 'https://api.aibooo.cn/updates/0.4.91/app.apk', size: 33_554_432, sha256: SHA };

function fakeNative(over: Partial<ApkUpdateNative> = {}, versionName = '0.4.90') {
  const calls = { download: 0, install: 0, permission: 0 };
  const impl: ApkUpdateNative = {
    async info() { return { versionName, versionCode: 1, canInstall: true }; },
    async download() { calls.download += 1; return { path: '/data/app.apk', bytes: APK.size, sha256: SHA }; },
    async install() { calls.install += 1; },
    async openInstallPermission() { calls.permission += 1; },
    async addListener() { return { remove: async () => undefined }; },
    ...over,
  };
  return { impl, calls };
}

/** 没有 build.json 的那种环境(读不到就缺席),单测里一律这么给。 */
const noStamp: typeof fetch = async () => new Response('', { status: 404 });

function mount(state: PhoneApkState, native: ApkUpdateNative | null) {
  resetPhoneBuildStampCache();
  render(<PhoneUpdateSection state={state} native={native} fetchImpl={noStamp} />);
}

describe('手机包那一节', () => {
  it('电脑没查过清单(两格都缺):整节不出现 —— 不编一个"已经是最新"', async () => {
    mount({}, fakeNative().impl);
    await act(async () => {});
    expect(screen.queryByText('手机包')).toBeNull();
    expect(screen.queryByText('手机端有新版')).toBeNull();
    expect(document.body.textContent).not.toContain(OFFICIAL_SITE);
  });

  it('★有新版:标题、两个版本号、一个动作;屏上没有 apk 直链', async () => {
    mount({ phone_apk: APK }, fakeNative().impl);
    await act(async () => {});
    expect(screen.getByText('手机端有新版')).toBeTruthy();
    const text = document.body.textContent ?? '';
    expect(text).toContain('0.4.90');
    expect(text).toContain('0.4.91');
    expect(text).toContain('32.0 MB');
    expect(screen.getByRole('button', { name: '有新版 0.4.91,下载并安装' })).toBeTruthy();
    expect(document.body.innerHTML).not.toContain('.apk');
    // 第一次系统会问那一句,照实先说出来
    expect(text).toContain('安装未知应用');
  });

  it('★按下去:在 App 里下、核校验码、交给系统安装器(一次都不跳官网)', async () => {
    const { impl, calls } = fakeNative();
    mount({ phone_apk: APK }, impl);
    await act(async () => {});
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /下载并安装/ })); });
    expect(calls.download).toBe(1);
    expect(calls.install).toBe(1);
    expect(screen.getByText(PHONE_UPDATE_HANDED_OVER_TEXT)).toBeTruthy();
  });

  it('★下载时按钮上写着下了多少,而且按不动(不许按出第二条下载)', async () => {
    let release: (() => void) | undefined;
    let emit: ((d: { received?: number; total?: number }) => void) | undefined;
    const { impl, calls } = fakeNative({
      async addListener(_e: 'progress', handler: (d: { received?: number; total?: number }) => void) {
        emit = handler;
        return { remove: async () => undefined };
      },
      async download() {
        calls.download += 1;
        emit?.({ received: 12_582_912, total: APK.size });
        await new Promise<void>((resolve) => { release = resolve; });
        return { path: '/data/app.apk', bytes: APK.size, sha256: SHA };
      },
    } as unknown as Partial<ApkUpdateNative>);
    mount({ phone_apk: APK }, impl);
    await act(async () => {});
    const button = screen.getByRole('button', { name: /下载并安装/ }) as HTMLButtonElement;
    await act(async () => { fireEvent.click(button); });
    expect(button.textContent).toBe('已下 12.0 MB / 32.0 MB(37%)');
    expect(button.disabled).toBe(true);
    await act(async () => { fireEvent.click(button); });
    expect(calls.download).toBe(1);
    await act(async () => { release?.(); });
  });

  it('★校验码对不上:屏上说清是路上坏了,而且没装', async () => {
    const { impl, calls } = fakeNative({
      async download() { return { path: '/a.apk', bytes: 1, sha256: 'b'.repeat(64) }; },
    } as unknown as Partial<ApkUpdateNative>);
    mount({ phone_apk: APK }, impl);
    await act(async () => {});
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /下载并安装/ })); });
    expect(screen.getByText(PHONE_UPDATE_SHA_MISMATCH_TEXT)).toBeTruthy();
    expect(calls.install).toBe(0);
  });

  it('★系统不允许装包:多一颗去系统设置的键,按它打开那一页', async () => {
    const { impl, calls } = fakeNative({
      async install() {
        const err = new Error('不允许') as Error & { code?: string };
        err.code = APK_UPDATE_NEED_PERMISSION_CODE;
        throw err;
      },
    });
    mount({ phone_apk: APK }, impl);
    await act(async () => {});
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /下载并安装/ })); });
    const go = screen.getByRole('button', { name: '去系统设置里允许' });
    await act(async () => { fireEvent.click(go); });
    expect(calls.permission).toBe(1);
  });

  it('本机就是清单里那一份:只说一句,不给动作', async () => {
    mount({ phone_apk: APK }, fakeNative({}, '0.4.91').impl);
    await act(async () => {});
    expect(screen.getByText('手机包')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /下载并安装/ })).toBeNull();
  });

  it('★清单那份没给校验码:不给动作,说明为什么', async () => {
    mount({ phone_apk: { ...APK, sha256: undefined } }, fakeNative().impl);
    await act(async () => {});
    expect(screen.queryByRole('button', { name: /下载并安装/ })).toBeNull();
    expect(document.body.textContent).toContain('校验码');
  });

  it('★官网那条路留着,但只是最后一行小字', async () => {
    mount({ phone_apk: APK }, fakeNative().impl);
    await act(async () => {});
    const link = screen.getByText(OFFICIAL_SITE) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe(`https://${OFFICIAL_SITE}`);
    expect(link.closest('.ba-settings__dim')).not.toBeNull();
  });

  it('没有原生那条路(浏览器里、老手机包):按下去照实说这一次得去官网', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mount({ phone_apk: APK }, null);
    await act(async () => {});
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /下载并安装/ })); });
    expect(document.body.textContent).toContain('2026-10-03 之前');
    warn.mockRestore();
  });

  it('屏上不出现 ** 与反引号(与设置页那一条同一个口径)', async () => {
    mount({ phone_apk: APK }, fakeNative().impl);
    await act(async () => {});
    const text = document.body.textContent ?? '';
    expect(text).not.toContain('**');
    expect(text).not.toContain('`');
  });
});
