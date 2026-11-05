// @vitest-environment node
/**
 * 「插件已经是新版了,运行环境还没换」这一整条(2026-09-26,卡 U6)。
 *
 * ## 这一份是为哪一幕写的
 *
 * 09-26 生产切换那天,这台 Mac 从 0.3.6 点「更新」到 0.4.0。执行那趟热更新的是**旧的
 * 0.3.6 客户端**,它的步骤表里没有 `runtime` —— 插件换成了 0.4.0,而底下那套 DSH
 * 运行环境一个字没换(还是 0.1.2-rc.1,这一版要 0.1.7-rc.2)。换上新插件之后再点
 * 「检查更新」,那条路只比插件版本号 → 没有新版 → **运行环境从此再也装不上**。
 * 同一台机器上体检却认得出来 —— 一件事两处各判一次,其中一处漏了。
 *
 * 所以这一份钉四件事:
 *
 * 1. **判据只有一处**(`readRuntimeDrift`):体检与「检查更新」读的是同一个函数。
 * 2. 插件版本相同 + 运行环境落后 → `available` 为真、`runtime_only` 为真,
 *    而且那一趟**只跑 profile + runtime**(不重下那几十兆)。
 * 3. **老清单没带 `runtime_tgz` → 不算**:那一趟跑起来一步也不会跑,
 *    一颗按了不算数的按钮比没有按钮更糟。
 * 4. 启动就看得见:`lastCheck()`(= `/state.update`)带着那一格,**哪怕从没查过清单**
 *    (它读的是本机的运行时目录,跟联网没关系)。
 *
 * 自动补那一趟(0.3.x 升上来那条路)与防循环的账在下半截。
 * 装机形态下的整条在 `tests/install-shape-runtime-drift.test.ts`。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { humaneDrift, readRuntimeDrift } from '../src/server/setup/dshRuntimeLock.ts'
import { nodeSetupIo, type SetupIo } from '../src/server/setup/io.ts'
import { LOCKED_DSH_VERSION, setupPaths } from '../src/server/setup/paths.ts'
import type { SetupInstallStep, SetupJobView } from '../src/server/setup/types.ts'
import {
  createRuntimeRepair, RUNTIME_DRIFT_NOTICE_KEY, RUNTIME_REPAIR_LABEL, RUNTIME_REPAIR_STEPS,
  type RuntimeRepairLedger,
} from '../src/server/setup/runtimeRepair.ts'
import { RUNTIME_ONLY_STEPS } from '../src/server/update/apply.ts'
import { createUpdateService, runtimeOnlyNotes } from '../src/server/update/service.ts'
import type { UpdateManifest } from '../src/server/update/types.ts'
import { seedLockedRuntime } from './setup/dshRuntimeFake.ts'

const NOW = Date.parse('2026-09-26T04:00:00Z')
const SHA = 'a'.repeat(64)
const BOX_PREFIX = join(tmpdir(), 'wb-runtime-drift-')

const boxes: string[] = []
afterEach(() => {
  // 0904 家目录被删事故之后的纪律:递归删除只许落在本用例前缀下的那个 mkdtemp 沙箱里。
  while (boxes.length) {
    const box = boxes.pop() as string
    if (!box.startsWith(BOX_PREFIX) || box.slice(BOX_PREFIX.length).includes('/')) continue
    rmSync(box, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

function box(): string {
  const dir = mkdtempSync(BOX_PREFIX)
  boxes.push(dir)
  return dir
}

/** 一台「装好了、运行环境也对」的机器。 */
function goodHome(): { home: string, paths: ReturnType<typeof setupPaths> } {
  const home = box()
  const paths = setupPaths({ home })
  mkdirSync(paths.runtimeDir, { recursive: true })
  seedLockedRuntime(paths.runtimeDir)
  return { home, paths }
}

/** 一台「插件换新了、运行环境还是旧的」的机器 —— 09-26 那台 Mac 的样子。 */
function driftedHome(installedDsh = '0.1.2-rc.1'): { home: string, paths: ReturnType<typeof setupPaths> } {
  const { home, paths } = goodHome()
  seedLockedRuntime(paths.runtimeDir, { '@deepseek-ai/dsh': installedDsh })
  return { home, paths }
}

