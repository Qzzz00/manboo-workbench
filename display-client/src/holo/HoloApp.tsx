/**
 * 全息屏独立前端根（重构 P1）：不再寄生手机 App.tsx。直接组合共享底层库
 * （useDjMode / usePresence / useChat / useHoloVoice / Live2DStage）搭出「电台角色 + 仪表盘 + 语音」，
 * 蜕掉手机端的聊天列表/日志/抽屉/通话/吧唧/屏保/桌宠。手机 App.tsx 原样不动、零回归。
 *
 * 目前经 holo/main.tsx 的 ?app=v2 开关启用（默认仍走稳定的 App 版 holo），验收通过后翻默认。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { HoloDashboard, type PomodoroCommand } from './HoloDashboard.tsx';
import { HoloStage } from './HoloStage.tsx';
import { useHoloVoice } from './useHoloVoice.ts';
import { useHoloControlBus } from './useHoloControlBus.ts';
import { holoEventToIntent, playbackIntent, type HoloBridgeEvent } from './holoIntent.ts';
import { resolveHoloPair } from './holoPair.ts';
import { pickHoloAvatarId, resolveHoloAvatarId } from './holoStage.ts';
import { ParticleAvatar } from '../display/ParticleAvatar.tsx';
import { defaultSettings } from '../display/appearanceFeed.ts';
import { displayOrbSettings } from '../display/displayStage.ts';
import { getServerBaseUrl } from '../screensaver/lib/serverConfig.ts';
import { useDjMode } from '../hooks/useDjMode.ts';
import { useChat } from '../hooks/useChat.ts';
import { usePresence } from '../features/live2d/presence/usePresence.ts';
import { useSettings } from '../features/settings/useSettings.ts';
import {
  NO_AVATAR,
  avatarList,
  getAvatarById,
  getAvatarNeutralExpressionId,
  useAvatarList,
  type AvatarManifest,
} from '../features/live2d/avatarManifest.ts';
import type { ChatMessage } from '../lib/llm.ts';
import { autoLogin, type UserInfo } from '../lib/authStore.ts';
import { setAuthErrorHandler } from '../lib/apiClient.ts';
import { loadLastAvatarId, saveLastAvatarId } from '../lib/lastAvatarStore.ts';
import { loadChatMessages } from '../lib/chatMedia.ts';
import { speakText } from '../lib/tts.ts';
import { LoginPage } from '../components/LoginPage.tsx';
import { loadHoloTheme, saveHoloTheme, toggleTheme, type HoloTheme } from './holoTheme.ts';
import { setNativeClearColor } from '../features/live2d/nativeStage.ts';

/** 没有形象时舞台上那颗粒子球的参数(全息屏不连工作台,用核心默认值)。 */
const NO_AVATAR_ORB = displayOrbSettings(defaultSettings());

/** ''= 这台机器上一个形象都没有(仓库不带模型,10-21):舞台画粒子球。 */
function initialAvatarId(): string {
  // ?avatar=<id> 优先于本地「上次所在角色」：宿主选定的模型不该被上一轮手动切换的记忆盖掉。
  return pickHoloAvatarId({
    forced: resolveHoloAvatarId(window.location.search),
    last: loadLastAvatarId(),
    known: (id) => getAvatarById(id) !== undefined,
    first: avatarList[0]?.id,
  }) ?? '';
}

