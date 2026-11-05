/**
 * 选题卡打开之后那一整块 = **指挥台**(2026-09-22,设计第一节 + 第〇节的修正)。
 *
 * 上一版展开一张选题卡看到的是:一行环节说明、两个日期、一颗「推进一步」、一份素材清单。
 * 产物在 `选题/<名>/` 里躺着,界面不显示、不校验;把关没有任何动作留痕。
 * 于是「指挥 → 执行 → 回收 → 把关」这条线在界面上是断的。
 *
 * 这一块把它接上,四件事:
 *
 * 1. **四态,不是六个按钮**(第〇节第 2 条):按当前段归成 构思 / 制作 / 发布 / 复盘,
 *    **只把这一态需要的铺开**,其余收进折叠块(`PHASE_SECTIONS`)。七个产物页签一直都在,
 *    只是这一态那几个排在前面并默认选中 —— **不藏**,藏了她就得去文件夹里找。
 * 2. **每态一颗「让事务官推进这一步」**:点了走 `POST /topic/run`,那条路把选题上下文
 *    (账号、已有产物、把关记录)拼成一段话,经 **`/butler/item/say` 同一个端口**交给事务官。
 *    她**不必再交代一遍**(第〇节第 2 条修正的原话)。
 * 3. **产物回卡**:七个页签读 `选题/<名>/` 里对应文件,能看能改,改了写回文件;
 *    段落级 diff 摆在下面,这一轮改了什么一眼看得见(第二节第 3 条)。
 * 4. **把关三键 + 留痕**:通过 / 改一改(带一句话回给事务官,**走同一个口**)/ 我自己改;
 *    每一次写一行 `审核记录.jsonl`。
 *
 * ## 为什么不做本地乐观更新
 *
 * 全仓通行纪律:写完以下一次真读为准。这里比看板更要紧 —— 正文是**文件**,
 * 界面上那一份要是与盘上不一样,她会照着一份不存在的稿子改。所以保存成功之后
 * 重新 `POST /topic/docs` 读一遍,而不是把输入框里那段字当成真相。
 */
import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type {
  TaskView, TopicDocTab, TopicDocView, TopicReviewAction, TopicReviewEntry, TopicStage,
} from '../protocol.ts'
import {
  TOPIC_PHASES, TOPIC_REVIEW_ACTIONS, TOPIC_REVIEW_ACTION_TITLES, TOPIC_STAGE_FLOW,
  nextTopicStage,
} from '../protocol.ts'
import {
  PHASE_RUN_HINT, defaultTab, docOf, lastRun, lastReviewOf, orderedTabs, sectionOpen, topicPhaseView, topicRunBadge,
} from './TopicDeckModel.ts'

/** 「素材清单」那一块要摆的东西。形状与 TodoModule 拿到的那一行一致。 */
export interface DeckAssets {
  files: { name: string, path: string, from: string }[]
  truncated?: boolean
  errors?: string[]
}