function manifest(over: Partial<UpdateManifest> = {}): UpdateManifest {
  return {
    version: '0.4.0',
    notes: '这一版改了什么,发版的人写的那一段',
    assets: {
      plugin_tgz: { url: 'http://127.0.0.1:9/updates/0.4.0/plugin.tgz', sha256: SHA, size: 1_200_000 },
      runtime_tgz: { url: 'http://127.0.0.1:9/updates/0.4.0/runtime.tgz', sha256: 'b'.repeat(64), size: 40_000 },
      channel_worker_tgz: { url: 'http://127.0.0.1:9/updates/0.4.0/worker.tgz', sha256: 'c'.repeat(64), size: 350_000_000 },
    },
    ...over,
  }
}

/** 一个只发这份清单的假 fetch(不联网)。 */
function fakeFetch(body: UpdateManifest): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch
}

function serviceOn(home: string, options: {
  currentVersion: string
  manifest?: UpdateManifest
  io?: SetupIo
}) {
  const real = nodeSetupIo()
  const io: SetupIo = { ...(options.io ?? real), fetch: fakeFetch(options.manifest ?? manifest()) }
  const paths = setupPaths({ home })
  let seq = 0
  return createUpdateService({
    io,
    paths,
    now: () => NOW,
    newId: () => `job${(seq += 1)}`,
    currentVersion: options.currentVersion,
    manifestUrl: 'http://127.0.0.1:9/updates/latest.json',
    runtimeDrift: async () => await readRuntimeDrift(io, paths.runtimeDir),
  })
}

/* ════════════════════════ 一、判据只有一处 ════════════════════════ */

describe('readRuntimeDrift · 「运行环境换到这一版了没有」的唯一判据', () => {
  it('全对 → 不漂,而且说得出装着的是哪一版', async () => {
    const { paths } = goodHome()
    const state = await readRuntimeDrift(nodeSetupIo(), paths.runtimeDir)
    expect(state.drifted).toBe(false)
    expect(state.locked).toBe(LOCKED_DSH_VERSION)
    expect(state.installed).toBe(LOCKED_DSH_VERSION)
    expect(state.detail).toBe('')
    expect(state.says).toBeUndefined()
  })

  it('★顶层 dsh 是旧版(09-26 那台机器)→ 漂,并说得出两个版本号', async () => {
    const { paths } = driftedHome()
    const state = await readRuntimeDrift(nodeSetupIo(), paths.runtimeDir)
    expect(state.drifted).toBe(true)
    expect(state.installed).toBe('0.1.2-rc.1')
    expect(state.locked).toBe(LOCKED_DSH_VERSION)
    expect(state.says).toContain('0.1.2-rc.1')
    expect(state.says).toContain(LOCKED_DSH_VERSION)
    // 那句话是给不懂代码的人看的:不出现内部词。
    for (const word of ['npm', '锁文件', '依赖树', 'package.json', 'profile']) {
      expect(state.says, word).not.toContain(word)
    }
  })

  it('运行时目录整个不在 → 也算漂(要做的事一样:装一次运行环境),装着的那一版缺席不猜', async () => {
    const home = box()
    const state = await readRuntimeDrift(nodeSetupIo(), setupPaths({ home }).runtimeDir)
    expect(state.drifted).toBe(true)
    expect(state.installed).toBeUndefined()
    expect(state.says).toContain('还没装上')
  })

  it('传递依赖漂了(09-23 cordis 那次)也算漂,逐项说清', async () => {
    const { paths } = goodHome()
    seedLockedRuntime(paths.runtimeDir, { '@deepseek-ai/cordis': '4.0.2' })
    const state = await readRuntimeDrift(nodeSetupIo(), paths.runtimeDir)
    expect(state.drifted).toBe(true)
    // 顶层 dsh 版本是对的 —— 「换没换版本」与「依赖漂没漂」是同一个判断。
    expect(state.installed).toBe(LOCKED_DSH_VERSION)
    expect(state.detail).toContain('@deepseek-ai/cordis 应是 4.0.4,装成了 4.0.2')
  })

  it('humaneDrift:锁定版本读不出来时也说得出一句话(不回空串)', () => {
    expect(humaneDrift('', undefined)).toContain('还没装上')
    expect(humaneDrift('0.1.7-rc.2', '0.1.2-rc.1')).toContain('装着的是 0.1.2-rc.1')
  })
})

