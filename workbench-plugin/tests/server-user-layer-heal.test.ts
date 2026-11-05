// @vitest-environment node
/**
 * 分层自愈完善(2026-10-23,卡「分层自愈完善」):三件事的服务端 —
 *   ① 最近 3 个真正画好过的小组件版本留历史,设置里能选回(含清单/入口/样式指纹;坏版不算);
 *   ② 页面报的坏版本记进用户层目录一份小表,跨重启同一指纹不再重试;文件一改(指纹变)自动恢复;
 *   ③ 派去改用户层的活交回来时,本体目录被改过 → 拒装:只回退这次可归因的用户层变更,
 *      保留她原有的修改,留下证据,本体一份文件都不碰。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createUserLayerService, type UserLayerService } from '../src/server/userLayer.ts'

const dirs: string[] = []
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-user-layer-heal-'))
  dirs.push(dir)
  return dir
}

const WIDGET = { contract: 1, id: 'files', name: '素材管理', replaces: 'files', entry: 'index.js', export: 'W' }

function writeWidget(root: string, id: string, manifest: unknown, code: string, style?: string): string {
  const dir = join(root, '小组件', id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'widget.json'), JSON.stringify(manifest), 'utf8')
  writeFileSync(join(dir, 'index.js'), code, 'utf8')
  if (style !== undefined) writeFileSync(join(dir, 'style.css'), style, 'utf8')
  return dir
}

/** 建一个带一个小组件的用户层;返回服务与小组件目录。 */
async function made(extra: { style?: string, bodyDir?: string } = {}): Promise<{ root: string, service: UserLayerService, widgetDir: string }> {
  const root = join(tmp(), '用户层')
  const code = 'module.exports = { W: function W() { return null } }'
  const widgetDir = writeWidget(root, 'files', WIDGET, code, extra.style)
  const service = createUserLayerService({ dir: root, ...(extra.bodyDir === undefined ? {} : { bodyDir: extra.bodyDir }) })
  await service.ensure()
  return { root, service, widgetDir }
}

/** 入口内容变了,指纹才变;帮助用例造「新一版」。 */
function nextVersion(widgetDir: string, code: string, style?: string): void {
  writeFileSync(join(widgetDir, 'index.js'), code, 'utf8')
  if (style !== undefined) writeFileSync(join(widgetDir, 'style.css'), style, 'utf8')
}

describe('① 可用版本历史:画好过才存,只留最近 3 份', () => {
  it('report ok 后历史里多一条(指纹 + 时刻);同一指纹重复报不重复存', async () => {
    const { service, widgetDir } = await made()
    const first = await service.scan()
    const rev = first.widgets[0]?.rev as string
    await service.report({ id: 'files', rev, ok: true })
    await service.report({ id: 'files', rev, ok: true })
    const history = await service.widgetHistory('files')
    expect(history).toHaveLength(1)
    expect(history[0]?.rev).toBe(rev)
    expect(history[0]?.at).toBeTruthy()
    expect(widgetDir).toBeTruthy()
  })

  it('带 style.css 的版本,历史条目带上样式指纹', async () => {
    const { service } = await made({ style: '.a { color: red }' })
    const widget = (await service.scan()).widgets[0]
    await service.report({ id: 'files', rev: widget?.rev as string, ok: true, style_rev: widget?.style_rev })
    const history = await service.widgetHistory('files')
    expect(history[0]?.style_rev).toBe(widget?.style_rev)
  })

  it('改了 4 版各报一次 ok,只留最近 3 份(最旧的清掉)', async () => {
    const { service, widgetDir } = await made()
    const revs: string[] = []
    for (let i = 0; i < 4; i++) {
      nextVersion(widgetDir, `module.exports = { W: function W() { return ${i} } }`)
      const rev = (await service.scan()).widgets[0]?.rev as string
      revs.push(rev)
      await service.report({ id: 'files', rev, ok: true })
    }
    const history = await service.widgetHistory('files')
    expect(history.map(one => one.rev)).toEqual([revs[3], revs[2], revs[1]])
    expect(history.some(one => one.rev === revs[0])).toBe(false)
  })

  it('坏的那版不进历史', async () => {
    const { service, widgetDir } = await made()
    const rev1 = (await service.scan()).widgets[0]?.rev as string
    await service.report({ id: 'files', rev: rev1, ok: true })
    nextVersion(widgetDir, 'throw new Error("boom")')
    const rev2 = (await service.scan()).widgets[0]?.rev as string
    await service.report({ id: 'files', rev: rev2, ok: false, problem: '运行出错' })
    const history = await service.widgetHistory('files')
    expect(history.map(one => one.rev)).toEqual([rev1])
  })
})

