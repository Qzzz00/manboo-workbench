// @vitest-environment node
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createTasksService } from '../src/server/tasks.ts'
import { createExecutionStore } from '../src/server/taskExecutionStore.ts'
import { newExecutionRecord, reduceExecution } from '../src/server/taskExecution.ts'
import { appendExecutionEvent, createJobLog, JOB_LOG_MAX } from '../src/server/jobLog.ts'

const NOW_SEC = Math.floor(Date.parse('2026-08-25T09:00:00Z') / 1000)

async function tmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'exec-store-'))
}

function svc(file: string) {
  let n = 0
  return createTasksService({ file, now: () => NOW_SEC, newId: () => `t-${++n}` })
}

describe('execution store(恢复记录挂在卡上一格)', () => {
  it('① 写完重建服务(重新 createTasksService 读同一目录),unfinished() 仍回同一条、next 仍在', async () => {
    const file = join(await tmpDir(), 'tasks.json')
    const first = svc(file)
    const created = await first.create({ title: '修复随手记提示语' })
    const store = createExecutionStore(first)
    expect(await store.compareAndSet(created.id!, 0, newExecutionRecord(created.id!))).toBe(true)
    const record = await store.read(created.id!)
    const running = reduceExecution(record!, { kind: 'started', attemptId: 'attempt-1', planVersion: 1 })
    expect(await store.compareAndSet(created.id!, 1, running)).toBe(true)

    // 重启:同一目录起一个全新的服务与账,未完成委托与下一动作原样在。
    const rebuilt = createExecutionStore(svc(file))
    const unfinished = await rebuilt.unfinished()
    expect(unfinished).toHaveLength(1)
    expect(unfinished[0]!.taskId).toBe(created.id!)
    expect(unfinished[0]!.phase).toBe('running')
    expect(unfinished[0]!.next).toEqual({ kind: 'observe', reason: 'await_result', wakeAt: null })
    expect((await rebuilt.read(created.id!))!.version).toBe(2)
  })

  it('② 同一 expectedVersion 并发两次 compareAndSet 只有一个 true;败者重读后不会覆盖新版', async () => {
    const file = join(await tmpDir(), 'tasks.json')
    const tasks = svc(file)
    const created = await tasks.create({ title: '普通项目文件修改' })
    const store = createExecutionStore(tasks)
    expect(await store.compareAndSet(created.id!, 0, newExecutionRecord(created.id!))).toBe(true)
    const current = await store.read(created.id!)
    expect(current!.version).toBe(1)

    const attemptA = reduceExecution(current!, { kind: 'started', attemptId: 'attempt-a', planVersion: 1 })
    const attemptB = reduceExecution(current!, { kind: 'started', attemptId: 'attempt-b', planVersion: 1 })
    const results = await Promise.all([
      store.compareAndSet(created.id!, 1, attemptA),
      store.compareAndSet(created.id!, 1, attemptB),
    ])
    expect(results.filter(Boolean)).toHaveLength(1)
    const after = await store.read(created.id!)
    expect(after!.version).toBe(2)
    expect(['attempt-a', 'attempt-b']).toContain(after!.attemptId)
    // 迟到的那一次按新读到的版本重试也只会撞版本,不会静默覆盖。
    const stale = reduceExecution(current!, { kind: 'returned', attemptId: 'attempt-a', planVersion: 1, receiptId: 'r' })
    expect(await store.compareAndSet(created.id!, 1, stale)).toBe(false)
  })

  it('③ 旧卡(只有 dispatch 字段)导入成 reconciling 且 unfinished() 能列出;不直接重派', async () => {
    const file = join(await tmpDir(), 'tasks.json')
    await writeFile(file, JSON.stringify({
      version: 2,
      tasks: [{
        id: 't-old', title: '老卡', status: 'doing', created_at: '', updated_at: '',
        dispatch: { family: 'codex', status: 'running', cwd: '/repo/workbench', started_at: '2026-10-01T00:00:00Z' },
      }],
      sprints: [], modules: [], project_meta: [],
    }))
    const store = createExecutionStore(svc(file))
    const record = await store.read('t-old')
    expect(record).toBeDefined()
    expect(record!.phase).toBe('reconciling')
    expect(record!.next?.kind).toBe('reconcile')
    const unfinished = await store.unfinished()
    expect(unfinished.map(one => one.taskId)).toEqual(['t-old'])
  })

  it('④ 往 jobLog 追加超过 4000 条后,unfinished() 不受影响', async () => {
    const dir = await tmpDir()
    const file = join(dir, 'tasks.json')
    const log = createJobLog({ file: join(dir, 'jobs.jsonl') })
    const tasks = svc(file)
    const created = await tasks.create({ title: '长任务观察' })
    const store = createExecutionStore(tasks)
    expect(await store.compareAndSet(created.id!, 0, newExecutionRecord(created.id!))).toBe(true)
    expect(await store.compareAndSet(created.id!, 1,
      reduceExecution((await store.read(created.id!))!, { kind: 'started', attemptId: 'attempt-1', planVersion: 1 }))).toBe(true)

    for (let i = 0; i < JOB_LOG_MAX + 100; i += 1) log.append({ job: created.id!, step: 'updated' })
    // 统一执行事件的历史输出口照常记(只记历史,不当恢复账)。
    appendExecutionEvent(log, { job: created.id!, fact: 'returned', attempt_id: 'attempt-1', plan_version: 1 })
    expect(log.all().length).toBeGreaterThan(JOB_LOG_MAX)

    const unfinished = await store.unfinished()
    expect(unfinished.map(one => one.taskId)).toEqual([created.id!])
    expect(unfinished[0]!.phase).toBe('running')
    expect(unfinished[0]!.next?.kind).toBe('observe')
  })
})
