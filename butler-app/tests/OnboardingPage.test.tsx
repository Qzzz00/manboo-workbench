/**
 * 引导页端到端(假工作台):开会话 → 轮询回合 → 打字回答 → /say → 阶段小点 → 做完复述卡 + 「以后我先开口」;
 * 断线续做(做到一半进来先显示「引导还没做完」,不问「上次到哪」);会话被收掉时 say 409 → 自动再开一次;
 * 无密钥降级(tts 503 → 只显示不朗读、语音键灰);工作台没开引导 → 如实说。
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { OnboardingPage } from '../src/onboarding/OnboardingPage';
import type { OnboardingApi, OnboardingDetail, OnboardingTurn } from '../src/onboarding/onboardingApi';
import { openSession, SessionContext } from '../src/session';
import { SettingsContext } from '../src/settings/SettingsContext';
import { createSettingsStore, DEFAULT_SETTINGS, type Settings } from '../src/settings/settingsStore';
import type { KeyValueStore } from '../src/api/tokenStore';
import { VOICE_UNAVAILABLE_TEXT } from '../src/api/voice';
import { AFTERWARDS_TEXT, ONBOARDING_UNAVAILABLE_TEXT } from '../src/onboarding/onboardingModel';

vi.mock('../src/aiboo/lipsyncPlayer', () => ({ playAudioBlob: async (_b: Blob, _m: () => void, onEnded?: () => void) => { onEnded?.(); }, stopSpeaking: () => {}, isSpeaking: () => false }));

const PLAN = ['opening', 'branch', 'projects', 'authorization', 'habits', 'persona', 'naming', 'wrapup', 'done'];

function memory(): KeyValueStore {
  const data = new Map<string, string>();
  return { async get(k) { return data.get(k) ?? null; }, async set(k, v) { data.set(k, v); }, async remove(k) { data.delete(k); } };
}

/** 假工作台:阶段机的最小模拟——每收到一句用户的话就回一句,答到第 N 句推进阶段。 */
const OPENING = '你好,很高兴认识你,我是你的专属事务官。首先,你希望我怎么称呼你?';
const BRANCH = '你现在是已经有项目在做,还是想从一个新点子开始?';
const SEEDS: Record<string, string> = { opening: OPENING, branch: BRANCH };

