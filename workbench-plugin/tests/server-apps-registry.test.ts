import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BASE_APP_LABELS, BASE_KEYS, createAppsRegistry, defaultAppsFile } from '../src/server/appsRegistry.ts'
import { APP_COMMANDS } from '../src/server/apps.ts'

async function tmpFile(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'apps-registry-')), 'apps.json')
}

function fakeOsascript(bundleByName: Record<string, string>) {
  return async (cmd: readonly string[]) => {
    const script = cmd[2] ?? ''
    const match = /id of app "(.+)"/.exec(script)
    const name = match?.[1]
    if (name === undefined) return { ok: false, stdout: '' }
    const bundleId = bundleByName[name]
    return bundleId === undefined ? { ok: false, stdout: '' } : { ok: true, stdout: `${bundleId}\n` }
  }
}

describe('appsRegistry(spec S4:窗口槽应用可增删)', () => {
  it('defaultAppsFile 落在 ~/.dsh/workbench/apps.json', () => {
    expect(defaultAppsFile('/Users/example')).toBe('/Users/example/.dsh/workbench/apps.json')
  })

  /**
   * ★ 2026-09-27(卡 HC「不写死各家 AI」):这一条不再逐字抄那张基础键表 ——
   * AI 那几家从知识表(`FAMILY_SOURCES`)长出来,抄第二遍的话新接一家就要改两处
   * (而豆包办公漏掉正是这么来的)。
   *
   * 钉住的仍是**没接探测时清单一家不少**:每个基础键一条、名字取自 `BASE_APP_LABELS`、
   * 一条自定义应用都没有。「没装的不出现」那一档由 server-apps-unlock 与
   * server-no-hardcoded-agents 两份各自钉。
   */
  it('list():基础键一条不少 + 尚未添加任何自定义应用(名字读常量,不写死第二遍)', async () => {
    const registry = createAppsRegistry({ file: await tmpFile(), runOsascript: fakeOsascript({}) })
    const list = await registry.list()
    expect(list).toEqual(BASE_KEYS.map(key => ({ key, label: BASE_APP_LABELS[key] })))
    // 豆包办公在这张表里(维护者:「豆包办公还认不出来呢」);微信双开假设 2026-08-22 起作废。
    expect(list).toContainEqual({ key: 'doubao', label: '豆包办公' })
    expect(list).toContainEqual({ key: 'wechat', label: '微信' })
  })

  it('add():osascript 查到 bundle id → 落盘,list() 里出现新键 c-<slug>', async () => {
    const file = await tmpFile()
    const registry = createAppsRegistry({ file, runOsascript: fakeOsascript({ Notion: 'notion.id' }) })

    const result = await registry.add('Notion')
    expect(result.ok).toBe(true)
    expect(result.key).toBe('c-notion')

    const list = await registry.list()
    expect(list.at(-1)).toEqual({ key: 'c-notion', label: 'Notion' })

    const onDisk = JSON.parse(await readFile(file, 'utf8')) as unknown
    expect(onDisk).toEqual({
      version: 1,
      apps: [{ key: 'c-notion', label: 'Notion', name: 'Notion', bundle_id: 'notion.id' }],
      disabled: [],
      // 2026-09-17「每个区域单独解锁」新增的第三张名单(他亲手加回来的基础键)。
      enabled: [],
    })
  })

  it('add():自定义 label 覆盖默认(即应用名)', async () => {
    const registry = createAppsRegistry({ file: await tmpFile(), runOsascript: fakeOsascript({ Notion: 'notion.id' }) })
    const result = await registry.add('Notion', '笔记')
    expect(result.ok).toBe(true)
    const list = await registry.list()
    expect(list.at(-1)).toEqual({ key: result.key, label: '笔记' })
  })

  it('add():osascript 查不到 bundle id → {ok:false,reason:"找不到应用:xxx"},不落盘、不瞎猜', async () => {
    const file = await tmpFile()
    const registry = createAppsRegistry({ file, runOsascript: fakeOsascript({}) })
    const result = await registry.add('不存在的App')
    expect(result).toEqual({ ok: false, reason: '找不到应用:不存在的App' })
    expect(await registry.list()).toHaveLength(BASE_KEYS.length)
  })

  it('add():bundle id 撞了基础应用(如 Claude 桌面版)→ 拒绝', async () => {
    const registry = createAppsRegistry({
      file: await tmpFile(),
      runOsascript: fakeOsascript({ Claude: 'com.anthropic.claudefordesktop' }),
    })
    const result = await registry.add('Claude')
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('Claude')
  })

  it('add():重复添加同一应用(bundle id 重复)→ 第二次拒绝', async () => {
    const file = await tmpFile()
    const registry = createAppsRegistry({ file, runOsascript: fakeOsascript({ Notion: 'notion.id' }) })
    await registry.add('Notion')
    const second = await registry.add('Notion')
    expect(second.ok).toBe(false)
  })

  // A5:基础应用改为可删(退出清单,不再拒绝)——覆盖搬到下面「A5:基础应用可删」describe。

  it('remove():自定义应用可删除,删完 list() 里消失', async () => {
    const registry = createAppsRegistry({ file: await tmpFile(), runOsascript: fakeOsascript({ Notion: 'notion.id' }) })
    const { key } = await registry.add('Notion')
    expect(await registry.remove(key as string)).toEqual({ ok: true })
    expect(await registry.list()).toHaveLength(BASE_KEYS.length)
  })

  it('remove():不存在的键给出原因「没有这个应用」', async () => {
    const registry = createAppsRegistry({ file: await tmpFile(), runOsascript: fakeOsascript({}) })
    expect(await registry.remove('c-nope')).toEqual({ ok: false, reason: '没有这个应用' })
  })

  it('commandFor/bundleFor:基础键走 APP_COMMANDS/APP_BUNDLES,自定义键走落盘数据', async () => {
    const registry = createAppsRegistry({ file: await tmpFile(), runOsascript: fakeOsascript({ Notion: 'notion.id' }) })
    // 2026-09-28:一律按包标识拉起,基础键的命令只认 `APP_COMMANDS` 这一份(不在用例里写第二遍)。
    expect(await registry.commandFor('claude')).toEqual(APP_COMMANDS.claude)
    expect(await registry.bundleFor('claude')).toBe('com.anthropic.claudefordesktop')

    const { key } = await registry.add('Notion')
    // 自定义应用也按包标识拉(10-08 真机:千问办公的 .app 叫 QwenWorkCN,`open -a 千问办公` 三次没开成)。
    expect(await registry.commandFor(key as string)).toEqual(['open', '-b', 'notion.id'])
    expect(await registry.bundleFor(key as string)).toBe('notion.id')

    expect(await registry.commandFor('c-nope')).toBeUndefined()
    expect(await registry.bundleFor('c-nope')).toBeUndefined()
  })

  it('keyFor:反查基础应用/自定义应用的 bundle_id,查不到就 undefined(不瞎猜)', async () => {
    const registry = createAppsRegistry({ file: await tmpFile(), runOsascript: fakeOsascript({ Notion: 'notion.id' }) })
    expect(await registry.keyFor('com.anthropic.claudefordesktop')).toEqual({ key: 'claude', label: 'Claude' })

    const { key } = await registry.add('Notion')
    expect(await registry.keyFor('notion.id')).toEqual({ key, label: 'Notion' })

    expect(await registry.keyFor('com.unknown.nope')).toBeUndefined()
  })
})