describe('① 选回:把历史版本写回小组件目录,可逆,不动她的样式', () => {
  it('选回后清单与入口回到那一版;当前可用版先存进历史(选回可逆)', async () => {
    const { service, widgetDir } = await made()
    const rev1 = (await service.scan()).widgets[0]?.rev as string
    await service.report({ id: 'files', rev: rev1, ok: true })
    nextVersion(widgetDir, 'module.exports = { W: function W() { return "v2" } }')
    const rev2 = (await service.scan()).widgets[0]?.rev as string
    await service.report({ id: 'files', rev: rev2, ok: true })

    const restored = await service.restoreWidget('files', rev1)
    expect(restored.ok).toBe(true)
    expect(readFileSync(join(widgetDir, 'index.js'), 'utf8')).toContain('return null')
    // 选回可逆:第二版(选回前的当前版)也进了历史
    const history = await service.widgetHistory('files')
    expect(history.map(one => one.rev)).toContain(rev2)
    expect(history.map(one => one.rev)).toContain(rev1)
  })

  it('选回不拿旧样式盖她现在的 style.css(不恢复旧样式覆盖新文件)', async () => {
    const { service, widgetDir } = await made({ style: '.a { color: red }' })
    const rev1 = (await service.scan()).widgets[0]?.rev as string
    await service.report({ id: 'files', rev: rev1, ok: true, style_rev: (await service.scan()).widgets[0]?.style_rev })
    nextVersion(widgetDir, 'module.exports = { W: function W() { return "v2" } }', '.a { color: blue }')
    const v2 = (await service.scan()).widgets[0]
    await service.report({ id: 'files', rev: v2?.rev as string, ok: true, style_rev: v2?.style_rev })
    const restored = await service.restoreWidget('files', rev1)
    expect(restored.ok).toBe(true)
    expect(readFileSync(join(widgetDir, 'style.css'), 'utf8')).toBe('.a { color: blue }')
  })

  it('选一份没有的历史:如实说不行', async () => {
    const { service } = await made()
    const restored = await service.restoreWidget('files', '000000000000')
    expect(restored.ok).toBe(false)
  })

  it('选回的版本入口名与现在不同:旧入口文件清掉,目录里不留脏的(2026-10-23 独立审 Minor 4)', async () => {
    const root = join(tmp(), '用户层')
    const code = 'module.exports = { W: function W() { return null } }'
    // 历史里的那一版入口叫 old.js
    const widgetDir = join(root, '小组件', 'files')
    mkdirSync(widgetDir, { recursive: true })
    writeFileSync(join(widgetDir, 'widget.json'), JSON.stringify({ ...WIDGET, entry: 'old.js' }), 'utf8')
    writeFileSync(join(widgetDir, 'old.js'), code, 'utf8')
    const service = createUserLayerService({ dir: root })
    await service.ensure()
    const rev1 = (await service.scan()).widgets[0]?.rev as string
    await service.report({ id: 'files', rev: rev1, ok: true })
    // 现在入口换成 main.js(内容也换一个样,指纹才变)
    writeFileSync(join(widgetDir, 'widget.json'), JSON.stringify({ ...WIDGET, entry: 'main.js' }), 'utf8')
    writeFileSync(join(widgetDir, 'main.js'), 'module.exports = { W: function W() { return "main" } }', 'utf8')
    rmSync(join(widgetDir, 'old.js'))
    const rev2 = (await service.scan()).widgets[0]?.rev as string
    expect(rev2).not.toBe(rev1)
    await service.report({ id: 'files', rev: rev2, ok: true })
    // 选回入口叫 old.js 的那一版:main.js(旧入口)被清掉,old.js 回来
    const restored = await service.restoreWidget('files', rev1)
    expect(restored.ok).toBe(true)
    expect(existsSync(join(widgetDir, 'old.js'))).toBe(true)
    expect(existsSync(join(widgetDir, 'main.js'))).toBe(false)
  })

  it('★当前版是坏版(不进可选回历史)又换过入口名:选回不删那份没有快照的在制原件(可逆保全硬边界)', async () => {
    const root = join(tmp(), '用户层')
    const widgetDir = join(root, '小组件', 'files')
    mkdirSync(widgetDir, { recursive: true })
    writeFileSync(join(widgetDir, 'widget.json'), JSON.stringify(WIDGET), 'utf8')
    const codeV1 = 'module.exports = { W: function W() { return "v1" } }'
    writeFileSync(join(widgetDir, 'index.js'), codeV1, 'utf8')
    const service = createUserLayerService({ dir: root })
    await service.ensure()
    const rev1 = (await service.scan()).widgets[0]?.rev as string
    await service.report({ id: 'files', rev: rev1, ok: true })
    // 她在改的新版:跑不起来,页面报过坏(坏版按设计不进可选回历史)
    const codeBad = 'function ( 她在改的这一版还没写好'
    writeFileSync(join(widgetDir, 'index.js'), codeBad, 'utf8')
    const badRev = (await service.scan()).widgets[0]?.rev as string
    await service.report({ id: 'files', rev: badRev, ok: false, problem: '画这一格时出错:还没写好' })
    // 坏版键(入口内容@样式)不含清单:改入口名不换内容,这一版仍然是坏版(被端上一版遮住)
    writeFileSync(join(widgetDir, 'widget.json'), JSON.stringify({ ...WIDGET, entry: 'c.js' }), 'utf8')
    renameSync(join(widgetDir, 'index.js'), join(widgetDir, 'c.js'))
    const stillBad = await service.scan()
    expect(stillBad.widgets[0]?.rolled_back).toBe('画这一格时出错:还没写好')
    // 此时选回一个入口名不同的旧版:换回 index.js(v1),她的 c.js 一份不丢
    const restored = await service.restoreWidget('files', rev1)
    expect(restored.ok).toBe(true)
    expect(readFileSync(join(widgetDir, 'index.js'), 'utf8')).toBe(codeV1)
    expect(readFileSync(join(widgetDir, 'c.js'), 'utf8')).toBe(codeBad)
    // 坏版没被她动过的组合键挡住的话,格子端回 v1 正常用
    const after = await service.scan()
    expect(after.widgets[0]?.status).toBe('ok')
    expect(after.widgets[0]?.rev).toBe(rev1)
  })

  it('当前版是好的又换过入口名:选回旧版清掉现入口,字节已进历史(选那个版本就捞得回来)', async () => {
    const root = join(tmp(), '用户层')
    const widgetDir = join(root, '小组件', 'files')
    mkdirSync(widgetDir, { recursive: true })
    writeFileSync(join(widgetDir, 'widget.json'), JSON.stringify(WIDGET), 'utf8')
    const codeV1 = 'module.exports = { W: function W() { return "v1" } }'
    writeFileSync(join(widgetDir, 'index.js'), codeV1, 'utf8')
    const service = createUserLayerService({ dir: root })
    await service.ensure()
    const rev1 = (await service.scan()).widgets[0]?.rev as string
    await service.report({ id: 'files', rev: rev1, ok: true })
    // 当前版好、入口改名 c.js(内容也变好),报过 ok
    const codeC = 'module.exports = { W: function W() { return "c 版" } }'
    writeFileSync(join(widgetDir, 'widget.json'), JSON.stringify({ ...WIDGET, entry: 'c.js' }), 'utf8')
    writeFileSync(join(widgetDir, 'c.js'), codeC, 'utf8')
    rmSync(join(widgetDir, 'index.js'))
    const revC = (await service.scan()).widgets[0]?.rev as string
    await service.report({ id: 'files', rev: revC, ok: true })
    // 选回 v1(index.js):c.js 被清掉,但那份字节在历史里(选回可逆)
    const restored = await service.restoreWidget('files', rev1)
    expect(restored.ok).toBe(true)
    expect(existsSync(join(widgetDir, 'c.js'))).toBe(false)
    const salvage = join(root, '.上一版', '历史', 'files', `${revC}--plain`, 'c.js')
    expect(readFileSync(salvage, 'utf8')).toBe(codeC)
  })
})

