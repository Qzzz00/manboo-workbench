/**
 * 三步密钥引导屏:一屏一件事、进度、直达外链、剪贴板识别、只读预置参数、一键测试连接、保存。
 *
 * 纪律(credentials.ts / AGENTS.md):密钥只进 password 输入框的 value 与请求体,
 * 不进任何可见文本、不进错误话术、不进 localStorage。每一条用例都顺手钉一下这条。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ApiKeySetupGate, type ApiKeySetupGateProps } from './ApiKeySetupGate.tsx';
import {
  API_KEY_GATE_COPY, API_KEY_SETUP_STEPS, DEEPSEEK_API_KEYS_URL, DEEPSEEK_PRESET,
} from './apiKeyGate.ts';
import { CREDENTIAL_TEST_COPY } from '../server/credentialTest.ts';
import { CREDENTIAL_TEST_CLIENT_COPY } from './credentials.ts';

afterEach(() => cleanup());

const KEY = 'sk-secret-123456';
const quietClipboard = async (): Promise<string> => '';

function response(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as Response;
}

/** 默认把「测」与「存」分开答,测试里按需覆盖。 */
function fetchFor(over: {
  test?: () => Promise<Response>,
  save?: (body: { provider: string, key: string }) => Promise<Response>,
} = {}): typeof fetch {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).endsWith('/credentials/test')) {
      return over.test === undefined ? response({ ok: true, message: CREDENTIAL_TEST_COPY.ok }) : over.test();
    }
    if (String(url).endsWith('/credentials') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { provider: string, key: string };
      return over.save === undefined ? response({ deepseek: { configured: true } }) : over.save(body);
    }
    return response({});
  }) as unknown as typeof fetch;
}

function gate(over: Partial<ApiKeySetupGateProps> = {}) {
  const props: ApiKeySetupGateProps = {
    baseUrl: 'http://127.0.0.1:8791',
    fetchImpl: fetchFor(),
    readClipboard: quietClipboard,
    onSaved: vi.fn(),
    onSkip: vi.fn(),
    ...over,
  };
  return { props, view: render(<ApiKeySetupGate {...props} />) };
}

/** 从第 1 步走到第 3 步(用次按钮推进,避免 jsdom 的导航噪声)。 */
function toPaste(): void {
  fireEvent.click(screen.getByRole('button', { name: API_KEY_GATE_COPY.login.alt }));
  fireEvent.click(screen.getByRole('button', { name: API_KEY_GATE_COPY.verify.alt }));
}

const input = (): HTMLInputElement => screen.getByLabelText(API_KEY_GATE_COPY.fieldLabel) as HTMLInputElement;
const progressNow = (): string | null => screen.getByRole('progressbar').getAttribute('aria-valuenow');

describe('一屏一件事 + 进度指示', () => {
  it('第 1 步只有「去登录」,主按钮就是 API Keys 页的外链', () => {
    gate();
    expect(progressNow()).toBe('1');
    // 进度文本是「第 1 步 / 共 3 步 · 去登录」,JSX 把它拆成了多个文本节点。
    expect(screen.getByText(/第 1 步 \/ 共 3 步/)).toBeTruthy();
    expect(screen.getByText(API_KEY_GATE_COPY.login.title)).toBeTruthy();
    expect(screen.queryByLabelText(API_KEY_GATE_COPY.fieldLabel)).toBeNull();
    const link = screen.getByRole('link', { name: API_KEY_GATE_COPY.login.primary });
    expect(link.getAttribute('href')).toBe(DEEPSEEK_API_KEYS_URL);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
  });

  it('点主 CTA 也推进到第 2 步(外链由壳交给系统浏览器)', () => {
    gate();
    fireEvent.click(screen.getByRole('link', { name: API_KEY_GATE_COPY.login.primary }));
    expect(progressNow()).toBe('2');
    expect(screen.getByText(API_KEY_GATE_COPY.verify.title)).toBeTruthy();
    const link = screen.getByRole('link', { name: API_KEY_GATE_COPY.verify.primary });
    expect(link.getAttribute('href')).toBe(DEEPSEEK_API_KEYS_URL);
  });

  it('三步走完才出现输入框,进度到 3', () => {
    gate();
    toPaste();
    expect(progressNow()).toBe('3');
    expect(screen.getByText(API_KEY_GATE_COPY.paste.title)).toBeTruthy();
    expect(input()).toHaveProperty('type', 'password');
  });

  it('「上一步」能退回,进度跟着退', () => {
    gate();
    toPaste();
    fireEvent.click(screen.getByRole('button', { name: new RegExp(API_KEY_GATE_COPY.back) }));
    expect(progressNow()).toBe('2');
    expect(screen.getByText(API_KEY_GATE_COPY.verify.title)).toBeTruthy();
  });

  it('从首页「配置 AI 来源」回来:直接落第 3 步,不再让他重走登录', () => {
    gate({ initialStep: 'paste' });
    expect(progressNow()).toBe('3');
    expect(screen.getByText(API_KEY_GATE_COPY.paste.title)).toBeTruthy();
  });

  it('进度条段数与三步一致', () => {
    gate();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuemax')).toBe(String(API_KEY_SETUP_STEPS.length));
  });
});

