/**
 * 事项页:顶上钉四个标签「在办 · 等你 · 排着 · 办完」,点哪个下面只摆那一块(2026-10-01,
 * 维护者:「什么信息都在里面,太乱了」「还不分区,一滑走就找不到了」;梳理见 docs/梳理-1001-手机事项页.md)。
 * 不是「事」的都不在这一页:汇报、各家对话、通话记录各一页(RecordPages.tsx),资讯搜索结果只在资讯页,测试单子不摆。
 * 分桶的规矩在 inboxTabs.ts;点开一张看到什么(Opened)照旧。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSession } from '../session';
import { useFeed, formatClock } from '../hooks';
import { externalSessionCard, itemCard, sessionStatusText, taskById, type ItemCard } from './itemsModel';
import { INBOX_TABS, doneByDay, inboxBuckets, type InboxTab } from './inboxTabs';
import { dispatchReplyOf, replyOf } from '../chat/chatModel';
// 这件事里她在问他 / 要他批(卡 M 补):事项页里就能答、能批,同电脑「在工作台里看」那一张 —— 同一套卡。
import { PhoneApprovalAsk, PhoneQuestionAsk } from '../asks/AskCards';
import { answerApprovalScoped, answerQuestion } from '../asks/asksApi';
import { FeatureDeckPage } from '../feature/FeatureDeckPage';
import { isFeatureTask } from '../feature/featureModel';
import { dispatchAskText, dispatchWho, driveLabel, friendlyWhen, isEvidenceProposal, ownerAskOf, OWNER_ASK_TITLES, progressNoneHint, SESSION_WINDOW_ONLY_MEDIA_NOTE, sessionActivityLine, sessionChildLine, sessionChildrenLine, sessionDisplayTitle, taskOriginOf, type SessionAttachmentRef, type SessionChildView, type TaskView, type WorkbenchState, ITEM_EVIDENCE_SOURCE_TITLES, ITEM_STANDING_ACTION_TITLES, ITEM_STANDING_CASE_TITLES, itemStandingRequest, standingWaitingText } from '../api/protocol';
import { useBackHandler } from '../nav/back';
import { blockLine, budgetLine, pausedLine, stoppable } from './itemControls';
import { agentColor, agentsBlockedLine, agentTitle, externalRunning } from '../stage/stageCardsModel';
import { TodayTodos } from './TodayTodos';
import { TranscriptView, useTranscript } from './SessionTranscript';
/** 最近几轮那一段(2026-10-04 搬出去的:「等你确认」那张卡也要摆它,两处读同一处)。 */
import { SessionRoundsList, useSessionDigest } from './SessionRounds';
import { AttachmentStrip, AttachmentViewer } from './attachments/Attachments';
import { attachmentKeep, type AttachmentTarget } from './attachments/attachmentsApi';
import { pullFileOffer } from '../files/fileFetch';
// 各家的 logo(2026-09-26,卡 LG3):卡片那一格、「派给」那一格、会话详情抬头、「先交给 X 做」那几颗键。
import { AgentIcon, AGENT_ICON_SIZE_SMALL } from '../agents/AgentIcon';
// 会话卡下面那个输入框(2026-09-27,卡 PS):直接把话说进那条会话里(捎话)。
import { SessionSayBox, SAY_NO_RECORD, SAY_NOT_OPEN, SAY_OLD_WORKBENCH } from './SessionSayBox';
import { ItemContinueBox } from './ItemContinueBox';

/**
 * 「存到手机上」(2026-10-04,卡「手机看各家对话里的图片和文件」)。
 *
 * 对话里的附件在手机上看不了全(压缩包、设计稿、几百 MB 的视频)时,她点一下就把原件拿到手机里 ——
 * 走的是**现成的那一套**:`view=keep` 让电脑开一张取件单,再用取文件那一下取
 * (在家直连 `GET /files/offer/<单号>`,出门让工人经房间推)。这里不另造传输路、也不碰路径。
 * 出门经房间那条是「电脑开始推了」,字节随后由通道层收下并落盘 —— 那一句如实说。
 */
export async function keepAttachment(session: ReturnType<typeof useSession>, target: AttachmentTarget): Promise<string> {
  const opened = await attachmentKeep(session.client, target);
  if (!opened.ok) return opened.error;
  const hit = opened.value;
  const outcome = await pullFileOffer(hit, {
    mode: () => session.client.mode(),
    direct: session.direct,
    ...(session.channel.pullOffer === undefined ? {} : { pullViaRoom: (offer: string) => session.channel.pullOffer!(offer) }),
  });
  if (!outcome.ok) return `「${hit.name}」没取回来:${outcome.error}`;
  if (outcome.via === 'direct') return `收到「${outcome.saved.name}」,存在${outcome.saved.where}`;
  return `电脑在推「${hit.name}」,到了会落在手机的「文档 / 事务官」里`;
}

