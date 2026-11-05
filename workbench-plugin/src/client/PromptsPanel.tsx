/**
 * 设置里那一节(2026-10-01 叫「事务官的提示词」;2026-10-02 改成**她的偏好**)。
 *
 * Air 上那位运营同学对 10-01 那一版的反馈是「太杂了」—— 9 段、两万多字、149 处接口与路径
 * 原样摊在她面前。维护者 10-02 要求「不要拿着打补丁的心态,要有机制上的调整」。
 *
 * 于是这一节默认只有**人话**:
 * 1. 人话那几项(它叫什么 / 怎么称呼你 / 说话方式 / 你的规矩 / 还想交代的几句),
 *    每项一句说明 + 一个例子,值直接摆在那儿,点「改」就改;
 * 2. **你各个环节的偏好**:环节是服务端按她的模板算出来的(运营一套、做产品一套),
 *    一个框一行一条;
 * 3. 页底「工作台怎么干活(只读)」—— 技能正文那一大摊 + 段外那些话,**默认收起**。
 *
 * 跟别的设置节同一套规矩(同 RulesPanel):
 * - 数据自己拉 `GET /butler/prompts`,不走 /state;404 = 这台服务没接 → 整节不出现;
 * - 结果如实上屏,服务端怎么说就怎么写(D13);
 * - 改不动的要说清为什么(不可改清单那几段、规矩那一张表指回「记住的规矩」)。
 */
import { useEffect, useState } from 'react'
import type { ButlerPromptSectionView, ButlerPromptStageView, ButlerPromptsView } from '../protocol.ts'
import { SetActions, SetBtn, SetMsg, SetRow, SetSection, SetWarn } from './settings/setKit.tsx'

/** 页底那一节的标题。与 `server/promptsPage.ts` 导出的那一份同一个字。 */
export const PROMPTS_MANUAL_TITLE = '工作台怎么干活(只读)'

/** 形状不对就当没拿到(并行用例里 fetch 会串台)。 */
export function isPromptsPayload(body: unknown): body is ButlerPromptsView {
  if (typeof body !== 'object' || body === null) return false
  const raw = body as Record<string, unknown>
  return Array.isArray(raw.basics) && Array.isArray(raw.stages) && typeof raw.file === 'string'
}

/** 一项后面那一小行:她改过没有、默认有没有更新、在不在文件里。 */
export function promptMetaLine(section: ButlerPromptSectionView): string {
  const bits: string[] = []
  if (section.overridden) bits.push('你改过这一项')
  if (section.default_changed) bits.push('默认版本有更新')
  if (!section.present) bits.push('这一项还没写进去')
  return bits.join(' · ')
}

/**
 * 一项在行里露出来的那一句(评审页「它叫什么 / 事务官」那一行的副行):正文里第一句人话,
 * 去掉 `##` 标题与 `- ` 列表头;太长截到 40 字。
 */
export function promptValueLine(body: string): string {
  const line = body.split('\n').map(one => one.trim()).find(one => one !== '' && !one.startsWith('#'))
  if (line === undefined) return '(还没写)'
  const text = line.replace(/^[-*]\s+/u, '')
  return text.length > 40 ? `${text.slice(0, 40)}…` : text
}

/** 一组偏好在框里的样子(一行一条),和回写时的拆法是同一份。 */
export function prefLinesToText(lines: readonly string[]): string {
  return lines.join('\n')
}

