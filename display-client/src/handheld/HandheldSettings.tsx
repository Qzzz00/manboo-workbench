// 掌机桌面的设置面板。
//
// 两块内容，对应 Ben 要的两种「设置入口」：
//   1) 底条角色：选人 + 取景（大小/上下）——Aiboo 自己的事，滑块调、存 localStorage
//   2) 各模拟器的设置直达——虚拟手柄、A/B 映射、画面对齐都在它们**自己的私有配置**里，
//      Aiboo 从外面改不了，只能把人送到门口
import { useEffect, useRef, useState } from 'react';
import Handheld from '../lib/handheldPlugin.ts';
import { overlayUpdateFraming } from '../lib/overlayPlugin.ts';
import {
  loadHandheldSettings,
  saveHandheldSettings,
  stripFramingFor,
  withStripFraming,
  HEAD_SCREEN_Y_RANGE,
  FACE_SCREEN_FRAC_RANGE,
  type HandheldSettings as Settings,
} from './handheldSettingsStore.ts';
import {
  HANDHELD_AVATAR_OPTIONS,
  DEFAULT_STRIP_FRAMING,
  type StripFraming,
} from './handheldAvatars.ts';
import { startBottomStrip, stopBottomStrip, syncStripParams, STRIP_HEIGHT_PX } from './handheldStrip.ts';
import {
  captureScreenshot,
  classifyCaptureError,
  requestMicPermission,
  strategistCapabilities,
} from '../lib/strategistPlugin.ts';
import {
  loadStrategistConfig,
  saveStrategistConfig,
  type StrategistConfig,
} from '../lib/strategist/strategistConfig.ts';

const EMULATORS: {
  app: 'retroarch' | 'duckstation' | 'drastic' | 'ppsspp';
  label: string;
  platforms: string;
}[] = [
  { app: 'retroarch', label: 'RetroArch', platforms: 'GBA / GB / GBC' },
  { app: 'duckstation', label: 'DuckStation', platforms: 'PS1' },
  { app: 'drastic', label: 'DraStic', platforms: 'NDS' },
  { app: 'ppsspp', label: 'PPSSPP', platforms: 'PSP' },
];

// 取景热更新节流：滑块 onChange 一秒能触发上百次，每次都过一遍
// JS→Capacitor→Service→evaluateJavascript 是浪费。60ms ≈ 16fps，肉眼已经连续。
const FRAMING_PUSH_MS = 60;

