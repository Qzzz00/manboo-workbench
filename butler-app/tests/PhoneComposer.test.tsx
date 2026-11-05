/**
 * 统一输入框 —— 手机那一份(2026-09-24,docs/设计-统一输入框-2026-09-24.md)。
 * 维护者拍板:手机要全套、收紧摆 ——「+」、@、发送、按住说话常驻;模式与模型合一枚胶囊,点开底部抽屉。
 *
 * 同日下午(卡 feat/phone-composer-call-slot,维护者原话见决策记录):
 *   - 通话键收进输入框:右下角那颗**没内容时是通话键**,一打字 / 加了图片文件就变回发送键,删光了变回通话键;
 *   - 按住说话单独一颗麦克风键,在它左边,样式大小和发送键一样,**一按下就录**;
 *   - 输入框本身只管打字(真的 textarea,长按就是系统的粘贴 / 选词),灰字「说点什么…」。
 * 录音本体(getUserMedia / WAV)在 tests/holdToTalk.test.tsx 用真的 hook 测;这里整段假掉,只测键与发送路径。
 */
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MIC_HINT_TEXT, MIC_INTERRUPTED_TEXT, PhoneComposer, type PhoneCallSlot, type PhoneVoice } from '../src/composer/PhoneComposer';
import { sessionComposerApi, type ComposerApi } from '../src/composer/composerApi';
import { TRIMS, actionKeyOf, itemBody, joinSaid, type ComposerDraft } from '../src/composer/composerModel';
import { TOO_SHORT_TEXT } from '../src/chat/useHoldToTalk';
import type { ComposerOptionsView, ComposerUploadView } from '../src/api/protocol';
import type { AsrResult } from '../src/api/voice';
import type { Session } from '../src/session';

const calls: string[] = [];
let recordedMs = 1200;
/** false = 按下之后先停在「还在要麦克风」,等用例叫 openMic 才真开。 */
let autoOpen = true;

vi.mock('../src/aiboo/useVoiceRecorder', async () => {
  const { useRef, useState } = await import('react');
  return {
    MIC_PERMISSION_TEXT: '没有录音权限',
    useVoiceRecorder() {
      const [state, setState] = useState<{ status: string, elapsedMs?: number }>({ status: 'idle' });
      const audioLevelRef = useRef(0);
      return {
        state,
        audioLevelRef,
        async startRecording() {
          calls.push('start');
          setState(autoOpen ? { status: 'recording', elapsedMs: 0 } : { status: 'requesting' });
        },
        stopRecording() {
          calls.push('stop');
          setState({ status: 'idle' });
          return { wavBlob: new Blob(['x'], { type: 'audio/wav' }), durationMs: recordedMs };
        },
        cancelRecording() { calls.push('cancel'); setState({ status: 'idle' }); },
      };
    },
  };
});

const OPTIONS: ComposerOptionsView = {
  agents: [
    { family: 'dsh', title: '事务官自己', hands: [], ready: true, in_slot: false },
    { family: 'claude', title: 'Claude', hands: [{ hand: 'window', ready: true }], ready: true, in_slot: true },
    { family: 'kimi', title: '小K', hands: [{ hand: 'cli', ready: false, why: '名片分派待公共接线' }], ready: false, in_slot: false },
  ],
  modes: [
    { id: 'plan', title: '只出方案', hint: 'a' },
    { id: 'ask', title: '先问我', hint: 'b' },
    { id: 'auto', title: '自动办', hint: 'c' },
  ],
  mode: 'ask',
  models: [
    { provider: 'workbench-relay', id: 'deepseek-v4-flash', title: 'V4 Flash', images: true },
    { provider: 'workbench-relay', id: 'deepseek-v4-pro', title: 'V4 Pro', images: false },
  ],
  recent: [],
};

type UploadResult = { ok: true; view: ComposerUploadView } | { ok: false; error: string };

