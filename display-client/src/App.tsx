import { FormEvent, KeyboardEvent, TouchEvent as ReactTouchEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Live2DStage } from './features/live2d/Live2DStage.tsx';
import { isBundledModelJson, nativeStageEnabled } from './features/live2d/nativeStage.ts';
import { createConfigFetchGate } from './features/live2d/configFetchGate.ts';
import {
  NO_AVATAR,
  avatarList,
  getAvatarById,
  useAvatarList,
  getAvatarNeutralExpressionId,
  resolveAvatarManifestById,
  readLipSyncParamIds,
  applyRemoteConfig,
  mergeRemoteConfig,
  invalidateAvatarResolution,
  type AvatarManifest,
  type DiscoveredLive2DParameter,
  type ExpressionLayer,
  type ParameterCall,
  type ParameterOverride,
  type MouthSyncState,
} from './features/live2d/avatarManifest.ts';
import {
  selectMouthParameter,
  computeMouthValue,
} from './features/live2d/mouthSync.ts';
import { useParameterDebug } from './features/live2d/useParameterDebug.ts';
import { isMouthParam } from './features/live2d/mouthParams.ts';
import { fetchAvatarConfig } from './features/live2d/avatarConfigSync.ts';
import { reconcileLorebook, type LorebookSyncSource } from './features/live2d/lorebookSync.ts';
import { useRemoteAvatars } from './hooks/useRemoteAvatars.ts';
import {
  type ChatMessage,
} from './lib/llm.ts';
import {
  speakText,
  playAudioUrl,
  stopSpeaking,
} from './lib/tts.ts';
import { useChat } from './hooks/useChat.ts';
import { usePresence } from './features/live2d/presence/usePresence.ts';
import { setSoullinkEmotionParams } from './features/live2d/live2dEngine.ts';
import { createSoullinkBridge, type EmotionBridge } from './features/live2d/emotion/soullinkBridge.ts';
import { isSoullinkEmotionEnabled } from './features/live2d/emotion/emotionFlag.ts';
import shuangshengProfile from './features/live2d/emotion/profiles/shuangsheng.profile.json';
import type { ModelProfile } from '@soullink-emotion/engine';
import { useSettings } from './features/settings/useSettings.ts';
import { ImagePreviewModal } from './components/ImagePreviewModal.tsx';
import type { StageTransform, RuntimeState } from './features/live2d/live2dEngine.ts';
import {
  loadProfileByRole,
  attachProfileBinding,
  initTtsEndTracker,
  loadV2Profile,
  attachV2ProfileBinding,
  attachNativeV2ProfileBinding,
  validateV2Profile,
  diffShuangshengPair,
  type ProfileBinding,
  type RoleProfile,
  type V2Profile,
  type V2ProfileBinding,
  type CostumeSlot,
} from './features/live2d/profile';
import { SettingsModal } from './components/SettingsModal.tsx';
import { ControlDrawer } from './components/ControlDrawer.tsx';
import { MessageBubble } from './components/MessageBubble.tsx';
import { ChatComposerPanel } from './components/ChatComposerPanel.tsx';
import { StickerPanel } from './components/StickerPanel.tsx';
import type { Sticker } from './lib/stickerTypes.ts';
import { scaleImageFile, type ScaledImage } from './lib/imageScale.ts';
import { resolveHomeFraming, resolveLoginFraming, IDENTITY_DELTA } from './lib/mobileTransform.ts';
import { loadBackgrounds, saveBackground } from './lib/backgroundGen.ts';
import { applyLifeSignsBackground, resolveLifeSignsBackgroundUrl } from './lib/sceneBackground.ts';
import { loadLastAvatarId, saveLastAvatarId } from './lib/lastAvatarStore.ts';
import { loadBubbleStyle, saveBubbleStyle, type BubbleStyle } from './lib/bubbleStyleStore.ts';
import { loadSensorEnabled, saveSensorEnabled } from './lib/sensorSettingsStore.ts';
import { BackgroundPanel } from './components/BackgroundPanel.tsx';
import { CharacterSettingsModal } from './components/CharacterSettingsModal.tsx';
import { CallOverlay } from './components/CallOverlay.tsx';
import { CallModePopover } from './components/CallModePopover.tsx';
import { useCall } from './features/call/useCall.ts';
import { loadCharacterSettings } from './lib/characterSettingsStore.ts';
import { buildVoiceCallSystemPrompt, buildVideoCallSystemPrompt } from './lib/promptTemplate.ts';
import { DiaryPage } from './components/DiaryPage.tsx';
import { ChatHistoryPage } from './components/ChatHistoryPage.tsx';
import { DjMode } from './components/DjMode.tsx';
import { HoloDashboard } from './holo/HoloDashboard.tsx';
import { useHoloVoice } from './holo/useHoloVoice.ts';
import { BadgePanel } from './components/BadgePanel.tsx';
import { ScreensaverModal } from './components/ScreensaverModal.tsx';
import { Capacitor } from '@capacitor/core';
import type { PluginListenerHandle } from '@capacitor/core';
import { App as CapacitorApp } from '@capacitor/app';
import { Keyboard } from '@capacitor/keyboard';
import { EndingScene } from './components/EndingScene.tsx';
import { JourneyTaskCard } from './components/JourneyTaskCard.tsx';
import { useDjMode } from './hooks/useDjMode.ts';
import { useDiary } from './features/diary/useDiary.ts';
import { LoginPage } from './components/LoginPage.tsx';
import { reportDjMode } from './lib/djModeBridge.ts';
import { createUsageTracker, type UsageSegment, type UsageTracker } from './lib/usageTracker.ts';
import { reportUsageOpen, reportUsageTime } from './lib/usageApi.ts';
import {
  overlayAvailable, overlayHasPermission, overlayRequestPermission,
  overlayIsRunning, overlayStart, overlayStop,
} from './lib/overlayPlugin.ts';
import { getPetSettings } from './lib/petSettingsStore.ts';
import { PetSettingsModal } from './components/PetSettingsModal.tsx';
import { ProfilePage } from './components/ProfilePage.tsx';
import { BirthdayGateModal } from './components/BirthdayGateModal.tsx';
import { autoLogin, isLocalGuest, type UserInfo } from './lib/authStore.ts';
import { getTotalFavorability } from './lib/relationshipStore.ts';
import { getDiaryEntryCount } from './lib/diaryStore.ts';
import { setAuthErrorHandler, getStoredToken } from './lib/apiClient.ts';
import { useLifeSigns } from './hooks/useLifeSigns.ts';
import {
  saveChatMessage,
  loadChatMessages,
  saveGeneratedImage,
} from './lib/chatMedia.ts';
import { triggerOpening, normalizeOpeningMessages } from './lib/openingApi.ts';
import { useProactivePerformance } from './hooks/useProactivePerformance.ts';
import { startJourney, getUnreadCount, subscribeUnread, clearUnread } from './lib/journeyStore.ts';
import { TouchBanner } from './components/TouchBanner.tsx';
import { InlineCallPrompt, type InlineCallPromptEvent } from './components/InlineCallPrompt.tsx';
import { IncomingCallScreen, type IncomingCallScreenEvent } from './components/IncomingCallScreen.tsx';
import { postCallResult } from './lib/touchApi.ts';
import { resolveCallAvatarView } from './lib/callAvatarView.ts';
import { acceptFullscreenCall } from './lib/fullscreenAccept.ts';
import { executePull, onSyncChange, setupNetworkListeners } from './lib/syncEngine.ts';
import { ToastContainer } from './components/Toast.tsx';
import { EmptyState } from './components/EmptyState.tsx';
import { showToast } from './lib/toastStore.ts';
import type { JourneyEnding } from './lib/journeyApi.ts';
import { useVoiceRecorder } from './hooks/useVoiceRecorder.ts';
import { useIdleUiHide } from './hooks/useIdleUiHide.ts';
import { transcribeBlob } from './lib/asr.ts';
import { shouldCancelBySlide, isTooShort, LONG_PRESS_MS } from './lib/voiceGesture.ts';
import { VoiceRecordOverlay } from './components/VoiceRecordOverlay.tsx';
import { CutsceneScene } from './components/CutsceneScene.tsx';
import { useCutscene } from './hooks/useCutscene.ts';
import { useJourneyTask } from './hooks/useJourneyTask.ts';
import { completeCutscene, fetchAppearance } from './lib/cutsceneApi.ts';
import { resolveAppearanceApparel } from './lib/cutsceneAppearance.ts';
import { useSinging } from './features/singing/useSinging.ts';
import { mergeStageOverrides } from './features/singing/humSway.ts';

/**
 * 启动默认角色：上一次离开时所在角色（合法才用）→ 否则列表第一个 → 一个都没有就是 ''（NO_AVATAR）。
 * 仓库不带模型（2026-10-21），没登录 Aiboo 账号下载过角色时就是空的。
 */
function resolveInitialAvatarId(): string {
  const last = loadLastAvatarId();
  return last && getAvatarById(last) ? last : avatarList[0]?.id ?? '';
}

const defaultAvatarId = resolveInitialAvatarId();

// 上次角色是远端下载角色时，模块初始化阶段 remoteOverrides 尚未恢复（要等 useRemoteAvatars
// 读盘 + catalog），getAvatarById 解析不到 → 上面兜底成 FALLBACK，且启动 effect 会立刻把
// 兜底 id 写回 last-avatar 记忆。这里记下待恢复的远端 id，等注册表就绪后由 App 内 effect
// 自动切回（「重启回到白夜凛」修复）。
const pendingRemoteAvatarId = (() => {
  const last = loadLastAvatarId();
  return last && !getAvatarById(last) ? last : null;
})();

/** 登录页角色构图（与 LoginPage 的 PROMO_TRANSFORM 一致），用作 morph 起点 */
const LOGIN_FRAMING: StageTransform = { scale: 1, offsetX: 0, offsetY: -0.18 };

/** DJ 电台背景：由共享 Stage 的 backgroundUrl 承载（在角色之后）。换 DJ 专属背景只改这一行。 */
const DJ_BG_URL = '/backgrounds/home-bg.jpg';
/** 登录页背景（公交车）：原生模式下 DOM 的 .app-bg 被隐藏，须由原生 GL 层画——登录时把它交给舞台背景。 */
const LOGIN_BG_URL = '/backgrounds/login-bg.jpg?v=5';

// 全息屏(holo)角色构图：默认 { scale:0.78, ox:0, oy:-0.44 }（横屏调小+下移防超屏），
// 真机现场可用 holo.html?scale=0.9&oy=-0.3&ox=0 覆盖调准。见 holo/holoStage.ts。

const EMPTY_EXPRESSION_MIX: ExpressionLayer[] = [];
const EMPTY_PARAM_OVERRIDES: ParameterOverride[] = [];

// 原生渲染目标帧率。此前主 App 不传此 prop，吃 Live2DStage 的默认值 15——那是为 U1 Pro
// (0.99GHz 单核) 定的地板，却把强得多的机器一并限死：RG Rotate 实测单帧仅 14ms
// (update 5 + draw 9)，余量足够 ~70fps 却只跑 14.5。targetFps 是帧预算上限而非强制，
// 弱机跑不满只会尽力跑，故与电台 DJ 模式 (DJ_NATIVE_TARGET_FPS) 对齐取 60。
const MAIN_NATIVE_TARGET_FPS = 60;

// 桌宠浮窗的原生渲染目标帧率。不传会吃 Live2DScene 默认的 15（U1 Pro 省电地板，真机 logcat
// 实测 target=15 很卡）。浮窗常驻桌面，不追 60，取 30：流畅度翻倍、功耗温和（真机单帧 14ms，
// 33ms 预算余量充足）。
const PET_NATIVE_TARGET_FPS = 30;

// 摇一摇「被摇晕」反应现由 Live2D 引擎程序化晕摇实现（Live2DStage onShake → triggerDizzyRuntime），
// 头+眼+身随衰减振荡自然晃动，跨角色零配置。旧的静态参数覆盖太弱（睁眼被模型钳制、无头部动作）已弃用。

/** 调试态临时结局数据，用于在 UI 中预览 EndingScene；正式触发由旅程状态驱动。仅在 dev 构建可用。 */
const DEMO_ENDING: JourneyEnding | null = import.meta.env.DEV
  ? {
      id: 'demo-ending',
      journeyInstanceId: 'demo-instance',
      endingTemplateId: 'demo-template',
      bodyText:
        '谢谢你，陪我走过了这段不算长、却很满的日子。\n' +
        '那些深夜里的碎碎念，那些没能说出口的情绪，我都记得。\n' +
        '现在，我把它们轻轻放进风里。\n' +
        '愿你继续往前走，我也会在远方，偶尔想起你。',
      rhythm: 'bittersweet',
      generatedAt: new Date().toISOString(),
    }
  : null;

function easeOutQuint(t: number) {
  return 1 - Math.pow(1 - t, 5);
}

/** 主页构图：后台配置的 homeFraming 作为该页面的绝对构图直接施加；未配置回落 IDENTITY_DELTA（auto-fit 现状）。 */
function homeFramingFor(avatar: AvatarManifest): StageTransform {
  return resolveHomeFraming(avatar);
}

/** 登录页构图：后台配置的 loginFraming 优先，未配置逐级回落主页构图 → IDENTITY_DELTA。 */
function loginFramingFor(avatar: AvatarManifest): StageTransform {
  return resolveLoginFraming(avatar);
}

// 实测键盘高度（CSS px）跨冷启持久化：表情包/加号面板高度=键盘高度，
// 不持久化的话每次冷启都丢，用户在本次还没开过键盘就开面板会矮一截（280 兜底）。
const KEYBOARD_HEIGHT_KEY = 'llm-live2d:keyboard-height-px';

function readStoredKeyboardHeight(): number {
  try {
    const v = Number(localStorage.getItem(KEYBOARD_HEIGHT_KEY));
    return Number.isFinite(v) && v > 100 && v < 1200 ? Math.round(v) : 0;
  } catch {
    return 0;
  }
}

function storeKeyboardHeight(px: number) {
  try {
    localStorage.setItem(KEYBOARD_HEIGHT_KEY, String(Math.round(px)));
  } catch { /* storage 不可用则跳过 */ }
}

// 从未实测过（新装还没弹过键盘）的估算：主流中文输入法 ≈ 屏高 38.5%（本机实测 352/915）。
function estimateKeyboardHeight(): number {
  const h = Math.round(window.innerHeight * 0.385);
  return Math.min(Math.max(h, 260), 520);
}

