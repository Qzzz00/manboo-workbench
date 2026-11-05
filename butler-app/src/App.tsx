/**
 * 壳:没登录 → 登录流程(login/LoginPage.tsx);登录了 → 竖屏(舞台 / 事项 / 设置)或横屏(展示台)。
 *
 * 2026-09-17(Ben:「手机上也需要有登录」):**现在没有账号体系**,所以手机上的「登录」=
 * 确认电脑端就绪 → 配对 → 引导。于是:
 *   - 没配对过进欢迎屏(不是一上来就一张扫码页);
 *   - 配对成功那一刻,引导没做完就直接进引导开场(docs/设计-引导流程.md v2);
 *   - **只有「退出登录」与令牌被撤销(401)才回欢迎屏**;电脑关机不算,那只是「电脑不在线」(见 StagePage 顶上那条)。
 * 深链 workbench://pair?… 冷启动与运行中都接,来了直接进配对屏,不让人先看一遍欢迎屏。
 *
 * 2026-09-24(卡 fix/phone-nav-back,维护者拍板):**首页是唯一主页**。底部标签栏拿掉;事项 / 资讯 / 设置 /
 * 对话记录 / 会议都是首页的下一级,左上角「‹」回首页;系统返回键在这一层接(nav/back.tsx):
 * 下一级 → 首页,首页 → 退到后台,电话里不挂断。
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { createTokenStore, preferencesStore, type Pairing, type TokenStore } from './api/tokenStore';
import { createAccountStore, type AccountRecord, type AccountStore } from './account/accountStore';
import { linkPairedPhone, phoneAccountLogout } from './account/phoneLogin';
import { createSettingsStore, DEFAULT_SETTINGS, type Settings, type SettingsStore } from './settings/settingsStore';
import { SettingsContext, useSettings } from './settings/SettingsContext';
import { createApiClient } from './api/client';
// 页面上出的错报给工作台(2026-09-25,卡 V):口子在 main.tsx 挂,这里把「往哪送」接上。
import { setPhoneErrorSink } from './api/reportClientError';
import { openSession, SessionContext, useSession, type Session } from './session';
import { RouteBanner } from './channel/RouteBanner';
import { LoginPage } from './login/LoginPage';
import { REPAIR_NOTICE, REVOKED_NOTICE, SIGNED_OUT_NOTICE } from './login/loginModel';
import { parsePairUrl, type PairTarget } from './pairing/pairUrl';
import { claimPairing, type ClaimInput } from './pairing/claim';
import { StagePage } from './stage/StagePage';
import { AvatarGalleryPage } from './avatars/AvatarGalleryPage';
import './avatars/avatars.css';
import { DisplayPage } from './display/DisplayPage';
import { InboxPage } from './items/InboxPage';
import { NewsPage } from './feed/NewsPage';
import { SettingsPage } from './settings/SettingsPage';
import { useAppearance, useLandscape, usePortraitSplit } from './hooks';
import { BackProvider, BackScope, useBackHandler, useSystemBack } from './nav/back';
import { BACK_PAGE, createBackStack } from './nav/backStack';
import { SubPage } from './nav/BackHeader';
import { PAGE_TITLES, paneShown, shellBackOf, type Page } from './nav/navModel';
import { useAvatar } from './live2d/useAvatar';
import { avatarLibrary } from './avatars/useAvatarLibrary';
import { avatarSourceOf } from './avatars/serverSource';
import { AvatarContext } from './live2d/AvatarContext';
import { afterPaired } from './onboarding/entry';
import { OnboardingCall } from './onboarding/OnboardingCall';
import { useIncoming } from './call/useIncoming';
import { IncomingCallPage } from './call/IncomingCallPage';
import { MissedCalls } from './call/MissedCalls';
import { MeetingPage } from './meeting/MeetingPage';
import type { MeetingController } from './meeting/meetingController';
import { setDeskPhoneMode } from './deskphone/deskPhone';
import { setHandoffPerfSender } from './brand/brandHandoff';
import type { InboxTarget } from './items/InboxPage';
import { CollabPage, type CollabTarget } from './collab/CollabPage';
import { CallsPage, HistoryPage, ReportsPage, type CallsTarget } from './items/RecordPages';
import { UpdatedToast } from './update/UpdatedToast';

const ONBOARDING_OPEN_KEY = 'butler.onboardingOpen';
function readFlag(key: string): boolean {
  try { return sessionStorage.getItem(key) === '1'; } catch { return false; }
}
function writeFlag(key: string, on: boolean): void {
  try { if (on) sessionStorage.setItem(key, '1'); else sessionStorage.removeItem(key); } catch { /* 存不了就只在内存里 */ }
}

/** 令牌被撤销时回欢迎屏说的那一句(人话在 login/loginModel.ts;这个名字留着给老用例与外部引用)。 */
export const TOKEN_EXPIRED_NOTICE = REVOKED_NOTICE;

