/**
 * **家族目录 + 适配器登记处**(2026-10-02,卡「引擎核心」)。
 *
 * 这一份钉两样:
 *
 * ① **这一次走哪一条通道**:一家可以登记「协议 + 窗口」两条,排队只按
 *    `comparePicks` 那四条(开得到某一段 / 读得到回答 / 通道从稳到脆 / 登记顺序),
 *    这一样不会的一条都不进队;`capabilities()` 抛了 = 这一条什么都不会,**别的通道照旧算**。
 *
 * ② **候选名单(`targets`)替掉 `agentDiscovery` 那条判法**(统筹 10-02 查实):
 *    今天 composer 的 @ 候选 = 登记表里 `state:'connected'` 的家,而那一格要
 *    `agentJudge.judgeStructure` 过关 —— **对话区 / 输入框 / 发送键或新对话三样都要**。于是 Air 上:
 *    - Kimi(自绘输入框,AX 里是 `AXUnknown`)永远过不了「有输入框」→ 永远不在候选里;
 *    - Codex 把窗一关就掉出候选 —— 哪怕 `codex app-server` 好好的。
 *    这两条**在这一份里都是真机能派的**:存不存在只看「目录认识它 + 这台真有它」,
 *    能做什么只看各适配器现查。
 */
import { describe, expect, it } from 'vitest'
import type { Adapter, AdapterCapabilities, Job, JobResult } from '../src/server/engine/adapter.ts'
import type { WriteMode } from '../src/server/engine/registry.ts'
import { NO_CAPABILITIES, VIA_ORDER, WRITE_MODE_TEXT, channelRank, comparePicks, createRegistry, writeModeOf } from '../src/server/engine/registry.ts'

const ALL_CAPS: AdapterCapabilities = { open: true, send: true, read: true, press: true, approve: true, writeAsk: true, stop: true, openSession: true }

function fakeAdapter(input: {
  family: string
  via?: JobResult['via']
  caps?: Partial<AdapterCapabilities>
  /** 查能力这一下坏了(协议握手抛了、壳没连上)。 */
  throws?: string
  onCapabilities?: () => void
  /** 自绘界面那一档(窗口适配器多实现的那个可选方法)。 */
  writeMode?: () => WriteMode
}): Adapter {
  return {
    family: input.family,
    via: input.via ?? 'window',
    capabilities: () => {
      input.onCapabilities?.()
      if (input.throws !== undefined) return Promise.reject(new Error(input.throws))
      return Promise.resolve({ ...ALL_CAPS, ...input.caps })
    },
    run: () => Promise.resolve({ delivered: 'confirmed', via: input.via ?? 'window' } satisfies JobResult),
    ...(input.writeMode === undefined ? {} : { writeMode: input.writeMode }),
  }
}

function jobOf(over: Partial<Job> = {}): Job {
  return {
    id: 'j-1',
    family: 'claude',
    kind: 'answer',
    target: { kind: 'new' },
    text: '一句话',
    expect: 'ack',
    ...over,
  }
}

