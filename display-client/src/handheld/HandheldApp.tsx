// 掌机桌面根（Anbernic RG Rotate，720×720 方屏 → CSS 视口 480×480）。
// 两页：主页（角色占屏）左滑切出游戏格。独立于 App.tsx / RadioApp.tsx，无登录墙。
//
// ★只在主页挂 Live2DStage，切到游戏格时卸掉。掌机上两个原生 GL 同屏会争抢 GPU 导致
// 帧间隔抖动，而 Cubism 物理按 dt 演算、dt 一抖就失控（见记忆 native-sdk-only-rendering）。
// 这里虽然同时只有一个 Live2D，卸载仍有意义：游戏格是要频繁进出的页，不渲染就不耗电。
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { Live2DStage } from '../features/live2d/Live2DStage.tsx';
import { markNativeStageRevealed, parkNativeStage } from '../features/live2d/nativeStage.ts';
import { getAvatarById } from '../features/live2d/avatarData.ts';
import { setLive2DRendererPref } from '../lib/deviceTier.ts';
import type { ExpressionLayer, ParameterOverride } from '../features/live2d/types.ts';
import { getDefaultCallSettings } from '../lib/callSettingsStore.ts';
import { buildVoiceCallSystemPrompt } from '../lib/promptTemplate.ts';
import { CallOverlay } from '../components/CallOverlay.tsx';
import { HandheldWeather } from './HandheldWeather.tsx';
import { HandheldGameGrid } from './HandheldGameGrid.tsx';
import { HandheldSettings } from './HandheldSettings.tsx';
import Handheld from '../lib/handheldPlugin.ts';
import { startBottomStrip, stopBottomStrip, syncStripParams } from './handheldStrip.ts';
import { handheldAvatarFor } from './handheldAvatars.ts';
import { loadHandheldSettings } from './handheldSettingsStore.ts';
import {
  navigationForTrackedTouch,
  settingsClosePolicy,
  type HandheldNavigation,
  type HandheldPage,
  type HandheldSwipeSession,
  type SettingsOrigin,
} from './handheldNavigation.ts';
import {
  coverHomeScene,
  formatHandheldHomeTime,
  homeStageMountDelayMs,
  isHomeSceneCovered,
  markHomeSceneReady,
  openSettingsAfterHomePark,
  shouldMountHandheldHomeLive2D,
  type HomeSceneGate,
} from './handheldHomeLive2D.ts';
import './handheld.css';

// 桌面背景。Ben：「MP4 的背景就可以」——即电台 DJ 页那张。
// 原生路径下这张图由 GL 层画（Live2DStage 把 backgroundUrl 转成 setBackground），
// 不是 DOM 背景，所以不受 .hh-root 透明化影响。
const HOME_BG_URL = '/backgrounds/radio-dj-bg.png';

// 天气改由 HandheldWeather 组件按 IP 定位自取城市（Ben：城市按位置取，别用默认）。
// 旧的「写死深圳到 localStorage 让屏保 WeatherWidget 读」的做法已删——那本质就是个默认值。

// 渲染后端交给自动判定：掌机有原生插件 → 走 Cubism 原生（实测 59.4fps）。
// 显式设 'auto' 是为了清掉旧版 APK 可能写进 localStorage 的 'webview'
// （localStorage 跨安装持久，只改代码不清值会让掌机继续走 WebView）。
setLive2DRendererPref('auto');

// 掌机角色：三只可切换（双生 DJ / 幽灵狗 / 小白猫），清单与每只的构图、换装参数、
// 剪影都在 handheldAvatars.ts 这一份注册表里。主页大角色与底条小角色同步换
// （Ben 拍板「两处一起换」），但两处各用各的构图——三只比例迥异，共用一套必散架。

// 原生渲染目标帧率。★必须显式传：Live2DStage 默认 15，那是当年为 U1 Pro
// （0.99GHz 单核）定的地板，不传会把掌机也限死。掌机实测单帧仅 14ms，余量充足。
const HANDHELD_NATIVE_TARGET_FPS = 60;

