/**
 * ★ **家名那一池每通电话现取**(2026-10-03,卡 C;审计 `docs/审计材料/2026-10-03/devices.md` 附证 C)。
 *
 * 现场:`main.ts` 那个 while 循环**一圈是一次进房**,不是一通电话。工人进了房就一直在
 * (常驻,挂断不关会话),于是启动之后登记表里新发现的那一家(她刚装了 Grok Bot、
 * 登记表更新了)要等到**工人断房重连**才认得出 —— 上一张卡那段注释写的「下一轮电话就认得出」
 * 与控制流不符。
 *
 * 这一条钉的是**那一池什么时候换**,不是认名字的判据(那一半在 `family-pool.test.ts`):
 * ① 两通电话之间多了一家 → 第二通认得出(第一通认不出,这是它该有的样子);
 * ② 拉失败 → **沿用上一份**(不是退回自带兜底),日志里说清沿用的是哪一份;
 * ③ 第一次就拉不到 → 那一份就是自带兜底,也说清;
 * ④ 一行坏了不清空整池(形状容错仍在 `setFamilyPool` 那一处);
 * ⑤ 「每通电话开始」那个入口真的会去拉:两通电话 = 两次拉。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  FALLBACK_FAMILIES,
  applyFamilyPool,
  familyPool,
  familyPoolSource,
  matchSpokenFamily,
  setFamilyPool,
} from '../src/agentName.ts'

afterEach(() => setFamilyPool(undefined))

const SRC = join(import.meta.dirname, '..', 'src')

function source(file: string): string {
  return readFileSync(join(SRC, file), 'utf8')
}

/** 第一通那会儿工作台认得出的几家。 */
const BEFORE = [
  { id: 'claude', title: 'Claude', aliases: ['克劳德'] },
  { id: 'codex', title: 'Codex', aliases: ['ChatGPT'] },
]
/** 她装完 Grok Bot、登记表更新之后的那几家(家名就是包标识 —— 知识表里压根没有)。 */
const AFTER = [...BEFORE, { id: 'com.anysphere.sand', title: 'Grok Bot' }]

describe('★ 每通电话开始前拉一次', () => {
  it('★ 两通电话之间登记表多一家 → 第二通认得出(不用等工人重连)', () => {
    applyFamilyPool({ ok: true, families: BEFORE })
    expect(matchSpokenFamily('让 Grok Bot 看一眼').kind).toBe('none')

    // ——— 她装了一家,登记表更新了。工人一直在房里,没断过 ———
    applyFamilyPool({ ok: true, families: AFTER })
    expect(matchSpokenFamily('让 Grok Bot 看一眼')).toMatchObject({ kind: 'one', id: 'com.anysphere.sand' })
    expect(familyPoolSource()).toBe('workbench')
  })

  it('★ 拉不到就沿用上一份,日志说清沿用的是工作台那一份', () => {
    applyFamilyPool({ ok: true, families: AFTER })
    const line = applyFamilyPool({ ok: false, note: '这会儿连不上工作台,问不到这台电脑上认得出哪几家。' })
    // 整池没被清掉:刚装的那一家仍然认得出(退回自带兜底会把她装的那几家弄丢)。
    expect(matchSpokenFamily('让 Grok Bot 看一眼')).toMatchObject({ kind: 'one', id: 'com.anysphere.sand' })
    expect(familyPoolSource()).toBe('workbench')
    expect(line).toContain('沿用')
    expect(line).toContain('工作台')
    expect(line).toContain('连不上工作台')
  })

  it('★ 第一次就拉不到:那一份是自带兜底,也要说清是哪一份', () => {
    const line = applyFamilyPool({ ok: false, note: '这份工作台还没有「有哪几家」这条接口(是旧版)。' })
    expect(familyPoolSource()).toBe('fallback')
    expect(familyPool()).toEqual(FALLBACK_FAMILIES)
    expect(line).toContain('自带')
    expect(line).toContain('旧版')
  })

  it('拉到了那一行说的是「来自工作台」与几家', () => {
    const line = applyFamilyPool({ ok: true, families: AFTER })
    expect(line).toContain('来自工作台')
    expect(line).toContain(`${AFTER.length} 家`)
  })

  it('一行坏了只丢那一行,整池空就当没拉到(沿用上一份)', () => {
    applyFamilyPool({ ok: true, families: AFTER })
    applyFamilyPool({ ok: true, families: [{ id: 'claude', title: 'Claude' }, { title: '没 id' }] })
    expect(familyPool()).toEqual([{ id: 'claude', title: 'Claude' }])
    // 回包里一行都认不出来 = 没拉到:沿用上一份,不许把整池清成一家都没有。
    const line = applyFamilyPool({ ok: true, families: [{ title: '没 id' }] })
    expect(familyPool()).toEqual([{ id: 'claude', title: 'Claude' }])
    expect(line).toContain('沿用')
  })
})

