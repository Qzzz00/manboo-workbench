// @vitest-environment node
/**
 * 选题 = 事项的一种(2026-09-21 选题池)。这一份守三件事:
 *
 * 1. **普通事项一个字不变** —— `kind` 缺席就是今天那张卡,老 tasks.json 原样读出来;
 * 2. 三个新字段的体检**只挑字段、不丢卡**(同 block_reason / direction 的老取舍);
 * 3. 「推进一步」只往后走一格,到头如实说到头了,而且**一个日期都不写**
 *    (2026-10-02 运营同学那一版:离开「发布」前实际发布日必须由她自己填 —— 见
 *    `TOPIC_PUBLISH_DAY_FIRST`;上一版在这里自动盖当天,等于替她断言"已经发到平台上了")。
 */
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_TOPIC_STAGE, TOPIC_STAGES, TOPIC_STAGE_FLOW, isPublishDay, nextTopicStage } from '../src/protocol.ts'
import { loadStarterLayoutTemplate } from './helpers/starterLayer.ts'
import { createTasksService, loadTasksFile, TASKS_SERVICE_METHODS, TOPIC_PUBLISH_DAY_FIRST } from '../src/server/tasks.ts'

// 「发布日」是**本地**日期。把时区钉死,这份用例才在任何机器上说同一句话。
const OPS_STAGES = (await loadStarterLayoutTemplate()).board_lanes

beforeAll(() => { process.env.TZ = 'Asia/Shanghai' })

/** 2026-09-21 17:00(+08)。 */
const NOW_SEC = Math.floor(Date.parse('2026-09-21T09:00:00Z') / 1000)

async function tmpFile(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'topics-')), 'tasks.json')
}

function svc(file: string, now: () => number = () => NOW_SEC) {
  let n = 0
  return createTasksService({ file, now, newId: () => `t-${++n}` })
}

describe('六段进度这件事本身', () => {
  it('六段就是运营同事写的那六个,顺序就是推进顺序', () => {
    expect([...TOPIC_STAGES]).toEqual(['灵感', '初稿', '准备素材', '制作中', '发布', '复盘'])
  })

  it('下一段往后走一格;最后一段回 undefined(**不绕回第一段**)', () => {
    expect(nextTopicStage('灵感')).toBe('初稿')
    expect(nextTopicStage('发布')).toBe('复盘')
    expect(nextTopicStage('复盘')).toBeUndefined()
  })

  it('八环节一个不落地被六段盖住,而且不多出一个环节', () => {
    const mapped = TOPIC_STAGES.flatMap(stage => TOPIC_STAGE_FLOW[stage])
    expect(mapped).toEqual([...OPS_STAGES])
  })

  it('没写进度的选题从「灵感」算起', () => {
    expect(DEFAULT_TOPIC_STAGE).toBe('灵感')
  })
})

describe('建一条选题', () => {
  it('四样都落盘:类型、优先级、账号、进度', async () => {
    const file = await tmpFile()
    const service = svc(file)
    const created = await service.create({
      title: '露营锅具怎么选',
      kind: 'topic',
      contentType: '视频',
      stage: '灵感',
      priority: 'high',
      projectId: '户外号',
    })
    expect(created.ok).toBe(true)
    const [task] = (await loadTasksFile(file)).tasks
    expect(task?.kind).toBe('topic')
    expect(task?.content_type).toBe('视频')
    expect(task?.stage).toBe('灵感')
    expect(task?.priority).toBe('high')
    expect(task?.project_id).toBe('户外号')
  })

  it('**不传 kind 就是普通事项**:三个新字段一个都不出现在盘上', async () => {
    const file = await tmpFile()
    await svc(file).create({ title: '改一下首页文案' })
    const [task] = (await loadTasksFile(file)).tasks
    expect(task).not.toHaveProperty('kind')
    expect(task).not.toHaveProperty('content_type')
    expect(task).not.toHaveProperty('stage')
  })
})