/* ════════════════════ 二、检查更新同时比运行环境 ════════════════════ */

describe('check() · 插件版本相同 + 运行环境落后', () => {
  it('★算「有更新」,而且标成只补运行环境', async () => {
    const { home } = driftedHome()
    const update = serviceOn(home, { currentVersion: '0.4.0' })
    const view = await update.check()
    expect(view.available).toBe(true)
    expect(view.runtime_only).toBe(true)
    // 版本号没变:这一格如实说"服务器上也是 0.4.0"。
    expect(view.latest).toBe('0.4.0')
    expect(view.current).toBe('0.4.0')
  })

  it('★这一趟的账里只有运行环境那一件 —— 不重下那 350MB 的通话组件', async () => {
    const { home } = driftedHome()
    const update = serviceOn(home, { currentVersion: '0.4.0' })
    const view = await update.check()
    expect(view.plan?.items.map(item => item.kind)).toEqual(['runtime_tgz'])
    expect(view.plan?.changed).toBe(1)
    expect(view.size).toBe(40_000)
  })

  it('★「这一版说了什么」换成我们自己那句人话:为什么还要装、要多久、会不会重启', async () => {
    const { home } = driftedHome()
    const update = serviceOn(home, { currentVersion: '0.4.0' })
    const view = await update.check()
    expect(view.notes).not.toBe('这一版改了什么,发版的人写的那一段')
    expect(view.notes).toContain('运行环境')
    expect(view.notes).toContain('几十秒')
    expect(view.notes).toContain('重启')
    expect(view.notes).toContain('0.1.2-rc.1')
  })

  it('手机包那一格**不给** —— 只补运行环境时手机包一个字节没变,说"有新的"等于骗他重下一份一样的', async () => {
    const { home } = driftedHome()
    const update = serviceOn(home, {
      currentVersion: '0.4.0',
      manifest: manifest({
        assets: {
          ...manifest().assets,
          apk: { url: 'http://127.0.0.1:9/updates/0.4.0/app.apk', sha256: 'd'.repeat(64), size: 32_000_000 },
        },
      }),
    })
    await update.check()
    expect(update.apk()).toBeUndefined()
  })

  it('★老清单没带 runtime_tgz → 不算有更新(那一趟跑起来一步也不会跑)', async () => {
    const { home } = driftedHome()
    const noRuntime = manifest({ assets: { plugin_tgz: { url: 'http://127.0.0.1:9/updates/0.4.0/p.tgz', sha256: SHA, size: 1_000 } } })
    const update = serviceOn(home, { currentVersion: '0.4.0', manifest: noRuntime })
    const view = await update.check()
    expect(view.available).toBe(false)
    expect(view.runtime_only).toBeUndefined()
    // 按钮不给了,但这件事没被藏起来:体检那一项照样认得出来(readRuntimeDrift 是同一个判据)。
    expect((await readRuntimeDrift(nodeSetupIo(), setupPaths({ home }).runtimeDir)).drifted).toBe(true)
  })

  it('运行环境是对的 → 照旧只比插件版本号(既有行为一个字没变)', async () => {
    const { home } = goodHome()
    const same = await serviceOn(home, { currentVersion: '0.4.0' }).check()
    expect(same.available).toBe(false)
    expect(same.runtime_only).toBeUndefined()
    expect(same.notes).toBe('这一版改了什么,发版的人写的那一段')

    const older = await serviceOn(home, { currentVersion: '0.3.6' }).check()
    expect(older.available).toBe(true)
    expect(older.runtime_only).toBeUndefined()
    // 插件真有新版那一趟照旧是整份账(三件都在)。
    expect(older.plan?.items.length).toBe(3)
  })

  it('插件真有新版 + 运行环境也落后 → 走正常那一趟(整份账),不降级成"只补运行环境"', async () => {
    const { home } = driftedHome()
    const view = await serviceOn(home, { currentVersion: '0.3.6' }).check()
    expect(view.available).toBe(true)
    expect(view.runtime_only).toBeUndefined()
    expect(view.plan?.items.map(item => item.kind)).toContain('plugin_tgz')
  })

  it('探漂移这一路自己坏了 → 当"没漂",不凭一个读不出来的结论去改机器', async () => {
    const { home } = driftedHome()
    const paths = setupPaths({ home })
    const real = nodeSetupIo()
    const io: SetupIo = { ...real, fetch: fakeFetch(manifest()) }
    const update = createUpdateService({
      io,
      paths,
      now: () => NOW,
      newId: () => 'job1',
      currentVersion: '0.4.0',
      manifestUrl: 'http://127.0.0.1:9/updates/latest.json',
      runtimeDrift: async () => { throw new Error('读盘炸了') },
    })
    const view = await update.check()
    expect(view.available).toBe(false)
    expect(view.runtime_only).toBeUndefined()
  })

  it('runtimeOnlyNotes 三件事都说到(不懂代码的人看得懂)', () => {
    const says = runtimeOnlyNotes({ installed: '0.1.2-rc.1', locked: '0.1.7-rc.2' })
    expect(says).toContain('0.1.2-rc.1')
    expect(says).toContain('0.1.7-rc.2')
    expect(says).toContain('几十秒')
    expect(says).toContain('重启')
    for (const word of ['npm', 'profile', '锁定清单', '依赖树']) expect(says, word).not.toContain(word)
  })
})

