/**
 * 回归集打分(设计第七节):只给「指哪张 / 做什么」打分,与回话质量分开。
 *
 * - 对:期望的每条命令都有一条对得上,且没有多出来的「动手」命令(ask / chat 不算动手);
 * - 过度:期望的都对上了,另外还多动了手(多建、多派、多改名、多发反馈);
 * - 不足:少了期望的命令,也没乱动手(只聊了 / 少办了几件);
 * - 模糊:该动手却只问了一句(ask)—— 用例标了 `ask_ok` 的,问一句算对;
 * - 错:少了期望的、又动了别的手(改派落成改名、派活落成反馈)= 不足 + 过度,单列出来。
 */
export interface Expect {
  name: string
  card_id?: string
  /** 手:手的 id(家名或名片 id)。 */
  /** 给了字符串 = 必须派给这只手;null = 必须不给 to(执行层挑手);不写 = 不看。 */
  to?: string | null
  goal_id?: string
  status?: string
  /** 新活:必须建新卡(不许挂到板上已有的卡上)。 */
  fresh?: boolean
}

export interface Case {
  /** 回归集那一行(日期时间)。 */
  row: string
  entrance: 'desktop' | 'call' | 'phone'
  said: string
  /** 原话缺(「?」行)按梗概写的。 */
  synopsis?: boolean
  /** 这一句之前的话(say 账;按顺序)。 */
  says?: readonly { said: string, commands: readonly string[], cards: readonly string[], minutesAgo: number }[]
  /** 这一句之后才建出来的卡:这条用例的板上藏掉。 */
  hide?: readonly string[]
  /** 这条用例的板上多出来的卡(那一刻板上才有的)。 */
  add?: readonly { id: string, title: string, status: string, assignee?: string, minutesAgo: number }[]
  /** 这条用例里目标当时的状态。 */
  goalStatus?: readonly { id: string, status: string }[]
  /** 当时那张卡的标题(被改错之前 / 之后)。 */
  patch?: readonly { id: string, title: string }[]
  /** 点名的文件(仓库里的相对路径):读开头一段放进上下文包。 */
  files?: readonly string[]
  /** 期望:任一组整组对上即可(多组 = 可接受的几种办法)。 */
  expect: readonly (readonly Expect[])[]
  /** 这句本来就该问(问一句算对)。 */
  ask_ok?: boolean
  /** 允许顺带出现、不算过度的命令名(如改派时顺带 move_status)。 */
  allow?: readonly string[]
}

export type Grade = '对' | '过度' | '不足' | '模糊' | '错'

interface Got { name: string, card_id?: string, to?: string, goal_id?: string, status?: string }

const PASSIVE = new Set(['ask', 'chat'])

function matches(want: Expect, got: Got): boolean {
  if (want.name !== got.name) return false
  if (want.card_id !== undefined && want.card_id !== got.card_id) return false
  if (want.fresh === true && got.card_id !== undefined) return false
  if (want.to === null && got.to !== undefined) return false
  if (typeof want.to === 'string' && want.to !== got.to) return false
  if (want.goal_id !== undefined && want.goal_id !== got.goal_id) return false
  if (want.status !== undefined && want.status !== got.status) return false
  return true
}

function gradeOne(expect: readonly Expect[], got: readonly Got[], allow: ReadonlySet<string>): { grade: Grade, missing: number, extra: number } {
  const used = new Set<number>()
  let missing = 0
  for (const want of expect) {
    const i = got.findIndex((one, index) => !used.has(index) && matches(want, one))
    if (i < 0) missing += 1
    else used.add(i)
  }
  const extra = got.filter((one, index) => !used.has(index) && !PASSIVE.has(one.name) && !allow.has(one.name)).length
  const grade: Grade = missing === 0 ? (extra === 0 ? '对' : '过度') : (extra > 0 ? '错' : got.some(one => one.name === 'ask') ? '模糊' : '不足')
  return { grade, missing, extra }
}

const RANK: Record<Grade, number> = { 对: 0, 过度: 1, 模糊: 2, 不足: 3, 错: 4 }

/** 几组可接受的办法取最好的那一组。 */
export function grade(c: Pick<Case, 'expect' | 'ask_ok' | 'allow'>, got: readonly Got[]): Grade {
  if (c.ask_ok === true && got.length > 0 && got.every(one => PASSIVE.has(one.name)) && got.some(one => one.name === 'ask')) return '对'
  const allow = new Set(c.allow ?? [])
  return c.expect.map(one => gradeOne(one, got, allow).grade).sort((a, b) => RANK[a] - RANK[b])[0] ?? '不足'
}