function fakeApi(upload?: (file: File) => Promise<UploadResult>): ComposerApi & { saved: unknown[] } {
  const saved: unknown[] = [];
  return {
    saved,
    loadOptions: vi.fn(async () => OPTIONS),
    saveChoice: vi.fn(async (c) => { saved.push(c); return true; }),
    upload: vi.fn(upload ?? (async (file: File): Promise<UploadResult> => ({ ok: true, view: { id: file.name, name: file.name, type: file.type, bytes: file.size, image: true } }))),
  };
}

type Spy = ReturnType<typeof vi.fn>;

function voiceOf(overrides: Partial<PhoneVoice> = {}): PhoneVoice & { onError: Spy; transcribe: Spy } {
  return {
    transcribe: vi.fn(async (): Promise<AsrResult> => ({ ok: true, text: '周五交报销' })),
    onError: vi.fn(),
    ...overrides,
  } as PhoneVoice & { onError: Spy; transcribe: Spy };
}

function callSlot(overrides: Partial<PhoneCallSlot> = {}): PhoneCallSlot & { onCall: Spy } {
  return { ready: true, label: '通话', title: '和事务官通话', onCall: vi.fn(), ...overrides } as PhoneCallSlot & { onCall: Spy };
}

interface MountOptions {
  voice?: PhoneVoice & { onError: Spy; transcribe: Spy };
  call?: (PhoneCallSlot & { onCall: Spy }) | null;
  api?: ComposerApi;
  onSubmit?: (d: ComposerDraft) => boolean | Promise<boolean>;
}

function mountHome(options: MountOptions = {}) {
  calls.length = 0;
  recordedMs = 1200;
  autoOpen = true;
  const submitted: ComposerDraft[] = [];
  const voice = options.voice ?? voiceOf();
  const call = options.call === null ? undefined : (options.call ?? callSlot());
  const view = render(
    <PhoneComposer
      trim="phone-home"
      placeholder="说点什么…"
      ariaLabel="打字说给事务官"
      onSubmit={options.onSubmit ?? ((d) => { submitted.push(d); return true; })}
      voice={voice}
      api={options.api ?? fakeApi()}
      {...(call === undefined ? {} : { call })}
    />,
  );
  return { view, submitted, voice, call };
}

const input = () => screen.getByLabelText('打字说给事务官') as HTMLTextAreaElement;
const mic = () => screen.getByRole('button', { name: '按住说话' });
/** 右下角那颗(通话或发送)。 */
const actionKey = () => document.querySelector('.pc-bar .pc-action') as HTMLButtonElement;

