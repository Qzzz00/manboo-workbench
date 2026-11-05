// @vitest-environment node
/**
 * 选题指挥台的**纯算那一半**(2026-09-22,卡 ②):四态归类、段落级 diff、
 * 交给事务官那段话里到底带了什么。
 *
 * 这一份一个 HTTP 都不起 —— 起服务的那半在 `server-topic-deck-http.test.ts`。
 * 这里钉的是**判据**:同一份产物、同一段进度,拼出来的话必须逐字可预期,
 * 否则"她不必再交代一遍"这句承诺就没法验。
 */
import { describe, expect, it } from 'vitest'
import {
  TOPIC_PHASES, TOPIC_PHASE_OF_STAGE, TOPIC_STAGES, TOPIC_DOC_TABS,
  stagesOfTopicPhase, topicPhaseOf,
} from '../src/protocol.ts'
import type { TopicDocView } from '../src/protocol.ts'
import {
  TOPIC_DOC_FILES, TOPIC_STAGE_SKILL, TOPIC_STAGE_TAB,
  buildTopicReviseMessage, buildTopicRunPrompt, diffParagraphs, splitParagraphs, stageNeedsRelay,
} from '../src/server/topicRun.ts'
import { OPS_SKILLS } from '../src/server/opsSkills.ts'
import { TOPIC_DELIVERABLE_FILES } from '../src/templates.ts'

describe('四态:六段归成四种工作状态', () => {
  it('设计第〇节那句逐字:构思=灵感,制作=初稿/准备素材/制作中,发布=发布,复盘=复盘', () => {
    expect(stagesOfTopicPhase('构思')).toEqual(['灵感'])
    expect(stagesOfTopicPhase('制作')).toEqual(['初稿', '准备素材', '制作中'])
    expect(stagesOfTopicPhase('发布')).toEqual(['发布'])
    expect(stagesOfTopicPhase('复盘')).toEqual(['复盘'])
  })

  it('★ 六段一个不落,每一段都归得到一态(将来加一段会当场红)', () => {
    for (const stage of TOPIC_STAGES) {
      expect(TOPIC_PHASES).toContain(TOPIC_PHASE_OF_STAGE[stage])
    }
    // 反过来:四态各自至少认领一段,没有一个空着的态。
    for (const phase of TOPIC_PHASES) expect(stagesOfTopicPhase(phase).length).toBeGreaterThan(0)
  })

  it('没写过进度的按「灵感」算,也就是「构思」——**盘上不写**,只是显示时的缺省', () => {
    expect(topicPhaseOf(undefined)).toBe('构思')
    expect(topicPhaseOf('制作中')).toBe('制作')
  })
})

describe('页签 → 文件名:只有一份定义', () => {
  it('★ 六段那六个逐字来自 TOPIC_DELIVERABLE_FILES(不许在这里敲第二份字面量)', () => {
    expect(TOPIC_DOC_FILES.框架).toBe(TOPIC_DELIVERABLE_FILES.灵感)
    expect(TOPIC_DOC_FILES.初稿).toBe(TOPIC_DELIVERABLE_FILES.初稿)
    expect(TOPIC_DOC_FILES.素材清单).toBe(TOPIC_DELIVERABLE_FILES.准备素材)
    expect(TOPIC_DOC_FILES.定稿).toBe(TOPIC_DELIVERABLE_FILES.制作中)
    expect(TOPIC_DOC_FILES.发布包装).toBe(TOPIC_DELIVERABLE_FILES.发布)
    expect(TOPIC_DOC_FILES.复盘).toBe(TOPIC_DELIVERABLE_FILES.复盘)
  })

  it('★ 第七个是「合规查词」→ 查词.md —— 它故意不在六段表里(守卫用例的白名单)', () => {
    expect(TOPIC_DOC_FILES.合规查词).toBe('查词.md')
    expect(Object.values(TOPIC_DELIVERABLE_FILES)).not.toContain('查词.md')
    // 而且它确实是《运营-合规查词》那一条技能的固定产物,不是我们编的一个名字。
    const skill = OPS_SKILLS.find(one => one.name === '运营-合规查词')
    expect(skill?.artifacts.some(one => one.endsWith('/查词.md'))).toBe(true)
  })

  it('七个页签 = 七个不同的文件名,一个不重', () => {
    const files = TOPIC_DOC_TABS.map(tab => TOPIC_DOC_FILES[tab])
    expect(new Set(files).size).toBe(TOPIC_DOC_TABS.length)
  })

  it('★ 每一段点名的那份技能在 OPS_SKILLS 里真找得到(名字差一个字,事务官就找不到那一段)', () => {
    const names = new Set(OPS_SKILLS.map(one => one.name))
    for (const stage of TOPIC_STAGES) expect(names).toContain(TOPIC_STAGE_SKILL[stage])
  })
})