describe('apply() · 只补运行环境那一趟的步骤表', () => {
  it('★只有 profile 与 runtime 两步 —— 插件 / 脚本 / 壳 / launchd 一个都不碰', () => {
    expect(RUNTIME_ONLY_STEPS).toEqual(['profile', 'runtime'])
  })

  it('没查过就按不了(照旧);查过而且是只补运行环境那一档 → 起得来作业', async () => {
    const { home } = driftedHome()
    const update = serviceOn(home, { currentVersion: '0.4.0' })
    expect(update.apply()).toEqual({ error: '还没查过有没有新版。先点一次「检查更新」。' })
    await update.check()
    const started = update.apply()
    expect('error' in started).toBe(false)
  })

  it('运行环境也对、插件也不旧 → 照旧拒(「已经是最新的了」)', async () => {
    const { home } = goodHome()
    const update = serviceOn(home, { currentVersion: '0.4.0' })
    await update.check()
    expect(update.apply()).toEqual({ error: '已经是最新的了(0.4.0)。' })
  })
})

/* ═══════════════ 三、启动就看得见(/state.update.runtime_stale) ═══════════════ */

describe('lastCheck() · /state 里那一格', () => {
  it('★从没查过清单(刚开机 / 没网)也带着那一格 —— 它读的是本机的运行时目录', async () => {
    const { home } = driftedHome()
    const paths = setupPaths({ home })
    const io = nodeSetupIo()
    const update = createUpdateService({
      io,
      paths,
      now: () => NOW,
      newId: () => 'job1',
      currentVersion: '0.4.0',
      manifestUrl: 'http://127.0.0.1:9/updates/latest.json',
      runtimeStale: () => ({
        says: 'DSH 运行环境还没换到这一版(装着的是 0.1.2-rc.1,这一版要 0.1.7-rc.2)。',
        locked: '0.1.7-rc.2',
        installed: '0.1.2-rc.1',
        action_label: RUNTIME_REPAIR_LABEL,
      }),
    })
    const state = update.lastCheck()
    // 「有没有新版」如实说不知道(没查过),但那一格已经在了。
    expect(state?.available).toBe(false)
    expect(state?.latest).toBeUndefined()
    expect(state?.runtime_stale?.installed).toBe('0.1.2-rc.1')
    expect(state?.runtime_stale?.action_label).toBe('装运行环境')
  })

  it('运行环境没问题时那一格缺席(不编一个空对象出来)', async () => {
    const { home } = goodHome()
    const update = serviceOn(home, { currentVersion: '0.4.0' })
    expect(update.lastCheck()).toBeUndefined()
    await update.check()
    expect(update.lastCheck()?.runtime_stale).toBeUndefined()
  })
})

/* ════════════════ 四、老客户端升上来那条路:自动补 + 防循环 ════════════════ */

