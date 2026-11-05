/**
 * 自定义模块容器的服务端(2026-09-21,分支 feat/custom-module-container)。
 *
 * 三块:**路径穿越**(这条路由是唯一把 URL 拼进文件路径的地方)、**列清单**、
 * **回收站**(移进去 / 拿回来,一个字节都不删)。
 *
 * 全部在 `mkdtemp` 出来的临时目录里跑 —— 递归改动文件的代码只在沙箱里验(记忆里
 * 2026-09-04 那条事故纪律)。一行都不碰 `~/.dsh`。
 */
import { mkdtemp, mkdir, rm, symlink, writeFile, stat, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  contentTypeOf, createCustomModulesService, isModuleId, moduleViewOf, safeRelPath, trashStamp,
  TRASH_DIR_NAME, type CustomModulesService,
} from '../src/server/modules.ts'

let root = ''
let service: CustomModulesService

async function seed(id: string, manifest: Record<string, unknown>, files: Record<string, string> = {}): Promise<void> {
  await mkdir(join(root, id), { recursive: true })
  await writeFile(join(root, id, 'module.json'), JSON.stringify(manifest), 'utf8')
  for (const [name, body] of Object.entries(files)) {
    await mkdir(join(root, id, name, '..'), { recursive: true })
    await writeFile(join(root, id, name), body, 'utf8')
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wb-modules-'))
  service = createCustomModulesService({ dir: root, now: () => Date.parse('2026-09-21T10:00:00Z') })
})

afterEach(async () => {
  // 只删自己在 mkdtemp 里建的那一份。
  if (root !== '' && root.includes('wb-modules-')) await rm(root, { recursive: true, force: true })
})

// ───────────────────────────────────────────────────────────────────────────
describe('id 白名单', () => {
  it('★只许小写字母数字连字符,首字符不能是连字符', () => {
    expect(isModuleId('tool-a1b2c3')).toBe(true)
    expect(isModuleId('pomodoro')).toBe(true)
    expect(isModuleId('-lead')).toBe(false)
    expect(isModuleId('Tool')).toBe(false)
    expect(isModuleId('a_b')).toBe(false)
    expect(isModuleId('..')).toBe(false)
    expect(isModuleId('.trash')).toBe(false)
    expect(isModuleId('a/b')).toBe(false)
    expect(isModuleId('')).toBe(false)
    expect(isModuleId('x'.repeat(41))).toBe(false)
  })
})

describe('路径穿越(字符串那一道)', () => {
  it('★`..` 无论在哪一段都否', () => {
    expect(safeRelPath('../../../etc/passwd')).toBeUndefined()
    expect(safeRelPath('assets/../../x.html')).toBeUndefined()
    expect(safeRelPath('a/./b.js')).toBeUndefined()
  })

  it('★URL 编码过的 `..` 也否(先解码再判,不是反过来)', () => {
    expect(safeRelPath('%2e%2e/%2e%2e/secret.json')).toBeUndefined()
    expect(safeRelPath('%2e%2e%2f%2e%2e%2fsecret.json')).toBeUndefined()
  })

  it('★隐藏文件、反斜杠、NUL 一律否', () => {
    expect(safeRelPath('.env')).toBeUndefined()
    expect(safeRelPath('assets/.git/config')).toBeUndefined()
    expect(safeRelPath('a\\b.js')).toBeUndefined()
    expect(safeRelPath('a\0.js')).toBeUndefined()
    expect(safeRelPath('//x.js')).toBeUndefined()
  })

  it('空串与 `/` 都等于入口文件', () => {
    expect(safeRelPath('')).toBe('index.html')
    expect(safeRelPath('/')).toBe('index.html')
  })

  it('正常的相对路径原样过', () => {
    expect(safeRelPath('index.html')).toBe('index.html')
    expect(safeRelPath('assets/app.js')).toBe('assets/app.js')
    expect(safeRelPath('assets/app.js/')).toBe('assets/app.js')
  })
})

describe('文件类型白名单', () => {
  it('表里有的给 content-type,表外的一律不给', () => {
    expect(contentTypeOf('index.html')).toBe('text/html; charset=utf-8')
    expect(contentTypeOf('a/b.JS')).toBe('text/javascript; charset=utf-8')
    expect(contentTypeOf('x.png')).toBe('image/png')
    expect(contentTypeOf('x.sh')).toBeUndefined()
    expect(contentTypeOf('x.wasm')).toBeUndefined()
    expect(contentTypeOf('Makefile')).toBeUndefined()
  })

})

describe('file():落到盘上那一道', () => {
  beforeEach(async () => {
    await seed('pomodoro', { version: 1, name: '番茄钟', created_at: '2026-09-21T10:00:00+08:00', source: 'dsh' }, {
      'index.html': '<!doctype html><title>番茄钟</title>',
      'assets/app.js': 'console.log(1)',
    })
  })

  it('读得到入口与子目录里的文件', async () => {
    const entry = await service.file('pomodoro', '')
    expect('path' in entry && entry.contentType).toBe('text/html; charset=utf-8')
    const asset = await service.file('pomodoro', 'assets/app.js')
    expect('path' in asset).toBe(true)
  })

  it('★指到目录外面的软链接:字符串那三道全过,realpath 这一道拦下来', async () => {
    const outside = join(root, 'outside.html')
    await writeFile(outside, '<p>不该被读到</p>', 'utf8')
    await symlink(outside, join(root, 'pomodoro', 'leak.html'))
    expect(await service.file('pomodoro', 'leak.html')).toEqual({ kind: 'path' })
  })

  it('认不出的 id / 穿越 / 表外类型 / 不存在,四种各回各的原因,不混成一个 404', async () => {
    expect(await service.file('../etc', 'passwd')).toEqual({ kind: 'id' })
    expect(await service.file('pomodoro', '../../x.html')).toEqual({ kind: 'path' })
    expect(await service.file('pomodoro', 'run.sh')).toEqual({ kind: 'type' })
    expect(await service.file('pomodoro', 'nope.html')).toEqual({ kind: 'missing' })
  })

  it('目录本身不是文件:请求一个子目录回 missing,不回目录内容', async () => {
    expect(await service.file('pomodoro', 'assets')).toEqual({ kind: 'type' })
  })
})

