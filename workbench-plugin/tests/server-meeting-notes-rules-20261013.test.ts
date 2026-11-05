// @vitest-environment node
/**
 * 纪要按《会议纪要生成规则》出(2026-10-13,卡「会议纪要按规则出 + 不靠现场录音的演示样例」)。
 * 规则原文:`docs/规范-会议纪要生成规则-2026-10-12.md`,九条逐条对照见 `docs/交接-1013-会议纪要按规则.md` 第一节。
 *
 * 这份用例盯的是**纯的那一半**:给模型那段话、把模型回的东西读成结构、拼出 `纪要.md`。
 * 夹具是演示用的那份转写样例(`docs/演示/会议样例-自媒体选题会-转写.md`),所以样例一改,这里当场红。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  CLAIM_KINDS,
  MEETING_SECTIONS,
  MEETING_TOPIC_FIELDS,
  buildMeetingPrompt,
  nextDroppedLine,
  parseMeetingReply,
  renderNotesMd,
  transcriptBodyOf,
} from '../src/server/meetingText.ts'

/** 演示样例那份转写的正文(文件头不算 —— 校验「下一步」时不能拿文件头里的字当证据)。 */
const SAMPLE = transcriptBodyOf(readFileSync(new URL('../../docs/演示/会议样例-自媒体选题会-转写.md', import.meta.url), 'utf8'))

/**
 * 模型照格式回的那一份(手写,模仿 V4 Flash 在上面那份转写上的输出)。
 * 故意埋了四处要被程序挡掉的东西:
 * - 「下一步」里编了一个转写里没有的人(阿杏);
 * - 「下一步」里编了一个转写里没说过的日子(10月20号);
 * - 判断里有一行没标性质;
 * - 议题里有一行不是列表项。
 */
const REPLY = [
  `## ${MEETING_SECTIONS.solved}`,
  '- 定了下个月的内容结构:四条短的加一条长的',
  '- 定了短片开头不做自我介绍,直接抛数',
  '- 两条选题过了,第三条只算想法、不排期',
  '- 第二个账号今天没定,先去查平台规则',
  '',
  `## ${MEETING_SECTIONS.topic}:下个月的选题方向`,
  `### ${MEETING_TOPIC_FIELDS.discussed}`,
  '- 这个月后半段流量掉了一截,同量级的号也在掉',
  '- 短的那一头和长的那一条各做多少',
  '这一行不是列表项,该丢掉',
  `### ${MEETING_TOPIC_FIELDS.claims}`,
  '- [已确定] 下个月四条短的加一条长的',
  '- [已确定] 新手三个坑那一条直接做',
  '- [待验证] 拆爆款那一条要先拿到数据才定',
  '- [初步想法] 讲自己翻车那一条可能好、也可能把调性带偏,不排期',
  '- 这一行没标性质,该丢掉',
  `### ${MEETING_TOPIC_FIELDS.why}`,
  '- 平台这一轮把推荐权重往完播率挪了,上个月那批长片完播率本来就低',
  `### ${MEETING_TOPIC_FIELDS.chain}`,
  '- 流量掉了 → 权重挪到完播率 → 长片吃亏 → 多做短片、长片一个月一条',
  '',
  `## ${MEETING_SECTIONS.topic}:上个月那条起量的片子`,
  `### ${MEETING_TOPIC_FIELDS.discussed}`,
  '- 那一条的完播率是所有片子里最高的一条',
  `### ${MEETING_TOPIC_FIELDS.claims}`,
  '- [已确定] 短片开头不自我介绍,直接抛一个数或者一个反常识的说法',
  '- [当前判断] 后半段每二十秒一个转折也有用,只有一条片子说明不了',
  `### ${MEETING_TOPIC_FIELDS.why}`,
  '- 改过开头的那一条完播率也上去了一点',
  '',
  `## ${MEETING_SECTIONS.topic}:要不要再开一个号`,
  `### ${MEETING_TOPIC_FIELDS.discussed}`,
  '- 开新号把短的那一头单独放过去,或者只搬切片',
  `### ${MEETING_TOPIC_FIELDS.claims}`,
  '- [初步想法] 开第二个账号这件事今天不下结论',
  '- [待验证] 平台对切片和搬运怎么判还不清楚',
  `### ${MEETING_TOPIC_FIELDS.why}`,
  '- 卡在两处:人手不够、平台怎么判不知道',
  '',
  `## ${MEETING_SECTIONS.topic}:拍摄与素材排期`,
  `### ${MEETING_TOPIC_FIELDS.discussed}`,
  '- 四条短的集中在一天拍完,脚本要提前定',
  `### ${MEETING_TOPIC_FIELDS.claims}`,
  '- [已确定] 四条短的一天拍完',
  `### ${MEETING_TOPIC_FIELDS.why}`,
  '- 分开拍场地要重新搭,太浪费',
  '',
  `## ${MEETING_SECTIONS.keep}`,
  '- 下个月四条短的加一条长的',
  '- 开头不自我介绍,直接抛数',
  '- 第二个账号先查平台规则再谈开不开',
  '- 拆爆款那一条等数据',
  '',
  `## ${MEETING_SECTIONS.next}`,
  '- 小满|把那两条确定的选题框架写出来,一条一页|周五之前',
  '- |把平台对切片和搬运的规则查一份出来|下周一之前',
  '- 阿杏|跟剪辑对一下片头|这周三',
  '- |把第二个账号的定位写出来|10月20号',
  '',
  `## ${MEETING_SECTIONS.unsure}`,
  '- 「上次那个」指的是哪个场地没听清',
].join('\n')

