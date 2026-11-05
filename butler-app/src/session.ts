/**
 * 配对成功之后的「会话」:一份令牌 + 一个客户端 + 一条状态流 + 语音接口 + 通道层。
 * 整个 App 只有这一处知道令牌;界面组件从 SessionContext 拿到的都是已经带好令牌的函数。
 *
 * 2026-09-17:`client` 不再是「直连 8791」那一个,而是 **routedClient** ——
 * 局域网里优先直连(快),连不上自动切到 LiveKit 房间让 Mac 上的工人代理(见 channel/routedClient.ts)。
 * 业务代码(stateFeed / voice / call / items / onboarding …)一个字都不用改:它们只见 `ApiClient` 这个接口。
 * 直连那一份仍然留着,而且**只由通道层自己用** —— 房间凭证是 8791 签的,取凭证只能走直连。
 */
import { createContext, useContext } from 'react';
import { Capacitor } from '@capacitor/core';
import { createApiClient, type ApiClient } from './api/client';
import { createStateFeed, FEED_OFFLINE_GRACE_MS, type StateFeed } from './api/stateFeed';
import { asrOfflineText, createVoiceApi, type VoiceApi } from './api/voice';
import { createCallApi, type CallApi } from './api/call';
import { createAppearanceFeed, type AppearanceFeed } from './swarm/appearance';
import { createWbchChannel, type WbchChannel } from './channel/channel';
import { createWbchCredentialStore } from './channel/credentialStore';
import { createWbchRoutedClient, wbchNetworkChanges, type WbchRoutedClient } from './channel/routedClient';
import { createPhoneRoute, type PhoneRoute } from './channel/phoneRoute';
import { preferencesStore, type KeyValueStore, type Pairing } from './api/tokenStore';
import { createAccountStore, type AccountStore } from './account/accountStore';
import { createRelayRoomSource, phoneIdentityOf } from './account/roomFromRelay';
import { createAgentIcons } from './agents/agentIconsApi';
import type { AgentIconStore } from './agents/agentIcons';
import type { SettingsStore } from './settings/settingsStore';
import type { MeetingController } from './meeting/meetingController';
import { createMeetingControllerFor } from './meeting/meetingSetup';
import { SEND_OUTBOX_KEY, createSendOutbox, type SendOutbox } from './outbox/sendOutbox';
import { baseUrlOf } from './pairing/pairUrl';

/** 待发箱多久自己补一次(有没送到的才真发;没有就是空转一下)。 */
const OUTBOX_PUMP_MS = 30_000;

export interface Session {
  pairing: Pairing;
  /** 选好路的那个:局域网直连 / 经房间代理。业务代码只用它。 */
  client: WbchRoutedClient;
  /**
   * **只直连 8791 的那一份**(2026-09-21 会议模式)。绝大多数地方都该用上面的 `client`;
   * 会议录音是例外,而且是**故意**的例外:录音默认只在这台手机与这台电脑之间走(09-27 已拍板),
   * 经房间代理等于把一整场会的音频推给中转。所以没同意的那一场只用它,出了局域网就攒在手机上,回家再传;
   * 她这一场点了「现在经中转服务器传」才交给 `client`(2026-10-09,见 meeting/meetingApi.ts)。
   */
  direct: ApiClient;
  /**
   * 会议控制器(2026-10-09,卡「会后真机走通」):录音的生命挂在会话上,不挂在会议页上 ——
   * 来电页压上来、会议页被卸下,录音照录。**可缺**:老的测试假 Session 不带它。
   */
  meeting?: MeetingController;
  /**
   * 待发箱(2026-10-12,卡「手机交代只执行一次」;outbox/sendOutbox.ts):交代那一句先落盘带请求号再发,
   * 没送到的留着,开 App、网络变了、每 30 秒自动补发。**可缺**:老的测试假 Session 不带它(useSendItem 就地起一个只在内存里的)。
   */
  outbox?: SendOutbox;
  feed: StateFeed;
  voice: VoiceApi;
  /** 通话模式(2026-09-17):进房凭证 / 通话状态 / 挂断后的通话记录。 */
  call: CallApi;
  /** 通道层(2026-09-17):房间凭证、进房、字幕、文件。 */
  channel: WbchChannel;
  /**
   * 在家 / 出门(2026-10-21,局域网 M4):路线驱动与它的那几样。**可缺**:网页里调试、用例、老的假 Session 没有它
   * (那时照老规矩:直连优先、不通走房间)。
   */
  route?: PhoneRoute;
  /** 外观(2026-09-16):继承 Mac 的那一份粒子配置。 */
  appearance: AppearanceFeed;
  /**
   * 各家的 logo(2026-09-26,卡 LG3:「每家的 logo-icon 要显示在手机客户端上」)。**可缺** ——
   * 老的测试假 Session 不带它;缺席时每一处名字前就是卡 Q 那颗色点(见 agents/AgentIcon.tsx 那条退路),
   * 不报错、不空白。
   */
  agentIcons?: AgentIconStore;
  settings: SettingsStore;
  /**
   * 账号登录态(2026-09-22 起挂在这儿)。**可缺** —— 老的测试假 Session 不带它,
   * 而真正必须有它的只有一处:设置 → 座机 → 添加座机,那一步要拿账号的会话令牌
   * 去中转换一张**给座机的**设备令牌。缺席时那条流程如实说「先登录一次」。
   */
  account?: AccountStore;
  /** 解除配对(本机只删令牌;工作台那边的记录由维护者在设置里解除)。 */
  unpair(): Promise<void>;
  /**
   * 重新扫码配对(2026-09-23):同「退出登录」,但直接落到扫码页、开相机。
   * **可缺**:老的测试假 Session 不带它,首页那时退回 `unpair`。
   */
  repair?(): Promise<void>;
}

