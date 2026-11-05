import { useCallback, useEffect, useRef, useState } from 'react';
import { avatarList } from '../features/live2d/avatarData.ts';
import { getCachedPortrait } from './badgeThumbs.ts';
import { probeLoopMotions, type LoopMotionOption } from './badgeCatalog.ts';
import { resolveAvatarManifestById } from '../features/live2d/avatarManifest.ts';
import { createLive2DRuntime, destroyRuntime } from '../features/live2d/live2dEngine.ts';
import { bakeWidgetLoop } from '../features/badgeBake/widgetBake.ts';
import { WIDGET_SWAY_PERIOD_S } from '../features/badgeBake/widgetProfile.ts';
import {
  getWidgetState,
  saveWidgetFrames,
  setActiveWidgetLoop,
  requestWidgetPin,
  DEFAULT_WIDGET_STATE,
  type WidgetState,
} from '../lib/widgetPlugin.ts';
import {
  applyScreensaver,
  enableNotificationAccess,
  getScreensaverState,
  openDreamSettings,
  requestScreensaverPermission,
  setScreensaverConfig,
  DEFAULT_SCREENSAVER_STATE,
  type ScreensaverState,
} from '../lib/screensaverPlugin.ts';
import './screensaverModal.css';

type Props = { onClose: () => void };

/** 屏保默认角色（与屏保 Web 侧 Live2DScene 的 DEFAULT_AVATAR_ID 一致）。 */
const FALLBACK_AVATAR_ID = 'shuangsheng';

