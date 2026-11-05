/**
 * 给 Agent 发信息的那个框**固定可见**,送到了给一句「已送到 · 10:38」
 * (2026-10-03,卡 claude/phone-saybox-pinned)。
 *
 * 维护者 10-03 上午从手机捎来两条:
 *   ①「一个手机端的体验优化,给 Agent 发信息的输入框没有默认置顶,用起来得自己下滑,很难受。」
 *   ②「发送成功最好给个小提示,显示发送成功。」
 *
 * 一整类 = 两种会话页上「把话说给某一家」的那个框(维护者的规矩「举例 = 一整类」):
 *   · **捎话** —— 会话详情里那个框(items/SessionSayBox.tsx,摆在 items/InboxPage.tsx 的 SessionDetail 里);
 *   · **替她答** —— 「等你确认」那一页上那张卡里的「我自己说」(asks/AskCards.tsx 的 PhoneSessionAsk)。
 *
 * 这一份钉四件:
 *   1. **框在首屏**:会话详情那张卡分三格 —— 抬头(不滚)· 对话(只有这一格滚)· 输入框(最下面那一格,
 *      永远在);框不在那个滚动的对话格里,所以滚多远它都在。
 *   2. **键盘弹起不盖住它**:两页都接上了 viewport/keyboardViewport 那一套(`data-ba-kb-page`),
 *      keyboard.css 里这两页的覆盖层高度钉成 --ba-app-h、内容盒下边界收到键盘上沿
 *      (iOS 的 `Keyboard.resize: None` 不压视口,不收这一下键盘就画在框上面)。
 *   3. **进页面不抢焦点**:光标不在框里(她点开是来看对话的,不是一进来就弹键盘)。
 *   4. **送到才提示**:捎话 `ok:true` / 替她答核实过 → 「已送到 · HH:MM」;
 *      没送到(送不进去 / 写进去了没看到它收下)→ **不提示**,照旧把工作台那句原因摆出来。
 *
 * jsdom 不排版(同 tests/keyboardCss.test.ts、orbSlotCss.test.ts 的理由):
 * 「在首屏 / 吸底」钉的是 DOM 里谁在哪一格 + CSS 文本里那几条规则,真机上的像素在交接文档里量。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { InboxPage } from '../src/items/InboxPage';
import { PhoneSessionAsk } from '../src/asks/AskCards';
import { SENT_OK_TEXT, sentOkLine } from '../src/composer/sentHint';
import { SAY_LABEL } from '../src/items/SessionSayBox';
import { installKeyboardViewport } from '../src/viewport/keyboardViewport';
import { SessionContext, type Session } from '../src/session';
import { createApiClient } from '../src/api/client';
import { createVoiceApi } from '../src/api/voice';
import { createCallApi } from '../src/api/call';
import { createAppearanceFeed } from '../src/swarm/appearance';
import { emptyState, type SessionDigestView, type SessionView, type WorkbenchState } from '../src/api/protocol';
import type { FeedSnapshot, StateFeed } from '../src/api/stateFeed';
import { fakeChannel, fakeRouted } from './wbchFakes';
import { registryOf } from './registryFixture';
import { hmOf, pinPhoneClock, unpinPhoneClock } from './clockFixture';

const SRC = resolve(__dirname, '../src');
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, ' ');
const STYLES = strip(readFileSync(resolve(SRC, 'styles.css'), 'utf8'));
const ASKS = strip(readFileSync(resolve(SRC, 'asks/asks.css'), 'utf8'));
const KB = strip(readFileSync(resolve(SRC, 'viewport/keyboard.css'), 'utf8'));

/** `/state.now`:屏上那个「已送到 · HH:MM」照它写(电脑的钟,见 src/clock.ts)。 */
const NOW = '2026-10-03T10:38:00.000Z';
const SESSION_ID = 'cx-9f3a1c2b7e';

function session(over: Partial<SessionView> = {}): SessionView {
  return {
    agent: 'codex', session_id: SESSION_ID, project: 'desktop-workbench', status: 'running',
    title: '把导出 PDF 做出来', elapsed_sec: 14 * 60, unread: false, updated_at: NOW,
    activity: { line: '在跑测试', at: '2026-10-03T10:30:00.000Z' },
    ...over,
  };
}

function state(sessions: SessionView[]): WorkbenchState {
  return { ...emptyState(), stale: false, now: NOW, sessions, agent_registry: registryOf(sessions, ['codex', 'claude']) } as WorkbenchState;
}