export function Card({ card, state, onOpen }: { card: ItemCard; state?: WorkbenchState; onOpen(card: ItemCard): void }) {
  // 这一张是某一家的(各家正在办的一条会话、登记表那一档):那一格画它的 logo,状态点挪到图的右下角当角标。
  // 取不到图 / 不是某一家的那些卡:还是原来那一颗点,一个字没变。
  const who = card.external?.agent ?? card.agent?.id;
  const inner = (
    <>
      {who === undefined
        ? <span className="ba-dot" data-dot={card.dot} style={card.tint === undefined ? undefined : { background: card.tint }} aria-hidden />
        : <AgentIcon agent={who} state={state} size={AGENT_ICON_SIZE_SMALL} dot={card.dot} {...(card.tint === undefined ? {} : { tint: card.tint })} />}
      <span className="ba-item__body">
        <span className="ba-item__title">{card.title}</span>
        <span className="ba-item__meta">
          {card.deck !== undefined && <span className="ba-item__deck">{card.deck}卡</span>}
          {card.label !== undefined && <span>{card.label}</span>}
          {card.waitLabel !== undefined && <span className="ba-item__wait">{card.waitLabel}</span>}
          {/* 派出去了没有(2026-09-30):成功不再打电话,那这一格在手机上也得看得见。 */}
          {card.delivery !== undefined && <span className="ba-item__delivery">{card.delivery}</span>}
          {/* 停在哪(2026-10-12):只给要留意的那几种,与电脑卡面同一句。 */}
          {card.standing !== undefined && <span className="ba-item__standing">{card.standing}</span>}
          {card.note !== undefined && <span className="ba-item__note">{card.note}</span>}
          {card.childrenLine !== undefined && <span className="ba-item__children">{card.childrenLine}</span>}
          {/* 这个时刻写不写日期照**电脑的钟**判(2026-10-02,卡 claude/phone-clock):`state` 本来就是可缺的,
              缺了只会是「还没连上」那一瞬,那时 clockOf 自己退回手机的钟(口径见 src/clock.ts)。 */}
          {card.at !== undefined && <span className="ba-item__time">{formatClock(card.at, state?.now)}</span>}
        </span>
      </span>
    </>
  );
  const openable = card.sessionId !== undefined || card.taskId !== undefined || card.external !== undefined || card.agent !== undefined || card.habit !== undefined || card.callRecordId !== undefined;
  return openable
    ? <button type="button" className="ba-item ba-item--tap" onClick={() => onOpen(card)}>{inner}</button>
    : <div className="ba-item">{inner}</div>;
}

/**
 * 「通过」= 事项挪到「完成」(2026-09-24,卡 F:手机上验收派出去的活)。
 * 与电话里说「批准」、座机屏上按「批准」同一条路(`POST /task/move`,房间白名单里有它),
 * 七态转换表不许的那一步服务端回 409 + 一句人话,**原样摆出来**。
 */
async function moveOnPhone(client: ReturnType<typeof useSession>['client'], taskId: string, status: 'done' | 'canceled' | 'todo' | 'confirm'): Promise<string> {
  try {
    const moved = await client.json<{ ok?: boolean; error?: string }>('/task/move', { method: 'POST', body: { id: taskId, status } });
    if (!moved.ok) return moved.error ?? '没挪动';
    if (moved.data?.ok === false) return moved.data.error ?? '工作台没接受';
    if (status === 'todo') return '加上了,在看板「待办」里。';
    if (status === 'confirm') return '收进「等你确认」了,看一眼交回来的。';
    return status === 'done'
      ? '通过了,已经挪到「完成」。'
      : '取消了。卡还在(「办完」那一栏),不删;后台回来的结果也不会再把它挪回「等你确认」。';
  }
  catch (error) { return error instanceof Error ? error.message : '连不上工作台'; }
}

/**
 * 「说一句到哪了」(2026-09-25,卡 N):证据里没找到、或和卡上写的对不上时,他说一句 ——
 * 工作台记成口述证据、当场再核那一张(`POST /progress/said`,房间白名单里有它)。回执原样摆出来。
 */
async function sayProgress(client: ReturnType<typeof useSession>['client'], taskId: string, text: string): Promise<string> {
  try {
    const said = await client.json<{ ok?: boolean; note?: string; error?: string }>('/progress/said', { method: 'POST', body: { task_id: taskId, text } });
    if (!said.ok) return said.error ?? '没记上';
    return said.data?.note ?? said.data?.error ?? '记下了。';
  }
  catch (error) { return error instanceof Error ? error.message : '连不上工作台'; }
}

/**
 * 「现在核一次」「派给 X」(2026-09-25,卡 N;统筹定:手机上也要能派活、验收)。两条都在房间白名单里;
 * 回包的 `note` / `error` 原样摆出来。**真派活之前**先摆出那一问(`dispatchAskText`,与电脑外层卡、卡片弹窗同一句),他点「派」才发。
 */
async function postProgress(client: ReturnType<typeof useSession>['client'], path: '/progress/check' | '/item/drive', taskId: string): Promise<string> {
  try {
    const got = await client.json<{ ok?: boolean; note?: string; error?: string; by?: string }>(path, { method: 'POST', body: { task_id: taskId } });
    if (!got.ok) return got.error;
    if (path === '/progress/check') return got.data?.note === undefined ? '看过了。' : `看过了。${got.data.note}`;
    return got.data?.note ?? '派出去了';
  }
  catch (error) { return error instanceof Error ? error.message : '连不上工作台'; }
}

/**
 * 详情里「停在哪」那一段(2026-10-12,卡「没办完的事项说清楚」):最后一条证据(什么 · 来源 · 时刻)、在等谁、下一步;
 * 四种要分开说的带「继续 / 关掉 / 重派」,走哪个口由 `itemStandingRequest` 一处定(与电脑同表)。
 * 「继续」= 打开这件的那几种不画那颗 —— 她已经在这件里了。回执原样摆出来。
 */
function StandingSection({ task, state }: { task: TaskView; state: WorkbenchState }) {
  const session0 = useSession();
  const [receipt, setReceipt] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const standing = task.standing;
  if (standing === undefined) return null;
  const run = (job: () => Promise<string>): void => {
    setBusy(true);
    void job().then(setReceipt).finally(() => setBusy(false));
  };
  const last = standing.last;
  const at = last === undefined ? '' : friendlyWhen(last.at, state.now);
  return (
    <div className="ba-sheet__progress" aria-label="停在哪">
      <p className="ba-sheet__hint">停在哪:{ITEM_STANDING_CASE_TITLES[standing.case]}{standing.stalled === true && standing.idle_days !== undefined ? ` · 停了 ${standing.idle_days} 天` : ''}</p>
      {last !== undefined && <p className="ba-sheet__desc">最后一条:{last.what}({ITEM_EVIDENCE_SOURCE_TITLES[last.source]}{at === '' ? '' : ` · ${at}`})</p>}
      <p className="ba-sheet__hint">{standingWaitingText(standing, standing.agent === undefined ? undefined : dispatchWho(standing.agent, state))}</p>
      <p className="ba-sheet__desc">下一步:{standing.next}</p>
      {(standing.actions ?? []).length > 0 && (
        <div className="ba-sheet__acts">
          {(standing.actions ?? []).map((action) => {
            const request = itemStandingRequest(task.id, standing.case, action);
            if ('open' in request) return null;
            const job = request.path === '/task/move'
              ? () => moveOnPhone(session0.client, task.id, request.body.status)
              : () => postProgress(session0.client, '/item/drive', task.id);
            return (
              <button key={action} type="button" className={action === 'close' ? 'ba-btn ba-btn--ghost' : 'ba-btn'} disabled={busy} onClick={() => run(job)}>
                {ITEM_STANDING_ACTION_TITLES[action]}
              </button>
            );
          })}
        </div>
      )}
      {receipt !== undefined && <p className="ba-sheet__hint" role="status">{receipt}</p>}
    </div>
  );
}

