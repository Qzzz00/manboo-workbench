/**
 * 窗位清单的默认值随探测走(2026-09-17「每个区域单独解锁」第 3 条)。
 *
 * Ben 的原话是「没装的那家默认不出现在窗位清单(不是删)」。这里守的正是那个括号:
 * APP_COMMANDS 那张调研实测表一行不删,变的只是**清单层面的可见性**;而"默认"只能管默认,
 * 他亲手加过的、亲手删过的,探测说什么都不作数。
 */
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BASE_KEYS, createAppsRegistry, loadAppsFile } from '../src/server/appsRegistry.ts'
import { APP_BUNDLES } from '../src/server/activation.ts'
import { APP_COMMANDS } from '../src/server/apps.ts'

async function tmpFile(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'apps-unlock-')), 'apps.json')
}

const noOsascript = async () => ({ ok: false, stdout: '' })

function keysOf(list: readonly { key: string }[]): string[] {
  return list.map(row => row.key)
}

describe('disabled 默认值随探测走', () => {
  it('★没接扫描(installedKeys 不传)时清单跟这一版之前一模一样——七家全在', async () => {
    const registry = createAppsRegistry({ file: await tmpFile(), runOsascript: noOsascript })
    expect(keysOf(await registry.list())).toEqual([...BASE_KEYS])
  })

  it('★扫描服务在、但还没扫出结果(undefined)时也是七家全在——"没查过"不等于"没有"', async () => {
    const registry = createAppsRegistry({
      file: await tmpFile(), runOsascript: noOsascript, installedKeys: () => undefined,
    })
    expect(keysOf(await registry.list())).toHaveLength(BASE_KEYS.length)
  })

  it('只扫到 Claude 与微信 → 清单里只剩这两家 + 终端/日历(系统自带的不受探测管)', async () => {
    const registry = createAppsRegistry({
      file: await tmpFile(), runOsascript: noOsascript,
      installedKeys: () => new Set(['claude', 'wechat']),
    })
    expect(keysOf(await registry.list())).toEqual(['claude', 'wechat', 'term', 'calendar'])
  })

  it('★没扫到的那家不是被"删"了:apps.json 里一个字都没写', async () => {
    const file = await tmpFile()
    const registry = createAppsRegistry({
      file, runOsascript: noOsascript, installedKeys: () => new Set(['claude']),
    })
    await registry.list()
    // 只读不写:文件压根没被建出来(读不到时 loadAppsFile 回空清单)。
    await expect(readFile(file, 'utf8')).rejects.toThrow()
    const data = await loadAppsFile(file)
    expect(data.disabled).toEqual([])
    expect(data.enabled).toEqual([])
  })

  it('探测说装了,但他亲手删过 → 仍然不出现(disabled 压过探测)', async () => {
    const file = await tmpFile()
    const registry = createAppsRegistry({
      file, runOsascript: noOsascript, installedKeys: () => new Set(['claude', 'kimi']),
    })
    expect(await registry.remove('kimi')).toEqual({ ok: true })
    expect(keysOf(await registry.list())).toEqual(['claude', 'term', 'calendar'])
  })
})

describe('手动加过的不被探测覆盖', () => {
  it('★拖一扇 Kimi 窗进来(addResolved)→ 记一笔 enabled,此后探测扫不到它也照样在清单里', async () => {
    const file = await tmpFile()
    let installed = new Set<string>() // 一开始谁都没扫到
    const registry = createAppsRegistry({
      file, runOsascript: noOsascript, installedKeys: () => installed,
    })
    expect(keysOf(await registry.list())).toEqual(['term', 'calendar'])

    // 窗都拖进来了,说明它其实装着——自愈注册回那个基础键,并记一笔"他亲手加过"。
    const added = await registry.addResolved({ bundle_id: APP_BUNDLES.kimi ?? '', name: 'Kimi' })
    expect(added).toEqual({ ok: true, key: 'kimi' })
    expect((await loadAppsFile(file)).enabled).toEqual(['kimi'])

    // mdfind 下一轮照样扫不到(索引没建好 / 装在外置盘)——他不用再加第二次。
    installed = new Set<string>()
    expect(keysOf(await registry.list())).toEqual(['kimi', 'term', 'calendar'])
  })

  it('没扫到的基础键,keyFor 认不出 → 走 addResolved 自愈那条路(「装了自动出现」)', async () => {
    const file = await tmpFile()
    const registry = createAppsRegistry({
      file, runOsascript: noOsascript, installedKeys: () => new Set<string>(),
    })
    expect(await registry.keyFor(APP_BUNDLES.kimi ?? '')).toBeUndefined()
    await registry.addResolved({ bundle_id: APP_BUNDLES.kimi ?? '', name: 'Kimi' })
    expect(await registry.keyFor(APP_BUNDLES.kimi ?? '')).toEqual({ key: 'kimi', label: 'Kimi' })
  })

  it('加回来之后再亲手删掉 → enabled 那一笔跟着抹掉,不留自相矛盾的记录', async () => {
    const file = await tmpFile()
    const registry = createAppsRegistry({
      file, runOsascript: noOsascript, installedKeys: () => new Set(['kimi']),
    })
    await registry.addResolved({ bundle_id: APP_BUNDLES.kimi ?? '', name: 'Kimi' })
    await registry.remove('kimi')
    const data = await loadAppsFile(file)
    expect(data.enabled).toEqual([])
    expect(data.disabled).toEqual(['kimi'])
  })

  it('自定义应用(c-*)完全不受探测影响', async () => {
    const file = await tmpFile()
    const registry = createAppsRegistry({
      file,
      runOsascript: async () => ({ ok: true, stdout: 'so.notion.app\n' }),
      installedKeys: () => new Set<string>(),
    })
    await registry.add('Notion')
    expect(keysOf(await registry.list())).toEqual(['term', 'calendar', 'c-notion'])
  })
})

describe('没装的那家拿不到命令', () => {
  it('commandFor / bundleFor 对没扫到的基础键回 undefined —— 免得 `open -b <没装的那家>` 弹一个系统报错框', async () => {
    const registry = createAppsRegistry({
      file: await tmpFile(), runOsascript: noOsascript, installedKeys: () => new Set(['claude']),
    })
    expect(await registry.commandFor('kimi')).toBeUndefined()
    expect(await registry.bundleFor('kimi')).toBeUndefined()
    expect(await registry.commandFor('claude')).toEqual(APP_COMMANDS.claude)
    // 系统自带的两家永远给得出命令(一律按包标识,见 `APP_COMMANDS`)。
    expect(await registry.commandFor('term')).toEqual(APP_COMMANDS.term)
  })
})

describe('老 apps.json 的容错', () => {
  it('没有 enabled 这个键的老文件按空数组读,不当成读坏了', async () => {
    const file = await tmpFile()
    const { writeFile, mkdir } = await import('node:fs/promises')
    const { dirname } = await import('node:path')
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify({ version: 1, apps: [], disabled: ['calendar'] }))
    const data = await loadAppsFile(file)
    expect(data.enabled).toEqual([])
    expect(data.disabled).toEqual(['calendar'])
  })
})
