import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { createRoot } from 'react-dom/client';

import { Live2DScene } from '../screensaver/Live2DScene';
import { screensaverNativeAvailable, setNativeScreensaverBackground } from '../screensaver/lib/nativeLive2dScreensaver';
import { setPetStripFraming } from '../features/live2d/live2dEngine';
import { IDENTITY_DELTA } from '../lib/mobileTransform';
import { setLive2DRendererPref } from '../lib/deviceTier';
import { getAvatarById } from '../features/live2d/avatarManifest';
import { nativePetBottomMask, shouldFadePetBottom } from './petVisualMode.ts';
import { handheldStripLayerLayout } from './handheldStripUi.ts';
import { accelToTiltAngles, tiltToFocus, lowPass, createGravityEstimator, createTiltGate } from '../features/live2d/deviceTilt';
import type { Live2DController } from '../screensaver/lib/live2dController';
import { createPetCallStage, type PetCallStage } from './petCall';
import { StrategistPanel } from './StrategistPanel';
import { useStrategist } from './useStrategist';
import {
  initialGreetingPresentation,
  installPetPresentationBridge,
} from './strategistGreetingGate.ts';
import { setInjectedToken } from '../lib/apiClient';
import { getDefaultCallSettings } from '../lib/callSettingsStore';
import { buildVoiceCallSystemPrompt, buildVideoCallSystemPrompt } from '../lib/promptTemplate';
import { CallOverlay } from '../components/CallOverlay';
import './pet.css';
import '../call.css'; // 复用主 App 通话 UI(CallOverlay)的样式

// chibi/Q版角色：模型内自带触发 Q 版形态的「变小」类参数，拉满即变 Q 版（矮身大头，适合全身展示）。
// headSizeNorm=喂给 auto-fit 的「脸高占模型高的比例」；尺寸 ∝ faceScreenFrac/headSizeNorm，
// 故 headSizeNorm 越小 → 角色越大。要新增 chibi 角色，在此加一条（并确认其「变小」参数 id）。
type ChibiConfig = {
  costume: { id: string; value: number }[];
  headSizeNorm: number;
  // Q 版形态头在模型空间的纵向锚点（脸中心占模型高的比例）。默认 0.16 是高身形态的值，
  // Q 版大头短身时脸位置不同 → 需专门覆盖，否则 auto-fit 把角色推到画面外。增大→角色上移。
  headAnchorY?: number;
};
const PET_CHIBI: Record<string, ChibiConfig> = {
  // rattan：Param120/Param127 拉满 → Q 版（模型自带 exp/大Q.exp3.json 即设此二参）。
  rattan: {
    costume: [
      { id: 'Param120', value: 1 },
      { id: 'Param127', value: 1 },
    ],
    // 撑满且完整(任何窗口比例)：petFull 开 fitWindowHeight(按真实窗口高适配，不裁腿)后，hs=0.09/ha=0.70 预览标定，
    // 3:4/1:1/9:16 三种比例都露完整光环+脚、占~77%居中。尺寸 ∝ faceScreenFrac/headSizeNorm 越小越大；ha 越大越上移。
    headSizeNorm: 0.09,
    headAnchorY: 0.70,
  },
};