export interface OpenSessionInput {
  pairing: Pairing;
  settings: SettingsStore;
  onUnauthorized: () => void;
  unpair: () => Promise<void>;
  /** 见 Session.repair。 */
  repair?: () => Promise<void>;
  fetchImpl?: typeof fetch;
  /** 房间凭证存哪儿。测试注入内存实现;生产是 Capacitor Preferences。 */
  kv?: KeyValueStore;
  /** 测试注入现成的通道层(这样测试不会碰到 livekit-client)。 */
  channel?: WbchChannel;
  /**
   * 账号登录态(2026-09-21)。有它 + 有设备令牌时,房间凭证**直接向中转领**,
   * 不再依赖局域网里的 8791 —— 这就是「出门随时进房」。缺省与 kv 同一处存储。
   */
  accountStore?: AccountStore;
  /**
   * 路线(局域网 M4)。缺省:原生 App 里开(要原生网络回调认网络),网页 / 用例里不开(照老规矩)。
   * 传 `false` 强制不开;用例要测路线就传一份现成的。
   */
  route?: PhoneRoute | false;
}

/** 等第一次判在家 / 出门落地最多多久(毫秒)。判在家要 0.8 秒探测,没确认的网络上判出门是当场的。 */
export const ROUTE_SETTLE_WAIT_MS = 2500;

