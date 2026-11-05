import { describe, expect, it } from 'vitest';
import { afterPaired, onboardingEntryText, onboardingEntryVisible } from '../src/onboarding/entry';
import { DEFAULT_SETTINGS } from '../src/settings/settingsStore';
import { applyTurns, fromDetail, isWaiting, needsSeedOnResume, progressOf, speechKey, threadOf, withPending, withSeed, withoutPending, type OnboardingModel } from '../src/onboarding/onboardingModel';
import type { OnboardingDetail } from '../src/onboarding/onboardingApi';

const PLAN = ['opening', 'branch', 'projects', 'authorization', 'habits', 'persona', 'naming', 'wrapup', 'done'];
const detail = (over: Partial<OnboardingDetail> = {}): OnboardingDetail => ({ stage: 'opening', done: false, plan: PLAN, answered: {}, ...over });

describe('引导入口', () => {
  it('第一次配对 → pending,入口亮;之后重配不改', () => {
    expect(afterPaired(DEFAULT_SETTINGS)).toEqual({ onboarding: 'pending' });
    expect(afterPaired({ ...DEFAULT_SETTINGS, onboarding: 'done' })).toEqual({});
    expect(onboardingEntryVisible({ ...DEFAULT_SETTINGS, onboarding: 'pending' })).toBe(true);
    expect(onboardingEntryVisible(DEFAULT_SETTINGS)).toBe(false);
  });
  it('工作台说引导做完了 → 卡消失;做到一半 → 卡说「接着引导」', () => {
    const pending = { ...DEFAULT_SETTINGS, onboarding: 'pending' as const };
    expect(onboardingEntryVisible(pending, { onboarding: { stage: 'done', done: true, askedAt: 't' } })).toBe(false);
    expect(onboardingEntryVisible(pending, { onboarding: { stage: 'habits', done: false, askedAt: 't' } })).toBe(true);
    expect(onboardingEntryText({ onboarding: { stage: 'habits', done: false, askedAt: 't' } })).toMatchObject({ title: '引导做到一半', button: '接着引导' });
    expect(onboardingEntryText({ onboarding: { stage: 'opening', done: false } })).toMatchObject({ title: '第一次见面', button: '开始引导' });
    expect(onboardingEntryText(undefined).title).toBe('第一次见面');
  });
});

describe('引导页状态(纯函数)', () => {
  it('全貌 → 没开始过直接开;做到一半显示正在哪一步(不问「上次到哪」);做完了显示复述', () => {
    expect(fromDetail(detail()).phase).toBe('starting');
    expect(fromDetail(detail({ askedAt: 't' })).phase).toBe('starting');
    const half = fromDetail(detail({ stage: 'habits', askedAt: 't', answered: { opening: ['nickname'], branch: ['mode'], projects: ['idea'] }, nickname: 'Ben' }));
    expect(half.phase).toBe('resume');
    expect(half.resumeLine).toBe('正在「④ 习惯偏好」,已经答了 3 项。');
    expect(half.resumeLine).not.toMatch(/上次到哪|接着吗/);
    const done = fromDetail(detail({ stage: 'done', done: true, askedAt: 't', recap: '- 称呼:Ben' }));
    expect(done).toMatchObject({ phase: 'done', recap: '- 称呼:Ben' });
  });
  it('八段小点:done 之前的阶段;当前几就亮到几;做完全亮', () => {
    expect(progressOf({ plan: PLAN, stage: 'projects', done: false })).toEqual({ steps: PLAN.slice(0, 8), index: 2 });
    expect(progressOf({ plan: PLAN, stage: 'done', done: true }).index).toBe(8);
    expect(progressOf({ plan: ['persona', 'done'], stage: 'persona', done: false })).toEqual({ steps: ['persona'], index: 0 });
  });
  it('回合并进来:按 seq 追加、被回显的 pending 删掉、busy/stage/done 跟着走;做完切 done', () => {
    let m: OnboardingModel = { ...fromDetail(detail()), phase: 'chatting' };
    m = withPending(m, '叫我 Ben');
    m = applyTurns(m, { turns: [{ seq: 1, role: 'assistant', text: '你好', at: 't' }], busy: true, ended: false, stage: 'opening', done: false });
    expect(threadOf(m).map((l) => [l.role, l.text, l.pending === true])).toEqual([['assistant', '你好', false], ['user', '叫我 Ben', true]]);
    m = applyTurns(m, { turns: [{ seq: 2, role: 'user', text: '叫我 Ben', at: 't' }, { seq: 3, role: 'assistant', text: 'Ben 你好', at: 't' }], busy: false, ended: false, stage: 'branch', done: false });
    expect(m.pending).toEqual([]);
    expect(m.lastSeq).toBe(3);
    expect(m.stage).toBe('branch');
    expect(threadOf(m)).toHaveLength(3);
    // 重复的一拍不会重复追加。
    expect(applyTurns(m, { turns: [{ seq: 3, role: 'assistant', text: 'Ben 你好', at: 't' }], busy: false, ended: false, stage: 'branch', done: false }).turns).toHaveLength(3);
    expect(applyTurns(m, { turns: [], busy: false, ended: false, stage: 'done', done: true }).phase).toBe('done');
    expect(withoutPending(withPending(m, 'x'), 'x').pending).toEqual([]);
  });
});

