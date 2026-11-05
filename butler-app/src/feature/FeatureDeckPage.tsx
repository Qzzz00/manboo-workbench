/**
 * 手机上的**需求卡页**(2026-09-23,中秋断点 A)。
 *
 * 电脑上那张指挥台(workbench-plugin/src/client/FeatureDeck.tsx)的**手机版**,
 * 同一份接口、同一套四态与页签,但三处刻意不一样:
 *
 *   ① **四个产物页签只读**。他不在手机上改长文 —— 六寸屏上改一份需求文档不是省事,是受罪。
 *      「我自己改」那一键只留痕(意思是"这一份我回电脑上自己改"),**不打开编辑器**。
 *   ② **第二颗键叫「打回」**(电脑上叫「改一改」)。盘上写的仍然是 `revise` 那个 id,
 *      两边看到的是同一条历史;措辞按任务书第 2 条。
 *   ③ **不推进度**。四态那一排点别的一格只把页签翻过去,改进度要 `/task/update`,
 *      那条路没进房间白名单(理由见 channel-worker/src/rpc.ts)。这一版手机上推不动下一态。
 *
 * ★ 2026-09-23「同一个事务官」之后这一页多了**一颗**键:「验收」态的**发版**。
 * 它是这一页唯一要按两次的键(「会合并并发一版,确定?」)—— 重的动作靠界面上那一下,
 * 不靠"只认本机"把她自己挡在外面(docs/设计-同一个事务官-2026-09-23.md 第四节)。
 *
 * ★ 局域网 / 房间两条路这一层**不挑**:拿的是 `session.client`(routedClient),
 * 局域网里它直连 8791,出了局域网自动换成经房间让 Mac 上的工人代理。
 * 界面上只如实写一句「刚才那一条走的是:局域网直连 / 经房间代理」。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSession } from '../session';
import { formatClock, useFeed } from '../hooks';
import type { TaskView } from '../api/protocol';
import {
  DECK_ACTION_TITLES, FEATURE_STAGES,
  type DeckDocView, type FeatureDocTab, type FeatureStage, type FeatureDocsBody,
} from './deckProtocol';
import {
  FEATURE_RECORD_BUTTON, FEATURE_RUN_BUTTON, FEATURE_RUN_HINT,
  FEATURE_SHIP_BUTTON, FEATURE_SHIP_CONFIRM, FEATURE_SHIP_GO, ROUTE_TITLES,
  deckHasChange, deckRunBadge, defaultFeatureTab, docNote, featureDocOf, featureStageOf,
  featureStageView, lastDeckRun, lastFeatureReviewOf, lastRecord, orderedFeatureTabs, reviewBlocked,
} from './featureModel';
import { createFeatureApi, type FeatureReviewAction } from './featureApi';
import './featureDeck.css';

/**
 * 403 时补的那一句。
 *
 * ★ 2026-09-23「同一个事务官」之后,**配对过的手机与本机同权**,需求卡这几条不该再 403。
 * 所以真收到 403 多半是另一回事:这台手机的配对被解除了,或者电脑上跑的还是旧版本。
 * 照实说这两种可能,**不再说"这几条只认本机"**(那句话已经不成立了)。
 */
const FORBIDDEN_HINT = '配对过的设备本该和电脑同权 —— 多半是配对被解除了,或者电脑上还是旧版本。';

function StageRow({ current, shown, onShow }: {
  current: FeatureStage;
  shown: FeatureStage;
  onShow(stage: FeatureStage): void;
}) {
  return (
    <ol className="ba-fd__stages" aria-label="四态">
      {FEATURE_STAGES.map((stage) => (
        <li key={stage}>
          <button
            type="button"
            className="ba-fd__stage"
            data-current={stage === current}
            data-shown={stage === shown}
            aria-current={stage === current ? 'step' : undefined}
            onClick={() => onShow(stage)}
          >
            {stage}
          </button>
        </li>
      ))}
    </ol>
  );
}