describe('自动填参:只填 Key 一处', () => {
  it('服务地址与模型名只读展示,界面上只有一个输入框', () => {
    const { view } = gate({ initialStep: 'paste' });
    // Key 那格是 type=password,没有 textbox role(仓库里早踩过);直接数 input 元素。
    expect(view.container.querySelectorAll('input')).toHaveLength(1);
    expect(screen.getByText(API_KEY_GATE_COPY.presetTitle)).toBeTruthy();
    expect(screen.getByText(DEEPSEEK_PRESET.baseUrl)).toBeTruthy();
    expect(screen.getByText(DEEPSEEK_PRESET.model)).toBeTruthy();
    expect(screen.queryByLabelText(API_KEY_GATE_COPY.presetBaseLabel)).toBeNull();
    expect(screen.queryByLabelText(API_KEY_GATE_COPY.presetModelLabel)).toBeNull();
  });
});

describe('剪贴板智能识别', () => {
  it('回来就看见「检测到 Key」,点一下一键填入;界面不显示那串内容', async () => {
    gate({ initialStep: 'paste', readClipboard: async () => `  ${KEY}  ` });
    await waitFor(() => expect(screen.getByText(API_KEY_GATE_COPY.clipboardFound)).toBeTruthy());
    expect(document.body.textContent).not.toContain(KEY);
    fireEvent.click(screen.getByRole('button', { name: API_KEY_GATE_COPY.clipboardFill }));
    expect(input().value).toBe(KEY);
    expect(screen.queryByText(API_KEY_GATE_COPY.clipboardFound)).toBeNull();
  });

  it('窗口重新拿到焦点时再探一次(复制完回来那一拍)', async () => {
    let text = '';
    gate({ initialStep: 'paste', readClipboard: async () => text });
    expect(screen.queryByText(API_KEY_GATE_COPY.clipboardFound)).toBeNull();
    text = KEY;
    fireEvent.focus(window);
    await waitFor(() => expect(screen.getByText(API_KEY_GATE_COPY.clipboardFound)).toBeTruthy());
  });

  it('显式的「从剪贴板粘贴」是用户手势路径,WKWebView 里最稳', async () => {
    gate({ initialStep: 'paste', readClipboard: async () => KEY });
    fireEvent.click(screen.getByRole('button', { name: API_KEY_GATE_COPY.clipboardRead }));
    await waitFor(() => expect(input().value).toBe(KEY));
  });

  it('读不到 / 不是 Key:自动探测静默降级,显式按钮给一句能照着做的话', async () => {
    gate({ initialStep: 'paste', readClipboard: async () => { throw new Error('permission denied') } });
    expect(screen.queryByText(API_KEY_GATE_COPY.clipboardFound)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: API_KEY_GATE_COPY.clipboardRead }));
    await waitFor(() => expect(screen.getByText(API_KEY_GATE_COPY.clipboardReadFailed)).toBeTruthy());
  });

  it('直接按 ⌘V / Ctrl+V 的兜底:首尾空白去掉,免得带空格导致 401', () => {
    gate({ initialStep: 'paste' });
    fireEvent.paste(input(), { clipboardData: { getData: () => `  ${KEY}  ` } });
    expect(input().value).toBe(KEY);
  });
});