describe('老数据与坏数据', () => {
  it('这三个字段出现之前的 tasks.json 原样读出来,一条不丢、一个字段不多', async () => {
    const file = await tmpFile()
    await writeFile(file, JSON.stringify({
      version: 2,
      tasks: [{
        id: 'old', title: '老卡', status: 'doing',
        source: { kind: 'manual' }, created_at: 'a', updated_at: 'b',
      }],
      sprints: [], modules: [], project_meta: [],
    }))
    const loaded = await loadTasksFile(file)
    expect(loaded.tasks).toEqual([{
      id: 'old', title: '老卡', status: 'doing',
      source: { kind: 'manual' }, created_at: 'a', updated_at: 'b',
    }])
  })

  it('认不出的 kind / content_type / stage **只挑掉那个字段,卡本身留着**', async () => {
    const file = await tmpFile()
    await writeFile(file, JSON.stringify({
      version: 2,
      tasks: [{
        id: 'x', title: '半条选题', status: 'todo',
        kind: '选题', content_type: '直播', stage: '发布中',
        source: { kind: 'manual' }, created_at: 'a', updated_at: 'b',
      }],
      sprints: [], modules: [], project_meta: [],
    }))
    const [task] = (await loadTasksFile(file)).tasks
    expect(task?.id).toBe('x')
    expect(task).not.toHaveProperty('kind')
    expect(task).not.toHaveProperty('content_type')
    expect(task).not.toHaveProperty('stage')
  })

  it('认得出的三个字段照常读出来', async () => {
    const file = await tmpFile()
    await writeFile(file, JSON.stringify({
      version: 2,
      tasks: [{
        id: 'x', title: '选题', status: 'todo',
        kind: 'topic', content_type: '图文', stage: '制作中',
        source: { kind: 'manual' }, created_at: 'a', updated_at: 'b',
      }],
      sprints: [], modules: [], project_meta: [],
    }))
    const [task] = (await loadTasksFile(file)).tasks
    expect(task?.kind).toBe('topic')
    expect(task?.content_type).toBe('图文')
    expect(task?.stage).toBe('制作中')
  })
})

describe('改一条选题', () => {
  it('类型与进度能改;传 null 清掉', async () => {
    const file = await tmpFile()
    const service = svc(file)
    const created = await service.create({ title: '选题', kind: 'topic', contentType: '图文', stage: '灵感' })
    const id = created.id as string
    expect(await service.update(id, { contentType: '视频', stage: '初稿' })).toBe(true)
    let [task] = (await loadTasksFile(file)).tasks
    expect(task?.content_type).toBe('视频')
    expect(task?.stage).toBe('初稿')
    expect(await service.update(id, { contentType: null })).toBe(true)
    ;[task] = (await loadTasksFile(file)).tasks
    expect(task).not.toHaveProperty('content_type')
  })
})

describe('推进一步', () => {
  it('六段一段一段往后走(最后那一格要先有实际发布日,见下面那一道闸)', async () => {
    const file = await tmpFile()
    const service = svc(file)
    const id = (await service.create({ title: '选题', kind: 'topic' })).id as string
    for (const expected of ['初稿', '准备素材', '制作中', '发布']) {
      expect((await service.advanceTopic(id)).ok).toBe(true)
      const [task] = (await loadTasksFile(file)).tasks
      expect(task?.stage).toBe(expected)
    }
    await service.update(id, { publishedAt: '2026-09-21' })
    expect((await service.advanceTopic(id)).ok).toBe(true)
    expect((await loadTasksFile(file)).tasks[0]?.stage).toBe('复盘')
  })

  it('**没写过进度的从「灵感」算起**,推一下到初稿', async () => {
    const file = await tmpFile()
    const service = svc(file)
    const id = (await service.create({ title: '选题', kind: 'topic' })).id as string
    // 建的时候没传 stage:盘上没有这个字段。
    expect((await loadTasksFile(file)).tasks[0]).not.toHaveProperty('stage')
    await service.advanceTopic(id)
    expect((await loadTasksFile(file)).tasks[0]?.stage).toBe('初稿')
  })

  it('到「复盘」就到头了:拒绝并**说出为什么**,盘上一个字不动', async () => {
    const file = await tmpFile()
    const service = svc(file)
    const id = (await service.create({ title: '选题', kind: 'topic', stage: '复盘' })).id as string
    const before = await loadTasksFile(file)
    const result = await service.advanceTopic(id)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('复盘')
    expect(await loadTasksFile(file)).toEqual(before)
  })

  it('普通事项推不动:拒绝并说出为什么(**不顺手把它变成选题**)', async () => {
    const file = await tmpFile()
    const service = svc(file)
    const id = (await service.create({ title: '普通事项' })).id as string
    const result = await service.advanceTopic(id)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('选题')
    expect((await loadTasksFile(file)).tasks[0]).not.toHaveProperty('kind')
  })

  it('卡不存在:ok false 且**没有 reason**(HTTP 层据此回 404 而不是 409,同 move)', async () => {
    const result = await svc(await tmpFile()).advanceTopic('没有这条')
    expect(result).toEqual({ ok: false })
  })
})