describe('appsRegistry(A5:基础应用可删——退出清单,不动 APP_COMMANDS/APP_BUNDLES 那份调研实测表)', () => {
  it('remove():基础应用现在可删除,list() 里消失,APP_COMMANDS 本身不受影响', async () => {
    const file = await tmpFile()
    const registry = createAppsRegistry({ file, runOsascript: fakeOsascript({}) })

    expect(await registry.remove('calendar')).toEqual({ ok: true })

    const list = await registry.list()
    expect(list.some(a => a.key === 'calendar')).toBe(false)
    expect(list).toHaveLength(BASE_KEYS.length - 1)

    const onDisk = JSON.parse(await readFile(file, 'utf8')) as { disabled: string[] }
    expect(onDisk.disabled).toEqual(['calendar'])
  })

  it('remove():disabled 的基础键 commandFor/bundleFor/keyFor 全部查不到(跟未知键一样)', async () => {
    const registry = createAppsRegistry({ file: await tmpFile(), runOsascript: fakeOsascript({}) })
    await registry.remove('calendar')

    expect(await registry.commandFor('calendar')).toBeUndefined()
    expect(await registry.bundleFor('calendar')).toBeUndefined()
    expect(await registry.keyFor('com.apple.iCal')).toBeUndefined()
  })

  it('remove():重复删除同一个基础键 → {ok:false,reason:"没有这个应用"},不重复记两遍', async () => {
    const file = await tmpFile()
    const registry = createAppsRegistry({ file, runOsascript: fakeOsascript({}) })
    await registry.remove('calendar')

    expect(await registry.remove('calendar')).toEqual({ ok: false, reason: '没有这个应用' })
    const onDisk = JSON.parse(await readFile(file, 'utf8')) as { disabled: string[] }
    expect(onDisk.disabled).toEqual(['calendar'])
  })

  it('旧 apps.json(没有 disabled 字段)容错读成空数组,不当成读坏了', async () => {
    const file = await tmpFile()
    const { writeFile: wf, mkdir } = await import('node:fs/promises')
    const { dirname } = await import('node:path')
    await mkdir(dirname(file), { recursive: true })
    await wf(file, JSON.stringify({ version: 1, apps: [] }))

    const registry = createAppsRegistry({ file, runOsascript: fakeOsascript({}) })
    expect(await registry.list()).toHaveLength(BASE_KEYS.length) // 没有任何键被当成 disabled
  })
})

