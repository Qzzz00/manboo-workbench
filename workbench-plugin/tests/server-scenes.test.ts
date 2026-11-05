import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { APP_BUNDLES } from '../src/server/activation.ts'
import type { HelperRequest } from '../src/server/helperChannel.ts'
import { createScenesService, defaultScenesFile, saveScenesFile } from '../src/server/scenes.ts'
import type { ScenesFile } from '../src/server/scenes.ts'

const noSleep = (): Promise<void> => Promise.resolve()

async function tmpFile(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'scenes-')), 'scenes.json')
}

/**
 * 一份「用户已经有两个场景」的种子文件(2026-09-20 去预置之后加的)。
 *
 * 预置下线之后新文件里一个场景都没有,而下面这一批用例要的是「已经有场景」那一档
 * (save / restore / 重名),所以自己先写一份。**名字刻意不叫「干活/沟通」**:
 * 那一对 id+名字现在是旧预置的签名,空着读出来会被当作没有(见 loadScenesFile)。
 */
async function tmpFileSeeded(): Promise<string> {
  const file = await tmpFile()
  await saveScenesFile(file, {
    version: 1,
    scenes: [
      { id: 'work', name: '写代码', apps: [] },
      { id: 'talk', name: '开会', apps: [] },
    ],
  })
  return file
}

/** 假壳:按 op/bundle_id 回放脚本化响应,记录全部请求。先例见 server-orchestrator.test.ts。 */
function fakeHelper(script: (req: HelperRequest) => Record<string, unknown> | Error) {
  const calls: HelperRequest[] = []
  return {
    calls,
    channel: {
      attach: () => {},
      connected: () => true,
      view: () => ({ connected: true, authorized: true }),
      onChange: () => {},
      request: (req: HelperRequest) => {
        calls.push(req)
        const out = script(req)
        return out instanceof Error ? Promise.reject(out) : Promise.resolve(out)
      },
    },
  }
}

/** lsappinfo 对给定 bundle 集合回 pid,其余回空。 */
function runCommandRunning(runningBundles: readonly string[]) {
  return async (cmd: readonly string[]) => {
    if (cmd[0] === 'lsappinfo') {
      const bundleId = cmd.at(-1)
      return { ok: true, stdout: bundleId !== undefined && runningBundles.includes(bundleId) ? '"pid"=123\n' : '' }
    }
    return { ok: true, stdout: '' }
  }
}

const termFrame = { x: 0, y: 0, w: 800, h: 600 }
const wechatFrame = { x: 10, y: 10, w: 500, h: 400 }
const wecomFrame = { x: 20, y: 20, w: 500, h: 400 }

