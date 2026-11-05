/**
 * 需求卡打开之后那一整块 = **指挥台**(2026-09-22,
 * `docs/审视-用户到底得到什么-2026-09-22.md` 第三节 + 第四节第三幕)。
 *
 * 审视第三节那张表,做产品这一列的缺口逐字:「**需求→拆事项→派对的 Agent→验收→回写文档
 * 这条线没有一个入口**」。这一块就是那个入口,四件事(与选题卡**同一个模式**):
 *
 * 1. **四态**:梳理 / 拆解与派活 / 验收 / 记录。当前那格高亮,点别的一格
 *    **只把那一态的页签翻到前面**,不改进度 —— 改进度是「推进一步」那颗按钮的事;
 * 2. **每态一颗「让事务官推进这一步」**:点了走 `POST /feature/run`,那条路把需求上下文
 *    (项目、仓库路径、已有产物、把关记录)拼成一段话,经 **`/butler/item/say` 同一个端口**
 *    交给事务官。她**不必再交代一遍**;
 * 3. **产物回卡**:四个页签读 `docs/需求/<名>/` 里对应文件,能看能改,改了写回文件;
 *    段落级 diff 摆在下面;
 * 4. **把关三键 + 留痕**:通过 / 打回(带一句话回给事务官,走同一个口)/ 我自己改;
 *    每一次写一行 `审核记录.jsonl`。外加「记录」那一态独有的第五颗:**写进决策记录**。
 *
 * ## 为什么整块与 `TopicDeck.tsx` 长得一样,却不是同一个组件
 *
 * 两边**数据形状一样、措辞与那几块"在场的东西"完全不同**:选题卡上摊的是素材清单、
 * 日历、数据与对标;需求卡上摊的是子事项与项目仓库。把它们硬合成一个组件,
 * 得先拿七八个 props 把每一处措辞与每一块内容都注进去 —— 那时读代码的人要同时想着
 * 两种卡才看得懂任何一行。共用的是**算**(`DeckModel.ts`)与**服务端**(`deckRun.ts`),
 * 那才是会漂的部分;JSX 这一层各写各的,样式类名共用一套 `ben-wb__deck*`。
 *
 * ## 不做本地乐观更新(同选题卡)
 *
 * 正文是**文件**,界面上那一份要是与盘上不一样,她会照着一份不存在的稿子改。
 * 所以保存成功之后重新 `POST /feature/docs` 读一遍。
 */
import { useCallback, useEffect, useState } from 'react'
import type {
  DeckReviewAction, FeatureDocTab, FeatureDocView, FeatureResultView, FeatureReviewEntry,
  FeatureStage, SelfShipStepView, TaskView,
} from '../protocol.ts'
import {
  DECK_REVIEW_ACTIONS, DECK_REVIEW_ACTION_TITLES, FEATURE_HANDS, FEATURE_HAND_TITLES,
  FEATURE_STAGES, featureStageOf, nextFeatureStage,
} from '../protocol.ts'
import { deckRunBadge, lastDeckRun } from './DeckModel.ts'
import {
  FEATURE_RECORD_BUTTON, FEATURE_RUN_HINT, defaultFeatureTab, featureDocOf, featureStageView,
  lastFeatureReviewOf, lastRecord, orderedFeatureTabs,
} from './FeatureDeckModel.ts'