describe('计划发布日与实际发布日(2026-09-22 两状态)', () => {
  it('新建选题时填得上计划发布日,落盘就是那一天', async () => {
    const file = await tmpFile()
    const created = await svc(file).create({ title: '露营锅具怎么选', kind: 'topic', plannedAt: '2026-09-25' })
    expect(created.ok).toBe(true)
    expect((await loadTasksFile(file)).tasks[0]?.planned_at).toBe('2026-09-25')
    // **不顺手写一个实际发布日**:还没发就是还没发。
    expect((await loadTasksFile(file)).tasks[0]).not.toHaveProperty('published_at')
  })

  it('卡片上两个日期都能手改,也都能清掉(传 null)', async () => {
    const file = await tmpFile()
    const service = svc(file)
    const id = (await service.create({ title: '选题', kind: 'topic', plannedAt: '2026-09-25' })).id as string
    await service.update(id, { plannedAt: '2026-09-28', publishedAt: '2026-09-27' })
    expect((await loadTasksFile(file)).tasks[0]?.planned_at).toBe('2026-09-28')
    expect((await loadTasksFile(file)).tasks[0]?.published_at).toBe('2026-09-27')
    await service.update(id, { plannedAt: null, publishedAt: null })
    expect((await loadTasksFile(file)).tasks[0]).not.toHaveProperty('planned_at')
    expect((await loadTasksFile(file)).tasks[0]).not.toHaveProperty('published_at')
  })

  it('★**进入「发布」那一段一个日期都不写**(2026-10-02:工作台没发过任何东西,不替她断言)', async () => {
    const file = await tmpFile()
    const service = svc(file)
    const id = (await service.create({ title: '选题', kind: 'topic', stage: '制作中' })).id as string
    await service.advanceTopic(id)
    const [task] = (await loadTasksFile(file)).tasks
    expect(task?.stage).toBe('发布')
    expect(task).not.toHaveProperty('published_at')
  })

  it('★从「发布」往「复盘」走,实际发布日还空着就**拒绝**,盘上一个字不动', async () => {
    const file = await tmpFile()
    const service = svc(file)
    const id = (await service.create({ title: '选题', kind: 'topic', stage: '发布' })).id as string
    const before = await loadTasksFile(file)
    const result = await service.advanceTopic(id)
    expect(result).toEqual({ ok: false, reason: TOPIC_PUBLISH_DAY_FIRST })
    expect(await loadTasksFile(file)).toEqual(before)
  })

  it('★她自己填了实际发布日,这一闸就放行,而且**不覆盖她填的那一天**', async () => {
    const file = await tmpFile()
    const service = svc(file)
    const id = (await service.create({ title: '选题', kind: 'topic', stage: '发布', publishedAt: '2026-09-19' })).id as string
    expect((await service.advanceTopic(id)).ok).toBe(true)
    const [task] = (await loadTasksFile(file)).tasks
    expect(task?.stage).toBe('复盘')
    expect(task?.published_at).toBe('2026-09-19')
  })

  it('推进**一个字都不碰计划发布日**:计划是他排的,流水是我们记的,两码事', async () => {
    const file = await tmpFile()
    const service = svc(file)
    const id = (await service.create({ title: '选题', kind: 'topic', stage: '制作中', plannedAt: '2026-10-01' })).id as string
    await service.advanceTopic(id)
    expect((await loadTasksFile(file)).tasks[0]?.planned_at).toBe('2026-10-01')
  })

  it('没碰到「发布」的那几段推进,**一个日期都不写**', async () => {
    const file = await tmpFile()
    const service = svc(file)
    const id = (await service.create({ title: '选题', kind: 'topic', stage: '灵感' })).id as string
    await service.advanceTopic(id)
    await service.advanceTopic(id)
    const [task] = (await loadTasksFile(file)).tasks
    expect(task).not.toHaveProperty('published_at')
    expect(task).not.toHaveProperty('planned_at')
  })

  it('**推进不再往 `due` 上写一个字** —— `due` 留给普通事项的预期结束时间', async () => {
    const file = await tmpFile()
    const service = svc(file)
    const id = (await service.create({ title: '选题', kind: 'topic', stage: '制作中' })).id as string
    await service.advanceTopic(id)
    expect((await loadTasksFile(file)).tasks[0]?.stage).toBe('发布')
    expect((await loadTasksFile(file)).tasks[0]).not.toHaveProperty('due')
  })

  it('普通事项的 `due` 一个字没变:建、改、清都照旧', async () => {
    const file = await tmpFile()
    const service = svc(file)
    const id = (await service.create({ title: '改一下首页文案', due: '2026-09-25' })).id as string
    expect((await loadTasksFile(file)).tasks[0]?.due).toBe('2026-09-25')
    await service.update(id, { due: '2026-09-26' })
    expect((await loadTasksFile(file)).tasks[0]?.due).toBe('2026-09-26')
    await service.update(id, { due: null })
    expect((await loadTasksFile(file)).tasks[0]).not.toHaveProperty('due')
  })
})

