/**
 * 设置里那一页(2026-10-01 叫「事务官的提示词」;2026-10-02 改成**她的偏好页**)。
 *
 * ## 10-02 为什么重做
 *
 * 10-01 那一版把 `~/.dsh/AGENTS.md` 的每一个标记段原样摊出来给她改。统筹量过维护者那台
 * (做产品模板):9 段、约 2.7 万字、接口与地址 149 处(「派活给别家Agent」5839 字、
 * 「做产品-改工作台自己」5047 字),运营模板还多十段。Air 上那位运营同学的反馈是
 * **「太杂了」**;维护者 10-02:「提示词现在看似有一个汇总的地方,但是运营人员反馈太杂了」,
 * 并要求「不要拿着打补丁的心态,要有机制上的调整」。
 *
 * 机制上的调整 = **分两层**(不是把那一页排得好看一点):
 *
 * 1. **她的意思**(这一页默认看到的全部):
 *    - 人话那几项,每项一句说明 + 一个例子:它叫什么 / 怎么称呼你 / 说话方式 /
 *      你的规矩(指回「记住的规矩」那一张表,**不出第二个入口**)/ 还想交代的几句;
 *    - **各工作环节的偏好**:环节名与例子**从当前模板那几条技能里取**
 *      (`opsSkills.ts` 的 `stage`),运营模板是选题 / 写稿 / 标题与封面 / 复盘……,
 *      做产品模板是另一套 —— 界面里**不写第二份清单**(写死一份,加一条技能就漏)。
 * 2. **机器说明书**:技能正文。她**不再改正文**(收回 10-01 那一版的可编辑,门在
 *    `store.save` 里,不只是界面上灰一下),整摊收在页底「工作台怎么干活(只读)」,默认收起。
 *    她那几句偏好由本体在写 AGENTS.md 那一刻接在对应技能正文末尾
 *    (`promptOverrides.withPromptPrefs`)—— 于是**发版重写技能,偏好原样不动**。
 *
 * 不可改清单(AGENTS.md §9)那几段**照旧只读**,而且不收偏好:锁它们的理由正是"不许被改口径"。
 *
 * 生效时机(回包里原话说给她听):**这一页写的是文件**,所以电话**下一通**就算数
 * (`GET /channel/persona` 每通现取),事务官本尊那条 DSH 会话要**新开一条**才读得到。
 */
import type { ButlerPromptSectionView, ButlerPromptStageView, ButlerPromptsView } from '../protocol.ts'
import {
  CALL_ADDRESS_BLOCK, SPEAKING_STYLE_BLOCK,
  applyAgentsFile, butlerNameOf, listMarkedBlockNames, readMarkedBlock, textOutsideMarkedBlocks,
} from './memoryMd.ts'
import { RULES_BLOCK } from './rules.ts'
import type { WbHooksApplyIo } from './hooksApply.ts'
import { wbAgentsWrite, wbSkillApply, wbSkillRevert } from './hooksApply.ts'
import {
  PROMPT_EXTRA_SECTION, PROMPT_NAME_SECTION, type PromptOverrideStore,
  promptSectionEditable, promptSectionKind, promptSectionMeta, stripPromptPrefBlock,
} from './promptOverrides.ts'

/** 保存 / 恢复 / 撤回之后说的那一句。**说清下一步**,不留一句"好了"。 */
export const PROMPT_SAVED_NOTE
  = '写进事务官的设置了。电话下一通就按新的说;它本尊那条会话要新开一条才读得到。'

/** 偏好写完之后那一句(这个环节还没接上时会多半句实话)。 */
export const PROMPT_PREF_SAVED_NOTE = `记下了,这个环节以后都照这几句办。${PROMPT_SAVED_NOTE}`

/** 页底那一节的标题。界面与用例都引这一份,不逐字抄。 */
export const PROMPT_MANUAL_TITLE = '工作台怎么干活(只读)'

export type PromptsWriteResult = { ok: true, note: string, backup_path?: string } | { ok: false, error: string }

