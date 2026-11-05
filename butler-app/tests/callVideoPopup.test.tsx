/**
 * 通话中弹出来的那个播放器(2026-10-12,周三演示末尾那一下)。
 *
 * 规矩就三条:
 *   · 还在取的时候说一句「正在取…」,不摆一个空的黑框;
 *   · 取到了就在这儿放(App 内的 `<video controls playsInline>`,不跳到别的 App —— 电话还在打着);
 *   · 取不到如实说一句,关闭那颗 icon 一直在。
 *
 * 还有一条形状上的:这一层**不盖满整屏**(没有遮罩、底下那条挂断键照旧点得到)——
 * 盖住挂断键的弹窗等于把电话扣在手里。
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CALL_VIDEO_PULLING_TEXT, CallVideoPopup } from '../src/call/CallVideoPopup';

describe('通话中的视频弹窗', () => {
  it('正在取:说一句话,没有 video', () => {
    render(<CallVideoPopup name="片子.mp4" onClose={() => {}} />);
    expect(screen.getByText(CALL_VIDEO_PULLING_TEXT)).toBeTruthy();
    expect(document.querySelector('video')).toBeNull();
    expect(screen.getByText('片子.mp4')).toBeTruthy();
  });

  it('取到了:就在这儿放', () => {
    render(<CallVideoPopup name="片子.mp4" src="http://localhost/_capacitor_file_/x.mp4" onClose={() => {}} />);
    const video = document.querySelector('video');
    expect(video?.getAttribute('src')).toBe('http://localhost/_capacitor_file_/x.mp4');
    expect(video?.hasAttribute('controls')).toBe(true);
  });

  it('取不到:一句实话 + 关闭那颗 icon 还在', () => {
    const onClose = vi.fn();
    render(<CallVideoPopup name="片子.mp4" error="电脑那边说单子没了" onClose={onClose} />);
    expect(screen.getByText('视频没取到:电脑那边说单子没了')).toBeTruthy();
    screen.getByRole('button', { name: '关掉视频' }).click();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('不盖满整屏:没有遮罩(底下的挂断键照旧点得到)', () => {
    render(<CallVideoPopup name="片子.mp4" src="x.mp4" onClose={() => {}} />);
    expect(document.querySelector('.ba-scene__scrim')).toBeNull();
  });

  /**
   * **收掉它就是把 `<video>` 拿掉**(2026-10-13,卡 E 第 2 条:通话一结束页上那一处就这么做)。
   * 片子就放在这一层里,没有另一个长在页外、活得比它久的播放器 —— 不然「收掉弹窗」只是把声音藏起来。
   */
  it('★收掉这一层,片子跟着没了(通话结束就靠这一下)', () => {
    const view = render(<CallVideoPopup name="片子.mp4" src="x.mp4" onClose={() => {}} />);
    expect(document.querySelector('video')).toBeTruthy();
    view.unmount();
    expect(document.querySelector('video')).toBeNull();
  });
});
