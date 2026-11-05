/**
 * **显示只看本机探测,不写死任何一家**(2026-09-27,卡 HC)。
 *
 * 现场:维护者的全新 MacBook Air 上只装了「豆包办公」与「Codex」,诊断包里 `/state.agents`
 * 却是 `[dsh, claude(connected:false), codex, kimi]` —— 写死的四家;常用应用只认出 Codex,
 * 豆包办公一处都没认出来。原话:
 * 「顶部栏也是一样,现在还是有 claude 和 kimi,你要全面检查一遍,每一个人电脑装的东西都不一样,
 * 千万不能写死,豆包办公还认不出来呢」。
 *
 * 这一份钉三件事:
 * 1. **只装豆包办公 + Codex 的机器**:探测只报这两家;界面那几处只剩这两家 + 事务官;
 * 2. **一家都没装的机器**:主界面不出现任何别家(只剩事务官);
 * 3. **探不出来**(Spotlight 关了 / mdfind 不在):一个都不筛,退回这一版之前的行为
 *    —— D13「查不到」不许冒充「没有」。
 */
import { describe, expect, it } from 'vitest'
import { AGENT_IDS } from '../src/protocol.ts'
import {
  AGENT_APP_CANDIDATES, KNOWN_APP_CANDIDATES, candidatesWith, createInstalledAgentScan, shownAgentIds,
} from '../src/server/installedAgents.ts'
import { ANTIGRAVITY_BUNDLE_ID } from '../src/quota/antigravityNative.ts'
import { readFile } from 'node:fs/promises'
import {
  FAMILY_SOURCES, appBundleNameOf, bundleForEntry, bundleIdsOf, openCommandFor, pickFamilyPackage,
} from '../src/server/agentSources.ts'
import { APP_BUNDLES } from '../src/server/activation.ts'
import { APP_COMMANDS } from '../src/server/apps.ts'
import { BASE_APP_LABELS, createAppsRegistry } from '../src/server/appsRegistry.ts'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 豆包办公在维护者**旧机器**上的身份(本机读 `/Applications/Doubao.app/Contents/Info.plist` 读出来的)。 */
const DOUBAO_BUNDLE = 'com.bot.pc.doubao'

/**
 * 豆包办公在**新 MacBook Air** 上的身份(坞上写「豆包工作」)。两个包标识都是真机读出来的,
 * 同一家(`doubao`)在不同机器上装的是**不同的那一个**(卡 CF 的 `packages`)。
 *
 * ★ 2026-09-30(止血 6):这一份原来只用旧机器那个包跑一遍,于是
 * 「Air 上只有 `com.work.pc.doubao`」这种真机情形**一次都没跑过** —— 而 Air 正是出问题的那台。
 * 下面「只装了豆包办公 + Codex 的那台机器」两台都跑一遍。
 */
const DOUBAO_AIR_BUNDLE = 'com.work.pc.doubao'

/** 两台真机:名字只用来让用例名读得出是哪一台。 */
const DOUBAO_MACHINES: readonly (readonly [string, string])[] = [
  ['维护者旧机器', DOUBAO_BUNDLE],
  ['新 MacBook Air', DOUBAO_AIR_BUNDLE],
]

/**
 * 假 `mdfind`:只有 `installed` 里那几个包标识找得到。
 * `broken: true` 模拟「Spotlight 关了」—— 每一条都 `ok:false`。
 */
function fakeIo(installed: readonly string[], broken = false) {
  return {
    exec: async (cmd: readonly string[]) => {
      if (broken) return { ok: false, code: 127, out: '', err: 'mdfind: command not found' }
      const query = cmd.join(' ')
      const hit = installed.find(bundle => query.includes(`'${bundle}'`))
      return { ok: true, code: 0, out: hit === undefined ? '' : '/Applications/Fake.app', err: '' }
    },
  }
}

async function tmpAppsFile(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'hc-apps-')), 'apps.json')
}