interface RepairHarness {
  home: string
  paths: ReturnType<typeof setupPaths>
  steps: SetupInstallStep[]
  notices: { key: string, title: string, body: string }[]
  service: ReturnType<typeof createRuntimeRepair>
  ledger: () => RuntimeRepairLedger | undefined
}

/**
 * 一台漂着的机器 + 一套假的一键装。
 * @param options.failAt  哪一步要失败(装运行环境失败那一幕)。
 * @param options.fixOn   跑到哪一步时把运行时目录补对(装成功那一幕)。
 */
function repairHarness(options: {
  home?: string
  failAt?: SetupInstallStep
  fixOn?: SetupInstallStep
  maxAttempts?: number
  autoRepair?: boolean
} = {}): RepairHarness {
  const home = options.home ?? driftedHome().home
  const paths = setupPaths({ home })
  const steps: SetupInstallStep[] = []
  const notices: RepairHarness['notices'] = []
  const jobs = new Map<string, SetupJobView>()
  let seq = 0
  const service = createRuntimeRepair({
    io: nodeSetupIo(),
    paths,
    now: () => NOW,
    newId: () => `repair${(seq += 1)}`,
    install: (step) => {
      steps.push(step)
      if (options.fixOn === step) seedLockedRuntime(paths.runtimeDir)
      const view: SetupJobView = {
        id: `sub-${step}-${steps.length}`,
        step,
        state: options.failAt === step ? 'failed' : 'done',
        started_at: new Date(NOW).toISOString(),
        finished_at: new Date(NOW).toISOString(),
        tail: [`(假的)${step} 的输出`],
        ...(options.failAt === step ? { error: 'npm 装不出来(假的)' } : { note: `${step} 好了` }),
      }
      jobs.set(view.id, view)
      return view
    },
    waitJob: async () => {},
    notify: notice => notices.push(notice),
    probeMs: 0,
    subPollMs: 0,
    ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
    ...(options.autoRepair === undefined ? {} : { autoRepair: options.autoRepair }),
  })
  return {
    home,
    paths,
    steps,
    notices,
    service,
    ledger: () => {
      try { return JSON.parse(readFileSync(paths.runtimeRepairJson, 'utf8')) as RuntimeRepairLedger }
      catch { return undefined }
    },
  }
}

/** pump 是 fire-and-forget 的;让它把那一串 await 跑完。 */
async function settle(): Promise<void> {
  // 真读盘的那十几个 await 要靠计时器轮转才跟得上(光 setImmediate 不够)。
  for (let i = 0; i < 60; i += 1) await new Promise(resolve => setTimeout(resolve, 0))
}