describe('两个日期的体检与迁移', () => {
  it('这两个字段出现之前的选题照常读出来,一条不丢、一个字段不多', async () => {
    const file = await tmpFile()
    await writeFile(file, JSON.stringify({
      version: 2,
      tasks: [{
        id: 'old', title: '老选题', status: 'todo', kind: 'topic', stage: '发布', due: '2026-09-18',
        source: { kind: 'manual' }, created_at: 'a', updated_at: 'b',
      }],
      sprints: [], modules: [], project_meta: [],
    }))
    const [task] = (await loadTasksFile(file)).tasks
    expect(task?.kind).toBe('topic')
    expect(task?.due).toBe('2026-09-18')
    expect(task).not.toHaveProperty('planned_at')
    expect(task).not.toHaveProperty('published_at')
  })

  it('形状不对的日期**只挑掉那个字段,卡本身留着**(同 kind / stage 的老取舍)', async () => {
    const file = await tmpFile()
    await writeFile(file, JSON.stringify({
      version: 2,
      tasks: [{
        id: 'x', title: '半条选题', status: 'todo', kind: 'topic',
        planned_at: '九月二十五', published_at: '2026-02-30',
        source: { kind: 'manual' }, created_at: 'a', updated_at: 'b',
      }],
      sprints: [], modules: [], project_meta: [],
    }))
    const [task] = (await loadTasksFile(file)).tasks
    expect(task?.id).toBe('x')
    expect(task?.kind).toBe('topic')
    expect(task).not.toHaveProperty('planned_at')
    expect(task).not.toHaveProperty('published_at')
  })

  it('认得出的两个日期照常读出来', async () => {
    const file = await tmpFile()
    await writeFile(file, JSON.stringify({
      version: 2,
      tasks: [{
        id: 'x', title: '选题', status: 'todo', kind: 'topic',
        planned_at: '2026-09-25', published_at: '2026-09-26',
        source: { kind: 'manual' }, created_at: 'a', updated_at: 'b',
      }],
      sprints: [], modules: [], project_meta: [],
    }))
    const [task] = (await loadTasksFile(file)).tasks
    expect(task?.planned_at).toBe('2026-09-25')
    expect(task?.published_at).toBe('2026-09-26')
  })

  it('写坏形状的日期进不去盘:建卡与改卡两条路都挡住,卡照常在', async () => {
    const file = await tmpFile()
    const service = svc(file)
    const id = (await service.create({ title: '选题', kind: 'topic', plannedAt: '九月二十五' })).id as string
    expect((await loadTasksFile(file)).tasks[0]?.title).toBe('选题')
    expect((await loadTasksFile(file)).tasks[0]).not.toHaveProperty('planned_at')
    await service.update(id, { publishedAt: '2026-13-01' })
    expect((await loadTasksFile(file)).tasks[0]).not.toHaveProperty('published_at')
  })

  it('isPublishDay 收的就是 YYYY-MM-DD 那一种,别的一律不收', () => {
    expect(isPublishDay('2026-09-25')).toBe(true)
    expect(isPublishDay('2028-02-29')).toBe(true)
    expect(isPublishDay('2026-02-30')).toBe(false)
    expect(isPublishDay('2026-13-01')).toBe(false)
    expect(isPublishDay('2026-9-5')).toBe(false)
    expect(isPublishDay('2026-09-25T18:00:00+08:00')).toBe(false)
    expect(isPublishDay('')).toBe(false)
    expect(isPublishDay(undefined)).toBe(false)
    expect(isPublishDay(20260925)).toBe(false)
  })
})