const digest = (over: Partial<SessionDigestView> = {}): SessionDigestView => ({
  agent: 'codex',
  session_id: SESSION_ID,
  title: '把导出 PDF 做出来',
  project: 'desktop-workbench',
  status: 'running',
  elapsed_sec: 14 * 60,
  activity: { line: '在跑测试', at: '2026-10-03T10:30:00.000Z' },
  rounds: [{ ask: '加个导出 PDF', reply: '在做,先把按钮摆上。', at: '2026-10-03T10:20:00.000Z' }],
  read_at: NOW,
  relay: { can: true },
  ...over,
});

/** 捎话那一条回什么。 */
function mount(relay: { status: number; body: unknown }) {
  const posts: { path: string; body: unknown }[] = [];
  const pairing = { token: 't', host: 'h', port: 8791, deviceId: 'd' };
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const path = url.slice(url.indexOf('/', 'http://'.length));
    if ((init?.method ?? 'GET') !== 'GET') posts.push({ path, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
    if (path.startsWith('/sessions/digest')) return new Response(JSON.stringify(digest()), { status: 200, headers: { 'content-type': 'application/json' } });
    if (path === '/sessions/relay') return new Response(JSON.stringify(relay.body), { status: relay.status, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ error: '没这条路' }), { status: 404 });
  }) as typeof fetch;
  const client = createApiClient({ pairing, fetchImpl, onUnauthorized: () => {} });
  const snapshot: FeedSnapshot = { state: state([session()]), connected: true, error: undefined };
  const feed: StateFeed = { get: () => snapshot, subscribe: () => () => {}, async refresh() {}, stop() {} };
  const ctx: Session = {
    pairing,
    client: fakeRouted(client, 'direct'),
    direct: client,
    feed,
    voice: createVoiceApi(client),
    call: createCallApi(client),
    channel: fakeChannel({}),
    appearance: createAppearanceFeed(client),
    settings: { async load() { throw new Error('用不到'); }, async update() { throw new Error('用不到'); } },
    async unpair() {},
  };
  render(
    <SessionContext.Provider value={ctx}>
      <InboxPage />
    </SessionContext.Provider>,
  );
  return { posts };
}

/** 点开「各家正在办」里那一条,拿到那张详情。 */
async function openSheet(): Promise<HTMLElement> {
  await act(async () => { fireEvent.click(within(screen.getByRole('region', { name: '各家正在办' })).getByRole('button')); });
  return await screen.findByRole('dialog', { name: '会话详情' });
}

async function say(sheet: HTMLElement, text: string): Promise<void> {
  await act(async () => { fireEvent.change(within(sheet).getByLabelText(SAY_LABEL), { target: { value: text } }); });
  await act(async () => { fireEvent.click(within(sheet).getByRole('button', { name: '发送' })); });
}

/** 键盘那一套的桩(同 tests/keyboardPages.test.tsx:视口 986 → 560 + keyboardHeight 426)。 */
const html = document.documentElement;
const v = (name: string) => html.style.getPropertyValue(name);
function setViewport(width: number, height: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
}
function keyboard(open: boolean): void {
  const ev = new Event(open ? 'keyboardWillShow' : 'keyboardWillHide') as Event & { keyboardHeight?: number };
  if (open) ev.keyboardHeight = 426;
  act(() => {
    window.dispatchEvent(ev);
    setViewport(443, open ? 560 : 986);
    window.dispatchEvent(new Event('resize'));
  });
}

beforeEach(() => {
  // 手机自己的墙钟钉在一个风马牛不相及的日子:屏上那个时刻要是看它,这一条就红(clockFixture.ts)。
  pinPhoneClock();
  setViewport(443, 986);
});
afterEach(() => { unpinPhoneClock(); });