describe('PhoneComposer', () => {
  it('与电脑同一张裁剪表', () => {
    expect(TRIMS['phone-home']).toEqual({ plus: true, at: true, mode: true, model: true, voice: true, pillsMerged: true });
    expect(TRIMS.call).toEqual({ plus: false, at: false, mode: false, model: false, voice: false, pillsMerged: false });
  });

  it('首页:输入框就是真的打字框(不再是「长得像输入框的按钮」),灰字「说点什么…」;+、@、胶囊、麦克风、通话常驻', () => {
    render(<PhoneComposer trim="phone-home" placeholder="说点什么…" ariaLabel="打字说给事务官" onSubmit={() => true} voice={voiceOf()} api={fakeApi()} call={callSlot()}
      current={{ mode: 'ask', model: { provider: 'workbench-relay', id: 'deepseek-v4-flash', title: 'V4 Flash', images: true } }} />);
    expect(input().tagName).toBe('TEXTAREA');
    expect(input().getAttribute('placeholder')).toBe('说点什么…');
    expect(document.querySelector('.ba-scene__field, .pc-field')).toBeNull();
    expect(screen.getByRole('button', { name: '添加' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '交给谁' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '模式与模型:先问我·V4 Flash' })).toBeTruthy();
    expect(mic()).toBeTruthy();
    expect(screen.getByRole('button', { name: '通话' })).toBeTruthy();
    // 麦克风在右下角那颗的左边,紧挨着;两颗是同一种键
    const keys = [...document.querySelectorAll('.pc-keys > button')];
    expect(keys.map((k) => k.getAttribute('aria-label'))).toEqual(['按住说话', '通话']);
    expect(keys.every((k) => k.classList.contains('pc-key') && k.classList.contains('pc-send'))).toBe(true);
    expect(keys[0]!.querySelector('[data-icon="microphone"]')).toBeTruthy();
    expect(keys[1]!.querySelector('[data-icon="phone"]')).toBeTruthy();
  });

  it('胶囊点开 → 底部抽屉上下两段:模式、模型;选了记成默认', async () => {
    const api = fakeApi();
    render(<PhoneComposer trim="phone-home" placeholder="p" ariaLabel="打字说给事务官" onSubmit={() => true} voice={voiceOf()} api={api} current={{ mode: 'ask' }} />);
    fireEvent.click(screen.getByRole('button', { name: /模式与模型/ }));
    expect(await screen.findByRole('dialog', { name: '模式与模型' })).toBeTruthy();
    expect(screen.getByText('模式')).toBeTruthy();
    expect(screen.getByText('模型')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: /自动办/ }));
    fireEvent.click(screen.getByRole('button', { name: /deepseek-v4-pro/ }));
    expect(api.saved).toEqual([{ mode: 'auto' }, { model: { provider: 'workbench-relay', id: 'deepseek-v4-pro' } }]);
    expect(screen.getByRole('button', { name: '模式与模型:自动办·V4 Pro' })).toBeTruthy();
  });

  it('打字 → 打 @ → 抽屉里挑 Claude → 片;发出去带 assignee', async () => {
    const { submitted } = mountHome();
    fireEvent.change(input(), { target: { value: '改一下首页 @cl', selectionStart: 11 } });
    fireEvent.click(await screen.findByRole('button', { name: /Claude/ }));
    expect(screen.getByText('@Claude')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(itemBody(submitted[0]!)).toEqual({ text: '改一下首页', assignee: 'claude' });
  });

  it('通话裁剪:只有文字与发送(没有麦克风、没有通话键)', () => {
    render(<PhoneComposer trim="call" placeholder="打字回答…" ariaLabel="打字回答" onSubmit={() => true} />);
    expect(screen.getByLabelText('打字回答')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '添加' })).toBeNull();
    expect(screen.queryByRole('button', { name: /模式/ })).toBeNull();
    expect(screen.queryByRole('button', { name: '按住说话' })).toBeNull();
    expect(screen.queryByRole('button', { name: /通话/ })).toBeNull();
    expect((screen.getByRole('button', { name: '发送' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('引导兜底裁剪:文字 + 旁边那几样(extra)+ 发送,别的都没有', () => {
    render(<PhoneComposer trim="onboarding" placeholder="打字回答…" ariaLabel="回答事务官" onSubmit={() => true} extra={<button type="button">停</button>} />);
    expect(screen.getByLabelText('回答事务官')).toBeTruthy();
    expect([...document.querySelectorAll('.pc-row > button')].map((b) => b.getAttribute('aria-label') ?? b.textContent)).toEqual(['停', '发送']);
    expect(screen.queryByRole('button', { name: '按住说话' })).toBeNull();
  });
});

describe('右下角那颗:没内容是通话键,有内容是发送键', () => {
  it('纯函数:空 / 只有空格 → 通话;有字、有附件、有片 → 发送;在发 → 发送;没给通话 → 永远是发送', () => {
    const empty: ComposerDraft = { text: '', attachments: [], refs: [] };
    expect(actionKeyOf(empty, { call: true, sending: false })).toBe('call');
    expect(actionKeyOf({ ...empty, text: '  \n' }, { call: true, sending: false })).toBe('call');
    expect(actionKeyOf({ ...empty, text: '好' }, { call: true, sending: false })).toBe('send');
    expect(actionKeyOf({ ...empty, attachments: [{ key: 'k', name: 'a.png', image: true }] }, { call: true, sending: false })).toBe('send');
    expect(actionKeyOf({ ...empty, agent: { family: 'claude', title: 'Claude' } }, { call: true, sending: false })).toBe('send');
    expect(actionKeyOf({ ...empty, refs: [{ kind: 'item', id: 'i', title: 't' }] }, { call: true, sending: false })).toBe('send');
    expect(actionKeyOf(empty, { call: true, sending: true })).toBe('send');
    expect(actionKeyOf(empty, { call: false, sending: false })).toBe('send');
  });

  it('空 → 通话;打一个字 → 发送;删光 → 变回通话', () => {
    mountHome();
    expect(actionKey().getAttribute('aria-label')).toBe('通话');
    expect(actionKey().getAttribute('data-key')).toBe('call');
    fireEvent.change(input(), { target: { value: '好' } });
    expect(actionKey().getAttribute('aria-label')).toBe('发送');
    expect(actionKey().getAttribute('data-key')).toBe('send');
    expect(actionKey().disabled).toBe(false);
    fireEvent.change(input(), { target: { value: '' } });
    expect(actionKey().getAttribute('aria-label')).toBe('通话');
  });

  it('通话能打:点了就进通话,不发任何东西', () => {
    const { call, submitted } = mountHome();
    fireEvent.click(screen.getByRole('button', { name: '通话' }));
    expect(call!.onCall).toHaveBeenCalledTimes(1);
    expect(submitted).toEqual([]);
  });

  it('通话打不了:键是灰的、点不动;无障碍名与悬停提示里带原因', () => {
    const call = callSlot({ ready: false, label: '通话(电脑上还没配通话供应商)', title: '电脑上还没配通话供应商' });
    mountHome({ call });
    const key = screen.getByRole('button', { name: /通话/ }) as HTMLButtonElement;
    expect(key.disabled).toBe(true);
    expect(key.getAttribute('title')).toBe('电脑上还没配通话供应商');
    fireEvent.click(key);
    expect(call.onCall).not.toHaveBeenCalled();
  });

  it('只加了附件(没打字)→ 发送键;传完之前点不动,传完能发', async () => {
    let finish: () => void = () => {};
    const api = fakeApi((file) => new Promise<UploadResult>((res) => { finish = () => res({ ok: true, view: { id: file.name, name: file.name, type: file.type, bytes: file.size, image: true } }); }));
    const { submitted } = mountHome({ api });
    const file = new File(['abc'], 'a.png', { type: 'image/png' });
    fireEvent.paste(input(), { clipboardData: { files: { length: 1, item: () => file } } });
    expect(actionKey().getAttribute('aria-label')).toBe('发送');
    expect(actionKey().disabled).toBe(true);
    await act(async () => { finish(); });
    await waitFor(() => expect(actionKey().disabled).toBe(false));
    fireEvent.click(actionKey());
    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(itemBody(submitted[0]!)).toEqual({ text: '', attachments: [{ id: 'a.png' }] });
    // 发出去之后片清掉,键变回通话
    await waitFor(() => expect(actionKey().getAttribute('aria-label')).toBe('通话'));
  });

  it('发送中:那颗键显示「···」并点不动;发出去之后清空、变回通话键、收起键盘', async () => {
    let done: (ok: boolean) => void = () => {};
    const submitted: ComposerDraft[] = [];
    mountHome({ onSubmit: (d) => new Promise<boolean>((res) => { submitted.push(d); done = res; }) });
    input().focus();
    fireEvent.change(input(), { target: { value: '帮我订明天的会议室' } });
    fireEvent.keyDown(input(), { key: 'Enter' });
    await waitFor(() => expect(actionKey().textContent).toBe('···'));
    expect(actionKey().disabled).toBe(true);
    await act(async () => { done(true); });
    await waitFor(() => expect(actionKey().getAttribute('aria-label')).toBe('通话'));
    expect(input().value).toBe('');
    expect(document.activeElement).not.toBe(input());
  });

  it('发送失败:字留着、还是发送键,可以再点一次', async () => {
    mountHome({ onSubmit: () => false });
    fireEvent.change(input(), { target: { value: '帮我订明天的会议室' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(actionKey().disabled).toBe(false));
    expect(input().value).toBe('帮我订明天的会议室');
    expect(actionKey().getAttribute('aria-label')).toBe('发送');
  });

  it('未就绪候选(ready: false): 禁发、按钮disabled、点击不发起提交且itemBody不带assignee', async () => {
    const unreadyDraft: ComposerDraft = {
      text: '帮我整理数据',
      agent: { family: 'kimi', title: '小K', ready: false, why: '名片分派待公共接线' },
      attachments: [],
      refs: [],
    };
    expect(itemBody(unreadyDraft)).toEqual({ text: '帮我整理数据' });

    const onSubmit = vi.fn(async () => true);
    mountHome({ onSubmit });

    fireEvent.change(input(), { target: { value: '测试 @小', selectionStart: 6 } });
    fireEvent.click(await screen.findByRole('button', { name: /小K/ }));

    expect(screen.getByText('@小K')).toBeTruthy();
    expect(actionKey().disabled).toBe(true);

    fireEvent.click(actionKey());
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('麦克风键:按住说话', () => {
  it('一按下就开录(不等 260ms)、键和浮层当场给反应;松开转成文字直接发出去', async () => {
    const { submitted, voice } = mountHome();
    fireEvent.pointerDown(mic(), { clientY: 700, pointerId: 1 });
    // 没有 waitFor:按下的这一下里就已经在录了
    expect(calls).toEqual(['start']);
    expect(mic().getAttribute('data-recording')).toBe('true');
    expect(document.querySelector('.ba-voice-record-overlay')).toBeTruthy();
    await act(async () => { fireEvent.pointerUp(mic(), { clientY: 700, pointerId: 1 }); });
    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(submitted[0]!.text).toBe('周五交报销');
    expect(voice.transcribe).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['start', 'stop']);
    expect(voice.onError).not.toHaveBeenCalled();
  });

  it('上滑松开作废:不转文字、不发,也不弹话', async () => {
    const { submitted, voice } = mountHome();
    fireEvent.pointerDown(mic(), { clientY: 700, pointerId: 1 });
    fireEvent.pointerMove(mic(), { clientY: 520, pointerId: 1 });
    await act(async () => { fireEvent.pointerUp(mic(), { clientY: 520, pointerId: 1 }); });
    expect(calls).toEqual(['start', 'cancel']);
    expect(voice.transcribe).not.toHaveBeenCalled();
    expect(submitted).toEqual([]);
    expect(voice.onError).not.toHaveBeenCalled();
  });

  it('按太短:说「太短了,按住再说」,不发', async () => {
    const { submitted, voice } = mountHome();
    recordedMs = 120;
    fireEvent.pointerDown(mic(), { clientY: 700, pointerId: 1 });
    await act(async () => { fireEvent.pointerUp(mic(), { clientY: 700, pointerId: 1 }); });
    await waitFor(() => expect(voice.onError).toHaveBeenCalledWith(TOO_SHORT_TEXT));
    expect(submitted).toEqual([]);
  });

  it('麦克风还没真打开就松手了(快点一下):也当太短说一句,并作废那一路', async () => {
    const { submitted, voice } = mountHome();
    autoOpen = false;
    fireEvent.pointerDown(mic(), { clientY: 700, pointerId: 1 });
    expect(mic().getAttribute('data-recording')).toBe('true');
    await act(async () => { fireEvent.pointerUp(mic(), { clientY: 700, pointerId: 1 }); });
    expect(voice.onError).toHaveBeenCalledWith(TOO_SHORT_TEXT);
    expect(calls).toEqual(['start', 'cancel']);
    expect(submitted).toEqual([]);
  });

  it('被系统打断(pointercancel,如来电、权限弹框):作废,并说一句人话', async () => {
    const { submitted, voice } = mountHome();
    fireEvent.pointerDown(mic(), { clientY: 700, pointerId: 1 });
    await act(async () => { fireEvent.pointerCancel(mic(), { pointerId: 1 }); });
    expect(calls).toEqual(['start', 'cancel']);
    expect(voice.onError).toHaveBeenCalledWith(MIC_INTERRUPTED_TEXT);
    expect(submitted).toEqual([]);
  });

  it('识别没成:把那句人话原样说出来,不发', async () => {
    const voice = voiceOf({ transcribe: vi.fn(async (): Promise<AsrResult> => ({ ok: false, kind: 'network', error: '电脑不在线,这段没转成文字:让电脑开着、连上网,再按住说' })) });
    const { submitted } = mountHome({ voice });
    fireEvent.pointerDown(mic(), { clientY: 700, pointerId: 1 });
    await act(async () => { fireEvent.pointerUp(mic(), { clientY: 700, pointerId: 1 }); });
    await waitFor(() => expect(voice.onError).toHaveBeenCalledWith('电脑不在线,这段没转成文字:让电脑开着、连上网,再按住说'));
    expect(submitted).toEqual([]);
  });

  it('语音用不了:麦克风键灰着,按下去说为什么(不录音);打字照常能发', async () => {
    const voice = voiceOf({ disabled: true, disabledNote: '语音已关(设置里打开)' });
    const { submitted } = mountHome({ voice });
    expect(mic().getAttribute('aria-disabled')).toBe('true');
    expect(mic().getAttribute('title')).toBe('语音已关(设置里打开)');
    fireEvent.pointerDown(mic(), { clientY: 700, pointerId: 1 });
    expect(voice.onError).toHaveBeenCalledWith('语音已关(设置里打开)');
    expect(calls).toEqual([]);
    fireEvent.change(input(), { target: { value: '打字总还能用' } });
    fireEvent.keyDown(input(), { key: 'Enter' });
    await waitFor(() => expect(submitted.map((d) => d.text)).toEqual(['打字总还能用']));
  });

  it('打了一半字又按住说:打的字和说的话一起发出去,不丢', async () => {
    const { submitted } = mountHome();
    fireEvent.change(input(), { target: { value: '帮我记一下' } });
    fireEvent.pointerDown(mic(), { clientY: 700, pointerId: 1 });
    await act(async () => { fireEvent.pointerUp(mic(), { clientY: 700, pointerId: 1 }); });
    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(submitted[0]!.text).toBe('帮我记一下 周五交报销');
    expect(joinSaid('', '周五交报销')).toBe('周五交报销');
    expect(joinSaid('帮我记一下  ', '周五交报销')).toBe('帮我记一下 周五交报销');
  });

  it('只点一下、没有按住(读屏的双击、键盘回车):告诉他这颗键怎么用', () => {
    const { voice } = mountHome();
    fireEvent.click(mic());
    expect(voice.onError).toHaveBeenCalledWith(MIC_HINT_TEXT);
    expect(calls).toEqual([]);
  });

  it('指针按下那一下之后跟着来的那个 click 不再重复说', async () => {
    const { voice } = mountHome();
    recordedMs = 120;
    fireEvent.pointerDown(mic(), { clientY: 700, pointerId: 1 });
    await act(async () => { fireEvent.pointerUp(mic(), { clientY: 700, pointerId: 1 }); });
    fireEvent.click(mic());
    await waitFor(() => expect(voice.onError).toHaveBeenCalledWith(TOO_SHORT_TEXT));
    expect(voice.onError).not.toHaveBeenCalledWith(MIC_HINT_TEXT);
  });
});

describe('样式:两颗键同一种、同一尺寸、触控区与间距、不用蓝', () => {
  const css = readFileSync(resolve(__dirname, '../src/composer/composer.css'), 'utf8');
  const rule = (selector: string): string => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = new RegExp(`(^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css);
    expect(m, selector).not.toBeNull();
    return m![2]!;
  };

  it('发送键 36px 白底黑字;首页那一对键(麦克风、通话 / 发送)用的就是它,不另写一套尺寸', () => {
    const send = rule('.pc-send');
    expect(send).toMatch(/width:\s*36px/);
    expect(send).toMatch(/height:\s*36px/);
    expect(send).toMatch(/background:\s*#fff/);
    expect(send).toMatch(/color:\s*#111/);
    expect(css).not.toMatch(/\.pc-(?:mic|key|action)[^{]*\{[^}]*(?:^|[\s;])(?:width|height):/);
  });

  it('两颗键之间 10px:圆心相距 46px ≥ 44px,各自 44×44 的触控区不重叠', () => {
    expect(rule('.pc-keys')).toMatch(/gap:\s*10px/);
    // 36px 的圆(边框内 34px)往外扩 5px = 44px 见方的触控区,不改版面
    expect(rule('.pc-box[data-trim="phone-home"] .pc-key::before')).toMatch(/inset:\s*-5px/);
  });

  it('首页那一档不拿自己那一排键去撑外壳(360 宽开大字也不横向滚)', () => {
    expect(rule('.pc[data-trim="phone-home"]')).toMatch(/contain:\s*inline-size/);
  });

  it('麦克风键上按住不让系统抢手势:不滚、不选字、不弹长按菜单', () => {
    const m = rule('.pc-mic');
    expect(m).toMatch(/touch-action:\s*none/);
    expect(m).toMatch(/(^|[\s;])user-select:\s*none/);
    expect(m).toMatch(/-webkit-user-select:\s*none/);
    expect(m).toMatch(/-webkit-touch-callout:\s*none/);
  });

  it('这几条键的规则里只有黑白灰', () => {
    const keyRules = [...css.matchAll(/\n(\.pc-(?:send|key|keys|mic|action)[^{]*)\{([^}]*)\}/g)].map((m) => m[2]!).join('\n');
    expect(keyRules.length).toBeGreaterThan(0);
    const hexes = [...keyRules.matchAll(/#([0-9a-f]{3}|[0-9a-f]{6})\b/gi)].map((m) => m[1]!.toLowerCase());
    for (const hex of hexes) {
      const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;
      expect([full.slice(0, 2), full.slice(2, 4)], hex).toEqual([full.slice(2, 4), full.slice(4, 6)]);
    }
    expect(keyRules).not.toMatch(/rgb\((?!0 0 0)/);
  });
});

describe('sessionComposerApi.upload', () => {
  function fakeSession(direct: unknown, sendFile: (file: File) => Promise<{ ok: true } | { ok: false; error: string }>) {
    return {
      direct: { json: vi.fn(async () => direct) },
      client: { json: vi.fn() },
      channel: { sendFile: vi.fn(sendFile) },
    } as unknown as Session;
  }

  it('同一个局域网:直连 8791 传', async () => {
    const session = fakeSession({ ok: true, status: 200, data: { id: 'a.png', name: 'a.png', type: 'image/png', bytes: 3, image: true } }, async () => ({ ok: true }));
    const r = await sessionComposerApi(session).upload(new File(['abc'], 'a.png', { type: 'image/png' }));
    expect(r).toMatchObject({ ok: true, view: { id: 'a.png' } });
    expect((session.channel.sendFile as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('在外面(直连不通):走房间「发文件」那条字节流,id 是带随机前缀的文件名', async () => {
    const session = fakeSession({ ok: false, status: 0, kind: 'network', error: 'x' }, async () => ({ ok: true }));
    const r = await sessionComposerApi(session).upload(new File(['abc'], 'a.png', { type: 'image/png' }));
    expect(r.ok).toBe(true);
    const sent = (session.channel.sendFile as ReturnType<typeof vi.fn>).mock.calls[0]![0] as File;
    expect(sent.name).toMatch(/^[a-z0-9]{1,4}-a\.png$/);
    expect(r.ok && r.view.id).toBe(sent.name);
  });

  it('工作台答了个错(不是连不上)→ 如实说,不绕房间', async () => {
    const session = fakeSession({ ok: false, status: 413, kind: 'http', error: '太大了' }, async () => ({ ok: true }));
    expect(await sessionComposerApi(session).upload(new File(['abc'], 'a.png'))).toEqual({ ok: false, error: '太大了' });
  });
});

