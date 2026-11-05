// 「电子吧唧」素材导出工具页（纯前端开发工具，桌面浏览器使用，URL ?badgeExport=1 进入）。
// 用途：从 App 现有 Live2D 模型导出 ESP32 硬件（466×466 圆形屏）所需的预烘焙帧动画素材：
//   - 全屏状态立绘（待机/聆听/思考/说话）
//   - 眨眼帧序列（眼参数 1→0→1 共 N 帧，同一 JS tick 内连拍，帧间零漂移）
//   - 口型帧（嘴参数 0 / 0.5 / 1.0 三帧，可按框选区域裁剪）
// 导出格式：PNG（透明底）+ RGB565 小端 .bin（黑底合成）+ manifest.json。
// 抓帧走 renderer.render(stage, { renderTexture }) + extract，不依赖 preserveDrawingBuffer。
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import * as PIXI from 'pixi.js';
import {
  applyExpressionMix,
  createLive2DRuntime,
  destroyRuntime,
  getRuntimeParameterSnapshot,
  resetRuntimeFocus,
  updateStageTransform,
  REFERENCE_ASPECT,
  type StageTransform,
} from '../../features/live2d/live2dEngine.ts';
import {
  avatars,
  avatarList,
  resolveAvatarManifestById,
} from '../../features/live2d/avatarManifest.ts';
import type { AvatarManifest } from '../../features/live2d/avatarManifest.ts';
import { djModelFor, djConfigForModelAvatar } from '../../features/live2d/djModels.ts';
import {
  adjacentLoopMads,
  canvasToPngBlob,
  canvasToRgb565,
  compositeOnBackground,
  computeDiffRegion,
  countOpaquePixels,
  diffBoundingBox,
  diffPixelCount,
  downloadBlob,
  findLoopValleyIndex,
  findMouthAnchor,
  intersectRegions,
  saveToBadgeAssets,
  sleep,
  type AnchorMatch,
  type BadgeExportRecord,
  type ExportRegion,
} from './exportUtils.ts';
import { startMotion } from '../../features/live2d/live2dEngine.ts';
import {
  IDLE_BADGE_PERIOD_S,
  evalIdleBadgeAngles,
  evalIdleBadgeFinal,
  blinkEyeOpen,
} from './idleBadgeCurves.ts';
import { bakeIdle } from '../../features/badgeBake/bakeIdle.ts';
import type { BakeDriverConfig } from '../../features/badgeBake/bakeProfiles.ts';
import './badgeExport.css';

// —— 常量 ——

/** 硬件屏尺寸：466×466 圆形屏 */
const VIEW = 466;
/** 魔力卡竖屏编码尺寸（H.264 契约：尺寸 align32；构图=466 方形放大到 640 高居中裁两侧） */
const CARD_W = 384;
const CARD_H = 640;
/** 方屏在引擎里的虚拟竖屏高度（fitModel 的 offsetY 以 layoutHeight 为基准，拖拽换算用） */
const LAYOUT_HEIGHT = VIEW / REFERENCE_ASPECT;
const DEFAULT_TRANSFORM: StageTransform = { scale: 1, offsetX: 0, offsetY: 0 };

/** 状态立绘细分（文件名与 manifest.label 用） */
const STATE_KINDS = [
  { key: 'idle', label: '待机' },
  { key: 'listen', label: '聆听' },
  { key: 'think', label: '思考' },
  { key: 'talk', label: '说话' },
] as const;

// 常见参数 id 默认值（模型间可能不同，输入框可手改；datalist 会列出运行时发现的全部参数）
const DEFAULT_EYE_L = 'ParamEyeLOpen';
const DEFAULT_EYE_R = 'ParamEyeROpen';
const DEFAULT_MOUTH = 'ParamMouthOpenY';

/** 口型三帧：嘴开合 0 / 0.5 / 1.0（文件名后缀按百分比） */
const MOUTH_FRAME_VALUES = [
  { value: 0, suffix: '000' },
  { value: 0.5, suffix: '050' },
  { value: 1, suffix: '100' },
] as const;

/** 口型自动区域模式：嘴开合 5 档（区域由嘴 0 vs 嘴 1 像素 diff 自动求出） */
const MOUTH_AUTO_LEVELS = [0, 0.25, 0.5, 0.75, 1] as const;

/** 嘴部区域 diff 包围盒的外扩像素（硬件贴图对位裕量）。 */
const MOUTH_BBOX_PAD = 8;

/**
 * 口型档位采集后自检：level_0 vs level_4 的 diff 像素数须超过「有效核心区」面积的该比例。
 * 核心区 = region 去掉 pad 环（diff 包围盒按构造 = 紧致变化区 + pad 外扩，diff 像素数不可能
 * 超过核心区面积，用整个 region 当分母会把小嘴角色永远判死）。两类真实事故都会被抓住：
 * ① 嘴参数被钉死/没驱动上 → diff ≈ 0；② region 被物理噪声撑爆（如 112×212）→ 核心区巨大而
 * 实际嘴部变化只占其中一角，比例远低于阈值。
 */
const MOUTH_LEVEL_MIN_DIFF_RATIO = 0.2;

/**
 * 锚点模板匹配的上下文外扩（每边像素）：嘴 region 大部分是光滑皮肤，小窗口 SAD 在大半径
 * 里全是假极小值（v8 实锤：帧 0 贴到右脸颊、帧 1 顶边界掉下巴）。外扩后模板含下巴/鼻底/
 * 唇角等结构，极小值唯一。
 */
const ANCHOR_CONTEXT_PAD = 16;
/** 相邻帧锚点位移硬门（|Δdx|+|Δdy|）：正常身体摆动在 5-7fps 下不会单帧跳 10px 以上。 */
const ANCHOR_MAX_STEP = 10;
/** 循环相邻帧 MAD 观感阈值：超过则该动作在此 fps 下有强运动段，观感可能读作跳变。 */
const LOOP_MAD_WARN = 35;

// 眼/嘴参数 id 的常见命名候选（按优先级）。模型间命名不统一（如 yumi 是 ParamEyeOpenL 而非
// 标准 ParamEyeLOpen），加载模型后从运行时参数表里自动匹配，匹配不到保留默认值、允许手输。
const EYE_L_CANDIDATES = ['ParamEyeLOpen', 'ParamEyeOpenL', 'PARAM_EYE_L_OPEN'];
const EYE_R_CANDIDATES = ['ParamEyeROpen', 'ParamEyeOpenR', 'PARAM_EYE_R_OPEN'];
const MOUTH_CANDIDATES = ['ParamMouthOpenY', 'ParamMouthOpen', 'PARAM_MOUTH_OPEN_Y', 'ParamJawOpen'];

function pickParamId(ids: string[], candidates: string[], fuzzy: RegExp): string | undefined {
  for (const candidate of candidates) {
    const hit = ids.find((id) => id.toLowerCase() === candidate.toLowerCase());
    if (hit) return hit;
  }
  return ids.find((id) => fuzzy.test(id));
}

const transformStorageKey = (avatarId: string) => `aiboo:badge-export-transform:${avatarId}`;