describe('② 坏版本落盘:跨重启不再重试,改好自动恢复', () => {
  it('同一指纹报过坏,新服务实例(重启)同一拍仍判坏、原因还在', async () => {
    const { root, service, widgetDir } = await made()
    const rev = (await service.scan()).widgets[0]?.rev as string
    await service.report({ id: 'files', rev, ok: false, problem: '画这一格时出错:boom' })
    const rebooted = createUserLayerService({ dir: root })
    const after = await rebooted.scan()
    expect(after.widgets[0]?.status).toBe('broken')
    expect(after.widgets[0]?.problem).toBe('画这一格时出错:boom')
    expect(widgetDir).toBeTruthy()
  })

  it('文件改好(指纹变)自动恢复成 ok', async () => {
    const { root, service, widgetDir } = await made()
    const rev = (await service.scan()).widgets[0]?.rev as string
    await service.report({ id: 'files', rev, ok: false, problem: '运行出错' })
    nextVersion(widgetDir, 'module.exports = { W: function W() { return "fixed" } }')
    const rebooted = createUserLayerService({ dir: root })
    expect((await rebooted.scan()).widgets[0]?.status).toBe('ok')
  })

  it('坏版按 入口指纹@样式指纹 记:只挡报过的那一组合,样式改了是另一版照常试', async () => {
    const { root, service, widgetDir } = await made({ style: '.a{}' })
    const widget = (await service.scan()).widgets[0]
    await service.report({ id: 'files', rev: widget?.rev as string, ok: false, problem: '带样式那次坏了', style_rev: widget?.style_rev })
    const rebooted = createUserLayerService({ dir: root })
    // 同一组合:跨重启仍判坏(不重试)
    expect((await rebooted.scan()).widgets[0]?.status).toBe('broken')
    // 样式文件改一个码:组合变了,不挡(自动恢复重试)
    nextVersion(widgetDir, 'module.exports = { W: function W() { return null } }', '.a { color: black }')
    expect((await rebooted.scan()).widgets[0]?.status).toBe('ok')
  })

  it('报 ok 会把同键的坏记录清掉(改好自动恢复)', async () => {
    const { service } = await made()
    const rev = (await service.scan()).widgets[0]?.rev as string
    await service.report({ id: 'files', rev, ok: false, problem: '运行出错' })
    await service.report({ id: 'files', rev, ok: true })
    const rebooted = createUserLayerService({ dir: service.dir })
    expect((await rebooted.scan()).widgets[0]?.status).toBe('ok')
  })
})