export interface PromptsService {
  view: () => Promise<ButlerPromptsView>
  save: (input: { name: string, body: string }) => Promise<PromptsWriteResult>
  reset: (name: string) => Promise<PromptsWriteResult>
  undo: (name: string) => Promise<PromptsWriteResult>
  /** 一个环节的偏好,整组替换(2026-10-02)。 */
  setPrefs: (input: { name: string, lines: readonly string[] }) => Promise<PromptsWriteResult>
  undoPrefs: (name: string) => Promise<PromptsWriteResult>
  /** 打发掉那句「这段你改过的旧内容我替你放在这里了」。 */
  dismissPrefNotice: (name: string) => Promise<PromptsWriteResult>
}

/**
 * **人话那几项**的先后(2026-10-02)。她最常改的在前。
 *
 * 「通话偏好(旧的几条)」**不在这一栏**:那一段是 09-24 之前攒下的残留,摆在人话里只会多一项
 * 她看不懂的东西。它在页底那一节里只读地露着(没有就不露)。
 */
const BASIC_ORDER: readonly string[] = [
  PROMPT_NAME_SECTION, CALL_ADDRESS_BLOCK, SPEAKING_STYLE_BLOCK, RULES_BLOCK, PROMPT_EXTRA_SECTION,
]

/** 这个模板下那几条技能(带不带环节由 `opsSkills.ts` 说)。 */
export interface PromptsSkillRef {
  name: string
  /** 给维护者看的那一行(里面有接口路径)。**只用在页底那一节**。 */
  summary?: string
  /** 这一段对应哪个环节(人话名字 + 一句人话说明 + 一个例子),见 `opsSkills.ts` 的 `stage`。 */
  stage?: { title: string, note: string, example: string }
}

type PromptsStageRef = PromptsSkillRef & { stage: { title: string, note: string, example: string } }

