// @vitest-environment node
/**
 * 自定义模块的**真边界**(2026-09-22,C7,分支 feat/module-origin)。
 *
 * 2026-09-21 那一版模块页面与工作台同源,于是那张「能用 / 不要碰」的接口表只是一份规范。
 * Ben 拍板走「单开来源 + 白名单」(决策记录 C7 / 交接-0921 第五节第 1 条的第三条路)。
 * 这一份钉的就是那道门真的立起来了:
 *
 *   ① 模块的静态文件**只在另一台监听上**,工作台服务那条老路已经不端文件了;
 *   ② 模块拿主令牌 / 不拿令牌都打不动白名单之外的接口(403 / 401),白名单之内通;
 *   ③ 令牌过期、被吊销(模块移进回收站)当场失效,续期换得到新的;
 *   ④ 跨源头对不对、预检放不放、注入的前言在不在。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createCustomModulesService } from '../src/server/modules.ts'
import { createNotesService } from '../src/server/notes.ts'
import { createTasksService } from '../src/server/tasks.ts'
import {
  DEFAULT_MODULE_PORT, MODULE_API_ROUTES, createModuleTokens, injectModulePrelude,
  isModuleApiAllowed, moduleApiPaths, moduleCsp, modulePrelude,
} from '../src/server/moduleOrigin.ts'
import type { WorkbenchState } from '../src/protocol.ts'

const NOW_SEC = Math.floor(Date.parse('2026-09-22T02:00:00Z') / 1000)
const started: WorkbenchServer[] = []
const dirs: string[] = []

afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-module-origin-'))
  dirs.push(dir)
  return dir
}

const POMODORO = '<!doctype html><html><head><meta charset="utf-8"><title>番茄钟</title></head><body>25:00</body></html>'

function seedModule(root: string, id: string, files: Record<string, string> = { 'index.html': POMODORO }): void {
  mkdirSync(join(root, id), { recursive: true })
  writeFileSync(join(root, id, 'module.json'), JSON.stringify({ version: 1, id, name: '番茄钟', created_at: '2026-09-21T10:00:00+08:00', source: 'dsh' }), 'utf8')
  for (const [name, body] of Object.entries(files)) {
    if (name.includes('/')) mkdirSync(join(root, id, name.slice(0, name.lastIndexOf('/'))), { recursive: true })
    writeFileSync(join(root, id, name), body, 'utf8')
  }
}

/** 可拨的钟,给令牌过期那几条用。 */
let clock = Date.parse('2026-09-22T10:00:00Z')

async function serve(opts: { withOrigin?: boolean } = {}) {
  clock = Date.parse('2026-09-22T10:00:00Z')
  const dir = tmpDir()
  const modulesDir = join(dir, 'modules')
  mkdirSync(modulesDir, { recursive: true })
  const modules = createCustomModulesService({ dir: modulesDir, now: () => clock })
  const tokens = createModuleTokens({ now: () => clock })
  let n = 0
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({ now: () => NOW_SEC }),
    tickIntervalMs: 0,
    modules,
    notes: createNotesService({ file: join(dir, 'notes.json') }),
    tasks: createTasksService({ file: join(dir, 'tasks.json'), now: () => NOW_SEC, newId: () => `t-${++n}` }),
    ...(opts.withOrigin === false ? {} : { moduleOrigin: { port: 0, tokens } }),
  })
  started.push(server)
  return { url: server.url, origin: server.moduleOrigin(), modulesDir, tokens, modules }
}

async function state(url: string): Promise<WorkbenchState> {
  return await (await fetch(`${url}/state`)).json() as WorkbenchState
}

/** 一条"从模块页面里发出来的"请求:origin 是 null(sandbox 之后就是它),带模块令牌。 */
function asModule(token: string | undefined, extra: Record<string, string> = {}): Record<string, string> {
  return {
    origin: 'null',
    ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    ...extra,
  }
}

// ───────────────────────────────────────────────────────────── 纯函数那几条