describe('list()', () => {
  it('按 created_at 升序(先做的在左边,标签是往右长的)', async () => {
    await seed('tool-bbb', { name: '后做的', created_at: '2026-09-21T12:00:00+08:00' })
    await seed('tool-aaa', { name: '先做的', created_at: '2026-09-21T09:00:00+08:00' })
    expect((await service.list()).map(m => m.name)).toEqual(['先做的', '后做的'])
  })

  it('module.json 读不出来 / 不是合法 JSON 的目录整个不进清单(不编一条)', async () => {
    await mkdir(join(root, 'tool-broken'), { recursive: true })
    await writeFile(join(root, 'tool-broken', 'module.json'), '{ 这不是 json', 'utf8')
    await mkdir(join(root, 'tool-empty'), { recursive: true })
    await seed('tool-good', { name: '好的', created_at: '2026-09-21T09:00:00+08:00' })
    expect((await service.list()).map(m => m.id)).toEqual(['tool-good'])
  })

  it('目录压根不存在 = 一个自定义模块都没有,不是错', async () => {
    const fresh = createCustomModulesService({ dir: join(root, '没建过') })
    expect(await fresh.list()).toEqual([])
  })

  it('★没有名字的退回用 id 当名字(标签上一格空白比什么都糟),source 缺省算 dsh', () => {
    expect(moduleViewOf('tool-x', { created_at: 'x' })).toMatchObject({ name: 'tool-x', source: 'dsh', entry: 'index.html' })
    expect(moduleViewOf('tool-x', { source: 'user' })?.source).toBe('user')
    expect(moduleViewOf('不合法的 id', {})).toBeUndefined()
  })
})

describe('回收站', () => {
  it('时间戳那串只有数字与连字符(过得了 id 白名单)', () => {
    expect(trashStamp(Date.parse('2026-09-21T10:00:00Z'))).toBe('20260921-100000')
    expect(isModuleId(`pomodoro-${trashStamp(Date.parse('2026-09-21T10:00:00Z'))}`)).toBe(true)
  })

  beforeEach(async () => {
    await seed('pomodoro', { name: '番茄钟', created_at: '2026-09-21T10:00:00+08:00' }, { 'index.html': '<p>x</p>' })
  })

  it('★移除 = 搬进 .trash,一个字节都没删', async () => {
    expect(await service.remove('pomodoro')).toEqual({ ok: true })
    expect((await service.list())).toEqual([])
    expect((await service.trash()).map(m => m.name)).toEqual(['番茄钟'])
    // 文件原样躺在回收站里。
    expect(await readFile(join(root, TRASH_DIR_NAME, 'pomodoro', 'index.html'), 'utf8')).toBe('<p>x</p>')
  })

  it('★恢复:原样搬回来,清单里又有了', async () => {
    await service.remove('pomodoro')
    expect(await service.restore('pomodoro')).toEqual({ ok: true })
    expect((await service.list()).map(m => m.id)).toEqual(['pomodoro'])
    expect(await service.trash()).toEqual([])
  })

  it('★回收站里已经有同名的:另存一份带时间戳的,不覆盖(覆盖就是删掉了前一次那份)', async () => {
    await service.remove('pomodoro')
    await seed('pomodoro', { name: '番茄钟二号', created_at: '2026-09-21T11:00:00+08:00' })
    expect(await service.remove('pomodoro')).toEqual({ ok: true })
    expect((await stat(join(root, TRASH_DIR_NAME, 'pomodoro'))).isDirectory()).toBe(true)
    // ★时间戳那一份也必须**列得出来**:名字里带 ISO 的大写 T/Z 就过不了 id 白名单,
    // 那一份会变成"还在盘上、界面上不存在"——比直接说删不掉更糟。
    const trashed = await service.trash()
    expect(trashed).toHaveLength(2)
    expect(trashed.map(m => m.id).sort()).toEqual(['pomodoro', 'pomodoro-20260921-100000'])
  })

  it('★同名的还在用着就不恢复,如实说一句让人自己处置', async () => {
    await service.remove('pomodoro')
    await seed('pomodoro', { name: '重名的', created_at: '2026-09-21T11:00:00+08:00' })
    const result = await service.restore('pomodoro')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('已经有一个叫 pomodoro 的模块在用了')
    // 回收站里那份还在,没被动过。
    expect(await service.trash()).toHaveLength(1)
  })

  it('认不出的 id / 不存在的模块各回各的原因', async () => {
    expect((await service.remove('..')).error).toBe('认不出这个模块')
    expect((await service.remove('nothing')).error).toBe('没有这个模块')
    expect((await service.restore('nothing')).error).toBe('回收站里没有这个模块')
  })

  it('`.trash` 自己不会被当成一个模块列出来', async () => {
    await service.remove('pomodoro')
    expect((await service.list()).map(m => m.id)).toEqual([])
  })

  it('exists() 查重', async () => {
    expect(await service.exists('pomodoro')).toBe(true)
    expect(await service.exists('nothing')).toBe(false)
    expect(await service.exists('..')).toBe(false)
  })
})