function fakeWorkbench(over: { detail?: Partial<OnboardingDetail>; sayStatus?: number; sessionNote?: string; silent?: boolean; replyMs?: number } = {}) {
  let detail: OnboardingDetail = { stage: 'opening', done: false, plan: PLAN, answered: {}, ...over.detail };
  const replyMs = over.replyMs ?? 5;
  const seedOf = () => SEEDS[detail.stage];
  const turns: OnboardingTurn[] = [];
  let busy = false;
  let ended = false;
  let sessions = 0;
  let opens = 0;
  const said: string[] = [];
  const push = (role: OnboardingTurn['role'], text: string) => turns.push({ seq: turns.length + 1, role, text, at: 't' });
  const api: OnboardingApi = {
    async detail() { return { ok: true, status: 200, data: detail }; },
    async session() {
      // 像工作台:开过会话就算接着(哪怕一项没答);原会话还在就排进去不另开。
      // 答过东西的续做模型直接接着问没答的那一题,没答过的续做模型会再把开场白照念一遍(标 kind:seed)。
      const resumed = detail.askedAt !== undefined || Object.keys(detail.answered).length > 0;
      opens += 1;
      const reused = detail.session_id !== undefined && !ended;
      if (!reused) sessions += 1;
      ended = false;
      detail = { ...detail, askedAt: 't', session_id: `s${sessions}` };
      if (over.sessionNote !== undefined) return { ok: true, status: 200, data: { ok: true, stage: detail.stage, note: over.sessionNote, first_message: 'seed', seed: seedOf()!, resumed } };
      busy = true;
      if (!over.silent) {
        setTimeout(() => {
          if (resumed && Object.keys(detail.answered).length > 0) { push('assistant', '接着问:你一般几点开始干活?'); busy = false; return; }
          if (resumed) { turns.push({ seq: turns.length + 1, role: 'assistant', text: OPENING.replace(/,/g, ','), at: 't', kind: 'seed' }); busy = false; return; }
          // 像真机:先说一句读规矩的,再把亲笔那句照念一遍(标点被改成全角),工作台标 kind:seed。
          push('assistant', '我先读一下引导技能和工作区的规矩。');
          turns.push({ seq: turns.length + 1, role: 'assistant', text: OPENING.replace(/,/g, ','), at: 't', kind: 'seed' });
          busy = false;
        }, replyMs);
      }
      return { ok: true, status: 200, data: { ok: true, stage: detail.stage, session_id: `s${sessions}`, first_message: 'seed', seed: seedOf()!, resumed } };
    },
    async say(text) {
      if (over.sayStatus !== undefined && said.length === 0) { said.push(text); ended = true; return { ok: false, status: over.sayStatus, kind: 'http', error: '这条引导会话在 DSH 里已经没了:重新 POST /onboarding/session 接着聊' }; }
      said.push(text);
      push('user', text);
      busy = true;
      setTimeout(() => {
        if (text === '最后一句') {
          // 像真机一样:阶段机先置 done(模型还在说),最后一句晚 30ms 才到,turn/end 之后 busy 才落。
          detail = { ...detail, stage: 'done', done: true, recap: '- 称呼:Ben\n- 名字:小满', nickname: 'Ben' };
          setTimeout(() => { push('assistant', '都记下了。以后我先开口。'); busy = false; }, 30);
          return;
        }
        else { detail = { ...detail, stage: 'branch', answered: { opening: ['nickname'] } }; push('assistant', `${text},记下了。`); push('assistant', BRANCH); push('assistant', '比如手上的仓库,或者一个还没动手的点子。'); }
        busy = false;
      }, replyMs);
      return { ok: true, status: 200, data: { ok: true, session_id: `s${sessions}` } };
    },
    async turns(after) { return { ok: true, status: 200, data: { turns: turns.filter((t) => t.seq > after), busy, ended, stage: detail.stage, done: detail.done, session_id: `s${sessions}`, ...(seedOf() === undefined ? {} : { seed: seedOf()! }) } }; },
    async restart() { detail = { stage: 'opening', done: false, plan: PLAN, answered: {} }; turns.length = 0; return { ok: true, status: 200, data: { ok: true, stage: 'opening' } }; },
    async leader(leader) { return { ok: true, status: 200, data: { ok: true, leader } }; },
  };
  return { api, said, sessions: () => sessions, opens: () => opens, endSession: () => { ended = true; } };
}

function mount(api: OnboardingApi, options: { fetchImpl?: typeof fetch; settings?: Partial<Settings>; slowMs?: number } = {}) {
  const pairing = { token: 't', host: 'h', port: 8791, deviceId: 'd' };
  const fetchImpl = options.fetchImpl ?? (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/state')) return new Response(JSON.stringify({ now: 'x', stale: false, sessions: [] }), { status: 200 });
    return new Response(JSON.stringify({ error: '没配' }), { status: 503 });
  }) as typeof fetch;
  const store = createSettingsStore(memory());
  const session = openSession({ pairing, settings: store, onUnauthorized: () => {}, unpair: async () => {}, fetchImpl });
  const updates: Partial<Settings>[] = [];
  const settings = { ...DEFAULT_SETTINGS, onboarding: 'pending' as const, ...options.settings };
  const onClose = vi.fn();
  const view = render(
    <SettingsContext.Provider value={{ settings, update: async (p) => { updates.push(p); } }}>
      <SessionContext.Provider value={session}>
        <OnboardingPage onClose={onClose} api={api} pollMs={20} {...(options.slowMs === undefined ? {} : { slowMs: options.slowMs })} />
      </SessionContext.Provider>
    </SettingsContext.Provider>,
  );
  return { view, updates, onClose, stop: () => session.feed.stop() };
}