describe('一键测试连接', () => {
  it('测通了:显示成功话术,保存键改成「连接成功,保存并开始使用」', async () => {
    const fetchImpl = fetchFor({ test: async () => response({ ok: true, message: CREDENTIAL_TEST_COPY.ok }) });
    gate({ initialStep: 'paste', fetchImpl });
    fireEvent.change(input(), { target: { value: KEY } });
    fireEvent.click(screen.getByRole('button', { name: API_KEY_GATE_COPY.test }));
    await waitFor(() => expect(screen.getByText(API_KEY_GATE_COPY.testPassed)).toBeTruthy());
    expect(screen.getByRole('button', { name: API_KEY_GATE_COPY.testSave })).toBeTruthy();
    const call = vi.mocked(fetchImpl).mock.calls.find(([url]) => String(url).endsWith('/credentials/test'));
    expect(call?.[0]).toBe('http://127.0.0.1:8791/credentials/test');
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ key: KEY });
    expect(document.body.textContent).not.toContain(KEY);
  });

  it('401 / 402 由服务端翻成人话,界面上不出现状态码', async () => {
    for (const message of [CREDENTIAL_TEST_COPY.invalidKey, CREDENTIAL_TEST_COPY.noBalance]) {
      const fetchImpl = fetchFor({ test: async () => response({ ok: false, message }) });
      const { view } = gate({ initialStep: 'paste', fetchImpl });
      fireEvent.change(input(), { target: { value: KEY } });
      fireEvent.click(screen.getByRole('button', { name: API_KEY_GATE_COPY.test }));
      await waitFor(() => expect(screen.getByText(message)).toBeTruthy());
      expect(document.body.textContent).not.toMatch(/\b(401|402)\b/);
      expect(message).toContain(message === CREDENTIAL_TEST_COPY.invalidKey ? '复制' : '余额不足');
      view.unmount();
    }
  });

  it('测试接口整个挂了:数据层先翻成人话,不带底层错误', async () => {
    const fetchImpl = fetchFor({ test: async () => { throw new Error(`boom ${KEY}`) } });
    gate({ initialStep: 'paste', fetchImpl });
    fireEvent.change(input(), { target: { value: KEY } });
    fireEvent.click(screen.getByRole('button', { name: API_KEY_GATE_COPY.test }));
    await waitFor(() => expect(screen.getByText(CREDENTIAL_TEST_CLIENT_COPY.noService)).toBeTruthy());
    expect(document.body.textContent).not.toContain(KEY);
    expect(document.body.textContent).not.toContain('boom');
  });

  it('回包认不出时兜底成「稍后再试」,仍不显示 Key', async () => {
    const fetchImpl = fetchFor({ test: async () => response({ ok: 'yes', message: 123 }) });
    gate({ initialStep: 'paste', fetchImpl });
    fireEvent.change(input(), { target: { value: KEY } });
    fireEvent.click(screen.getByRole('button', { name: API_KEY_GATE_COPY.test }));
    await waitFor(() => expect(screen.getByText(CREDENTIAL_TEST_CLIENT_COPY.failed)).toBeTruthy());
    expect(document.body.textContent).not.toContain(KEY);
  });

  it('Key 一改,上一次测试结论就不算数', async () => {
    gate({ initialStep: 'paste', fetchImpl: fetchFor() });
    fireEvent.change(input(), { target: { value: KEY } });
    fireEvent.click(screen.getByRole('button', { name: API_KEY_GATE_COPY.test }));
    await waitFor(() => expect(screen.getByText(API_KEY_GATE_COPY.testPassed)).toBeTruthy());
    fireEvent.change(input(), { target: { value: 'sk-another-123456' } });
    expect(screen.queryByText(API_KEY_GATE_COPY.testPassed)).toBeNull();
  });
});

describe('保存与放行', () => {
  it('填对并保存成功后调 onSaved,密钥清空且不回到界面', async () => {
    const sent: { provider: string, key: string }[] = [];
    const fetchImpl = fetchFor({
      save: async (body) => { sent.push(body); return response({ deepseek: { configured: true } }); },
    });
    const { props } = gate({ initialStep: 'paste', fetchImpl });
    fireEvent.change(input(), { target: { value: `  ${KEY}  ` } });
    fireEvent.click(screen.getByRole('button', { name: API_KEY_GATE_COPY.save }));
    await waitFor(() => expect(props.onSaved).toHaveBeenCalledTimes(1));
    expect(sent).toEqual([{ provider: 'deepseek', key: KEY }]);
    expect(input().value).toBe('');
    expect(document.body.textContent).not.toContain(KEY);
  });

  it('服务端回 configured=false 时不放行,显示自己的话术', async () => {
    const { props } = gate({
      initialStep: 'paste',
      fetchImpl: fetchFor({ save: async () => response({ deepseek: { configured: false } }) }),
    });
    fireEvent.change(input(), { target: { value: KEY } });
    fireEvent.click(screen.getByRole('button', { name: API_KEY_GATE_COPY.save }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByRole('alert').textContent).toBe(API_KEY_GATE_COPY.saveFailed);
    expect(props.onSaved).not.toHaveBeenCalled();
  });

  it('保存抛错时话术不带底层错误(密钥不会漏出来)', async () => {
    gate({
      initialStep: 'paste',
      fetchImpl: fetchFor({ save: async () => { throw new Error(`boom ${KEY}`) } }),
    });
    fireEvent.change(input(), { target: { value: KEY } });
    fireEvent.click(screen.getByRole('button', { name: API_KEY_GATE_COPY.save }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByRole('alert').textContent).toBe(API_KEY_GATE_COPY.saveFailed);
    expect(document.body.textContent).not.toContain('boom');
    expect(document.body.textContent).not.toContain(KEY);
  });

  it('空密钥不能保存也不能测', () => {
    gate({ initialStep: 'paste' });
    expect(screen.getByRole('button', { name: API_KEY_GATE_COPY.save })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: API_KEY_GATE_COPY.test })).toHaveProperty('disabled', true);
  });

  it('稍后再说:调 onSkip、不放行,且引导屏上任何一步都能点', () => {
    const { props } = gate();
    fireEvent.click(screen.getByRole('button', { name: API_KEY_GATE_COPY.skip }));
    expect(props.onSkip).toHaveBeenCalledTimes(1);
    expect(props.onSaved).not.toHaveBeenCalled();
  });
});
