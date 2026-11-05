/**
 * 首页在小米 10S(0.2.88,约 412 CSS px 宽)上走样的那几件(2026-09-25 晚,卡 fix/phone-home-card-fit)。统筹原话:
 *   1. 顶上「未接来电 2」那块长标题不换行、撑出屏幕,整页变宽 → 球被挤到右边缘只露半个,字幕被切;
 *   2. 未接来电那块太占地方、在球上面:应在球下面收成一行,已取消的事引起的未接不该再显眼地挂着;
 *   3. 球下字幕显示了已取消的事(还带一行红字);
 *   5. 球的颜色两端同一口径:有真失败且还没处理才红,待确认琥珀,其余中性。
 *
 * jsdom 不排版:「不横向溢出」这件事在这里钉的是**规则在不在**(CSS 文本)与**超长标题落在哪个会截断的格子里**;
 * 真排出来的样子看交接里的无头 Chrome 截图(那边量了 scrollWidth)。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MissedCalls, MISSED_FOLD_LABEL } from '../src/call/MissedCalls';
import { parseCallLog } from '../src/call/incomingModel';
import { captionEligible, captionLinesOf } from '../src/stage/captionModel';
import { buildThread } from '../src/chat/chatModel';
import { isOpenFailure, signalsFromState, stageModeOf } from '../src/swarm/orbState';
import { App } from '../src/App';
import { createTokenStore, type KeyValueStore } from '../src/api/tokenStore';
import { createSettingsStore } from '../src/settings/settingsStore';
import { emptyState, type TaskView, type WorkbenchState } from '../src/api/protocol';

afterEach(() => { cleanup(); });

const LONG = '[派活测试] 让 Kimi 用一句话回答:一年有几个季节?这一句故意写得非常非常长,长到一行怎么都放不下,用来钉住不许把整页撑宽的那条规矩';

function mine(over: Partial<TaskView> & { id: string; title: string }): TaskView {
  return { status: 'todo', direction: 'mine', origin: 'user', created_at: '2026-09-24T14:50:00Z', updated_at: '2026-09-24T14:50:00Z', ...over };
}

/** 台账里三通未接:一通是已经取消的那件(t-cancel)引起的,两通还开着。 */
const RAW_LOG = {
  missed: 3,
  config: { enabled: true, done_call: false },
  entries: [
    { id: 'c1', reason: 'confirm', item_id: 't-confirm', title: '[测试·统筹验证,可忽略] 我的规矩有哪些?不要翻文件,直接说。', at: '2026-09-24T15:20:00Z', state: 'missed', error: '响了 60 秒没人接' },
    { id: 'c2', reason: 'failed', item_id: 't-cancel', title: LONG, at: '2026-09-24T14:54:00Z', state: 'missed', error: '响了 60 秒没人接' },
    { id: 'c3', reason: 'failed', item_id: 't-open', title: `还开着的一件:${LONG}`, at: '2026-09-24T14:40:00Z', state: 'missed', error: '响了 60 秒没人接' },
  ],
};
const LOG = parseCallLog(RAW_LOG);
const ok = async () => ({ ok: true as const });