describe('段落级 diff', () => {
  it('空行分段;段内的换行留着(markdown 的列表是一段)', () => {
    expect(splitParagraphs('一\n二\n\n三')).toEqual(['一\n二', '三'])
    expect(splitParagraphs('\n\n  \n\n')).toEqual([])
  })

  it('没改动时全是 same', () => {
    expect(diffParagraphs('甲\n\n乙', '甲\n\n乙')).toEqual([
      { kind: 'same', text: '甲' },
      { kind: 'same', text: '乙' },
    ])
  })

  it('★ 改写一段 = 先「删」后「增」,读起来是"原来这么写 → 现在这么写"', () => {
    expect(diffParagraphs('甲\n\n乙', '甲\n\n丙')).toEqual([
      { kind: 'same', text: '甲' },
      { kind: 'del', text: '乙' },
      { kind: 'add', text: '丙' },
    ])
  })

  it('中间插一段:只标那一段是新增的,前后照旧是 same', () => {
    expect(diffParagraphs('甲\n\n丙', '甲\n\n乙\n\n丙')).toEqual([
      { kind: 'same', text: '甲' },
      { kind: 'add', text: '乙' },
      { kind: 'same', text: '丙' },
    ])
  })

  it('★ 太长就**不比**,回 undefined —— 不静默给一个只比了前面那些的 diff', () => {
    const huge = Array.from({ length: 401 }, (_, at) => `第 ${at} 段`).join('\n\n')
    expect(diffParagraphs(huge, huge)).toBeUndefined()
  })
})

/** 一份"什么都还没有"的七个页签。 */
function emptyDocs(): TopicDocView[] {
  return TOPIC_DOC_TABS.map(tab => ({ tab, file: TOPIC_DOC_FILES[tab], exists: false }))
}