/** `now`(2026-10-02,卡 claude/phone-clock):产物那个时刻写不写日期照电脑的钟判,见 src/clock.ts。 */
function DocPanel({ doc, now }: { doc: DeckDocView | undefined; now: string }) {
  const note = docNote(doc);
  return (
    <div className="ba-fd__doc">
      {doc !== undefined && (
        <p className="ba-fd__docmeta">
          <span>{doc.file}</span>
          {doc.updated_at !== undefined && <span className="ba-item__time">{formatClock(doc.updated_at, now)}</span>}
        </p>
      )}
      {note !== undefined
        ? <p className="ba-sheet__hint">{note}</p>
        // **只读**:一个 <pre>,没有 textarea —— 手机上不改长文(见文件头 ①)。
        : <pre className="ba-fd__text">{doc?.text}</pre>}
      {deckHasChange(doc?.diff) && (
        <details className="ba-fd__diff">
          <summary>这一轮改了什么</summary>
          <ul>
            {(doc?.diff ?? []).filter((row) => row.kind !== 'same').map((row, at) => (
              <li key={`${row.kind}-${at}`} data-kind={row.kind}>{row.kind === 'add' ? '+ ' : '- '}{row.text}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

export function FeatureDeckPage({ task, onClose }: { task: TaskView; onClose(): void }) {
  const session = useSession();
  // 产物那个时刻照电脑的钟写「今天」(2026-10-02,卡 claude/phone-clock):这一页原来不订状态流,现在只为那一个时刻读 /state.now。
  const feed = useFeed(session.feed);
  const api = useMemo(() => createFeatureApi(session.client), [session.client]);

  const [view, setView] = useState<FeatureDocsBody | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState<'' | 'load' | 'run' | 'review' | 'record' | 'ship'>('load');
  const [flash, setFlash] = useState<string | undefined>(undefined);
  const [route, setRoute] = useState<'direct' | 'remote' | 'offline' | undefined>(undefined);
  const [shown, setShown] = useState<FeatureStage | undefined>(undefined);
  const [tab, setTab] = useState<FeatureDocTab | undefined>(undefined);
  const [revising, setRevising] = useState(false);
  /** ★ 发版那一颗按过一次没有。**按两次才真发**(见 featureModel 的 FEATURE_SHIP_BUTTON)。 */
  const [shipAsked, setShipAsked] = useState(false);
  const [said, setSaid] = useState('');

  /** 卡上那一格与服务端回的那一格,**以服务端为准**(他在电脑上推过一步,手机的快照可能还是旧的)。 */
  const stage = featureStageOf(view?.stage ?? task.feature_stage);
  const stageShown = shown ?? stage;
  const tabs = orderedFeatureTabs(stageShown);
  const current = tab !== undefined && tabs.includes(tab) ? tab : defaultFeatureTab(stageShown);
  const doc = featureDocOf(view?.docs ?? [], current);
  const reviews = view?.reviews ?? [];
  const badge = deckRunBadge({
    dispatch: task.dispatch,
    clientDispatch: task.client_dispatch,
    lastRunAt: lastDeckRun(reviews)?.at,
  });
  const lastReview = lastFeatureReviewOf(reviews, current);
  const recorded = lastRecord(reviews);
  const position = featureStageView(stage);

  /** 一句失败话怎么说。**原样转达服务端那句**,403 时补一句这条路今天为什么不通。 */
  const failure = useCallback((status: number, text: string): string => (
    status === 403 ? `${text}(${FORBIDDEN_HINT})` : text
  ), []);

  const load = useCallback(async () => {
    setBusy('load');
    const result = await api.docs(task.id);
    setRoute(session.client.mode());
    if (result.ok) { setView(result.data); setError(undefined); }
    else setError(failure(result.status, result.error));
    setBusy('');
  }, [api, failure, session.client, task.id]);

  useEffect(() => { void load(); }, [load]);

  const run = async () => {
    setBusy('run');
    setFlash(undefined);
    const result = await api.run(task.id);
    setRoute(session.client.mode());
    if (!result.ok) { setError(failure(result.status, result.error)); setBusy(''); return; }
    setError(undefined);
    const standin = result.data.standin === true ? '(派不出去,它自己顶着做)' : '';
    setFlash(result.data.sent
      ? `交给事务官了${standin}`
      : `没送进会话:${result.data.note ?? '会话通道没接上'}`);
    setBusy('');
    await load();
  };

  const review = async (action: FeatureReviewAction) => {
    const blocked = reviewBlocked(action, said);
    // 手机自己就知道的事,不白跑一趟房间代理(见 featureModel.reviewBlocked)。
    if (blocked !== undefined) { setFlash(blocked); return; }
    setBusy('review');
    setFlash(undefined);
    const result = await api.review({ id: task.id, tab: current, action, ...(action === 'revise' ? { text: said } : {}) });
    setRoute(session.client.mode());
    if (!result.ok) { setError(failure(result.status, result.error)); setBusy(''); return; }
    setError(undefined);
    // 留痕一定成了;送没送出去是另一回事,分开说(见 FeatureReviewBody 那段)。
    setFlash(action === 'revise'
      ? (result.data.sent ? '打回去了,记下了' : `记下了,但那一句没送进会话:${result.data.note ?? '会话通道没接上'}`)
      : `记下了:${DECK_ACTION_TITLES[action]}`);
    setRevising(false);
    setSaid('');
    setBusy('');
    await load();
  };

  /**
   * ★ 发版(2026-09-23,「同一个事务官」)。**这一颗是这一页唯一要按两次的**:
   * 第一次只把「会合并并发一版,确定?」摆出来,第二次才真打那条接口。
   *
   * 失败**照旧 200 + `ok:false`**(那条闭环八步,停在第几步是执行结果不是接口出错),
   * 所以这里分三种话说:发成了 / 停在哪一步 / 这条路压根没接线(404)。
   */
  const ship = async () => {
    if (!shipAsked) { setShipAsked(true); setFlash(FEATURE_SHIP_CONFIRM); return; }
    setShipAsked(false);
    setBusy('ship');
    setFlash(undefined);
    const result = await api.ship(task.id);
    setRoute(session.client.mode());
    if (!result.ok) { setError(failure(result.status, result.error)); setBusy(''); return; }
    setError(undefined);
    setFlash(result.data.ok
      ? `发出去了${result.data.version === undefined ? '' : `:${result.data.version}`}`
      : `停在「${result.data.stopped_at ?? '不知道哪一步'}」:${result.data.note ?? '没拿到原因'}`);
    setBusy('');
    await load();
  };

  const record = async () => {
    setBusy('record');
    setFlash(undefined);
    const result = await api.record(task.id);
    setRoute(session.client.mode());
    if (!result.ok) { setError(failure(result.status, result.error)); setBusy(''); return; }
    setError(undefined);
    setFlash(result.data.added ? `写进了 ${result.data.path}` : '这一条已经在里面了,没写第二遍');
    setBusy('');
    await load();
  };

  return (
    <div className="ba-sheet" role="dialog" aria-label="需求卡">
      <div className="ba-sheet__card ba-fd">
        <p className="ba-sheet__title">{task.title}</p>
        {view !== undefined && (
          <p className="ba-fd__where">{view.project} · {view.project_path}</p>
        )}
        {route !== undefined && (
          <p className="ba-fd__route" role="status">这一条走的是:{ROUTE_TITLES[route]}</p>
        )}

        <StageRow current={stage} shown={stageShown} onShow={setShown} />
        <p className="ba-fd__now">现在:第 {position.index}/{position.total} 态「{position.stage}」</p>
        {stageShown !== stage && <p className="ba-sheet__hint">点别的一格只是翻页签,不改进度。</p>}

        <p className="ba-sheet__hint">{FEATURE_RUN_HINT[stage]}</p>
        <button type="button" className="ba-btn ba-btn--big" disabled={busy !== ''} onClick={() => void run()}>
          {busy === 'run' ? '交给事务官…' : FEATURE_RUN_BUTTON}
        </button>
        {badge !== undefined && <p className="ba-fd__badge" data-badge={badge}>派活:{badge}</p>}
        {flash !== undefined && <p className="ba-fd__flash" role="status">{flash}</p>}
        {error !== undefined && <p className="ba-fd__error" role="alert">{error}</p>}

        <div className="ba-fd__tabs" role="tablist" aria-label="产物">
          {tabs.map((one) => (
            <button
              key={one}
              type="button"
              role="tab"
              aria-selected={one === current}
              className="ba-fd__tab"
              data-on={one === current}
              onClick={() => setTab(one)}
            >
              {one}
            </button>
          ))}
        </div>
        <DocPanel doc={doc} now={feed.state.now} />

        {lastReview !== undefined && (
          <p className="ba-sheet__hint">
            你上次说:{DECK_ACTION_TITLES[lastReview.action]}
            {lastReview.text !== undefined && ` · ${lastReview.text}`}
          </p>
        )}

        <div className="ba-fd__keys">
          <button type="button" className="ba-btn" disabled={busy !== ''} onClick={() => void review('pass')}>
            {DECK_ACTION_TITLES.pass}
          </button>
          <button type="button" className="ba-btn ba-btn--ghost" disabled={busy !== ''} onClick={() => setRevising(true)}>
            {DECK_ACTION_TITLES.revise}
          </button>
          <button type="button" className="ba-btn ba-btn--ghost" disabled={busy !== ''} onClick={() => void review('self')}>
            {DECK_ACTION_TITLES.self}
          </button>
        </div>
        <p className="ba-sheet__hint">「我自己改」只记一笔,回电脑上改 —— 手机上不编辑长文。</p>

        {revising && (
          <div className="ba-fd__revise">
            <label htmlFor="ba-fd-said">哪儿不对(一句话)</label>
            <textarea
              id="ba-fd-said"
              rows={2}
              value={said}
              onChange={(e) => setSaid(e.target.value)}
            />
            <button type="button" className="ba-btn ba-btn--danger" disabled={busy !== ''} onClick={() => void review('revise')}>
              打回去
            </button>
          </div>
        )}

        {stage === '验收' && (
          <>
            {/*
              ★ 发版那一颗(2026-09-23)。摆在「验收」那一态 —— 设计第一节第 5 步就是
              「他在手机上点通过 → 事务官合并分支、跑发版脚本」。**只有一颗键**,
              但它要按两次:第一次把话摆出来,第二次才真发。
            */}
            <button
              type="button"
              className="ba-btn ba-btn--danger ba-btn--big"
              disabled={busy !== ''}
              onClick={() => void ship()}
            >
              {busy === 'ship' ? '发版中…' : (shipAsked ? FEATURE_SHIP_GO : FEATURE_SHIP_BUTTON)}
            </button>
            <p className="ba-sheet__hint">
              {shipAsked
                ? FEATURE_SHIP_CONFIRM
                : '全量测试 → 合并 main → 发一版 → 电脑热更新。每一步失败就停下来叫你。'}
            </p>
            {shipAsked && (
              <button type="button" className="ba-btn ba-btn--ghost" onClick={() => { setShipAsked(false); setFlash(undefined); }}>
                先不发
              </button>
            )}
          </>
        )}

        {stage === '记录' && (
          <>
            <button type="button" className="ba-btn ba-btn--big" disabled={busy !== ''} onClick={() => void record()}>
              {busy === 'record' ? '写进去…' : FEATURE_RECORD_BUTTON}
            </button>
            {recorded !== undefined && (
              <p className="ba-sheet__hint">已经写进:{recorded.text ?? 'docs/决策记录.md'}</p>
            )}
          </>
        )}

        <button type="button" className="ba-btn ba-btn--ghost" onClick={onClose}>关闭</button>
      </div>
    </div>
  );
}
