/* 待机烘焙编排（极限环闭环烘焙，机制定稿见
 * docs/superpowers/specs/2026-07-07-magikcard-idle-limit-cycle-bake.md，M1-M11 实证）。
 *
 * 原理：严格周期驱动 + 确定性阻尼物理 ⇒ 粒子状态收敛到唯一周期轨道；
 * 恒等式「逐圈边界粒子残差 = 采集窗接缝误差」⇒ 残差<EPS 才采集 = 带证书的无缝。
 * 采集窗对齐（2026-07-10）：窗边界=残差落点=证书回卷对，而边界相位在环上本是自由参数——
 * 侦察窗测环形 MAD 谷后推进到谷相位重采，回卷对落在内容最静转移处（bakeAlign.ts）。
 *
 * 五个已踩实的地雷（每条都有当日数据实锤，动之前先读 spec）：
 * ① 残差必须测 _physicsRig.particles（update() 末尾 loadParameters 会把物理输出从参数表
 *    抹掉，按参数测=假收敛）；② 抓帧 advanceMs 必须=0（0.001 微步踢粒子速度 0.71/次=恒定
 *    回卷 12.03）；③ 预热前必须 physics.initialize()（多稳态吸引子=抽卡本体）；④ ticker
 *    必须停且防看门狗复活（MessageChannel yield + lastTickAt 喂食 + yield 后再停）；
 * ⑤ 眼参数只认 beforeModelUpdate 位（库在 afterMotionUpdate 后恢复默认睁）。
 */
import * as PIXI from 'pixi.js';
import { diffBoundingBox, findMouthAnchor, intersectRegions, type ExportRegion } from '../../tools/badgeExport/exportUtils.ts';
import { getRuntimeParameterSnapshot } from '../../features/live2d/live2dEngine.ts';
import type { createLive2DRuntime } from '../../features/live2d/live2dEngine.ts';
import { planAlignedWindow } from './bakeAlign.ts';
import { computeCertificate, CERT_RESIDUAL_EPS, type BakeCertificate } from './bakeCertificate.ts';
import { resolveDriver, type ResolvedDriver } from './bakeDriver.ts';
import type { BakeProfile } from './bakeProfiles.ts';

export type BakeRuntime = Awaited<ReturnType<typeof createLive2DRuntime>>;

export type BakeProgress =
  | { phase: 'warmup'; cycle: number; maxCycles: number; residual: number }
  | { phase: 'capture'; frame: number; total: number; align?: boolean }
  | { phase: 'mouth'; step: string };

export type BakeMouthSuite = {
  region: ExportRegion;
  /** 张口 0/0.25/0.5/0.75/1 五档，region 尺寸裁剪 */
  levels: HTMLCanvasElement[];
  /** 每 idle 帧的嘴部平移锚点 [dx,dy]（固件把口型贴图按帧偏移叠加=跟头动） */
  anchors: Array<[number, number]>;
  /** 锚点匹配最差残差（诊断） */
  worstResidual: number;
};

export type BakeResult = {
  frames: HTMLCanvasElement[];
  fps: number;
  periodS: number;
  startIdx: number;
  frameMads: number[];
  certificate: BakeCertificate;
  /** 采集窗对齐偏移（帧）：0=侦察窗边界即速度谷；>0=第二窗从该相位起采（诊断用） */
  alignPhaseFrames: number;
  /** 口型套件（profile.mouth 开启且采集成功时给出；失败=undefined+warnings 里说原因） */
  mouth?: BakeMouthSuite;
};

const SUB_MS = 1000 / 60;   // 物理子步 = 60fps 网格（魔力卡 M6/M8 实证该 dt 下 T=8s 必收敛；
                            // 100ms 帧恰好 6 子步整除。旧 25ms 只是防振荡上限，非最优）
const MIN_CYCLES = 4;
const MAX_CYCLES = 60;

type InternalEvents = {
  on?: (event: string, fn: () => void) => void;
  off?: (event: string, fn: () => void) => void;
  updateNaturalMovements?: (dt: number, now: number) => void;
  eyeBlink?: unknown;
  physics?: {
    initialize?: () => void;
    _physicsRig?: { particles?: Array<{ position?: { x: number; y: number }; lastPosition?: { x: number; y: number }; velocity?: { x: number; y: number } }> };
  };
  motionManager?: { stopAllMotions?: () => void };
};

type CoreModelLike = { setParameterValueById: (id: string, value: number) => void };

