/* 吧唧素材工坊 v2：手风琴四步（选角 → 搭配 → 烘焙 → 投放）+ 圆屏常驻实时预览。
 * spec: docs/superpowers/specs/2026-07-07-badge-app-bake-preview-design.md
 * UI 方向（Ben 2026-07-08 拍板）：
 * ① 图形化——选角用引擎现渲头像（badgeThumbs 缓存），动作候选配中段姿态截图+观感化命名；
 * ② 流程反转=先预览后烘焙——烘焙 runtime 直接摆进圆屏 live 播所选组合（动作/换装/背景），
 *    所见即所烤；烤完圆屏切成品帧回放，改任何配置立刻作废旧成品回到 live（不开盲盒）；
 * ③ 手风琴——完成一模块收起一模块（头部留已选摘要），点头部随时回溯，页面不跳转。
 *
 * ⚠空帧守卫（2026-07-08 四轮双生实锤）：标签页长时间完全后台且无任何外部活动（或真机
 * 熄屏/切应用）时，Chrome 会静默停掉该页 GPU 光栅化——GL 绘制/readPixels 变 no-op，
 * 无 contextlost 事件；短暂后台或有活动保活则无碍（R5 实测烤中第 2 分钟采集正常、
 * 第 8 分钟采集全空=中途死）。落在采集窗=80 帧全透明 → 合成后全同 → 0.00≤0.00 退化
 * 过门（假证书）；物理是纯计算不受影响（四轮残差逐位一致 0.501，证书其余数字全对，
 * 极具欺骗性）。防线在本文件（UI 层）：帧 alpha 覆盖率硬门 + 全静止硬门，拒收假成品
 * 并用人话提示重烤。预热阶段无像素依赖，后台无害不拦。
 *
 * v1 边界不变：吧唧档固定配方（BADGE_PROFILE_BASE，零调参）；证书不过=禁投放。
 * 烘焙机制在 src/features/badgeBake/（本文件只做 UI/流程层，不动机制）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { avatarList } from '../features/live2d/avatarData.ts';
import { resolveAvatarManifestById } from '../features/live2d/avatarManifest.ts';
import {
  applyExpressionMix,
  createLive2DRuntime,
  destroyRuntime,
  getRuntimeParameterSnapshot,
  setCostumeParamOverrides,
} from '../features/live2d/live2dEngine.ts';
import { djModelFor } from '../features/live2d/djModels.ts';
import type { AvatarExpression, AvatarManifest } from '../features/live2d/types.ts';
import type { BakeResult, BakeRuntime } from '../features/badgeBake/bakeIdle.ts';
import { bakeWithinBudget } from '../features/badgeBake/bakeBudget.ts';
import { ABP_SHIP_BUDGET_KB } from '../features/badgeBake/bakeBudgetPlan.ts';
import { BADGE_PROFILE_BASE } from '../features/badgeBake/bakeProfiles.ts';
import type { BakeDriverConfig } from '../features/badgeBake/bakeProfiles.ts';
import type { AbpPackResult } from '../features/badgeBake/abpPack.ts';
import { uploadBadgeAsset } from '../lib/badgeAssetUpload.ts';
import { BadgeDevicePanel } from './BadgeDevicePanel.tsx';
import { macToDeviceId } from '../lib/badgeBle.ts';
import {
  buildMotionDriver,
  EXPRESSION_NAMES,
  MOTION_NAMES,
  probeLoopMotions,
  resolveExpressionPins,
  type LoopMotionOption,
} from './badgeCatalog.ts';
import {
  capturePortraitFromRuntime,
  generatePortrait,
  getCachedPortrait,
  snapshotMotionThumbs,
  snapshotPinThumbs,
  snapshotWobbleThumb,
} from './badgeThumbs.ts';
import './badgePanel.css';

type Phase = 'pick' | 'loading' | 'ready' | 'baking';
type Step = 'pick' | 'style' | 'bake' | 'deploy';
type UploadState = 'idle' | 'packing' | 'uploading' | 'uploaded' | 'failed';

/** 出货三件套：烘焙结果 + 已打包 abp（预算实测=投放字节，不重打包）+ 预载/档位。 */
type ShippedBake = { baked: BakeResult; abp: AbpPackResult; sizeKb: number; rungKey: string; rungLabel: string };

const WOBBLE = 'wobble';

type MotionCard = { choice: string; name: string; hint: string };

/** 动作观感化命名：已知 key 查 badgeCatalog 表，未知按时长给气质名，重名加序号；
 * 秒数降级为卡片副标题（用户不认识「idle（8s 动画）」，认「轻柔摇曳」）。 */