describe('② 回退期间代码与样式同源:上一版的样式也从快照出,不回写她的文件', () => {
  it('入口改坏后回退:端的代码是上一版,样式也是上一版的样式', async () => {
    const { service, widgetDir } = await made({ style: '.a { color: red }' })
    const before = await service.scan()
    const rev1 = before.widgets[0]?.rev as string
    const styleRev1 = before.widgets[0]?.style_rev as string
    await service.report({ id: 'files', rev: rev1, ok: true, style_rev: styleRev1 })
    nextVersion(widgetDir, 'module.exports = { W: function W() { return "v2" } }', '.a { color: blue }')
    const v2widget = (await service.scan()).widgets[0]
    await service.report({ id: 'files', rev: v2widget?.rev as string, ok: false, problem: '画这一格时出错:v2', style_rev: v2widget?.style_rev })
    const after = await service.scan()
    const widget = after.widgets[0]
    expect(widget?.status).toBe('ok')
    expect(widget?.rev).toBe(rev1)
    expect(widget?.rolled_back).toBe('画这一格时出错:v2')
    expect(widget?.style_rev).toBe(styleRev1)
    // 回退期间样式从快照端:不是 live 目录里那份新的
    const style = await service.widgetStyle('files')
    expect(style?.css).toBe('.a { color: red }')
    // 她的文件一个字没动
    expect(readFileSync(join(widgetDir, 'style.css'), 'utf8')).toBe('.a { color: blue }')
    expect(readFileSync(join(widgetDir, 'index.js'), 'utf8')).toContain('v2')
  })

  it('她删掉 style.css(指纹变):同入口不再算坏,按没带样式重试', async () => {
    const { root, service, widgetDir } = await made({ style: '.a { color: red }' })
    const before = await service.scan()
    const rev1 = before.widgets[0]?.rev as string
    await service.report({ id: 'files', rev: rev1, ok: false, problem: '带样式那次坏了', style_rev: before.widgets[0]?.style_rev })
    rmSync(join(widgetDir, 'style.css'))
    const rebooted = createUserLayerService({ dir: root })
    const after = await rebooted.scan()
    expect(after.widgets[0]?.status).toBe('ok')
    expect(after.widgets[0]?.style_rev).toBeUndefined()
  })
})

