/**
 * 设置 › 关于与更新 › 发诊断包(2026-10-21,内测发版底座)。
 *
 * 按一下 → 电脑打包、交到服务器 → 手机上显示六位编号(她把编号发给统筹)。
 * 传不上去 → 说为什么,并说包留在电脑哪儿;连电脑都连不上 → 说清连不上,不装作发出去了。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DiagSendSection } from '../src/settings/DiagSendSection';
import { SessionContext, type Session } from '../src/session';
import type { ApiClient, ApiResult } from '../src/api/client';
import { fakeRouted } from './wbchFakes';

afterEach(cleanup);

const RUNNING = { id: 'send-1', state: 'running', started_at: '2026-10-21T02:00:00.000Z' };

function sessionWith(json: (path: string, init?: { method?: string }) => Promise<ApiResult<unknown>>): { session: Session, calls: string[] } {
  const calls: string[] = [];
  const client = fakeRouted({
    baseUrl: 'http://10.0.0.9:8791',
    json: async (path: string, init?: { method?: string }) => {
      calls.push(`${init?.method ?? 'GET'} ${path}`);
      return await json(path, init);
    },
  } as unknown as ApiClient);
  return { session: { client } as unknown as Session, calls };
}

function okOf<T>(data: T): ApiResult<T> {
  return { ok: true, status: 200, data };
}

describe('发诊断包', () => {
  it('★按下去 → 电脑在打包 → 显示编号,并说把它发给统筹', async () => {
    let gets = 0;
    const { session, calls } = sessionWith(async (_path, init) => {
      if (init?.method === 'POST') return okOf(RUNNING);
      gets += 1;
      return okOf(gets < 2 ? RUNNING : { ...RUNNING, state: 'done', code: '7KQ2MX', expires_at: '2026-10-28T02:00:00.000Z' });
    });
    render(<SessionContext.Provider value={session}><DiagSendSection pollMs={5} /></SessionContext.Provider>);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '发诊断包' })); });
    await waitFor(() => expect(screen.getByText('7KQ2MX')).toBeTruthy());
    expect(screen.getByRole('status').textContent).toContain('发给统筹');
    expect(calls[0]).toBe('POST /diag/send');
    expect(calls.slice(1).every(call => call === 'GET /diag/send')).toBe(true);
  });

  it('★传不上去:原样说为什么,并说包留在电脑桌面上(用的是脱敏过的那条路径)', async () => {
    const { session } = sessionWith(async (_path, init) => okOf(init?.method === 'POST' ? RUNNING : {
      ...RUNNING,
      state: 'failed',
      error: '连不上服务器,诊断包传不上去(多半是这会儿没网)。',
      kept: { file: '/Users/example/Desktop/工作台诊断包-20261021-100000.zip', file_redacted: '/Users/<用户>/Desktop/工作台诊断包-20261021-100000.zip', name: '工作台诊断包-20261021-100000.zip' },
    }));
    render(<SessionContext.Provider value={session}><DiagSendSection pollMs={5} /></SessionContext.Provider>);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '发诊断包' })); });
    await waitFor(() => expect(screen.getByText(/传不上去/)).toBeTruthy());
    const body = document.body.textContent ?? '';
    expect(body).toContain('工作台诊断包-20261021-100000.zip');
    expect(body).toContain('桌面');
    expect(body).not.toContain('/Users/example');
  });

  it('连电脑都连不上 → 说连不上、没发出去(不显示编号)', async () => {
    const { session } = sessionWith(async () => ({ ok: false, status: 0, kind: 'network', error: '连不上电脑' }));
    render(<SessionContext.Provider value={session}><DiagSendSection pollMs={5} /></SessionContext.Provider>);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '发诊断包' })); });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('没发出去'));
    expect(screen.getByRole('alert').textContent).toContain('连不上电脑');
  });
});
