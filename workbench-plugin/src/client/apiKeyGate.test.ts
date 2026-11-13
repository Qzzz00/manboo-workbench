/** @vitest-environment node */
/**
 * 首次安装密钥引导:判定、三步、话术、剪贴板识别、外链与预置参数。
 *
 * 用 node 环境是为了让 import.meta.url 是 file: —— 下面两组「读源头文件比对」
 * 要按相对路径读 modelConfig.ts / credentialTest.ts(同 tests/client-particle-source.test.ts)。
 * 这一文件只碰纯函数,不需要 DOM。
 *
 * 2026-11-12 这一版多两组「读源头文件比对」(AGENTS.md:改契约的卡要有对照测试,
 * 不写「逐字相同」注释代替):
 * ① 界面上只读展示的 Base URL / 模型名,必须与服务端 modelConfig.ts 的 OWN_DEFAULT_*
 *    是同一份,且「一键测试连接」也用那一份 —— 否则会出现「测的时候是这家、用的时候是那家」;
 * ② 引导屏、首页入口、设置里「去哪拿」三处,必须都认 DEEPSEEK_API_KEYS_URL 这一个常量,
 *    不许谁再抄一遍地址。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  API_KEY_GATE_COPY, API_KEY_SETUP_STEPS, DEEPSEEK_API_KEYS_URL, DEEPSEEK_PRESET,
  looksLikeDeepSeekKey, needApiKeySetup, stepNumber,
} from './apiKeyGate.ts';
import { decideWindowMode } from './shellWindowMode.ts';

const clientDir = new URL('./', import.meta.url);
const readClient = (name: string): string => readFileSync(new URL(name, clientDir), 'utf8');
const modelConfigSource = readFileSync(new URL('../server/modelConfig.ts', import.meta.url), 'utf8');
const credentialTestSource = readFileSync(new URL('../server/credentialTest.ts', import.meta.url), 'utf8');

/** 从服务端源文件里取一个字面量字符串常量;取不到就当场喊,不静默跳过对照。 */
function serverStringConst(name: string): string {
  const matched = new RegExp(`export const ${name} = '([^']+)'`).exec(modelConfigSource);
  if (matched?.[1] === undefined) throw new Error(`modelConfig.ts 里没找到 ${name}`);
  return matched[1];
}

describe('首次安装密钥引导判定', () => {
  const base = { loggedIn: true, deepseekConfigured: false, skipped: false };

  it('已登录 + 确认没配 + 没跳过 → 弹', () => {
    expect(needApiKeySetup(base)).toBe(true);
  });

  it('没登录 → 不弹(登录屏在前,那一屏不叠任何东西)', () => {
    expect(needApiKeySetup({ ...base, loggedIn: false })).toBe(false);
  });

  it('配好了 → 不弹(持久放行)', () => {
    expect(needApiKeySetup({ ...base, deepseekConfigured: true })).toBe(false);
  });

  it('还没问到 /credentials(undefined) → 不弹(问不到别把人按在整屏)', () => {
    expect(needApiKeySetup({ ...base, deepseekConfigured: undefined })).toBe(false);
  });

  it('本次点过稍后再说 → 不弹(下次启动 skipped 重置,又会弹)', () => {
    expect(needApiKeySetup({ ...base, skipped: true })).toBe(false);
  });

  it('窗口层级:引导屏在屏上时窗口要置前', () => {
    const account = { enabled: true as const, view: { logged_in: true } };
    expect(decideWindowMode({ account, firstRunNeeded: false, apiKeyGateNeeded: true })).toBe('front');
    // 没这一屏时照旧(首次流程已走完 → 桌面档)
    expect(decideWindowMode({ account, firstRunNeeded: false, apiKeyGateNeeded: false })).toBe('desktop');
    // 缺席(老调用方)也照旧
    expect(decideWindowMode({ account, firstRunNeeded: false })).toBe('desktop');
    // 首次流程还在时,首次流程优先(它先出现)
    expect(decideWindowMode({ account, firstRunNeeded: true, apiKeyGateNeeded: true })).toBe('front');
  });
});

