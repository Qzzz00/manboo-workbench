/**
 * 舞台页 = 手机端的主界面(2026-09-17 拍板,Ben 原话:「手机端的 UI 界面也得改改,现在底部的对话框那种不太合适,
 * 我比较喜欢 Grok 的暗色,就是字幕形式,平时不显示对话内容,点击一个 icon 之后,才会显示」)。
 *
 * 整屏纯黑;粒子事务官居中(约屏宽 60%,与 Mac 同一份核心、同一份外观);球下面一到两行字幕(captionModel.ts);
 * 对话记录**默认不显示**,点右上角「记录」才从底下升起来(复用那份气泡列表 ThreadList)。
 *
 * 底部按 Ben 修正版的口径(决策记录「2026-09-17 · 手机主界面:两种状态的底部键」)分两种状态:
 *   - **不通话时**:一个撑满底部的输入框(见 StageComposer)。2026-09-24 维护者改过一次(决策记录
 *     「手机首页输入框:通话键收进输入框、按住说话单独一颗」):左边那颗通话键收进输入框右下角 ——
 *     没内容时发送键就是通话键;按住说话是它左边那颗麦克风键;输入框本身只管打字。
 *   - **通话中**:三个键——麦克风(收音开关)、挂断、字幕(见 call/CallOverlay)。
 *
 * 通话是这一页的一种状态,不是另起一屏:**球还是正中那一颗**,只是形态跟着通话走(useCall 给 stageMode),
 * 挂断就回到待命。所以这页同时持有「有没有在通话」和「配没配通话供应商」。
 *
 * 2026-10-03(卡「手机各家最近会话固定入口」):「各家最近的对话」在首页上多一条**不带任何条件**的入口
 * (维护者:「给他一个固定的入口」)。当天下午那张卡(「首页侧边小图标」)把它和「未接来电」一起
 * **从主列搬到球那一栏右边那一列小图标上**(维护者:「未接来电和各家的最近对话换个地方放,做成小图标放到侧边吧,
 * 而且现在的我还点击不到」)—— 「点不到」的根因在 avatars/avatars.css 那一段(形象区漏出球那一格、
 * 压在那两行上),交接在 docs/交接-1003-手机首页侧边小图标.md。
 *
 * 2026-10-03 傍晚(卡「首页两卡 + 一排图标」= 维护者看过示意图后拍的**方案 B**):
 * 「只保留正在办和待确认两个是卡片,其他都和前面一样做成 icon 就 OK……中间的球球还是要大的,
 * 这个事情是要适配 Live2D 的显示空间,省出来的空间 Live2D 也能放大。」于是这一页从上到下是
 * 球 / Live2D 形象区 → 字幕 → **球下一排五颗图标**(未接来电 · 各家最近的对话 · 今天要做 ·
 * 最近一次通话 · 资讯;右上角那一列并进了这一排,只留一处)→ **两张卡并排各占一半**(正在办 / 等你确认)
 * → 输入条。球那一格是 `flex: 1`,卡片区从三行掉到一行省出来的高度全归它;球自己跟着格子长大
 * (avatars/avatars.css 那条 `height: 100%`),Live2D 本来就跟着容器走。
 * 见 HomeRail.tsx、stage/homeRail.css 与 docs/交接-1003-手机首页两卡一排图标.md。
 *
 * 2026-09-17 晚(通道层):最顶上多一条**细横幅**说此刻是「直连 / 远程 / 未连接」——
 * 出了局域网请求会自动改走 LiveKit 房间让 Mac 上的工人代理(见 channel/routedClient.ts),
 * 切换是自动的,**只显示、不弹窗**(Ben 的口径)。记录面板里多一个「发文件」。
 */
import { meetingPlanNeedsLook } from '../meeting/MeetingPrepPanel';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { StageIcon } from './icons';
import { useSession } from '../session';
import { useAppearance, useFeed } from '../hooks';
import { PhoneBehindBanner } from '../update/PhoneBehindBanner';
import { useSettings } from '../settings/SettingsContext';
import { buildThread, mergePending } from '../chat/chatModel';
import { useSendItem } from '../chat/useSendItem';
import { sessionComposerApi } from '../composer/composerApi';
import { itemBody, type ComposerDraft } from '../composer/composerModel';
// 事务官问你的话、要你批的事(2026-09-25,卡 M;维护者点名的 bug):「等你确认」那一格点开是同样的问题与选项。
// 以前要批的那几行摆在输入框正上方(卡 F),现在一起进「等你确认」—— 同电脑球下那一区,也不挤球。
import { PhoneApprovalAsk, PhoneQuestionAsk, PhoneSessionAsk } from '../asks/AskCards';
// 各家的 logo(2026-09-26,卡 LG3):「另外 N 件等你确认」里别家会话那一行。
import { AgentIcon, AGENT_ICON_SIZE_SMALL } from '../agents/AgentIcon';
import { answerApprovalScoped, answerAsk, answerQuestion, answerSession, dismissSessionAsk, readApprovalKeys } from '../asks/asksApi';
import { useSpeak } from '../chat/useSpeak';
// 免打扰时段不出声(2026-09-26,卡 QH):判断在服务端 /state.quiet,这里只读结论 + 说人话。
import { quietActive, quietHushLabel, quietWhyText } from '../chat/quietVoice';
// 第一份真快照到了没有(卡 QH,统筹拍板「冷启动不念旧回答」):见下面 speakNewReplies 那一处。
import { snapshotArrived, type WorkbenchState } from '../api/protocol';
import { channelShouldRecheckRoom } from '../api/call';
import { ThreadList } from '../chat/ThreadList';
const ButlerStage = lazy(() => import('../live2d/ButlerStage').then((m) => ({ default: m.ButlerStage })));
import { Orb } from '../live2d/Orb';
import { useAvatarState } from '../live2d/AvatarContext';
import { ParticleStage } from '../swarm/ParticleStage';
import { PortraitAvatar } from '../avatars/PortraitAvatar';
import { signalsFromState, stageModeOf } from '../swarm/orbState';
import { VOICE_UNAVAILABLE_TEXT, type AsrResult } from '../api/voice';
import { CALL_ENTRY_LABEL, CALL_UNAVAILABLE_TEXT } from '../call/callModel';
import { useCall } from '../call/useCall';
// 话筒那一通(2026-09-28,座机通话页统一):同一张通话页,状态摆成同一份 handle。
import { useHandsetCall } from '../call/handsetCall';
import { missedShownCount, type IncomingCall } from '../call/incomingModel';
import type { CallClient } from '../call/rtcCall';
// 通话那一层连着火山 Web SDK 那个大包(SDK 自己也是动态 import 的),这里再切一刀:不打电话就不加载。
const CallOverlay = lazy(() => import('../call/CallOverlay').then((m) => ({ default: m.CallOverlay })));
import { dismissOnboardingBanner, onboardingBannerDismissed, onboardingEntryText, onboardingEntryVisible } from '../onboarding/entry';
import { CAPTION_MAX, CAPTION_TIMING, answerCaptionLines, answerCaptionOf, captionLinesOf, captionPhaseAt, revealedText } from './captionModel';
// ★ 「刚办完 · 结果一句话」那一条(2026-10-04,卡 `claude/answer-comes-to-her`)。
import { FreshResults } from './FreshResults';
import { freshResultRows } from './stageCardsModel';
import { useAnswerNotice } from './useAnswerNotice';
import { StageComposer } from './StageComposer';
import { StageCards } from './StageCards';
import { MissedCalls, type MissedCallsProps } from '../call/MissedCalls';
// 引导落地(2026-09-24 晚;09-25 放进卡 A 的五卡首页):单子等他点头时在「等你确认」那一格置顶,点开是整张单子(下一级页)。
import { SETUP_TITLE, SetupCard, SetupReceipt } from '../materialize/SetupCard';
import { applyMaterialize } from '../materialize/materializeApi';
import type { StageCardTarget } from './stageCardsModel';
import { agentTitle, askSessionOf, glancePodcast, latestCall as latestCallOf, otherConfirms, otherConfirmsTitle, otherWaiting, todayTasks, waitingRows, type WaitingRow } from './stageCardsModel';
import { useNewsGlance } from './useNewsGlance';
// 点哪件开哪件(2026-09-28,卡 UX):首页点了某一行,这一页只摆那一件。
import { focusedAskKeys } from '../asks/asksModel';
import { Opened, type InboxTarget } from '../items/InboxPage';
/**
 * 「等你确认」那张卡下面那一段:它刚才在干什么(2026-10-04,卡 `claude/ask-with-context`)。
 * 读会话最近几轮那条路全仓只有这一份 —— 事项页点开一条会话用的也是它。
 */
import { AskRounds } from '../items/SessionRounds';
import { useChannel } from '../channel/useChannel';
import { DESKTOP_CONNECTING_BANNER, DESKTOP_OFFLINE_BANNER } from '../login/loginModel';
import type { WbchFileSinkDeps } from '../channel/fileSink';
import { wbchKindText, wbchTransferLine } from '../channel/devices';
import { cardsViewOf, relinkNotice, staleCardsLabel } from './linkHealth';
import { stageStrong } from '../fx/fxModel';
import { useBackHandler } from '../nav/back';
import { BackHeader } from '../nav/BackHeader';
import { LOG_TITLE, RECENT_SESSIONS_TITLE, TRANSFERS_TITLE } from '../nav/navModel';
// 球下那一排小图标 + 未接来电那一块(2026-10-03,卡「首页两卡 + 一排图标」)。样式在它自己那个文件里。
import { HomeRail, RAIL_MISSED_NONE_TEXT } from './HomeRail';
// 手机从电脑取文件(2026-09-25,卡 J):取文件那张卡、进度那一行、收到的文件那一栏。
import { FileAskCard } from '../files/FileAskCard';
import { FileProgressLine, ReceivedFiles } from '../files/ReceivedFileList';
import type { FileAsk } from '../files/fileFetch';
// 通话中把视频弹到眼前(2026-10-12,周三演示「出图进可灵」那条链路的末尾)。
import { inCallVideoOffer, playableFileSrc } from '../files/inCallVideo';
import { CallVideoPopup } from '../call/CallVideoPopup';

