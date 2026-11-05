// @vitest-environment node
/**
 * 「在 Finder 里显示」(2026-09-11 图谱交互):POST /files/reveal { path } → `open -R`。
 *
 * 这是图谱**唯一的写接口**,而且只做定位:不打开、不删除、不移动。服务层 createRevealService
 * 只会拼一条 `open -R <绝对路径>`,用例逐词断言。路径必须落在扫描根之内——`..`、根之外、
 * 符号链接指出根外,一律拒绝;判定用 realpath,不是字符串前缀。
 *
 * 全部在 mkdtemp 临时目录里跑,没有对任何真实目录做过写操作。
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createRevealService, resolveInsideRoots } from '../src/server/reveal.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'

const dirs: string[] = []
const started: WorkbenchServer[] = []

afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/** 一个扫描根 + 一个根外目录;根里有一个文件、一个目录、一个指向根外的符号链接。 */
function fixture() {
  const root = tempDir('wb-reveal-root-')
  const outside = tempDir('wb-reveal-outside-')
  mkdirSync(join(root, 'proj', 'src'), { recursive: true })
  writeFileSync(join(root, 'proj', 'src', 'a.ts'), 'x')
  writeFileSync(join(outside, 'secret.txt'), 'y')
  symlinkSync(join(outside, 'secret.txt'), join(root, 'proj', 'leak'))
  symlinkSync(outside, join(root, 'proj', 'leakdir'))
  return { root, outside }
}

describe('resolveInsideRoots:路径必须落在扫描根之内', () => {
  it('根内的真实文件与目录 → 通过,回 realpath', async () => {
    const { root } = fixture()
    const file = await resolveInsideRoots(join(root, 'proj', 'src', 'a.ts'), [root])
    expect(file).toEqual({ ok: true, path: expect.stringMatching(/\/proj\/src\/a\.ts$/) })
    expect((await resolveInsideRoots(join(root, 'proj'), [root])).ok).toBe(true)
  })

  it('带 .. 绕出去 → 拒', async () => {
    const { root, outside } = fixture()
    // 字面上的 `..`(不经 path.join 归一化),客户端要是想绕就是这么绕的。
    const result = await resolveInsideRoots(`${root}/proj/../../${outside.slice(outside.lastIndexOf('/') + 1)}/secret.txt`, [root])
    expect(result.ok).toBe(false)
  })

  it('扫描根之外的绝对路径 → 拒', async () => {
    const { root, outside } = fixture()
    expect((await resolveInsideRoots(join(outside, 'secret.txt'), [root])).ok).toBe(false)
    // 前缀相同但不是同一个目录(/root 与 /root-evil)也算根外——按段比,不按字符串比。
    const sibling = tempDir(`${root.slice(root.lastIndexOf('/') + 1)}-`)
    expect((await resolveInsideRoots(sibling, [root])).ok).toBe(false)
  })

  it('符号链接指出根外(文件与目录两种) → 拒', async () => {
    const { root } = fixture()
    expect((await resolveInsideRoots(join(root, 'proj', 'leak'), [root])).ok).toBe(false)
    expect((await resolveInsideRoots(join(root, 'proj', 'leakdir', 'secret.txt'), [root])).ok).toBe(false)
  })

  it('相对路径、空串、不存在的路径 → 拒', async () => {
    const { root } = fixture()
    expect((await resolveInsideRoots('proj/src/a.ts', [root])).ok).toBe(false)
    expect((await resolveInsideRoots('', [root])).ok).toBe(false)
    expect((await resolveInsideRoots(join(root, 'proj', '没有这个.ts'), [root])).ok).toBe(false)
  })

  it('扫描根本身不存在(比如 ~/WeChatProjects 没建过)→ 那一条根不算数,不抛', async () => {
    const { root } = fixture()
    const result = await resolveInsideRoots(join(root, 'proj', 'src', 'a.ts'), ['/nonexistent/root/xyz', root])
    expect(result.ok).toBe(true)
  })
})

describe('createRevealService:只拼 open -R,没有别的命令', () => {
  it('通过校验 → 跑 open -R <realpath>', async () => {
    const { root } = fixture()
    const ran: string[][] = []
    const service = createRevealService({
      roots: [root],
      runCommand: async (cmd) => { ran.push([...cmd]); return { ok: true, stdout: '' } },
    })
    const result = await service.reveal(join(root, 'proj', 'src', 'a.ts'))
    expect(result).toEqual({ ok: true })
    expect(ran).toHaveLength(1)
    expect(ran[0]?.[0]).toBe('open')
    expect(ran[0]?.[1]).toBe('-R')
    expect(ran[0]?.[2]).toMatch(/\/proj\/src\/a\.ts$/)
    expect(ran[0]).toHaveLength(3)
  })

  it('越界 → 一条命令都不跑,原因说人话', async () => {
    const { root, outside } = fixture()
    const ran: string[][] = []
    const service = createRevealService({
      roots: [root],
      runCommand: async (cmd) => { ran.push([...cmd]); return { ok: true, stdout: '' } },
    })
    const result = await service.reveal(join(outside, 'secret.txt'))
    expect(result.ok).toBe(false)
    expect(ran).toHaveLength(0)
  })
})

/**
 * ★ `listedPaths`:界面上**已经列出来的**那几条确切路径也放行(运营同学 Air 的原件,
 * `contrib/air-20261002/patches/index.patch` 的 index-08 / index-09,2026-10-03 原封接入)。
 *
 * 她那一格(素材管理)点的是素材文件夹 / 素材文件 / 收件箱里列着的那几条,而工作目录
 * 通常不在扫描根里。这一组钉的是这条口子的**边界**:逐字相等才放行、不给这个回调
 * 就等于这条口子不存在、放行之后仍然走 realpath 那道门。
 */
