/**
 * 「识别中」挂久了要说一句(2026-09-25,卡 S「手机在哪都能用」)。
 * 在外面第一次按住说话要先进房间、再经房间转文字,弱网上可能要十来秒;验收清单:任何等待超过 8 秒要有说明。
 */
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TRANSCRIBE_SLOW_MS, TRANSCRIBE_SLOW_TEXT, VoiceRecordOverlay } from '../src/aiboo/VoiceRecordOverlay';

afterEach(() => { vi.useRealTimers(); });

describe('识别中 · 等久了补一句', () => {
  it('8 秒以内只说「识别中」;过了 8 秒补「网有点慢,还在转文字」', () => {
    vi.useFakeTimers();
    render(<VoiceRecordOverlay visible transcribing elapsedMs={0} cancelHint={false} />);
    expect(screen.getByText(/识别中/)).toBeTruthy();
    act(() => { vi.advanceTimersByTime(TRANSCRIBE_SLOW_MS - 100); });
    expect(screen.queryByText(TRANSCRIBE_SLOW_TEXT)).toBeNull();
    act(() => { vi.advanceTimersByTime(200); });
    expect(screen.getByText(TRANSCRIBE_SLOW_TEXT)).toBeTruthy();
  });

  it('转完了再来一段:重新计时,不带着上一段的「网慢」', () => {
    vi.useFakeTimers();
    const view = render(<VoiceRecordOverlay visible transcribing elapsedMs={0} cancelHint={false} />);
    act(() => { vi.advanceTimersByTime(TRANSCRIBE_SLOW_MS + 10); });
    expect(screen.getByText(TRANSCRIBE_SLOW_TEXT)).toBeTruthy();
    view.rerender(<VoiceRecordOverlay visible={false} transcribing={false} elapsedMs={0} cancelHint={false} />);
    view.rerender(<VoiceRecordOverlay visible transcribing elapsedMs={0} cancelHint={false} />);
    expect(screen.queryByText(TRANSCRIBE_SLOW_TEXT)).toBeNull();
  });

  it('录音时(还没到识别)不出这一句', () => {
    vi.useFakeTimers();
    render(<VoiceRecordOverlay visible transcribing={false} elapsedMs={3000} cancelHint={false} />);
    act(() => { vi.advanceTimersByTime(TRANSCRIBE_SLOW_MS * 2); });
    expect(screen.queryByText(TRANSCRIBE_SLOW_TEXT)).toBeNull();
  });
});