describe('登记处 · 一家几条通道', () => {
  it('按 family 登记;同一家两条按稳到脆排(协议在窗口前)', () => {
    const registry = createRegistry()
    const window = fakeAdapter({ family: 'claude', via: 'window' })
    const socket = fakeAdapter({ family: 'claude', via: 'protocol' })
    registry.register(window)
    registry.register(socket)
    registry.register(fakeAdapter({ family: 'doubao', via: 'window' }))
    expect(registry.channelsOf('claude')).toEqual([socket, window])
    expect(registry.channelsOf('doubao')).toHaveLength(1)
    expect(registry.channelsOf('muse')).toEqual([])
    expect(registry.all()).toHaveLength(3)
  })

  it('稳到脆就是契约那几种的顺序(2026-10-03 多了接口那一条,排在命令行后、文件前)', () => {
    expect([...VIA_ORDER]).toEqual(['protocol', 'cli', 'api', 'file', 'window'])
    expect(channelRank('protocol')).toBeLessThan(channelRank('window'))
  })

  it('这一样不会的一条都不进队(socket 不会按键 → press 只剩窗口)', async () => {
    const registry = createRegistry()
    const socket = fakeAdapter({ family: 'claude', via: 'protocol', caps: { press: false, stop: false } })
    const window = fakeAdapter({ family: 'claude', via: 'window' })
    registry.register(socket)
    registry.register(window)
    const send = await registry.picksFor(jobOf())
    expect(send.map(one => one.adapter.via)).toEqual(['protocol', 'window'])
    const press = await registry.picksFor(jobOf({ kind: 'press', expect: 'none' }))
    expect(press.map(one => one.adapter.via)).toEqual(['window'])
    expect((await registry.adapterFor('claude', { kind: 'press' }))?.adapter).toBe(window)
  })

  it('capabilities() 抛了 = 这一条什么都不会,同一家别的通道照旧算', async () => {
    const registry = createRegistry()
    registry.register(fakeAdapter({ family: 'claude', via: 'protocol', throws: 'socket 连不上' }))
    const window = fakeAdapter({ family: 'claude', via: 'window' })
    registry.register(window)
    const picks = await registry.picksFor(jobOf())
    expect(picks).toHaveLength(1)
    expect(picks[0]?.adapter).toBe(window)
  })

  it('★候选名单那一份答案留一小会儿(每打一个字问一次,不碰一次壳)', async () => {
    const clock = { value: 0 }
    let asked = 0
    const registry = createRegistry({ now: () => new Date(clock.value), capsTtlMs: 5000 })
    registry.register(fakeAdapter({ family: 'claude', via: 'protocol', onCapabilities: () => { asked += 1 } }))
    await registry.targets()
    await registry.targets()
    expect(asked).toBe(1)
    clock.value += 5001
    await registry.targets()
    expect(asked).toBe(2)
  })

  it('★**真要动手**那一下不吃缓存:每一次都现查', async () => {
    /*
     * 2026-10-02 查出来的一个真毛病:服务器先起、壳后连,中间只要有谁问过一次
     * (候选名单 / `/state` 那一拍),`send:false` 就被缓存住 —— 接下来那几秒里派活会被答成
     * 「没有一条能送话的通道」,而其实送得出去。所以 `picksFor` 这一下**现查**,
     * 界面那两份(`targets` / `knownCaps`)照旧吃缓存(它们每秒问一次,晚一拍不要紧)。
     */
    let asked = 0
    const registry = createRegistry({ now: () => new Date(0), capsTtlMs: 5000 })
    registry.register(fakeAdapter({ family: 'claude', via: 'protocol', onCapabilities: () => { asked += 1 } }))
    await registry.picksFor(jobOf())
    await registry.picksFor(jobOf())
    expect(asked).toBe(2)
  })
})

describe('登记处 · 谁先(comparePicks 那四条)', () => {
  const candidate = (via: JobResult['via'], caps: Partial<AdapterCapabilities>, at: number) =>
    ({ adapter: fakeAdapter({ family: 'claude', via }), caps: { ...ALL_CAPS, ...caps }, at })

  it('她指名了某一段:开得到那一段的先(哪怕通道更脆)', () => {
    const protocol = candidate('protocol', { openSession: false }, 0)
    const window = candidate('window', { openSession: true }, 1)
    expect(comparePicks(protocol, window, jobOf({ target: { kind: 'session', sessionId: 's-1' } }))).toBeGreaterThan(0)
    // 新开一条时这一条不比:协议照旧在前。
    expect(comparePicks(protocol, window, jobOf())).toBeLessThan(0)
  })

  it('她要回话:读得到回答的先', () => {
    const blind = candidate('protocol', { read: false }, 0)
    const reader = candidate('window', { read: true }, 1)
    expect(comparePicks(blind, reader, jobOf({ expect: 'reply' }))).toBeGreaterThan(0)
    expect(comparePicks(blind, reader, jobOf({ expect: 'ack' }))).toBeLessThan(0)
  })

  it('都一样就按登记顺序', () => {
    expect(comparePicks(candidate('window', {}, 0), candidate('window', {}, 1), jobOf())).toBeLessThan(0)
  })
})