export function TopicDeck({
  task, stage, baseUrl, fetchImpl, account, assets, onAdvance, onOpenAssets, dates, breakdown,
}: {
  task: TaskView
  /** 这条选题此刻在哪一段(由 TodoModule 按 `stageOf` 算好传进来,**不在这里再算一遍**)。 */
  stage: TopicStage
  baseUrl: string
  fetchImpl: typeof fetch
  /** 归哪个账号(名字,不是 id)。没挂账号就缺席 —— **不编一个**。 */
  account?: string | undefined
  /** 关联素材。取不到就缺席,那一块写「还没读到」而不是画一个 0。 */
  assets?: DeckAssets | undefined
  onAdvance: () => void
  onOpenAssets: () => void
  /** 两个日期那一格(日历)。由 TodoModule 给,免得这里再写一份 `/task/update`。 */
  dates: ReactNode
  /** 「拆解这条」那一块(复盘态铺开)。这台服务没接采集时缺席。 */
  breakdown?: ReactNode
}) {
  const view = topicPhaseView(stage)
  const phase = view.phase
  const [tab, setTab] = useState<TopicDocTab>(() => defaultTab(phase))
  const [docs, setDocs] = useState<readonly TopicDocView[] | undefined>(undefined)
  const [reviews, setReviews] = useState<readonly TopicReviewEntry[]>([])
  /** 正文输入框里此刻的字。`undefined` = 还没进编辑(显示盘上那一份)。 */
  const [draft, setDraft] = useState<string | undefined>(undefined)
  /** 服务端最后说的那句话。**原样显示,不美化**。 */
  const [said, setSaid] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /** 「让事务官推进」时额外补的一句(可空)。 */
  const [note, setNote] = useState('')
  /** 「改一改」那个输入框开着没有、填了什么。 */
  const [revising, setRevising] = useState(false)
  const [reviseText, setReviseText] = useState('')

  const name = task.title

  const reload = useCallback(async (): Promise<void> => {
    try {
      const res = await fetchImpl(`${baseUrl}/topic/docs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      const body = await res.json() as { docs?: TopicDocView[], reviews?: TopicReviewEntry[], error?: string }
      if (!res.ok) { setSaid(body.error ?? '读不到这条选题的产物'); return }
      setDocs(body.docs ?? [])
      setReviews(body.reviews ?? [])
    }
    catch (error) {
      // 读不到就**不画产物那一块**(维持 undefined),不画七个空页签假装都还没做。
      setSaid(error instanceof Error ? error.message : '读不到这条选题的产物')
    }
  }, [baseUrl, fetchImpl, name])

  useEffect(() => { void reload() }, [reload])
  // 段变了(推进一步 / 事务官推完一段)→ 默认页签跟着换。她正在改的那一份不抢
  // (draft 有值 = 她手上有没存的字,换页签会把它冲掉)。
  useEffect(() => { if (draft === undefined) setTab(defaultTab(phase)) }, [phase, draft])

  const doc = docs === undefined ? undefined : docOf(docs, tab)
  const text = draft ?? doc?.text ?? ''
  const dirty = draft !== undefined && draft !== (doc?.text ?? '')
  const badge = topicRunBadge({
    dispatch: task.dispatch,
    clientDispatch: task.client_dispatch,
    lastRunAt: lastRun(reviews)?.at,
  })
  const standin = lastRun(reviews)?.standin === true
  const next = nextTopicStage(stage)
  const said1 = lastReviewOf(reviews, tab)

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
      const done = await post('/topic/run', {
        id: task.id,
        name,
        ...(account === undefined || account === '' ? {} : { account }),
        ...(note.trim() === '' ? {} : { note: note.trim() }),
      })
      if (done === undefined) return
      setNote('')
      // 送没送成都要说出来:一颗"点了像是成了"的按钮比没有按钮更坏(D13)。
      setSaid(done.sent === true
        ? `交给事务官了${done.standin === true ? '(GPT / 豆包 这次派不出去,它自己顶着做)' : ''}`
        : `没送进去:${typeof done.note === 'string' ? done.note : '会话那头不在'}`)
      await reload()
    })()
  }

  const save = (): void => {
    if (draft === undefined) return
    setSaid(null)
    void (async () => {
      const done = await post('/topic/doc/save', { name, tab, text: draft })
      if (done === undefined) return
      setDraft(undefined)
      setSaid(typeof done.diff_note === 'string' ? done.diff_note : '存好了')
      await reload()
    })()
  }

  const judge = (action: TopicReviewAction): void => {
    setSaid(null)
    if (action === 'revise' && !revising) { setRevising(true); return }
    void (async () => {
      const done = await post('/topic/review', {
        id: task.id,
        name,
        tab,
        action,
        ...(action === 'revise' ? { text: reviseText.trim() } : {}),
      })
      if (done === undefined) return
      if (action === 'revise') { setRevising(false); setReviseText('') }
      setSaid(action === 'revise'
        ? (done.sent === true ? '打回去了,它这就改' : `记下了,但话没送进去:${typeof done.note === 'string' ? done.note : '会话那头不在'}`)
        : `记下了:${TOPIC_REVIEW_ACTION_TITLES[action]}`)
      await reload()
    })()
  }

  return (
    <div className="ben-wb__deck">
      {/* ── 四态 ──
          当前那格高亮。点别的一格**不改盘上的段**(那是「推进一步」的事),
          只是把那一态的页签翻到前面来 —— 她想回头看构思时写的框架是常事。 */}
      <div className="ben-wb__deck-phases" role="group" aria-label="工作状态">
        {TOPIC_PHASES.map(one => (
          <button
            key={one}
            type="button"
            data-on={one === phase}
            aria-pressed={one === phase}
            title={one === phase ? `现在就在「${one}」` : `翻到「${one}」那几份看看(不改进度)`}
            onClick={() => setTab(defaultTab(one))}
          >
            {one}
          </button>
        ))}
      </div>

      <p className="ben-wb__deck-now">
        {`现在:${phase} · 第 ${view.stageIndex}/${view.stageTotal} 段「${stage}」`}
      </p>
      {/* 八环节那一行**一字没改**(上一版就在这里,`TOPIC_STAGE_FLOW` 现算)。
          四态是粗刻度、八环节是细刻度,两句都留着:她要的是"我走到哪了"这件事的两种读法。 */}
      <p className="ben-wb__topics-flow">{`当前环节:${TOPIC_STAGE_FLOW[stage].join(' / ')}`}</p>

      {/* ── 每态一颗「让事务官推进这一步」 ── */}
      <div className="ben-wb__deck-run">
        <button type="button" className="ben-wb__topics-adv" disabled={busy} onClick={runStep}>
          让事务官推进这一步
        </button>
        {/* 派活小标四档。没派过活、也没点过这颗按钮时**整段不画**。 */}
        {badge !== undefined && (
          <span className="ben-wb__deck-badge" data-state={badge}>{badge}</span>
        )}
        {standin && (
          <span className="ben-wb__deck-badge" data-state="代做" title="服务器上还没配 GPT / 豆包,这一步由事务官自己顶着做">
            代做
          </span>
        )}
        {/* 「推进一步」与「素材」**一字没改**(措辞、行为、打的路由都是上一版那两颗):
            她手动把进度往后推一格、打开这条选题的文件夹,这两件事与事务官无关。 */}
        <button
          type="button"
          className="ben-wb__topics-adv"
          disabled={next === undefined}
          title={next === undefined ? '已经到「复盘」了,后面没有下一步' : `推进到「${next}」`}
          onClick={onAdvance}
        >
          {next === undefined ? '已到复盘' : `推进一步 → ${next}`}
        </button>
        <button type="button" className="ben-wb__topics-assets" onClick={onOpenAssets}>素材</button>
      </div>
      <p className="ben-wb__deck-hint">{PHASE_RUN_HINT[phase]}</p>
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
          七个一直都在,这一态那几个排在前面。读不到时整块不画(不摆七个空壳)。 */}
      {docs === undefined
        ? <p className="ben-wb__topics-nofiles">还没读到这条选题的产物。</p>
        : (
            <>
              <div className="ben-wb__deck-tabs" role="tablist" aria-label="产物">
                {orderedTabs(phase).map((one) => {
                  const each = docOf(docs, one)
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
                  {dirty && (
                    <button type="button" onClick={() => setDraft(undefined)}>不改了</button>
                  )}
                </div>

                {/* ── 这一轮改了什么(段落级)──
                    全是没变的那种情况服务端根本不回 diff,所以有 diff 就一定有改动。 */}
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
                    **只在这一份真有东西的时候画**:对一份还不存在的产物点「通过」是没有意义的。 */}
                {doc?.exists === true && (
                  <div className="ben-wb__deck-judge" role="group" aria-label="把关">
                    {TOPIC_REVIEW_ACTIONS.map(action => (
                      <button
                        key={action}
                        type="button"
                        className="ben-wb__chip"
                        data-judge={action}
                        disabled={busy}
                        onClick={() => judge(action)}
                      >
                        {TOPIC_REVIEW_ACTION_TITLES[action]}
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
                    {`你上次对这一份:${TOPIC_REVIEW_ACTION_TITLES[said1.action]}${said1.text === undefined ? '' : `——「${said1.text}」`}`}
                  </p>
                )}
              </div>
            </>
          )}

      {/* ── 四块「在场 / 收起」的东西 ──
          当前这一态那几块摊开,其余收进折叠块。**收起不是删掉**:点一下就能打开。 */}
      <DeckSectionBox title="随手记" open={sectionOpen(phase, '随手记')}>
        {task.desc === undefined
          ? <p className="ben-wb__topics-nofiles">这条选题还没有随手记。</p>
          : <p className="ben-wb__topics-desc">{task.desc}</p>}
      </DeckSectionBox>

      <DeckSectionBox title="素材清单" open={sectionOpen(phase, '素材清单')}>
        {assets === undefined
          ? <p className="ben-wb__topics-nofiles">还没读到素材。</p>
          : assets.files.length === 0
            ? (
                <p className="ben-wb__topics-nofiles">
                  还没有素材。放进这条选题的「素材」目录,或者把文件名用选题名开头。
                </p>
              )
            : (
                <ul className="ben-wb__topics-files">
                  {assets.files.map(file => (
                    <li key={file.path}>
                      <span className="ben-wb__topics-filename">{file.name}</span>
                      <span className="ben-wb__topics-filefrom">{file.from}</span>
                    </li>
                  ))}
                </ul>
              )}
        {assets?.truncated === true && <p className="ben-wb__topics-nofiles">素材太多,这里只列了前面那些。</p>}
        {assets?.errors?.map(error => <p className="ben-wb__topics-err" key={error}>{error}</p>)}
      </DeckSectionBox>

      <DeckSectionBox title="日历" open={sectionOpen(phase, '日历')}>{dates}</DeckSectionBox>

      {breakdown !== undefined && (
        <DeckSectionBox title="数据与对标" open={sectionOpen(phase, '数据与对标')}>{breakdown}</DeckSectionBox>
      )}
    </div>
  )
}

/**
 * 一块「在场 / 收起」。用原生 `<details>` ——
 * 自己写一套展开收起要再写一遍键盘与可及性,而这一格里本来就已经有一层展开了。
 */
function DeckSectionBox({ title, open, children }: {
  title: string
  open: boolean
  children: ReactNode
}) {
  return (
    <details className="ben-wb__deck-sec" open={open}>
      <summary>{title}</summary>
      {children}
    </details>
  )
}