describe('② 未接来电:球下面收成一行,已收场的不挂', () => {
  it('★一行:「未接来电 2」+「最近:…」(已取消那件引起的那一通不算、不挂),整行点开才铺开', () => {
    render(<MissedCalls log={LOG} onCallBack={ok} onClear={ok} compact hideItems={new Set(['t-cancel'])} />);
    const box = document.querySelector('.ba-missed')!;
    expect(box.getAttribute('data-compact')).toBe('true');
    expect(box.getAttribute('data-open')).toBe('false');
    const line = within(box as HTMLElement).getByRole('button', { expanded: false });
    expect(line.textContent).toContain('未接来电 2');
    expect(line.textContent).toContain('最近:等你确认 [测试·统筹验证,可忽略]');
    // 收着的时候那几行不在。
    expect(document.querySelectorAll('.ba-missed__row')).toHaveLength(0);

    fireEvent.click(line);
    expect(document.querySelectorAll('.ba-missed__row')).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: '回拨' }).length).toBeGreaterThan(0);
    // 铺开了也只有还开着的那两件;已取消那件(标题正好是 LONG)那一行不在。
    const names = [...document.querySelectorAll('.ba-missed__name')].map((one) => one.textContent);
    expect(names).not.toContain(LONG);
    expect(names).toContain(`还开着的一件:${LONG}`);
    fireEvent.click(screen.getByRole('button', { name: MISSED_FOLD_LABEL }));
    expect(document.querySelectorAll('.ba-missed__row')).toHaveLength(0);
  });

  it('超长标题落在会截断的那一格里(`.ba-missed__latest` / `.ba-missed__name`),不在一个会撑宽的格子里', () => {
    render(<MissedCalls log={LOG} onCallBack={ok} onClear={ok} compact />);
    expect(document.querySelector('.ba-missed__latest')?.textContent).toContain('最近:');
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    const names = [...document.querySelectorAll('.ba-missed__name')].map((one) => one.textContent);
    expect(names).toContain(LONG);
  });

  it('未接都是已收场的事引起的:整块不出现', () => {
    const { container } = render(<MissedCalls log={LOG} onCallBack={ok} onClear={ok} compact hideItems={new Set(['t-cancel', 't-open', 't-confirm'])} />);
    expect(container.querySelector('.ba-missed')).toBeNull();
  });
});