describe('能力清单', () => {
  // 除 advanceTopic 外,协作方法按 server-tasks.test.ts 同一能力名单精确对齐。
  it('选题服务保留已授权的全部服务器动作且没有额外动作', async () => {
    expect([...TASKS_SERVICE_METHODS]).toEqual([
      'list', 'create', 'move', 'update', 'remove', 'advanceTopic',
      'createSprint', 'updateSprint', 'removeSprint',
      'createModule', 'updateModule', 'removeModule',
      'setProjectMeta',
      'createGoal', 'updateGoal', 'saveGoalSprint', 'saveAgentCard', 'comment', 'resolveComment', 'recordReceipt',
      'migrateToGoals', 'rollbackGoals', 'dismissProposal', 'dismissedProposals',
      // 10-22 第三轮 4(维护者定):只记「等你」里那行已办说明,本身不动便签。
      'setPlacedNotice', 'placedNotices',
      // 2026-10-23 卡「待排的卡不许被派出去」④:只读「删过」那张小表。
      'removedSessionCards',
      'saveSquad', 'removeSquad', 'saveTimer', 'removeTimer', 'recordTimerRun', 'saveMcp', 'removeMcp',
      'saveGoalCondition', 'removeGoalCondition', 'verifyGoalCondition', 'deliverGoalCondition',
      'message', 'saveRelation', 'removeRelation', 'listRelations',
      // 邀请登记/收尾保证同一协作邀请幂等推进。
      'prepareInvitation', 'finishInvitation',
      // LAN 历史、来源策略和消息快照是频道持久化唯一写口。
      'lanChannel', 'saveLanMessage',
      'lanIdentity', 'saveLanIdentity', 'lanMembers', 'saveLanMembers', 'rememberLanMember',
      // 2026-10-29 可靠执行闭环第一批第 1 步:执行身份与恢复记录(串行比较版本写入)。
      'readExecution', 'writeExecution', 'unfinishedExecutions',
      'lanSourcePolicies', 'saveLanSourcePolicy',
      // 2026-10-29(8791 第六轮):写成功订阅,只发通知、不改看板,驱动执行对账。
      'onMutated',
    ])
    expect(Object.keys(svc(await tmpFile())).sort()).toEqual([...TASKS_SERVICE_METHODS].sort())
  })
})