describe('会话详情:输入框固定可见', () => {
  it('★三格 —— 抬头不滚 / 只有对话那一格滚 / 输入框在最下面那一格:框不在滚动区里,滚多远都在', async () => {
    mount({ status: 200, body: { ok: true } });
    const sheet = await openSheet();
    const card = sheet.querySelector('.ba-sheet__card--chat');
    expect(card).not.toBeNull();
    const head = card!.querySelector(':scope > .ba-sheet__head');
    const flow = card!.querySelector(':scope > .ba-sheet__flow');
    const dock = card!.querySelector(':scope > .ba-sheet__dock');
    expect(head).not.toBeNull();
    expect(flow).not.toBeNull();
    expect(dock).not.toBeNull();
    // 三格的顺序:抬头 → 对话 → 输入框(输入框排在最后 = 屏幕最下沿,单手打字拇指就在那儿)
    expect([...card!.children].map((one) => one.className)).toEqual([
      'ba-sheet__head', 'ba-sheet__flow', 'ba-sheet__dock',
    ]);
    // 框在 dock 里,**不在**那个会滚的对话格里
    const box = within(sheet).getByLabelText(SAY_LABEL);
    expect(dock!.contains(box)).toBe(true);
    expect(flow!.contains(box)).toBe(false);
    expect(head!.contains(box)).toBe(false);
    // 对话那一段(完整对话 / 退回去的「最近几轮」)就在中间那一格里
    expect(flow!.querySelector('.ba-sheet__rounds')).not.toBeNull();
  });

  it('★进页面不抢焦点:光标不在框里(她点开是来看对话的)', async () => {
    mount({ status: 200, body: { ok: true } });
    const sheet = await openSheet();
    const box = within(sheet).getByLabelText(SAY_LABEL);
    expect(document.activeElement).not.toBe(box);
    expect(box.hasAttribute('autofocus')).toBe(false);
  });

  it('★「关闭」挪到抬头那一行:不摆在输入框底下 —— 伸手打字时点不到它', async () => {
    mount({ status: 200, body: { ok: true } });
    const sheet = await openSheet();
    const close = within(sheet).getByRole('button', { name: '关闭' });
    expect(sheet.querySelector('.ba-sheet__head')!.contains(close)).toBe(true);
    expect(sheet.querySelector('.ba-sheet__dock')!.contains(close)).toBe(false);
  });

  it('★弹键盘:这一页接上了那一套(布局钉在没弹键盘那一档、框抬到键盘上沿),收起后 html 上什么都不留', async () => {
    const dispose = installKeyboardViewport(window);
    try {
      mount({ status: 200, body: { ok: true } });
      const sheet = await openSheet();
      expect(sheet.getAttribute('data-ba-kb-page')).not.toBeNull();
      const box = within(sheet).getByLabelText(SAY_LABEL);
      act(() => { box.focus(); });
      expect(html.getAttribute('data-ba-kb')).toBe('hold');
      keyboard(true);
      expect(html.getAttribute('data-ba-kb')).toBe('up');
      expect(v('--ba-app-h')).toBe('986px');
      expect(v('--ba-kb-shift')).toBe('426px');
      keyboard(false);
      act(() => { box.blur(); });
      expect(html.hasAttribute('data-ba-kb')).toBe(false);
    }
    finally { dispose(); }
  });
});

describe('送到了才提示(捎话)', () => {
  it('★送到了:框旁边一行「已送到 · 10:38」—— 时刻照电脑的钟,工作台那句话照旧摆着', async () => {
    mount({ status: 200, body: { ok: true, route: 'window', note: '捎到了 —— 你那句话已经送进 Codex 那条会话里了。' } });
    const sheet = await openSheet();
    await say(sheet, '现在到哪了');
    const sent = sheet.querySelector('[data-say="sent"]');
    expect(sent?.textContent).toBe(`${SENT_OK_TEXT} · ${hmOf(NOW)}`);
    expect(sent?.textContent).toBe(sentOkLine(NOW));
    // 那一行紧挨着输入框(同一格:dock)
    expect(sheet.querySelector('.ba-sheet__dock')!.contains(sent!)).toBe(true);
    expect(await within(sheet).findByText(/捎到了/)).toBeTruthy();
  });

  it('★留着等它醒(ok:true 但 delivered:kept):不提示「已送到」,只摆工作台那句「我留着」(2026-10-23 卡「捎话留言等它醒」)', async () => {
    mount({ status: 200, body: { ok: true, route: 'window', delivered: 'kept', note: '那条会话没开着,这句我留着,它一开就送进去' } });
    const sheet = await openSheet();
    await say(sheet, '现在到哪了');
    expect(sheet.querySelector('[data-say="sent"]')).toBeNull();
    expect(within(sheet).queryByText(new RegExp(SENT_OK_TEXT))).toBeNull();
    expect(await within(sheet).findByText(/这句我留着/)).toBeTruthy();
  });

  it('★没送进去:不提示「已送到」,照旧把工作台那句原因原样摆出来', async () => {
    mount({ status: 200, body: { ok: false, where: 'desk', why: '窗口里没找到那段对话', note: '捎不进去:窗口里没找到那段对话' } });
    const sheet = await openSheet();
    await say(sheet, '先停一下');
    expect(sheet.querySelector('[data-say="sent"]')).toBeNull();
    expect(within(sheet).queryByText(new RegExp(SENT_OK_TEXT))).toBeNull();
    expect((await within(sheet).findByText(/捎不进去/)).textContent).toContain('窗口里没找到那段对话');
  });

  it('★连不上工作台:同样不提示「已送到」', async () => {
    mount({ status: 500, body: { error: '工作台出错了' } });
    const sheet = await openSheet();
    await say(sheet, '喂');
    expect(sheet.querySelector('[data-say="sent"]')).toBeNull();
  });
});