describe('白名单与 CSP', () => {
  it('★白名单是逐条列全的九条(2026-10-01 起,第八九条给她自己那一版的内置格),前缀通配一条都没有', () => {
    expect(MODULE_API_ROUTES.map(r => `${r.method} ${r.path}`)).toEqual([
      'GET /state',
      'POST /task/create',
      'POST /task/move',
      'POST /task/update',
      'POST /note/add',
      'POST /note/remove',
      'GET /module/data',
      'POST /xhs/refresh',
      'POST /files/asset-reveal',
    ])
    // 第八条只放「刷新」这一下(它受自己那道 10 分钟的闸);登录、翻页那几条一条都不在表上。
    expect(isModuleApiAllowed('POST', '/xhs/login')).toBe(false)
    expect(isModuleApiAllowed('POST', '/xhs/peek')).toBe(false)
    expect(isModuleApiAllowed('GET', '/xhs')).toBe(false)
    // 第九条只收素材文件夹名;**任意路径的 reveal 照旧不在表上**。
    expect(isModuleApiAllowed('POST', '/files/reveal')).toBe(false)
    expect(isModuleApiAllowed('POST', '/topic/open')).toBe(false)
    // 第七条只放读;`/collector/*`(建 / 登录 / 采 / 撤)一条都不在这张表上。
    expect(isModuleApiAllowed('POST', '/module/data')).toBe(false)
    expect(isModuleApiAllowed('POST', '/collector/add')).toBe(false)
    expect(isModuleApiAllowed('POST', '/collector/run')).toBe(false)
    expect(isModuleApiAllowed('GET', '/collector')).toBe(false)
    expect(isModuleApiAllowed('GET', '/state')).toBe(true)
    expect(isModuleApiAllowed('POST', '/state')).toBe(false)   // 方法也要对得上
    expect(isModuleApiAllowed('POST', '/task/delete')).toBe(false)
    expect(isModuleApiAllowed('POST', '/sprint/create')).toBe(false)
    expect(isModuleApiAllowed('POST', '/board/project')).toBe(false)
    expect(isModuleApiAllowed('GET', '/credentials')).toBe(false)
  })

  /**
   * 2026-09-22(待拍板 E3,按统筹建议做)。它是七条里唯一一条会在他屏幕上弹出东西的,
   * 而模块不需要它。**路由本身没删** —— 工作台自己的页面(图谱、素材、随手记文件卡)
   * 照旧走它,那条走的是回环那道门,不经这张表。
   */
  it('★「在 Finder 里显示」不在模块的白名单里了', () => {
    expect(isModuleApiAllowed('POST', '/files/reveal')).toBe(false)
    expect(moduleApiPaths()).not.toContain('/files/reveal')
  })

  it("★CSP 不写 'self':sandbox 之后是不透明来源,'self' 谁都不匹配(模块自己的 css 都会被拦)", () => {
    const csp = moduleCsp({ moduleOrigin: 'http://127.0.0.1:8794', apiOrigin: 'http://127.0.0.1:8791' })
    expect(csp).not.toContain("'self'")
    expect(csp).toContain('script-src http://127.0.0.1:8794 \'unsafe-inline\'')
    // fetch 只能打这两台:模块自己的来源 + 工作台服务。外网一个都没有。
    expect(csp).toContain('connect-src http://127.0.0.1:8794 http://127.0.0.1:8791')
    expect(csp).toContain("object-src 'none'")
    expect(csp).toContain("form-action 'none'")
  })

  it('★注入的前言绝不能落在 doctype 前面(那会让浏览器进怪异模式,布局当场走样)', () => {
    const out = injectModulePrelude(POMODORO, '<script>x</script>')
    expect(out.indexOf('<!doctype html>')).toBe(0)
    // 有 <head> 就紧跟在它后面。
    expect(out).toContain('<head><script>x</script>')

    // 没有 head、只有 html:跟在 <html> 后面。
    expect(injectModulePrelude('<!doctype html><html><body>x', '<script>y</script>'))
      .toBe('<!doctype html><html><script>y</script><body>x')
    // 连 html 都没有:跟在 doctype 后面。
    expect(injectModulePrelude('<!doctype html><p>x', '<script>z</script>'))
      .toBe('<!doctype html><script>z</script><p>x')
    // 什么都没有:塞在最前面。
    expect(injectModulePrelude('<p>x', '<script>w</script>')).toBe('<script>w</script><p>x')
  })

  it('★塞进前言的那几个值里的 `<` 都转义了(不然一个 `</script>` 就把 script 提前关掉)', () => {
    const text = modulePrelude({
      moduleId: 'tool-a1b2c3', token: 'wbm.</script><img src=x>.y',
      apiOrigin: 'http://127.0.0.1:8791', moduleOrigin: 'http://127.0.0.1:8794',
    })
    expect(text).not.toContain('</script><img')
    expect(text).toContain('\\u003c/script>')
    // script 只关一次,而且是在最后。
    expect(text.indexOf('</script>')).toBe(text.length - '</script>'.length)
    expect(text).toContain('WB_API_BASE')
    expect(text).toContain('WB_MODULE_TOKEN')
  })

  it('默认端口是 8794(8791 是工作台服务,3080 是界面)', () => {
    expect(DEFAULT_MODULE_PORT).toBe(8794)
  })
})