/** 详情里「现在到哪」那一段:按证据说的进度、依据(出处 + 时刻 + 逐字那一句)、几点看的;没找到 / 对不上时能说一句。 */
function ProgressSection({ task, now }: { task: TaskView; now: string }) {
  const session0 = useSession();
  const [text, setText] = useState('');
  const [receipt, setReceipt] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  /** 点了「派给 X」:先摆出那一问,等他点「派」。 */
  const [confirming, setConfirming] = useState(false);
  const progress = task.progress;
  // 老工作台(没有进度核对)卡上两格都没有:整段不画 —— 画了点下去也只会回一句「没接上」。
  if (progress === undefined && task.mover === undefined) return null;
  const drive = driveLabel(task);
  const askSay = progress !== undefined && progress.state !== 'found';
  const run = (job: () => Promise<string>): void => {
    setBusy(true);
    void job().then(setReceipt).finally(() => setBusy(false));
  };
  return (
    <div className="ba-sheet__progress" aria-label="现在到哪">
      {task.mover !== undefined && task.mover.who !== 'none' && <p className="ba-sheet__hint">现在该谁动:{task.mover.line}</p>}
      {progress !== undefined && (
        <>
          <p className="ba-sheet__desc" data-state={progress.state}>{progress.line}</p>
          {/* 没看到进展:补一句我在哪儿找过(与电脑卡片弹窗同一句;照实说,没看对话就不说看过)。 */}
          {progress.state === 'none' && <p className="ba-sheet__hint">{progressNoneHint(progress)}</p>}
          {progress.state === 'mismatch' && progress.mismatch !== undefined && <p className="ba-sheet__hint">和卡上写的对不上:{progress.mismatch}</p>}
          {progress.basis.slice(0, 3).map((one, index) => (
            <p className="ba-sheet__hint" key={`${one.source}:${index}`}>
              依据:{one.source}{one.at === undefined ? '' : ` · ${friendlyWhen(one.at, now)}`}{one.quote === undefined ? '' : ` ·「${one.quote}」`}
            </p>
          ))}
          <p className="ba-sheet__hint">{friendlyWhen(progress.checked_at, now)} 看的</p>
        </>
      )}
      <div className="ba-sheet__acts">
        {drive !== undefined && !confirming && (
          <button type="button" className="ba-btn" disabled={busy} onClick={() => setConfirming(true)}>{drive}</button>
        )}
        <button type="button" className="ba-btn ba-btn--ghost" disabled={busy} onClick={() => run(() => postProgress(session0.client, '/progress/check', task.id))}>现在核一次</button>
      </div>
      {confirming && (
        <div className="ba-sheet__confirm" role="group" aria-label="派活确认">
          <p className="ba-sheet__desc">{dispatchAskText(task.assignee, task.progress, undefined, now)}</p>
          <button type="button" className="ba-btn" disabled={busy} onClick={() => { setConfirming(false); run(() => postProgress(session0.client, '/item/drive', task.id)); }}>{task.assignee === 'dsh' ? '交给她' : '派'}</button>
          <button type="button" className="ba-btn ba-btn--ghost" onClick={() => setConfirming(false)}>先不派</button>
        </div>
      )}
      {askSay && (
        <form
          className="ba-sheet__say"
          onSubmit={(event) => {
            event.preventDefault();
            const said = text.trim();
            if (said === '') return;
            void sayProgress(session0.client, task.id, said).then((note) => { setReceipt(note); setText(''); });
          }}
        >
          <input type="text" aria-label="说一句到哪了" placeholder="说一句到哪了" value={text} onChange={(event) => setText(event.target.value)} />
          <button type="submit" className="ba-btn" disabled={text.trim() === ''}>记下</button>
        </form>
      )}
      {receipt !== undefined && <p className="ba-sheet__hint" role="status">{receipt}</p>}
    </div>
  );
}

/**
 * 「取消这件」(2026-09-25,卡 fix/confirm-cancel)。统筹 0.2.89 真机:一件带交付物的测试题取消不掉 ——
 * 那一次走的是 `/task/update {status}`(那条路由不改状态,却回了 ok);手机上本来也没有取消的口。
 * 走的是同一条 `POST /task/move`,七态转换表说了算;**不删卡**,取消了的卡任何后台回写都挪不回来
 * (转换表里「取消」只能被人挪回待办 / 待排)。已经完成 / 取消的不画这颗键。
 */
/**
 * Agent 登记表那一句上的键(2026-09-25,卡 Q):「新接上一家:XX」上的「知道了」/「这不是 Agent」。与电脑球下那一张同一条路
 * (`POST /agents/*`,房间白名单里有它们),服务端回的那句人话原样摆出来。
 * 拿不准的「XX 像是个 Agent,要接上吗?」是一张提问卡(卡 M 的 asks/AskCards),在「等你确认」里答。
 */
async function sayAboutAgent(client: ReturnType<typeof useSession>['client'], path: string, id: string): Promise<string> {
  try {
    const res = await client.json<{ ok?: boolean; note?: string; error?: string }>(path, { method: 'POST', body: { id } });
    if (!res.ok) return res.error ?? '没办成';
    return res.data?.note ?? res.data?.error ?? '好了';
  }
  catch (error) { return error instanceof Error ? error.message : '连不上工作台'; }
}