export interface StagePageProps {
  /**
   * 引导模式(2026-09-18,Ben:「引导部分的 UI……不是通话模式吗」):这一页**一进来就是通话态**,
   * 房里的工人换上引导那套提示接话。挂断 = 暂停引导,回主页(onExit)。
   * 传了它的时候底部永远是通话那三个键,不摆输入框与通话入口。
   */
  onboarding?: { resume: boolean; onExit: () => void };
  /**
   * **她主动打来的那一通**(2026-09-21,座机响铃)。他在来电页上按了「接起」、
   * 工人那边已经开口了,这一页同样**一进来就是通话态** —— 只是不发那句招呼
   * (开场白是「我打给你是因为…」,两句一起说就是两个声音抢话)。
   * 挂断 = 这通电话完了(onExit 回主页 / 回来电台账)。
   */
  incoming?: { callId: string; onExit: () => void };
  /**
   * **座机页上按了「打给事务官」**(2026-09-22)。和上面两条同一个做法 —— 这一页一进来
   * 就是通话态;区别是它**照常发那句招呼**(那就是一通他主动打的普通电话,不是她打来的),
   * 所以这里除了「一进来就在通话里」以外什么都不改。挂断走 `onExit`(回座机页)。
   */
  autoCall?: { onExit: () => void };
  /**
   * **从别的页要求开一通**(2026-10-13,卡「播客页重做」:资讯页深聊面板上那颗「打电话聊」)。
   *
   * 这一页在竖屏下是**一直挂着的**(状态流、语音、通话都在它身上),所以不能靠
   * `autoCall` 那条「一进来就在通话里」—— 那一格只在挂上那一刻读一次。
   * 这里收一个**数字**:它变了就开一通。认的是「变了」而不是「有值」,所以
   * 横竖屏来回切(这一页重挂)不会凭空再打一通。
   */
  callNow?: number;
  /**
   * **话筒那一通**(2026-09-28,座机通话页统一)。维护者原话:「座机拿起来的通话页面和我正常从
   * 首页打出去的那套 UI 不一样,因为座机……根本没有粒子球」。以前座机那一路进的是另一张页
   * (`call/HandsetCallPage.tsx`),于是同一件事两条路两个样;现在**走这同一张通话页**。
   *
   * 和上面三条的区别只有一样:**这台手机不是那个说话的人** —— 通话音频走树莓派那只话筒
   * (决策记录 2026-09-21「座机形态」),所以这一路**不激活 `useCall`**:不进房、不要麦克风权限、
   * 不推音轨。屏上那份状态由 `call/handsetCall.ts` 的 `useHandsetCall` 摆成同一份 handle,
   * 形态差异写在它的 `elsewhere` 那一格里(不摆麦克风键 + 说清声音在哪一台上)。
   *
   * 挂断 = 这台手机上按的那一下(`onHangup` → `useIncoming.hangup`);
   * 话筒放回去那一下不经这里 —— 工人广播 `ring_end{hung_up}`,`useIncoming` 自己收掉这一屏。
   */
  handset?: {
    call?: IncomingCall;
    by?: 'handset' | 'phone';
    since?: number;
    onHangup: () => void;
  };
  onStartOnboarding?: () => void;
  /** 左上角小齿轮:去设置页(不放在底部,别挡球)。 */
  onOpenSettings?: () => void;
  /** 形象陈列与下载(2026-10-01)。 */
  onOpenAvatars?: () => void;
  /**
   * 去事项页。记录面板里的「事项」不带目标;首页卡片整张点下去带着「落在哪一段 / 哪一张」(2026-09-25)。
   */
  onOpenInbox?: (target?: InboxTarget) => void;
  /**
   * 从事项页搬出来的三页(2026-10-01,docs/梳理-1001-手机事项页.md):记录面板里各一颗;
   * 「最近一次通话」那张卡也去通话记录,带着那一通。
   */
  onOpenReports?: () => void;
  /**
   * 「各家最近的对话」那一页。2026-10-03(卡「手机各家最近会话固定入口」)起**这一页在首页上另有一条不带条件的入口**,
   * 不只在记录面板里;当天下午(卡「首页侧边小图标」)那条入口从主列里一行改成了球那一栏边上那一列里的一颗
   * (`HomeRail`)—— 理由见下面画它那一处。
   */
  onOpenHistory?: () => void;
  /** 通话记录页;带上那一通的编号(老纪要卡就是卡的 id)就直接打开它。 */
  onOpenCalls?: (callId?: string) => void;
  /** 记录面板里的「资讯」:去资讯流(2026-09-21)。 */
  onOpenNews?: () => void;
  /**
   * 去会议页。**底部那两样一个字没动** —— Ben 的口径是不通话时底部只有「通话键 + 输入框」,
   * 所以 2026-09-21 它的入口是记录面板里那一行,不在舞台上加第三颗键。
   * 2026-10-04(卡「首页会议图标」)起**首页那一排上多一颗**(最后一颗):记录面板里那条路
   * 要先拉开记录、再进对话记录页、再在顶上那排小链接里找 —— 藏了三层,维护者在手机上找不到。
   * 记录面板里那颗照旧留着,是第二条路(同另外几颗)。
   */
  onOpenMeeting?: () => void;
  /** 语音「没配」之后多久再探一次(缺省 60 秒;测试用)。 */
  voiceRetryMs?: number;
  /** 字幕时值(测试用;缺省见 CAPTION_TIMING)。 */
  captionHoldMs?: number;
  captionFadeMs?: number;
  captionMsPerChar?: number;
  /** 测试注入假的通话客户端 / 调快计时;生产两个都不传。 */
  createCallClient?: () => CallClient;
  callTickMs?: number;
  /** 测试注入:收到文件时不碰 Capacitor 的文件系统。 */
  fileSink?: WbchFileSinkDeps;
  /**
   * 未接来电(2026-09-25 晚,卡 fix/phone-home-card-fit):**在球下面、卡片上面收成一行**,点开才铺那几行。
   * 以前 App 把它摆在舞台页上面一件一行地铺开(统筹小米真机:太占地方、长标题撑宽整页)。
   * 已经取消 / 办完的事引起的未接不挂出来。
   */
  missed?: Pick<MissedCallsProps, 'log' | 'onCallBack' | 'onClear'>;
}

/** 字幕活着的时候按这个间隔重算一次「该显示到哪儿了」。 */
const TICK_MS = 120;

/** 通话入口的三种样子。没配与掉线说的话不一样——一个要去 Mac 上配,一个等会儿再试。 */
type CallEntry =
  | { state: 'unknown' }
  | { state: 'ready' }
  | { state: 'off', note: string };