describe('scenes(spec §3/W5/W6)', () => {
  it('★新装/重置:文件缺失 → 一个场景都没有(2026-09-20 去掉「干活/沟通」两条空预置)', async () => {
    const svc = createScenesService({
      file: await tmpFile(),
      helper: fakeHelper(() => ({})).channel,
      runCommand: runCommandRunning([]),
      sleep: noSleep,
    })
    expect(await svc.list()).toEqual([])
  })

  it('★旧文件里只剩那两条空预置 → 读的时候当作没有(不回写,用户的文件不动)', async () => {
    const file = await tmpFile()
    const legacy: ScenesFile = {
      version: 1,
      scenes: [
        { id: 'work', name: '干活', apps: [] },
        { id: 'talk', name: '沟通', apps: [] },
      ],
    }
    await saveScenesFile(file, legacy)
    const svc = createScenesService({ file, helper: fakeHelper(() => ({})).channel, runCommand: runCommandRunning([]), sleep: noSleep })

    expect(await svc.list()).toEqual([])
    // 文件本身一个字没动:这一支只是"读的时候当作没有",不替用户改盘上的东西。
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(legacy)
  })

  it('★只剩一条空预置(另一条被删过)→ 同样当作没有', async () => {
    const file = await tmpFile()
    await saveScenesFile(file, { version: 1, scenes: [{ id: 'talk', name: '沟通', apps: [] }] })
    const svc = createScenesService({ file, helper: fakeHelper(() => ({})).channel, runCommand: runCommandRunning([]), sleep: noSleep })
    expect(await svc.list()).toEqual([])
  })

  it('★用户自己的场景原样保留:存过内容的、改过名的、自建的,一条都不许当预置清掉', async () => {
    const file = await tmpFile()
    await saveScenesFile(file, {
      version: 1,
      scenes: [
        // 同一个 id 但用户存过内容 —— 这是他的场景了。
        { id: 'work', name: '干活', apps: [{ app: 'term', bundle_id: 'com.apple.Terminal', windows: [{ frame: termFrame }] }] },
        // 同一个 id、改过名、还没存内容 —— 改名这一下就是"他在用它"。
        { id: 'talk', name: '摸鱼', apps: [] },
        // 自建的空场景。
        { id: 's-abc', name: '写方案', apps: [] },
      ],
    })
    const svc = createScenesService({ file, helper: fakeHelper(() => ({})).channel, runCommand: runCommandRunning([]), sleep: noSleep })

    expect((await svc.list()).map(s => s.name)).toEqual(['干活', '摸鱼', '写方案'])
  })

  it('save:按 8 应用名册枚举,只收「运行中+未隐藏+有窗」的应用;落盘后重建实例仍在(原子写)', async () => {
    const file = await tmpFileSeeded()
    const helper = fakeHelper((req) => {
      if (req.op === 'app_info') {
        if (req.bundle_id === 'com.apple.Terminal') return { running: true, hidden: false, windows: [{ index: 0, frame: termFrame }] }
        if (req.bundle_id === 'com.tencent.xinWeChat') return { running: true, hidden: false, windows: [{ index: 0, frame: wechatFrame }] }
        return { running: false, hidden: false, windows: [] }
      }
      return {}
    })
    const svc = createScenesService({ file, helper: helper.channel, runCommand: runCommandRunning([]), sleep: noSleep })
    const result = await svc.save('work')
    expect(result).toEqual({ ok: true })

    // 用同一 file 重建实例:落盘的是真实文件内容,不是内存态。
    const svc2 = createScenesService({ file, helper: fakeHelper(() => ({})).channel, runCommand: runCommandRunning([]), sleep: noSleep })
    const list = await svc2.list()
    const work = list.find(s => s.id === 'work')
    expect(work?.app_count).toBe(2)
    expect(work?.saved_at).toBeDefined()
  })

  it('save:名册内应用全没开→拒绝保存并给原因(不许把好场景覆盖成空)', async () => {
    const file = await tmpFileSeeded()
    // 先造一份有内容的场景,证明拒绝时原内容不被清空。
    const seedHelper = fakeHelper((req) => {
      if (req.op === 'app_info' && req.bundle_id === 'com.apple.Terminal') {
        return { running: true, hidden: false, windows: [{ index: 0, frame: termFrame }] }
      }
      return { running: false, hidden: false, windows: [] }
    })
    const seedSvc = createScenesService({ file, helper: seedHelper.channel, runCommand: runCommandRunning([]), sleep: noSleep })
    expect(await seedSvc.save('work')).toEqual({ ok: true })

    const emptyHelper = fakeHelper(() => ({ running: false, hidden: false, windows: [] }))
    const svc = createScenesService({ file, helper: emptyHelper.channel, runCommand: runCommandRunning([]), sleep: noSleep })
    const result = await svc.save('work')
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('没有可保存的窗口')

    const list = await svc.list()
    expect(list.find(s => s.id === 'work')?.app_count).toBe(1) // 原场景仍在,没被清空
  })

  it('save:helper 未接入→原因原样透传,不落盘', async () => {
    const file = await tmpFileSeeded()
    const before = await readFile(file, 'utf8')
    const helper = fakeHelper(() => new Error('工作台 App 未运行'))
    const svc = createScenesService({ file, helper: helper.channel, runCommand: runCommandRunning([]), sleep: noSleep })
    const result = await svc.save('work')
    expect(result).toEqual({ ok: false, reason: '工作台 App 未运行' })
    // 未落盘:文件一个字没变(去预置之后这份文件本来就存在,不能再用"文件不存在"来证明)。
    expect(await readFile(file, 'utf8')).toBe(before)
  })

  it('restore 空场景:拒绝并提示先保存,不发任何窗口指令', async () => {
    const helper = fakeHelper(() => ({}))
    const svc = createScenesService({ file: await tmpFileSeeded(), helper: helper.channel, runCommand: runCommandRunning([]), sleep: noSleep })
    const result = await svc.restore('work')
    expect(result.ok).toBe(false)
    expect(result.apps).toEqual([])
    expect(result.reason).toContain('先手排')
    expect(helper.calls).toEqual([])
  })

  it('restore:逐应用 激活→unhide→等窗→按序摆位→raise;隐藏「其他场景有而本场景没有」的运行中应用;无关应用不动', async () => {
    const file = await tmpFile()
    const fixture: ScenesFile = {
      version: 1,
      scenes: [
        { id: 'work', name: '干活', apps: [{ app: 'term', bundle_id: 'com.apple.Terminal', windows: [{ frame: termFrame }] }] },
        {
          id: 'talk',
          name: '沟通',
          apps: [
            { app: 'wechat', bundle_id: 'com.tencent.xinWeChat', windows: [{ frame: wechatFrame }] },
            { app: 'wecom', bundle_id: 'com.tencent.WeWorkMac', windows: [{ frame: wecomFrame }] },
          ],
        },
      ],
    }
    await saveScenesFile(file, fixture)

    const helper = fakeHelper((req) => {
      if (req.op === 'app_info') {
        if (req.bundle_id === 'com.apple.Terminal') return { running: true, hidden: false, windows: [{ index: 0, frame: termFrame }] }
        return { running: false, hidden: false, windows: [] }
      }
      return {}
    })
    // term、wechat 在运行(lsappinfo 有 pid),wecom 没在运行(空输出)。
    const runCommand = runCommandRunning(['com.apple.Terminal', 'com.tencent.xinWeChat'])
    const svc = createScenesService({ file, helper: helper.channel, runCommand, sleep: noSleep })

    const result = await svc.restore('work')
    expect(result.ok).toBe(true)

    const setFrameCalls = helper.calls.filter(c => c.op === 'set_window_frame')
    expect(setFrameCalls).toEqual([{ op: 'set_window_frame', bundle_id: 'com.apple.Terminal', index: 0, frame: termFrame }])

    // 有可摆窗口的应用摆完位要置前(raise_window),且发生在 set_window_frame 之后。
    const raiseCalls = helper.calls.filter(c => c.op === 'raise_window')
    expect(raiseCalls).toEqual([{ op: 'raise_window', bundle_id: 'com.apple.Terminal', index: 0 }])
    expect(helper.calls.indexOf(setFrameCalls[0]!)).toBeLessThan(helper.calls.indexOf(raiseCalls[0]!))

    const hideCalls = helper.calls.filter(c => c.op === 'hide_app')
    expect(hideCalls.some(c => c.bundle_id === 'com.tencent.xinWeChat')).toBe(true)
    expect(hideCalls.some(c => c.bundle_id === 'com.tencent.WeWorkMac')).toBe(false)
    // 从不 hide 名册外的任何 bundle。
    const roster = new Set(Object.values(APP_BUNDLES))
    for (const c of hideCalls) expect(roster.has(c.bundle_id as string)).toBe(true)
  })

  it('restore:隐藏动作被 helper 拒绝→合成一条失败 entry 且不拖垮已复原应用的成败', async () => {
    const file = await tmpFile()
    const fixture: ScenesFile = {
      version: 1,
      scenes: [
        { id: 'work', name: '干活', apps: [{ app: 'term', bundle_id: 'com.apple.Terminal', windows: [{ frame: termFrame }] }] },
        { id: 'talk', name: '沟通', apps: [{ app: 'wechat', bundle_id: 'com.tencent.xinWeChat', windows: [{ frame: wechatFrame }] }] },
      ],
    }
    await saveScenesFile(file, fixture)

    const helper = fakeHelper((req) => {
      if (req.op === 'app_info') {
        if (req.bundle_id === 'com.apple.Terminal') return { running: true, hidden: false, windows: [{ index: 0, frame: termFrame }] }
        return { running: false, hidden: false, windows: [] }
      }
      if (req.op === 'hide_app') return new Error('隐藏失败:辅助功能未授权')
      return {}
    })
    // term、wechat 都在运行,wechat(talk 独有)会被尝试隐藏,但 hide_app 会被拒绝。
    const runCommand = runCommandRunning(['com.apple.Terminal', 'com.tencent.xinWeChat'])
    const svc = createScenesService({ file, helper: helper.channel, runCommand, sleep: noSleep })

    const result = await svc.restore('work')
    expect(result.ok).toBe(false)

    const hideEntry = result.apps.find(a => a.app === '隐藏 wechat')
    expect(hideEntry).toEqual({ app: '隐藏 wechat', ok: false, reason: '隐藏失败:辅助功能未授权' })

    // term 本身的复原不受隐藏失败牵连,仍如实报告成功。
    const termEntry = result.apps.find(a => a.app === 'term')
    expect(termEntry).toEqual({ app: 'term', ok: true })
  })

  it('restore:窗口数不符时尽力摆并如实报差异', async () => {
    const file = await tmpFile()
    const fixture: ScenesFile = {
      version: 1,
      scenes: [
        { id: 'work', name: '干活', apps: [{ app: 'term', bundle_id: 'com.apple.Terminal', windows: [{ frame: termFrame }, { frame: wechatFrame }] }] },
        { id: 'talk', name: '沟通', apps: [] },
      ],
    }
    await saveScenesFile(file, fixture)

    const helper = fakeHelper((req) => {
      if (req.op === 'app_info') return { running: true, hidden: false, windows: [{ index: 0, frame: termFrame }] }
      return {}
    })
    const runCommand = runCommandRunning(['com.apple.Terminal'])
    const svc = createScenesService({ file, helper: helper.channel, runCommand, sleep: noSleep })

    const result = await svc.restore('work')
    expect(result.ok).toBe(false)
    const entry = result.apps.find(a => a.app === 'term')
    expect(entry?.ok).toBe(false)
    expect(entry?.reason).toContain('存了 2 个')
    expect(entry?.reason).toContain('1 个')
    expect(helper.calls.filter(c => c.op === 'set_window_frame').length).toBe(1)
  })

  it('restore:某应用激活失败不拖垮其余,整体 ok=false,逐应用成败在 apps 里', async () => {
    const file = await tmpFile()
    const fixture: ScenesFile = {
      version: 1,
      scenes: [
        {
          id: 'work',
          name: '干活',
          apps: [
            { app: 'term', bundle_id: 'com.apple.Terminal', windows: [{ frame: termFrame }] },
            { app: 'wechat', bundle_id: 'com.tencent.xinWeChat', windows: [{ frame: wechatFrame }] },
          ],
        },
        { id: 'talk', name: '沟通', apps: [] },
      ],
    }
    await saveScenesFile(file, fixture)

    const helper = fakeHelper((req) => {
      if (req.op === 'app_info') {
        if (req.bundle_id === 'com.tencent.xinWeChat') return { running: true, hidden: false, windows: [{ index: 0, frame: wechatFrame }] }
        return { running: false, hidden: false, windows: [] }
      }
      return {}
    })
    // term(com.apple.Terminal)从不在运行 → 激活重试耗尽后失败;wechat 一直在运行 → 成功。
    const runCommand = runCommandRunning(['com.tencent.xinWeChat'])
    const svc = createScenesService({ file, helper: helper.channel, runCommand, sleep: noSleep })

    const result = await svc.restore('work')
    expect(result.ok).toBe(false)
    const term = result.apps.find(a => a.app === 'term')
    const wechat = result.apps.find(a => a.app === 'wechat')
    expect(term?.ok).toBe(false)
    expect(term?.reason).toContain('激活失败')
    expect(wechat?.ok).toBe(true)
  }, 15_000)

  it('create/rename/remove:重名拒绝、改名生效、删除后 list 不再出现;写坏的文件按空清单兜底', async () => {
    const file = await tmpFileSeeded()
    const svc = createScenesService({ file, helper: fakeHelper(() => ({})).channel, runCommand: runCommandRunning([]), sleep: noSleep })

    const dup = await svc.create('写代码')
    expect(dup.ok).toBe(false)
    expect(dup.reason).toContain('已有同名场景')

    const created = await svc.create('新场景')
    expect(created.ok).toBe(true)
    expect(created.id).toBeDefined()
    const id = created.id as string

    expect(await svc.rename(id, '改名后')).toBe(true)
    let list = await svc.list()
    expect(list.find(s => s.id === id)?.name).toBe('改名后')

    expect(await svc.remove(id)).toBe(true)
    list = await svc.list()
    expect(list.find(s => s.id === id)).toBeUndefined()

    // 写坏文件:JSON 解析失败按空清单兜底(2026-09-20 起不再有预置可兜)。
    await writeFile(file, '{ 这不是合法 JSON')
    expect(await svc.list()).toEqual([])
  })
})