function canCancel(status: TaskView['status']): boolean {
  return status !== 'done' && status !== 'canceled';
}

/** 发一条 POST,回执原样说出来(卡 O 那几颗键共用)。 */
async function postOnPhone(client: ReturnType<typeof useSession>['client'], path: string, body: unknown): Promise<string> {
  try {
    const res = await client.json<{ ok?: boolean; note?: string; error?: string }>(path, { method: 'POST', body });
    if (!res.ok) return res.error ?? '没办成';
    if (res.data?.ok === false) return res.data.error ?? res.data.note ?? '工作台没接受';
    return res.data?.note ?? '好了';
  }
  catch (error) { return error instanceof Error ? error.message : '连不上工作台'; }
}

/**
 * 事项详情里「派活的眼睛」那几样(2026-09-25,卡 O):花了多少 / 上限多少、「停掉这一件」、
 * 到上限了的「继续 / 停掉这一件 / 换 X 来做」、派不出去时为什么 + 能换谁。
 * 「登录 Claude」只能在电脑前做:手机上只说一句,不画按钮。
 */
function ItemEyes({ task, state, onReceipt }: { task: TaskView; state: WorkbenchState; onReceipt(text: string): void }) {
  const session0 = useSession();
  const [busy, setBusy] = useState(false);
  const budget = task.budget;
  const block = task.dispatch_block;
  const canStop = stoppable(task, state.sessions);
  if (budget === undefined && block === undefined && !canStop) return null;
  const run = (path: string, body: unknown): void => {
    if (busy) return;
    setBusy(true);
    void postOnPhone(session0.client, path, body).then(onReceipt).finally(() => setBusy(false));
  };
  const paused = budget?.state === 'paused';
  return (
    <div className="ba-sheet__eyes" data-testid="item-eyes">
      {budget !== undefined && <p className="ba-sheet__hint">{budgetLine(budget)}</p>}
      {/* 卡上的备注已经说了的那一句不再念一遍(详情上方就是「备注」)。 */}
      {pausedLine(task) !== undefined && <p className="ba-sheet__desc" role="status">{pausedLine(task)}</p>}
      {blockLine(task) !== undefined && <p className="ba-sheet__desc" role="status">{blockLine(task)}</p>}
      {paused && <button type="button" className="ba-btn" disabled={busy} onClick={() => run('/butler/item/budget', { id: task.id, choice: 'continue' })}>继续</button>}
      {paused && <button type="button" className="ba-btn ba-btn--ghost" disabled={busy} onClick={() => run('/butler/item/budget', { id: task.id, choice: 'stop' })}>停掉这一件</button>}
      {paused && budget?.switch_to !== undefined && (
        <button type="button" className="ba-btn ba-btn--ghost" disabled={busy} onClick={() => run('/butler/item/budget', { id: task.id, choice: 'switch' })}>{`换 ${budget.switch_to} 来做`}</button>
      )}
      {canStop && <button type="button" className="ba-btn ba-btn--ghost" disabled={busy} onClick={() => run('/butler/item/stop', { id: task.id })}>停掉这一件</button>}
      {(block?.alternatives ?? []).map((one) => (
        <button
          type="button"
          key={one.family}
          className="ba-btn ba-btn--ghost"
          disabled={busy}
          onClick={() => run('/dispatch/run', { item_id: task.id, app: one.family, kind: block?.kind })}
        >
          {/* 派不出去时能换谁(卡 O):名字前那一家的 logo,认得出是哪个应用才敢点(卡 LG3)。 */}
          <AgentIcon agent={one.family} state={state} size={AGENT_ICON_SIZE_SMALL} />
          {' '}
          {`先交给 ${one.title} 做`}{one.note === undefined ? '' : `(${one.note})`}
        </button>
      ))}
    </div>
  );
}

