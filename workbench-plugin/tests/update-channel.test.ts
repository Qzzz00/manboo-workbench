// @vitest-environment node
/**
 * 两条更新通道(2026-10-21,内测发版底座)。
 *
 * 体验的人只收稳定版(`latest.json`),维护者与统筹收热修(`beta.json`)。钉五件事:
 *
 * 1. 通道决定读哪一份清单;没接通道那一路(既有用例)一律读 `latest.json`,行为不变;
 * 2. 收热修的机器在服务器上还没有 `beta.json` 时照稳定版那份查(稳定版从不落后于热修),并如实标一句;
 * 3. 稳定版那份 404 **不**去读热修 —— 体验的人不能因为服务器缺一个文件就收到热修;
 * 4. 切通道落在 app.json 的 `update_channel`,写完当场按新通道再查一次;更新正跑着时不许切;
 * 5. **切回稳定版不降级**:本机装着的热修版比稳定版新,照实说没有新版,「立即更新」也不给装。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadAppConfigFile } from '../src/server/appConfig.ts'
import { nodeSetupIo, type SetupIo } from '../src/server/setup/io.ts'
import { setupPaths } from '../src/server/setup/paths.ts'
import { appJsonChannelStore, manifestUrlOf } from '../src/server/update/channel.ts'
import { createUpdateService } from '../src/server/update/service.ts'
import { UPDATE_CHANNEL_MANIFEST, type UpdateChannel, type UpdateManifest } from '../src/server/update/types.ts'

const NOW = Date.parse('2026-10-21T04:00:00Z')
const BASE = 'http://127.0.0.1:9/updates'
const BOX_PREFIX = join(tmpdir(), 'wb-update-channel-')

const boxes: string[] = []
afterEach(() => {
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

function manifest(version: string): UpdateManifest {
  return {
    version,
    notes: `${version} 改了什么`,
    assets: {
      plugin_tgz: { url: `${BASE}/${version}/plugin.tgz`, sha256: 'a'.repeat(64), size: 1_200_000 },
    },
  }
}

/** 一个只认这几份文件的假服务器;别的一律 404。记下被问过哪几个地址。 */
function fakeServer(files: Partial<Record<string, UpdateManifest>>): { fetch: typeof fetch, asked: string[] } {
  const asked: string[] = []
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input)
    asked.push(url)
    const name = url.slice(`${BASE}/`.length)
    const body = files[name]
    if (body === undefined) return new Response('{"error":"not found"}', { status: 404 })
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return { fetch: fetchImpl, asked }
}

function serviceOn(options: {
  currentVersion: string
  files: Partial<Record<string, UpdateManifest>>
  channel?: UpdateChannel
  withStore?: boolean
}) {
  const home = box()
  const paths = setupPaths({ home })
  if (options.channel !== undefined) {
    mkdirSync(join(home, '.dsh', 'workbench'), { recursive: true })
    writeFileSync(paths.appJson, JSON.stringify({ version: 1, lan_access: false, update_channel: options.channel }))
  }
  const server = fakeServer(options.files)
  const io: SetupIo = { ...nodeSetupIo(), fetch: server.fetch }
  let seq = 0
  const service = createUpdateService({
    io,
    paths,
    now: () => NOW,
    newId: () => `job${(seq += 1)}`,
    currentVersion: options.currentVersion,
    manifestUrl: `${BASE}/latest.json`,
    ...(options.withStore === false ? {} : { channel: appJsonChannelStore(paths.appJson) }),
  })
  return { service, server, paths, home }
}

describe('manifestUrlOf · 通道 → 清单地址', () => {
  it('稳定版就是原来那个地址;热修是同一个目录下的 beta.json', () => {
    expect(manifestUrlOf(`${BASE}/latest.json`, 'stable')).toBe(`${BASE}/latest.json`)
    expect(manifestUrlOf(`${BASE}/latest.json`, 'hotfix')).toBe(`${BASE}/beta.json`)
    expect(manifestUrlOf('https://api.aibooo.cn/updates/latest.json', 'hotfix')).toBe('https://api.aibooo.cn/updates/beta.json')
  })

  it('两个文件名与发版脚本写的逐字相同(读源头文件比对)', () => {
    const script = readFileSync(join(__dirname, '..', '..', 'deploy', 'publish-update.sh'), 'utf8')
    expect(UPDATE_CHANNEL_MANIFEST.stable).toBe('latest.json')
    expect(UPDATE_CHANNEL_MANIFEST.hotfix).toBe('beta.json')
    expect(script).toContain(`STABLE_MANIFEST_NAME="${UPDATE_CHANNEL_MANIFEST.stable}"`)
    expect(script).toContain(`HOTFIX_MANIFEST_NAME="${UPDATE_CHANNEL_MANIFEST.hotfix}"`)
  })
})

