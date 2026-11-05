/**
 * 会议页(2026-09-21)。Ben 原话:
 * 「手机上还有『会议模式』,开完会直接打通这套系统帮忙办事、梳理」。
 *
 * 2026-10-09(卡「会后真机走通」):**这一页只是一张脸**。录音、分段、待传箱都在会话上的会议控制器里
 * (meetingController.ts):电话一响,来电页压上来、这一页被卸下,录音照录;挂断回到这一页,还是同一场。
 * 所以这里**没有**「卸载就停录」那条 cleanup 了 —— 停录只有「结束」一条路。
 *
 * 整屏一页,几段:
 *
 * 1. **在录**:一个大计时器、一根电平条、「暂停 / 结束」。顶上一行说清**屏幕能不能关**;
 *    在外面时说清录音先存在手机上,并摆「现在经中转服务器传」(只管这一场)。
 * 2. **在传**:按了「结束」还有段没上去 —— 不结束,攒着,回家自动传(或者她点那颗键)。
 * 3. **正在整理**:这时候可以离开这一页。
 * 4. **好了**:这一场分**会前 / 会中 / 会后**三个页签看(2026-10-13 起,在 MeetingReview.tsx;默认停在会后 ——
 *    纪要与待办照旧是第一眼看到的)。转写或梳理没成时有一颗「重新整理」(只重做没成的那一截)。
 *
 * **不删任何东西**:这一页上没有一颗能删录音 / 删会议的按钮,服务端也没有那条路由。
 */
import { useCallback, useEffect, useReducer, useRef, useState, useSyncExternalStore } from 'react';
import { useSession } from '../session';
import { openMicSettings, MIC_SETTINGS_LABEL } from '../call/micPermission';
import { createMeetingApi, MEETING_AWAY_TEXT, type MeetingDetail } from './meetingApi';
import type { MeetingController } from './meetingController';
import {
  MEETING_BACKGROUND_TEXT,
  MEETING_INTERRUPTED_LABEL,
  MEETING_INTERRUPTED_TEXT,
  MEETING_KEPT_TEXT,
  MEETING_LEAVE_TEXT,
  MEETING_NO_BACKGROUND_TEXT,
  MEETING_PRIVACY_TEXT,
  MEETING_RECENT_BACK,
  MEETING_RECENT_TITLE,
  MEETING_RELAY_HINT,
  MEETING_RELAY_LABEL,
  MEETING_RETRY_LABEL,
  MEETING_RETRY_TEXT,
  SEGMENT_MS,
  SILENT_HINT_MS,
  SILENT_HINT_TEXT,
  meetingClock,
  meetingLevelBar,
  meetingRecentLine,
  meetingWorkingText,
} from './meetingModel';
import { useBackHandler } from '../nav/back';
import { BackHeader } from '../nav/BackHeader';
import { MEETING_TITLE } from '../nav/navModel';
import type { MeetingPlanView, MeetingRecentView } from '../api/protocol';
import type { StateFeed } from '../api/stateFeed';
import { MeetingPrepPanel, meetingPlanLine } from './MeetingPrepPanel';
import { MeetingReview } from './MeetingReview';

const NO_PLANS: readonly MeetingPlanView[] = [];
const NO_RECENT: readonly MeetingRecentView[] = [];
const noFeed = (): (() => void) => () => {};

/** 会前登记、还没开录的那几场(`/state.meetings.upcoming`)。老会话 / 假会话没有 feed 就是空的。 */
function useUpcoming(feed: StateFeed | undefined): readonly MeetingPlanView[] {
  return useSyncExternalStore(
    feed === undefined ? noFeed : (cb) => feed.subscribe(cb),
    () => feed?.get().state.meetings?.upcoming ?? NO_PLANS,
  );
}

/**
 * 最近整理过的那几场(`/state.meetings.recent`,2026-10-13)。**不含还在录的那一场**:
 * 那一场的脸是这一页本来那一套(计时、结束),不该在列表里再出现一次。
 * 老工作台不给这一格 → 空的 → 整块不出现。
 */