describe('defaultScenesFile', () => {
  it('落在 ~/.dsh/workbench/scenes.json', () => {
    expect(defaultScenesFile('/Users/example')).toBe('/Users/example/.dsh/workbench/scenes.json')
  })
})

describe('scenes + registry(spec S4:名册与自定义应用激活都走 registry)', () => {
  it('save:名册=registry.list(),覆盖到自定义应用', async () => {
    const file = await tmpFileSeeded()
    const helper = fakeHelper((req) => {
      if (req.op === 'app_info' && req.bundle_id === 'notion.id') {
        return { running: true, hidden: false, windows: [{ index: 0, frame: termFrame }] }
      }
      return { running: false, hidden: false, windows: [] }
    })
    const registry = {
      list: async () => [{ key: 'c-notion', label: 'Notion' }],
      commandFor: async (key: string) => (key === 'c-notion' ? ['open', '-a', 'Notion'] : undefined),
      bundleFor: async (key: string) => (key === 'c-notion' ? 'notion.id' : undefined),
    }
    const svc = createScenesService({ file, helper: helper.channel, runCommand: runCommandRunning([]), sleep: noSleep, registry })
    const result = await svc.save('work')
    expect(result).toEqual({ ok: true })

    const list = await svc.list()
    expect(list.find(s => s.id === 'work')?.app_count).toBe(1)
  })

  it('restore:自定义应用激活走 registry.commandFor/bundleFor', async () => {
    const file = await tmpFile()
    await saveScenesFile(file, {
      version: 1,
      scenes: [
        { id: 'work', name: '干活', apps: [{ app: 'c-notion', bundle_id: 'notion.id', windows: [{ frame: termFrame }] }] },
        { id: 'talk', name: '沟通', apps: [] },
      ],
    })
    const helper = fakeHelper((req) => {
      if (req.op === 'app_info') return { running: true, hidden: false, windows: [{ index: 0, frame: termFrame }] }
      if (req.op === 'set_window_frame') return { frame: req.frame }
      return {}
    })
    const opened: string[][] = []
    const registry = {
      list: async () => [{ key: 'c-notion', label: 'Notion' }],
      commandFor: async (key: string) => (key === 'c-notion' ? ['open', '-a', 'Notion'] : undefined),
      bundleFor: async (key: string) => (key === 'c-notion' ? 'notion.id' : undefined),
    }
    const runCommand = async (cmd: readonly string[]) => {
      opened.push([...cmd])
      return { ok: true, stdout: cmd[0] === 'lsappinfo' ? '"pid"=1\n' : '' }
    }
    const svc = createScenesService({ file, helper: helper.channel, runCommand, sleep: noSleep, registry })
    const report = await svc.restore('work')
    expect(report.ok).toBe(true)
    expect(report.apps).toEqual([{ app: 'c-notion', ok: true }])
  })
})