export interface AppProps {
  tokenStore?: TokenStore;
  settingsStore?: SettingsStore;
  /** 账号登录态(2026-09-21)。测试注入内存实现;生产是 Capacitor Preferences。 */
  accountStore?: AccountStore;
  fetchImpl?: typeof fetch;
}

/**
 * 只靠账号登录、还没跟任何一台电脑配过对时,手上那份「配对」长什么样(2026-09-21)。
 *
 * 局域网那三样(地址、端口、设备令牌)这时候**根本不存在** —— 这台手机没见过那台电脑的局域网。
 * 于是给一个一定连不通的地址:直连当场失败(kind=network),routedClient 按它既有的规矩
 * 切到房间代理,业务代码一个字都不用改(channel/routedClient.ts 的文件头写的就是这条)。
 *
 * 为什么不给 undefined:整个 App 的「登录了没有」判的是 `pairing !== null`,
 * 把它改成可空要动会话、状态流、语音、通话每一处。**这一版不动那根柱子。**
 * 代价写在交接里:这种手机上 `/live` 那条 WebSocket 会一直连不上(每 5 秒重试一次),
 * 状态仍然靠轮询经房间拿得到。
 */
export function relayOnlyPairing(deviceId: string): Pairing {
  return { token: '', host: '127.0.0.1', port: 1, deviceId };
}