describe('开场体验(2026-09-16):种子句先出现、与模型照念的合并、等待态', () => {
  const OPENING = '你好,很高兴认识你,我是你的专属事务官。首先,你希望我怎么称呼你?';
  it('speechKey:去空白与全半角标点后比较', () => {
    expect(speechKey('你好,很高兴认识你。 ')).toBe(speechKey('你好,很高兴认识你。'));
    expect(speechKey('叫我 Ben')).not.toBe(speechKey('叫我 Bob'));
  });
  it('开会话成功 → 种子句立刻是事务官的第一句;模型随后照念(标点不同)的那条合并,不重复;别的话照常接在后面', () => {
    let m: OnboardingModel = { ...fromDetail(detail({ next: { label: '① 开场', seed: OPENING, goals: [], keys: ['nickname'] } })), phase: 'chatting' };
    expect(m.seed).toBe(OPENING);
    m = withSeed(m, 'opening', OPENING);
    expect(threadOf(m)).toEqual([{ key: 'seed:opening:0', role: 'assistant', text: OPENING, kind: 'seed' }]);
    // 同一阶段再加一次不重复。
    expect(threadOf(withSeed(m, 'opening', OPENING))).toHaveLength(1);
    m = applyTurns(m, { turns: [
      { seq: 1, role: 'assistant', text: '我先读一下引导技能和工作区的规矩。', at: 't' },
      { seq: 2, role: 'assistant', text: '你好,很高兴认识你,我是你的专属事务官。首先,你希望我怎么称呼你?', at: 't', kind: 'seed' },
      { seq: 3, role: 'assistant', text: '慢慢想,不着急。', at: 't' },
    ], busy: false, ended: false, stage: 'opening', done: false, seed: OPENING });
    expect(threadOf(m).map((l) => [l.key, l.text])).toEqual([
      ['seed:opening:0', OPENING],
      ['t1', '我先读一下引导技能和工作区的规矩。'],
      ['t3', '慢慢想,不着急。'],
    ]);
    expect(m.lastSeq).toBe(3);
    // 没有 kind 但文字(去标点后)与种子句相同,同样合并;已经合并过的种子句不再吸收第二条。
    let m2 = withSeed({ ...fromDetail(detail()), phase: 'chatting' }, 'opening', OPENING);
    m2 = applyTurns(m2, { turns: [{ seq: 1, role: 'assistant', text: OPENING.replace(/,/g, ','), at: 't' }, { seq: 2, role: 'assistant', text: OPENING, at: 't' }], busy: false, ended: false, stage: 'opening', done: false });
    expect(threadOf(m2).map((l) => l.key)).toEqual(['seed:opening:0', 't2']);
  });
  it('续做(2026-09-16 真机三遍):进页面先摆历史回合;称呼没答再进来,历史里已有开场白就不再摆、模型再照念也只显示一条;答过东西的续做不摆', () => {
    const d = detail({ askedAt: 't', next: { label: '① 开场', seed: OPENING, goals: [], keys: ['nickname'] } });
    let m: OnboardingModel = { ...fromDetail(d), phase: 'chatting' };
    expect(m.opened).toBe(true);
    expect(m.stageAnswered).toBe(0);
    // 历史里还没有开场白(模型没来得及念就退出了):要摆。
    expect(needsSeedOnResume(m, OPENING)).toBe(true);
    m = applyTurns(m, { turns: [{ seq: 1, role: 'assistant', text: '我先读一下规矩。', at: 't' }, { seq: 2, role: 'assistant', text: OPENING, at: 't', kind: 'seed' }], busy: false, ended: false, stage: 'opening', done: false, seed: OPENING });
    expect(needsSeedOnResume(m, OPENING)).toBe(false);
    // 续做后模型又照念一遍(标点不同):不再显示。
    m = applyTurns(m, { turns: [{ seq: 3, role: 'assistant', text: OPENING.replace(/,/g, ','), at: 't', kind: 'seed' }, { seq: 4, role: 'assistant', text: '慢慢想。', at: 't' }], busy: false, ended: false, stage: 'opening', done: false, seed: OPENING });
    expect(threadOf(m).map((l) => l.key)).toEqual(['t1', 't2', 't4']);
    // 没标 kind 但与当前阶段种子句相同,同样只显示一次;别的话重复照常显示。
    m = applyTurns(m, { turns: [{ seq: 5, role: 'assistant', text: OPENING, at: 't' }, { seq: 6, role: 'assistant', text: '慢慢想。', at: 't' }], busy: false, ended: false, stage: 'opening', done: false, seed: OPENING });
    expect(threadOf(m).map((l) => l.key)).toEqual(['t1', 't2', 't4', 't6']);
    // 答过东西的续做不摆种子句。
    const half = fromDetail(detail({ stage: 'habits', askedAt: 't', answered: { opening: ['nickname'], habits: ['rhythm'] }, next: { label: '④ 习惯偏好', seed: '再聊聊你平时怎么干活', goals: [], keys: ['done'] } }));
    expect(needsSeedOnResume(half, '再聊聊你平时怎么干活')).toBe(false);
  });
  it('阶段推进:手机先显示新阶段的种子句(位置在模型照念那条之前),模型补充的话接在后面', () => {
    const BRANCH = '你现在是已经有项目在做,还是想从一个新点子开始?';
    let m = withSeed({ ...fromDetail(detail()), phase: 'chatting' }, 'opening', OPENING);
    m = applyTurns(m, { turns: [{ seq: 1, role: 'user', text: '叫我 Ben', at: 't' }], busy: true, ended: false, stage: 'opening', done: false, seed: OPENING });
    // 一拍里同时来了:模型对上一阶段的收尾、照念的新种子句、补充的一句,以及阶段推进。
    m = applyTurns(m, { turns: [
      { seq: 2, role: 'assistant', text: 'Ben,记下了。', at: 't' },
      { seq: 3, role: 'assistant', text: BRANCH, at: 't', kind: 'seed' },
      { seq: 4, role: 'assistant', text: '比如手上的仓库,或者一个还没动手的点子。', at: 't' },
    ], busy: false, ended: false, stage: 'branch', done: false, seed: BRANCH });
    expect(threadOf(m).map((l) => [l.key, l.text])).toEqual([
      ['seed:opening:0', OPENING],
      ['t1', '叫我 Ben'],
      ['t2', 'Ben,记下了。'],
      ['seed:branch:1', BRANCH],
      ['t4', '比如手上的仓库,或者一个还没动手的点子。'],
    ]);
    expect(m.seed).toBe(BRANCH);
    // 推进那一拍模型还没照念:种子句排在已有回合之后,之后照念的那条合并。
    let n = withSeed({ ...fromDetail(detail()), phase: 'chatting' }, 'opening', OPENING);
    n = applyTurns(n, { turns: [{ seq: 1, role: 'user', text: '叫我 Ben', at: 't' }, { seq: 2, role: 'assistant', text: 'Ben,记下了。', at: 't' }], busy: true, ended: false, stage: 'branch', done: false, seed: BRANCH });
    expect(threadOf(n).map((l) => l.key)).toEqual(['seed:opening:0', 't1', 't2', 'seed:branch:1']);
    n = applyTurns(n, { turns: [{ seq: 3, role: 'assistant', text: BRANCH, at: 't', kind: 'seed' }], busy: false, ended: false, stage: 'branch', done: false, seed: BRANCH });
    expect(threadOf(n).map((l) => l.key)).toEqual(['seed:opening:0', 't1', 't2', 'seed:branch:1']);
    // 做完了(done)没有种子句,不加。
    const d = applyTurns(n, { turns: [], busy: false, ended: false, stage: 'done', done: true });
    expect(threadOf(d).filter((l) => l.kind === 'seed')).toHaveLength(2);
  });
  it('等待态:开会话中 / 事务官在想 / 我说了它还没回 = 等;种子句刚摆出来等用户答 = 不等;做完了不等', () => {
    const base: OnboardingModel = { ...fromDetail(detail()), phase: 'chatting' };
    expect(isWaiting({ ...base, phase: 'starting' })).toBe(true);
    expect(isWaiting({ ...base, phase: 'loading' })).toBe(false);
    expect(isWaiting(withSeed(base, 'opening', OPENING))).toBe(false);
    expect(isWaiting({ ...withSeed(base, 'opening', OPENING), busy: true })).toBe(true);
    expect(isWaiting(withPending(withSeed(base, 'opening', OPENING), '叫我 Ben'))).toBe(true);
    const echoed = applyTurns(withSeed(base, 'opening', OPENING), { turns: [{ seq: 1, role: 'user', text: '叫我 Ben', at: 't' }], busy: false, ended: false, stage: 'opening', done: false });
    expect(isWaiting(echoed)).toBe(true);
    const replied = applyTurns(echoed, { turns: [{ seq: 2, role: 'assistant', text: 'Ben,记下了。', at: 't' }], busy: false, ended: false, stage: 'opening', done: false });
    expect(isWaiting(replied)).toBe(false);
    expect(isWaiting({ ...replied, busy: true, phase: 'done', done: true })).toBe(false);
    expect(isWaiting({ ...base, phase: 'resume' })).toBe(false);
  });
});