function useRecent(feed: StateFeed | undefined): readonly MeetingRecentView[] {
  return useSyncExternalStore(
    feed === undefined ? noFeed : (cb) => feed.subscribe(cb),
    () => feed?.get().state.meetings?.recent ?? NO_RECENT,
  );
}

export interface MeetingPageProps {
  onClose: () => void;
  /** 缺省用会话上那一个(session.meeting)。用例注入。 */
  controller?: MeetingController;
  /** 「正在整理」时多久问一次电脑(缺省 3 秒;测试调小)。 */
  pollMs?: number;
  /** 计时器走一步是多久(测试调小)。 */
  tickMs?: number;
  /** 一段多长(只用来写「每 N 分钟存一段」那句;缺省十分钟)。 */
  segmentMs?: number;
}

export function MeetingPage(props: MeetingPageProps) {
  const session = useSession();
  const controller = props.controller ?? session.meeting;
  if (controller === undefined) {
    return (
      <div className="ba-meeting">
        <BackHeader title={MEETING_TITLE} onBack={props.onClose} />
        <div className="ba-meeting__main"><p className="ba-meeting__warn" role="alert">会议这一块没接上,重开一次 App 试试。</p></div>
      </div>
    );
  }
  return <MeetingFace {...props} controller={controller} />;
}

