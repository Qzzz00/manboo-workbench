/**
 * 卡 feat/first-look-orb-top(2026-09-25)手机那一半。维护者 09-24 晚:
 *   「手机的不要这个什么所谓的座机页面,就显示首页就好了...多此一举」(插着线充电时自动进了座机页)
 *   「最近一次通话:还没有通过电话 —— 其实刚打了 27 分钟」
 *   首页球下面那行字是事项的出处说明(「引导 ②′ 排的方案…」+「会话未开」),不是给人看的
 *
 * 断言写的是**他在手机上看得到什么**。存储与 fetch 都是假的,不碰任何真机器。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App } from '../src/App';
import { createTokenStore, type KeyValueStore } from '../src/api/tokenStore';
import { createSettingsStore } from '../src/settings/settingsStore';
import { buildThread } from '../src/chat/chatModel';
import { captionLinesOf } from '../src/stage/captionModel';
import { itemCard } from '../src/items/itemsModel';
import { stageCards } from '../src/stage/stageCardsModel';
import { emptyState, type TaskView, type WorkbenchState } from '../src/api/protocol';

const native = vi.hoisted(() => ({ setDeskPhone: vi.fn(async (_input: { on: boolean }) => ({ on: false })) }));
vi.mock('@capacitor/core', async (importOriginal) => {
  const real = await importOriginal<typeof import('@capacitor/core')>();
  return {
    ...real,
    registerPlugin: (name: string) => (name === 'DeskPhone'
      ? { setDeskPhone: native.setDeskPhone, status: async () => ({ notifications: true, fullScreen: true, deskPhone: false }), startRinging: async () => ({}), stopRinging: async () => {}, requestNotifications: async () => ({ granted: true }) }
      : real.registerPlugin(name)),
  };
});

afterEach(() => { cleanup(); sessionStorage.clear(); vi.unstubAllGlobals(); });

function memory(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, async get(k) { return data.get(k) ?? null; }, async set(k, v) { data.set(k, v); }, async remove(k) { data.delete(k); } };
}
function jsonRes(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
function mine(over: Partial<TaskView> & { id: string; title: string }): TaskView {
  return { status: 'todo', direction: 'mine', created_at: '2026-09-24T10:27:27Z', updated_at: '2026-09-24T10:27:27Z', ...over };
}

/** 维护者 09-24 晚那份看板的形状(四条引导排的 + 老通话纪要 + 今晚那通引导的纪要)。 */
const TASKS: TaskView[] = [
  mine({ id: 'onb-1', title: '让她能自己扫仓库,不用你口述', desc: '引导 ②′ 排的方案「desktop-workbench」。你自己说的头号需求' }),
  mine({ id: 'call-old', title: '和事务官通了个电话(34 秒)', desc: '时长:34 秒。\n\n通话里说了:\n我:是一段测试声音。', status: 'done', created_at: '2026-09-24T09:33:06Z' }),
  mine({ id: 'call-onb', title: '引导通话(27 分钟)', desc: '时长:27 分。', status: 'done', origin: 'call', created_at: '2026-09-24T10:52:00Z', call: { kind: 'onboarding', summary: '引导走完了:项目(desktop-workbench)、授权、习惯都记下了', duration_seconds: 1620 } }),
];
const STATE = { now: '2026-09-24T19:05:00+08:00', stale: false, sessions: [], tasks: { tasks: TASKS }, butler_inbox: { items: [] }, onboarding: { stage: 'done', done: true } };

async function mountApp(settingsJson: Record<string, unknown> = {}) {
  const kv = memory();
  kv.data.set('butler.pairing', JSON.stringify({ token: 'T', host: '10.0.0.9', port: 8795, deviceId: 'd1' }));
  const settings = memory();
  settings.data.set('butler.settings', JSON.stringify({ voiceEnabled: true, avatarId: null, onboarding: 'done', stage: 'particles', callProvider: 'livekit', ...settingsJson }));
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/state')) return jsonRes(200, STATE);
    if (url.endsWith('/call/log')) return jsonRes(200, { missed: 0, config: { enabled: true, done_call: false }, entries: [] });
    if (url.endsWith('/call/config')) return jsonRes(200, { enabled: true, quiet_from: '23:00', quiet_to: '08:00', done_call: false });
    return jsonRes(503, { error: '没配' });
  });
  render(<App tokenStore={createTokenStore(kv)} settingsStore={createSettingsStore(settings)} fetchImpl={fetchImpl as unknown as typeof fetch} />);
  await waitFor(() => expect(document.querySelector('.ba-scene')).toBeTruthy(), { timeout: 3000 });
  return { settings };
}