const params = new URLSearchParams(window.location.search);
const avatarId = params.get('avatar') || undefined;
const bgOn = params.get('bg') === '1';
const chibiOn = params.get('chibi') === '1';
const gyroOn = params.get('gyro') === '1';
// 底条模式（掌机）：浮窗被拉成满宽横条（720×240），布局要换成「角色靠左 + 右侧对话/功能区」，
// 而不是默认的角色铺满整窗。见 src/handheld/handheldStrip.ts。
const stripOn = params.get('strip') === '1';
const stripUi = params.get('stripUi') || '';
const stripLayerLayout = handheldStripLayerLayout();
// 底条取景**目标**（屏幕空间）：桌面设置页两个滑块下发的就是这两个。语义见 handheldAvatars.ts。
// ★与下面的 ?hs=/?ha= 不是一回事：那两个是模型固有度量，当旋钮用会让位置灵敏度被大小缩放。
const stripHy = params.get('hy');
const stripFf = params.get('ff');
// loading 剪影占位图（Live2D 就绪前显示）。
const silhouetteUrl = params.get('sil');
// 军师上下文（Task 3 由 handheldStrip 折进 petQuery）。缺了也不炸：面板会提示去设置里填。
// sh=底条高度（原生截屏用它当裁剪量，去掉底条上的角色自己）。
const stripHeightPx = Number(params.get('sh')) || 240;
const strategistBaseUrl = params.get('sv') || '';
const romFileName = params.get('rom') || '';
// romp=ROM 绝对路径。用来找同名的 .srm 存档，军师据此知道玩家打到哪了
// （见 lib/strategist/saveFile.ts）。overlayPlugin.ts 早就在传，之前没人读。
const romPath = params.get('romp') || '';
// Aiboo 后台（语音）。ab=地址，token 与 deviceId 走 Intent extra 注入（不进 URL）。
const aibooBaseUrl = params.get('ab') || '';
const aibooDeviceId = params.get('did') || '';
// 原生 GL 目标帧率。★底条这条路径以前从没传过 → 一直吃 Live2DScene 默认的 15。
const nativeFps = Number(params.get('fps'));
// pet.localhost 与主 App localhost 不同源，localStorage 隔离且旧值跨安装持久。
// 显式 ?renderer= 覆盖 pet 源的历史 pref：'native'=原生 GL（透明 clear 悬浮，见 transparentClear）；
// 'webview'=Pixi。U3 固定浮窗现传 native（提帧率+保物理，透明由 clearColor=#00000000 实现）。
const rendererParam = params.get('renderer');
if (rendererParam === 'webview') setLive2DRendererPref('webview');
else if (rendererParam === 'native') setLive2DRendererPref('native');
// 离线合成演示路径（无后端/RTC 也能过审预览）：?calldemo=1 时通话走 stage.startDemo()，
// 否则走真实火山 RTC（createCallClient，见下方 callMode 生命周期 effect）。
const callDemo = params.get('calldemo') === '1';

// Q 版仅在开关开启且该角色有配置时生效；否则走原始形态（上半身特写）。
const chibiConfig = chibiOn ? PET_CHIBI[avatarId ?? ''] : undefined;
const chibi = !!chibiConfig;
// 底条用 petStrip（=pet 同构图但放开顶部钳制，否则 240px 条里位置滑块全程被夹死）
const framing = stripOn ? 'petStrip' : chibi ? 'petFull' : 'pet';

// ★取景目标覆盖必须在 Live2DScene 挂载**之前**就位：它挂载时按 SURFACE_FRAMING 算首帧构图，
// 晚一步首帧就是旧构图（会看到角色跳一下）。模块级执行，早于 React。
if (stripOn) {
  setPetStripFraming({
    headScreenY: stripHy != null ? Number(stripHy) : undefined,
    faceScreenFrac: stripFf != null ? Number(stripFf) : undefined,
  });
}

// 头部框选调参口：Q 版用于快速迭代（真机走 overlay 拿不到时用烧入值），非 Q 版（如 U3 固定浮窗）
// 用它自定义构图（默认走角色自带 headSizeNorm/headAnchorY，U3 需要「胸部以上」的更紧构图，
// 与角色默认不同，故 radioOverlay.ts 显式传 hs/ha 覆盖）。
// ?hs=脸比例(越小越大) ?ha=纵向锚点。注意 headAnchorY>~0.4 被 computeModelLayout 顶部钳制吃掉（[-0.2,0.55]×rawHeight），
// 故当前钳制下 hs=0.20/ha=0.40 已是最大干净全身框选；要更大须放开该共享钳制（影响屏保/主页，待定）。
const dbgHs = params.get('hs');
const dbgHa = params.get('ha');
const chibiHead = chibiConfig
  ? {
      headSizeNorm: dbgHs != null ? Number(dbgHs) : chibiConfig.headSizeNorm,
      headAnchorY: dbgHa != null ? Number(dbgHa) : chibiConfig.headAnchorY,
    }
  : (dbgHs != null || dbgHa != null)
    ? { headSizeNorm: dbgHs != null ? Number(dbgHs) : undefined, headAnchorY: dbgHa != null ? Number(dbgHa) : undefined }
    : undefined;

