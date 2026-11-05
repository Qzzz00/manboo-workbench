/**
 * 展示台（PRD §6）。
 *
 * ★这一版是**基于 holo 那套改**，不再自己重写一遍外壳。
 * 上一版我新写了时钟/音乐块/黄历/CSS，结果 holo 里**本来就能跑**的东西全丢了——
 * 口型同步、唱盘（封面/波形/歌词/手势）、Live2D 接线——然后一件件往回补，补一个漏一个。
 * 现在 Live2D 与仪表盘完全沿用 HoloApp / HoloDashboard 的接线与配置
 * （包括 enableMusicAnalyser:true——holo 在这台机器上能出声、嘴能动，就照它的来），
 * 只把「左下番茄钟」换成会话区、右侧追加余额/用量。
 *
 * 与 HoloApp 的差异只有三处，其余照抄：
 *  1. 不要登录页：展示台是没人操作的桌面设备（PRD §6.3）；
 *  2. 不要对话/语音：展示台只展示；
 *  3. 番茄钟 → 会话区，另加余额/用量（PRD §6.4 明确删番茄钟）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { HoloStage } from '../holo/HoloStage.tsx';
import { DisplayDashboard } from './DisplayDashboard.tsx';
import { loadHoloTheme, saveHoloTheme, toggleTheme, type HoloTheme } from '../holo/holoTheme.ts';
import { ParticleAvatar } from './ParticleAvatar';
import { DISPLAY_BACKGROUNDS, displayOrbSettings, isWideScreen, orbSignalsOf, particleModeOf, resolveDisplayLayout, resolveStageKind, stageBackdrop } from './displayStage';
import { nowPlayingText } from './nowPlaying';
import { useDisplayAppearance } from './useDisplayAppearance';
import { usePresence } from '../features/live2d/presence/usePresence.ts';
import { getAvatarById, getAvatarNeutralExpressionId } from '../features/live2d/avatarManifest.ts';
import { useDjMode } from '../hooks/useDjMode.ts';
import { autoLogin, type UserInfo } from '../lib/authStore.ts';
import { setAuthErrorHandler } from '../lib/apiClient.ts';
import { loadLastAvatarId } from '../lib/lastAvatarStore.ts';
import { boardCounts, familyGroups, quotaLines, type BoardState } from './displayBoard';
import { orbitSessions, quotaAccounts, syncLine } from './orbitBoard';
import { ORBIT_DESIGN_WIDTH, OrbitDashboard } from './OrbitDashboard';
import { resolveLiveUrl, useHostFeed, useLiveState } from './useLiveState';
import { avatarSelectMessage, isHostFeed, postToHost } from './hostFeed';
import { AvatarStage } from './AvatarStage';
import { emptyState } from './workbenchProtocol';
import { WorkbenchPairing } from './WorkbenchPairing';
import { demoMode, demoState } from './demoFixture';
import { useDoubleTap } from './useDoubleTap';
import './display.css';
import { djTrace } from '../screensaver/lib/djClient';

const noop = (): void => {};

/** 设计稿宽度。仪表盘的所有尺寸都按这个宽度写，再整体缩到真实视口。 */
const DESIGN_WIDTH = 1200;

/** 底图两张与切换规则挪到 displayStage.ts(`DISPLAY_BACKGROUNDS` / `stageBackdrop`),粒子那条路不铺图。 */
const BG_KEY = 'aiboo:display-bg-index';