function loadStoredTransform(avatarId: string): StageTransform {
  try {
    const raw = localStorage.getItem(transformStorageKey(avatarId));
    if (!raw) return DEFAULT_TRANSFORM;
    const parsed = JSON.parse(raw) as Partial<StageTransform>;
    if (
      typeof parsed.scale === 'number'
      && typeof parsed.offsetX === 'number'
      && typeof parsed.offsetY === 'number'
    ) {
      return { scale: parsed.scale, offsetX: parsed.offsetX, offsetY: parsed.offsetY };
    }
  } catch { /* 坏数据回默认 */ }
  return DEFAULT_TRANSFORM;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

type Runtime = Awaited<ReturnType<typeof createLive2DRuntime>>;
type CoreModelLike = { setParameterValueById(id: string, value: number): void };
type InternalModelEvents = {
  on?: (event: string, fn: () => void) => void;
  off?: (event: string, fn: () => void) => void;
};
type Thumb = { name: string; dataUrl: string };

export default function BadgeExportPage() {
  // —— 角色与运行时 ——
  const avatarOptions = useMemo(() => {
    // 抽屉可见角色在前，追加注册表里的内部条目（如 shuangsheng-dj 完整换装模型）
    const seen = new Set<string>();
    return [...avatarList, ...Object.values(avatars)].filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
  }, []);
  const [avatarId, setAvatarId] = useState(() => avatarOptions[0]?.id ?? 'yumi');
  const [resolved, setResolved] = useState<AvatarManifest | null>(null);
  const [status, setStatus] = useState('初始化…');
  const [paramIds, setParamIds] = useState<string[]>([]);

  // —— 构图（拖拽/滚轮，localStorage 持久化）——
  const [transform, setTransform] = useState<StageTransform>(() => loadStoredTransform(avatarOptions[0]?.id ?? 'yumi'));
  const [maskOn, setMaskOn] = useState(true);
  const [freeze, setFreeze] = useState(true);
  // 换装形态：按 djModels 映射每帧硬写换装参数（如双生 Param67=1；只设一次会被动作数据覆盖）
  const [costumeOn, setCostumeOn] = useState(false);

  // —— 表情与参数覆盖 ——
  const [activeExpr, setActiveExpr] = useState('neutral');
  const [eyeOn, setEyeOn] = useState(true);
  const [eyeValue, setEyeValue] = useState(1);
  const [eyeLId, setEyeLId] = useState(DEFAULT_EYE_L);
  const [eyeRId, setEyeRId] = useState(DEFAULT_EYE_R);
  const [mouthOn, setMouthOn] = useState(false);
  const [mouthValue, setMouthValue] = useState(0);
  const [mouthId, setMouthId] = useState(DEFAULT_MOUTH);

  // —— 裁剪区 ——
  const [selecting, setSelecting] = useState(false);
  const [draftRegion, setDraftRegion] = useState<ExportRegion | null>(null);
  const [region, setRegion] = useState<ExportRegion | null>(null);
  const [cropOn, setCropOn] = useState(true);

  // —— 导出配置与结果 ——
  const [pngOn, setPngOn] = useState(true);
  const [binOn, setBinOn] = useState(true);
  const [stateKind, setStateKind] = useState<string>('idle');
  const [blinkN, setBlinkN] = useState(6);
  // 待机动作连拍（呼吸/摇摆）：合成时间步进抓帧，帧间隔严格 = 1/fps
  const [idleFrames, setIdleFrames] = useState(30);
  const [idleFps, setIdleFps] = useState(15);
  // W2（spec 2026-07-04）：程序化低幅闭环微动——曲线直驱参数，绕开 motion 管理器全部干扰源
  // （fade/内部loop/看门狗/小动作池）。要求 帧数/fps === IDLE_BADGE_PERIOD_S（如 48@12）。
  const [idleParametric, setIdleParametric] = useState(false);
  // 动作驱动（魔力卡待机方案）：以模型自带 loop-authored 动作为严格周期驱动，替代手搓正弦
  const [idleMotionDrive, setIdleMotionDrive] = useState(false);
  const [idleMotionUrl, setIdleMotionUrl] = useState('/live2D/shuangsheng/motions/idle.motion3.json');
  // 自然摆动层：库 CubismBreath 默认摆的有理化重构（预览活气的大头）。周期倍数=烘焙窗
  // 拉长为动作时长×N（N=2 时摆动分频误差最小，且两遍动作配不同摆动相位=不重复感）
  const [idleWobble, setIdleWobble] = useState(true);
  const [idleLoopMult, setIdleLoopMult] = useState(2);
  // 竖屏原生：直接渲染 384×640（治模糊：466→640 上采样全是插值），PNG 供 mp4，不出 .bin
  const [idleCardNative, setIdleCardNative] = useState(true);
  // 说话动作连拍（嘴锚点）：动作播放中逐帧模板匹配求嘴部平移偏移，供硬件端嘴部贴图逐帧对位
  const [speakMotion, setSpeakMotion] = useState('');
  const [speakFrames, setSpeakFrames] = useState(30);
  const [speakFps, setSpeakFps] = useState(15);
  const [speakRadius, setSpeakRadius] = useState(12);
  const [speakTolerance, setSpeakTolerance] = useState(8);
  const [speakAnchors, setSpeakAnchors] = useState<AnchorMatch[]>([]);
  // 物理预热：抓帧前先让动作+物理按同样的 1/fps 步进空跑 2 个完整周期（2×帧数 步，不抓帧），
  // 让发丝物理进入稳态周期轨道，循环首尾自然接近。作用于待机/说话连拍与全套连拍的 idle 分组。
  // （前一版方案是末 K 帧向帧 0 交叉淡化，真机上表现为两套发型半透明叠加的残影，已废弃。）
  const [warmupOn, setWarmupOn] = useState(true);
  // 聆听表情提取：表情帧 vs 基线做像素 diff 求局部区域（默认取眼睛高亮类表情）
  const [listenExpr, setListenExpr] = useState('');
  // 落盘到 dev server 的 badge-assets/<outDir>/（关闭则回退浏览器下载）
  const [serverSave, setServerSave] = useState(true);
  const [outDir, setOutDir] = useState(() => avatarOptions[0]?.id ?? 'badge');
  // 背景图（badge-assets 相对路径，须为 466×466）：导出时垫在最底层合成为不透明成品帧；空 = 透明底
  const [bgPath, setBgPath] = useState('');
  const [bgImage, setBgImage] = useState<HTMLImageElement | null>(null);
  const [bgPreviewUrl, setBgPreviewUrl] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [records, setRecords] = useState<BadgeExportRecord[]>([]);
  // ref 镜像：全套连拍在一次执行里连续调 4 次 exportGroup，闭包里的 records state 不会刷新，
  // 直接用 state 累加会互相覆盖（manifest 只剩最后一组）。追加一律走 ref。
  const recordsRef = useRef<BadgeExportRecord[]>([]);
  const [thumbs, setThumbs] = useState<Thumb[]>([]);

  const stageRef = useRef<HTMLDivElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const runtimeRef = useRef<Runtime | null>(null);
  const transformRef = useRef(transform);
  // 滑杆覆盖（每帧写）与连拍覆盖（抓帧瞬时写，优先级更高）
  const overrideMapRef = useRef(new Map<string, number>());
  const burstMapRef = useRef(new Map<string, number>());
  // 换装持久参数（写在最前，情绪/滑杆/连拍都可再叠加）
  const costumeMapRef = useRef(new Map<string, number>());
  // 口型档位采集时的「档位 0 同姿态全帧」：说话连拍的锚点模板基线从这里取（与嘴贴图完全同姿态），
  // 避免两次独立沉降之间的微小姿态差污染模板。avatarId 不匹配时失效（回退现抓）。
  const mouthBaselineRef = useRef<{ avatarId: string; canvas: HTMLCanvasElement } | null>(null);
  // 冻结前的待机动作状态（解冻恢复用）
  const originalIdleRef = useRef<{ key: string | null; beats: boolean }>({ key: null, beats: true });
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; base: StageTransform } | null>(null);
  const regionDragRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    document.title = 'Aiboo 吧唧素材导出';
  }, []);

  // 滑杆状态 → 每帧覆盖表（在 beforeModelUpdate 时机写入，晚于动作/眨眼/物理，必定生效）
  useEffect(() => {
    const next = new Map<string, number>();
    if (eyeOn) {
      if (eyeLId.trim()) next.set(eyeLId.trim(), eyeValue);
      if (eyeRId.trim()) next.set(eyeRId.trim(), eyeValue);
    }
    if (mouthOn && mouthId.trim()) next.set(mouthId.trim(), mouthValue);
    overrideMapRef.current = next;
  }, [eyeOn, eyeValue, eyeLId, eyeRId, mouthOn, mouthValue, mouthId]);

  // 当前角色的换装配置（djModels 映射：对话角色正查，完整模型 id 反查）
  const costumeCfg = useMemo(
    () => djModelFor(avatarId) ?? djConfigForModelAvatar(avatarId),
    [avatarId],
  );

  // 换装开关 → 每帧硬写换装参数（如 Param67=1）。开关或角色变化即重建映射表。
  useEffect(() => {
    const next = new Map<string, number>();
    if (costumeOn && costumeCfg) {
      for (const item of costumeCfg.costume) next.set(item.id, item.value);
    }
    costumeMapRef.current = next;
  }, [costumeOn, costumeCfg]);

  // 背景图加载：从 dev server 的 badge-assets/ 取（GET /__badge_export/<path>），
  // 同时作为视口预览底图与导出合成底图。路径清空则回到透明底。
  useEffect(() => {
    if (!bgPath.trim()) {
      setBgImage(null);
      setBgPreviewUrl(null);
      return;
    }
    let cancelled = false;
    let objectUrl: string | null = null;
    void (async () => {
      try {
        const response = await fetch(`/__badge_export/${bgPath.trim()}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        objectUrl = URL.createObjectURL(blob);
        const image = new Image();
        await new Promise<void>((resolve, reject) => {
          image.onload = () => resolve();
          image.onerror = () => reject(new Error('图片解码失败'));
          image.src = objectUrl!;
        });
        if (cancelled) return;
        setBgImage(image);
        setBgPreviewUrl(objectUrl);
        setStatus(`背景图已加载：${bgPath.trim()}（${image.naturalWidth}×${image.naturalHeight}）`);
      } catch (error) {
        if (cancelled) return;
        setBgImage(null);
        setBgPreviewUrl(null);
        setStatus(`背景图加载失败：${error instanceof Error ? error.message : String(error)}`);
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) setTimeout(() => URL.revokeObjectURL(objectUrl!), 5000);
    };
  }, [bgPath]);

  // 构图变化：同步 ref、应用到引擎、持久化
  useEffect(() => {
    transformRef.current = transform;
    const runtime = runtimeRef.current;
    const container = stageRef.current;
    if (runtime && container) updateStageTransform(runtime, container, transform);
    try {
      localStorage.setItem(transformStorageKey(avatarId), JSON.stringify(transform));
    } catch { /* 存储满/隐私模式：忽略 */ }
  }, [transform, avatarId]);

  // 运行时生命周期：仅随角色重建（一个 WebGL 上下文一个模型）
  useEffect(() => {
    const container = stageRef.current;
    if (!container) return;

    let cancelled = false;
    setResolved(null);
    setStatus('加载模型…');

    void (async () => {
      const manifest = await resolveAvatarManifestById(avatarId);
      if (cancelled) return;
      const runtime = await createLive2DRuntime(container, manifest);
      if (cancelled) {
        destroyRuntime(runtime);
        return;
      }
      runtimeRef.current = runtime;
      originalIdleRef.current = { key: runtime.idleMotionKey, beats: runtime.idleBeatEnabled };

      // 参数覆盖挂到 beforeModelUpdate（motion/眨眼/物理之后、model.update 之前）：
      // 写入必定反映到本帧 drawable，且同步连拍（dt=0 的多次 render）也逐帧生效。
      const internal = runtime.model.internalModel as unknown as InternalModelEvents;
      internal.on?.('beforeModelUpdate', () => {
        const core = runtime.model.internalModel.coreModel as CoreModelLike;
        // 写入顺序 = 优先级：换装（持久）→ 滑杆 → 连拍（抓帧瞬时值最高）
        for (const map of [costumeMapRef.current, overrideMapRef.current, burstMapRef.current]) {
          for (const [id, value] of map) {
            if (!Number.isFinite(value)) continue;
            try { core.setParameterValueById(id, value); } catch { /* 未知参数 id：忽略 */ }
          }
        }
      });

      await applyExpressionMix(runtime, manifest, [{ key: 'neutral', weight: 1 }]);
      updateStageTransform(runtime, container, transformRef.current);
      const ids = getRuntimeParameterSnapshot(runtime).map((item) => item.id);
      setParamIds(ids);
      // 按当前模型自动匹配眼/嘴参数 id（匹配不到保留原值，可手输）
      const eyeL = pickParamId(ids, EYE_L_CANDIDATES, /eye.*open.*l|l.*eye.*open|eye.*l.*open/i);
      const eyeR = pickParamId(ids, EYE_R_CANDIDATES, /eye.*open.*r|r.*eye.*open|eye.*r.*open/i);
      const mouth = pickParamId(ids, MOUTH_CANDIDATES, /mouth.*open/i);
      if (eyeL) setEyeLId(eyeL);
      if (eyeR) setEyeRId(eyeR);
      if (mouth) setMouthId(mouth);
      // 说话动作默认选中名字里带 talk/speak 的动作组，没有则回落第一个；聆听表情同理找 happy/shy 类。
      const motionKeys = Object.keys(manifest.motions ?? {});
      const talkMotion = motionKeys.find((k) => /talk|speak/i.test(k)) ?? motionKeys[0] ?? '';
      setSpeakMotion(talkMotion);
      const exprIds = (manifest.expressions ?? []).map((e) => e.id);
      const listenCandidate = exprIds.find((id) => /happy|shy|sparkle|star|blush/i.test(id)) ?? exprIds[0] ?? '';
      setListenExpr(listenCandidate);
      setActiveExpr('neutral');
      setResolved(manifest);
      setStatus('就绪');
    })().catch((error) => {
      console.error('[badgeExport] 模型加载失败：', error);
      setStatus(`加载失败：${error instanceof Error ? error.message : String(error)}`);
    });

    return () => {
      cancelled = true;
      if (runtimeRef.current) {
        destroyRuntime(runtimeRef.current);
        runtimeRef.current = null;
      }
    };
  }, [avatarId]);

  // 冻结动作：清空待机动作/小动作拍并停播（引擎公开可变状态，不改引擎代码），视线回中。
  // 目的：多次抓取（如四个状态立绘）之间身体姿态尽量一致，便于硬件切换状态不跳变。
  // 注意竞态：引擎 setupIdle 是异步的，且在起播前就捕获了 idleMotionKey——本 effect 先跑、
  // setupIdle 的续段后到会把循环待机动作重新播上（实测跑了好几轮才发现）。
  // 因此延迟 1.6s 再补一次 stopAllMotions 兜底（关键采集入口 captureAllAligned 还会再停一次）。
  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime || !resolved) return;
    const motionManager = runtime.model.internalModel.motionManager as unknown as { stopAllMotions?: () => void };
    if (freeze) {
      runtime.idleMotionKey = null;
      runtime.idleBeatEnabled = false;
      try { motionManager.stopAllMotions?.(); } catch { /* ignore */ }
      resetRuntimeFocus(runtime);
      const lateStop = setTimeout(() => {
        try { motionManager.stopAllMotions?.(); } catch { /* ignore */ }
      }, 1600);
      return () => clearTimeout(lateStop);
    }
    runtime.idleMotionKey = originalIdleRef.current.key;
    runtime.idleBeatEnabled = originalIdleRef.current.beats;
  }, [freeze, resolved]);

  // 滚轮缩放（native 监听，passive:false 才能 preventDefault）
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      setTransform((prev) => ({
        ...prev,
        scale: clamp(prev.scale * Math.exp(-event.deltaY * 0.0012), 0.05, 20),
      }));
    };
    wrap.addEventListener('wheel', onWheel, { passive: false });
    return () => wrap.removeEventListener('wheel', onWheel);
  }, []);

  // —— 交互：角色切换 / 表情 ——

  function handleSwitchAvatar(nextId: string) {
    setAvatarId(nextId);
    setTransform(loadStoredTransform(nextId));
    setThumbs([]);
    setOutDir(nextId); // 落盘目录默认跟随角色（可再手改，如 shuangsheng-costume）
  }

  function handleExpression(exprId: string) {
    const runtime = runtimeRef.current;
    if (!runtime || !resolved) return;
    setActiveExpr(exprId);
    void applyExpressionMix(runtime, resolved, [{ key: exprId, weight: 1 }]).catch((error) => {
      console.error('[badgeExport] 表情切换失败：', error);
    });
  }

  // —— 交互：构图拖拽 ——

  function handleStagePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (selecting) return;
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      base: transformRef.current,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handleStagePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    setTransform({
      scale: drag.base.scale,
      offsetX: drag.base.offsetX + dx / VIEW,
      offsetY: drag.base.offsetY + dy / LAYOUT_HEIGHT,
    });
  }

  function handleStagePointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
  }

  // —— 交互：框选裁剪区 ——

  function regionPoint(event: ReactPointerEvent<HTMLDivElement>) {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: clamp(Math.round(event.clientX - rect.left), 0, VIEW),
      y: clamp(Math.round(event.clientY - rect.top), 0, VIEW),
    };
  }

  function handleSelectPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    event.stopPropagation();
    const point = regionPoint(event);
    regionDragRef.current = point;
    setDraftRegion({ x: point.x, y: point.y, w: 0, h: 0 });
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handleSelectPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const start = regionDragRef.current;
    if (!start) return;
    const point = regionPoint(event);
    setDraftRegion({
      x: Math.min(start.x, point.x),
      y: Math.min(start.y, point.y),
      w: Math.abs(point.x - start.x),
      h: Math.abs(point.y - start.y),
    });
  }

  function handleSelectPointerUp() {
    const draft = draftRegion;
    regionDragRef.current = null;
    setDraftRegion(null);
    if (draft && draft.w >= 4 && draft.h >= 4) {
      setRegion(draft);
      setSelecting(false);
    }
  }

  function updateRegionField(field: keyof ExportRegion, raw: string) {
    const value = Number(raw);
    if (!Number.isFinite(value)) return;
    setRegion((prev) => {
      if (!prev) return prev;
      const next = { ...prev, [field]: Math.round(value) };
      next.x = clamp(next.x, 0, VIEW - 1);
      next.y = clamp(next.y, 0, VIEW - 1);
      next.w = clamp(next.w, 1, VIEW - next.x);
      next.h = clamp(next.h, 1, VIEW - next.y);
      return next;
    });
  }

  // —— 抓帧核心 ——

  /**
   * 抓当前帧：渲染到 466×466、resolution=1 的 RenderTexture 再 extract，
   * 与屏幕取景 1:1（不受 devicePixelRatio 影响），且不依赖 preserveDrawingBuffer。
   * advanceMs：本次抓帧前推进的模型时间（毫秒）。默认 1µs 级——
   * 关键：Live2DModel._render 仅在 deltaTime>0 时才执行 internalModel.update
   * （即消费 beforeModelUpdate 的参数写入并重算 drawable）。同步连拍期间 ticker
   * 不运行、deltaTime 恒为 0，必须垫入时间片，否则每帧都停留在上一屏幕帧的
   * drawable 状态（眨眼/口型参数不生效，帧帧相同）。待机动作连拍则传 1000/fps，
   * 让动作/物理按严格帧间隔推进（比实时 rAF 采样更稳定）。
   */
  function captureCanvas(cropRegion: ExportRegion | null, advanceMs = 0.001): HTMLCanvasElement {
    const runtime = runtimeRef.current;
    if (!runtime) throw new Error('模型尚未就绪');
    runtime.model.update(advanceMs);
    const renderer = runtime.app.renderer as PIXI.Renderer;
    const renderTexture = PIXI.RenderTexture.create({ width: VIEW, height: VIEW, resolution: 1 });
    renderer.render(runtime.app.stage, { renderTexture });
    const extract = renderer.plugins.extract as PIXI.Extract;
    const full = extract.canvas(renderTexture);
    renderTexture.destroy(true);
    if (!cropRegion) return full;

    const cropped = document.createElement('canvas');
    cropped.width = cropRegion.w;
    cropped.height = cropRegion.h;
    cropped.getContext('2d')?.drawImage(
      full,
      cropRegion.x, cropRegion.y, cropRegion.w, cropRegion.h,
      0, 0, cropRegion.w, cropRegion.h,
    );
    return cropped;
  }


  function effectiveRegion(): ExportRegion | null {
    return cropOn && region ? region : null;
  }

  /** canvas → RGBA Uint8ClampedArray（喂 findMouthAnchor/computeDiffRegion 这两个不依赖 DOM 的纯函数）。 */
  function canvasRgba(canvas: HTMLCanvasElement): Uint8ClampedArray {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('无法创建 2d 上下文');
    return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  }

  /**
   * 运行时全部 id 含 mouth 的参数（含 extraIds 兜底）在当前姿态下的基线值表。
   * 该角色嘴部可能受非标准命名参数或动作曲线驱动，只钉一个 mouthId 钉不住。
   * excludeId：口型档位采集时被扫描的嘴参数必须放行（不钉），否则 5 档全被钉成基线闭嘴。
   */
  function collectMouthBaseline(runtime: Runtime, extraIds: string[] = [], excludeId?: string): Map<string, number> {
    const snapshot = getRuntimeParameterSnapshot(runtime);
    const ids = new Set(snapshot.map((p) => p.id).filter((pid) => /mouth/i.test(pid)));
    for (const pid of extraIds) ids.add(pid);
    if (excludeId) ids.delete(excludeId);
    const baseline = new Map<string, number>();
    for (const pid of ids) {
      const current = snapshot.find((p) => p.id === pid)?.currentValue;
      baseline.set(pid, typeof current === 'number' ? current : 0);
    }
    return baseline;
  }

  /**
   * 循环序列诊断：帧序保持抓拍自然序不动（帧 0 = 基线，固件位级不变量）。只算环形相邻 MAD
   * （mads[0]=回卷缝，末帧→帧 0）与「速度谷」下标（最小转移处，见 findLoopValleyIndex）——
   * 谷下标不用来重排帧，而是作为 start_idx 落 meta.json，由固件起播时使用。
   * 返回 mads（四舍五入到 0.01，随 frame_mads 落 manifest）与 startIdx。
   */
  function analyzeLoop(
    frames: { name: string; canvas: HTMLCanvasElement }[],
  ): { mads: number[]; startIdx: number } {
    if (frames.length < 2) return { mads: [], startIdx: 0 };
    const rgbas = frames.map((f) => canvasRgba(f.canvas));
    const mads = adjacentLoopMads(rgbas);
    const startIdx = findLoopValleyIndex(rgbas);
    return { mads: mads.map((m) => Math.round(m * 100) / 100), startIdx };
  }

  /**
   * 口型档位采集后自检（fail-fast）：level_0 vs level_4（首末档）的 diff 像素数须显著，
   * 否则说明嘴参数被钉死/没驱动上，或 region 被物理噪声撑爆（真机表现＝说话时嘴巴没变化）。
   * 通过返回 null，失败返回错误描述（调用方置状态并整组不落盘）。
   */
  function checkMouthLevelsDiff(frames: { name: string; canvas: HTMLCanvasElement }[], bbox: ExportRegion): string | null {
    const diff = diffPixelCount(frames[0].canvas, frames[frames.length - 1].canvas, 48);
    const coreArea = Math.max(1, (bbox.w - 2 * MOUTH_BBOX_PAD) * (bbox.h - 2 * MOUTH_BBOX_PAD));
    const need = Math.ceil(coreArea * MOUTH_LEVEL_MIN_DIFF_RATIO);
    console.log(
      `[badgeExport] 口型档位自检：level_0 vs level_4 diff=${diff}px，核心区 ${coreArea}px`
      + `（region ${bbox.w}×${bbox.h} 去 pad ${MOUTH_BBOX_PAD} 环），阈值 ${need}px`,
    );
    if (diff >= need) return null;
    return `口型档位无差异（level_0 vs level_4 diff ${diff}px < 核心区 ${coreArea}px 的 ${Math.round(MOUTH_LEVEL_MIN_DIFF_RATIO * 100)}%）`
      + `——嘴参数没驱动上或 region 被噪声撑爆，检查嘴参数 id / 先等物理沉降（建议直接用「全套对齐连拍」）`;
  }

  function buildManifest(allRecords: BadgeExportRecord[]) {
    return {
      screen: { width: VIEW, height: VIEW, shape: 'round', pixelFormat: 'RGB565', byteOrder: 'little-endian' },
      generatedAt: new Date().toISOString(),
      exports: allRecords,
    };
  }

  /**
   * 逐帧导出 PNG/RGB565 并记入 manifest。落盘模式 POST 到 dev server 写 badge-assets/<outDir>/
   * （并同步更新该目录 manifest.json）；否则走浏览器下载（帧间加间隔避免多文件下载被拦截）。
   * 自检：每帧不透明像素数（空白告警）+ 序列相邻帧差异像素数（全 0 说明参数没驱动上）。
   */
  async function exportGroup(
    kind: BadgeExportRecord['kind'],
    frames: { name: string; canvas: HTMLCanvasElement }[],
    cropRegion: ExportRegion | null,
    extra?: {
      label?: string;
      params?: BadgeExportRecord['params'];
      fps?: number;
      frameMads?: number[];
      startIdx?: number;
      /**
       * motions/<motionDir>/ 目录契约（跨仓：abp-pack 只扫 motions/<name>/ 子目录，不读顶层
       * manifest.json）。提供时帧落盘到该子目录，并额外写一份 motions/<motionDir>/meta.json
       * （snake_case：fps/loop/trigger/start_idx/frame_mads，模式与 speak 组一致）。
       */
      motionDir?: string;
    },
  ) {
    if (!pngOn && !binOn) {
      setStatus('请至少勾选一种导出格式（PNG / RGB565）');
      return;
    }
    setExporting(true);
    try {
      const fileNames: string[] = [];
      const nextThumbs: Thumb[] = [];
      let blankCount = 0;
      // motions/<motionDir>/ 目录契约：帧与 meta.json 都落到该子目录（跨仓 abp-pack 只扫这里）
      const motionDir = extra?.motionDir;
      const motionPrefix = motionDir ? `motions/${motionDir}/` : '';

      // 自检①：相邻帧差异像素数（阈值 48 滤掉渲染微动噪声；序列帧应逐帧有实质变化）
      const adjacentDiffs: number[] = [];
      for (let i = 1; i < frames.length; i += 1) {
        adjacentDiffs.push(diffPixelCount(frames[i - 1].canvas, frames[i].canvas, 48));
      }
      if (adjacentDiffs.length > 0) {
        console.log(`[badgeExport] ${kind} 相邻帧差异像素:`, adjacentDiffs.join(','));
      }

      for (const frame of frames) {
        // 自检②：空白帧检测——在「合成背景前」的原始帧上做（合成后全图不透明，alpha 检测失效）
        const opaque = countOpaquePixels(frame.canvas);
        if (opaque === 0) blankCount += 1;

        // 背景合成：垫底出不透明成品帧（裁剪帧按同区域裁背景对位）；无背景则保持透明底
        const finalCanvas = bgImage
          ? compositeOnBackground(frame.canvas, bgImage, cropRegion)
          : frame.canvas;
        if (nextThumbs.length < 12) {
          nextThumbs.push({ name: frame.name, dataUrl: finalCanvas.toDataURL() });
        }

        if (pngOn) {
          const blob = await canvasToPngBlob(finalCanvas);
          if (serverSave) {
            await saveToBadgeAssets(`${outDir}/${motionPrefix}${frame.name}.png`, blob);
          } else {
            downloadBlob(`${frame.name}.png`, blob);
            await sleep(260);
          }
          fileNames.push(`${frame.name}.png`);
        }
        if (binOn) {
          const bytes = canvasToRgb565(finalCanvas);
          console.log(
            `[badgeExport] ${frame.name}.bin 字节=${bytes.length}`
            + `（期望 ${finalCanvas.width * finalCanvas.height * 2}）角色不透明像素=${opaque}`,
          );
          const blob = new Blob([bytes], { type: 'application/octet-stream' });
          if (serverSave) {
            await saveToBadgeAssets(`${outDir}/${motionPrefix}${frame.name}.bin`, blob);
          } else {
            downloadBlob(`${frame.name}.bin`, blob);
            await sleep(260);
          }
          fileNames.push(`${frame.name}.bin`);
        }
      }

      // motions/<motionDir>/meta.json：与 speak 组同款 snake_case 契约（fps/loop/trigger/
      // start_idx/frame_mads）。abp-pack 只解析 fps/loop/trigger/mouth_anchors，多出字段无害。
      if (motionDir) {
        const meta = {
          fps: extra?.fps,
          loop: true,
          trigger: motionDir,
          start_idx: extra?.startIdx ?? 0,
          frame_mads: extra?.frameMads ?? [],
        };
        const metaBlob = new Blob([JSON.stringify(meta, null, 2)], { type: 'application/json' });
        if (serverSave) {
          await saveToBadgeAssets(`${outDir}/${motionPrefix}meta.json`, metaBlob);
        } else {
          downloadBlob(`${motionDir}_meta.json`, metaBlob);
        }
      }

      const size = cropRegion
        ? { w: cropRegion.w, h: cropRegion.h }
        : { w: VIEW, h: VIEW };
      const record: BadgeExportRecord = {
        avatarId,
        kind,
        label: extra?.label,
        region: cropRegion ? { ...cropRegion } : 'full',
        frames: fileNames,
        size,
        formats: [pngOn ? 'png' : null, binOn ? 'bin' : null].filter((f): f is string => f !== null),
        params: extra?.params,
        fps: extra?.fps,
        background: bgImage ? bgPath.trim() : undefined,
        frameMads: extra?.frameMads,
        startIdx: extra?.startIdx,
        createdAt: new Date().toISOString(),
      };
      const nextRecords = [...recordsRef.current, record];
      recordsRef.current = nextRecords;
      setRecords(nextRecords);
      setThumbs(nextThumbs);

      // 落盘模式：每组导出后同步刷新该目录的 manifest.json
      if (serverSave) {
        const manifestBlob = new Blob(
          [JSON.stringify(buildManifest(nextRecords), null, 2)],
          { type: 'application/json' },
        );
        await saveToBadgeAssets(`${outDir}/manifest.json`, manifestBlob);
      }

      const zeroDiff = adjacentDiffs.filter((d) => d === 0).length;
      const checkNote = adjacentDiffs.length > 0
        ? `，相邻帧差异 min=${Math.min(...adjacentDiffs)}px${zeroDiff > 0 ? `（⚠ ${zeroDiff} 对相邻帧完全相同）` : ''}`
        : '';
      // 循环观感诊断：相邻帧 MAD 峰值超阈值时提示该动作在此 fps 下有强运动段（导出时暴露风险，别等烧板）
      const maxMad = extra?.frameMads?.length ? Math.max(...extra.frameMads) : null;
      const startIdxNote = extra?.startIdx !== undefined
        ? `，起拍 start_idx=${extra.startIdx}（谷值 MAD=${(extra.frameMads?.[extra.startIdx] ?? 0).toFixed(2)}）`
        : '';
      const madNote = maxMad !== null
        ? `${startIdxNote}，相邻帧 MAD 峰值 ${maxMad.toFixed(1)}${maxMad > LOOP_MAD_WARN
          ? `。⚠ 该动作在此 fps 下有强运动段（>${LOOP_MAD_WARN}），观感可能类似跳变，建议提高 fps 或换柔和动作`
          : ''}`
        : '';
      setStatus(
        blankCount > 0
          ? `⚠ ${blankCount}/${frames.length} 帧完全透明（空白），请检查构图或等模型加载完成`
          : `已导出 ${frames.length} 帧（${kind}${extra?.label ? `/${extra.label}` : ''}，${size.w}×${size.h}`
            + `${serverSave ? `，落盘 badge-assets/${outDir}/${motionPrefix}` : ''}）${checkNote}${madNote}`,
      );
    } catch (error) {
      console.error('[badgeExport] 导出失败：', error);
      setStatus(`导出失败：${error instanceof Error ? error.message : String(error)}`);
      throw error;
    } finally {
      setExporting(false);
    }
  }

  /** 单帧状态立绘 */
  async function handleCaptureState() {
    const crop = effectiveRegion();
    const name = `${avatarId}_state_${stateKind}${crop ? '_crop' : ''}`;
    await exportGroup('state', [{ name, canvas: captureCanvas(crop) }], crop, { label: stateKind });
  }

  /**
   * 眨眼序列：眼参数按三角波 1→0→1 共 N 帧。同一 JS tick 内连拍——期间 ticker 不运行、
   * 动作/物理时间不推进（每帧仅垫 1µs），帧间唯一变化就是眼参数，硬件逐帧播放不会有身体漂移。
   */
  async function handleCaptureBlink() {
    const ids = [eyeLId.trim(), eyeRId.trim()].filter(Boolean);
    if (ids.length === 0) {
      setStatus('请先填写眼参数 id');
      return;
    }
    const crop = effectiveRegion();
    const n = clamp(Math.round(blinkN), 2, 30);
    const frames: { name: string; canvas: HTMLCanvasElement }[] = [];
    const values: number[] = [];
    try {
      for (let i = 0; i < n; i += 1) {
        const t = i / (n - 1);
        // 放大 1.25 倍再下钳的三角波：1→0→1，且中段保证完全闭眼
        // （纯三角波在偶数帧数下永远到不了 0，眨眼会「闭不上」）。
        // N=6 → [1, 0.5, 0, 0, 0.5, 1]
        const value = clamp(1.25 * Math.abs(1 - 2 * t) - 0.25, 0, 1);
        values.push(value);
        for (const id of ids) burstMapRef.current.set(id, value);
        frames.push({
          name: `${avatarId}_blink_${String(i).padStart(2, '0')}${crop ? '_crop' : ''}`,
          canvas: captureCanvas(crop),
        });
      }
    } finally {
      burstMapRef.current.clear();
    }
    await exportGroup('blink', frames, crop, { params: { ids, values } });
  }

  /** 口型三帧：嘴参数 0 / 0.5 / 1.0（同 tick 连拍，配合手动框选的裁剪区）。 */
  async function handleCaptureMouth() {
    const id = mouthId.trim();
    if (!id) {
      setStatus('请先填写嘴参数 id');
      return;
    }
    const crop = effectiveRegion();
    const frames: { name: string; canvas: HTMLCanvasElement }[] = [];
    try {
      for (const step of MOUTH_FRAME_VALUES) {
        burstMapRef.current.set(id, step.value);
        frames.push({
          name: `${avatarId}_mouth_${step.suffix}${crop ? '_crop' : ''}`,
          canvas: captureCanvas(crop),
        });
      }
    } finally {
      burstMapRef.current.clear();
    }
    await exportGroup('mouth', frames, crop, {
      params: { ids: [id], values: MOUTH_FRAME_VALUES.map((s) => s.value) },
    });
  }

  /**
   * 口型 5 档（自动嘴部区域）：先抓嘴 0 / 嘴 1 两张全帧做像素 diff 求变化包围盒
   * （外扩 pad、偶数对齐），再按该区域连拍 0/0.25/0.5/0.75/1 五帧裁剪导出。
   * 其余 Mouth* 参数钉在基线值（防表情/动作曲线干扰），但被扫描的嘴参数本身必须放行——
   * 钉住它口型 5 档就全被钉成基线闭嘴，档间无差异（真机说话嘴巴没变化）。
   * 采集后自检 level_0 vs level_4 diff（fail-fast），无差异整组不落盘。
   */
  async function handleCaptureMouthAuto() {
    const id = mouthId.trim();
    if (!id) {
      setStatus('请先填写嘴参数 id');
      return;
    }
    const runtime = runtimeRef.current;
    if (!runtime) {
      setStatus('模型尚未就绪');
      return;
    }
    const frames: { name: string; canvas: HTMLCanvasElement }[] = [];
    let bbox: ExportRegion | null = null;
    try {
      // 其余嘴部参数钉基线（排除被扫描的 id），隔离表情/动作对嘴 region 的干扰
      for (const [pid, value] of collectMouthBaseline(runtime, [], id)) {
        burstMapRef.current.set(pid, value);
      }
      // 连拍两对 0/1 全帧，各求 diff 包围盒后取交集：单对偶发的瞬态抖动（物理时间跳变等）
      // 不会在两对中重复出现，交集稳定收敛到真实嘴部区域。
      burstMapRef.current.set(id, 0);
      const closedA = captureCanvas(null);
      burstMapRef.current.set(id, 1);
      const openedA = captureCanvas(null);
      burstMapRef.current.set(id, 0);
      const closedB = captureCanvas(null);
      burstMapRef.current.set(id, 1);
      const openedB = captureCanvas(null);
      bbox = intersectRegions(
        diffBoundingBox(closedA, openedA, MOUTH_BBOX_PAD),
        diffBoundingBox(closedB, openedB, MOUTH_BBOX_PAD),
      );
      if (!bbox) {
        setStatus(`嘴参数 ${id} 从 0→1 无像素变化，无法自动求嘴部区域（换个参数 id 试试）`);
        return;
      }
      // 档位 0 同姿态全帧存为说话连拍的锚点模板基线（与嘴贴图零姿态差）
      mouthBaselineRef.current = { avatarId, canvas: closedB };
      for (const value of MOUTH_AUTO_LEVELS) {
        burstMapRef.current.set(id, value);
        frames.push({
          name: `${avatarId}_mouth_${String(Math.round(value * 100)).padStart(3, '0')}`,
          canvas: captureCanvas(bbox),
        });
      }
    } finally {
      burstMapRef.current.clear();
    }
    // fail-fast：首末档必须有显著像素差异，否则整组不落盘
    const levelsError = checkMouthLevelsDiff(frames, bbox);
    if (levelsError) {
      setStatus(`⚠ 口型 5 档采集失败，整组未导出：${levelsError}`);
      return;
    }
    setRegion(bbox); // 顺带显示在视口里，便于人工核对
    await exportGroup('mouth', frames, bbox, {
      params: { ids: [id], values: [...MOUTH_AUTO_LEVELS] },
    });
  }

  /**
   * 待机动作连拍：让待机动作/物理（呼吸、摇摆）以合成时间步进（每帧恰好 1/fps 秒）推进，
   * 连抓 N 帧全屏帧。需关闭「冻结动作」，否则只有呼吸物理在动。
   */
  async function handleCaptureIdleMotion() {
    const n = clamp(Math.round(idleFrames), 2, 1400);
    const fps = clamp(idleFps, 1, 60);
    const stepMs = 1000 / fps;
    const runtime = runtimeRef.current;

    // —— 程序化闭环烘焙：机制全在 badgeBake 库（极限环收敛+证书），页面只组 profile ——
    // 帧数自动 = fps×驱动周期（sine=2.6s 实验曲线为 IDLE_BADGE_PERIOD_S；motion=时长×倍数），
    // 「帧数」输入框对本分支不再生效（防呆：周期错配是旧版最大坑源）。
    if (idleParametric) {
      if (!runtime) { setStatus('模型尚未就绪'); return; }
      if (!freeze) { setStatus('程序化微动需先勾选「冻结动作」（停掉引擎待机循环，参数由曲线全权驱动）'); return; }
      const driver: BakeDriverConfig = idleMotionDrive
        ? { kind: 'motion', url: idleMotionUrl.trim(), wobble: idleWobble, loopMult: clamp(Math.round(idleLoopMult), 1, 4) }
        : {
            kind: 'custom',
            periodS: IDLE_BADGE_PERIOD_S,
            evalParams: (t) => [...evalIdleBadgeAngles(t), ...evalIdleBadgeFinal(t)],
            evalEyes: (t) => {
              const open = blinkEyeOpen(t);
              return [['ParamEyeLOpen', open], ['ParamEyeROpen', open]] as Array<[string, number]>;
            },
          };
      const view = idleCardNative
        ? { w: CARD_W, h: CARD_H, stageScale: CARD_H / VIEW, stageOffsetX: -(VIEW * (CARD_H / VIEW) - CARD_W) / 2 }
        : { w: VIEW, h: VIEW, stageScale: 1, stageOffsetX: 0 };
      try {
        const result = await bakeIdle(runtime, { fps, driver, view }, (p) => {
          if (p.phase === 'warmup') setStatus(`物理预热 圈${p.cycle}/${p.maxCycles} 粒子残差 ${p.residual.toFixed(5)}`);
          else if (p.phase === 'capture') setStatus(`${p.align ? '对齐重采' : '采集'} ${p.frame}/${p.total} 帧…`);
          else setStatus(`口型套件：${p.step}`);
        });
        const captured = result.frames.map((canvas, i) => ({
          name: `${avatarId}_idlemotion_${String(i).padStart(2, '0')}`,
          canvas,
        }));
        const cert = result.certificate;
        const verdict = `${cert.pass ? '✅' : '❌'} 回卷MAD=${cert.wrapMad.toFixed(2)} 中位=${cert.medianMad.toFixed(2)}`
          + `｜预热${cert.warmupCycles}圈 残差=${Number.isFinite(cert.residual) ? cert.residual.toFixed(5) : '未测'}`
          + (cert.reason ? `｜${cert.reason}` : '');
        console.log(`[badgeExport] ${verdict}`);
        await exportGroup('idle_motion', captured, null, { fps, frameMads: result.frameMads, startIdx: result.startIdx, motionDir: 'idle' });
        setStatus((s) => `${s}｜${verdict}`);
      } catch (error) {
        setStatus(`烘焙失败：${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }

    // —— 旧行为：抓当前自动播放的待机动作/物理 ——
    if (warmupOn) {
      for (let i = 0; i < 2 * n; i += 1) advanceModelTime(stepMs);
    }
    const captured: { name: string; canvas: HTMLCanvasElement }[] = [];
    for (let i = 0; i < n; i += 1) {
      captured.push({
        name: `${avatarId}_idlemotion_${String(i).padStart(2, '0')}`,
        canvas: captureCanvas(null, i === 0 ? 0.001 : stepMs),
      });
    }
    const { mads, startIdx } = analyzeLoop(captured);
    await exportGroup('idle_motion', captured, null, { fps, frameMads: mads, startIdx, motionDir: 'idle' });
  }

  /**
   * 说话动作连拍（嘴锚点）：播放指定动作、逐帧以合成时间步进（每帧恰 1/fps 秒），期间把全部嘴部
   * 参数钉在姿态基线的值上（硬件端嘴部贴图单独叠加，身体帧本身不该带张嘴）。每帧相对冻结姿态
   * 基线做嘴部区域模板匹配求平移偏移 (dx,dy)，写入 meta.json 的 mouth_anchors——硬件按帧号取
   * 偏移贴嘴部局部贴图，保证嘴不随身体动作错位。
   * 物理预热（默认开）：起播动作后先按 1/fps 空跑 2 个完整周期（每周期后重启动作），发丝物理
   * 进入与 n 帧窗口同周期的稳态轨道后再抓帧，循环首尾自然接近。预热后帧 0 的身体在动作轨道上，
   * 允许非零锚点偏移（记录真实匹配值），只要求残差在容差内。
   * 前置条件：需先跑「口型 5 档（自动嘴部区域）」或手动框选出嘴部 region（复用 `region` state）。
   * 抓前自检（fail-fast）：帧 0 对基线模板匹配的最优残差超容差直接报错，不进入逐帧连拍——该模型
   * 嘴部可能受 `mouthId` 之外的参数驱动（如动作曲线驱动非标嘴参数），只钉 mouthId 会导致嘴部
   * 烤入张嘴、锚点全部匹配到下巴皮肤，提早在帧 0 就发现比 n 帧都抓完在真机上才看出来快得多。
   * 失败即整组不落盘：① 帧 0 自检残差超容差（嘴部未钉住/漂移超半径）；② 逐帧残差超容差
   * （body 姿态使模板匹配不可靠，标红该帧、提示换动作或调容差）。
   */
  async function handleCaptureSpeak() {
    if (!freeze) {
      setStatus('请先勾选「冻结动作」再连拍（姿态基线要求）');
      return;
    }
    if (!speakMotion) {
      setStatus('请先选择说话动作');
      return;
    }
    const mouthRegion = region;
    if (!mouthRegion) {
      setStatus('请先跑「口型 5 档（自动嘴部区域）」或手动框选出嘴部 region');
      return;
    }
    const runtime = runtimeRef.current;
    if (!runtime || !resolved) {
      setStatus('模型尚未就绪');
      return;
    }
    const mId = mouthId.trim();
    if (!mId) {
      setStatus('请先填写嘴参数 id');
      return;
    }
    const n = clamp(Math.round(speakFrames), 2, 240);
    const fps = clamp(speakFps, 1, 60);
    const radius = clamp(Math.round(speakRadius), 1, 64);
    const tolerance = Math.max(0, speakTolerance);
    const stepMs = 1000 / fps;
    setExporting(true);
    setSpeakAnchors([]);
    try {
      const burst = burstMapRef.current;

      // D2 修复①：其余嘴部参数钉在姿态基线值，mId 钉 0——与口型档位采集的档位 0 完全同参数
      // 状态（嘴贴图 level_0 就是 mId=0 抓的，身体帧必须与它同姿态才能无缝叠加）。
      const mouthBaseline = collectMouthBaseline(runtime, [], mId);
      mouthBaseline.set(mId, 0);
      const pinMouth = () => {
        for (const [id, value] of mouthBaseline) burst.set(id, value);
      };

      // 嘴锚点模板基线：优先用口型档位采集时存下的「档位 0 同姿态全帧」（与嘴贴图零姿态差）；
      // 没有（如手动框选 region）则现抓冻结沉降姿态一帧。
      pinMouth();
      const stored = mouthBaselineRef.current;
      const usingStoredBaseline = stored !== null && stored.avatarId === avatarId;
      const baselineCanvas = usingStoredBaseline ? stored.canvas : captureCanvas(null, 0.001);
      const baselineRgba = canvasRgba(baselineCanvas);
      console.log(`[badgeExport] 说话连拍锚点模板基线：${usingStoredBaseline ? '口型档位采集的档位0帧' : '现抓冻结帧'}`);

      // 起播说话动作（异步）；起播完成后才开始按合成时间步进连拍，动作因此从头播放。
      await startMotion(runtime, resolved, speakMotion);

      // 物理预热：动作+物理以同样的 1/fps 步进空跑 2 个完整周期（2×n 步，不抓帧），每个周期后
      // 重启动作——发丝物理进入与「n 帧窗口」同周期的稳态轨道，循环首尾自然接近。
      if (warmupOn) {
        for (let cycle = 0; cycle < 2; cycle += 1) {
          for (let i = 0; i < n; i += 1) advanceModelTime(stepMs);
          await startMotion(runtime, resolved, speakMotion);
        }
      }

      // D2 修复②：抓前自检（fail-fast）——帧 0 嘴 region 对基线做模板匹配（上下文外扩窗口），
      // 最优残差超容差立即报错，不进入后续 n 帧连拍。口型没钉住时残差必然超标。
      // 预热后身体处于动作轨道上，帧 0 允许非零平移（锚点记录真实偏移），但残差必须在容差内。
      pinMouth();
      const frame0Canvas = captureCanvas(null, 0.001);
      const frame0Rgba = canvasRgba(frame0Canvas);
      const selfCheck = findMouthAnchor(baselineRgba, frame0Rgba, VIEW, mouthRegion, radius, ANCHOR_CONTEXT_PAD);
      if (selfCheck.residual > tolerance) {
        setStatus(
          `⚠ 说话连拍失败：口型未钉住或基线漂移超匹配半径（帧0嘴区残差 ${selfCheck.residual.toFixed(1)} 超容差 ${tolerance}），`
          + `检查嘴部参数（已钉：${[...mouthBaseline.keys()].join(', ')}）或调大匹配半径`,
        );
        return;
      }

      const canvases: HTMLCanvasElement[] = [frame0Canvas];
      const rgbas: Uint8ClampedArray[] = [frame0Rgba];
      const anchors: AnchorMatch[] = [selfCheck];
      let failReason: string | null = null;
      /** 边界拒绝：|dx| 或 |dy| 顶到半径 = 真位置在搜索窗外，该帧匹配不可信。 */
      const atBoundary = (m: AnchorMatch) => Math.abs(m.dx) === radius || Math.abs(m.dy) === radius;
      if (atBoundary(selfCheck)) {
        failReason = `第 0 帧锚点 [${selfCheck.dx},${selfCheck.dy}] 顶到搜索边界 ±${radius}（真位置在窗外），调大匹配半径`;
      }
      for (let i = 1; i < n; i += 1) {
        pinMouth();
        const canvas = captureCanvas(null, stepMs);
        const rgba = canvasRgba(canvas);
        const match = findMouthAnchor(baselineRgba, rgba, VIEW, mouthRegion, radius, ANCHOR_CONTEXT_PAD);
        anchors.push(match);
        canvases.push(canvas);
        rgbas.push(rgba);

        if (match.residual > tolerance) {
          failReason = failReason
            ?? `第 ${i} 帧残差 ${match.residual.toFixed(1)} 超容差 ${tolerance}，换个动作或调大容差后重试`;
        } else if (atBoundary(match)) {
          failReason = failReason
            ?? `第 ${i} 帧锚点 [${match.dx},${match.dy}] 顶到搜索边界 ±${radius}（真位置在窗外），调大匹配半径`;
        } else {
          // 平滑性硬门：正常身体摆动在 5-7fps 下相邻帧锚点不会跳 10px 以上（跳=假匹配）
          const step = Math.abs(match.dx - anchors[i - 1].dx) + Math.abs(match.dy - anchors[i - 1].dy);
          if (step > ANCHOR_MAX_STEP) {
            failReason = failReason
              ?? `第 ${i - 1}→${i} 帧锚点位移 ${step}px 超平滑门限 ${ANCHOR_MAX_STEP}（假匹配嫌疑），检查嘴部region/半径`;
          }
        }
      }
      setSpeakAnchors(anchors);

      if (failReason) {
        setStatus(`⚠ 说话连拍失败，整组未导出：${failReason}`);
        return;
      }

      // 帧序保持抓拍自然序不动（帧 0 = 基线，固件位级不变量）。速度谷只算不转，谷下标随
      // meta.json 的 start_idx 落盘，由固件起播时使用——环形循环内任何相邻对的 MAD 不受
      // 帧序影响，起拍相位交给消费侧处理。
      const mads = adjacentLoopMads(rgbas);
      const startIdx = findLoopValleyIndex(rgbas);
      setSpeakAnchors(anchors);

      // D1 修复：落盘前走与「全套对齐连拍」同一个背景合成函数（垫底 bgImage → 不透明成品）。
      const fileNames: string[] = [];
      for (let i = 0; i < canvases.length; i += 1) {
        const name = `${avatarId}_speak_frame_${String(i).padStart(3, '0')}`;
        const finalCanvas = bgImage ? compositeOnBackground(canvases[i], bgImage, null) : canvases[i];
        const blob = await canvasToPngBlob(finalCanvas);
        if (serverSave) {
          await saveToBadgeAssets(`${outDir}/motions/speak/${name}.png`, blob);
        } else {
          downloadBlob(`${name}.png`, blob);
          await sleep(260);
        }
        fileNames.push(`${name}.png`);
      }
      // 预热后帧 0 允许非零偏移（身体在动作轨道上），全部帧记录真实匹配锚点；frame_mads 仅诊断
      const roundedMads = mads.map((m) => Math.round(m * 100) / 100);
      const meta = {
        fps,
        loop: true,
        trigger: 'speak',
        start_idx: startIdx,
        mouth_anchors: anchors.map((a) => [a.dx, a.dy]),
        frame_mads: roundedMads,
      };
      if (serverSave) {
        await saveToBadgeAssets(
          `${outDir}/motions/speak/meta.json`,
          new Blob([JSON.stringify(meta, null, 2)], { type: 'application/json' }),
        );
      } else {
        downloadBlob('speak_meta.json', new Blob([JSON.stringify(meta, null, 2)], { type: 'application/json' }));
      }

      const record: BadgeExportRecord = {
        avatarId,
        kind: 'speak_motion',
        label: speakMotion,
        region: 'full',
        frames: fileNames,
        size: { w: VIEW, h: VIEW },
        formats: ['png'],
        fps,
        background: bgImage ? bgPath.trim() : undefined,
        frameMads: roundedMads,
        startIdx,
        createdAt: new Date().toISOString(),
      };
      const nextRecords = [...recordsRef.current, record];
      recordsRef.current = nextRecords;
      setRecords(nextRecords);

      const maxResidual = Math.max(...anchors.map((a) => a.residual));
      const maxStep = Math.max(...anchors.map((a, i) => {
        const prev = anchors[(i - 1 + anchors.length) % anchors.length];
        return Math.abs(a.dx - prev.dx) + Math.abs(a.dy - prev.dy);
      }));
      const maxMad = Math.max(...mads);
      setStatus(
        `说话动作连拍完成：${n} 帧 @ ${fps}fps（动作=${speakMotion}），锚点最大残差 ${maxResidual.toFixed(1)}`
        + `（容差 ${tolerance}），相邻锚点最大位移 ${maxStep}px，起拍 start_idx=${startIdx}`
        + `（谷值 MAD=${mads[startIdx].toFixed(1)}，峰值 ${maxMad.toFixed(1)}）`
        + `${serverSave ? `，落盘 badge-assets/${outDir}/motions/speak/` : ''}`
        + (maxMad > LOOP_MAD_WARN
          ? `。⚠ 该动作在此 fps 下有强运动段（相邻帧 MAD 峰值 ${maxMad.toFixed(1)}>${LOOP_MAD_WARN}），观感可能类似跳变，建议提高 fps 或换柔和动作`
          : ''),
      );
    } catch (error) {
      console.error('[badgeExport] 说话动作连拍失败：', error);
      setStatus(`说话动作连拍失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      burstMapRef.current.clear();
      setExporting(false);
    }
  }

  /**
   * 聆听表情提取：在姿态基线上分别抓「基线」与「聆听表情」两帧，像素 diff 求局部区域
   * （眼睛高亮/星星等聆听态特征区）。裁剪该区域落盘为局部贴图，供硬件端叠加播放聆听态。
   * 失败：diff 为 null（表情选得不对，画面无变化）或 region 大于屏幕 1/4（选到了影响全身的表情，
   * 不该按局部贴图处理）。
   */
  async function handleCaptureListenExpr() {
    if (!freeze) {
      setStatus('请先勾选「冻结动作」再连拍（姿态基线要求）');
      return;
    }
    if (!listenExpr) {
      setStatus('请先选择聆听表情');
      return;
    }
    const runtime = runtimeRef.current;
    if (!runtime || !resolved) {
      setStatus('模型尚未就绪');
      return;
    }
    setExporting(true);
    try {
      // 基线：当前表情（通常 neutral）
      const baselineCanvas = captureCanvas(null, 0.001);
      const baselineRgba = canvasRgba(baselineCanvas);

      await applyExpressionMix(runtime, resolved, [{ key: listenExpr, weight: 1 }]);
      const exprCanvas = captureCanvas(null, 0.001);
      const exprRgba = canvasRgba(exprCanvas);

      const diffRegion = computeDiffRegion(baselineRgba, exprRgba, VIEW, VIEW, 8, 4);
      if (!diffRegion) {
        setStatus(`表情 ${listenExpr} 相对基线无像素变化，无法提取聆听区域（换个表情试试）`);
        return;
      }
      const maxArea = (VIEW * VIEW) / 4;
      if (diffRegion.w * diffRegion.h > maxArea) {
        setStatus(
          `表情 ${listenExpr} 的差异区域 ${diffRegion.w}×${diffRegion.h} 超过屏幕 1/4，`
          + '不适合做局部贴图（选到了影响全身的表情，换一个）',
        );
        return;
      }

      const cropped = document.createElement('canvas');
      cropped.width = diffRegion.w;
      cropped.height = diffRegion.h;
      cropped.getContext('2d')?.drawImage(
        exprCanvas,
        diffRegion.x, diffRegion.y, diffRegion.w, diffRegion.h,
        0, 0, diffRegion.w, diffRegion.h,
      );

      const blob = await canvasToPngBlob(cropped);
      if (serverSave) {
        await saveToBadgeAssets(`${outDir}/eyes/frame_000.png`, blob);
        await saveToBadgeAssets(
          `${outDir}/eyes/meta.json`,
          new Blob([JSON.stringify({ region: diffRegion }, null, 2)], { type: 'application/json' }),
        );
      } else {
        downloadBlob('eyes_frame_000.png', blob);
        await sleep(260);
        downloadBlob(
          'eyes_meta.json',
          new Blob([JSON.stringify({ region: diffRegion }, null, 2)], { type: 'application/json' }),
        );
      }

      const record: BadgeExportRecord = {
        avatarId,
        kind: 'listen_expr',
        label: listenExpr,
        region: diffRegion,
        frames: ['frame_000.png'],
        size: { w: diffRegion.w, h: diffRegion.h },
        formats: ['png'],
        createdAt: new Date().toISOString(),
      };
      const nextRecords = [...recordsRef.current, record];
      recordsRef.current = nextRecords;
      setRecords(nextRecords);
      setStatus(
        `聆听表情提取完成：${listenExpr}，区域 ${diffRegion.x},${diffRegion.y} ${diffRegion.w}×${diffRegion.h}`
        + `${serverSave ? `，落盘 badge-assets/${outDir}/eyes/` : ''}`,
      );
    } catch (error) {
      console.error('[badgeExport] 聆听表情提取失败：', error);
      setStatus(`聆听表情提取失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      // 恢复到当前选中表情（避免残留聆听表情影响后续其它组抓帧）
      try { await applyExpressionMix(runtime, resolved, [{ key: activeExpr, weight: 1 }]); } catch { /* ignore */ }
      setExporting(false);
    }
  }

  /**
   * 闭眼 blink 贴图（对位眨眼方案 A）：冻结态下同一 tick 抓「睁眼(param=1)」与
   * 「闭眼(param=0)」两帧——只改眼参、物理冻结→无耳/发级联(§4 病根)，diff 求眼区包围盒，
   * 裁「闭眼」帧 = 单张闭眼贴图 + region。冻结姿态=嘴锚点的参考基线→region 天然对齐
   * 锚点(0,0)，固件复用 mouth_anchors 逐帧偏移即跟头转。落 eyes/frame_000.png + meta。
   */
  async function handleCaptureBlinkSprite() {
    if (!freeze) {
      setStatus('请先勾选「冻结动作」再抓闭眼贴图（姿态基线=锚点(0,0)，须与嘴锚点同参考）');
      return;
    }
    const ids = [eyeLId.trim(), eyeRId.trim()].filter(Boolean);
    if (ids.length === 0) {
      setStatus('请先填写眼参数 id');
      return;
    }
    setExporting(true);
    try {
      for (const id of ids) burstMapRef.current.set(id, 1);   // 睁眼基线
      const openCanvas = captureCanvas(null, 0.001);
      const openRgba = canvasRgba(openCanvas);

      for (const id of ids) burstMapRef.current.set(id, 0);   // 闭眼（同 tick 仅改眼参）
      const closedCanvas = captureCanvas(null, 0.001);
      const closedRgba = canvasRgba(closedCanvas);

      /* 眼区包围盒：睁↔闭是大色变(蓝虹膜→肤色, >100/通道)，而 canvas 回读噪声≤8/通道且
       * 零散。computeDiffRegion(阈8, 逐像素) 会被角落几个噪点撑爆全屏。改用「块聚类」：
       * 8px 块内高阈(40)变化像素≥4 才算变化块 → 天然滤掉孤立噪点。偶对齐。
       * ★中央 ROI 门控：眼睛恒在脸部中上(实测 x196~284/y124~156)，而蝙蝠翅/耳/发是
       * 两侧摆链、物理不收敛(settlePose 不 settle)→睁闭两帧间抖动会混进眼区。只在中央带
       * [x 0.32~0.69, y 0.19~0.47]VIEW 内找变化块=确定性排除两侧饰件抖动。 */
      const roiX0 = Math.round(VIEW * 0.32), roiX1 = Math.round(VIEW * 0.69);
      const roiY0 = Math.round(VIEW * 0.19), roiY1 = Math.round(VIEW * 0.47);
      const BLK = 8, PIXTH = 40, MINCNT = 4;
      let bx0 = VIEW, by0 = VIEW, bx1 = -1, by1 = -1;
      for (let gy = roiY0; gy < roiY1; gy += BLK) {
        for (let gx = roiX0; gx < roiX1; gx += BLK) {
          let cnt = 0;
          for (let y = gy; y < Math.min(gy + BLK, VIEW); y++) {
            for (let x = gx; x < Math.min(gx + BLK, VIEW); x++) {
              const o = (y * VIEW + x) * 4;
              if (Math.abs(openRgba[o] - closedRgba[o]) > PIXTH
                || Math.abs(openRgba[o + 1] - closedRgba[o + 1]) > PIXTH
                || Math.abs(openRgba[o + 2] - closedRgba[o + 2]) > PIXTH) cnt++;
            }
          }
          if (cnt >= MINCNT) {
            if (gx < bx0) bx0 = gx;
            if (gx + BLK > bx1) bx1 = gx + BLK;
            if (gy < by0) by0 = gy;
            if (gy + BLK > by1) by1 = gy + BLK;
          }
        }
      }
      if (bx1 < 0) {
        setStatus('睁/闭眼无显著像素差异——检查眼参数 id / 冻结是否生效');
        return;
      }
      const PAD = 4;
      bx0 = Math.max(0, (bx0 - PAD) & ~1);
      by0 = Math.max(0, (by0 - PAD) & ~1);
      bx1 = Math.min(VIEW, (bx1 + PAD + 1) & ~1);
      by1 = Math.min(VIEW, (by1 + PAD + 1) & ~1);
      const diffRegion = { x: bx0, y: by0, w: bx1 - bx0, h: by1 - by0 };
      const maxArea = (VIEW * VIEW) / 4;
      if (diffRegion.w * diffRegion.h > maxArea) {
        setStatus(
          `闭眼差异区 ${diffRegion.w}×${diffRegion.h} 超屏 1/4——物理级联未冻住？`
          + '（确认「冻结动作」已勾选、breath/physics 已停）',
        );
        return;
      }

      const cropped = document.createElement('canvas');
      cropped.width = diffRegion.w;
      cropped.height = diffRegion.h;
      cropped.getContext('2d')?.drawImage(
        closedCanvas,
        diffRegion.x, diffRegion.y, diffRegion.w, diffRegion.h,
        0, 0, diffRegion.w, diffRegion.h,
      );

      const blob = await canvasToPngBlob(cropped);
      if (serverSave) {
        await saveToBadgeAssets(`${outDir}/eyes/frame_000.png`, blob);
        await saveToBadgeAssets(
          `${outDir}/eyes/meta.json`,
          new Blob([JSON.stringify({ region: diffRegion }, null, 2)], { type: 'application/json' }),
        );
      } else {
        downloadBlob('eyes_frame_000.png', blob);
        await sleep(260);
        downloadBlob(
          'eyes_meta.json',
          new Blob([JSON.stringify({ region: diffRegion }, null, 2)], { type: 'application/json' }),
        );
      }
      setStatus(
        `闭眼贴图提取完成：区域 ${diffRegion.x},${diffRegion.y} ${diffRegion.w}×${diffRegion.h}`
        + `${serverSave ? `，落盘 badge-assets/${outDir}/eyes/` : ''}`,
      );
    } catch (error) {
      console.error('[badgeExport] 闭眼贴图提取失败：', error);
      setStatus(`闭眼贴图提取失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      burstMapRef.current.clear();
      setExporting(false);
    }
  }

  /** 错误状态帧：466×466 纯黑底 + 白字两行「连接失败」「重试中…」，居中，圆屏安全区内。 */
  async function handleCaptureErrorState() {
    setExporting(true);
    try {
      const canvas = document.createElement('canvas');
      canvas.width = VIEW;
      canvas.height = VIEW;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('无法创建 2d 上下文');
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, VIEW, VIEW);
      ctx.fillStyle = '#ffffff';
      ctx.font = '48px system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('连接失败', VIEW / 2, VIEW / 2 - 32);
      ctx.fillText('重试中…', VIEW / 2, VIEW / 2 + 32);

      const blob = await canvasToPngBlob(canvas);
      if (serverSave) {
        await saveToBadgeAssets(`${outDir}/states/error.png`, blob);
      } else {
        downloadBlob('error.png', blob);
      }

      const record: BadgeExportRecord = {
        avatarId,
        kind: 'error_state',
        label: 'error',
        region: 'full',
        frames: ['error.png'],
        size: { w: VIEW, h: VIEW },
        formats: ['png'],
        createdAt: new Date().toISOString(),
      };
      const nextRecords = [...recordsRef.current, record];
      recordsRef.current = nextRecords;
      setRecords(nextRecords);
      setStatus(`错误状态帧已导出${serverSave ? `，落盘 badge-assets/${outDir}/states/error.png` : ''}`);
    } catch (error) {
      console.error('[badgeExport] 错误状态帧导出失败：', error);
      setStatus(`错误状态帧导出失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setExporting(false);
    }
  }

  /** 只推进模型时间不取像素：渲染进 4×4 小 RenderTexture（internalModel.update 只在渲染时执行）。 */
  function advanceModelTime(stepMs: number) {
    const runtime = runtimeRef.current;
    if (!runtime) throw new Error('模型尚未就绪');
    runtime.model.update(stepMs);
    const renderer = runtime.app.renderer as PIXI.Renderer;
    const renderTexture = PIXI.RenderTexture.create({ width: 4, height: 4, resolution: 1 });
    renderer.render(runtime.app.stage, { renderTexture });
    renderTexture.destroy(true);
  }

  /**
   * 姿态沉降（合成时间轴，纯同步）：以 33ms 步长推进模型时间，每推进 1 秒对比一次帧差，
   * 差异降到 quietDiff 以下视为沉降完成。不依赖真实 rAF——后台/节流标签页里 ticker 时间
   * 跳变会不断「踢」物理（实测永不沉降），合成时间轴步进平滑、确定性衰减。
   * 注意呼吸是持续振荡（不会衰减到 0），quietDiff 须高于 1 秒呼吸位移的像素差下限。
   */
  function settlePoseSynthetic(maxSeconds = 20, quietDiff = 2000): { settled: boolean; lastDiff: number; seconds: number } {
    let prev = captureCanvas(null);
    let lastDiff = Number.POSITIVE_INFINITY;
    for (let second = 1; second <= maxSeconds; second += 1) {
      for (let i = 0; i < 30; i += 1) advanceModelTime(1000 / 30);
      const current = captureCanvas(null);
      lastDiff = diffPixelCount(prev, current, 48);
      prev = current;
      console.log(`[badgeExport] 沉降 第${second}s 帧差=${lastDiff}px`);
      if (lastDiff <= quietDiff) return { settled: true, lastDiff, seconds: second };
    }
    return { settled: false, lastDiff, seconds: maxSeconds };
  }

  /**
   * 全套对齐连拍：所有组（state/blink/mouth/idle_motion）在**完全相同的身体姿态基线**上采集。
   * 做法：冻结动作 → 等物理沉降 → 同一个 JS tick 内同步连拍全部帧（期间 ticker 不运行、
   * 静态组每帧只垫 1µs，组间零姿态漂移）；idle_motion 第 0 帧同在基线上（1µs），之后每帧
   * 步进 1/fps 秒，由呼吸+物理在合成时间轴上驱动摇摆——首帧与 state/mouth 基线严格一致。
   * 全部采集完成后才逐组异步落盘（此时的姿态漂移不再影响帧内容）。
   * state/blink/idle 全程钳 嘴=0 且其余 Mouth* 参数钉沉降基线值（口型档位采集时放行被扫描的
   * mId 本身），保证 mouth level 0 与底图（state_idle）在裁剪区内无缝、档间差异只来自 mId。
   * 「物理预热」开启时 idle 分组抓帧前先按 1/fps 空跑 2 个完整周期（发丝进入稳态轨道，循环
   * 首尾自然接近），代价是 idle 第 0 帧偏离静止基线（可接受：贴图对位靠 state/mouth 组）。
   */
  async function handleCaptureAllAligned() {
    const eyeIds = [eyeLId.trim(), eyeRId.trim()].filter(Boolean);
    const mId = mouthId.trim();
    if (eyeIds.length === 0 || !mId) {
      setStatus('请先填写眼/嘴参数 id');
      return;
    }
    if (!freeze) {
      setStatus('请先勾选「冻结动作」再全套连拍（基线需要可沉降的静止姿态）');
      return;
    }
    const runtime = runtimeRef.current;
    if (!runtime) {
      setStatus('模型尚未就绪');
      return;
    }
    setExporting(true);
    // 呼吸控制器是持续正弦振荡（实测驱动全身物理 ~10 万 px/s，永不衰减），挡住真正的沉降。
    // 静态组采集期间暂停呼吸（物理输入静止 → 摆动可确定性衰减到 0）；
    // idle_motion 采集前恢复呼吸并把相位归零——sin(0)=0，第 0 帧与无呼吸基线严格连续。
    const internalWithBreath = runtime.model.internalModel as unknown as { breath?: { _currentTime?: number } };
    const savedBreath = internalWithBreath.breath;
    try {
      // ⓪ 确保动作彻底停死（防 setupIdle 异步续段把循环待机动作重新播上——那会让
      //    角度/呼吸/头发参数持续被动作曲线驱动，沉降永不收敛、嘴部 bbox 被污染）。
      const motionManager = runtime.model.internalModel.motionManager as unknown as {
        stopAllMotions?: () => void;
        playing?: boolean;
      };
      runtime.idleMotionKey = null;
      runtime.idleBeatEnabled = false;
      try { motionManager.stopAllMotions?.(); } catch { /* ignore */ }
      if (motionManager.playing) {
        console.warn('[badgeExport] stopAllMotions 后 motionManager 仍在播放，采集可能受动作干扰');
      }

      internalWithBreath.breath = undefined;

      // ① 姿态沉降（合成时间轴，纯同步）：翅膀/头发摆动确定性衰减。
      //    与下方连拍处于同一个 JS tick——沉降完成到采集之间不存在任何真实时间缝隙。
      setStatus('姿态沉降中…（合成时间轴，呼吸已暂停）');
      const settle = settlePoseSynthetic(45, 2000);
      if (!settle.settled) {
        console.warn(`[badgeExport] 沉降未达阈值（${settle.seconds}s 后帧差 ${settle.lastDiff}px），继续采集`);
      }

      // ② 同步连拍全部组（与沉降同一个 tick，姿态零漂移）
      const n = clamp(Math.round(blinkN), 2, 30);
      const idleN = clamp(Math.round(idleFrames), 2, 240);
      const fps = clamp(idleFps, 1, 60);
      const stepMs = 1000 / fps;

      let stateFrame: HTMLCanvasElement;
      const blinkFrames: { name: string; canvas: HTMLCanvasElement }[] = [];
      const blinkValues: number[] = [];
      const mouthFrames: { name: string; canvas: HTMLCanvasElement }[] = [];
      const idleFrameList: { name: string; canvas: HTMLCanvasElement }[] = [];
      let bbox: ExportRegion | null = null;

      const burst = burstMapRef.current;
      try {
        // state 基线：嘴钳 0（眼由滑杆覆盖，默认 1 睁眼）。
        // 其余 Mouth* 参数钉在沉降后的基线值（排除被扫描的 mId）：隔离表情/动作曲线对嘴部的
        // 干扰，且 state/blink/mouth/idle 各组嘴部像素严格一致（贴图与底图无缝）。
        burst.clear();
        for (const [pid, value] of collectMouthBaseline(runtime, [], mId)) {
          burst.set(pid, value);
        }
        burst.set(mId, 0);
        stateFrame = captureCanvas(null);

        // blink：嘴保持 0，眼按带完全闭眼段的三角波
        for (let i = 0; i < n; i += 1) {
          const t = i / (n - 1);
          const value = clamp(1.25 * Math.abs(1 - 2 * t) - 0.25, 0, 1);
          blinkValues.push(value);
          for (const id of eyeIds) burst.set(id, value);
          blinkFrames.push({
            name: `${avatarId}_blink_${String(i).padStart(2, '0')}`,
            canvas: captureCanvas(null),
          });
        }
        for (const id of eyeIds) burst.delete(id); // 眼交还滑杆覆盖值

        // mouth 自动区域：冻结基线下双对 diff 交集（更小更准）
        burst.set(mId, 0);
        const closedA = captureCanvas(null);
        burst.set(mId, 1);
        const openedA = captureCanvas(null);
        burst.set(mId, 0);
        const closedB = captureCanvas(null);
        burst.set(mId, 1);
        const openedB = captureCanvas(null);
        bbox = intersectRegions(
          diffBoundingBox(closedA, openedA, MOUTH_BBOX_PAD),
          diffBoundingBox(closedB, openedB, MOUTH_BBOX_PAD),
        );
        if (!bbox) {
          setStatus(`嘴参数 ${mId} 从 0→1 无像素变化，无法自动求嘴部区域`);
          return;
        }
        // 档位 0 同姿态全帧存为说话连拍的锚点模板基线（与嘴贴图零姿态差）
        mouthBaselineRef.current = { avatarId, canvas: closedB };
        for (const value of MOUTH_AUTO_LEVELS) {
          burst.set(mId, value);
          mouthFrames.push({
            name: `${avatarId}_mouth_${String(Math.round(value * 100)).padStart(3, '0')}`,
            canvas: captureCanvas(bbox),
          });
        }
        // fail-fast：口型首末档必须有显著像素差异（钉死/没驱动上时整套连拍全部不落盘）
        const levelsError = checkMouthLevelsDiff(mouthFrames, bbox);
        if (levelsError) {
          setStatus(`⚠ 全套连拍失败（口型档位自检未过，整套未导出）：${levelsError}`);
          return;
        }

        // idle_motion：嘴钳回 0；恢复呼吸并把相位归零（sin(0)=0），之后（可选）物理预热——
        // 按同样的 1/fps 步进空跑 2 个完整周期（不抓帧），呼吸**自由连续运行**（不做周期性
        // 相位归零！三轮真机教训：每周期归零相位虽能让发丝轨道闭合，但归零瞬间的输入跳变会
        // 在循环头部烤入一次剧烈甩发——v8 实测帧 0→1 MAD 45.65，被 Ben 读作「非常跳」；而
        // 自由呼吸下整循环运动均匀（相邻 MAD ~3），仅回卷处一次 ~12 的呼吸相位差，峰值远小）。
        // 呼吸多条正弦周期互不相通，回卷相位差无法在不改呼吸模型/不加帧数预算下彻底消除，
        // 由 frame_mads + 状态栏峰值警告量化暴露。预热会让 idle 第 0 帧偏离静止基线（身体在
        // 呼吸轨道上），取舍可接受：嘴/眨眼贴图对位靠的是 state/mouth 组间一致，不受影响。
        burst.set(mId, 0);
        if (savedBreath) {
          savedBreath._currentTime = 0;
          internalWithBreath.breath = savedBreath;
        }
        if (warmupOn) {
          for (let i = 0; i < 2 * idleN; i += 1) advanceModelTime(stepMs);
        }
        for (let i = 0; i < idleN; i += 1) {
          idleFrameList.push({
            name: `${avatarId}_idlemotion_${String(i).padStart(2, '0')}`,
            canvas: captureCanvas(null, i === 0 ? 0.001 : stepMs),
          });
        }
      } finally {
        burst.clear();
      }

      // ③ 逐组导出（采集已完成，异步期间的姿态漂移不再影响帧内容）
      setRegion(bbox);
      // idle 分组：起拍 start_idx（速度谷，帧序不动） + frame_mads 观感诊断
      const idleLoop = analyzeLoop(idleFrameList);
      await exportGroup('state', [{ name: `${avatarId}_state_${stateKind}`, canvas: stateFrame }], null, { label: stateKind });
      await exportGroup('blink', blinkFrames, null, { params: { ids: eyeIds, values: blinkValues } });
      await exportGroup('mouth', mouthFrames, bbox, { params: { ids: [mId], values: [...MOUTH_AUTO_LEVELS] } });
      await exportGroup('idle_motion', idleFrameList, null, {
        fps, frameMads: idleLoop.mads, startIdx: idleLoop.startIdx, motionDir: 'idle',
      });
      const idleMaxMad = idleLoop.mads.length ? Math.max(...idleLoop.mads) : 0;
      setStatus(
        `全套对齐连拍完成：state 1 + blink ${n} + mouth ${MOUTH_AUTO_LEVELS.length} + idle ${idleN} 帧同一姿态基线`
        + `（沉降${settle.settled ? `于第 ${settle.seconds}s 完成` : '未达阈值'}，末差 ${settle.lastDiff}px/s），`
        + `嘴部区域 ${bbox.x},${bbox.y} ${bbox.w}×${bbox.h}，idle 起拍 start_idx=${idleLoop.startIdx}`
        + `，相邻帧 MAD 峰值 ${idleMaxMad.toFixed(1)}`
        + (idleMaxMad > LOOP_MAD_WARN
          ? `。⚠ idle 在此 fps 下有强运动段（>${LOOP_MAD_WARN}），观感可能类似跳变，建议提高 fps 或调预热`
          : ''),
      );
    } finally {
      // 兜底恢复呼吸（正常路径已在 idle 采集前恢复；异常提前退出也不能让呼吸永久停掉）
      if (savedBreath) internalWithBreath.breath = savedBreath;
      setExporting(false);
    }
  }

  /**
   * 探针：用两组参数值各抓一帧，返回差异像素数（验证某参数 id 是否真能驱动画面）。
   * threshold 建议 ≥48：相邻两次渲染有少量微动噪声（同参数两帧也有低幅差异）。
   */
  function probeParam(ids: string[], a: number, b: number, threshold = 48): number {
    try {
      for (const id of ids) burstMapRef.current.set(id, a);
      const frameA = captureCanvas(null);
      for (const id of ids) burstMapRef.current.set(id, b);
      const frameB = captureCanvas(null);
      return diffPixelCount(frameA, frameB, threshold);
    } finally {
      burstMapRef.current.clear();
    }
  }

  function handleDownloadManifest() {
    downloadBlob(
      'badge_manifest.json',
      new Blob([JSON.stringify(buildManifest(records), null, 2)], { type: 'application/json' }),
    );
  }

  const ready = resolved !== null && !exporting;
  const shownRegion = draftRegion ?? region;

  // 无头驱动 API：挂到 window.__badgeExport，供自动化（preview_eval / 脚本）驱动整套导出。
  // 每次渲染重挂，保证闭包里的 state 是最新值。effect 体内只赋值 window 属性、
  // 不调用任何 setState（setter 仅作为 API 成员透出），不会形成更新循环。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const api = {
      ready,
      avatarId,
      switchAvatar: handleSwitchAvatar,
      setTransform,
      setFreeze,
      setCostumeOn,
      setServerSave,
      setOutDir,
      setStateKind,
      setBlinkN,
      setIdleFrames,
      setIdleFps,
      setEyeIds: (left: string, right: string) => { setEyeLId(left); setEyeRId(right); },
      setEyeOn,   /* 关"眼开合"滑杆钉眼→烤 idle 时让 blinkEyeOpen 曲线驱动眨眼(否则被钉回睁) */
      getEyeOn: () => eyeOn,
      setMouthId,
      setBgPath,
      hasBackground: bgImage !== null,
      getParamIds: () => paramIds,
      probeParam,
      captureState: handleCaptureState,
      captureBlink: handleCaptureBlink,
      captureMouth: handleCaptureMouth,
      captureMouthAuto: handleCaptureMouthAuto,
      captureIdleMotion: handleCaptureIdleMotion,
      captureAllAligned: handleCaptureAllAligned,
      setWarmup: setWarmupOn,
      setSpeakMotion,
      setSpeakFrames,
      setSpeakFps,
      setSpeakRadius,
      setSpeakTolerance,
      captureSpeak: handleCaptureSpeak,
      getSpeakAnchors: () => speakAnchors,
      setListenExpr,
      captureListenExpr: handleCaptureListenExpr,
      captureBlinkSprite: handleCaptureBlinkSprite,
      captureErrorState: handleCaptureErrorState,
      settlePose: settlePoseSynthetic,
      advanceTime: advanceModelTime,
      /** 诊断：暂停/恢复呼吸控制器（恢复时不重置相位）。返回是否成功。 */
      setBreathEnabled: (on: boolean) => {
        const runtime = runtimeRef.current;
        if (!runtime) return false;
        const internal = runtime.model.internalModel as unknown as { breath?: unknown; __savedBreath?: unknown };
        if (!on) {
          if (internal.breath) internal.__savedBreath = internal.breath;
          internal.breath = undefined;
        } else if (internal.__savedBreath) {
          internal.breath = internal.__savedBreath;
        }
        return true;
      },
      /** 诊断：暂停/恢复物理。 */
      setPhysicsEnabled: (on: boolean) => {
        const runtime = runtimeRef.current;
        if (!runtime) return false;
        const internal = runtime.model.internalModel as unknown as { physics?: unknown; __savedPhysics?: unknown };
        if (!on) {
          if (internal.physics) internal.__savedPhysics = internal.physics;
          internal.physics = undefined;
        } else if (internal.__savedPhysics) {
          internal.physics = internal.__savedPhysics;
        }
        return true;
      },
      /** 诊断：当前全部参数值快照（id→currentValue），配合 advanceTime 定位持续振荡源。 */
      getParamValues: () => {
        const runtime = runtimeRef.current;
        if (!runtime) return {};
        const out: Record<string, number> = {};
        for (const item of getRuntimeParameterSnapshot(runtime)) {
          if (typeof item.currentValue === 'number') out[item.id] = item.currentValue;
        }
        return out;
      },
      getRecords: () => records,
      getStatus: () => status,
      /** 诊断/自动化：带临时参数覆盖抓一帧，返回 dataURL（自动化侧可自行做像素分析）。 */
      captureWithParams: (entries: Array<[string, number]>, region?: ExportRegion | null) => {
        try {
          for (const [id, value] of entries) burstMapRef.current.set(id, value);
          return captureCanvas(region ?? null).toDataURL();
        } finally {
          burstMapRef.current.clear();
        }
      },
      isMotionPlaying: () =>
        (runtimeRef.current?.model.internalModel.motionManager as unknown as { playing?: boolean } | undefined)
          ?.playing ?? false,
    };
    (window as unknown as { __badgeExport?: unknown }).__badgeExport = api;
    return () => {
      delete (window as unknown as { __badgeExport?: unknown }).__badgeExport;
    };
  });

  return (
    <div className="bex-root">
      <header className="bex-header">
        <h1>电子吧唧素材导出</h1>
        <span className="bex-header-sub">466×466 圆形屏 · RGB565(LE) · Live2D 帧动画烘焙</span>
        <span className={`bex-status${status.startsWith('⚠') ? ' bex-status--error' : ''}`}>{status}</span>
      </header>

      <div className="bex-main">
        {/* 左：466×466 视口 */}
        <div className="bex-stage-col">
          <div
            ref={wrapRef}
            className={`bex-stage-wrap${selecting ? ' bex-stage-wrap--selecting' : ''}`}
            style={{
              width: VIEW,
              height: VIEW,
              ...(bgPreviewUrl
                ? { background: `center / cover no-repeat url(${bgPreviewUrl})` }
                : null),
            }}
            onPointerDown={handleStagePointerDown}
            onPointerMove={handleStagePointerMove}
            onPointerUp={handleStagePointerUp}
            onPointerCancel={handleStagePointerUp}
          >
            <div ref={stageRef} className="bex-stage" />
            {maskOn && <div className="bex-circle-mask" />}
            {shownRegion && shownRegion.w > 0 && shownRegion.h > 0 && (
              <div
                className="bex-region-box"
                style={{ left: shownRegion.x, top: shownRegion.y, width: shownRegion.w, height: shownRegion.h }}
              >
                <span className="bex-region-tag">
                  {shownRegion.x},{shownRegion.y} {shownRegion.w}×{shownRegion.h}
                </span>
              </div>
            )}
            {selecting && (
              <div
                className="bex-select-layer"
                onPointerDown={handleSelectPointerDown}
                onPointerMove={handleSelectPointerMove}
                onPointerUp={handleSelectPointerUp}
              />
            )}
          </div>
          <div className="bex-stage-tools">
            <span>拖拽移动 · 滚轮缩放（scale {transform.scale.toFixed(3)}）</span>
            <button type="button" onClick={() => setTransform(DEFAULT_TRANSFORM)}>重置构图</button>
            <label>
              <input type="checkbox" checked={maskOn} onChange={(e) => setMaskOn(e.target.checked)} />
              圆形参考线
            </label>
          </div>
          {thumbs.length > 0 && (
            <div className="bex-thumbs">
              {thumbs.map((thumb) => (
                <figure key={thumb.name}>
                  <img src={thumb.dataUrl} alt={thumb.name} />
                  <figcaption>{thumb.name}</figcaption>
                </figure>
              ))}
            </div>
          )}
        </div>

        {/* 右：控制面板 */}
        <div className="bex-panel">
          <section>
            <h2>角色</h2>
            <div className="bex-row">
              <select value={avatarId} onChange={(e) => handleSwitchAvatar(e.target.value)} disabled={exporting}>
                {avatarOptions.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}（{item.id}）{item.listedInDrawer === false ? ' · 内部模型' : ''}
                  </option>
                ))}
              </select>
              <label title="停掉待机动作/小动作拍并回中视线，让多次抓取之间姿态一致（呼吸/物理仍有微小变化）">
                <input type="checkbox" checked={freeze} onChange={(e) => setFreeze(e.target.checked)} />
                冻结动作
              </label>
              {costumeCfg && (
                <label title={`每帧硬写换装参数：${costumeCfg.costume.map((c) => `${c.id}=${c.value}`).join(', ')}`}>
                  <input type="checkbox" checked={costumeOn} onChange={(e) => setCostumeOn(e.target.checked)} />
                  换装形态
                </label>
              )}
            </div>
          </section>

          <section>
            <h2>表情 / Emotion</h2>
            <div className="bex-expr-list">
              {(resolved?.expressions ?? []).map((expr) => (
                <button
                  key={expr.id}
                  type="button"
                  className={activeExpr === expr.id ? 'bex-expr--on' : ''}
                  title={`${expr.id} · ${expr.kind}`}
                  onClick={() => handleExpression(expr.id)}
                  disabled={!ready}
                >
                  {expr.label}
                </button>
              ))}
            </div>
            <p className="bex-hint">表情有约 1 秒平滑过渡，等画面稳定后再抓帧。</p>
          </section>

          <section>
            <h2>参数覆盖（眼 / 嘴）</h2>
            <datalist id="bex-param-ids">
              {paramIds.map((id) => <option key={id} value={id} />)}
            </datalist>
            <div className="bex-row">
              <label>
                <input type="checkbox" checked={eyeOn} onChange={(e) => setEyeOn(e.target.checked)} />
                眼开合
              </label>
              <input
                type="range" min={0} max={1} step={0.01} value={eyeValue}
                onChange={(e) => setEyeValue(Number(e.target.value))} disabled={!eyeOn}
              />
              <span className="bex-num">{eyeValue.toFixed(2)}</span>
            </div>
            <div className="bex-row">
              <input list="bex-param-ids" value={eyeLId} onChange={(e) => setEyeLId(e.target.value)} placeholder="左眼参数 id" />
              <input list="bex-param-ids" value={eyeRId} onChange={(e) => setEyeRId(e.target.value)} placeholder="右眼参数 id" />
            </div>
            <div className="bex-row">
              <label>
                <input type="checkbox" checked={mouthOn} onChange={(e) => setMouthOn(e.target.checked)} />
                嘴开合
              </label>
              <input
                type="range" min={0} max={1} step={0.01} value={mouthValue}
                onChange={(e) => setMouthValue(Number(e.target.value))} disabled={!mouthOn}
              />
              <span className="bex-num">{mouthValue.toFixed(2)}</span>
            </div>
            <div className="bex-row">
              <input list="bex-param-ids" value={mouthId} onChange={(e) => setMouthId(e.target.value)} placeholder="嘴参数 id" />
            </div>
            <p className="bex-hint">参数 id 支持手输（输入框有全部运行时参数的自动补全）。勾选即每帧硬写、盖过动作与自动眨眼。</p>
          </section>

          <section>
            <h2>裁剪区（如嘴部）</h2>
            <div className="bex-row">
              <button type="button" onClick={() => setSelecting((v) => !v)} disabled={!ready}>
                {selecting ? '取消框选' : '框选区域'}
              </button>
              <button type="button" onClick={() => setRegion(null)} disabled={!region}>清除</button>
              <label>
                <input type="checkbox" checked={cropOn} onChange={(e) => setCropOn(e.target.checked)} disabled={!region} />
                导出时按区域裁剪
              </label>
            </div>
            {region && (
              <div className="bex-row bex-region-fields">
                {(['x', 'y', 'w', 'h'] as const).map((field) => (
                  <label key={field}>
                    {field}
                    <input
                      type="number" value={region[field]}
                      onChange={(e) => updateRegionField(field, e.target.value)}
                    />
                  </label>
                ))}
              </div>
            )}
          </section>

          <section>
            <h2>抓帧导出</h2>
            <div className="bex-row">
              <label><input type="checkbox" checked={pngOn} onChange={(e) => setPngOn(e.target.checked)} /> PNG</label>
              <label><input type="checkbox" checked={binOn} onChange={(e) => setBinOn(e.target.checked)} /> RGB565 .bin</label>
              <label title="经 dev server 中间件写入仓库根 badge-assets/<目录>/；关闭则走浏览器下载">
                <input type="checkbox" checked={serverSave} onChange={(e) => setServerSave(e.target.checked)} />
                落盘 badge-assets/
              </label>
              <input
                className="bex-outdir" value={outDir} placeholder="输出目录"
                onChange={(e) => setOutDir(e.target.value.replace(/[^\w./-]/g, ''))}
                disabled={!serverSave}
              />
            </div>
            <div className="bex-row">
              <label title="badge-assets 相对路径（466×466），导出时垫在最底层合成不透明成品帧；留空 = 透明底">
                背景图
                <input
                  className="bex-outdir" value={bgPath} placeholder="backgrounds/xxx.png"
                  onChange={(e) => setBgPath(e.target.value)}
                />
              </label>
              <span className="bex-num">{bgImage ? '已加载' : '无'}</span>
            </div>
            <div className="bex-row">
              <select value={stateKind} onChange={(e) => setStateKind(e.target.value)}>
                {STATE_KINDS.map((item) => (
                  <option key={item.key} value={item.key}>{item.label}（{item.key}）</option>
                ))}
              </select>
              <button type="button" onClick={() => void handleCaptureState()} disabled={!ready}>抓取单帧</button>
            </div>
            <div className="bex-row">
              <label>
                眨眼帧数
                <input
                  type="number" min={2} max={30} value={blinkN}
                  onChange={(e) => setBlinkN(Number(e.target.value) || 6)}
                />
              </label>
              <button type="button" onClick={() => void handleCaptureBlink()} disabled={!ready}>眨眼序列（1→0→1）</button>
            </div>
            <div className="bex-row">
              <button type="button" onClick={() => void handleCaptureMouth()} disabled={!ready}>口型 3 帧（0/0.5/1）</button>
              <button
                type="button" onClick={() => void handleCaptureMouthAuto()} disabled={!ready}
                title="抓嘴0/嘴1全帧做像素diff自动求嘴部区域（外扩8px、偶对齐），按区域裁剪导出 0/0.25/0.5/0.75/1 五帧"
              >
                口型 5 档（自动嘴部区域）
              </button>
            </div>
            <div className="bex-row">
              <label title="W2：程序化低幅闭环微动（曲线直驱参数，数学精确闭环；需冻结动作+帧数/fps=4s，如 48@12）">
                <input type="checkbox" checked={idleParametric} onChange={(e) => setIdleParametric(e.target.checked)} />
                吧唧微动（程序化闭环）
              </label>
              <label title="以模型自带 loop-authored 循环动作（如 idle.motion3）为严格周期驱动：authored 自然度+数学闭环。周期=动作时长（idle=8s→480帧@60fps）">
                <input type="checkbox" checked={idleMotionDrive} onChange={(e) => setIdleMotionDrive(e.target.checked)} />
                动作驱动
              </label>
              <label>
                帧数
                <input
                  type="number" min={2} max={1400} value={idleFrames}
                  onChange={(e) => setIdleFrames(Number(e.target.value) || 30)}
                />
              </label>
              <label>
                fps
                <input
                  type="number" min={1} max={60} value={idleFps}
                  onChange={(e) => setIdleFps(Number(e.target.value) || 15)}
                />
              </label>
              <label title="抓帧前按同样的 1/fps 步进空跑 2 个完整周期（2×帧数 步，不抓帧），发丝物理进入稳态周期轨道，循环首尾自然接近（消除回卷跳变）">
                <input type="checkbox" checked={warmupOn} onChange={(e) => setWarmupOn(e.target.checked)} />
                物理预热
              </label>
              <button
                type="button" onClick={() => void handleCaptureIdleMotion()} disabled={!ready}
                title="以合成时间步进（每帧恰 1/fps 秒）推进待机动作/物理连抓全屏帧；需关闭「冻结动作」"
              >
                待机动作连拍
              </button>
            </div>
            {idleMotionDrive && (
              <div className="bex-row">
                <label>
                  动作文件
                  <input
                    type="text" value={idleMotionUrl} size={40}
                    onChange={(e) => setIdleMotionUrl(e.target.value)}
                  />
                </label>
                <label title="库 CubismBreath 默认摆（AngleX±7.5°等五分量，预览活气的大头）的有理化重构：周期凑成烘焙窗整数分频=闭环，幅度原样">
                  <input type="checkbox" checked={idleWobble} onChange={(e) => setIdleWobble(e.target.checked)} />
                  自然摆动层
                </label>
                <label title="烘焙窗=动作时长×N。N=2 时摆动分频误差最小（16s：8/3.2/5.33/16/3.2 vs 库 6.53/3.53/5.53/15.53/3.23），两遍动作相位不同=去重复感">
                  倍数
                  <input
                    type="number" min={1} max={4} value={idleLoopMult}
                    onChange={(e) => setIdleLoopMult(Number(e.target.value) || 1)}
                  />
                </label>
                <label title="直接渲染 384×640 竖屏（466 方形构图放大居中裁两侧）：编码零缩放=不糊。仅 PNG 有意义（.bin 是吧唧 466 方形契约）">
                  <input type="checkbox" checked={idleCardNative} onChange={(e) => setIdleCardNative(e.target.checked)} />
                  竖屏原生 384×640
                </label>
              </div>
            )}
            <div className="bex-row">
              <button
                type="button" className="bex-primary"
                onClick={() => void handleCaptureAllAligned()} disabled={!ready}
                title="冻结动作→等物理沉降→同一 tick 连拍 state/blink/mouth/idle 全部组：所有组同一身体姿态基线，嘴/眨眼贴图与底图零错位（需勾选「冻结动作」）"
              >
                全套对齐连拍（同一姿态基线）
              </button>
            </div>
            <p className="bex-hint">序列在同一 JS tick 内连拍（待机连拍按 1/fps 步进模型时间）。浏览器下载模式首次需允许「下载多个文件」。「物理预热」同时作用于待机/说话连拍与全套连拍里的 idle 分组。</p>
          </section>

          <section>
            <h2>说话动作连拍（嘴锚点）</h2>
            <div className="bex-row">
              <select value={speakMotion} onChange={(e) => { setSpeakMotion(e.target.value); setSpeakAnchors([]); }} disabled={!ready}>
                <option value="">选择动作…</option>
                {Object.keys(resolved?.motions ?? {}).map((key) => (
                  <option key={key} value={key}>{key}</option>
                ))}
              </select>
            </div>
            <div className="bex-row">
              <label>
                帧数
                <input
                  type="number" min={2} max={240} value={speakFrames}
                  onChange={(e) => setSpeakFrames(Number(e.target.value) || 30)}
                />
              </label>
              <label>
                fps
                <input
                  type="number" min={1} max={60} value={speakFps}
                  onChange={(e) => setSpeakFps(Number(e.target.value) || 15)}
                />
              </label>
              <label title="模板匹配的邻域半径（像素）：嘴部偏移超出此范围会匹配不到">
                匹配半径
                <input
                  type="number" min={1} max={64} value={speakRadius}
                  onChange={(e) => setSpeakRadius(Number(e.target.value) || 12)}
                />
              </label>
              <label title="残差（0-255）超过此值判定该帧匹配不可靠，整组导出失败">
                残差容差
                <input
                  type="number" min={0} max={255} value={speakTolerance}
                  onChange={(e) => setSpeakTolerance(Number(e.target.value) || 8)}
                />
              </label>
            </div>
            <div className="bex-row">
              <button
                type="button" onClick={() => void handleCaptureSpeak()} disabled={!ready}
                title="播放选中动作、按 1/fps 合成时间步进连拍，逐帧对嘴部 region 做模板匹配求平移偏移（mouth_anchors）；需先跑「口型 5 档（自动嘴部区域）」求出嘴部 region"
              >
                说话动作连拍
              </button>
            </div>
            {speakAnchors.length > 0 && (
              <div className="bex-anchor-list">
                {speakAnchors.map((a, i) => (
                  <span
                    key={i}
                    className={`bex-anchor-chip${a.residual > speakTolerance ? ' bex-anchor-chip--bad' : ''}`}
                    title={`帧 ${i}：残差 ${a.residual.toFixed(1)}`}
                  >
                    {i}:[{a.dx},{a.dy}]
                  </span>
                ))}
              </div>
            )}
            <p className="bex-hint">
              嘴 region 复用「口型 5 档（自动嘴部区域）」求出的裁剪区（region 面板可见）。
              抓前自检：帧 0 对基线模板匹配的残差超容差直接报错（不进入逐帧连拍）；
              任意帧残差超容差则整组不落盘。物理预热开启时帧 0 允许非零锚点偏移（记录真实匹配值）。
              「物理预热」勾选框见上方「抓帧导出」区。
            </p>
          </section>

          <section>
            <h2>聆听表情提取</h2>
            <div className="bex-row">
              <select value={listenExpr} onChange={(e) => setListenExpr(e.target.value)} disabled={!ready}>
                <option value="">选择表情…</option>
                {(resolved?.expressions ?? []).map((expr) => (
                  <option key={expr.id} value={expr.id}>{expr.label}（{expr.id}）</option>
                ))}
              </select>
              <button
                type="button" onClick={() => void handleCaptureListenExpr()} disabled={!ready}
                title="基线 vs 表情帧像素 diff 求局部区域（如眼睛高亮），裁剪导出为局部贴图；diff 为空或区域超屏幕 1/4 会报错"
              >
                提取聆听表情区域
              </button>
            </div>
            <p className="bex-hint">默认选中名字带 happy/shy/sparkle 等高亮类的表情，可手动改选。</p>
          </section>

          <section>
            <h2>错误状态帧</h2>
            <div className="bex-row">
              <button type="button" onClick={() => void handleCaptureErrorState()} disabled={exporting}>
                生成「连接失败 重试中…」错误帧
              </button>
            </div>
            <p className="bex-hint">466×466 纯黑底 + 白字两行，居中，落盘 states/error.png。</p>
          </section>

          <section>
            <h2>manifest（本次会话 {records.length} 组）</h2>
            <ul className="bex-records">
              {records.map((record, index) => (
                <li key={`${record.createdAt}-${index}`}>
                  {record.avatarId} · {record.kind}{record.label ? `/${record.label}` : ''} · {record.frames.length} 文件 ·
                  {' '}{record.size.w}×{record.size.h}
                  {record.formats.includes('bin') ? `（bin=${record.size.w * record.size.h * 2}B）` : ''}
                </li>
              ))}
            </ul>
            <div className="bex-row">
              <button type="button" onClick={handleDownloadManifest} disabled={records.length === 0}>
                下载 manifest.json
              </button>
              <button
                type="button"
                onClick={() => { recordsRef.current = []; setRecords([]); }}
                disabled={records.length === 0}
              >
                清空记录
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
