import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';

const nativeBridges = vi.hoisted(() => ({
  overlay: {
    hasOverlayPermission: vi.fn(),
    start: vi.fn(),
    prewarm: vi.fn(),
    saveStripParams: vi.fn(),
  },
  handheld: {
    launchRom: vi.fn(),
  },
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => true,
    convertFileSrc: (path: string) => path,
  },
  registerPlugin: (name: string) => {
    if (name === 'Overlay') return nativeBridges.overlay;
    if (name === 'Handheld') return nativeBridges.handheld;
    return {};
  },
}));

import {
  computeStripGeometry,
  prewarmBottomStrip,
  startBottomStrip,
  STRIP_HEIGHT_PX,
  stripCtxFor,
  STRIP_NATIVE_TARGET_FPS,
  syncStripParams,
} from './handheldStrip.ts';
import { defaultHandheldSettings, withStripFraming } from './handheldSettingsStore.ts';
import { handheldStripLayerLayout } from '../pet/handheldStripUi.ts';
import { launchHandheldRom } from './handheldGameLaunch.ts';
import capacitorConfig from '../../capacitor.config.ts';

function installBrowserStorage() {
  const values = new Map<string, string>();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  } as Storage;
  (globalThis as unknown as { window: Window }).window = {
    devicePixelRatio: 1.5,
    screen: { width: 480, height: 480 },
  } as unknown as Window;
}

describe('computeStripGeometry', () => {
  // 掌机真实分辨率：720×720（CSS 视口 480×480 × dpr 1.5）。
  // 240 的由来：Ben 的 RetroArch 配成 custom_viewport 720×480 @ y=0，底下剩的就是这条。
  it('掌机 720×720 → 满宽底条钉在下方 240px', () => {
    expect(computeStripGeometry({ widthPx: 720, heightPx: 720 })).toEqual({
      xPx: 0,
      yPx: 480,
      widthPx: 720,
      heightPx: 240,
    });
  });

  it('默认高度就是 STRIP_HEIGHT_PX', () => {
    const a = computeStripGeometry({ widthPx: 720, heightPx: 720 });
    const b = computeStripGeometry({ widthPx: 720, heightPx: 720 }, STRIP_HEIGHT_PX);
    expect(a).toEqual(b);
  });

  it('竖屏手机也算得对（不写死方屏）', () => {
    expect(computeStripGeometry({ widthPx: 1080, heightPx: 2400 })).toEqual({
      xPx: 0,
      yPx: 2160,
      widthPx: 1080,
      heightPx: 240,
    });
  });

  // 浮窗 gravity 是 TOP|START，y 是自己算的——条高超过屏高时若不钳制会得到负 y，
  // 窗口被顶到屏幕外，现象是「起了但看不见」。
  it('条高超过屏高时钳到满屏，y 不为负', () => {
    expect(computeStripGeometry({ widthPx: 720, heightPx: 200 }, 240)).toEqual({
      xPx: 0,
      yPx: 0,
      widthPx: 720,
      heightPx: 200,
    });
  });
});