describe('OnboardingPage', () => {
  it('从零:进页面就开会话 → 事务官开场白出现 → 打字回答 → /say → 阶段小点推进 → 做完复述卡 + 以后我先开口 → 本机标 done', async () => {
    const wb = fakeWorkbench();
    const { updates, onClose, stop } = mount(wb.api);
    expect(await screen.findByText(OPENING)).toBeTruthy();
    expect(wb.sessions()).toBe(1);
    expect(screen.getByLabelText('引导进度:① 开场')).toBeTruthy();
    expect(document.querySelectorAll('.ba-onboarding__dots li')).toHaveLength(8);
    expect(document.querySelector('.ba-onboarding__dots li[data-state="current"]')).toBe(document.querySelectorAll('.ba-onboarding__dots li')[0]);

    const input = screen.getByLabelText('回答事务官');
    fireEvent.change(input, { target: { value: '叫我 Ben' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    // 先以「发送中」挂在尾部,回显后变成正式回合。
    expect(await screen.findByText('叫我 Ben')).toBeTruthy();
    expect(wb.said).toEqual(['叫我 Ben']);
    expect(await screen.findByText('叫我 Ben,记下了。')).toBeTruthy();
    await waitFor(() => expect(screen.getByLabelText('引导进度:② 分岔')).toBeTruthy());
    // 分岔的种子句手机先摆(模型照念的那条合并成一条),补充的话接在后面。
    expect(await screen.findByText('比如手上的仓库,或者一个还没动手的点子。')).toBeTruthy();
    expect(screen.getAllByText(BRANCH)).toHaveLength(1);
    expect(screen.getAllByText(OPENING)).toHaveLength(1);
    expect(document.querySelectorAll('.ba-onboarding__dots li[data-state="done"]')).toHaveLength(1);
    expect(document.querySelector('.ba-bubble[data-pending="true"]')).toBeNull();

    fireEvent.change(input, { target: { value: '最后一句' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(await screen.findByText(AFTERWARDS_TEXT)).toBeTruthy();
    expect(await screen.findByText('Ben,记下了')).toBeTruthy();
    // done 之后还在说的最后一句也要到屏幕上,球回到待命。
    expect(await screen.findByText('都记下了。以后我先开口。')).toBeTruthy();
    await waitFor(() => expect(document.querySelector('.ba-orb, .ba-particles')?.getAttribute('data-mode')).toBe('idle'));
    expect(document.querySelector('.ba-onboard__recap')?.textContent).toBe('- 称呼:Ben\n- 名字:小满');
    expect(screen.getByLabelText('引导进度:完成')).toBeTruthy();
    expect(document.querySelectorAll('.ba-onboarding__dots li[data-state="done"]')).toHaveLength(8);
    await waitFor(() => expect(updates).toContainEqual({ onboarding: 'done' }));
    fireEvent.click(screen.getByText('回主页'));
    expect(onClose).toHaveBeenCalled();
    stop();
  });

  it('做到一半再进来:先显示「引导还没做完」,已有回合摆出来;点接着 → 开会话,事务官直接接着问', async () => {
    const wb = fakeWorkbench({ detail: { stage: 'habits', askedAt: 't', answered: { opening: ['nickname'], branch: ['mode'] }, nickname: 'Ben' } });
    const { stop } = mount(wb.api);
    expect(await screen.findByText('引导还没做完')).toBeTruthy();
    expect(screen.queryByText(/上次到哪|接着吗/)).toBeNull();
    expect(screen.getByText('正在「④ 习惯偏好」,已经答了 2 项。')).toBeTruthy();
    expect(wb.sessions()).toBe(0);
    expect(screen.queryByLabelText('回答事务官')).toBeNull();
    fireEvent.click(screen.getByText('接着聊'));
    expect(await screen.findByText('接着问:你一般几点开始干活?')).toBeTruthy();
    expect(wb.sessions()).toBe(1);
    expect(screen.getByLabelText('回答事务官')).toBeTruthy();
    stop();
  });

  it('会话被 DSH 收掉:say 409 → 自动再开一次会话再说,用户无感', async () => {
    const wb = fakeWorkbench({ sayStatus: 409 });
    const { stop } = mount(wb.api);
    await screen.findByText(OPENING);
    fireEvent.change(screen.getByLabelText('回答事务官'), { target: { value: '叫我 Ben' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(wb.sessions()).toBe(2));
    expect(await screen.findByText('叫我 Ben,记下了。')).toBeTruthy();
    expect(wb.said).toEqual(['叫我 Ben', '叫我 Ben']);
    stop();
  });

  it('没密钥:tts 503 → 回复只显示、语音键灰并说明;有密钥:每句新回复都朗读', async () => {
    const wb = fakeWorkbench();
    const tts = vi.fn(async () => new Response(JSON.stringify({ error: '未配置语音供应商密钥' }), { status: 503 }));
    const { stop, view } = mount(wb.api, { fetchImpl: (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/state')) return new Response(JSON.stringify({ now: 'x', stale: false, sessions: [] }), { status: 200 });
      if (url.endsWith('/tts')) return tts();
      return new Response(JSON.stringify({ error: '没配' }), { status: 503 });
    }) as typeof fetch });
    await screen.findByText(OPENING);
    await waitFor(() => expect(tts).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(VOICE_UNAVAILABLE_TEXT)).toBeTruthy();
    expect((screen.getByLabelText(VOICE_UNAVAILABLE_TEXT) as HTMLButtonElement).disabled).toBe(true);
    stop();
    view.unmount();

    const ok = vi.fn(async () => new Response(new Uint8Array([1]), { status: 200, headers: { 'content-type': 'audio/mpeg' } }));
    const wb2 = fakeWorkbench();
    const second = mount(wb2.api, { fetchImpl: (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/state')) return new Response(JSON.stringify({ now: 'x', stale: false, sessions: [] }), { status: 200 });
      if (url.endsWith('/tts')) return ok();
      return new Response(JSON.stringify({ error: '没配' }), { status: 503 });
    }) as typeof fetch });
    // 种子句一出现就念;模型照念的那条合并了不再念;「读规矩」那句念一次。
    await screen.findByText(OPENING);
    await waitFor(() => expect(ok).toHaveBeenCalledTimes(1));
    await screen.findByText('我先读一下引导技能和工作区的规矩。');
    await waitFor(() => expect(ok).toHaveBeenCalledTimes(2));
    fireEvent.change(screen.getByLabelText('回答事务官'), { target: { value: '叫我 Ben' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await screen.findByText('比如手上的仓库,或者一个还没动手的点子。');
    // 记下了 + 分岔种子句(手机摆的那条)+ 补充的一句 = 再念三次。
    await waitFor(() => expect(ok).toHaveBeenCalledTimes(5));
    second.stop();
  });

  it('做到一半点「从头来」:restart 后开场白重新摆出来并再念一遍', async () => {
    const wb = fakeWorkbench({ detail: { stage: 'habits', askedAt: 't', answered: { opening: ['nickname'] }, nickname: 'Ben' } });
    const ok = vi.fn(async () => new Response(new Uint8Array([1]), { status: 200, headers: { 'content-type': 'audio/mpeg' } }));
    const { stop } = mount(wb.api, { fetchImpl: (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/state')) return new Response(JSON.stringify({ now: 'x', stale: false, sessions: [] }), { status: 200 });
      if (url.endsWith('/tts')) return ok();
      return new Response(JSON.stringify({ error: '没配' }), { status: 503 });
    }) as typeof fetch });
    await screen.findByText('引导还没做完');
    fireEvent.click(screen.getByText('从头来'));
    expect(await screen.findByText(OPENING)).toBeTruthy();
    await waitFor(() => expect(ok).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('我先读一下引导技能和工作区的规矩。')).toBeTruthy();
    await waitFor(() => expect(ok).toHaveBeenCalledTimes(2));
    expect(screen.getAllByText(OPENING)).toHaveLength(1);
    stop();
  });

  it('工作台没开出会话(note 会话未开)→ 如实说、能再试;工作台没接引导(404)→ 说清楚', async () => {
    const wb = fakeWorkbench({ sessionNote: '会话未开' });
    const { stop } = mount(wb.api);
    expect(await screen.findByText('工作台没开出引导会话(DSH 还没接上),等一会儿再点。')).toBeTruthy();
    expect(screen.getByText('再试一次')).toBeTruthy();
    stop();
    const missing: OnboardingApi = { ...wb.api, async detail() { return { ok: false, status: 404, kind: 'http', error: '引导未启用' }; } };
    const m = mount(missing);
    expect(await screen.findByText(ONBOARDING_UNAVAILABLE_TEXT)).toBeTruthy();
    m.stop();
  });

  it('开场体验:开会话成功就显示开场白(不等模型),模型回来那句合并;等模型时球是说话准备态、气泡三点,不显示系统句', async () => {
    const wb = fakeWorkbench({ replyMs: 60 });
    const { stop } = mount(wb.api);
    expect(await screen.findByText(OPENING)).toBeTruthy();
    expect(screen.queryByText('事务官来了…')).toBeNull();
    // 模型还没回:工作台说 busy → 三点动画 + 说话准备态。
    await waitFor(() => expect(screen.getByRole('status', { name: '事务官在想' })).toBeTruthy());
    expect(screen.queryByText('事务官在想…')).toBeNull();
    expect(document.querySelector('.ba-orb, .ba-particles')?.getAttribute('data-mode')).toBe('preparing');
    expect(await screen.findByText('我先读一下引导技能和工作区的规矩。')).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('status', { name: '事务官在想' })).toBeNull());
    expect(screen.getAllByText(OPENING)).toHaveLength(1);
    expect(document.querySelectorAll('.ba-bubble--butler')).toHaveLength(2);
    // 我说了一句它还没回:发送中也算等。
    fireEvent.change(screen.getByLabelText('回答事务官'), { target: { value: '叫我 Ben' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(screen.getByRole('status', { name: '事务官在想' })).toBeTruthy();
    await screen.findByText('比如手上的仓库,或者一个还没动手的点子。');
    await waitFor(() => expect(screen.queryByRole('status', { name: '事务官在想' })).toBeNull());
    stop();
  });

  it('回归(2026-09-16 真机开场白三遍):开会话 → 模型照念 → 回主页再「接着引导」 → 模型又照念 → 只显示一条、只念一次', async () => {
    const wb = fakeWorkbench();
    const ok = vi.fn(async () => new Response(new Uint8Array([1]), { status: 200, headers: { 'content-type': 'audio/mpeg' } }));
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/state')) return new Response(JSON.stringify({ now: 'x', stale: false, sessions: [] }), { status: 200 });
      if (url.endsWith('/tts')) return ok();
      return new Response(JSON.stringify({ error: '没配' }), { status: 503 });
    }) as typeof fetch;
    const first = mount(wb.api, { fetchImpl });
    await screen.findByText(OPENING);
    await screen.findByText('我先读一下引导技能和工作区的规矩。');
    await waitFor(() => expect(ok).toHaveBeenCalledTimes(2));
    expect(screen.getAllByText(OPENING)).toHaveLength(1);
    first.stop();
    first.view.unmount();
    // 从主页「接着引导」再进来:同一条会话,工作台说 resumed;模型又照念一遍。
    const second = mount(wb.api, { fetchImpl });
    expect(await screen.findByText(OPENING)).toBeTruthy();
    await new Promise((r) => setTimeout(r, 120));
    expect(screen.getAllByText(OPENING)).toHaveLength(1);
    expect(wb.sessions()).toBe(1);
    // 已经念过的不再念:回来之后一次 tts 都没打。
    expect(ok).toHaveBeenCalledTimes(2);
    // 「读规矩」那句是历史,照旧显示。
    expect(screen.getByText('我先读一下引导技能和工作区的规矩。')).toBeTruthy();
    second.stop();
  });

  it('等太久:超过时限没有新回合 → 「事务官反应慢了,再等等或重试」+ 重试;重试后又回来就消失', async () => {
    const wb = fakeWorkbench({ silent: true });
    const { stop } = mount(wb.api, { slowMs: 80 });
    await screen.findByText(OPENING);
    expect(screen.queryByText('事务官反应慢了,再等等或重试')).toBeNull();
    expect(await screen.findByText('事务官反应慢了,再等等或重试', {}, { timeout: 1500 })).toBeTruthy();
    fireEvent.click(screen.getByText('重试'));
    await waitFor(() => expect(wb.opens()).toBe(2));
    // 第二次还是不回:提示再次出现;开会话次数说明重试确实重开了(原会话还在就排进去,不另开)。
    expect(wb.sessions()).toBe(1);
    expect(await screen.findByText('事务官反应慢了,再等等或重试', {}, { timeout: 1500 })).toBeTruthy();
    stop();
  });

  it('粒子球:事务官在想 = 说话准备;打字 = 聆听', async () => {
    const wb = fakeWorkbench();
    const { stop } = mount(wb.api);
    await screen.findByText('我先读一下引导技能和工作区的规矩。');
    await waitFor(() => expect(document.querySelector('.ba-orb, .ba-particles')?.getAttribute('data-mode')).toBe('idle'));
    fireEvent.change(screen.getByLabelText('回答事务官'), { target: { value: '在打字' } });
    expect(document.querySelector('.ba-orb, .ba-particles')?.getAttribute('data-mode')).toBe('listening');
    stop();
  });
});
