/**
 * 从事项页搬出来的三页(2026-10-01,维护者拍板;梳理见 docs/梳理-1001-手机事项页.md):
 *   汇报     —— 开工汇报、下班例程、每周知识 lint(收件箱里的例程汇报),一条一张、原样;
 *   各家最近的对话 —— 各家最近 7 天的对话(原来事项页里那段「最近的对话」);
 *   通话记录 —— 一通一份记录(2026-10-22 起不是事项,读 `/state.calls`),新的在前;这一天之前的老纪要卡排在后面。
 *              首页「最近一次通话」点进来直接打开那一通。
 * 入口都在首页右上角记录面板里。点开一张看到什么照用事项页那一套(Opened)。
 *
 * 2026-10-03(卡「手机各家最近会话固定入口」):「各家最近的对话」**另有一条不带任何条件的入口在首页上**;
 * 当天下午(卡「首页侧边小图标」)那条入口改成了球那一栏右边那一列小图标里的一颗
 * (stage/HomeRail.tsx;记录面板里那一颗照旧留着,是第二条路)。那一页本身改成按家、按项目分组,见下面 HistoryPage。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSession } from '../session';
import { formatClock, useFeed } from '../hooks';
import { useBackHandler } from '../nav/back';
import { itemCard, taskById, type ItemCard } from './itemsModel';
import { callTasks, reportItems } from './inboxTabs';
import { HISTORY_ASKING_TEXT, HISTORY_FLAT_NOTE, familyGroups, historyCard, recentHistoryItems, useSessionHistory } from './sessionHistory';
import { agentColor, agentTitle, callDurationText, callRecordEntries, externalRecent } from '../stage/stageCardsModel';
import { externalSessionCard } from './itemsModel';
import { Card, Opened } from './InboxPage';
import { Markdown } from '../ui/Markdown';
// 组头那张 logo:与首页「正在办」那几行同一份(2026-09-26,卡 LG3)。
import { AgentIcon, AGENT_ICON_SIZE_SMALL } from '../agents/AgentIcon';
import { RECENT_SESSIONS_TITLE } from '../nav/navModel';
import { SESSION_HISTORY_DAYS, SESSION_HISTORY_PER_FAMILY, STATUS_TITLES, type CallRecordItemLinkView, type CallRecordView, type WorkbenchState } from '../api/protocol';
import './recentSessions.css';

export function ReportsPage() {
  const session = useSession();
  const feed = useFeed(session.feed);
  const items = useMemo(() => reportItems(feed.state), [feed.state]);
  return (
    <div className="ba-inbox">
      {items.length === 0 && <p className="ba-inbox__empty">还没有汇报。早上开工、晚上下班时事务官会各写一份。</p>}
      {items.map((item) => (
        <article key={item.id} className="ba-report">
          {/* 这一份汇报那个时刻照电脑的钟写「今天」(2026-10-02,卡 claude/phone-clock)。 */}
          <h3 className="ba-inbox__sub"><span>{item.title}</span>{item.at !== undefined && <span className="ba-report__at"> · {formatClock(item.at, feed.state.now)}</span>}</h3>
          {item.note !== undefined && <div className="ba-report__body"><Markdown text={item.note} /></div>}
        </article>
      ))}
    </div>
  );
}

export interface CallsTarget {
  /** 首页「最近一次通话」带进来的那一通:直接打开(通话记录的编号;老纪要卡就是卡的 id)。 */
  callId?: string;
}

/** 一份通话记录在列表里那一张(与老纪要卡同一个样子:摘要是标题,时长在旁边,时刻在最右)。 */
function recordCard(record: CallRecordView): ItemCard {
  const long = callDurationText(record.duration_seconds);
  return { id: `call:${record.id}`, kind: 'mine', title: record.summary, dot: 'gray', ...(long === undefined ? {} : { note: long }), at: record.at, callRecordId: record.id };
}

/** 通话里对那张卡做了什么。 */
function didText(link: CallRecordItemLinkView): string {
  if (link.did === 'created') return '建了';
  if (link.did === 'moved') return link.to === undefined ? '挪了' : `挪到「${STATUS_TITLES[link.to]}」`;
  return '补了一句';
}

/**
 * 一通电话点开(2026-10-22)。**沿用事项详情那一张的样子**(`ba-sheet` 那一套),不另起一套:
 * 摘要、几点、多长;通话里建过 / 挪过的事项(点得开,点开就是那件事);可能要办;双方原话。
 */