describe('stripCtxFor', () => {
  const screen = { widthPx: 720, heightPx: 720 };

  it('带上该角色的取景目标与剪影，且帧率不吃 15 的默认地板', () => {
    const ctx = stripCtxFor('ghostpuppy', defaultHandheldSettings(), screen);
    expect(ctx.framingHeadScreenY).toBe(0.35);
    expect(ctx.framingFaceScreenFrac).toBe(0.31);
    expect(ctx.silhouetteUrl).toBe('./live2D/ghostpuppy/strip-silhouette.png');
    expect(ctx.nativeTargetFps).toBe(STRIP_NATIVE_TARGET_FPS);
    expect(STRIP_NATIVE_TARGET_FPS).toBe(60);
  });

  // 双生在 avatarData 里没填头部度量，必须由掌机侧下发真值；另两只不下发（用它们自己的）
  it('只有双生下发 hs/ha 头部度量覆盖', () => {
    const dj = stripCtxFor('shuangsheng-dj', defaultHandheldSettings(), screen);
    expect(dj.framingHeadSizeNorm).toBe(0.19);
    expect(dj.framingHeadAnchorY).toBe(0.05);

    const pup = stripCtxFor('ghostpuppy', defaultHandheldSettings(), screen);
    expect(pup.framingHeadSizeNorm).toBeUndefined();
    expect(pup.framingHeadAnchorY).toBeUndefined();
  });

  it('用户调过的取景优先于注册表默认', () => {
    const s = withStripFraming(defaultHandheldSettings(), 'tororo', {
      headScreenY: 0.62,
      faceScreenFrac: 0.48,
    });
    const ctx = stripCtxFor('tororo', s, screen);
    expect(ctx.framingHeadScreenY).toBe(0.62);
    expect(ctx.framingFaceScreenFrac).toBe(0.48);
  });

  // 未知 id 不能把 ctx 拼成一堆 undefined —— 回落第一只（与注册表同一套回落语义）
  it('未知角色 id 回落默认那只的参数', () => {
    const ctx = stripCtxFor('nope', defaultHandheldSettings(), screen);
    expect(ctx.silhouetteUrl).toBe('./live2D/shuangsheng-dj/strip-silhouette.png');
    expect(ctx.framingHeadSizeNorm).toBe(0.19);
  });

  // 几何：条钉在屏幕底部；新版 Figma 底条本身是控制区，按钮必须可触。
  it('几何与 Figma 控制条交互参数不变', () => {
    const ctx = stripCtxFor('tororo', defaultHandheldSettings(), screen);
    expect(ctx).toMatchObject({ xPx: 0, yPx: 480, widthPx: 720, heightPx: 240 });
    expect(ctx.touchThrough).toBe(false);
    expect(ctx.webTouchable).toBe(true);
    expect(ctx.fixed).toBe(true);
    expect(ctx.rendererMode).toBe('native');
    expect(ctx.stripMode).toBe(true);
    expect(ctx.stripUi).toBe('figma-handheld');
  });
});

describe('stripCtxFor 军师上下文', () => {
  const screen = { widthPx: 720, heightPx: 720 };
  const settings = defaultHandheldSettings();

  it('带上底条高度（原生截屏用它当裁剪量去掉角色自己）', () => {
    expect(stripCtxFor('shuangsheng', settings, screen).stripHeightPx).toBe(240);
  });

  it('传了 ROM 与服务器就带进去，供底条 resolve 知识包', () => {
    const ctx = stripCtxFor('shuangsheng', settings, screen, {
      baseUrl: 'http://127.0.0.1:8080',
      rom: { fileName: '空之花神.gba', path: '/storage/emulated/0/GBA/空之花神.gba' },
    });
    expect(ctx.strategistBaseUrl).toBe('http://127.0.0.1:8080');
    expect(ctx.romFileName).toBe('空之花神.gba');
    expect(ctx.romPath).toBe('/storage/emulated/0/GBA/空之花神.gba');
  });

  it('没传 ROM 时字段是 undefined，不塞空串（空串会被当合法文件名去 resolve）', () => {
    const ctx = stripCtxFor('shuangsheng', settings, screen);
    expect(ctx.romFileName).toBeUndefined();
    expect(ctx.romPath).toBeUndefined();
    expect(ctx.strategistBaseUrl).toBeUndefined();
  });

  it('原有取景/帧率字段一个不少（军师不能把底条既有参数挤掉）', () => {
    const ctx = stripCtxFor('shuangsheng', settings, screen);
    expect(ctx.stripMode).toBe(true);
    expect(ctx.stripUi).toBe('figma-handheld');
    expect(ctx.touchThrough).toBe(false);
    expect(ctx.webTouchable).toBe(true);
    expect(ctx.nativeTargetFps).toBe(60);
    expect(typeof ctx.framingHeadScreenY).toBe('number');
  });
});