export function createPromptsService(options: {
  store: PromptOverrideStore
  /** `~/.dsh/AGENTS.md`。**由调用方给**(2026-09-04 事故纪律:写家目录的路径一律注入)。 */
  agentsFile: string
  deps: WbHooksApplyIo
  /** 这个模板下该有哪几段技能(用来把"该有、还没接上"的段也列出来)。不接就只列文件里有的。 */
  skills?: () => readonly PromptsSkillRef[]
}): PromptsService {
  const { store, agentsFile, deps } = options

  async function readAgents(): Promise<string> {
    return (await deps.io.readFile(agentsFile)) ?? ''
  }

  function skillRefs(): readonly PromptsSkillRef[] {
    return options.skills?.() ?? []
  }

  /** 文件里此刻这一段的正文(偏好那一节摘掉 —— 它不是正文,是用户层接上去的)。 */
  function bodyOf(text: string, name: string): string {
    const meta = promptSectionMeta(name)
    if (meta.mode === 'line') return butlerNameOf(text) ?? ''
    const found = readMarkedBlock(text, name)
    return found === undefined ? '' : stripPromptPrefBlock(found).trimEnd()
  }

  function presentIn(text: string, name: string): boolean {
    return promptSectionMeta(name).mode === 'line'
      ? butlerNameOf(text) !== undefined
      : readMarkedBlock(text, name) !== undefined
  }

  function rowOf(text: string, name: string): ButlerPromptSectionView {
    const meta = promptSectionMeta(name)
    const overrideRow = store.rows().find(one => one.name === name)
    const summary = skillRefs().find(one => one.name === name)?.summary
    return {
      name,
      title: meta.title,
      note: summary === undefined ? meta.note : `${meta.note}(${summary})`,
      body: bodyOf(text, name),
      present: presentIn(text, name),
      editable: promptSectionEditable(meta),
      overridden: store.get(name) !== undefined,
      default_changed: overrideRow?.default_changed ?? false,
      can_undo: overrideRow?.can_undo ?? false,
      ...(meta.example === undefined ? {} : { example: meta.example }),
      ...(overrideRow?.default_body === undefined ? {} : { default_body: overrideRow.default_body }),
      ...(overrideRow?.latest_default_body === undefined ? {} : { latest_default_body: overrideRow.latest_default_body }),
      ...(meta.locked === undefined ? {} : { locked: meta.locked }),
      ...(meta.elsewhere === undefined ? {} : { elsewhere: meta.elsewhere }),
      ...(meta.manual === undefined ? {} : { manual: meta.manual }),
    }
  }

  /**
   * 这个模板下有哪几个环节。
   *
   * 判据只有一条,而且不在界面里:**这条技能带 `stage`**(`opsSkills.ts` 说它是一个做事环节)。
   *
   * ★ 2026-10-02 上午那一版还多一条「不在不可改清单里」,当天下午维护者拍板去掉:
   * 那一条让**做产品模板下只剩一个环节**(《需求确认点》《做产品-改工作台自己》都在清单上)。
   * 锁着的那两段**正文照旧只读**(`store.save` 当场 400),但偏好收得下 —— 她在那一步上
   * 加一句自己的讲究不算触及清单。
   */
  function stageRefs(): readonly PromptsStageRef[] {
    return skillRefs().filter((one): one is PromptsStageRef => one.stage !== undefined)
  }

  function stageOf(text: string, ref: PromptsStageRef): ButlerPromptStageView {
    const pref = store.prefs(ref.name)
    return {
      name: ref.name,
      title: ref.stage.title,
      // 人话那一句(**不是** `summary`:那一行里有接口路径,这一栏上一条路径都不许出现)。
      note: ref.stage.note,
      example: ref.stage.example,
      lines: pref.lines,
      present: presentIn(text, ref.name),
      can_undo: pref.can_undo,
      ...(pref.kept === undefined ? {} : { kept: pref.kept }),
      ...(pref.notice === undefined ? {} : { notice: pref.notice }),
    }
  }

  /** 页底那一摊:文件里的段 + 这个模板该有的段,减去人话那几项。 */
  function manualNames(text: string): readonly string[] {
    const out: string[] = []
    const push = (name: string): void => {
      if (BASIC_ORDER.includes(name) || out.includes(name)) return
      out.push(name)
    }
    for (const name of listMarkedBlockNames(text)) push(name)
    for (const ref of skillRefs()) push(ref.name)
    return out
  }

  /** 把算好的正文写进文件。标记段走 `wbSkillApply`,首行走 `wbAgentsWrite`,两条都先备份。 */
  async function writeSection(name: string, body: string): Promise<PromptsWriteResult> {
    const meta = promptSectionMeta(name)
    if (meta.mode === 'line') {
      const text = await readAgents()
      const next = applyAgentsFile(text, { butlerName: body.trim() })
      const done = await wbAgentsWrite(deps, { file: agentsFile, next })
      return done.ok
        ? { ok: true, note: PROMPT_SAVED_NOTE, ...(done.backup_path === undefined ? {} : { backup_path: done.backup_path }) }
        : { ok: false, error: done.error }
    }
    if (body.trim() === '') {
      // 空的那一段就把它摘掉(只有「还想交代的几句」到得了这里):留一个空标记段是两行噪音。
      const done = await wbSkillRevert(deps, { file: agentsFile, name })
      return done.ok
        ? { ok: true, note: PROMPT_SAVED_NOTE, ...(done.backup_path === undefined ? {} : { backup_path: done.backup_path }) }
        : { ok: false, error: done.error }
    }
    const done = await wbSkillApply(deps, { file: agentsFile, name, body })
    return done.ok
      ? { ok: true, note: PROMPT_SAVED_NOTE, ...(done.backup_path === undefined ? {} : { backup_path: done.backup_path }) }
      : { ok: false, error: done.error }
  }

  /**
   * 偏好改完,把这一段**原地重写一次**:正文照旧(文件里那一份,偏好那一节先摘掉),
   * 偏好由腰眼 `wbSkillMergeInto` 接上去。
   *
   * 这一段还没接上(文件里没有)→ 不造一段出来:偏好先存着,「重新接上」或者切模板那一下
   * 会把正文写进去,同一个腰眼顺手把偏好带上。如实回一句,不装作写进去了(D13)。
   */
  async function rewriteStage(name: string): Promise<PromptsWriteResult> {
    const text = await readAgents()
    const body = bodyOf(text, name)
    if (body === '') {
      return {
        ok: true,
        note: '记下了。这个环节的说明书这台机器上还没接上 —— 在「技能」那一节点一次「重新接上」,你这几句会跟着写进去。',
      }
    }
    const done = await writeSection(name, body)
    return done.ok ? { ...done, note: PROMPT_PREF_SAVED_NOTE } : done
  }

  return {
    view: async () => {
      const text = await readAgents()
      return {
        file: agentsFile,
        basics: BASIC_ORDER.map(name => rowOf(text, name)),
        stages: stageRefs().map(ref => stageOf(text, ref)),
        manual: manualNames(text).map(name => rowOf(text, name)),
        outside: textOutsideMarkedBlocks(text),
        note: '这里写的是你的意思:它怎么称呼你、怎么说话、各个环节照你哪几句办。'
          + '改完电话下一通就按新的说;它本尊那条会话要新开一条才读得到。',
      }
    },

    save: async ({ name, body }) => {
      const text = await readAgents()
      // 她还没改过这一段时,**文件里现在那一份就是默认**(它正是各条写入路写进去的那一份)。
      const current = bodyOf(text, name)
      const stored = await store.save(name, body, { defaultBody: current })
      if (!stored.ok) return { ok: false, error: stored.error }
      // 表先改、文件后写:`wbSkillMergeInto` 会去问覆盖层,这个顺序才写得出她这一版。
      const written = await writeSection(name, body)
      if (!written.ok) {
        // 文件没写成就把表撤回去 —— 不留一份"界面说改了、事务官读的还是旧的"。
        await store.undo(name)
        return written
      }
      return written
    },

    reset: async (name) => {
      const row = store.rows().find(one => one.name === name)
      if (row === undefined) return { ok: true, note: '这一项本来就是默认的,什么都没改。' }
      const back = row.latest_default_body ?? row.default_body
      if (back === undefined) {
        return {
          ok: false,
          error: '这一项的默认那一份没留底(这台机器上还没有哪条路写过它),所以没法自动恢复。'
            + '在「技能」那一节点一次「重新接上」就会写回默认那一份。',
        }
      }
      const cleared = await store.reset(name)
      if (!cleared.ok) return { ok: false, error: cleared.error }
      const written = await writeSection(name, back)
      if (!written.ok) { await store.undo(name); return written }
      return { ...written, note: `已经换回默认那一份。${PROMPT_SAVED_NOTE}` }
    },

    undo: async (name) => {
      const done = await store.undo(name)
      if (!done.ok) return { ok: false, error: done.error }
      // 撤到的那一版可能是「没改过」 —— 那就写默认那一份(表里留着底,文件里此刻还是她上一版)。
      const kept = store.defaults(name)
      const body = store.get(name)?.body ?? kept.latest_default_body ?? kept.default_body ?? ''
      if (body === '') {
        return { ok: false, error: '撤到了「没改过」,可这一项的默认没留底 —— 在「技能」那一节点一次「重新接上」会写回默认那一份。' }
      }
      const written = await writeSection(name, body)
      if (!written.ok) return written
      return { ...written, note: `撤到上一版了。${PROMPT_SAVED_NOTE}` }
    },

    setPrefs: async ({ name, lines }) => {
      if (promptSectionKind(name) !== 'skill') {
        return { ok: false, error: '这一项你直接改上面那一栏就行,不用在这儿写偏好。' }
      }
      const stored = await store.setPrefs(name, lines)
      if (!stored.ok) return { ok: false, error: stored.error }
      const written = await rewriteStage(name)
      // 文件没写成就把那一组撤回去 —— 不留一份"界面说记下了、事务官读的还是旧的"。
      if (!written.ok) await store.undoPrefs(name)
      return written
    },

    undoPrefs: async (name) => {
      const done = await store.undoPrefs(name)
      if (!done.ok) return { ok: false, error: done.error }
      const written = await rewriteStage(name)
      if (!written.ok) return written
      return { ...written, note: `撤到上一版了。${PROMPT_SAVED_NOTE}` }
    },

    dismissPrefNotice: async (name) => {
      await store.dismissPrefNotice(name)
      return { ok: true, note: '知道了。' }
    },
  }
}