function buildMotionCards(options: LoopMotionOption[]): MotionCard[] {
  const used = new Map<string, number>();
  const cards: MotionCard[] = options.map((opt) => {
    let name = MOTION_NAMES[opt.key.toLowerCase()]
      ?? (opt.durationS >= 6 ? '舒缓摇曳' : '轻快灵动');
    const n = (used.get(name) ?? 0) + 1;
    used.set(name, n);
    if (n > 1) name = `${name} ${'②③④⑤'[n - 2] ?? n}`;
    return { choice: opt.url, name, hint: `${Math.round(opt.durationS)} 秒循环` };
  });
  cards.push({ choice: WOBBLE, name: '安静呼吸', hint: '轻微起伏 + 自然眨眼' });
  return cards;
}

/** 空帧守卫的采样：帧 alpha 覆盖率（每 8 像素采样，466² 足够置信）。 */
function frameOpaqueFraction(frame: HTMLCanvasElement): number {
  const ctx = frame.getContext('2d', { willReadFrequently: true });
  if (!ctx) return 0;
  const d = ctx.getImageData(0, 0, frame.width, frame.height).data;
  const step = 8;
  let opaque = 0;
  let total = 0;
  for (let i = 3; i < d.length; i += 4 * step) {
    total += 1;
    if (d[i] > 10) opaque += 1;
  }
  return total ? opaque / total : 0;
}

/** 手风琴模块：头部=序号/标题/收起态摘要，点头部展开回溯；body 常挂载（0fr/1fr 动画）。 */
function Module(props: {
  index: number;
  title: string;
  locked: boolean;
  lockedHint?: string;
  done: boolean;
  open: boolean;
  summary: ReactNode;
  onToggle: () => void;
  children: ReactNode;
}) {
  const { index, title, locked, lockedHint, done, open, summary, onToggle, children } = props;
  return (
    <section className={`bp-mod ${open ? 'is-open' : ''} ${locked ? 'is-locked' : ''}`}>
      <button type="button" className="bp-mod__head" onClick={onToggle} disabled={locked}>
        <span className={`bp-mod__num ${done ? 'is-done' : ''}`}>{done ? '✓' : index}</span>
        <span className="bp-mod__title">{title}</span>
        <span className="bp-mod__summary">{locked ? (lockedHint ?? '') : (!open ? summary : '')}</span>
        <span className="bp-mod__chev">{open ? '▾' : '▸'}</span>
      </button>
      <div className="bp-mod__body-wrap">
        <div className="bp-mod__body">{children}</div>
      </div>
    </section>
  );
}