describe('① 不许横向溢出:CSS 那一层', () => {
  const CSS = readFileSync(resolve(__dirname, '../src/styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ');
  const rule = (selector: string) => {
    const at = CSS.indexOf(`${selector} {`);
    expect(at, `没找到 ${selector}`).toBeGreaterThan(-1);
    return CSS.slice(at, CSS.indexOf('}', at));
  };

  it('★壳的列只认屏宽(minmax(0, 1fr)):任何一段不换行的长字都撑不宽整页', () => {
    expect(rule('.ba-shell')).toMatch(/grid-template-columns: minmax\(0, 1fr\)/);
    expect(rule('.ba-pane')).toMatch(/min-width: 0/);
    // 折叠屏并排那一档:右边那一列同样不许被撑宽。
    expect(CSS).toMatch(/grid-template-columns: minmax\(280px, 38%\) minmax\(0, 1fr\)/);
  });

  it('未接那几行:外层能缩到 0、标题自己截断带省略号', () => {
    expect(rule('.ba-missed__what')).toMatch(/min-width: 0/);
    expect(rule('.ba-missed__name')).toMatch(/min-width: 0/);
    expect(rule('.ba-missed__name')).toMatch(/text-overflow: ellipsis/);
    expect(rule('.ba-missed__latest')).toMatch(/text-overflow: ellipsis/);
    expect(rule('.ba-missed__latest')).toMatch(/min-width: 0/);
  });
});

describe('③ 字幕:取消了的不上,红字只给还开着的事', () => {
  const failedDispatch = { hand: 'window', family: 'kimi', status: 'failed', at: '2026-09-24T14:53:40Z', reason: '壳没说为什么,只说没送成' } as unknown as TaskView['client_dispatch'];

  it('★最后一件是已取消的派活(还带着「没送成」):字幕退到前一件还开着的事', () => {
    const state: WorkbenchState = {
      ...emptyState(), stale: false,
      tasks: { tasks: [
        mine({ id: 't-open', title: '把首页卡片的字对齐一下', created_at: '2026-09-24T14:40:00Z' }),
        mine({ id: 't-cancel', title: LONG, status: 'canceled', client_dispatch: failedDispatch, created_at: '2026-09-24T14:52:54Z' }),
      ] },
    };
    const lines = captionLinesOf(buildThread(state));
    expect(lines.me?.text).toBe('把首页卡片的字对齐一下');
    expect(lines.butler?.kind).not.toBe('error');
  });

  it('同一件派活还开着时,那行红字照上(真出错、还没处理)', () => {
    const state: WorkbenchState = { ...emptyState(), stale: false, tasks: { tasks: [mine({ id: 't', title: '让 Kimi 答一句', client_dispatch: failedDispatch })] } };
    expect(captionLinesOf(buildThread(state)).butler?.kind).toBe('error');
  });

  // 2026-09-25 夜(卡 fix/phone-home-orb-first,统筹拍板一刀切):办完了的,哪怕是一句真回答,也不上首页字幕。
  it('captionEligible:只取还在办 / 等你确认的;取消的、办完的(连真回答)都不上;刚发出去的上', () => {
    const reply = { kind: 'reply' as const, text: '版本号补好了。', speak: true };
    const status = { kind: 'status' as const, text: '办完了', speak: false };
    const error = { kind: 'error' as const, text: '派给 Kimi 没送成', speak: false };
    const at = '2026-09-24T15:00:00Z';
    expect(captionEligible({ taskId: 'a', user: 'x', at, butler: reply, status: 'canceled' })).toBe(false);
    expect(captionEligible({ taskId: 'a', user: 'x', at, butler: reply, status: 'done' })).toBe(false);
    expect(captionEligible({ taskId: 'a', user: 'x', at, butler: status, status: 'done' })).toBe(false);
    expect(captionEligible({ taskId: 'a', user: 'x', at, butler: error, status: 'done' })).toBe(false);
    expect(captionEligible({ taskId: 'a', user: 'x', at, butler: reply, status: 'confirm' })).toBe(true);
    expect(captionEligible({ taskId: 'a', user: 'x', at, butler: error, status: 'doing' })).toBe(true);
    expect(captionEligible({ localId: 'l', user: 'x', at, butler: status })).toBe(true);
  });
});

describe('⑤ 球的颜色:真失败没处理才红,等你确认琥珀,其余中性(与电脑首页同一口径)', () => {
  const failedDispatch = { hand: 'window', family: 'kimi', status: 'failed', at: '2026-09-24T14:53:40Z' } as unknown as TaskView['client_dispatch'];
  const signals = (state: WorkbenchState) => stageModeOf(signalsFromState(state, { speaking: false, listening: false }));
  const base = (): WorkbenchState => ({ ...emptyState(), stale: false });

  it('★已取消的派活失败 + 两通未接 + 一张等你确认:琥珀,不红', () => {
    const state: WorkbenchState = {
      ...base(),
      tasks: { tasks: [mine({ id: 't-cancel', title: '派活测试', status: 'canceled', client_dispatch: failedDispatch })] },
      butler_inbox: { items: [{ id: 'confirm:t1', kind: 'confirm', title: '等你点头' }] },
    };
    expect(signals(state)).toEqual({ mode: 'acknowledging', notice: 'confirmation' });
  });

  it('还开着的一件派活没送成 / 卡在出错上:红', () => {
    expect(signals({ ...base(), tasks: { tasks: [mine({ id: 'a', title: 'x', client_dispatch: failedDispatch })] } }).notice).toBe('failed');
    expect(signals({ ...base(), tasks: { tasks: [mine({ id: 'b', title: 'y', status: 'blocked', block_reason: 'error' })] } }).notice).toBe('failed');
    expect(isOpenFailure(mine({ id: 'c', title: 'z', status: 'done', block_reason: 'error' }))).toBe(false);
  });

  it('「我照你说的摆好了」那张单子等他点头:琥珀;落好了就不算', () => {
    const plan = { id: 'plan-1', status: 'pending', line: '都摆好了', source: 'rules', counts: { projects: 2, tasks: 10, cancel: 7 }, groups: [], rows: [], created_at: '2026-09-24T12:30:00Z' } as unknown as WorkbenchState['materialize'];
    expect(signals({ ...base(), materialize: plan }).notice).toBe('confirmation');
    expect(signals({ ...base(), materialize: { ...plan!, status: 'applied' } }).notice).toBe('neutral');
  });

  it('什么都没有:中性', () => {
    expect(signals(base())).toEqual({ mode: 'idle', notice: 'neutral' });
  });
});

describe('① ② 挂到 App 上:竖屏首页', () => {
  function memory(): KeyValueStore & { data: Map<string, string> } {
    const data = new Map<string, string>();
    return { data, async get(k) { return data.get(k) ?? null; }, async set(k, v) { data.set(k, v); }, async remove(k) { data.delete(k); } };
  }
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  /**
   * 2026-10-03 下午(卡「首页侧边小图标」,维护者:「未接来电和各家的最近对话换个地方放,做成小图标放到侧边吧,
   * 而且现在的我还点击不到」):**收起来的那一行换成了球那一栏边上那颗小图标**(角标写数),
   * 点它才把原来那一块挂上来。这一条原来钉的三件事一件没删,只是从「那一行」改成「那颗图标 + 点开之后那一块」:
   * ① 不在 `.ba-pane--stage` 上、在舞台页里;② 已取消那件引起的那一通不挂(角标 2,不是 3);
   * ③ 超长标题落在会截断的那一格里。
   */
  it('★未接收成球那一栏边上那颗小图标(角标 2);点开才铺开;已取消那件引起的那一通不挂;超长标题在会截断的格子里', async () => {
    window.matchMedia = ((query: string) => ({ matches: false, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } })) as unknown as typeof window.matchMedia;
    const kv = memory();
    kv.data.set('butler.pairing', JSON.stringify({ token: 'T', host: '10.0.0.9', port: 8795, deviceId: 'd1' }));
    const settings = memory();
    settings.data.set('butler.settings', JSON.stringify({ voiceEnabled: true, avatarId: null, onboarding: 'done', stage: 'particles', callProvider: 'livekit' }));
    const state = {
      now: '2026-09-24T23:30:00+08:00', stale: false, sessions: [],
      tasks: { tasks: [
        mine({ id: 't-cancel', title: LONG, status: 'canceled' }),
        mine({ id: 't-open', title: `还开着的一件:${LONG}` }),
        mine({ id: 't-confirm', title: '[测试·统筹验证,可忽略] 我的规矩有哪些?', status: 'confirm' }),
      ] },
      butler_inbox: { items: [] }, onboarding: { stage: 'done', done: true },
    };
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/state')) return json(200, state);
      if (url.endsWith('/call/log')) return json(200, RAW_LOG);
      return json(503, { error: '没配' });
    });
    render(<App tokenStore={createTokenStore(kv)} settingsStore={createSettingsStore(settings)} fetchImpl={fetchImpl as unknown as typeof fetch} />);
    // 角标 = 挂出来的那几通(已取消那件引起的那一通不算):台账里 3 通,挂出来 2 通。
    const icon = await waitFor(() => {
      const one = document.querySelector<HTMLElement>('.ba-scene__stage > .ba-rail .ba-rail__btn');
      expect(one?.querySelector('.ba-rail__badge')?.textContent).toBe('2');
      return one!;
    }, { timeout: 3000 });
    // 没点之前主列、整格里都没有那一块。
    expect(document.querySelector('.ba-missed')).toBeNull();
    expect(document.querySelector('.ba-pane--stage > .ba-missed')).toBeNull();

    fireEvent.click(icon);
    const missed = document.querySelector<HTMLElement>('.ba-scene__stage > .ba-rail-sheet > .ba-missed')!;
    expect(missed.getAttribute('data-compact')).toBe('true');
    expect(missed.textContent).toContain('未接来电 2');
    // 铺开了也只有还开着的那两件;已取消那件(标题正好是 LONG)那一行不在,长标题落在会截断的那一格里。
    const names = [...document.querySelectorAll('.ba-missed__name')].map((one) => one.textContent);
    expect(names).not.toContain(LONG);
    expect(names).toContain(`还开着的一件:${LONG}`);
  });
});