describe('① 座机页整个去掉了', () => {
  /** 一块「正在充电」的电池(插电脑 USB 或充电器都一样)。以前 auto 档一插电就整屏换成座机页。 */
  beforeEach(() => {
    vi.stubGlobal('navigator', Object.assign(Object.create(navigator), {
      getBattery: async () => ({ charging: true, addEventListener: () => {}, removeEventListener: () => {} }),
    }));
  });

  it('★插着电、老设置里还开着「座机模式:始终」→ 照样是首页(球 + 卡片),没有大时钟那一页', async () => {
    await mountApp({ deskPhone: 'always', deskPhoneOnCharge: true });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(document.querySelector('.ba-desk')).toBeNull();
    expect(screen.getByRole('list', { name: '首页卡片' })).toBeTruthy();
  });

  it('进来时把原生那边可能还挂着的「常亮 / 锁屏上显示」关一次(老版本开过座机模式的手机)', async () => {
    native.setDeskPhone.mockClear();
    await mountApp();
    await waitFor(() => expect(native.setDeskPhone).toHaveBeenCalledWith({ on: false }));
  });

  it('★设置里没有「座机模式 / 放上无线充就进座机页 / 拿下来回到舞台」了;添加座机、主动来电照旧在', async () => {
    await mountApp();
    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    const settings = document.querySelector<HTMLElement>('.ba-pane--settings')!;
    // 2026-09-27(卡 SZ2):设置首屏只剩八行分组 —— 主动来电在「提醒与免打扰」,配座机在「座机」。
    fireEvent.click(within(settings).getByText('提醒与免打扰'));
    await waitFor(() => expect(within(settings).getByText('有事的时候主动打电话给我')).toBeTruthy(), { timeout: 3000 });
    expect(within(settings).queryByText(/座机模式/)).toBeNull();
    expect(within(settings).queryByText(/无线充/)).toBeNull();
    expect(within(settings).queryByText(/回到舞台/)).toBeNull();
    fireEvent.click(within(settings).getByLabelText('返回'));
    fireEvent.click(within(settings).getByText('座机'));
    expect(within(settings).getByRole('button', { name: '添加座机(实体话筒)' })).toBeTruthy();
    expect(within(settings).queryByText(/座机模式/)).toBeNull();
  });
});

/**
 * 2026-10-03 傍晚(卡「首页两卡 + 一排图标」= 方案 B,维护者看过示意图):
 * 「最近一次通话」从主列里那张卡**收成球下那一排里的一颗图标**,内容在通话记录那一页上。
 * 这一条钉的两件事一件没删,只是换了落点:
 *   ① 那一通算的是引导那一通(摘要那一句,不是「还没有通过电话」)—— 在**模型**那一层钉
 *      (`callCard` 那一份,它照旧是「最近一次通话是什么」的口径);
 *   ② 点那颗图标**直接打开最近那一通**(去处 `{page:'calls', callId}`;老纪要卡的 callId 就是卡的 id)。
 */
describe('② 首页:最近一次通话是引导那一通;那颗图标点下去是那张纪要', () => {
  it('★「最近一次通话」那一份写引导那一通的一句话摘要,不写「还没有通过电话」', () => {
    const s: WorkbenchState = { ...emptyState(), ...STATE } as unknown as WorkbenchState;
    const card = stageCards(s).find((one) => one.id === 'call')!;
    expect(card.lines[0]?.text).toContain('引导走完了');
    expect(card.empty).toContain('还没有通话记录');
    expect(card.to).toEqual({ page: 'calls', callId: 'call-onb' });
  });

  it('★球下那一排里「最近一次通话」那颗:点下去打开那张纪要卡', async () => {
    await mountApp();
    const icon = await waitFor(() => screen.getByRole('button', { name: '打开「最近一次通话」' }), { timeout: 3000 });
    // 它在球那一栏里那一排上,**不在主列的卡片区里**(那三张卡搬走了)。
    expect(icon.closest('.ba-scene__stage > .ba-rail')).toBeTruthy();
    expect(document.querySelector('[data-card="call"]')).toBeNull();
    fireEvent.click(icon);
    const detail = await screen.findByRole('dialog', { name: '事项详情' });
    expect(detail.textContent).toContain('引导通话(27 分钟)');
    // 纪要卡不开会话,不该挂一句「会话未开」。
    expect(detail.textContent).not.toContain('会话未开');
  });
});

describe('③ 球下面那行字幕不再是出处说明', () => {
  it('系统写下的卡(引导排的、通话纪要)不进对话记录;他亲口交代的照旧', () => {
    const state: WorkbenchState = { ...emptyState(), stale: false, tasks: { tasks: [...TASKS, mine({ id: 'u1', title: '把首页文案改一版', desc: '把首页文案改一版,语气轻一点', created_at: '2026-09-24T11:00:00Z' })] } };
    const thread = buildThread(state);
    expect(thread.map((m) => m.taskId)).toEqual(['u1']);
    expect(thread[0]!.user).toBe('把首页文案改一版,语气轻一点');
    expect(thread.some((m) => m.user.startsWith('引导'))).toBe(false);
  });

  it('★字幕那一句写事项标题,不写 desc(desc 不上首页)', () => {
    const state: WorkbenchState = { ...emptyState(), stale: false, tasks: { tasks: [...TASKS, mine({ id: 'u1', title: '把首页文案改一版', desc: '把首页文案改一版,语气轻一点\n(来自 09-24 那通电话)', created_at: '2026-09-24T11:00:00Z' })] } };
    const lines = captionLinesOf(buildThread(state));
    expect(lines.me?.text).toBe('把首页文案改一版');
  });

  it('事项卡上「会话未开」只对他交代的事说', () => {
    expect(itemCard(TASKS[0]!).note).toBeUndefined();
    expect(itemCard(mine({ id: 'u', title: '把首页文案改一版' })).note).toBe('会话未开');
  });
});