function CallRecordSheet({ record, state, onClose, onOpenTask }: { record: CallRecordView; state: WorkbenchState; onClose(): void; onOpenTask(card: ItemCard): void }) {
  const long = callDurationText(record.duration_seconds);
  const maybe = record.maybe_todo ?? [];
  return (
    <div className="ba-sheet" role="dialog" aria-label="通话详情">
      <div className="ba-sheet__card">
        <p className="ba-sheet__title"><span className="ba-dot" data-dot="gray" aria-hidden /> {record.summary}</p>
        <dl className="ba-sheet__facts">
          <dt>时间</dt><dd>{formatClock(record.at, state.now)}</dd>
          {long !== undefined && <><dt>时长</dt><dd>{long}</dd></>}
        </dl>
        {record.items.length > 0 && (
          <section aria-label="通话里建过、挪过的事项">
            <p className="ba-sheet__hint">通话里建过、挪过的事项</p>
            <ul className="ba-list">
              {record.items.map((link) => {
                const task = taskById(state, link.task_id);
                if (task === undefined) return <li key={`${link.did}:${link.task_id}`}><p className="ba-sheet__hint">{didText(link)}:{link.title ?? link.task_id}(已不在看板上)</p></li>;
                const card = itemCard(task, state);
                return <li key={`${link.did}:${link.task_id}`}><Card card={{ ...card, label: didText(link) }} state={state} onOpen={onOpenTask} /></li>;
              })}
            </ul>
          </section>
        )}
        {maybe.length > 0 && (
          <section aria-label="可能要办">
            <p className="ba-sheet__hint">可能要办 —— 你明说要记,通话里没建成卡。没替你建,要办就再说一句。</p>
            <p className="ba-sheet__desc">{maybe.map((one) => `「${one}」`).join('\n')}</p>
          </section>
        )}
        <p className="ba-sheet__desc">{record.kind === 'onboarding'
          ? '引导那一通不落全文:你答的每一项都在引导存档与记忆文件里。'
          : record.transcript.length === 0
            ? '这通电话没有留下转写。'
            : record.transcript.map((line) => `${line.who === 'me' ? '我' : '事务官'}:${line.text}`).join('\n')}</p>
        <button type="button" className="ba-btn ba-btn--ghost" onClick={onClose}>关闭</button>
      </div>
    </div>
  );
}

export function CallsPage({ target }: { target?: CallsTarget } = {}) {
  const session = useSession();
  const feed = useFeed(session.feed);
  const [open, setOpen] = useState<ItemCard | null>(null);
  const [openRecord, setOpenRecord] = useState<CallRecordView | null>(null);
  useBackHandler(open !== null || openRecord !== null, () => { setOpen(null); setOpenRecord(null); });
  // 通话记录在前(新的在前),这一天之前的老纪要卡排在后面(记录一律比老卡新)。
  const records = useMemo(() => callRecordEntries(feed.state).map((entry) => entry.record!), [feed.state]);
  const cards = useMemo(
    () => [...records.map(recordCard), ...callTasks(feed.state).map((task) => itemCard(task, feed.state))],
    [records, feed.state],
  );
  const openCard = (card: ItemCard): void => {
    const record = card.callRecordId === undefined ? undefined : records.find((one) => one.id === card.callRecordId);
    if (record !== undefined) { setOpenRecord(record); return; }
    setOpen(card);
  };
  // 同一个对象只认一次;那一通一时还没进 /state(刚挂断)就等下一拍。
  const handled = useRef<CallsTarget | undefined>(undefined);
  useEffect(() => {
    if (target?.callId === undefined || handled.current === target) return;
    const record = records.find((one) => one.id === target.callId);
    if (record !== undefined) { handled.current = target; setOpenRecord(record); return; }
    const task = taskById(feed.state, target.callId);
    if (task === undefined) return;
    handled.current = target;
    setOpen(itemCard(task, feed.state));
  }, [target, records, feed.state]);
  return (
    <div className="ba-inbox">
      {cards.length === 0
        ? <p className="ba-inbox__empty">还没有通话记录。打一通电话,挂断后这里多一条。</p>
        : <ul className="ba-list" aria-label="通话记录">{cards.map((c) => <li key={c.id}><Card card={c} state={feed.state} onOpen={openCard} /></li>)}</ul>}
      {openRecord !== null && <CallRecordSheet record={openRecord} state={feed.state} onClose={() => setOpenRecord(null)} onOpenTask={(card) => { setOpenRecord(null); setOpen(card); }} />}
      {open !== null && <Opened card={open} state={feed.state} onClose={() => setOpen(null)} />}
    </div>
  );
}

/**
 * 「各家最近的对话」(2026-10-01 起这一页;2026-10-03 卡「手机各家最近会话固定入口」改成**按家、按项目分好**)。
 *
 * 维护者 10-03 原话:「我说找不到,说明这一页现在的交互路径不可达或是太隐秘或有条件。现在只有『各家在办』
 * 只有运行中或运行中后一点时间才会显示,这显然违背了最初的设计目标。给他一个固定的入口,固定显示每一家最近的
 * 十个会话,最好是按项目分好的。」所以这一页:
 *   - 入口在**首页**那条常驻的「各家最近的对话」上(StagePage;记录面板里那一颗照旧留着,是第二条路);
 *   - 每家最近 {@link SESSION_HISTORY_PER_FAMILY} 条,**在跑的也在**(不许一条对话跑起来 / 停下来就从这里消失);
 *   - 一家一折叠组(组头 = 家名 + 条数),家底下按项目分;没有项目的归「未分项目」;
 *   - 点一条照旧进原来那张会话页(替她答 / 捎话那一套一个字没动)。
 *
 * 退路两条,都不空白:电脑连这条路都没有(404)→ 退回会话表那一份;电脑有这条路但不认 `per_family`
 * → 退回原来那条平列表 + {@link HISTORY_FLAT_NOTE},「再往前看」照旧能翻。
 */
