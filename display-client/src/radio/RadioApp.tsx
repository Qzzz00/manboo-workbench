// U3 电台桌面根（按 Figma 四页重排 + Ben 二轮验收调优）：
//   · Live2D音乐（主页，角色放大下移到腰部以上 + 自定义背景图 + 底部深色播放器）
//   · 主界面（左滑切出，彩色九宫格启动器；右上角贴纸格子由固定浮窗自动占位，无需点按）
//   · 歌单 / 更多应用 / 设置——覆盖层
// 独立于 App.tsx（仿 holo），无登录墙；渲染强制 WebView（U3 短边 480px 会被误判低端走原生）。
// 画布固定 480×640 设计坐标，整体 transform:scale(--radio-scale) 铺满视口（屏同为 3:4，正好满铺）。
//
// 页面切换=异步序列 + loading 门（而非双屏 CSS 滑动同时挂载）：同一时刻只有一个 Live2D 在渲染
// （DJ 页 Live2DStage 或主界面固定浮窗二选一），避免两个 Live2D 同时跑掉帧。切出 DJ 页先关浮窗
// 再挂 Live2DStage、等 onReady；切去主界面先撤 Live2DStage 再开浮窗，等浮窗起服务确认。
import { memo, type ComponentProps, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SplashScreen } from '@capacitor/splash-screen';
import { Live2DStage } from '../features/live2d/Live2DStage.tsx';
import { getAvatarById } from '../features/live2d/avatarData.ts';
import { buildUnifiedActions, getAvatarNeutralExpressionId } from '../features/live2d/avatarManifest.ts';
import { djConfigForModelAvatar } from '../features/live2d/djModels.ts';
import { usePresence } from '../features/live2d/presence/usePresence.ts';
import { setLive2DRendererPref } from '../lib/deviceTier.ts';
import type { StageTransform } from '../features/live2d/live2dEngine.ts';
import type { ParameterOverride } from '../features/live2d/types.ts';
import type { ChatMessage } from '../lib/llm.ts';
import { ensureBatteryExemption } from '../lib/radioLauncherPlugin.ts';
import RadioLauncher from '../lib/radioLauncherPlugin.ts';
import { useSettings } from '../features/settings/useSettings.ts';
import { useChat } from '../hooks/useChat.ts';
import { useRadioPlayer } from './useRadioPlayer.ts';
import { RadioPlayerCard } from './RadioPlayerCard.tsx';
import { RadioStatusBar } from './RadioStatusBar.tsx';
import { RadioHomeGrid } from './RadioHomeGrid.tsx';
import { MoreAppsPopup } from './MoreAppsPopup.tsx';
import { TrackListSheet } from './TrackListSheet.tsx';
import { RadioSettingsSheet } from './RadioSettingsSheet.tsx';
import { ensureRadioAuth } from './radioAuth.ts';
import { loadRadioDjId, saveRadioDjId, cardTransformFor } from './radioDjAvatar.ts';
import { mouthOverridesForLevel } from './radioMouth.ts';
import { createAnimalVoice } from './animalVoice.ts';
import { planAck, allVoiceClipsFor, CRY_EXCLUDE_PREFIX } from './radioVoicePack.ts';
import { loadVoiceVolume, saveVoiceVolume } from './radioVoiceVolume.ts';
import { useRadioVoice } from './useRadioVoice.ts';
import type { RadioVoiceDeps } from './radioVoiceExecutor.ts';
import { resolveAppPackage } from './appPackageMap.ts';
import type { HoloControl } from '../holo/holoControl.ts';
import { usePetPlay } from './pet/usePetPlay.ts';
import { decideTap } from './pet/petHitZones.ts';
import { PetBadge } from './pet/PetBadge.tsx';
import { PetPanel } from './pet/PetPanel.tsx';
import { favoriteSnackFor, SNACKS } from './pet/petReactions.ts';
import type { AckPlan } from './radioVoicePack.ts';
import type { ModelBounds } from '../features/live2d/live2dEngine.ts';
import './radio.css';
import './pet/pet.css';

// 电台 DJ 模型：用户在设置页三选一（小白猫/幽灵狗/小幽灵），localStorage 持久化，见 radioDjAvatar.ts。
// 跨模型的比例差异由各 avatar 的 headAnchorY/headSizeNorm 经 computeAutoFit 吸收，所以 DJ 页三只共用
// 同一个（近乎 identity 的）transform；卡片页因 offsetY 是加性的没法共用，那套值 per-model 放在清单里。
// 要换回双生：把 'shuangsheng-dj' 加进 RADIO_DJ_OPTIONS（djConfigForModelAvatar 会自动接回 Param67 换装）。
// 渲染后端恢复自动判定：显式设 'auto' 清掉旧版 APK 写进主 App 源 localStorage 的 'webview'
// （localStorage 跨安装持久，只删代码不清值会让 U3 继续走 WebView）。auto → shouldUseNativeLive2D：
// U3（短边480判低端 + 原生插件随包）走 Cubism 原生 GLSurfaceView（提帧率 + 保物理，见 NativeLive2DModel）；
// 浏览器/非原生自动回落 WebView Pixi。小浮窗另走 pet.localhost 源单独强制 WebView 保透明，不受此影响。
setLive2DRendererPref('auto');

