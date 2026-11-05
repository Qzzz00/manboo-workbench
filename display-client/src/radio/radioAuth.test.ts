import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const registerOrLogin = vi.fn(async () => undefined);
const isTokenValid = vi.fn(() => false);
vi.mock('../lib/authStore.ts', () => ({ registerOrLogin, isTokenValid }));

async function fresh() {
  vi.resetModules();
  return await import('./radioAuth.ts');
}

const store = new Map<string, string>();
const localStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => { store.set(key, value); },
  clear: () => { store.clear(); },
};
vi.stubGlobal('localStorage', localStorage);

beforeEach(() => {
  localStorage.clear();
  registerOrLogin.mockClear();
  isTokenValid.mockReset().mockReturnValue(false);
});
afterEach(() => { vi.restoreAllMocks(); vi.stubGlobal('localStorage', localStorage); });

describe('电台账号从本机读,源码里不带(2026-10-21)', () => {
  it('源码里没有写死的账号对象', () => {
    const text = readFileSync(join(__dirname, 'radioAuth.ts'), 'utf8');
    expect(text).not.toMatch(/RADIO_TEST_ACCOUNT\s*=/);
    expect(text).not.toMatch(/password:\s*['"]/);
  });

  it('本机没配账号:不尝试登录,只告警', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { ensureRadioAuth } = await fresh();
    await ensureRadioAuth();
    expect(registerOrLogin).not.toHaveBeenCalled();
  });

  it('本机配了账号:拿它注册即登录', async () => {
    const { RADIO_ACCOUNT_KEY, ensureRadioAuth } = await fresh();
    localStorage.setItem(RADIO_ACCOUNT_KEY, JSON.stringify({ username: 'u', password: 'p', inviteCode: 'i' }));
    await ensureRadioAuth();
    expect(registerOrLogin).toHaveBeenCalledWith('u', 'p', 'i');
  });

  it('已有有效 token:不再登录', async () => {
    isTokenValid.mockReturnValue(true);
    const { RADIO_ACCOUNT_KEY, ensureRadioAuth } = await fresh();
    localStorage.setItem(RADIO_ACCOUNT_KEY, JSON.stringify({ username: 'u', password: 'p' }));
    await ensureRadioAuth();
    expect(registerOrLogin).not.toHaveBeenCalled();
  });

  it('配置写坏了当没配', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { RADIO_ACCOUNT_KEY, radioAccount } = await fresh();
    localStorage.setItem(RADIO_ACCOUNT_KEY, '{坏');
    expect(radioAccount()).toBeUndefined();
    localStorage.setItem(RADIO_ACCOUNT_KEY, JSON.stringify({ username: 'u' }));
    expect(radioAccount()).toBeUndefined();
  });
});