const yieldMacrotask = () => new Promise<void>((resolve) => {
  // MessageChannel：后台标签页 setTimeout 被钳到 1s+，长窗口给看门狗复活 ticker 的机会
  const mc = new MessageChannel();
  mc.port1.onmessage = () => resolve();
  mc.port2.postMessage(0);
});

/** 同一 runtime 的烘焙互斥：并发烘焙会双挂 afterMotionUpdate 钩子（旧钩子以冻结 tSec 写
 * 常量盖掉新驱动 → 姿势恒定 → 物理秒收敛到不动点 → 全零假证书；dev 热刷新叠加态实测）。 */
const bakingLock = new WeakSet<object>();

export async function bakeIdle(
  runtime: BakeRuntime,
  profile: BakeProfile,
  onProgress?: (p: BakeProgress) => void,
): Promise<BakeResult> {
  if (bakingLock.has(runtime)) throw new Error('该模型已有烘焙进行中（并发烘焙会互相污染）');
  bakingLock.add(runtime);
  try {
    return await bakeIdleInner(runtime, profile, onProgress);
  } finally {
    bakingLock.delete(runtime);
  }
}

async function bakeIdleInner(
  runtime: BakeRuntime,
  profile: BakeProfile,
  onProgress?: (p: BakeProgress) => void,
): Promise<BakeResult> {
  const driver: ResolvedDriver = await resolveDriver(profile.driver);
  const fps = profile.fps;
  const stepMs = 1000 / fps;
  const n = Math.round(fps * driver.periodS);
  if (Math.abs(n / fps - driver.periodS) > 1e-9) {
    throw new Error(`fps=${fps} 与周期 ${driver.periodS}s 不整除（帧数须为整数）`);
  }

  const internal = runtime.model.internalModel as unknown as InternalEvents;
  const core = runtime.model.internalModel.coreModel as unknown as CoreModelLike;
  const renderer = runtime.app.renderer as PIXI.Renderer;

  let tSec = 0;
  const writeCurves = () => {
    for (const [id, value] of driver.evalParams(tSec)) {
      try { core.setParameterValueById(id, value); } catch { /* 未知参数 id：忽略 */ }
    }
  };
  // 眼 + pins 走库自有的 beforeModelUpdate 位（注册晚于页面钩子=同帧后写生效）
  const writeFinal = () => {
    for (const [id, value] of profile.pins ?? []) {
      try { core.setParameterValueById(id, value); } catch { /* ignore */ }
    }
    for (const [id, value] of driver.evalEyes(tSec)) {
      try { core.setParameterValueById(id, value); } catch { /* ignore */ }
    }
  };

  const advanceModelTime = (ms: number) => {
    runtime.model.update(ms);
    const rt = PIXI.RenderTexture.create({ width: 4, height: 4, resolution: 1 });
    renderer.render(runtime.app.stage, { renderTexture: rt });
    rt.destroy(true);
  };
  /** 推进一帧到 frameEndSec：物理拆 ≤SUB_MS 子步，且**驱动按子步时刻求值**。
   * 低 fps 时按帧求值=粗阶梯输入（10fps=100ms 棱），阶梯棱持续激励摆链 → 残差有地板
   * 收敛不了（面板 e2e 实测 18 圈 2.39）；子步求值让输入平滑度与采集 fps 解耦。 */
  const advanceSubstepped = (frameEndSec: number, ms: number) => {
    const k = Math.max(1, Math.ceil(ms / SUB_MS));
    for (let s = 1; s <= k; s += 1) {
      tSec = frameEndSec - (ms / 1000) * (1 - s / k);   // 子步末时刻（周期性不受影响）
      advanceModelTime(ms / k);
    }
    tSec = frameEndSec;
  };
  const captureFrame = (): HTMLCanvasElement => {
    runtime.model.update(0);   // 纯渲染：dt=0 时库跳过 internalModel.update（地雷②）
    const { w, h, stageScale, stageOffsetX, stageOffsetY = 0 } = profile.view;
    const rt = PIXI.RenderTexture.create({ width: w, height: h, resolution: 1 });
    renderer.render(runtime.app.stage, {
      renderTexture: rt,
      transform: new PIXI.Matrix(stageScale, 0, 0, stageScale, stageOffsetX, stageOffsetY),
    });
    const canvas = (renderer.plugins.extract as PIXI.Extract).canvas(rt);
    rt.destroy(true);
    return canvas;
  };
  const feedWatchdog = () => {
    (runtime as unknown as { lastTickAt: number }).lastTickAt = performance.now();
  };
  // 按时间让出主线程（>800ms 同步块就 yield）：预热一圈在低 fps 档是 2-16s 纯同步——
  // 预览无响应看门狗会重载页面，真机上就是 Android ANR（5s 阈值）杀 WebView。
  // yield 后必须重停 ticker（引擎渲染看门狗可能趁 yield 复活它，地雷④）。
  let lastYieldAt = performance.now();
  const yieldIfDue = async () => {
    if (performance.now() - lastYieldAt < 800) return;
    feedWatchdog();
    await yieldMacrotask();
    feedWatchdog();
    if (runtime.app.ticker.started) runtime.app.ticker.stop();
    lastYieldAt = performance.now();
  };

  // —— 干扰源 patch（finally 全量恢复）——
  internal.on?.('afterMotionUpdate', writeCurves);
  internal.on?.('beforeModelUpdate', writeFinal);
  const savedNat = internal.updateNaturalMovements;
  const savedBlink = internal.eyeBlink;
  internal.updateNaturalMovements = () => {};
  internal.eyeBlink = undefined;
  const rtState = runtime as unknown as { idleMotionKey?: string | null; idleBeatEnabled?: boolean };
  const savedIdleKey = rtState.idleMotionKey;
  const savedBeats = rtState.idleBeatEnabled;
  rtState.idleMotionKey = null;
  rtState.idleBeatEnabled = false;
  try { internal.motionManager?.stopAllMotions?.(); } catch { /* ignore */ }
  runtime.app.ticker.stop();

  try {
    // 规范化物理初始状态（地雷③）
    try { internal.physics?.initialize?.(); } catch { /* 无物理链模型 */ }
    const particles = internal.physics?._physicsRig?.particles ?? [];
    const snapParticles = () => {
      const arr = new Float32Array(particles.length * 6);
      for (let i = 0; i < particles.length; i += 1) {
        const p = particles[i];
        arr[i * 6] = p.position?.x ?? 0; arr[i * 6 + 1] = p.position?.y ?? 0;
        arr[i * 6 + 2] = p.lastPosition?.x ?? 0; arr[i * 6 + 3] = p.lastPosition?.y ?? 0;
        arr[i * 6 + 4] = p.velocity?.x ?? 0; arr[i * 6 + 5] = p.velocity?.y ?? 0;
      }
      return arr;
    };

    // —— 自适应预热（残差=接缝误差；k=2,3 亚谐波检测）——
    let warmupCycles = 0;
    let warmupResidual = particles.length ? Number.POSITIVE_INFINITY : 0;   // 无物理链：视为即时收敛
    let subharmonic = 0;
    const hist: Float32Array[] = [];
    // 预热圈数上限可按档位收紧（组件档 6 圈封顶：小卡慢摆不需证书级无缝，手机上 60 圈=数分钟）
    const maxWarmup = profile.warmupMaxCycles ?? MAX_CYCLES;
    for (let c = 1; c <= maxWarmup && particles.length; c += 1) {
      for (let i = 0; i < n; i += 1) {
        advanceSubstepped((i + 1) * (stepMs / 1000), stepMs);
        if (i % 8 === 7) await yieldIfDue();
      }
      const vals = snapParticles();
      const resK: Array<{ k: number; r: number }> = [];
      for (let k = 1; k <= Math.min(3, hist.length); k += 1) {
        const ref = hist[hist.length - k];
        let r = 0;
        for (let i = 0; i < vals.length; i += 1) r = Math.max(r, Math.abs(vals[i] - ref[i]));
        resK.push({ k, r });
      }
      warmupCycles = c;
      const res1 = resK.find((e) => e.k === 1);
      if (res1) {
        warmupResidual = vals.length >= 6 ? res1.r : Number.POSITIVE_INFINITY;
        onProgress?.({ phase: 'warmup', cycle: c, maxCycles: maxWarmup, residual: warmupResidual });
      }
      hist.push(vals);
      if (hist.length > 3) hist.shift();
      feedWatchdog();
      await yieldMacrotask();
      feedWatchdog();
      if (runtime.app.ticker.started) runtime.app.ticker.stop();   // 看门狗复活兜底（地雷④）
      lastYieldAt = performance.now();
      if (warmupCycles >= MIN_CYCLES) {
        if (warmupResidual < CERT_RESIDUAL_EPS) break;
        const sub = resK.find((e) => e.k > 1 && e.r < CERT_RESIDUAL_EPS);
        if (sub) { subharmonic = sub.k; break; }
      }
    }

    // —— 采集：侦察窗定谷 → 对齐窗出货 ——
    // 窗边界=残差 δ 的落点=证书回卷对。预热出口相位对内容活动量是任意的（双生 idle 的
    // 动段尾恰压边界，回卷/中位基线 1.26 贴 1.3 门=「总不过关」根因），极限环上窗起点
    // 本是自由参数：先采一窗测环形 MAD 谷，谷≠0 就推进到谷相位重采（物理只前进不倒带，
    // 未收敛平台下谷相位由周期驱动的内容主导，仍有效）。δ 仍落在窗边界被如实判决，不藏缝。
    const rgbaOf = (f: HTMLCanvasElement) => {
      const ctx = f.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error('无法读取帧像素');
      return ctx.getImageData(0, 0, f.width, f.height).data;
    };
    const captureWindow = async (baseAbs: number, align: boolean): Promise<HTMLCanvasElement[]> => {
      // 前置：物理已推进到绝对帧 baseAbs（首帧零推进纯抓，地雷②）
      const out: HTMLCanvasElement[] = [];
      for (let i = 0; i < n; i += 1) {
        const abs = baseAbs + i;
        tSec = abs / fps;
        if (i > 0) advanceSubstepped(abs / fps, stepMs);
        out.push(captureFrame());
        if (i % 20 === 19) onProgress?.({ phase: 'capture', frame: i + 1, total: n, align });
        if (i % 8 === 7) await yieldIfDue();
      }
      onProgress?.({ phase: 'capture', frame: n, total: n, align });
      return out;
    };

    /* 环形相邻 MAD（与 exportUtils.adjacentLoopMads 同口径）流式版：逐帧提取 rgba 即算即弃，
     * 峰值内存 ~3 帧像素（vs 整窗数组 160帧≈139MB——20fps 档实测把浏览器标签页 OOM 打崩）。 */
    const madsOfStreaming = async (fs: HTMLCanvasElement[]): Promise<number[]> => {
      const first = rgbaOf(fs[0]);
      let prev = first;
      const out = new Array<number>(fs.length);
      for (let i = 1; i < fs.length; i += 1) {
        const cur = rgbaOf(fs[i]);
        let sum = 0;
        for (let p = 0; p < cur.length; p += 1) sum += Math.abs(cur[p] - prev[p]);
        out[i] = sum / cur.length;
        prev = cur;
        if (i % 8 === 7) await yieldIfDue();
      }
      let sum = 0;
      for (let p = 0; p < first.length; p += 1) sum += Math.abs(first[p] - prev[p]);
      out[0] = sum / first.length;   // 回卷对（末帧→帧0）
      return out;
    };
    /** 释放画布背份纹理（width=0 立即归还光栅内存，等 GC 在 160 帧档来不及） */
    const freeFrames = (fs: HTMLCanvasElement[]) => { for (const f of fs) { f.width = 0; f.height = 0; } };

    let frames = await captureWindow(0, false);
    let mads = await madsOfStreaming(frames);
    const valley = mads.indexOf(Math.min(...mads));
    const alignPhaseFrames = valley;
    if (valley !== 0) {
      const { startAbs } = planAlignedWindow(n, valley);
      freeFrames(frames);   // 侦察窗画布即时释放（重采期间不叠两窗内存）
      frames = [];
      onProgress?.({ phase: 'capture', frame: 0, total: n, align: true });
      for (let abs = n; abs <= startAbs; abs += 1) {   // 从侦察窗末帧 n-1 推进到 startAbs
        advanceSubstepped(abs / fps, stepMs);
        if ((abs - n) % 8 === 7) await yieldIfDue();
      }
      frames = await captureWindow(startAbs, true);
      mads = await madsOfStreaming(frames);
    }

    // —— 口型套件（可选；仍在 patch 上下文内：驱动钉相位0、ticker 停、干扰源全关）——
    // A1 方案素材面：嘴部 region + 5 档张口贴图 + 每 idle 帧锚点（固件把口型贴图按帧偏移
    // 叠加到 idle 身体帧上=嘴跟头动）。失败不致命：降级为无口型 abp + warnings 说人话。
    let mouth: BakeMouthSuite | undefined;
    const mouthWarnings: string[] = [];
    if (profile.mouth?.enabled) {
      onProgress?.({ phase: 'mouth', step: '定位嘴部区域' });
      tSec = alignPhaseFrames / fps;   // 驱动钉采集窗首帧相位（与 idle 帧 0 同基线姿态）
      const ids = getRuntimeParameterSnapshot(runtime).map((item) => item.id);
      const mouthIds = ids.filter((id) => /mouth/i.test(id));
      const mainMouth = mouthIds.find((id) => /open/i.test(id)) ?? mouthIds[0];
      if (!mainMouth) {
        mouthWarnings.push('未发现嘴参数（id 含 mouth 的全无），口型套件跳过');
      } else {
        // 库自有嘴部 burst 位（注册最晚=同帧最后写生效）；其余嘴参钉 0 隔离干扰
        const mouthMap = new Map<string, number>();
        for (const id of mouthIds) if (id !== mainMouth) mouthMap.set(id, 0);
        const writeMouth = () => {
          for (const [id, value] of mouthMap) {
            try { core.setParameterValueById(id, value); } catch { /* ignore */ }
          }
        };
        internal.on?.('beforeModelUpdate', writeMouth);
        try {
          // 每次改嘴后推进一个物理子步消费参数（不用微 dt——地雷②的数值踢腿）
          const grab = () => {
            advanceModelTime(SUB_MS);
            return captureFrame();
          };
          const setMouth = (v: number) => { mouthMap.set(mainMouth, v); };
          setMouth(0); const closedA = grab();
          setMouth(1); const openedA = grab();
          setMouth(0); const closedB = grab();
          setMouth(1); const openedB = grab();
          const bbox = intersectRegions(
            diffBoundingBox(closedA, openedA, 8),
            diffBoundingBox(closedB, openedB, 8),
          );
          if (!bbox) {
            mouthWarnings.push(`嘴参数 ${mainMouth} 0→1 无像素变化，口型套件跳过（模型可能用非标嘴参）`);
          } else {
            onProgress?.({ phase: 'mouth', step: '采集口型档位' });
            const crop = (full: HTMLCanvasElement): HTMLCanvasElement => {
              const c = document.createElement('canvas');
              c.width = bbox.w;
              c.height = bbox.h;
              c.getContext('2d')?.drawImage(full, bbox.x, bbox.y, bbox.w, bbox.h, 0, 0, bbox.w, bbox.h);
              return c;
            };
            const levels: HTMLCanvasElement[] = [];
            for (const v of [0, 0.25, 0.5, 0.75, 1]) {
              setMouth(v);
              levels.push(crop(grab()));
            }
            // 锚点：基线=嘴0相位0全帧，模板=嘴部 region；每 idle 帧模板匹配求平移
            onProgress?.({ phase: 'mouth', step: '计算逐帧锚点' });
            setMouth(0);
            const baselineFull = grab();
            const rgba = (c: HTMLCanvasElement) => {
              const ctx = c.getContext('2d', { willReadFrequently: true });
              if (!ctx) throw new Error('无法读取帧像素');
              return ctx.getImageData(0, 0, c.width, c.height).data;
            };
            const base = rgba(baselineFull);
            const anchors: Array<[number, number]> = [];
            let worst = 0;
            for (const f of frames) {
              const m = findMouthAnchor(base, rgba(f), f.width, bbox, 12, 8);
              anchors.push([m.dx, m.dy]);
              if (m.residual > worst) worst = m.residual;
              await yieldIfDue();
            }
            const ANCHOR_TOL = 18;   // 平移模板匹配吃不掉头转的旋转分量（F2 真机「不贴」同源，Ben 已接受该先天限制）；18≈观感可用上限
            if (worst > ANCHOR_TOL) {
              mouthWarnings.push(`口型锚点匹配最差残差 ${worst.toFixed(1)} > ${ANCHOR_TOL}（身体动作使嘴部模板不可靠），口型套件已降级跳过`);
            } else {
              mouth = { region: bbox, levels, anchors, worstResidual: worst };
            }
          }
        } finally {
          internal.off?.('beforeModelUpdate', writeMouth);
        }
      }
    }

    // —— 证书（判决最终窗；mads 已由流式计算给出）——
    const frameMads = mads.map((m) => Math.round(m * 100) / 100);
    const startIdx = mads.indexOf(Math.min(...mads));   // 速度谷起播下标（对齐后通常=0）
    const certificate = computeCertificate(frameMads, {
      cycles: warmupCycles, residual: warmupResidual, subharmonic,
    });
    certificate.warnings.push(...mouthWarnings);
    return { frames, fps, periodS: driver.periodS, startIdx, frameMads, certificate, alignPhaseFrames, mouth };
  } finally {
    internal.off?.('afterMotionUpdate', writeCurves);
    internal.off?.('beforeModelUpdate', writeFinal);
    internal.updateNaturalMovements = savedNat;
    internal.eyeBlink = savedBlink;
    rtState.idleMotionKey = savedIdleKey;
    rtState.idleBeatEnabled = savedBeats;
    if (!runtime.app.ticker.started) runtime.app.ticker.start();
  }
}
