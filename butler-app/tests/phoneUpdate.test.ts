/**
 * 手机包带版本号、应用内直接更新(2026-10-03,卡 claude/phone-in-app-update)。
 *
 * 维护者原话:「手机端现在每次更新我都得跳转官网去下载,而且包也没有版本号……」
 * 这一份只钉**纯的那几件**:版本比较、拿哪一格、校验码核对、进度与失败文案、
 * 「已更新到」那一句。下载与调起安装器是原生的事,在 ApkUpdatePlugin.java 里。
 */
import { describe, expect, it } from 'vitest';
import {
  OFFICIAL_SITE,
  PHONE_UPDATE_NEED_PERMISSION_TEXT,
  PHONE_UPDATE_SHA_MISMATCH_TEXT,
  apkSizeText,
  comparePhoneVersions,
  justUpdatedText,
  localPhoneVersion,
  parsePhoneVersion,
  phoneDownloadProgressText,
  phoneUpdateFailText,
  phoneUpdateVerdict,
  pickPhoneApk,
  shaOk,
} from '../src/update/phoneUpdate';

const SHA = 'a'.repeat(64);
const OFFER = { version: '0.4.91', url: 'https://api.aibooo.cn/updates/0.4.91/app.apk', size: 33_554_432, sha256: SHA };

describe('版本号', () => {
  it('三段数字才认,别的一律认不出(不编一个)', () => {
    expect(parsePhoneVersion('0.4.91')).toEqual([0, 4, 91]);
    expect(parsePhoneVersion('10.0.3')).toEqual([10, 0, 3]);
    expect(parsePhoneVersion('1.0')).toBeUndefined();
    expect(parsePhoneVersion('0.0.0-dev')).toBeUndefined();
    expect(parsePhoneVersion('')).toBeUndefined();
    expect(parsePhoneVersion(undefined)).toBeUndefined();
  });

  it('逐段按数字比,不按字符串比(0.4.91 比 0.4.9 新)', () => {
    expect(comparePhoneVersions('0.4.91', '0.4.9')).toBeGreaterThan(0);
    expect(comparePhoneVersions('0.4.9', '0.4.91')).toBeLessThan(0);
    expect(comparePhoneVersions('0.4.91', '0.4.91')).toBe(0);
    expect(comparePhoneVersions('1.0.0', '0.99.99')).toBeGreaterThan(0);
    expect(comparePhoneVersions('0.5.0', '0.4.91')).toBeGreaterThan(0);
  });

  it('任一边认不出就 undefined —— 不许退化成"一样"', () => {
    expect(comparePhoneVersions('0.0.0-dev', '0.4.91')).toBeUndefined();
    expect(comparePhoneVersions('0.4.91', '1.0')).toBeUndefined();
  });

  it('本机版本号:原生报的优先,没有原生桥就退到 build.json 那一格', () => {
    expect(localPhoneVersion({ native: '0.4.90', stamp: '0.4.91' })).toBe('0.4.90');
    expect(localPhoneVersion({ stamp: '0.4.91' })).toBe('0.4.91');
    // 原生报了个认不出的(没跑过 pnpm build 的那种包),退到 build.json
    expect(localPhoneVersion({ native: '1.0', stamp: '0.4.91' })).toBe('0.4.91');
    // 两边都认不出:undefined,界面上如实说认不出
    expect(localPhoneVersion({ native: '1.0', stamp: '0.0.0-dev' })).toBeUndefined();
    expect(localPhoneVersion({})).toBeUndefined();
  });
});

describe('拿清单里哪一格', () => {
  it('优先 phone_apk —— 它带校验码,而且查过一次清单就一直在', () => {
    const picked = pickPhoneApk({
      phone_apk: OFFER,
      update_available_apk: { version: '0.4.91', url: 'https://x/other.apk', size: 1 },
    });
    expect(picked).toEqual(OFFER);
  });

  it('只有 update_available_apk 时也用它(没校验码,下面那一档会拦住)', () => {
    const picked = pickPhoneApk({ update_available_apk: { version: '0.4.91', url: 'https://x/a.apk', size: 10 } });
    expect(picked?.version).toBe('0.4.91');
    expect(picked?.sha256).toBeUndefined();
  });

  it('两格都缺(电脑没查过清单)就 undefined —— 整节不出现,不编一个"已经是最新"', () => {
    expect(pickPhoneApk({})).toBeUndefined();
  });
});