describe('登记处 · 这次动哪个包(只问 pickFamilyPackage,不新造一张表)', () => {
  it('她点名了哪个包就是它', () => {
    const registry = createRegistry({ installed: () => [{ bundle_id: 'com.bot.pc.doubao' }, { bundle_id: 'com.work.pc.doubao' }] })
    expect(registry.packageFor('doubao', 'com.work.pc.doubao')).toEqual({
      bundle_id: 'com.work.pc.doubao', name: '豆包工作', why: 'said',
    })
  })

  it('只装了一个 → 那一个;两个都装着 → 开着的那一个', () => {
    const one = createRegistry({ installed: () => [{ bundle_id: 'com.work.pc.doubao' }] })
    expect(one.packageFor('doubao')).toMatchObject({ bundle_id: 'com.work.pc.doubao', why: 'only' })
    const two = createRegistry({
      installed: () => [{ bundle_id: 'com.bot.pc.doubao' }, { bundle_id: 'com.work.pc.doubao', running: true }],
    })
    expect(two.packageFor('doubao')).toMatchObject({ bundle_id: 'com.work.pc.doubao', why: 'running' })
  })

  it('探过、一个都没装 → 这一格缺席(不记一个不在这台机器上的包标识)', () => {
    const registry = createRegistry({ installed: () => [] })
    expect(registry.packageFor('doubao')).toBeUndefined()
  })

  it('目录不认识的那一家:家名就是它的包标识', () => {
    const registry = createRegistry({ installed: () => [] })
    expect(registry.packageFor('com.electron.klingai')).toMatchObject({ bundle_id: 'com.electron.klingai' })
  })

  it('探不出装没装 → 主包(与这张卡之前一字不变)', () => {
    expect(createRegistry().packageFor('doubao')).toMatchObject({ bundle_id: 'com.bot.pc.doubao', why: 'default' })
  })
})

