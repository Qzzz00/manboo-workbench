/**
 * 设置弹窗里的「会议 · 用现成的转写出纪要」一节(2026-10-13,卡「会议纪要按规则出 + 不靠现场录音的演示样例」)。
 *
 * 为什么有这一节:会后那条路要先录、再按段识别,一小时的会大约等 35 分钟 —— 周三演示与展位
 * 都等不起。这里给**同一条流水线**开一个不经识别的口:粘一段现成的转写(或者选一份转写文件),
 * 约一分钟出一份纪要,产物与真录的一场同形(同一份 `会议/<日期>-<标题>/`、同一批待办)。
 *
 * 这一节只负责**把材料交出去**。纪要出来之后在哪儿看照旧:事务官收件箱那一档、手机会议页。
 * 两件事不在这里重画(一张表不该有两处入口,同 PromptsPanel 对规矩那一节的处理)。
 *
 * 2026-10-13(卡「会议页不再空着」)同一节底下多一颗文字键「放三场演示用的会」:
 * 它走的是同一条流水线的一键版(登记 → 五问 → 预案卡 → 用现成的转写出纪要),
 * 所以不另起一节;设置页「每节最多一颗主键」那条铁律照旧(主键是「导入,出纪要」)。
 */
import { useMemo, useState } from 'react'
import { SetActions, SetBtn, SetErr, SetField, SetFields, SetFold, SetLead, SetMsg, SetSection } from './settings/setKit.tsx'

export const MEETING_IMPORT_TITLE = '会议转写'

/** 要等多久。转写文字那条只剩一次模型调用,所以是「约一分钟」而不是半小时。 */
export const MEETING_IMPORT_HOW_LONG = '约一分钟'

/** 录音那条走的是识别,慢 —— 这句话必须摆在她点下去之前。 */
export const MEETING_IMPORT_AUDIO_SLOW = '录音要先转成文字,一小时的录音大约要等半小时;演示用上面那条(粘转写)。'

/** 转写文件能选哪几种。只认文字:音频走下面那一栏。 */
const TEXT_FILE_ACCEPT = '.md,.txt,.srt,.vtt,text/plain,text/markdown'

/** 放三场演示用的会那颗键(2026-10-13,卡「会议页不再空着」)。 */
export const MEETING_DEMO_SEED_LABEL = '放三场演示用的会'

/**
 * 按下去会发生什么,**说在她按之前**:三场虚构的会、走的是真路(会前登记 → 五问 → 预案卡 → 转写出纪要)、
 * 要问几次模型、重复点不会放第二摞。
 */
export const MEETING_DEMO_SEED_HINT = '三场虚构的历史会(十月选题会、跟品牌方谈一条植入、周复盘),'
  + '走的是真路:会前登记那一句、五问画像、预案卡,再用现成的转写出纪要,'
  + '所以会问模型六次(三张预案卡 + 三份纪要)。放好之后在手机会议页里按会前 / 会中 / 会后翻;'
  + '列表上标着「演示用」,不冒充真会。同一天同名的会已经有了就跳过,重复点不会放第二摞。'