describe('该不该更新', () => {
  it('电脑没查过:none', () => {
    expect(phoneUpdateVerdict({ mine: '0.4.90' })).toEqual({ kind: 'none' });
  });

  it('★清单里那份新:给一个动作,话里两个版本号都在', () => {
    const v = phoneUpdateVerdict({ offer: OFFER, mine: '0.4.90' });
    if (v.kind !== 'newer') throw new Error(`应当是 newer,实际 ${v.kind}`);
    expect(v.action).toContain('0.4.91');
    expect(v.action).toContain('下载并安装');
    expect(v.detail).toContain('0.4.90');
    expect(v.detail).toContain('0.4.91');
    expect(v.detail).toContain('32.0 MB');
    expect(v.title).toBe('手机端有新版');
  });

  it('一样:不给动作,如实说已经是那一份', () => {
    const v = phoneUpdateVerdict({ offer: OFFER, mine: '0.4.91' });
    expect(v.kind).toBe('same');
    expect(v).not.toHaveProperty('action');
  });

  it('本机比清单里那份新(维护者自己打的包):不给动作,也不说"有新版"', () => {
    const v = phoneUpdateVerdict({ offer: OFFER, mine: '0.4.99' });
    expect(v.kind).toBe('older');
    expect(v).not.toHaveProperty('action');
    if (v.kind === 'older') expect(v.title).toBe('手机包');
  });

  it('本机版本号认不出:照样给动作(这种包多半就是该换掉的),但话说清楚', () => {
    const v = phoneUpdateVerdict({ offer: OFFER });
    if (v.kind !== 'unknown-local') throw new Error(`应当是 unknown-local,实际 ${v.kind}`);
    expect(v.detail).toContain('认不出');
    expect(v.action).toContain('0.4.91');
  });

  it('★清单那份没给校验码:不装,如实说为什么(核不了就不装)', () => {
    const v = phoneUpdateVerdict({ offer: { ...OFFER, sha256: undefined }, mine: '0.4.90' });
    if (v.kind !== 'no-sha') throw new Error(`应当是 no-sha,实际 ${v.kind}`);
    expect(v).not.toHaveProperty('action');
    expect(v.detail).toContain('校验码');
  });

  it('版本一样时没校验码不算毛病 —— 本来就不用下', () => {
    expect(phoneUpdateVerdict({ offer: { ...OFFER, sha256: undefined }, mine: '0.4.91' }).kind).toBe('same');
  });

  it('屏上那几句话里不出现 ** 与反引号,也不出现 apk 直链', () => {
    for (const mine of ['0.4.90', '0.4.91', '0.4.99', undefined]) {
      const v = phoneUpdateVerdict({ offer: OFFER, ...(mine === undefined ? {} : { mine }) });
      const text = `${'title' in v ? v.title : ''}${'detail' in v ? v.detail : ''}${'action' in v ? v.action : ''}`;
      expect(text).not.toContain('**');
      expect(text).not.toContain('`');
      expect(text).not.toContain('.apk');
    }
  });
});

describe('校验码核对', () => {
  it('★对得上才算对;大小写不计,位数不对一律不算', () => {
    expect(shaOk(SHA, SHA)).toBe(true);
    expect(shaOk(SHA, SHA.toUpperCase())).toBe(true);
    expect(shaOk(SHA.toUpperCase(), SHA)).toBe(true);
    expect(shaOk(SHA, 'b'.repeat(64))).toBe(false);
    expect(shaOk(SHA, SHA.slice(0, 63))).toBe(false);
    expect(shaOk(SHA, `${SHA}a`)).toBe(false);
    expect(shaOk('zz', 'zz')).toBe(false);
  });

  it('任一边缺就不算对 —— 核不了不等于核过了', () => {
    expect(shaOk(undefined, SHA)).toBe(false);
    expect(shaOk(SHA, undefined)).toBe(false);
    expect(shaOk(undefined, undefined)).toBe(false);
    expect(shaOk('', '')).toBe(false);
  });

  it('对不上那一句说清是路上坏了、而且没装', () => {
    expect(PHONE_UPDATE_SHA_MISMATCH_TEXT).toContain('没装');
  });
});

describe('进度与失败文案', () => {
  it('知道总共多大就带百分比,不知道就只说下了多少', () => {
    expect(phoneDownloadProgressText(12_582_912, 33_554_432)).toBe('已下 12.0 MB / 32.0 MB(37%)');
    expect(phoneDownloadProgressText(12_582_912, 0)).toBe('已下 12.0 MB');
    expect(phoneDownloadProgressText(0, 33_554_432)).toBe('已下 0 KB / 32.0 MB(0%)');
    // 服务器报的总数比实际小的时候百分比不许超过 100
    expect(phoneDownloadProgressText(40_000_000, 33_554_432)).toContain('(100%)');
  });

  it('★失败原样说原因,一个字不改,也不说"去官网"', () => {
    const line = phoneUpdateFailText('连不上 api.aibooo.cn(这会儿没网)');
    expect(line).toContain('连不上 api.aibooo.cn(这会儿没网)');
    expect(line).not.toContain(OFFICIAL_SITE);
  });

  it('原生那边一个字都没说时如实说没说(不编一个原因)', () => {
    expect(phoneUpdateFailText('')).toContain('没说为什么');
    expect(phoneUpdateFailText('   ')).toContain('没说为什么');
  });

  it('没允许「安装未知应用」那一句照实提示,而且说清在哪儿允许', () => {
    expect(PHONE_UPDATE_NEED_PERMISSION_TEXT).toContain('安装未知应用');
  });
});

describe('更新完打开 App 那一句', () => {
  it('★比上次记的新:已更新到', () => {
    expect(justUpdatedText({ last: '0.4.90', now: '0.4.91' })).toBe('已更新到 0.4.91');
  });

  it('一样、或者从没记过:一个字不说', () => {
    expect(justUpdatedText({ last: '0.4.91', now: '0.4.91' })).toBeUndefined();
    expect(justUpdatedText({ now: '0.4.91' })).toBeUndefined();
    expect(justUpdatedText({ last: '0.4.90' })).toBeUndefined();
    expect(justUpdatedText({})).toBeUndefined();
  });

  it('装回了旧的一份:照实说旧,不说"已更新"', () => {
    const line = justUpdatedText({ last: '0.4.91', now: '0.4.90' });
    expect(line).toContain('0.4.90');
    expect(line).not.toContain('已更新到');
  });

  it('认不出版本号但确实换了一份:只说换成了哪一个,不说新旧', () => {
    expect(justUpdatedText({ last: '0.4.90', now: '0.0.0-dev' })).toBe('已换成 0.0.0-dev');
  });
});

describe('apkSizeText', () => {
  it('MB 与 KB 两档,给人看的', () => {
    expect(apkSizeText(33_554_432)).toBe('32.0 MB');
    expect(apkSizeText(5_000)).toBe('5 KB');
  });
});