export function ScreensaverModal({ onClose }: Props) {
  const [state, setState] = useState<ScreensaverState>(DEFAULT_SCREENSAVER_STATE);
  const [loaded, setLoaded] = useState(false);
  const [hint, setHint] = useState('');
  // 滑块本地值（拖动中不写原生，松手才 setConfig——节流）
  const [brightness, setBrightness] = useState(DEFAULT_SCREENSAVER_STATE.brightness);
  const [fps, setFps] = useState(DEFAULT_SCREENSAVER_STATE.fps);
  const [server, setServer] = useState('');
  const [city, setCity] = useState('');
  const busyRef = useRef(false);

  const refresh = useCallback(async () => {
    const s = await getScreensaverState();
    setState(s);
    setBrightness(s.brightness);
    setFps(s.fps);
    setServer(s.server);
    setCity(s.city);
    setLoaded(true);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // 从系统设置页返回时刷新状态（深链回落路径：用户去系统页选完回来）
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refresh]);

  const selectedAvatarId = state.avatarId || FALLBACK_AVATAR_ID;

  const handleApply = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      const r = await applyScreensaver();
      if (r.applied) {
        setHint('已应用为系统屏保 ✓ 充电息屏时自动启动');
      } else {
        setHint('未授权直写，已跳系统设置——请在屏保列表选择 Aiboo 后返回');
        await openDreamSettings();
      }
      await refresh();
    } finally {
      busyRef.current = false;
    }
  };

  const handlePickAvatar = async (id: string) => {
    setState((s) => ({ ...s, avatarId: id }));
    await setScreensaverConfig({ avatarId: id });
  };

  const handleNotifAccess = async () => {
    const method = await enableNotificationAccess();
    if (method === 'settings') {
      setHint('已跳通知使用权设置页——找到 Aiboo 打开开关后返回');
    }
    await refresh();
  };

  const handlePermission = async (kind: 'calendar' | 'location') => {
    await requestScreensaverPermission(kind);
    await refresh();
  };

  // ---- 桌面组件：动作烤制/动画库/一键上桌面 ----
  const [widget, setWidget] = useState<WidgetState>(DEFAULT_WIDGET_STATE);
  const [motionOptions, setMotionOptions] = useState<LoopMotionOption[]>([]);
  const [bakingKey, setBakingKey] = useState('');
  const [bakePercent, setBakePercent] = useState(0);
  const [widgetHint, setWidgetHint] = useState('');
  const hiddenStageRef = useRef<HTMLDivElement>(null);

  const widgetAvatarId = state.avatarId || FALLBACK_AVATAR_ID;

  const refreshWidget = useCallback(async () => {
    setWidget(await getWidgetState());
  }, []);

  useEffect(() => {
    refreshWidget();
  }, [refreshWidget]);

  // 「自然摆动」常驻默认项：无闭环 motion 的角色（如 yumi 只有一次性手势）也永远有环可烤。
  // url='' 在烤制时映射为 null → Tier B wobble 驱动。
  const SWAY_OPTION: LoopMotionOption = {
    key: 'sway', url: '', durationS: WIDGET_SWAY_PERIOD_S, gridPeriodS: WIDGET_SWAY_PERIOD_S,
  };

  // 枚举当前角色可循环动作（烤帧的动作源），头部固定自然摆动
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const manifest = await resolveAvatarManifestById(widgetAvatarId);
        const options = await probeLoopMotions(manifest, 12);
        if (alive) setMotionOptions([SWAY_OPTION, ...options]);
      } catch {
        if (alive) setMotionOptions([SWAY_OPTION]);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [widgetAvatarId]);

  /** 烤一个动作环并落盘（首环自动上桌面）。烤制期间与其他烤制互斥。 */
  const bakeLoop = async (option: LoopMotionOption) => {
    if (bakingKey) return;
    setBakingKey(option.key);
    setBakePercent(0);
    setWidgetHint('');
    let runtime: Awaited<ReturnType<typeof createLive2DRuntime>> | null = null;
    try {
      const container = hiddenStageRef.current;
      if (!container) return;
      const manifest = await resolveAvatarManifestById(widgetAvatarId);
      runtime = await createLive2DRuntime(container, manifest);
      const out = await bakeWidgetLoop(runtime, option.url || null, '/backgrounds/home-bg.jpg', (p) => {
        if (p.phase === 'capture') setBakePercent(Math.round((p.frame / p.total) * 100));
      }, option.durationS);
      const saved = await saveWidgetFrames({
        avatarId: widgetAvatarId,
        loopKey: option.key,
        fps: out.fps,
        frames: out.framesPng,
      });
      setWidgetHint(saved > 0 ? `「${option.key}」已烤好（${saved} 帧）` : '烤制失败，请重试');
      await refreshWidget();
    } catch {
      setWidgetHint('烤制失败，请重试');
    } finally {
      if (runtime) {
        try {
          destroyRuntime(runtime);
        } catch {
          /* WebGL 已丢失等：忽略 */
        }
      }
      setBakingKey('');
      setBakePercent(0);
    }
  };

  const handlePin = async () => {
    const ok = await requestWidgetPin();
    // MIUI 会回报成功却不弹系统确认框（「桌面快捷方式」权限默认静默拒绝）——始终附手动路径
    setWidgetHint(ok
      ? '已请求添加：桌面若没弹确认框（小米常见），长按桌面空白处 → 添加小部件 → Aiboo 角色'
      : '当前桌面不支持一键添加——长按桌面空白处手动添加「Aiboo 角色」');
    await refreshWidget();
  };

  return (
    <div className="ssm-overlay" onClick={onClose}>
      <div className="ssm-panel" onClick={(e) => e.stopPropagation()}>
        <div className="ssm-head">
          <h2>充电屏保</h2>
          <button type="button" className="ssm-close" onClick={onClose} aria-label="关闭">✕</button>
        </div>
        <p className="ssm-note">改动在下次进入屏保时生效</p>

        {/* 应用状态卡 */}
        <section className="ssm-card">
          <div className="ssm-status">
            <span className={`ssm-dot ${state.applied ? 'is-on' : ''}`} />
            {loaded ? (state.applied ? '已设为系统屏保' : '尚未设为系统屏保') : '读取中…'}
          </div>
          <button type="button" className="ssm-primary" onClick={handleApply}>
            {state.secureGranted ? '一键应用为屏保' : '去系统设置选择'}
          </button>
          {!state.secureGranted && (
            <p className="ssm-tip">
              提示：执行一次 adb 授权后可一键直设：
              <code>pm grant com.llm.live2d android.permission.WRITE_SECURE_SETTINGS</code>
            </p>
          )}
          {hint && <p className="ssm-hint">{hint}</p>}
        </section>

        {/* 角色选择 */}
        <section className="ssm-card">
          <h3>屏保角色</h3>
          <div className="ssm-avatars">
            {avatarList.map((a) => {
              const portrait = getCachedPortrait(a.id);
              return (
                <button
                  key={a.id}
                  type="button"
                  className={`ssm-avatar ${selectedAvatarId === a.id ? 'is-active' : ''}`}
                  onClick={() => handlePickAvatar(a.id)}
                >
                  {portrait
                    ? <img src={portrait} alt="" />
                    : <span className="ssm-avatar-glyph">{a.name.slice(0, 1)}</span>}
                  <span className="ssm-avatar-name">{a.name}</span>
                </button>
              );
            })}
          </div>
          <p className="ssm-tip">DJ 模式进行中时，屏保自动跟随 DJ 角色并换装（优先于此处指定）</p>
        </section>

        {/* 桌面组件：烤动作环 → 动画库 → 一键上桌面 */}
        <section className="ssm-card">
          <h3>桌面组件（{widget.added ? '已在桌面 ✓' : '未添加'}）</h3>
          <div ref={hiddenStageRef} className="ssm-hidden-stage" />
          {motionOptions.length === 0 ? (
            <p className="ssm-tip">该角色暂无可循环的待机动作</p>
          ) : (
            motionOptions.map((m) => {
              const baked = widget.avatarId === widgetAvatarId && widget.loops.some((l) => l.key === m.key);
              const isActive = baked && widget.activeLoop === m.key;
              return (
                <div className="ssm-perm" key={m.key}>
                  <span className={`ssm-dot ${baked ? 'is-on' : ''}`} />
                  <span className="ssm-perm-name">
                    {m.key === 'sway' ? '自然摆动（默认）' : `${m.key}（${m.durationS.toFixed(1)}s）`}
                    {isActive ? ' · 桌面使用中' : ''}
                  </span>
                  {bakingKey === m.key ? (
                    <span className="ssm-tip">{bakePercent > 0 ? `采集 ${bakePercent}%` : '预热中…'}</span>
                  ) : (
                    <>
                      {baked && !isActive && (
                        <button type="button" onClick={() => setActiveWidgetLoop(widgetAvatarId, m.key).then(refreshWidget)}>
                          用这个
                        </button>
                      )}
                      <button type="button" disabled={!!bakingKey} onClick={() => bakeLoop(m)}>
                        {baked ? '重烤' : '烤制'}
                      </button>
                    </>
                  )}
                </div>
              );
            })
          )}
          <button type="button" className="ssm-primary" onClick={handlePin} disabled={!!bakingKey}>
            一键添加到桌面
          </button>
          {widgetHint && <p className="ssm-hint">{widgetHint}</p>}
          <p className="ssm-tip">烤好的动画由桌面自行循环播放，App 无需常驻后台；换角色后需为新角色烤制</p>
        </section>

        {/* 亮度 / 帧数 */}
        <section className="ssm-card">
          <h3>显示</h3>
          <label className="ssm-slider">
            <span>屏保亮度 {brightness}%</span>
            <input
              type="range"
              min={10}
              max={100}
              step={5}
              value={brightness}
              onChange={(e) => setBrightness(Number(e.target.value))}
              onPointerUp={() => setScreensaverConfig({ brightness })}
              onTouchEnd={() => setScreensaverConfig({ brightness })}
            />
          </label>
          <label className="ssm-slider">
            <span>刷新率 {fps} fps（越高越流畅，越耗电发热）</span>
            <input
              type="range"
              min={10}
              max={60}
              step={5}
              value={fps}
              onChange={(e) => setFps(Number(e.target.value))}
              onPointerUp={() => setScreensaverConfig({ fps })}
              onTouchEnd={() => setScreensaverConfig({ fps })}
            />
          </label>
        </section>

        {/* 权限组 */}
        <section className="ssm-card">
          <h3>屏保小组件权限</h3>
          <div className="ssm-perm">
            <span className={`ssm-dot ${state.calendarGranted ? 'is-on' : ''}`} />
            <span className="ssm-perm-name">日历（日程卡片）</span>
            {!state.calendarGranted && (
              <button type="button" onClick={() => handlePermission('calendar')}>授权</button>
            )}
          </div>
          <div className="ssm-perm">
            <span className={`ssm-dot ${state.locationGranted ? 'is-on' : ''}`} />
            <span className="ssm-perm-name">定位（天气跟随本地）</span>
            {!state.locationGranted && (
              <button type="button" onClick={() => handlePermission('location')}>授权</button>
            )}
          </div>
          <div className="ssm-perm">
            <span className={`ssm-dot ${state.notifAccess ? 'is-on' : ''}`} />
            <span className="ssm-perm-name">通知读取（消息卡片）</span>
            {!state.notifAccess && (
              <button type="button" onClick={handleNotifAccess}>开启</button>
            )}
          </div>
        </section>

        {/* 后端 / 天气 */}
        <section className="ssm-card">
          <h3>数据源</h3>
          <label className="ssm-field">
            <span>后端服务器地址（DJ / 天气）</span>
            <input
              type="text"
              inputMode="url"
              placeholder="http://192.168.x.x:3456"
              value={server}
              onChange={(e) => setServer(e.target.value)}
              onBlur={() => setScreensaverConfig({ server: server.trim() })}
            />
          </label>
          <label className="ssm-field">
            <span>天气城市（留空跟随定位/默认）</span>
            <input
              type="text"
              placeholder="Beijing / 上海"
              value={city}
              onChange={(e) => setCity(e.target.value)}
              onBlur={() => setScreensaverConfig({ city: city.trim() })}
            />
          </label>
        </section>
      </div>
    </div>
  );
}