describe('候选表从知识表长出来,不另写一张家名表', () => {
  it('★写过专门读法的候选 = FAMILY_SOURCES 里带包标识的每一条(新写一家自动进来)', () => {
    const expected = FAMILY_SOURCES.filter(one => one.bundle_id !== undefined).map(one => one.agent)
    /*
     * ★ 2026-09-28(卡 CF):**一家可以有几个已知包标识**(豆包办公在维护者旧机器上是
     * `com.bot.pc.doubao`、在新 Air 上是 `com.work.pc.doubao`),候选里每个包标识一条 ——
     * 家名(`id`)去重之后仍然与知识表**逐一对应**,这一条钉的还是「不另写一张家名表」。
     */
    expect([...new Set(AGENT_APP_CANDIDATES.map(one => one.id))]).toEqual(expected)
    // 每一条候选的包标识都必须真写在知识表上的那一家身上(不许凭空多一个)。
    for (const one of AGENT_APP_CANDIDATES) {
      const binding = FAMILY_SOURCES.find(family => family.agent === one.id)
      expect(bundleIdsOf(binding)).toContain(one.bundle_id)
    }
    // 事务官自己没有 App、GPT 只有接口那只手 —— 两条都不该在候选里。
    expect(AGENT_APP_CANDIDATES.map(one => one.id)).not.toContain('dsh')
    expect(AGENT_APP_CANDIDATES.map(one => one.id)).not.toContain('gpt')
  })

  /**
   * ★ 2026-09-27 晚的回归守门:**有读法的家必须有包标识**。
   *
   * 真机 `installed_agents` 漏了两家,根子就是「这一家我们写了代码、却没人记下它的包标识」。
   * 没包标识 = 探不到 = 在「本机有哪几家」里隐身。只有两种家可以没有:
   * 事务官自己(`self`,没有 App)、只走接口连 App 都没有的(`api` 且 `noWindow`,今天是 GPT)。
   */
  it('★守门:FAMILY_SOURCES 里每一条都有包标识,除了事务官自己与只走接口的那一家', () => {
    const missing = FAMILY_SOURCES
      .filter(one => one.bundle_id === undefined || one.bundle_id === '')
      .filter(one => one.self !== true && !(one.api === true && one.noWindow === true))
      .map(one => one.agent)
    expect(missing).toEqual([])
  })

  it('★豆包办公认得出:候选里有它,包标识与名字都对得上', () => {
    const doubao = AGENT_APP_CANDIDATES.find(one => one.id === 'doubao')
    expect(doubao).toEqual({ id: 'doubao', bundle_id: DOUBAO_BUNDLE, name: '豆包办公' })
    // 换算表三处都认得它(坞与窗位清单靠包标识、拉起靠命令、界面靠名字)。
    expect(APP_BUNDLES.doubao).toBe(DOUBAO_BUNDLE)
    // 2026-09-28:拉起一律按包标识(显示名在别人机器上不一样);名字只给「stat 一下 .app 在不在」那条退路用。
    expect(APP_COMMANDS.doubao).toEqual(['open', '-b', DOUBAO_BUNDLE])
    expect(BASE_APP_LABELS.doubao).toBe('豆包办公')
    // 探测整个跑不起来时那条退路认的也是同一个名字,不再写第三份显示名表。
    expect(appBundleNameOf('doubao')).toBe('Doubao')
  })
})