export function PromptsPanel({ baseUrl, fetchImpl }: { baseUrl: string, fetchImpl?: typeof fetch }) {
  const [payload, setPayload] = useState<ButlerPromptsView | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /** 正在改的那一项(人话那几项:正文;环节:一行一条的偏好)。 */
  const [draft, setDraft] = useState<{ name: string, text: string } | null>(null)
  const [showNewDefault, setShowNewDefault] = useState<string | null>(null)
  /** 页底那一节展开了没有(**默认收起**)。 */
  const [manualOpen, setManualOpen] = useState(false)
  /** 页底那一节里点开了哪一段。 */
  const [openManual, setOpenManual] = useState<string | null>(null)
  /** 「各个环节的偏好」那一行展开了没有(**默认收起**,评审页那一行是「查看」)。 */
  const [stagesOpen, setStagesOpen] = useState(false)

  const call = fetchImpl ?? fetch

  async function reload(): Promise<ButlerPromptsView | null> {
    try {
      const res = await call(`${baseUrl}/butler/prompts`)
      if (!res.ok) return null
      const body = await res.json() as unknown
      return isPromptsPayload(body) ? body : null
    }
    catch { return null }
  }

  useEffect(() => {
    let alive = true
    void (async () => {
      const next = await reload()
      if (alive && next !== null) setPayload(next)
    })()
    return () => { alive = false }
    // 依赖只列 baseUrl / fetchImpl,同 RulesPanel:reload 是每次渲染新建的闭包。
  }, [baseUrl, fetchImpl])

  if (payload === null) return null

  async function send(path: string, body: Record<string, unknown>): Promise<void> {
    setBusy(true)
    setMessage(null)
    try {
      const res = await call(`${baseUrl}${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      })
      const said = (await res.json().catch(() => ({}))) as { ok?: boolean, error?: string, note?: string }
      if (!res.ok || said.error !== undefined) setMessage(said.error ?? '没办成')
      else {
        setMessage(said.note ?? '好了。')
        setDraft(null)
      }
      const next = await reload()
      if (next !== null) setPayload(next)
    }
    catch { setMessage('工作台服务没应答') }
    finally { setBusy(false) }
  }

  /** 人话那几项里的一项:一行(名字 + 现在那一句 + 「改」);点「改」在下面摊开框与恢复默认那几颗。 */
  function basicRow(section: ButlerPromptSectionView) {
    const editing = draft?.name === section.name
    const meta = promptMetaLine(section)
    const sub = section.locked !== undefined
      ? `改不了:${section.locked}`
      : section.elsewhere ?? [promptValueLine(section.body), meta].filter(one => one !== '').join(' · ')
    return (
      <div key={section.name} data-prompt-section={section.name}>
        <SetRow title={section.title} sub={sub}>
          {section.editable && !editing && (
            <SetBtn disabled={busy} onClick={() => { setDraft({ name: section.name, text: section.body }); setShowNewDefault(null) }}>改</SetBtn>
          )}
        </SetRow>
        {editing && (
          <div className="ben-wb__srow-more">
            <p className="ben-wb__smsg" data-prompt-example={section.name}>{[section.note, section.example].filter(one => one !== undefined && one !== '').join(' ')}</p>
            <textarea
              aria-label={`改「${section.title}」`}
              rows={6}
              value={draft.text}
              onChange={event => setDraft({ name: section.name, text: event.target.value })}
            />
            <SetActions>
              {section.overridden && (
                <SetBtn kind="text" disabled={busy} onClick={() => { void send('/butler/prompts/reset', { name: section.name }) }}>恢复默认</SetBtn>
              )}
              {section.can_undo && (
                <SetBtn kind="text" disabled={busy} onClick={() => { void send('/butler/prompts/undo', { name: section.name }) }}>撤到上一版</SetBtn>
              )}
              {section.default_changed && section.latest_default_body !== undefined && (
                <SetBtn kind="text" onClick={() => setShowNewDefault(showNewDefault === section.name ? null : section.name)}>
                  {showNewDefault === section.name ? '不看新默认了' : '看新默认'}
                </SetBtn>
              )}
              <SetBtn disabled={busy} onClick={() => setDraft(null)}>算了</SetBtn>
              <SetBtn kind="outline" disabled={busy} onClick={() => { void send('/butler/prompts/save', { name: section.name, body: draft.text }) }}>保存</SetBtn>
            </SetActions>
            {section.default_changed && section.latest_default_body !== undefined && showNewDefault === section.name && (
              <>
                <pre data-prompt-new-default={section.name}>{section.latest_default_body}</pre>
                <SetActions>
                  <SetBtn kind="text" disabled={busy} onClick={() => { void send('/butler/prompts/reset', { name: section.name }) }}>换成新默认</SetBtn>
                </SetActions>
              </>
            )}
            <p className="ben-wb__smsg">{payload?.note}</p>
          </div>
        )}
      </div>
    )
  }

  /** 一个工作环节的偏好:一行(环节名 + 现在那几句 + 「改 / 写一条」),改的时候在下面摊开框。 */
  function stageRow(stage: ButlerPromptStageView) {
    const editing = draft?.name === stage.name
    return (
      <div key={stage.name} data-prompt-stage={stage.name}>
        <SetRow title={stage.title} sub={stage.lines.length === 0 ? '(你还没说过这个环节的偏好)' : stage.lines.join(';')}>
          {!editing && (
            <SetBtn disabled={busy} onClick={() => setDraft({ name: stage.name, text: prefLinesToText(stage.lines) })}>
              {stage.lines.length === 0 ? '写一条' : '改'}
            </SetBtn>
          )}
        </SetRow>
        {stage.notice !== undefined && (
          <SetWarn role="note">
            <span data-prompt-notice={stage.name}>{stage.notice}</span>
            {stage.kept !== undefined && <pre data-prompt-kept={stage.name}>{stage.kept}</pre>}
            <SetActions>
              <SetBtn disabled={busy} onClick={() => { void send('/butler/prompts/pref/seen', { name: stage.name }) }}>知道了</SetBtn>
            </SetActions>
          </SetWarn>
        )}
        {stage.notice === undefined && stage.kept !== undefined && <pre data-prompt-kept={stage.name}>{stage.kept}</pre>}
        {editing && (
          <div className="ben-wb__srow-more">
            <p className="ben-wb__smsg" data-prompt-example={stage.name}>{`${stage.note} ${stage.example} 一行一条;工作台更新也不会把它冲掉。`}</p>
            <textarea
              aria-label={`改「${stage.title}」的偏好`}
              rows={5}
              value={draft.text}
              onChange={event => setDraft({ name: stage.name, text: event.target.value })}
            />
            <SetActions>
              {stage.can_undo && (
                <SetBtn kind="text" disabled={busy} onClick={() => { void send('/butler/prompts/pref/undo', { name: stage.name }) }}>撤到上一版</SetBtn>
              )}
              <SetBtn disabled={busy} onClick={() => setDraft(null)}>算了</SetBtn>
              <SetBtn kind="outline" disabled={busy} onClick={() => { void send('/butler/prompts/pref', { name: stage.name, lines: draft.text.split('\n') }) }}>保存</SetBtn>
            </SetActions>
          </div>
        )}
      </div>
    )
  }

  // 评审页 `section('prefs', '事务官照你的意思办', …)`:它叫什么 / 怎么称呼你 / 说话方式各一行「改」,
  // 「各个环节的偏好」一行「查看」,底下文字入口「只读工作手册」(技能正文那一大摊,默认收起)。
  const stagesWaiting = payload.stages.some(stage => stage.notice !== undefined)
  return (
    <SetSection id="ben-wb-prompts" title="事务官照你的意思办">
      {message !== null && <SetMsg>{message}</SetMsg>}

      {payload.basics.map(section => basicRow(section))}

      {payload.stages.length > 0 && (
        <>
          <SetRow title="各个环节的偏好" sub={payload.stages.map(stage => stage.title).join('、')} data-prompt-stages="1">
            <SetBtn aria-expanded={stagesOpen || stagesWaiting} onClick={() => setStagesOpen(!stagesOpen)}>{stagesOpen ? '收起' : '查看'}</SetBtn>
          </SetRow>
          {(stagesOpen || stagesWaiting) && (
            <div className="ben-wb__srow-more">
              {payload.stages.map(stage => stageRow(stage))}
            </div>
          )}
        </>
      )}

      <SetActions>
        <SetBtn kind="text" aria-expanded={manualOpen} onClick={() => setManualOpen(!manualOpen)}>只读工作手册</SetBtn>
      </SetActions>
      {manualOpen && (
        <div data-prompt-manual="1">
          <p className="ben-wb__smsg">{`${PROMPTS_MANUAL_TITLE}:它每一步照着办的那份说明书 —— 写给机器看的那种,由工作台更新时管着,你不用改。想加你的讲究就写在上面那几项里。`}</p>
          {payload.manual.map(section => (
            <div className="ben-wb__prompt-manual-row" key={section.name} data-prompt-section={section.name}>
              <SetRow
                title={section.title}
                sub={[!section.present ? '这一段还没写进去' : '', section.locked !== undefined ? `改不了:${section.locked}` : ''].filter(one => one !== '').join(' · ')}
              >
                <SetBtn onClick={() => setOpenManual(openManual === section.name ? null : section.name)}>
                  {openManual === section.name ? '收起' : '看全文'}
                </SetBtn>
              </SetRow>
              {openManual === section.name && (
                <pre data-prompt-body={section.name}>{section.body === '' ? '(这一段还是空的)' : section.body}</pre>
              )}
            </div>
          ))}
          {payload.outside !== '' && (
            <div className="ben-wb__prompt-manual-row" data-prompt-outside="1">
              <SetRow title="这份文件里别的话" sub="你自己(或者别人)直接写在那份文件里的几句。工作台一个字不动它。">
                <SetBtn onClick={() => setOpenManual(openManual === '__outside' ? null : '__outside')}>
                  {openManual === '__outside' ? '收起' : '看全文'}
                </SetBtn>
              </SetRow>
              {openManual === '__outside' && <pre data-prompt-body="__outside">{payload.outside}</pre>}
            </div>
          )}
        </div>
      )}
    </SetSection>
  )
}