describe('给模型那段话:九条规矩都写在里头', () => {
  const prompt = buildMeetingPrompt('十一月选题会', `[00:00:00] ${SAMPLE.slice(0, 20)}`)

  it('转写原文摆进去了,「不许编发言人」照旧写死在里头', () => {
    expect(prompt).toContain('没有说话人分离')
    expect(prompt).toContain('一个发言人都不许写')
  })

  it('五段标题与四种性质标记都在,模型照着填', () => {
    for (const name of Object.values(MEETING_SECTIONS)) expect(prompt).toContain(name)
    for (const name of Object.values(MEETING_TOPIC_FIELDS)) expect(prompt).toContain(name)
    for (const kind of CLAIM_KINDS) expect(prompt).toContain(kind)
  })

  it('按议题不按发言顺序、同一观点只留一处、口语废话删掉、链路用箭头、结尾再压一遍 —— 五条都明写', () => {
    expect(prompt).toContain('不按发言顺序')
    expect(prompt).toContain('合并')
    expect(prompt).toContain('删')
    expect(prompt).toContain('→')
    expect(prompt).toContain(MEETING_SECTIONS.keep)
  })

  it('脑暴不许写成结论、下一步不许自己补 —— 两条最要紧的说死', () => {
    expect(prompt).toContain('脑暴')
    expect(prompt).toContain('不许补')
    expect(prompt).toContain('不要换算成日期')
  })
})

describe('读模型回的那几段(规则 1—8)', () => {
  const parsed = parseMeetingReply(REPLY, SAMPLE)

  it('开头那几条「解决了什么」读出来了,3—5 条', () => {
    expect(parsed.solved.length).toBeGreaterThanOrEqual(3)
    expect(parsed.solved.length).toBeLessThanOrEqual(5)
    expect(parsed.solved[0]).toContain('四条短的加一条长的')
  })

  it('议题按议题分,每个议题只有三类信息 + 一条链路;不是列表项的那一行丢掉', () => {
    expect(parsed.topics.map(one => one.name)).toEqual(['下个月的选题方向', '上个月那条起量的片子', '要不要再开一个号', '拍摄与素材排期'])
    const first = parsed.topics[0]
    expect(first?.discussed).toHaveLength(2)
    expect(first?.discussed.join('')).not.toContain('不是列表项')
    expect(first?.why).toEqual(['平台这一轮把推荐权重往完播率挪了,上个月那批长片完播率本来就低'])
    expect(first?.chain[0]).toContain('→')
  })

  it('每条判断都标着性质,四种之内;没标性质的那一行丢掉(不替它猜一个)', () => {
    const claims = parsed.topics.flatMap(one => one.claims)
    expect(claims.length).toBeGreaterThan(0)
    for (const claim of claims) expect(CLAIM_KINDS).toContain(claim.kind)
    expect(claims.some(one => one.text.includes('没标性质'))).toBe(false)
    expect(parsed.topics[0]?.claims).toHaveLength(4)
  })

  it('★ 脑暴的没被写成结论:翻车那条、开第二个号都是「初步想法」,拿不准的是「待验证」', () => {
    const claims = parsed.topics.flatMap(one => one.claims)
    expect(claims.find(one => one.text.includes('翻车'))?.kind).toBe('初步想法')
    expect(claims.find(one => one.text.includes('第二个账号'))?.kind).toBe('初步想法')
    expect(claims.find(one => one.text.includes('拆爆款'))?.kind).toBe('待验证')
    expect(claims.filter(one => one.kind === '已确定').map(one => one.text).join('')).not.toContain('翻车')
  })

  it('结尾那一次压缩(最值得保留的 3—5 条)读出来了', () => {
    expect(parsed.keep.length).toBeGreaterThanOrEqual(3)
    expect(parsed.keep.length).toBeLessThanOrEqual(5)
  })

  it('拿不准的那一段照旧(它说的是识别可能听错了,不是会议内容)', () => {
    expect(parsed.unsure).toEqual(['「上次那个」指的是哪个场地没听清'])
  })
})

