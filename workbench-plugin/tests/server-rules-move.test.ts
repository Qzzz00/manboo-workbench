// @vitest-environment node
/**
 * 规矩表先后可调(2026-10-23,卡「分层第二刀一」第三条;审计 P2:她追加的固定分工排在旧分工后面被盖住)。
 *
 * `divisionOf` 按表序取第一条读得出的分工 —— 后加的那条只有排在前面才生效。这张卡给规矩表加
 * 「上移 / 下移」,让排先后来得及;用例钉「后加的放前面就生效」。
 *
 * 钉这几件:
 *   ① 后加的分工规则盖不住旧的;上移一条之后生效(匹配按表序);
 *   ② 设置里那张表的顺序跟着变(同一块内);
 *   ③ 边界:已经在最前 / 最后,如实说不动;撤下的规矩不占位;
 *   ④ 落盘读回顺序还在;挪完同步 AGENTS.md 那一段。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { divisionOf } from '../src/server/dispatchChoice.ts'
import { createRulesService } from '../src/server/rules.ts'

const dirs: string[] = []
function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-rules-move-'))
  dirs.push(dir)
  return dir
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) })

function service() {
  const applied: string[] = []
  const rules = createRulesService({
    file: join(tmpDir(), 'rules.json'),
    agents: { apply: async (body) => { applied.push(body); return { ok: true } }, revert: async () => ({ ok: true }) },
  })
  return { rules, applied }
}

const OLD_DIVISION = '派活默认分工:写代码的活派 Claude。问他派给谁时,这几家都要列成选项,默认项按这个分工选;他点名了就听他的。'
const NEW_DIVISION = '派活默认分工:写代码的活派 Codex。问他派给谁时,这几家都要列成选项,默认项按这个分工选;他点名了就听他的。'

/** 像 10-03 那台机器一样:rules.json 里旧分工在前、新分工追加在后(直接种文件,不经 add —— add 会把同一处的两条并成一条)。 */
async function seeded() {
  const dir = tmpDir()
  const file = join(dir, 'rules.json')
  const stored = (id: string, text: string, created_at: string) => ({
    id, text, title: '派活默认分工', area: 'all', status: 'active', origin: 'said',
    evidence: [{ channel: 'settings', at: created_at, text }], created_at, updated_at: created_at,
  })
  const { writeFileSync } = await import('node:fs')
  writeFileSync(file, JSON.stringify({
    version: 1,
    rules: [stored('rule:old-division', OLD_DIVISION, '2026-09-25T12:00:00.000Z'), stored('rule:new-division', NEW_DIVISION, '2026-10-03T12:00:00.000Z')],
    events: [],
    reviews: [],
  }), 'utf8')
  const applied: string[] = []
  const rules = createRulesService({
    file,
    agents: { apply: async (body) => { applied.push(body); return { ok: true } }, revert: async () => ({ ok: true }) },
  })
  await rules.load()
  return { rules, applied }
}

/** 混合种入(照统筹 P2 复现的形状):规矩原文自带归类字眼,area/status 直接写死。 */
async function seededMixed(entries: { id: string, text: string, area: string, status?: string }[]) {
  const dir = tmpDir()
  const file = join(dir, 'rules.json')
  const { writeFileSync } = await import('node:fs')
  writeFileSync(file, JSON.stringify({
    version: 1,
    rules: entries.map((one, index) => ({
      id: one.id, text: one.text, title: one.text, area: one.area, status: one.status ?? 'active', origin: 'said',
      evidence: [], created_at: `2026-10-23T0${index + 1}:00:00.000Z`, updated_at: `2026-10-23T0${index + 1}:00:00.000Z`,
    })),
    events: [],
    reviews: [],
  }), 'utf8')
  const rules = createRulesService({ file, agents: { apply: async () => ({ ok: true }), revert: async () => ({ ok: true }) } })
  await rules.load()
  return rules
}