// DJ 页构图：几乎是无覆盖基线——取景（胸部以上的近景）已由 surface="radio" 的 SURFACE_FRAMING 表达，
// 每只角色的比例差异由各自 avatar 的 headAnchorY/headSizeNorm 吸收。这里只留一点点微调余量。
// ★别再用「大 scale + 大 offsetY」硬怼：那是靠撞 computeModelLayout 的顶部钳制才成像，换个模型就散架
//（实测幽灵狗偏小、小幽灵撑爆画面，正是那版的症状）。
const DJ_PAGE_TRANSFORM: StageTransform = { scale: 1, offsetX: 0, offsetY: 0 };

// 主界面卡片构图：同一个 Live2DStage 缩小 + 移到右上角，把角色框进 live2d 卡片洞
// （卡片 244,50,228×346 的上半 228 区域）。九宫格用 box-shadow 挖洞法只在卡片处露出 GL 角色，其余不透明。
// scale/offsetX/offsetY 语义见 computeModelLayout：offsetX/Y 是屏宽/屏高的比例增量（叠加在居中 0.5 上）。
// 值是 per-model 的，见 radioDjAvatar.cardTransform（那里有为什么不能三只共用一套的推导）。

// DJ 页背景图（Ben 提供，夜巷酒馆场景）。
const DJ_PAGE_BG_URL = '/backgrounds/radio-dj-bg.png';

// DJ 页原生渲染目标帧率。★临时探天花板：设 60（渲染器上限，等于不锁）实测能跑多少——
// U3 原生+物理 work≈46ms 理论硬上限 ~21fps，不锁大概率稳在 21 左右（work 决定，非锁决定）；
// 要真上 24/30 得砍 draw（降纹理/分辨率，与清晰度冲突）。实测后再定最终值。
// 主 App 更弱低端机（U1 Pro 0.99GHz）仍走默认 15，不受影响。
const DJ_NATIVE_TARGET_FPS = 60;

// 稳定空引用：Live2DStage 多个 effect 以数组引用做依赖，字面量 [] 每次渲染都是新对象，
// 会让 useRadioPlayer 的 1s 轮询重渲染白白触发表情/参数重下发（App.tsx 共享舞台同一套写法）。
// expressionMix/parameterOverrides 现由 usePresence.composed 驱动（语音表情/参数），
// costumeParamOverrides 仍需空数组兜底（djCfg 缺省时）。
const EMPTY_PARAM_OVERRIDES: ParameterOverride[] = [];

type RadioPage = 'radio' | 'home';
type RadioOverlay = null | 'list' | 'moreApps' | 'settings';

const framingFor = (p: RadioPage, cardTransform: StageTransform): StageTransform =>
  (p === 'radio' ? DJ_PAGE_TRANSFORM : cardTransform);

type RadioAvatar = NonNullable<ReturnType<typeof getAvatarById>>;

/** Live2D 舞台（独立叶子组件）：把「切页角色构图 morph」封在这里——page 变化时内部 rAF 插值 transform，
 * 每帧只重渲染本组件 + Live2DStage，不触发 RadioApp/九宫格/播放器重渲染（这是把 morph 从 RadioApp 抽出来的
 * 原因：之前 morph 每帧 setState 让整棵树重渲染，低端机主线程卡顿，DOM 平移被拖顿）。memo 化，语音/播放态
 * 变化传进来的 props 稳定时不重渲染。 */