export function FeatureDeck({ task, baseUrl, fetchImpl, onStageChange }: {
  task: TaskView
  baseUrl: string
  fetchImpl: typeof fetch
  /**
   * 「推进一步」把卡挪到下一态。**由外面那一层打 `/task/update`** ——
   * 这一块不自己写卡(改卡只有一条路,见 TaskDialog 的 onUpdate)。
   */
  onStageChange: (stage: FeatureStage) => void
}) {
  const stage = featureStageOf(task.feature_stage)
  const view = featureStageView(stage)
  const [tab, setTab] = useState<FeatureDocTab>(() => defaultFeatureTab(stage))
  const [docs, setDocs] = useState<readonly FeatureDocView[] | undefined>(undefined)
  const [reviews, setReviews] = useState<readonly FeatureReviewEntry[]>([])
  /** 这条需求的目录与仓库(服务端算的,界面只显示)。读不到就缺席 —— **不编一个路径**。 */
  const [where, setWhere] = useState<{ dir?: string, project?: string, project_path?: string }>({})
  /** 正文输入框里此刻的字。`undefined` = 还没进编辑(显示盘上那一份)。 */
  const [draft, setDraft] = useState<string | undefined>(undefined)
  /** 服务端最后说的那句话。**原样显示,不美化**。 */
  const [said, setSaid] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [revising, setRevising] = useState(false)
  const [reviseText, setReviseText] = useState('')
  /**
   * 派出去那几件子事项各自的结果(2026-09-23,断点 B)。**现从服务端读**,不另存一份状态。
   * 空数组 = 一件都还没回来;这一块只在「验收」那一态铺开(她在那一态才需要看它)。
   */
  const [results, setResults] = useState<readonly FeatureResultView[]>([])
  /**
   * 这条需求改的是不是工作台自己(断点 C 的判据,服务端算的)。
   * `undefined` = 还没读到 —— 那时**什么都不画**,不先画一颗按钮再收回去。
   */
  const [self, setSelf] = useState<{ self: boolean, why: string } | undefined>(undefined)
  /** 展开的那一份结果(点标题展开全文)。 */
  const [openResult, setOpenResult] = useState<string | undefined>(undefined)

  const reload = useCallback(async (): Promise<void> => {
    try {
      const res = await fetchImpl(`${baseUrl}/feature/docs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: task.id }),
      })
      const body = await res.json() as {
        docs?: FeatureDocView[], reviews?: FeatureReviewEntry[], error?: string
        dir?: string, project?: string, project_path?: string
        results?: FeatureResultView[], self?: boolean, self_why?: string
      }
      if (!res.ok) { setSaid(body.error ?? '读不到这条需求的产物'); return }
      setDocs(body.docs ?? [])
      setReviews(body.reviews ?? [])
      setResults(body.results ?? [])
      setSelf(body.self === undefined ? undefined : { self: body.self, why: body.self_why ?? '' })
      setWhere({
        ...(body.dir === undefined ? {} : { dir: body.dir }),
        ...(body.project === undefined ? {} : { project: body.project }),
        ...(body.project_path === undefined ? {} : { project_path: body.project_path }),
      })
    }
    catch (error) {
      // 读不到就**不画产物那一块**(维持 undefined),不画四个空页签假装都还没做。
      setSaid(error instanceof Error ? error.message : '读不到这条需求的产物')
    }
  }, [baseUrl, fetchImpl, task.id])

  useEffect(() => { void reload() }, [reload])
  // 态变了 → 默认页签跟着换。她正在改的那一份不抢(draft 有值 = 她手上有没存的字)。
  useEffect(() => { if (draft === undefined) setTab(defaultFeatureTab(stage)) }, [stage, draft])

  const doc = docs === undefined ? undefined : featureDocOf(docs, tab)
  const text = draft ?? doc?.text ?? ''
  const dirty = draft !== undefined && draft !== (doc?.text ?? '')
  const badge = deckRunBadge({
    dispatch: task.dispatch,
    clientDispatch: task.client_dispatch,
    lastRunAt: lastDeckRun(reviews)?.at,
  })
  const standin = lastDeckRun(reviews)?.standin === true
  const next = nextFeatureStage(stage)
  const said1 = lastFeatureReviewOf(reviews, tab)
  const recorded = lastRecord(reviews)

  const post = async (path: string, body: unknown): Promise<Record<string, unknown> | undefined> => {
    setBusy(true)
    try {
      const res = await fetchImpl(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const parsed = await res.json() as Record<string, unknown>
      if (!res.ok) { setSaid(typeof parsed.error === 'string' ? parsed.error : '没办成'); return undefined }
      return parsed
    }
    catch (error) {
      setSaid(error instanceof Error ? error.message : '没办成')
      return undefined
    }
    finally { setBusy(false) }
  }

  const runStep = (): void => {
    setSaid(null)
    void (async () => {
      const done = await post('/feature/run', {
        id: task.id,
        ...(note.trim() === '' ? {} : { note: note.trim() }),
      })
      if (done === undefined) return
      setNote('')
      // 送没送成都要说出来:一颗"点了像是成了"的按钮比没有按钮更坏(D13)。
      setSaid(done.sent === true
        ? `交给事务官了${done.standin === true ? '(Codex / Claude 这次派不出去,它自己顶着做)' : ''}`
        : `没送进去:${typeof done.note === 'string' ? done.note : '会话那头不在'}`)
      await reload()
    })()
  }

  const save = (): void => {
    if (draft === undefined) return
    setSaid(null)
    void (async () => {
      const done = await post('/feature/doc/save', { id: task.id, tab, text: draft })
      if (done === undefined) return
      setDraft(undefined)
      setSaid(typeof done.diff_note === 'string' ? done.diff_note : '存好了')
      await reload()
    })()
  }

  const judge = (action: DeckReviewAction): void => {
    setSaid(null)
    if (action === 'revise' && !revising) { setRevising(true); return }
    void (async () => {
      const done = await post('/feature/review', {
        id: task.id,
        tab,
        action,
        ...(action === 'revise' ? { text: reviseText.trim() } : {}),
      })
      if (done === undefined) return
      if (action === 'revise') { setRevising(false); setReviseText('') }
      setSaid(action === 'revise'
        ? (done.sent === true ? '打回去了,它这就改' : `记下了,但话没送进去:${typeof done.note === 'string' ? done.note : '会话那头不在'}`)
        : `记下了:${DECK_REVIEW_ACTION_TITLES[action]}`)
      await reload()
    })()
  }

  /**
   * 「先开分支」(断点 C 第 1 条)。**只在「拆解与派活」那一态、而且这条需求改的是工作台自己时**
   * 画得出来 —— 别的项目没有这条路,画一颗点了回 409 的按钮是骗人。
   */
  const openBranch = (): void => {
    setSaid(null)
    void (async () => {
      const done = await post('/feature/branch', { id: task.id })
      if (done === undefined) return
      setSaid(done.created === true
        ? `开好了:${String(done.branch)} —— 子事项都在 ${String(done.worktree)} 里做`
        : `本来就有:${String(done.branch)}(${String(done.worktree)})`)
    })()
  }

  /**
   * 「合并并发版」(断点 C 第 2 条)。八步,**每一步失败就停**。
   *
   * 这一颗**只在「验收」那一态**画:它会动 main 与发版链,而「验收」正是她看过摘要、
   * 点过「通过」的那一态。点下去之后她看到的是**停在哪一步**与那一步的原话 ——
   * 一句"发版失败了"对她没有用。
   */
  const ship = (): void => {
    setSaid(null)
    void (async () => {
      const done = await post('/feature/ship', { id: task.id })
      if (done === undefined) return
      if (done.ok === true) {
        setSaid(`发出去了:${String(done.version)} —— 这台电脑已经换过来了,卡推到「记录」态`)
        onStageChange('记录')
      }
      else {
        const step = (done.steps as SelfShipStepView[] | undefined)?.find(one => one.id === done.stopped_at)
        setSaid(`停在「${step?.title ?? String(done.stopped_at)}」:${String(done.note)}`)
      }
      await reload()
    })()
  }

  const writeRecord = (): void => {
    setSaid(null)
    void (async () => {
      const done = await post('/feature/record', { id: task.id })
      if (done === undefined) return
      const at = typeof done.path === 'string' ? done.path : '决策记录'
      setSaid(done.added === true ? `写进去了:${at}` : `这一条已经在里面了:${at}`)
      await reload()
    })()
  }

  return (
    <div className="ben-wb__deck ben-wb__deck--feature">
      {/* ── 四态 ──
          当前那格高亮。点别的一格**不改盘上的态**(那是「推进一步」的事),
          只是把那一态的页签翻到前面来。 */}
      <div className="ben-wb__deck-phases" role="group" aria-label="需求进度">
        {FEATURE_STAGES.map(one => (
          <button
            key={one}
            type="button"
            data-on={one === stage}
            aria-pressed={one === stage}
            title={one === stage ? `现在就在「${one}」` : `翻到「${one}」那一份看看(不改进度)`}
            onClick={() => setTab(defaultFeatureTab(one))}
          >
            {one}
          </button>
        ))}
      </div>

      <p className="ben-wb__deck-now">{`现在:第 ${view.index}/${view.total} 态「${stage}」`}</p>
      {where.project !== undefined && (
        <p className="ben-wb__topics-flow">
          {`项目:${where.project}${where.project_path === undefined ? '' : ` · ${where.project_path}`}`}
        </p>
      )}

      {/* ── 每态一颗「让事务官推进这一步」 ── */}
      <div className="ben-wb__deck-run">
        <button type="button" className="ben-wb__topics-adv" disabled={busy} onClick={runStep}>
          让事务官推进这一步
        </button>
        {badge !== undefined && (
          <span className="ben-wb__deck-badge" data-state={badge}>{badge}</span>
        )}
        {standin && (
          <span className="ben-wb__deck-badge" data-state="代做" title="窗口编排壳没接上,这一步由事务官自己顶着做">
            代做
          </span>
        )}
        <button
          type="button"
          className="ben-wb__topics-adv"
          disabled={next === undefined}
          title={next === undefined ? '已经到「记录」了,后面没有下一步' : `推进到「${next}」`}
          onClick={() => { if (next !== undefined) onStageChange(next) }}
        >
          {next === undefined ? '已到记录' : `推进一步 → ${next}`}
        </button>
      </div>
      <p className="ben-wb__deck-hint">{FEATURE_RUN_HINT[stage]}</p>
      <input
        className="ben-wb__deck-note"
        type="text"
        aria-label="推进时补一句(可不填)"
        placeholder="要补一句吗?不填也行 —— 该交代的它已经知道了"
        value={note}
        onChange={event => setNote(event.target.value)}
      />

      {said !== null && <p className="ben-wb__deck-said" role="status">{said}</p>}

      {/* ── 产物页签 ──
          四个一直都在,这一态那个排在前面。读不到时整块不画(不摆四个空壳)。 */}
      {docs === undefined
        ? <p className="ben-wb__topics-nofiles">还没读到这条需求的产物。</p>
        : (
            <>
              <div className="ben-wb__deck-tabs" role="tablist" aria-label="产物">
                {orderedFeatureTabs(stage).map((one) => {
                  const each = featureDocOf(docs, one)
                  return (
                    <button
                      key={one}
                      type="button"
                      role="tab"
                      aria-selected={one === tab}
                      data-on={one === tab}
                      data-has={each?.exists === true}
                      title={each === undefined ? one : `${one} · ${each.file}${each.exists ? '' : '(还没有)'}`}
                      onClick={() => { setTab(one); setDraft(undefined); setRevising(false) }}
                    >
                      {one}
                    </button>
                  )
                })}
              </div>

              <div className="ben-wb__deck-doc">
                <p className="ben-wb__deck-file">
                  {doc === undefined
                    ? tab
                    : `${doc.file}${doc.exists ? (doc.updated_at === undefined ? '' : ` · 改于 ${doc.updated_at}`) : ' · 还没有这一份'}`}
                </p>
                {doc?.error !== undefined && <p className="ben-wb__topics-err">{doc.error}</p>}

                <textarea
                  className="ben-wb__deck-text"
                  rows={10}
                  aria-label={`${tab} 正文`}
                  placeholder={doc?.exists === true ? '' : '这一份还没有。你可以自己先写,或者上面点「让事务官推进这一步」。'}
                  value={text}
                  onChange={event => setDraft(event.target.value)}
                />
                <div className="ben-wb__deck-acts">
                  <button type="button" disabled={!dirty || busy} onClick={save}>
                    {dirty ? '存回文件' : '没改动'}
                  </button>
                  {dirty && <button type="button" onClick={() => setDraft(undefined)}>不改了</button>}
                </div>

                {/* ── 这一轮改了什么(段落级)── */}
                {doc?.diff !== undefined && (
                  <details className="ben-wb__deck-diff" open>
                    <summary>这一轮改了什么</summary>
                    <ul>
                      {doc.diff.map((row, at) => (
                        <li key={`${row.kind}-${at}`} data-kind={row.kind}>
                          <span aria-hidden="true">{row.kind === 'add' ? '＋' : row.kind === 'del' ? '－' : '　'}</span>
                          <span className="ben-wb__sr">{row.kind === 'add' ? '新增' : row.kind === 'del' ? '删去' : '没变'}</span>
                          {row.text}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}

                {/* ── 把关三键 ──
                    **只在这一份真有东西的时候画**:对一份还不存在的产物点「通过」没有意义。 */}
                {doc?.exists === true && (
                  <div className="ben-wb__deck-judge" role="group" aria-label="把关">
                    {DECK_REVIEW_ACTIONS.map(action => (
                      <button
                        key={action}
                        type="button"
                        className="ben-wb__chip"
                        data-judge={action}
                        disabled={busy}
                        onClick={() => judge(action)}
                      >
                        {action === 'revise' ? '打回' : DECK_REVIEW_ACTION_TITLES[action]}
                      </button>
                    ))}
                  </div>
                )}
                {revising && (
                  <div className="ben-wb__deck-revise">
                    <input
                      type="text"
                      aria-label="改哪儿"
                      placeholder="哪儿不对、要它怎么改(这一句会原样送给事务官)"
                      value={reviseText}
                      onChange={event => setReviseText(event.target.value)}
                    />
                    <button type="button" disabled={reviseText.trim() === '' || busy} onClick={() => judge('revise')}>
                      打回去
                    </button>
                    <button type="button" onClick={() => { setRevising(false); setReviseText('') }}>取消</button>
                  </div>
                )}
                {said1 !== undefined && (
                  <p className="ben-wb__deck-lastsaid">
                    {`你上次对这一份:${DECK_REVIEW_ACTION_TITLES[said1.action]}${said1.text === undefined ? '' : `——「${said1.text}」`}`}
                  </p>
                )}
              </div>
            </>
          )}

      {/* ── 派出去那几件的结果(2026-09-23,断点 B)──
          「验收」那一态铺开:一件子事项一行,成没成 + 退出码 + 有没有改动;点标题看全文。
          **摘要是服务端从那份文件里现读的**,不是这一层算的 —— 卡上写的与文件里写的
          必须是同一句话(同"产物回卡"那条纪律)。 */}
      {results.length > 0 && (
        <details className="ben-wb__deck-sec ben-wb__deck-results" open={stage === '验收'}>
          <summary>{`派出去那几件的结果(${results.length} 件)`}</summary>
          <ul className="ben-wb__topics-files">
            {results.map(one => (
              <li key={one.file} data-ok={one.ok ? 'yes' : 'no'}>
                <button
                  type="button"
                  className="ben-wb__topics-filename"
                  onClick={() => setOpenResult(openResult === one.file ? undefined : one.file)}
                >
                  {one.summary}
                </button>
                {openResult === one.file && <pre className="ben-wb__deck-resulttext">{one.text}</pre>}
              </li>
            ))}
          </ul>
        </details>
      )}

      {/* ── 「改工作台自己」那条路(2026-09-23,断点 C)──
          **只在判据成立时才画**(`self === true`)。判据不成立时画一句实话而不是一颗灰按钮:
          她要知道"为什么这张卡上没有那条闭环",而不是"这颗按钮怎么按不动"。
          `self === undefined` = 还没读到,那时整块不画。 */}
      {self?.self === true && (stage === '拆解与派活' || stage === '验收') && (
        <div className="ben-wb__deck-record ben-wb__deck-self">
          {stage === '拆解与派活' && (
            <>
              <button type="button" className="ben-wb__topics-adv" disabled={busy} onClick={openBranch}>
                先开分支再派活
              </button>
              <p className="ben-wb__deck-hint">
                {task.self_ship?.branch === undefined
                  ? '这条需求改的是工作台自己,所以子事项要在一条分支的 worktree 里做,不在 main 上改。'
                  : `在 ${task.self_ship.branch} 上做(${task.self_ship.worktree ?? ''})`}
              </p>
            </>
          )}
          {stage === '验收' && (
            <>
              <button type="button" className="ben-wb__topics-adv" disabled={busy} onClick={ship}>
                通过,合并并发版
              </button>
              <p className="ben-wb__deck-hint">
                全量测试 → 只许快进的合并 → 版本号 +1 → 发版 → 记一条 → 这台电脑热更新。
                **每一步失败就停**,停下来会在收件箱里说一声、座机也会响。
                最后那一下按完这个页面就会重启,新版本生没生效**重启之后**在收件箱里说。
              </p>
            </>
          )}
          {task.self_ship?.steps !== undefined && (
            <ol className="ben-wb__deck-steps">
              {task.self_ship.steps.map(one => (
                <li key={one.id} data-status={one.status}>
                  {`${one.title}:${one.status === 'ok' ? '过了' : one.status === 'failed' ? '停在这儿' : '还没走到'}`}
                  {one.status === 'failed' && one.note !== undefined && (
                    <pre className="ben-wb__deck-resulttext">{one.note}</pre>
                  )}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
      {self?.self === false && stage === '验收' && (
        <p className="ben-wb__deck-hint">{`这条需求改的不是工作台自己,所以没有"合并并发版"那条路:${self.why}`}</p>
      )}

      {/* ── 「记录」那一态独有的第五颗 ──
          第三幕最后一句:「她说通过 → 决策记录里多了一条,**不用她写**」。
          只在「记录」那一态画:别的态点它没有意义(那时 记录.md 还没有)。 */}
      {stage === '记录' && (
        <div className="ben-wb__deck-record">
          <button type="button" className="ben-wb__topics-adv" disabled={busy} onClick={writeRecord}>
            {FEATURE_RECORD_BUTTON}
          </button>
          <p className="ben-wb__deck-hint">
            {recorded?.text === undefined
              ? '把 记录.md 那一条追加进这个项目的 docs/决策记录.md(没有就建)。'
              : `上次落在:${recorded.text}`}
          </p>
        </div>
      )}

      {/* ── 这一态派给谁 ──
          第三幕逐字:「派给 Codex 做代码、Claude 审代码」。摆出来是为了让她知道
          子事项里那几行「派给谁」是从哪几家里挑 —— 不是一个自由填空。 */}
      <details className="ben-wb__deck-sec" open={stage === '拆解与派活'}>
        <summary>能派给谁</summary>
        <ul className="ben-wb__topics-files">
          {FEATURE_HANDS.map(hand => (
            <li key={hand}>
              <span className="ben-wb__topics-filename">{FEATURE_HAND_TITLES[hand]}</span>
            </li>
          ))}
        </ul>
        {where.dir !== undefined && <p className="ben-wb__topics-filefrom">{`产物都落在 ${where.dir}`}</p>}
      </details>
    </div>
  )
}