describe('底条原生 request 同源', () => {
  beforeEach(() => {
    installBrowserStorage();
    localStorage.setItem('aiboo:strategist-config', JSON.stringify({
      baseUrl: 'https://strategist.example',
      deviceToken: 'strategist-test-token',
      aibooBaseUrl: 'https://voice.example',
      aibooDeviceToken: 'voice-test-token',
    }));
    localStorage.setItem('aiboo:handheld-last-launched', JSON.stringify({
      pkg: 'com.retroarch.aarch64',
      romPath: '/storage/emulated/0/GBA/Kirby.gba',
    }));
    nativeBridges.overlay.hasOverlayPermission.mockReset().mockResolvedValue({ granted: true });
    nativeBridges.overlay.start.mockReset().mockResolvedValue(undefined);
    nativeBridges.overlay.prewarm.mockReset().mockResolvedValue(undefined);
    nativeBridges.overlay.saveStripParams.mockReset().mockResolvedValue(undefined);
    nativeBridges.handheld.launchRom.mockReset().mockResolvedValue(undefined);
  });

  it('start/prewarm/save 深等同一份完整 Figma 底条 request', async () => {
    await startBottomStrip('tororo');
    await prewarmBottomStrip('tororo');
    await syncStripParams('tororo');

    const expected = {
      avatarId: 'tororo',
      widthDp: 260,
      aspect: '3:4',
      petQuery: [
        'renderer=native',
        'hy=0.35',
        'ff=0.31',
        'sil=.%2Flive2D%2Ftororo%2Fstrip-silhouette.png',
        'fps=60',
        'sh=240',
        'sv=https%3A%2F%2Fstrategist.example',
        'rom=Kirby.gba',
        'romp=%2Fstorage%2Femulated%2F0%2FGBA%2FKirby.gba',
        'ab=https%3A%2F%2Fvoice.example',
        'stripUi=figma-handheld',
        'strip=1',
      ].join('&'),
      token: 'strategist-test-token',
      aibooToken: 'voice-test-token',
      fixed: true,
      xPx: 0,
      yPx: 480,
      widthPx: 720,
      heightPx: 240,
      touchThrough: false,
      webTouchable: true,
    };
    expect(nativeBridges.overlay.start).toHaveBeenCalledWith(expected);
    expect(nativeBridges.overlay.prewarm).toHaveBeenCalledWith(expected);
    expect(nativeBridges.overlay.saveStripParams).toHaveBeenCalledWith(expected);
    expect(handheldStripLayerLayout().nativeBottomBar.color).toBe('#FF1A1A1A');
  });

  it('prewarm 原生拒绝会透传给调用方处理', async () => {
    const error = new Error('native prewarm unavailable');
    nativeBridges.overlay.prewarm.mockRejectedValueOnce(error);
    await expect(prewarmBottomStrip('tororo')).rejects.toBe(error);
  });

  it('prewarm 不经过 JS 权限桥，立即把本次 ROM request 交给原生', async () => {
    nativeBridges.overlay.hasOverlayPermission.mockReturnValueOnce(new Promise(() => {}));

    const warming = prewarmBottomStrip('tororo');
    localStorage.setItem('aiboo:handheld-last-launched', JSON.stringify({
      pkg: 'com.retroarch.aarch64',
      romPath: '/storage/emulated/0/GBA/Zelda.gba',
    }));
    await warming;

    expect(nativeBridges.overlay.hasOverlayPermission).not.toHaveBeenCalled();
    const request = nativeBridges.overlay.prewarm.mock.calls[0]?.[0] as { petQuery: string };
    expect(request.petQuery).toContain('rom=Kirby.gba');
    expect(request.petQuery).not.toContain('Zelda.gba');
  });
});

describe('Capacitor bridge 日志', () => {
  it('Android debug 包也禁止 bridge 输出含认证与 ROM 上下文的 methodData', () => {
    expect(capacitorConfig.android?.loggingBehavior).toBe('none');
  });
});