describe.each(DOUBAO_MACHINES)('只装了豆包办公 + Codex 的那台机器(%s)', (_machine, doubaoBundle) => {
  const installed = [doubaoBundle, 'com.openai.codex']

  it('★探测只报这两家', async () => {
    // now() 是**毫秒**(生产上 Date.now())—— 头一版这一条自己把「按秒又乘 1000」那个 bug 钉住了。
    const ms = 1_700_000_000_000
    const scan = createInstalledAgentScan({ io: fakeIo(installed), now: () => ms })
    const view = await scan.scan()
    expect(view?.agents.map(one => one.id)).toEqual(['codex', 'doubao'])
    expect([...(scan.installedIds() ?? [])].sort()).toEqual(['codex', 'doubao'])
    // 这一份要说得出「几点探到的」。
    expect(view?.at).toBe(new Date(ms).toISOString())
  })

  it('★顶栏 / 会话那一排 / 额度里只剩 Codex 与事务官 —— Claude 与 Kimi 不出现', async () => {
    const scan = createInstalledAgentScan({ io: fakeIo(installed), now: () => 1 })
    await scan.scan()
    // AGENT_IDS 是「有会话流的那几家」,豆包办公没有会话流,所以这一排里只剩 dsh + codex。
    expect(shownAgentIds(AGENT_IDS, scan.installedIds())).toEqual(['dsh', 'codex'])
  })

  it('★窗口槽 / 常用应用认得出豆包办公,同时不列没装的 Claude 与 Kimi', async () => {
    const scan = createInstalledAgentScan({ io: fakeIo(installed), now: () => 1 })
    await scan.scan()
    const registry = createAppsRegistry({
      file: await tmpAppsFile(),
      runOsascript: async () => ({ ok: false, stdout: '' }),
      installedKeys: () => scan.installedIds(),
    })
    const keys = (await registry.list()).map(one => one.key)
    expect(keys).toContain('doubao')
    expect(keys).toContain('codex')
    expect(keys).not.toContain('claude')
    expect(keys).not.toContain('kimi')
    expect(keys).not.toContain('muse')
    expect(keys).not.toContain('manus')
    // 系统自带的两个不受探测管(Spotlight 抽风不该把「终端」弄丢)。
    expect(keys).toContain('term')
    expect(keys).toContain('calendar')
  })
})

/**
 * ★ **Air 上那台:装着的豆包是 `com.work.pc.doubao`,「家 → 包」却总回主包**(2026-09-30,止血 6)。
 *
 * 这一组把根子 1 的现象钉在用例里:对的只有 `pickFamilyPackage`(派活送出去那一下问的就是它),
 * 别的几处换算(`bundleForEntry` / `openCommandFor` 不带包标识 / `APP_BUNDLES` / `APP_COMMANDS`)
 * **一律回知识表的主包** —— 在只装了 `com.work` 的机器上就是「打不开、清不掉小点、读不到额度」。
 *
 * 红的那几条标了 `it.fails`,修它们是**第 1 段 A 应用身份**(一份家族目录 + 一个解析器,
 * 「家 → 包」只许从那里出),不是这张止血卡的活。修好之后这几条会「不该过却过了」而变红 —— 那时把
 * `it.fails` 改回 `it`。
 */