describe('createRevealService 的 listedPaths:只放行界面上列出来的那几条确切路径', () => {
  function service(options: { root: string, listed?: readonly string[] }) {
    const ran: string[][] = []
    const impl = createRevealService({
      roots: [options.root],
      ...(options.listed === undefined ? {} : { listedPaths: async () => options.listed as readonly string[] }),
      runCommand: async (cmd) => { ran.push([...cmd]); return { ok: true, stdout: '' } },
    })
    return { impl, ran }
  }

  it('根外、但**逐字**在清单里 → 放行,照旧只跑一条 open -R', async () => {
    const { root, outside } = fixture()
    const path = join(outside, 'secret.txt')
    const { impl, ran } = service({ root, listed: [path] })
    expect(await impl.reveal(path)).toEqual({ ok: true })
    expect(ran).toHaveLength(1)
    expect(ran[0]?.slice(0, 2)).toEqual(['open', '-R'])
    expect(ran[0]).toHaveLength(3)
  })

  it('★不给这个回调 = 这条口子不存在(用例里的假服务就不给)', async () => {
    const { root, outside } = fixture()
    const { impl, ran } = service({ root })
    expect((await impl.reveal(join(outside, 'secret.txt'))).ok).toBe(false)
    expect(ran).toHaveLength(0)
  })

  it('★只认逐字相等:清单里那一条的父目录 / 子路径 / 前缀都不放行', async () => {
    const { root, outside } = fixture()
    const listed = [join(outside, 'secret.txt')]
    for (const path of [outside, join(outside, 'secret.txt.bak'), `${outside}/`]) {
      const { impl, ran } = service({ root, listed })
      expect((await impl.reveal(path)).ok, path).toBe(false)
      expect(ran, path).toHaveLength(0)
    }
  })

  it('★放行之后那道 realpath 还在:清单里写的那一条不存在,照旧拒', async () => {
    const { root, outside } = fixture()
    const path = join(outside, '压根没有这个文件.txt')
    const { impl, ran } = service({ root, listed: [path] })
    expect((await impl.reveal(path)).ok).toBe(false)
    expect(ran).toHaveLength(0)
  })

  it('★清单里那一条是指向根外的符号链接 → realpath 之后露出真身,但它自己就是靶子,所以放行的是它自己', async () => {
    const { root, outside } = fixture()
    // `proj/leak` 是 root 里指向 outside/secret.txt 的符号链接 —— 它本来就在根内,
    // 走不到 listedPaths 那一支(根内判定用 realpath,所以它被拒);
    // 列进清单之后,resolveInsideRoots(path, [path]) 把它自己当根 → realpath 落在自己身上。
    const path = join(root, 'proj', 'leak')
    expect((await service({ root }).impl.reveal(path)).ok).toBe(false)
    const { impl, ran } = service({ root, listed: [path] })
    expect(await impl.reveal(path)).toEqual({ ok: true })
    expect(ran[0]?.[2]).toContain(outside.slice(outside.lastIndexOf('/') + 1))
  })
})

describe('POST /files/reveal', () => {
  async function serve(root: string, ran: string[][]) {
    const server = await startWorkbenchServer({
      port: 0,
      service: createWorkbenchService(),
      tickIntervalMs: 0,
      heartbeatMs: 0,
      reveal: createRevealService({
        roots: [root],
        runCommand: async (cmd) => { ran.push([...cmd]); return { ok: true, stdout: '' } },
      }),
    })
    started.push(server)
    return server.url
  }
  async function post(url: string, body: unknown) {
    const res = await fetch(`${url}/files/reveal`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: res.status, body: await res.json() as Record<string, unknown> }
  }

  it('根内文件 → 200 {ok:true},open -R 被调了一次', async () => {
    const { root } = fixture()
    const ran: string[][] = []
    const url = await serve(root, ran)
    const res = await post(url, { path: join(root, 'proj', 'src', 'a.ts') })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
    expect(ran).toHaveLength(1)
  })

  it('路径越界(..、根外、符号链接出根)→ 400,一条命令都不跑', async () => {
    const { root, outside } = fixture()
    const ran: string[][] = []
    const url = await serve(root, ran)
    for (const path of [
      `${root}/proj/../../${outside.slice(outside.lastIndexOf('/') + 1)}/secret.txt`,
      join(outside, 'secret.txt'),
      join(root, 'proj', 'leak'),
    ]) {
      const res = await post(url, { path })
      expect(res.status, path).toBe(400)
      expect(String(res.body.error)).toBeTruthy()
    }
    expect(ran).toHaveLength(0)
  })

  it('path 缺失/不是字符串/不是 JSON → 400', async () => {
    const { root } = fixture()
    const url = await serve(root, [])
    expect((await post(url, {})).status).toBe(400)
    expect((await post(url, { path: 12 })).status).toBe(400)
    const res = await fetch(`${url}/files/reveal`, { method: 'POST', body: '{' })
    expect(res.status).toBe(400)
  })

  it('没接 reveal 服务 → 404,不是 500', async () => {
    const server = await startWorkbenchServer({ port: 0, service: createWorkbenchService(), tickIntervalMs: 0, heartbeatMs: 0 })
    started.push(server)
    expect((await post(server.url, { path: '/a' })).status).toBe(404)
  })
})