export function openSession(input: OpenSessionInput): Session {
  const kv = input.kv ?? preferencesStore();
  // 提成一个变量(2026-09-22):以前它只在通道层里用一次,现在「添加座机」也要它,
  // 而那一处拿到的必须是**同一个** store —— 两份各读各的 Preferences 迟早不一致。
  const accountStore = input.accountStore ?? createAccountStore(kv);
  /**
   * 在家 / 出门(局域网 M4)。注入了现成通道层的(用例)不开:路线要和通道层同一份票。
   */
  const route: PhoneRoute | undefined = input.route === false || input.channel !== undefined
    ? undefined
    : input.route ?? (Capacitor.isNativePlatform()
      ? createPhoneRoute({ pairing: input.pairing, kv, accountStore, ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }) })
      : undefined);
  const direct: ApiClient = createApiClient({
    pairing: input.pairing,
    onUnauthorized: input.onUnauthorized,
    // 在家时直连驱动判到的那台(Mac 换了地址、mDNS 找回来的);不在家时这一份不会被用到。
    ...(route === undefined ? {} : { baseUrl: () => route.driver.http().url ?? baseUrlOf(input.pairing) }),
    ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
  });
  const channel = input.channel ?? createWbchChannel({
    direct,
    store: createWbchCredentialStore(kv),
    relay: createRelayRoomSource({
      store: accountStore,
      // 只认这一次配对那台设备的账号记录(见 roomFromRelay.ts 的 deviceId)。
      ...(input.pairing.deviceId === '' ? {} : { deviceId: input.pairing.deviceId }),
      ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
    }),
    onUnauthorized: input.onUnauthorized,
    /**
     * 存着的房间凭证必须是**这一次配对**的(2026-09-23 从零重装验收):重新扫码之后
     * device_id 是新的,身份对不上的那张是上一次(往往是重装前)留下的,进去就是旧房间。
     * relayOnlyPairing 的 deviceId 就是账号那边的 device_id,两条路拼出来是同一个身份。
     */
    ...(input.pairing.deviceId === '' ? {} : { expectedIdentity: phoneIdentityOf(input.pairing.deviceId) }),
    ...(route === undefined ? {} : { routing: route.routing }),
  });
  route?.attach(channel);
  const client = createWbchRoutedClient({
    direct,
    remote: () => channel.remote(),
    // 回到局域网就把房间放掉(通话那一份持有不受影响):按需进房,不常驻。
    onBackToDirect: () => { void channel.releaseRemote().catch(() => {}); },
    // 刚出家门(Wi-Fi 切到移动网络)那一下:家里的地址回到「没确认」,别让请求挂到系统超时(2026-09-25,卡 S)。
    networkChanges: wbchNetworkChanges,
    // 在家 / 出门由路线驱动说(局域网 M4):不在家就不碰直连;在家直连慢就让它复查。
    ...(route === undefined ? {} : {
      directBase: () => route.driver.http(),
      settled: () => route.driver.settled(ROUTE_SETTLE_WAIT_MS),
      onSlowDirect: () => route.driver.tick(),
    }),
  });

  // 连续失败满 10 秒才说「电脑不在线」,之前写「正在连接」(2026-09-30,维护者:「一上来先显示电脑不在线,每次都以为坏了」)。
  const feed = createStateFeed({
    client,
    pairing: input.pairing,
    offlineGraceMs: FEED_OFFLINE_GRACE_MS,
    // `/live` 只在家时连(连驱动判到的那台);出门只轮询,轮询经房间。
    ...(route === undefined ? {} : { liveBase: () => route.driver.http().url }),
  });

  /**
   * 待发箱:开 App 那一下补一次(上一次被杀时没送到 / 发到一半的),网络变了补一次,之后每 30 秒一次。
   * 补发带的是落过盘的那个请求号,电脑那头办过的不办第二次(workbench-plugin/src/server/clientKeys.ts)。
   */
  const outbox = createSendOutbox({
    kv,
    client,
    ...(input.pairing.deviceId === '' ? {} : { storageKey: `${SEND_OUTBOX_KEY}:${input.pairing.deviceId}` }),
    autoPump: { everyMs: OUTBOX_PUMP_MS, networkChanges: wbchNetworkChanges },
    // 老工作台不认请求号:不自动补(补了可能办两次),留给她点「重发」。
    canAutoResend: () => feed.get().state.client_keys === true,
  });
  // 连上了(或刚认出这台电脑认请求号)那一下就补,不等下一个 30 秒。
  let outboxReady = false;
  feed.subscribe(() => {
    const snap = feed.get();
    const ready = snap.connected && snap.state.client_keys === true;
    if (ready && !outboxReady) void outbox.pump().catch(() => {});
    outboxReady = ready;
  });

  const appearance = createAppearanceFeed(client);
  void appearance.refresh();
  // /state.appearance_version 变了(Mac 上改了参数)就重新拉——快照本来就在轮询 / 推送,不另起定时器。
  feed.subscribe(() => { appearance.notice(feed.get().state.appearance_version); });
  return {
    pairing: input.pairing,
    client,
    direct,
    feed,
    // 识别「连不上」那一句按此刻知道的说细一点:手机没网 / 电脑不在房里 / 不认这台手机(2026-09-25,卡 S)。
    voice: createVoiceApi(client, {
      offlineText: () => asrOfflineText({
        ...(typeof navigator === 'undefined' || typeof navigator.onLine !== 'boolean' ? {} : { online: navigator.onLine }),
        ...(channel.presence === undefined ? {} : { presence: channel.presence() }),
      }),
    }),
    call: createCallApi(client),
    meeting: createMeetingControllerFor({ kv, direct, routed: client, networkChanges: wbchNetworkChanges }),
    outbox,
    channel,
    ...(route === undefined ? {} : { route }),
    appearance,
    // 各家的 logo(卡 LG3):走选好路的那个客户端 —— 清单在外面也问得到,图片只在局域网取。
    agentIcons: createAgentIcons(client),
    settings: input.settings,
    account: accountStore,
    unpair: input.unpair,
    ...(input.repair === undefined ? {} : { repair: input.repair }),
  };
}

export const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (session === null) throw new Error('SessionContext 没有提供');
  return session;
}