describe('送到了才提示(替她答)', () => {
  function formAsk(extra: Record<string, unknown>): SessionView {
    return {
      agent: 'claude', session_id: 'd999', project: 'ben-dsh-workbench', status: 'waiting', wait_reason: 'input', title: '统筹',
      elapsed_sec: 600, unread: false, updated_at: NOW,
      ask: {
        kind: 'choose', question: '今天的模型额度只剩 0.58 元。', since: NOW, by: 'form' as const,
        options: [{ label: '把上限提到 15 元' }], reply: 'desk' as const, press: true as const, ...extra,
      },
    } as SessionView;
  }

  it('★工作台核实过:「已送到 · 10:38」就在「我自己说」那个框旁边', async () => {
    const sayFn = vi.fn(async () => ({ ok: true as const, confirmed: true, text: '已替你答了:换成江浙菜' }));
    const { container } = render(<PhoneSessionAsk session={formAsk({ write: true })} answer={vi.fn()} say={sayFn} now={NOW} />);
    fireEvent.change(screen.getByLabelText('我自己说'), { target: { value: '换成江浙菜' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '回复' })); });
    expect(container.querySelector('[data-ask="sent"]')?.textContent).toBe(`${SENT_OK_TEXT} · ${hmOf(NOW)}`);
  });

  it('★写进去了、没看到它收下:**不算送到** —— 不提示,照工作台那句原话说', async () => {
    const sayFn = vi.fn(async () => ({ ok: true as const, confirmed: false, text: '写进去按了发送,但没看到它收下 —— 去电脑上的 Claude 看一眼' }));
    const { container } = render(<PhoneSessionAsk session={formAsk({ write: true })} answer={vi.fn()} say={sayFn} now={NOW} />);
    fireEvent.change(screen.getByLabelText('我自己说'), { target: { value: '换成江浙菜' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '回复' })); });
    expect(container.querySelector('[data-ask="sent"]')).toBeNull();
    expect(await screen.findByText(/没看到它收下/)).toBeTruthy();
  });

  it('★送不回去(工作台说得去电脑上):不提示', async () => {
    const sayFn = vi.fn(async () => ({ ok: false as const, desk: true, text: '这一问得在电脑上的 Claude 里回答' }));
    const { container } = render(<PhoneSessionAsk session={formAsk({ write: true })} answer={vi.fn()} say={sayFn} now={NOW} />);
    fireEvent.change(screen.getByLabelText('我自己说'), { target: { value: '换成江浙菜' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '回复' })); });
    expect(container.querySelector('[data-ask="sent"]')).toBeNull();
  });

  it('还没连上电脑(/state.now 是空的):只写「已送到」,不拿手机的墙钟凑一个数', async () => {
    const sayFn = vi.fn(async () => ({ ok: true as const, confirmed: true }));
    const { container } = render(<PhoneSessionAsk session={formAsk({ write: true })} answer={vi.fn()} say={sayFn} now="" />);
    fireEvent.change(screen.getByLabelText('我自己说'), { target: { value: '嗯' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '回复' })); });
    expect(container.querySelector('[data-ask="sent"]')?.textContent).toBe(SENT_OK_TEXT);
  });
});