describe('登记处 · 候选名单(替掉「三样都要」的结构判法)', () => {
  /**
   * ★ **自绘界面不是「没接上」,是「写入靠粘贴」那一档**(统筹 10-02 补;
   * `origin/claude/kimi-kmp` f13f3b63 给 `judgeStructure` 加的 `mode:'full'|'paste_only'` 同一张表)。
   * 官网版 Kimi 登录后 `inputs:0 send:0`、`texts.above_input:12` —— 对话文字读得到,
   * 输入框与发送键是 `AXUnknown`。两档(接上 / 没接上)会把它判成没接上,于是整家派不了活。
   */
  it('Kimi 自绘界面:照常在候选里,标「写入靠粘贴」', async () => {
    const registry = createRegistry({ installed: () => [{ bundle_id: 'com.moonshot.kimichat' }] })
    registry.register(fakeAdapter({ family: 'kimi', via: 'window', writeMode: () => 'paste_only' }))
    const kimi = (await registry.targets()).find(one => one.family === 'kimi')
    expect(kimi).toMatchObject({ name: 'Kimi', bundle_id: 'com.moonshot.kimichat', here: 'package', write: 'paste_only' })
    expect(kimi?.can.send).toBe(true)
    expect(WRITE_MODE_TEXT.paste_only).toBe('写入靠粘贴')
  })

  it('没报那一档的(协议型 / 老壳)就是老样子 full', async () => {
    const registry = createRegistry({ installed: () => [{ bundle_id: 'com.openai.codex' }] })
    registry.register(fakeAdapter({ family: 'codex', via: 'protocol' }))
    expect((await registry.targets()).find(one => one.family === 'codex')?.write).toBe('full')
    expect(await writeModeOf(fakeAdapter({ family: 'codex' }))).toBe('full')
  })

  it('一家两条通道:有一条打字送得进去就是 full(取最好的那一档)', async () => {
    const registry = createRegistry({ installed: () => [{ bundle_id: 'com.anthropic.claudefordesktop' }] })
    registry.register(fakeAdapter({ family: 'claude', via: 'window', writeMode: () => 'paste_only' }))
    registry.register(fakeAdapter({ family: 'claude', via: 'protocol' }))
    expect((await registry.targets()).find(one => one.family === 'claude')?.write).toBe('full')
  })

  it('送不进去的那一家不标写法(不说一个说不出的档)', async () => {
    const registry = createRegistry({ installed: () => [{ bundle_id: 'com.moonshot.kimichat' }] })
    // 壳没连上:这一条通道此刻什么都不会 ——「不会」不等于「不在」。
    registry.register({ ...fakeAdapter({ family: 'kimi', via: 'window' }), capabilities: () => Promise.resolve(NO_CAPABILITIES) })
    const kimi = (await registry.targets()).find(one => one.family === 'kimi')
    expect(kimi).toMatchObject({ here: 'package' })
    expect(kimi?.can.send).toBe(false)
    expect(kimi?.write).toBeUndefined()
  })

  it('Codex 窗口关着、app-server 答应得上:凭通道就在候选里', async () => {
    // 探了、这台一个 App 都没探到(壳没装 Spotlight 索引那一类);协议那条通道答应得上。
    const registry = createRegistry({ installed: () => [] })
    registry.register(fakeAdapter({ family: 'codex', via: 'protocol' }))
    const codex = (await registry.targets()).find(one => one.family === 'codex')
    expect(codex).toMatchObject({ here: 'channel', channels: ['protocol'] })
    expect(codex?.can.send).toBe(true)
  })

  it('探过、既没它的包也没一条答应得上的通道 → 整家不出现', async () => {
    const registry = createRegistry({ installed: () => [{ bundle_id: 'com.moonshot.kimichat' }] })
    const families = (await registry.targets()).map(one => one.family)
    expect(families).toContain('kimi')
    expect(families).not.toContain('doubao')
    expect(families).not.toContain('muse')
  })

  it('探不出装没装:目录认识的那几家照旧列出(「查不到」不许冒充「没有」)', async () => {
    const families = (await createRegistry().targets()).map(one => one.family)
    expect(families).toContain('claude')
    expect(families).toContain('kimi')
    expect((await createRegistry().targets()).every(one => one.here === 'unknown')).toBe(true)
  })

  it('事务官自己不进候选(她不派活给自己)', async () => {
    const registry = createRegistry()
    expect((await registry.targets()).some(one => one.family === 'dsh')).toBe(false)
  })

  it('一家装着两个包:候选照旧一家一条,两个包都挂在它身上', async () => {
    const registry = createRegistry({
      installed: () => [{ bundle_id: 'com.bot.pc.doubao' }, { bundle_id: 'com.work.pc.doubao' }],
    })
    const doubao = (await registry.targets()).filter(one => one.family === 'doubao')
    expect(doubao).toHaveLength(1)
    expect(doubao[0]?.packages?.map(one => one.bundle_id)).toEqual(['com.bot.pc.doubao', 'com.work.pc.doubao'])
  })

  it('能做什么 = 几条通道取或;通道按稳到脆排', async () => {
    const registry = createRegistry({ installed: () => [{ bundle_id: 'com.anthropic.claudefordesktop' }] })
    registry.register(fakeAdapter({ family: 'claude', via: 'window', caps: { press: true, read: true, send: false, stop: false, openSession: false } }))
    registry.register(fakeAdapter({ family: 'claude', via: 'protocol', caps: { send: true, press: false, stop: false } }))
    const claude = (await registry.targets()).find(one => one.family === 'claude')
    expect(claude?.channels).toEqual(['protocol', 'window'])
    expect(claude?.can).toEqual({ open: true, send: true, read: true, press: true, approve: true, writeAsk: true, stop: false, openSession: true })
  })

  it('目录不认识、已经认成一家的那几条:喂进来就在候选里', async () => {
    const registry = createRegistry({
      installed: () => [{ bundle_id: 'com.electron.klingai' }],
      extra: () => [{ family: 'com.electron.klingai', name: '可灵', bundle_id: 'com.electron.klingai' }],
    })
    const one = (await registry.targets()).find(had => had.family === 'com.electron.klingai')
    expect(one).toMatchObject({ name: '可灵', bundle_id: 'com.electron.klingai', here: 'package' })
  })
})