describe('★ Air 上那台:同一家装的是另一个包', () => {
  const airInstalled = [{ bundle_id: DOUBAO_AIR_BUNDLE }]

  it('对的那一处:派活挑包问 pickFamilyPackage,它认得这台上装的是哪一个', () => {
    expect(pickFamilyPackage({ family: 'doubao', installed: airInstalled }))
      .toEqual({ bundle_id: DOUBAO_AIR_BUNDLE, name: '豆包工作', why: 'only' })
    // 她说「豆包办公 / 豆包工作」时,两个都装着也挑得对。
    expect(pickFamilyPackage({
      family: 'doubao',
      said: '让豆包办公看一眼',
      installed: [{ bundle_id: DOUBAO_BUNDLE }, { bundle_id: DOUBAO_AIR_BUNDLE }],
    })).toMatchObject({ bundle_id: DOUBAO_AIR_BUNDLE, why: 'said' })
  })

  it('知道几个包都算这一家(候选与归属这一向是对的;2026-10-01 加了 Mac App Store 版)', () => {
    expect(bundleIdsOf(FAMILY_SOURCES.find(one => one.agent === 'doubao'))).toEqual([DOUBAO_BUNDLE, DOUBAO_AIR_BUNDLE, 'com.bot.neotix.doubao'])
    expect(AGENT_APP_CANDIDATES.filter(one => one.id === 'doubao').map(one => one.bundle_id))
      .toEqual([DOUBAO_BUNDLE, DOUBAO_AIR_BUNDLE, 'com.bot.neotix.doubao'])
  })

  // 第 1 段 A 应用身份修:`bundleForEntry` 不知道这台上装的是哪一个,永远回主包。
  it.fails('★家名 → 包:这台上装着的是 com.work,bundleForEntry 该给它', () => {
    expect(bundleForEntry('doubao')).toBe(DOUBAO_AIR_BUNDLE)
  })

  // 第 1 段 A 应用身份修:`openCommandFor` 不带包标识时同样回主包 —— 这台上 `open -b` 的是没装的那个。
  it.fails('★拉起:openCommandFor 不带包标识时该开这台上装着的那个', () => {
    expect(openCommandFor('doubao')).toEqual(['open', '-b', DOUBAO_AIR_BUNDLE])
  })

  // 第 1 段 A 应用身份修:两张换算表是模块级常量,压根没有「这台机器装了什么」这一说。
  it.fails('★坞位 / 拉起两张换算表也该是这台上那个包', () => {
    expect(APP_BUNDLES.doubao).toBe(DOUBAO_AIR_BUNDLE)
    expect(APP_COMMANDS.doubao).toEqual(['open', '-b', DOUBAO_AIR_BUNDLE])
  })

  it('★传了包标识那一路是通的(第 1 段 A 之前,调用方自己挑好包再传进来就对)', () => {
    const picked = pickFamilyPackage({ family: 'doubao', installed: airInstalled })
    expect(openCommandFor('doubao', picked?.bundle_id)).toEqual(['open', '-b', DOUBAO_AIR_BUNDLE])
  })
})

describe('一家都没装的那台机器', () => {
  it('★主界面不出现任何别家:只剩事务官', async () => {
    const scan = createInstalledAgentScan({ io: fakeIo([]), now: () => 1 })
    const view = await scan.scan()
    expect(view?.agents).toEqual([])
    expect(shownAgentIds(AGENT_IDS, scan.installedIds())).toEqual(['dsh'])
  })

  it('★窗位清单里一家 AI 都没有(微信 / 企微同理),系统自带的两个还在', async () => {
    const scan = createInstalledAgentScan({ io: fakeIo([]), now: () => 1 })
    await scan.scan()
    const registry = createAppsRegistry({
      file: await tmpAppsFile(),
      runOsascript: async () => ({ ok: false, stdout: '' }),
      installedKeys: () => scan.installedIds(),
    })
    expect((await registry.list()).map(one => one.key)).toEqual(['term', 'calendar'])
  })
})

describe('★探不出来 ≠ 都没装(D13)', () => {
  it('mdfind 一条都没跑成 → 整格缺席,一个都不筛', async () => {
    const scan = createInstalledAgentScan({ io: fakeIo([DOUBAO_BUNDLE], true), now: () => 1 })
    expect(await scan.scan()).toBeUndefined()
    expect(scan.installedIds()).toBeUndefined()
    // 没探出来时退回这一版之前的行为:四家照旧全在。
    expect(shownAgentIds(AGENT_IDS, undefined)).toEqual(AGENT_IDS)
  })

  it('没探过(一次都没 scan)→ view 与 installedIds 都缺席', () => {
    const scan = createInstalledAgentScan({ io: fakeIo([]), now: () => 1 })
    expect(scan.view()).toBeUndefined()
    expect(scan.installedIds()).toBeUndefined()
  })
})

describe('探测之外仍要留下的那几家', () => {
  it('★此刻真有会话 / 登记表里接上过的那一家不因 Spotlight 索引不到而消失', async () => {
    const scan = createInstalledAgentScan({ io: fakeIo(['com.openai.codex']), now: () => 1 })
    await scan.scan()
    // Claude 装在非标准位置、mdfind 找不到,可它正在说话 —— 那就留着。
    expect(shownAgentIds(AGENT_IDS, scan.installedIds(), new Set(['claude'])))
      .toEqual(['dsh', 'claude', 'codex'])
  })

  it('事务官自己永远留着(它没有 App,永远探不到)', () => {
    expect(shownAgentIds(AGENT_IDS, new Set<string>())).toEqual(['dsh'])
  })
})