describe('规矩表先后可调', () => {
  it('① 后加的分工盖不住旧的(审计 P2 复现);上移之后生效(匹配按表序)', async () => {
    const { rules } = await seeded()
    // 现状:两条都读得出时取表序在前的一条 —— 旧的赢。
    expect(divisionOf(rules.counting())?.code).toBe('claude')
    const moved = await rules.move('rule:new-division', 'up')
    expect(moved.ok).toBe(true)
    expect(divisionOf(rules.counting())?.code).toBe('codex')
    // 移回下面,旧的那条重新生效 —— 先后就是开关。
    await rules.move('rule:new-division', 'down')
    expect(divisionOf(rules.counting())?.code).toBe('claude')
  })

  it('② 设置里那张表的顺序跟着变(同一块内)', async () => {
    const { rules } = service()
    await rules.load()
    await rules.add({ text: '不要蓝(球的「完成」色也不要)', channel: 'settings' })
    await rules.add({ text: '只做深色', channel: 'settings' })
    const ids = () => rules.view().rules.map(one => one.title)
    expect(ids()).toEqual(['不要蓝', '只做深色'])
    const dark = rules.view().rules.find(one => one.title === '只做深色')
    await rules.move(dark?.id as string, 'up')
    expect(ids()).toEqual(['只做深色', '不要蓝'])
  })

  it('③ 边界:已经在最前 / 最后,如实说不动', async () => {
    const { rules } = service()
    await rules.load()
    await rules.add({ text: '不要蓝', channel: 'settings' })
    const only = rules.view().rules[0]
    expect((await rules.move(only?.id as string, 'up')).ok).toBe(false)
    expect((await rules.move(only?.id as string, 'down')).ok).toBe(false)
    expect((await rules.move('rule:没有这条', 'up')).ok).toBe(false)
  })

  it('⑤ 统筹 P2 复现:同块邻居隔着别的块 —— 上移找**同块**相邻项,可见顺序真变', async () => {
    // 种入:ui-old / say-between / ui-new(数组这个顺序)。
    const rules = await seededMixed([
      { id: 'rule:ui-old', text: '界面旧规矩', area: 'ui' },
      { id: 'rule:say-between', text: '说话中间规矩', area: 'say' },
      { id: 'rule:ui-new', text: '界面新规矩', area: 'ui' },
    ])
    const view = () => rules.view().rules.map(one => one.title)
    expect(view()).toEqual(['说话中间规矩', '界面旧规矩', '界面新规矩'])
    // 旧行为:与数组相邻的 say-between 换,view 纹丝不动;修后:与同块的 ui-old 换。
    const moved = await rules.move('rule:ui-new', 'up')
    expect(moved.ok).toBe(true)
    expect(view()).toEqual(['说话中间规矩', '界面新规矩', '界面旧规矩'])
    // 再点上移:同块上面没有了 → 如实不动。
    expect((await rules.move('rule:ui-new', 'up')).ok).toBe(false)
    expect(view()).toEqual(['说话中间规矩', '界面新规矩', '界面旧规矩'])
  })

  it('⑤′ 试用沉底也是同块判据:上移跨过生效的,落在同块相邻项上;试用的上面没有同块就不动', async () => {
    const rules = await seededMixed([
      { id: 'rule:ui-a', text: '界面规矩甲', area: 'ui' },
      { id: 'rule:ui-trial', text: '界面试用的', area: 'ui', status: 'trial' },
      { id: 'rule:ui-b', text: '界面规矩乙', area: 'ui' },
    ])
    const view = () => rules.view().rules.map(one => one.title)
    expect(view()).toEqual(['界面规矩甲', '界面规矩乙', '界面试用的'])
    // 乙 上移到甲前面(跳过试用那条 —— 不是同块):可见顺序真变。
    expect((await rules.move('rule:ui-b', 'up')).ok).toBe(true)
    expect(view()).toEqual(['界面规矩乙', '界面规矩甲', '界面试用的'])
    // 试用那条上移到乙前面(同块 = trial 那一组里没有比它更靠上的):先与…… 同块相邻不存在 → 不动。
    expect((await rules.move('rule:ui-trial', 'up')).ok).toBe(false)
    expect(view()).toEqual(['界面规矩乙', '界面规矩甲', '界面试用的'])
  })

  it('③′ 撤下的规矩不占位:上移跳过撤下的,落在还算数的那一条上', async () => {
    const { rules } = service()
    await rules.load()
    await rules.add({ text: '不要蓝', channel: 'settings' })
    await rules.add({ text: '只做深色', channel: 'settings' })
    await rules.add({ text: '不留卡片框', channel: 'settings' })
    const dark = rules.view().rules.find(one => one.title === '只做深色')
    const frame = rules.view().rules.find(one => one.title === '不留卡片框')
    await rules.remove(dark?.id as string)
    await rules.move(frame?.id as string, 'up')
    expect(rules.view().rules.map(one => one.title)).toEqual(['不留卡片框', '不要蓝'])
  })

  it('④ 落盘读回顺序还在;挪完同步 AGENTS.md 那一段', async () => {
    const dir = tmpDir()
    const file = join(dir, 'rules.json')
    const applied: string[] = []
    const rules = createRulesService({
      file,
      agents: { apply: async (body) => { applied.push(body); return { ok: true } }, revert: async () => ({ ok: true }) },
    })
    await rules.load()
    await rules.add({ text: '不要蓝', channel: 'settings' })
    await rules.add({ text: '只做深色', channel: 'settings' })
    const dark = rules.view().rules.find(one => one.title === '只做深色')
    await rules.move(dark?.id as string, 'up')
    expect(applied.length).toBeGreaterThan(0)
    expect(applied[applied.length - 1]).toContain('只做深色')

    const again = createRulesService({ file, agents: { apply: async () => ({ ok: true }), revert: async () => ({ ok: true }) } })
    await again.load()
    expect(again.view().rules.map(one => one.title)).toEqual(['只做深色', '不要蓝'])
  })
})
