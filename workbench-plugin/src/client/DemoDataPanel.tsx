/**
 * 设置弹窗里的「演示数据」一节(2026-10-13,卡「演示数据一键放进去」;周三 10-14 演示)。
 *
 * 为什么有这一节:演示机上看板是空的、任务账是空的,于是早报里日报那四段、「今天的待办」、
 * 发布计划月历全都没有东西可看(统筹 10-13 中午真跑过一遍,确实如此)。维护者的口径是
 * 「演示不是展示生产」—— 开演前一键放一套**明标演示用**的数据,演完一键清掉。
 *
 * 这一节只有两颗键,**不在这里重画任何一格**:放好之后在哪儿看照旧 —— 看板、
 * 「今天的待办」那一格、发布计划月历、事务官收件箱那一档、手机会议页。
 *
 * 为什么另起一节而不挤在「会议 · 用现成的转写出纪要」底下:那一节说的是「把一份现成的材料
 * 交给事务官出纪要」,而这一节碰的是**她的看板与任务账**(十几张卡 + 一摞记录),
 * 收拾的法子也不一样(那几场会删不掉,这些卡能一键取消)。
 * 设置页「每节最多一颗主键」那条铁律照旧:主键是「放一套演示数据」,清掉那一颗是文字键。
 */
import { useState } from 'react'
import { CONFIRMS, ConfirmDialog } from './ui/index.tsx'
import { SetActions, SetBtn, SetExplain, SetMsg, SetRow, SetSection } from './settings/setKit.tsx'

export const DEMO_DATA_TITLE = '演示数据'

export const DEMO_DATA_SEED_LABEL = '放一套'
export const DEMO_DATA_CLEAR_LABEL = '清理演示数据'

/**
 * 按下去会发生什么,**说在她按之前**:放哪几样、走的是真路、全部标着「演示用」、
 * 重复点不会放第二摞、放完顺手跑一遍早报。
 */
export const DEMO_DATA_SEED_HINT = '放一套虚构的自媒体数据:看板上十条带日期的事项(今天 / 明天 / 更晚各有)、'
  + '昨天那六件派出去的活的记录(两件交回来了、两件在推进、一件卡住、一件刚记下)、三条发布计划、'
  + '今天下午一场要开的会。走的是真路(建卡、挪格子、记任务账、登记那场会),'
  + '每张卡都标着「演示用」,同名的已经有了就跳过。放完顺手跑一遍早报 —— 四段(已完成 / 推进中 / 卡点 / 下一步)'
  + '、「今天的会」、「今天的待办」就都有东西了。'

/** 清掉那一颗的说明:**先说清它动不了什么**(账是只追加的、会删不掉)。 */
export const DEMO_DATA_CLEAR_HINT = '只把带「演示用」记号的那几张卡挪进「取消」(不是删掉,她自己的卡一张不碰)。'
  + '任务账是只追加的那一本,那几条记录留在账上 —— 卡取消了,早报就不再数它们;'
  + '那场演示用的会也删不掉(会议模式里没有删除的路),列表上标着「演示用」。'

interface SeedAnswer {
  ok?: boolean
  error?: string
  note?: string
  morning?: string
  jobs?: number
  lines?: readonly { title?: string, note?: string, skipped?: true }[]
}

interface ClearAnswer {
  ok?: boolean
  error?: string
  note?: string
  canceled?: number
  failed?: readonly { title?: string, why?: string }[]
}

export function DemoDataPanel({ baseUrl, fetchImpl }: {
  baseUrl: string
  fetchImpl?: typeof fetch
}) {
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [lines, setLines] = useState<readonly string[]>([])
  /** 「清理演示数据」先问一句,后果就是 `DEMO_DATA_CLEAR_HINT` 那几句(共用确认弹层)。 */
  const [asking, setAsking] = useState(false)

  async function call(path: string): Promise<unknown> {
    const res = await (fetchImpl ?? fetch)(`${baseUrl}${path}`, { method: 'POST' })
    const answer = await res.json() as { ok?: boolean, error?: string }
    if (!res.ok || answer.ok !== true) throw new Error(answer.error ?? '没成')
    return answer
  }

  async function seed(): Promise<void> {
    setBusy(true)
    setNote(null)
    setLines([])
    try {
      const answer = await call('/demo/seed') as SeedAnswer
      setNote(`${answer.note ?? '放好了'}${answer.morning === undefined ? '' : ` ${answer.morning}`}`)
      setLines((answer.lines ?? []).map(one =>
        `${one.skipped === true ? '跳过 · ' : ''}${one.title ?? '这一条'}:${one.note ?? '放好了'}`))
    }
    catch (error) { setNote(error instanceof Error ? error.message : '没放进去') }
    finally { setBusy(false) }
  }

  async function clear(): Promise<void> {
    setBusy(true)
    setNote(null)
    setLines([])
    try {
      const answer = await call('/demo/clear') as ClearAnswer
      setNote(answer.note ?? '清掉了')
      setLines((answer.failed ?? []).map(one => `没挪动 · ${one.title ?? '这一张'}:${one.why ?? '没说原因'}`))
    }
    catch (error) { setNote(error instanceof Error ? error.message : '没清掉') }
    finally { setBusy(false) }
  }

  // 评审页 `section('demo', '演示数据', …)`:一行「十条虚构事项 / 带日期、进度与演示标记。」+ 描边「放一套」,
  // 底下文字「清理演示数据」。放了哪几样、清的时候动不了什么,收进「放了什么、清掉什么」。
  return (
    <SetSection id="ben-wb-demo-data" title={DEMO_DATA_TITLE}>
      <SetRow title="十条虚构事项" sub="带日期、进度与演示标记。">
        <SetBtn kind="outline" disabled={busy} onClick={() => { void seed() }}>{DEMO_DATA_SEED_LABEL}</SetBtn>
      </SetRow>
      <SetActions>
        <SetBtn kind="text" disabled={busy} onClick={() => setAsking(true)}>{DEMO_DATA_CLEAR_LABEL}</SetBtn>
      </SetActions>
      <SetExplain label="放了什么、清掉什么">
        <p>{DEMO_DATA_SEED_HINT}</p>
        <p>{DEMO_DATA_CLEAR_HINT}</p>
      </SetExplain>
      {note !== null && <SetMsg>{note}</SetMsg>}
      {lines.length > 0 && (
        <ul className="ben-wb__smsg">
          {lines.map(one => <li key={one}>{one}</li>)}
        </ul>
      )}
      {asking && (
        <ConfirmDialog
          {...CONFIRMS.clearDemo}
          body={DEMO_DATA_CLEAR_HINT}
          busy={busy}
          onCancel={() => setAsking(false)}
          onConfirm={() => { setAsking(false); void clear() }}
        />
      )}
    </SetSection>
  )
}