describe('节流与作废', () => {
  it('一分钟内 pump 不重扫;invalidate 之后下一拍立刻重扫', async () => {
    let calls = 0
    let now = 1_000
    const scan = createInstalledAgentScan({
      io: {
        exec: async () => { calls += 1; return { ok: true, code: 0, out: '/Applications/Fake.app', err: '' } },
      },
      now: () => now,
      rescanMs: 60,
    })
    await scan.scan()
    const first = calls
    // 一轮 = 知识表那几条 + 已知的那两家(没接登记表时就这些)。
    expect(first).toBe(AGENT_APP_CANDIDATES.length + KNOWN_APP_CANDIDATES.length)
    scan.pump()
    await Promise.resolve()
    expect(calls).toBe(first)
    scan.invalidate()
    scan.pump()
    // pump 是 fire-and-forget:让出几拍让那一轮跑完。
    for (let i = 0; i < first + 4; i += 1) await Promise.resolve()
    expect(calls).toBeGreaterThan(first)
    now += 1
  })
})

describe('★真机漏报的那两家:Antigravity 与 Grok Bot(2026-09-27 晚的回归)', () => {
  /**
   * 现场:维护者本机装着这两家、顶栏里都在(运行中被发现的),
   * 可 `/state.installed_agents.agents` 只报了六家 —— 「本机有哪几家」是唯一出处,漏一家就不算。
   *
   * 两个包标识都是本机读 `Info.plist` / `mdls` 读出来的,不猜。
   */
  it('两家都在候选里,包标识与本机读到的逐字相同', () => {
    const byBundle = new Map(KNOWN_APP_CANDIDATES.map(one => [one.bundle_id, one]))
    expect(byBundle.get('com.google.antigravity')?.name).toBe('Antigravity')
    // Grok Bot 的包标识与名字对不上(anysphere 是 Cursor 那家公司、sand 是代号)—— 别照名字猜。
    expect(byBundle.get('com.anysphere.sand')?.name).toBe('Grok Bot')
    expect(ANTIGRAVITY_BUNDLE_ID).toBe('com.google.antigravity')
  })

  it('★登记表 id 不变:候选的 id 就是包标识,与登记表里那一条一致', () => {
    // 要是把这两家塞进 FAMILY_SOURCES,entryIdForBundle 会把 id 换成短名,
    // 已落盘的额度读数 / 已读簿 / 卡上的 links 会一次性孤立掉。所以 id 必须还是包标识。
    for (const one of KNOWN_APP_CANDIDATES) expect(one.id).toBe(one.bundle_id)
  })

  it('★装了就报得出来(哪怕它一次都没启动过 —— 登记表那一路要它跑过才有)', async () => {
    const scan = createInstalledAgentScan({
      io: fakeIo(['com.google.antigravity', 'com.anysphere.sand']),
      now: () => 1_700_000_000_000,
    })
    const view = await scan.scan()
    expect(view?.agents.map(one => one.name)).toEqual(['Antigravity', 'Grok Bot'])
  })
})