describe('模块令牌', () => {
  it('★有效期内反复签给的是同一把 —— 不然 /state 一秒一拍,iframe 的 src 一秒一变就重载了', () => {
    let now = 1_000_000
    const tokens = createModuleTokens({ now: () => now })
    const first = tokens.issue('tool-a1b2c3')
    now += 60_000
    expect(tokens.issue('tool-a1b2c3')).toBe(first)
  })

  it('★过期之后打接口不认了,但还换得到新的(页面开一整天不重载是常态)', () => {
    let now = 1_000_000
    const tokens = createModuleTokens({ now: () => now, ttlMs: 30 * 60 * 1000, sessionMs: 12 * 60 * 60 * 1000 })
    const token = tokens.issue('tool-a1b2c3')
    expect(tokens.verifyApi(token)?.module_id).toBe('tool-a1b2c3')
    now += 31 * 60 * 1000
    expect(tokens.verifyApi(token)).toBeUndefined()
    const fresh = tokens.renew(token)
    expect(fresh).toBeDefined()
    expect(tokens.verifyApi(fresh)?.module_id).toBe('tool-a1b2c3')
    // 总寿命到头:连换都换不了。
    now += 13 * 60 * 60 * 1000
    expect(tokens.renew(fresh)).toBeUndefined()
  })

  it('★吊销当场生效,而且只吊销这一个模块', () => {
    const tokens = createModuleTokens()
    const a = tokens.issue('tool-aaaaaa')
    const b = tokens.issue('tool-bbbbbb')
    tokens.revoke('tool-aaaaaa')
    expect(tokens.verifyApi(a)).toBeUndefined()
    expect(tokens.renew(a)).toBeUndefined()
    expect(tokens.verifyApi(b)?.module_id).toBe('tool-bbbbbb')
  })

  it('签名动过一个字符就不认;别的密钥签的也不认', () => {
    const tokens = createModuleTokens()
    const token = tokens.issue('tool-a1b2c3')
    expect(tokens.verifyApi(`${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`)).toBeUndefined()
    expect(tokens.verifyApi(undefined)).toBeUndefined()
    expect(tokens.verifyApi('wbm.x')).toBeUndefined()
    expect(tokens.verifyApi('不是令牌')).toBeUndefined()
    expect(createModuleTokens().verifyApi(token)).toBeUndefined()
  })
})

// ───────────────────────────────────────────────────────────── 来源隔离