describe('★ 规则 9:「下一步」只留转写里真提到的(人名 / 日期必须在转写里出现过)', () => {
  const parsed = parseMeetingReply(REPLY, SAMPLE)

  it('转写里点了名、说了日子的那条留着,原话照抄不换算成日期', () => {
    const kept = parsed.todos.find(one => one.what.includes('选题框架'))
    expect(kept).toEqual({ id: 't1', who: '小满', what: '把那两条确定的选题框架写出来,一条一页', due: '周五之前' })
  })

  it('转写里没说谁、只说了日子的那条也留着,「谁」整格缺席(不写「某人」)', () => {
    const anon = parsed.todos.find(one => one.what.includes('平台对切片'))
    expect(anon?.who).toBeUndefined()
    expect(anon?.due).toBe('下周一之前')
  })

  it('★ 编出来的人名(转写里没有「阿杏」)→ 整条丢掉,并记一笔', () => {
    expect(parsed.todos.some(one => one.who === '阿杏')).toBe(false)
    expect(parsed.dropped.join('\n')).toContain('阿杏')
  })

  it('★ 编出来的日子(转写里没说过「10月20号」)→ 整条丢掉,并记一笔', () => {
    expect(parsed.todos.some(one => one.due === '10月20号')).toBe(false)
    expect(parsed.dropped.join('\n')).toContain('10月20号')
  })

  it('留下两条、丢掉两条,编号从 t1 连着排(手机上逐条勾用它)', () => {
    expect(parsed.todos.map(one => one.id)).toEqual(['t1', 't2'])
    expect(parsed.dropped).toHaveLength(2)
  })

  it('一个字转写都没给(空的那一侧)→ 带人名或日期的一条都不留,只留两头都没说的', () => {
    const bare = parseMeetingReply([`## ${MEETING_SECTIONS.next}`, '- 小满|写框架|周五之前', '- |把素材理一遍|'].join('\n'), '')
    expect(bare.todos.map(one => one.what)).toEqual(['把素材理一遍'])
    expect(bare.dropped).toHaveLength(1)
  })
})

describe('纪要.md', () => {
  const parsed = parseMeetingReply(REPLY, SAMPLE)
  const md = renderNotesMd({ title: '十一月选题会', date: '2026-10-13', startedAt: '2026-10-13T02:00:00.000Z', seconds: 800, parsed })

  it('五段按规则的顺序排:解决了什么 → 议题 → 最值得保留 → 下一步 → 拿不准', () => {
    const order = [MEETING_SECTIONS.solved, MEETING_SECTIONS.topic, MEETING_SECTIONS.keep, MEETING_SECTIONS.next, MEETING_SECTIONS.unsure]
      .map(name => md.indexOf(`## ${name}`))
    expect(order.every(at => at > 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('每个议题带着三类信息与性质标记,判断前面看得出是定了还是只是想法', () => {
    expect(md).toContain('下个月的选题方向')
    expect(md).toContain(MEETING_TOPIC_FIELDS.discussed)
    expect(md).toContain('已确定')
    expect(md).toContain('初步想法')
    expect(md).toContain('→')
  })

  it('下一步:没说谁的那条明写「没说谁」;丢掉的那两条如实记一笔', () => {
    expect(md).toContain('没说谁:把平台对切片和搬运的规则查一份出来(下周一之前)')
    expect(md).toContain(nextDroppedLine(2))
    expect(md).toContain('阿杏')
  })

  it('不知道录了多久(导入的那一场)→ 时长那一行整行不出现,不写「0 秒」', () => {
    const noSeconds = renderNotesMd({ title: '会', date: '2026-10-13', startedAt: '2026-10-13T02:00:00.000Z', parsed, imported: true })
    expect(noSeconds).not.toContain('0 秒')
    expect(noSeconds).not.toContain('时长')
    expect(noSeconds).toContain('导入')
  })

  it('一段都没读出来(模型整段自由发挥)→ 每一段如实说「这一段没有」,不把废话当成结论', () => {
    const empty = parseMeetingReply('这次会议大家都很积极,讨论了很多事情。', SAMPLE)
    expect(empty.solved).toEqual([])
    expect(empty.topics).toEqual([])
    expect(empty.keep).toEqual([])
    expect(empty.todos).toEqual([])
    const md2 = renderNotesMd({ title: '会', date: '2026-10-13', startedAt: '2026-10-13T02:00:00.000Z', seconds: 60, parsed: empty })
    expect(md2).toContain('这一段没有')
  })
})