// 背景：优先用主 App 传入的后端角色背景；pet 页离线 avatar 无 defaultBackground，回落家园背景。
// 相对路径在 appassets 下解析到 assets/public/。后端背景为 http:// → 桌宠页须 http 源加载（见 OverlayWindow.setHttpAllowed）。
const avatar = avatarId ? getAvatarById(avatarId) : undefined;
const bgUrl = bgOn ? (params.get('bgUrl') || avatar?.defaultBackground || './backgrounds/home-bg.jpg') : null;

// 原生 GL 路径下 DOM 背景层会整个盖住 WebView 之下的 SurfaceView（角色被背景挡没，真机实报）——
// 背景改交原生 GL 画（主 App/屏保同一条 setBackground 通道），DOM 层不铺。高端 Pixi 路径维持 DOM 背景。
const nativeBg = bgUrl != null && screensaverNativeAvailable();

// 软边渐隐仅用于「透明悬浮 + 上半身」：有背景时背景已遮住裁切、Q 版全身要留完整脚——都不渐隐。
const fade = shouldFadePetBottom({ stripOn, bgOn, chibi });
const nativeBottomMask = nativePetBottomMask({ stripOn, bgOn, chibi });

// 惯性晄晃常数（★真机手感调）：KICK=冲量→速度(越大甩越狠)、STIFF=回弹刚度、DAMP=每帧阻尼(越小停越快)。
// 初版太轻无感知 → 大幅加大 KICK(0.012→0.05)、软化弹簧(STIFF 55→42)、减阻尼(0.82→0.86)让摆动幅度与余振更明显。
const KICK = 0.05;
const STIFF = 42;
const DAMP = 0.86;
const GYRO_HOLD_MS = 2500; // 陀螺仪最近一次出数后仍写 focus 的保持窗（与主 App 待机让位量级一致）。

// 跨源 token 注入桥（★必须模块级，不能进 useEffect）：原生 OverlayWindow.onPageFinished 页面一加载完
// 就 evaluateJavascript 调 window.__petAuth(token)，这早于 React useEffect 运行——若 __petAuth 定义在
// useEffect 里则注入时它还 undefined，`&&` 守卫短路跳过 → token 永不注入 → apiPost 401（实测坑）。
// 模块顶层赋值在脚本执行时即生效，早于 onPageFinished。setInjectedToken 是纯函数无需 React state。
// 军师设备 token 与 apiClient 的 token 走同一条 Intent extra 通道（不进 URL，避免被
// loadUrl / PetOverlayWeb console 打进 logcat），但消费者不同：这里存成模块级变量
// 给 strategistClient 拼 X-Device-Token。不导出——useStrategist 靠 main.tsx 传进去的
// 闭包读它，反向 import 入口模块会绕出一条循环依赖。
let strategistToken = '';
let aibooToken = '';
(window as unknown as { __petAuth?: (t: string) => void }).__petAuth = (t) => {
  setInjectedToken(t || null);
  strategistToken = t || '';
};
// ★两个 token 各走各的，别再互相覆盖：军师问答用军师的 device token（打我的服务端），
// 语音用 Aiboo 的 token（打阿里云）。之前只有一条通道，我把 apiClient 的那个覆盖了。
(window as unknown as { __aibooAuth?: (t: string) => void }).__aibooAuth = (t) => {
  aibooToken = t || '';
};