describe('读哪一份清单', () => {
  it('没接通道(既有那一路)→ 只读 latest.json,回包里标 stable', async () => {
    const { service, server } = serviceOn({ currentVersion: '0.4.142', files: { 'latest.json': manifest('0.4.143') }, withStore: false })
    const view = await service.check()
    expect(server.asked).toEqual([`${BASE}/latest.json`])
    expect(view.latest).toBe('0.4.143')
    expect(view.channel).toBe('stable')
  })

  it('app.json 里没配过 → 稳定版', async () => {
    const { service, server } = serviceOn({
      currentVersion: '0.4.142',
      files: { 'latest.json': manifest('0.4.142'), 'beta.json': manifest('0.4.145') },
    })
    const view = await service.check()
    expect(server.asked).toEqual([`${BASE}/latest.json`])
    expect(view.available).toBe(false)
    expect(view.channel).toBe('stable')
  })

  it('收热修 → 读 beta.json,看得见热修版', async () => {
    const { service, server } = serviceOn({
      currentVersion: '0.4.142',
      channel: 'hotfix',
      files: { 'latest.json': manifest('0.4.142'), 'beta.json': manifest('0.4.145') },
    })
    const view = await service.check()
    expect(server.asked).toEqual([`${BASE}/beta.json`])
    expect(view.latest).toBe('0.4.145')
    expect(view.available).toBe(true)
    expect(view.channel).toBe('hotfix')
    expect(view.channel_fallback).toBeUndefined()
    expect(service.lastCheck()?.channel).toBe('hotfix')
  })

  it('★收热修、服务器上还没有 beta.json → 照稳定版那份查,并标一句(不是一条红字)', async () => {
    const { service, server } = serviceOn({
      currentVersion: '0.4.141',
      channel: 'hotfix',
      files: { 'latest.json': manifest('0.4.142') },
    })
    const view = await service.check()
    expect(server.asked).toEqual([`${BASE}/beta.json`, `${BASE}/latest.json`])
    expect(view.error).toBeUndefined()
    expect(view.latest).toBe('0.4.142')
    expect(view.available).toBe(true)
    expect(view.channel).toBe('hotfix')
    expect(view.channel_fallback).toBe(true)
  })

  it('★收稳定版、latest.json 404 → 报错,**不**退去读热修', async () => {
    const { service, server } = serviceOn({
      currentVersion: '0.4.141',
      channel: 'stable',
      files: { 'beta.json': manifest('0.4.145') },
    })
    const view = await service.check()
    expect(server.asked).toEqual([`${BASE}/latest.json`])
    expect(view.available).toBe(false)
    expect(view.error).toContain('404')
  })

  it('app.json 里写了认不出的值(比如 "beta")→ 当没配,收稳定版', async () => {
    const home = box()
    const paths = setupPaths({ home })
    mkdirSync(join(home, '.dsh', 'workbench'), { recursive: true })
    writeFileSync(paths.appJson, JSON.stringify({ version: 1, lan_access: false, update_channel: 'beta' }))
    expect(await appJsonChannelStore(paths.appJson).read()).toBe('stable')
    expect((await loadAppConfigFile(paths.appJson)).update_channel).toBeUndefined()
  })
})

describe('切通道', () => {
  it('切到热修:落进 app.json、别的键原样留着、当场按热修再查一次', async () => {
    const { service, server, paths } = serviceOn({
      currentVersion: '0.4.142',
      channel: 'stable',
      files: { 'latest.json': manifest('0.4.142'), 'beta.json': manifest('0.4.145') },
    })
    writeFileSync(paths.appJson, JSON.stringify({ version: 1, lan_access: true, update_channel: 'stable', diag_report: false }))
    expect((await service.check()).available).toBe(false)
    const switched = await service.setChannel('hotfix')
    expect('error' in switched).toBe(false)
    if ('error' in switched) return
    expect(switched.channel).toBe('hotfix')
    expect(switched.latest).toBe('0.4.145')
    expect(switched.available).toBe(true)
    expect(server.asked.at(-1)).toBe(`${BASE}/beta.json`)
    const saved = JSON.parse(readFileSync(paths.appJson, 'utf8')) as Record<string, unknown>
    expect(saved.update_channel).toBe('hotfix')
    expect(saved.lan_access).toBe(true)
    expect(saved.diag_report).toBe(false)
    expect(await service.channel()).toBe('hotfix')
  })

  it('★切回稳定版不降级:本机 0.4.145(热修),稳定版 0.4.142 → 没有新版,「立即更新」也不装', async () => {
    const { service } = serviceOn({
      currentVersion: '0.4.145',
      channel: 'hotfix',
      files: { 'latest.json': manifest('0.4.142'), 'beta.json': manifest('0.4.145') },
    })
    await service.check()
    const back = await service.setChannel('stable')
    if ('error' in back) throw new Error(back.error)
    expect(back.channel).toBe('stable')
    expect(back.latest).toBe('0.4.142')
    expect(back.available).toBe(false)
    expect(back.components_behind).toBeUndefined()
    const applied = service.apply()
    expect('error' in applied && applied.error).toContain('已经是最新的了')
  })

  it('更新正跑着 → 不许切(装到一半换清单,装出来的是哪一版就说不清了)', async () => {
    const { service } = serviceOn({ currentVersion: '0.4.142', channel: 'hotfix', files: { 'beta.json': manifest('0.4.145') } })
    await service.check()
    const job = service.apply()
    expect('error' in job).toBe(false)
    const out = await service.setChannel('stable')
    expect('error' in out && out.error).toContain('正在更新')
    expect(await service.channel()).toBe('hotfix')
    if (!('error' in job)) await service.waitJob(job.id)
  })

  it('认不出的通道名 → 不写盘,回一句人话', async () => {
    const { service, paths } = serviceOn({ currentVersion: '0.4.142', channel: 'stable', files: { 'latest.json': manifest('0.4.142') } })
    const out = await service.setChannel('beta' as UpdateChannel)
    expect('error' in out).toBe(true)
    expect((JSON.parse(readFileSync(paths.appJson, 'utf8')) as Record<string, unknown>).update_channel).toBe('stable')
  })

  it('没接通道那一路 → 切不了(说清楚),而不是假装切成了', async () => {
    const { service } = serviceOn({ currentVersion: '0.4.142', files: { 'latest.json': manifest('0.4.142') }, withStore: false })
    const out = await service.setChannel('hotfix')
    expect('error' in out).toBe(true)
    expect(await service.channel()).toBe('stable')
  })
})