describe('★候选也从登记表长出来(下一家不用改代码)', () => {
  it('登记表里判过的那一家进候选,按包标识去重、不重复', () => {
    const list = candidatesWith([
      { id: 'com.example.newai', bundle_id: 'com.example.newai', name: '某新家' },
      // 知识表里已经有的那一家(同一个包标识)不重复进来。
      { id: 'doubao', bundle_id: DOUBAO_BUNDLE, name: '豆包办公' },
      // 事务官自己、没有包标识的那种探不了,跳过。
      { id: 'dsh', name: '事务官', self: true },
      { id: 'gpt', name: 'GPT' },
    ])
    const bundles = list.map(one => one.bundle_id)
    expect(bundles).toContain('com.example.newai')
    expect(bundles.filter(one => one === DOUBAO_BUNDLE)).toHaveLength(1)
    expect(list.some(one => one.id === 'dsh')).toBe(false)
    expect(list.some(one => one.id === 'gpt')).toBe(false)
  })

  it('★运行时新接上的一家:探到了就进 installed_agents,名字用登记表里的', async () => {
    const scan = createInstalledAgentScan({
      io: fakeIo(['com.example.newai']),
      now: () => 1_700_000_000_000,
      registryApps: () => [{ id: 'com.example.newai', bundle_id: 'com.example.newai', name: '某新家' }],
    })
    const view = await scan.scan()
    expect(view?.agents).toEqual([{ id: 'com.example.newai', name: '某新家', bundle_id: 'com.example.newai' }])
  })

  it('登记表读不出来(抛了)也不该把这一轮带塌', async () => {
    const scan = createInstalledAgentScan({
      io: fakeIo([DOUBAO_BUNDLE]),
      now: () => 1_700_000_000_000,
      registryApps: () => { throw new Error('登记表这会儿读不了') },
    })
    expect((await scan.scan())?.agents.map(one => one.id)).toEqual(['doubao'])
  })
})

describe('★探到的时刻:now() 是毫秒,不许再乘 1000', () => {
  /**
   * 真机上 `installed_agents.at` 写出来是 `+058709-03-29T13:14:51.000Z`(公元五万八千年):
   * `deps.now()` 生产上就是 `Date.now()`(毫秒),头一版又乘了一遍 1000。
   */
  it('at = new Date(now()).toISOString(),不是 now()*1000', async () => {
    const ms = Date.UTC(2026, 8, 27, 12, 34, 56)
    const scan = createInstalledAgentScan({ io: fakeIo([DOUBAO_BUNDLE]), now: () => ms })
    expect((await scan.scan())?.at).toBe('2026-09-27T12:34:56.000Z')
    expect(scan.view()?.at).toBe('2026-09-27T12:34:56.000Z')
  })

  it('★年份必须落在四位数(公元五万八千年那种一眼就该被钉住)', async () => {
    const scan = createInstalledAgentScan({ io: fakeIo([DOUBAO_BUNDLE]), now: () => Date.now() })
    const at = (await scan.scan())?.at ?? ''
    expect(at).toMatch(/^20\d\d-/)
    expect(new Date(at).getUTCFullYear()).toBeLessThan(2100)
  })
})

describe('★还没探完的那一瞬间:退回全显示,但一个字都不许落盘', () => {
  it('探测还没结果时 list() 全给,且 apps.json 一个字没写', async () => {
    const file = await tmpAppsFile()
    const scan = createInstalledAgentScan({ io: fakeIo([DOUBAO_BUNDLE]), now: () => Date.now() })
    // 刻意不 scan():模拟重启后第一次 /state,探测还没跑完。
    expect(scan.installedIds()).toBeUndefined()
    const registry = createAppsRegistry({
      file,
      runOsascript: async () => ({ ok: false, stdout: '' }),
      installedKeys: () => scan.installedIds(),
    })
    const keys = (await registry.list()).map(one => one.key)
    // 退回全显示(D13):这一瞬间不许把「没装」当结论。
    expect(keys).toContain('claude')
    expect(keys).toContain('kimi')
    expect(keys).toContain('doubao')
    /**
     * ★ 而且**没落盘**:`list()` 是纯读路径(`baseKeyVisible` 只在 list / enabledBase /
     * commandFor / bundleFor 四处被叫,全是读)。apps.json 的写只走他亲手加 / 删那几条
     * (`enable` / `add` / `remove` / `addResolved`),它们压根不看探测。
     * 要是哪天有人把探测结论写进落盘状态,这一条会先炸 —— 那一瞬间的「没装」会变成永久的。
     */
    await expect(readFile(file, 'utf8')).rejects.toThrow()
  })
})