function PetApp() {
  const ctlRef = useRef<Live2DController | null>(null);
  // 通话态：null=idle，'voice'/'video'。原生 onTap 经 window.__petStartCall 触发。UI 复用 CallOverlay。
  const [callMode, setCallMode] = useState<'voice' | 'video' | null>(null);
  const [stripChatOpen, setStripChatOpen] = useState(false);
  // 剪影占位：Live2D 就绪前顶上。真机 F10 到出画约 2.5 秒，这段时间窗口全透明，
  // 观感上就是"按了没反应"（其中 model loaded 那段最重，300 参数的双生尤甚）。
  const [live2dReady, setLive2dReady] = useState(false);
  const isHandheldStrip = stripUi === 'figma-handheld';
  // 原生可能在 React bridge 注册前发过 hidden 通知，所以预热底条绝不自行猜为可见。
  // 普通桌宠没有 presentation bridge，沿用一生一次的稳定 legacy presentation。
  const [presentation, setPresentation] = useState(() =>
    initialGreetingPresentation(isHandheldStrip),
  );
  // petCall 演出舞台（音量→口型/字幕→情绪）。CallOverlay 的 onBotAudioLevel/onBotUtterance 经 stageRef 路由到它。
  const stageRef = useRef<PetCallStage | null>(null);
  // 陀螺仪目标（useDeviceTilt 已含 Accelerometer 主源 + tiltToFocus 映射 + 两轴翻转 + 平滑）。
  const gx = useRef(0);
  const gy = useRef(0);
  const gyroLastAt = useRef(-1e9);

  // 通话触发桥：原生 onTap 经 evaluateJavascript 调用（与 __petDrag/__petAccel 同一模式）。
  // ★底条模式不注册：底条的点击语义是军师问答（未接），不是打电话——真机实翻过一次
  // 误触发（401 /rtc/token）。原生层底条窗口已 FLAG_NOT_TOUCHABLE 收不到触摸，
  // 这里是第二道锁：就算有人把穿透关了，电话也起不来。
  useEffect(() => {
    if (stripOn) return;
    (window as unknown as { __petStartCall?: (mode: 'voice' | 'video') => void }).__petStartCall = (mode) => {
      setCallMode(mode === 'video' ? 'video' : 'voice');
    };
  }, []);

  // 原生只在完整帧真正 reveal 后推 visible=true。卸载恢复旧 handler，避免 HMR 或重复
  // mount 把别的调用方留下的 bridge 永久覆盖。
  useEffect(() => {
    if (!isHandheldStrip) return;
    return installPetPresentationBridge(window, (visible, presentationId, revealedElapsedMs) => {
      setPresentation({
        visible,
        presentationId,
        revealedElapsedMs,
        receivedAt: performance.now(),
      });
    });
  }, [isHandheldStrip]);

  // （跨源 token 注入桥 __petAuth 已移至模块顶层，见文件上方——必须早于 onPageFinished 定义。）

  // 通话演出舞台：callMode 非空时起 petCall stage（音量→口型、字幕→情绪）。RTC client 由 CallOverlay
  // 自己管（建连/挂断/mic/摄像头/UI），它经 onBotAudioLevel/onBotUtterance 回调把演出数据喂给本 stage
  // （渲染处用 stageRef 路由，见下）。?calldemo=1 无后端时用 stage.startDemo 离线合成演示（预览用）。
  // 挂断/卸载 stop() 归零口型表情。
  useEffect(() => {
    if (!callMode || !ctlRef.current) return;
    const stage = createPetCallStage(ctlRef.current);
    stageRef.current = stage;
    if (callDemo) stage.startDemo();
    return () => {
      stage.stop();
      stageRef.current = null;
    };
  }, [callMode]);

  // 通话态 touchCatcher 放行桥：通话中原生 touchCatcher 挡住 DOM 里的挂断/麦克风按钮（真机实测不可点），
  // 故通话开始时喂 AibooPetOverlay.setCallActive(true) 让原生隐藏 touchCatcher 放行触摸给 WebView，
  // 挂断/卸载时置回 false 恢复拖动/长按/点按。AibooPetOverlay 只在 OverlayWindow 里挂载，浏览器预览
  // 下 undefined，可选链兜底为 no-op，不影响预览。
  useEffect(() => {
    const overlay = (window as unknown as {
      AibooPetOverlay?: { setCallActive?: (active: boolean) => void };
    }).AibooPetOverlay;
    overlay?.setCallActive?.(!!callMode);
    return () => {
      overlay?.setCallActive?.(false);
    };
  }, [callMode]);

  // 陀螺仪：原生 SensorManager 经 window.__petAccel 喂加速度（overlay WebView 传感器被门控，不走 web 传感器）。
  // 复用主页同款映射：重力低通 → accelToTiltAngles → tiltToFocus(含屏幕角/基准/量程) → 低通 → 两轴翻转 → 门控。
  useEffect(() => {
    if (!gyroOn) return;
    const SMOOTH = 0.25, GRAVITY_ALPHA = 0.05;
    const gravity = createGravityEstimator(GRAVITY_ALPHA);
    const gate = createTiltGate();
    let smX = 0, smY = 0, baselineBeta: number | null = null, count = 0;
    const screenAngle = () =>
      (typeof screen !== 'undefined' && screen.orientation && typeof screen.orientation.angle === 'number')
        ? screen.orientation.angle : 0;
    (window as unknown as { __petAccel?: (x: number, y: number, z: number) => void }).__petAccel = (x, y, z) => {
      const g = gravity.update(x, y, z);
      const { beta, gamma } = accelToTiltAngles(g.x, g.y, g.z);
      if (baselineBeta == null) baselineBeta = beta;
      const { nx, ny } = tiltToFocus(beta, gamma, screenAngle(), { baselineBetaDeg: baselineBeta });
      smX = lowPass(smX, nx, SMOOTH);
      smY = lowPass(smY, ny, SMOOTH);
      // 取负：设备轴与「朝倾斜方向看」相反（主页实测两轴均翻转）。门控只转发真实动作。
      if (gate.push(-smX, -smY, performance.now())) {
        gx.current = -smX;
        gy.current = -smY;
        gyroLastAt.current = performance.now();
        if (count < 3) { count += 1; console.log('[pet] gyro tilt nx=%s ny=%s', (-smX).toFixed(3), (-smY).toFixed(3)); }
      }
    };
    console.log('[pet] gyro: native accel bridge ready (window.__petAccel), origin=%s', window.location.origin);
  }, []);

  // 取景热更新桥：桌面设置页拖滑块 → OverlayPlugin.updateFraming → 原生 evaluateJavascript
  // → 这里。只改取景目标 + refit，**不重载模型**（重载要约 2.5 秒，实时预览就没了）。
  // 通道形状与 __petDrag/__petAccel 一致；非 overlay 场景（浏览器预览）没人调，安全空跑。
  useEffect(() => {
    if (!stripOn) return;
    (window as unknown as { __petFraming?: (hy: number, ff: number) => void }).__petFraming = (hy, ff) => {
      setPetStripFraming({ headScreenY: hy, faceScreenFrac: ff });
      ctlRef.current?.refit?.();
    };
  }, []);

  // 军师播报的口型：复用 petCall stage 的 onBotAudioLevel 通道（音量→嘴）。
  // ★只在底条模式起：普通桌宠浮窗的 stage 由 callMode 生命周期管，别抢它。
  useEffect(() => {
    if (!stripOn || !live2dReady || !ctlRef.current) return;
    const stage = createPetCallStage(ctlRef.current);
    stageRef.current = stage;
    return () => {
      stage.stop();
      stageRef.current = null;
    };
  }, [live2dReady]);

  // 军师问答编排：原生触摸洞 → 截屏 → SSE → 状态机。底条模式才有意义，
  // 但 hook 不能条件调用，所以内部靠 stripOn 之外的降级（无原生桥时报 NO_NATIVE）自洽。
  const strategist = useStrategist({
    endpoint: () => ({ baseUrl: strategistBaseUrl, deviceToken: strategistToken }),
    // 语音走 Aiboo 后台（阿里云，公网可达）——凭证与音色绑定都在那边，
    // 军师服务端完全不碰语音（我一度在那边重写了火山协议，纯重复，已删）。
    aibooEndpoint: () => ({ baseUrl: aibooBaseUrl, token: aibooToken, deviceId: aibooDeviceId }),
    avatarId: avatarId ?? '',
    presentationId: presentation.presentationId,
    presentationVisible: presentation.visible,
    presentationRevealedElapsedMs: presentation.revealedElapsedMs,
    presentationReceivedAt: presentation.receivedAt,
    compositeReady: live2dReady,
    romFileName,
    romPath,
    stripHeightPx,
    // 表情是锦上添花：Live2DController 未必有 setEmotion，缺了静默跳过，
    // 绝不能因为它炸掉问答本身。
    onEmotion: (emo) => (ctlRef.current as unknown as { setEmotion?: (e: string) => void })?.setEmotion?.(emo),
    onSpeechLevel: (l) => stageRef.current?.onBotAudioLevel(l),
  });

  // 焦点泵：setFocus 唯一写入者，每帧合成「陀螺仪朝向 + 拖拽惯性」。
  // 静止时（无陀螺仪出数 且 惯性收敛）停写，让位给引擎待机朝向拍，不打断 idle 小动作。
  useEffect(() => {
    const clamp1 = (v: number) => Math.max(-1, Math.min(1, v));
    let px = 0, py = 0, vx = 0, vy = 0, impX = 0, impY = 0;
    (window as unknown as { __petDrag?: (ddx: number, ddy: number) => void }).__petDrag = (ddx, ddy) => {
      impX += ddx; impY += ddy;
    };
    let lastT = performance.now();
    let raf = 0;
    const pump = () => {
      const now = performance.now();
      const dt = Math.min(0.05, (now - lastT) / 1000); lastT = now;
      vx += impX * KICK; vy += impY * KICK; impX = 0; impY = 0; // 拖拽方向踢（Ben 要顺拖拽方向摆）
      vx += -px * STIFF * dt; vy += -py * STIFF * dt;             // 弹簧回中
      vx *= DAMP; vy *= DAMP;                                     // 阻尼
      px += vx * dt; py += vy * dt;
      const inertiaActive = Math.abs(px) + Math.abs(vx) + Math.abs(py) + Math.abs(vy) > 1e-3;
      const gyroActive = now - gyroLastAt.current < GYRO_HOLD_MS;
      const c = ctlRef.current;
      if (c?.setFocus && (gyroActive || inertiaActive)) {
        c.setFocus(clamp1(gx.current + px), clamp1(gy.current + py));
      }
      raf = requestAnimationFrame(pump);
    };
    raf = requestAnimationFrame(pump);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div
      className={[stripOn ? 'pet-strip' : null, bgOn ? 'pet-card' : fade ? 'pet-fade' : null]
        .filter(Boolean)
        .join(' ') || undefined}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'transparent',
        '--pet-strip-model-top': `${stripLayerLayout.modelTopPx}px`,
        '--pet-strip-silhouette-bottom': `${stripLayerLayout.silhouetteBottomPx}px`,
        '--pet-strip-statusbar-height': `${stripLayerLayout.statusbarHeightPx}px`,
        '--pet-strip-right-panel-bottom': `${stripLayerLayout.rightPanelBottomInsetPx}px`,
        '--pet-strip-statusbar-layer': stripLayerLayout.layers.statusbar,
        '--pet-strip-model-layer': stripLayerLayout.layers.model,
        '--pet-strip-controls-layer': stripLayerLayout.layers.controls,
      } as CSSProperties}
    >
      {bgUrl && !nativeBg ? <div className="pet-bg" style={{ backgroundImage: `url(${bgUrl})` }} /> : null}
        {/* 底条的左半：对话与功能区。第一版先立壳（军师的回答、功能按钮之后填进来），
            现在放一句占位，好在真机上确认比例与可读性。 */}
        {stripOn ? (
         <StrategistPanel
           state={strategist.state}
           spokenChars={strategist.spokenChars}
           chatOpen={stripUi === 'figma-handheld' ? stripChatOpen : true}
           onOpenChat={() => setStripChatOpen(true)}
           onExitChat={() => setStripChatOpen(false)}
         />
        ) : null}
      {/* loading 剪影：角色出画前顶在它将来会在的那个方块里，出画即淡出（见 pet.css）。 */}
      {stripOn && silhouetteUrl && !live2dReady ? (
        <img className="pet-strip-silhouette" src={silhouetteUrl} alt="" aria-hidden="true" />
      ) : null}
      <Live2DScene
        avatarId={avatarId}
        framing={callMode === 'video' ? 'petCall' : framing}
        // ★底条必须显式传单位 transform：不传时 Live2DScene 会回落到
        // djConfigForModelAvatar 的**电台 DJ 页**构图（双生那套 {0.6275, 0, -1.15}）。
        // 那个 -1.15 把模型上推约 490px，底条里就只剩两条腿（浏览器实证）。
        // 底条有自己的取景目标（petStrip + ?hy/?ff），不该再叠别的页面的构图。
        stageTransform={stripOn ? IDENTITY_DELTA : undefined}
        costume={chibiConfig?.costume}
        framingHead={chibiHead}
        resolutionCap={Math.min(window.devicePixelRatio || 2, 3)}
        // 桌宠/固定浮窗悬浮：原生渲染路径清屏透明，GL 空白处露出桌面（有 bg 时背景层盖住，透明也无妨）。
        // ★nativeBg 时必须透明清屏：圆角是背景 shader 擦 alpha 擦出来的，角区只剩清屏色——
        // 不透明清屏会让四个角露出黑角（真机实锤）。
        transparentClear={!bgOn || nativeBg}
        // 软边渐隐的原生 GL 版：与上面 .pet-fade 那条 CSS 遮罩同条件、同数值（76%→98%）。
        // 两条路径各管各的——CSS 遮罩只作用于 DOM canvas(Pixi)，盖不到原生的 SurfaceView。
        bottomFade={nativeBottomMask}
        bottomBar={stripOn ? stripLayerLayout.nativeBottomBar : null}
        // ★不传会吃 Live2DScene 默认的 15（U1 Pro 时代的省电地板）——底条真机 logcat 实测过 target=15。
        targetFps={Number.isFinite(nativeFps) && nativeFps > 0 ? nativeFps : undefined}
        onReady={(c) => {
          ctlRef.current = c;
          setLive2dReady(true);
          // 原生路径的背景图在 onReady 后下发：glHost 要等 showModel 才建，提前调会被原生侧静默丢弃。
          if (nativeBg) void setNativeScreensaverBackground(bgUrl);
          // U3 固定浮窗首帧就绪信号：主 App 等它收 loading（而非 overlay start() 调用本身）。
          // 非 overlay 场景（如普通桌宠悬浮）该桥不存在，安全空跑。
          (window as unknown as { AibooOverlayReady?: { ready?: () => void } }).AibooOverlayReady?.ready?.();
        }}
      />
      {callMode && (
        // 复用主 App 通话 UI：CallOverlay 自管 RTC client(建连/挂断/mic/摄像头/状态/计时)，
        // 经 onBotAudioLevel/onBotUtterance 把演出数据喂给 stageRef 里的 petCall stage → 驱动口型/表情。
        // .pet-call-scope：CallOverlay 尺寸是为主 App 全屏设计的，浮窗小窗要缩小按钮/间距(仅覆盖，见 pet.css)。
        <div className="pet-call-scope">
        <CallOverlay
          open
          mode={callMode}
          avatarName={avatar?.name ?? avatarId ?? ''}
          avatarId={avatarId ?? ''}
          voice={avatar?.voice}
          systemMessage={
            avatar
              ? callMode === 'video'
                ? buildVideoCallSystemPrompt(avatar)
                : buildVoiceCallSystemPrompt(avatar)
              : undefined
          }
          callSettings={getDefaultCallSettings()}
          onBotAudioLevel={(l) => stageRef.current?.onBotAudioLevel(l)}
          onBotUtterance={(t) => stageRef.current?.onBotUtterance(t)}
          onClose={() => setCallMode(null)}
        />
        </div>
      )}
    </div>
  );
}

const rootEl = document.getElementById('pet-root');
if (rootEl) {
  createRoot(rootEl).render(<PetApp />);
}