export default function App() {
  const hasResolvedInitialAvatar = useRef(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // 通过 + 面板打开表情包时标记，避免 blur 导致输入栏先收起再弹起
  const openingStickerRef = useRef(false);
  const composerRef = useRef<HTMLFormElement>(null);
  // v2 profile 触发通道：与 Live2DStage 的 runtime/action 通道独立。
  const live2dRuntimeRef = useRef<RuntimeState | null>(null);
  // SoulLink 情绪层(主页): 角色回复文本→VAD→情绪域参数,每帧刷新到主页 runtime。仅 shuangsheng+开关。
  const soullinkBridgeRef = useRef<EmotionBridge | null>(null);
  const soullinkRafRef = useRef<number | null>(null);
  const profileTrackerRef = useRef<ReturnType<typeof initTtsEndTracker> | null>(null);
  const profileBindingRef = useRef<ProfileBinding | V2ProfileBinding | null>(null);
  const profileRef = useRef<RoleProfile | null>(null);
  const v2ProfileRef = useRef<V2Profile | null>(null);
  const isV2ProfileRef = useRef<boolean>(false);
  const [isV2Profile, setIsV2Profile] = useState(false);
  // 输入框两态：收起=底部胶囊(224-904) / 展开=贴键盘的底部面板(224-1056)，聚焦时展开
  const [composerExpanded, setComposerExpanded] = useState(false);
  // 主画面聊天气泡：只留最新数条，静默数秒后淡出让角色露出；点击/新消息重新露出。完整历史进「聊天记录」页。
  const [messagesFaded, setMessagesFaded] = useState(true);
  const [revealNonce, setRevealNonce] = useState(0); // 点击气泡区重现并重启淡出计时
  // 切角色/首次登录加载历史时，不要把「上一次的旧气泡」浮出来；只有本会话新消息才露出。
  // 加载/切换时置 true，淡出 effect 会消费它并保持淡出，之后新消息正常露出。
  const suppressRevealRef = useRef(true);
  const [chatHistoryOpen, setChatHistoryOpen] = useState(false);
  // 画外角色消息未读红点：个人主页圆钮上显示（Task 11 接线横幅+清除时机，这里只订阅计数变化）。
  const [hasUnread, setHasUnread] = useState(() => getUnreadCount() > 0);
  useEffect(() => {
    const unsubscribe = subscribeUnread(() => setHasUnread(getUnreadCount() > 0));
    return unsubscribe;
  }, []);
  // 仅保留移动布局：桌面双列布局已废弃。恒为移动端；宽屏由 .device-frame 居中成手机画幅。
  const isMobile = true;
  const [selectedAvatarId, setSelectedAvatarId] = useState(defaultAvatarId);
  const [selectedAvatar, setSelectedAvatar] = useState<AvatarManifest>(getAvatarById(defaultAvatarId) ?? NO_AVATAR);
  const [messagesByAvatar, setMessagesByAvatar] = useState<Record<string, ChatMessage[]>>({});
  const messages = messagesByAvatar[selectedAvatarId] || [];
  const refreshMessages = useCallback((avatarId: string) => {
    void loadChatMessages(avatarId)
      .then((serverMessages) => {
        // 合并而非整体覆盖：保留本地比服务端新的消息（刚发的乐观消息/回复尚未回读到服务端），
        // 避免 proactive 刷新用滞后的服务端历史把新气泡盖成旧内容。
        setMessagesByAvatar((prev) => {
          const local = prev[avatarId] || [];
          const serverIds = new Set(serverMessages.map((m) => m.id));
          const localOnlyTail = local.filter((m) => !serverIds.has(m.id));
          return { ...prev, [avatarId]: [...serverMessages, ...localOnlyTail] };
        });
      })
      .catch((e) => console.error('[proactive] refresh messages failed:', e));
  }, []);
  function setMessages(msgs: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])) {
    setMessagesByAvatar((prev) => ({
      ...prev,
      [selectedAvatarId]: typeof msgs === 'function' ? msgs(prev[selectedAvatarId] || []) : msgs,
    }));
  }
  // 形象状态合成器（单一权威写入口）：四层（情绪/服饰/形态/动作）合成出渲染所需的一组值。
  // activeExpressionMix / activeParameterOverrides / activeAction 全部从 compose() 派生，不再各自直驱 state。
  const { presence, composed } = usePresence(getAvatarNeutralExpressionId(getAvatarById(defaultAvatarId) ?? NO_AVATAR));
  const activeExpressionMix = composed.expressionMix;
  const activeParameterOverrides = composed.parameterOverrides;
  // 一次性动作（④ gesture）：取最新一条 nativeTrigger 喂给 Live2DStage 的 action（nonce 触发一次 playAction）。
  const activeAction = composed.nativeTriggers.length > 0
    ? { id: composed.nativeTriggers[0].id, nonce: composed.nativeTriggers[0].nonce }
    : null;
  const {
    llmSettings,
    ttsSettings,
    callSettings,
    ttsEnabled,
    browserVoices,
    updateLlmSettings,
    updateTtsSettings,
    updateCallSettings,
    persistSettings,
    resetSettings,
    setTtsEnabled,
  } = useSettings();
  const { callOpen, callMode, setCallOpen, startCall, startVideoCall } = useCall(callSettings);
  const [callMenuOpen, setCallMenuOpen] = useState(false);
  const [mouthOpen, setMouthOpen] = useState(0);
  // 口型参数 id 的最优先来源：model3.json Groups[LipSync].Ids（加载即有，换模型自适应）。
  const [lipSyncParamIds, setLipSyncParamIds] = useState<string[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [controlDrawerOpen, setControlDrawerOpen] = useState(false);
  const [controlDrawerScrollToDebug, setControlDrawerScrollToDebug] = useState(false);
  // 隐藏入口：长按右上角 TTS 喇叭 5 秒呼出「抓取参数」调试面板（真机上齿轮设置常看不到）。
  const ttsLongPressTimerRef = useRef<number | null>(null);
  const ttsLongPressFiredRef = useRef(false);

  // 录音手势状态
  const { state: recState, startRecording, stopRecording, cancelRecording, audioLevelRef } = useVoiceRecorder();
  const [recActive, setRecActive] = useState(false);
  const [recLevel, setRecLevel] = useState(0);
  const [recTranscribing, setRecTranscribing] = useState(false);
  const [recCancelHint, setRecCancelHint] = useState(false);
  const recCancelHintRef = useRef(false);
  const isRecordingRef = useRef(false);
  const longPressTimerRef = useRef<number | null>(null);
  const touchStartYRef = useRef(0);

  // 录音中用 rAF 把实时音量(ref)同步到 state，驱动遮罩声波。
  useEffect(() => {
    if (!recActive) {
      setRecLevel(0);
      return;
    }
    let raf = 0;
    const tick = () => {
      const v = audioLevelRef.current;
      // 变化够大才更新，避免大组件每帧重渲染
      setRecLevel((prev) => (Math.abs(prev - v) > 0.02 ? v : prev));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [recActive, audioLevelRef]);
  const {
    debugMode,
    setDebugMode,
    parameterDiscoveryResults,
    parameterDiscoveryRunning,
    parameterDiscoveryStatus,
    handleDiscoverParameters,
  } = useParameterDebug();
  const [bgPanelOpen, setBgPanelOpen] = useState(false);
  const [bubbleStyle, setBubbleStyle] = useState<BubbleStyle>(loadBubbleStyle);
  const [autoHideChat, setAutoHideChat] = useState<boolean>(() => {
    try { return localStorage.getItem('aiboo:autoHideChat') !== 'false'; } catch { return true; }
  });
  // 持久化自动隐藏偏好
  useEffect(() => {
    try { localStorage.setItem('aiboo:autoHideChat', String(autoHideChat)); } catch { /* noop */ }
  }, [autoHideChat]);
  const handleToggleAutoHide = useCallback(() => {
    setAutoHideChat((v) => !v);
    setComposerPanelOpen(false);
  }, []);
  const [sensorEnabled, setSensorEnabled] = useState<boolean>(loadSensorEnabled);
  const [djModeOpen, setDjModeOpen] = useState(false);
  const [badgePanelOpen, setBadgePanelOpen] = useState(false);
  const [screensaverOpen, setScreensaverOpen] = useState(false);
  const [petRunning, setPetRunning] = useState(false);
  const [petSettingsOpen, setPetSettingsOpen] = useState(false);
  const petPressTimer = useRef<number | null>(null);
  const petLongPressed = useRef(false);
  // 桌宠浮窗开关（仅原生）：未授权先跳 SAW 设置页，用户授权后回 App 再点一次开启。设置经 URL 参数下发。
  const togglePet = useCallback(async () => {
    if (!overlayAvailable()) return;
    if (await overlayIsRunning()) { await overlayStop(); setPetRunning(false); return; }
    if (!(await overlayHasPermission())) { await overlayRequestPermission(); return; }
    await overlayStart(
      selectedAvatarId,
      getPetSettings(),
      petBgUrl(),
      { token: getStoredToken() ?? undefined, nativeTargetFps: PET_NATIVE_TARGET_FPS },
    );
    setPetRunning(true);
  }, [selectedAvatarId]);
  // 桌宠设置改动后：若正在运行则重启浮窗使之生效。
  const restartPetWithSettings = useCallback(async () => {
    if (!(await overlayIsRunning())) return;
    await overlayStop();
    await overlayStart(
      selectedAvatarId,
      getPetSettings(),
      petBgUrl(),
      { token: getStoredToken() ?? undefined, nativeTargetFps: PET_NATIVE_TARGET_FPS },
    );
  }, [selectedAvatarId]);
  // holo(全息屏)入口标记：纯 DOM 读，常量。供 DJ 音乐频谱重路由 / 语音控制回合门控 / holo 构图。
  const isHoloSurface =
    typeof document !== 'undefined' && document.documentElement.dataset.holo === '1';
  // holo 角色构图（大小/竖向）走 surface='holo' 的头部锚点自适应；URL(?scale=&head=)在 holo/main.tsx
  // 入口用 setHoloFraming 下发。此处 transform 传 IDENTITY_DELTA（零增量），大小位置全由 holo 构图解算。
  // DJ 电台编排（升起位移/换装/口型/播放器后端）——驱动主 App 共享的那一个 Live2DStage（全程同一个模型实例）。
  // ★DJ 的 SoulLink 情绪层桥复用上面第 207 行那一个 ref，不再单独声明：两处 effect 的
  // enabled 条件互斥（主页那处要求 !djModeOpen，DJ 这处要求 djModeOpen），任何时刻只有
  // 一个持有者，共用一个 ref 不会互相覆盖。
  const djView = useDjMode({
    open: djModeOpen,
    sourceAvatarId: selectedAvatarId,
    onClosed: () => setDjModeOpen(false),
    // 仅 holo：把音乐床重路由过 AudioContext 出真频谱喂波形。移动端不传=纯 <audio> 直连(零回归)。
    enableMusicAnalyser: isHoloSurface,
    // 口播文本产生时喂给情绪引擎（桥不存在=开关关/非 shuangsheng 时为 no-op，零影响）。
    onSpokenText: (text) => soullinkBridgeRef.current?.feedText(text, performance.now() / 1000),
  });
  // DJ 换装（Param67 ramp）→ ② 服饰层（持久 costumeParamOverrides）。合成器统一下发，
  // 不再让 Live2DStage 直驱 djView.costumeOverrides 旁路。退场 ramp 归零后移除该服饰。
  useEffect(() => {
    const overrides = djView.costumeOverrides;
    if (overrides.length > 0) {
      presence.setApparel({ id: 'dj-costume', costumeParamOverrides: overrides });
    } else {
      presence.removeApparel('dj-costume');
    }
  }, [presence, djView.costumeOverrides]);
  // 登录↔主页背景渐隐：仅在切换瞬间同时渲染两张图做 opacity 交叉淡入；过渡结束回到单图(稳态清晰，避免合成层降清)。
  const [bgFading, setBgFading] = useState(false);
  const [settingsAvatarId, setSettingsAvatarId] = useState<string | null>(null);
  const settingsAvatar = settingsAvatarId === null ? undefined : getAvatarById(settingsAvatarId);
  const { diaryOpen, setDiaryOpen, tryGenerateDiary, onDiaryTriggerGenerate } = useDiary(messagesByAvatar);
  const [activeBg, setActiveBg] = useState<string | null>(null);
  // 桌宠浮窗背景源：主 App 当前实际显示的背景（activeBg 已含后端 journey 下发的 background_id）。
  // 用 ref 镜像，让上面定义的 togglePet/restartPetWithSettings 回调读到最新值而无需进 deps。
  const activeBgRef = useRef<string | null>(null);
  activeBgRef.current = activeBg;
  // 最近一次按角色初始化/切换背景的角色 id：人设刷新只换对象不换 id，靠它跳过背景重置，
  // 避免双击刷新人设把当前（可能服务端下发的）背景误重置成默认、再被 lifeSigns 轮询补回的闪烁。
  const bgInitializedAvatarIdRef = useRef<string | null>(null);
  // blob:/data: 是内存对象/内联数据，无法经 URL 参数跨到独立源的桌宠 WebView → 暂不下发
  // （P0 只需后端 http URL；App 内 AI 生成背景是 blob:，将来另走原生桥/自 fetch 机制）。
  const petBgUrl = (): string | undefined => {
    const bg = activeBgRef.current;
    if (!bg || bg.startsWith('blob:') || bg.startsWith('data:')) return undefined;
    return bg;
  };
  // 滑动切换角色的过渡：switching 期间盖一层遮罩（盖住冷加载空窗 + 背景切换），onReady 后淡出。
  const [switching, setSwitching] = useState(false);
  const [switchTargetName, setSwitchTargetName] = useState('');
  const switchingRef = useRef(false);
  const queuedSwitchRef = useRef<string | null>(null); // 连滑防抖：加载中记住最新目标，落定后再切
  const switchSafetyTimerRef = useRef<number | null>(null);
  const [motionName, setMotionName] = useState<string | undefined>(undefined);
  const lifeSigns = useLifeSigns();
  const [lifeSignsWardrobeItemId, setLifeSignsWardrobeItemId] = useState<string | undefined>(undefined);
  const [watermarkVisible, setWatermarkVisible] = useState(
    selectedAvatar.watermark?.enabledByDefault ?? false,
  );
  const [authUser, setAuthUser] = useState<UserInfo | null>(null);
  const authUserRef = useRef<UserInfo | null>(null);
  useEffect(() => { authUserRef.current = authUser; }, [authUser]);
  // 登录后自动轻量检查角色库更新（只比对 catalog 元数据，不下载 zip）；
  // 下载由用户点击加号页面总更新按钮触发，失败仅跳过、不阻塞首屏
  useRemoteAvatars({ enabled: !!authUser });
  const journeyStartedRef = useRef<Set<string>>(new Set());
  const [birthdayGateOpen, setBirthdayGateOpen] = useState(false);
  // 入口年龄门：真实用户登录后若未填生日，强制弹出且不可关闭，拦住 18 岁以下。
  const needsBirthday = !!authUser && !authUser.birth_date && !isLocalGuest();
  useEffect(() => {
    if (needsBirthday) setBirthdayGateOpen(true);
  }, [needsBirthday]);
  const tryStartJourney = useCallback((avatarId: string) => {
    void startJourney(avatarId)
      .then((r) => {
        if (r.ok || !r.blocked) return;
        // 缺生日 → 弹生日填写框；真·未满18 → 提示。
        if (r.code === 'birth_date_missing') setBirthdayGateOpen(true);
        else showToast('未满 18 周岁，暂未开放此功能', 'warning', 4000);
      })
      .catch((e) => console.error('[journey] start failed:', e));
  }, []);
  useEffect(() => {
    if (!authUser) return;
    if (journeyStartedRef.current.has(selectedAvatarId)) return;
    journeyStartedRef.current.add(selectedAvatarId);
    tryStartJourney(selectedAvatarId);
  }, [authUser, selectedAvatarId, tryStartJourney]);

  // 电影级事件演出：待播演出（换挡卡 → 全屏条漫）。
  const cutscene = useCutscene(authUser ? selectedAvatarId : undefined);
  // 旅程任务完成闭环（ALL-371）：拉取当前派发中的任务，用户提交反馈后推进剧情。
  const journeyTask = useJourneyTask(authUser ? selectedAvatarId : undefined);
  // 进角色时加载持久形象状态（换装/发型）→ 落到日常 Live2D。M1 桩目录为空，plumbing 就绪。
  useEffect(() => {
    if (!authUser || !selectedAvatarId) return;
    let alive = true;
    fetchAppearance(selectedAvatarId)
      .then((appearance) => {
        if (!alive) return;
        const apparel = resolveAppearanceApparel(appearance);
        if (apparel) presence.setApparel(apparel);
      })
      .catch(() => { /* 未登录/无实例：静默 */ });
    return () => { alive = false; };
  }, [authUser, selectedAvatarId, presence]);
  // 演出播完 → 服务端三层回写 + 形象立即应用到日常 Live2D。
  const handleCutsceneComplete = useCallback(async () => {
    const cur = cutscene.pending;
    cutscene.finish();
    if (!cur) return;
    const appearance = await completeCutscene(selectedAvatarId, cur.id).catch(() => null);
    const apparel = resolveAppearanceApparel(appearance || undefined);
    if (apparel) presence.setApparel(apparel);
  }, [cutscene, selectedAvatarId, presence]);

  // 双击拉取服务端人设：跟踪当前选中角色（避免 await 中切换错配）+ 在途/节流锁。
  const selectedAvatarIdRef = useRef(selectedAvatarId);
  // 前台活跃时长跟踪器：生命周期 effect 持有实例，切角色 effect 通过 ref 结算换挂。
  const usageTrackerRef = useRef<UsageTracker | null>(null);
  useEffect(() => {
    selectedAvatarIdRef.current = selectedAvatarId;
    // 切角色：抑制旧气泡露出并立即淡出，避免看到上一个/上一次的气泡。
    suppressRevealRef.current = true;
    setMessagesFaded(true);
  }, [selectedAvatarId]);
  // 记住上次角色：任何来源的角色切换（滑动/抽屉/剧情 lifeSigns 覆盖）都落一次本地，
  // 保证下次启动 defaultAvatarId 直接进入上次真实所见的角色。
  useEffect(() => { saveLastAvatarId(selectedAvatarId); }, [selectedAvatarId]);
  // ALL-440：并发闸门（每角色独立在途 + 每角色最多一次待补跑 force），取代旧的全局 inFlight——
  // 旧实现会在 silent 同步在途时把双击 force 请求静默吞掉。
  const configFetchGateRef = useRef(createConfigFetchGate({ cooldownMs: 10_000 }));
  const recentClearedSlotsRef = useRef<CostumeSlot[]>([]);
  const recentSetSlotsRef = useRef<CostumeSlot[]>([]);
  // costume 穿着记忆（avatarId → slot→file）：原生绑定随切角色销毁重建，凭它重放恢复穿着。
  const profileCostumeMemoryRef = useRef(new Map<string, Map<CostumeSlot, string>>());
  const [authChecking, setAuthChecking] = useState(true);
  const [profileOpen, setProfileOpen] = useState(false);
  const [syncTick, setSyncTick] = useState(0);
  const [live2dRuntimeNonce, setLive2dRuntimeNonce] = useState(0);
  // 原生渲染路径就绪信号：无 Pixi runtime，仅靠 Live2DStage 的 onNativeReady 翻 nonce。
  const [nativeStageNonce, setNativeStageNonce] = useState(0);
  const [previewImageUrl, setPreviewImageUrl] = useState<string | null>(null);
  const [playingVoiceId, setPlayingVoiceId] = useState<string | null>(null);
  const [endingDemoOpen, setEndingDemoOpen] = useState(false);
  const [composerPanelOpen, setComposerPanelOpen] = useState(false);
  const [stickerPanelOpen, setStickerPanelOpen] = useState(false);
  // 面板状态的 ref 镜像：键盘监听/offset effect 挂载一次、不随面板开关重注册，
  // 通过 ref 读最新状态（快速连打时 effect 重注册有间隙，会丢键盘事件卡死 kbAnimating）
  const composerPanelOpenRef = useRef(false);
  const stickerPanelOpenRef = useRef(false);
  composerPanelOpenRef.current = composerPanelOpen;
  stickerPanelOpenRef.current = stickerPanelOpen;
  // 微信式交叉过渡：面板→键盘时延迟卸载面板（见 closePanelAndFocusInput）
  const pendingPanelCloseRef = useRef(false);
  // 表情包面板同款交叉过渡（见 closeStickerAndFocusInput）
  const pendingStickerCloseRef = useRef(false);
  const stickerCloseTimerRef = useRef<number | null>(null);
  const panelCloseTimerRef = useRef<number | null>(null);
  // 输入栏定位（见下方 offset effect）：键盘遮挡稳定采样值 / 键盘动画期冻结标记 /
  // 键盘隐藏时的基准 innerHeight / 实测键盘高度
  const stableOverlapRef = useRef(0);
  const kbAnimatingRef = useRef(false);
  const baselineInnerHRef = useRef(0);
  const keyboardHeightRef = useRef(readStoredKeyboardHeight());
  // 原生 WindowInsets ime() 实测高度（CSS px，MainActivity 派发 aiboo:ime）：
  // visualViewport 在部分输入法（搜狗高键盘等）下低报遮挡，取 max(vv, ime) 兜底
  const nativeImeHeightRef = useRef(0);
  // blur 提前下滑（见 offset effect 内 hideGlideRef 赋值）；+ 键主动 blur 用
  // openingPanelRef 挡掉（与 openingStickerRef 同款模式）
  const hideGlideRef = useRef<(() => void) | null>(null);
  const openingPanelRef = useRef(false);
  // 面板开关时触发 offset 重算（键盘 offset effect 挂载一次不随面板状态重跑）
  const offsetUpdateRef = useRef<(() => void) | null>(null);
  // --composer-offset 的当前数值镜像 + 气泡区预留高度重算入口：
  // offset 变化（CSS 变量，不触发 ResizeObserver/resize）后必须同步重算 --composer-reserve，
  // 否则气泡区锚点停留在旧值——键盘升起时气泡被键盘盖住、键盘收起后气泡卡在半空
  const composerOffsetValueRef = useRef(0);
  const reserveUpdateRef = useRef<(() => void) | null>(null);
  const [pendingImage, setPendingImage] = useState<ScaledImage | null>(null);

  const { input, setInput, isSending, ttsState, cancelTts, handleSubmit, handleOpeningSequence, performProactive, performCallUtterance } = useChat({
    selectedAvatar,
    selectedAvatarId,
    ttsSettings,
    ttsEnabled,
    messages,
    setMessages,
    presence,
    setMotionName,
    setMouthOpen,
    openSettings: () => setSettingsOpen(true),
    // holo 面：让 LLM 判语音控制意图并吐 control 字段，命中就驱动 djView（控制先行，不等 TTS）。
    holoControl: isHoloSurface,
    onControl: (control) => {
      switch (control) {
        case 'next': djView.dj.controls.next(); break;
        case 'prev': djView.dj.controls.prev(); break;
        case 'playPause': djView.dj.controls.playPause(); break;
        case 'mode:focus': djView.setMode('focus'); break;
        case 'mode:commute': djView.setMode('commute'); break;
      }
    },
    onPreparedSpeech: (prepared) => {
      profileTrackerRef.current?.noteUpcomingSpeech(prepared.durationMs ?? 0);
    },
    // 进对话触发世界书对账（fire-and-forget，不阻塞消息发送）。
    onDialogueStart: () => triggerLorebookSync('dialogue'),
    bypassLegacyLive2dOutputs: isV2Profile,
    getActiveProfileCostumeSlots: () => {
      const binding = profileBindingRef.current;
      if (binding && 'getActiveCostumeSlots' in binding) return binding.getActiveCostumeSlots();
      return Array.from(live2dRuntimeRef.current?.profileCostumeSlots.keys() ?? []);
    },
    getRecentClearedProfileCostumeSlots: () => recentClearedSlotsRef.current,
    getRecentSetProfileCostumeSlots: () => recentSetSlotsRef.current,
    onProfileTrigger: ({ files, clearSlots }) => {
      console.info('[profile] onProfileTrigger', { isV2: isV2ProfileRef.current, files, clearSlots, bindingReady: !!profileBindingRef.current });
      if (!isV2ProfileRef.current || !profileBindingRef.current) return;
      let memory = profileCostumeMemoryRef.current.get(selectedAvatarId);
      if (!memory) {
        memory = new Map();
        profileCostumeMemoryRef.current.set(selectedAvatarId, memory);
      }
      if (clearSlots && 'clearSlot' in profileBindingRef.current) {
        for (const slot of clearSlots) {
          const cleared = profileBindingRef.current.clearSlot(slot);
          console.info('[profile] clearSlot result', { slot, cleared });
          if (cleared && cleared.length > 0) {
            if (cleared.some((a) => a.type === 'clear_costume')) memory.delete(slot);
            recentClearedSlotsRef.current = [
              slot,
              ...recentClearedSlotsRef.current.filter((s) => s !== slot),
            ].slice(0, 3);
            // 某个 slot 被清除后，它不应再占据最近设置列表的顶部。
            recentSetSlotsRef.current = recentSetSlotsRef.current.filter((s) => s !== slot);
          }
        }
      }
      for (const file of files) {
        console.info('[profile] trigger file', { file });
        const actions = profileBindingRef.current.trigger(file);
        console.info('[profile] trigger actions', { file, actions });
        for (const action of actions) {
          if (action.type === 'set_costume') {
            memory.set(action.slot, action.file);
            recentSetSlotsRef.current = [
              action.slot,
              ...recentSetSlotsRef.current.filter((s) => s !== action.slot),
            ].slice(0, 3);
          } else if (action.type === 'clear_costume') {
            memory.delete(action.slot);
          }
        }
      }
    },
  });
  const handleOpeningSequenceRef = useRef(handleOpeningSequence);
  useEffect(() => { handleOpeningSequenceRef.current = handleOpeningSequence; }, [handleOpeningSequence]);
  const openingAttemptedRef = useRef<Set<string>>(new Set());
  // 取消尚未推送的后续开场条（用户中途插话/切角色时止推）。
  const openingCancelRef = useRef<null | (() => void)>(null);

  // 主画面气泡自动淡出：新消息到达或正在回复时露出并重置计时；静默 ~5s 后淡出让角色露出。
  const lastMessageId = messages[messages.length - 1]?.id;
  useEffect(() => {
    // 加载历史/切角色引起的变化：保持淡出，不露出旧气泡（消费一次抑制标记）。
    if (suppressRevealRef.current) {
      suppressRevealRef.current = false;
      setMessagesFaded(true);
      return;
    }
    setMessagesFaded(false);
    if (messages.length === 0 || isSending) return; // 回复中保持常亮
    if (!autoHideChat) return; // 用户关了自动隐藏 → 对话常显
    const timer = window.setTimeout(() => setMessagesFaded(true), 5000);
    return () => window.clearTimeout(timer);
  }, [lastMessageId, messages.length, isSending, revealNonce, autoHideChat]);

  // ── 主页沉浸模式：30s 无触屏隐藏聊天 UI（角色留下当"活屏保"），触屏唤回 ──
  // 豁免（暂停计时并强制显示）：打字/草稿未发、AI 回复中/播语音中、录音中、各弹窗抽屉开着；
  // 通话/DJ 有自己的界面，未登录走 pre-auth，都不参与。
  const idleUiSuspended =
    composerExpanded || input.trim().length > 0 || isSending || ttsState !== 'idle' ||
    playingVoiceId !== null || recActive || recTranscribing ||
    callMenuOpen || composerPanelOpen || stickerPanelOpen || settingsOpen || controlDrawerOpen || bgPanelOpen ||
    profileOpen || chatHistoryOpen || diaryOpen || previewImageUrl !== null ||
    birthdayGateOpen || settingsAvatarId !== null || endingDemoOpen || switching;
  const { hidden: uiIdleHidden, wake: wakeIdleUi } = useIdleUiHide(
    isMobile && !!authUser && !djModeOpen && !callOpen && !idleUiSuspended,
  );
  // 新消息到达（含主动演出）自动唤回 UI——她开口说话不能没人看见。
  useEffect(() => {
    if (lastMessageId) wakeIdleUi();
  }, [lastMessageId, wakeIdleUi]);

  // 自适应：输入框(定位在底部、脱离文档流)占用的底部高度写入 --composer-reserve，
  // 供 .chat-panel 底部预留，避免变高/展开后的输入框挡住聊天气泡。
  // 解析式计算（布局高 + 当前 offset）：不能用 getBoundingClientRect——它含 transform，
  // 且 offset 变化（CSS 变量）不触发 RO/resize，测量时机落在过渡前就会卡死旧值。
  useEffect(() => {
    const update = () => {
      const el = composerRef.current;
      if (!el) return;
      const reserve = Math.max(0, el.offsetHeight + composerOffsetValueRef.current);
      document.documentElement.style.setProperty('--composer-reserve', `${Math.round(reserve)}px`);
    };
    reserveUpdateRef.current = update;
    // authChecking 早期 return 期间 composer 未挂载：rAF 轮询等它出现（限 3s，
    // 超时靠依赖变化重跑本 effect 再试），挂载后 ResizeObserver 跟踪高度变化
    let ro: ResizeObserver | null = null;
    let raf = 0;
    const t0 = performance.now();
    const attach = () => {
      const el = composerRef.current;
      if (!el) {
        if (performance.now() - t0 < 3000) raf = requestAnimationFrame(attach);
        return;
      }
      update();
      ro = new ResizeObserver(update);
      ro.observe(el);
    };
    attach();
    return () => {
      reserveUpdateRef.current = null;
      cancelAnimationFrame(raf);
      ro?.disconnect();
    };
  }, [composerExpanded, input, isMobile, authUser]);

  // 主动消息（旅程 beat / 强制触发）的演出由 useChat.performProactive 提供：
  // 与普通回复同一条渲染管线（分段对白+（动作）灰气泡+带 avatarId 的 TTS）。
  const performProactive2 = useCallback(
    (content: string, emotion: string | undefined, intensity: number | undefined, messageId: string) => {
      void performProactive(content, emotion, intensity, messageId);
    },
    [performProactive],
  );
  const { bannerEvent, clearBanner, callEvent, clearCall, callResolved } = useProactivePerformance({
    authUser,
    selectedAvatarId,
    callOpen,
    callEnabled: callSettings.enabled,
    refreshMessages,
    performProactive: performProactive2,
    // ALL-434：主动补演「演出就绪」门——App 冷启动/启动页/鉴权加载/切角色过渡期间角色不得
    // 提前开口，必须等当前角色聊天主界面真正可见且演出路径就绪后再补演未 seen beat。组合
    // 现有就绪信号：已登录（非 pre-auth/login 浮层）、authChecking 已完成（聊天 UI 已挂载）、
    // 非切角色遮罩过渡、selectedAvatar 已与 selectedAvatarId 对齐（异步解析未落定时仍挂旧角色）、
    // Live2D/native 舞台已对当前角色就绪（Pixi runtime 归属当前角色 或 原生舞台就绪过）。
    performanceReady:
      !!authUser &&
      !authChecking &&
      !switching &&
      selectedAvatar?.id === selectedAvatarId &&
      (nativeStageNonce > 0 || live2dRuntimeRef.current?.avatar?.id === selectedAvatarId),
  });

  // 全屏来电接听：切到该角色 → 等切换过渡结束 → startCall。用 ref 桥接，effect 只依赖 switching。
  const pendingCallAfterSwitchRef = useRef(false);
  const startCallRef = useRef(startCall);
  startCallRef.current = startCall;
  useEffect(() => {
    if (!switching && pendingCallAfterSwitchRef.current) {
      pendingCallAfterSwitchRef.current = false;
      startCallRef.current();
    }
  }, [switching]);

  // 发起通话前清场：收键盘 + 关加号/表情面板（它们 portal 到 body，.in-call 的 CSS 藏不到），
  // 否则通话浮层下面还叠着面板，出现 图2 那种半截布局。
  const handleStartVoiceCall = useCallback(() => {
    setCallMenuOpen(false);
    setComposerPanelOpen(false);
    setStickerPanelOpen(false);
    inputRef.current?.blur();
    startCall();
  }, [startCall]);
  const handleStartVideoCall = useCallback(() => {
    setCallMenuOpen(false);
    setComposerPanelOpen(false);
    setStickerPanelOpen(false);
    inputRef.current?.blur();
    startVideoCall();
  }, [startVideoCall]);

  // 触达 UI 回调：TouchBanner 的 onTap/onDismiss 需稳定引用（其 6s 计时 effect 依赖 onDismiss）。
  // handleAvatarChange 只读 ref/稳定 setter，闭包捕早期实例也安全，故 deps 留空。
  const handleBannerTap = useCallback((avatarId: string) => {    handleAvatarChange(avatarId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const handleFullscreenAccept = useCallback((e: IncomingCallScreenEvent) => {
    void postCallResult(e.avatarId, e.id, 'accepted');
    // 时序决策抽成纯函数 acceptFullscreenCall（可单测）：目标恰为当前角色时直接
    // startCall——handleAvatarChange 对同角色会早退，switching 周期不启动，若仍
    // arm pending 会永久悬挂（本次来电被丢 + 下次无关切角色幻影 startCall）。
    // 画外角色才走「arm pending → 切角色 → 等 switching 结束的 effect 拉起」。
    acceptFullscreenCall(e.avatarId, selectedAvatarIdRef.current, {
      startCall: () => startCallRef.current(),
      armPendingCall: () => { pendingCallAfterSwitchRef.current = true; },
      switchAvatar: handleAvatarChange,
    });
    callResolved();
    clearCall();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callResolved, clearCall]);
  const handleInplaceAccept = useCallback((e: InlineCallPromptEvent) => {
    void postCallResult(e.avatarId, e.id, 'accepted');
    // 与全屏路径同构：响铃 25s 内用户可能滑到别的角色，直接 startCall 会接到当前（错的）
    // 角色。走 acceptFullscreenCall 做时序决策——同角色直拉通话（行为不变），滑走则 arm
    // pending + 切回目标角色后再拉起。
    acceptFullscreenCall(e.avatarId, selectedAvatarIdRef.current, {
      startCall: () => startCallRef.current(),
      armPendingCall: () => { pendingCallAfterSwitchRef.current = true; },
      switchAvatar: handleAvatarChange,
    });
    callResolved();
    clearCall();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callResolved, clearCall]);
  const handleCallDecline = useCallback((e: { id: string; avatarId: string }) => {
    void postCallResult(e.avatarId, e.id, 'declined');
    refreshMessages(e.avatarId);
    callResolved();
    clearCall();
  }, [refreshMessages, callResolved, clearCall]);
  const handleCallTimeout = useCallback((e: { id: string; avatarId: string }) => {
    void postCallResult(e.avatarId, e.id, 'timeout');
    refreshMessages(e.avatarId);
    callResolved();
    clearCall();
  }, [refreshMessages, callResolved, clearCall]);

  const activeExpressionKeys = useMemo(
    () => new Set(activeExpressionMix.map((layer) => layer.key)),
    [activeExpressionMix],
  );
  const mobileDefaults: StageTransform = isMobile
    ? homeFramingFor(selectedAvatar)
    : selectedAvatar.transformDefaults;
  const [stageTransform, setStageTransform] = useState<StageTransform>(mobileDefaults);
  // 登录→主页角色构图过渡（仅移动端）
  const [morphActive, setMorphActive] = useState(false);
  const [morphTransform, setMorphTransform] = useState<StageTransform>(LOGIN_FRAMING);
  const morphRafRef = useRef<number | null>(null);
  const morphActiveRef = useRef(false);
  const visibleExpressions = selectedAvatar.expressions;
  const diaryCount = useMemo(() => getDiaryEntryCount(selectedAvatarId), [selectedAvatarId, diaryOpen, syncTick]);
  const favTotal = useMemo(() => getTotalFavorability(), [selectedAvatarId, syncTick]);
  const activeParameterMap = useMemo(
    () => new Map(activeParameterOverrides.map((parameterOverride) => [parameterOverride.id, parameterOverride.value])),
    [activeParameterOverrides],
  );

  const mouthSyncTarget = useMemo(() => {
    // 优先级 1：model3.json Groups[LipSync].Ids[0]（加载即有，最优先）。
    // 空数组（如 Estella 声明了 LipSync 组但 Ids 为空）已在 readLipSyncParamIds 过滤掉，
    // 这里 length>0 才命中，否则正确跌落到优先级 2/3。
    if (lipSyncParamIds.length > 0) {
      return {
        avatarId: selectedAvatarId,
        parameterId: lipSyncParamIds[0],
        min: 0,
        max: 1,
        neutral: 0,
      };
    }

    // 优先级 2：运行时发现的参数表（需手动触发「抓取参数」后才有）。
    const result = parameterDiscoveryResults.find((r) => r.avatarId === selectedAvatarId);
    const selected = selectMouthParameter(result?.parameters ?? []);
    if (selected) {
      return {
        avatarId: selectedAvatarId,
        parameterId: selected.id,
        min: selected.min ?? 0,
        max: selected.max ?? 1,
        neutral: selected.defaultValue ?? selected.min ?? 0,
      };
    }

    // 优先级 3：硬编码兜底。
    return {
      avatarId: selectedAvatarId,
      parameterId: 'ParamMouthOpenY',
      min: 0,
      max: 1,
      neutral: 0,
    };
  }, [lipSyncParamIds, parameterDiscoveryResults, selectedAvatarId]);

  const mouthSyncOverrides = useMemo(() => {
    const mouthParamId = mouthSyncTarget.parameterId;
    const isManualOverride = activeParameterOverrides.some((po) => po.id === mouthParamId);
    const isAudioActive = mouthOpen > 0.001;

    if (isAudioActive) {
      const value = computeMouthValue(mouthOpen, mouthSyncTarget);
      return [{ id: mouthParamId, value }];
    }

    if (isManualOverride) {
      // 无音频时允许手动调用覆盖嘴部参数
      return [];
    }

    // 无音频且未手动覆盖：保持嘴部闭合
    return [{ id: mouthParamId, value: mouthSyncTarget.neutral }];
  }, [mouthOpen, mouthSyncTarget, activeParameterOverrides]);

  // 待机自发哼唱：DJ 模式/来电响铃中/通话中都不哼——DJ 那边是电台场景另有音频在播；
  // 通话中 voiceChannel 目前没有 rtc 占用方（CallOverlay/useCall 从不 acquireVoice('rtc', ...)），
  // 且贴耳讲电话不产生 pointerdown/keydown，idle 计时会一直往前走——不额外挡住 callOpen 的话，
  // 通话满 3 分钟 shouldHum 会全部放行，哼声与通话语音同时出扬声器。
  // callEvent 是「响铃中」（非空即有一通来电挂在 InlineCallPrompt/IncomingCallScreen 上）：
  // callOpen 要等用户**接听**之后才为真，而响铃那 25 秒里 createRingtone 循环放铃声却从不
  // 碰 voiceChannel——voiceChannelBusy 也是 false。来电本就在用户闲置时才来，正好撞上
  // 门槛全开的时刻，15s 的门检查落在响铃中就会让哼声压着铃声一起响。接/挂/超时三条路径
  // 都会 clearCall()，所以这道门不会卡死。
  const singing = useSinging({
    // ★临时关闭待机哼唱（「不倒翁」摇摆即哼唱摇摆演出）：enabled=false 让门检查不再起哼，
    // 并停掉进行中的哼唱。代码全保留，恢复时改回下面的表达式即可。
    // enabled: !djModeOpen && !callOpen && !callEvent,
    enabled: false,
    avatarId: selectedAvatarId,
  });

  // 合并逻辑（含 T4B 嘴部裁剪、同名去重、快路引用保持）提到 humSway.mergeStageOverrides，
  // 由 humSway.test.ts 逐条钉死——这里只负责把三个输入喂进去。
  const stageParameterOverrides = useMemo(
    () => mergeStageOverrides(activeParameterOverrides, singing.swayOverrides, mouthOpen > 0.001),
    [activeParameterOverrides, mouthOpen, singing.swayOverrides],
  );

  const mouthSyncState: MouthSyncState = useMemo(() => {
    const active = mouthOpen > 0.001;
    return {
      active,
      source: active ? 'tts' : 'unknown',
      level: mouthOpen,
      appliedValue: active ? computeMouthValue(mouthOpen, mouthSyncTarget) : mouthSyncTarget.neutral,
      target: mouthSyncTarget,
    };
  }, [mouthOpen, mouthSyncTarget]);

  // 参数发现扫描逻辑见 features/live2d/useParameterDebug.ts

  function handleParameterCall(call: ParameterCall, parameter: DiscoveredLive2DParameter) {
    if (call.avatarId !== selectedAvatarId) {
      return {
        ok: false,
        message: `${parameter.id} 调用失败：请先切换到 ${parameter.avatarName}`,
      };
    }

    if (!parameter.callable) {
      return {
        ok: false,
        message: `${parameter.id} 调用失败：该参数未在 runtime 参数表中确认`,
      };
    }

    const isMouth = isMouthParam(call.id);
    const isMouthSyncActive = mouthOpen > 0.001;

    if (call.id === 'ParamMouthOpenY') {
      setMouthOpen(call.value);
    }

    if (!isMouth) {
      // 调试面板手动参数：作为持久 ② 服饰项（按参数 id 唯一），不被情绪淡回冲掉。
      presence.setApparel({ id: `manual-param:${call.id}`, parameterOverrides: [{ id: call.id, value: call.value }] });
    }
    console.info('[Live2D Parameter Debug] applied', call);
    return {
      ok: true,
      message:
        isMouth && isMouthSyncActive
          ? `${parameter.id} 调用成功：${call.value}（当前有音频播放，口型同步会覆盖该值）`
          : `${parameter.id} 调用成功：${call.value}`,
    };
  }

  useEffect(() => {
    setAuthErrorHandler(() => {
      setAuthUser(null);
      setProfileOpen(false);
    });
    return () => setAuthErrorHandler(null);
  }, []);

  useEffect(() => {
    autoLogin()
      .then(async (user) => {
        if (user) {
          setAuthUser(user);
          if (!isLocalGuest()) {
            await executePull();
            void syncAvatarConfig(selectedAvatarIdRef.current, {
              silent: true,
              force: true,
              updateTransform: true,
            });
          }
        }
      })
      .catch((e) => {
        console.error('[app] autoLogin failed', e);
        showToast('自动登录失败，请重新登录', 'error', 4000);
      })
      .finally(() => {
        setAuthChecking(false);
      });
  }, []);

  useEffect(() => {
    const removeNetworkListeners = setupNetworkListeners();
    const removeSyncListener = onSyncChange(() => {
      setSyncTick((n) => n + 1);
      setBubbleStyle(loadBubbleStyle);
    });
    return () => {
      removeNetworkListeners();
      removeSyncListener();
    };
  }, []);

  // 设置读取/持久化、浏览器语音列表同步：见 features/settings/useSettings.ts

  useEffect(() => () => {
    stopSpeaking();
    profileBindingRef.current?.dispose();
    profileBindingRef.current = null;
    profileTrackerRef.current?.dispose();
    profileTrackerRef.current = null;
    profileRef.current = null;
    isV2ProfileRef.current = false;
  }, []);

  useEffect(() => {
    setWatermarkVisible(selectedAvatar.watermark?.enabledByDefault ?? false);
    // 背景回退：用户本地生成/上传 → 角色默认背景（后台配置）→ 无。
    // 仅在角色 id 变化（含首屏）时重置背景；人设刷新只换对象不换 id，跳过——
    // 否则会把当前（可能服务端下发的）背景误重置成默认，再被 lifeSigns 轮询补回造成闪烁。
    if (bgInitializedAvatarIdRef.current !== selectedAvatar.id) {
      bgInitializedAvatarIdRef.current = selectedAvatar.id;
      const saved = loadBackgrounds()[selectedAvatarId];
      setActiveBg(saved?.url ?? selectedAvatar.defaultBackground ?? null);
    }
  }, [selectedAvatar]);

  // 生命迹象（lifeSigns）驱动背景、角色与换装。优先级：外部 journey runtime > 用户本地设置。
  // 对话回合进行中（isSending）收到「场景切换」背景下发时先暂存：回复气泡要等 TTS/动作
  // 同步就绪才渲染（responseSyncController），立即切背景会变成「背景先换了角色才说话」。
  // 暂存的背景在回合结束（isSending 回落）后由下方 flush effect 应用。
  const isSendingRef = useRef(isSending);
  isSendingRef.current = isSending;
  const pendingLifeSignsBgRef = useRef<{
    avatarId: string;
    backgroundId: string;
    sceneKey?: string;
  } | null>(null);
  useEffect(() => {
    // 背景（ALL-414）：预加载成功才切换 activeBg 并回传 ack；失败保留旧背景并回传失败。
    // 与当前背景相同则跳过（同时充当 commit 推送 → ack 的循环断路器）。
    // SSE 推送携带 avatarId 时只应用当前角色的背景下发（快照路径无此字段，不过滤）。
    if (lifeSigns.background_id && (!lifeSigns.avatarId || lifeSigns.avatarId === selectedAvatarIdRef.current)) {
      const payload = {
        avatarId: selectedAvatarIdRef.current,
        backgroundId: lifeSigns.background_id,
        sceneKey: lifeSigns.scene_key,
      };
      const isSceneSwitch =
        resolveLifeSignsBackgroundUrl(lifeSigns.background_id) !== activeBgRef.current;
      if (isSceneSwitch && isSendingRef.current) {
        pendingLifeSignsBgRef.current = payload; // 最新一次下发覆盖旧的
      } else {
        void applyLifeSignsBackground({
          ...payload,
          currentBg: activeBgRef.current,
          setBackground: setActiveBg,
        });
      }
    }

    // 角色：仅在当前可用角色中存在对应 model_id 时才切换，避免指向未下载/未知模型导致舞台空白。
    if (lifeSigns.model_id && getAvatarById(lifeSigns.model_id)) {
      setSelectedAvatarId(lifeSigns.model_id);
    }

    // 换装：把 wardrobe_item_id 透传给 Live2DStage 的 motionName。
    // 当前 avatar 的动作系统没有独立的「服装」概念，因此按同名 motion 触发；
    // 若角色无对应 motion，Live2DStage 内部会捕获异常并静默忽略。
    setLifeSignsWardrobeItemId(lifeSigns.wardrobe_item_id);
  }, [lifeSigns]);

  // 回合结束且回复气泡已落屏后，应用暂存的场景背景下发（台词先出、背景后切）。
  useEffect(() => {
    if (isSending) return;
    const pending = pendingLifeSignsBgRef.current;
    if (!pending) return;
    pendingLifeSignsBgRef.current = null;
    if (pending.avatarId !== selectedAvatarIdRef.current) return; // 期间切了角色，丢弃
    void applyLifeSignsBackground({
      ...pending,
      currentBg: activeBgRef.current,
      setBackground: setActiveBg,
    });
  }, [isSending, messages]);

  // 读取当前角色 model3.json 的 LipSync 参数 id（口型参数最优先来源）。
  // 切换角色先清空，避免上一个角色的 id 短暂作用到新模型；读到空则 mouthSyncTarget 自动跌落。
  useEffect(() => {
    let cancelled = false;
    setLipSyncParamIds([]);
    void readLipSyncParamIds(selectedAvatar.modelJson).then((ids) => {
      if (!cancelled) setLipSyncParamIds(ids);
    });
    return () => { cancelled = true; };
  }, [selectedAvatar.modelJson]);

  useEffect(() => {
    let cancelled = false;

    void resolveAvatarManifestById(selectedAvatarId).then((resolvedAvatar) => {
      if (cancelled) {
        return;
      }

      setSelectedAvatar(resolvedAvatar);
      setStageTransform(
        isMobile
          ? homeFramingFor(resolvedAvatar)
          : resolvedAvatar.transformDefaults,
      );
      setWatermarkVisible(resolvedAvatar.watermark?.enabledByDefault ?? false);
      // 切角色：①情绪重置 + 清掉旧角色 ②③（不同角色形象不互通），随后由下方「形象恢复」
      // effect 按该角色最新消息的形象身份恢复 ②③。新角色 neutral 兜底也一并更新。
      presence.setNeutralExpressionId(getAvatarNeutralExpressionId(resolvedAvatar));
      presence.resetAll();
      setMouthOpen(0);
      stopSpeaking();
      setControlDrawerOpen(false);

      if (authUserRef.current && !isLocalGuest()) {
        void syncAvatarConfig(selectedAvatarId, {
          silent: true,
          force: true,
          baseAvatar: resolvedAvatar,
          updateTransform: true,
        });
      }

      if (!hasResolvedInitialAvatar.current) {
        hasResolvedInitialAvatar.current = true;
        return;
      }
    });

    return () => {
      cancelled = true;
    };
  }, [selectedAvatarId]);

  // v2 profile：runtime 与角色同时就绪后建立绑定；切角色时由 cleanup 先释放旧绑定。
  useEffect(() => {
    const runtime = live2dRuntimeRef.current;
    // runtime 必须是当前角色的：ref 在旧 runtime 销毁后不清空，切角色的间隙里它是尸体。
    if (!runtime || runtime.avatar?.id !== selectedAvatarId) return;
    if (selectedAvatar.id !== selectedAvatarId) return;
    attachProfileBindingFor(runtime, selectedAvatarId, selectedAvatar);
    return () => {
      profileBindingRef.current?.dispose();
      profileBindingRef.current = null;
      profileRef.current = null;
      isV2ProfileRef.current = false;
    };
  }, [selectedAvatar, selectedAvatarId, live2dRuntimeNonce]);

  // v2 profile（原生渲染路径）：原生舞台就绪后挂镜像绑定；与上面 Pixi effect 互斥。
  useEffect(() => {
    if (nativeStageNonce === 0) return;
    // 只有「当前角色的」Pixi runtime 存在时才让位——ref 里的陈旧 runtime（上一个
    // 角色销毁后不清空）不能阻止原生绑定，否则原生路径永远挂不上（estella 事故）。
    const runtime = live2dRuntimeRef.current;
    if (runtime && runtime.avatar?.id === selectedAvatarId) return;
    if (selectedAvatar.id !== selectedAvatarId) return;
    attachNativeProfileBindingFor(selectedAvatarId, selectedAvatar);
    return () => {
      profileBindingRef.current?.dispose();
      profileBindingRef.current = null;
      v2ProfileRef.current = null;
      isV2ProfileRef.current = false;
    };
  }, [selectedAvatar, selectedAvatarId, nativeStageNonce, live2dRuntimeNonce]);

  // Load chat history from server when avatar changes
  useEffect(() => {
    if (!authUser || isLocalGuest()) return;
    loadChatMessages(selectedAvatarId)
      .then((serverMessages) => {
        // 历史异步到达时同样抑制露出：这些是旧消息，不该浮成气泡。
        suppressRevealRef.current = true;
        setMessagesFaded(true);
        // 合并而非整体覆盖（与 refreshMessages 一致）：保留本地独有的新消息——
        // 用户在角色正在输出时滑走，回复继续渲染进本地列表；滑回来时这次重载不能把
        // 那段「服务端还没有」的回复盖掉（否则表现为「滑走一趟回复就消失」）。
        setMessagesByAvatar((prev) => {
          const local = prev[selectedAvatarId] || [];
          const serverIds = new Set(serverMessages.map((m) => m.id));
          const localOnlyTail = local.filter((m) => !serverIds.has(m.id));
          return { ...prev, [selectedAvatarId]: [...serverMessages, ...localOnlyTail] };
        });
      })
      .catch((error) => {
        console.error('[chat] load messages failed:', error);
      });
  }, [selectedAvatarId, authUser]);


  useEffect(() => {
    if (!controlDrawerOpen) {
      setControlDrawerScrollToDebug(false);
    }
  }, [controlDrawerOpen]);

  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollTop = messagesEndRef.current.scrollHeight;
    }
  }, [messages]);

  // Auto-trigger opening message when entering a new conversation
  useEffect(() => {
    if (!authUser || messages.length > 0) return;
    if (openingAttemptedRef.current.has(selectedAvatarId)) return;
    openingAttemptedRef.current.add(selectedAvatarId);

    let cancelled = false;
    void triggerOpening(selectedAvatarId).then((result) => {
      if (cancelled) return;
      // 优先 messages 多条；老服务端/legacy 单条时归一化会 wrap 成 [message]。
      const openingMessages = normalizeOpeningMessages(result);
      if (!openingMessages.length) return;
      // 按 1000ms 间隔逐条推气泡（单条走旧 handleOpening，行为不变）；返回 cancel 供止推。
      openingCancelRef.current?.();
      openingCancelRef.current = handleOpeningSequenceRef.current(openingMessages);
    }).catch((err) => {
      console.error('[opening] trigger failed:', err);
    });

    return () => { cancelled = true; };
  }, [authUser, selectedAvatarId, messages.length]);

  // 切换角色时取消上一个角色尚未推完的开场条（仅 selectedAvatarId 变化触发，不受自推 append 影响）。
  useEffect(() => {
    return () => {
      openingCancelRef.current?.();
      openingCancelRef.current = null;
    };
  }, [selectedAvatarId]);

  // 用户一旦开始输入/发消息，取消后续未推的开场条（别在用户已经聊起来时还硬插开场）。
  useEffect(() => {
    if (input.trim().length > 0) {
      openingCancelRef.current?.();
      openingCancelRef.current = null;
    }
  }, [input]);

  // Auto-trigger diary generation after assistant response
  useEffect(() => {
    const lastMsg = messages[messages.length - 1];
    if (!lastMsg || lastMsg.role !== 'assistant') return;
    tryGenerateDiary(selectedAvatarId);
  }, [messages]);

  // 切换/加载会话时,把最新一条 assistant 消息存的 expressionMix/parameterOverrides 应用到模型
  // (替代一律回 neutral),让重开会话保持上次情绪/状态。
  // 仅在「切换角色」时应用——实时回复由回复路径自己驱动(它会按"有 action 则忽略 expressionMix"
  // 的规则正确处理),这里再插一脚会把 action(如变小)对应的换装层冲掉。
  const lastEmotionAvatarRef = useRef<string | null>(null);
  useEffect(() => {
    if (isSending || djModeOpen) return;
    if (lastEmotionAvatarRef.current === selectedAvatarId) return; // 同角色实时回复:不重复插手
    if (messages.length === 0) return; // 等该角色消息加载完
    lastEmotionAvatarRef.current = selectedAvatarId;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role !== 'assistant') continue;
      // 重开会话恢复「上次形象」：作为常驻情绪写入（不带淡回 holdMs），让脸/参数停在最后一条消息的状态。
      // 注：历史消息未持久化 action/分层身份，故此处无法精确还原 ②③（如「变小」），是 P1 已知局限。
      if (m.expressionMix?.length || m.parameterOverrides?.length) {
        presence.applyEmotion({
          expressionMix: m.expressionMix?.length ? m.expressionMix : undefined,
          parameterOverrides: m.parameterOverrides ?? undefined,
        });
      }
      break; // 只看最新一条 assistant
    }
  }, [messages, isSending, djModeOpen, selectedAvatarId, presence]);

  // SoulLink 情绪层(主页): 仅 shuangsheng + 非DJ + 开关开。进入建 bridge + 每帧 tick→情绪域参数;
  // 退出/换角色/关开关清空。角色回复文本经 engine 本地分类器→连续VAD,绕开离散命名表情的跳变。
  useEffect(() => {
    const runtime = live2dRuntimeRef.current;
    const enabled =
      !djModeOpen && selectedAvatarId === 'shuangsheng' && isSoullinkEmotionEnabled() && !!runtime;
    if (!enabled || !runtime) {
      if (runtime) setSoullinkEmotionParams(runtime, new Map());
      soullinkBridgeRef.current = null;
      if (soullinkRafRef.current != null) {
        cancelAnimationFrame(soullinkRafRef.current);
        soullinkRafRef.current = null;
      }
      return;
    }
    const bridge = createSoullinkBridge({
      profile: shuangshengProfile as unknown as ModelProfile,
      reserved: { costumeIds: runtime.costumeParamOverrides.keys(), mouthIds: ['ParamMouthOpenY'] },
    });
    soullinkBridgeRef.current = bridge;
    const start = performance.now() / 1000;
    let prev = start;
    const step = () => {
      const now = performance.now() / 1000;
      const dt = Math.min(0.1, now - prev);
      prev = now;
      try {
        setSoullinkEmotionParams(runtime, bridge.tick(now - start, dt));
      } catch {
        // tick 抛错(情绪域冲突,理论不达):自愈——清空+停循环,不惊动全局 onerror。
        setSoullinkEmotionParams(runtime, new Map());
        soullinkRafRef.current = null;
        return;
      }
      soullinkRafRef.current = requestAnimationFrame(step);
    };
    soullinkRafRef.current = requestAnimationFrame(step);
    return () => {
      if (soullinkRafRef.current != null) {
        cancelAnimationFrame(soullinkRafRef.current);
        soullinkRafRef.current = null;
      }
      soullinkBridgeRef.current = null;
      setSoullinkEmotionParams(runtime, new Map());
    };
  }, [djModeOpen, selectedAvatarId, live2dRuntimeNonce]);

  // 新回复到达 → 把最新一条 assistant 文本喂给情绪桥(本地分类器判 VAD)。
  useEffect(() => {
    const bridge = soullinkBridgeRef.current;
    if (!bridge) return;
    const last = messages[messages.length - 1];
    if (last?.role === 'assistant' && last.content?.trim()) {
      bridge.feedText(last.content, performance.now() / 1000);
    }
  }, [lastMessageId]);

  // Stop voice playback when switching avatars
  useEffect(() => {
    stopSpeaking();
    setPlayingVoiceId(null);
  }, [selectedAvatarId]);

  // 上下滑动切换角色（取代已下线的角色抽屉）：Live2DStage 触摸竖滑 → 在有序角色表里循环取上/下一个。
  const drawerAvatars = useAvatarList();

  // 远端角色记忆恢复：冷启动因 remoteOverrides 未恢复被兜底成 FALLBACK 后，
  // 等远端注册表就绪（drawerAvatars 变化）自动切回上次角色；用户在就绪前已手动
  // 切走（selectedAvatarId 离开启动值）则放弃恢复。
  const pendingRemoteAvatarRef = useRef(pendingRemoteAvatarId);
  useEffect(() => {
    const pending = pendingRemoteAvatarRef.current;
    if (!pending) return;
    if (selectedAvatarId !== defaultAvatarId) {
      pendingRemoteAvatarRef.current = null;
      return;
    }
    if (!getAvatarById(pending)) return;
    pendingRemoteAvatarRef.current = null;
    setSelectedAvatarId(pending);
  }, [drawerAvatars, selectedAvatarId]);
  function switchAvatarBySwipe(dir: 'next' | 'prev') {
    if (drawerAvatars.length < 2) return;
    const idx = drawerAvatars.findIndex((a) => a.id === selectedAvatarId);
    if (idx < 0) return;
    const len = drawerAvatars.length;
    const nextIdx = dir === 'next' ? (idx + 1) % len : (idx - 1 + len) % len;
    handleAvatarChange(drawerAvatars[nextIdx].id);
  }

  // 全息屏(holo)入口：holo/main.tsx 会在 <html data-holo="1">。以下 holo 专用行为全部以此为守卫，
  // 移动端主客户端(无此属性)一律早退/走原逻辑，行为字节级不变。
  // holo 大屏/投屏常无触摸，拖拽切角色不便：加键盘 ↑↓(←→) 切角色，复用滑动同一逻辑。
  useEffect(() => {
    if (!isHoloSurface) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') switchAvatarBySwipe('next');
      else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') switchAvatarBySwipe('prev');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isHoloSurface, selectedAvatarId, drawerAvatars]);

  // 全息屏语音控制：登录后开麦持续听(VAD 分段→ASR→喂进聊天管线)。
  // 我们自己 TTS 说话/回合进行中时 muted，避免自问自答与回合重叠。
  useHoloVoice({
    enabled: isHoloSurface && !!authUser,
    muted: isSending || ttsState !== 'idle',
    onUtterance: (text) => { void handleSubmit(text); },
    onError: (err) => console.warn('[holo-voice]', err),
  });

  // 全息屏：登录后自动进 DJ 引擎（复用换装 Param67 + DJ 模型 + 音乐引擎），
  // 但下方 DjMode 全屏层在 holo 被抑制，改由 HoloDashboard 呈现播放器。
  useEffect(() => {
    if (isHoloSurface && authUser) setDjModeOpen(true);
  }, [isHoloSurface, authUser]);

  // Auto-focus input on mobile mount
  useEffect(() => {
    if (isMobile && inputRef.current) {
      setTimeout(() => {
        inputRef.current?.focus();
      }, 500);
    }
  }, []);

  // 输入栏定位：
  // - 原生缩放模式（iOS）：键盘弹出时窗口自身收缩，fixed bottom:0 天然贴合键盘顶，
  //   键盘偏移恒为 0。apply() 用 innerHeight<基准 实时判定，绝不靠 vv。
  // - 非缩放模式（安卓 adjustNothing + MainActivity 替换 insets 监听，窗口恒全高）：
  //   键盘偏移 = max(vv 遮挡, 原生 ime() 可视高度)。本机 vv/ime 动画期无中间帧、
  //   起点即跳终值：applySmart 检测到 0↔正 跳变就把 offset 一次性指到终点，
  //   CSS transition(.composer-kb-anim) 驱动输入栏随键盘同步滑行；didShow/didHide 校正。
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    if (baselineInnerHRef.current === 0) baselineInnerHRef.current = window.innerHeight;
    let lastWidth = window.innerWidth;
    const isAndroid = Capacitor.getPlatform() === 'android';
    // 原生同步接口（MainActivity JavascriptInterface）：aiboo:ime 事件只在变化时派发，
    // 冷启时键盘可能已升起、事件早于 JS 加载，随时可拉当前键盘可视高度兜底
    const imeIf = (window as unknown as { AibooIme?: { getImeHeightCss?: () => number } }).AibooIme;
    if (imeIf?.getImeHeightCss) {
      const h = imeIf.getImeHeightCss();
      if (h > 0) nativeImeHeightRef.current = h;
    }
    // 冷启即定面板高度：有上次实测值用实测值，全新安装按屏高估算——
    // 不然用户在本次还没弹过键盘就开面板，会矮一截（280 兜底）。
    if (keyboardHeightRef.current <= 100) {
      const safeBottom = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--safe-area-bottom') || '0');
      document.documentElement.style.setProperty('--panel-height', `${Math.round(estimateKeyboardHeight() + safeBottom)}px`);
    } else {
      document.documentElement.style.setProperty('--panel-height', `${keyboardHeightRef.current}px`);
    }
    const setAnim = (on: boolean) => {
      document.documentElement.classList.toggle('composer-kb-anim', on);
    };

    // kbAnimating 看门狗：正常由 didShow/didHide 解锁；事件丢失（极端连打、ROM 丢事件）
    // 时 900ms 强制解锁并重采校正，避免输入栏永久冻结在错误位置
    let animWatchdogTimer: number | null = null;
    const setKbAnimating = (on: boolean) => {
      if (on) {
        if (kbAnimatingRef.current) return;
        kbAnimatingRef.current = true;
        if (animWatchdogTimer !== null) window.clearTimeout(animWatchdogTimer);
        animWatchdogTimer = window.setTimeout(() => {
          animWatchdogTimer = null;
          kbAnimatingRef.current = false;
          setAnim(false);
          sampleOverlap();
          apply();
        }, 900);
      } else {
        kbAnimatingRef.current = false;
        if (animWatchdogTimer !== null) {
          window.clearTimeout(animWatchdogTimer);
          animWatchdogTimer = null;
        }
      }
    };

    const getPanelHeight = () => {
      // 优先用实测键盘高度（didShow 时记录），未记录过按屏高估算 + safe-area 兜底。
      // 与面板 CSS 高度（--panel-height）同源，保证输入栏位移量 == 面板实际高度。
      if (keyboardHeightRef.current > 0) return keyboardHeightRef.current;
      const safeBottom = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--safe-area-bottom') || '0');
      return Math.round(estimateKeyboardHeight() + safeBottom);
    };

    const sampleOverlap = () => {
      const vvOverlap = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      // 取 vv 与原生 ime() 的较大者：vv 低报时（高键盘输入法）原生值兜底，
      // 键盘隐藏时原生派发 0，max 自然退化为 vv 值
      stableOverlapRef.current = Math.max(vvOverlap, nativeImeHeightRef.current);
    };

    const apply = () => {
      // 原生缩放模式（iOS）：窗口自身收缩带动输入栏，offset 恒 0；
      // 键盘可见期间屏蔽面板偏移，避免面板高度把输入栏顶到半空。
      const resized = window.innerHeight < baselineInnerHRef.current;
      const keyboardVisible = resized && window.innerHeight < baselineInnerHRef.current - 100;
      const keyboardOffset = resized ? 0 : stableOverlapRef.current;
      // 表情包面板与加号面板同槽位同高，输入栏位移量一致（面板状态走 ref：
      // 本 effect 挂载一次不随面板开关重跑，闭包里的 state 是旧值）
      const panelHeight = (composerPanelOpenRef.current || stickerPanelOpenRef.current) && !keyboardVisible ? getPanelHeight() : 0;
      const offset = Math.round(Math.max(keyboardOffset, panelHeight));
      document.documentElement.style.setProperty('--composer-offset', `${offset}px`);
      composerOffsetValueRef.current = offset;
      reserveUpdateRef.current?.();
    };

    // 面板高=键盘真实高度（采样终值），等高后键盘↔面板切换输入栏位置不动、
    // 键盘正好盖满面板（不等高时 didShow 卸载面板会在键盘上方露出一条）
    const syncPanelHeight = () => {
      const overlap = Math.round(stableOverlapRef.current);
      if (overlap > 100 && overlap !== keyboardHeightRef.current) {
        keyboardHeightRef.current = overlap;
        storeKeyboardHeight(overlap);
        document.documentElement.style.setProperty('--panel-height', `${overlap}px`);
      }
    };

    // 智能 apply：本机实测 vv/ime 在键盘动画期无中间帧、起点即跳终值，而键盘视觉上
    // 还要滑 ~300ms（willShow@182ms→didShow@492ms）。逐帧 apply 会让输入栏瞬跳到位
    // 干等键盘（用户感知"有延迟不丝滑"）。检测遮挡 0↔正 跳变即认定动画开始：
    // 一次性把 offset 指到终点，CSS transition(.composer-kb-anim) 驱动同步滑行；
    // 已开时的高度微调（输入法模式切换，无 willShow/didShow）走 350ms 短滑行。
    let imeAdjustTimer: number | null = null;
    const applySmart = () => {
      if (kbAnimatingRef.current) return; // 动画期冻结：offset 已指到终点
      const prev = stableOverlapRef.current;
      sampleOverlap();
      if (isAndroid) {
        const now = stableOverlapRef.current;
        if (prev <= 100 && now > 100) {
          // 键盘开始升起：终点取已知最大值（上次实测/原生），vv 中间值可能偏小
          setKbAnimating(true);
          setAnim(true);
          stableOverlapRef.current = Math.max(now, keyboardHeightRef.current);
        } else if (prev > 100 && now <= 100) {
          // 键盘开始收起：目标 0（面板已开时 apply 会取面板高，零位移）
          setKbAnimating(true);
          setAnim(true);
          stableOverlapRef.current = 0;
        } else if (now > 100 && prev > 100 && now !== prev) {
          setAnim(true);
          if (imeAdjustTimer !== null) window.clearTimeout(imeAdjustTimer);
          imeAdjustTimer = window.setTimeout(() => {
            imeAdjustTimer = null;
            setAnim(false);
          }, 350);
        }
      }
      apply();
    };

    const update = () => {
      // 旋转：宽度变化时以当前高度重建基准，避免旧基准误判缩放模式
      if (window.innerWidth !== lastWidth) {
        lastWidth = window.innerWidth;
        baselineInnerHRef.current = window.innerHeight;
      }
      applySmart();
    };
    offsetUpdateRef.current = update;

    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    window.addEventListener('resize', update);

    // 原生键盘可视高度（MainActivity 派发）：src=0 insets 跳变帧（本 ROM 动画起点即终值），
    // src=1 WindowInsetsAnimation 逐帧流（支持 inset 动画的 ROM）
    const onNativeIme = (e: Event) => {
      const d = (e as CustomEvent<{ height?: number; src?: number }>).detail;
      const h = d?.height;
      if (typeof h !== 'number') return;
      nativeImeHeightRef.current = h;
      if (isAndroid && d?.src === 1) {
        // 逐帧流：脱离 transition，输入栏逐帧直贴键盘顶（微信式跟手）
        setKbAnimating(true);
        setAnim(false);
        sampleOverlap();
        apply();
        return;
      }
      applySmart();
    };
    window.addEventListener('aiboo:ime', onNativeIme);

    // 用户点输入框外触发 blur = 键盘即将收起：立刻开始下滑，不等 willHide/ime 事件
    // （本机实测事件晚 55~130ms 才到，用户感知"慢半拍"）。程序主动 blur（+键/表情键
    // 开面板）由 openingStickerRef/openingPanelRef 挡掉，不走这里。
    hideGlideRef.current = () => {
      if (!isAndroid || kbAnimatingRef.current) return;
      if (stableOverlapRef.current <= 100 && nativeImeHeightRef.current <= 100) return;
      setKbAnimating(true); // 看门狗兜底：键盘实际没收（didHide 不来）时 900ms 后解锁重采
      setAnim(true);
      nativeImeHeightRef.current = 0;
      stableOverlapRef.current = 0;
      apply();
    };

    const listeners: Array<{ remove: () => void }> = [];
    if (Capacitor.isNativePlatform()) {
      void (async () => {
        listeners.push(await Keyboard.addListener('keyboardWillShow', (info) => {
          setKbAnimating(true);
          if (isAndroid) {
            setAnim(true);
            // insets 动画起点即终值：原生接口此刻已是最终键盘高（冷启/首次也能拿到）
            const imeNow = imeIf?.getImeHeightCss?.() ?? 0;
            if (imeNow > 100) nativeImeHeightRef.current = imeNow;
            const expectedKb = nativeImeHeightRef.current > 100
              ? nativeImeHeightRef.current
              : getPanelHeight();
            keyboardHeightRef.current = expectedKb;
            storeKeyboardHeight(expectedKb);
            document.documentElement.style.setProperty('--panel-height', `${expectedKb}px`);
            stableOverlapRef.current = expectedKb;
            // 一次性把 offset 指到终点，CSS transition 让输入栏随键盘同步滑上去
            const panelHeight = (composerPanelOpenRef.current || stickerPanelOpenRef.current) ? getPanelHeight() : 0;
            const offset = Math.round(Math.max(expectedKb, panelHeight));
            document.documentElement.style.setProperty('--composer-offset', `${offset}px`);
            composerOffsetValueRef.current = offset;
            reserveUpdateRef.current?.();
          } else {
            // iOS 缩放模式：面板高度对齐窗口收缩量（比事件值准），异常退回事件值
            const shrink = baselineInnerHRef.current - window.innerHeight;
            const kbHeight = shrink > 100 ? shrink : (info?.keyboardHeight ?? 0);
            if (kbHeight > 100 && kbHeight !== keyboardHeightRef.current) {
              keyboardHeightRef.current = kbHeight;
              storeKeyboardHeight(kbHeight);
              document.documentElement.style.setProperty('--panel-height', `${kbHeight}px`);
            }
          }
        }));
        listeners.push(await Keyboard.addListener('keyboardDidShow', () => {
          setKbAnimating(false);
          if (window.innerHeight >= baselineInnerHRef.current) {
            // 非缩放（安卓）：动画结束采终值精确校正（通常与 willShow 预期一致，零位移）
            sampleOverlap();
            syncPanelHeight();
          }
          if (pendingPanelCloseRef.current) {
            // 键盘已升起盖住面板：卸载面板，完成交叉过渡（面板锚定屏幕底，期间位置不动）
            pendingPanelCloseRef.current = false;
            if (panelCloseTimerRef.current) window.clearTimeout(panelCloseTimerRef.current);
            setComposerPanelOpen(false);
          }
          if (pendingStickerCloseRef.current) {
            // 表情包面板同款收尾
            pendingStickerCloseRef.current = false;
            if (stickerCloseTimerRef.current) window.clearTimeout(stickerCloseTimerRef.current);
            setStickerPanelOpen(false);
          }
          apply();
          setAnim(false);
        }));
        listeners.push(await Keyboard.addListener('keyboardWillHide', () => {
          setKbAnimating(true);
          if (isAndroid) {
            setAnim(true);
            // 键盘下滑同时输入栏随 transition 落位：面板已开则保持面板高（零位移，
            // 键盘滑走露出面板）；否则归 0 随键盘滑到底。先清采样值再 apply 直指终点。
            nativeImeHeightRef.current = 0;
            stableOverlapRef.current = 0;
            apply();
          }
        }));
        listeners.push(await Keyboard.addListener('keyboardDidHide', () => {
          setKbAnimating(false);
          baselineInnerHRef.current = Math.max(baselineInnerHRef.current, window.innerHeight);
          apply();
          setAnim(false);
        }));
        // 冷启自聚焦把键盘拉起的时序可能早于上面的监听注册：注册完补一次采样+面板高
        // 校正，否则键盘已升起但偏移没采到，输入栏会被键盘盖住直到下次事件
        update();
        syncPanelHeight();
      })();
    }

    update();

    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
      window.removeEventListener('aiboo:ime', onNativeIme);
      if (imeAdjustTimer !== null) window.clearTimeout(imeAdjustTimer);
      if (animWatchdogTimer !== null) window.clearTimeout(animWatchdogTimer);
      hideGlideRef.current = null;
      offsetUpdateRef.current = null;
      listeners.forEach((l) => l.remove());
    };
    // 挂载一次：面板状态经 ref 镜像读取，键盘事件监听不随面板开关重注册
    // （重注册有间隙，快速连打 +/表情 时会丢键盘事件、kbAnimating 卡死，输入栏消失）
  }, []);

  // 面板开关时重算输入栏位移（上面的 offset effect 挂载一次，不随面板状态重跑）
  useEffect(() => {
    offsetUpdateRef.current?.();
  }, [composerPanelOpen, stickerPanelOpen]);

  // 移动端展开态：输入框随内容自动增高（最多约 5 行后内部滚动）；收起态/桌面端保持单行
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    if (!isMobile || !composerExpanded) {
      el.style.height = '';
      return;
    }
    el.style.height = '22px';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, [input, isMobile, composerExpanded]);

  // 日记生成逻辑见 features/diary/useDiary.ts

  function startLoginMorph(target: StageTransform) {
    if (morphRafRef.current) cancelAnimationFrame(morphRafRef.current);
    // 起点用「当前登录构图」(loginFraming)，终点是主页构图。两者相同(默认)时即为无跳变。
    const from = loginFramingFor(selectedAvatar);
    const start = performance.now();
    const duration = 850;
    setMorphTransform(from);
    setMorphActive(true);
    morphActiveRef.current = true;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const e = easeOutQuint(t);
      setMorphTransform({
        scale: from.scale + (target.scale - from.scale) * e,
        offsetX: from.offsetX + (target.offsetX - from.offsetX) * e,
        offsetY: from.offsetY + (target.offsetY - from.offsetY) * e,
        // 端点任一为绝对构图（后台配置 loginFraming/homeFraming）时，插值全程也在绝对空间，标志保持 true。
        absolute: !!(from.absolute || target.absolute),
      });
      if (t < 1) {
        morphRafRef.current = requestAnimationFrame(step);
      } else {
        morphRafRef.current = null;
        morphActiveRef.current = false;
        setMorphActive(false);
      }
    };
    morphRafRef.current = requestAnimationFrame(step);
  }

  useEffect(() => () => {
    if (morphRafRef.current) cancelAnimationFrame(morphRafRef.current);
  }, []);

  // 把「是否正处于 DJ 模式 + 当前 DJ 角色」上报给原生(SharedPreferences)，供充电屏保联动。
  // 心跳刷新时间戳，仅在前台可见时打点：切后台/被杀 → 时间戳过期 → 屏保判定为未在 DJ 模式
  //（对应「最近活跃」语义）。退出 DJ 模式/卸载时显式写 false。
  useEffect(() => {
    if (!djModeOpen) {
      reportDjMode(false, '');
      return;
    }
    const beat = () => {
      if (document.visibilityState === 'visible') reportDjMode(true, selectedAvatarId);
    };
    beat();
    const timer = window.setInterval(beat, 10_000);
    document.addEventListener('visibilitychange', beat);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', beat);
      reportDjMode(false, '');
    };
  }, [djModeOpen, selectedAvatarId]);

  // 前台活跃时长统计：进前台开计，退后台/锁屏结算上报；前台期间每分钟周期结算一次，
  // 崩溃/杀进程最多丢失最后一分钟（分钟级误差口径）。只上报「角色+时长段」，不含起止时间。
  // 原生端走 Capacitor appStateChange（锁屏时 WebView 的 visibilitychange 不一定触发），
  // 浏览器/dev 用 visibilitychange 兜底；事件重复由 tracker 幂等吸收。
  useEffect(() => {
    const tracker = createUsageTracker({
      onSessionStart: () => void reportUsageOpen(),
    });
    usageTrackerRef.current = tracker;
    const emit = (segments: UsageSegment[]) => {
      for (const seg of segments) void reportUsageTime(seg.avatarId, seg.seconds);
    };
    const handleForeground = () => emit(tracker.enterForeground(Date.now(), selectedAvatarIdRef.current));
    const handleBackground = () => emit(tracker.enterBackground(Date.now()));
    const onVisibility = () => {
      if (document.visibilityState === 'visible') handleForeground();
      else handleBackground();
    };
    onVisibility(); // 挂载即按当前可见性起计
    document.addEventListener('visibilitychange', onVisibility);
    let appListener: PluginListenerHandle | null = null;
    if (Capacitor.isNativePlatform()) {
      void CapacitorApp.addListener('appStateChange', ({ isActive }) => {
        if (isActive) handleForeground();
        else handleBackground();
      }).then((listener) => {
        appListener = listener;
      });
    }
    const flushTimer = window.setInterval(() => emit(tracker.flush(Date.now())), 60_000);
    return () => {
      window.clearInterval(flushTimer);
      document.removeEventListener('visibilitychange', onVisibility);
      void appListener?.remove();
      usageTrackerRef.current = null;
    };
  }, []);

  // 世界书对账：App 回到前台时复查当前角色（浏览器 visibilitychange + 原生 appStateChange 双保险）。
  useEffect(() => {
    let appListener: PluginListenerHandle | null = null;
    const onVisibility = () => {
      if (document.visibilityState === 'visible') triggerLorebookSync('foreground');
    };
    document.addEventListener('visibilitychange', onVisibility);
    if (Capacitor.isNativePlatform()) {
      void CapacitorApp.addListener('appStateChange', ({ isActive }) => {
        if (isActive) triggerLorebookSync('foreground');
      }).then((listener) => {
        appListener = listener;
      });
    }
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      void appListener?.remove();
    };
  }, []);

  // 时长统计：前台期间切换角色，旧角色先结算，后续时长挂到新角色。
  useEffect(() => {
    const segments = usageTrackerRef.current?.switchAvatar(Date.now(), selectedAvatarId) ?? [];
    for (const seg of segments) void reportUsageTime(seg.avatarId, seg.seconds);
  }, [selectedAvatarId]);

  // 进入 DJ 模式：模型全程常驻（同一个实例，换装走 Param67），无需加载/切换，立即标记就绪 → 启动升起+换装。
  useEffect(() => {
    if (djModeOpen) djView.markReady();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [djModeOpen]);

  // SoulLink 情绪层接线（开关默认关 → 整段零行为差异）：仅在「DJ 模式 + shuangsheng + 开关开 + runtime 就绪 + 换装到位」时，
  // 实例化情绪桥并每帧 tick → setSoullinkEmotionParams（引擎在 runOverlayFrame 里叠加，costume 之后/口型之前）。
  // 口播文本经 djView.onSpokenText → bridge.feedText 驱动。退出/关开关/切角色时清空情绪参数并销毁桥。
  useEffect(() => {
    const runtime = live2dRuntimeRef.current;
    const enabled =
      djModeOpen &&
      djView.ready &&
      djView.mode !== 'commute' && // 通勤无 Live2D（Stage 卸载），情绪层不适用
      selectedAvatarId === 'shuangsheng' &&
      isSoullinkEmotionEnabled() &&
      !!runtime;
    if (!enabled || !runtime) {
      if (runtime) setSoullinkEmotionParams(runtime, new Map());
      soullinkBridgeRef.current = null;
      return;
    }

    const bridge = createSoullinkBridge({
      profile: shuangshengProfile as unknown as ModelProfile,
      reserved: {
        costumeIds: runtime.costumeParamOverrides.keys(), // Param67 等换装参数
        mouthIds: ['ParamMouthOpenY'], // 口型（口播能量驱动，情绪层不得触碰）
      },
    });
    soullinkBridgeRef.current = bridge;

    let raf = 0;
    let last = performance.now() / 1000;
    const step = () => {
      const now = performance.now() / 1000;
      const dt = Math.min(0.1, Math.max(0, now - last));
      last = now;
      // 永不抛出铁律：bridge.tick 冲突时会 throw（见 soullinkBridge.ts），一旦逃逸到
      // rAF 回调就是未捕获异常直达 window.onerror。这里兜底：捕获后清空情绪层参数
      // 并停止继续排程，让画面回到「情绪层零行为差异」的安全态，而不是打断整个 App。
      try {
        setSoullinkEmotionParams(runtime, bridge.tick(now, dt));
      } catch (err) {
        console.error('[soullink] emotion tick 异常，已停用情绪层本轮会话', err);
        setSoullinkEmotionParams(runtime, new Map());
        return;
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);

    return () => {
      cancelAnimationFrame(raf);
      soullinkBridgeRef.current = null;
      setSoullinkEmotionParams(runtime, new Map()); // 清空情绪层，回到零行为差异
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [djModeOpen, djView.ready, djView.mode, selectedAvatarId, live2dRuntimeNonce]);

  // 共享 Stage 就绪回调：首次创建 / 切换角色重建完成时触发（DJ 进出不再触发——模型不重建）。
  function handleStageReady() {
    if (djModeOpen) djView.markReady();

    // 滑动切换收尾：新模型已可渲染。若连滑期间还有排队目标，直接续切（遮罩不落）；否则淡出遮罩。
    if (switchingRef.current) {
      const queued = queuedSwitchRef.current;
      queuedSwitchRef.current = null;
      if (queued && queued !== selectedAvatarIdRef.current) {
        startSwitch(queued);
        return;
      }
      finishSwitch();
    }
  }

  // 切换：置遮罩、预加载目标背景（保证遮罩落下时新背景已解码）、切 id。
  function startSwitch(avatarId: string) {
    const target = getAvatarById(avatarId);
    switchingRef.current = true;
    setSwitching(true);
    setSwitchTargetName(target?.name ?? '');
    // 背景随角色 id 同批提交：先预加载目标背景（本地保存 → 角色默认背景），
    // 并立刻应用到 activeBg，不再等 [selectedAvatar] 异步解析后才切——
    // 消除切换瞬间上一个角色的背景滞留窗口。
    const bg = loadBackgrounds()[avatarId]?.url ?? target?.defaultBackground ?? null;
    if (bg) { const img = new Image(); img.src = bg; }
    setActiveBg(bg);
    if (switchSafetyTimerRef.current) window.clearTimeout(switchSafetyTimerRef.current);
    // 安全兜底：加载失败不会触发 onReady，8s 后强制收尾避免遮罩卡死。
    // 若期间有排队目标（连滑），续切而不是丢弃——否则用户手势石沉大海、像卡死。
    switchSafetyTimerRef.current = window.setTimeout(() => {
      const queued = queuedSwitchRef.current;
      queuedSwitchRef.current = null;
      if (queued && queued !== selectedAvatarIdRef.current) {
        startSwitch(queued);
        return;
      }
      finishSwitch();
    }, 8000);
    setSelectedAvatarId(avatarId);
    clearUnread(avatarId); // 切到该角色即清其未读红点
  }

  function finishSwitch() {
    switchingRef.current = false;
    queuedSwitchRef.current = null;
    if (switchSafetyTimerRef.current) {
      window.clearTimeout(switchSafetyTimerRef.current);
      switchSafetyTimerRef.current = null;
    }
    setSwitching(false);
  }

  // 登录↔主页背景渐隐：仅在登录态真正切换时开启交叉淡入(过渡期同时渲染两张图)，结束回单图保清晰。
  const bgPhaseRef = useRef<boolean>(!!authUser);
  useEffect(() => {
    const phase = !!authUser;
    if (bgPhaseRef.current === phase) return;
    bgPhaseRef.current = phase;
    if (!isMobile) return;
    setBgFading(true);
    const t = window.setTimeout(() => setBgFading(false), 650);
    return () => window.clearTimeout(t);
  }, [authUser]);

  // 卸载时清理长按定时器，防止组件卸载后触发录音
  useEffect(() => () => {
    if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
  }, []);

  // v2 profile：dev 模式下暴露手动触发入口，供真机测试。
  useEffect(() => {
    if (import.meta.env.DEV) {
      (window as unknown as Record<string, (file: string) => void>).debugTriggerProfile = (file: string) => {
        if (!profileBindingRef.current) {
          console.warn('[profile] binding not ready');
          return;
        }
        profileBindingRef.current.trigger(file);
      };
      (window as unknown as Record<string, (slot: CostumeSlot) => void>).debugClearSlot = (slot: CostumeSlot) => {
        if (!profileBindingRef.current || !('clearSlot' in profileBindingRef.current)) {
          console.warn('[profile] v2 binding not ready');
          return;
        }
        const actions = profileBindingRef.current.clearSlot(slot);
        console.info('[profile] manual clearSlot', { slot, actions });
      };
    }
    return () => {
      if (import.meta.env.DEV) {
        delete (window as unknown as Record<string, unknown>).debugTriggerProfile;
        delete (window as unknown as Record<string, unknown>).debugClearSlot;
      }
    };
  }, []);

  async function handleLogin(user: UserInfo) {
    setAuthUser(user);
    if (isMobile) {
      // 角色从登录构图平滑过渡到主页构图（共享同一 Live2D 实例，不重载）
      startLoginMorph(homeFramingFor(selectedAvatar));
    }
    if (!isLocalGuest()) {
      await executePull();
      void syncAvatarConfig(selectedAvatarIdRef.current, {
        silent: true,
        force: true,
        updateTransform: true,
      });
    }
  }

  function handleLogout() {
    setAuthUser(null);
    setProfileOpen(false);
  }

  // 聊天意图：说「切换/进入 DJ 模式 / 电台 / 打碟」→ 直接进 App 内 DJ 电台（不发给大模型）。
  function tryEnterDjMode(text: string): boolean {
    const hit = /(?:切换|进入|打开|开启|开始)?\s*dj\s*模式|进入?电台|开始打碟|电台模式/i.test(text.trim());
    if (!hit) return false;
    setInput('');
    setDjModeOpen(true);
    showToast('进入电台模式 🎧', 'info');
    return true;
  }

  // 统一发送入口：DJ 模式拦截 → 否则普通聊天发送。
  function submitText(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (tryEnterDjMode(trimmed)) return;
    handleSubmit(trimmed);
  }

  function onFormSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setComposerPanelOpen(false);
    if (pendingImage) {
      void handleSendImage();
      return;
    }
    submitText(input);
  }

  // 长按 textarea 录音手势处理
  function handleTextareaTouchStart(event: ReactTouchEvent<HTMLElement>) {
    if (!isMobile) return;
    // 不 preventDefault：让短按自然聚焦弹键盘（preventDefault 会导致键盘一闪即退）。
    // 长按时输入框文字被选中的问题由 CSS user-select:none 负责（Android WebView 下
    // touchstart preventDefault 压不住系统长按选词）。
    touchStartYRef.current = event.touches[0].clientY;
    setRecCancelHint(false);
    longPressTimerRef.current = window.setTimeout(() => {
      longPressTimerRef.current = null;
      isRecordingRef.current = true;
      recCancelHintRef.current = false;
      setRecActive(true);
      setRecCancelHint(false);
      // 面板打开时长按录音：像键盘一样先收掉面板，否则录音气泡与面板叠在一起
      setComposerPanelOpen(false);
      setStickerPanelOpen(false);
      inputRef.current?.blur(); // 进入录音前收起键盘
      try { navigator.vibrate?.(30); } catch { /* 不支持震动则忽略 */ }
      void startRecording();
    }, LONG_PRESS_MS);
  }

  function handleTextareaTouchMove(event: ReactTouchEvent<HTMLElement>) {
    if (!isMobile) return;
    if (!isRecordingRef.current) return;
    const cancel = shouldCancelBySlide(touchStartYRef.current, event.touches[0].clientY);
    recCancelHintRef.current = cancel;
    setRecCancelHint(cancel);
  }

  function handleTextareaTouchEnd(event: ReactTouchEvent<HTMLElement>) {
    if (!isMobile) return;
    if (longPressTimerRef.current) {
      // 短按：定时器还没触发，清掉。键盘交给原生聚焦（不再手动 focus，避免闪退）。
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    if (isRecordingRef.current) {
      // 录音抬手：阻止原生「点按聚焦输入框」，否则录完会弹键盘并把输入框展开。
      event.preventDefault();
      void finishRecording(!recCancelHintRef.current);
    }
  }

  function handleTextareaTouchCancel() {
    if (!isMobile) return;
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    if (isRecordingRef.current) {
      cancelRecording();
      isRecordingRef.current = false;
      recCancelHintRef.current = false;
      setRecActive(false);
      setRecCancelHint(false);
      inputRef.current?.blur();
      setComposerExpanded(false);
    }
  }

  async function finishRecording(shouldSend: boolean) {
    if (!isRecordingRef.current) return;
    isRecordingRef.current = false;
    setRecActive(false);
    // 录音结束（无论发出/取消）都收起输入框，避免残留展开态。
    inputRef.current?.blur();
    setComposerExpanded(false);

    if (!shouldSend) {
      cancelRecording();
      setRecCancelHint(false);
      return;
    }

    const result = stopRecording();
    setRecCancelHint(false);

    if (!result) {
      showToast('没听清，请重试', 'error', 3000);
      return;
    }

    if (isTooShort(result.durationMs)) {
      showToast('说话时间太短', 'warning', 3000);
      return;
    }

    setRecTranscribing(true);
    try {
      const text = await transcribeBlob(result.wavBlob);
      if (!text) {
        showToast('没听清，请重试', 'error', 3000);
        return;
      }
      submitText(text);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '语音识别失败';
      showToast(msg, 'error', 3000);
    } finally {
      setRecTranscribing(false);
    }
  }

  async function syncAvatarConfig(
    targetId: string,
    options: {
      silent?: boolean;
      force?: boolean;
      baseAvatar?: AvatarManifest;
      updateTransform?: boolean;
    } = {},
  ) {
    const gate = configFetchGateRef.current;
    // ALL-440：silent 在途时双击 force 不再被吞——queue 分支登记补跑，当前请求结束后再补一次；
    // 冷却仍只挡非 force；手动 force 永远 run（或 queue）。
    const decision = gate.submit({ targetId, force: !!options.force, silent: !!options.silent });
    if (decision.kind === 'skip') return;
    if (decision.kind === 'queue') return; // 已在途，等当前请求结束后补跑一次
    const base = options.baseAvatar
      ?? (selectedAvatarIdRef.current === targetId ? selectedAvatar : getAvatarById(targetId));
    if (base === undefined) return;
    try {
      const cfg = await fetchAvatarConfig(targetId);
      if (!cfg) {
        if (!options.silent) {
          // 真正登录的用户才提示「暂无更新」；游客 / 未登录引导去登录。
          const loggedIn = !!authUser && !isLocalGuest();
          showToast(loggedIn ? '暂无可同步的人设更新' : '登录后可同步最新人设', 'info');
        }
        return;
      }
      applyRemoteConfig(targetId, cfg); // 注册表（角色抽屉 / 后续 getAvatarById）
      invalidateAvatarResolution(targetId); // 让切走再切回也拿到新值
      gate.markFetched(targetId);
      // 仅当用户未在 await 期间切走，才把改动反映到当前舞台与对话。
      if (selectedAvatarIdRef.current === targetId && base.id === targetId) {
        const merged = mergeRemoteConfig(base, cfg);
        // 无实质变化时保持原对象引用：新引用会让 Live2DStage 的 [avatar] effect 重放
        // expressionMix/参数/动作（applyRuntimeState 首行 resetExpression），造成「先取消再恢复」闪烁。
        if (JSON.stringify(merged) !== JSON.stringify(base)) {
          setSelectedAvatar(merged);
        }
        if (options.updateTransform ?? true) {
          setStageTransform(isMobile ? homeFramingFor(merged) : merged.transformDefaults);
        }
      }
      if (!options.silent) showToast('已更新人设', 'info');
    } finally {
      // 在途期间被双击 force 排队：本请求结束后以相同意图补跑一次（不带 baseAvatar，重算当前目标）。
      const pending = gate.settled(targetId);
      if (pending.rerun) {
        void syncAvatarConfig(targetId, {
          silent: pending.silent,
          force: true,
          updateTransform: options.updateTransform ?? true,
        });
      }
    }
  }

  // 世界书对账统一入口：双击/进对话/切角色/回前台四个触发点共用（对账模块内部做
  // 在途去重、双击 5 分钟节流与游客/未登录拦截）。对账拉到新世界书写回注册表后，
  // 把当前选中角色同步到最新，下一轮对话即可读到新世界书。全程后台、非阻塞。
  function triggerLorebookSync(source: LorebookSyncSource, avatarId?: string) {
    const id = avatarId ?? selectedAvatarIdRef.current;
    void reconcileLorebook(id, { source }).then((result) => {
      if (!result.applied || selectedAvatarIdRef.current !== id) return;
      const lorebook = getAvatarById(id)?.lorebook;
      setSelectedAvatar((prev) =>
        prev && prev.id === id && prev.lorebook !== lorebook ? { ...prev, lorebook } : prev,
      );
    });
  }

  // 双击模型本体 → 手动拉一次服务端轻量配置（persona + transform + voice，不下载模型）。
  // 登录和切换角色也会静默自动拉取，用于让后台 TTS 音色及时生效。
  // force: true——切换时的静默拉取会刷新 10s 冷却时间戳，而双击的高发时机正是刚切完角色，
  // 不用 force 会被冷却静默吞掉（无任何提示，表现为「双击没反应」）。
  async function refreshSelectedAvatarConfig() {
    await syncAvatarConfig(selectedAvatarId, {
      silent: false,
      force: true,
      baseAvatar: selectedAvatar,
      updateTransform: true,
    });
    // 双击对账走独立通道（fetchAvatarConfig 已不再下发世界书），fire-and-forget，
    // 在 toast 之后后台执行，不阻塞提示。
    triggerLorebookSync('doubletap');
  }

  function handleAvatarChange(avatarId: string) {
    if (avatarId === selectedAvatarIdRef.current) {
      return;
    }
    // 切角色触发世界书对账（后台、不阻塞切换）。
    triggerLorebookSync('switch', avatarId);
    // 连滑防抖：加载中不叠加新的重建，只记住最新目标（并更新遮罩名字），落定后由 handleStageReady 续切。
    if (switchingRef.current) {
      queuedSwitchRef.current = avatarId;
      setSwitchTargetName(getAvatarById(avatarId)?.name ?? '');
      return;
    }
    startSwitch(avatarId);
  }

  // v2 profile：切角色或 runtime 就绪时，按角色 ID 加载 profile 并绑定调度器。
  // 加载/校验失败只 warn，不阻断人物渲染。
  function attachProfileBindingFor(runtime: RuntimeState, avatarId: string, avatar: AvatarManifest) {
    profileBindingRef.current?.dispose();
    profileBindingRef.current = null;
    profileRef.current = null;
    v2ProfileRef.current = null;
    isV2ProfileRef.current = false;
    setIsV2Profile(false);

    void loadProfileByRole(avatarId).then((profile) => {
      if (!profile || live2dRuntimeRef.current !== runtime) return;
      if (!profileTrackerRef.current) {
        profileTrackerRef.current = initTtsEndTracker();
      }
      const tracker = profileTrackerRef.current;

      const isV2 = profile.driver === 'v2';
      if (!isV2) {
        isV2ProfileRef.current = false;
        setIsV2Profile(false);
      }

      if (isV2) {
        void loadV2Profile(avatarId).then((v2Profile) => {
          if (!v2Profile || live2dRuntimeRef.current !== runtime) {
            // 挂载失败必须保持 isV2=false：否则 legacy 通道已被旁路、v2 又没绑上，两头落空。
            console.warn('[profile] v2 attach bail', { avatarId, hasV2Profile: !!v2Profile, runtimeStale: live2dRuntimeRef.current !== runtime });
            return;
          }
          v2ProfileRef.current = v2Profile;
          profileBindingRef.current = attachV2ProfileBinding({
            runtime,
            avatar,
            profile: v2Profile,
            tracker,
            initialCostumes: profileCostumeMemoryRef.current.get(avatarId),
          });
          // 绑定真正挂上后才声明 v2 模式（旁路 legacy 输出以它为准）。
          isV2ProfileRef.current = true;
          setIsV2Profile(true);
          const assetsRoot = avatar.modelJson.slice(0, avatar.modelJson.lastIndexOf('/') + 1);
          void validateV2Profile(v2Profile, assetsRoot);

          // shuangsheng vs shuangsheng-dj 启动期 diff：只 warn，不阻塞。
          const pairRole =
            avatarId === 'shuangsheng-dj' ? 'shuangsheng' : avatarId === 'shuangsheng' ? 'shuangsheng-dj' : null;
          if (pairRole) {
            void loadV2Profile(pairRole).then((pairProfile) => {
              if (!pairProfile) return;
              const base = avatarId === 'shuangsheng-dj' ? pairProfile : v2Profile;
              const dj = avatarId === 'shuangsheng-dj' ? v2Profile : pairProfile;
              const diff = diffShuangshengPair(base, dj);
              if (diff.missingInDj.length > 0 || diff.missingInBase.length > 0 || diff.fieldMismatch.length > 0) {
                console.warn('[v2 profile] shuangsheng ↔ shuangsheng-dj mismatch', diff);
              }
            });
          }
        });
        return;
      }

      profileRef.current = profile;
      profileBindingRef.current = attachProfileBinding({
        runtime,
        avatar,
        profile,
        tracker,
      });
    });
  }

  // v2 profile（原生渲染路径）：无 Pixi runtime，绑定执行层镜像到原生通道。
  // 与 attachProfileBindingFor 互斥：Pixi runtime 存在时不走这里；原生回落 Pixi 时
  // 由 attachProfileBindingFor 开头 dispose 掉本绑定，后挂者赢。
  function attachNativeProfileBindingFor(avatarId: string, avatar: AvatarManifest) {
    profileBindingRef.current?.dispose();
    profileBindingRef.current = null;
    v2ProfileRef.current = null;
    isV2ProfileRef.current = false;
    setIsV2Profile(false);

    void loadProfileByRole(avatarId).then((profile) => {
      if (!profile || profile.driver !== 'v2') {
        console.warn('[profile:native] attach bail', { avatarId, hasProfile: !!profile, driver: profile?.driver });
        return;
      }
      if (selectedAvatarIdRef.current !== avatarId) {
        console.warn('[profile:native] attach bail: avatar switched', { avatarId, current: selectedAvatarIdRef.current });
        return;
      }
      if (!profileTrackerRef.current) {
        profileTrackerRef.current = initTtsEndTracker();
      }
      void loadV2Profile(avatarId).then((v2Profile) => {
        if (!v2Profile) {
          console.warn('[profile:native] attach bail: no v2 profile', { avatarId });
          return;
        }
        if (selectedAvatarIdRef.current !== avatarId) {
          console.warn('[profile:native] attach bail: avatar switched', { avatarId, current: selectedAvatarIdRef.current });
          return;
        }
        v2ProfileRef.current = v2Profile;
        profileBindingRef.current = attachNativeV2ProfileBinding({
          avatar,
          profile: v2Profile,
          tracker: profileTrackerRef.current!,
          initialCostumes: profileCostumeMemoryRef.current.get(avatarId),
        });
        // 绑定真正挂上后才声明 v2 模式（与 Pixi 侧同序）。
        isV2ProfileRef.current = true;
        setIsV2Profile(true);
        const assetsRoot = avatar.modelJson.slice(0, avatar.modelJson.lastIndexOf('/') + 1);
        void validateV2Profile(v2Profile, assetsRoot);
      });
    });
  }

  // 设置更新/重置逻辑见 features/settings/useSettings.ts（updateLlmSettings/
  // updateTtsSettings/updateCallSettings/persistSettings/resetSettings）。
  function handleSaveLlmSettings() {
    persistSettings();
    setSettingsOpen(false);
  }

  // 语音通话开关逻辑见 features/call/useCall.ts

  function handleCloseSettings() {
    setSettingsOpen(false);
  }

  function focusInput() {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    // 不再调用 el.click()：它会冒泡触发 textarea 的 onClick，导致面板→键盘切换时
    // closePanelAndFocusInput 的逻辑被重复执行。
  }

  function closePanelAndFocusInput() {
    // 微信式交叉过渡：先聚焦唤起键盘，面板保持挂载（CSS 已锚定屏幕底，键盘升起时
    // 面板位置不动）；键盘升起盖住面板后（keyboardDidShow）再卸载，底部无空档。
    // 500ms 兜底：键盘唤起失败面板也能关闭。
    focusInput();
    pendingPanelCloseRef.current = true;
    if (panelCloseTimerRef.current) window.clearTimeout(panelCloseTimerRef.current);
    panelCloseTimerRef.current = window.setTimeout(() => {
      if (pendingPanelCloseRef.current) {
        pendingPanelCloseRef.current = false;
        setComposerPanelOpen(false);
      }
    }, 500);
  }

  // 表情包面板同款交叉过渡：聚焦唤起键盘，面板保持挂载（与加号面板同槽位、钉屏幕底），
  // 键盘升起盖住后（keyboardDidShow）再卸载；500ms 兜底键盘唤起失败也能关。
  function closeStickerAndFocusInput() {
    focusInput();
    pendingStickerCloseRef.current = true;
    if (stickerCloseTimerRef.current) window.clearTimeout(stickerCloseTimerRef.current);
    stickerCloseTimerRef.current = window.setTimeout(() => {
      if (pendingStickerCloseRef.current) {
        pendingStickerCloseRef.current = false;
        setStickerPanelOpen(false);
      }
    }, 500);
  }

  function handleInsertEmoji(emoji: string) {
    setInput((prev) => prev + emoji);
    window.setTimeout(() => focusInput(), 0);
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || !event.ctrlKey || event.nativeEvent.isComposing) {
      return;
    }

    event.preventDefault();

    const form = event.currentTarget.form;
    if (form) {
      form.requestSubmit();
    }
  }

  // 语音气泡播放统一走 tts.ts 的 stopSpeaking（停掉自动播报或上一条气泡 + 口型归零）。
  function stopVoicePlayback() {
    stopSpeaking();
    setPlayingVoiceId(null);
  }

  function handleToggleVoice(messageId: string, url: string) {
    if (playingVoiceId === messageId) {
      stopVoicePlayback();
      return;
    }

    // 先停掉任何在播音频（自动播报 / 另一条气泡），保证 setMouthOpen 单一来源、口型不串。
    stopVoicePlayback();

    setPlayingVoiceId(messageId);
    // 复用与自动播报相同的 AnalyserNode 口型路径：点击播放气泡时角色嘴部同步开合。
    void playAudioUrl(url, setMouthOpen, {
      avatarId: selectedAvatarId,
      onEnded: () => setPlayingVoiceId(null),
    }).catch((error) => {
      console.error('[chat] voice toggle failed:', error);
      setPlayingVoiceId(null);
      showToast('语音播放失败', 'error', 3000);
    });
  }

  // 拍照/选图 → 降采样 → 进待发预览（先预览再发，可在输入框补一句 caption）。
  async function handlePickImage(file: File) {
    if (!authUser) {
      showToast('请先登录', 'warning', 3000);
      return;
    }
    if (!file.type.startsWith('image/')) {
      showToast('请选择图片文件', 'warning', 3000);
      return;
    }
    try {
      const scaled = await scaleImageFile(file);
      setPendingImage(scaled);
      setComposerExpanded(true);
      focusInput();
    } catch (error) {
      console.error('[chat] image scale failed:', error);
      showToast('图片处理失败', 'error', 3000);
    }
  }

  // 发送待发图片：造 user 图片消息（dataUrl 既显示又喂模型）→ 本地入列 + 持久化 + 触发回复。
  async function handleSendImage() {
    if (!pendingImage) return;
    const caption = input.trim();
    const messageId = crypto.randomUUID();
    const userImageMessage: ChatMessage = {
      id: messageId,
      role: 'user',
      type: 'image',
      content: caption,
      image: {
        url: pendingImage.dataUrl,
        width: pendingImage.width,
        height: pendingImage.height,
        mime_type: pendingImage.mimeType,
        size_bytes: pendingImage.sizeBytes,
      },
      createdAt: Date.now(),
    };
    setMessages((prev) => [...prev, userImageMessage]);
    setPendingImage(null);
    setInput('');
    // 把图片字节存进沙盒：服务器会剥掉 data: URL（messages.cjs safeMediaUrl），用户图又无 image_prompt
    // 可重生，故必须本地留存，否则重载后 ensureImageInSandbox 未命中→永远「加载中」。镜像助手发图路径。
    try {
      const blob = await (await fetch(pendingImage.dataUrl)).blob();
      await saveGeneratedImage(messageId, blob);
    } catch (error) {
      console.error('[chat] save user image to sandbox failed:', error);
    }
    void saveChatMessage(selectedAvatarId, userImageMessage).catch((error) => {
      console.error('[chat] save user image failed:', error);
    });
    // 最后一条 user 图片消息会被 llm.ts 注入 image_url；handleSubmit 允许空文本继续。
    await handleSubmit('');
  }

  // 用户选择 sticker 后发送：关闭面板并把 sticker 交给 useChat 处理。
  // 用户选中 sticker → 带当前输入框文字一起发送（纯 sticker 时文字为空）。
  function handleSendSticker(sticker: Sticker) {
    if (!authUser) {
      showToast('请先登录', 'warning', 3000);
      return;
    }
    if (isSending) return;
    setComposerPanelOpen(false);
    void handleSubmit(input, { id: sticker.id, url: sticker.url });
  }

  function handleToggleTts() {
    const next = !ttsEnabled;
    setTtsEnabled(next); // useSettings: setState + saveTtsEnabled 持久化
    // 关闭语音时立即停止正在播放的音频：AI 播报(stopSpeaking) + 语音气泡(stopVoicePlayback)。
    if (!next) {
      stopSpeaking();
      stopVoicePlayback();
    }
  }

  // 打开「模型调试 / 抓取参数」面板（移动端 ControlDrawer 的 Parameter Debug 区）。
  function openModelDebugPanel() {
    setControlDrawerScrollToDebug(true);
    setControlDrawerOpen(true);
  }

  // 隐藏手势：长按 TTS 喇叭 5 秒触发。按下起计时，抬手/移出/取消则清除。
  function handleTtsLongPressStart() {
    ttsLongPressFiredRef.current = false;
    if (ttsLongPressTimerRef.current !== null) {
      window.clearTimeout(ttsLongPressTimerRef.current);
    }
    ttsLongPressTimerRef.current = window.setTimeout(() => {
      ttsLongPressFiredRef.current = true;
      ttsLongPressTimerRef.current = null;
      try { navigator.vibrate?.(60); } catch { /* 不支持震动则忽略 */ }
      openModelDebugPanel();
    }, 5000);
  }

  function handleTtsLongPressCancel() {
    if (ttsLongPressTimerRef.current !== null) {
      window.clearTimeout(ttsLongPressTimerRef.current);
      ttsLongPressTimerRef.current = null;
    }
  }

  // 长按已触发过这次抬手就吞掉 click，避免顺带切换 TTS 开关；否则正常切换。
  function handleTtsButtonClick() {
    if (ttsLongPressFiredRef.current) {
      ttsLongPressFiredRef.current = false;
      return;
    }
    handleToggleTts();
  }

  if (authChecking) {
    return (
      <div className="app-shell" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ textAlign: 'center' }}>
          <div className="spinner" style={{ width: 32, height: 32, margin: '0 auto 12px', border: '3px solid rgba(255,255,255,0.1)', borderTopColor: '#d6a761', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
          <p style={{ color: '#9a8c7a', fontSize: '0.9rem' }}>正在加载...</p>
        </div>
      </div>
    );
  }

  // 桌面端：未登录直接渲染登录页（保持原行为）
  if (!authUser && !isMobile) {
    return <LoginPage onLogin={handleLogin} />;
  }

  // 移动端：app-shell 始终挂载（Live2D 实例常驻、不重载）；未登录时加 pre-auth
  // 类隐藏聊天 UI，并把 LoginPage 作为透明浮层叠在角色之上。
  const preAuth = isMobile && !authUser;
  // 角色构图：登录态用后台配置的 loginFraming（缺省回落主页构图）；过渡中用 morph 插值；其余用主页 stageTransform。
  const personaTransform = preAuth
    ? loginFramingFor(selectedAvatar)
    : morphActive
      ? morphTransform
      : stageTransform;
  // 未登录时必须只露出清晰的 login-bg；用户/主页背景只允许进入主页后由舞台承载。
  // 全息屏：角色纯白悬浮，舞台一律不承载背景（含 WebGL 景深背景，CSS 盖不住，须从源头置 null）。
  // 原生模式下 DOM 的 .app-bg 被隐藏（html.native-live2d），登录背景必须交给原生 GL 层画——
  // 否则登录页角色下是黑的。非原生模式登录背景仍走 .app-bg，此处不重复传（避免与视差 stage-bg 错位）。
  const loginNativeBg = nativeStageEnabled() && isBundledModelJson(selectedAvatar.modelJson) ? LOGIN_BG_URL : null;
  const stageBackgroundUrl = isHoloSurface ? null : (authUser ? activeBg : loginNativeBg);

  // 共享单一 Live2DStage：登录/主页/DJ 三态共用同一个渲染器与 WebGL 上下文（不再为 DJ mount 第二个舞台）。
  // 进 DJ 不换模型：三页全程同一个模型实例。进 DJ = 换装(Param67 ramp) + 升起位移 + 背景，复用登录→主页那套丝滑过渡。
  // （同一 WebGL 上下文里常驻第二个 Cubism 模型会冻死第一个的 moc 形变，故彻底不预载/不换模型。）
  const stageAvatar = selectedAvatar;
  // 全息屏：角色调小+下移，避免横屏头顶超屏（覆盖 persona/DJ 构图）。
  const stageTransformProp = isHoloSurface
    ? IDENTITY_DELTA
    : (djModeOpen ? djView.transform : personaTransform);
  const stageMouthOverrides = djModeOpen ? djView.mouthOverrides : mouthSyncOverrides;
  // DJ 背景在角色「就绪」后再换上（冷加载期间维持主页背景，避免主页模型短暂叠到 DJ 背景上）。
  const stageBackgroundProp = isHoloSurface
    ? null
    : (djModeOpen ? (djView.ready ? DJ_BG_URL : stageBackgroundUrl) : stageBackgroundUrl);

  return (
    <div className="device-frame">
      {isMobile ? (
        <div
          className={`app-bg${bgFading ? ' app-bg--fading' : ''}`}
          data-phase={authUser ? 'home' : 'login'}
          aria-hidden="true"
        >
          {/* 稳态只渲染当前相位的单图(清晰)；登录↔主页切换的瞬间(bgFading)才同时渲染两张图做 opacity
              交叉淡入。过渡结束回单图——避免长期把背景留作合成图层被 Live2D WebGL 显存压力降清(Pixel 实测)。 */}
          {bgFading ? (
            <>
              {/* 旧相位在底(静态)，新相位在上做 opacity 0→1 关键帧淡入 → 交叉淡入 */}
              <img
                className="app-bg-img app-bg-img--out"
                src={authUser ? '/backgrounds/login-bg.jpg?v=5' : '/backgrounds/home-bg.jpg?v=3'}
                alt=""
              />
              <img
                className="app-bg-img app-bg-img--in"
                src={authUser ? '/backgrounds/home-bg.jpg?v=3' : '/backgrounds/login-bg.jpg?v=5'}
                alt=""
              />
            </>
          ) : (
            <img
              className="app-bg-img"
              src={authUser ? '/backgrounds/home-bg.jpg?v=3' : '/backgrounds/login-bg.jpg?v=5'}
              alt=""
            />
          )}
        </div>
      ) : null}
      <div className={`app-shell bubble-${bubbleStyle}${preAuth ? ' pre-auth' : ''}${djModeOpen ? ' dj-entering' : ''}${callOpen ? ' in-call' : ''}${recActive ? ' recording' : ''}${uiIdleHidden ? ' ui-idle-hidden' : ''}`}>
      <ToastContainer />
      <VoiceRecordOverlay
        visible={recActive || recTranscribing}
        elapsedMs={recState.status === 'recording' ? recState.elapsedMs : 0}
        cancelHint={recCancelHint}
        transcribing={recTranscribing}
        level={recLevel}
      />
      {isMobile && authUser ? <div className="home-overlay" aria-hidden="true" /> : null}
      <section className="viewer-panel">
        {/* 三态共用的唯一 Live2DStage：DJ 完整模型与主页轻量模型常驻同一上下文，进/出 DJ 仅切指针+构图，零重载。
            通勤模式例外：由 DjMode 内的双主播独立舞台接管 → 此处**卸载**共享舞台（释放其 WebGL 上下文），
            避免「共享 + 双主播」三上下文同屏触发浏览器驱逐导致全体黑屏。 */}
        {/* 演出(cutscene)期间不卸载 stage：卸载会触发 pixi 清理链上的 null.remove 崩溃(真机实录)。
            「Live2D 消失」由 CutsceneScene 的 fixed inset-0 z-50 不透明黑底盖住实现(同 EndingScene 先例)。 */}
        {(djModeOpen && djView.mode === 'commute') || endingDemoOpen ? null : (
        <Live2DStage
          avatar={stageAvatar}
          expressionMix={djModeOpen ? EMPTY_EXPRESSION_MIX : activeExpressionMix}
          action={djModeOpen ? null : activeAction}
          parameterOverrides={djModeOpen ? EMPTY_PARAM_OVERRIDES : stageParameterOverrides}
          mouthSyncOverrides={stageMouthOverrides}
          costumeParamOverrides={composed.costumeParamOverrides}
          watermarkVisible={djModeOpen ? false : !watermarkVisible}
          transform={stageTransformProp}
          surface={isHoloSurface ? 'holo' : (djModeOpen ? 'dj' : 'home')}
          backgroundUrl={stageBackgroundProp}
          motionName={djModeOpen ? 'idle' : authUser ? (lifeSignsWardrobeItemId || motionName) : 'idle'}
          interactive={djModeOpen ? false : !!authUser}
          onDoubleTap={djModeOpen ? undefined : refreshSelectedAvatarConfig}
          onSwitchAvatar={djModeOpen ? undefined : switchAvatarBySwipe}
          sensorEnabled={djModeOpen ? false : sensorEnabled}
          onReady={handleStageReady}
          onRuntimeReady={(runtime) => {
            live2dRuntimeRef.current = runtime;
            setLive2dRuntimeNonce((n) => n + 1);
          }}
          onNativeReady={() => setNativeStageNonce((n) => n + 1)}
          nativeTargetFps={MAIN_NATIVE_TARGET_FPS}
        />
        )}
        {/* 滑动切换过渡遮罩：盖住冷加载空窗与背景切换；pointer-events:none 让连滑穿透以排队。 */}
        {authUser && !djModeOpen ? (
          <div className={`avatar-switch-overlay${switching ? ' is-active' : ''}`} aria-hidden={!switching}>
            <div className="avatar-switch-spinner" />
            {switchTargetName ? <div className="avatar-switch-name">切换到 {switchTargetName}</div> : null}
          </div>
        ) : null}
      </section>

      <section className="chat-panel">
        <div
          className={`messages${messagesFaded ? ' messages--faded' : ''}`}
          ref={messagesEndRef}
          onClick={() => {
            setRevealNonce((n) => n + 1);
            if (composerPanelOpen) setComposerPanelOpen(false);
          }}
        >
          {messages.length === 0 ? (
            <EmptyState />
          ) : (
            // 主画面只留最新 2 条；完整历史进「聊天记录」页
            messages.slice(-2).map((message) => (
              <MessageBubble
                key={message.id}
                message={message}
                avatarName={selectedAvatar.name}
                playingVoiceId={playingVoiceId}
                onToggleVoice={handleToggleVoice}
                onPreviewImage={setPreviewImageUrl}
                onReplay={(text) => {
                  if (!ttsEnabled) return;
                  speakText({
                    text,
                    // 每角色音色覆盖，与正常播报保持一致。
                    settings: { ...ttsSettings, apiVoice: selectedAvatar.voice ?? ttsSettings.apiVoice },
                    onMouthChange: setMouthOpen,
                    avatarId: selectedAvatarId,
                  }).catch(console.error);
                }}

              />
            ))
          )}
        </div>

        <form ref={composerRef} className={`composer${composerExpanded ? ' composer--expanded' : ''}${composerPanelOpen ? ' composer--panel-open' : ''}`} onSubmit={onFormSubmit}>
          <button
            type="button"
            className="composer-call-btn"
            // 阻止抢焦点：键盘态点通话不应让 textarea 失焦收键盘（与表情按钮同理），
            // 选完语音/视频后才由 handler 统一收键盘进通话，过渡一步到位
            onMouseDown={(e) => e.preventDefault()}
            onClick={ttsState !== 'idle' ? cancelTts : () => setCallMenuOpen((v) => !v)}
            aria-label={ttsState !== 'idle' ? '停止朗读' : '通话'}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.35 1.9.66 2.81a2 2 0 0 1-.45 2.11L8.05 9.91a16 16 0 0 0 6.04 6.04l1.27-1.27a2 2 0 0 1 2.11-.45c.91.31 1.85.53 2.81.66A2 2 0 0 1 22 16.92Z" />
            </svg>
          </button>
          {/* 通话方式弹出面板：锚在电话键正上方（与 + 号面板同款交互），取代旧全屏底部弹层 */}
          <CallModePopover
            open={callMenuOpen}
            onVoice={handleStartVoiceCall}
            onVideo={handleStartVideoCall}
            onClose={() => setCallMenuOpen(false)}
          />
          {/* 白色圆角输入框：即使 composer 背景在面板态变深，输入框仍是独立白色浮层 */}
          <div className="composer-input-box">
            {pendingImage && (
              <div className="composer-pending-image">
                <img src={pendingImage.dataUrl} alt="待发送图片" />
                <button
                  type="button"
                  className="composer-pending-remove"
                  onClick={() => setPendingImage(null)}
                  aria-label="移除图片"
                >
                  ×
                </button>
              </div>
            )}
            <textarea
              ref={inputRef}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={handleComposerKeyDown}
              // 录音/通话期间置只读：Android WebView 的光标插入手柄（青绿色水滴）是原生弹层，
              // 不随 blur()/opacity/display:none 消失——只读让 WebView 撤掉可编辑选区，手柄随之清除。
              readOnly={recActive || callOpen}
              onClick={() => {
                if (composerPanelOpen) {
                  closePanelAndFocusInput();
                } else if (stickerPanelOpen) {
                  closeStickerAndFocusInput();
                } else {
                  focusInput();
                }
              }}
              onFocus={() => setComposerExpanded(true)}
              onBlur={() => {
                if (openingStickerRef.current) {
                  openingStickerRef.current = false;
                  return;
                }
                if (openingPanelRef.current) {
                  openingPanelRef.current = false;
                  setComposerExpanded(false);
                  return;
                }
                setComposerExpanded(false);
                // 用户点输入框外收键盘：立刻开始下滑，不等 willHide/ime 事件（慢半拍）
                hideGlideRef.current?.();
              }}
              inputMode="text"
              placeholder={isMobile ? '点击输入 · 长按说话' : '点击输入...'}
              rows={4}
              // 移动端禁用文字选区：否则系统长按会选中输入框内容、抢走长按手势导致进不了录音。
              style={isMobile ? { WebkitUserSelect: 'none', userSelect: 'none', WebkitTouchCallout: 'none' } : undefined}
              onTouchStart={handleTextareaTouchStart}
              onTouchMove={handleTextareaTouchMove}
              onTouchEnd={handleTextareaTouchEnd}
              onTouchCancel={handleTextareaTouchCancel}
              onContextMenu={(event) => { if (isMobile) event.preventDefault(); }}
            />
          </div>

          {/* 表情按钮：打开 sticker 面板（含系统 emoji + sticker 梗图）。
              面板打开时变键盘图标（微信联动）：点它回键盘，面板保持挂载至键盘盖住。 */}
          <button
            type="button"
            className="composer-emoji-btn"
            // 阻止抢焦点：面板态点表情不应让 textarea 失焦收起
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              if (stickerPanelOpen) {
                closeStickerAndFocusInput();
                return;
              }
              if (composerPanelOpen) setComposerPanelOpen(false);
              // 从键盘展开态直接进表情包面板：先标记再 blur，避免 onBlur 把 composer 收起来
              // 清掉未完成的延迟关闭：快速连打时 500ms 兜底定时器会把刚重开的面板误关
              pendingStickerCloseRef.current = false;
              if (stickerCloseTimerRef.current) window.clearTimeout(stickerCloseTimerRef.current);
              openingStickerRef.current = true;
              setStickerPanelOpen(true);
              inputRef.current?.blur();
              if (Capacitor.isNativePlatform()) {
                try {
                  void Keyboard.hide();
                } catch {
                  // Web 或不支持时忽略
                }
              }
            }}
            aria-label={stickerPanelOpen ? '键盘' : '表情'}
          >
            {stickerPanelOpen ? (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <rect x="3" y="6" width="18" height="12" rx="2" />
                <path d="M7 10h.01M12 10h.01M17 10h.01M7 14h.01M17 14h.01M10 14h4" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path
                  fillRule="evenodd"
                  clipRule="evenodd"
                  d="M12 3a9 9 0 100 18 9 9 0 000-18zM8.5 9a1.4 1.4 0 100 2.8 1.4 1.4 0 000-2.8zm7 0a1.4 1.4 0 100 2.8 1.4 1.4 0 000-2.8zM7.5 14a4.6 4.6 0 009 0H7.5z"
                />
              </svg>
            )}
          </button>

          {/* +/发送 切换：占同一最右槽位。有文字 → 黄色发送图标；否则 → +（开附件面板）。
              朗读中不占槽：停止朗读走最左通话键（双态）。 */}
          {input.trim() ? (
            <button
              type="submit"
              className="send-btn has-content"
              aria-label="发送"
              onMouseDown={(event) => {
                // 有文字时阻止按钮抢焦点：发送后 textarea 保持聚焦、键盘不收，可接着打字。
                if (isMobile && input.trim()) event.preventDefault();
              }}
            >
              <svg viewBox="0 0 14 14" fill="none" aria-hidden="true">
                <path
                  d="M12.0397 0.686113C12.8305 0.409326 13.5907 1.1695 13.3139 1.96032L9.58325 12.6193C9.28406 13.4741 8.09342 13.5227 7.72558 12.6951L5.90621 8.60147C5.80566 8.37523 5.62477 8.19434 5.39853 8.09379L1.30494 6.27442C0.477311 5.90658 0.525886 4.71594 1.38072 4.41675L12.0397 0.686113Z"
                  fill="#131921"
                />
              </svg>
            </button>
          ) : (
            <button
              type="button"
              className="composer-plus-btn"
              // 阻止按钮抢焦点：否则展开态点 + 会让 textarea 失焦(onBlur→collapse)，输入框收起
              onMouseDown={(e) => e.preventDefault()}
              onClick={(event) => {
                event.stopPropagation();
                if (stickerPanelOpen) {
                  // 表情包 → 加号面板：同槽位瞬时互换，不涉及键盘
                  setStickerPanelOpen(false);
                  setComposerPanelOpen(true);
                  return;
                }
                if (composerPanelOpen) {
                  // 面板态 → 关闭面板并唤起键盘（等价于取消面板）
                  closePanelAndFocusInput();
                } else {
                  // 键盘态/收起态 → 收起键盘并打开面板
                  openingPanelRef.current = true; // 主动 blur：onBlur 里不做提前下滑
                  inputRef.current?.blur();
                  if (Capacitor.isNativePlatform()) {
                    try {
                      void Keyboard.hide();
                    } catch {
                      // Web 或不支持时忽略
                    }
                  }
                  // 取消待处理的面板延迟关闭，避免重开面板被 500ms 兜底定时器误关
                  pendingPanelCloseRef.current = false;
                  if (panelCloseTimerRef.current) window.clearTimeout(panelCloseTimerRef.current);
                  setComposerPanelOpen(true);
                }
              }}
              aria-label="更多"
            >
              {/* 面状填充加号（两条圆角实心条），与发送/表情的填充图标风格一致 */}
              <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <rect x="10.5" y="4" width="3" height="16" rx="1.5" />
                <rect x="4" y="10.5" width="16" height="3" rx="1.5" />
              </svg>
            </button>
          )}

          {/* 附件面板 + 隐藏 file input：fixed 定位（面板态）/常挂（相册降级），不参与输入栏平铺 */}
          <ChatComposerPanel
            open={composerPanelOpen}
            onClose={() => setComposerPanelOpen(false)}
            onPickImage={handlePickImage}
            autoHideChat={autoHideChat}
            onToggleAutoHide={handleToggleAutoHide}
          />
        </form>

        <ImagePreviewModal url={previewImageUrl} onClose={() => setPreviewImageUrl(null)} />
      </section>

      {/* Mobile floating action buttons — hidden on desktop */}
      <div className="mobile-floating-actions">
        <div className="mobile-home-actions">
          <button
            type="button"
            className="mobile-home-chip mobile-chip-profile"
            onClick={() => setProfileOpen(true)}
            aria-label="个人主页"
          >
            <span className="mobile-chip-avatar">
              {authUser?.avatar?.startsWith('data:')
                ? <img className="mobile-chip-avatar-img" src={authUser.avatar} alt="头像" />
                : (authUser?.avatar || '🙂')}
            </span>
            {hasUnread && <span className="touch-unread-dot" />}
          </button>
          <button
            type="button"
            className="mobile-home-chip mobile-chip-badge"
            onClick={() => setBadgePanelOpen(true)}
            title="吧唧素材工坊"
            aria-label="吧唧素材工坊"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="10" r="7" />
              <path d="M8.5 20.5 12 17l3.5 3.5" />
            </svg>
          </button>
          {Capacitor.isNativePlatform() ? (
            <button
              type="button"
              className="mobile-home-chip mobile-chip-screensaver"
              onClick={() => setScreensaverOpen(true)}
              title="充电屏保"
              aria-label="充电屏保设置"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z" />
              </svg>
            </button>
          ) : null}
          {Capacitor.isNativePlatform() ? (
            <button
              type="button"
              className="mobile-home-chip mobile-chip-pet"
              onClick={() => { if (!petLongPressed.current) void togglePet(); }}
              onPointerDown={() => {
                petLongPressed.current = false;
                petPressTimer.current = window.setTimeout(() => {
                  petLongPressed.current = true;
                  setPetSettingsOpen(true);
                }, 500);
              }}
              onPointerUp={() => { if (petPressTimer.current != null) { clearTimeout(petPressTimer.current); petPressTimer.current = null; } }}
              onPointerLeave={() => { if (petPressTimer.current != null) { clearTimeout(petPressTimer.current); petPressTimer.current = null; } }}
              title={petRunning ? '关闭桌宠（长按设置）' : '开启桌宠（长按设置）'}
              aria-label="桌宠浮窗"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="9" r="5" />
                <path d="M5 21v-1a5 5 0 0 1 5-5h4a5 5 0 0 1 5 5v1" />
              </svg>
            </button>
          ) : null}
        </div>
        <PetSettingsModal
          open={petSettingsOpen}
          onClose={() => setPetSettingsOpen(false)}
          onChange={() => { void restartPetWithSettings(); }}
        />
        <button
          type="button"
          className="mobile-float-btn mobile-float-profile"
          onClick={() => setProfileOpen(true)}
          title="Profile"
          aria-label="Profile"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
            <circle cx="12" cy="7" r="4" />
          </svg>
        </button>
        {debugMode ? (
          <button
            type="button"
            className="mobile-float-btn mobile-float-bg"
            onClick={() => setBgPanelOpen(true)}
            title="背景设置"
            aria-label="AI background"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <polyline points="21 15 16 10 5 21" />
            </svg>
          </button>
        ) : null}
        <button
          type="button"
          className="mobile-float-btn mobile-float-diary"
          onClick={() => setDiaryOpen(true)}
          title="日志"
          aria-label="Open diary"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="20" height="20">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="16" y1="13" x2="8" y2="13" />
            <line x1="16" y1="17" x2="8" y2="17" />
            <polyline points="10 9 9 9 8 9" />
          </svg>
        </button>
        <button
          type="button"
          className="mobile-float-btn mobile-float-history"
          onClick={() => {
            // 进聊天记录前关掉加号/表情面板，避免浮层下残留
            if (composerPanelOpen) setComposerPanelOpen(false);
            if (stickerPanelOpen) setStickerPanelOpen(false);
            setChatHistoryOpen(true);
          }}
          title="聊天记录"
          aria-label="Open chat history"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="20" height="20">
            <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
          </svg>
        </button>
        <button
          type="button"
          className="mobile-float-btn mobile-float-dj"
          onClick={() => setDjModeOpen(true)}
          title="电台"
          aria-label="DJ 电台"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 14v-2a9 9 0 0 1 18 0v2" />
            <rect x="2.5" y="14" width="5" height="7" rx="1.6" />
            <rect x="16.5" y="14" width="5" height="7" rx="1.6" />
          </svg>
        </button>
        <button
          type="button"
          className={`mobile-float-btn mobile-float-tts ${ttsEnabled ? 'is-active' : ''}`}
          onClick={handleTtsButtonClick}
          onPointerDown={handleTtsLongPressStart}
          onPointerUp={handleTtsLongPressCancel}
          onPointerLeave={handleTtsLongPressCancel}
          onPointerCancel={handleTtsLongPressCancel}
          onContextMenu={(event) => event.preventDefault()}
          title={ttsEnabled ? '关闭语音播报' : '打开语音播报'}
          aria-label={ttsEnabled ? '关闭语音播报' : '打开语音播报'}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            {ttsEnabled ? (
              <>
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
              </>
            ) : (
              <>
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                <line x1="23" y1="9" x2="17" y2="15" />
                <line x1="17" y1="9" x2="23" y2="15" />
              </>
            )}
          </svg>
        </button>
        {debugMode ? (
          <button
            type="button"
            className="mobile-float-btn mobile-float-debug"
            onClick={() => {
              setControlDrawerScrollToDebug(true);
              setControlDrawerOpen(true);
            }}
            title="模型调试"
            aria-label="模型调试"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <line x1="22" y1="12" x2="18" y2="12" />
              <line x1="6" y1="12" x2="2" y2="12" />
              <line x1="12" y1="6" x2="12" y2="2" />
              <line x1="12" y1="22" x2="12" y2="18" />
            </svg>
          </button>
        ) : null}
        {debugMode && import.meta.env.DEV ? (
          <button
            type="button"
            className="mobile-float-btn mobile-float-debug"
            onClick={() => setEndingDemoOpen(true)}
            title="结局预览"
            aria-label="结局预览"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="5 3 19 12 5 21 5 3" />
            </svg>
          </button>
        ) : null}
      </div>

      {/* 模型调试/抓取参数抽屉：渲染在顶层，脱离 viewer-panel 的 stacking 上下文，
          否则被 chat-panel(z:5) 压住导致内容可见但不可点（移动端长按喇叭呼出）。 */}
      {isMobile ? (
        <ControlDrawer
          open={controlDrawerOpen}
          onToggle={() => setControlDrawerOpen((c) => !c)}
          selectedAvatarId={selectedAvatarId}
          onAvatarChange={handleAvatarChange}
          visibleExpressions={visibleExpressions}
          activeExpressionKeys={activeExpressionKeys}
          onExpressionClick={(key) => presence.applyEmotion({ expressionMix: [{ key, weight: 1 }] })}
          parameterControls={selectedAvatar.parameterControls}
          activeParameterMap={activeParameterMap}
          mouthSyncState={mouthSyncState}
          paramOverridesCount={stageParameterOverrides.length}
          discoveryResults={parameterDiscoveryResults}
          discoveryRunning={parameterDiscoveryRunning}
          discoveryStatus={parameterDiscoveryStatus}
          onDiscoverParameters={handleDiscoverParameters}
          onParameterCall={handleParameterCall}
          scrollToParameterDebug={controlDrawerScrollToDebug}
        />
      ) : null}

      {settingsOpen ? (
        <SettingsModal
          llmSettings={llmSettings}
          ttsSettings={ttsSettings}
          callSettings={callSettings}
          browserVoices={browserVoices}
          onClose={handleCloseSettings}
          onSave={handleSaveLlmSettings}
          onReset={resetSettings}
          onUpdateLlm={updateLlmSettings}
          onUpdateTts={updateTtsSettings}
          onUpdateCall={updateCallSettings}
          bubbleStyle={bubbleStyle}
          onUpdateBubbleStyle={(s) => { setBubbleStyle(s); saveBubbleStyle(s); }}
          debugMode={debugMode}
          onDebugModeChange={setDebugMode}
          sensorEnabled={sensorEnabled}
          onSensorEnabledChange={(v) => { setSensorEnabled(v); saveSensorEnabled(v); }}
        />
      ) : null}
      <CallOverlay
        open={callOpen}
        mode={callMode}
        avatarName={selectedAvatar.name}
        avatarId={selectedAvatarId}
        voice={loadCharacterSettings(selectedAvatarId)?.callVoice || selectedAvatar.voice || undefined}
        systemMessage={callMode === 'video' ? buildVideoCallSystemPrompt(selectedAvatar) : buildVoiceCallSystemPrompt(selectedAvatar)}
        callSettings={callSettings}
        // 通话接入演出引擎：她的声音驱动口型（与聊天播报同一出口）；定稿字幕判情绪驱动表情/动作。
        onBotAudioLevel={setMouthOpen}
        onBotUtterance={performCallUtterance}
        onClose={() => setCallOpen(false)}
      />
      <TouchBanner
        event={bannerEvent}
        avatarName={bannerEvent ? (getAvatarById(bannerEvent.avatarId)?.name ?? '') : ''}
        avatarThumb={bannerEvent ? resolveCallAvatarView(getAvatarById(bannerEvent.avatarId), bannerEvent).portraitUrl : null}
        onTap={handleBannerTap}
        onDismiss={clearBanner}
      />
      {callEvent?.mode === 'inplace' ? (
        <InlineCallPrompt
          event={callEvent}
          onAccept={handleInplaceAccept}
          onDecline={handleCallDecline}
          onTimeout={handleCallTimeout}
        />
      ) : null}
      {callEvent?.mode === 'fullscreen' ? (
        <IncomingCallScreen
          event={callEvent}
          onAccept={handleFullscreenAccept}
          onDecline={handleCallDecline}
          onTimeout={handleCallTimeout}
        />
      ) : null}
      <DiaryPage
        open={diaryOpen}
        selectedAvatarId={selectedAvatarId}
        onClose={() => setDiaryOpen(false)}
        onTriggerGenerate={onDiaryTriggerGenerate}
      />
      <ChatHistoryPage
        open={chatHistoryOpen}
        avatarName={selectedAvatar.name}
        messages={messages}
        playingVoiceId={playingVoiceId}
        onClose={() => setChatHistoryOpen(false)}
        onToggleVoice={handleToggleVoice}
        onPreviewImage={setPreviewImageUrl}
      />
      {settingsAvatar !== undefined ? (
        <CharacterSettingsModal
          open
          avatar={settingsAvatar}
          onClose={() => setSettingsAvatarId(null)}
          onSave={() => {}}
        />
      ) : null}
      {bgPanelOpen ? (
        <div className="settings-modal-backdrop bg-modal-backdrop" onClick={() => setBgPanelOpen(false)}>
          <div className="settings-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 480 }}>
            <div className="settings-modal-header">
              <h2>背景设置</h2>
              <button type="button" className="settings-close" onClick={() => setBgPanelOpen(false)}>
                关闭
              </button>
            </div>
            <BackgroundPanel
              avatarId={selectedAvatarId}
              avatarName={selectedAvatar.name}
              currentBg={activeBg}
              onApply={(url) => { setActiveBg(url); saveBackground(selectedAvatarId, { url, prompt: '', timestamp: Date.now() }); }}
              onRemove={() => { setActiveBg(null); }}
            />
          </div>
        </div>
      ) : null}
      {authUser ? (
        <ProfilePage
          open={profileOpen}
          user={authUser}
          onClose={() => setProfileOpen(false)}
          onLogout={handleLogout}
          onUserUpdate={setAuthUser}
          diaryCount={diaryCount}
          favTotal={favTotal}
        />
      ) : null}
      </div>
      {preAuth ? <LoginPage onLogin={handleLogin} showCharacter={false} /> : null}
      {/* DJ 电台 chrome 覆盖层：角色由上方共享 Stage 渲染。就绪前透明(露出主页角色覆盖切换空档)，就绪后淡入。 */}
      {authUser && djModeOpen && !isHoloSurface ? <DjMode view={djView} /> : null}
      {badgePanelOpen ? <BadgePanel onClose={() => setBadgePanelOpen(false)} /> : null}
      {screensaverOpen ? <ScreensaverModal onClose={() => setScreensaverOpen(false)} /> : null}

      <BirthdayGateModal
        open={birthdayGateOpen}
        mandatory={needsBirthday}
        title="确认你的年龄"
        subtitle={needsBirthday
          ? '本应用仅向年满 18 周岁的用户开放，请填写真实出生日期后进入。'
          : '剧情旅程与主动演出仅向年满 18 周岁的用户开放，请填写出生日期。'}
        initial={authUser?.birth_date}
        onClose={() => setBirthdayGateOpen(false)}
        onSaved={(u) => {
          setAuthUser(u);
          setBirthdayGateOpen(false);
          tryStartJourney(selectedAvatarId);
        }}
      />

      {import.meta.env.DEV && DEMO_ENDING ? (
        <EndingScene
          open={endingDemoOpen}
          avatar={selectedAvatar}
          ending={DEMO_ENDING}
          musicUrl={null}
          onClose={() => setEndingDemoOpen(false)}
        />
      ) : null}

      <StickerPanel
        open={stickerPanelOpen}
        onClose={() => setStickerPanelOpen(false)}
        onEmoji={(emoji) => {
          handleInsertEmoji(emoji);
          setStickerPanelOpen(false);
          window.setTimeout(() => focusInput(), 0);
        }}
        onSendSticker={(sticker) => {
          // 微信式：发完表情面板保持打开可连发，不回焦输入框（避免键盘整个升起打断）
          handleSendSticker(sticker);
        }}
      />
      {/* 电影级事件演出：换挡卡（有待播且未进入）+ 全屏条漫播放器 */}
      {authUser && cutscene.pending && !cutscene.playing ? (
        <button type="button" className="cutscene-entry-card" onClick={cutscene.open}>
          <span className="cutscene-entry-card__title">昨晚，关于你和 TA 的一件事…</span>
          <span className="cutscene-entry-card__cta">▶ 进入</span>
        </button>
      ) : null}
      {cutscene.playing && cutscene.pending ? (
        <CutsceneScene
          storyboard={cutscene.pending.storyboard}
          bgmUrl={cutscene.pending.bgmUrl}
          avatarId={selectedAvatarId}
          onComplete={handleCutsceneComplete}
        />
      ) : null}
      {/* 旅程任务卡（ALL-371）：有派发中的任务且未在播演出时浮层展示，提交后由 hook 推进剧情。 */}
      {authUser && journeyTask.task && !cutscene.playing ? (
        <div className="fixed left-1/2 -translate-x-1/2 bottom-24 z-40 w-[min(92vw,28rem)]">
          <JourneyTaskCard task={journeyTask.task} onComplete={journeyTask.submit} />
        </div>
      ) : null}
      {/* 全息屏横屏仪表盘：仅 holo 页(data-holo)登录后渲染；移动端主客户端从不渲染。 */}
      {isHoloSurface && authUser ? (
        <HoloDashboard
          djMode={djView.mode}
          onSetDjMode={djView.setMode}
          nowTitle={djView.dj.playing?.title ?? null}
          nowArtist={djView.dj.playing?.artist ?? null}
          nowCover={djView.dj.playing?.pic_url ?? null}
          ncmId={djView.dj.playing?.ncm_id ?? null}
          getPositionMs={djView.dj.controls.getPositionMs}
          getDurationMs={djView.dj.controls.getDurationMs}
          playing={!!djView.dj.playing && !djView.dj.paused}
          analyser={djView.dj.musicAnalyser}
          pomodoroWorkMinutes={djView.pomodoroMin}
          onPomodoroAlarm={() => {
            // v1 逃生门无 Stackchan 摸头通道：只口播，闹钟相位靠 120s 兜底自动进休息。
            if (!ttsEnabled) return;
            speakText({
              text: '这一轮专注结束啦，先歇一会儿～起来喝口水、走两步、远眺一下',
              settings: { ...ttsSettings, apiVoice: selectedAvatar.voice ?? ttsSettings.apiVoice },
              onMouthChange: setMouthOpen,
              avatarId: selectedAvatarId,
            }).catch(console.error);
          }}
        />
      ) : null}
    </div>
  );
}
