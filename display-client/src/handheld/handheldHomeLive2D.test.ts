import { describe, expect, it } from 'vitest';

import {
  coverHomeScene,
  formatHandheldHomeTime,
  isHomeSceneCovered,
  markHomeSceneReady,
  openSettingsAfterHomePark,
  shouldMountHandheldHomeLive2D,
} from './handheldHomeLive2D.ts';
import {
  createLifecycleTrace,
  recordLifecyclePhase,
} from '../lib/handheldLifecycleTrace.ts';

describe('shouldMountHandheldHomeLive2D', () => {
  it('生命周期日志固定格式并对同一 phase 去重', () => {
    const output: string[] = [];
    const trace = createLifecycleTrace('[handheld-home]', 7, 100);

    expect(recordLifecyclePhase(trace, 'request', 100, output.push.bind(output))).toBe(true);
    expect(recordLifecyclePhase(trace, 'request', 101, output.push.bind(output))).toBe(false);
    expect(recordLifecyclePhase(trace, 'composite_ready', 112.6, output.push.bind(output))).toBe(true);

    expect(output).toEqual([
      '[handheld-home] id=7 phase=request elapsed=0ms',
      '[handheld-home] id=7 phase=composite_ready elapsed=13ms',
    ]);
  });

  it('主页时间使用带英文冒号的 HH:mm 单行格式', () => {
    expect(formatHandheldHomeTime(new Date(2026, 7, 5, 9, 7))).toBe('09:07');
  });

  it('旧请求的 ready 不能揭开新一轮主页', () => {
    const first = coverHomeScene({ requestId: 0, readyRequestId: -1 });
    const second = coverHomeScene(first);
    expect(markHomeSceneReady(second, first.requestId)).toEqual(second);
    expect(isHomeSceneCovered(second)).toBe(true);
  });

  it('当前请求完整帧到达后才揭开', () => {
    const covered = coverHomeScene({ requestId: 0, readyRequestId: -1 });
    expect(isHomeSceneCovered(markHomeSceneReady(covered, covered.requestId))).toBe(false);
  });

  it('主页 pause 失败时不挂设置预览', async () => {
    let previewMounted = false;

    const opened = await openSettingsAfterHomePark(
      async () => { throw new Error('pause failed'); },
      () => { previewMounted = true; },
    );

    expect(opened).toBe(false);
    expect(previewMounted).toBe(false);
  });

  it('主页 pause 确认后才挂设置预览', async () => {
    let previewMounted = false;

    const opened = await openSettingsAfterHomePark(
      async () => {},
      () => { previewMounted = true; },
    );

    expect(opened).toBe(true);
    expect(previewMounted).toBe(true);
  });

  it('仅在主页可见且浮窗已释放时挂载主页模型', () => {
    expect(shouldMountHandheldHomeLive2D({
      page: 'home',
      documentVisible: true,
      overlayStopped: true,
      pageReady: true,
      settingsOpen: false,
    })).toBe(true);
  });

  it.each([
    { page: 'games' as const, documentVisible: true, overlayStopped: true, pageReady: true, settingsOpen: false },
    { page: 'home' as const, documentVisible: false, overlayStopped: true, pageReady: true, settingsOpen: false },
    { page: 'home' as const, documentVisible: true, overlayStopped: false, pageReady: true, settingsOpen: false },
    { page: 'home' as const, documentVisible: true, overlayStopped: true, pageReady: false, settingsOpen: false },
    { page: 'home' as const, documentVisible: true, overlayStopped: true, pageReady: true, settingsOpen: true },
  ])('不满足单模型前提时不挂载主页模型：%o', (state) => {
    expect(shouldMountHandheldHomeLive2D(state)).toBe(false);
  });
});
