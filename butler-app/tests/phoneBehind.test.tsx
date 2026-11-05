/**
 * 旧手机包收不到新格时提示更新手机端(2026-10-09,卡「四件小事」第 1 件)。
 *
 * 判据只用数得出来的:手机自己装的版本(原生 versionName / build.json)
 * 与工作台记的「哪一版起手机才有这一格」(`/state.phone_cells`)比;
 * 落后于其中任何一格、**而且电脑那份手机包真比它新**(带校验码,一键能装)时,
 * 首页说一句「电脑上的事务官更新了,手机端也更新一下」,一颗键直接下载并安装。
 * 版本认不出 / 老工作台没这一格 / 没有更新的包 → 不说(不猜)。
 */
import { describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { PHONE_BEHIND_TEXT, phoneBehind } from '../src/update/phoneUpdate';
import { PhoneBehindBanner } from '../src/update/PhoneBehindBanner';
import { PHONE_UPDATE_HANDED_OVER_TEXT } from '../src/update/PhoneUpdateSection';
import type { ApkUpdateNative } from '../src/update/apkUpdater';
import { resetPhoneBuildStampCache } from '../src/update/buildStamp';
import type { PhoneCellView } from '../src/api/protocol';

const SHA = 'a'.repeat(64);
const APK = { version: '0.4.110', url: 'https://example.invalid/0.4.110/app.apk', size: 33_554_432, sha256: SHA };
const CELLS: PhoneCellView[] = [
  { cell: 'answers', title: '答案来找她', since: '0.4.98' },
  { cell: 'habits', title: '它学到了什么', since: '0.4.110' },
  { cell: 'meeting_outbox', title: '会议待传箱', since: '0.4.110' },
];

describe('phoneBehind:判据', () => {
  it('★ 手机 0.4.98、工作台记着 0.4.110 起才有的两格、电脑上有 0.4.110 的包 → 说,列出缺的那两格', () => {
    expect(phoneBehind({ cells: CELLS, mine: '0.4.98', offer: APK })).toEqual({
      missing: ['它学到了什么', '会议待传箱'], offer: APK,
    });
  });

  it('手机已经够新 → 不说', () => {
    expect(phoneBehind({ cells: CELLS, mine: '0.4.110', offer: APK })).toBeUndefined();
  });

  it('电脑上那份包不比手机新(这一版没重打手机包)→ 不说:没有能装的,说了也点不动', () => {
    expect(phoneBehind({ cells: CELLS, mine: '0.4.98', offer: { ...APK, version: '0.4.98' } })).toBeUndefined();
  });

  it('包没校验码 → 不说(一键装不了)', () => {
    const { sha256: _drop, ...noSha } = APK;
    expect(phoneBehind({ cells: CELLS, mine: '0.4.98', offer: noSha })).toBeUndefined();
  });

  it('手机版本认不出 / 老工作台没有那张表 / 没有包 → 不说(不猜)', () => {
    expect(phoneBehind({ cells: CELLS, offer: APK })).toBeUndefined();
    expect(phoneBehind({ cells: CELLS, mine: '0.0.0-dev', offer: APK })).toBeUndefined();
    expect(phoneBehind({ mine: '0.4.98', offer: APK })).toBeUndefined();
    expect(phoneBehind({ cells: CELLS, mine: '0.4.98' })).toBeUndefined();
  });

  it('表里认不出版本号的那一行跳过,不当成缺', () => {
    expect(phoneBehind({ cells: [{ cell: 'x', title: '某格', since: 'next' }], mine: '0.4.98', offer: APK })).toBeUndefined();
  });
});

function fakeNative(versionName: string) {
  const calls = { download: 0, install: 0 };
  const impl: ApkUpdateNative = {
    async info() { return { versionName, versionCode: 1, canInstall: true }; },
    async download() { calls.download += 1; return { path: '/data/app.apk', bytes: APK.size, sha256: SHA }; },
    async install() { calls.install += 1; },
    async openInstallPermission() {},
    async addListener() { return { remove: async () => undefined }; },
  };
  return { impl, calls };
}

const noStamp: typeof fetch = async () => new Response('', { status: 404 });

describe('首页那一句', () => {
  it('★ 落后:说那一句,一颗键按下去就在 App 里下、核、交给系统安装器', async () => {
    resetPhoneBuildStampCache();
    const { impl, calls } = fakeNative('0.4.98');
    render(<PhoneBehindBanner state={{ phone_apk: APK, phone_cells: CELLS }} native={impl} fetchImpl={noStamp} />);
    await act(async () => {});
    expect(screen.getByText(PHONE_BEHIND_TEXT)).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /更新/ })); });
    expect(calls.download).toBe(1);
    expect(calls.install).toBe(1);
    expect(screen.getByText(PHONE_UPDATE_HANDED_OVER_TEXT)).toBeTruthy();
  });

  it('不落后:什么都不画', async () => {
    resetPhoneBuildStampCache();
    render(<PhoneBehindBanner state={{ phone_apk: APK, phone_cells: CELLS }} native={fakeNative('0.4.110').impl} fetchImpl={noStamp} />);
    await act(async () => {});
    expect(screen.queryByText(PHONE_BEHIND_TEXT)).toBeNull();
  });

  it('「稍后」:这一次收起来', async () => {
    resetPhoneBuildStampCache();
    render(<PhoneBehindBanner state={{ phone_apk: APK, phone_cells: CELLS }} native={fakeNative('0.4.98').impl} fetchImpl={noStamp} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: '稍后' }));
    expect(screen.queryByText(PHONE_BEHIND_TEXT)).toBeNull();
  });
});