export function DisplayApp() {
  // 账号态只影响个性化数据；电台接口是公开的，没登录也能放。留 setter 供 401 复位。
  const [, setAuthUser] = useState<UserInfo | null>(null);

  // 双击角色换装（day=DJ 黑装 / night=初始+外套），跟 holo 同一套，持久化。
  const [theme, setTheme] = useState<HoloTheme>(loadHoloTheme);
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'night') root.setAttribute('data-holo-theme', 'night');
    else root.removeAttribute('data-holo-theme');
  }, [theme]);
  const toggleHoloTheme = useCallback(() => {
    setTheme((t) => { const next = toggleTheme(t); saveHoloTheme(next); return next; });
  }, []);

  // 背景 + 配色方案：双击屏幕切换，持久化。
  const [bgIndex, setBgIndex] = useState<number>(() => {
    try {
      const raw = localStorage.getItem(BG_KEY);
      const n = raw === null ? 0 : Number(raw);
      return Number.isInteger(n) && n >= 0 && n < DISPLAY_BACKGROUNDS.length ? n : 0;
    } catch { return 0; }
  });
  const cycleBackground = useCallback(() => {
    setBgIndex((i) => {
      const next = (i + 1) % DISPLAY_BACKGROUNDS.length;
      djTrace('换背景 ' + i + ' → ' + next + ' scheme=' + DISPLAY_BACKGROUNDS[next].scheme);
      try { localStorage.setItem(BG_KEY, String(next)); } catch { /* 存不下就只当次生效 */ }
      return next;
    });
  }, []);

  /**
   * 形象位放什么(2026-09-22,Ben:「把 Live2D 形象换成旋转的粒子吧,后面我再给你对应的
   * Live2D 模型,再换上去」)。默认粒子球;`?avatar=<形象 id>` 走回原来那套 Live2D,
   * 一行没删(判定与换回的三步见 displayStage.ts 与 docs/交接-0922-展示台粒子球.md)。
   */
  const stage = useMemo(
    () => resolveStageKind(typeof window === 'undefined' ? '' : window.location.search, (id) => getAvatarById(id) !== undefined),
    [],
  );
  /** 底图(2026-09-30):粒子那条路不铺动漫房间图,恒深色;Live2D 那条路照旧两张双击切换。 */
  const background = useMemo(() => stageBackdrop(stage, bgIndex), [stage, bgIndex]);
  useEffect(() => {
    document.documentElement.setAttribute('data-display-scheme', background.scheme);
    if (background.url === null) document.documentElement.setAttribute('data-display-plain', '1');
    else document.documentElement.removeAttribute('data-display-plain');
    djTrace('配色已套用 data-display-scheme=' + background.scheme + ' bg=' + background.url);
  }, [background.scheme, background.url]);
  // Live2D 那一支要一个形象 id;粒子球那一支用不上它,但 DJ(电台声音/换装)仍按它取素材,所以照算。
  // 仓库不带模型(10-21):这台机器上一个形象都没有时是 null,DJ 只放声音、不换装。
  const avatarId = useMemo(() => {
    if (stage.kind === 'live2d') return stage.avatarId;
    const last = loadLastAvatarId();
    return last !== null && getAvatarById(last) ? last : null;
  }, [stage]);
  const avatar = useMemo(() => (avatarId === null ? undefined : getAvatarById(avatarId)), [avatarId]);
  const { presence, composed } = usePresence(avatar === undefined ? '' : getAvatarNeutralExpressionId(avatar));

  useEffect(() => {
    let alive = true;
    autoLogin()
      .then((user) => { if (user && alive) setAuthUser(user); })
      .catch(() => { /* 没账号态不影响展示与电台 */ });
    setAuthErrorHandler(() => setAuthUser(null));
    return () => { alive = false; };
  }, []);

  // ★DJ 配置与 holo 保持一致，不要自作主张改参数。
  // ★DJ 配置与 holo 逐字一致，一个参数都不要改。
  // 实证：只跑 holo（com.aiboo.tsv）时音乐正常（进度 02:00/05:25、歌词同步），
  // 说明设备与后端都没问题；我之前擅自改 enableMusicAnalyser / preferWebAudio
  // 反而把能跑的配置改坏了。要动这里，先拿 holo 做对照。
  const djView = useDjMode({
    open: true,
    sourceAvatarId: avatarId ?? '',
    onClosed: () => { /* 展示台恒电台，不退出 */ },
    enableMusicAnalyser: true,
  });

  const mode = useMemo(
    () => demoMode(typeof window === 'undefined' ? '' : window.location.search),
    [],
  );
  const demo = mode !== 'off';
  /**
   * 手机横屏(`?feed=host`,2026-09-30):状态与外观都由手机壳递进来,展示台不自己连 /live
   * (理由见 hostFeed.ts:手机不在同一个 Wi-Fi 时那条连不上,会话区就是一排灰灯)。
   */
  const hostMode = useMemo(() => isHostFeed(typeof window === 'undefined' ? '' : window.location.search), []);
  const host = useHostFeed(hostMode);
  const wsLive = useLiveState({ disabled: hostMode });
  const hostLive = useMemo(() => ({
    state: host.state ?? emptyState(),
    ringing: new Set<string>(),
    connected: host.state !== null && !host.state.stale,
  }), [host.state]);
  const live = mode === 'fixture'
    ? { state: demoState(), ringing: new Set<string>(), connected: true }
    : hostMode ? hostLive : wsLive;

  /**
   * 会话区与额度区(2026-09-30 横屏补齐):与 Mac 顶栏 / 额度面板同一份判据(displayBoard.ts)——
   * 「有哪几家」认 agent_registry,额度只画此刻真接上了的那几家。
   */
  const groups = useMemo(() => familyGroups(live.state, live.ringing), [live.state, live.ringing]);
  // 「今天/明天 11:33 重置」这类相对时间必须随时间推移重算。
  // 这台设备一开就是几天不关，额度几小时才变一次；若只在额度变化时重算，
  // 跨过午夜后会一直挂着昨天算出来的那句「明天 11:33」——真机上就是这么错的。
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNowTick(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const lines = useMemo(() => quotaLines(live.state, new Date(nowTick)), [live.state, nowTick]);
  const counts = useMemo(() => boardCounts(groups), [groups]);

  /**
   * 粒子球的参数:Mac 那份 appearance.json(GET /butler/appearance),与手机端同一份。
   * 拉不到就用核心默认值——球照样转,不白屏(appearanceFeed.ts 里逐条写了拉不到的几种情形)。
   * `displayOrbSettings`:中心光团一律关(同手机),Mac 上把自转调成 0 时仍给一档慢速自转(可推翻)。
   * 球的态照手机竖屏首页那一套判(displayStage.ts `orbSignalsOf`,2026-09-30),不再按会话数自己判。
   */
  // 手机壳那条路不自己拉(给一个空地址 = appearanceFeed 当场退默认值、不发请求),用壳递进来的那一份。
  const fetched = useDisplayAppearance(hostMode ? '' : resolveLiveUrl(), live.state.appearance_version);
  const baseSettings = host.settings ?? fetched.settings;
  const particleSettings = useMemo(() => displayOrbSettings(baseSettings), [baseSettings]);
  const particle = useMemo(() => particleModeOf(orbSignalsOf(live.state)), [live.state]);

  const playing = djView.dj.playing;


  // 双击分区（规则一句话：左列＝角色＝换装；其余＝换背景）。
  // 自己判定双击而不是用 dblclick——老 WebView 的 dblclick 要等第三次点击超时才派发。
  const onStageDoubleTap = useDoubleTap(toggleHoloTheme, '角色=换装');
  // 粒子那条路只有一种底(恒深色),双击空白不再换(换了也只是把 localStorage 里那个下标翻一下,屏上没变化)。
  const onFrameDoubleTap = useDoubleTap(stage.kind === 'particles' ? noop : cycleBackground, '空白=换背景');

  // 角色住在左列这个子区域里，原生分数必须以整屏为基准（见 Live2DStage.viewportSize），
  // 否则 anchorXFrac 按容器宽算出来、被原生按整屏宽应用，人会跑到屏幕中央。
  const [screenSize, setScreenSize] = useState(() => ({
    width: typeof window === 'undefined' ? 0 : window.innerWidth,
    height: typeof window === 'undefined' ? 0 : window.innerHeight,
  }));
  useEffect(() => {
    const onResize = () => setScreenSize({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  /**
   * 仪表盘按 1200 宽的设计空间排版，再整体缩到真实视口。
   *
   * 稿子（Figma node 2134-2）是 1200 宽画的，真机 CSS 视口只有 788
   *（1280 物理 ÷ DPR 1.625）。想让浏览器自己缩需要 `<meta viewport width=1200>`，
   * 但 Android WebView 默认 useWideViewPort=false，实测直接忽略该 meta
   *（真机读到 innerWidth 仍是 788）。打开那个开关要改六个 flavor 共用的 MainActivity，
   * 不值当。所以缩放放在这里做：CSS 里一律写稿子原值，缩放只此一处。
   */
  const designScale = useMemo(
    () => (screenSize.width > 0 ? screenSize.width / DESIGN_WIDTH : 1),
    [screenSize.width],
  );
  // 设计空间里的高度：真机 788×493 → 缩放 0.657 → 设计盒子 1200×750。
  // 稿子是 1200×800，所以竖向比稿子少 50px，那 50px 由中间的会话区（1fr）吸收。
  // 手机横屏那种宽扁屏走三栏(displayStage.ts `isWideScreen`)。
  const wide = isWideScreen(screenSize.width, screenSize.height);
  const designHeight = useMemo(
    () => (designScale > 0 ? screenSize.height / designScale : 750),
    [screenSize.height, designScale],
  );

  // 粒子球那一块(.dp-avatar:形象位上半,版位就是 Live2D 那一块)。
  const particleBall = (
    <div className="dp-avatar">
      <ParticleAvatar
        mode={particle.mode}
        notice={particle.notice}
        settings={particleSettings}
        theme={background.scheme}
      />
    </div>
  );
  // 滑到 / 点了哪个:当场换(不等壳回话),同时告诉壳存起来;壳递回来的 current 一到,以它为准。
  const [avatarChoice, setAvatarChoice] = useState<string | null>(null);
  const hostCurrent = host.avatars?.current;
  useEffect(() => { setAvatarChoice(null); }, [hostCurrent]);
  const selectAvatar = useCallback((id: string) => {
    setAvatarChoice(id);
    postToHost(avatarSelectMessage(id));
  }, []);

  /**
   * 第二套「环绕」(2026-10-01,手机 设置 › 声音与形象 › 展示台样式;`?layout=orbit`)。
   * 数据、音乐、形象舞台都是上面同一份,只换摆法;那台 1200×800 桌面展示台不带这个参数,走下面原来那套。
   */
  const layout = useMemo(() => resolveDisplayLayout(typeof window === 'undefined' ? '' : window.location.search), []);
  const orbitCards = useMemo(() => orbitSessions(live.state, live.ringing, new Date(nowTick)), [live.state, live.ringing, nowTick]);
  const orbitQuota = useMemo(() => quotaAccounts(live.state), [live.state]);
  const agentColors = useMemo(() => {
    const out: Record<string, string> = {};
    for (const e of (live.state as BoardState).agent_registry?.entries ?? []) if (e.color !== undefined) out[e.id] = e.color;
    return out;
  }, [live.state]);

  if (layout === 'orbit') {
    const scale = screenSize.width > 0 ? screenSize.width / ORBIT_DESIGN_WIDTH : 1;
    const received = hostMode ? host.state !== null : live.connected || !live.state.stale;
    const orb = (
      <div className="ob-orb">
        <ParticleAvatar mode={particle.mode} notice={particle.notice} settings={particleSettings} theme="dark" />
      </div>
    );
    return (
      <OrbitDashboard
        now={nowPlayingText({
          mode: djView.mode,
          status: djView.dj.status,
          playing: djView.dj.playing,
          segment: djView.dj.segment,
          ...(djView.dj.topics === undefined ? {} : { topics: djView.dj.topics }),
          currentTopicId: djView.dj.currentTopicId ?? null,
        })}
        playing={!!playing && !djView.dj.paused}
        onPlayPause={djView.dj.controls.playPause}
        cards={orbitCards}
        accounts={orbitQuota.accounts}
        hidden={orbitQuota.hidden}
        sync={syncLine({ stale: received && live.state.stale, received })}
        icons={host.icons}
        colors={agentColors}
        stage={host.avatars !== null ? (
          <AvatarStage
            items={host.avatars.items}
            current={avatarChoice ?? host.avatars.current}
            onSelect={selectAvatar}
            variant="center"
            particle={orb}
          />
        ) : orb}
        designScale={scale}
        designHeight={scale > 0 ? screenSize.height / scale : 393}
      />
    );
  }

  return (
    // 外层结构照抄 HoloApp：device-frame > app-shell > viewer-panel + 仪表盘。
    // 双击空白＝换背景；双击角色＝换装（viewer-panel 上 stopPropagation 把两者分开）。
    <div className="device-frame" onPointerUp={onFrameDoubleTap}>
      <div className="app-shell">
        {/*
          底图。Live2D 那条路上它由 Live2DStage(或原生 GL 层)画;粒子这条路上
          **没人画它**(holo.css 里 `:root[data-holo] .stage-bg { display:none }`,
          而 body 在非原生下被压成白色),不自己铺一层的话整屏是白的、暗色卡片全糊。
          所以这一层只在粒子那条路上出现,Live2D 那条路一个字没动。
          双击空白换底图照旧生效(配色 data-display-scheme 跟着翻)。
        */}
        {!demo && stage.kind === 'particles' && (
          <div className="dp-bg dp-bg--plain" aria-hidden="true" />
        )}
        <section
          className="viewer-panel"
          onPointerUp={(e) => { e.stopPropagation(); onStageDoubleTap(e); }}
        >
          {!demo && (stage.kind === 'particles' || avatar === undefined ? (
            /*
              手机横屏(壳递来了形象队列,2026-10-01):左栏是形象舞台 —— 左右滑换形象、加载中压暗转圈、点圆点出快速选择;
              当前是粒子球时舞台里画的还是原来那颗(.dp-avatar)。没有队列(那台 1200×800 桌面展示台)照旧只有粒子球。
            */
            host.avatars !== null ? (
              <AvatarStage
                items={host.avatars.items}
                current={avatarChoice ?? host.avatars.current}
                onSelect={selectAvatar}
                variant="column"
                particle={particleBall}
              />
            ) : particleBall
          ) : (
            <HoloStage
              avatar={avatar}
              presence={presence}
              costumeParamOverrides={composed.costumeParamOverrides}
              djView={djView}
              theme={theme}
              backgroundUrl={background.url ?? DISPLAY_BACKGROUNDS[0].url}
              viewportSize={screenSize}
            />
          ))}
        </section>

        {/* 2026-09-11:工作台不在本机且还没令牌时,显示配对框;其余情况不渲染。 */}
        {!demo && !hostMode && <WorkbenchPairing wsUrl={resolveLiveUrl()} connected={live.connected} />}

        <DisplayDashboard
          designScale={designScale}
          designHeight={designHeight}
          djMode={djView.mode}
          now={nowPlayingText({
            mode: djView.mode,
            status: djView.dj.status,
            playing: djView.dj.playing,
            segment: djView.dj.segment,
            ...(djView.dj.topics === undefined ? {} : { topics: djView.dj.topics }),
            currentTopicId: djView.dj.currentTopicId ?? null,
          })}
          onMode={djView.setMode}
          wide={wide}
          nowCover={playing?.pic_url ?? null}
          ncmId={playing?.ncm_id ?? null}
          getPositionMs={djView.dj.controls.getPositionMs}
          getDurationMs={djView.dj.controls.getDurationMs}
          playing={!!playing && !djView.dj.paused}
          analyser={djView.dj.musicAnalyser}
          onPlayPause={djView.dj.controls.playPause}
          onNext={djView.dj.controls.next}
          onPrev={djView.dj.controls.prev}
          groups={groups}
          stale={live.state.stale}
          counts={counts}
          lines={lines}
        />
      </div>
    </div>
  );
}
