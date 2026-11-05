/**
 * 手机「等你确认」那一条点开就看得懂前因后果(2026-10-04,卡 `claude/ask-with-context`)。
 *
 * 维护者原话:「麻烦的是每次要确认内容的信息都很短,我都不知道发生了什么,还得自己去最近的会话找上下文,这个不好」。
 *
 * 那张卡上现在有四样(都是现成的、数出来的,一样都不经模型):
 *   ① 是谁在问:哪一家(名 + logo)、哪条会话(标题)、哪个项目;
 *   ② 它刚才在干什么:问话之前的**最近几轮原文**(她说的 / 它说的,原样)—— 走现成那条 `GET /sessions/digest`;
 *   ③ 问的是什么:问题全文 + 选项全文(`ask.full`;没有就照旧摆短的那一句);
 *   ④ 底下一颗「打开整段对话」,直接进那条会话的全文页。
 * 作答方式一个字没改(选项 / 我自己说照旧),答完那一条自己消失。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../src/api/client';
import type { SessionDigestView, SessionView } from '../src/api/protocol';
import { PhoneSessionAsk } from '../src/asks/AskCards';
import { AskRounds, ASK_CONTEXT_NO_READ } from '../src/items/SessionRounds';

afterEach(() => cleanup());

const LONG_QUESTION = [
  '导出 PDF 这件事有两条路:一条是在工作台里自己排版(字体、页边距都要自己定,好处是以后改样式不用动别人的东西);',
  '另一条是调系统的打印那一路(样子跟她在浏览器里按 ⌘P 一样,坏处是页眉页脚改不了)。',
  '两条路工期差不多,差别只在以后改样式方便不方便。你要哪一条?选完我就按这一条往下做,中途不再回来问你。',
].join('');
const LONG_NOTE = '自己排版:第一版大约两天,之后换字体换页边距都在工作台设置里点,不用等我改代码;缺点是她那台机器上没装的字体会退回默认那一个。';
const FULL = { question: LONG_QUESTION, header: '导出 PDF 走哪一条', options: [{ label: '自己排版', note: LONG_NOTE }, { label: '调系统打印那一路' }] };

const ROUNDS: SessionDigestView['rounds'] = [
  { ask: '加个导出 PDF', reply: '好,我先看这一页现在是怎么画的。', did: '读了 3 个文件', at: '2026-10-04T08:58:00.000Z' },
  { reply: '看完了,两条路都走得通,区别在改样式方便不方便。', did: '读了 2 个文件', at: '2026-10-04T09:00:30.000Z' },
];

function digest(patch: Partial<SessionDigestView> = {}): SessionDigestView {
  return {
    agent: 'claude', session_id: 'd999', project: 'desktop-workbench', status: 'waiting',
    title: '加个导出 PDF', rounds: ROUNDS, read_at: '2026-10-04T09:05:00.000Z', ...patch,
  };
}

function client(reply: () => { ok: boolean; data?: SessionDigestView; error?: string }): ApiClient {
  return { json: vi.fn(async () => { const out = reply(); return out.ok ? { ok: true, status: 200, data: out.data } : { ok: false, status: 503, error: out.error ?? '连不上工作台' }; }) } as unknown as ApiClient;
}

function asking(ask: Partial<NonNullable<SessionView['ask']>> = {}): SessionView {
  return {
    agent: 'claude', session_id: 'd999', project: 'desktop-workbench', status: 'waiting', wait_reason: 'input',
    title: '加个导出 PDF', elapsed_sec: 600, unread: false, updated_at: '2026-10-04T09:01:00.000Z',
    ask: {
      kind: 'choose',
      question: '导出 PDF 这件事有两条路:一条是在工作台里自己排版(字体、页边距都要自己…',
      options: [{ label: '自己排版', note: '第一版大约两天,之后换字体换页边距都在工作台设置里点,不用等我改代…' }, { label: '调系统打印那一路' }],
      since: '2026-10-04T09:01:00.000Z',
      by: 'form',
      reply: 'window',
      ...ask,
    },
  } as SessionView;
}

const answerOk = async () => ({ ok: true as const });

describe('③ 问的是什么:问题全文 + 选项全文', () => {
  it('有原文就摆原文,那行小标题也摆;长了先折起来,一颗「展开全文」摊开', () => {
    render(<PhoneSessionAsk session={asking({ full: FULL })} answer={answerOk} />);
    const say = screen.getByTestId('ask-say');
    expect(say.textContent).toContain(LONG_QUESTION);
    expect(say.getAttribute('data-folded')).toBe('true');
    expect(screen.getByText('导出 PDF 走哪一条')).toBeTruthy();
    // 选项说明也是原文那一份(短的那一份带省略号)。
    expect(screen.getByText(LONG_NOTE)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '展开全文' }));
    expect(screen.getByTestId('ask-say').getAttribute('data-folded')).toBe('false');
  });

  it('没有原文(老工作台 / 按内容判出来的):照旧摆短的那一句,也没有那颗键', () => {
    render(<PhoneSessionAsk session={asking({ by: 'rules', question: '你选哪个?回个数字就行。', options: undefined })} answer={answerOk} />);
    expect(screen.getByTestId('ask-say').textContent).toContain('你选哪个?回个数字就行。');
    expect(screen.queryByRole('button', { name: '展开全文' })).toBeNull();
  });

  it('点选项送上去的还是工作台给的那一颗(看见的是原文,送的是短的那一份)', async () => {
    const sent: string[] = [];
    const long = { ...FULL, options: [{ label: '自己排版,字体与页边距都在工作台设置里点(以后改样式不用动别人的东西)' }, { label: '调系统打印那一路' }] };
    render(<PhoneSessionAsk session={asking({ full: long })} answer={async (text) => { sent.push(text); return { ok: true as const }; }} />);
    fireEvent.click(screen.getByRole('button', { name: /自己排版,字体与页边距都在工作台设置里点/ }));
    await waitFor(() => { expect(sent).toEqual(['自己排版']); });
  });
});

describe('① 是谁在问 / ④ 打开整段对话', () => {
  it('家名 + 会话标题在抬头那一行;底下一颗「打开整段对话」,点下去把那条会话交给上层开', () => {
    const opened: string[] = [];
    render(<PhoneSessionAsk session={asking({ full: FULL })} answer={answerOk} openSession={() => opened.push('d999')} />);
    expect(screen.getByLabelText('Claude 在等你选')).toBeTruthy();
    expect(screen.getByText('加个导出 PDF')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '打开整段对话' }));
    expect(opened).toEqual(['d999']);
  });

  it('上层没接那条路(老壳 / 还没连上):那颗键不画,不给按下去没反应的键', () => {
    render(<PhoneSessionAsk session={asking({ full: FULL })} answer={answerOk} />);
    expect(screen.queryByRole('button', { name: '打开整段对话' })).toBeNull();
  });
});

describe('② 它刚才在干什么:最近几轮原文(走现成的 /sessions/digest)', () => {
  it('摆的是原样那几轮 + 在哪个项目;问的是现成那条路,不另开一条', async () => {
    const api = client(() => ({ ok: true, data: digest() }));
    render(<AskRounds client={api} agent="claude" name="Claude" sessionId="d999" now="2026-10-04T09:05:00.000Z" />);
    await waitFor(() => { expect(screen.getByText('好,我先看这一页现在是怎么画的。')).toBeTruthy(); });
    expect(screen.getByText('加个导出 PDF')).toBeTruthy();
    expect(screen.getByText('看完了,两条路都走得通,区别在改样式方便不方便。')).toBeTruthy();
    expect(screen.getByText(/desktop-workbench/)).toBeTruthy();
    expect(vi.mocked(api.json).mock.calls[0]?.[0]).toContain('/sessions/digest?agent=claude&id=d999');
  });

  it('读不到(离线 / 走中转):如实一句「这会儿取不到前面的对话」+ 原因,不编一段上下文', async () => {
    const api = client(() => ({ ok: false, error: '连不上工作台' }));
    render(<AskRounds client={api} agent="claude" name="Claude" sessionId="d999" now="2026-10-04T09:05:00.000Z" />);
    await waitFor(() => { expect(screen.getByText(ASK_CONTEXT_NO_READ)).toBeTruthy(); });
    expect(screen.getByText('连不上工作台')).toBeTruthy();
  });

  it('一轮都读不出来(窗口读出来的那几条):照工作台那句 rounds_note 说,不画一段空白', async () => {
    const api = client(() => ({ ok: true, data: digest({ rounds: [], rounds_note: '这家只能看最新一句,完整的对话在它自己的窗口里' }) }));
    render(<AskRounds client={api} agent="doubao" name="豆包办公" sessionId="window:abc" now="2026-10-04T09:05:00.000Z" />);
    await waitFor(() => { expect(screen.getByText('这家只能看最新一句,完整的对话在它自己的窗口里')).toBeTruthy(); });
  });

  it('那一段递进卡里时,作答那几样一个都没少(选项照旧点得到)', async () => {
    const api = client(() => ({ ok: true, data: digest() }));
    render(
      <PhoneSessionAsk
        session={asking({ full: FULL })}
        answer={answerOk}
        context={<AskRounds client={api} agent="claude" name="Claude" sessionId="d999" now="2026-10-04T09:05:00.000Z" />}
      />,
    );
    await waitFor(() => { expect(screen.getByText('好,我先看这一页现在是怎么画的。')).toBeTruthy(); });
    expect((screen.getByRole('button', { name: /自己排版/ }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByLabelText('我自己说')).toBeTruthy();
  });
});
