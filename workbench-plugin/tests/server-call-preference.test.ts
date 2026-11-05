// @vitest-environment node
/**
 * 「她说记住了,就必须真的记住」(2026-09-23,Ben 第五通真机)。
 *
 * 那一通里他三次说「这个我记着了」「记住」,而工人**什么都没落盘** —— 下一通照旧。
 * 这一份钉的是那条出口:`POST /butler/memory/preference` 把一条**以后都算数**的规矩
 * 写进 `~/.dsh/AGENTS.md` 的标记段,下一通电话由 `GET /channel/persona` 读回系统提示。
 *
 * 四条:
 *   ① 写进去的是标记段,**段外一个字不动**;
 *   ② 同一条说两遍不会攒成两条(他每通都会重复一遍);
 *   ③ `kind=address` 写的是「称呼」那张表,**不带日期**(日期会被念出来);
 *   ④ 授权表 `write_docs` 不是「可以」时,程序来源吃 403 + 一句人话 ——
 *      **这正是对的**:工人据此照实说「没记上,要你去改哪一行」,而不是假装记住了。
 *
 * 全程在 mkdtemp 出来的临时 HOME 里跑,一个字节都不碰真实的 `~/.dsh`
 * (2026-09-04 家目录被删事故之后的纪律)。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { createAppConfig } from '../src/server/appConfig.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createChannelService } from '../src/server/channel.ts'
import { createAuthorizationService, defaultAuthTable, renderAuthMarkdown } from '../src/server/authorization.ts'
import { CALL_TOOL_DOING, CALL_TOOL_REMEMBER, callAddressesOf, callPreferencesOf } from '../src/server/rtcCall.ts'
import { CALL_ADDRESS_BLOCK, CALL_PREFS_BLOCK, markers } from '../src/server/memoryMd.ts'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '')
const CHANNEL_ENV = { WORKBENCH_CHANNEL_API_KEY: 'devkey', WORKBENCH_CHANNEL_API_SECRET: 'secret' }

const started: WorkbenchServer[] = []
const dirs: string[] = []
afterEach(async () => {
  while (started.length) await started.pop()?.close()
  // **只删自己 mkdtemp 出来的那几个**。
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

interface Served {
  url: string
  agentsFile: string
  agents: () => string
}

async function serve(options: { agents?: string, writeDocs?: '可以' | '要问' | '不可以' } = {}): Promise<Served> {
  const dir = mkdtempSync(join(tmpdir(), 'wb-call-pref-'))
  dirs.push(dir)
  const home = join(dir, 'home')
  const agentsFile = join(home, '.dsh', 'AGENTS.md')
  mkdirSync(join(home, '.dsh'), { recursive: true })
  writeFileSync(agentsFile, options.agents ?? '我叫 周到。\n\n# 事务官\n\n正文不许被动。\n', 'utf8')

  // 授权表:真写一份 Markdown,再由真的 AuthorizationService 读回来(不 stub 那道门)。
  const authFile = join(dir, '授权.md')
  const table = defaultAuthTable()
  table.write_docs = { status: options.writeDocs ?? '可以', date: '2026-09-23' }
  writeFileSync(authFile, renderAuthMarkdown(table, '2026-09-23'), 'utf8')

  const channel = createChannelService({
    agentsFile,
    env: CHANNEL_ENV,
    configFile: join(dir, '不存在.json'),
    nowSeconds: () => 0,
    rememberTool: CALL_TOOL_REMEMBER,
    doingTool: CALL_TOOL_DOING,
  })

  let tick = 0
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({ now: () => 0 }),
    tickIntervalMs: 0,
    heartbeatMs: 0,
    channel,
    authorization: createAuthorizationService({ file: authFile }),
    remoteAddress: () => '127.0.0.1',
    paths: {
      config: createAppConfig({ file: join(dir, 'app.json') }),
      home,
      moduleDir: `${REPO_ROOT}/workbench-plugin/src/server`,
      applyHooks: {
        files: { claude: join(home, '.claude', 'settings.json'), codex: join(home, '.codex', 'hooks.json') },
        now: () => new Date(Date.UTC(2026, 8, 23, 3, 30, tick++)),
      },
    },
  })
  started.push(server)
  const read = (): string => readFileSync(agentsFile, 'utf8')
  /**
   * **等起服务那一下把技能段补完**。工作台起来时会 fire-and-forget 地往同一份 AGENTS.md 里
   * 补一次技能段(server-ops-skills-wire 那份用例钉的就是它)。不等它,这份用例发出去的
   * 第一条请求会和那一下撞在一起 —— 代写那条路「备份对不上就整件作罢」,于是回 409。
   * 那个 409 是**对的**(宁可不写也不写坏),但它不是这份用例要验的东西。
   */
  const settled = async (): Promise<void> => {
    let last = ''
    for (let i = 0; i < 60; i += 1) {
      const now = read()
      if (i > 0 && now === last) return
      last = now
      await new Promise(resolve => setTimeout(resolve, 40))
    }
  }
  await settled()
  return { url: server.url, agentsFile, agents: read }
}