// Live2DStage 的 expressionMix / parameterOverrides 是必填 props。桌面只做静态展示
// （不接 LLM、不接口型），给稳定的空数组即可。
// ★必须是模块级常量：写成字面量 [] 每次 render 都是新引用，会让 Stage 内的 effect 反复重跑。
const EMPTY_EXPRESSION_MIX: ExpressionLayer[] = [];
const EMPTY_PARAM_OVERRIDES: ParameterOverride[] = [];

// 方屏取景（每只一份，见 handheldAvatars.ts 的 homeTransform）：surface='home' 的自动取景
// 按手机竖屏画幅定，套到 480×480 方屏上不合适，那里存的是叠在自动取景之上的增量
// （offsetY 是 layoutHeight 的比例、正值下移）。
//
// ★换角色必须重标：offsetY 是加性的、scale 是乘性的，而三只「总高/脸高」比值不同。
// 标度参考（幽灵狗实测）：offsetY 每 0.07 ≈ 移动 120px @720 屏。
// ★别用「大 scale + 大 offsetY」硬怼：那是撞 computeModelLayout 的顶部钳制才成像，
// 换个模型立刻散架（电台侧踩过，见 RadioApp 的 DJ_PAGE_TRANSFORM 注释）。
// ★不要复用 djModels 的 transform：那套 {0.6275, 0, -1.15} 是给电台 DJ 页
// （surface='radio' 的胸部以上近景）调的，搬到方屏主页会把头顶到屏幕外面去
// ——真机实测正是这个症状（只看得见下巴到脚）。

/** 与 handheld.css 里 .hh-pages 的 transition 时长一致；改一处记得改另一处。 */
const PAGE_TRANSITION_MS = 260;
const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

function useMinuteClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 1000 * 30);
    return () => window.clearInterval(t);
  }, []);
  return now;
}