function Detail({ card, state, onClose }: { card: ItemCard; state: WorkbenchState; onClose(): void }) {
  const session0 = useSession();
  const [receipt, setReceipt] = useState<string | undefined>(undefined);
  const task = card.taskId === undefined ? undefined : taskById(state, card.taskId);
  // 事务官那一侧的回复 / 状态只对他交代的事有意义(2026-09-25,卡 A):通话纪要、引导排的、会议来的本来就不开会话,
  // 那一格说「会话未开」读起来像坏了。**派给别家的那一件例外**(卡 F):不管是谁交代的(引导落地派的第一件也算),
  // 那家回来的那段话都要看得见 —— 那就是他要验收的东西。
  const dispatched = task === undefined ? undefined : dispatchReplyOf(task);
  const reply = task === undefined ? undefined : dispatched ?? (taskOriginOf(task) !== 'user' ? undefined : replyOf(state, task));
  const dispatchedTo = task === undefined ? undefined : (task.client_dispatch?.family ?? task.dispatch?.family);
  const session = card.sessionId === undefined ? undefined : state.sessions.find((s) => s.session_id === card.sessionId);
  const questions = task === undefined ? [] : (state.questions ?? []).filter((one) => one.task_id === task.id);
  const approvals = task === undefined ? [] : (state.approvals ?? []).filter((one) => one.task_id === task.id);
  return (
    /*
      data-ba-kb-page(2026-10-03,卡 claude/phone-saybox-pinned):这一张卡里也有能打字的框
      (她停着等他那一问的「我自己说」)。iOS 上 `Keyboard.resize: None` 不压视口,不接这一套
      键盘就画在框上面 —— 规矩在 viewport/keyboard.css,对 `.ba-sheet` 整类生效。
    */
    <div className="ba-sheet" role="dialog" aria-label="事项详情" data-ba-kb-page="sheet">
      <div className="ba-sheet__card">
        <p className="ba-sheet__title"><span className="ba-dot" data-dot={card.dot} aria-hidden /> {card.title}</p>
        {task?.desc !== undefined && task.desc !== task.title && <p className="ba-sheet__desc">{task.desc}</p>}
        <dl className="ba-sheet__facts">
          {card.label !== undefined && <><dt>状态</dt><dd>{card.label}</dd></>}
          {/* 「派给 X」那一格(卡 LG3):名字前那一家的 logo —— 一眼看出这件事交给了哪个应用。 */}
          {dispatchedTo !== undefined && (
            <><dt>派给</dt><dd><AgentIcon agent={dispatchedTo} state={state} /> {dispatchWho(dispatchedTo, state)}</dd></>
          )}
          {card.waitLabel !== undefined && <><dt>等什么</dt><dd>{card.waitLabel}</dd></>}
          {card.delivery !== undefined && <><dt>派出去了吗</dt><dd>{card.delivery}</dd></>}
          {session !== undefined && <><dt>会话</dt><dd>{session.title ?? session.session_id}{session.status === 'running' ? ' · 在跑' : ''}</dd></>}
          {card.note !== undefined && <><dt>备注</dt><dd>{card.note}</dd></>}
          {card.at !== undefined && <><dt>时间</dt><dd>{formatClock(card.at, state.now)}</dd></>}
        </dl>
        {/* 她停着等他:那一问 / 那一条就摆在这里(选项、「我自己说」、批不批),不只是一句「等你回答」(卡 M 补)。 */}
        {questions.map((question) => (
          <PhoneQuestionAsk key={question.id} question={question} answer={(answers) => answerQuestion(session0, question.id, answers)} onReceipt={setReceipt} now={state.now} />
        ))}
        {approvals.map((approval) => (
          <PhoneApprovalAsk key={approval.id} approval={approval} answer={(allow, scope) => answerApprovalScoped(session0, approval.id, allow, scope)} onReceipt={setReceipt} agents={state} />
        ))}
        {reply !== undefined && reply.waiting === undefined && (
          <div className={`ba-bubble ba-bubble--butler ba-bubble--${reply.kind}`}><p>{reply.text}</p></div>
        )}
        {task !== undefined && <ItemEyes task={task} state={state} onReceipt={setReceipt} />}
        {task !== undefined && <StandingSection task={task} state={state} />}
        {task !== undefined && <ProgressSection task={task} now={state.now} />}
        {/* 接着这件事做(2026-10-23,卡 A):发给哪条来源由服务端认,这里只从能续的几条里选。 */}
        {task !== undefined && <ItemContinueBox taskId={task.id} />}
        {/* 证据里冒出来的下一步(卡 N):「加上」挪进「待办」,「不要」改取消。 */}
        {task !== undefined && isEvidenceProposal(task) && (
          <>
            <button type="button" className="ba-btn" onClick={() => { void moveOnPhone(session0.client, task.id, 'todo').then(setReceipt); }}>加上</button>
            <button type="button" className="ba-btn ba-btn--ghost" onClick={() => { void moveOnPhone(session0.client, task.id, 'canceled').then(setReceipt); }}>不要</button>
          </>
        )}
        {task !== undefined && task.status === 'confirm' && ownerAskOf(task) === undefined && (
          <p className="ba-sheet__hint">事务官核验中:标了要拍板的事(带方案与依据)才回到你手上。</p>
        )}
        {task !== undefined && ownerAskOf(task) !== undefined && (
          <div className="ba-sheet__hint">
            <p>要拍板:{OWNER_ASK_TITLES[ownerAskOf(task)!.kind]}</p>
            <p>方案:{ownerAskOf(task)!.proposal}</p>
            <p>依据:{ownerAskOf(task)!.basis}</p>
          </div>
        )}
        {task !== undefined && ownerAskOf(task) !== undefined && (
          <button type="button" className="ba-btn" onClick={() => { void moveOnPhone(session0.client, task.id, 'done').then(setReceipt); }}>通过</button>
        )}
        {task !== undefined && canCancel(task.status) && !isEvidenceProposal(task) && (
          <button type="button" className="ba-btn ba-btn--ghost" onClick={() => { void moveOnPhone(session0.client, task.id, 'canceled').then(setReceipt); }}>取消这件</button>
        )}
        {card.agent !== undefined && card.agent.notice_id !== undefined && (
          <button type="button" className="ba-btn" onClick={() => { void sayAboutAgent(session0.client, '/agents/notice/dismiss', card.agent!.notice_id!).then(setReceipt); }}>知道了</button>
        )}
        {card.agent !== undefined && (
          <button type="button" className="ba-btn ba-btn--ghost" onClick={() => { void sayAboutAgent(session0.client, '/agents/not-agent', card.agent!.id).then(setReceipt); }}>这不是 Agent</button>
        )}
        {/* 新学到一条(2026-10-10):直接撤(撤错了在「它学到了什么」里能恢复)/ 知道了收掉这一句。两条都在房间白名单里。 */}
        {card.habit !== undefined && (
          <button type="button" className="ba-btn ba-btn--ghost" onClick={() => { void postOnPhone(session0.client, '/habits/revoke', { id: card.habit!.id }).then(setReceipt); }}>撤掉</button>
        )}
        {card.habit !== undefined && (
          <button type="button" className="ba-btn" onClick={() => { void postOnPhone(session0.client, '/habits/seen', { id: card.habit!.id }).then(setReceipt); }}>知道了</button>
        )}
        {receipt !== undefined && <p className="ba-sheet__hint" role="status">{receipt}</p>}
        <button type="button" className="ba-btn ba-btn--ghost" onClick={onClose}>关闭</button>
      </div>
    </div>
  );
}

