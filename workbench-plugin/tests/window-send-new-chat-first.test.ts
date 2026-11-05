/**
 * 卡 DB(2026-09-27):派给窗口那几家时**先开新对话再查输入框**,他没发出去的草稿**先存后放回**。
 *
 * 现场:电话「找豆包,把这几天我跟他聊的内容总结一下」→ 派给豆包办公回
 * 「没送:输入框里有你没发出去的字」—— 而这条路本意是新开一条对话再送,新对话的框本来是空的。
 * 壳那一半(步骤顺序、草稿存与回的判断)在 `workbench-app/Tests/main.swift`;
 * 这一份钉的是**服务端**:协议那两格发不发、草稿落盘、卡上那句话。
 *
 * ★ 2026-10-02(卡「引擎接线与删复制品」):草稿那一套从 `dispatchClient.sendOnce` 搬进了
 * **窗口适配器一处**(审计第二表第 4 条:从前派活与答 / 捎话各存一份、行为还不一样),
 * 所以这一份改成「假壳 + 真引擎」(`engineHarness`)端到端跑 —— `saveDraft` / `draftNote`
 * 现在是窗口适配器的两格,断言的还是同样那三档(存住了 / 放不回去 / 存都没存住)。
 */
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createClientDispatch } from '../src/server/dispatchSend.ts'
import { draftFileName, draftFilePath, draftSavedNote, draftsDir, saveClientDraft } from '../src/server/clientDrafts.ts'
import type { HelperRequest } from '../src/server/helperChannel.ts'
import { engineHarness } from './helpers/engineHarness.ts'

const AT = '2026-09-27T21:23:00.000Z'

interface Options {
  send?: Record<string, unknown>
  caps?: readonly string[]
  /** 不接草稿那一格(老调用方 / 这一路接不住)。 */
  noSaveDraft?: boolean
  saved?: { ok: boolean, path?: string, reason?: string }
}

function harness(options: Options = {}) {
  const saves: { family: string, text: string, at: string }[] = []
  const save = (input: { family: string, text: string, at: string }): Promise<{ ok: boolean, path?: string, reason?: string }> => {
    saves.push(input)
    return Promise.resolve(options.saved ?? { ok: true, path: '/Users/example/.dsh/workbench/drafts/doubao-x.txt' })
  }
  const h = engineHarness({
    // `read_reply` 这一路(送前后比那一档)不走草稿,照默认回;`send_text` 回 options.send。
    reply: req => (req.op === 'send_text' ? (options.send ?? { method: 'ax_value' }) : { found: false }),
    caps: options.caps ?? ['new_conversation', 'save_draft', 'read_reply'],
    // 卡上那句草稿的话里要说清是哪一家(`draftSavedNote` 的 `who`)。
    nameOf: () => '豆包办公',
    now: () => new Date(AT),
    ...(options.noSaveDraft === true ? {} : { saveDraft: save, draftNote: input => draftSavedNote(input) }),
  })
  const dispatch = createClientDispatch({
    engine: h.engine,
    sessionIdsOf: () => [],
    now: () => new Date(AT),
  })
  return { requests: h.requests, saves, dispatch }
}

function sendText(requests: readonly HelperRequest[]): Extract<HelperRequest, { op: 'send_text' }> {
  const one = requests.find(req => req.op === 'send_text')
  expect(one).toBeDefined()
  return one as Extract<HelperRequest, { op: 'send_text' }>
}

describe('协议那两格:save_draft 发不发', () => {
  it('★接得住草稿 + 这份壳会这件事 → 告诉壳「照送,把那段原文给我」', async () => {
    const h = harness()
    await h.dispatch.send({ family: 'doubao', text: '总结这几天的聊天', submit: true, newConversation: true })
    const req = sendText(h.requests)
    expect(req.save_draft).toBe(true)
    expect(req.new_conversation).toBe(true)
  })

  it('★旧壳(caps 里没有 save_draft)→ 不发这一格,壳照旧拦下不覆盖', async () => {
    const h = harness({ caps: ['new_conversation'] })
    await h.dispatch.send({ family: 'doubao', text: '总结这几天的聊天', newConversation: true })
    expect(sendText(h.requests).save_draft).toBeUndefined()
  })

  it('★这一路接不住草稿(没注入 saveDraft)→ 也不发', async () => {
    const h = harness({ noSaveDraft: true })
    await h.dispatch.send({ family: 'doubao', text: '总结这几天的聊天', newConversation: true })
    expect(sendText(h.requests).save_draft).toBeUndefined()
  })

  it('★工作台自己从来不发 overwrite —— 存不下来的东西不许盖掉', async () => {
    const h = harness()
    await h.dispatch.send({ family: 'doubao', text: '总结这几天的聊天', newConversation: true })
    expect(sendText(h.requests).overwrite).toBeUndefined()
  })
})