export function BadgePanel({ onClose }: { onClose: () => void }) {
  const [avatarId, setAvatarId] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>('pick');
  const [openStep, setOpenStep] = useState<Step | 'none'>('pick');
  const [progressText, setProgressText] = useState('');
  const [result, setResult] = useState<ShippedBake | null>(null);
  const [uploadState, setUploadState] = useState<UploadState>('idle');
  const [uploadInfo, setUploadInfo] = useState('');
  const [connectedMac, setConnectedMac] = useState<string | null>(null);
  // 搭配区（动作/表情配饰/换装/背景/口型）
  const [motionOptions, setMotionOptions] = useState<LoopMotionOption[]>([]);
  const [driverChoice, setDriverChoice] = useState<string>(WOBBLE);
  const [avatarExpressions, setAvatarExpressions] = useState<AvatarExpression[]>([]);
  const [exprSel, setExprSel] = useState<string[]>([]);
  const [exprThumbs, setExprThumbs] = useState<Record<string, string>>({});
  // 目录完备信号：动作/表情候选全部就位才 true——缩略图批量与烘焙都等它（目录探测要
  // 拉 20+ 个文件，比 ready 慢；不等它会抓半截目录/烤到默认兜底动作）
  const [catalogReady, setCatalogReady] = useState(false);
  const [costumeOn, setCostumeOn] = useState(true);
  const [bgOn, setBgOn] = useState(true);
  const [bgAvailable, setBgAvailable] = useState(false);
  const [mouthOn, setMouthOn] = useState(true);
  // 图形化素材
  const [portraits, setPortraits] = useState<Record<string, string>>(() => {
    const cached: Record<string, string> = {};
    for (const a of avatarList) {
      const url = getCachedPortrait(a.id);
      if (url) cached[a.id] = url;
    }
    return cached;
  });
  const [motionThumbs, setMotionThumbs] = useState<Record<string, string>>({});
  // 缩略图生成中=true：抓图会挂钩子/停启 ticker，与烘焙同 runtime 互斥（撞上=烤程被污染）
  const [thumbsBusy, setThumbsBusy] = useState(false);

  const stageRef = useRef<HTMLDivElement | null>(null);
  const runtimeRef = useRef<BakeRuntime | null>(null);
  const manifestRef = useRef<AvatarManifest | null>(null);
  const previewRef = useRef<HTMLCanvasElement | null>(null);
  const bgRef = useRef<HTMLImageElement | null>(null);
  const phaseRef = useRef<Phase>('pick');
  phaseRef.current = phase;
  const avatarIdRef = useRef<string | null>(null);
  avatarIdRef.current = avatarId;

  const teardownRuntime = useCallback(() => {
    if (runtimeRef.current) {
      try { destroyRuntime(runtimeRef.current); } catch { /* WebGL 已丢失等：忽略 */ }
      runtimeRef.current = null;
    }
  }, []);

  /** 任何配置变更 → 旧成品作废回 live 预览（预览=真相，绝不让圆屏播过期成品）。 */
  const invalidateBake = useCallback(() => {
    setResult(null);
    setUploadState('idle');
    setUploadInfo('');
    setProgressText('');
  }, []);

  // 选角色 → 圆屏里建烘焙 runtime（一个 WebGL 上下文一个模型，换角色先销毁）。
  // runtime 同时就是实时预览：canvas 直接可见，ticker 日常渲染=引擎原生观感。
  useEffect(() => {
    if (!avatarId) return;
    let cancelled = false;
    setPhase('loading');
    invalidateBake();
    void (async () => {
      teardownRuntime();
      try {
        const manifest = await resolveAvatarManifestById(avatarId);
        if (cancelled) return;
        const container = stageRef.current;
        if (!container) throw new Error('舞台容器未就绪');
        const runtime = await createLive2DRuntime(container, manifest);
        if (cancelled) { destroyRuntime(runtime); return; }
        // 预览保真：关掉随机待机小动作（烘焙不含它们，预览也不该演）
        (runtime as unknown as { idleBeatEnabled: boolean }).idleBeatEnabled = false;
        runtimeRef.current = runtime;
        setPhase('ready');
        // 顺手抓头像（免为头像重复加载大模型）；等 600ms 让首个待机循环淡入
        window.setTimeout(() => {
          if (cancelled || runtimeRef.current !== runtime) return;
          try {
            const url = capturePortraitFromRuntime(runtime, avatarId);
            if (url) setPortraits((p) => (p[avatarId] ? p : { ...p, [avatarId]: url }));
          } catch { /* 抓图失败：保持占位 */ }
        }, 600);
      } catch (error) {
        if (!cancelled) {
          setPhase('pick');
          setProgressText(`模型加载失败：${error instanceof Error ? error.message : String(error)}`);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [avatarId, teardownRuntime, invalidateBake]);

  useEffect(() => () => teardownRuntime(), [teardownRuntime]);

  // 后台补齐其余角色头像（缓存未命中才现渲；面板忙时让路；当前选中角色由就绪回调顺手抓）
  useEffect(() => {
    let dead = false;
    void (async () => {
      for (const a of avatarList) {
        if (dead) return;
        if (getCachedPortrait(a.id)) continue;
        if (a.id === avatarIdRef.current && runtimeRef.current) continue;
        while (!dead && (phaseRef.current === 'loading' || phaseRef.current === 'baking')) {
          await new Promise((r) => { setTimeout(r, 800); });
        }
        if (dead) return;
        try {
          const url = await generatePortrait(a.id);
          if (!dead && url) setPortraits((p) => (p[a.id] ? p : { ...p, [a.id]: url }));
        } catch { /* 单个角色失败：保持首字母占位 */ }
      }
    })();
    return () => { dead = true; };
  }, []);

  // 吧唧背景：内置素材 public/badge-backgrounds/<avatarId>.png（物理吧唧成品就是带背景
  // 合成的）。没有该角色背景 → 黑底（圆形 AMOLED 外圈即黑）。
  useEffect(() => {
    bgRef.current = null;
    setBgAvailable(false);
    if (!avatarId) return;
    const img = new Image();
    img.onload = () => { bgRef.current = img; setBgAvailable(true); };
    img.onerror = () => { bgRef.current = null; setBgAvailable(false); };
    img.src = `/badge-backgrounds/${avatarId}.png`;
  }, [avatarId]);

  // 搭配目录：枚举模型自己带的全部内容——loop 闭合动作（manifest∪model3，含网格重映射
  // 候选）+ 全量表情/配饰（发型/耳朵/道具…直接读 manifest.expressions）。Ben 验收拍板：
  // 别只挑名字带 idle 的，模型有什么就上什么。
  useEffect(() => {
    setMotionOptions([]);
    setMotionThumbs({});
    setDriverChoice(WOBBLE);
    setAvatarExpressions([]);
    setExprSel([]);
    setExprThumbs({});
    setCatalogReady(false);
    manifestRef.current = null;
    if (!avatarId) return;
    let cancelled = false;
    void (async () => {
      try {
        const manifest = await resolveAvatarManifestById(avatarId);
        if (cancelled) return;
        manifestRef.current = manifest;
        const options = await probeLoopMotions(manifest, BADGE_PROFILE_BASE.fps);
        if (cancelled) return;
        // 目录一次性就位（分批 set 会让缩略图批量抓到半截目录——竞态实测）
        setAvatarExpressions(manifest.expressions ?? []);
        setMotionOptions(options);
        const idle = options.find((o) => /idle/i.test(o.key)) ?? options[0];
        if (idle) setDriverChoice(idle.url);
      } catch { /* 探测失败 → 保持安静呼吸兜底 */ } finally {
        if (!cancelled) setCatalogReady(true);
      }
    })();
    return () => { cancelled = true; };
  }, [avatarId]);

  // 动作截图：runtime 就绪 + 候选就绪 → 先抓「安静呼吸」的自然姿态（未被动作参数污染），
  // 再批量抓各候选动作中段姿态（<200ms，live 只闪一下）。只在空表时抓一轮。
  // thumbsBusy 期间烘焙按钮禁用：抓图挂 afterMotionUpdate 钩子+停启 ticker，若撞进烤程
  // = v1「双挂钩子假证书」同类污染（e2e 实测烤程收敛行为被带偏）。
  useEffect(() => {
    const runtime = runtimeRef.current;
    if (phase !== 'ready' || !runtime || !catalogReady) return;
    if (Object.keys(motionThumbs).length > 0) return;
    let cancelled = false;
    setThumbsBusy(true);
    void (async () => {
      try {
        // 全部收集完再一次性 set：中途 setMotionThumbs 会改到本 effect 的依赖 →
        // cleanup 置 cancelled → 表情段被自己触发的重跑掐死（实测 0/13 的死因）
        const wobbleThumb = snapshotWobbleThumb(runtime);
        const thumbs = await snapshotMotionThumbs(runtime, motionOptions);
        if (wobbleThumb) thumbs[WOBBLE] = wobbleThumb;
        let exprThumbMap: Record<string, string> = {};
        if (avatarExpressions.length) {
          const baseline = new Map(getRuntimeParameterSnapshot(runtime)
            .map((p) => [p.id, p.defaultValue ?? p.currentValue ?? 0] as [string, number]));
          const pinSets: Array<{ id: string; pins: Array<[string, number]> }> = [];
          for (const expr of avatarExpressions) {
            if (cancelled) return;
            try {
              pinSets.push({ id: expr.id, pins: await resolveExpressionPins(baseline, avatarExpressions, [expr.id]) });
            } catch { /* 单个表情解析失败：无卡图 */ }
          }
          if (cancelled || runtimeRef.current !== runtime) return;
          exprThumbMap = snapshotPinThumbs(runtime, pinSets);
        }
        if (cancelled || runtimeRef.current !== runtime) return;
        if (Object.keys(thumbs).length) setMotionThumbs(thumbs);
        if (Object.keys(exprThumbMap).length) setExprThumbs(exprThumbMap);
      } catch { /* 抓图失败：卡片用文字占位 */ } finally {
        if (!cancelled) setThumbsBusy(false);
      }
    })();
    return () => { cancelled = true; setThumbsBusy(false); };
  }, [phase, catalogReady, motionOptions, motionThumbs, avatarExpressions]);

  // 实时预览·动作：切换所选待机动作 = 换 runtime 的 idle 循环源。
  // stopAllMotions 后引擎 ensureIdle 看门狗 ≤600ms 内按新 key 无缝续播；
  // 安静呼吸 = 无动作（idleMotionKey=null），剩下库自然摆动层 = Tier B 烘焙的同源观感。
  useEffect(() => {
    const runtime = runtimeRef.current;
    if (phase !== 'ready' || !runtime) return;
    const rtState = runtime as unknown as { idleMotionKey: string | null };
    const mm = (runtime.model.internalModel as unknown as { motionManager?: { stopAllMotions?: () => void } }).motionManager;
    rtState.idleMotionKey = driverChoice === WOBBLE
      ? null
      : motionOptions.find((o) => o.url === driverChoice)?.key ?? null;
    try { mm?.stopAllMotions?.(); } catch { /* ignore */ }
  }, [phase, driverChoice, motionOptions]);

  // 实时预览·换装：costumeParamOverrides 每帧硬写（与 DjMode 同机制），与烘焙 pins 同源
  useEffect(() => {
    const runtime = runtimeRef.current;
    if (phase !== 'ready' || !runtime || !avatarId) return;
    const costume = djModelFor(avatarId)?.costume ?? [];
    setCostumeParamOverrides(runtime, costumeOn ? costume : []);
  }, [phase, avatarId, costumeOn]);

  // 实时预览·表情/配饰：引擎表情层直接应用（live 走 overlay 平滑）；烘焙时 overlay
  // 不跑，同一份选择由 resolveExpressionPins 折算成 pins 穿透（两路语义一致）。
  useEffect(() => {
    const runtime = runtimeRef.current;
    const manifest = manifestRef.current;
    if (phase !== 'ready' || !runtime || !manifest) return;
    void applyExpressionMix(runtime, manifest, exprSel.map((key) => ({ key, weight: 1 })));
  }, [phase, exprSel]);

  // 成品回放：烤出的真实帧按 fps 循环画进圆屏 canvas
  useEffect(() => {
    if (!result) return;
    const canvas = previewRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const { frames, fps } = result.baked;
    let i = 0;
    const timer = window.setInterval(() => {
      const frame = frames[i % frames.length];
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
      i += 1;
    }, 1000 / fps);
    return () => window.clearInterval(timer);
  }, [result]);

  const handleBake = useCallback(async () => {
    const runtime = runtimeRef.current;
    if (!runtime || !avatarId || thumbsBusy || !catalogReady) return;
    setPhase('baking');
    setUploadState('idle');
    setUploadInfo('');
    setProgressText('准备烘焙…');
    // 空帧守卫·因果记录：采集/口型阶段页面必须可见（预热是纯计算，后台无害）
    let sawHiddenInCapture = document.visibilityState === 'hidden';
    let inCapturePhase = false;
    const onVis = () => {
      if (inCapturePhase && document.visibilityState === 'hidden') sawHiddenInCapture = true;
    };
    document.addEventListener('visibilitychange', onVis);
    try {
      // 搭配区落 profile：所选驱动（差网格动作由 buildMotionDriver 给 custom 重映射，
      // 呼吸钉半开静态两路都内置）+ 换装钉参 + 表情折算 pins + 口型开关——与 live 预览同源
      const chosen = motionOptions.find((o) => o.url === driverChoice);
      const driver: BakeDriverConfig = driverChoice === WOBBLE || !chosen
        ? { kind: 'wobble', periodS: 8 }
        : await buildMotionDriver(chosen);
      const costume = costumeOn ? (djModelFor(avatarId)?.costume ?? []) : [];
      const baseline = new Map(getRuntimeParameterSnapshot(runtime)
        .map((p) => [p.id, p.defaultValue ?? p.currentValue ?? 0] as [string, number]));
      const exprPins = await resolveExpressionPins(baseline, avatarExpressions, exprSel);
      // 背景合成（打包/回放共用同一份最终画面）；预算实测的就是投放的字节
      const bg = bgOn ? bgRef.current : null;
      const compositeBg = (frames: HTMLCanvasElement[]) => frames.map((frame) => {
        const c = document.createElement('canvas');
        c.width = frame.width;
        c.height = frame.height;
        const ctx = c.getContext('2d');
        if (!ctx) return frame;
        if (bg) ctx.drawImage(bg, 0, 0, c.width, c.height);
        else { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, c.width, c.height); }
        ctx.drawImage(frame, 0, 0);
        frame.width = 0; frame.height = 0;   // 源画布即时释放（160帧档等 GC=叠双份内存,OOM 教训）
        return c;
      });
      const outcome = await bakeWithinBudget({
        runtime,
        profile: {
          ...BADGE_PROFILE_BASE, driver,
          pins: [
            ...costume.map((c) => [c.id, c.value] as [string, number]),
            ...exprPins,
          ],
          mouth: { enabled: mouthOn },
        },
        characterId: avatarId,
        // —— 空帧/冻结硬门（拒收假成品；环境问题换档重烤无意义，整体中止）——
        validate: (baked) => {
          if (frameOpaqueFraction(baked.frames[0]) < 0.02) {
            return sawHiddenInCapture
              ? '❌ 烘焙时这页进了后台，画面没采到（采集需要页面保持可见）——回到这页保持亮着，点「重新烘焙」'
              : '❌ 采集到的画面是空的（渲染被系统暂停）——保持本页亮着可见，点「重新烘焙」再来一次';
          }
          if (baked.certificate.medianMad === 0 && baked.certificate.wrapMad === 0) {
            return '❌ 画面全程纹丝不动（渲染冻结），成品不可用——请点「重新烘焙」；若反复出现请重进本页';
          }
          return null;
        },
        finalize: compositeBg,
        onProgress: (p) => {
          if (p.phase === 'warmup') {
            setProgressText(`物理定型 第 ${p.cycle}/${p.maxCycles} 圈`);
          } else if (p.phase === 'capture') {
            inCapturePhase = true;
            if (document.visibilityState === 'hidden') sawHiddenInCapture = true;
            setProgressText(p.align
              ? `对齐接缝：重采 ${p.frame}/${p.total} 帧`
              : `定格画面 ${p.frame}/${p.total} 帧`);
          } else {
            inCapturePhase = true;
            if (document.visibilityState === 'hidden') sawHiddenInCapture = true;
            setProgressText(`口型贴图：${p.step}`);
          }
        },
        onBudget: (b) => {
          if (b.phase === 'overBudget') {
            setProgressText(`体积 ${(b.measuredKb / 1024).toFixed(1)}MB 超预算 ${Math.round(ABP_SHIP_BUDGET_KB / 1024)}MB${b.nextRungLabel ? `，自动换省预算档「${b.nextRungLabel}」重烤…` : ''}`);
          }
        },
      });
      if (outcome.kind === 'aborted') {
        setPhase('ready');
        setProgressText(outcome.reason);
        return;
      }
      if (outcome.kind === 'overBudget') {
        setPhase('ready');
        setProgressText(outcome.tier === 'A'
          ? `❌ 这个动作装不进吧唧（体积 ${(outcome.bestSizeKb / 1024).toFixed(1)}MB > 预算 ${Math.round(ABP_SHIP_BUDGET_KB / 1024)}MB）——换个更安静的动作试试`
          : `❌ 这个搭配装不进吧唧（最省档仍 ${(outcome.bestSizeKb / 1024).toFixed(1)}MB > ${Math.round(ABP_SHIP_BUDGET_KB / 1024)}MB）——试试去掉一个配饰，或换纯黑背景`);
        return;
      }
      setResult({
        baked: outcome.baked, abp: outcome.abp, sizeKb: outcome.sizeKb,
        rungKey: outcome.rung.key, rungLabel: outcome.rung.label,
      });
      setPhase('ready');
      setProgressText('');
      if (outcome.baked.certificate.pass) setOpenStep('deploy');
    } catch (error) {
      setPhase('ready');
      setProgressText(`烘焙失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      document.removeEventListener('visibilitychange', onVis);
    }
  }, [avatarId, driverChoice, motionOptions, costumeOn, bgOn, mouthOn, thumbsBusy, catalogReady, avatarExpressions, exprSel]);

  const handleDeploy = useCallback(async () => {
    if (!result || !avatarId || !result.baked.certificate.pass) return;
    // 预算断言（出货条件已在烘焙侧保证，此处是最后防线——触发=预算门失守的内部 bug）
    if (result.sizeKb > ABP_SHIP_BUDGET_KB) {
      setUploadState('failed');
      setUploadInfo(`内部错误：预算门失守（体积 ${(result.sizeKb / 1024).toFixed(1)}MB > ${Math.round(ABP_SHIP_BUDGET_KB / 1024)}MB），请重新烘焙并反馈`);
      return;
    }
    setUploadState('uploading');
    setUploadInfo(`上传中（${(result.abp.buffer.length / 1024 / 1024).toFixed(1)}MB ≤ 预算 ${Math.round(ABP_SHIP_BUDGET_KB / 1024)}MB ✓）…`);
    try {
      const { baked } = result;
      const res = await uploadBadgeAsset(result.abp.buffer, {
        avatarId,
        fps: baked.fps,
        frameCount: baked.frames.length,
        certificate: {
          pass: baked.certificate.pass,
          residual: baked.certificate.residual,
          wrapMad: baked.certificate.wrapMad,
          medianMad: baked.certificate.medianMad,
          warmupCycles: baked.certificate.warmupCycles,
          warnings: baked.certificate.warnings,
        },
      }, connectedMac ? macToDeviceId(connectedMac) : 'default');
      if (res.ok) {
        setUploadState('uploaded');
        setUploadInfo(`已投放（${res.assetId}${connectedMac ? ` · 绑定 ${connectedMac}` : ' · 未连设备(deviceId=default)'}，体积 ${(result.sizeKb / 1024).toFixed(1)}MB ✓）——等吧唧固件 P0-P2 上线后自动送达`);
      } else {
        setUploadState('failed');
        setUploadInfo(`上传失败：${res.error}`);
      }
    } catch (error) {
      setUploadState('failed');
      setUploadInfo(`打包/上传失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }, [result, avatarId]);

  const cert = result?.baked.certificate ?? null;
  const activeAvatar = avatarId ? avatarList.find((a) => a.id === avatarId) ?? null : null;
  const hasCostume = !!(avatarId && djModelFor(avatarId));
  const motionCards = buildMotionCards(motionOptions);
  const activeMotionName = motionCards.find((c) => c.choice === driverChoice)?.name ?? '安静呼吸';
  const busy = phase === 'baking';

  const screenMode: 'empty' | 'loading' | 'live' | 'baking' | 'playback' =
    phase === 'baking' ? 'baking'
      : result ? 'playback'
        : !avatarId ? 'empty'
          : phase === 'loading' ? 'loading'
            : 'live';

  const toggleStep = (step: Step) => {
    setOpenStep((cur) => (cur === step ? 'none' : step));
  };

  const styleSummary = [
    activeMotionName,
    exprSel.length ? `配饰×${exprSel.length}` : null,
    hasCostume && costumeOn ? '换装形态' : null,
    bgAvailable && bgOn ? '实景背景' : null,
    mouthOn ? '口型贴图' : null,
  ].filter(Boolean).join(' · ');

  return (
    <div className="badge-panel" role="dialog" aria-label="吧唧素材工坊">
      <header className="badge-panel__header">
        <button type="button" className="badge-panel__back" onClick={onClose} aria-label="返回">←</button>
        <h1>吧唧素材工坊</h1>
      </header>

      <BadgeDevicePanel onConnectedMac={setConnectedMac} />

      {/* 圆屏常驻：空态提示 → live 预览（所见即所烤） → 烘焙定格 → 成品回放 */}
      <div className="badge-panel__screen-area">
        <div className="badge-panel__screen">
          {avatarId && bgAvailable && bgOn && screenMode !== 'playback' && (
            <img className="badge-panel__screen-bg" src={`/badge-backgrounds/${avatarId}.png`} alt="" />
          )}
          {/* 烘焙舞台=实时预览：容器保持 466×466（引擎取景不变），CSS 缩放进圆屏 */}
          <div
            ref={stageRef}
            className="badge-panel__stage"
            style={{ visibility: screenMode === 'live' || screenMode === 'baking' ? 'visible' : 'hidden' }}
          />
          {screenMode === 'playback' && result && (
            <canvas
              className="badge-panel__playback"
              ref={previewRef}
              width={result.baked.frames[0].width}
              height={result.baked.frames[0].height}
            />
          )}
          {screenMode === 'empty' && <span className="badge-panel__screen-hint">先在下面选一个角色</span>}
          {screenMode === 'loading' && <span className="badge-panel__screen-hint">模型加载中…</span>}
          {screenMode === 'baking' && (
            <div className="badge-panel__screen-veil">
              <span className="badge-panel__spinner" aria-hidden="true" />
              <span>{progressText || '定格中…'}</span>
            </div>
          )}
        </div>
        <p className={`badge-panel__screen-status is-${screenMode}`}>
          {screenMode === 'live' && '● 实时预览 · 所见即所烤'}
          {screenMode === 'baking' && '正在把预览定格成吧唧动画…请保持本页可见'}
          {screenMode === 'playback' && '✓ 成品回放（吧唧上就是这个样子）'}
          {screenMode === 'loading' && '正在请角色进屏…'}
          {screenMode === 'empty' && '这里会实时预览你的吧唧'}
        </p>
      </div>

      <div className="badge-panel__accordion">
        <Module
          index={1}
          title="选角色"
          locked={false}
          done={!!avatarId}
          open={openStep === 'pick'}
          onToggle={() => toggleStep('pick')}
          summary={activeAvatar ? (
            <span className="bp-mod__summary-avatar">
              {portraits[activeAvatar.id]
                ? <img src={portraits[activeAvatar.id]} alt="" />
                : <i>{activeAvatar.name.slice(0, 1)}</i>}
              {activeAvatar.name}
            </span>
          ) : '还没选'}
        >
          <div className="badge-panel__grid">
            {avatarList.map((a) => (
              <button
                key={a.id}
                type="button"
                className={`badge-panel__avatar ${avatarId === a.id ? 'is-active' : ''}`}
                onClick={() => {
                  if (a.id !== avatarId) setAvatarId(a.id);
                  setOpenStep('style');
                }}
                disabled={busy}
              >
                {portraits[a.id]
                  ? <img className="badge-panel__avatar-img" src={portraits[a.id]} alt="" />
                  : <span className="badge-panel__avatar-glyph">{a.name.slice(0, 1)}</span>}
                <span className="badge-panel__avatar-name">{a.name}</span>
              </button>
            ))}
          </div>
          {!avatarId && progressText && <p className="badge-panel__error">{progressText}</p>}
        </Module>

        <Module
          index={2}
          title="搭配外观"
          locked={!avatarId}
          lockedHint="先选角色"
          done={!!result}
          open={openStep === 'style'}
          onToggle={() => toggleStep('style')}
          summary={avatarId ? styleSummary : ''}
        >
          <p className="bp-mod__lead">怎么动</p>
          <div className="badge-panel__motions">
            {motionCards.map((card) => (
              <button
                key={card.choice}
                type="button"
                className={`badge-panel__motion ${driverChoice === card.choice ? 'is-active' : ''}`}
                onClick={() => {
                  if (driverChoice !== card.choice) { setDriverChoice(card.choice); invalidateBake(); }
                }}
                disabled={busy || phase === 'loading'}
              >
                <span className="badge-panel__motion-thumb">
                  {motionThumbs[card.choice]
                    ? <img src={motionThumbs[card.choice]} alt="" />
                    : <span className="badge-panel__motion-thumb-ph">…</span>}
                </span>
                <span className="badge-panel__motion-name">{card.name}</span>
                <span className="badge-panel__motion-hint">{card.hint}</span>
              </button>
            ))}
          </div>
          {avatarExpressions.length > 0 && (
            <>
              <p className="bp-mod__lead">戴什么 · 什么表情（可多选，再点一下取消）</p>
              <div className="badge-panel__motions badge-panel__exprs">
                {avatarExpressions.map((expr) => (
                  <button
                    key={expr.id}
                    type="button"
                    className={`badge-panel__motion ${exprSel.includes(expr.id) ? 'is-active' : ''}`}
                    onClick={() => {
                      setExprSel((sel) => (sel.includes(expr.id) ? sel.filter((x) => x !== expr.id) : [...sel, expr.id]));
                      invalidateBake();
                    }}
                    disabled={busy || phase === 'loading'}
                  >
                    <span className="badge-panel__motion-thumb">
                      {exprThumbs[expr.id]
                        ? <img src={exprThumbs[expr.id]} alt="" />
                        : <span className="badge-panel__motion-thumb-ph">…</span>}
                    </span>
                    <span className="badge-panel__motion-name">{EXPRESSION_NAMES[expr.id.toLowerCase()] ?? expr.label ?? expr.id}</span>
                  </button>
                ))}
              </div>
            </>
          )}
          <p className="bp-mod__lead">穿什么 · 带什么</p>
          <div className="badge-panel__toggles">
            {hasCostume && (
              <label className="badge-panel__toggle">
                <span className="badge-panel__toggle-text">
                  换装形态
                  <small>切到这个角色的特别造型</small>
                </span>
                <input type="checkbox" checked={costumeOn} disabled={busy} onChange={(e) => { setCostumeOn(e.target.checked); invalidateBake(); }} />
              </label>
            )}
            {bgAvailable && (
              <label className="badge-panel__toggle">
                <span className="badge-panel__toggle-text">
                  实景背景
                  <small>不勾就是纯黑底（圆屏外圈本来就是黑的）</small>
                </span>
                <input type="checkbox" checked={bgOn} disabled={busy} onChange={(e) => { setBgOn(e.target.checked); invalidateBake(); }} />
              </label>
            )}
            <label className="badge-panel__toggle">
              <span className="badge-panel__toggle-text">
                口型贴图
                <small>吧唧说话时嘴会动（预览里看不到，烤完随成品打包）</small>
              </span>
              <input type="checkbox" checked={mouthOn} disabled={busy} onChange={(e) => { setMouthOn(e.target.checked); invalidateBake(); }} />
            </label>
          </div>
          <button
            type="button"
            className="badge-panel__primary badge-panel__next"
            onClick={() => setOpenStep('bake')}
            disabled={!avatarId || busy}
          >
            就这样，去烘焙 →
          </button>
        </Module>

        <Module
          index={3}
          title="烘焙"
          locked={!avatarId}
          lockedHint="先选角色"
          done={!!cert?.pass}
          open={openStep === 'bake'}
          onToggle={() => toggleStep('bake')}
          summary={busy ? (progressText || '烘焙中…') : cert ? (cert.pass ? '✅ 质检通过' : '❌ 质检未过') : '预览满意就来'}
        >
          <p className="bp-mod__note">
            把圆屏里的实时预览定格成吧唧循环动画（约 1-3 分钟）。期间请把这页留在前台、屏幕保持亮着。
          </p>
          <div className="badge-panel__bake">
            <button
              type="button"
              className="badge-panel__primary"
              onClick={() => void handleBake()}
              disabled={!avatarId || phase === 'loading' || busy || thumbsBusy || !catalogReady}
            >
              {phase === 'loading' ? '角色加载中…'
                : !catalogReady ? '读取模型目录中…'
                  : thumbsBusy ? '准备预览中…'
                    : busy ? '烘焙中…' : result ? '重新烘焙' : '开始烘焙'}
            </button>
            {progressText && <p className="badge-panel__progress">{progressText}</p>}
            {cert && (
              <p className={`badge-panel__cert ${cert.pass ? 'is-pass' : 'is-fail'}`}>
                {cert.pass
                  ? `✅ 质检通过：接缝 ${cert.wrapMad.toFixed(2)} ≤ 1.3×中位 ${cert.medianMad.toFixed(2)}（定型 ${cert.warmupCycles} 圈）· 体积 ${result ? (result.sizeKb / 1024).toFixed(1) : '?'}MB ≤ ${Math.round(ABP_SHIP_BUDGET_KB / 1024)}MB${result && result.rungKey !== 'R1' ? `（省预算档：${result.rungLabel}）` : ''}`
                  : `❌ 质检未过：${cert.reason ?? '未知原因'}——请重烤或换个动作`}
              </p>
            )}
            {cert && cert.warnings.length > 0 && (
              <p className="badge-panel__cert is-warn">⚠ {cert.warnings.join('；')}</p>
            )}
          </div>
        </Module>

        <Module
          index={4}
          title="投放到吧唧"
          locked={!cert?.pass}
          lockedHint="质检通过后解锁"
          done={uploadState === 'uploaded'}
          open={openStep === 'deploy'}
          onToggle={() => toggleStep('deploy')}
          summary={uploadState === 'uploaded' ? '已投放' : uploadState === 'failed' ? '上传失败' : cert?.pass ? '成品已就绪' : ''}
        >
          <div className="badge-panel__deploy">
            <button
              type="button"
              className="badge-panel__primary"
              onClick={() => void handleDeploy()}
              disabled={!cert?.pass || uploadState === 'packing' || uploadState === 'uploading' || uploadState === 'uploaded'}
            >
              {uploadState === 'packing' ? '打包中…'
                : uploadState === 'uploading' ? '上传中…'
                  : uploadState === 'uploaded' ? '已投放（等固件）'
                    : '投放到吧唧'}
            </button>
            {uploadInfo && <p className={`badge-panel__upload ${uploadState === 'failed' ? 'is-fail' : ''}`}>{uploadInfo}</p>}
          </div>
        </Module>
      </div>
    </div>
  );
}