export function StagePage(props: StagePageProps = {}) {
  const { onboarding, incoming, autoCall, handset, onStartOnboarding, onOpenSettings, onOpenAvatars, onOpenInbox, onOpenNews, onOpenMeeting, onOpenReports, onOpenHistory, onOpenCalls, voiceRetryMs, createCallClient, callTickMs } = props;
  const session = useSession();
  const channel = useChannel(session, props.fileSink === undefined ? {} : { sink: props.fileSink });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { settings } = useSettings();
  const feed = useFeed(session.feed);
  const appearance = useAppearance(session.appearance);
  const { pending, send, resend, dismiss, choose, choosing } = useSendItem(session);
  const mouthRef = useRef(0);
  const avatar = useAvatarState();
  const avatarId = avatar.status === 'ready' ? avatar.manifest.id : undefined;
  /**
   * 免打扰时段(2026-09-26,卡 QH):**服务端算好的一处判断**,这一页只读结论,不自己算时段。
   * 时段里不自动朗读 —— 字幕、气泡、卡片照常出,只是不念;他自己点「重听」照念(那是他要听)。
   */
  const quiet = feed.state.quiet;
  const hushed = quietActive(quiet);
  /**
   * 此刻在一通电话里(引导模式一挂上就在通话里 = 进引导就自动进房,不用他再点一次「通话」)。
   * **摆在朗读那一层前面**是因为它要喂给 `useSpeak`:通话中不自动念新回复、挂断那一刻停下
   * (2026-10-13,卡 E,维护者:「挂断后手机不许再出声;通话中也不该自顾自念」)。
   */
  const [inCall, setInCall] = useState(onboarding !== undefined || incoming !== undefined || autoCall !== undefined || handset !== undefined);
  const speaker = useSpeak(session, settings.voiceEnabled, avatarId, mouthRef, voiceRetryMs, quiet, inCall);
  const [log, setLog] = useState(false);
  /**
   * 挑一台设备发(2026-09-21)。选好文件之后弹这一层 —— 房里可能有两台电脑和另一台手机,
   * 「发文件」不再等于「发给那台 Mac」。只有一台在线时也照样问一句:
   * 一秒钟的确认,换的是「文件到底去了哪」这件事永远说得清。
   */
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  /** 记录面板开着时显示传输记录。 */
  const [records, setRecords] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  /**
   * 「我照你说的摆好了」那一页开着没有(2026-09-25 放进卡 A 的五卡首页):单子等他点头时在「等你确认」那一格置顶,
   * 整张卡点下去就是这一页(整屏的下一级页,顶上「‹」回首页,系统返回同样回首页)。
   */
  const [setupOpen, setSetupOpen] = useState(false);
  /** 「事务官问你 / 要你批」那一页开着没有(2026-09-25,卡 M):「等你确认」里有这几件时,整张卡点下去先到这一页。 */
  const [asksOpen, setAsksOpen] = useState(false);
  /**
   * 点哪件开哪件(2026-09-28,卡 UX):首页「等你确认」里点了某一行,这一页**只摆那一件**
   * (`question:<id>` / `approval:<id>` / `session:<家>/<会话>`,就是「等你」那一堆里的 key)。
   * 整张卡点下去、或者按了「还有 N 件」→ 缺席,照旧整列摆。
   */
  const [asksFocus, setAsksFocus] = useState<string | undefined>(undefined);
  /**
   * 「等你确认」那张卡上点了「打开整段对话」(2026-10-04,卡 `claude/ask-with-context`):
   * 哪一家、哪条会话。摆的是**事项页点开一条会话那一张**(`items/InboxPage.tsx` 的 `Opened`)——
   * 完整对话、附件、在那条会话里直接说一句,一样都不另写。缺席 = 没在看。
   */
  const [askSession, setAskSession] = useState<{ agent: string; sessionId: string } | null>(null);
  const [micLevel, setMicLevel] = useState(0);
  const [typing, setTyping] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  const thread = useMemo(() => mergePending(buildThread(feed.state), pending), [feed.state, pending]);
  /**
   * 朗读新回复。第二个参数是**第一份真快照到了没有**(2026-09-26,卡 QH,统筹拍板「冷启动不念旧回答」):
   * 界面挂出来那一刻 `feed.state` 还是 `emptyState()`,那一拍不许让朗读那一层把空集当成「已有的」——
   * 不然真快照一到,他上一次交代那件事的回答就被念一遍。理由与落法见 chat/useSpeak.ts 文件头。
   */
  const arrived = snapshotArrived(feed.state);
  useEffect(() => { speaker.speakNewReplies(thread, arrived); }, [thread, speaker, arrived]);

  const [bannerDismissed, setBannerDismissed] = useState(() => onboardingBannerDismissed());
  useEffect(() => {
    if (toast === null) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);
  /**
   * 单子落好了(不管是这里点的、电脑上点的,还是电话里说的「可以」):那一句回执飘一下(3.5 秒)。
   * 那一页开着时不飘 —— 页上已经写着了。只认「刚才还在等 / 正在落 → 落好了」这一下,打开 App 时早就落好的不飘。
   */
  const setupStatus = useRef<{ id: string; status: string } | undefined>(undefined);
  useEffect(() => {
    const view = feed.state.materialize;
    const before = setupStatus.current;
    setupStatus.current = view === undefined ? undefined : { id: view.id, status: view.status };
    if (view === undefined || view.status !== 'applied' || before === undefined || before.id !== view.id || before.status === 'applied') return;
    if (!setupOpen && view.result !== undefined) setToast(view.result.line);
  }, [feed.state.materialize, setupOpen]);
  // 记录面板一打开就滚到最新那条。
  useEffect(() => {
    if (!log) return;
    const el = logRef.current;
    if (el !== null && typeof el.scrollTo === 'function') el.scrollTo({ top: el.scrollHeight });
  }, [log, thread.length]);

  /** 「把 X 发我」打完之后那张卡(卡 J):电脑没建事项,回了找到的是哪几个。 */
  const [fileAsk, setFileAsk] = useState<FileAsk | null>(null);
  /**
   * **电脑主动推过来的那张卡**(2026-10-04,卡 `claude/phone-file-send-loop`):
   * 事务官找到她要的文件之后由它推过来,她**不用再说一遍**。
   * 手上已经有一张(她刚说的那句话回的)时不顶掉 —— 先把眼前这张办完。
   */
  const pushedAsk = channel.pushedAsk;
  const shownAsk = fileAsk ?? pushedAsk;
  const [pullingOffer, setPullingOffer] = useState<string | null>(null);
  const submit = useCallback(async (text: string) => {
    const r = await send(text);
    if (r.fileAsk !== undefined) setFileAsk(r.fileAsk);
    if (!r.ok && r.error !== undefined) setToast(r.error);
  }, [send]);
  // 打字发的和按住说的走同一条路径:一句话 = 一条事项。
  const onComposerText = useCallback((text: string) => { void submit(text); }, [submit]);
  /** 统一输入框(2026-09-24):正文 + 谁来办 + 附件 + 引用一起交。 */
  const composerApi = useMemo(() => sessionComposerApi(session), [session]);
  const onComposerDraft = useCallback(async (draft: ComposerDraft) => {
    const { text, ...extra } = itemBody(draft);
    const r = await send(String(text ?? ''), extra);
    if (r.fileAsk !== undefined) setFileAsk(r.fileAsk);
    if (!r.ok && r.error !== undefined) setToast(r.error);
    return r.ok;
  }, [send]);

  const voiceOff = !settings.voiceEnabled || (speaker.availability !== 'unknown' && !speaker.availability.available);
  const voiceNote = !settings.voiceEnabled ? '语音已关(设置里打开)' : speaker.availability !== 'unknown' && !speaker.availability.available ? speaker.availability.note : undefined;

  // ——— 通话 ———
  /**
   * 启动时问一次本机后端配没配通话供应商:没配就把「通话」键灰掉并说一句人话,
   * **不让他点进去再看错误栈**(Ben 的要求;这段口径原来挂在 ChatPage 上,那页已经没人走了)。
   */
  const [callEntry, setCallEntry] = useState<CallEntry>({ state: 'unknown' });
  // `inCall` 在上面朗读那一层前面声明(它要喂给 useSpeak)。
  /**
   * 别的页要求开一通(2026-10-13):**数字变了才开**。初值记进 ref,
   * 所以这一页重挂那一下不会把上一次的要求又当成一次新的(见 `callNow` 那段注释)。
   */
  const callNowSeen = useRef(props.callNow);
  useEffect(() => {
    if (props.callNow === undefined || props.callNow === callNowSeen.current) return;
    callNowSeen.current = props.callNow;
    setInCall(true);
  }, [props.callNow]);
  const callProvider = settings.callProvider;
  useEffect(() => {
    let alive = true;
    // 走哪条链路就问哪条链路的状态:LiveKit 问 /channel/status(要 key/secret + 服务器 + 工人三样齐),
    // 火山那条退路还是问 /rtc/status。问错一条会把「能打」说成「不能打」。
    const ask = callProvider === 'volc' ? session.call.status() : session.call.channelStatus();
    void ask.then((status) => {
      if (!alive) return;
      /**
       * **电脑换房了就跟着搬**(2026-09-27,卡 RM ③)。
       *
       * 电脑登录之后会把自己挂到账号下,那一刻中转算出来的房间名从「名字那一间」换成
       * 「账号那一间」;而手机手上那张进房凭证是 7 天级的,还守着旧房间 —— 电话打不进来,
       * 而屏上什么都不会说(它进得了那间旧房,只是里头没人)。所以这一问回来的房间名
       * 跟手上那张不一样时,**丢掉旧的重取**(不需要重新配对,`recheckRoom` 会连着搬过去)。
       *
       * **这一问本身问不到时也去核对**(2026-09-28,卡 PH):问 status 走的正是旧房间里的
       * 代理,电脑搬走之后那间房里没人应 —— 只等「问到房间名」的话就永远等不到。
       * 判据全文在 `channelShouldRecheckRoom`。
       */
      if (channelShouldRecheckRoom(status, session.channel.credential()?.room)) {
        void session.channel.recheckRoom?.().catch(() => undefined);
      }
      if (status.configured) { setCallEntry({ state: 'ready' }); return; }
      // LiveKit 那条:**说服务端那句原话**。它说的是「差哪一样」(没配 key / 服务器不应答 / 工人没跑),
      // Ben 要照着这句知道去 Mac 上做什么。火山那条口径不动(2026-09-17 底部键那张卡定的):
      // 问到了就说一句统一的「电脑上还没配通话供应商」,没问到才转达掉线那句。
      const note = callProvider === 'volc'
        ? (status.checked ? CALL_UNAVAILABLE_TEXT : (status.reason ?? CALL_UNAVAILABLE_TEXT))
        : (status.reason ?? CALL_UNAVAILABLE_TEXT);
      setCallEntry({ state: 'off', note });
    });
    return () => { alive = false; };
  }, [session, callProvider, channel.mode]);
  // 挂断:平时回舞台待命;引导时是「暂停引导」,回主页(进度在 onboarding.json,下次接着做)。
  const onExit = onboarding?.onExit ?? incoming?.onExit ?? autoCall?.onExit;
  const onCallEnded = useCallback(() => {
    setInCall(false);
    onExit?.();
  }, [onExit]);
  const phoneCall = useCall({
    /**
     * **话筒那一通不激活它**(2026-09-28):这台手机这会儿不是那个说话的人,
     * 激活就等于进房、要麦克风权限、推一路音轨 —— 房里两只耳朵抢同一段话。
     * 它照旧被无条件调用(hooks 的规矩),只是 `active` 为假时整个 hook 什么都不做。
     */
    active: inCall && handset === undefined,
    ...(onboarding === undefined ? {} : { onboarding: { resume: onboarding.resume } }),
    ...(incoming === undefined ? {} : { incoming: { callId: incoming.callId } }),
    ...(avatarId === undefined ? {} : { avatarId }),
    ...(createCallClient === undefined ? {} : { createClient: createCallClient }),
    ...(callTickMs === undefined ? {} : { tickMs: callTickMs }),
    onEnded: onCallEnded,
  });
  /**
   * 话筒那一通的同一份 handle(`call/handsetCall.ts`)。**同一张页、同一层 CallOverlay**,
   * 差异只在这份 handle 的 `elsewhere` 那一格。
   */
  const handsetCall = useHandsetCall({
    active: handset !== undefined,
    ...(handset?.call === undefined ? {} : { call: handset.call }),
    ...(handset?.by === undefined ? {} : { by: handset.by }),
    ...(handset?.since === undefined ? {} : { since: handset.since }),
    onHangup: handset?.onHangup ?? (() => {}),
    ...(callTickMs === undefined ? {} : { tickMs: callTickMs }),
  });
  const call = handset === undefined ? phoneCall : handsetCall;
  /**
   * **通话中那段视频自己弹出来**(2026-10-12,维护者:「看到视频之后推到手机端上,再打个电话过来,
   * 并且可以在手机上(通话过程中)看到视频。播放器以弹窗形式弹到通话页面上,给个关闭的 icon。」)。
   *
   * 电话里她腾不出手去点那张「找到了什么」的卡(通话中那张卡本来也不摆),所以**只有视频**
   * 在通话中自己取、自己弹;别的照旧等挂了电话再摆那张卡(判断在 files/inCallVideo.ts)。
   * 取的是**同一条路**(`channel.pull`:在家直连、出门经房间,带同一张「收到了」的回执)。
   * 一个单号只弹一次(她关掉的不要回来)。
   */
  const [callVideo, setCallVideo] = useState<{ offer: string; name: string; src?: string; error?: string } | null>(null);
  const callVideoShown = useRef<Set<string>>(new Set());
  /**
   * **一通结束就把这个播放器收掉**(2026-10-13,卡 E)。10-13 下午维护者再打出去时,上一通的那个弹窗还在 ——
   * 原来它只在他点 × 时才清,而这一页在两通之间**不重挂**(拨出去那条路:同一个 StagePage,只是 `inCall` 翻了一下)。
   * 所以挂断 / 对方挂 / 来电未接(这一层跟着卸掉)都在这儿归零,新一通也从干净的屏开始。
   *
   * 摆在下面那个「取片子」的 effect **前面**:同一拍里先清上一通的,再认这一通该弹的那一张。
   */
  useEffect(() => { setCallVideo(null); }, [inCall]);
  useEffect(() => {
    if (!inCall) return;
    const ask = channel.pushedAsk;
    if (ask === null) return;
    const picked = inCallVideoOffer([ask], callVideoShown.current);
    if (picked === null) return;
    callVideoShown.current.add(picked.hit.offer);
    setCallVideo({ offer: picked.hit.offer, name: picked.hit.name });
    // 这张卡这就办了:挂了电话别再把同一张摆回来。
    channel.clearPushedAsk();
    void channel.pull(picked.hit).then((result) => {
      setCallVideo((now) => {
        if (now === null || now.offer !== picked.hit.offer) return now;
        if (!result.ok) return { ...now, error: result.error };
        const src = playableFileSrc(result.file);
        // 经房间那条路字节随后才到:这儿先接着说「正在取」,下面那个 effect 接手。
        return src === undefined ? now : { ...now, src };
      });
    }).catch((error: unknown) => {
      setCallVideo((now) => (now === null || now.offer !== picked.hit.offer
        ? now
        : { ...now, error: error instanceof Error && error.message !== '' ? error.message : '电脑没说原因' }));
    });
  }, [inCall, channel.pushedAsk, channel.pull, channel.clearPushedAsk]);
  /**
   * 经房间那条路(出门在外):字节由 `onFile` 收、存好之后挂在 `noticeFile` 上 ——
   * 等着的那个弹窗就在这儿接上地址。不是视频的不碰。
   */
  useEffect(() => {
    const file = channel.noticeFile;
    if (file === null || file.kind !== 'video') return;
    const src = playableFileSrc(file);
    if (src === undefined) return;
    setCallVideo((now) => (now === null || now.src !== undefined ? now : { ...now, src }));
  }, [channel.noticeFile]);
  /*
   * 系统返回键(2026-09-24,卡 fix/phone-nav-back,维护者拍板):
   *   - **通话中接住、什么都不做** —— 划一下返回不许把电话挂了(防误挂;挂断只靠挂断键),也不退到后台
   *     (退到后台麦克风会被系统收走,电话就成了单向的)。字幕面板开着时由它先收(CallOverlay)。
   *     唯一的例外是**没接通**(红键已经变成「关闭」):那时没有电话可挂,返回 = 按「关闭」。
   *   - 对话记录那一页、选设备那一层开着:先收它。
   */
  useBackHandler(inCall, () => { if (call.failed && !call.ending) call.hangup(); });
  useBackHandler(log && !inCall, () => setLog(false));
  useBackHandler(setupOpen && !inCall, () => setSetupOpen(false));
  useBackHandler(asksOpen && !inCall, () => { setAsksOpen(false); setAsksFocus(undefined); });
  // 整段对话那一页开着:系统返回先收它,再按一次才收「等你确认」那一页(卡 fix/phone-nav-back 那条规矩)。
  useBackHandler(askSession !== null, () => setAskSession(null));
  useBackHandler(pendingFile !== null, () => setPendingFile(null));
  useBackHandler(shownAsk !== null, () => { setFileAsk(null); channel.clearPushedAsk(); });
  // 视频弹窗开着:返回先关它(电话不动 —— 同 inCall 那一条的规矩)。
  useBackHandler(callVideo !== null, () => setCallVideo(null));
  const callReady = callEntry.state === 'ready';
  /** 首页输入框右下角那颗在「没内容」时的样子(2026-09-24:通话键从左边收进来;标签、灰不灰、点了去哪都与原来那颗一样)。 */
  const callSlot = useMemo(() => ({
    ready: callReady,
    label: callEntry.state === 'off' ? `${CALL_ENTRY_LABEL}(${callEntry.note})` : CALL_ENTRY_LABEL,
    title: callEntry.state === 'off' ? callEntry.note : '和事务官通话',
    onCall: () => setInCall(true),
  }), [callEntry, callReady]);

  // ——— 按住说话:识别 ———
  /**
   * 2026-09-25(卡 S「手机在哪都能用」):出了局域网也能转文字了(录音经房间交给电脑上的识别),
   * 09-24 那套「在外面被挡回来就把麦克风键灰掉、说『不在同一个网络』」整个撤掉。
   * 没成时 r.error 就是那一句真实原因(api/voice.ts 的 asrFailureOf),原样给他看;
   * 只有「电脑上没配识别」(不管走哪条路)才把语音判成不可用,过一会儿再探。
   */
  const transcribe = useCallback(async (wav: Blob): Promise<AsrResult> => {
    const r = await session.voice.asr(wav);
    if (!r.ok && r.kind === 'unavailable') speaker.setAvailability({ available: false, note: VOICE_UNAVAILABLE_TEXT, since: Date.now() });
    return r;
  }, [session, speaker]);
  const micOff = voiceOff;
  const micNote = voiceNote;

  // ——— 字幕 ———
  const timing = useMemo(() => ({
    msPerChar: props.captionMsPerChar ?? CAPTION_TIMING.msPerChar,
    holdMs: props.captionHoldMs ?? CAPTION_TIMING.holdMs,
    fadeMs: props.captionFadeMs ?? CAPTION_TIMING.fadeMs,
  }), [props.captionMsPerChar, props.captionHoldMs, props.captionFadeMs]);
  /**
   * ★ **答案来找她 —— 字幕这一处**(2026-10-04,卡 `claude/answer-comes-to-her`)。
   *
   * 维护者 10-04:「信息直接从正在办切到办完了,我是自己追过去点开查看的」。
   * 「问一句」的答案从此**出现在她提问的那个地方** —— 手机上就是这一行。
   *
   * 摆哪一条**工作台一处算**(`/state.answers`;`answerCaptionOf` 照抄那一条规矩:
   * 最新那条还没看过的)。没有新回答时字幕照旧是事项那一条,**行为一字不差**。
   * 通话中 / 引导中整格让位给通话字幕(下面 `alive` 那一条 `!inCall`,一个字没动)。
   */
  const freshAnswer = useMemo(() => answerCaptionOf(feed.state.answers), [feed.state.answers]);
  const lines = useMemo(
    () => (freshAnswer === undefined ? captionLinesOf(thread) : answerCaptionLines(freshAnswer)),
    [thread, freshAnswer],
  );
  const key = lines.butler?.key;
  const [shown, setShown] = useState<{ key: string; at: number } | null>(null);
  /**
   * 横屏下字幕区**默认折叠成一行**(2026-09-22,交接-0921 横屏问题清单第 5 条)。
   *
   * 那一条原话是「球在横屏下只有 101–153px;再大只能动字幕,而字幕是这一页的产品核心
   * (Ben 2026-09-17 定的『Grok 那种字幕形式』),把它压没了换一个大球是拿产品换视觉」。
   * 折叠**不是压没**:它默认剩一行(最新那一句),点一下就展开回原样 ——
   * 字幕还在、随时看得全,而没展开的时候球拿得到 220px 以上。
   *
   * **竖屏下这个状态没有任何作用**(CSS 只在 `orientation: landscape` 里用它):
   * 组件照旧不读屏幕尺寸、不做机型特判。
   */
  const [captionsOpen, setCaptionsOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (key === undefined) { setShown(null); return; }
    setShown({ key, at: Date.now() });
    setNow(Date.now());
  }, [key]);

  const sinceMs = shown === null ? 0 : now - shown.at;
  /**
   * 字幕最多两行(2026-09-25 夜,卡 fix/phone-home-orb-first):放完、停留的时长只按**看得见的那一截**算
   * (CAPTION_MAX 个字,两行放得下的量),不按整段回答 —— 一段两百字的回答不该在两行里挂上半分钟。
   * 「展开」那颗 09-25 夜去掉了(字幕那一格定高两行,展开不了);全文在右上角「记录」里。
   */
  const phase = captionPhaseAt({
    length: Math.min(lines.butler?.text.length ?? 0, CAPTION_MAX),
    sinceMs,
    speaking: speaker.speaking,
    /**
     * ★ **一条新回答不许自己淡出**(2026-10-04,卡 `claude/answer-comes-to-her`)。
     *
     * 事项字幕淡出是对的(那是「它在干什么」的旁白,过一会儿就不新鲜了);
     * 但「问一句」的答案是**她要的东西** —— 让它 5 秒后消失,就又回到「我得自己追过去」。
     * 所以有新回答在时按「展开着」算(`captionPhaseAt` 里那一档本来就是「不淡出,等她自己收」),
     * 她点一下标「看过了」,这一条从 `/state.answers` 里掉出去,字幕自然让位回事项那一条。
     */
    expanded: freshAnswer !== undefined,
    timing,
  });
  // 通话中球下面是通话字幕,不能再叠一层事项字幕。
  const alive = shown !== null && phase !== 'gone' && !inCall;
  useEffect(() => {
    if (!alive) return;
    const t = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(t);
  }, [alive, phase]);

  const full = lines.butler?.text ?? '';
  // 逐句出现照旧;截到两行、行尾省略号是 CSS 的事(-webkit-line-clamp),这里不再按字数剪。
  const butlerText = revealedText(full, sinceMs, timing.msPerChar);

  // ——— 球 ———
  // 通话时球还是这一颗,只是形态跟着通话走(她在说 / 你在说 / 在接通)。
  const stage = stageModeOf({
    ...signalsFromState(feed.state, { speaking: speaker.speaking, listening: micLevel > 0 || typing }),
    // 刚发出去、工作台还没回:事务官在想。
    thinking: pending.some((p) => p.error === undefined),
  });
  // ——— 动效配角(2026-09-23,fx/fxModel.stageStrong)———
  // 这一屏最多一种强效果:录音中谁都不亮;刚说的那句在路上 → 输入框;有事在办 → 「正在办」那块卡(2026-09-25)。
  const strong = stageStrong({
    recording: micLevel > 0,
    sending: pending.some((p) => p.error === undefined),
    working: signalsFromState(feed.state, { speaking: false, listening: false }).working,
  });
  /** 首页卡片整张点下去(2026-09-25):资讯去资讯页,其余去事项页并落在对应那一段 / 那一张。 */
  const openCard = useCallback((to: StageCardTarget) => {
    if (to.page === 'setup') { setSetupOpen(true); return; }
    if (to.page === 'asks') { setAsksFocus(undefined); setAsksOpen(true); return; }
    if (to.page === 'news') { onOpenNews?.(); return; }
    if (to.page === 'calls') { onOpenCalls?.(to.callId); return; }
    onOpenInbox?.({ ...(to.tab === undefined ? {} : { tab: to.tab }), ...(to.taskId === undefined ? {} : { taskId: to.taskId }) });
  }, [onOpenInbox, onOpenNews, onOpenCalls]);
  /**
   * 「另外 N 件等你确认」里点一行(2026-09-25,卡 M 追加):问你的 / 要你批的 → 那一页;单子 → 单子那一页;
   * 办完了等你确认的 → 事项页那一张;提议(小工具 / 布局 / 固化)在电脑上定,这一行点不动。
   */
  const openWaitingRow = useCallback((row: WaitingRow) => {
    // 点哪件开哪件(卡 UX):这一行的 key 带进去,那一页只摆它,别的收在「还有 N 件」后面。
    if (row.kind === 'question' || row.kind === 'approval' || row.kind === 'session') { setSetupOpen(false); setAsksFocus(row.id); setAsksOpen(true); return; }
    if (row.kind === 'plan') { setAsksOpen(false); setSetupOpen(true); return; }
    if (row.kind === 'confirm') onOpenInbox?.(row.taskId === undefined ? { tab: 'waiting' } : { taskId: row.taskId });
    // 要他定的(卡 O):去那件事的详情,几颗键在那儿。
    if (row.kind === 'decide' && row.taskId !== undefined) onOpenInbox?.({ taskId: row.taskId });
  }, [onOpenInbox]);
  /**
   * 「等你确认」那一页上摆哪几张(2026-09-28,卡 UX):**顺序与件数照「等你」那一堆**
   * (与首页那一格、电脑球下「等你 n」同一份),他点了某一行就只摆那一件。
   */
  const asks = useMemo(() => {
    const rows = waitingRows(feed.state).filter((row) => row.kind === 'question' || row.kind === 'approval' || row.kind === 'session');
    const { shown, others } = focusedAskKeys(rows.map((row) => row.id), asksFocus);
    // 快照里对不上号的(不该有)照样摆一行它那句话 —— 宁可朴素,不能给他一页空白(同电脑球下那一区的规矩)。
    return { others, shown, textOf: (key: string) => rows.find((row) => row.id === key)?.text ?? '' };
  }, [feed.state, asksFocus]);
  /**
   * 首页「等你确认」里点了某一行(2026-09-28,卡 UX):按这一行的 key 找到那一件,该开哪一页就开哪一页,
   * 而且**只摆那一件**。认不出那一行(状态刚换过一拍)就退回整张卡的去处 —— 不给他一次点了没反应。
   */
  const openWaitingKey = useCallback((lineId: string) => {
    const row = waitingRows(feed.state).find((one) => one.id === lineId);
    if (row === undefined) { setAsksFocus(undefined); setAsksOpen(true); return; }
    openWaitingRow(row);
  }, [feed.state, openWaitingRow]);
  const orbMode = inCall ? call.stageMode : stage.mode;
  const orbNotice = inCall ? ('neutral' as const) : stage.notice;
  const live2d = settings.stage === 'live2d' && avatar.status === 'ready';

  // ——— 电脑认不认这台手机(2026-09-23 第二轮从零重装)———
  // 通道层进房后几秒内给出结论(channel.ts presence);这里只在首页没连上时说话。
  const presence = useSyncExternalStore(
    (cb) => session.channel.subscribe(cb),
    () => session.channel.presence?.().kind,
    () => session.channel.presence?.().kind,
  );
  /**
   * 电脑上一次是**怎么**从房里走的(2026-09-28,卡 AW)。单独订一个字符串:
   * 订整个 presence 对象的话每次都是新对象,快照不稳。
   */
  const departure = useSyncExternalStore(
    (cb) => session.channel.subscribe(cb),
    () => { const p = session.channel.presence?.(); return p?.kind === 'absent' ? p.departure : undefined; },
    () => { const p = session.channel.presence?.(); return p?.kind === 'absent' ? p.departure : undefined; },
  );
  /**
   * 核对房间的结论(2026-09-28,卡 PH)。只为分出 `no_account` 那一路 ——
   * 「这台手机没有账号令牌,自己找不回电脑的新房间」要说的是重新扫码,而不是「工作台没在运行」。
   */
  const roomCheck = useSyncExternalStore(
    (cb) => session.channel.subscribe(cb),
    () => { const p = session.channel.presence?.(); return p?.kind === 'absent' ? p.check : undefined; },
    () => { const p = session.channel.presence?.(); return p?.kind === 'absent' ? p.check : undefined; },
  );
  const relink = relinkNotice({ connected: feed.connected, presence, departure, check: roomCheck });
  const cardsView = cardsViewOf({ connected: feed.connected, now: feed.state.now });
  /** 已经收场的事(取消了 / 办完了):它们引起的未接不挂在首页(统筹 09-25 晚)。 */
  const handledItems = useMemo(
    () => new Set((feed.state.tasks?.tasks ?? []).filter((task) => task.status === 'canceled' || task.status === 'done').map((task) => task.id)),
    [feed.state.tasks],
  );
  /**
   * 那一排里话筒那颗图标上的角标数(2026-10-03,卡「首页侧边小图标」)。**与点开之后列出来的那几行同一处**
   * (`missedShownCount` / `missedShownGroups`)—— 两处各数一遍早晚出「角标写 2、点开只有一行」。
   */
  const missedCount = props.missed === undefined ? 0 : missedShownCount(props.missed.log, handledItems);
  /**
   * 「今天要做」那颗图标上的角标数(2026-10-03 傍晚,方案 B:那张卡收成了一颗图标)。
   * **与那张卡右上角那个数、与点进去那一段同一处**(`todayTasks`)—— 同一件事的数字各处一致是硬规矩。
   */
  const todayCount = useMemo(() => todayTasks(feed.state).length, [feed.state]);
  /**
   * 「最近一次通话」那颗图标点下去带的那一张(同方案 B)。去处与那张卡原来的 `to` 一个字没改
   * (`{ page: 'calls', callId: 最新那一通 }`);一通都没有时就是通话记录那一页。
   */
  const latestCall = useMemo(() => latestCallOf(feed.state), [feed.state]);
  /**
   * 「资讯」那颗图标上的小点:今天那期播客能听(2026-10-03 晚,维护者:「要,只标播客有没有」)。
   * 首页于是又每 15 分钟问一次 `/feed` 与 `/feed/aidj`(后一问工作台要去打 Aiboo 云端)——
   * 所以**只在那颗画着时问**:通话里、引导里那一排不画,资讯那颗没去处时它也不在;App 藏在后台时到点也不问
   * (useNewsGlance 里那一条)。竖屏下别的页开着时这一页只是 hidden、照样挂着,所以那时照问。
   * 亮不亮认 `glancePodcast`(与资讯那一页摆哪条播放条同一处判断),首页不另判一遍。
   */
  const newsGlance = useNewsGlance(session, { enabled: !inCall && onboarding === undefined && onOpenNews !== undefined });
  const podcastReady = glancePodcast(newsGlance) !== null;
  /** 未接那一块开着没有(侧边那颗图标点开、「收起」收掉)。 */
  /**
   * ★ **「看过了」那一下**(2026-10-04,卡 `claude/answer-comes-to-her`)。
   *
   * 回答与「刚办完」两处用的是**两条路、同一个意思**:
   *   - `POST /answers/seen {id}` —— 字幕那一行;
   *   - `POST /task/seen-result {id}` —— 「刚办完」那一条。
   * 两条都只记**服务端那一格**,所以**两端同步**:手机点了,电脑那一处下一拍快照就跟着收。
   *
   * 送出去那一下在路上时把那一张的两颗键停住(`seeing`),免得她连点两下。
   * 送失败**如实说一句**(D13:不静默丢掉也不假装成功)—— 那一条照旧摆着,她能再按一次。
   */
  const [seeing, setSeeing] = useState<string | undefined>(undefined);
  const markSeen = useCallback(async (path: string, id: string): Promise<boolean> => {
    setSeeing(id);
    try {
      const res = await session.client.json<{ ok?: boolean; error?: string }>(path, { method: 'POST', body: { id } });
      if (!res.ok) { setToast(res.error ?? '这一下没记上,再按一次试试'); return false; }
      return true;
    }
    finally { setSeeing(undefined); }
  }, [session.client]);
  /** 字幕那一行点一下:展开全文 + 标「看过了」。 */
  const onCaptionTap = useCallback(() => {
    const id = lines.butler?.answerId;
    if (id === undefined) { setCaptionsOpen((v) => !v); return; }
    // 先展开(她这一下要的是看全文),再去记「看过了」 —— 记那一下走网,不该让展开等它。
    setCaptionsOpen(true);
    void markSeen('/answers/seen', id);
  }, [lines.butler?.answerId, markSeen]);
  /** ★ 「刚办完」那几条(2026-10-04)。摆哪几条工作台一处算,这里只渲染。 */
  const freshRows = useMemo(() => freshResultRows(feed.state), [feed.state]);
  /**
   * ★ **App 在后台时那一条通知,正文就是答案本身**(2026-10-04,卡 `claude/answer-comes-to-her`)。
   * 通话中 / 引导中不推:那两种状态下她就在跟它说话,一条通知是插话。
   */
  useAnswerNotice(feed.state.answers, { enabled: !inCall && onboarding === undefined });

  const [missedOpen, setMissedOpen] = useState(false);
  /**
   * 清空 / 最后一通的事被取消了 → 一条都不剩:那一块自己收掉。
   * 不收的话这个 true 会留在那儿,下次真来一通未接时它**自己就开了** —— 那是她没按过的一下。
   */
  useEffect(() => { if (missedCount === 0) setMissedOpen(false); }, [missedCount]);
  const [staleOpen, setStaleOpen] = useState(false);
  const [relinking, setRelinking] = useState(false);
  const startRelink = useCallback(() => {
    if (relinking) return;
    setRelinking(true);
    // 没有 repair 的老会话退回「退出登录」(回欢迎屏,多点一下「去配对」)。
    void (session.repair ?? session.unpair)().catch(() => setRelinking(false));
  }, [relinking, session]);

  const banner = onboarding === undefined && !inCall && !bannerDismissed && onboardingEntryVisible(settings, feed.state)
    ? onboardingEntryText(feed.state)
    : undefined;

  return (
    // data-ba-kb-page / data-ba-kb-anchor:弹键盘时布局钉在没弹键盘那一档、球那一格不动(viewport/keyboardViewport.ts,2026-09-24)。
    <div className="ba-scene" data-mode={orbMode} data-call={inCall} data-onboarding={onboarding !== undefined} data-incoming={incoming !== undefined} data-handset={handset !== undefined} data-ba-kb-page="stage">
      {/* 引导横幅规矩不变(2026-09-16):最顶上一条细横幅,一句话,点它进引导页。通话中不插话。 */}
      {banner !== undefined && (
        <div className="ba-banner" role="region" aria-label="引导">
          <button type="button" className="ba-banner__main" onClick={() => onStartOnboarding?.()}>{banner.banner}</button>
          <button type="button" className="ba-banner__later" onClick={() => { dismissOnboardingBanner(); setBannerDismissed(true); }}>稍后</button>
        </div>
      )}
      {/* 手机包落在电脑后面、收不到新格时那一句(2026-10-09);同一种细横幅,通话中 / 引导中不插话。 */}
      {banner === undefined && onboarding === undefined && !inCall && <PhoneBehindBanner state={feed.state} />}

      <div className="ba-scene__top">
        {/* 通话中不放别的出口:这时候要走只有挂断。 */}
        {!inCall && <button type="button" className="ba-scene__icon ba-scene__icon--sm" aria-label="设置" onClick={() => onOpenSettings?.()}><StageIcon name="settings" /></button>}
        {/*
          ── 状态行那一格(2026-09-26,卡 QH 第二轮)──

          「远程」「停止朗读」「免打扰中」全住在这里:**一格固定预留的地方,高度不随摆了几行变**。
          为什么非这样不可:球那一格是 `flex: 1`,顶上每多一行都从球身上扣 —— 0.3.5 真机上这两行
          一起出现时球从 152 掉到 84。维护者的规矩①「球是主角、够大」与⑦「弹键盘球不缩」是同一件事:
          **任何多出来的行都不许挤球**。

          做法同球下字幕那一处(capspace / capbody):下面那份**看不见的垫子**出高度(真字体排的,
          系统放大字它自己跟着长,**不写死像素**),真内容压在同一格里。理由见 styles.css `.ba-scene__top` 那一大段。
        */}
        <div className="ba-scene__statusbox">
          {/*
            垫子:两条状态行各一个壳子,里面一个不换行空格。`aria-hidden` —— 它不是内容,只是高度。

            类名刻意**不复用** `ba-scene__conn` / `ba-scene__hush`(照球下字幕那一处 capline / caption 的先例):
            同名会让「直连时那条横幅不显示」这类查询查到垫子,断言就假了。尺寸不会跑偏 ——
            styles.css 里每条尺寸规则都把垫子这两个类**写在同一条选择器上**,改一处两边一起动。

            要加第三条状态行时,这里也得跟着加一个壳子,不然那一行会挤到球上。
          */}
          <div className="ba-scene__topspace" aria-hidden="true">
            <p className="ba-scene__connspace">&nbsp;</p>
            <span className="ba-scene__hushspace"><StageIcon name="speakerphone" /><span>&nbsp;</span></span>
          </div>
          <div className="ba-scene__status">
            {/*
              连接横幅(2026-09-17):直连 / 远程 / 未连接。**一条细横幅,不弹窗**——
              切换是自动的,弹一次窗就等于每次进出门都打扰他一回。直连时不显示:那是常态,常态不用说。

              电脑关机时这条说的是「电脑不在线」(2026-09-17 登录那张卡第 3 条):**掉线不掉登录**,
              令牌还在、还是这台工作台,只是它此刻没开机;回欢迎屏只有两种情况——自己退出登录,或者令牌被撤销(401)。
              通话中照样显示:那时候「还连着吗」比什么都要紧。
            */}
            {/* 还在连(一打开 / 切回来 / 失败还没满 10 秒):写「正在连接电脑…」,不写「不在线」(2026-09-30)。 */}
            {(!feed.connected || channel.mode !== 'direct') && (
              <p className="ba-scene__conn" role="status" data-mode={feed.connected ? channel.mode : feed.connecting === true ? 'connecting' : 'offline'}>
                {feed.connected ? channel.modeText : feed.connecting === true ? DESKTOP_CONNECTING_BANNER : relink !== null ? relink.title : DESKTOP_OFFLINE_BANNER}
              </p>
            )}
            {/*
              她在念回答时,顶上正中一颗「停止朗读」(2026-09-25 夜:以前字幕下面一颗只写「停」,看不懂停什么,还占字幕的地方)。
            */}
            {!inCall && speaker.speaking && (
              <button type="button" className="ba-scene__hush" onClick={speaker.stop}>
                <StageIcon name="speakerphone" />
                <span>停止朗读</span>
              </button>
            )}
            {/*
              没在念、而且在免打扰时段里:同一个位置改说**为什么没声**(2026-09-26,卡 QH)。
              「免打扰中 · 08:30 后恢复」—— 第一次用的人看见这一行就知道不是坏了,也知道几点会有声。
              **点它不出声**(它不是播放键):飘一句话说清回答照样出字、想听去哪儿点、时段在哪儿改。
              他自己点了「重听」时 `speaker.speaking` 为真,让位给上面那颗「停止朗读」——
              一次只摆一个,而且那时候正在出声,写「免打扰中」就是在说假话。
            */}
            {!inCall && !speaker.speaking && hushed && (
              <button type="button" className="ba-scene__hush" data-quiet="true" onClick={() => setToast(quietWhyText(quiet))}>
                <StageIcon name="speakerphone" />
                <span>{quietHushLabel(quiet)}</span>
              </button>
            )}
          </div>
        </div>
        {/* 不通话时右上角这个记录 icon 保留;通话中改用底部那颗字幕键(同一个概念,一次只摆一个)。 */}
        {!inCall && (
          <button
            type="button"
            className="ba-scene__icon ba-scene__icon--sm"
            aria-label={log ? '收起记录' : '记录'}
            aria-expanded={log}
            onClick={() => setLog((v) => !v)}
          ><StageIcon name="messages" /></button>
        )}
      </div>

      {/*
        身子 = 球那一栏 + 卡片区(2026-09-21 展示台布局,按运营同事白板第三节)。
        **横版球在左、卡片在右;竖版球居中、卡片在下** —— 同一份 DOM,差别全在
        stage/stageCards.css 的 `@media (orientation: landscape)` 里,组件不读屏幕尺寸、
        不做机型特判(折叠屏展开是「宽竖屏」,照竖版走)。
      */}
      {/*
        data-ba-kb-fit:这一整块是「内容区」—— 弹键盘时它变矮、自己滚,输入框照常排在它下面
        (2026-09-25,卡 fix/phone-keyboard-overlap;上一版是把输入框抬上去,于是画在了卡片标题身上)。
        输入框(`.ba-scene__dock`)是它的**兄弟**、排在它后面:两边都在文档流里,就不可能重叠。
      */}
      <div className="ba-scene__body" data-ba-kb-fit="stage" data-captions={captionsOpen ? 'open' : 'collapsed'}>
        <div className="ba-scene__stage">
          <div className="ba-scene__orb" data-ba-kb-anchor="orb">
            {live2d
              /* 通话里那张脸跟着语气走(2026-10-02,卡「声音与形象跟着话走」):
                 不在通话时不给 toneRef —— 那时没有「这一句的语气」这件事。 */
              ? <Suspense fallback={<Orb mode="idle" />}><ButlerStage avatar={avatar.manifest} mouthRef={mouthRef} {...(inCall ? { toneRef: call.toneRef } : {})} /></Suspense>
              /*
                首页(不在通话、不在引导):形象区可以左右滑换形象、点顶上小方格进陈列(2026-10-01);
                通话 / 引导时还是那颗球 —— 说话、聆听那几态都在它身上。
              */
              : !inCall && onboarding === undefined
                ? <PortraitAvatar particle={<ParticleStage mode={orbMode} notice={orbNotice} settings={appearance.preset.settings} />} onOpenGallery={() => onOpenAvatars?.()} />
                : <ParticleStage mode={orbMode} notice={orbNotice} settings={appearance.preset.settings} {...(onboarding === undefined ? {} : { scene: 'onboarding' as const })} />}
          </div>

          {inCall
            ? (
              <Suspense fallback={<div className="ba-call__captions"><p className="ba-call__status" role="status">正在接通…</p></div>}>
                <CallOverlay call={call} />
              </Suspense>
            )
            : (
              /*
                字幕那一格**定高**(2026-09-25 夜,卡 fix/phone-home-orb-first;统筹小米真机:一段办完的长回答占了五行大字,
                球被压成顶上一个小点)。高度 = 看不见的那一份「他一行 + 她两行」按真字体排出来的高(不写死像素),
                真字幕压在同一格里、各自截到一行 / 两行带省略号 —— 字幕来了、变长、没了,球一个像素都不动。
              */
              /*
                data-ba-kb-into:弹键盘时「当前在看的那一块」就是她刚说的那句 —— 有字幕在的时候把它滚进可视区
                (他正要回她那句话)。没字幕就什么都不滚:球在最上面,弹键盘时页面纹丝不动。
              */
              <div
                className="ba-scene__captions"
                data-phase={alive ? phase : 'gone'}
                data-open={captionsOpen ? 'true' : 'false'}
                aria-live="polite"
                {...(alive && (butlerText !== '' || (lines.me?.text ?? '') !== '') ? { 'data-ba-kb-into': 'caption' } : {})}
              >
                <div className="ba-scene__capspace" aria-hidden="true">
                  <span className="ba-scene__capline" data-role="me" />
                  <span className="ba-scene__capline" data-role="butler" />
                </div>
                <div className="ba-scene__capbody">
                  {alive && lines.me !== undefined && lines.me.text !== '' && (
                    <p className="ba-scene__caption" data-role="me">{lines.me.text}</p>
                  )}
                  {alive && butlerText !== '' && (
                    /*
                     * ★ 一条「问一句」的回答时这一行**点得开**(2026-10-04,卡
                     * `claude/answer-comes-to-her`:「长的截一句,点一下展开全文」)——
                     * 同一下也标「看过了」(她已经看到答案了)。
                     * 不是回答时这一行照旧是一段纯文字,**一个属性都不多**(老行为一字不差)。
                     */
                    <p
                      className="ba-scene__caption"
                      data-role="butler"
                      data-kind={lines.butler?.kind}
                      {...(lines.butler?.answerId === undefined
                        ? {}
                        : {
                            'data-answer': lines.butler.answerId,
                            role: 'button',
                            tabIndex: 0,
                            'aria-expanded': captionsOpen,
                            'aria-label': captionsOpen ? '收起这条回答' : '展开这条回答的全文',
                            onClick: onCaptionTap,
                            onKeyDown: (e: React.KeyboardEvent) => {
                              if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onCaptionTap(); }
                            },
                          })}
                    >{butlerText}</p>
                  )}
                </div>
              </div>
            )}
          {/*
            横屏下那颗「展开/收起字幕区」(2026-09-22)。**竖屏下 CSS 把它整个藏起来** ——
            竖屏本来就摆得下两三行字幕,多一颗按钮只是噪音。
            它在 DOM 里永远存在:横竖同一份 DOM 是这一页的纪律(见 tests/stageLayout.test.tsx)。
          */}
          {!inCall && (
            <button
              type="button"
              className="ba-scene__capstoggle"
              aria-label={captionsOpen ? '收起字幕区' : '展开字幕区'}
              aria-expanded={captionsOpen}
              onClick={() => setCaptionsOpen((v) => !v)}
            >{captionsOpen ? '收起' : '字幕'}</button>
            )}
          {/*
            事务官自己那几句说明(语音没开 / 通话没配 / 文件收发 / 出错)**跟着球走**,
            摆在球那一栏里而不是整屏底下:横屏下它们横在球与卡片之间那一条里,
            会把卡片区压掉一行 —— 真机横屏截图上看得见(见交接的横屏问题清单第 2 条)。
          */}
          {/*
            「电脑不认这台手机 / 房里没有电脑」(2026-09-23)。标题在顶上那条横幅里,这里是一句说明 + 一颗键,
            点了直接进扫码页开相机。**它在的时候不再摆通话那句说明** —— 那句多半是「连不上工作台」一类,
            和这一块说的是同一件事,两句叠着只会让人猜哪句算数。
          */}
          {!inCall && relink !== null && (
            <div className="ba-scene__relink" data-kind={relink.kind}>
              <p className="ba-scene__relinkdetail">{relink.detail}</p>
              {/* 键只在「重新扫码配对」真是下一步时才画(卡 AW:电脑睡着了的时候房间是对的)。 */}
              {relink.action !== undefined && (
                <button type="button" className="ba-btn ba-scene__relinkbtn" disabled={relinking} onClick={startRelink}>{relink.action}</button>
              )}
            </div>
          )}
          {/* 正在收的那个文件(卡 J):通话中也摆 —— 电话里说「发我」,文件就在这时候进来。 */}
          {channel.incoming !== null && (
            <FileProgressLine
              text={channel.incoming.text}
              received={channel.incoming.received}
              {...(channel.incoming.total === undefined ? {} : { total: channel.incoming.total })}
            />
          )}
          {!inCall && (
            <>
              {voiceNote !== undefined && <p className="ba-scene__voicenote">{voiceNote}</p>}
              {callEntry.state === 'off' && relink === null && <p className="ba-scene__callnote">{callEntry.note}</p>}
              {/* 文件收发那一句。收到了文件就点它打开(卡 J);别的点一下消掉 —— 它是一条通知,不是一个状态。 */}
              {channel.notice !== null && (
                <button
                  type="button"
                  className="ba-scene__filenote"
                  onClick={() => {
                    const file = channel.noticeFile;
                    channel.clearNotice();
                    if (file !== null) void channel.openFile(file);
                  }}
                >{channel.notice}</button>
              )}
              {toast !== null && <p className="ba-toast" role="alert">{toast}</p>}
            </>
          )}
          {/*
            ── 球下那一排小图标:未接来电 · 各家最近的对话 · 今天要做 · 最近一次通话 · 资讯 · 会议 ──
            (2026-10-03 傍晚,卡「首页两卡 + 一排图标」= 维护者看过示意图之后拍的**方案 B**;
             会议那颗是 2026-10-04 加的第六颗,卡「首页会议图标」)

            她的原话:「只保留正在办和待确认两个是卡片,其他都和前面一样做成 icon 就 OK……
            中间的球球还是要大的,这个事情是要适配 Live2D 的显示空间,省出来的空间 Live2D 也能放大。」

            「和前面一样」指的是当天下午那张卡(「首页侧边小图标」)把「未接来电」「各家最近的对话」
            做成的那两颗小图标 —— 那时它们是球那一栏**右上角一列**绝对定位的。这一版把那一列
            **并进这一排**(维护者要一处,不是两处),再把「今天要做」「最近一次通话」「资讯」
            三张卡也收成这一排里的图标;主列只剩两张卡并排。

            **摆在球那一栏里、在流里**(`flex: 0 0 auto`,这一栏最后一格):球与字幕在上、它在下,
            再往下才是卡片区。进流不再怕挤球 —— 卡片区从三行网格掉到一行,省下来的一大截全归
            球那一格(`flex: 1`,它自己吃掉),这一排这 44px 是零头(量数在交接第二、四节)。

            通话中与引导中不画 —— 那两种状态下整屏只有一件事在发生(同下面卡片区那条老规矩)。
            「各家最近的对话」那颗照旧**什么条件都不带**:不看有没有在跑的、不看电脑连不连得上
            (点进去那一页会如实说连不上,而不是让入口自己消失);另外五颗同样一直在。
            记录面板里那几颗照旧留着,是第二条路。

            **会议那颗**(2026-10-04,维护者:「再开张卡,把会议模式一样拿出来到右边的侧边栏上」):
            在这之前它只有一条路 —— 记录 → 对话记录页 → 顶上那排小链接里的「会议」,藏了三层,
            她在手机上找不到。排在最后一颗;没传 `onOpenMeeting` 时整个不画(没有去处的不画,D13)。
            **不带角标**:会议页一卸载,它那个 cleanup 就把录音停了(App.tsx 那条早退旁边的注释),
            所以首页上没有「正在录」这回事;纪要有几条首页不另去问一遍(同「各家最近的对话」那颗)。
          */}
          {!inCall && onboarding === undefined && (
            <HomeRail
              {...(props.missed === undefined
                ? {}
                : {
                    missed: {
                      count: missedCount,
                      // 一条都没有时不开那一块(空着的一块等于在装作有东西),只飘一句说清它是什么。
                      onOpen: () => (missedCount > 0 ? setMissedOpen(true) : setToast(RAIL_MISSED_NONE_TEXT)),
                    },
                  })}
              {...(onOpenHistory === undefined ? {} : { history: { name: RECENT_SESSIONS_TITLE, onOpen: onOpenHistory } })}
              {...(onOpenInbox === undefined
                ? {}
                : {
                    // 角标与点进去那一段**同一处**(`todayTasks`):首页那张卡右上角那个数本来就是它,
                    // 两处各数一遍早晚出「角标写 3、进去只有 1 件」。
                    today: { count: todayCount, onOpen: () => onOpenInbox({ tab: 'queued' }) },
                  })}
              {...(onOpenCalls === undefined
                ? {}
                : {
                    // 原来那张卡的去处一个字没改:有纪要卡就直接打开最近那一通,
                    // 一张都没有时就是通话记录那一页(它自己会说「还没有通话记录」,不在这儿编一句)。
                    calls: { onOpen: () => onOpenCalls(latestCall?.id) },
                  })}
              {...(onOpenNews === undefined ? {} : { news: { podcast: podcastReady, onOpen: () => onOpenNews() } })}
              {...(onOpenMeeting === undefined ? {} : { meeting: { prep: meetingPlanNeedsLook(feed.state.meetings?.upcoming), onOpen: () => onOpenMeeting() } })}
            />
          )}
          {/*
            未接来电那一块:**点了这一排里那颗话筒才挂上来**(2026-10-03,同上那张卡)。
            那颗图标就是「收起来的那一行」,所以这一块一挂上来就是铺开的(回拨 / 清空 / 明细一个字没动),
            「收起」那一下把它卸掉。清空之后那张卡自己收掉、这一层也跟着空掉,所以那一层不画边框、不上底色。
            和那一列同一个参照物(球那一栏):横竖两向都不盖顶上那一排、不盖输入框,也不会在横屏下铺到卡片区去
            (封顶 40vh 与量过的三档数在 stage/homeRail.css)。
          */}
          {!inCall && onboarding === undefined && props.missed !== undefined && missedOpen && missedCount > 0 && (
            <div className="ba-rail-sheet">
              <MissedCalls {...props.missed} compact hideItems={handledItems} onClose={() => setMissedOpen(false)} />
            </div>
          )}
        </div>
        {/*
          卡片区。通话中与引导中**不画** —— 那两种状态下整屏只有一件事在发生,
          旁边摆四块卡片是抢话(同「通话中不放别的出口」那条)。
        */}
        {/* 没连上时卡片上是上次的数据:收起成一行,点开才看(linkHealth.ts cardsViewOf)。 */}
        {/*
          引导落地那张单子(卡 feat/onboarding-materialize)**不另占一格**:等他点头时在「等你确认」那一格置顶一行
          「我照你说的摆好了」,整张卡点下去是整张单子(stageCardsModel.ts setupLine、下面那一页)。
        */}
        {/* onOpenRow:点哪件开哪件(2026-09-28,卡 UX)——「等你确认」里一行一颗按钮,点了那一页只摆那一件。 */}
        {/*
          ★ 「刚办完 · 结果一句话」(2026-10-04,卡 `claude/answer-comes-to-her`)。
          摆在两张卡**上面**、球那一栏下面:它是「看一眼就没了」的东西,不该挤掉常驻的那两张卡。
          通话中 / 引导中整条不画(同「通话中不放别的出口」那条);没连上时(`cardsView === 'none'`)
          也不画 —— 那会儿屏幕上是上次的数据,挂一条「刚办完」会让她以为刚刚办完了什么。
          一条都没有时组件自己回 null。
        */}
        {!inCall && onboarding === undefined && cardsView !== 'none' && (
          <FreshResults
            rows={freshRows}
            {...(seeing === undefined ? {} : { busy: seeing })}
            onOpen={(taskId) => {
              // 点开**就算看过了**(她已经看到结果了)。先开那一页,记那一下走网、不让她等。
              onOpenInbox?.({ taskId });
              void markSeen('/task/seen-result', taskId);
            }}
            onSeen={(taskId) => { void markSeen('/task/seen-result', taskId); }}
          />
        )}
        {!inCall && onboarding === undefined && cardsView !== 'none' && (
          <StageCards
            state={feed.state}
            strong={strong}
            {...(onOpenInbox === undefined && onOpenNews === undefined ? {} : { onOpen: openCard })}
            onOpenRow={openWaitingKey}
            {...(cardsView === 'stale'
              ? { stale: { label: staleCardsLabel(feed.state.now, staleOpen), open: staleOpen, onToggle: () => setStaleOpen((v) => !v) } }
              : {})}
          />
        )}
      </div>

      {!inCall && (
          <>
            {/*
              底部就一个撑满的输入框(2026-09-24 维护者:「给电话挪个位置吧……默认输入框就能撑满底部了」)。
              通话键收在它右下角(没内容时发送键就是通话键),按住说话是它左边那颗麦克风键。
            */}
            <div className="ba-scene__dock">
              <StageComposer
                disabled={micOff}
                {...(micNote === undefined ? {} : { disabledNote: micNote })}
                call={callSlot}
                transcribe={transcribe}
                onText={onComposerText}
                onSubmitDraft={onComposerDraft}
                api={composerApi}
                current={feed.state.composer}
                onError={(text) => setToast(text)}
                onLevel={setMicLevel}
                onTypingChange={setTyping}
                glow={strong === 'composer'}
              />
            </div>
          </>
        )}

      {shownAsk !== null && !inCall && (
        <FileAskCard
          ask={shownAsk}
          busy={pullingOffer}
          onPick={(hit) => {
            setPullingOffer(hit.offer);
            void channel.pull(hit).finally(() => {
              setPullingOffer(null);
              setFileAsk(null);
              channel.clearPushedAsk();
            });
          }}
          onDismiss={() => { setFileAsk(null); channel.clearPushedAsk(); }}
          onHandOver={() => {
            const said = shownAsk.request;
            setFileAsk(null);
            channel.clearPushedAsk();
            // 交给 DSH 里的她:原话照旧建一件事项(no_fetch = 别再岔回这张卡)。
            void send(said, { no_fetch: true }).then((r) => { if (!r.ok && r.error !== undefined) setToast(r.error); });
          }}
        />
      )}

      {/*
        通话中那段视频(2026-10-12):顶上一块、**没有遮罩** —— 底下挂断 / 麦克风 / 字幕照旧点得到。
        挂了电话就收(电话结束了,文件在「文档 / 事务官」里)。
      */}
      {inCall && callVideo !== null && (
        <CallVideoPopup
          name={callVideo.name}
          {...(callVideo.src === undefined ? {} : { src: callVideo.src })}
          {...(callVideo.error === undefined ? {} : { error: callVideo.error })}
          onClose={() => setCallVideo(null)}
        />
      )}

      {pendingFile !== null && (
        <>
          <div className="ba-scene__scrim" onClick={() => setPendingFile(null)} aria-hidden="true" />
          <div className="ba-scene__picker" role="dialog" aria-label="发到哪台设备">
            <p className="ba-scene__pickerhead">把「{pendingFile.name}」发到——</p>
            {channel.devices.length === 0 && (
              <p className="ba-scene__recordnote">
                {channel.devicesNote ?? '此刻没有别的设备在线。电脑上的工人起来之后再试。'}
              </p>
            )}
            {channel.devices.map((device) => (
              <button
                type="button"
                className="ba-scene__pickerone"
                key={device.identity}
                onClick={() => {
                  const file = pendingFile;
                  setPendingFile(null);
                  void channel.sendFile(file, device.identity);
                }}
              >{device.name}<span className="ba-scene__pickerkind">{wbchKindText(device.kind)}</span></button>
            ))}
            <button type="button" className="ba-scene__link" onClick={() => setPendingFile(null)}>算了</button>
          </div>
        </>
      )}

      {/*
        「我照你说的摆好了」整张单子(2026-09-25):首页的下一级页,同对话记录那一页的样子。
        等他点头 → 整张单子(逐条能勾、「改一下」、「就这样」);落好了 → 那一句回执与没落上的几样,「收起」回首页。
      */}
      {setupOpen && !inCall && feed.state.materialize !== undefined && (
        <div className="ba-setup-page" role="dialog" aria-label={SETUP_TITLE}>
          <BackHeader title={SETUP_TITLE} onBack={() => setSetupOpen(false)} />
          <div className="ba-setup-page__body">
            {/*
              另外几件等你确认的(2026-09-25,卡 fix/confirm-cancel):整张「等你确认」点下去先到这一页,
              以前别的几件在这里没有入口。点一件 = 事项页打开那一张(能「通过」「取消」);返回回到这一页。
            */}
            <OtherConfirms items={otherConfirms(feed.state)} state={feed.state} onOpen={openWaitingRow} />
            {feed.state.materialize.status === 'applied'
              ? <SetupReceipt view={feed.state.materialize} onDismiss={() => setSetupOpen(false)} />
              : <SetupCard view={feed.state.materialize} apply={(payload) => applyMaterialize(session, payload)} onReceipt={(text) => setToast(text)} />}
          </div>
        </div>
      )}

      {/*
        事务官问你的话、要你批的事(2026-09-25,卡 M):首页的下一级页,同单子那一页的样子。答完那一件从这里、从电脑上一起消失;
        另外几件等你确认的(与单子)列在下面,点一件打开它。
      */}
      {asksOpen && !inCall && (
        /*
          data-ba-kb-page(2026-10-03,卡 claude/phone-saybox-pinned):这一页上那张卡里有「我自己说」
          那个框(替她答)。它在 asks.css 里吸底 —— 再让 keyboardViewport 认这一页,
          软键盘弹起时整页的下边界收到键盘上沿(iOS 的 `Keyboard.resize: None` 不压视口,不收就盖住框)。
        */
        <div className="ba-asks-page" role="dialog" aria-label="等你确认" data-ba-kb-page="asks">
          <BackHeader title="等你确认" onBack={() => { setAsksOpen(false); setAsksFocus(undefined); }} />
          <div className="ba-asks-page__body">
            {asks.shown.map((key) => key.startsWith('question:')
              ? (() => {
                  const question = (feed.state.questions ?? []).find((one) => `question:${one.id}` === key);
                  return question === undefined ? <p key={key} className="ba-asks-page__done">{asks.textOf(key)}</p> : (
                    <PhoneQuestionAsk key={key} question={question} answer={(answers) => answerQuestion(session, question.id, answers)} onReceipt={setToast} now={feed.state.now} />
                  );
                })()
              : key.startsWith('approval:')
                ? (() => {
                    const approval = (feed.state.approvals ?? []).find((one) => `approval:${one.id}` === key);
                    return approval === undefined ? <p key={key} className="ba-asks-page__done">{asks.textOf(key)}</p> : (
                      <PhoneApprovalAsk key={key} approval={approval} answer={(allow, scope) => answerApprovalScoped(session, approval.id, allow, scope)} onReceipt={setToast} agents={feed.state} />
                    );
                  })()
                // 别家的会话停着在等他(卡 T):同一页、同一种卡。
                : (() => {
                    /*
                      ★ 2026-10-03(审计第四节第 1、2 条):这条会话从哪儿找,与首页那一行同一处
                      ({@link askSessionOf})—— 从前只找 `feed.state.sessions`,窗口型那几家只在登记表里,
                      点进来找不到就落到下面那行纯文字,选项键与「我自己说」一颗都不渲染。

                      `pick` / `say` 送上去的键是 **`key` 本身 —— 工作台下发的那一颗,原样回传**:
                      手机与插件分开发版,拿家名与会话 id 重拼一颗新键的话,新手机连老插件就按不动
                      (老插件只认 `session:<家>:<会话 id>`;新插件两种都收)。
                      `answerSession` / `dismissSessionAsk` / `readApprovalKeys` 送的是 agent + 会话 id 两格,不经键。
                    */
                    const one = askSessionOf(feed.state, key);
                    return one === undefined ? <p key={key} className="ba-asks-page__done">{asks.textOf(key)}</p> : (
                      /*
                        ★ 2026-10-04(卡 `claude/ask-with-context`,维护者:「每次要确认内容的信息都很短,
                        我都不知道发生了什么,还得自己去最近的会话找上下文」):这张卡多两样 ——
                        `context` 是**它刚才在干什么**(在哪个项目 + 最近几轮原文,走现成的 `GET /sessions/digest`),
                        `openSession` 是底下那颗「打开整段对话」(摆事项页点开一条会话那一张,全文那条路)。
                        作答那几样一个字没改。
                      */
                      <PhoneSessionAsk
                        key={key}
                        session={one}
                        answer={(text) => answerSession(session, one.agent, one.session_id, text)}
                        pick={(label) => answerAsk(session, key, { choice: label })}
                        say={(text) => answerAsk(session, key, { text })}
                        dismiss={() => dismissSessionAsk(session, one.agent, one.session_id)}
                        approval={() => readApprovalKeys(session, one.agent, one.session_id)}
                        onReceipt={setToast}
                        agents={feed.state}
                        now={feed.state.now}
                        context={(
                          <AskRounds
                            client={session.client}
                            agent={one.agent}
                            name={agentTitle(one.agent, feed.state)}
                            sessionId={one.session_id}
                            now={feed.state.now}
                            /* 那条会话一动就再读一次(卡 PS 那条纪律,与事项页那一张同一个节拍)。 */
                            beat={`${one.updated_at}|${one.status}|${one.activity?.at ?? ''}`}
                          />
                        )}
                        openSession={() => setAskSession({ agent: one.agent, sessionId: one.session_id })}
                      />
                    );
                  })())}
            {asks.shown.length === 0 && (
              <p className="ba-asks-page__done">没有要你回答、要你批的了。</p>
            )}
            {/*
              点哪件开哪件(2026-09-28,卡 UX):只摆了他点的那一件时,其余的收在这一颗后面 ——
              维护者 09-28 点首页第一行「让 Manus…」,打开的是整列、最上面是另外两条,他照着眼前那张卡批了别的事。
            */}
            {asks.others > 0 && (
              <button type="button" className="ba-asks-page__more" onClick={() => setAsksFocus(undefined)}>还有 {asks.others} 件要你答 / 要你批</button>
            )}
            {/* 「等你」那一堆里其余的几件(单子、提议、办完了等你确认的):这一页的几张加上它们,就是首页那一格的数。 */}
            {asksFocus === undefined && <OtherConfirms items={otherWaiting(feed.state, ['question', 'approval', 'session'])} state={feed.state} onOpen={openWaitingRow} />}
          </div>
          {/*
            「打开整段对话」点出来的那一张(2026-10-04,卡 `claude/ask-with-context`):
            **事项页点开一条会话那一张原样用**(`Opened` → `SessionDetail`)——
            完整对话从最新往上翻到开头、附件点得开、底下还能直接说一句,一样都不另写一套。
            摆在这一页里(不是跳去事项页):返回一下就回到那一问,她答完还在原地。
          */}
          {askSession !== null && (
            <Opened
              card={{ id: `ask-session:${askSession.agent}/${askSession.sessionId}`, kind: 'inbox', title: '', dot: 'white', external: askSession }}
              state={feed.state}
              onClose={() => setAskSession(null)}
            />
          )}
        </div>
      )}

      {/*
        对话记录(2026-09-24 起是首页的**下一级页**,卡 fix/phone-nav-back):整屏,顶上一条返回头「‹ 对话记录」,
        系统返回同样回首页。以前是从底下升起来的一块(09-17),靠点遮罩或下滑收起。
      */}
      {log && !inCall && (
        <>
          <div className="ba-scene__log" role="dialog" aria-label={LOG_TITLE}>
            <BackHeader title={records ? TRANSFERS_TITLE : LOG_TITLE} onBack={() => setLog(false)} />
            <div className="ba-scene__logbar">
              <button type="button" className="ba-scene__link" onClick={() => { setLog(false); onOpenInbox?.(); }}>事项</button>
              {/* 资讯(2026-09-21):摆在记录面板里,与「事项」并排 —— 底部按 Ben 的口径
                  只有「通话键 + 输入框」两样,不再加第三样。 */}
              <button type="button" className="ba-scene__link" onClick={() => { setLog(false); onOpenNews?.(); }}>资讯</button>
              {/* 从事项页搬出来的三页(2026-10-01):汇报、各家的历史对话、通话记录,各有各的地方。 */}
              <button type="button" className="ba-scene__link" onClick={() => { setLog(false); onOpenReports?.(); }}>汇报</button>
              <button type="button" className="ba-scene__link" onClick={() => { setLog(false); onOpenHistory?.(); }}>各家对话</button>
              <button type="button" className="ba-scene__link" onClick={() => { setLog(false); onOpenCalls?.(); }}>通话记录</button>
              {/* 会议(2026-09-21):开会时录音,结束后事务官转写并梳理成纪要与待办。 */}
              <button type="button" className="ba-scene__link" onClick={() => { setLog(false); onOpenMeeting?.(); }}>会议</button>
              {/*
                发文件(2026-09-17):走房间的 byte stream 直接到 Mac 上的收件目录。
                摆在记录面板里而不是底部——底部按 Ben 的口径只有「通话键 + 输入框」两样,不再加第三样。
              */}
              <button
                type="button"
                className="ba-scene__link"
                onClick={() => { void channel.refresh().catch(() => { /* 问不到设备表也照样能选文件 */ }); fileInputRef.current?.click(); }}
              >发文件</button>
              <button
                type="button"
                className="ba-scene__link"
                onClick={() => {
                  setRecords((v) => !v);
                  void channel.refresh().catch(() => { /* 同上 */ });
                  void channel.refreshReceived().catch(() => { /* 读不到那个文件夹就是空的 */ });
                }}
              >{records ? '对话' : TRANSFERS_TITLE}</button>
              <button type="button" className="ba-scene__link" onClick={() => { setLog(false); onOpenSettings?.(); }}>设置</button>
              <input
                ref={fileInputRef}
                type="file"
                className="ba-scene__fileinput"
                aria-label="发文件给电脑上的事务官"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  // input 的 value 要清掉:不清的话同一个文件选第二次不会再触发 change。
                  e.target.value = '';
                  if (file === undefined) return;
                  setLog(false);
                  // 先挑设备,挑完才发 —— 见 pendingFile 上面那段。
                  setPendingFile(file);
                }}
              />
            </div>
            {records
              ? (
                <div className="ba-scene__records" role="list" aria-label="传输记录">
                  {/* 收到的文件(卡 J):点名字打开,右边分享。真相是「文档 / 事务官」那个文件夹。 */}
                  <ReceivedFiles
                    files={channel.received}
                    note={channel.receivedNote}
                    onOpen={(file) => { void channel.openFile(file); }}
                    onShare={(file) => { void channel.shareFile(file); }}
                  />
                  <p className="ba-scene__recordhead">
                    此刻在线:{channel.devices.length === 0
                      ? '只有这台手机'
                      : channel.devices.map((device) => `${device.name}(${wbchKindText(device.kind)})`).join('、')}
                  </p>
                  {channel.devicesNote !== null && <p className="ba-scene__recordnote">{channel.devicesNote}</p>}
                  {channel.transfers.length === 0
                    ? <p className="ba-scene__recordnote">还没有传过文件。</p>
                    : channel.transfers.map((record, i) => (
                      <p className="ba-scene__record" role="listitem" key={`${record.at}-${record.name}-${i}`}>
                        {wbchTransferLine(record)}
                      </p>
                    ))}
                </div>
              )
              : (
                <ThreadList
                  thread={thread}
                  voiceOff={voiceOff}
                  // 气泡上那个时刻照电脑的钟写「今天」(2026-10-02,卡 claude/phone-clock),不看手机的墙钟。
                  now={feed.state.now}
                  listRef={logRef}
                  // 「没送到」那一句重发(带原来的请求号)/ 电脑答了不行的收起(2026-10-12,卡「手机交代只执行一次」)。
                  onResend={(localId) => { void resend(localId).then((r) => { if (!r.ok && r.error !== undefined) setToast(r.error); }); }}
                  onDismiss={dismiss}
                  sayState={feed.state}
                  sayBusy={choosing}
                  onSayChoice={(message, choice, askId, suggestId, decidedId) => { if (message.localId !== undefined) void choose(message.localId, choice, askId, suggestId, decidedId).then(result => { if (!result.ok && result.error) setToast(result.error); }); }}
                  className="ba-chat__thread ba-scene__logthread"
                  // 他自己点了「重听」却没念(在外面、电脑那边没开通):说一句为什么,别让这一下像没按着(2026-09-25,卡 S)。
                  onReplay={(m) => { void speaker.speakText(`${m.taskId}:${m.butler.text}`, m.butler.text).then((why) => { if (why !== undefined) setToast(why); }); }}
                />
              )}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * 「另外 N 件等你确认」(2026-09-25,卡 fix/confirm-cancel;卡 M 追加起它就是「等你」那一堆去掉这一页上已经摆着的)。
 * 一件都没有时整节不画。每一行是一颗键:点下去去它那一页(办完了等你确认的 → 那一件的详情,**不在这里放「通过」**:
 * 通过之前要看得见它交回来的是什么,那在详情里)。提议在电脑上定,那一行只是一句话。
 */
function OtherConfirms({ items, state, onOpen }: {
  items: readonly WaitingRow[];
  /** 认那一家用的(卡 LG3:「X 在等你选」那一行名字前那张 logo)。 */
  state?: WorkbenchState;
  onOpen(row: WaitingRow): void;
}) {
  if (items.length === 0) return null;
  return (
    <section className="ba-setup-others" aria-label={otherConfirmsTitle(items.length)}>
      <h2 className="ba-setup-others__title">{otherConfirmsTitle(items.length)}</h2>
      <ul className="ba-setup-others__list">
        {items.map((item) => (
          <li key={item.id}>
            {item.kind === 'proposal'
              ? (
                  <div className="ba-setup-others__row" data-static="true">
                    <span className="ba-setup-others__text">{item.text}</span>
                    {item.note !== undefined && <span className="ba-setup-others__note">{item.note}</span>}
                  </div>
                )
              : (
                  <button type="button" className="ba-setup-others__row" onClick={() => onOpen(item)}>
                    {/* 别家的会话在等他那一行(卡 LG3):图画在那句话里面 —— 这一行是 grid,每一格都指好了列。 */}
                    <span className="ba-setup-others__text">
                      {item.agent !== undefined && <><AgentIcon agent={item.agent} state={state} size={AGENT_ICON_SIZE_SMALL} />{' '}</>}
                      {item.text}
                    </span>
                    {item.note !== undefined && <span className="ba-setup-others__note">{item.note}</span>}
                    <span className="ba-setup-others__chev" aria-hidden="true">›</span>
                  </button>
                )}
          </li>
        ))}
      </ul>
    </section>
  );
}
