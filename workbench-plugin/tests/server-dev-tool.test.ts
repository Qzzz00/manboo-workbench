/**
 * 事务官识别那一段(2026-09-21,分支 feat/custom-module-container)。
 *
 * 钉四件:**认得出**(只认开头,不认"含有")、**复述是切出来的不是生成的**、
 * **产出规范逐条在那条事项里**、**落盘的待确认清单**。
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEV_TOOL_DRAFT } from '../src/protocol.ts'
import {
  checkModuleName, createDevToolStore, devToolAcceptNote, devToolBrief, devToolRestate,
  isDevToolRequest, MAX_PENDING, newModuleId,
} from '../src/server/devTool.ts'

describe('认得出', () => {
  it('★以预填那句开头 = 一次造模块的请求', () => {
    expect(isDevToolRequest(`${DEV_TOOL_DRAFT}一个番茄钟`)).toBe(true)
    // 前面有空白也算(输入框里回车过一次)。
    expect(isDevToolRequest(`\n  ${DEV_TOOL_DRAFT}一个番茄钟`)).toBe(true)
  })

  it('★只认开头,不认"含有"——引用那句话的普通事项不该被劫持', () => {
    expect(isDevToolRequest(`上次那条「${DEV_TOOL_DRAFT}番茄钟」做完了吗`)).toBe(false)
  })

  it('body 里显式写 kind:dev_tool 也算(手机端/通话/以后别的入口)', () => {
    expect(isDevToolRequest('做个今日待发清单', 'dev_tool')).toBe(true)
    expect(isDevToolRequest('做个今日待发清单', 'other')).toBe(false)
    expect(isDevToolRequest('做个今日待发清单')).toBe(false)
  })
})

describe('复述', () => {
  it('★把预填那段切掉,剩下的逐字就是他自己说的话(一个字都不是生成的)', () => {
    expect(devToolRestate(`${DEV_TOOL_DRAFT}一个番茄钟,25 分钟一轮,能看见还剩几分钟`))
      .toBe('一个番茄钟,25 分钟一轮,能看见还剩几分钟')
  })

  it('★他什么都没接着说 → 空串(调用方据此拒绝,不替他编一个需求)', () => {
    expect(devToolRestate(DEV_TOOL_DRAFT)).toBe('')
    expect(devToolRestate(`${DEV_TOOL_DRAFT}   `)).toBe('')
  })

  it('没带那个开头(kind:dev_tool 那条路)时,原话本身就是需求', () => {
    expect(devToolRestate('做个今日待发清单')).toBe('做个今日待发清单')
  })
})

describe('名字与 id', () => {
  it('名字不能空、不能超长、不能换行', () => {
    expect(checkModuleName('番茄钟')).toEqual({ ok: true, name: '番茄钟' })
    expect(checkModuleName('  番茄钟 ')).toEqual({ ok: true, name: '番茄钟' })
    expect(checkModuleName('').ok).toBe(false)
    expect(checkModuleName('   ').ok).toBe(false)
    expect(checkModuleName('一'.repeat(13)).ok).toBe(false)
    expect(checkModuleName('番茄\n钟').ok).toBe(false)
    expect(checkModuleName(undefined).ok).toBe(false)
  })

  it('★id 是 tool-<6 位>,不拿中文名字去转码(转出来不稳定、还会撞)', () => {
    let seed = 0
    const id = newModuleId(() => { seed += 0.137; return seed % 1 })
    expect(id).toMatch(/^tool-[0-9a-z]{6}$/)
  })
})

describe('交给 DSH 的那条事项', () => {
  const brief = devToolBrief({
    need: '一个番茄钟,25 分钟一轮',
    moduleId: 'tool-a1b2c3',
    name: '番茄钟',
    modulesDir: '/Users/example/.dsh/workbench/modules',
    serviceOrigin: 'http://127.0.0.1:8791',
  })

  it('★他的原话在最前面(模型先读到的该是他要的东西,不是我们的交代)', () => {
    expect(brief.startsWith('请做一个工作台自定义模块。用户要的是:一个番茄钟,25 分钟一轮')).toBe(true)
  })

  it('★写到哪、module.json 长什么样,逐字写清', () => {
    expect(brief).toContain('/Users/example/.dsh/workbench/modules/tool-a1b2c3/')
    expect(brief).toContain('"id":"tool-a1b2c3"')
    expect(brief).toContain('"name":"番茄钟"')
    expect(brief).toContain('index.html')
  })

  it('★能用的那几件接口都在,而且明写不给凭据、不给 shell', () => {
    for (const api of ['/state', '/task/create', '/task/move', '/note/add']) expect(brief).toContain(api)
    expect(brief).toContain('不给凭据、不给 shell')
  })

  // 2026-09-22(待拍板 E3):技能/规范文字里也不能再列它,否则模块作者照着写会收到一个 403。
  it('★「在 Finder 里显示」不在技能文字列的那几条里', () => {
    expect(brief).not.toContain('`POST /files/reveal` —— 在 Finder 里打开一个路径')
  })

  it('★2026-09-22:明说"就这九条,别的打不通"(那是一道真门,不是一份规范;2026-10-01 起第八九条给她自己那一版的内置格)', () => {
    expect(brief).toContain('就这九条,别的一条都打不通')
    expect(brief).toContain('POST /xhs/refresh')
    expect(brief).toContain('POST /files/asset-reveal')
    expect(brief).toContain('GET /module/data?name=')
    expect(brief).toContain('不编数')
    expect(brief).toContain('403')
    // 令牌怎么拿:页面里读 WB_MODULE_TOKEN / WB_API_BASE,老写法(相对路径)照样能用。
    expect(brief).toContain('WB_MODULE_TOKEN')
    expect(brief).toContain('WB_API_BASE')
    // sandbox 带来的那一条真话:localStorage 没了,别让 DSH 照着老规范去用它。
    expect(brief).toContain('用不了 localStorage')
  })

  it('★「不许引外网」不是一句请求,而是告诉它 CSP 会拦下来', () => {
    expect(brief).toContain('不许引任何外网地址')
    expect(brief).toContain('CSP')
  })
})

describe('待确认清单(落盘)', () => {
  let dir = ''
  let file = ''

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'wb-devtool-'))
    file = join(dir, 'dev-tools.json')
  })

  afterEach(async () => {
    if (dir !== '' && dir.includes('wb-devtool-')) await rm(dir, { recursive: true, force: true })
  })

  const proposal = (id: string) => ({
    id, request: `${DEV_TOOL_DRAFT}一个番茄钟`, restate: '一个番茄钟',
    module_id: `tool-${id}`, created_at: '2026-09-21T10:00:00+08:00',
  })

  it('★加一条 → 落盘 → 新起一个 store 读得回来(中间隔一次刷新/重启也不用重说)', async () => {
    const store = createDevToolStore({ file })
    await store.load()
    expect(await store.add(proposal('a'))).toEqual({ ok: true })
    expect(JSON.parse(await readFile(file, 'utf8')).pending).toHaveLength(1)

    const again = createDevToolStore({ file })
    await again.load()
    expect(again.pending().map(p => p.id)).toEqual(['a'])
    expect(again.find('a')?.restate).toBe('一个番茄钟')
  })

  it('★文件坏了 = 一条待确认都没有,不抛(读不懂的 json 不该让工作台起不来)', async () => {
    const store = createDevToolStore({ file })
    await store.load() // 文件压根不存在
    expect(store.pending()).toEqual([])
  })

  it('攒到上限就不再收新的(一屏待确认 = 一条都没在办)', async () => {
    const store = createDevToolStore({ file })
    await store.load()
    for (let i = 0; i < MAX_PENDING; i += 1) expect((await store.add(proposal(`p${i}`))).ok).toBe(true)
    const over = await store.add(proposal('over'))
    expect(over.ok).toBe(false)
    expect(over.error).toContain('先把它们处理掉')
  })

  it('drop 掉一条:清单里没了,盘上也没了;drop 一条不存在的回 false', async () => {
    const store = createDevToolStore({ file })
    await store.load()
    await store.add(proposal('a'))
    expect(await store.drop('a')).toBe(true)
    expect(store.pending()).toEqual([])
    expect(JSON.parse(await readFile(file, 'utf8')).pending).toEqual([])
    expect(await store.drop('nope')).toBe(false)
  })
})

/**
 * 验收那一下(2026-10-01,C2:事务官只写交代 + 验收)。**判据只有模块清单**,
 * 不是那一家在回答里说了什么 —— 「我写好了」与「盘上真有这一格」是两件事。
 */