/** 深链:冷启动的 launch url + 运行中的 appUrlOpen。网页里读 location.hash 里的 pair 地址方便调试。 */
function useIncomingPairUrl(): PairTarget | null {
  const [target, setTarget] = useState<PairTarget | null>(null);
  useEffect(() => {
    let handle: { remove(): Promise<void> } | null = null;
    (async () => {
      try {
        const { App: CapApp } = await import('@capacitor/app');
        const launch = await CapApp.getLaunchUrl();
        if (launch?.url !== undefined) setTarget(parsePairUrl(launch.url));
        handle = await CapApp.addListener('appUrlOpen', (e) => setTarget(parsePairUrl(e.url)));
      } catch { /* 网页环境没有原生桥 */ }
      const fromHash = parsePairUrl(decodeURIComponent(window.location.hash.replace(/^#/, '')));
      if (fromHash !== null) setTarget(fromHash);
    })();
    const onHash = () => {
      const t = parsePairUrl(decodeURIComponent(window.location.hash.replace(/^#/, '')));
      if (t !== null) setTarget(t);
    };
    window.addEventListener('hashchange', onHash);
    return () => { void handle?.remove(); window.removeEventListener('hashchange', onHash); };
  }, []);
  return target;
}

export function App(props: AppProps) {
  const tokenStore = useMemo(() => props.tokenStore ?? createTokenStore(preferencesStore()), [props.tokenStore]);
  const accountStore = useMemo(() => props.accountStore ?? createAccountStore(preferencesStore()), [props.accountStore]);
  const settingsStore = useMemo(() => props.settingsStore ?? createSettingsStore(preferencesStore()), [props.settingsStore]);
  const [boot, setBoot] = useState<'loading' | 'ready'>('loading');
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** 下一次进登录页直接开扫码(首页「重新扫码配对」,2026-09-23)。 */
  const [startScan, setStartScan] = useState(false);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const incoming = useIncomingPairUrl();
  /**
   * 系统返回键(2026-09-24)。**整个 App 只装这一次**:开着的那一层先接(抽屉、下一级页、会议、通话……),
   * 谁都不接就退到后台。登录流程里今天没有哪一层登记,按返回同样是退到后台(以前是什么都不做)。
   */
  const backStack = useMemo(() => createBackStack(), []);
  useSystemBack(backStack);

  useEffect(() => {
    let alive = true;
    void Promise.all([tokenStore.load(), settingsStore.load()]).then(([p, s]) => {
      if (!alive) return;
      setPairing(p);
      setSettings(s);
      setBoot('ready');
    });
    return () => { alive = false; };
  }, [tokenStore, settingsStore]);

  const updateSettings = useCallback(async (patch: Partial<Settings>) => {
    const next = await settingsStore.update(patch);
    setSettings(next);
  }, [settingsStore]);

  const onUnauthorized = useCallback(() => {
    void tokenStore.clear();
    setNotice(TOKEN_EXPIRED_NOTICE);
    setPairing(null);
  }, [tokenStore]);

  /**
   * 「退出登录」= 解除配对 + 清本地凭证 + **账号那边也登出** + 回欢迎屏(2026-09-21)。
   * 只清局域网那份等于"看起来下线了,而那把中转设备令牌还在服务器上活着、还进得了房"。
   */
  const unpair = useCallback(async () => {
    await tokenStore.clear();
    await phoneAccountLogout(accountStore, props.fetchImpl);
    setNotice(SIGNED_OUT_NOTICE);
    setPairing(null);
  }, [tokenStore, accountStore, props.fetchImpl]);

  /**
   * 「重新扫码配对」(2026-09-23 第二轮从零重装):首页判出「电脑不认这台手机了 / 房里没有电脑」时那颗键。
   * 做的事与「退出登录」一样(清设备令牌 + 账号那边登出 —— 旧账号那把中转令牌留着,
   * 扫完新电脑之后还会领回旧账号那间房),区别只在**落到哪一屏**:直接进扫码、开相机。
   * 账号登出失败(没网)也照清本地:这一步不该卡住重新配对。
   */
  const repair = useCallback(async () => {
    await tokenStore.clear();
    await phoneAccountLogout(accountStore, props.fetchImpl).catch(() => accountStore.clear());
    setNotice(REPAIR_NOTICE);
    setStartScan(true);
    setPairing(null);
  }, [tokenStore, accountStore, props.fetchImpl]);

  const claim = useCallback((input: ClaimInput) => claimPairing({ ...input, ...(props.fetchImpl === undefined ? {} : { fetchImpl: props.fetchImpl }) }), [props.fetchImpl]);

  const onPaired = useCallback((p: Pairing) => {
    void tokenStore.save(p);
    setNotice(null);
    setStartScan(false);
    setPairing(p);
    /**
     * 配对那一刻顺手把这台手机加到电脑登录的那个账号下(2026-09-21)。
     * 拿到的是一把**自己的**中转设备令牌 —— 有了它,以后出门不用再回局域网。
     * **失败一律不吵**:电脑上还没登录账号、还是老版本的工作台,都会走到这里,
     * 而它们都不影响"在局域网里照常能用"(phoneLogin.ts 的 linkPairedPhone 里写了全文)。
     */
    void linkPairedPhone({
      direct: createApiClient({
        pairing: p,
        onUnauthorized: () => {},
        ...(props.fetchImpl === undefined ? {} : { fetchImpl: props.fetchImpl }),
      }),
      store: accountStore,
      deviceId: p.deviceId,
    }).catch(() => undefined);
    // 登录的最后一步是引导:没做完就直接进引导开场(设计-引导流程 v2「配对成功的那一刻事务官在手机上开口」)。
    // 借的是 Shell 那面 sessionStorage 旗子——它本来就是「引导页开着」的那一个,重挂也还在。
    if (settings.onboarding !== 'done') writeFlag(ONBOARDING_OPEN_KEY, true);
    void updateSettings(afterPaired(settings));
  }, [tokenStore, updateSettings, settings, accountStore, props.fetchImpl]);

  /**
   * 账号登录成功(2026-09-21)。这台手机可能从没见过任何一台电脑的局域网 ——
   * 那就给一份"只走房间"的配对(relayOnlyPairing),业务代码一个字不用改。
   * 已经配过对的手机保持原样:局域网在跟前时直连更快。
   */
  const onAccountLoggedIn = useCallback((account: AccountRecord) => {
    setNotice(null);
    setPairing(previous => previous ?? relayOnlyPairing(account.deviceId));
    if (settings.onboarding !== 'done') writeFlag(ONBOARDING_OPEN_KEY, true);
    void updateSettings(afterPaired(settings));
  }, [settings, updateSettings]);

  // 会话在 effect 里开、在 cleanup 里停:StrictMode 会把 effect 跑两遍,这样第一遍的状态流会被正确停掉。
  const [session, setSession] = useState<Session | null>(null);

  /**
   * **页面上出的错报给工作台**(2026-09-25,卡 V)。口子在 `main.tsx` 里就挂上了(比渲染还早),
   * 但那会儿还没有能说话的客户端 —— 会话一开出来把那只手接上,攒着的一次性冲出去。
   * 走 `session.client`(选好路的那个):在家直连 8791,出了局域网经房间代理
   * (channel-worker 白名单里放行了 `POST /client/error`)。失败一律吞掉 —— 绝不因为报错再报一次错。
   */
  /**
   * **从后台切回来就马上重新问一次**(2026-09-30):以前没有这一下,切回来要等下一拍轮询;
   * 期间一次失败就翻成「电脑不在线」。现在先回到「正在连接」,马上问。
   */
  useEffect(() => {
    if (session === null) return;
    let handle: { remove(): Promise<void> } | null = null;
    let alive = true;
    void (async () => {
      try {
        const { App: CapApp } = await import('@capacitor/app');
        // 切回前台也让路线复查一次(规格:切回前台发 tick):锁屏这段时间可能已经换了网络。
        const h = await CapApp.addListener('appStateChange', (st) => { if (st.isActive) { void session.feed.resume?.(); session.route?.driver.tick(); } });
        if (alive) handle = h; else void h.remove();
      } catch { /* 网页环境没有原生桥 */ }
    })();
    return () => { alive = false; void handle?.remove(); };
  }, [session]);

  useEffect(() => {
    if (session === null) { setPhoneErrorSink(undefined); return; }
    const client = session.client;
    setPhoneErrorSink(payload => client.json('/client/error', { method: 'POST', body: payload }));
    return () => setPhoneErrorSink(undefined);
  }, [session]);

  useEffect(() => {
    if (pairing === null) { setSession(null); return; }
    const opened = openSession({
      pairing, settings: settingsStore, onUnauthorized, unpair, repair, accountStore,
      ...(props.fetchImpl === undefined ? {} : { fetchImpl: props.fetchImpl }),
    });
    setSession(opened);
    /**
     * 会话换掉(重新配对、退出登录、令牌被撤)时**通道层一起拆**(2026-09-23 从零重装验收):
     * 以前只停了状态流,旧那条通道还拿着旧房间 —— 重新扫码之后手机仍守在旧房间、
     * 旧通话还挂在那里等旧房间的工人回话。拆了它,旧房间里这台手机就走了。
     */
    // 串联的 3 秒打点(2026-09-24 第五轮):会话开起来就送进电脑 8791 日志;送不到不吵。
    setHandoffPerfSender(perf => { void opened.client.json('/perf/handoff', { method: 'POST', body: perf }).catch(() => undefined); });
    return () => { setHandoffPerfSender(null); opened.feed.stop(); opened.channel.stop(); opened.outbox?.stop(); opened.route?.stop(); };
  }, [pairing, settingsStore, onUnauthorized, unpair, repair, accountStore, props.fetchImpl]);

  if (boot === 'loading' || (pairing !== null && session === null)) return <div className="ba-boot">事务官</div>;

  const settingsHandle = { settings, update: updateSettings };

  if (session === null) {
    return (
      <BackProvider stack={backStack}>
        <SettingsContext.Provider value={settingsHandle}>
          <LoginPage
            onPaired={onPaired}
            onAccountLoggedIn={onAccountLoggedIn}
            accountStore={accountStore}
            incoming={incoming}
            notice={notice}
            startScan={startScan}
            claim={claim}
          />
        </SettingsContext.Provider>
      </BackProvider>
    );
  }

  return (
    <BackProvider stack={backStack}>
      <SettingsContext.Provider value={settingsHandle}>
        <SessionContext.Provider value={session}>
          {/*
            按这一次配对的 device_id 挂(2026-09-23):重新扫码配对 = 一台新设备,整个壳从头挂一遍 ——
            旧的那通电话(还在等旧房间的工人回话)、旧的来电状态一起丢掉,不带进新配对里。
          */}
          <Shell key={session.pairing.deviceId} />
          {/*
            「已更新到 0.4.xx」(2026-10-03,卡 claude/phone-in-app-update 第 3 件)。
            挂在 Shell **外面**:它是整个 App 的一句招呼,不该跟着重新配对一起被丢掉。
            读 build.json 与上次记的比,一样就什么都不渲染(见 update/UpdatedToast.tsx)。
          */}
          <UpdatedToast />
        </SessionContext.Provider>
      </SettingsContext.Provider>
    </BackProvider>
  );
}

/** 会议控制器那一场还占不占着会议页(在录 / 暂停 / 在传 / 断了没收尾)。顺手开机一次(读账、接回还在录的那一场)。 */
function useMeetingActive(controller: MeetingController | undefined): boolean {
  useEffect(() => { void controller?.boot(); }, [controller]);
  const subscribe = useCallback((listener: () => void) => controller?.subscribe(listener) ?? (() => {}), [controller]);
  return useSyncExternalStore(subscribe, () => controller?.active() ?? false);
}

function Shell() {
  const landscape = useLandscape();
  /**
   * 此刻在哪一页(2026-09-24 起不再叫「标签」):`stage` 是首页,另外三页是它的下一级。
   * 会议、引导不在这里 —— 它们是整屏一页,各自一面旗子(下面 meeting / onboarding)。
   */
  const [page, setPage] = useState<Page>('stage');
  /**
   * 「从别的页要求开一通」那个数(2026-10-13,卡「播客页重做」)。资讯页深聊面板上那颗
   * 「打电话聊」按一下就往上推一个数,首页那一层(StagePage)认「变了」就开一通。
   * 不用布尔:她聊完挂断、又点第二条资讯要再打一通,布尔那一格已经是 true 了,推不动第二次。
   */
  const [callNow, setCallNow] = useState<number>();
  const goHome = useCallback(() => setPage('stage'), []);
  /** 折叠屏展开 / 平板竖屏:事项一栏常驻左边(只用来判断哪几格看得见,排布归 CSS)。 */
  const split = usePortraitSplit();
  // 引导页开着的标记放 sessionStorage:真机实测 Shell 偶发被重挂(原因未定位,见交接 0916 手机引导真机),
  // 重挂后引导页要还在——页面本身从工作台拿进度,重进就是「引导还没做完 · 接着聊」。App 被杀重开时 sessionStorage 已清,回主页卡片。
  const [onboarding, setOnboardingState] = useState(() => readFlag(ONBOARDING_OPEN_KEY));
  // 会议页(2026-09-21):和引导一样是**整屏一页**,不是第四个标签——开会时屏幕上不该有别的东西。
  // 不借 sessionStorage 那面旗子:会议不像引导有"进度",关了就是关了(录音在电脑上)。
  const [meeting, setMeeting] = useState(false);
  const setOnboarding = useCallback((open: boolean) => { writeFlag(ONBOARDING_OPEN_KEY, open); setOnboardingState(open); }, []);
  useEffect(() => { console.info('[butler] Shell mounted', { onboarding }); return () => { console.info('[butler] Shell unmounted'); }; }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const session = useSession();
  const { settings } = useSettings();
  const avatar = useAvatar(session, settings.avatarId);
  // 形象只从电脑上来(10-21):会话换了就告诉形象库去问这一台电脑上有哪些。
  useEffect(() => { void avatarLibrary().setSource(avatarSourceOf(session.voice)); }, [session]);
  const avatars = avatar.status === 'loading' ? [] : avatar.avatars;
  /**
   * 座机来电(2026-09-21)。挂在 Shell 上而不是舞台页里:电话响起来的时候他可能正在
   * 事项页、设置页、甚至横屏展示台上 —— **一通电话压得过一切**,那正是座机的意思。
   */
  /**
   * 2026-09-22 晚:**不再传座机模式**。收不收得到电话不该是一个开关的副作用 ——
   * useIncoming 从此 App 活着就常驻房间(它自己那段文件头写了全文)。
   */
  // 后台待机跟着设置里那一格走(2026-10-03,缺省开):开着才切到别的 App、锁屏时也接得到电话。
  const incoming = useIncoming(session, { standby: settings.ringStandby });
  /**
   * 会议在录(2026-10-09,卡「会后真机走通」)。录音挂在会话的会议控制器上,不挂在会议页上:
   * 电话一响,下面那几条来电 / 通话页照常压过一切、会议页被卸下,**录音照录**;挂断后这一格还亮着,
   * 就回到会议页(还是同一场)。App 被划掉又重开、前台服务还在录(或者录到一半断了、还有段没传完)时,
   * 也直接进会议页。
   */
  const meetingActive = useMeetingActive(session.meeting);
  /**
   * 来电页中间那颗球的参数(2026-09-22,Ben 真机:「中间的来电显示不是粒子球」)。
   * **和主界面同一份** —— 来自 Mac 的那一份外观(swarm/appearance.ts);
   * 还没拉到就是核心默认值,来电页自己会退到那一份,不为一份参数不画球。
   */
  const appearance = useAppearance(session.appearance);
  /**
   * **座机页去掉了**(2026-09-25,卡 feat/first-look-orb-top,维护者:「手机的不要这个什么所谓的座机页面,
   * 就显示首页就好了...多此一举」)。以前插上电(或看到座机话筒在线)就整屏换成大时钟 + 卡片,球缩成右上角一个点;
   * 现在充电、话筒在不在都是首页。座机主动打来的电话(上面 useIncoming)照旧 —— 那是通话,不是这块屏。
   *
   * 老版本开过「座机模式」的手机,原生那边可能还挂着「屏幕常亮 / 锁屏上显示」与那条常驻通知:
   * 进来时关一次(没有原生插件就什么都不发生)。来电那一下点亮屏幕走的是另一条(DeskPhonePlugin.wakeScreen),不受影响。
   */
  useEffect(() => { void setDeskPhoneMode(false).catch(() => undefined); }, []);
  /** 首页卡片点进事项页时要落在哪(2026-09-25):哪一段、哪一张。 */
  const [inboxTarget, setInboxTarget] = useState<InboxTarget | undefined>(undefined);
  const openInbox = useCallback((target?: InboxTarget) => { setInboxTarget(target); setPage('inbox'); }, []);
  /** 协作区(2026-10-24,卡「完整手机协作下级页」):从事项页进,带落点(目标/卡)。 */
  const [collabTarget, setCollabTarget] = useState<CollabTarget | undefined>(undefined);
  const openCollab = useCallback((target?: CollabTarget) => { setCollabTarget(target); setPage('collab'); }, []);
  /** 通话记录页;「最近一次通话」带着那一通进来就直接打开它(2026-10-01)。 */
  const [callsTarget, setCallsTarget] = useState<CallsTarget | undefined>(undefined);
  const openCalls = useCallback((callId?: string) => { setCallsTarget(callId === undefined ? undefined : { callId }); setPage('calls'); }, []);

  /**
   * ——— 系统返回键在壳这一层怎么走(2026-09-24,卡 fix/phone-nav-back)———
   *
   * 表在 nav/navModel.ts 的 shellBackOf:下一级 → 回首页;座机页上盖着的资讯先收、座机页本身回舞台;
   * 来电 / 已接 / 话筒那一通 → **接住但什么都不做**(挂断只靠挂断键,也不退到后台)。
   * 壳这一层是最低档(BACK_PAGE):页里开着的抽屉、详情、会议页、通话里的字幕面板都先于它。
   * 会议页、引导自己接;首页上谁都不接 → App 那一层退到后台。
   */
  const shellBack = shellBackOf({
    incoming: incoming.state.kind,
    meeting: meeting || meetingActive,
    onboarding,
    page,
  });
  useBackHandler(shellBack !== 'none', () => {
    if (shellBack === 'home') setPage('stage');
    // 'stay':电话压得过一切 —— 返回不挂断、不退后台。
  }, BACK_PAGE);

  /**
   * 电话在响:整屏就是来电页。**排在横屏判断之前** —— 外壳里那台机器可能是横着装的,
   * 横屏时弹出展示台而把电话藏在后面是这一整张卡最不该发生的事。
   */
  if (incoming.state.kind === 'ringing') {
    return (
      <IncomingCallPage
        call={incoming.state.call}
        onAnswer={() => { void incoming.answer(); }}
        onLater={() => { void incoming.later(); }}
        note={incoming.note}
        settings={appearance.preset.settings}
        // 粒子核心起不来时如实记一行(界面上不吵:铃响着的时候屏幕上该是电话,不是故障)。
        onOrbDegraded={(reason) => { console.info('[butler] 来电页的粒子球退回声纹球', { reason }); }}
      />
    );
  }
  /** 接起来了:和引导那一通同一个做法 —— 舞台页 + 通话态,只是这一通不发招呼。 */
  if (incoming.state.kind === 'answered') {
    return <StagePage incoming={{ callId: incoming.state.call.call_id, onExit: incoming.ended }} />;
  }
  /**
   * **话筒那一通**(2026-09-22 打进来的那半;2026-09-23 起**拨出去的那半走同一张页**)。
   * Ben 12:45 的原话:「打过来和打过去都应该是显示同一个页面。」
   *
   * 2026-09-28(维护者真机:「座机拿起来的通话页面和我正常从首页打出去的那套 UI 不一样,
   * 因为座机……根本没有粒子球」;更正:「准确的说,只有座机打出去的页面不是同一套」):
   * **这一路从此进的就是那张通话页** —— 舞台页的通话态(粒子球 + 球下字幕 + 同一组按键),
   * 和「她打来、他在手机上接起」那一路(上面 `answered`)是同一个组件、同一份 DOM。
   * 以前这里进的是另一张 `HandsetCallPage`,那才是 UI 两个样的根。
   *
   * 决策记录 2026-09-21「座机形态」照旧:提机之后音频走树莓派,**手机只显示字幕与按钮** ——
   * 所以传 `handset`(而不是 `incoming`):StagePage 据此**不激活 useCall**,不进房、不推麦克风,
   * 底部也不摆麦克风键(差异全写在 `useHandsetCall` 的 `elsewhere` 那一格里)。
   * 和上面两条一样排在横屏与别的页之前:一通电话压得过一切。
   */
  if (incoming.state.kind === 'handset') {
    return (
      <StagePage
        handset={{
          // 打进来那一通有事项;**他提机拨出去的那一通没有**(2026-09-23),这一格就缺席。
          ...(incoming.state.call === undefined ? {} : { call: incoming.state.call }),
          // 谁接的(工人在 `ring_end.by` / `call_state.by` 里明说的;老工人不带,那时按话筒说)。
          ...(incoming.state.by === undefined ? {} : { by: incoming.state.by }),
          // 从几点起(工人报的)。不知道就不写那半句、也不摆时长。
          ...(incoming.state.since === undefined ? {} : { since: incoming.state.since }),
          onHangup: () => { void incoming.hangup(); },
        }}
      />
    );
  }

  /*
   * ——— 横屏 = 展示台(2026-09-22,Ben 拍板)———
   *
   * 09-21「选题池」那张卡把横屏从 display-client 那个展示台 iframe 改成了同一个舞台页的横排,
   * 并把「要不要留一条路回去」留给 Ben 拍。09-22 真机上他的话是「横屏展示台没了」,
   * 拍的是**回到展示台**:转成横屏就回到 `display/DisplayPage.tsx`(嵌 public/display/ 那个页面)。
   * 「球 + 卡片」那套排法**只在竖屏用**,一个字没动。
   *
   * 这一版**不再是一条 `if (landscape) return …` 的早退**,而是舞台那一格里的一个三目
   * (见下面 `.ba-pane--stage`)。两个好处:
   *   1. **优先级白送**:来电页 / 已接通话 / 话筒那一通 / 会议页 / 引导 / 座机页全都排在这之前,
   *      它们照旧压得过横屏 —— 不用再靠"把横屏那条 if 放在谁后面"来维持顺序;
   *      尤其是会议页那条(转屏卸载会把录音停掉,见下一段),现在**结构上**不可能被横屏抢走。
   *   2. 事项 / 资讯 / 设置三页**横屏时照旧**:展示台只顶掉舞台那一格,不再顶掉整个壳。
   *      (09-21 之前那一版是整壳早退,横屏时连设置页都进不去。)
   */
  /**
   * 会议页**排在横屏判断前面**(2026-09-21)。手机开会时是扣在桌上的,很容易被转成横屏;
   * 排在后面的话一转屏 MeetingPage 就被卸载,卸载时那个 cleanup 会把录音停掉 ——
   * 一场会就这么没了,而屏幕上显示的是展示台,什么都不说。
   *
   * 2026-09-22:横屏回到展示台之后这一条**更要紧了**(横屏真的会换一整页)。
   * 现在它靠的不只是"排在前面":横屏判断已经挪进舞台那一格里,会议页是整屏早退,
   * 两者根本不在一个层级上 —— 开着会怎么转屏都不会碰到展示台。
   */
  if (meeting || meetingActive) return <MeetingPage onClose={() => setMeeting(false)} />;
  /**
   * 引导:2026-09-18 起是**一通电话**(舞台页 + 通话态,房里的工人接话),
   * 通话打不了时自动退回旧的文字引导页 —— 两种都在 OnboardingCall 里分流。开着时整屏就是它。
   */
  if (onboarding) return <OnboardingCall onClose={() => setOnboarding(false)} />;

  return (
    <AvatarContext.Provider value={avatar}>
      {/*
        `data-landscape` 只是**把方向写在 DOM 上**:排布本身由 CSS 的
        `@media (orientation: landscape)` 认(见 stage/stageCards.css),这一条是给
        用例和截图时一眼看出"此刻算横屏还是竖屏",不参与任何布局计算。
      */}
      <div className="ba-shell" data-landscape={landscape}>
        {/*
          在家 / 出门要她看一眼的那两句(局域网 M4):「这是你常用的网络吗」、通话中换了网络「点一下回拨」。
          切换本身不打扰;没有路线(网页里)就整条不出现。
        */}
        {session.route !== undefined && (
          <RouteBanner route={session.route} onCallBack={() => { setPage('stage'); setCallNow(Date.now()); }} />
        )}
        {/*
          **没有底部标签栏了**(2026-09-24,卡 fix/phone-nav-back,维护者拍板)。09-17 舞台页那张卡给
          事项 / 设置页留着一条标签栏「好回来」,而首页上看不到它、系统返回又不接 —— 进了设置只能点底部栏回来。
          现在每个下一级页顶上一条返回头(nav/BackHeader.tsx 的 SubPage),系统返回走 nav/back.tsx。
          每一格包一层 BackScope:藏起来的那一格里开着的东西不接返回。
        */}
        <main className="ba-shell__main" data-page={page}>
          {/* 折叠屏展开(宽竖屏)时 CSS 把事项列表并排放在舞台旁,见 styles.css 的断点;不做机型特判。 */}
          <section className="ba-pane ba-pane--stage" hidden={page !== 'stage'}>
            <BackScope active={paneShown('stage', page, split)}>
              {/*
                未接来电那张卡压在舞台上面。点一条回拨 = 让工作台再排一通(不是手机自己拨)。
                **收起来由它自己管**(2026-09-22):「清空」发给工作台,台账变了它自己回来——
                以前这儿有一个 `missedOpen`,按一下「知道了」就再也不出来了,而那本台账
                只增不减,下次开 App 九条又回来。
              */}
              {/*
                2026-09-25 晚(卡 fix/phone-home-card-fit,统筹小米真机):**竖屏下这张卡挪进舞台页、球的下面,收成一行**
                (StagePage 的 `missed`)—— 以前它在球上面一件一行地铺开,长标题还把整页撑宽。横屏展示台上照旧是这一条薄横条。
              */}
              {landscape && (
                <MissedCalls
                  log={incoming.log}
                  onCallBack={entry => incoming.callBack({ reason: entry.reason, item_id: entry.item_id, title: entry.title })}
                  onClear={incoming.clearMissed}
                />
              )}
              {/*
                **横屏就是展示台**(2026-09-22 Ben 拍板);竖屏还是那颗球 + 四块卡片。
                两边共用外面这一格,于是未接来电那条薄横条(上面那个 `MissedCalls`,横屏下由
                `.ba-pane--stage > .ba-missed` 压成不占流的一条)**在展示台上也照样压一条** ——
                同一份组件、同一条规则,不为展示台另做一份。
                这一条 Ben 没说过,是这张卡替他定的:**可推翻**(要它别出现,把 `MissedCalls`
                挪进下面竖屏那一支即可,展示台这一支一个字不用动)。

                `page === 'stage' &&` 不能省:这一格在别的页开着时只是 `hidden`,里面的东西
                **照样挂着**。竖屏那一支挂的是舞台页(它本来就要一直在:状态流、语音、通话都在它身上),
                而展示台是一个 iframe —— 里头是 Live2D + WebGL + 一条自己的 /live,
                藏在设置页背后空转是白烧电。同资讯那一格的做法(`{page === 'news' && …}`)。
              */}
              {landscape ? (page === 'stage' && <DisplayPage />) : (
                <StagePage
                  missed={{
                    log: incoming.log,
                    onCallBack: entry => incoming.callBack({ reason: entry.reason, item_id: entry.item_id, title: entry.title }),
                    onClear: incoming.clearMissed,
                  }}
                  onStartOnboarding={() => setOnboarding(true)}
                  onOpenSettings={() => setPage('settings')}
                  onOpenInbox={openInbox}
                  onOpenNews={() => setPage('news')}
                  {...(callNow === undefined ? {} : { callNow })}
                  onOpenAvatars={() => setPage('avatars')}
                  onOpenReports={() => setPage('reports')}
                  onOpenHistory={() => setPage('history')}
                  onOpenCalls={openCalls}
                  onOpenMeeting={() => setMeeting(true)}
                />
              )}
            </BackScope>
          </section>
          <section className="ba-pane ba-pane--inbox" hidden={page !== 'inbox'}>
            <BackScope active={paneShown('inbox', page, split)}>
              <SubPage title={PAGE_TITLES.inbox} onBack={goHome}><InboxPage {...(inboxTarget === undefined ? {} : { target: inboxTarget })} onOpenCollab={openCollab} /></SubPage>
            </BackScope>
          </section>
          {/* 协作区(2026-10-24):事项页的下一级,目标/事项/频道;返回沿壳规则回首页。 */}
          <section className="ba-pane ba-pane--collab" hidden={page !== 'collab'}>
            <BackScope active={paneShown('collab', page, split)}>
              <SubPage title={PAGE_TITLES.collab} onBack={goHome}>
                {page === 'collab' && <CollabPage {...(collabTarget === undefined ? {} : { target: collabTarget })} onOpenItem={(taskId) => openInbox({ taskId })} />}
              </SubPage>
            </BackScope>
          </section>
          {/* 资讯(2026-09-21):**只在这一页开着时才挂**——它一挂上就会去拉 /feed,
              而那是一天只变一次的东西,没必要在别的页上先拉一遍。 */}
          <section className="ba-pane ba-pane--news" hidden={page !== 'news'}>
            {page === 'news' && (
              <SubPage title={PAGE_TITLES.news} onBack={goHome}>
                {/*
                  资讯页深聊面板上那颗「打电话聊」(2026-10-13,卡「播客页重做」):
                  **通话本体在首页那一层**(StagePage 的 CallOverlay),所以这里只做两件事 ——
                  回首页、把 `callNow` 往上推一个数(StagePage 认「变了」就开一通)。
                  横屏下首页是展示台、StagePage 整个不挂,那时这颗键**不给**(传 undefined),
                  面板上它会灰掉并写明原因 —— 画一颗点了没反应的键比没有更坏。
                */}
                <NewsPage {...(landscape ? {} : { onCall: () => { setPage('stage'); setCallNow(Date.now()); } })} />
              </SubPage>
            )}
          </section>
          {/* 从事项页搬出来的三页(2026-10-01):只在开着时才挂(各家对话一挂上就去读各家的记录文件)。 */}
          <section className="ba-pane ba-pane--reports" hidden={page !== 'reports'}>
            {page === 'reports' && <SubPage title={PAGE_TITLES.reports} onBack={goHome}><ReportsPage /></SubPage>}
          </section>
          <section className="ba-pane ba-pane--history" hidden={page !== 'history'}>
            {page === 'history' && <SubPage title={PAGE_TITLES.history} onBack={goHome}><HistoryPage /></SubPage>}
          </section>
          <section className="ba-pane ba-pane--calls" hidden={page !== 'calls'}>
            {page === 'calls' && <SubPage title={PAGE_TITLES.calls} onBack={goHome}><CallsPage {...(callsTarget === undefined ? {} : { target: callsTarget })} /></SubPage>}
          </section>
          {/* 形象陈列与下载(2026-10-01):只在这一页开着时才挂。 */}
          <section className="ba-pane ba-pane--avatars" hidden={page !== 'avatars'}>
            {page === 'avatars' && <SubPage title={PAGE_TITLES.avatars} onBack={goHome}><AvatarGalleryPage /></SubPage>}
          </section>
          <section className="ba-pane ba-pane--settings" hidden={page !== 'settings'}>
            <BackScope active={paneShown('settings', page, split)}>
              {/*
                2026-09-27(卡 SZ2):返回头**由设置页自己摆** —— 它现在有分组子页与两条座机流程,
                顶上那一条写的名字要跟着层走(以前这儿写死「设置」,进了六步配网流程屏上还是「设置」)。
                从设置里打开引导:先回到首页再开 —— 引导那一页的「‹ 主页」/ 返回落在首页,不落回设置。
              */}
              <SettingsPage avatars={avatars} onBack={goHome} onOpenAvatars={() => setPage('avatars')} onOpenOnboarding={() => { setPage('stage'); setOnboarding(true); }} />
            </BackScope>
          </section>
        </main>
      </div>
    </AvatarContext.Provider>
  );
}