describe('交给事务官那段话', () => {
  const base = {
    name: '露营锅具怎么选',
    taskId: 't-7',
    dir: '/假路径/选题/露营锅具怎么选',
    docs: emptyDocs(),
    reviews: [],
    relayReady: true,
    // 2026-09-23 加的那道门:下面这些用例说的是"已经过了确认点之后那段话长什么样",
    // 所以 base 里就是 true。**未确认那一支另有用例**(见文件末尾那一组)。
    confirmed: true,
  }

  it('★ 逐字写着「不要重新问她一遍背景」——这一条就是「不要求她再交代」的落点', () => {
    const text = buildTopicRunPrompt({ ...base, stage: '制作中' })
    expect(text).toContain('不要重新问她一遍背景')
    expect(text).toContain('她这一次没有再交代任何事')
  })

  it('带着段、工作状态、技能名与该落哪个文件', () => {
    const text = buildTopicRunPrompt({ ...base, stage: '制作中' })
    expect(text).toContain('「制作中」')
    expect(text).toContain('工作状态:制作')
    expect(text).toContain('《运营-初稿定稿》')
    expect(text).toContain(TOPIC_DOC_FILES[TOPIC_STAGE_TAB['制作中']])
    expect(text).toContain('/假路径/选题/露营锅具怎么选')
    expect(text).toContain('(工作台事项 t-7)')
  })

  it('★ 已有的产物逐条点名(有就说有多少字,没有就说还没有)', () => {
    const docs = emptyDocs().map(one => (
      one.tab === '框架' ? { ...one, exists: true, text: '一二三四五', updated_at: '2026-09-22T01:00:00.000Z' } : one
    ))
    const text = buildTopicRunPrompt({ ...base, stage: '初稿', docs })
    expect(text).toContain('框架.md:有了(5 字,最后改于 2026-09-22T01:00:00.000Z)')
    expect(text).toContain('定稿.md:还没有')
  })

  it('★ 挂了账号就叫它先读账号.md;没挂账号**一个字都不编**', () => {
    expect(buildTopicRunPrompt({ ...base, stage: '灵感', account: '露营小周' }))
      .toContain('账号/露营小周/账号.md')
    expect(buildTopicRunPrompt({ ...base, stage: '灵感' })).not.toContain('账号.md')
  })

  it('★ 她说过的话带过去(同一处不该被打回两次);`run` 那几条不算把关,不带', () => {
    const text = buildTopicRunPrompt({
      ...base,
      stage: '制作中',
      reviews: [
        { at: '2026-09-22T02:00:00.000Z', tab: '定稿', action: 'revise', text: '开头太软了' },
        { at: '2026-09-22T03:00:00.000Z', tab: '定稿', action: 'run' },
      ],
    })
    expect(text).toContain('「开头太软了」')
    expect(text).not.toContain('让我推进')
  })

  it('一次都没把过关时如实说一句,不留白', () => {
    expect(buildTopicRunPrompt({ ...base, stage: '灵感' })).toContain('她还没对任何一份产物把过关')
  })

  it('按白板分工点名派给谁;「准备素材」「发布」那两段没有要派的活', () => {
    expect(buildTopicRunPrompt({ ...base, stage: '初稿' })).toContain('GPT / 豆包')
    expect(buildTopicRunPrompt({ ...base, stage: '灵感' })).toContain('Claude')
    expect(buildTopicRunPrompt({ ...base, stage: '准备素材' })).toContain('这一段没有要派出去的活')
    expect(buildTopicRunPrompt({ ...base, stage: '发布' })).toContain('这一段没有要派出去的活')
  })

  it('★ 代做:接口那两家发不出去时,明着让它自己顶,并且**明说不要假装是它们写的**', () => {
    const text = buildTopicRunPrompt({
      ...base,
      stage: '初稿',
      relayReady: false,
      relayNote: '现在用的是你自己的 Key,直连官方发不出这两家',
    })
    expect(text).toContain('你自己顶着做')
    expect(text).toContain('这一版是我代做的')
    expect(text).toContain('不要假装是它们写的')
    expect(text).toContain('现在用的是你自己的 Key')
  })

  it('★ 不经中转的那两段(准备素材 / 发布)**不谈代做** —— 它们本来就没要派的活', () => {
    expect(stageNeedsRelay('准备素材')).toBe(false)
    expect(stageNeedsRelay('发布')).toBe(false)
    expect(stageNeedsRelay('初稿')).toBe(true)
    expect(buildTopicRunPrompt({ ...base, stage: '准备素材', relayReady: false })).not.toContain('代做')
  })

  it('★ 她说过不止一次的偏好一条一行带过去,并写明「先照它做,不用她再交代」(2026-09-23)', () => {
    const line = '「开头太长」—— 在《露营锅具怎么选》《帐篷选购避坑》上都打回过(试用中,2026-09-23 起)'
    const text = buildTopicRunPrompt({ ...base, stage: '初稿', preferences: [line] })
    expect(text).toContain(`- ${line}`)
    expect(text).toContain('先照它做,不用她再交代')
    // 摆在「她把过的关」之后、派活之前。
    expect(text.indexOf('先照它做')).toBeGreaterThan(text.indexOf('她还没对任何一份产物把过关'))
    expect(text.indexOf('先照它做')).toBeLessThan(text.indexOf('这一段白板上分给'))
  })

  it('★ 没有偏好(缺席或空)时那一段整段缺席,话与加它之前逐字相同', () => {
    const plain = buildTopicRunPrompt({ ...base, stage: '初稿' })
    expect(buildTopicRunPrompt({ ...base, stage: '初稿', preferences: [] })).toBe(plain)
    expect(buildTopicRunPrompt({ ...base, stage: '初稿', preferences: ['  '] })).toBe(plain)
    expect(plain).not.toContain('偏好')
  })

  it('她补的那一句原样带过去', () => {
    expect(buildTopicRunPrompt({ ...base, stage: '灵感', note: '这次想走情绪那条线' }))
      .toContain('「这次想走情绪那条线」')
  })
})

describe('「改一改」送出去的那一句', () => {
  it('★ 带上是哪一份 + 她的原话,而不是一句没有主语的意见', () => {
    const text = buildTopicReviseMessage({ name: '露营锅具怎么选', taskId: 't-7', tab: '定稿', text: '第二段删掉' })
    expect(text).toContain('定稿.md')
    expect(text).toContain('「第二段删掉」')
    expect(text).toContain('(工作台事项 t-7)')
  })
})
