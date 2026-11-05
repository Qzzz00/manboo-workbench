/**
 * 舞台底部那个输入框。
 *
 * 2026-09-17 Ben 拍板的是「左边通话键 + 右边输入框(点了打字、按住录音)」;2026-09-24 维护者改了(决策记录
 * 「手机首页输入框:通话键收进输入框、按住说话单独一颗」):
 *   - 「左侧的通话按钮和输入框有点不太一致……上面空了一大截」→ 通话键收进输入框右下角(没内容时发送键就是通话键);
 *   - 「输入框内的文字还是点击输入,按住说话,但实际上按住说不了话」→ 输入框只管打字,按住说话单独一颗麦克风键;
 *     提示语换成全局那句「说点什么…」。
 *
 * 录音本体(getUserMedia / WAV 封装)是 Aiboo 那份 useVoiceRecorder,这里整段假掉 —— 要测的是键与发送路径。
 */
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FIELD_PLACEHOLDER, StageComposer } from '../src/stage/StageComposer';
import type { AsrResult } from '../src/api/voice';

const calls: string[] = [];
let recordedMs = 1200;

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
        async startRecording() { calls.push('start'); setState({ status: 'recording', elapsedMs: 0 }); },
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

interface MountOptions {
  disabled?: boolean;
  disabledNote?: string;
  asr?: AsrResult;
  call?: { ready: boolean; label: string; title?: string };
}

function mount(options: MountOptions = {}) {
  calls.length = 0;
  recordedMs = 1200;
  const onText = vi.fn();
  const onError = vi.fn();
  const onCall = vi.fn();
  const transcribe = vi.fn(async () => options.asr ?? ({ ok: true, text: '周五交报销' } as AsrResult));
  const view = render(
    <StageComposer
      disabled={options.disabled ?? false}
      disabledNote={options.disabledNote}
      transcribe={transcribe}
      onText={onText}
      onError={onError}
      call={{ ready: true, label: '通话', ...options.call, onCall }}
    />,
  );
  return { view, onText, onError, onCall, transcribe };
}

const input = () => screen.getByLabelText('打字说给事务官') as HTMLTextAreaElement;
const mic = () => screen.getByRole('button', { name: '按住说话' });

describe('舞台底部输入框 · 打字', () => {
  it('输入框本身就是打字框,灰字「说点什么…」;不再是「点击输入,按住说话」那颗假输入框', () => {
    mount();
    expect(FIELD_PLACEHOLDER).toBe('说点什么…');
    expect(input().getAttribute('placeholder')).toBe('说点什么…');
    expect(screen.queryByText('点击输入,按住说话')).toBeNull();
    expect(document.querySelector('.ba-scene__field')).toBeNull();
  });

  it('打字回车发出去;发完清空、键变回通话', async () => {
    const { onText } = mount();
    fireEvent.change(input(), { target: { value: '帮我订明天的会议室' } });
    expect(screen.getByRole('button', { name: '发送' })).toBeTruthy();
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(onText).toHaveBeenCalledWith('帮我订明天的会议室');
    await waitFor(() => expect(input().value).toBe(''));
    expect(screen.getByRole('button', { name: '通话' })).toBeTruthy();
    expect(calls).toEqual([]); // 打字不录音
  });

  it('长按输入框不录音(那是系统的粘贴 / 选词),手势只挂在麦克风键上', async () => {
    mount();
    fireEvent.pointerDown(input(), { clientY: 700, pointerId: 1 });
    await new Promise((r) => setTimeout(r, 320));
    fireEvent.pointerUp(input(), { clientY: 700, pointerId: 1 });
    expect(calls).toEqual([]);
  });
});

describe('舞台底部输入框 · 通话键收在右下角', () => {
  it('没内容时右下角那颗就是通话键,点了进通话', () => {
    const { onCall } = mount();
    fireEvent.click(screen.getByRole('button', { name: '通话' }));
    expect(onCall).toHaveBeenCalledTimes(1);
  });

  it('通话打不了:灰着、点不动', () => {
    const { onCall } = mount({ call: { ready: false, label: '通话(电脑上还没配通话供应商)', title: '电脑上还没配通话供应商' } });
    const key = screen.getByRole('button', { name: /通话/ }) as HTMLButtonElement;
    expect(key.disabled).toBe(true);
    fireEvent.click(key);
    expect(onCall).not.toHaveBeenCalled();
  });
});

describe('舞台底部输入框 · 按住麦克风说话', () => {
  it('按下就录,松开转文字,和打字走同一条发送路径', async () => {
    const { onText, transcribe } = mount();
    fireEvent.pointerDown(mic(), { clientY: 700, pointerId: 1 });
    expect(calls).toEqual(['start']);
    await act(async () => { fireEvent.pointerUp(mic(), { clientY: 700, pointerId: 1 }); });
    await waitFor(() => expect(onText).toHaveBeenCalledWith('周五交报销'));
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['start', 'stop']);
  });

  it('上滑松手 = 不想发了:不转文字、不发送', async () => {
    const { onText, transcribe } = mount();
    fireEvent.pointerDown(mic(), { clientY: 700, pointerId: 1 });
    fireEvent.pointerMove(mic(), { clientY: 500, pointerId: 1 });
    await act(async () => { fireEvent.pointerUp(mic(), { clientY: 500, pointerId: 1 }); });
    expect(calls).toEqual(['start', 'cancel']);
    expect(transcribe).not.toHaveBeenCalled();
    expect(onText).not.toHaveBeenCalled();
  });

  it('手一滑按太短:说一句人话,不发一条空事项', async () => {
    const { onError, onText } = mount();
    recordedMs = 120;
    fireEvent.pointerDown(mic(), { clientY: 700, pointerId: 1 });
    await act(async () => { fireEvent.pointerUp(mic(), { clientY: 700, pointerId: 1 }); });
    await waitFor(() => expect(onError).toHaveBeenCalledWith('太短了,按住再说'));
    expect(onText).not.toHaveBeenCalled();
  });

  it('识别失败:把那句话原样说出来,不发送', async () => {
    const { onError, onText } = mount({ asr: { ok: false, kind: 'unavailable', error: '未配置语音供应商密钥' } });
    fireEvent.pointerDown(mic(), { clientY: 700, pointerId: 1 });
    await act(async () => { fireEvent.pointerUp(mic(), { clientY: 700, pointerId: 1 }); });
    await waitFor(() => expect(onError).toHaveBeenCalledWith('未配置语音供应商密钥'));
    expect(onText).not.toHaveBeenCalled();
  });
});

describe('舞台底部输入框 · 语音不可用的时候', () => {
  it('按住麦克风不录音、说明为什么;但**打字照常能用**(不能把人堵死)', async () => {
    const { onText, onError } = mount({ disabled: true, disabledNote: '语音已关(设置里打开)' });
    expect(mic().getAttribute('aria-disabled')).toBe('true');
    fireEvent.pointerDown(mic(), { clientY: 700, pointerId: 1 });
    expect(onError).toHaveBeenCalledWith('语音已关(设置里打开)');
    expect(calls).toEqual([]);
    fireEvent.change(input(), { target: { value: '打字总还能用' } });
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(onText).toHaveBeenCalledWith('打字总还能用');
  });
});