export function HandheldSettings({
  avatarId,
  onAvatarChange,
  onClose,
  preserveStripOnClose = false,
}: {
  avatarId: string;
  onAvatarChange: (id: string) => void;
  onClose: () => void;
  /** 从游戏底条进来时，关闭设置后这条预览就是游戏底条，不能随组件卸载停掉。 */
  preserveStripOnClose?: boolean;
}) {
  const [s, setS] = useState<Settings>(() => loadHandheldSettings());
  const framing = stripFramingFor(s, avatarId);
  const pushAt = useRef(0);
  const pushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 是不是默认桌面（HOME role）。null=正在查/原生方法缺失（浏览器预览等），
  // 不显示误导性的状态，只显示「正在检查…」。
  const [launcherState, setLauncherState] = useState<{ isDefault: boolean; roleAvailable: boolean } | null>(null);
  useEffect(() => {
    const refresh = () => {
      void Handheld.getLauncherState().then(setLauncherState).catch(() => {});
    };
    refresh();
    // 从系统「用作主屏幕」确认框 / 系统设置页返回时页面会重新可见——借这个时机重新查。
    // openHomeSettings 那条路径原生侧根本拿不到用户在系统设置里选了什么，只能靠回来后再问系统。
    document.addEventListener('visibilitychange', refresh);
    return () => document.removeEventListener('visibilitychange', refresh);
  }, []);

  async function handleLauncherAction() {
    try {
      // 已经是默认桌面：按钮改去系统「主屏幕应用」设置页，把「换回别的桌面」的入口也给全；
      // 不是默认：走 RoleManager 官方请求流程，系统弹确认框。
      if (launcherState?.isDefault) await Handheld.openHomeSettings();
      else await Handheld.requestSetAsLauncher();
    } catch {
      /* 用户在系统确认框里取消 / 原生方法缺失：不额外提示，下面重新查真实状态即可反映结果 */
    }
    try {
      setLauncherState(await Handheld.getLauncherState());
    } catch {
      /* 保持上次已知状态 */
    }
  }

  // ★真底条实时预览：设置页在前台时起一条**真实**浮窗底条，拖滑块所见即所得。
  //   不做页内 Pixi 预览框——Pixi 与原生 Cubism 成像差约 7% 屏高，已经栽过三次，
  //   给一个"准但不精准"的预览等于埋第四次。
  // ★主页大角色由 HandheldApp 在 settingsOpen 时卸掉（两个原生 GL 同屏抢 GPU →
  //   帧间隔抖动 → Cubism 物理按 dt 演算失控 → 角色疯狂抽动）。先卸主页再起底条，
  //   顺序由那边的渲染条件保证。
  // 没有悬浮窗权限时 startBottomStrip 静默不起，滑块照常能调能存（退回"退出去按 F10 看"）。
  useEffect(() => {
    void startBottomStrip(avatarId).catch(() => {});
    return () => {
      if (pushTimer.current) clearTimeout(pushTimer.current);
      if (!preserveStripOnClose) void stopBottomStrip().catch(() => {});
    };
  }, [avatarId, preserveStripOnClose]);

  /** 存设置 + 节流推给正在预览的底条（热更新，不重载模型）。 */
  function updateFraming(patch: Partial<StripFraming>) {
    const next = { ...stripFramingFor(s, avatarId), ...patch };
    const nextSettings = withStripFraming(s, avatarId, next);
    setS(nextSettings);
    saveHandheldSettings(nextSettings);

    const now = Date.now();
    const push = () => {
      pushAt.current = Date.now();
      void overlayUpdateFraming(next.headScreenY, next.faceScreenFrac).catch(() => {});
    };
    if (pushTimer.current) clearTimeout(pushTimer.current);
    if (now - pushAt.current >= FRAMING_PUSH_MS) push();
    // 尾随一次：拖停在两次节流之间时，最后那一档也要推上去，否则松手后差半档
    else pushTimer.current = setTimeout(push, FRAMING_PUSH_MS);
  }

  function pickAvatar(id: string) {
    const next = { ...s, avatarId: id };
    setS(next);
    saveHandheldSettings(next);
    onAvatarChange(id);
  }

  // ── 军师 ──────────────────────────────────────────────────────────────
  // 能力自检：无障碍（侧键 F10 + 截屏，同一个 AibooKeyService）与麦克风（语音提问）。
  // ★这不是一次性引导而是常驻状态显示，因为无障碍授权会被**两件事**清掉：
  //   ① 重装 APK ② force-stop（2026-07-31 logcat 实锤的新发现）
  // 而它掉了之后**唯一的症状就是按 F10 没反应**，没有任何提示，用户只能猜。
  const [caps, setCaps] = useState<{ screenshot: boolean; mic: boolean } | null>(null);
  useEffect(() => {
    const refresh = () => void strategistCapabilities().then(setCaps);
    refresh();
    // ★必须跟着 visibilitychange 重查：用户点下面的按钮去系统无障碍页开完回来，
    // 状态得立刻变 ✓，否则他会以为没开成功、来回折腾。
    document.addEventListener('visibilitychange', refresh);
    return () => document.removeEventListener('visibilitychange', refresh);
  }, []);

  // 截屏自检结果文案。延时 5 秒再截，给你时间切进游戏——「游戏全屏时能不能截」
  // 是这条路唯一验不了的地方，必须真机自检。
  const [shotCheck, setShotCheck] = useState('');

  async function runShotCheck() {
    setShotCheck('5 秒后截屏，现在切到游戏…');
    try {
      const r = await captureScreenshot({
        cropBottomPx: STRIP_HEIGHT_PX,
        maxBytes: 300_000,
        delayMs: 5000,
      });
      setShotCheck(`OK ${r.widthPx}×${r.heightPx}，${Math.round(r.bytes / 1024)}KB`);
    } catch (e) {
      setShotCheck(classifyCaptureError(String((e as { message?: string })?.message ?? e)));
    }
    void strategistCapabilities().then(setCaps);
  }

  async function askMic() {
    await requestMicPermission();
    setCaps(await strategistCapabilities());
  }

  // 服务器地址与设备 token。
  // ★这里存的是**用户正在输入的原始值**，不在 onChange 里归一化——半截地址
  // （"http://1"）会被 normalize 吞回默认，输到一半就跳掉，根本没法打字。
  // 归一化只发生在 saveStrategistConfig 内部与 loadStrategistConfig 读出时。
  const [sv, setSv] = useState(() => loadStrategistConfig());

  function updateStrategist(patch: Partial<StrategistConfig>) {
    const next = { ...sv, ...patch };
    setSv(next);
    saveStrategistConfig(next);
    // 底条参数里带着服务器地址与 token，改完要立刻落盘给 F10 回放用。
    void syncStripParams(avatarId).catch(() => {});
  }

  return (
    <div className="hh-settings">
      <div className="hh-settings-head">
        <button className="hh-nav hh-nav--to-home hh-settings-back" onClick={onClose}>
          ‹ 返回
        </button>
        <span className="hh-settings-title">设置</span>
      </div>

      <div className="hh-settings-body">
        <section className="hh-settings-group">
          <div className="hh-settings-group-title">底条角色</div>
          <p className="hh-settings-hint">
            下面那条就是真的底条，拖滑块实时变。换角色要重载模型，会先出一个剪影。
          </p>

          <div className="hh-settings-avatars">
            {HANDHELD_AVATAR_OPTIONS.map((o) => (
              <button
                key={o.id}
                className={
                  o.id === avatarId ? 'hh-settings-avatar hh-settings-avatar--on' : 'hh-settings-avatar'
                }
                onClick={() => pickAvatar(o.id)}
              >
                {o.label}
              </button>
            ))}
          </div>

          {/* ★两个滑块都是正向绑定：faceScreenFrac 越大越大、headScreenY 越大越靠下，
              与拖动方向一致。v1 那种 min+max-v 镜像绑定别再写回来——那是因为当年绑的
              是 headSizeNorm（越小越大）这个反直觉的量，换成屏幕空间量后不需要了。 */}
          <label className="hh-settings-row">
            <span>大小</span>
            <input
              type="range"
              min={FACE_SCREEN_FRAC_RANGE.min}
              max={FACE_SCREEN_FRAC_RANGE.max}
              step={FACE_SCREEN_FRAC_RANGE.step}
              value={framing.faceScreenFrac}
              onChange={(e) => updateFraming({ faceScreenFrac: Number(e.target.value) })}
            />
            <span className="hh-settings-val">{framing.faceScreenFrac.toFixed(3)}</span>
          </label>

          <label className="hh-settings-row">
            <span>上下</span>
            <input
              type="range"
              min={HEAD_SCREEN_Y_RANGE.min}
              max={HEAD_SCREEN_Y_RANGE.max}
              step={HEAD_SCREEN_Y_RANGE.step}
              value={framing.headScreenY}
              onChange={(e) => updateFraming({ headScreenY: Number(e.target.value) })}
            />
            <span className="hh-settings-val">{framing.headScreenY.toFixed(3)}</span>
          </label>

          <button className="hh-settings-reset" onClick={() => updateFraming(DEFAULT_STRIP_FRAMING)}>
            恢复默认
          </button>
        </section>

        <section className="hh-settings-group">
          <div className="hh-settings-group-title">模拟器设置</div>
          <p className="hh-settings-hint">
            虚拟手柄、A/B 映射、画面对齐都存在各模拟器自己的配置里，Aiboo 改不了，
            点进去在它们的菜单里调。
          </p>
          {EMULATORS.map((e) => (
            <button
              key={e.app}
              className="hh-settings-emu"
              onClick={() => void Handheld.openEmulator({ app: e.app }).catch(() => {})}
            >
              <span className="hh-settings-emu-name">{e.label}</span>
              <span className="hh-settings-emu-sub">{e.platforms}</span>
              <span className="hh-settings-emu-go">›</span>
            </button>
          ))}
        </section>

        <section className="hh-settings-group">
          <div className="hh-settings-group-title">军师</div>
          <p className="hh-settings-hint">
            玩游戏时按 F10 出底条，点角色一下问「这里怎么过」，按住角色说话。
          </p>
          <label className="hh-settings-row">
            <span>服务器</span>
            <input
              className="hh-settings-input"
              value={sv.baseUrl}
              placeholder="https://js.aibooo.cn"
              onChange={(e) => updateStrategist({ baseUrl: e.target.value })}
            />
          </label>
          <label className="hh-settings-row">
            <span>设备 token</span>
            <input
              className="hh-settings-input"
              value={sv.deviceToken}
              onChange={(e) => updateStrategist({ deviceToken: e.target.value })}
            />
          </label>
          {/* 语音走 Aiboo 后台（阿里云，公网可达）——凭证与角色音色绑定都在那边，
              所以它和上面的军师服务端是两套地址/两个 token。 */}
          <label className="hh-settings-row">
            <span>语音服务器</span>
            <input
              className="hh-settings-input"
              value={sv.aibooBaseUrl}
              placeholder="http://your-aiboo-host:3456"
              onChange={(e) => updateStrategist({ aibooBaseUrl: e.target.value })}
            />
          </label>
          <label className="hh-settings-row">
            <span>语音 token</span>
            <input
              className="hh-settings-input"
              value={sv.aibooDeviceToken}
              onChange={(e) => updateStrategist({ aibooDeviceToken: e.target.value })}
            />
          </label>

          <div className="hh-settings-launcher">
            <span className="hh-settings-launcher-status">
              {caps == null
                ? '正在检查…'
                : caps.screenshot
                  ? '侧键 F10 + 截屏：✓'
                  : '侧键 F10 + 截屏：✕ 无障碍已关'}
            </span>
            {/* ✕ 时按钮换成「去开无障碍」——只告诉用户坏了而不给入口，等于让他自己
                去系统设置里翻。✓ 时才是自检按钮。 */}
            {caps && !caps.screenshot ? (
              <button
                className="hh-settings-launcher-btn"
                onClick={() => void Handheld.openAccessibilitySettings().catch(() => {})}
              >
                去开无障碍
              </button>
            ) : (
              <button className="hh-settings-launcher-btn" onClick={() => void runShotCheck()}>
                截屏自检
              </button>
            )}
          </div>
          {caps && !caps.screenshot ? (
            <p className="hh-settings-hint">
              这一项会被两件事清掉：重装 App、以及被 force-stop（在系统「应用信息」里
              点「强行停止」也算）。掉了之后按 F10 会完全没反应，也不报错。
            </p>
          ) : null}
          <div className="hh-settings-launcher">
            <span className="hh-settings-launcher-status">
              {caps == null ? '正在检查…' : `麦克风 ${caps.mic ? '✓' : '✕ 未授权'}`}
            </span>
            <button className="hh-settings-launcher-btn" onClick={() => void askMic()}>
              请求麦克风
            </button>
          </div>
          <p className="hh-settings-hint">
            截屏自检：点一下后有 5 秒时间切进游戏，会截一张并报出尺寸与大小。
            底部 {STRIP_HEIGHT_PX}px 会被裁掉（那是底条角色自己）。
          </p>
          {shotCheck ? <p className="hh-settings-hint">{shotCheck}</p> : null}
        </section>

        <section className="hh-settings-group">
          <div className="hh-settings-group-title">桌面</div>
          <p className="hh-settings-hint">
            设为默认桌面后，按 HOME 键或开机会直接进 Aiboo。系统会弹一次确认，
            随时可以在这里或系统设置里换回其他桌面。
          </p>
          <div className="hh-settings-launcher">
            <span className="hh-settings-launcher-status">
              {launcherState == null
                ? '正在检查…'
                : launcherState.isDefault
                  ? '当前桌面：Aiboo ✓'
                  : '当前桌面：其他应用'}
            </span>
            <button className="hh-settings-launcher-btn" onClick={() => void handleLauncherAction()}>
              {launcherState?.isDefault ? '更改桌面' : '设为默认桌面'}
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