describe('③ 修复交回守门', () => {
  function fakeBody(): string {
    const dir = tmp()
    mkdirSync(join(dir, 'lib'), { recursive: true })
    writeFileSync(join(dir, 'lib', 'index.js'), '本体代码 v1', 'utf8')
    return dir
  }

  it('本体没动:交回后清掉记录,用户层里这次改的东西保留(正常修复结果)', async () => {
    const body = fakeBody()
    const { service, widgetDir } = await made({ bodyDir: body })
    await service.beginFixGuard('item-1')
    expect(await service.pendingFixGuards()).toEqual(['item-1'])
    // 这次修复该改的:用户层里正常改动
    nextVersion(widgetDir, 'module.exports = { W: function W() { return "fixed" } }')
    const outcome = await service.finishFixGuard('item-1', new Date().toISOString())
    expect(outcome.kind).toBe('clean')
    expect(await service.pendingFixGuards()).toEqual([])
    expect(existsSync(join(service.dir, '.修复'))).toBe(false)
    expect(readFileSync(join(widgetDir, 'index.js'), 'utf8')).toContain('fixed')
  })

  it('本体被改:拒装——窗口内变过的全部保留原样、分清是谁改的不行就记阻塞,唯一副本不挪走;本体不碰', async () => {
    const body = fakeBody()
    const { service, widgetDir } = await made({ bodyDir: body })
    // 她派活前就有的修改(相对更早的版本),先报一次 ok —— 这一格有「上一版」可端
    writeFileSync(join(widgetDir, 'index.js'), 'module.exports = { W: function W() { return "她的修改" } }', 'utf8')
    const herRev = (await service.scan()).widgets[0]?.rev as string
    await service.report({ id: 'files', rev: herRev, ok: true })
    await service.beginFixGuard('item-2')
    // 派出去的那一家:改了本体、改了她的小组件、还新建了一格(也可能都是她自己在窗口内动的 —— 分不清)
    writeFileSync(join(body, 'lib', 'index.js'), '本体代码 被改', 'utf8')
    writeFileSync(join(widgetDir, 'index.js'), 'module.exports = { W: function W() { return "窗口内变的" } }', 'utf8')
    writeWidget(service.dir, 'evil', { ...WIDGET, id: 'evil', replaces: 'todo' }, 'module.exports = { W: function W() { return 1 } }')
    const completedAt = new Date().toISOString()
    const outcome = await service.finishFixGuard('item-2', completedAt)
    expect(outcome.kind).toBe('out-of-bounds')
    if (outcome.kind === 'out-of-bounds') {
      expect(outcome.changed).toContain('lib/index.js')
      // 窗口内变过的都记进阻塞,谁也不动
      expect(outcome.blocked).toContain('小组件/files/index.js')
      expect(outcome.blocked).toContain('小组件/evil/index.js')
      expect(outcome.blocked).toContain('小组件/evil/widget.json')
      // 变过的小组件按组合记成「先不装」(她改一个码就恢复)
      expect(outcome.held_back).toContain('files')
      expect(outcome.held_back).toContain('evil')
    }
    // 窗口内的样子原样保留 —— 不回退成派活前,也不挪走
    expect(readFileSync(join(widgetDir, 'index.js'), 'utf8')).toContain('窗口内变的')
    expect(existsSync(join(service.dir, '小组件', 'evil', 'index.js'))).toBe(true)
    // 那一格先不端:files 有上一版 → 端上一版;evil 没画好过 → broken
    const after = await service.scan()
    const files = after.widgets.find(one => one.id === 'files')
    const evil = after.widgets.find(one => one.id === 'evil')
    expect(files?.rolled_back).toMatch(/先不装/)
    expect(evil?.status).toBe('broken')
    expect(evil?.problem).toMatch(/先不装/)
    // 本体保持被改的样子 —— 本体一份文件都不由这里回写
    expect(readFileSync(join(body, 'lib', 'index.js'), 'utf8')).toBe('本体代码 被改')
    // 证据与派活前的备份都留着(唯一副本不清)
    expect(existsSync(join(service.dir, '.修复', 'item-2', 'record.json'))).toBe(true)
    expect(existsSync(join(service.dir, '.修复', 'item-2', '之前', '小组件', 'files', 'index.js'))).toBe(true)
  })

  it('窗口内她删的文件不复活、等长改写(时间戳照留)也检出', async () => {
    const body = fakeBody()
    const { service, widgetDir } = await made({ bodyDir: body })
    await service.beginFixGuard('item-3')
    // 本体:等长改写,还把 mtime 拨回去(伪装成没动过)—— 内容指纹照样检出
    const original = readFileSync(join(body, 'lib', 'index.js'), 'utf8')
    const sameLength = `${original.slice(0, -2)}XX`
    expect(sameLength.length).toBe(original.length)
    writeFileSync(join(body, 'lib', 'index.js'), sameLength, 'utf8')
    const past = new Date(Date.now() - 3600_000)
    utimesSync(join(body, 'lib', 'index.js'), past, past)
    // 用户层:她在窗口内删了一个文件 —— 不复活,记阻塞
    rmSync(join(widgetDir, 'index.js'))
    const outcome = await service.finishFixGuard('item-3', new Date().toISOString())
    expect(outcome.kind).toBe('out-of-bounds')
    if (outcome.kind === 'out-of-bounds') {
      expect(outcome.changed).toContain('lib/index.js')
      expect(outcome.blocked).toContain('小组件/files/index.js')
    }
    // 删除保持删除,不复活
    expect(existsSync(join(widgetDir, 'index.js'))).toBe(false)
  })

  it('本体文件被换成 symlink:检出;用户层新建的 symlink:保留原样记阻塞(不跟、不拷)', async () => {
    const body = fakeBody()
    const { service, widgetDir } = await made({ bodyDir: body })
    await service.beginFixGuard('item-4')
    rmSync(join(body, 'lib', 'index.js'))
    symlinkSync(join(body, 'lib', 'elsewhere.js'), join(body, 'lib', 'index.js'))
    writeFileSync(join(body, 'lib', 'elsewhere.js'), '本体代码 被改', 'utf8')
    symlinkSync(join(widgetDir, 'index.js'), join(service.dir, '小组件', 'files', 'linked.js'))
    const outcome = await service.finishFixGuard('item-4', new Date().toISOString())
    expect(outcome.kind).toBe('out-of-bounds')
    if (outcome.kind === 'out-of-bounds') expect(outcome.changed).toContain('lib/index.js')
    // 用户层那份 symlink 原样在,备份里没有把指向的目标拷进来
    expect(existsSync(join(service.dir, '小组件', 'files', 'linked.js'))).toBe(true)
    expect(existsSync(join(service.dir, '.修复', 'item-4', '之前', '小组件', 'files', 'linked.js'))).toBe(false)
  })

  it('7 天清扫只清待核记录;已核(留证)的记录与证据长留', async () => {
    const body = fakeBody()
    const { service, widgetDir } = await made({ bodyDir: body })
    await service.beginFixGuard('item-old')
    // 已核的越界记录:老也不清
    writeFileSync(join(body, 'lib', 'index.js'), '本体代码 被改', 'utf8')
    writeFileSync(join(widgetDir, 'index.js'), 'module.exports = { W: function W() { return "窗口内变的" } }', 'utf8')
    await service.finishFixGuard('item-old', new Date().toISOString())
    // 待核记录:7 天没交回 → 清掉
    await service.beginFixGuard('item-pending')
    const record = join(service.dir, '.修复', 'item-pending', 'record.json')
    const raw = JSON.parse(readFileSync(record, 'utf8')) as { at: string }
    raw.at = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString()
    writeFileSync(record, JSON.stringify(raw), 'utf8')
    await service.beginFixGuard('item-new')
    expect(await service.pendingFixGuards()).toEqual(['item-new'])
    const left = readdirSync(join(service.dir, '.修复'))
    expect(left).toContain('item-new')
    expect(left).toContain('item-old')
    expect(left).not.toContain('item-pending')
  })
})