export default function HandheldApp() {
  const [page, setPage] = useState<HandheldPage>('home');
  // 设置面板：盖在主页之上（不占一个横页——横轨是给「首页↔游戏」那条主动线的，
  // 设置是偶尔进一次的东西，多一页会让左右滑动变得难预期）。
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsOrigin, setSettingsOrigin] = useState<SettingsOrigin>('home');
  const [callOpen, setCallOpen] = useState(false);
  // 选中角色：主页大角色与底条小角色同步换。写入在设置页，这里只读初值。
  const [avatarId, setAvatarId] = useState<string>(() => loadHandheldSettings().avatarId);
  const option = handheldAvatarFor(avatarId);
  // ★切页平移期间不能挂 Live2DStage。
  // 它挂载时按容器的屏幕位置算构图（computeLayoutFractions 吃 containerRect），
  // 而 260ms 的 translateX 动画途中量到的是「还在屏幕左边一整屏」的位置——
  // 真机实测下发 anchorXFrac=-0.5 / bottomYFrac=1.95（正常是 0.5 / 0.92），
  // 模型被摆到画外。症状极具迷惑性：日志里 model loaded + 60fps、背景（GL 清屏画的）
  // 也正常显示，唯独角色不见。translate 不触发 resize，所以它也不会自己纠正。
  const [stageMountable, setStageMountable] = useState(false);
  const [documentVisible, setDocumentVisible] = useState(() => document.visibilityState !== 'hidden');
  const [overlayStopped, setOverlayStopped] = useState(false);
  const [homeGate, setHomeGate] = useState<HomeSceneGate>({ requestId: 0, readyRequestId: -1 });
  const isFirstHomeVisit = useRef(true);
  const rootRef = useRef<HTMLDivElement>(null);
  const swipeStart = useRef<HandheldSwipeSession | null>(null);
  const suppressClickUntil = useRef(0);
  const coverHome = useCallback(() => {
    setHomeGate((gate) => coverHomeScene(gate));
  }, []);
  useEffect(() => {
    setStageMountable(false);
    if (page !== 'home' || !documentVisible) {
      return;
    }
    const t = window.setTimeout(
      () => setStageMountable(true),
      homeStageMountDelayMs(isFirstHomeVisit.current, PAGE_TRANSITION_MS),
    );
    isFirstHomeVisit.current = false;
    return () => clearTimeout(t);
  }, [page, documentVisible]);

  const stopOverlayBeforeHomeModel = useCallback(async () => {
    setOverlayStopped(false);
    try {
      // stop() 直到原生服务实际销毁浮窗才 resolve；此处不允许以「已经发出 stop 指令」
      // 代替「另一个 Cubism renderer 已离场」。
      await stopBottomStrip();
      setOverlayStopped(true);
    } catch {
      // 不能确认浮窗已退出时宁可主页暂不挂模型，也不能再制造双原生 renderer。
      setOverlayStopped(false);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    const syncVisibility = () => {
      const visible = document.visibilityState !== 'hidden';
      if (!visible) coverHome();
      setDocumentVisible(visible);
      setStageMountable(false);
      if (!visible) {
        setOverlayStopped(false);
        return;
      }
      void stopOverlayBeforeHomeModel().then(() => {
        if (!alive || document.visibilityState === 'hidden') setOverlayStopped(false);
      });
    };
    syncVisibility();
    document.addEventListener('visibilitychange', syncVisibility);
    return () => {
      alive = false;
      document.removeEventListener('visibilitychange', syncVisibility);
    };
  }, [coverHome, stopOverlayBeforeHomeModel]);

  const homeLive2DVisible = shouldMountHandheldHomeLive2D({
    page,
    documentVisible,
    overlayStopped,
    pageReady: stageMountable,
    settingsOpen,
  });

  const showSettings = useCallback(async (origin: SettingsOrigin) => {
    coverHome();
    setOverlayStopped(false);
    setStageMountable(false);
    setSettingsOrigin(origin);
    // 设置页会启动真实底条预览；主页 renderer 确认 pause 后才允许挂载它。
    const opened = await openSettingsAfterHomePark(
      parkNativeStage,
      () => setSettingsOpen(true),
    );
    if (!opened) console.error('[handheld] 主页渲染层暂停失败，设置预览保持关闭');
  }, [coverHome]);

  async function closeSettings() {
    const policy = settingsClosePolicy(settingsOrigin);
    setOverlayStopped(false);

    if (policy.destination === 'game') {
      // 设置页正在展示的就是真底条。先把最新参数落盘并确认服务仍在，再卸设置页；
      // HandheldSettings 的 preserveStripOnClose 会阻止 cleanup 把它误停。
      try {
        await syncStripParams(avatarId);
        await startBottomStrip(avatarId);
      } catch {
        // 返回游戏优先；底条异常时仍让用户回游戏，F10 可按持久化参数重试。
      }
      setSettingsOpen(false);
      // 等 React 完成设置页卸载后再把 HOME task 放到后台，避免状态更新被冻结在前台切换中。
      window.requestAnimationFrame(() => {
        void Handheld.returnToGame().catch(() => {});
      });
      return;
    }

    setSettingsOpen(false);
    void syncStripParams(avatarId).catch(() => {});
    void stopOverlayBeforeHomeModel().then(() => {
      // 设置页没有横向转场；服务确认离场后下一帧即可重新挂主页模型。
      if (document.visibilityState !== 'hidden' && page === 'home') {
        window.requestAnimationFrame(() => setStageMountable(true));
      }
    });
  }

  function navigateToPage(nextPage: HandheldPage) {
    coverHome();
    setStageMountable(false);
    setPage(nextPage);
  }

  function openGames() {
    navigateToPage('games');
  }

  function openApps() {
    navigateToPage('apps');
  }

  function closeApps() {
    navigateToPage('games');
  }

  function returnHome() {
    navigateToPage('home');
  }

  function executeNavigation(command: HandheldNavigation) {
    if (command.kind === 'close-settings') {
      void closeSettings();
      return;
    }
    if (command.kind === 'settings') {
      void showSettings(command.origin);
      return;
    }
    if (command.kind === 'page') {
      navigateToPage(command.page);
    }
  }

  // 原生 touch 监听器只挂一次；事件发生时从 ref 读取最新页面和导航闭包，避免重渲染期间
  // 反复拆装监听器，也避免 capture 监听器拿到旧的 settingsOrigin / avatarId。
  const navigationSurfaceRef = useRef(settingsOpen ? 'settings' as const : page);
  navigationSurfaceRef.current = settingsOpen ? 'settings' : page;
  const gestureBlockedRef = useRef(callOpen);
  gestureBlockedRef.current = callOpen;
  const executeNavigationRef = useRef(executeNavigation);
  executeNavigationRef.current = executeNavigation;

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const beginSwipe = (event: TouchEvent) => {
      const target = event.target;
      const startsOnInput = target instanceof Element
        && Boolean(target.closest('input, textarea, select, [data-swipe-ignore]'));
      const touch = event.changedTouches[0];
      if (gestureBlockedRef.current || startsOnInput || event.touches.length !== 1 || !touch) {
        swipeStart.current = null;
        return;
      }
      swipeStart.current = {
        identifier: touch.identifier,
        start: { x: touch.clientX, y: touch.clientY },
      };
    };

    const continueSwipe = (event: TouchEvent) => {
      const session = swipeStart.current;
      if (!session || gestureBlockedRef.current) return;
      const command = navigationForTrackedTouch(
        navigationSurfaceRef.current,
        session,
        event.touches,
      );
      if (command.kind === 'none') return;

      // 一旦确认为横滑，就在 capture 阶段截住 WebView 的纵向列表滚动，避免随后 touchcancel。
      event.preventDefault();
      event.stopPropagation();
      swipeStart.current = null;
      // Android WebView 会在 touchend 后补发 click；短暂吃掉它，避免从 ROM 封面起滑时误开游戏。
      suppressClickUntil.current = Date.now() + 450;
      executeNavigationRef.current(command);
    };

    const endSwipe = () => {
      swipeStart.current = null;
    };

    root.addEventListener('touchstart', beginSwipe, { capture: true, passive: true });
    root.addEventListener('touchmove', continueSwipe, { capture: true, passive: false });
    root.addEventListener('touchend', endSwipe, true);
    root.addEventListener('touchcancel', endSwipe, true);
    return () => {
      root.removeEventListener('touchstart', beginSwipe, true);
      root.removeEventListener('touchmove', continueSwipe, true);
      root.removeEventListener('touchend', endSwipe, true);
      root.removeEventListener('touchcancel', endSwipe, true);
    };
  }, []);

  function handleClickCapture(event: ReactMouseEvent<HTMLDivElement>) {
    if (Date.now() >= suppressClickUntil.current) return;
    event.preventDefault();
    event.stopPropagation();
  }

  // ★底条由实体侧键（F10）全局呼出/收起。JS 只负责同步参数，以及回主页时等待其彻底销毁。
  useEffect(() => {
    void syncStripParams(avatarId).catch(() => {});
  }, [avatarId]);
  const now = useMinuteClock();

  const avatar = getAvatarById(option.id);
  const homeRequestId = homeGate.requestId;
  const dateLabel = `${now.getMonth() + 1}月${now.getDate()}日 ${WEEKDAYS[now.getDay()]}`;
  const timeLabel = formatHandheldHomeTime(now);

  useEffect(() => {
    const w = window as unknown as {
      __aibooHandheldOpenSettings?: (origin?: SettingsOrigin) => void;
      __aibooPendingHandheldOpenSettings?: SettingsOrigin | number;
    };
    const openSettingsFromOverlay = (origin?: SettingsOrigin) => {
      setCallOpen(false);
      // 旧原生包没有 origin 参数；这个桥只由游戏底条调用，所以安全回落到 game。
      void showSettings(origin === 'home' ? 'home' : 'game');
    };
    w.__aibooHandheldOpenSettings = openSettingsFromOverlay;
    if (w.__aibooPendingHandheldOpenSettings) {
      const pending = w.__aibooPendingHandheldOpenSettings;
      w.__aibooPendingHandheldOpenSettings = 0;
      openSettingsFromOverlay(pending === 'home' ? 'home' : 'game');
    }
    return () => {
      if (w.__aibooHandheldOpenSettings === openSettingsFromOverlay) delete w.__aibooHandheldOpenSettings;
    };
  }, [showSettings]);

  return (
    <div
      ref={rootRef}
      className="hh-root"
      data-page={page === 'home' ? 'home' : 'games'}
      data-route={page}
      onClickCapture={handleClickCapture}
    >
      <div className="hh-pages">
        <section className="hh-page hh-page--home">
          {/* ★settingsOpen 时必须卸掉：设置页会起一条真实底条做实时预览，
              两个原生 GL 同屏抢 GPU → 帧间隔抖动 → Cubism 物理按 dt 演算失控 →
              角色疯狂抽动（Ben 实报过）。先卸主页、再起底条，顺序不能反。 */}
          {homeLive2DVisible && avatar ? (
            <Live2DStage
              avatar={avatar}
              expressionMix={EMPTY_EXPRESSION_MIX}
              parameterOverrides={EMPTY_PARAM_OVERRIDES}
              costumeParamOverrides={option.costume}
              watermarkVisible={false}
              transform={option.homeTransform}
              backgroundUrl={HOME_BG_URL}
              surface="home"
              // 关掉拖拽缩放：这是桌面，误拖角色很烦，且没有「复位」入口
              interactive={false}
              nativeTargetFps={HANDHELD_NATIVE_TARGET_FPS}
              preserveNativeOnUnmount
              lifecycleRequestId={homeRequestId}
              onReady={() => {
                markNativeStageRevealed(homeRequestId);
                setHomeGate((gate) => markHomeSceneReady(gate, homeRequestId));
              }}
            />
          ) : null}
          <div
            className={`hh-home-curtain${isHomeSceneCovered(homeGate) ? '' : ' is-ready'}`}
            aria-hidden="true"
          />
          <div className="hh-home-gradient hh-home-gradient--top" aria-hidden="true" />
          {!callOpen ? (
            <div className="hh-home-clock">
              <div className="hh-home-time">{timeLabel}</div>
              <div className="hh-home-info">
                <div className="hh-home-date">{dateLabel}</div>
                <HandheldWeather />
              </div>
            </div>
          ) : null}

          {!callOpen ? (
            <>
              <div className="hh-home-gradient hh-home-gradient--bottom" aria-hidden="true" />
              <nav className="hh-home-actions" aria-label="掌机快捷入口">
                <button
                  type="button"
                  className="hh-home-action"
                  onClick={() => { void showSettings('home'); }}
                >
                  <img src="./handheld/figma/home-settings.svg" alt="" />
                  <span>设置</span>
                </button>
                <button type="button" className="hh-home-action" onClick={openGames}>
                  <img src="./handheld/figma/home-game.svg" alt="" />
                  <span>游戏</span>
                </button>
              </nav>
              <div className="hh-home-callbar">
                <button type="button" className="hh-home-call" onClick={() => setCallOpen(true)} aria-label="打电话">
                  <img src="./handheld/figma/home-call.svg" alt="" />
                </button>
              </div>
            </>
          ) : null}
          {callOpen && avatar ? (
            <CallOverlay
              open
              mode="voice"
              avatarName={avatar.name}
              avatarId={avatar.id}
              voice={avatar.voice}
              systemMessage={buildVoiceCallSystemPrompt(avatar)}
              callSettings={getDefaultCallSettings()}
              variant="handheld-home"
              onClose={() => setCallOpen(false)}
            />
          ) : null}
        </section>

        <section className="hh-page hh-page--games">
          {page !== 'home' ? (
            <HandheldGameGrid
              avatarId={avatarId}
              view={page}
              onBack={returnHome}
              onOpenApps={openApps}
              onCloseApps={closeApps}
            />
          ) : null}
        </section>
      </div>
      {settingsOpen ? (
        <HandheldSettings
          avatarId={avatarId}
          onAvatarChange={setAvatarId}
          preserveStripOnClose={settingsClosePolicy(settingsOrigin).keepStrip}
          onClose={() => { void closeSettings(); }}
        />
      ) : null}
    </div>
  );
}