function MeetingFace(props: MeetingPageProps & { controller: MeetingController }) {
  const { controller } = props;
  const session = useSession();
  // 只有文字的那几样(看纪要 / 建事项 / 重新整理)走选好路的那个:出门也看得到。老的假会话没有 client 就退回直连。
  const [api] = useState(() => createMeetingApi({ direct: session.direct, routed: session.client ?? session.direct }));
  const state = useSyncExternalStore(controller.subscribe, controller.get);
  const phase = state.phase;
  const [title, setTitle] = useState(state.title);
  const [detail, setDetail] = useState<MeetingDetail | undefined>(undefined);
  const [round, setRound] = useState(0);
  const [pageNote, setPageNote] = useState<string | null>(null);
  const upcoming = useUpcoming((session as { feed?: StateFeed }).feed);
  const recent = useRecent((session as { feed?: StateFeed }).feed);
  /** 点开的那一场待开的会(会前准备)。 */
  const [openPlan, setOpenPlan] = useState<string | null>(null);
  /** 点开的那一场**整理过的**会(2026-10-13):电脑导进来的、或者 App 重开之后想再看一眼的。 */
  const [openDone, setOpenDone] = useState<string | null>(null);
  const plan = upcoming.find(one => one.id === openPlan);
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const loudAtRef = useRef(Date.now());
  const tickMs = props.tickMs ?? 250;

  useEffect(() => { void controller.boot(); }, [controller]);
  // 重开 App 接回来的那一场:标题跟着它。
  useEffect(() => { if (state.title !== '' && title === '') setTitle(state.title); }, [state.title]); // eslint-disable-line react-hooks/exhaustive-deps

  const recording = phase.kind === 'recording' || phase.kind === 'paused';

  /* ——— 计时 + 电平:时间从控制器算(开录时刻减暂停),这一页只按拍重画 ——— */
  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(() => {
      if (controller.level() > 0.01) loudAtRef.current = Date.now();
      redraw();
    }, tickMs);
    return () => clearInterval(timer);
  }, [recording, tickMs, controller]);

  /* ——— 整理进度 ———
     这一页看的是哪一场:自己刚录完那一场(phase.working),或者她从「整理好的会」里点开的那一场。
     两条走的是同一组接口(get / apply / retry / outcome),所以下面只有这一个 id。 */
  const serverId = phase.kind === 'working' ? phase.serverId : (openDone ?? undefined);
  /** 从列表里点开那一下、电脑还没回话的那一瞬(别在这一瞬说「可以先去忙别的」)。 */
  const opening = openDone !== null && detail === undefined;
  useEffect(() => {
    if (serverId === undefined) return;
    let alive = true;
    const ask = async (): Promise<boolean> => {
      const got = await api.get(serverId);
      if (!alive || !got.ok) return false;
      setDetail(got.data);
      return got.data.status === 'done' || got.data.status === 'failed';
    };
    let timer: ReturnType<typeof setInterval> | undefined;
    void ask().then((settled) => {
      if (!alive || settled) return;
      timer = setInterval(() => { void ask().then((done) => { if (done && timer !== undefined) clearInterval(timer); }); }, props.pollMs ?? 3000);
    });
    return () => { alive = false; if (timer !== undefined) clearInterval(timer); };
  }, [serverId, api, props.pollMs, round]);

  const begin = useCallback((planned?: { title: string; id: string }) => {
    setPageNote(null);
    setDetail(undefined);
    setOpenPlan(null);
    setOpenDone(null);
    loudAtRef.current = Date.now();
    // 会前登记过的那一场:标题照它,录音接到同一个会议对象上(2026-10-10)。
    if (planned !== undefined) { setTitle(planned.title); void controller.begin(planned.title, planned.id); return; }
    void controller.begin(title);
  }, [controller, title]);

  const saveOutcome = useCallback(async (settled: 'yes' | 'partly' | 'no', said: string): Promise<boolean> => {
    if (serverId === undefined) return false;
    const result = await api.outcome(serverId, settled, said);
    if (!result.ok) { setPageNote(result.error); return false; }
    setPageNote('记下了这场会的结果。');
    const got = await api.get(serverId);
    if (got.ok) setDetail(got.data);
    return true;
  }, [api, serverId]);

  const retryProcessing = useCallback(async () => {
    if (serverId === undefined) return;
    const result = await api.retry(serverId);
    if (!result.ok) { setPageNote(result.error); return; }
    setPageNote(MEETING_RETRY_TEXT);
    setDetail(undefined);
    setRound(n => n + 1);
  }, [api, serverId]);

  const applyTodos = useCallback(async (ids: readonly string[]): Promise<boolean> => {
    if (serverId === undefined) return false;
    const result = await api.apply(serverId, ids);
    if (!result.ok) { setPageNote(result.error); return false; }
    setPageNote(`建了 ${result.data.created.length} 条事项`);
    const got = await api.get(serverId);
    if (got.ok) setDetail(got.data);
    return true;
  }, [api, serverId]);

  const close = useCallback(() => {
    controller.release();
    props.onClose();
  }, [controller, props]);

  /** 看完一场:从列表里点开的那一场回列表,自己刚录的那一场回首页。 */
  const leave = useCallback(() => {
    if (openDone !== null) { setOpenDone(null); setDetail(undefined); return; }
    close();
  }, [openDone, close]);

  const active = controller.active();
  /**
   * 系统返回(2026-09-24,卡 fix/phone-nav-back):同左上角那颗「‹」—— 录着(含暂停)、在传、断了没收尾的时候
   * **接住、不走**,别的时候回首页。录着时划一下返回就把一场会悄悄扔掉,和通话中划返回不许挂断是同一条。
   */
  // 从「整理好的会」里点开的那一场:返回先回那张列表(leave),不直接退出会议页。
  useBackHandler(true, () => { if (!active) leave(); });

  const upload = state.upload;
  const away = upload.offline && !upload.viaRelay;
  const relayKey = away && upload.pending > 0 && (
    <div className="ba-meeting__center">
      <p className="ba-meeting__hint">{MEETING_AWAY_TEXT}</p>
      <button type="button" className="ba-btn ba-btn--ghost" onClick={() => { void controller.allowRelay(); }}>{MEETING_RELAY_LABEL}</button>
      <p className="ba-meeting__hint ba-meeting__hint--dim">{MEETING_RELAY_HINT}</p>
    </div>
  );
  const uploadTrouble = !away && upload.error !== undefined && (
    <p className="ba-meeting__warn">{`传给电脑没成:${upload.error}${upload.pending > 0 ? `(还有 ${upload.pending} 段在手机上)` : ''}`}</p>
  );
  const silent = phase.kind === 'recording' && Date.now() - loudAtRef.current > SILENT_HINT_MS;
  const note = pageNote ?? state.note ?? null;

  return (
    <div className="ba-meeting">
      {/*
        会议是首页的下一级(2026-09-24):顶上一条返回头「‹ 会议」。
        **录着 / 在传 / 断了没收尾的时候不放别的出口**(同通话态「这时候要走只有挂断」):只留页名、不摆「‹」。
      */}
      <BackHeader title={MEETING_TITLE} {...(active ? {} : { onBack: close })} />
      <div className="ba-meeting__main">
        <div className="ba-meeting__top">
          <input
            className="ba-input ba-meeting__title"
            placeholder="这场会叫什么(可以不填)"
            aria-label="会议标题"
            value={title}
            disabled={serverId !== undefined}
            onChange={e => setTitle(e.target.value)}
          />
        </div>

        {recording && (
          <p className="ba-meeting__bg" data-via={state.via}>
            {state.via === 'native' ? MEETING_BACKGROUND_TEXT : MEETING_NO_BACKGROUND_TEXT}
          </p>
        )}

        {phase.kind === 'idle' && openDone === null && plan !== undefined && (
          <MeetingPrepPanel key={plan.id} plan={plan} api={api} onStart={(planTitle, id) => begin({ title: planTitle, id })} onBack={() => setOpenPlan(null)} />
        )}

        {phase.kind === 'idle' && openDone === null && plan === undefined && upcoming.length > 0 && (
          <div className="ba-meeting__plans">
            <h2 className="ba-meeting__h">待开的会</h2>
            <ul>
              {upcoming.map(one => (
                <li key={one.id}>
                  <button type="button" className="ba-meeting__plan" onClick={() => setOpenPlan(one.id)}>
                    <span>{one.title}</span>
                    <small>{meetingPlanLine(one)}</small>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {phase.kind === 'idle' && openDone === null && plan === undefined && recent.length > 0 && (
          <div className="ba-meeting__plans">
            <h2 className="ba-meeting__h">{MEETING_RECENT_TITLE}</h2>
            <ul>
              {recent.map(one => (
                <li key={one.id}>
                  <button type="button" className="ba-meeting__plan" onClick={() => { setPageNote(null); setDetail(undefined); setOpenDone(one.id); }}>
                    <span>{one.title}</span>
                    <small>{meetingRecentLine(one)}</small>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {phase.kind === 'idle' && openDone === null && plan === undefined && (
          <div className="ba-meeting__center">
            <p className="ba-meeting__hint">开会时按「开始录」,结束之后事务官会转写、梳理成纪要与待办。</p>
            <p className="ba-meeting__hint ba-meeting__hint--dim">{MEETING_PRIVACY_TEXT}</p>
            <button type="button" className="ba-btn ba-btn--big" onClick={() => begin()}>开始录</button>
          </div>
        )}

        {phase.kind === 'starting' && <p className="ba-meeting__status" role="status">正在开始…</p>}

        {recording && (
          <div className="ba-meeting__center">
            <p className="ba-meeting__clock" aria-label="已经录了">{meetingClock(controller.elapsed())}</p>
            <div className="ba-meeting__level" role="presentation" data-paused={phase.kind === 'paused'}>
              <i style={{ width: `${Math.round((phase.kind === 'paused' ? 0 : meetingLevelBar(controller.level())) * 100)}%` }} />
            </div>
            {phase.kind === 'paused' && <p className="ba-meeting__status" role="status">暂停中,没有在录</p>}
            {silent && <p className="ba-meeting__warn">{SILENT_HINT_TEXT}</p>}
            <p className="ba-meeting__segs">
              {`每 ${Math.round((props.segmentMs ?? SEGMENT_MS) / 60000)} 分钟存一段,已经传上去 ${upload.sent} 段`}
              {upload.pending > 0 ? `,还有 ${upload.pending} 段在等` : ''}
            </p>
            <div className="ba-meeting__keys">
              {phase.kind === 'recording'
                ? <button type="button" className="ba-btn ba-btn--ghost" onClick={() => { void controller.pause(); }}>暂停</button>
                : <button type="button" className="ba-btn ba-btn--ghost" onClick={() => { void controller.resume(); }}>继续</button>}
              <button type="button" className="ba-btn ba-btn--danger" onClick={() => { void controller.finish(title); }}>结束</button>
            </div>
          </div>
        )}
        {recording && relayKey}
        {recording && uploadTrouble}

        {phase.kind === 'uploading' && (
          <div className="ba-meeting__center">
            <p className="ba-meeting__status" role="status">正在把录音传给电脑…</p>
            <p className="ba-meeting__segs">{`已经传上去 ${upload.sent} 段,还有 ${upload.pending} 段`}</p>
            {uploadTrouble}
            {/* 在外面也摆:回到家里的网时网络变化不一定报得上来,她点一下就传。 */}
            <button type="button" className="ba-btn" onClick={() => { void controller.retryUpload(); }}>重试</button>
          </div>
        )}
        {phase.kind === 'uploading' && relayKey}

        {phase.kind === 'interrupted' && (
          <div className="ba-meeting__center">
            <p className="ba-meeting__warn" role="alert">{MEETING_INTERRUPTED_TEXT}</p>
            <button type="button" className="ba-btn" onClick={() => { void controller.finish(title); }}>{MEETING_INTERRUPTED_LABEL}</button>
          </div>
        )}

        {serverId !== undefined && detail?.status !== 'done' && detail?.status !== 'failed' && (
          <div className="ba-meeting__center">
            <p className="ba-meeting__status" role="status">
              {opening ? '正在打开…' : meetingWorkingText(detail?.status, detail?.transcribed, detail?.segments)}
            </p>
            {!opening && <p className="ba-meeting__hint">{MEETING_LEAVE_TEXT}</p>}
            <button type="button" className="ba-btn ba-btn--ghost" onClick={leave}>{openDone === null ? '先离开' : MEETING_RECENT_BACK}</button>
          </div>
        )}

        {serverId !== undefined && detail?.status === 'failed' && (
          <div className="ba-meeting__center">
            <p className="ba-meeting__warn" role="alert">{detail.error ?? '整理没成'}</p>
            <p className="ba-meeting__hint">{MEETING_KEPT_TEXT}</p>
            {detail.retryable === true && <button type="button" className="ba-btn" onClick={() => { void retryProcessing(); }}>{MEETING_RETRY_LABEL}</button>}
            <button type="button" className="ba-btn ba-btn--ghost" onClick={leave}>{openDone === null ? '回主页' : MEETING_RECENT_BACK}</button>
          </div>
        )}

        {serverId !== undefined && detail?.status === 'done' && (
          <MeetingReview
            key={detail.id}
            detail={detail}
            onApply={applyTodos}
            onOutcome={saveOutcome}
            onRetry={() => { void retryProcessing(); }}
            onLeave={leave}
            leaveLabel={openDone === null ? '回主页' : MEETING_RECENT_BACK}
          />
        )}

        {phase.kind === 'failed' && (
          <div className="ba-meeting__center">
            <p className="ba-meeting__warn" role="alert">{phase.error}</p>
            {/* 录音**没有被删** —— 这一句必须说,否则人会以为一场会白开了。 */}
            <p className="ba-meeting__hint">{MEETING_KEPT_TEXT}</p>
            {phase.micFix === true && <button type="button" className="ba-btn" onClick={() => { void openMicSettings(); }}>{MIC_SETTINGS_LABEL}</button>}
            <button type="button" className="ba-btn ba-btn--ghost" onClick={close}>回主页</button>
          </div>
        )}

        {note !== null && <p className="ba-meeting__note" role="status">{note}</p>}
      </div>
    </div>
  );
}