export function HistoryPage() {
  const session = useSession();
  const feed = useFeed(session.feed);
  const [open, setOpen] = useState<ItemCard | null>(null);
  useBackHandler(open !== null, () => setOpen(null));
  const history = useSessionHistory(session.client, SESSION_HISTORY_PER_FAMILY);
  /** 电脑按「每家 n 条」给了 → 分组;没给(老电脑把参数当没看见)→ 平列表。 */
  const grouped = history.perFamily !== undefined;
  const groups = useMemo(
    () => (grouped ? familyGroups(history.items, feed.state) : []),
    [grouped, history.items, feed.state],
  );
  // 平列表那两条退路:连这条路都没有 → 会话表那一份;有这条路、不认新参数 → 原来那份(在跑的让给「各家正在办」)。
  const flat = useMemo(() => {
    if (grouped) return [];
    return history.old
      ? externalRecent(feed.state).map((s) => externalSessionCard(s, feed.state.now, agentTitle(s.agent, feed.state), agentColor(s.agent, feed.state)))
      : recentHistoryItems(history.items, feed.state).map((item) => historyCard(item, feed.state));
  }, [grouped, feed.state, history.items, history.old]);
  /** 收起来的那几家(默认全摊开:她要的是「看得见」,不是「再点一下才看得见」)。 */
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
  const total = grouped ? groups.reduce((sum, one) => sum + one.count, 0) : flat.length;
  return (
    <div className="ba-inbox">
      <section className="ba-inbox__half" aria-label={RECENT_SESSIONS_TITLE}>
        <h3 className="ba-inbox__sub">最近的对话 {total}{history.more ? '+' : ''}</h3>
        {/* 说哪一句:还没问到第一份之前只说「正在读…」—— HISTORY_FLAT_NOTE 是一句关于她那台电脑的断言。 */}
        <p className="ba-inbox__empty">{!history.asked
          ? HISTORY_ASKING_TEXT
          : history.old
            ? '电脑上的工作台是旧版,这里只列这次开机以来的;更新之后能看最近 7 天的。'
            : grouped
              ? `每家最近 ${history.perFamily} 条(最近 ${SESSION_HISTORY_DAYS} 天),按项目分好 —— 点进去从头看到尾,也能直接说一句。`
              : HISTORY_FLAT_NOTE}</p>
        {history.error !== undefined && <p className="ba-inbox__empty" role="status">{history.error}</p>}
        {grouped
          ? (
            <>
              {groups.length === 0 && history.asked && !history.loading && (
                <p className="ba-inbox__empty">还没有哪一家有最近的对话。派一件活、或者捎一句话,这里就有了。</p>
              )}
              {groups.map((group) => {
                const shown = !folded.has(group.agent);
                return (
                  <section className="ba-recent__family" key={group.agent} aria-label={group.name}>
                    <h4 className="ba-recent__head">
                      <button
                        type="button"
                        className="ba-recent__toggle"
                        aria-expanded={shown}
                        onClick={() => setFolded((prior) => {
                          const next = new Set(prior);
                          if (shown) next.add(group.agent); else next.delete(group.agent);
                          return next;
                        })}
                      >
                        {/* 组头:家名(问主人要的那个名字)+ 条数。 */}
                        <AgentIcon agent={group.agent} state={feed.state} size={AGENT_ICON_SIZE_SMALL} />
                        <span className="ba-recent__name">{group.name}</span>
                        <span className="ba-recent__count">{group.count}</span>
                        <span className="ba-recent__chev" aria-hidden="true">{shown ? '⌄' : '›'}</span>
                      </button>
                    </h4>
                    {shown && group.projects.map((bucket) => (
                      <div className="ba-recent__project" key={bucket.project}>
                        <h5 className="ba-recent__projectname">{bucket.project}</h5>
                        <ul className="ba-list" aria-label={`${group.name} · ${bucket.project}`}>
                          {bucket.cards.map((c) => <li key={c.id}><Card card={c} state={feed.state} onOpen={setOpen} /></li>)}
                        </ul>
                      </div>
                    ))}
                  </section>
                );
              })}
            </>
          )
          : (
            <>
              <ul className="ba-list">{flat.map((c) => <li key={c.id}><Card card={c} state={feed.state} onOpen={setOpen} /></li>)}</ul>
              {history.more && (
                <button type="button" className="ba-btn ba-btn--ghost" disabled={history.loading} onClick={history.loadMore}>
                  {history.loading ? '正在读…' : '再往前看'}
                </button>
              )}
            </>
          )}
      </section>
      {open !== null && <Opened card={open} state={feed.state} onClose={() => setOpen(null)} />}
    </div>
  );
}