describe('直达 DeepSeek 开放平台 API Keys 页', () => {
  it('地址就是那扇门,话术里那一处与常量同源', () => {
    expect(DEEPSEEK_API_KEYS_URL).toBe('https://platform.deepseek.com/api_keys');
    expect(API_KEY_GATE_COPY.whereUrl).toBe(DEEPSEEK_API_KEYS_URL);
  });

  it('引导屏 / 首页入口 / 设置里那一行都认同一个常量,谁都不许再抄一遍地址', () => {
    for (const file of ['ApiKeySetupGate.tsx', 'NeedBar.tsx', 'CredentialPanel.tsx']) {
      const source = readClient(file);
      expect(source, `${file} 没用 DEEPSEEK_API_KEYS_URL`).toContain('DEEPSEEK_API_KEYS_URL');
      expect(source, `${file} 又把地址抄了一遍`).not.toContain("'https://platform.deepseek.com/api_keys'");
    }
  });
});

describe('分步引导 + 进度指示', () => {
  it('去登录 → 完成实名 → 回来贴 Key,一屏一件事', () => {
    expect(API_KEY_SETUP_STEPS.map(one => one.id)).toEqual(['login', 'verify', 'paste']);
    expect(API_KEY_SETUP_STEPS.map(one => one.label)).toEqual(['去登录', '完成实名', '回来贴 Key']);
  });

  it('第几步是 1-based,给进度条与文案共用', () => {
    expect(stepNumber('login')).toBe(1);
    expect(stepNumber('verify')).toBe(2);
    expect(stepNumber('paste')).toBe(3);
    expect(API_KEY_GATE_COPY.progress(2)).toBe('第 2 步 / 共 3 步');
  });

  it('三步各有自己的标题与该做的一件事,不互相重复', () => {
    const titles = [API_KEY_GATE_COPY.login.title, API_KEY_GATE_COPY.verify.title, API_KEY_GATE_COPY.paste.title];
    expect(new Set(titles).size).toBe(3);
    expect(API_KEY_GATE_COPY.login.primary).toContain('开放平台');
    expect(API_KEY_GATE_COPY.paste.lead).toContain('只填这一处');
    expect(API_KEY_GATE_COPY.clipboardFound).toContain('一键填入');
  });
});

describe('自动填参:预置值与服务端缺省不漂(读源文件比对)', () => {
  it('界面显示的 Base URL = 服务端 DEEPSEEK_BASE_URL + /v1', () => {
    expect(modelConfigSource).toContain('export const OWN_DEFAULT_BASE_URL = `${DEEPSEEK_BASE_URL}/v1`');
    expect(DEEPSEEK_PRESET.baseUrl).toBe(`${serverStringConst('DEEPSEEK_BASE_URL')}/v1`);
  });

  it('界面显示的模型名 = 服务端 OWN_DEFAULT_MODEL', () => {
    expect(DEEPSEEK_PRESET.model).toBe(serverStringConst('OWN_DEFAULT_MODEL'));
  });

  it('「一键测试连接」也用服务端那两个缺省,不是另抄一份', () => {
    expect(credentialTestSource).toContain("import { OWN_DEFAULT_BASE_URL, OWN_DEFAULT_MODEL } from './modelConfig.ts'");
    expect(credentialTestSource).toContain('baseUrl = OWN_DEFAULT_BASE_URL');
    expect(credentialTestSource).toContain('model = OWN_DEFAULT_MODEL');
  });
});

describe('剪贴板智能识别', () => {
  it('sk- 开头、单行、长度够的串才认', () => {
    expect(looksLikeDeepSeekKey('sk-abcdefghijk')).toBe(true);
    expect(looksLikeDeepSeekKey('  sk-abcdefghijk  ')).toBe(true); // 复制常带首尾空白
  });

  it('认不出的一律 false:空、缺席、别的家、太短、带空白/换行、超长', () => {
    for (const value of [
      '', '   ', undefined, null, 'pk-abcdefghijk', 'sk-short',
      'sk-abc defghijk', 'sk-abcdefghijk\nsk-xyz', `sk-${'x'.repeat(300)}`,
    ]) {
      expect(looksLikeDeepSeekKey(value), String(value)).toBe(false);
    }
  });
});

describe('引导屏话术', () => {
  it('说「密钥」不说「API Key」,并且给出申请链接', () => {
    expect(API_KEY_GATE_COPY.title).toContain('密钥');
    expect(API_KEY_GATE_COPY.whereUrl).toBe(DEEPSEEK_API_KEYS_URL);
    expect(API_KEY_GATE_COPY.privacy).toContain('这台电脑');
  });

  it('测试连接那几句话不出现状态码、不出现 Key', () => {
    for (const line of [API_KEY_GATE_COPY.test, API_KEY_GATE_COPY.testPassed, API_KEY_GATE_COPY.testSave]) {
      expect(line).not.toMatch(/\b(401|402)\b/);
      expect(line).not.toContain('sk-');
    }
  });
});