describe('runtimeRepair · 启动发现漂移', () => {
  it('★探到漂移:弹一条通知 + 自动跑 profile → runtime → restart', async () => {
    const h = repairHarness({ fixOn: 'runtime' })
    h.service.pump()
    await settle()
    expect(h.steps).toEqual([...RUNTIME_REPAIR_STEPS])
    expect(h.steps).toEqual(['profile', 'runtime', 'restart'])
    const notice = h.notices.find(one => one.key === RUNTIME_DRIFT_NOTICE_KEY)
    expect(notice?.title).toContain('运行环境')
    expect(notice?.body).toContain('自动装')
    expect(notice?.body).toContain('重启')
  })

  it('★重启之前状态就落成「装好了,正在重启」—— 那一下会把这个进程杀掉,界面得来得及看见', async () => {
    const h = repairHarness({ fixOn: 'runtime' })
    h.service.pump()
    await settle()
    const job = h.service.job('repair1')
    expect(job?.state).toBe('done')
    expect(job?.note).toContain('正在重启')
    expect(job?.step).toBe('runtime')
  })

  it('★这一趟记进账里(防循环):先记再动手', async () => {
    const h = repairHarness({ fixOn: 'runtime' })
    h.service.pump()
    await settle()
    expect(h.ledger()?.attempts).toBe(1)
    expect(h.ledger()?.locked).toBe(LOCKED_DSH_VERSION)
  })

  it('★账满了就不再自动动手(不然「探到 → 装 → 重启 → 探到」会一直转),按钮还在', async () => {
    const home = driftedHome().home
    const paths = setupPaths({ home })
    mkdirSync(join(home, '.dsh/workbench'), { recursive: true })
    writeFileSync(paths.runtimeRepairJson, JSON.stringify({
      locked: LOCKED_DSH_VERSION, attempts: 2, last_error: 'npm 装不出来(假的)',
    }))
    const h = repairHarness({ home })
    h.service.pump()
    await settle()
    expect(h.steps).toEqual([])
    const view = h.service.view()
    expect(view?.repair?.state).toBe('stopped')
    expect(view?.repair?.says).toContain('不再自动试')
    expect(view?.repair?.attempts).toBe(2)
    // 按钮还在 —— 他自己按不受这条限制(那是他的决定,不是我们的循环)。
    expect(view?.action_label).toBe(RUNTIME_REPAIR_LABEL)
    const started = h.service.start()
    expect('error' in started).toBe(false)
    await settle()
    expect(h.steps).toEqual(['profile', 'runtime', 'restart'])
  })

  it('★锁定版本换了 → 账从头算(上一版试过两次不该拖累下一版)', async () => {
    const home = driftedHome().home
    const paths = setupPaths({ home })
    mkdirSync(join(home, '.dsh/workbench'), { recursive: true })
    writeFileSync(paths.runtimeRepairJson, JSON.stringify({ locked: '0.1.2-rc.1', attempts: 9 }))
    const h = repairHarness({ home, fixOn: 'runtime' })
    h.service.pump()
    await settle()
    expect(h.steps).toEqual(['profile', 'runtime', 'restart'])
    expect(h.ledger()?.attempts).toBe(1)
  })

  it('★装运行环境失败:停在这里、不自动重试、说人话,并且明说"在用的那一份没被动过"', async () => {
    const h = repairHarness({ failAt: 'runtime' })
    h.service.pump()
    await settle()
    // restart 没跑 —— 装失败绝不重启。
    expect(h.steps).toEqual(['profile', 'runtime'])
    const job = h.service.job('repair1')
    expect(job?.state).toBe('failed')
    expect(job?.error).toContain('npm 装不出来')
    expect(job?.error).toContain('没有被动过')
    expect(job?.tail.length).toBeGreaterThan(0)
    expect(h.notices.some(one => one.key.endsWith('_failed') && one.body.includes(RUNTIME_REPAIR_LABEL))).toBe(true)
    expect(h.ledger()?.last_error).toContain('npm 装不出来')
    // 再泵一拍也不会自动来第二趟。
    h.service.pump()
    await settle()
    expect(h.steps).toEqual(['profile', 'runtime'])
  })

  it('★灰度实例(autoRepair:false)只亮那一格、不自己动手 —— 重启那一步会去重启生产那个 DSH', async () => {
    const h = repairHarness({ autoRepair: false })
    h.service.pump()
    await settle()
    expect(h.steps).toEqual([])
    expect(h.notices[0]?.body).toContain(RUNTIME_REPAIR_LABEL)
    // 他自己按照样能补(那是他的决定)。
    const started = h.service.start()
    expect('error' in started).toBe(false)
    await settle()
    expect(h.steps).toEqual(['profile', 'runtime', 'restart'])
  })

  it('maxAttempts=0(关掉自动补)→ 只弹通知 + 亮按钮,一步都不自己跑', async () => {
    const h = repairHarness({ maxAttempts: 0 })
    h.service.pump()
    await settle()
    expect(h.steps).toEqual([])
    expect(h.notices[0]?.body).toContain(RUNTIME_REPAIR_LABEL)
    expect(h.service.view()?.says).toContain('0.1.2-rc.1')
  })

  it('没漂的机器:不探出东西、不弹通知、不动手,那一格缺席', async () => {
    const h = repairHarness({ home: goodHome().home })
    h.service.pump()
    await settle()
    expect(h.steps).toEqual([])
    expect(h.notices).toEqual([])
    expect(h.service.view()).toBeUndefined()
    expect(h.service.start()).toEqual({ error: '运行环境已经是这一版要的那一份了,不用再装。' })
  })

  it('补上之后那一格自己收掉(下一拍探到"不漂了")', async () => {
    const h = repairHarness({ fixOn: 'runtime' })
    h.service.pump()
    await settle()
    expect(h.service.view()).toBeDefined()
    await h.service.refresh()
    expect(h.service.view()).toBeUndefined()
  })
})