async function post(url: string, path: string, body: unknown): Promise<{ status: number, body: Record<string, any> }> {
  const res = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, body: (text === '' ? {} : JSON.parse(text)) as Record<string, any> }
}

async function getJson(url: string, path: string): Promise<{ status: number, body: Record<string, any> }> {
  const res = await fetch(`${url}${path}`)
  return { status: res.status, body: await res.json() as Record<string, any> }
}

describe('POST /butler/memory/preference:把一条长期偏好写进人设', () => {
  it('★写进「通话偏好」标记段,**段外一个字不动**', async () => {
    const h = await serve()
    const r = await post(h.url, '/butler/memory/preference', { text: '以后别念标题,用人话讲' })
    expect(r.status).toBe(200)
    expect(r.body.added).toBe(true)
    expect(r.body.block).toBe(CALL_PREFS_BLOCK)

    const text = h.agents()
    expect(text).toContain(markers(CALL_PREFS_BLOCK).open)
    expect(callPreferencesOf(text)).toEqual(['以后别念标题,用人话讲(2026-09-23)'])
    // 段外的两样原样还在。
    expect(text.split('\n')[0]).toBe('我叫 周到。')
    expect(text).toContain('正文不许被动。')
  })

  it('★同一条说两遍不攒两条(他每通都会重复一遍),照样回 200', async () => {
    const h = await serve()
    await post(h.url, '/butler/memory/preference', { text: '以后每次先说结论' })
    const again = await post(h.url, '/butler/memory/preference', { text: '以后每次先说结论' })
    expect(again.status).toBe(200)
    expect(again.body.added).toBe(false)
    expect(callPreferencesOf(h.agents())).toHaveLength(1)
  })

  it('★kind=address 写的是「称呼」那张表,而且**不带日期**', async () => {
    const h = await serve()
    expect((await post(h.url, '/butler/memory/preference', { text: '姚总', kind: 'address' })).status).toBe(200)
    const text = h.agents()
    expect(callAddressesOf(text)).toEqual(['姚总'])
    // 日期写进称呼里会被她念出来 ——「姚总二〇二六年九月二十三日」。
    expect(callAddressesOf(text)[0]).not.toContain('2026')
    // 偏好那一段没被顺手建出来:两段各管各的。
    expect(callPreferencesOf(text)).toEqual([])
  })

  it('两条不同的偏好按顺序攒在同一段里', async () => {
    const h = await serve()
    await post(h.url, '/butler/memory/preference', { text: '以后别念标题' })
    await post(h.url, '/butler/memory/preference', { text: '以后每次先说结论' })
    expect(callPreferencesOf(h.agents()).map(one => one.split('(')[0])).toEqual(['以后别念标题', '以后每次先说结论'])
  })

  it('空的 / 太长的一律 400,人设一个字没动', async () => {
    const h = await serve()
    const before = h.agents()
    expect((await post(h.url, '/butler/memory/preference', { text: '   ' })).status).toBe(400)
    expect((await post(h.url, '/butler/memory/preference', { text: '啊'.repeat(201) })).status).toBe(400)
    expect(h.agents()).toBe(before)
  })

  /**
   * ——— 授权这道门(2026-09-23)———
   *
   * 今天 `write_docs` 的缺省是「要问」,所以**程序来源(工人)会吃 403** —— 那是对的。
   * 要紧的是那句话里说得出「去哪儿改」:工人拿到它会照实告诉他,而不是说「我记在脑子里」。
   */
  it('★write_docs 不是「可以」→ 403 + 一句说得出去哪儿改的人话,人设一个字没动', async () => {
    for (const status of ['要问', '不可以'] as const) {
      const h = await serve({ writeDocs: status })
      const before = h.agents()
      const r = await post(h.url, '/butler/memory/preference', { text: '以后别念标题' })
      expect(r.status).toBe(403)
      expect(String(r.body.error)).toContain('docs/记忆/授权.md')
      expect(String(r.body.error)).toContain('write_docs')
      expect(h.agents()).toBe(before)
    }
  })
})

