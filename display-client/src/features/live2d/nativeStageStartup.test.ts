import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AvatarManifest } from './types.ts';

const {
  nativeHide,
  nativeReleaseModel,
  nativeSetBackground,
  nativeSetLayout,
  nativeShow,
  nativeShowModel,
} = vi.hoisted(() => ({
  nativeHide: vi.fn(() => Promise.resolve()),
  nativeReleaseModel: vi.fn(() => Promise.resolve()),
  nativeSetBackground: vi.fn(() => Promise.resolve()),
  nativeSetLayout: vi.fn(() => Promise.resolve()),
  nativeShow: vi.fn(),
  nativeShowModel: vi.fn(),
}));

vi.mock('../../lib/nativeLive2dBridge.ts', () => ({
  NativeLive2D: {
    hide: nativeHide,
    releaseModel: nativeReleaseModel,
    setBackground: nativeSetBackground,
    setLayout: nativeSetLayout,
    show: nativeShow,
    showModel: nativeShowModel,
  },
  isNativeLive2DPluginAvailable: () => true,
}));
vi.mock('./live2dEngine.ts', () => ({
  SURFACE_FRAMING: { home: { topClampMin: 0 } },
  computeAutoFit: vi.fn(() => ({ scale: 1, offsetX: 0, offsetY: 0 })),
  computeModelLayout: vi.fn(() => ({
    modelX: 50,
    modelY: 100,
    modelPixelWidth: 50,
    modelPixelHeight: 100,
  })),
  createAugmentedSettings: vi.fn(() => ({})),
  findIdleMotionKey: vi.fn(() => null),
  resolveIdleBeatKeys: vi.fn(() => []),
}));

import {
  destroyNativeStage,
  getNativeStageState,
  parkNativeStage,
  showAvatarModel,
} from './nativeStage.ts';

