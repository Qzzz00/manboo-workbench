/** Explicit plan fixtures only; dispatch/behavior/habits/CLI replies remain production services. */
import { createServer } from 'node:http'
import { execFileSync, spawn } from 'node:child_process'
import { openSync, closeSync, writeFileSync, copyFileSync, cpSync, existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { decisionExecutionPolicy } from './decisionExecutionPolicy.ts'
import { createRulesService } from '../../src/server/rules.ts'
import { createBehaviorLog } from '../../src/server/behaviorLog.ts'
import { createHabitService, HABIT_POKE_EVENTS } from '../../src/server/habits.ts'
import { createEngine } from '../../src/server/engine/engine.ts'
import { createRegistry } from '../../src/server/engine/registry.ts'
import { createActionGate } from '../../src/server/actionGate.ts'
import { createJobLog } from '../../src/server/jobLog.ts'
import { createModelService } from '../../src/server/modelService.ts'
import type { TasksService } from '../../src/server/tasks.ts'
import type { StartWorkbenchServerOptions } from '../../src/server/http.ts'

export const DECISION_QA_TEXT = '安排代码运输验收甲'
export const RETARGET_QA_TEXT = '安排代码通道改选口令核对'
export const SUGGEST_QA_TEXT = '建议代码运输验收乙'
export async function decisionQaEnvironment(root: string, tasks: TasksService) {
  const saved = await tasks.list()
  const card = saved.agent_cards?.find(c => c.id === 'agent:local:b9c02c112a' && c.runtime?.family === 'codex')
  if (!card?.project?.repo || card.project.repo !== '/tmp/api-codex-natural-v2/project') throw new Error('Expected genuine controlled Codex card')
  const policy = decisionExecutionPolicy(card.project.repo, process.env.PHONE_REGISTERED_QA_RETARGET_CWD)
  const cwd = policy.cwd
  const reuse = process.env.PHONE_REGISTERED_QA_REUSE_DEFAULT
  if (policy.limit === 1) {
    if (!reuse || !existsSync(join(reuse, 'rules.json')) || !existsSync(join(reuse, 'behavior'))) throw new Error('Retarget requires saved genuine rules/behavior')
    copyFileSync(join(reuse, 'rules.json'), join(root, 'rules.json'))
    cpSync(join(reuse, 'behavior'), join(root, 'behavior'), { recursive: true, errorOnExist: true, force: false })
    writeFileSync(join(root, 'reused-default-provenance.json'), JSON.stringify({ source: reuse, rules_sha256: createHash('sha256').update(await readFile(join(reuse, 'rules.json'))).digest('hex') }))
  }
  const plans = {
    [RETARGET_QA_TEXT]: { addressed: true, items: [{ kind: '办', title: '代码通道运输测试，无修改代码或验收仓库任务。唯一任务：只回复 QA_1C_RETARGET_REAL。禁止工具、文件读写、统筹状态报告与代理调用。', confidence: 0.98, risk: 'none', why: '受控计划fixture，仅验同原件改选运输' }] },
    [DECISION_QA_TEXT]: { addressed: true, items: [{ kind: '办', title: '修改代码运输验收甲。只回复 QA_1C_DECIDED_REAL。不要使用工具、读取或写入仓库、报告统筹状态、另起代理。', confidence: 0.98, risk: 'none', why: '受控计划fixture，仅验消费运输' }] },
    [SUGGEST_QA_TEXT]: { addressed: true, items: [{ kind: '办', title: '修改代码运输验收乙。只回复 QA_1C_SUGGEST_REAL。不要使用工具、读取或写入仓库、报告统筹状态、另起代理。', confidence: 0.60, risk: 'none', why: '受控不确定计划fixture，仅验消费运输' }] },
  }
  const fixture = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part
    try {
      const messages = JSON.parse(raw).messages as { content?: unknown }[]
      const text = /她说:「([\s\S]*?)」/.exec(String(messages.at(-1)?.content ?? ''))?.[1]
      const plan = plans[text as keyof typeof plans]
      if (!plan) { res.writeHead(422).end('{}'); return }
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(plan) }, finish_reason: 'stop' }] }))
    } catch { res.writeHead(400).end('{}') }
  })
  await new Promise<void>((resolve, reject) => { fixture.once('error', reject); fixture.listen(29693, '127.0.0.1', resolve) })
  writeFileSync(join(root, 'fixture-plans.json'), JSON.stringify(plans, null, 2))
  writeFileSync(join(root, 'model.json'), JSON.stringify({ mode: 'own', own: { base_url: 'http://127.0.0.1:29693/v1', model: 'explicit-1c-plan-fixture' } }), { mode: 0o600 })
  writeFileSync(join(root, 'credentials.json'), JSON.stringify({ keys: { deepseek: 'local-qa-fixture-no-personal-key' } }), { mode: 0o600 })
  const model = createModelService({ modelFile: join(root, 'model.json'), credentialFile: join(root, 'credentials.json') })
  const rules = createRulesService({ file: join(root, 'rules.json'), agents: { apply: async () => ({ ok: true }), revert: async () => ({ ok: true }) } })
  await rules.load()
  const ledger = createBehaviorLog({ dir: join(root, 'behavior') })
  const habits = createHabitService({ store: rules, behavior: ledger })
  const behaviorLog = { ...ledger, record(input: Parameters<typeof ledger.record>[0]) { ledger.record(input); if (HABIT_POKE_EVENTS.includes(input.事)) habits.poke() } }
  const log = createJobLog({ file: join(root, 'jobs.jsonl'), warn: console.warn })
  const gate = createActionGate({ phaseOf: () => 'unknown', log, now: () => new Date() })
  const registry = createRegistry()
  const engine = createEngine({ registry, gate, log, warn: console.warn })
  const bin = execFileSync('which', ['codex'], { encoding: 'utf8' }).trim()
  let executions = 0
  const options = {
    model, rules, habits, behaviorLog, engine, engineRegistry: registry, actionGate: gate, jobLog: log,
    dispatchRun: {
      resultDir: root,
      resolveCli: family => family === 'codex' ? { found: true, family, bin, source: 'path' } : { found: false, family, why: '本受控QA只执行Codex' },
      runCli: cmd => {
        if (cmd.bin !== bin || cmd.cwd !== cwd || executions >= policy.limit) {
          writeFileSync(join(root, 'scope-refusal.json'), JSON.stringify({ cwd: cmd.cwd, allowedCwd: cwd, executions, limit: policy.limit, reason: 'Outside authorized controlled CLI acceptance; no process spawned' }))
          throw new Error('Outside authorized controlled CLI acceptance')
        }
        executions++
        writeFileSync(join(root, 'executions.json'), JSON.stringify({ executions, cwd, bin, limit: policy.limit, argv: cmd.argv }))
        const fd = openSync(cmd.logFile, 'a', 0o600)
        const child = spawn(cmd.bin, [...cmd.argv], { cwd: cmd.cwd, env: process.env, stdio: ['ignore', fd, fd] }); closeSync(fd)
        if (child.pid === undefined) throw new Error('Codex CLI process did not start')
        return { pid: child.pid, exited: new Promise(resolve => { child.once('exit', code => resolve({ code })); child.once('error', () => resolve({ code: null })) }) }
      },
      readFile: async file => readFile(file, 'utf8').catch(() => undefined),
      alive: pid => { try { process.kill(pid, 0); return true } catch { return false } },
    },
  } satisfies Partial<StartWorkbenchServerOptions>
  return { options, cardId: card.id, async close() { await ledger.flush(); await new Promise<void>(resolve => fixture.close(() => resolve())) } }
}
