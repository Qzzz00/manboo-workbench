/**
 * **两步接力端到端跑一遍**(2026-10-12,演示卡「出图进可灵」;维护者:「你得完整走一遍,用你写的代码」)。
 *
 * 跑的是真代码:`videoChain`(认话、接力、落图、收卡)→ 第一步真派给豆包办公 → `doubaoImage` 从它本机缓存取图 →
 * `klingStep` 开可灵生成页、贴图、写提示词、**真按「生成」(花她一次额度)**。看板用真的 `tasks` 服务(临时文件)。
 *
 * 唯一换掉的是「壳」:生产上 op 经 8791 的 `/helper` 发给工作台 App;这里发给本分支 Swift 源码现编的探针
 * (`workbench-app/probe-send-text.sh op '<同形 JSON>'`,调的是壳 `runOp` 调的同一批函数)——
 * 因为这一版壳(`paste_image`、`agent_press` 的 `role`)还没发,装在她机器上的那份不认。
 * 电话 → `/butler/item` 那一段不在这里(要统筹发版装上才走得到)。
 *
 *   PROBE_APP=<编好的探针.app> node workbench-plugin/scripts/demo-chain-e2e.ts "<她那句话>" <落图的根目录>
 */
import { execFile } from 'node:child_process'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { discoverDoubaoCacheDirs, findDoubaoImage } from '../src/server/doubaoImage.ts'
import { dispatchMarker, dispatchPrompt } from '../src/server/dispatchReply.ts'
import { KLING_BUNDLE, KLING_LOG, runKlingStep, waitKlingVideo } from '../src/server/klingStep.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { createVideoChain, videoChainPlan } from '../src/server/videoChain.ts'

const DOUBAO = process.env.DOUBAO_BUNDLE ?? 'com.bot.pc.doubao'
const said = process.argv[2] ?? ''
const root = process.argv[3] ?? '/tmp/demo-chain-e2e'
const probe = join(dirname(new URL(import.meta.url).pathname), '../../workbench-app/probe-send-text.sh')
const t0 = Date.now()
const log = (...parts: unknown[]): void => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s]`, ...parts)

function request(req: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    execFile('zsh', [probe, 'op', JSON.stringify(req), '--allow', KLING_BUNDLE, '--allow', DOUBAO], { env: process.env, maxBuffer: 16 << 20 }, (error, stdout) => {
      const at = stdout.indexOf('{')
      if (at < 0) { reject(error ?? new Error(`探针没回 JSON:${stdout.slice(0, 200)}`)); return }
      try { resolve(JSON.parse(stdout.slice(at)) as Record<string, unknown>) }
      catch (e) { reject(e) }
    })
  })
}

const plan = videoChainPlan(said)
if (plan === undefined) { log(`认不出这句是「做一个 XXX 的视频」:${said}`); process.exit(2) }
log('认出来了 →', JSON.stringify(plan, null, 1))

const tasks = createTasksService({ file: join(root, '.e2e/tasks.json') })
const created = await tasks.create({ title: said, direction: 'mine', status: 'doing' })
const taskId = created.id as string

const chain = createVideoChain({
  tasks,
  dispatch: async (id, input) => {
    const text = dispatchPrompt({ taskId: id, said: input.text })
    log(`第一步:新开一条豆包对话,送进去 →`, text.split('\n')[0])
    // 与生产同一档:框里有她没发的字 → 壳先读出来、送完放回去(`save_draft`);这里另存一份。
    const sent = await request({ op: 'send_text', bundle_id: DOUBAO, index: 0, text, submit: true, new_conversation: true, save_draft: true })
    if (sent.ok !== true) return { ok: false, note: `没送进豆包:${String(sent.error)}` }
    const result = (sent.result ?? {}) as Record<string, unknown>
    if (typeof result.draft === 'string' && result.draft !== '') {
      await mkdir(join(root, '.e2e'), { recursive: true })
      await writeFile(join(root, '.e2e/豆包框里没发的字.txt'), result.draft)
      log(`豆包框里有她没发的字(${result.draft.length} 字),另存了一份;放回去了没有:${String(result.draft_returned)}`)
    }
    await tasks.update(id, { clientDispatch: { hand: 'window', family: 'doubao', status: 'sent', at: new Date().toISOString(), text, reply_state: 'waiting', marker: dispatchMarker(id) } })
    return { ok: true, note: '已经送到 豆包办公 的窗口里' }
  },
  findImage: async since => await findDoubaoImage({ cacheDirs: await discoverDoubaoCacheDirs(), since }),
  root: async () => root,
  fallbackRoot: root,
  writeFile: async (path, body) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, body); log('参考图落盘 →', path, `${body.length} 字节`) },
  kling: async (input) => {
    log('第二步:交给可灵 →', input.imagePath)
    const out = await runKlingStep(input, {
      openApp: async () => await new Promise<void>((resolve, reject) => execFile('open', ['-b', KLING_BUNDLE], e => (e === null ? resolve() : reject(e)))),
      helper: { request: async (req) => { log('  壳 op', req.op, req.op === 'agent_press' ? `${String(req.label)}/${String(req.role)}` : ''); return await request(req) } },
      sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    })
    log('可灵那一步 →', JSON.stringify(out))
    return out
  },
  // 出片之后:等可灵出片、点下载、等它下完(真代码);推手机与打电话要装上新版工作台才走得到,这里只记一句。
  fetchVideo: async (input) => {
    log('等可灵出片(盯它自己的日志)…')
    const out = await waitKlingVideo(input, {
      readLog: async () => await readFile(join(homedir(), KLING_LOG), 'utf8'),
      helper: { request: async (req) => { log('  壳 op', req.op); return await request(req) } },
      sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
      now: () => Date.now(),
    })
    log('出片 →', JSON.stringify(out))
    return out
  },
  copyFile: async (from, to) => { await mkdir(dirname(to), { recursive: true }); await copyFile(from, to); log('视频落盘 →', to) },
  pushToPhone: async (input) => { log('推到手机 →(装上新版后走 /butler/send-file 同一道门)', input.path); return { ok: true, note: '演练:没真推' } },
  // 哪一档由接力那一层给(2026-10-13):没办成就不是「办完了,等你验收」。
  announce: async input => log('打电话 →', input.reason === 'confirm'
    ? `插一句:「${input.title}」办完了,等你验收:${input.note}。`
    : `插一句:${input.note}。你说下一步怎么办。`),
  file: join(root, '.e2e/video-chains.json'),
  now: () => Date.now(),
})

const started = await chain.start(taskId, plan)
log('派出去 →', JSON.stringify(started))
if (!started.ok) process.exit(1)

const deadline = Date.now() + 12 * 60_000
while (Date.now() < deadline) {
  await new Promise(resolve => setTimeout(resolve, 3100))
  await chain.pump()
  const rec = chain.view().find(one => one.item === taskId)
  if (rec?.image_url !== undefined && rec.stage === 'image') log('缓存里看到图了,等它稳住 →', rec.image_url.replace(/\?.*$/, ''))
  if (rec?.stage === 'done' || rec?.stage === 'failed') {
    const task = (await tasks.list()).tasks.find(one => one.id === taskId)
    log(`收场:接力 ${rec.stage};卡 ${task?.status};卡上那句 → ${task?.note ?? ''}`)
    process.exit(rec.stage === 'done' ? 0 : 1)
  }
}
log('12 分钟没走完')
process.exit(1)