/** 一条会话底下的后台任务(卡 Q):「内含 3 项后台任务 · 在跑 2」+「展开」;展开后一项一行,不露 id、型号。 */
export function PhoneSessionChildren({ items, now }: { items: readonly SessionChildView[] | undefined; now: string }) {
  const [open, setOpen] = useState(false);
  const line = sessionChildrenLine(items);
  if (items === undefined || line === undefined) return null;
  return (
    <section className="ba-sheet__children" aria-label="后台任务">
      <p className="ba-sheet__hint">
        {line}{' '}
        <button type="button" className="ba-scene__link" aria-expanded={open} onClick={() => setOpen((value) => !value)}>{open ? '收起' : '展开'}</button>
      </p>
      {open && (
        <ol className="ba-rounds">
          {items.map((child) => (
            <li key={child.id} data-status={child.status}>
              <p className="ba-rounds__reply">{child.title}</p>
              <small className="ba-rounds__did">{sessionChildLine(child, now)}</small>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/**
 * 点开「某家在跑的一条会话」(2026-09-25,卡 P;维护者:「事务官中并没有显示会话的标题和内容」)。
 * 与电脑事务官页同一个口(`GET /sessions/digest`,当场读,不经模型):标题、哪一家现在怎样、在哪个项目、
 * 在做什么、最近几轮。读不到就说读不到。不露会话 id。
 *
 * **最近几轮要及时**(2026-09-27,卡 PS,维护者原话第一句):
 *   ① 开着的时候 {@link DIGEST_POLL_MS} 再读一次(原来 15 秒 —— 他站在那儿等一句回话,15 秒像坏了);
 *   ② **那条会话一动就读**:/state 里这一条的 `updated_at` / 在做什么 / 状态一变就立刻再读一次
 *      (会话动静跟着文件走,卡 LK;所以这一条不是定时器,是跟着那条对话本身走的);
 *   ③ 他自己在下面说完一句、送进去了,也立刻再读一次(不等下一拍)。
 *
 * 2026-10-04(卡 `claude/ask-with-context`):这三条与那几轮怎么摆**搬去了 `items/SessionRounds.tsx`** ——
 * 「等你确认」那张卡也要摆最近几轮,两处读的得是同一处(同一条接口、同一个节拍、同一句读不到时说的话)。
 * 这里一个行为都没变,只是不再自己写那一段。
 */
function SessionDetail({ agent, sessionId, state, onClose }: { agent: string; sessionId: string; state: WorkbenchState; onClose(): void }) {
  const session0 = useSession();
  const [receipt, setReceipt] = useState<string | undefined>(undefined);
  /** 「现在就再读一次」的把手(说完一句之后按一下)。 */
  const [again, setAgain] = useState(0);
  // 登记表里的那一条(卡 Q:读窗口读出来的那几家不在会话流里)。
  const session = state.sessions.find((s) => s.agent === agent && s.session_id === sessionId)
    ?? state.agent_registry?.entries.flatMap((entry) => entry.sessions).find((s) => s.agent === agent && s.session_id === sessionId);
  /** 那条会话此刻的动静(变了就立刻再读一次最近几轮)。会话没了也算一种动静。 */
  const beat = session === undefined ? 'gone' : `${session.updated_at}|${session.status}|${session.activity?.at ?? ''}`;
  const digest = useSessionDigest(session0.client, agent, sessionId, beat, again);
  const { view, error } = digest;
  const name = agentTitle(agent, state);
  // 有记录文件的那几家看完整对话;读窗口读出来的那一条(`window:`)只有标题与最新一句。
  const fullTranscript = !sessionId.startsWith('window:');
  const transcript = useTranscript(session0.client, agent, fullTranscript ? sessionId : '', `${beat}|${again}`);
  // 对话里的附件(卡 C):点开全屏看;同一条对话里的图左右滑着看。电脑不在线时卡上只写一句,不去要。
  const online = useFeed(session0.feed).connected;
  const [viewing, setViewing] = useState<SessionAttachmentRef | undefined>(undefined);
  useBackHandler(viewing !== undefined, () => setViewing(undefined));
  const gallery = useMemo(() => transcript.entries.flatMap((entry) => (entry.k === 'note' ? [] : entry.attachments ?? [])).filter((one) => one.kind === 'image' && one.missing !== true), [transcript.entries]);
  // 「这不是 Agent」要好找(统筹 09-25):点开某一家的会话就有这颗键(事务官自己没有)。
  const entry = state.agent_registry?.entries.find((one) => one.id === agent);
  const title = sessionDisplayTitle({ title: session?.title ?? view?.title ?? transcript.title }, name);
  const project = session?.project ?? view?.project;
  return (
    /*
      这一页是**一条对话**,所以按对话页排(2026-10-03,卡 claude/phone-saybox-pinned;
      维护者 10-03 上午从手机捎来:「给 Agent 发信息的输入框没有默认置顶,用起来得自己下滑,很难受。」):

        抬头(.ba-sheet__head)  —— 哪一家、哪条对话、现在怎样:**不滚**,她永远知道自己在哪;
        对话(.ba-sheet__flow)  —— **只有这一格滚**(原来是整张卡滚,对话自己又滚一遍,两层滚动);
        输入框(.ba-sheet__dock)—— 永远在最下面那一格,**一眼可见**。

      吸底不置顶:单手打字时拇指就在屏幕下沿,与首页那条、通话页那个打字框同一个位置
      (置顶的话打一句字要把手举到屏幕上半截)。软键盘那一下在 viewport/keyboard.css 里 ——
      `data-ba-kb-page` 让 keyboardViewport 认这一页:整页高度钉在没弹键盘那一档、下边界收到键盘上沿。
      「关闭」从卡底挪到抬头那一行:它原来正好压在输入框底下,伸手打字容易点到。
    */
    <div className="ba-sheet" role="dialog" aria-label="会话详情" data-ba-kb-page="session">
      <div className="ba-sheet__card ba-sheet__card--chat">
        <div className="ba-sheet__head">
          {/* 抬头那一格(卡 LG3):这一家的 logo;取不到就是卡 Q 那颗它自己颜色的点(原来的样子)。 */}
          <div className="ba-sheet__bar">
            <p className="ba-sheet__title"><AgentIcon agent={agent} state={state} dot="white" {...(entry?.color === undefined ? {} : { tint: entry.color })} /> {title}</p>
            <button type="button" className="ba-btn ba-btn--ghost ba-sheet__close" onClick={onClose}>关闭</button>
          </div>
          <dl className="ba-sheet__facts">
            <dt>现在</dt><dd>{session === undefined ? `${name} · 已经不在跑了` : sessionStatusText(session, name)}</dd>
            {project !== undefined && project !== '' && <><dt>项目</dt><dd>{project === '未归类' ? '没认出是哪个项目' : project}</dd></>}
            {/* 关掉了的那条(只在记录文件里)没有「在做」可说:不写一句「读不到」。 */}
            {(session !== undefined || view !== undefined) && <><dt>在做</dt><dd>{sessionActivityLine(view?.activity ?? session?.activity, state.now)}</dd></>}
          </dl>
          {/* 它底下的后台任务(卡 Q):一行说几项、在跑几项,点「展开」才一项一行(电脑上同一套说法)。 */}
          <PhoneSessionChildren items={session?.children} now={state.now} />
          {/* 「这不是 Agent」是对**这一家**的一句话,跟抬头那几格是一类:不摆在打字那一格里。 */}
          {entry !== undefined && entry.self !== true && (
            <button type="button" className="ba-btn ba-btn--ghost" onClick={() => { void sayAboutAgent(session0.client, '/agents/not-agent', agent).then(setReceipt); }}>这不是 Agent</button>
          )}
          {receipt !== undefined && <p className="ba-sheet__hint" role="status">{receipt}</p>}
        </div>
        <div className="ba-sheet__flow">
          {/*
            完整对话(2026-10-01,手机读对话 B):从最新往上翻到开头,文字不截断,AI 那句按 Markdown 显示。
            窗口型那几家(没有记录文件)和旧版电脑(没有这条路)照旧是下面那几轮摘要。
          */}
          {fullTranscript && !transcript.unsupported
            ? <section className="ba-sheet__rounds" aria-label="对话">
                <TranscriptView
                  state={transcript}
                  name={name}
                  now={state.now}
                  renderAttachments={(refs) => <AttachmentStrip client={session0.client} agent={agent} sessionId={sessionId} refs={refs} online={online} onOpen={setViewing} />}
                />
              </section>
            : <>
                <SessionRoundsList state={digest} name={name} now={state.now} />
                {/*
                  窗口型那几家(2026-10-04):读窗口只拿到那一句字,没有记录文件 —— 图片与文件
                  一个字节都拿不到。**如实说一句**,不摆空的附件格、也不编一个。
                */}
                {!fullTranscript && <p className="ba-sheet__hint">{SESSION_WINDOW_ONLY_MEDIA_NOTE}</p>}
              </>}
        </div>
        <div className="ba-sheet__dock">
          {/*
            那个输入框(2026-09-27,卡 PS):**直接把话说进这条会话里**。2026-10-03 起它在这一格 ——
            对话在它上面滚,它自己永远在屏幕下沿。
            能不能送由服务端那一格说(`view.relay`);老工作台没有这一格 → 不摆,说清是旧版;
            连记录都读不到 → 也不摆。还在读的时候整段不画(上面那一段已经在说「正在读…」)。
          */}
          <SessionSayBox
            agent={agent}
            name={name}
            sessionId={sessionId}
            ready={view !== undefined
              ? (view.relay ?? { can: false, why: SAY_OLD_WORKBENCH })
              : error !== undefined ? { can: false, why: transcript.entries.length > 0 ? SAY_NOT_OPEN : SAY_NO_RECORD } : undefined}
            now={state.now}
            onSent={() => setAgain((n) => n + 1)}
          />
        </div>
      </div>
      {viewing !== undefined && (
        <AttachmentViewer
          client={session0.client}
          agent={agent}
          sessionId={sessionId}
          item={viewing}
          gallery={gallery}
          online={online}
          onMove={setViewing}
          onClose={() => setViewing(undefined)}
          onKeep={(one) => keepAttachment(session0, { agent, sessionId, ref: one.ref })}
        />
      )}
    </div>
  );
}

/**
 * 点开一张卡看到什么(2026-09-23)。
 *
 * **`kind:'feature'` 的卡点开的是需求卡页**(四态 / 推进 / 四个产物页签 / 把关三键),
 * 别的一律还是那张只读详情卡 —— 老卡的行为一个字没变。
 *
 * 判据只认 `task.kind`,不看标题、不看它在哪一半区:上半区那条「等我确认」如果指的就是
 * 一张需求卡,点开也该是指挥台(那正是第三幕里她被叫去验收的那一下)。
 */
export function Opened({ card, state, onClose }: { card: ItemCard; state: WorkbenchState; onClose(): void }) {
  if (card.external !== undefined) return <SessionDetail agent={card.external.agent} sessionId={card.external.sessionId} state={state} onClose={onClose} />;
  const task = card.taskId === undefined ? undefined : taskById(state, card.taskId);
  if (task !== undefined && isFeatureTask(task)) return <FeatureDeckPage task={task} onClose={onClose} />;
  return <Detail card={card} state={state} onClose={onClose} />;
}

/**
 * 从首页卡片整张点进来时落在哪(2026-09-25;10-01 起是「哪个标签」):
 * 「正在办」→ 在办;「等你确认」→ 等你;「今天要做」→ 排着。`taskId` 直接打开那一张的详情。缺席 = 停在上次看的那个标签。
 */
export interface InboxTarget {
  tab?: InboxTab;
  taskId?: string;
}

function List({ cards, state, onOpen, dim }: { cards: readonly ItemCard[]; state: WorkbenchState; onOpen(card: ItemCard): void; dim?: boolean }) {
  return <ul className={dim === true ? 'ba-list ba-list--dim' : 'ba-list'}>{cards.map((c) => <li key={c.id}><Card card={c} state={state} onOpen={onOpen} /></li>)}</ul>;
}

export function InboxPage({ target, onOpenCollab }: { target?: InboxTarget; onOpenCollab?: () => void } = {}) {
  const session = useSession();
  const feed = useFeed(session.feed);
  const [open, setOpen] = useState<ItemCard | null>(null);
  // 事项页在壳里一直挂着(只是藏起来),不带落点进来就停在上次看的那个标签。
  const [tab, setTab] = useState<InboxTab>(target?.tab ?? 'doing');
  // 系统返回(2026-09-24,卡 fix/phone-nav-back):点开的详情 / 需求卡先收,再按一次才回首页。
  useBackHandler(open !== null, () => setOpen(null));
  const buckets = useMemo(() => inboxBuckets(feed.state), [feed.state]);
  // 各家客户端里此刻在跑的会话(2026-09-25,卡 P):与首页「正在办」、电脑球周围同一个口径(externalRunning)。
  const running = useMemo(() => externalRunning(feed.state).map((s) => externalSessionCard(s, feed.state.now, agentTitle(s.agent, feed.state), agentColor(s.agent, feed.state))), [feed.state]);
  // 电脑上读不了别家窗口(没开「辅助功能」权限 / 壳是旧版):这一格说清为什么,不是一片空白(卡 Q)。
  const blockedLine = agentsBlockedLine(feed.state);
  const counts: Record<InboxTab, number> = {
    doing: running.length + buckets.doing.length,
    waiting: buckets.waiting.length,
    queued: buckets.queued.length,
    done: buckets.done.length,
  };
  // 「今天 / 昨天」按电脑的时钟分(/state.now),与卡上那句「今天 20:17」同一个口径;不看手机自己的钟。
  const days = useMemo(() => doneByDay(buckets.done, feed.state.now), [buckets.done, feed.state.now]);
  /**
   * 首页卡片带进来的目标(同一个对象只认一次:回到首页再点同一张卡是一个新对象,会再认一次)。
   * 要打开的那一张一时还没在 /state 里(刚落的纪要卡)就等下一拍,认到了才算数。
   */
  const handled = useRef<InboxTarget | undefined>(undefined);
  useEffect(() => {
    if (target === undefined || handled.current === target) return;
    if (target.taskId !== undefined) {
      const task = taskById(feed.state, target.taskId);
      if (task === undefined) return;
      handled.current = target;
      setOpen(itemCard(task, feed.state));
      return;
    }
    handled.current = target;
    if (target.tab !== undefined) setTab(target.tab);
  }, [target, feed.state]);
  const cardsOf = (tasks: readonly TaskView[]): ItemCard[] => tasks.map((task) => itemCard(task, feed.state));

  return (
    <div className="ba-inbox">
      {/* 钉在顶上:怎么滑都在,点一下就回到那一块。 */}
      <div className="ba-inbox__tabs" role="tablist" aria-label="事项分区">
        {INBOX_TABS.map((t) => (
          <button key={t.key} type="button" role="tab" className="ba-inbox__tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)}>
            {t.label} <span className="ba-inbox__tabn">{counts[t.key]}</span>
          </button>
        ))}
      </div>
      {/* 协作区入口(2026-10-24,卡「完整手机协作下级页」):目标的进展/分桶/频道在下一级;一行,不动首页。
          2026-11-09:还要 /state.collab_enabled 为真 —— 开源版默认关着时连这颗键都不摆。 */}
      {onOpenCollab !== undefined && feed.state.collab_enabled === true && (
        <button type="button" className="ba-collab__entry" onClick={onOpenCollab}>
          协作区 <span className="ba-collab__entrynote">目标进展 · 分工清单 · 频道</span>
        </button>
      )}
      {!feed.connected && <p className="ba-chat__offline" role="status">{feed.connecting === true ? '正在连接电脑…' : (feed.error ?? '工作台掉线,显示的是上次的状态')}</p>}

      {tab === 'doing' && (
        <div role="tabpanel" aria-label="在办">
          {counts.doing === 0 && blockedLine === undefined && <p className="ba-inbox__empty">这会儿没有在办的事。</p>}
          {(running.length > 0 || blockedLine !== undefined) && (
            <section className="ba-inbox__half" aria-label="各家正在办">
              <h3 className="ba-inbox__sub">各家正在办 {running.length}</h3>
              {blockedLine !== undefined && <p className="ba-inbox__empty" role="status">{blockedLine}</p>}
              {running.length > 0 && <List cards={running} state={feed.state} onOpen={setOpen} />}
            </section>
          )}
          {buckets.doing.length > 0 && (
            <section className="ba-inbox__half" aria-label="AI 与事务官">
              <h3 className="ba-inbox__sub">AI 与事务官 {buckets.doing.length}</h3>
              <List cards={cardsOf(buckets.doing)} state={feed.state} onOpen={setOpen} />
            </section>
          )}
        </div>
      )}

      {tab === 'waiting' && (
        <div role="tabpanel" aria-label="等你">
          {buckets.waiting.length === 0
            ? <p className="ba-inbox__empty">这会儿没有要你拍板的。</p>
            : <List cards={buckets.waiting} state={feed.state} onOpen={setOpen} />}
        </div>
      )}

      {tab === 'queued' && (
        <div role="tabpanel" aria-label="排着">
          {feed.state.today_todos !== undefined && (
            <TodayTodos view={feed.state.today_todos} onOpen={(id) => { const task = taskById(feed.state, id); if (task !== undefined) setOpen(itemCard(task, feed.state)); }} />
          )}
          {buckets.queued.length === 0
            ? <p className="ba-inbox__empty">没有排着的事。</p>
            : <List cards={cardsOf(buckets.queued)} state={feed.state} onOpen={setOpen} />}
        </div>
      )}

      {tab === 'done' && (
        <div role="tabpanel" aria-label="办完">
          {days.length === 0 && <p className="ba-inbox__empty">还没有办完的事。</p>}
          {days.map((day) => (
            <section key={day.label} className="ba-inbox__half" aria-label={day.label}>
              <h3 className="ba-inbox__sub">{day.label}</h3>
              <List cards={cardsOf(day.tasks)} state={feed.state} onOpen={setOpen} dim />
            </section>
          ))}
        </div>
      )}

      {open !== null && <Opened card={open} state={feed.state} onClose={() => setOpen(null)} />}
    </div>
  );
}