/**
 * 2026-09-25 夜(卡 fix/phone-home-orb-first):统筹小米 0.2.92,一段办完的长回答约 32px 大字占了五行、下面还有一颗「停」,
 * 球被压成顶上一个约 50px 的小点。维护者规矩第 1 条:球是主角、够大、不许被文字挤没。
 * jsdom 不排版,这里钉的是规则在不在;真排出来的样子看交接里的截图(球的直径与字幕来去无关)。
 */
describe('⑥ 球先定大小,字幕在剩下的地方(CSS 那一层)', () => {
  const CSS = readFileSync(resolve(__dirname, '../src/styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ');

  it('★字幕那一格定高:一份看不见的「他一行 + 她两行」垫着(按真字体排,不写像素),真字幕叠在同一格', () => {
    expect(CSS).toMatch(/\.ba-scene__captions \{[^}]*display: grid/);
    expect(CSS).not.toMatch(/\.ba-scene__captions \{[^}]*min-height: 6\.5rem/);
    expect(CSS).toMatch(/\.ba-scene__capspace, \.ba-scene__capbody \{[^}]*grid-area: 1 \/ 1/);
    expect(CSS).toMatch(/\.ba-scene__capspace \{[^}]*visibility: hidden/);
    expect(CSS).toMatch(/\.ba-scene__capline\[data-role="me"\]::before \{[^}]*content: '国'/);
    expect(CSS).toMatch(/\.ba-scene__capline\[data-role="butler"\]::before \{[^}]*content: '国\\A国'/);
    // 球那一格拿剩下的全部。
    expect(CSS).toMatch(/\.ba-scene__orb \{[^}]*flex: 1 1 auto/);
  });

  it('★她那句最多两行、字号降一档、多了省略号(line-clamp);他那句一行省略号', () => {
    expect(CSS).toMatch(/\.ba-scene__caption\[data-role="butler"\] \{[^}]*-webkit-line-clamp: 2/);
    expect(CSS).toMatch(/\.ba-scene__caption\[data-role="butler"\] \{[^}]*font-size: var\(--ba-fs-title\)/);
    expect(CSS).not.toMatch(/\.ba-scene__caption\[data-role="butler"\] \{[^}]*--ba-fs-caption/);
    expect(CSS).toMatch(/\.ba-scene__caption\[data-role="me"\] \{[^}]*white-space: nowrap[^}]*text-overflow: ellipsis/);
  });

  /**
   * 2026-09-26(卡 QH 第二轮):这一条原来钉的是「`.ba-scene__hush` 用 `margin: 0 auto` 居中 +
   * 它后面那颗 icon 收掉 auto」。那两条规则没了 —— 「停止朗读」搬进了 `.ba-scene__status`
   * (绝对定位叠在顶格里),居中由那一叠负责。要钉的意图没变:**它在顶上那一排正中,不占字幕的地方**,
   * 现在连「也不占球的地方」一起钉(见下面那条「状态行不许挤球」)。
   */
  it('「停止朗读」那颗在顶上那一排正中,不占字幕的地方', () => {
    // 居中由中间那一格负责(grid + 居中),它自己不再用 auto 外边距。
    expect(CSS).toMatch(/\.ba-scene__topspace, \.ba-scene__status \{[^}]*align-items: center[^}]*justify-content: center/);
    expect(CSS).toMatch(/\.ba-scene__hush, \.ba-scene__hushspace \{[^}]*margin: 0;/);
    // 字幕那一格里不许再有它(它住在顶格)。
    expect(CSS).not.toMatch(/\.ba-scene__captions[^{]*\{[^}]*ba-scene__hush/);
  });
});