describe('单开来源', () => {
  it('★模块文件在另一个 origin 上,工作台服务那条老路不端文件了', async () => {
    const { url, origin, modulesDir } = await serve()
    seedModule(modulesDir, 'pomodoro')
    expect(origin).toBeDefined()
    expect(new URL(origin as string).port).not.toBe(new URL(url).port)

    // 老路:留了一句能查的话,但一个字节的模块文件都不端。
    const old = await fetch(`${url}/modules/pomodoro/index.html`)
    expect(old.status).toBe(404)
    expect(await old.text()).not.toContain('25:00')
  })

  it('★/state 里每条模块带着那块 iframe 的 src —— 前端不拼这个地址(端口与令牌只有服务端知道)', async () => {
    const { url, origin, modulesDir } = await serve()
    seedModule(modulesDir, 'pomodoro')
    const view = (await state(url)).modules?.[0]
    expect(view?.frame_url).toBeDefined()
    const src = new URL(view?.frame_url as string)
    expect(src.origin).toBe(origin)
    expect(src.pathname).toBe('/modules/pomodoro/index.html')
    expect(src.searchParams.get('wb')?.startsWith('wbm.')).toBe(true)
  })

  it('没配单开来源:frame_url 整条缺席(界面据此一格都不挂,**不退回同源**)', async () => {
    const { url, origin, modulesDir } = await serve({ withOrigin: false })
    seedModule(modulesDir, 'pomodoro')
    expect(origin).toBeUndefined()
    expect((await state(url)).modules?.[0]?.frame_url).toBeUndefined()
    expect((await fetch(`${url}/modules/pomodoro/index.html`)).status).toBe(404)
  })

  it('★入口页面端得出来:带 CSP、带注入的前言、带那把令牌', async () => {
    const { url, origin, modulesDir } = await serve()
    seedModule(modulesDir, 'pomodoro')
    const src = (await state(url)).modules?.[0]?.frame_url as string
    const res = await fetch(src)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('content-security-policy')).toContain(`connect-src ${origin} ${url}`)
    const html = await res.text()
    expect(html).toContain('25:00')            // 模块自己那份一个字没少
    expect(html).toContain('WB_MODULE_TOKEN')  // 前言注进去了
    expect(html.indexOf('<!doctype html>')).toBe(0)
  })

  it('★URL 上那把令牌不对 / 是别的模块的:不端页面,给一句人话而不是白屏', async () => {
    const { origin, modulesDir, tokens } = await serve()
    seedModule(modulesDir, 'pomodoro')
    seedModule(modulesDir, 'other')
    const bad = await fetch(`${origin}/modules/pomodoro/index.html?wb=wbm.x.y`)
    expect(bad.status).toBe(403)
    expect(await bad.text()).toContain('令牌')
    // 拿 other 那把去开 pomodoro:同样不给。
    const wrong = await fetch(`${origin}/modules/pomodoro/index.html?wb=${encodeURIComponent(tokens.issue('other'))}`)
    expect(wrong.status).toBe(403)
  })

  it('★这台监听只端模块文件:别的路径一律 404,没有 /state、没有 /task', async () => {
    const { origin, modulesDir } = await serve()
    seedModule(modulesDir, 'pomodoro')
    for (const path of ['/state', '/credentials', '/task/create', '/', '/modules']) {
      expect((await fetch(`${origin}${path}`)).status, path).toBe(404)
    }
  })

  it('子资源(css/js/图片)照端,不注入也不要令牌 —— 它们只是这个模块自己的文件', async () => {
    const { origin, modulesDir } = await serve()
    seedModule(modulesDir, 'pomodoro', { 'index.html': POMODORO, 'assets/app.css': 'body{color:#fff}' })
    const res = await fetch(`${origin}/modules/pomodoro/assets/app.css`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/css; charset=utf-8')
    expect(await res.text()).toBe('body{color:#fff}')
  })

  it('路径穿越走到新来源上还是穿越', async () => {
    const { origin, modulesDir } = await serve()
    seedModule(modulesDir, 'pomodoro')
    writeFileSync(join(modulesDir, 'secret.json'), '{"token":"不该被读到"}', 'utf8')
    for (const path of ['/modules/pomodoro/../secret.json', '/modules/pomodoro/%2e%2e/secret.json', '/modules/..%2fsecret.json']) {
      const res = await fetch(`${origin}${path}`, { redirect: 'manual' })
      expect(res.status, path).not.toBe(200)
      expect(await res.text(), path).not.toContain('不该被读到')
    }
  })

  it('★续期:拿过期的旧令牌换一把新的;被吊销的换不了', async () => {
    const { origin, tokens, modulesDir } = await serve()
    seedModule(modulesDir, 'pomodoro')
    const token = tokens.issue('pomodoro')
    clock += 31 * 60 * 1000
    const ok = await fetch(`${origin}/__wb/renew`, { method: 'POST', headers: { authorization: `Bearer ${token}` } })
    expect(ok.status).toBe(200)
    const fresh = (await ok.json() as { token: string }).token
    expect(tokens.verifyApi(fresh)?.module_id).toBe('pomodoro')

    tokens.revoke('pomodoro')
    const dead = await fetch(`${origin}/__wb/renew`, { method: 'POST', headers: { authorization: `Bearer ${fresh}` } })
    expect(dead.status).toBe(401)
  })
})