describe('CSS 那一层(jsdom 不排版,按文本钉)', () => {
  it('★会话详情那张卡:三格一列,只有中间那一格滚,输入框那一格不许被压掉', () => {
    expect(STYLES).toMatch(/\.ba-sheet__card--chat\s*\{[^}]*display:\s*flex/);
    expect(STYLES).toMatch(/\.ba-sheet__card--chat\s*\{[^}]*flex-direction:\s*column/);
    // 卡自己不滚了(滚的是中间那一格):overflow 收成 hidden
    expect(STYLES).toMatch(/\.ba-sheet__card--chat\s*\{[^}]*overflow:\s*hidden/);
    expect(STYLES).toMatch(/\.ba-sheet__flow\s*\{[^}]*flex:\s*1 1 auto/);
    expect(STYLES).toMatch(/\.ba-sheet__flow\s*\{[^}]*min-height:\s*0/);
    // 输入框那一格 flex-shrink: 0 —— 地方不够时压的是对话,不是它
    expect(STYLES).toMatch(/\.ba-sheet__dock\s*\{[^}]*flex:\s*0 0 auto/);
    // 抬头也不让、封顶 34vh:让它跟着让的话,地方一紧先掉的是它最后那一行(真机上量过)
    expect(STYLES).toMatch(/\.ba-sheet__head\s*\{[^}]*flex:\s*0 0 auto/);
    expect(STYLES).toMatch(/\.ba-sheet__head\s*\{[^}]*max-height:\s*calc\(var\(--ba-vh, 1vh\) \* 34\)/);
    // 横屏屏高只有 ~375:抬头再收一档,不然对话只剩十来个像素(812×375 上量过)
    expect(STYLES).toMatch(/@media \(orientation: landscape\) \{\s*\.ba-sheet__head\s*\{[^}]*max-height:\s*calc\(var\(--ba-vh, 1vh\) \* 20\)/);
    // 屏高一律写成 var(--ba-vh, 1vh)(keyboardCss 那条规矩:键盘开着时它钉在没弹键盘那一档)
    const chat = /\.ba-sheet__card--chat\s*\{([^}]*)\}/.exec(STYLES)?.[1] ?? '';
    expect(chat).toContain('var(--ba-vh, 1vh)');
    expect(chat.replace(/var\(--ba-vh, 1vh\)/g, '')).not.toMatch(/\d(\.\d+)?vh\b/);
  });

  it('★「我自己说」那个框吸底:那张卡还在屏上,它就浮在屏幕下沿', () => {
    expect(ASKS).toMatch(/\.ba-ask__own\s*\{[^}]*position:\s*sticky/);
    expect(ASKS).toMatch(/\.ba-ask__own\s*\{[^}]*bottom:\s*calc\(var\(--ba-safe-bottom/);
    // 底色要实的:不然底下那几行字从它身上透过来(两种页各自给值)
    expect(ASKS).toMatch(/\.ba-ask__own\s*\{[^}]*background:\s*var\(--ba-ask-dock-bg/);
    expect(ASKS).toMatch(/\.ba-asks-page\s*\{[^}]*--ba-ask-dock-bg:/);
    expect(STYLES).toMatch(/\.ba-sheet__card\s*\{[^}]*--ba-ask-dock-bg:/);
  });

  it('★键盘弹起:两页的覆盖层高度钉成 --ba-app-h、内容盒下边界收到键盘上沿(iOS 不压视口,不收就盖住框)', () => {
    expect(KB).toMatch(/html\[data-ba-kb\][^{]*\.ba-sheet[^{]*\{[^}]*height:\s*var\(--ba-app-h/);
    expect(KB).toMatch(/html\[data-ba-kb="up"\][^{]*\.ba-sheet[^{]*\{[^}]*padding-bottom:\s*var\(--ba-kb-shift/);
    expect(KB).toMatch(/html\[data-ba-kb\][^{]*\.ba-asks-page[^{]*\{[^}]*height:\s*var\(--ba-app-h/);
    expect(KB).toMatch(/html\[data-ba-kb="up"\][^{]*\.ba-asks-page[^{]*\{[^}]*padding-bottom:\s*var\(--ba-kb-shift/);
    // 她在打字时抬头让出来(小屏 + 大键盘上量过:不让的话对话一行都不剩,而她正要回的那句就在对话里)
    expect(KB).toMatch(/html\[data-ba-kb="up"\] \.ba-sheet__head\s*\{[^}]*flex:\s*0 1 auto/);
    expect(KB).toMatch(/html\[data-ba-kb="up"\] \.ba-sheet__head\s*\{[^}]*max-height:\s*calc\(var\(--ba-vh, 1vh\) \* 16\)/);
    // keyboard.css 的两条老规矩不许破:不引入颜色、不加动效
    expect(KB).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(KB).not.toMatch(/transition|animation/);
  });

  it('★那颗 toast 得画在「等你确认」那一页前面(以前同一档 z-index、又排在它后面 = 整条看不见)', () => {
    const toast = Number(/\.ba-toast\s*\{[^}]*z-index:\s*(\d+)/.exec(STYLES)?.[1] ?? '0');
    const asksPage = Number(/\.ba-asks-page\s*\{[^}]*z-index:\s*(\d+)/.exec(ASKS)?.[1] ?? '0');
    expect(asksPage).toBeGreaterThan(0);
    expect(toast).toBeGreaterThan(asksPage);
  });
});