export function MeetingImportPanel({ baseUrl, fetchImpl, meetings }: {
  baseUrl: string
  fetchImpl?: typeof fetch
  /**
   * `/state.meetings`。**整格缺席 = 这台没接会议模式**(那时这一节由 SettingsDialog 整块不渲染);
   * `dir` 缺席 = 工作目录没配,导进来也没地方落 —— 如实说一句,那颗键按不动。
   */
  meetings: { dir?: string }
}) {
  const [text, setText] = useState('')
  const [title, setTitle] = useState('')
  const [audioPath, setAudioPath] = useState('')
  const [from, setFrom] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [seeded, setSeeded] = useState<readonly string[]>([])
  /** 「或者使用录音文件」点开了没有(评审页那一格默认不在屏上)。 */
  const [audioOpen, setAudioOpen] = useState(false)
  const ready = meetings.dir !== undefined
  const has = useMemo(() => ({ text: text.trim() !== '', audio: audioPath.trim() !== '' }), [text, audioPath])

  async function pickText(file: File | undefined): Promise<void> {
    if (file === undefined) return
    setNote(null)
    try {
      setText(await file.text())
      setFrom(file.name)
      if (title.trim() === '') setTitle(file.name.replace(/\.[a-z0-9]+$/i, ''))
    }
    catch { setNote('这份文件读不开,换一份、或者直接把字粘进来。') }
  }

  async function send(): Promise<void> {
    setBusy(true)
    setNote(null)
    // 两样只给一样:电脑那边也会拒,这里先挡一道(录音那条在下面,粘了字就以字为准)。
    const body = has.text
      ? { text: text.trim(), ...(title.trim() === '' ? {} : { title: title.trim() }), ...(from === '' ? {} : { from }) }
      : { audio_path: audioPath.trim(), ...(title.trim() === '' ? {} : { title: title.trim() }) }
    try {
      const res = await (fetchImpl ?? fetch)(`${baseUrl}/meeting/import`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const answer = await res.json() as { ok?: boolean, dir?: string, error?: string }
      if (!res.ok || answer.ok !== true) { setNote(answer.error ?? '没导进来'); return }
      setNote(`在整理了(${has.text ? MEETING_IMPORT_HOW_LONG : '录音要先转成文字,慢'})。`
        + `好了会出现在事务官收件箱里,手机会议页也看得到。落在 ${answer.dir ?? meetings.dir ?? ''}`)
      setText('')
      setAudioPath('')
      setFrom('')
    }
    catch (error) { setNote(error instanceof Error ? error.message : '没导进来') }
    finally { setBusy(false) }
  }

  async function seedDemo(): Promise<void> {
    setBusy(true)
    setNote(null)
    setSeeded([])
    try {
      const res = await (fetchImpl ?? fetch)(`${baseUrl}/meeting/seed-demo`, { method: 'POST' })
      const answer = await res.json() as { ok?: boolean, error?: string, cases?: readonly { title?: string, note?: string, skipped?: true }[] }
      if (!res.ok || answer.ok !== true) { setNote(answer.error ?? '没放进去'); return }
      const cases = answer.cases ?? []
      const put = cases.filter(one => one.skipped !== true).length
      setNote(`放了 ${put} 场${cases.length - put === 0 ? '' : `(跳过 ${cases.length - put} 场已经有的)`}。`
        + '纪要与预案卡在后台做,约一分钟一场;好了在事务官收件箱和手机会议页里看得到。')
      setSeeded(cases.map(one => `${one.title ?? '这一场'}:${one.note ?? '放好了'}`))
    }
    catch (error) { setNote(error instanceof Error ? error.message : '没放进去') }
    finally { setBusy(false) }
  }

  // 评审页 `section('meeting', '会议转写', …)`:一句 + 转写框 + 会议名称(整行)+「选择文件」「导入转写」,
  // 底下文字「或者使用录音文件」。录音那一格点了才露出来;「放三场演示用的会」收进「演示用的几场会」折叠。
  return (
    <SetSection id="ben-wb-meeting-import" title={MEETING_IMPORT_TITLE}>
      <SetLead>已有转写可以生成纪要与待办。</SetLead>
      {!ready && <SetErr>还没配「工作目录」(事务官仓库),导进来没地方落 —— 先在「高级 › 目录」里选一个。</SetErr>}

      <textarea
        aria-label="会议转写内容"
        placeholder="粘贴转写内容,或选择转写文件"
        rows={4}
        value={text}
        disabled={busy}
        onChange={event => setText(event.target.value)}
      />
      <SetFields>
        <SetField label="会议名称" full>
          <input placeholder="选填" value={title} disabled={busy} onChange={event => setTitle(event.target.value)} />
        </SetField>
        {audioOpen && (
          <SetField label="录音文件" full>
            <input
              aria-label="录音文件在这台电脑上的位置"
              placeholder="/Users/…/上周的会.m4a"
              spellCheck={false}
              value={audioPath}
              disabled={busy || has.text}
              onChange={event => setAudioPath(event.target.value)}
            />
          </SetField>
        )}
      </SetFields>
      {has.audio && !has.text && <SetMsg>{MEETING_IMPORT_AUDIO_SLOW}</SetMsg>}
      <SetActions>
        <label className="ben-wb__sbtn" data-kind="text">
          选择文件
          <input
            type="file"
            accept={TEXT_FILE_ACCEPT}
            aria-label="选一份转写文件"
            onChange={(event) => { void pickText(event.target.files?.[0]); }}
          />
        </label>
        <SetBtn kind="outline" disabled={busy || !ready || (!has.text && !has.audio)} onClick={() => { void send() }}>导入转写</SetBtn>
      </SetActions>
      {note !== null && <SetMsg>{note}</SetMsg>}
      {!audioOpen && (
        <SetActions>
          <SetBtn kind="text" onClick={() => setAudioOpen(true)}>或者使用录音文件</SetBtn>
        </SetActions>
      )}

      <SetFold summary="演示用的几场会">
        <p>{MEETING_DEMO_SEED_HINT}</p>
        <SetActions>
          <SetBtn kind="text" disabled={busy || !ready} onClick={() => { void seedDemo() }}>{MEETING_DEMO_SEED_LABEL}</SetBtn>
        </SetActions>
        {seeded.length > 0 && (
          <ul className="ben-wb__smsg">
            {seeded.map(one => <li key={one}>{one}</li>)}
          </ul>
        )}
      </SetFold>
    </SetSection>
  )
}