describe('原生 Live2D 首屏', () => {
  beforeEach(() => {
    const classList = { add: vi.fn(), remove: vi.fn() };
    vi.stubGlobal('window', {
      innerWidth: 100,
      innerHeight: 100,
      location: { origin: 'https://localhost' },
    });
    vi.stubGlobal('document', { documentElement: { classList } });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })));
    nativeShow.mockResolvedValue(undefined);
    nativeShowModel.mockResolvedValue({ canvasWidthPx: 50, canvasHeightPx: 100, params: [] });
  });

  afterEach(async () => {
    await destroyNativeStage();
    vi.useRealTimers();
    nativeHide.mockClear();
    nativeReleaseModel.mockClear();
    nativeSetBackground.mockClear();
    nativeSetLayout.mockClear();
    nativeShow.mockReset();
    nativeShowModel.mockReset();
    vi.unstubAllGlobals();
  });

  it('冷启动先提交背景，再加载模型', async () => {
    await showAvatarModel({
      id: 'background-first-test',
      modelJson: '/live2D/background-first/model3.json',
    } as AvatarManifest, {
      surface: 'home',
      transform: { scale: 1, offsetX: 0, offsetY: 0 },
      backgroundUrl: '/backgrounds/radio-dj-bg.png',
    });

    expect(nativeSetBackground).toHaveBeenCalledWith({
      assetPath: 'public/backgrounds/radio-dj-bg.png',
    });
    expect(nativeSetBackground.mock.invocationCallOrder[0])
      .toBeLessThan(nativeShowModel.mock.invocationCallOrder[0]);
  });

  it('主页展示号原样传到 showModel 和最终合成帧等待', async () => {
    await showAvatarModel({
      id: 'correlated-trace-test',
      modelJson: '/live2D/correlated-trace/model3.json',
    } as AvatarManifest, {
      surface: 'home',
      transform: { scale: 1, offsetX: 0, offsetY: 0 },
      backgroundUrl: '/backgrounds/radio-dj-bg.png',
      lifecycleRequestId: 41,
    });

    expect(nativeShowModel).toHaveBeenCalledWith(expect.objectContaining({ lifecycleTraceId: 41 }));
    expect(nativeShow).toHaveBeenCalledWith({ lifecycleTraceId: 41 });
  });

  it('setBackground 提交完成不冒充 renderer 已画出背景', async () => {
    const output: string[] = [];
    vi.spyOn(console, 'info').mockImplementation((message) => output.push(String(message)));
    let resolveFrame!: () => void;
    nativeShow.mockReturnValueOnce(new Promise<void>((resolve) => { resolveFrame = resolve; }));
    const loading = showAvatarModel({
      id: 'background-truth-test',
      modelJson: '/live2D/background-truth/model3.json',
    } as AvatarManifest, {
      surface: 'home',
      transform: { scale: 1, offsetX: 0, offsetY: 0 },
      backgroundUrl: '/backgrounds/radio-dj-bg.png',
      lifecycleRequestId: 42,
    });

    await vi.waitFor(() => expect(nativeShow).toHaveBeenCalledTimes(1));
    expect(output.some((line) => line.includes('phase=background_ready'))).toBe(false);
    resolveFrame();
    await loading;
  });

  it('首次新建原生层后在最终完整帧前重提背景', async () => {
    await showAvatarModel({
      id: 'attached-background-test',
      modelJson: '/live2D/attached-background/model3.json',
    } as AvatarManifest, {
      surface: 'home',
      transform: { scale: 1, offsetX: 0, offsetY: 0 },
      backgroundUrl: '/backgrounds/radio-dj-bg.png',
    });

    expect(nativeSetBackground).toHaveBeenCalledTimes(2);
    expect(nativeSetBackground.mock.invocationCallOrder[1])
      .toBeGreaterThan(nativeShowModel.mock.invocationCallOrder[0]);
    expect(nativeSetBackground.mock.invocationCallOrder[1])
      .toBeLessThan(nativeShow.mock.invocationCallOrder[0]);
  });

  it('冷启动也等稳定构图后的完整帧才恢复 native-live2d 透明态', async () => {
    let resolveFrame!: () => void;
    nativeShow.mockReturnValueOnce(new Promise<void>((resolve) => { resolveFrame = resolve; }));
    const loading = showAvatarModel({
      id: 'cold-final-frame-test',
      modelJson: '/live2D/cold-final-frame/model3.json',
    } as AvatarManifest, {
      surface: 'home',
      transform: { scale: 1, offsetX: 0, offsetY: 0 },
      backgroundUrl: '/backgrounds/radio-dj-bg.png',
    });

    await vi.waitFor(() => expect(nativeShow).toHaveBeenCalledTimes(1));
    expect(document.documentElement.classList.add).not.toHaveBeenCalled();
    resolveFrame();
    await loading;
    expect(document.documentElement.classList.add).toHaveBeenCalledWith('native-live2d');
  });

  it('热恢复等完整帧后才恢复 native-live2d 透明态', async () => {
    const avatar = {
      id: 'hot-resume-test',
      modelJson: '/live2D/hot-resume/model3.json',
    } as AvatarManifest;
    const options = {
      surface: 'home' as const,
      transform: { scale: 1, offsetX: 0, offsetY: 0 },
      backgroundUrl: '/backgrounds/radio-dj-bg.png',
    };

    await showAvatarModel(avatar, options);
    const classList = document.documentElement.classList;
    vi.mocked(classList.add).mockClear();
    let resolveFrame!: () => void;
    nativeShow.mockReturnValueOnce(new Promise<void>((resolve) => { resolveFrame = resolve; }));

    const resumed = showAvatarModel(avatar, options);
    await Promise.resolve();
    expect(classList.add).not.toHaveBeenCalled();

    resolveFrame();
    await resumed;
    expect(classList.add).toHaveBeenCalledWith('native-live2d');
  });

  it('park 只暂停并保留热模型状态', async () => {
    const avatar = {
      id: 'park-test',
      modelJson: '/live2D/park/model3.json',
    } as AvatarManifest;
    await showAvatarModel(avatar, {
      surface: 'home',
      transform: { scale: 1, offsetX: 0, offsetY: 0 },
      backgroundUrl: '/backgrounds/radio-dj-bg.png',
    });

    await parkNativeStage();

    expect(nativeHide).toHaveBeenCalledTimes(1);
    expect(getNativeStageState()?.avatar.id).toBe(avatar.id);
    expect(document.documentElement.classList.remove).toHaveBeenCalledWith('native-live2d');
    expect(nativeReleaseModel).not.toHaveBeenCalled();
  });

  it('park 会让尚未完成的冷启动失效，不能在设置页挂载后反向恢复主页层', async () => {
    let resolveModel!: (result: { canvasWidthPx: number; canvasHeightPx: number; params: [] }) => void;
    nativeShowModel.mockReturnValueOnce(new Promise((resolve) => { resolveModel = resolve; }));
    const loading = showAvatarModel({
      id: 'park-pending-cold-test',
      modelJson: '/live2D/park-pending-cold/model3.json',
    } as AvatarManifest, {
      surface: 'home',
      transform: { scale: 1, offsetX: 0, offsetY: 0 },
      backgroundUrl: '/backgrounds/radio-dj-bg.png',
    }).then(
      () => 'resolved',
      (error: Error) => error.message,
    );
    await vi.waitFor(() => expect(nativeShowModel).toHaveBeenCalledTimes(1));

    await parkNativeStage();
    resolveModel({ canvasWidthPx: 50, canvasHeightPx: 100, params: [] });

    expect(await loading).toBe('superseded');
    expect(document.documentElement.classList.add).not.toHaveBeenCalled();
  });

  it('热恢复丢帧 3000ms 后销毁并冷加载同一请求一次', async () => {
    vi.useFakeTimers();
    const avatar = {
      id: 'lost-frame-retry-test',
      modelJson: '/live2D/lost-frame-retry/model3.json',
    } as AvatarManifest;
    const options = {
      surface: 'home' as const,
      transform: { scale: 1, offsetX: 0, offsetY: 0 },
      backgroundUrl: '/backgrounds/radio-dj-bg.png',
    };

    await showAvatarModel(avatar, options);
    nativeShow
      .mockReturnValueOnce(new Promise<void>(() => {}))
      .mockResolvedValueOnce(undefined);
    const resumed = showAvatarModel(avatar, options).then(
      (state) => ({ ok: true as const, state }),
      (error: Error) => ({ ok: false as const, error }),
    );

    await vi.advanceTimersByTimeAsync(2999);
    expect(nativeShowModel).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    const outcome = await resumed;

    expect(outcome.ok).toBe(true);
    expect(nativeReleaseModel).toHaveBeenCalledTimes(1);
    expect(nativeShowModel).toHaveBeenCalledTimes(2);
  });

  it('热恢复销毁等待期间发生 park 后不再启动冷重试', async () => {
    vi.useFakeTimers();
    const avatar = {
      id: 'lost-frame-ownership-test',
      modelJson: '/live2D/lost-frame-ownership/model3.json',
    } as AvatarManifest;
    const options = {
      surface: 'home' as const,
      transform: { scale: 1, offsetX: 0, offsetY: 0 },
      backgroundUrl: '/backgrounds/radio-dj-bg.png',
    };
    await showAvatarModel(avatar, options);
    vi.mocked(document.documentElement.classList.add).mockClear();

    let resolveDestroyHide!: () => void;
    nativeShow.mockReturnValueOnce(new Promise<void>(() => {}));
    nativeHide
      .mockReturnValueOnce(new Promise<void>((resolve) => { resolveDestroyHide = resolve; }))
      .mockResolvedValueOnce(undefined);
    const recovery = showAvatarModel(avatar, options).then(
      () => 'resolved',
      (error: Error) => error.message,
    );

    await vi.advanceTimersByTimeAsync(3000);
    expect(nativeHide).toHaveBeenCalledTimes(1);
    await parkNativeStage();
    resolveDestroyHide();

    expect(await recovery).toBe('superseded');
    expect(nativeShowModel).toHaveBeenCalledTimes(1);
    expect(document.documentElement.classList.add).not.toHaveBeenCalled();
  });

  it('park 的原生 pause 失败时向调用方传播', async () => {
    nativeHide.mockRejectedValueOnce(new Error('pause failed'));

    await expect(parkNativeStage()).rejects.toThrow('pause failed');
  });
});
