/**
 * 用户层真跑(2026-10-21,卡「分层第一刀」):起一台**真的**工作台服务(`server/http.ts`),
 * 用户层是一个真目录、走真的扫描 / 取代码 / 打开目录;别的服务一律不接(不读 8791、不碰 ~/.dsh)。
 *
 *   node dev/user-layer-run/server.ts <用户层目录> <empty|starter|broken> [端口,缺省 4291]
 *
 *   empty    目录空着(只有骨架)
 *   starter  第一次建目录:放进起步层(要先 pnpm build,拷的是 lib/starter-layer)
 *   broken   起步层 + 故意弄坏三格:发布计划 widget.json 写坏、数据复盘 index.js 语法错、随手记画的时候抛错
 *   restart  **不擦目录**重起(目录必须已在):模拟真机重启 —— 她删过的文件不补(.seeded 标记),
 *            template.json 里记的布局 id 原样保留。删→重启→回退→恢复 的真跑用这个档。
 *
 * 2026-10-23(分层二刀二)起布局模板也走真的:与 index.ts 同款接线(模板清单从用户层
 * 服务的快照出),起在自媒体布局那一档 —— /state.template 是真实注入回来的那份。
 *
 * 页面那一半见同目录 main.tsx;「在访达中打开」会真的拉起 Finder 打开这个目录。
 */
import { execFile } from 'node:child_process'
import { appendFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { WorkbenchLayout } from '../../src/protocol.ts'
import { startWorkbenchServer } from '../../src/server/http.ts'
import { createWorkbenchService } from '../../src/server/service.ts'
import { createTemplateService } from '../../src/server/templateStore.ts'
import { createUserLayerService } from '../../src/server/userLayer.ts'

const [dir, mode = 'starter', portText = '4291'] = process.argv.slice(2)
if (dir === undefined || !['empty', 'starter', 'broken', 'restart'].includes(mode)) {
  console.error('用法:node dev/user-layer-run/server.ts <用户层目录> <empty|starter|broken|restart> [端口]')
  process.exit(2)
}
// starter / broken / empty 是「新机器」:整个目录重建。restart 是真机重启:一个字不动。
if (mode !== 'restart') rmSync(dir, { recursive: true, force: true })
const starterDir = fileURLToPath(new URL('../../lib/starter-layer/', import.meta.url))
const userLayer = createUserLayerService({
  dir,
  // restart 像真机一样传同一份 starterDir:由 ensure 内部按 .seeded / .styled 标记
  // 主动决定不重复放,而不是在外部特意不传 starterDir。
  ...(mode === 'empty' ? {} : { starterDir }),
  runCommand: cmd => new Promise(resolve => execFile(cmd[0]!, cmd.slice(1), error => resolve({ ok: error === null, stdout: '' }))),
})
console.log('ensure', await userLayer.ensure())
if (mode === 'broken') {
  const widgets = join(dir, '小组件')
  writeFileSync(join(widgets, 'publish', 'widget.json'), '{ "contract": 1, "name": "发布计划" ', 'utf8')
  appendFileSync(join(widgets, 'review', 'index.js'), '\n}} 这一行是故意写坏的\n', 'utf8')
  appendFileSync(join(widgets, 'notes', 'index.js'), "\nmodule.exports = { NotesModule() { throw new Error('故意弄坏:画的时候抛错') } }\n", 'utf8')
}
// 布局模板接真的(2026-10-23,分层二刀二):与 index.ts 同款 —— 模板清单从用户层服务的
// 快照出,/state.template 经真实注入回来;这一页就是来看自媒体布局的,起在它那一档。
// 布局落 layout.json(与 template.json 同目录):restart 档重起不丢,删模板→重启→回退那一条
// 在读路径上才看得到(内存态的话重启即失)。
let layout: WorkbenchLayout | undefined
const layoutFile = join(dir, 'layout.json')
try { layout = JSON.parse(readFileSync(layoutFile, 'utf8')) as WorkbenchLayout } catch { layout = undefined }
await userLayer.scan()
const template = createTemplateService({
  file: join(dir, 'template.json'),
  backupsDir: join(dir, 'template-backups'),
  readLayout: () => Promise.resolve(layout),
  writeLayout: (next) => {
    layout = next
    writeFileSync(layoutFile, JSON.stringify(next), 'utf8')
    return Promise.resolve()
  },
  templates: () => userLayer.layoutTemplates(),
})
await template.load()
if (userLayer.layoutTemplate('ops') !== undefined && template.currentId() !== 'ops') {
  // 走真 apply:布局、当前模板 id、备份各就各位(没接窗位清单 / 工作目录,结果里如实写着)。
  console.log('切到 ops', await template.apply('ops'))
}
const server = await startWorkbenchServer({
  port: Number(portText),
  service: createWorkbenchService({}),
  tickIntervalMs: 0,
  heartbeatMs: 0,
  userLayer,
  template,
  // 项目区桩:getLayout / setLayout 两件(内存),/state.layout 与模板回退那一条读路径靠它。
  projects: {
    getProjectsState: () => Promise.resolve({ projects: [], pending: [], scan_errors: [], scanned_at: new Date().toISOString() }),
    confirmStatus: () => Promise.resolve(false),
    setDdl: () => Promise.resolve(false),
    addRule: () => Promise.resolve(),
    getLayout: () => Promise.resolve(layout),
    setLayout: (next) => { layout = next; return Promise.resolve() },
    invalidateScanCache: () => {},
  },
})
console.log(`用户层真跑:${server.url}(${mode})目录 ${dir}`)
console.log(JSON.stringify(await userLayer.scan(), null, 1))