describe('restore 的激活回调(2026-09-09 Dock/⌘Tab 点回已认领应用丢标签修复:场景恢复也是我们发起的激活)', () => {
  it('onBeforeActivate 在每个应用 激活(open/lsappinfo)之前 被调一次,顺序与场景里的应用顺序一致', async () => {
    const file = await tmpFile()
    const fixture: ScenesFile = {
      version: 1,
      scenes: [
        {
          id: 'talk',
          name: '沟通',
          apps: [
            { app: 'wechat', bundle_id: 'com.tencent.xinWeChat', windows: [{ frame: wechatFrame }] },
            { app: 'wecom', bundle_id: 'com.tencent.WeWorkMac', windows: [{ frame: wecomFrame }] },
          ],
        },
        { id: 'work', name: '干活', apps: [] },
      ],
    }
    await saveScenesFile(file, fixture)
    const helper = fakeHelper((req) => {
      if (req.op === 'app_info') return { running: true, hidden: false, windows: [{ index: 0, frame: wechatFrame }] }
      return {}
    })
    const order: string[] = []
    const inner = runCommandRunning(['com.tencent.xinWeChat', 'com.tencent.WeWorkMac'])
    const runCommand = async (cmd: readonly string[]) => { order.push(`run:${cmd[0]}:${cmd.at(-1)}`); return inner(cmd) }
    const svc = createScenesService({
      file, helper: helper.channel, runCommand, sleep: noSleep,
      onBeforeActivate: async (app) => { order.push(`before:${app}`) },
    })

    const result = await svc.restore('talk')

    expect(result.ok).toBe(true)
    expect(order.filter(o => o.startsWith('before:'))).toEqual(['before:wechat', 'before:wecom'])
    // 每个应用的回调都先于它自己的第一条命令(lsappinfo 查在不在跑 / open 拉起)。
    for (const [app, bundle] of [['wechat', 'com.tencent.xinWeChat'], ['wecom', 'com.tencent.WeWorkMac']] as const) {
      const before = order.indexOf(`before:${app}`)
      const firstCmd = order.findIndex(o => o.startsWith('run:') && o.endsWith(bundle))
      expect(firstCmd).toBeGreaterThan(before)
    }
  })

  it('不传 onBeforeActivate → restore 行为与以前完全一样(回调是可选接线)', async () => {
    const file = await tmpFile()
    await saveScenesFile(file, {
      version: 1,
      scenes: [{ id: 'work', name: '干活', apps: [{ app: 'term', bundle_id: 'com.apple.Terminal', windows: [{ frame: termFrame }] }] }],
    })
    const helper = fakeHelper((req) => {
      if (req.op === 'app_info') return { running: true, hidden: false, windows: [{ index: 0, frame: termFrame }] }
      return {}
    })
    const svc = createScenesService({ file, helper: helper.channel, runCommand: runCommandRunning(['com.apple.Terminal']), sleep: noSleep })

    expect((await svc.restore('work')).ok).toBe(true)
  })

  it('onBeforeActivate 抛错 → 只算那个应用失败(原因如实进 apps),不拖垮其余应用', async () => {
    const file = await tmpFile()
    await saveScenesFile(file, {
      version: 1,
      scenes: [{
        id: 'talk',
        name: '沟通',
        apps: [
          { app: 'wechat', bundle_id: 'com.tencent.xinWeChat', windows: [{ frame: wechatFrame }] },
          { app: 'wecom', bundle_id: 'com.tencent.WeWorkMac', windows: [{ frame: wecomFrame }] },
        ],
      }],
    })
    const helper = fakeHelper((req) => {
      if (req.op === 'app_info') return { running: true, hidden: false, windows: [{ index: 0, frame: wechatFrame }] }
      return {}
    })
    const svc = createScenesService({
      file, helper: helper.channel, runCommand: runCommandRunning(['com.tencent.xinWeChat', 'com.tencent.WeWorkMac']), sleep: noSleep,
      onBeforeActivate: async (app) => { if (app === 'wechat') throw new Error('窗位叠写队列炸了') },
    })

    const result = await svc.restore('talk')

    expect(result.ok).toBe(false)
    expect(result.apps).toEqual([
      { app: 'wechat', ok: false, reason: '窗位叠写队列炸了' },
      { app: 'wecom', ok: true },
    ])
  })
})