describe('验收(读模块清单)', () => {
  const record = { task_id: 't-1', module_id: 'tool-a1b2c3', name: '我的数据复盘', family: 'codex', at: '2026-10-01T09:00:00+08:00' }

  it('★清单里出现了这一格 = 做好了', () => {
    const got = devToolAcceptNote(record, { moduleIds: ['tool-a1b2c3'], taskStatus: 'doing' })
    expect(got?.done).toBe(true)
    expect(got?.note).toContain('我的数据复盘')
    expect(got?.note).toContain('tool-a1b2c3')
  })

  it('★清单里还没有、那边还在办:什么都不说,接着等(不催、不报喜)', () => {
    expect(devToolAcceptNote(record, { moduleIds: [], taskStatus: 'doing' })).toBeUndefined()
    expect(devToolAcceptNote(record, { moduleIds: ['tool-别的'], taskStatus: 'todo' })).toBeUndefined()
    // 卡找不着了(她刚删了):也当还在等,下一拍再看。
    expect(devToolAcceptNote(record, { moduleIds: [] })).toBeUndefined()
  })

  it('★那边收工了而清单里还是没有:如实说没落盘,**不把「派完了」说成「做好了」**', () => {
    for (const status of ['confirm', 'done', 'blocked']) {
      const got = devToolAcceptNote(record, { moduleIds: [], taskStatus: status })
      expect(got?.done, status).toBe(true)
      expect(got?.note, status).toContain('没按交代落到盘上')
    }
    expect(devToolAcceptNote(record, { moduleIds: [], taskStatus: 'canceled' })?.note).toContain('取消了')
  })
})

describe('派活记录(落盘,验收要跨重启)', () => {
  it('★记一条 → 再 load 一次还在;验收过了就不再等', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wb-devtool-dispatched-'))
    try {
      const file = join(dir, 'dev-tools.json')
      const store = createDevToolStore({ file })
      await store.load()
      expect(store.dispatched()).toEqual([])
      const record = { task_id: 't-1', module_id: 'tool-a1b2c3', name: '番茄钟', family: 'codex', at: '2026-10-01T09:00:00+08:00' }
      await store.markDispatched(record)

      const again = createDevToolStore({ file })
      await again.load()
      expect(again.dispatched()).toEqual([record])

      expect(await again.dropDispatched('tool-a1b2c3')).toBe(true)
      expect(await again.dropDispatched('tool-a1b2c3')).toBe(false)
      const third = createDevToolStore({ file })
      await third.load()
      expect(third.dispatched()).toEqual([])
    }
    finally { await rm(dir, { recursive: true, force: true }) }
  })
})
