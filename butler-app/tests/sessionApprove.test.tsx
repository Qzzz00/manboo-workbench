/**
 * 手机「等你确认」里那家的**权限弹窗**(2026-10-01,卡 AP「手机替她批准」)。
 *
 * 现场:维护者 10-01 午饭在外面,修手机横屏那条 Claude 会话在等批准 ——
 * 「找到那个会话是在待确认里,输入回复内容之后,说发不出去」。
 *
 * 守:① 权限弹窗那一问**不摆输入框**;② 读得了 → 打开就去读,读到的键名照壳读到的原字摆成按钮(底下配一句中文);
 * ③ 按下去走 `/asks/answer`,核实过才说批了;④ 读不到 → 如实说 + 「再看一次」;旧壳 → 一句到电脑上点;
 * ⑤ 打字撞上(工作台回 `permission`)→ 收起输入框、切到按键。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionView } from '../src/api/protocol';
import { PhoneSessionAsk } from '../src/asks/AskCards';

afterEach(() => cleanup());

const KEYS = [{ label: 'Allow once', does: 'once' as const }, { label: 'Deny', does: 'deny' as const }];

function approving(permission: NonNullable<SessionView['ask']>['permission']): SessionView {
  return {
    agent: 'claude', session_id: 'h1', project: 'desktop-workbench', status: 'waiting', wait_reason: 'approval', title: '修手机横屏',
    elapsed_sec: 300, unread: false, updated_at: '2026-10-01T04:10:00.000Z',
    ask: {
      kind: 'approve', question: 'Claude 要跑一条命令,等你批准', since: '2026-10-01T04:10:00.000Z', by: 'form', reply: 'desk',
      where: '这一问得在电脑上的 Claude 里回答(它那边弹了个框等你点)', reveal: true,
      ...(permission === undefined ? {} : { permission }),
    },
  };
}

describe('权限弹窗那张卡', () => {
  it('★读过了:摆弹窗上那两颗键(原字 + 一句中文),没有输入框;点了核实过 → 「已替你批准了这一次」', async () => {
    const pick = vi.fn(async () => ({ ok: true as const, confirmed: true, text: '已替你批准了这一次(按的是「Allow once」)' }));
    const receipts: string[] = [];
    render(<PhoneSessionAsk session={approving({ keys: KEYS })} answer={vi.fn()} pick={pick} onReceipt={(t) => receipts.push(t)} />);
    expect(screen.queryByLabelText('我自己说')).toBeNull();
    expect(screen.getByRole('button', { name: /Allow once/ }).textContent).toContain('批准这一次');
    expect(screen.getByRole('button', { name: /Deny/ }).textContent).toContain('不批');
    fireEvent.click(screen.getByRole('button', { name: /Allow once/ }));
    await waitFor(() => expect(receipts).toEqual(['已替你批准了这一次(按的是「Allow once」)']));
    expect(pick).toHaveBeenCalledWith('Allow once');
  });

  it('★按了没核上:照工作台那句原话说,不说成批了', async () => {
    const pick = vi.fn(async () => ({ ok: true as const, confirmed: false, text: '按了「Deny」,可那个弹窗还在 —— 没按上,去电脑上的 Claude 看一眼' }));
    render(<PhoneSessionAsk session={approving({ keys: KEYS })} answer={vi.fn()} pick={pick} />);
    fireEvent.click(screen.getByRole('button', { name: /Deny/ }));
    expect((await screen.findByRole('alert')).textContent).toContain('没按上');
  });

  it('★读得了还没读:打开就去读一次,读到了摆键;读的时候说「在看它弹窗上有哪几颗键」', async () => {
    let done: (v: { ok: true; keys: typeof KEYS }) => void = () => {};
    const approval = vi.fn(() => new Promise<{ ok: true; keys: typeof KEYS }>((resolve) => { done = resolve; }));
    render(<PhoneSessionAsk session={approving({ readable: true })} answer={vi.fn()} pick={vi.fn()} approval={approval} />);
    expect(screen.getByText('在看它弹窗上有哪几颗键…')).toBeTruthy();
    expect(approval).toHaveBeenCalledTimes(1);
    done({ ok: true, keys: KEYS });
    expect(await screen.findByRole('button', { name: /Allow once/ })).toBeTruthy();
    expect(screen.queryByLabelText('我自己说')).toBeNull();
  });

  it('★读不到:如实说那一句 + 「再看一次」;点了再读', async () => {
    const approval = vi.fn(async () => ({ ok: false as const, desk: true, text: '这一问得在电脑上的 Claude 里回答(没在它窗口里认出这一步的批准弹窗)' }));
    render(<PhoneSessionAsk session={approving({ readable: true })} answer={vi.fn()} pick={vi.fn()} approval={approval} />);
    expect(await screen.findByText('这一问得在电脑上的 Claude 里回答(没在它窗口里认出这一步的批准弹窗)')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '再看一次' }));
    await waitFor(() => expect(approval).toHaveBeenCalledTimes(2));
  });

  it('上次没读成(工作台记着那一句):照它说 + 「再看一次」,不自动再读', () => {
    const approval = vi.fn(async () => ({ ok: true as const, keys: KEYS }));
    render(<PhoneSessionAsk session={approving({ why: '没在它窗口里认出这一步的批准弹窗' })} answer={vi.fn()} pick={vi.fn()} approval={approval} />);
    expect(screen.getByText('没在它窗口里认出这一步的批准弹窗')).toBeTruthy();
    expect(screen.getByRole('button', { name: '再看一次' })).toBeTruthy();
    expect(approval).not.toHaveBeenCalled();
  });

  it('★旧壳(permission 是空的):不摆输入框,一句到电脑上点', () => {
    render(<PhoneSessionAsk session={approving({})} answer={vi.fn()} pick={vi.fn()} approval={vi.fn()} />);
    expect(screen.queryByLabelText('我自己说')).toBeNull();
    expect(screen.getByText('这一问得在电脑上的 Claude 里回答(它那边弹了个框等你点)')).toBeTruthy();
  });

  it('★10-01 现场:旧版工作台没给 permission、摆了输入框;打字回来说是权限弹窗 → 收起输入框、去读键', async () => {
    const old = approving(undefined);
    old.ask = { ...old.ask!, reply: 'window', where: undefined };
    const answer = vi.fn(async () => ({ ok: false as const, desk: true, text: '这是权限弹窗,打字批不了它 —— 点「批准」或「拒绝」那颗键', permission: true as const }));
    const approval = vi.fn(async () => ({ ok: true as const, keys: KEYS }));
    render(<PhoneSessionAsk session={old} answer={answer} pick={vi.fn()} approval={approval} />);
    fireEvent.change(screen.getByLabelText('我自己说'), { target: { value: '可以' } });
    fireEvent.click(screen.getByRole('button', { name: '回复' }));
    expect(await screen.findByRole('button', { name: /Allow once/ })).toBeTruthy();
    expect(screen.queryByLabelText('我自己说')).toBeNull();
    expect(screen.getByText('这是权限弹窗,打字批不了它 —— 点「批准」或「拒绝」那颗键')).toBeTruthy();
  });
});