describe('appsRegistry.addResolved(A2b:自愈注册——壳报来的展示名直接注册,不经 osascript)', () => {
  it('未知 bundle_id → 注册一条新的自定义应用,key 走跟 add() 同一套 uniqueKey 规则', async () => {
    const file = await tmpFile()
    const registry = createAppsRegistry({ file, runOsascript: fakeOsascript({}) })

    const result = await registry.addResolved({ bundle_id: 'com.example.newapp', name: 'NewApp' })
    expect(result).toEqual({ ok: true, key: 'c-newapp' })

    const list = await registry.list()
    expect(list.at(-1)).toEqual({ key: 'c-newapp', label: 'NewApp' })
    const onDisk = JSON.parse(await readFile(file, 'utf8')) as { apps: { bundle_id: string, name: string }[] }
    expect(onDisk.apps.at(-1)).toEqual({ key: 'c-newapp', label: 'NewApp', name: 'NewApp', bundle_id: 'com.example.newapp' })
  })

  it('name 拿不到(空字符串)→ 退回 bundle_id 本身当展示名(D13,不装一个更好看的名字)', async () => {
    const registry = createAppsRegistry({ file: await tmpFile(), runOsascript: fakeOsascript({}) })

    const result = await registry.addResolved({ bundle_id: 'com.example.noname', name: '' })
    expect(result.ok).toBe(true)
    const list = await registry.list()
    expect(list.at(-1)?.label).toBe('com.example.noname')
  })

  it('重复调用同一个 bundle_id(并发拖动/自愈重试撞了)→ 回已有的键,不重复注册', async () => {
    const registry = createAppsRegistry({ file: await tmpFile(), runOsascript: fakeOsascript({}) })
    const first = await registry.addResolved({ bundle_id: 'com.example.dup', name: 'Dup' })

    const second = await registry.addResolved({ bundle_id: 'com.example.dup', name: 'Dup' })
    expect(second).toEqual({ ok: true, key: first.key })
    expect(await registry.list()).toHaveLength(BASE_KEYS.length + 1) // 只有一条,不是两条
  })

  it('bundle_id 命中某个被 disable 过的基础键 → 重新启用,回那个基础键本身,不注册影子应用', async () => {
    const registry = createAppsRegistry({ file: await tmpFile(), runOsascript: fakeOsascript({}) })
    await registry.remove('calendar')
    expect((await registry.list()).some(a => a.key === 'calendar')).toBe(false)

    const result = await registry.addResolved({ bundle_id: 'com.apple.iCal', name: '日历' })
    expect(result).toEqual({ ok: true, key: 'calendar' })

    const list = await registry.list()
    expect(list.some(a => a.key === 'calendar')).toBe(true)
    expect(list).toHaveLength(BASE_KEYS.length) // 没有多出一条自定义应用
  })
})