describe('壳把草稿读回来了:落盘 + 卡上说一句', () => {
  const sent = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    ok: true,
    result: { method: 'paste', draft: '国庆放几天?\n', draft_returned: true, ...over },
  })

  it('★存下来了、也原样放回去了', async () => {
    const h = harness({ send: sent() })
    const result = await h.dispatch.send({ family: 'doubao', text: '总结这几天的聊天', submit: true, newConversation: true })
    expect(h.saves).toEqual([{ family: 'doubao', text: '国庆放几天?\n', at: AT }])
    expect(result.dispatch?.draft?.saved).toBe(true)
    expect(result.dispatch?.draft?.returned).toBe(true)
    expect(result.dispatch?.draft?.saved_to).toBe('/Users/example/.dsh/workbench/drafts/doubao-x.txt')
    expect(result.dispatch?.draft?.note).toContain('豆包办公')
    expect(result.dispatch?.draft?.note).toContain('原样放回')
  })

  it('★放不回去 → 说清存在哪个文件、为什么没放回(壳的原话原样带走)', async () => {
    const h = harness({ send: sent({ draft_returned: false, draft_note: '这一送只把话放进框里、没替你按发送' }) })
    const result = await h.dispatch.send({ family: 'doubao', text: '总结这几天的聊天', newConversation: true })
    const note = result.dispatch?.draft?.note ?? ''
    expect(result.dispatch?.draft?.returned).toBe(false)
    expect(note).toContain('/Users/example/.dsh/workbench/drafts/doubao-x.txt')
    expect(note).toContain('没替你按发送')
  })

  it('★存都没存住 → 如实说没存下来(这一送已经发出去了,瞒着更糟)', async () => {
    const h = harness({ send: sent(), saved: { ok: false, reason: 'EACCES: permission denied' } })
    const result = await h.dispatch.send({ family: 'doubao', text: '总结这几天的聊天', newConversation: true })
    expect(result.dispatch?.draft?.saved).toBe(false)
    expect(result.dispatch?.draft?.saved_to).toBeUndefined()
    expect(result.dispatch?.draft?.note).toContain('没能把它存下来')
    expect(result.dispatch?.draft?.note).toContain('EACCES')
  })

  it('框本来是空的(常态)→ 卡上一格都不多', async () => {
    const h = harness()
    const result = await h.dispatch.send({ family: 'doubao', text: '总结这几天的聊天', newConversation: true })
    expect(result.dispatch?.draft).toBeUndefined()
    expect(h.saves).toEqual([])
  })

  /**
   * ★ 2026-10-13(卡 F,四场景验收第 15 条):真机上存下来的那份「草稿」内容是
   * 「发消息或按住空格说话...」—— 豆包**空框**时 `AXValue` 读回来就是那句占位符,
   * 而壳的 `knownPlaceholders` 没列豆包(壳不随版发,所以这一道补在插件侧)。
   * 存了它的后果:草稿目录里多一份假草稿,卡上 / 电话里还多说一句不实的话。
   */
  it('★壳回来的「原有的字」是豆包空框的占位符 → 不落盘、也不说那句话', async () => {
    const h = harness({ send: sent({ draft: '发消息或按住空格说话...', draft_returned: false, draft_note: '发完框里还留着字,没敢再往上写' }) })
    const result = await h.dispatch.send({ family: 'doubao', text: '总结这几天的聊天', submit: true, newConversation: true })
    expect(h.saves).toEqual([])
    expect(result.dispatch?.draft).toBeUndefined()
    expect(result.front_note).toBeUndefined()
    expect(result.confirm_note ?? '').not.toContain('没发出去的那句')
  })

  it('★占位符那句话的两种写法(单字符省略号 / 三个点、前后带空白)都算占位符', async () => {
    for (const draft of ['发消息或按住空格说话…', ' 发消息或按住空格说话...\n']) {
      const h = harness({ send: sent({ draft, draft_returned: false }) })
      const result = await h.dispatch.send({ family: 'doubao', text: 'x', submit: true, newConversation: true })
      expect(h.saves).toEqual([])
      expect(result.dispatch?.draft).toBeUndefined()
    }
  })

  /**
   * ★ 2026-10-13(卡 F):那句话**只有卡上那一格出**(`dispatch.draft.note`,上一层按它拼话);
   * 送话这一层从前又把它拼进 `confirm_note`,于是 `dispatch_note` 里说了两遍。
   * `front_note`(界面上「送进窗口」那一下当场要说的)照旧带着它。
   */
  it('★草稿那一句不进 confirm_note(卡上那一格与 front_note 照旧有)', async () => {
    const h = harness({ send: sent({ draft_returned: false, draft_note: '发完框里还留着字,没敢再往上写' }) })
    const result = await h.dispatch.send({ family: 'doubao', text: '总结这几天的聊天', submit: true, newConversation: true })
    expect(result.dispatch?.draft?.note).toContain('存在这里了')
    expect(result.front_note).toContain('存在这里了')
    expect(result.confirm_note ?? '').not.toContain('存在这里了')
  })

  it('真草稿照旧存(占位符那一道不许吃掉她真写了的半句)', async () => {
    const h = harness({ send: sent({ draft: '发消息或按住空格说话...国庆放几天?' }) })
    const result = await h.dispatch.send({ family: 'doubao', text: 'x', submit: true, newConversation: true })
    expect(h.saves).toHaveLength(1)
    expect(result.dispatch?.draft?.saved).toBe(true)
  })
})

