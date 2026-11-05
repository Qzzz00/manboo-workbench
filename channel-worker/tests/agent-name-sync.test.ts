/**
 * ★ **两份别名表不许再漂**(2026-09-30,第 0 段止血 6)。
 *
 * 现场:2851e0b0 在插件那份(`workbench-plugin/src/server/spokenFamily.ts`)把「GPT / ChatGPT /
 * Chat GPT」认成 Codex、给豆包加了 `Doubao`,工人这份 `FALLBACK_FAMILIES` 却还留着单独一家 `gpt`
 * 带 `ChatGPT` —— 电话里说「让 ChatGPT 写」,插件认成 Codex、工人认成 GPT,**两头认成两家**。
 * 两份实现靠一句「逐字相同」的注释同步,没人跑得到,所以漂了没人知道。
 *
 * 这一份**直接读插件的源码**比对(顶层子目录互不 import,所以只能读文本)。
 *
 * ★ **2026-10-03(卡「两条接缝」;决策记录 10-03 早 ⑦)口径从「=」改成「⊆」**:
 * 候选池的主人定下来了 —— 插件的家族目录,由 `GET /families` 下发,工人每轮拉一份
 * (`setFamilyPool`)。工人这张 `FALLBACK_FAMILIES` 从此**只是拉不到时的退路**,
 * 所以它该钉的是「**不许比主人多、也不许与主人说法不同**」,而不是「一字不差地等于主人」:
 *   - 每一家的 id 必须是插件 `DISPATCH_FAMILY_TITLES` 里的一家,正名逐字相同;
 *   - 每一家的别名必须是插件 `FAMILY_ALIASES` 里那一条的**子集**(顺序照原表);
 *   - 主人那边新加一家,这边**不跟也不红** —— 拉得到的时候那一家自然在池里;
 *     拉不到的时候退路里没有它,是如实的「问不到工作台」,不是猜一家顶上。
 * 反过来:这边多出一家 / 多出一个别名 / 正名漂了 → 红。那正是 2851e0b0 那次漂的形状。
 *
 * **只钉数据**。两份实现行为上仍有故意不同的地方(各自的门面不同,不在这一条管):
 *   - 插件的候选是**本机真装的那几家 + 登记表里运行时发现的那几家**(`spokenFamilies()`);
 *     工人够不到 `~/.dsh`,拉不到那一份时才用这张退路表;
 *   - 插件多一个 `stripSpokenFamily`(认完家把家名从原话里切掉),工人多一个 `canonicalWho`
 *     (把听错的名字换成正名再送给 8791);
 *   - 判分那几个函数(`normalize` / `spokenWords` / `consonantKey` / `editDistance` /
 *     `spokenScore` / `matchSpokenFamily` / `SPOKEN_MIN_SCORE`)两边此刻逐字相同,
 *     由两边各自的用例 + `agent-name.test.ts` 末尾那组「两端同一组输入」钉着。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FALLBACK_FAMILIES, matchSpokenFamily } from '../src/agentName.ts'

const PLUGIN_DIR = join(import.meta.dirname, '..', '..', 'workbench-plugin', 'src')

function read(...parts: string[]): string {
  return readFileSync(join(PLUGIN_DIR, ...parts), 'utf8')
}

/** 取出 `名字 = {` 到那一层的 `}` 之间那一段,并把 `//` 注释去掉(注释里也有引号)。 */
function objectBody(source: string, marker: string): string {
  const at = source.indexOf(marker)
  expect(at, `插件源码里找不到 ${marker} —— 它改名了?这一条要跟着改`).toBeGreaterThanOrEqual(0)
  const start = source.indexOf('{', at)
  const end = source.indexOf('\n}', start)
  expect(end).toBeGreaterThan(start)
  return source.slice(start + 1, end)
    .split('\n')
    .map(line => line.replace(/^\s*\/[/*].*$/, '').replace(/^\s*\*.*$/, ''))
    .join('\n')
}

function quoted(list: string): readonly string[] {
  return [...list.matchAll(/'([^']*)'/g)].map(one => one[1] as string)
}

/** 插件 `protocol.ts` 的 `DISPATCH_FAMILY_TITLES`:家名 → 正名,**按源码里的顺序**。 */
function pluginTitles(): readonly (readonly [string, string])[] {
  const body = objectBody(read('protocol.ts'), 'DISPATCH_FAMILY_TITLES')
  return [...body.matchAll(/^\s*([A-Za-z0-9_]+):\s*'([^']*)'/gm)].map(one => [one[1] as string, one[2] as string])
}

/** 插件 `server/spokenFamily.ts` 的 `FAMILY_ALIASES`:家名 → 他还会怎么念它。 */
function pluginAliases(): Readonly<Record<string, readonly string[]>> {
  const body = objectBody(read('server', 'spokenFamily.ts'), 'FAMILY_ALIASES')
  const out: Record<string, readonly string[]> = {}
  for (const hit of body.matchAll(/^\s*([A-Za-z0-9_]+):\s*\[([^\]]*)\]/gm)) out[hit[1] as string] = quoted(hit[2] as string)
  return out
}

describe('★ 家名候选池:插件那份是主人,工人这份只是拉不到时的退路(⊆)', () => {
  it('读得到插件那两张表(扫描本身没坏)', () => {
    const titles = pluginTitles()
    expect(titles.length).toBeGreaterThanOrEqual(5)
    expect(titles.map(one => one[0])).toContain('codex')
    const aliases = pluginAliases()
    expect(Object.keys(aliases).length).toBeGreaterThanOrEqual(4)
    expect(aliases.claude).toEqual(['克劳德'])
  })

  it('★ 兜底那份的每一家都是主人那份里的一家,正名逐字相同(⊆,不许多出一家、不许漂)', () => {
    const titles = new Map(pluginTitles())
    for (const one of FALLBACK_FAMILIES) {
      expect(
        titles.has(one.id),
        `工人兜底表里的 ${one.id} 不在插件 protocol.ts 的 DISPATCH_FAMILY_TITLES 里 —— 兜底只许是主人那份的子集`,
      ).toBe(true)
      expect(
        one.title,
        `${one.id} 的正名与插件 DISPATCH_FAMILY_TITLES 漂了 —— 插件那份是主人,改它再把这边改成一样的`,
      ).toBe(titles.get(one.id))
    }
    // 顺序照主人那张表(拉不到时念候选的先后与电脑上一致)。
    const mine = FALLBACK_FAMILIES.map(one => one.id)
    expect(mine, '兜底表的顺序与主人那张表不一致').toEqual([...titles.keys()].filter(id => mine.includes(id)))
  })

  it('★ 每一家的别名是主人那一条的子集(2851e0b0 漂的正是这一格:ChatGPT / GPT 归 Codex)', () => {
    const aliases = pluginAliases()
    for (const one of FALLBACK_FAMILIES) {
      const mine = [...(one.aliases ?? [])]
      if (mine.length === 0) continue
      const owner = aliases[one.id] ?? []
      expect(
        mine.filter(alias => !owner.includes(alias)),
        [
          `工人兜底表里 ${one.id} 的别名有主人那份没有的:插件 server/spokenFamily.ts 的 FAMILY_ALIASES 是主人。`,
          '改主人那一处,再把 channel-worker/src/agentName.ts 的 FALLBACK_FAMILIES 收成它的子集。',
        ].join('\n'),
      ).toEqual([])
      // 顺序也照主人那一条(同一个输入两端并列时念的先后一致)。
      expect(mine, `${one.id} 的别名顺序与主人那一条不一致`).toEqual(owner.filter(alias => mine.includes(alias)))
    }
  })

  it('★ 电话里说「ChatGPT / GPT」不再是单独一家:认成 Codex,或者(两家都在时)问一句', () => {
    // 两家都在退路表里 → 并列,问一句是哪一个(与插件同一份数据下的答案相同)。
    const both = matchSpokenFamily('让 ChatGPT 帮我写一段')
    expect(both.kind).toBe('many')
    if (both.kind === 'many') expect(both.families.map(one => one.id).sort()).toEqual(['codex', 'gpt'])
    // 这台机器上没有「只走接口」那一家时(登记表里只有 Codex),直接就是 Codex。
    const onlyCodex = FALLBACK_FAMILIES.filter(one => one.id !== 'gpt')
    expect(matchSpokenFamily('让 ChatGPT 帮我写一段', onlyCodex)).toMatchObject({ kind: 'one', id: 'codex' })
    expect(matchSpokenFamily('让 Chat GPT 帮我写一段', onlyCodex)).toMatchObject({ kind: 'one', id: 'codex' })
  })

  it('★ 「Doubao」(坞上那个英文名)也认得出是豆包这一家', () => {
    expect(matchSpokenFamily('让 Doubao 看一眼')).toMatchObject({ kind: 'one', id: 'doubao' })
  })
})