export default function HoloApp() {
  const [authUser, setAuthUser] = useState<UserInfo | null>(null);
  const [authChecking, setAuthChecking] = useState(true);
  const [selectedAvatarId, setSelectedAvatarId] = useState(initialAvatarId);
  const [selectedAvatar, setSelectedAvatar] = useState<AvatarManifest>(() => getAvatarById(initialAvatarId()) ?? NO_AVATAR);
  const [messagesByAvatar, setMessagesByAvatar] = useState<Record<string, ChatMessage[]>>({});
  const messages = messagesByAvatar[selectedAvatarId] || [];
  const setMessages = useCallback(
    (updater: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])) => {
      setMessagesByAvatar((prev) => {
        const cur = prev[selectedAvatarId] || [];
        const next = typeof updater === 'function' ? updater(cur) : updater;
        return { ...prev, [selectedAvatarId]: next };
      });
    },
    [selectedAvatarId],
  );

  const [, setMouthOpen] = useState(0); // 提醒/回应 TTS 的口型 sink（holo 舞台口型由 djView 独占，见重构注记）

  // 昼夜主题：day=白底黑字+DJ 换装；night=黑底白字+初始/外套。双击角色切换，持久化重启保留。
  const [theme, setTheme] = useState<HoloTheme>(loadHoloTheme);
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'night') root.setAttribute('data-holo-theme', 'night');
    else root.removeAttribute('data-holo-theme');
    // 原生渲染时 DOM 底色整面透明（否则盖死 GL 层的角色，见 holo.css），昼夜底色改由
    // GL 清屏色承担。非原生路径无 active 模型，这里只是记下值，不产生任何副作用。
    setNativeClearColor(theme === 'night' ? '#000000' : '#ffffff');
  }, [theme]);
  const toggleHoloTheme = useCallback(() => {
    setTheme((t) => {
      const next = toggleTheme(t);
      saveHoloTheme(next);
      return next;
    });
  }, []);

  const { ttsSettings, ttsEnabled } = useSettings();
  const { presence, composed } = usePresence(getAvatarNeutralExpressionId(selectedAvatar));

  // 自动登录（+ 401 掉登录）。
  useEffect(() => {
    autoLogin()
      .then((u) => { if (u) setAuthUser(u); })
      .catch((e) => console.error('[holo] autoLogin failed', e))
      .finally(() => setAuthChecking(false));
    setAuthErrorHandler(() => setAuthUser(null));
  }, []);

  // 登录后拉最近聊天历史（给 useChat 的 LLM 上下文，保证语音对话跨次连续）。
  useEffect(() => {
    if (!authUser) return;
    void loadChatMessages(selectedAvatarId)
      .then((msgs) => setMessagesByAvatar((prev) => ({ ...prev, [selectedAvatarId]: msgs })))
      .catch(() => { /* 拉不到就空 */ });
  }, [authUser, selectedAvatarId]);

  // DJ 电台引擎：登录后自动进（holo 恒电台，enableMusicAnalyser 出真频谱）。
  const djView = useDjMode({
    open: !!authUser,
    sourceAvatarId: selectedAvatarId,
    onClosed: () => { /* holo 不退出 DJ */ },
    enableMusicAnalyser: true,
  });

  // handleSubmit 与 dispatch 互相引用（onControl→dispatch；dispatch.onChat→handleSubmit），用 ref 破环。
  const handleSubmitRef = useRef<((text: string) => void) | null>(null);

  // 番茄命令信号：摸头 ack / 语音暂停·继续·改时长。seq 递增,组件消费一次。
  const [pomodoroCmd, setPomodoroCmd] = useState<PomodoroCommand>({ seq: 0, action: 'ack' });
  const firePomodoroCmd = useCallback((action: PomodoroCommand['action'], minutes?: number) => {
    setPomodoroCmd((s) => ({ seq: s.seq + 1, action, minutes }));
  }, []);

  // 控制总线：语音/Stackchan 隔空手势/摸头 → 执行到 djView / 音量 / 番茄 / 对话。
  const dispatch = useHoloControlBus({
    djView,
    onVolumeDelta: (delta) => {
      const c = djView.dj.controls;
      c.setVolume(c.getVolume() + delta);
    },
    onVolumeSet: (v) => djView.dj.controls.setVolume(v),
    onChat: (text) => handleSubmitRef.current?.(text),
    onPomodoroAck: () => firePomodoroCmd('ack'),
    onPomodoroPause: () => firePomodoroCmd('pause'),
    onPomodoroResume: () => firePomodoroCmd('resume'),
    onPomodoroSetMinutes: (m) => {
      djView.setPomodoroMin(m); // 持久化(DJ 配置链路:服务端+localStorage),下轮起 prop 生效
      firePomodoroCmd('set', m); // 当前轮立即按新时长重开
    },
  });

  // 聊天管线：语音文本 → LLM（判 control + 回应）→ TTS。holo 恒 idle、无设置弹窗。
  const { isSending, ttsState, handleSubmit } = useChat({
    selectedAvatar,
    selectedAvatarId,
    ttsSettings,
    ttsEnabled,
    messages,
    setMessages,
    presence,
    setMotionName: () => { /* holo 恒 idle */ },
    setMouthOpen,
    openSettings: () => { /* holo 无设置弹窗 */ },
    holoControl: true,
    onControl: (c) => dispatch(playbackIntent(c)),
  });
  handleSubmitRef.current = handleSubmit;

  // 语音输入：登录后开麦；我方 TTS 说话/回合进行中时门控收音（避免自问自答）。
  useHoloVoice({
    enabled: !!authUser,
    muted: isSending || ttsState !== 'idle',
    onUtterance: (text) => { void handleSubmit(text); },
    onError: (err) => console.warn('[holo-voice]', err),
  });

  // Stackchan 配对码：URL ?pair= 优先，瘦终端本机(127.0.0.1)默认 ben1（零参数可用）。
  const pair = resolveHoloPair(window.location.search, window.location.hostname);

  const speakLine = useCallback((text: string) => {
    if (!ttsEnabled) return;
    speakText({
      text,
      settings: { ...ttsSettings, apiVoice: selectedAvatar.voice ?? ttsSettings.apiVoice },
      onMouthChange: setMouthOpen,
      avatarId: selectedAvatarId,
    }).catch(console.error);
  }, [ttsEnabled, ttsSettings, selectedAvatar, selectedAvatarId, setMouthOpen]);

  // 向 Stackchan 发命令(带一次重试:命令槽是内存的,后端恰好重启会丢)。
  const postStackchanCmd = useCallback((cmd: string) => {
    if (!pair) return;
    const base = getServerBaseUrl().replace(/\/+$/, '');
    const doPost = () =>
      fetch(`${base}/api/holo/cmd?pair=${encodeURIComponent(pair)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cmd }),
      });
    doPost().catch(() => { setTimeout(() => { doPost().catch(() => { /* alarm 兜底靠120s自动休息 */ }); }, 3000); });
  }, [pair]);
  const postAlarmCmd = useCallback(() => postStackchanCmd('alarm'), [postStackchanCmd]);

  // 专注结束 → 口播 + 令 Stackchan 进闹钟(摇头到摸头)。桥不在也不影响本地口播。
  const onPomodoroAlarm = useCallback(() => {
    postAlarmCmd();
    speakLine('这一轮专注结束啦！去摸摸小机器人的头，然后歇 10 分钟～');
  }, [postAlarmCmd, speakLine]);

  // 闹钟相位每20s补发一次命令(不重复口播):防首发恰逢后端重启被抹/设备正忙错过。
  const onPomodoroAlarmAgain = useCallback(() => {
    postAlarmCmd();
  }, [postAlarmCmd]);

  // 休息结束回专注 → 开工口播 + Stackchan 点点头。
  const onPomodoroWorkStart = useCallback(() => {
    postStackchanCmd('nod');
    speakLine('休息结束，开始新一轮专注吧，加油！');
  }, [postStackchanCmd, speakLine]);

  // 键盘 ↑↓←→ 切角色（瘦终端/大屏无触摸，滑动切角色在 holo 关闭）。
  const drawerAvatars = useAvatarList();
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (drawerAvatars.length < 2) return;
      const idx = drawerAvatars.findIndex((a) => a.id === selectedAvatarId);
      if (idx < 0) return;
      const len = drawerAvatars.length;
      let nextIdx = idx;
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') nextIdx = (idx + 1) % len;
      else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') nextIdx = (idx - 1 + len) % len;
      else return;
      const a = drawerAvatars[nextIdx];
      setSelectedAvatarId(a.id);
      setSelectedAvatar(getAvatarById(a.id) ?? NO_AVATAR);
      saveLastAvatarId(a.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawerAvatars, selectedAvatarId]);

  // Stackchan 输入（经阿里云后端中转的统一事件流）：手势 + 语音转写(utterance)一条管道。
  // gesture → 查表意图；utterance → chat 意图 → handleSubmit（既有 LLM 大脑判控制/闲聊 + TTS 回应）。
  // 无 pair 不轮询（普通用户零开销）。演示用轮询;以后要低延迟再换 SSE。
  useEffect(() => {
    if (!authUser || !pair) return;
    const base = getServerBaseUrl().replace(/\/+$/, '');
    let since = 0;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const r = await fetch(`${base}/api/holo/events?pair=${encodeURIComponent(pair)}&since=${since}`);
        const d = (await r.json()) as { events?: Array<HoloBridgeEvent & { seq: number }>; latest?: number };
        if (typeof d.latest === 'number' && d.latest < since) since = d.latest; // 后端重启序号回卷→重新对齐
        for (const evt of d.events ?? []) {
          if (typeof evt.seq !== 'number' || evt.seq <= since) continue;
          since = evt.seq;
          const intent = holoEventToIntent(evt);
          if (intent) dispatch(intent);
        }
      } catch { /* 网络抖动忽略，下一轮再试 */ }
      if (alive) timer = setTimeout(poll, 300);
    };
    void poll();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [authUser, pair, dispatch]);

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

  return (
    <div className="device-frame">
      <div className="app-shell">
        <section className="viewer-panel" onDoubleClick={toggleHoloTheme}>
          {selectedAvatar === NO_AVATAR ? (
            <div className="dp-avatar">
              <ParticleAvatar mode="idle" notice="neutral" settings={NO_AVATAR_ORB} theme={theme === 'night' ? 'dark' : 'light'} />
            </div>
          ) : (
            <HoloStage
              avatar={selectedAvatar}
              presence={presence}
              costumeParamOverrides={composed.costumeParamOverrides}
              djView={djView}
              theme={theme}
            />
          )}
        </section>
        {authUser ? (
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
            onPomodoroAlarm={onPomodoroAlarm}
            onPomodoroAlarmAgain={onPomodoroAlarmAgain}
            onPomodoroWorkStart={onPomodoroWorkStart}
            pomodoroCommand={pomodoroCmd}
            onPlayPause={djView.dj.controls.playPause}
            onNext={djView.dj.controls.next}
            onPrev={djView.dj.controls.prev}
          />
        ) : (
          <LoginPage onLogin={(u: UserInfo) => setAuthUser(u)} showCharacter={false} />
        )}
      </div>
    </div>
  );
}