describe('草稿存在哪、那句话怎么说', () => {
  it('放在 ~/.dsh/workbench/drafts/,一段一个文件', () => {
    expect(draftsDir('/Users/example')).toBe('/Users/example/.dsh/workbench/drafts')
    expect(draftFilePath('doubao', AT, '/Users/example'))
      .toBe('/Users/example/.dsh/workbench/drafts/doubao-2026-09-27T21-23-00-000Z.txt')
  })

  it('★文件名里只留安全字符(路径是路径,不让来源决定往哪写)', () => {
    expect(draftFileName('../../etc', '2026-09-27T21:23:00.000Z')).toBe('------etc-2026-09-27T21-23-00-000Z.txt')
    expect(draftFileName('doubao', AT)).not.toContain(':')
  })

  it('★存的是原文原样:不 trim、不加尾换行、不 JSON 转义', async () => {
    const home = await mkdtemp(join(tmpdir(), 'drafts-'))
    const text = '  国庆放几天?\n\n"带引号"与 \\ 反斜杠\n'
    const saved = await saveClientDraft({ family: 'doubao', text, at: AT }, home)
    expect(saved.ok).toBe(true)
    expect(await readFile(saved.path as string, 'utf8')).toBe(text)
    // 出处另存一份,内容与出处分开两个文件 —— 「原文原样」这一条不许被 JSON 碰到。
    const meta = JSON.parse(await readFile(`${saved.path as string}.json`, 'utf8')) as Record<string, unknown>
    expect(meta.family).toBe('doubao')
    expect(meta.at).toBe(AT)
    expect(meta.chars).toBe(text.length)
  })

  it('存不下来**绝不抛**:回一句原因,派活不被带塌', async () => {
    const saved = await saveClientDraft({ family: 'doubao', text: '半句', at: AT }, '/不存在的盘/也写不进去')
    expect(saved.ok).toBe(false)
    expect(saved.reason).not.toBe(undefined)
  })

  it('那句话三档各说各的', () => {
    expect(draftSavedNote({ who: '豆包办公', saved: { ok: true, path: '/p.txt' }, returned: true }))
      .toContain('原样放回')
    expect(draftSavedNote({ who: '豆包办公', saved: { ok: true, path: '/p.txt' }, returned: false, reason: '没按发送' }))
      .toContain('/p.txt')
    expect(draftSavedNote({ who: '豆包办公', saved: { ok: false, reason: '磁盘满了' }, returned: false }))
      .toContain('磁盘满了')
  })
})
