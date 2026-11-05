// @vitest-environment node
import { afterEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { normalS4WindowQaEnvironment, prepareNormalS4WindowQaProject, verifyNormalS4WindowQaBootstrap, normalS4RuntimePlan, auditS4WindowQaCapture } from '../dev/acceptance-three-entrances/s4WindowQa.ts'
import { createS4WindowQaRules, S4_WINDOW_QA_ENV, S4_WINDOW_QA_RULE, parseS4WindowQaConfig } from '../src/server/s4WindowQaRules.ts'
import { dispatchPrompt } from '../src/server/dispatchReply.ts'
import ts from 'typescript'
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))); roots.length = 0 })
async function world() {
  const root = await mkdtemp(join(tmpdir(), 's4-window-helper-')); roots.push(root)
  const home = join(root, 'iso/home')
  const config = { version: 1, enabled: true, root, home, profileDir: join(home, '.dsh/profiles/web'), projectId: '样片', projectRepo: join(home, 'Documents/GitHub/样片') } as const
  await mkdir(config.profileDir, { recursive: true })
  return { root, home, config, raw: JSON.stringify(config) }
}
it('normal helper 缺省不增加 env，不准备项目、不要求 bootstrap', async () => {
  const w = await world()
  expect(normalS4WindowQaEnvironment(w.root, w.home)).toEqual({})
  await prepareNormalS4WindowQaProject(undefined)
  await verifyNormalS4WindowQaBootstrap(undefined)
})
it('helper 真实 JSON/env 装配由同一个生产工厂消费并核回执；项目为自造 git 种子', async () => {
  const w = await world(), env = { HOME: w.home, DSH_HOME: join(w.home, '.dsh'), ...normalS4WindowQaEnvironment(w.root, w.home, w.raw) }
  const config = parseS4WindowQaConfig(env)!
  await prepareNormalS4WindowQaProject(config)
  expect(await readFile(join(config.projectRepo, 'README.md'), 'utf8')).toContain('QA')
  expect(await readFile(join(config.projectRepo, '.git/config'), 'utf8')).toContain('example.invalid')
  const tasks = { list: async () => ({ tasks: [], sprints: [], modules: [], project_meta: [] }) }
  expect(await createS4WindowQaRules({ env, tasks, projects: async () => [], ordinaryRulesFor: async () => undefined })).toBeTypeOf('function')
  await verifyNormalS4WindowQaBootstrap(config)
})
it('错误 root、未知字段及缺失/伪摘要回执明确 FAIL，不将服务 HTTP ready 当 QA 装配 ready', async () => {
  const w = await world()
  expect(() => normalS4WindowQaEnvironment('/tmp/another', w.home, w.raw)).toThrow()
  expect(() => normalS4WindowQaEnvironment(w.root, w.home, JSON.stringify({ ...w.config, submit: true }))).toThrow()
  await expect(verifyNormalS4WindowQaBootstrap(w.config)).rejects.toThrow()
  await writeFile(join(w.root, 's4-window-qa-bootstrap.json'), JSON.stringify({ state: 'configured', config_sha256: 'stale' }))
  await expect(verifyNormalS4WindowQaBootstrap(w.config)).rejects.toThrow(/bootstrap/)
  expect(normalS4WindowQaEnvironment(w.root, w.home, '{"enabled":false}')).toEqual({})
})
it('已有项目不覆盖，不能把旧项目当本次空隔离种子', async () => {
  const w = await world()
  await mkdir(w.config.projectRepo, { recursive: true })
  await writeFile(join(w.config.projectRepo, 'README.md'), 'original')
  await expect(prepareNormalS4WindowQaProject(w.config)).rejects.toThrow()
  expect(await readFile(join(w.config.projectRepo, 'README.md'), 'utf8')).toBe('original')
})

it('normal helper 的纯 JSON env 跨实际 Node 子进程仍只由生产工厂解释，不加载配置代码', async () => {
  const w = await world()
  await prepareNormalS4WindowQaProject(w.config)
  const moduleUrl = new URL('../src/server/s4WindowQaRules.ts', import.meta.url).href
  const script = `import {createS4WindowQaRules} from ${JSON.stringify(moduleUrl)}; await createS4WindowQaRules({env:process.env,tasks:{list:async()=>({tasks:[],sprints:[],modules:[],project_meta:[]})},projects:async()=>[],ordinaryRulesFor:async()=>undefined});`
  const child = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { env: { HOME: w.home, DSH_HOME: join(w.home, '.dsh'), ...normalS4WindowQaEnvironment(w.root, w.home, w.raw) } })
  expect(child.stderr).toBe('')
  await verifyNormalS4WindowQaBootstrap(w.config)
})
it('显式 assembly 的 runtime 只接受固定公共预编译缓存，目标始终本次隔离目录', async () => {
  const w = await world()
  const head = '477b4f420553e8a52c2fbccc464d7561b239c443'
  expect(normalS4RuntimePlan(w.config, '/tmp/locked-dsh-cache', head)).toEqual({ cache: '/tmp/locked-dsh-cache', target: join(w.home, '.dsh/runtime/locked-cache') })
  expect(() => normalS4RuntimePlan(w.config, '/tmp/cache', 'different')).toThrow()
  expect(() => normalS4RuntimePlan(w.config, w.root, head)).toThrow()
  expect(() => normalS4RuntimePlan(w.config, 'relative', head)).toThrow()
})
it('受控 helper 最终守门：缺安全段、目标/submit不符、原任务被替换都拒绝，不转发真实窗口', () => {
  const task = { id: 't-12345678', title: '把样片剪一版' }
  const base = dispatchPrompt({ taskId: task.id, said: task.title })
  const send = { op: 'send_text' as const, bundle_id: 'com.anthropic.claudefordesktop', index: 0, text: `${base}\n\n${S4_WINDOW_QA_RULE}`, submit: false, new_conversation: true }
  expect(() => auditS4WindowQaCapture(send, task, false)).not.toThrow()
  for (const bad of [{ ...send, text: base }, { ...send, text: S4_WINDOW_QA_RULE }, { ...send, bundle_id: 'com.openai.codex' }, { ...send, submit: true }, { ...send, new_conversation: false }]) expect(() => auditS4WindowQaCapture(bad, task, false)).toThrow(/QA_CAPTURE_REJECTED/)
})
it('既有 normal startInstance 真接 env/项目/回执，assembly 在账号与配对前返回', async () => {
  const source = ts.createSourceFile('instance.ts', await readFile(new URL('../dev/acceptance-three-entrances/instance.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
  const start = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'startInstance') as ts.FunctionDeclaration
  const body = start.body!.getText(source)
  expect(body).toContain('normalS4WindowQaEnvironment(root, home, process.env.WORKBENCH_S4_WINDOW_QA)')
  expect(body).toContain('...s4QaEnvironment,')
  expect(body).toContain('await prepareNormalS4WindowQaProject(s4QaConfig)')
  expect(body).toContain('await verifyNormalS4WindowQaBootstrap(s4QaConfig)')
  expect(body.indexOf('if (s4AssemblyOnly) {')).toBeLessThan(body.indexOf('const account = testAccount()'))
  expect(body).toContain("s4QaConfig === undefined ? 'profile,plugin,work_repo,scripts' : 'profile,plugin,scripts'")
  const failedStart = body.slice(body.indexOf('if (await waitHttp(`${base}/state`'), body.indexOf('try { await verifyNormalS4WindowQaBootstrap'))
  expect(failedStart).toContain('if (s4QaConfig !== undefined)')
  expect(failedStart).toContain("dshProc.kill('SIGTERM'); butler.kill('SIGTERM')")
})