// ───────────────────────────────────────────────────────────── 白名单这道门

describe('模块打工作台接口', () => {
  it('★白名单之内:读 /state、建事项、落随手记,三样都通', async () => {
    const { url, tokens, modulesDir } = await serve()
    seedModule(modulesDir, 'pomodoro')
    const token = tokens.issue('pomodoro')

    const read = await fetch(`${url}/state`, { headers: asModule(token) })
    expect(read.status).toBe(200)
    // 跨源头照发(不然页面读不到),但**不发 Allow-Credentials** —— 模块带不了 cookie。
    expect(read.headers.get('access-control-allow-origin')).toBe('null')
    expect(read.headers.get('access-control-allow-credentials')).toBeNull()

    const made = await fetch(`${url}/task/create`, {
      method: 'POST',
      headers: { ...asModule(token), 'content-type': 'application/json' },
      body: JSON.stringify({ title: '番茄钟走完一轮' }),
    })
    expect(made.status).toBe(200)

    const noted = await fetch(`${url}/note/add`, {
      method: 'POST',
      headers: { ...asModule(token), 'content-type': 'application/json' },
      body: JSON.stringify({ text: '10:00 一轮' }),
    })
    expect(noted.status).toBe(200)
    expect((await state(url)).notes?.some(note => note.text === '10:00 一轮')).toBe(true)
  })

  it('★白名单之外一律 403,一个字都不办 —— 凭据、配对、布局、窗位叠、别的模块', async () => {
    const { url, tokens, modulesDir } = await serve()
    seedModule(modulesDir, 'pomodoro')
    const token = tokens.issue('pomodoro')
    const headers = { ...asModule(token), 'content-type': 'application/json' }

    for (const [method, path] of [
      ['GET', '/credentials'],
      ['GET', '/modules'],
      ['POST', '/pair/start'],
      ['POST', '/layout'],
      ['POST', '/dock/hide'],
      ['POST', '/task/delete'],
      ['POST', '/modules/pomodoro/remove'],
    ] as const) {
      const res = await fetch(`${url}${path}`, {
        method,
        headers,
        ...(method === 'POST' ? { body: '{}' } : {}),
      })
      expect(res.status, `${method} ${path}`).toBe(403)
      expect((await res.json() as { error: string }).error, `${method} ${path}`).toContain('自定义模块用不了这条接口')
    }
    // 真的一个字都没办:那个模块还在。
    expect((await state(url)).modules?.map(m => m.id)).toEqual(['pomodoro'])
  })

  it('★不带令牌也照样降权:回环这一半信任在 Origin 对不上的那一刻就作废了', async () => {
    const { url, modulesDir } = await serve()
    seedModule(modulesDir, 'pomodoro')
    // 白名单之内但没令牌 → 401(不是 200)。
    const read = await fetch(`${url}/state`, { headers: asModule(undefined) })
    expect(read.status).toBe(401)
    // 白名单之外没令牌 → 401,而且当然也没办。
    const pair = await fetch(`${url}/pair/start`, { method: 'POST', headers: asModule(undefined) })
    expect(pair.status).toBe(401)
  })

  it('★`mode:\'no-cors\'` 那种"发出去就不看回什么"的写请求一样拦得住(门在服务端,不在浏览器)', async () => {
    const { url, tokens, modulesDir } = await serve()
    seedModule(modulesDir, 'pomodoro')
    // no-cors 的 POST 在浏览器里 content-type 只能是那三种之一,而且读不到响应 ——
    // 它赌的是"服务端照办"。这里钉的就是:服务端不办。
    const res = await fetch(`${url}/modules/pomodoro/remove`, {
      method: 'POST',
      headers: { ...asModule(tokens.issue('pomodoro')), 'content-type': 'text/plain' },
      body: '{}',
    })
    expect(res.status).toBe(403)
    expect((await state(url)).modules?.map(m => m.id)).toEqual(['pomodoro'])
  })

  it('★模块移进回收站 = 它那把令牌当场作废(那一格 iframe 可能还开着)', async () => {
    const { url, tokens, modulesDir } = await serve()
    seedModule(modulesDir, 'pomodoro')
    const token = tokens.issue('pomodoro')
    expect((await fetch(`${url}/state`, { headers: asModule(token) })).status).toBe(200)

    // 用户在设置里点的那一下(回环,不是模块)。
    expect((await fetch(`${url}/modules/pomodoro/remove`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(200)
    expect((await fetch(`${url}/state`, { headers: asModule(token) })).status).toBe(401)
  })

  it('★令牌过期:白名单之内也 401(页面据此自己去续一把)', async () => {
    const { url, tokens, modulesDir } = await serve()
    seedModule(modulesDir, 'pomodoro')
    const token = tokens.issue('pomodoro')
    clock += 31 * 60 * 1000
    expect((await fetch(`${url}/state`, { headers: asModule(token) })).status).toBe(401)
  })

  it('★预检:白名单里的给跨源头,表外的不给(浏览器据此把请求掐死)', async () => {
    const { url } = await serve()
    const ok = await fetch(`${url}/note/add`, {
      method: 'OPTIONS',
      headers: { origin: 'null', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization' },
    })
    expect(ok.status).toBe(204)
    expect(ok.headers.get('access-control-allow-origin')).toBe('null')
    expect(ok.headers.get('access-control-allow-headers')).toContain('authorization')
    expect(ok.headers.get('access-control-allow-credentials')).toBeNull()

    const denied = await fetch(`${url}/credentials`, {
      method: 'OPTIONS',
      headers: { origin: 'null', 'access-control-request-method': 'GET' },
    })
    expect(denied.status).toBe(204)
    expect(denied.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('★模块的 /state 里没有配对码 —— 那是钥匙,只给本机来源', async () => {
    const { url, tokens, modulesDir } = await serve()
    seedModule(modulesDir, 'pomodoro')
    const read = await (await fetch(`${url}/state`, { headers: asModule(tokens.issue('pomodoro')) })).json() as WorkbenchState
    expect(read.pairing).toBeUndefined()
  })

  it('从模块来源发过来(不是 null origin)同样降权', async () => {
    const { url, origin, tokens, modulesDir } = await serve()
    seedModule(modulesDir, 'pomodoro')
    const headers = { origin: origin as string, authorization: `Bearer ${tokens.issue('pomodoro')}` }
    expect((await fetch(`${url}/state`, { headers })).status).toBe(200)
    expect((await fetch(`${url}/modules`, { headers })).status).toBe(403)
  })

  it('工作台自己那条路一点没变:回环、没有 Origin,照旧全权', async () => {
    const { url, modulesDir } = await serve()
    seedModule(modulesDir, 'pomodoro')
    expect((await fetch(`${url}/modules`)).status).toBe(200)
    expect((await fetch(`${url}/state`, { headers: { origin: 'http://127.0.0.1:3080' } })).status).toBe(200)
  })
})