describe('GET /channel/persona:写进去的下一通就算数', () => {
  it('★偏好进系统提示,称呼表单独给一格', async () => {
    const h = await serve()
    await post(h.url, '/butler/memory/preference', { text: '以后别念标题,用人话讲' })
    await post(h.url, '/butler/memory/preference', { text: '老板', kind: 'address' })
    await post(h.url, '/butler/memory/preference', { text: '姚总', kind: 'address' })

    const { status, body } = await getJson(h.url, '/channel/persona')
    expect(status).toBe(200)
    // 2026-10-02:称谓按称呼表(表里第一个是「老板」),不写死「他」。
    expect(String(body.system_message)).toContain('老板以前在电话里说过、以后都算数的')
    expect(String(body.system_message)).toContain('以后别念标题,用人话讲')
    expect(body.addresses).toEqual(['老板', '姚总'])
  })

  it('一条都没写过:偏好那段整个缺席、称呼那一格也缺席(不编一份缺省)', async () => {
    const h = await serve()
    const { body } = await getJson(h.url, '/channel/persona')
    expect(String(body.system_message)).not.toContain('以前在电话里说过')
    expect(body.addresses).toBeUndefined()
  })

  /** 人设里那三条「别像机器人」的规矩:它们不靠 Ben 说,是写死在提示词里的。 */
  it('★「不要套公式 / 不要自我介绍 / 不要念标题」写在说话的规矩里', async () => {
    const h = await serve()
    const { body } = await getJson(h.url, '/channel/persona')
    const message = String(body.system_message)
    expect(message).toContain('不要套公式')
    expect(message).toContain('不要自我介绍')
    expect(message).toContain('不要把标题原样念出来')
  })

  /** 2026-09-23 新加的那几件工具要在人设里教一遍,否则模型不知道自己能派单、能换音色。 */
  // 2026-10-28(A2):需求卡并进派活,写板子那几件 = 理解中枢命令表(wb_dispatch / wb_remember / wb_reassign…)。
  it('★人设里教得出派活、换音色、记偏好、转本体、卡与目标的其余几件', async () => {
    const h = await serve()
    const message = String((await getJson(h.url, '/channel/persona')).body.system_message)
    for (const tool of ['wb_dispatch', 'wb_set_voice', 'wb_remember', 'wb_ask_butler', 'wb_reassign', 'wb_goal_status', 'wb_cancel', 'wb_confirm']) {
      expect(message).toContain(tool)
    }
    // 授权不放行时该说什么,也写在人设里(不是只在工具的回话里)。
    expect(message).toContain('没有这项授权')
  })

  /** 2026-09-23 `fix/call-remember-direct`:「记下来」只记,不开会话;「去办」才交给本体。 */
  it('★人设把「记」和「办」分给两件工具,不再教一件已经没有的 wb_create_item', async () => {
    const h = await serve()
    const message = String((await getJson(h.url, '/channel/persona')).body.system_message)
    const rememberLine = message.split('\n').find(line => line.includes('wb_remember_item')) ?? ''
    expect(rememberLine).toContain('记下来')
    // 2026-10-02:同一条规矩,话不再把自己说成第三个人(只有一个「我」)。
    expect(message).toContain('只是记,不派活')
    expect(message).not.toContain('不交给事务官办')
    expect(message).toContain('只是记一下的事不要用它')
    expect(message).not.toContain('wb_create_item')
    // 以前那句「这条事项会同时在 DSH 里开一条会话」挂在 remember 上 —— 不许再出现。
    expect(message).not.toContain('这条事项会同时在 DSH 里开一条会话')
  })
})