describe('★ 「这一通开始了」那个入口真的会去拉', () => {
  /**
   * `agent.ts` 的 `refreshSelfBrief()` 就是「一通电话开始了」那一处(来电接起与提机两条路
   * 各调它一次)。这里用**同一种接法**(把 `workbench.families` 换成假的)验那条线真的接上了:
   * 一通电话 = 一次拉。真进房那一层仓库里没有测试台(startChannelAgent 要 LiveKit),
   * 所以这一条验的是「每通一拉」这件事本身,不是 agent.ts 的那段接线。
   */
  it('两通电话 = 两次拉,第二通拿到的是新那一份', async () => {
    const pools = [BEFORE, AFTER]
    let calls = 0
    const families = async (): Promise<{ ok: true, families: readonly { id: string, title: string }[] }> => {
      const got = pools[Math.min(calls, pools.length - 1)] as readonly { id: string, title: string }[]
      calls += 1
      return { ok: true, families: got }
    }

    /** 一通电话开始:现取一次(= agent.ts 里 refreshSelfBrief 的那一步)。 */
    const callStarted = async (): Promise<string> => applyFamilyPool(await families())

    await callStarted()
    expect(matchSpokenFamily('让 Grok Bot 看一眼').kind).toBe('none')
    await callStarted()
    expect(matchSpokenFamily('让 Grok Bot 看一眼')).toMatchObject({ kind: 'one', id: 'com.anysphere.sand' })
    expect(calls).toBe(2)
  })

  /**
   * ★ 这张卡的病根**就是那一处接线接在了错的生命周期上**(接在「一次进房」上,
   * 而不是「一通电话」上),所以接线本身要有一条钉着。真进房那一层没有测试台,
   * 于是**直接读源码**比位置 —— 与 `agent-name-sync.test.ts` 读插件源码同一种办法。
   */
  it('★ 那一拉接在「这一通开始了」里面:在 refreshSelfBrief 的函数体内、session.start 之前', () => {
    const agent = source('agent.ts')
    const declared = agent.indexOf('async function refreshSelfBrief')
    const pulled = agent.indexOf('applyFamilyPool(await deps.workbench.families())')
    const started = agent.indexOf('await session.start(')
    expect(declared).toBeGreaterThan(-1)
    expect(pulled).toBeGreaterThan(declared)
    expect(started).toBeGreaterThan(pulled)
    // 「一通电话开始了」那两条路(来电接起、提机)各调它一次 —— 两处都在,这一拉才是每通一次。
    expect(agent.match(/await refreshSelfBrief\(\)/g)?.length).toBe(2)
  })

  it('★ 进房前那一次也还在(两处同一个处置,不是只剩一处)', () => {
    const main = source('main.ts')
    expect(main.indexOf('applyFamilyPool(await workbench.families())'))
      .toBeGreaterThan(main.indexOf('while (!stopping)'))
    // 旧那条「拉不到就退回自带兜底」的接法不许再留在这儿(它会把她装的那几家弄丢)。
    expect(main).not.toContain('setFamilyPool(')
  })
})
