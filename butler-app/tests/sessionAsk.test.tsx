/**
 * 别家会话在等他 —— 手机「等你确认」里那一行、那一页上的那张卡(2026-09-25,卡 T)。
 *
 * 维护者 09-25 晚的规矩:一句人话说清哪家在等、等他做什么;不贴对方原文;送不回去时写清去哪儿答。
 * 手机只读工作台算好的 `state.waiting` 与 `sessions[].ask`,不自己判。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionView, WorkbenchState } from '../src/api/protocol';
import { PhoneSessionAsk, sessionAskHead } from '../src/asks/AskCards';
import { otherWaiting, stageCards, waitingRows } from '../src/stage/stageCardsModel';

afterEach(() => cleanup());

function waiting(reply: 'desk' | 'window'): SessionView {
  return {
    agent: 'claude', session_id: 'd999', project: 'ben-dsh-workbench', status: 'waiting', wait_reason: 'input', title: '统筹',
    elapsed_sec: 600, unread: false, updated_at: '2026-09-25T09:34:23.000Z',
    ask: {
      kind: 'choose', question: '今天的模型额度只剩 0.58 元。', since: '2026-09-25T09:34:23.000Z', quote: '你选哪个?回个数字就行。', by: 'rules',
      options: [{ label: '把上限提到 15 元(我推荐)' }, { label: '不提,今天省着用' }],
      reply,
      ...(reply === 'desk' ? { where: '这一问得在电脑上的 Claude 里回答' } : {}),
    },
  };
}

function state(sessions: SessionView[]): WorkbenchState {
  return {
    agents: [], sessions, quota: {}, now: '2026-09-25T10:00:00.000Z', stale: false,
    tasks: { tasks: [], sprints: [], modules: [], project_meta: [] }, butler_inbox: { items: [] },
    waiting: { count: 1, items: [{ key: 'session:claude/d999', kind: 'session', verb: '答', text: 'Claude 在等你选:今天的模型额度只剩 0.58 元' }] },
  } as unknown as WorkbenchState;
}

describe('「等你确认」里那一行', () => {
  it('★就是工作台写好的那句人话;送不回去的附「到电脑上回答」;整张卡点下去到「等你确认」那一页', () => {
    const s = state([waiting('desk')]);
    // `agent`(2026-09-26,卡 LG3):那句话里写着是哪一家,首页那一行名字前那张 logo 按它取。
    expect(waitingRows(s)).toEqual([{ id: 'session:claude/d999', kind: 'session', agent: 'claude', text: 'Claude 在等你选:今天的模型额度只剩 0.58 元', note: '到电脑上回答' }]);
    expect(stageCards(s).find((card) => card.id === 'confirm')?.to).toEqual({ page: 'asks' });
    // 那一页摆着它,「另外 N 件」里就不再算它
    expect(otherWaiting(s, ['question', 'approval', 'session'])).toEqual([]);
    expect(waitingRows(state([waiting('window')]))[0]?.note).toBe('要你回答');
  });
});

describe('那一页上的那张卡(PhoneSessionAsk)', () => {
  it('★抬头「Claude 在等你选」+ 一句问题 + 选项;送不回去:写清去哪儿答,选项只摆字(不画成按不动的按钮)', () => {
    expect(sessionAskHead(waiting('desk'))).toBe('Claude 在等你选');
    // 子任务在等他:冒到主会话那张卡上,说清是哪家的哪个子任务(与电脑同一个说法)
    const base = waiting('desk');
    expect(sessionAskHead({ ...base, ask: { ...base.ask!, kind: 'approve', child: { id: 'agent-a7', title: '跑一遍测试' } } })).toBe('Claude 的子任务「跑一遍测试」在等你点头');
    expect(sessionAskHead({ ...base, agent: 'codex', ask: { ...base.ask!, child: { id: 't2' } } })).toBe('Codex 的子任务在等你选');
    /*
     * ★ 名字先问主人(2026-10-03,审计第四节第 2 条):窗口型那几家的家 id 是 App 的包标识,
     * 手机那张退路表里没有 —— 不问登记表这一句就念出 `doubao` 来。
     */
    const registry = { agent_registry: { entries: [{ id: 'doubao', name: '豆包办公' }] } } as unknown as Pick<WorkbenchState, 'agent_registry'>;
    expect(sessionAskHead({ ...base, agent: 'doubao' }, registry)).toBe('豆包办公在等你选');
    // 登记表里没有那一家(老工作台 / 还没扫到)→ 退路表,再退回原样用家名,**不猜**。
    expect(sessionAskHead({ ...base, agent: 'doubao' })).toBe('doubao 在等你选');
    render(<PhoneSessionAsk session={waiting('desk')} answer={vi.fn()} />);
    expect(screen.getByText('今天的模型额度只剩 0.58 元。')).toBeTruthy();
    expect(screen.getByText('这一问得在电脑上的 Claude 里回答')).toBeTruthy();
    expect(screen.getByText('不提,今天省着用')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /不提,今天省着用/ })).toBeNull();
    expect(screen.queryByLabelText('我自己说')).toBeNull();
    expect(screen.queryByText(/回个数字/)).toBeNull();
  });

  it('「不用管这条」:按内容判出来的才有,点了就拿掉', async () => {
    const dismiss = vi.fn(async () => undefined);
    const onReceipt = vi.fn();
    render(<PhoneSessionAsk session={waiting('desk')} answer={vi.fn()} dismiss={dismiss} onReceipt={onReceipt} />);
    fireEvent.click(screen.getByRole('button', { name: '不用管这条' }));
    await waitFor(() => expect(onReceipt).toHaveBeenCalledWith('好,这条不算在等你了'));
    cleanup();
    const form = waiting('desk');
    render(<PhoneSessionAsk session={{ ...form, ask: { ...form.ask!, by: 'form' } }} answer={vi.fn()} dismiss={dismiss} />);
    expect(screen.queryByRole('button', { name: '不用管这条' })).toBeNull();
  });

  it('送得回去:点一个就送(送的是选项原话);回执「送过去了」', async () => {
    const answer = vi.fn(async () => ({ ok: true as const }));
    const onReceipt = vi.fn();
    render(<PhoneSessionAsk session={waiting('window')} answer={answer} onReceipt={onReceipt} />);
    fireEvent.click(screen.getByRole('button', { name: /不提,今天省着用/ }));
    await waitFor(() => expect(onReceipt).toHaveBeenCalledWith('送过去了,它接着办'));
    expect(answer).toHaveBeenCalledWith('不提,今天省着用');
  });

  it('工作台说这一问送不回去(窗口里没找到那段对话):改写那一句', async () => {
    const answer = vi.fn(async () => ({ ok: false as const, desk: true, text: '这一问得在电脑上的 Claude 里回答(没在它的窗口里找到那段对话,没敢替你打字)' }));
    render(<PhoneSessionAsk session={waiting('window')} answer={answer} />);
    fireEvent.click(screen.getByRole('button', { name: /不提,今天省着用/ }));
    expect(await screen.findByText(/没敢替你打字/)).toBeTruthy();
  });

  /**
   * ★ **她自己打的那一句也送得进去**(2026-09-28,卡 AT)。维护者原话:「做半天还是不能送进去?……
   * 你就复制黏贴我贴在框里的文字输入进去不就好了吗。」弹框那一问从前在手机上只有一行
   * 「上面那几项我能替你点;要自己说一句,得在电脑上…」—— `ask.write` 为真时那儿该摆「我自己说」那个框。
   */
  function formAsk(extra: Record<string, unknown>) {
    const one = waiting('desk');
    return { ...one, ask: { ...one.ask!, by: 'form' as const, press: true as const, ...extra } };
  }

  it('★write:true:摆「我自己说」那个框,不再写「要自己说一句,得在电脑上…」;核实过说「已替你答了」', async () => {
    const say = vi.fn(async () => ({ ok: true as const, confirmed: true, text: '已替你答了:换成江浙菜' }));
    const onReceipt = vi.fn();
    const { container } = render(
      <PhoneSessionAsk session={formAsk({ write: true })} answer={vi.fn()} pick={vi.fn()} say={say} onReceipt={onReceipt} />,
    );
    expect(container.textContent).not.toContain('要自己说一句');
    const box = screen.getByLabelText('我自己说') as HTMLInputElement;
    expect(box.placeholder).toBe('我自己说:替你写进它那个框');
    fireEvent.change(box, { target: { value: '换成江浙菜' } });
    fireEvent.click(screen.getByRole('button', { name: '回复' }));
    await waitFor(() => expect(say).toHaveBeenCalledWith('换成江浙菜'));
    await waitFor(() => expect(onReceipt).toHaveBeenCalledWith('已替你答了:换成江浙菜'));
  });

  it('★写进去了、没看到它收下:照工作台那句原话说,不说成答上了', async () => {
    const say = vi.fn(async () => ({ ok: true as const, confirmed: false, text: '把「换成江浙菜」写进去按了发送,但没看到它收下 —— 去电脑上的 Claude 看一眼' }));
    render(<PhoneSessionAsk session={formAsk({ write: true })} answer={vi.fn()} say={say} />);
    fireEvent.change(screen.getByLabelText('我自己说'), { target: { value: '换成江浙菜' } });
    fireEvent.click(screen.getByRole('button', { name: '回复' }));
    expect(await screen.findByText(/没看到它收下/)).toBeTruthy();
  });

  it('★旧壳(没有 write):照旧那一行「上面那几项我能替你点;要自己说一句,…」,没有那个框', () => {
    render(<PhoneSessionAsk session={formAsk({})} answer={vi.fn()} pick={vi.fn()} say={vi.fn()} />);
    expect(screen.getByText(/上面那几项我能替你点;要自己说一句/)).toBeTruthy();
    expect(screen.queryByLabelText('我自己说')).toBeNull();
  });
});