const RadioStage = memo(function RadioStage(props: {
  page: RadioPage;
  avatar: RadioAvatar;
  expressionMix: ComponentProps<typeof Live2DStage>['expressionMix'];
  parameterOverrides: ParameterOverride[];
  mouthSyncOverrides: ParameterOverride[];
  costumeParamOverrides: ParameterOverride[];
  action: ComponentProps<typeof Live2DStage>['action'];
  motionName: string;
  onModelBounds?: (b: ModelBounds) => void;
  cardTransform: StageTransform;
  djReady: boolean;
  onReady: () => void;
}) {
  const { page, avatar, expressionMix, parameterOverrides, mouthSyncOverrides, costumeParamOverrides, action, motionName, onModelBounds, cardTransform, djReady, onReady } = props;
  const [morph, setMorph] = useState<StageTransform | null>(null);
  const rafRef = useRef<number | null>(null);
  const prevPageRef = useRef(page);

  const runMorph = useCallback((from: StageTransform, to: StageTransform, duration: number) => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const e = 1 - Math.pow(1 - t, 4); // easeOutQuart（与 CSS 平移 ease-out 同节奏）
      setMorph({
        scale: from.scale + (to.scale - from.scale) * e,
        offsetX: from.offsetX + (to.offsetX - from.offsetX) * e,
        offsetY: from.offsetY + (to.offsetY - from.offsetY) * e,
      });
      if (t < 1) { rafRef.current = requestAnimationFrame(step); }
      else { rafRef.current = null; setMorph(null); }
    };
    rafRef.current = requestAnimationFrame(step);
  }, []);

  useEffect(() => {
    if (prevPageRef.current === page) return;
    const from = framingFor(prevPageRef.current, cardTransform);
    const to = framingFor(page, cardTransform);
    prevPageRef.current = page;
    runMorph(from, to, 360);
  }, [page, cardTransform, runMorph]);

  // 预热：启动 1.2s 后跑一次「原地」morph（from==to，无位移），暖 rAF+原生重排代码路径，让第一次真滑动就不卡
  // （不预热时首次滑动要现场 JIT+首次布局，Ben 实测「第一次卡、多滑几次才顺」）。
  useEffect(() => {
    const id = window.setTimeout(() => {
      const f = framingFor(prevPageRef.current, cardTransform);
      if (!rafRef.current) runMorph(f, f, 300);
    }, 1200);
    return () => window.clearTimeout(id);
  }, [cardTransform, runMorph]);
  useEffect(() => () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); }, []);

  return (
    <div className="radio-stage">
      <Live2DStage
        avatar={avatar}
        expressionMix={expressionMix}
        parameterOverrides={parameterOverrides}
        mouthSyncOverrides={mouthSyncOverrides}
        costumeParamOverrides={costumeParamOverrides}
        watermarkVisible={false}
        transform={morph ?? framingFor(page, cardTransform)}
        backgroundUrl={DJ_PAGE_BG_URL}
        surface="radio"
        interactive={false}
        action={action}
        motionName={motionName}
        nativeTargetFps={DJ_NATIVE_TARGET_FPS}
        onReady={onReady}
        onModelBounds={onModelBounds}
      />
      {page === 'radio' && !djReady ? <div className="radio-stage-loading"><div className="radio-spinner" /></div> : null}
    </div>
  );
});