describe('启动 ROM 时的旁路预热', () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };

  beforeEach(() => {
    unhandled.length = 0;
    process.on('unhandledRejection', onUnhandled);
  });

  afterEach(() => {
    process.off('unhandledRejection', onUnhandled);
  });

  it('真实 bridge 在 launchRom 前同步入队 prewarm，权限查询即使悬空也不阻塞启动', () => {
    installBrowserStorage();
    nativeBridges.overlay.hasOverlayPermission.mockReset().mockReturnValue(new Promise(() => {}));
    nativeBridges.overlay.prewarm.mockReset().mockResolvedValue(undefined);
    nativeBridges.overlay.saveStripParams.mockReset().mockResolvedValue(undefined);
    nativeBridges.handheld.launchRom.mockReset().mockResolvedValue(undefined);

    launchHandheldRom('tororo', {
      path: '/storage/emulated/0/GBA/Kirby.gba',
      fileName: 'Kirby.gba',
      sizeBytes: 1024,
      platform: 'GBA',
      rootDir: '/storage/emulated/0/GBA',
    });

    expect(nativeBridges.overlay.hasOverlayPermission).not.toHaveBeenCalled();
    expect(nativeBridges.overlay.prewarm).toHaveBeenCalledTimes(1);
    expect(nativeBridges.handheld.launchRom).toHaveBeenCalledTimes(1);
    expect(nativeBridges.overlay.prewarm.mock.invocationCallOrder[0])
      .toBeLessThan(nativeBridges.handheld.launchRom.mock.invocationCallOrder[0]);
  });

  it('原生 prewarm 因缺权限拒绝时由现有 catch 吞掉，ROM 仍已启动', async () => {
    installBrowserStorage();
    nativeBridges.overlay.hasOverlayPermission.mockReset();
    nativeBridges.overlay.prewarm.mockReset().mockRejectedValue(new Error('overlay permission not granted'));
    nativeBridges.overlay.saveStripParams.mockReset().mockResolvedValue(undefined);
    nativeBridges.handheld.launchRom.mockReset().mockResolvedValue(undefined);

    launchHandheldRom('tororo', {
      path: '/storage/emulated/0/GBA/Kirby.gba',
      fileName: 'Kirby.gba',
      sizeBytes: 1024,
      platform: 'GBA',
      rootDir: '/storage/emulated/0/GBA',
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(nativeBridges.handheld.launchRom).toHaveBeenCalledTimes(1);
    expect(unhandled).toEqual([]);
  });

  it('不等 sync/prewarm 就原样调 launchRom，三路拒绝也没有 unhandled rejection', async () => {
    const deferred = () => {
      let reject!: (reason?: unknown) => void;
      const promise = new Promise<void>((_resolve, rejectPromise) => { reject = rejectPromise; });
      return { promise, reject };
    };
    const sync = deferred();
    const prewarm = deferred();
    const nativeLaunch = deferred();
    const calls: string[] = [];
    const launchArgs: unknown[] = [];
    const warnings: unknown[][] = [];

    launchHandheldRom('tororo', {
      path: '/storage/emulated/0/GBA/Kirby.gba',
      fileName: 'Kirby.gba',
      sizeBytes: 1024,
      platform: 'GBA',
      rootDir: '/storage/emulated/0/GBA',
    }, {
      loadLastLaunched: () => null,
      saveLastLaunched: () => { calls.push('save'); },
      syncStripParams: () => { calls.push('sync'); return sync.promise; },
      prewarmBottomStrip: () => { calls.push('prewarm'); return prewarm.promise; },
      launchRom: (args) => { calls.push('launch'); launchArgs.push(args); return nativeLaunch.promise; },
      warn: (...args) => { warnings.push(args); },
    });

    expect(calls).toEqual(['save', 'sync', 'prewarm', 'launch']);
    expect(launchArgs).toEqual([{
      path: '/storage/emulated/0/GBA/Kirby.gba',
      app: 'retroarch',
      core: 'mgba_libretro_android.so',
      switchApp: 'com.retroarch.aarch64',
    }]);

    sync.reject(new Error('sync contains a private path'));
    prewarm.reject(new Error('prewarm contains a private query'));
    nativeLaunch.reject(new Error('launch contains a private path'));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(warnings).toEqual([['[handheld-strip] prewarm failed; F10 will cold-start']]);
    expect(unhandled).toEqual([]);
  });
});