export default function RadioApp() {
  const player = useRadioPlayer();
  const [page, setPage] = useState<RadioPage>('radio');
  const [djReady, setDjReady] = useState(false);            // Live2D 首帧真画出（模型只加载一次，两页共用）
  const [overlay, setOverlay] = useState<RadioOverlay>(null);
  const [inCall, setInCall] = useState(false);              // 通话中（拨通→挂断）：门控语音收音
  const [bootReady, setBootReady] = useState(false);        // 启动预热循环完成前用全屏 cover 盖住
  // 切页动效：DOM 页用 CSS translateX 平移（GPU 顺滑）；角色构图 morph 封在 RadioStage 内部（见其注释），
  // page 变化即触发，逐帧只重渲染 RadioStage，不拖累这里整棵树。
  const rootRef = useRef<HTMLDivElement>(null);

  // 启动预热：djReady 后藏在全屏 cover 后跑一次真实 DJ→主界面→DJ 循环，把「主界面卡片构图」的原生首次布局
  // + CSS 平移图层 + 九宫格光栅一次性烤热，让用户第一次真滑动就顺（不预热时首次要现场算这些=Ben 实测第一次卡）。
  useEffect(() => {
    if (bootReady || !djReady) return;
    const t1 = window.setTimeout(() => setPage('home'), 30);
    const t2 = window.setTimeout(() => setPage('radio'), 300);
    const t3 = window.setTimeout(() => setBootReady(true), 560);
    return () => { window.clearTimeout(t1); window.clearTimeout(t2); window.clearTimeout(t3); };
  }, [djReady, bootReady]);

  // 首启（每次冷启动）引导电池优化豁免：careai ROM 无豁免则灭屏约12分钟 app-idle 杀播放服务。
  useEffect(() => { void ensureBatteryExemption(); }, []);
  // 挂载成功标记：供原生 MainActivity 看门狗判定 WebView 是否真把电台画出来了（白屏自愈）。
  useEffect(() => {
    (window as unknown as { __aibooRadioMounted?: number }).__aibooRadioMounted = 1;
  }, []);
  // 电台一挂载（WebView 已出画）就收起 Capacitor 启动屏，去掉 KeenPlus 之后那段多余 loading（不等 2s 兜底）。
  // 启动屏底色已改成 #262626 与 app 加载态一致 → KeenPlus 后是一段连续深灰直接到角色，不再是「蓝 loading→app」两段。
  useEffect(() => { requestAnimationFrame(() => { void SplashScreen.hide(); }); }, []);

  // 设计画布缩放：min(vw/480, vh/640)，随视口更新。屏同为 3:4 → 满铺无黑边。
  useEffect(() => {
    const apply = () => {
      const s = Math.min(window.innerWidth / 480, window.innerHeight / 640);
      rootRef.current?.style.setProperty('--radio-scale', String(s || 1));
    };
    apply();
    window.addEventListener('resize', apply);
    window.addEventListener('orientationchange', apply);
    return () => {
      window.removeEventListener('resize', apply);
      window.removeEventListener('orientationchange', apply);
    };
  }, []);

  // DJ 角色（设置页可切）：切换时重置 djReady，让 loading 门盖住换模型的加载过程。
  const [djId, setDjId] = useState(loadRadioDjId);
  const selectDj = useCallback((next: string) => {
    setDjId((prev) => {
      if (prev === next) return prev;
      saveRadioDjId(next);
      setDjReady(false);
      return next;
    });
  }, []);
  // ★action 通道的钥匙：playAction/playNativeAction 按 getAvatarAction(avatar) 解析统一动作，
  // 它读 avatar.actions——只有主 App 的 resolveAvatarManifest（异步富集）才会填。电台不走那条
  // 异步链路（模型是随包资产，无需远端解析），这里同步补上注册表，否则宠物反应的
  // actionId/expressionId 全部 no-op（且 no-op 兜底会把通话中的情绪表情硬切回 neutral）。
  const djAvatar = useMemo(() => {
    const raw = getAvatarById(djId);
    if (!raw) return raw;
    return { ...raw, actions: buildUnifiedActions(raw) };
  }, [djId]);
  const djCfg = useMemo(() => djConfigForModelAvatar(djId), [djId]);
  // 稳定引用：RadioStage 是 memo 的，字面量对象每次渲染都是新的会击穿 memo（也会让 morph effect 重跑）。
  const cardTransform = useMemo(() => cardTransformFor(djId), [djId]);

  // —— 语音对话 & 控制（复用 holo 链路）——
  const { ttsSettings } = useSettings();
  const neutralId = useMemo(() => (djAvatar ? getAvatarNeutralExpressionId(djAvatar) : ''), [djAvatar]);
  const { presence, composed } = usePresence(neutralId);
  const [mouthLevel, setMouthLevel] = useState(0);
  // ★电台不用 TTS：这几只 DJ 是猫/狗/幽灵，不说人话，只按情绪叫一声（见 radioVoicePack.ts）。
  // useChat 里 !ttsEnabled 本来就有跳过分支，所以这里写死 false 即可关掉合成语音，
  // ttsSettings 仍传（useChat 签名要求），关掉后它不会被用到。
  const ttsEnabled = false;
  // 「角色正在叫」——取代原来的 ttsState 做防自听门控（TTS 关掉后 ttsState 永远是 idle）。
  const [barking, setBarking] = useState(false);
  // 稳定引用：mouthOverridesForLevel(mouthLevel) 字面量每次渲染都是新数组，useRadioPlayer 1s 轮询
  // 重渲染会让 Live2DStage 的口型 effect（键引用）白白重触发（同上 EMPTY_PARAM_OVERRIDES 理由）。
  const mouthOverrides = useMemo(() => mouthOverridesForLevel(mouthLevel), [mouthLevel]);
  // 叫声播放器：整个电台生命周期一个实例（AudioContext 很贵，且解码后的叫声按 url 缓存复用）。
  // 它同时负责喂口型（波形 RMS → mouthLevel，接上原来 TTS onMouthChange 那条通道）。
  const [voiceVolume, setVoiceVolume] = useState(loadVoiceVolume);
  const animalVoiceRef = useRef<ReturnType<typeof createAnimalVoice> | null>(null);
  if (!animalVoiceRef.current) {
    animalVoiceRef.current = createAnimalVoice({
      onLevel: setMouthLevel,
      onSpeakingChange: setBarking,
      volume: loadVoiceVolume(), // 首次创建就带上，避免第一声按满音量吼出来
    });
  }
  const changeVoiceVolume = useCallback((v: number) => {
    setVoiceVolume(v);
    saveVoiceVolume(v);
    animalVoiceRef.current?.setVolume(v); // 立即生效，不用等下一声
  }, []);
  useEffect(() => () => { animalVoiceRef.current?.dispose(); animalVoiceRef.current = null; }, []);
  // 预热当前这只 DJ 的整套叫声：真机实测冷启首叫要 ~175ms(fetch40+decode57+量基准78)，
  // 预热后每次叫都是 ~1.5ms。放在 djReady 之后跑，逐条之间让出主线程，不抢启动/首次滑动的资源。
  // 换角色也重跑（各物种音库不同）；已缓存的会自动跳过，切回来是零成本。
  useEffect(() => {
    if (!djReady || !djId) return;
    const clips = allVoiceClipsFor(djId);
    if (clips.length === 0) return;
    void animalVoiceRef.current?.prewarm(clips);
  }, [djReady, djId]);

  // —— 宠物玩法（触摸/喂食/好感度/挂机；spec: 2026-07-30-u3-pet-play-design.md）——
  const screenRef = useRef<HTMLDivElement>(null);
  const playCry = useCallback((plan: AckPlan) => {
    // 同步先关防自听门再播（与 onHeard 相同的时序理由，见其注释）
    setBarking(true);
    void animalVoiceRef.current?.play(plan);
  }, []);
  const pet = usePetPlay({
    djId,
    headAnchorY: djAvatar?.headAnchorY,
    headSizeNorm: djAvatar?.headSizeNorm,
    page,
    djReady,
    overlayOpen: overlay !== null,
    inCall,
    barking,
    playing: player.view.playing,
    greetEnabled: true, // P2 打开
    idleEnabled: true,  // P4 打开
    screenRef,
    playCry,
    setMouthLevel,
  });
  const petRef = useRef(pet);
  petRef.current = pet;

  // 动作/表情（复用主 App 同一机制）：LLM 回合的 motion → motionName（startMotion/playNativeMotion）；
  // 情绪表情走 composed.expressionMix；一次性动作（gesture/DIY）取最新 nativeTrigger 喂 action（nonce 触发一次）。
  // 电台之前把这两条都写死成 idle/无（照搬主 App DJ 模式的抑制），现在放开让语音回合驱动角色动起来。
  const [motionName, setMotionName] = useState<string | undefined>(undefined);
  // 语音回合动作与宠物反应共用 action 通道：谁后到谁播（都是一次性小动作，覆盖无害）。
  // 两个来源各自的 nonce 序列不可比，这里统一重编号。
  const actionSeqRef = useRef(0);
  const [mergedAction, setMergedAction] = useState<{ id: string; nonce: number } | null>(null);
  // ★presenceStore.gestureTrigger 是粘性的且 compose 每次造新数组——今日全仓无 playGesture 调用方所以安全；
  // 若未来接上，需比对 trigger 自身 nonce 再重编号，否则每次情绪 emit 都会重放旧手势。
  useEffect(() => {
    const t = composed.nativeTriggers[0];
    if (t) setMergedAction({ id: t.id, nonce: ++actionSeqRef.current });
  }, [composed.nativeTriggers]);
  useEffect(() => {
    if (pet.petAction) setMergedAction({ id: pet.petAction.id, nonce: ++actionSeqRef.current });
  }, [pet.petAction]);
  // 宠物参数轻推拼在 presence 之后（同名参数 pet 在后覆盖）；空时保持原引用别击穿 memo。
  const stageParamOverrides = useMemo(
    () => (pet.petParamOverrides.length === 0
      ? composed.parameterOverrides
      : [...composed.parameterOverrides, ...pet.petParamOverrides]),
    [composed.parameterOverrides, pet.petParamOverrides],
  );
  const [voiceMessages, setVoiceMessages] = useState<ChatMessage[]>([]);
  // 通话内麦克风静音（不持久化，挂断即复位）：通话中点麦克风钮切换，true=不收音。
  const [callMicMuted, setCallMicMuted] = useState(false);
  const toggleCallMic = useCallback(() => setCallMicMuted((v) => !v), []);
  // 拨通/挂断：进入通话=开始收音（复位静音）；挂断=停止收音并复位静音。语音收音仅通话中生效。
  const startCall = useCallback(() => { setCallMicMuted(false); setInCall(true); }, []);
  const hangUp = useCallback(() => { setInCall(false); setCallMicMuted(false); }, []);
  const onDjReady = useCallback(() => setDjReady(true), []);
  const handleSubmitRef = useRef<((t: string) => void) | null>(null);
  // TDZ 规避：useChat 的 onControl 需引用其后才定义的 radioVoice.onControl，用 ref 间接延迟绑定。
  const onControlRef = useRef<(c: HoloControl) => void>(() => {});

  // 启动即登录固定测试账号（拿 JWT 过 /ai/asr、/ai/chat、/ai/tts 鉴权）。
  useEffect(() => { void ensureRadioAuth(); }, []);

  // 语音「打开应用」解析（U3 装的是七猫/酷狗/Via 等，非微信/QQ；硬编码表覆盖不到，故先查已装清单）：
  // ① 已装应用「标签」模糊匹配（label 含名字 / 名字含 label，取最短 label 避免过宽）
  // ② 中文名→包名静态表（且该包确已安装）
  // ③ 都不中 → 打开「更多应用」抽屉让用户手选。
  const openAppByName = useCallback(async (name: string) => {
    const norm = (s: string) => s.toLowerCase().replace(/\s+/g, '');
    const q = norm(name);
    let apps: { pkg: string; label: string }[] = [];
    try { apps = (await RadioLauncher.listApps()).apps; } catch { /* 拿不到清单→静态表/抽屉 */ }
    const matches = apps.filter((a) => {
      const l = norm(a.label);
      return !!l && (l === q || l.includes(q) || (l.length >= 2 && q.includes(l)));
    });
    let pkg = matches.sort((a, b) => a.label.length - b.label.length)[0]?.pkg;
    if (!pkg) {
      const mapped = resolveAppPackage(name);
      if (mapped && apps.some((a) => a.pkg === mapped)) pkg = mapped;
    }
    if (pkg) {
      console.info('[radio-voice] openApp', JSON.stringify(name), '→', pkg);
      void RadioLauncher.launchApp({ pkg }).catch(() => setOverlay('moreApps'));
      return;
    }
    console.info('[radio-voice] openApp', JSON.stringify(name), '→ 未匹配已装应用，打开更多应用抽屉');
    setOverlay('moreApps');
  }, []);

  // 执行侧依赖：播控走 RadioLauncher，音量走新增原生方法，isPlaying 读播放视图。
  const voiceDeps = useMemo<RadioVoiceDeps>(() => ({
    playback: (op) => { void RadioLauncher.playbackControl({ op }).catch(() => {}); },
    setVolume: (value) => { void RadioLauncher.setVolume({ value }).catch(() => {}); },
    adjustVolume: (delta) => { void RadioLauncher.adjustVolume({ delta }).catch(() => {}); },
    isPlaying: () => player.view.playing,
    openApp: (name) => { void openAppByName(name); }, // 已装标签匹配→中文名表→更多应用抽屉
  }), [player.view.playing, openAppByName]);

  // 不再取 ttsState：TTS 已关（ttsEnabled=false），发声状态改由叫声播放器的 barking 提供。
  const { isSending, handleSubmit, performCallUtterance } = useChat({
    selectedAvatar: djAvatar!,
    selectedAvatarId: djId,
    ttsSettings,
    ttsEnabled,
    messages: voiceMessages,
    setMessages: setVoiceMessages,
    presence,
    setMotionName,
    setMouthOpen: setMouthLevel,
    openSettings: () => { /* 电台无 LLM 设置弹窗 */ },
    holoControl: true,
    onControl: (c) => onControlRef.current(c),
  });
  handleSubmitRef.current = handleSubmit;

  // ★★叫声/动作在「听到用户说话」的瞬间就发生，**不等 LLM 回合**（Ben：「已经没有 TTS 了，
  // 完全可以是异步的，响应及时」）。
  //
  // 旧链路是 ASR→LLM回合→control执行操作→回复文字落地→判情绪→叫，叫声排在整条链路最末，
  // 表现就是 Ben 说的「我让播放歌曲，它是先播放，再叫的」。
  // ★根本理由：**叫声不携带语义**——它是「我听到你了」的应答，不是在念 LLM 想出来的内容，
  // 所以没有任何理由等 LLM。（TTS 时代必须等，因为要念出回复文字；换成叫声后这个约束消失了。）
  //
  // 现在：情绪从【用户说的那句话】本地判（classifyCallEmotion 纯函数，零网络零延迟）→ 立刻叫 + 立刻摆动作；
  // LLM 回合并行继续跑，只负责执行操作（onControl）。两条链路完全异步互不阻塞。
  // 副作用：角色的情绪反应的是「用户说了什么」而非「自己回了什么」——对宠物来说这其实更自然
  //（听到你说话就叫，而不是想好了再叫），且电台不显示回复文字，用户本来也感知不到 LLM 说了啥。
  const performCallUtteranceRef = useRef(performCallUtterance);
  performCallUtteranceRef.current = performCallUtterance;
  // 读最新选中的 DJ 决定叫哪种声（猫/狗/幽灵）。用 ref 是因为 onHeard 要保持稳定引用
  //（它进 useRadioVoice 的 useCallback 依赖，换角色不该重建整条语音链路）。
  const djIdRef = useRef(djId);
  djIdRef.current = djId;
  // 上一次应答的第一声是哪条——只为「别连着两次以同一声开头」（Ben：「重复很高」）。
  const lastAckRef = useRef<string | null>(null);
  // ★★应答叫声 + 动作，都挂在「ASR 返回了非空文本」这一刻。
  //
  // ★★★别再把叫声提前到 VAD 断句瞬间——试过，是错的，真机实测数据在此：
  // 那版为了省掉「WAV 编码 + ASR 网络往返」把叫声挂在 VAD 断句上，于是它**不再等 ASR 确认
  // 这段到底有没有话**，任何过了能量门槛的段都会叫。Ben 实测「不说话有点动静就叫、放歌它也叫」。
  // 我先加了「跑飞的段不叫」+ 抬高能量门槛，再测——**放歌 45 秒仍误叫 6 次**（CDP 探针实测计数）。
  // 根因：**能量 VAD 原理上分不出音乐和人声**，音乐有强弱起伏，自然会断出一段段"像话"的东西，
  // 抬门槛只能压低误报率、压不到零。**唯一可靠的「这段是不是人话」判据就是 ASR 返回了词。**
  //
  // 保留的收益：仍然**不等 LLM 回合**（那才是延迟大头，秒级）。现在只等 ASR，
  // 比最初「等完 LLM 才叫」快得多，同时不会对着音乐乱叫。这是快与准之间正确的那个折中点。
  const onHeard = useCallback((text: string) => {
    petRef.current.onVoiceHeard();
    // 动作：文字→情绪→findEmotionMotion→原生 playMotion（判不出情绪它自己会跳过）
    performCallUtteranceRef.current(text);
    const plan = planAck(djIdRef.current, lastAckRef.current);
    if (!plan) return;
    // 记住这次用了什么，下次避开：素材档记 URL，合成档记变体下标
    lastAckRef.current = plan.kind === 'samples' ? plan.clips[0] : `${CRY_EXCLUDE_PREFIX}${plan.variant}`;
    // ★同步先把防自听门关上再播：play() 内部的 onSpeakingChange(true) 要等 await 过一个微任务才生效，
    // 而此刻麦克风是活的，中间那一两帧足够让 VAD 把角色自己的叫声当成新的一句收进去。
    setBarking(true);
    void animalVoiceRef.current?.play(plan);
  }, []);

  // 回音兜底：AEC 之外再加「叫声尾巴门控」——角色叫完后喇叭尾音/混响可能被麦捕获成自听，
  // 故停止发声后再多门控 ~1s 才恢复收音（配合 useHoloVoice 的 AEC 双保险防自听）。
  // ★换成叫声后这条门控【保留但自然变短】：叫声只有 0.2-2.5s（TTS 是好几秒），门控窗口跟着缩短，
  // 麦克风比以前灵敏得多。保留的理由不是怕「喵」被听成指令（喵匹配不到任何关键词），
  // 而是喇叭输出灌进麦会让 ASR 收到一段带叫声的音频 → 火山返 422/乱码，白跑一次请求。
  const [ttsTail, setTtsTail] = useState(false);
  useEffect(() => {
    if (barking) { setTtsTail(true); return; }
    const t = window.setTimeout(() => setTtsTail(false), 1000);
    return () => window.clearTimeout(t);
  }, [barking]);

  const radioVoice = useRadioVoice({
    // 收音仅在「通话中」(拨通→挂断) 生效：主界面卡片上的绿色拨通钮进入通话开始收音，挂断停止。
    // 额外门控：无覆盖层（歌单/更多应用/设置弹出时暂不收音，避免误触）+ 通话内麦克风未静音。
    enabled: !!djAvatar && overlay === null && inCall && !callMicMuted,
    muted: isSending || barking || ttsTail, // 回合中/角色正在叫/叫声尾巴门控（防自听）
    deps: voiceDeps,
    handleSubmit: useCallback((t: string) => handleSubmitRef.current?.(t), []),
    onHeard, // ASR 出非空文本才叫/摆动作（仍早于 LLM 回合）
  });
  onControlRef.current = radioVoice.onControl;

  // 局部 loading 兜底：Live2D 首帧回调若丢失，8s 后也当就绪，绝不永久转圈。
  useEffect(() => {
    if (djReady) return;
    const t = window.setTimeout(() => setDjReady(true), 8000);
    return () => window.clearTimeout(t);
  }, [djReady]);

  const blurActive = () => { (document.activeElement as HTMLElement | null)?.blur?.(); };

  /** 切页：同一个 Live2DStage 常驻（不卸载/不重载/不起悬浮窗）。DOM 两页 CSS 平移滑入滑出；角色构图 morph
   * 由 RadioStage 内部按 page 变化自行播放，与 DOM 平移同节奏。 */
  const requestPage = (next: RadioPage) => {
    if (next === page) return;
    blurActive();
    setPage(next);
  };

  // 左右滑动切屏（pointer 覆盖鼠标/触摸）：仅无覆盖层且不在切页中才生效；纯点击（位移小）不触发。
  const swipe = useRef<{ x: number; y: number; t: number } | null>(null);
  const onDown = (e: React.PointerEvent) => { swipe.current = { x: e.clientX, y: e.clientY, t: Date.now() }; };
  const onUp = (e: React.PointerEvent) => {
    const s = swipe.current; swipe.current = null;
    if (!s || overlay) return;
    const dx = e.clientX - s.x; const dy = e.clientY - s.y;
    const dt = Date.now() - s.t;
    // 纯点击(位移小、时间短)→ 宠物触摸；只在 DJ 页且面板没开着时生效
    if (decideTap(dx, dy, dt)) {
      // 播放器按钮/播放条等交互 UI 命中不算戳宠物：三只角色模型矩形满铺画布，播放器按钮全落在
      // body 区，不排除的话点播放/暂停会顺带触发一次「戳身」反应+计 XP。
      // （.pet-badge-wrap/.pet-panel-backdrop 是 Task 8 才会加的类，现在写上无害，省得 P2 再改这行。）
      if ((e.target as HTMLElement | null)?.closest('button, .radio-player, .pet-badge-wrap, .pet-panel-backdrop')) return;
      if (page === 'radio' && !pet.panelOpen) pet.onScreenTap(e.clientX, e.clientY);
      return;
    }
    if (dt > 700) return;
    if (Math.abs(dx) < 45 || Math.abs(dx) < Math.abs(dy) * 1.2) return;
    if (dx < 0 && page === 'radio') requestPage('home');
    else if (dx > 0 && page === 'home') requestPage('radio');
  };

  const goOverlay = (o: RadioOverlay) => { blurActive(); setOverlay(o); };
  const launchApp = (pkg: string) => void RadioLauncher.launchApp({ pkg }).catch(() => {});

  return (
    // Live2D 舞台两页常驻，故原生下 root/frame 整条链透明（角色/背景画在 WebView 之下的 GLSurfaceView，
    // DOM 链任一层有不透明背景都会挡住它）。DJ 页满屏露角色；主界面靠九宫格 box-shadow 挖洞只在卡片处露。
    // 仅原生生效（CSS html.native-live2d 门控）；浏览器走 Pixi canvas（在 DOM 内，天然在九宫格之下）。
    <div className="radio-root" ref={rootRef}>
      <div className="radio-frame">
        <div className="radio-screen" ref={screenRef} onPointerDown={onDown} onPointerUp={onUp}>
          {/* —— Live2D 舞台：常驻挂载，两页共用同一模型；切页角色构图 morph 封在 RadioStage 内部（逐帧只重渲染
              它自己，不拖累九宫格/播放器）。DOM 两页（播放器 / 九宫格）常驻并各自 CSS 平移滑入滑出。 —— */}
          {djAvatar ? (
            <RadioStage
              page={page}
              avatar={djAvatar}
              expressionMix={composed.expressionMix}
              parameterOverrides={stageParamOverrides}
              mouthSyncOverrides={mouthOverrides}
              costumeParamOverrides={djCfg?.costume ?? EMPTY_PARAM_OVERRIDES}
              action={mergedAction}
              motionName={motionName ?? 'idle'}
              onModelBounds={pet.onModelBounds}
              cardTransform={cardTransform}
              djReady={djReady}
              onReady={onDjReady}
            />
          ) : null}

          {/* DJ 播放器页：page!=radio 时向左滑出 */}
          <div className={`radio-slot${page === 'radio' ? '' : ' radio-slot--off-left'}`}>
            <RadioPlayerCard
              view={player.view}
              coverUrl={player.coverUrl}
              onToggle={player.actions.toggle}
              onNext={player.actions.next}
              onPrev={player.actions.prev}
              onOpenList={() => goOverlay('list')}
            />
          </div>

          {/* 主界面九宫格页：page!=home 时向右滑出 */}
          <div className={`radio-slot${page === 'home' ? '' : ' radio-slot--off-right'}`}>
            <RadioHomeGrid
              view={player.view}
              onToggle={player.actions.toggle}
              onNext={player.actions.next}
              onPrev={player.actions.prev}
              onOpenRadio={() => requestPage('radio')}
              onOpenMoreApps={() => goOverlay('moreApps')}
              onOpenSettings={() => goOverlay('settings')}
              onLaunchApp={launchApp}
              cardLoading={!djReady}
              inCall={inCall}
              callMicMuted={callMicMuted}
              onStartCall={startCall}
              onToggleMic={toggleCallMic}
              onHangUp={hangUp}
            />
          </div>
        </div>

        <RadioStatusBar />

        {page === 'radio' && bootReady && djReady ? (
          <PetBadge level={pet.derived.level} bubble={pet.bubble} onOpen={() => pet.setPanelOpen(true)} />
        ) : null}
        {pet.panelOpen ? (
          <PetPanel
            derived={pet.derived}
            counters={pet.persist.counters}
            favorite={favoriteSnackFor(djId)}
            onClose={() => pet.setPanelOpen(false)}
            onSnackTap={(snack, el) => pet.tapFeedSnack(snack, el)}
          />
        ) : null}
        {pet.flight ? (
          <div className="pet-drag-ghost" style={{ left: pet.flight.x, top: pet.flight.y }}>
            {SNACKS.find((s) => s.id === pet.flight?.snack)?.emoji}
          </div>
        ) : null}
        {pet.hearts.map((h) => (
          <div key={h.id} className="pet-heart" style={{ left: h.x, top: h.y }}>❤️</div>
        ))}

        {/* 启动预热 cover：预热循环（DJ→主界面→DJ）跑完前用全屏深灰盖住，藏掉预热过程的滑动/构图切换。 */}
        {!bootReady ? <div className="radio-boot-cover"><div className="radio-spinner" /></div> : null}

        {overlay === 'list' ? (
          <TrackListSheet
            tracks={player.tracks}
            phase={player.phase}
            currentId={player.view.track?.id ?? null}
            onPlayAt={(i) => { void player.actions.playAt(i); goOverlay(null); }}
            onRescan={() => void player.actions.rescan()}
            onRequestPermission={() => void player.actions.requestPermission()}
            onClose={() => goOverlay(null)}
          />
        ) : overlay === 'moreApps' ? (
          <MoreAppsPopup onClose={() => goOverlay(null)} />
        ) : overlay === 'settings' ? (
          <RadioSettingsSheet
            onRescan={() => void player.actions.rescan()}
            onClose={() => goOverlay(null)}
            djId={djId}
            onSelectDj={selectDj}
            voiceVolume={voiceVolume}
            onVoiceVolume={changeVoiceVolume}
          />
        ) : null}
      </div>
    </div>
  );
}
