// @vitest-environment node
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { canTransition, TASK_STATUSES, TASK_TRANSITIONS } from '../src/protocol.ts'
import {
  createTasksService,
  defaultTasksFile,
  emptyTasksFile,
  loadTasksFile,
  readTasksFile,
  saveTasksFile,
  TASKS_SERVICE_METHODS,
  TasksFileUnreadableError,
  type TasksFile,
} from '../src/server/tasks.ts'

const NOW_SEC = Math.floor(Date.parse('2026-08-25T09:00:00Z') / 1000)

async function tmpFile(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'tasks-')), 'tasks.json')
}

function svc(file: string, now: () => number = () => NOW_SEC) {
  let n = 0
  return createTasksService({ file, now, newId: () => `t-${++n}` })
}

describe('tasks.json 落盘', () => {
  it('list() 逐字节命中读缓存:连续返回共享同一份已解析账(零深拷贝),外改/坏账/恢复立即可见', async () => {
    const file = await tmpFile(), tasks = svc(file)
    await tasks.create({ title: '甲甲' })
    const first = await tasks.list()
    const again = await tasks.list()
    // 读路径零拷贝的边界写在这:命中返回的是缓存里那一份,不是副本。
    expect(again.tasks).toBe(first.tasks)
    expect(again).toEqual(first)
    // 消费方要改必须先自拷 —— 全仓审计的不变量:无人就地改 list() 返回的账。
    const privateCopy = structuredClone(first)
    privateCopy.tasks[0]!.title = '污染'
    expect((await tasks.list()).tasks[0]?.title).toBe('甲甲')
    const original = await readFile(file, 'utf8')
    const replacement = original.replace('甲甲', '乙乙')
    expect(Buffer.byteLength(replacement)).toBe(Buffer.byteLength(original))
    await writeFile(file, replacement)
    expect((await tasks.list()).tasks[0]?.title).toBe('乙乙')
    await writeFile(file, '{坏账')
    expect((await tasks.list()).problem).toContain('tasks.json')
    await writeFile(file, original)
    expect((await tasks.list()).tasks[0]?.title).toBe('甲甲')
    await tasks.update('t-1', { title: '丙丙' })
    expect((await tasks.list()).tasks[0]?.title).toBe('丙丙')
  })
  it('缺文件当空,不抛', async () => {
    expect(await loadTasksFile(await tmpFile())).toEqual(emptyTasksFile())
  })

  it('文件写坏了读出来是空的,不抛(只读的地方照旧显示空态)', async () => {
    const file = await tmpFile()
    await writeFile(file, '{ 这不是 JSON')
    expect(await loadTasksFile(file)).toEqual(emptyTasksFile())
  })

  it('tasks 不是数组时当空', async () => {
    const file = await tmpFile()
    await writeFile(file, JSON.stringify({ version: 1, tasks: { a: 1 } }))
    expect((await loadTasksFile(file)).tasks).toEqual([])
  })

  it('空文件当空账,不算坏(里面没有能丢的东西)', async () => {
    const file = await tmpFile()
    await writeFile(file, '  \n')
    expect(await readTasksFile(file)).toEqual({ ok: true, data: emptyTasksFile() })
  })
})

/**
 * 坏文件不被覆盖(2026-10-21,开源整理;复现步骤照工程师移交审查第六节)。
 * 原来读坏了当空账,下一次建卡就把空账加一张写回去 —— 原文件里几十张卡一张不剩。
 */
describe('tasks.json 读坏了:拒写、原文件原样、另存一份', () => {
  const TRUNCATED = '{"version":2,"tasks":[{"id":"t-old","title":"原来那张卡","status":"todo","source":{"kind":"manual"},"created_at":"a","updated_at":"b"},{"id":"t-o'

  it('写截断 JSON → list 报一句人话 → create 被拒 → 原文件一字不差', async () => {
    const file = await tmpFile()
    await writeFile(file, TRUNCATED)
    const tasks = svc(file)

    const listed = await tasks.list()
    expect(listed.tasks).toEqual([])
    expect(listed.problem).toContain('tasks.json')
    expect(listed.problem).toContain('原文件没动')

    await expect(tasks.create({ title: '新的一张' })).rejects.toBeInstanceOf(TasksFileUnreadableError)
    expect(await readFile(file, 'utf8')).toBe(TRUNCATED)
  })

  it('另存一份 tasks.json.corrupt-<时间>,内容与原文件相同;反复读不重复另存', async () => {
    const file = await tmpFile()
    await writeFile(file, TRUNCATED)
    const tasks = svc(file)
    await tasks.list()
    await tasks.list()
    await tasks.create({ title: 'x' }).catch(() => undefined)

    const copies = (await readdir(dirname(file))).filter(name => name.startsWith('tasks.json.corrupt-'))
    expect(copies).toHaveLength(1)
    expect(await readFile(join(dirname(file), copies[0] as string), 'utf8')).toBe(TRUNCATED)
    expect((await tasks.list()).problem).toContain(copies[0])
  })

  it('同时几处在读(/state 与后台刷新):只另存一份,每处说的是同一句', async () => {
    const file = await tmpFile()
    await writeFile(file, TRUNCATED)
    const reads = await Promise.all(Array.from({ length: 8 }, () => readTasksFile(file)))
    const problems = new Set(reads.map(read => (read.ok ? '' : read.problem)))
    expect(problems.size).toBe(1)
    const copies = (await readdir(dirname(file))).filter(name => name.startsWith('tasks.json.corrupt-'))
    expect(copies).toHaveLength(1)
    expect([...problems][0]).toContain(copies[0])
  })

  it('每一种写都被拒:改状态、改字段、删、冲刺、模块、项目元数据', async () => {
    const file = await tmpFile()
    await writeFile(file, TRUNCATED)
    const tasks = svc(file)
    const writes: Array<() => Promise<unknown>> = [
      () => tasks.move('t-old', 'doing'),
      () => tasks.update('t-old', { title: '改' }),
      () => tasks.remove('t-old'),
      () => tasks.advanceTopic('t-old'),
      () => tasks.createSprint({ projectId: 'p', name: 's' }),
      () => tasks.updateSprint('s', { name: 's2' }),
      () => tasks.removeSprint('s'),
      () => tasks.createModule({ sprintId: 's', name: 'm' }),
      () => tasks.updateModule('m', { name: 'm2' }),
      () => tasks.removeModule('m'),
      () => tasks.setProjectMeta('p', { priority: 'high' }),
    ]
    for (const write of writes) await expect(write()).rejects.toBeInstanceOf(TasksFileUnreadableError)
    expect(await readFile(file, 'utf8')).toBe(TRUNCATED)
  })

  it('JSON 合法但不是任务账的样子(tasks 不是数组)同样拒写', async () => {
    const file = await tmpFile()
    const text = JSON.stringify({ version: 2, tasks: { a: 1 } })
    await writeFile(file, text)
    await expect(svc(file).create({ title: 'x' })).rejects.toBeInstanceOf(TasksFileUnreadableError)
    expect(await readFile(file, 'utf8')).toBe(text)
  })

  it('修好之后自动恢复:换回能读的内容,下一次 create 照常写', async () => {
    const file = await tmpFile()
    await writeFile(file, TRUNCATED)
    const tasks = svc(file)
    await expect(tasks.create({ title: 'x' })).rejects.toBeInstanceOf(TasksFileUnreadableError)
    await writeFile(file, JSON.stringify({ version: 2, tasks: [] }))
    expect((await tasks.list()).problem).toBeUndefined()
    expect(await tasks.create({ title: '恢复后' })).toEqual({ ok: true, id: 't-1' })
  })

  it('读不出来(不是不存在,比如是个目录)也拒写,不当空账', async () => {
    const dir = dirname(await tmpFile())
    const file = join(dir, 'tasks.json')
    await mkdir(file)
    const tasks = svc(file)
    expect((await tasks.list()).problem).toContain('tasks.json')
    await expect(tasks.create({ title: 'x' })).rejects.toBeInstanceOf(TasksFileUnreadableError)
  })
})

describe('tasks.json 落盘(单条)', () => {

  it('坏掉的单条被挑掉,其余照常读出来——一张卡写坏不连累几十张', async () => {
    const file = await tmpFile()
    await writeFile(file, JSON.stringify({
      version: 1,
      tasks: [
        { id: 'ok', title: '好的', status: 'todo', source: { kind: 'manual' }, created_at: 'a', updated_at: 'b' },
        { id: '', title: '没有 id', status: 'todo' },
        { id: 'bad-status', title: '状态不认识', status: '已归档' },
        null,
      ],
    }))
    const loaded = await loadTasksFile(file)
    expect(loaded.tasks.map(task => task.id)).toEqual(['ok'])
  })

  /**
   * ★ 2026-09-30 维护者拍板把「带我过去」全删(见 `docs/决策记录.md` 末尾那一条)。
   * 升级那一下的接缝:**装新版之前存下的卡**上可能还挂着一个 `fix.kind === 'show_app'` 的派不出去说明。
   * 那一档已经没有了(`/agents/show` 整条口都不在),所以读回来时整个 `fix` 认不出 → 丢掉;
   * 那张卡本身与 `why`「派不出去」那几句一个字不动 —— 她看到的是原话,只是不再摆一颗按了没反应的键。
   */
  it('老卡上存着的「带我过去」(show_app)读回来时丢掉,卡本身照旧(2026-09-30 维护者拍板全删)', async () => {
    const file = await tmpFile()
    await writeFile(file, JSON.stringify({
      version: 1,
      tasks: [{
        id: 'old', title: '修一下首页', status: 'blocked', block_reason: 'input',
        source: { kind: 'manual' }, created_at: 'x', updated_at: 'y',
        dispatch_block: {
          family: 'codex', kind: 'code', at: 'z',
          why: '要让 Codex 直接改你电脑上的文件,还差一步:把 ChatGPT 更新到最新版',
          fix: { kind: 'show_app', family: 'codex', label: '带我过去', hint: '在 ChatGPT 里检查更新', desk_only: true },
        },
      }],
    }))
    const loaded = await loadTasksFile(file)
    expect(loaded.tasks.map(task => task.id)).toEqual(['old'])
    expect(loaded.tasks[0]?.dispatch_block?.why).toBe('要让 Codex 直接改你电脑上的文件,还差一步:把 ChatGPT 更新到最新版')
    expect(loaded.tasks[0]?.dispatch_block?.fix).toBeUndefined()
  })

  it('认不出的 source.kind 归成 manual,不整条丢掉', async () => {
    const file = await tmpFile()
    await writeFile(file, JSON.stringify({
      version: 1,
      tasks: [{ id: 'x', title: 't', status: 'todo', source: { kind: '外星来的' }, created_at: '', updated_at: '' }],
    }))
    expect((await loadTasksFile(file)).tasks[0]?.source).toEqual({ kind: 'manual' })
  })

  it('原子写:落盘后能原样读回,且没留下 .tmp 残骸', async () => {
    const file = await tmpFile()
    const data: TasksFile = {
      version: 2,
      tasks: [{
        id: 'a', title: '写个卡', status: 'doing', project_id: 'p1',
        source: { kind: 'note' }, created_at: 'x', updated_at: 'y',
      }],
      sprints: [],
      modules: [],
      project_meta: [],
    }
    await saveTasksFile(file, data)
    expect(await loadTasksFile(file)).toEqual(data)
    expect(JSON.parse(await readFile(file, 'utf8')) as TasksFile).toEqual(data)
  })

  it('默认路径与 projects/dock/scenes 同一个目录', () => {
    expect(defaultTasksFile('/Users/example')).toBe('/Users/example/.dsh/workbench/tasks.json')
  })
})

describe('TasksService:功能点那一层', () => {
  it('建卡:默认落在待办,带上时间戳与来源', async () => {
    const file = await tmpFile()
    const tasks = svc(file)
    const created = await tasks.create({ title: '  修好那个铃  ' })
    expect(created).toEqual({ ok: true, id: 't-1' })

    const { tasks: list } = await tasks.list()
    expect(list).toEqual([{
      id: 't-1',
      title: '修好那个铃', // 前后空白被削掉
      status: 'todo',
      source: { kind: 'manual' },
      execution_role: { kind: 'business', origin: 'explicit_task' },
      created_at: '2026-08-25T09:00:00.000Z',
      updated_at: '2026-08-25T09:00:00.000Z',
    }])
  })

  it('建卡:标题空白直接拒绝,不落一张看不出是什么的白卡', async () => {
    const tasks = svc(await tmpFile())
    expect(await tasks.create({ title: '   ' })).toEqual({ ok: false, reason: '功能点标题不能为空' })
    expect((await tasks.list()).tasks).toEqual([])
  })

  it('建卡:项目与来源原样带上(转卡的三个入口共用这一条路径)', async () => {
    const tasks = svc(await tmpFile())
    await tasks.create({
      title: '归档那批截图', projectId: 'p9', status: 'confirm', source: { kind: 'file', ref: '/tmp/a.png' },
    })
    expect((await tasks.list()).tasks[0]).toMatchObject({
      status: 'confirm', project_id: 'p9', source: { kind: 'file', ref: '/tmp/a.png' },
    })
  })

  it('改状态:updated_at 跟着走,created_at 不动', async () => {
    const file = await tmpFile()
    let now = NOW_SEC
    const tasks = svc(file, () => now)
    const { id } = await tasks.create({ title: 'a' })
    now = NOW_SEC + 3600
    // 待办不能一步到完成,得先经过进行中——转换表管着(见下面那个 describe)。
    await tasks.move(id as string, 'doing')
    expect(await tasks.move(id as string, 'done')).toEqual({ ok: true })

    const task = (await tasks.list()).tasks[0]
    expect(task?.status).toBe('done')
    expect(task?.created_at).toBe('2026-08-25T09:00:00.000Z')
    expect(task?.updated_at).toBe('2026-08-25T10:00:00.000Z')
  })

  it('改状态:卡不存在时 ok=false 且 reason 空着——HTTP 层据此回 404 而不是 409', async () => {
    const tasks = svc(await tmpFile())
    expect(await tasks.move('没有这张', 'doing')).toEqual({ ok: false })
  })

  it('改标题;空标题被拒,原标题保住', async () => {
    const tasks = svc(await tmpFile())
    const { id } = await tasks.create({ title: '原标题' })
    expect(await tasks.update(id as string, { title: '新标题' })).toBe(true)
    expect((await tasks.list()).tasks[0]?.title).toBe('新标题')

    expect(await tasks.update(id as string, { title: '  ' })).toBe(false)
    expect((await tasks.list()).tasks[0]?.title).toBe('新标题')
  })

  it('改归属:传 null 就从项目里摘出来(落进未归项目泳道)', async () => {
    const tasks = svc(await tmpFile())
    const { id } = await tasks.create({ title: 'a', projectId: 'p1' })
    expect(await tasks.update(id as string, { projectId: 'p2' })).toBe(true)
    expect((await tasks.list()).tasks[0]?.project_id).toBe('p2')

    expect(await tasks.update(id as string, { projectId: null })).toBe(true)
    expect((await tasks.list()).tasks[0]).not.toHaveProperty('project_id')
  })

  it('删卡:删掉的真没了,重复删返回 false', async () => {
    const tasks = svc(await tmpFile())
    const { id } = await tasks.create({ title: 'a' })
    await tasks.create({ title: 'b' })
    expect(await tasks.remove(id as string)).toBe(true)
    expect((await tasks.list()).tasks.map(task => task.title)).toEqual(['b'])
    expect(await tasks.remove(id as string)).toBe(false)
  })

  it('并发建卡不丢更新(写队列串行化,先例见 projectsService/scenes)', async () => {
    const tasks = svc(await tmpFile())
    await Promise.all(['a', 'b', 'c', 'd', 'e'].map(title => tasks.create({ title })))
    expect((await tasks.list()).tasks.map(task => task.title).sort()).toEqual(['a', 'b', 'c', 'd', 'e'])
  })
})

/**
 * 不可改清单第 5 条的延伸约束(PRD §9,设计稿 §3.5):事务层不得建议删除待办。
 *
 * 这条**在代码层面靠"不存在"保证**,所以守卫也只能是"清点有什么"。精确相等,不是包含
 * ——同款先例见 acceptance.v5.test.ts 对 MODULE_IDS 的断言。将来谁加一个自动清理能力,
 * 必须先在这里把它写进清单,改的时候人一定看得见。
 */
describe('不可改清单第 5 条延伸:看板不得有自动清理能力', () => {
  // 2026-09-21 选题池:多了第十三个 —— `advanceTopic`(「推进一步」)。
  // 它**也是手动动作**:只有 Ben 点那颗按钮才会走到,服务端自己一次都不调。
  // 2026-10-21 协作区:多了目标 / 冲刺 / 名片 / 留言 / 迁移回退 / 「这条会话不挂」十个。目标**没有删除**(不要了改 dropped);
  // 迁移是起服务时跑一次的格式升级(同 v1 → v2 那一次),不删任何东西,回退照账撤。
  // 10-22 第三轮 4(维护者定):多 setPlacedNotice / placedNotices 两个,只记「等你」里那行已办说明,不删、不动便签。
  // 2026-10-23 卡「待排的卡不许被派出去」④:多 removedSessionCards 一个,只读「删过」那张小表(写在 remove 里)。
  // 2026-10-24 协作区事实层(契约 B/C/D2):多八个 —— 条件存 / 删 / 核验 / 交付、留言、关系存 / 删 / 读。
  // 全是他亲手点的动作:核验与交付按任务当前轮次对账,留言 client_msg_id 幂等,关系画了线不自动执行。
  // 2026-10-24 契约 §5(E/F 同车):多五个 —— 身份读 / 存、成员读 / 整组写 / 登记。refresh 是 UI 显式触发,不是后台扫描。
  it('服务的能力清单精确对应公开动作', async () => {
    expect([...TASKS_SERVICE_METHODS]).toEqual([
      'list', 'create', 'move', 'update', 'remove', 'advanceTopic',
      'createSprint', 'updateSprint', 'removeSprint',
      'createModule', 'updateModule', 'removeModule',
      'setProjectMeta',
      'createGoal', 'updateGoal', 'saveGoalSprint', 'saveAgentCard', 'comment', 'resolveComment', 'recordReceipt',
      'migrateToGoals', 'rollbackGoals', 'dismissProposal', 'dismissedProposals',
      'setPlacedNotice', 'placedNotices', 'removedSessionCards',
      'saveSquad', 'removeSquad', 'saveTimer', 'removeTimer', 'recordTimerRun', 'saveMcp', 'removeMcp',
      'saveGoalCondition', 'removeGoalCondition', 'verifyGoalCondition', 'deliverGoalCondition',
      'message', 'saveRelation', 'removeRelation', 'listRelations',
      'prepareInvitation', 'finishInvitation',
      'lanChannel', 'saveLanMessage', 'lanIdentity', 'saveLanIdentity', 'lanMembers', 'saveLanMembers', 'rememberLanMember',
      // 2026-10-29 可靠执行闭环第一批第 1 步:执行身份与恢复记录(串行比较版本写入)。
      'readExecution', 'writeExecution', 'unfinishedExecutions',
      'lanSourcePolicies', 'saveLanSourcePolicy',
      // 2026-10-29(8791 第六轮):写成功订阅,只发通知、不改看板,驱动执行对账。
      'onMutated',
    ])
    expect(Object.keys(svc(await tmpFile())).sort()).toEqual([...TASKS_SERVICE_METHODS].sort())
  })

  it('源码里没有 archive/cleanup/prune/sweep/stale 这类自动清理入口', async () => {
    const source = await readFile(new URL('../src/server/tasks.ts', import.meta.url), 'utf8')
    // 注释里会提到这些词(说明"为什么没有"),只查函数/方法定义位置。
    const declarations = source.match(/^\s*(?:export\s+)?(?:async\s+)?(?:function\s+)?([A-Za-z_$][\w$]*)\s*[(:]/gm) ?? []
    const banned = /archive|cleanup|prune|sweep|stale|expire/i
    expect(declarations.filter(line => banned.test(line))).toEqual([])
  })

  it('放着不动的卡:多久都不会自己变(没有定时器,没有陈旧判定)', async () => {
    const file = await tmpFile()
    let now = NOW_SEC
    const tasks = svc(file, () => now)
    await tasks.create({ title: '一年没动的待办' })
    const before = await tasks.list()

    now = NOW_SEC + 365 * 24 * 3600
    // 重新构一个服务再读一遍——"重启工作台之后被清理掉"也在防范之列。
    expect(await svc(file, () => now).list()).toEqual(before)
  })
})

describe('TasksService:冲刺与模块两层', () => {
  it('建冲刺:名字、目标、组成版本号、起止都落盘', async () => {
    const tasks = svc(await tmpFile())
    const created = await tasks.createSprint({
      projectId: 'p1',
      name: '  冲刺一  ',
      goal: '把看板跑通',
      versions: [{ label: '客户端', version: 'V0.1' }, { label: '后端', version: 'V0.1' }],
      startsAt: '2026-08-25',
      endsAt: '2026-09-07',
    })
    expect(created).toEqual({ ok: true, id: 't-1' })
    expect((await tasks.list()).sprints[0]).toMatchObject({
      project_id: 'p1',
      name: '冲刺一',
      goal: '把看板跑通',
      versions: [{ label: '客户端', version: 'V0.1' }, { label: '后端', version: 'V0.1' }],
      starts_at: '2026-08-25',
      ends_at: '2026-09-07',
    })
  })

  it('建冲刺:名字空白或没有项目都拒绝', async () => {
    const tasks = svc(await tmpFile())
    expect((await tasks.createSprint({ projectId: 'p1', name: ' ' })).ok).toBe(false)
    expect((await tasks.createSprint({ projectId: '', name: '冲刺一' })).ok).toBe(false)
    expect((await tasks.list()).sprints).toEqual([])
  })

  it('改冲刺:goal 传 null 就清掉,versions 整组替换', async () => {
    const tasks = svc(await tmpFile())
    const { id } = await tasks.createSprint({ projectId: 'p1', name: 'S1', goal: '旧目标' })
    expect(await tasks.updateSprint(id as string, { goal: null })).toBe(true)
    expect((await tasks.list()).sprints[0]).not.toHaveProperty('goal')

    await tasks.updateSprint(id as string, { versions: [{ label: '客户端', version: 'V0.2' }] })
    expect((await tasks.list()).sprints[0]?.versions).toEqual([{ label: '客户端', version: 'V0.2' }])
  })

  it('建模块:挂在冲刺上,带模块目标', async () => {
    const tasks = svc(await tmpFile())
    const sprint = await tasks.createSprint({ projectId: 'p1', name: 'S1' })
    const module = await tasks.createModule({ sprintId: sprint.id as string, name: '播放模块', goal: '能连播' })
    expect(module.ok).toBe(true)
    expect((await tasks.list()).modules[0]).toMatchObject({
      sprint_id: sprint.id, name: '播放模块', goal: '能连播',
    })
  })

  it('项目元数据:优先级与执行人各自可设可清,同一个项目只留一条', async () => {
    const tasks = svc(await tmpFile())
    await tasks.setProjectMeta('p1', { priority: 'high', assignee: 'codex' })
    await tasks.setProjectMeta('p1', { priority: 'low' })
    expect((await tasks.list()).project_meta).toEqual([{ project_id: 'p1', priority: 'low', assignee: 'codex' }])

    await tasks.setProjectMeta('p1', { assignee: null })
    expect((await tasks.list()).project_meta[0]).not.toHaveProperty('assignee')
  })
})

/**
 * 层级删除的硬约束(不可改清单第 5 条延伸):删上面一层**绝不**级联删掉下面的待办。
 * 删一个冲刺就顺手扔掉几十条卡,那是系统替 Ben 做了他没说要做的清理。
 */
describe('删冲刺/删模块不级联删卡', () => {
  async function seed() {
    const tasks = svc(await tmpFile())
    const sprint = await tasks.createSprint({ projectId: 'p1', name: 'S1' })
    const module = await tasks.createModule({ sprintId: sprint.id as string, name: '播放模块' })
    await tasks.create({ title: '连播', projectId: 'p1', moduleId: module.id as string })
    return { tasks, sprintId: sprint.id as string, moduleId: module.id as string }
  }

  it('删模块:卡还在,只是退回未归模块', async () => {
    const { tasks, moduleId } = await seed()
    expect(await tasks.removeModule(moduleId)).toBe(true)

    const state = await tasks.list()
    expect(state.modules).toEqual([])
    expect(state.tasks).toHaveLength(1)
    expect(state.tasks[0]).not.toHaveProperty('module_id')
    expect(state.tasks[0]?.project_id).toBe('p1') // 项目归属不受影响
  })

  it('删冲刺:模块跟着退休,但卡一张不少,退回未归模块', async () => {
    const { tasks, sprintId } = await seed()
    expect(await tasks.removeSprint(sprintId)).toBe(true)

    const state = await tasks.list()
    expect(state.sprints).toEqual([])
    expect(state.modules).toEqual([])
    expect(state.tasks).toHaveLength(1)
    expect(state.tasks[0]).not.toHaveProperty('module_id')
  })

  it('删别的冲刺不动这个冲刺的模块', async () => {
    const { tasks, moduleId } = await seed()
    const other = await tasks.createSprint({ projectId: 'p1', name: 'S2' })
    await tasks.removeSprint(other.id as string)
    expect((await tasks.list()).modules.map(module => module.id)).toEqual([moduleId])
  })
})

describe('v1 旧存档升级', () => {
  it('只有一个平铺 tasks 数组的旧文件:卡一张不丢,只是还没有模块归属', async () => {
    const file = await tmpFile()
    await writeFile(file, JSON.stringify({
      version: 1,
      tasks: [
        { id: 'a', title: '旧卡甲', status: 'todo', project_id: 'p1', source: { kind: 'manual' }, created_at: 'x', updated_at: 'y' },
        { id: 'b', title: '旧卡乙', status: 'done', source: { kind: 'note' }, created_at: 'x', updated_at: 'y' },
      ],
    }))
    const loaded = await loadTasksFile(file)
    expect(loaded.version).toBe(2)
    expect(loaded.tasks.map(task => task.title)).toEqual(['旧卡甲', '旧卡乙'])
    expect(loaded.tasks.every(task => task.module_id === undefined)).toBe(true)
    expect(loaded.sprints).toEqual([])
    expect(loaded.modules).toEqual([])
  })
})

describe('功能点的新字段', () => {
  it('优先级/执行人/预期结束/功能描述都能设能清', async () => {
    const tasks = svc(await tmpFile())
    const { id } = await tasks.create({
      title: '连播', priority: 'high', assignee: 'codex', due: '2026-09-01', desc: '播完一首自动下一首',
    })
    expect((await tasks.list()).tasks[0]).toMatchObject({
      priority: 'high', assignee: 'codex', due: '2026-09-01', desc: '播完一首自动下一首',
    })

    await tasks.update(id as string, { priority: null, assignee: null, due: null, desc: null })
    const task = (await tasks.list()).tasks[0]
    for (const key of ['priority', 'assignee', 'due', 'desc']) expect(task).not.toHaveProperty(key)
  })

  it('认不出的优先级/执行人在读盘时被丢掉,不让界面显示一个不存在的档位', async () => {
    const file = await tmpFile()
    await writeFile(file, JSON.stringify({
      version: 2,
      tasks: [{
        id: 'a', title: 't', status: 'todo', priority: '特急', assignee: '张三',
        source: { kind: 'manual' }, created_at: '', updated_at: '',
      }],
    }))
    const task = (await loadTasksFile(file)).tasks[0]
    expect(task).not.toHaveProperty('priority')
    expect(task).not.toHaveProperty('assignee')
  })
})

describe('关联窗口与模块版本号', () => {
  it('一个功能点可以关联多个窗口,跨多家 agent(额度耗尽的交接)', async () => {
    const tasks = svc(await tmpFile())
    const { id } = await tasks.create({
      title: '连播',
      links: [{ agent: 'codex', session_id: 'sess-1', note: '先干的' }],
    })
    // 交接:整组替换(原来那条 + 新接手的那条)。
    await tasks.update(id as string, {
      links: [
        { agent: 'codex', session_id: 'sess-1', note: '先干的' },
        { agent: 'claude', session_id: 'sess-2' },
      ],
    })
    expect((await tasks.list()).tasks[0]?.links).toEqual([
      { agent: 'codex', session_id: 'sess-1', note: '先干的' },
      { agent: 'claude', session_id: 'sess-2' },
    ])

    // 传空数组 = 全部解除。
    await tasks.update(id as string, { links: [] })
    expect((await tasks.list()).tasks[0]).not.toHaveProperty('links')
  })

  it('认不出 agent 或缺 session_id 的关联在读盘时被挑掉', async () => {
    const file = await tmpFile()
    await writeFile(file, JSON.stringify({
      version: 2,
      tasks: [{
        id: 'a', title: 't', status: 'todo', source: { kind: 'manual' }, created_at: '', updated_at: '',
        links: [
          { agent: 'codex', session_id: 'ok' },
          { agent: '张三', session_id: 'x' },
          { agent: 'claude' },
        ],
      }],
    }))
    expect((await loadTasksFile(file)).tasks[0]?.links).toEqual([{ agent: 'codex', session_id: 'ok' }])
  })

  it('模块可以指一条组成版本(客户端/后端),也可以清掉', async () => {
    const tasks = svc(await tmpFile())
    const sprint = await tasks.createSprint({
      projectId: 'p1',
      name: 'S1',
      versions: [{ label: '客户端', version: 'V0.1' }, { label: '后端', version: 'V0.1' }],
    })
    const module = await tasks.createModule({
      sprintId: sprint.id as string, name: '播放模块', versionLabel: '客户端',
    })
    expect((await tasks.list()).modules[0]?.version_label).toBe('客户端')

    await tasks.updateModule(module.id as string, { versionLabel: '后端' })
    expect((await tasks.list()).modules[0]?.version_label).toBe('后端')

    await tasks.updateModule(module.id as string, { versionLabel: null })
    expect((await tasks.list()).modules[0]).not.toHaveProperty('version_label')
  })

  it('只存版本 label 不存版本号本身——版本号往前走时不用两处一起改', async () => {
    const tasks = svc(await tmpFile())
    const sprint = await tasks.createSprint({
      projectId: 'p1', name: 'S1', versions: [{ label: '客户端', version: 'V0.1' }],
    })
    await tasks.createModule({ sprintId: sprint.id as string, name: 'M1', versionLabel: '客户端' })

    await tasks.updateSprint(sprint.id as string, { versions: [{ label: '客户端', version: 'V0.2' }] })
    const state = await tasks.list()
    expect(state.modules[0]?.version_label).toBe('客户端')
    expect(state.sprints[0]?.versions).toEqual([{ label: '客户端', version: 'V0.2' }])
  })
})

/**
 * 任务状态机(2026-09-09,借 shengsheng90/DSH-taskboard 的七态语义;只借语义,那个插件
 * 不装、代码不抄——依据 docs/决策记录.md 2026-09-09「首批插件的取舍」)。
 *
 * 表在 protocol.ts(服务端与客户端共用一份真相:界面把去不了的格置灰,服务端照同一张表拒绝)。
 */
describe('转换表:纯函数 canTransition', () => {
  it('七态,顺序即看板列序,两条旁路排在最后', () => {
    expect([...TASK_STATUSES]).toEqual(['backlog', 'todo', 'doing', 'confirm', 'done', 'blocked', 'canceled'])
  })

  it('原地不动恒为合法——拖回原处、重复点同一格都不该报错', () => {
    for (const status of TASK_STATUSES) expect(canTransition(status, status)).toEqual({ ok: true })
  })

  it('主干那条路一步一步走得通:待排→待办→进行中→等我确认→完成', () => {
    expect(canTransition('backlog', 'todo').ok).toBe(true)
    expect(canTransition('todo', 'doing').ok).toBe(true)
    expect(canTransition('doing', 'confirm').ok).toBe(true)
    expect(canTransition('confirm', 'done').ok).toBe(true)
  })

  it('自己干完的活不必自己审一遍:进行中可以直接到完成', () => {
    expect(canTransition('doing', 'done').ok).toBe(true)
  })

  it('跳级被拒,而且回一句能直接显示给 Ben 看的中文(D13:拒绝要说原因)', () => {
    const checked = canTransition('todo', 'done')
    expect(checked.ok).toBe(false)
    expect(checked.ok === false && checked.reason).toBe(
      '「待办」不能直接改成「完成」;能去的是 「进行中」、「待排」、「阻塞」、「取消」',
    )
  })

  it('阻塞是从待办/进行中拐出去的旁路,不是「进行中」的一种', () => {
    expect(canTransition('todo', 'blocked').ok).toBe(true)
    expect(canTransition('doing', 'blocked').ok).toBe(true)
    expect(canTransition('blocked', 'doing').ok).toBe(true)
    expect(canTransition('blocked', 'todo').ok).toBe(true)
    // 卡住的事情没做完,不能直接算完成。
    expect(canTransition('blocked', 'done').ok).toBe(false)
  })

  it('取消不是终点:还能捡回来重排或重新待办', () => {
    expect(canTransition('canceled', 'backlog').ok).toBe(true)
    expect(canTransition('canceled', 'todo').ok).toBe(true)
    // 但不能从取消一步跳回进行中——捡回来要先落到待办,免得一张"不做了"的卡悄悄又在跑。
    expect(canTransition('canceled', 'doing').ok).toBe(false)
  })

  it('完成之后只剩重开一条路:done 不能被「取消」', () => {
    expect(canTransition('done', 'doing').ok).toBe(true)
    expect(canTransition('done', 'canceled').ok).toBe(false)
    expect(canTransition('done', 'backlog').ok).toBe(false)
  })

  it('表里每个目标都是认识的状态,没有写错的字面量', () => {
    for (const [from, targets] of Object.entries(TASK_TRANSITIONS)) {
      for (const to of targets) {
        expect(TASK_STATUSES).toContain(to)
        expect(to).not.toBe(from) // 原地不动由 canTransition 兜,不该在表里再写一遍
      }
    }
  })
})

describe('TasksService.move 按转换表把关', () => {
  it('合法转换照走,状态真的改了', async () => {
    const tasks = svc(await tmpFile())
    const { id } = await tasks.create({ title: 'a' })
    expect(await tasks.move(id as string, 'doing')).toEqual({ ok: true })
    expect((await tasks.list()).tasks[0]?.status).toBe('doing')
  })

  it('非法转换拒绝、回原因,而且**卡上的状态一个字都没动**', async () => {
    const tasks = svc(await tmpFile())
    const { id } = await tasks.create({ title: 'a' })
    const moved = await tasks.move(id as string, 'done')
    expect(moved.ok).toBe(false)
    expect(moved.reason).toContain('不能直接改成')
    expect((await tasks.list()).tasks[0]?.status).toBe('todo')
  })

  it('被拒的那次也不该动 updated_at——什么都没发生就不算改过', async () => {
    const file = await tmpFile()
    let now = NOW_SEC
    const tasks = svc(file, () => now)
    const { id } = await tasks.create({ title: 'a' })
    now = NOW_SEC + 3600
    await tasks.move(id as string, 'done')
    expect((await tasks.list()).tasks[0]?.updated_at).toBe('2026-08-25T09:00:00.000Z')
  })

  it('原地不动是合法的空操作(拖回原处)', async () => {
    const tasks = svc(await tmpFile())
    const { id } = await tasks.create({ title: 'a' })
    expect(await tasks.move(id as string, 'todo')).toEqual({ ok: true })
  })

  it('走一整圈:待办→进行中→等我确认→完成→重开→取消→捡回待办', async () => {
    const tasks = svc(await tmpFile())
    const { id } = await tasks.create({ title: 'a' })
    const card = id as string
    for (const status of ['doing', 'confirm', 'done', 'doing'] as const) {
      expect(await tasks.move(card, status)).toEqual({ ok: true })
    }
    expect(await tasks.move(card, 'canceled')).toEqual({ ok: true })
    expect(await tasks.move(card, 'todo')).toEqual({ ok: true })
    expect((await tasks.list()).tasks[0]?.status).toBe('todo')
  })
})

describe('老数据兼容:没有 status 的卡按待办读出来', () => {
  it('缺 status 字段的旧卡不再被整条丢掉,落进待办列', async () => {
    const file = await tmpFile()
    await writeFile(file, JSON.stringify({
      version: 2,
      tasks: [{ id: 'old', title: '很早以前记的一条', source: { kind: 'manual' }, created_at: 'x', updated_at: 'y' }],
    }))
    const loaded = await loadTasksFile(file)
    expect(loaded.tasks).toHaveLength(1)
    expect(loaded.tasks[0]?.status).toBe('todo')
  })

  it('status 是 null 同样按待办读——写坏一个字段不该让一条待办从界面上消失', async () => {
    const file = await tmpFile()
    await writeFile(file, JSON.stringify({
      version: 2,
      tasks: [{ id: 'old', title: 't', status: null, source: { kind: 'manual' }, created_at: '', updated_at: '' }],
    }))
    expect((await loadTasksFile(file)).tasks[0]?.status).toBe('todo')
  })

  it('四态时期存下来的卡原样认得,不需要迁移脚本', async () => {
    const file = await tmpFile()
    await writeFile(file, JSON.stringify({
      version: 2,
      tasks: ['todo', 'doing', 'confirm', 'done'].map((status, index) => ({
        id: `t${index}`, title: status, status, source: { kind: 'manual' }, created_at: '', updated_at: '',
      })),
    }))
    expect((await loadTasksFile(file)).tasks.map(task => task.status)).toEqual(['todo', 'doing', 'confirm', 'done'])
  })
})

/**
 * 「阻塞」列的卡可挂一个原因(2026-09-09 傍晚拍板第 4 条),用的是**会话等待原因同一套 id**
 * (approval / input / quota / error),不另造一套。
 */
describe('阻塞原因(block_reason)', () => {
  it('挂上、换掉、传 null 清掉', async () => {
    const tasks = svc(await tmpFile())
    const { id } = await tasks.create({ title: 'a', status: 'blocked' })
    expect(await tasks.update(id as string, { blockReason: 'approval' })).toBe(true)
    expect((await tasks.list()).tasks[0]?.block_reason).toBe('approval')

    expect(await tasks.update(id as string, { blockReason: 'quota' })).toBe(true)
    expect((await tasks.list()).tasks[0]?.block_reason).toBe('quota')

    expect(await tasks.update(id as string, { blockReason: null })).toBe(true)
    expect((await tasks.list()).tasks[0]).not.toHaveProperty('block_reason')
  })

  it('★离开「阻塞」列就清掉——原因是「为什么卡住」,卡不再卡住时它就是陈旧信息', async () => {
    const tasks = svc(await tmpFile())
    const { id } = await tasks.create({ title: 'a', status: 'blocked' })
    await tasks.update(id as string, { blockReason: 'input' })
    expect(await tasks.move(id as string, 'doing')).toEqual({ ok: true })
    expect((await tasks.list()).tasks[0]).not.toHaveProperty('block_reason')
  })

  it('读盘:认得出的 id 原样读出,认不出的整个字段挑掉(卡本身留着)', async () => {
    const file = await tmpFile()
    await writeFile(file, JSON.stringify({
      tasks: [
        { id: 'x', title: '甲', status: 'blocked', block_reason: 'quota', source: { kind: 'manual' } },
        { id: 'y', title: '乙', status: 'blocked', block_reason: '不认识', source: { kind: 'manual' } },
      ],
    }))
    const list = await loadTasksFile(file)
    expect(list.tasks.find(t => t.id === 'x')?.block_reason).toBe('quota')
    expect(list.tasks.find(t => t.id === 'y')).toBeDefined()
    expect(list.tasks.find(t => t.id === 'y')).not.toHaveProperty('block_reason')
  })
})

/**
 * 交付物(2026-09-09,待办第 5 条)。验收的对象是产物不是一句「完成」——
 * 但清单本身只是留痕:落盘、整组替换、坏条挑掉,不回查分支/文件还在不在。
 */
describe('交付物', () => {
  it('建卡时可带交付物,读回来一字不差;repo 只在有值时保留', async () => {
    const tasks = svc(await tmpFile())
    const { id } = await tasks.create({
      title: '任务卡挂交付物',
      deliverables: [
        { kind: 'branch', ref: 'claude/heuristic-noyce', repo: '/Users/example/Documents/GitHub/desktop-workbench' },
        { kind: 'url', ref: 'https://example.com/pr/1' },
      ],
    })
    expect((await tasks.list()).tasks[0]?.deliverables).toEqual([
      { kind: 'branch', ref: 'claude/heuristic-noyce', repo: '/Users/example/Documents/GitHub/desktop-workbench' },
      { kind: 'url', ref: 'https://example.com/pr/1' },
    ])
    expect(id).toBe('t-1')
  })

  it('update 是整组替换;传空数组 = 清空,字段整个消失而不是留一个 []', async () => {
    const tasks = svc(await tmpFile())
    const { id } = await tasks.create({ title: 'x', deliverables: [{ kind: 'file', ref: '/a.pdf' }] })
    await tasks.update(id as string, { deliverables: [{ kind: 'diff', ref: 'main..feat' }] })
    expect((await tasks.list()).tasks[0]?.deliverables).toEqual([{ kind: 'diff', ref: 'main..feat' }])
    await tasks.update(id as string, { deliverables: [] })
    expect((await tasks.list()).tasks[0]).not.toHaveProperty('deliverables')
  })

  it('不传 deliverables 的 update 不动它(改标题不该顺手把交付物抹掉)', async () => {
    const tasks = svc(await tmpFile())
    const { id } = await tasks.create({ title: 'x', deliverables: [{ kind: 'file', ref: '/a.pdf' }] })
    await tasks.update(id as string, { title: 'y' })
    expect((await tasks.list()).tasks[0]?.deliverables).toEqual([{ kind: 'file', ref: '/a.pdf' }])
  })

  it('读盘时认不出 kind、或 ref 为空的那条挑掉,其余照常;老卡没有这个字段照常读', async () => {
    const file = await tmpFile()
    await writeFile(file, JSON.stringify({
      version: 2,
      tasks: [
        {
          id: 'a', title: 't', status: 'confirm', source: { kind: 'manual' }, created_at: '', updated_at: '',
          deliverables: [
            { kind: 'branch', ref: 'feat/x', repo: '' },
            { kind: '压缩包', ref: '/x.zip' },
            { kind: 'url', ref: '' },
            'not-an-object',
          ],
        },
        { id: 'b', title: '老卡', status: 'todo', source: { kind: 'manual' }, created_at: '', updated_at: '' },
      ],
    }))
    const loaded = await loadTasksFile(file)
    expect(loaded.tasks[0]?.deliverables).toEqual([{ kind: 'branch', ref: 'feat/x' }])
    expect(loaded.tasks[1]).not.toHaveProperty('deliverables')
  })
})

describe('完成时刻 done_at(2026-09-09 排期风险)', () => {
  it('move 到 done 时盖章', async () => {
    const file = await tmpFile()
    let now = NOW_SEC
    const tasks = svc(file, () => now)
    const { id } = await tasks.create({ title: 'a' })
    await tasks.move(id as string, 'doing')
    now = NOW_SEC + 7200
    await tasks.move(id as string, 'done')
    expect((await tasks.list()).tasks[0]?.done_at).toBe('2026-08-25T11:00:00.000Z')
  })

  it('重开(done → doing)时清掉——它已经不是一条完成的卡了,留着会把速度算虚', async () => {
    const tasks = svc(await tmpFile())
    const { id } = await tasks.create({ title: 'a' })
    await tasks.move(id as string, 'doing')
    await tasks.move(id as string, 'done')
    await tasks.move(id as string, 'doing')
    expect((await tasks.list()).tasks[0]?.done_at).toBeUndefined()
  })

  it('改标题不动 done_at——完成之后改个字不该让速度跟着变', async () => {
    const file = await tmpFile()
    let now = NOW_SEC
    const tasks = svc(file, () => now)
    const { id } = await tasks.create({ title: 'a' })
    await tasks.move(id as string, 'doing')
    await tasks.move(id as string, 'done')
    now = NOW_SEC + 86_400
    await tasks.update(id as string, { title: 'b' })
    const task = (await tasks.list()).tasks[0]
    expect(task?.done_at).toBe('2026-08-25T09:00:00.000Z')
    expect(task?.updated_at).toBe('2026-08-26T09:00:00.000Z')
  })

  it('老存档里的 done_at 原样读出来,不是字符串就当没有', async () => {
    const file = await tmpFile()
    const at = '2026-08-20T09:00:00.000Z'
    await saveTasksFile(file, {
      ...emptyTasksFile(),
      tasks: [
        { id: 'a', title: '甲', status: 'done', done_at: at, source: { kind: 'manual' }, created_at: at, updated_at: at },
        { id: 'b', title: '乙', status: 'done', done_at: 12345, source: { kind: 'manual' }, created_at: at, updated_at: at },
      ] as unknown as TasksFile['tasks'],
    })
    const list = (await loadTasksFile(file)).tasks
    expect(list[0]?.done_at).toBe(at)
    expect(list[1]?.done_at).toBeUndefined()
  })
})

describe('要本人拍板的结构化请求 owner_ask(2026-10-26,卡「事务官页接管队列」)', () => {
  const ask = { kind: 'spend' as const, proposal: '买这个', basis: '核过的事实', by: 'butler', at: '2026-08-25T09:00:00.000Z' }

  it('update 标上 owner_ask,落盘后再读还在', async () => {
    const file = await tmpFile()
    const tasks = svc(file)
    const { id } = await tasks.create({ title: 'a', status: 'confirm' })
    expect(await tasks.update(id as string, { ownerAsk: ask })).toBe(true)
    expect((await tasks.list()).tasks[0]?.owner_ask).toEqual(ask)
    // 重开一份服务:盘上 sanitize 过同一道门,坏形状进不了盘。
    const reread = svc(file)
    expect((await reread.list()).tasks[0]?.owner_ask).toEqual(ask)
  })

  it('update 接到坏形状(类别不在四类 / 缺方案 / 缺依据)不写入', async () => {
    const tasks = svc(await tmpFile())
    const { id } = await tasks.create({ title: 'a', status: 'confirm' })
    expect(await tasks.update(id as string, { ownerAsk: { kind: 'unknown' as never, proposal: 'x', basis: 'y', at: "2026-08-25T09:00:00.000Z" } })).toBe(true)
    expect((await tasks.list()).tasks[0]).not.toHaveProperty('owner_ask')
    expect(await tasks.update(id as string, { ownerAsk: { kind: 'spend', proposal: '', basis: 'y', at: "2026-08-25T09:00:00.000Z" } })).toBe(true)
    expect((await tasks.list()).tasks[0]).not.toHaveProperty('owner_ask')
  })

  it('update 传 null 清掉 owner_ask', async () => {
    const tasks = svc(await tmpFile())
    const { id } = await tasks.create({ title: 'a', status: 'confirm' })
    await tasks.update(id as string, { ownerAsk: ask })
    await tasks.update(id as string, { ownerAsk: null })
    expect((await tasks.list()).tasks[0]).not.toHaveProperty('owner_ask')
  })

  it('move 离开「等我确认」清掉 owner_ask,但 transitions 留痕(退回与重开保留历史)', async () => {
    const tasks = svc(await tmpFile())
    const { id } = await tasks.create({ title: 'a', status: 'confirm' })
    await tasks.update(id as string, { ownerAsk: ask })
    // 退回在做:请求本身被答掉擦掉。
    expect(await tasks.move(id as string, 'doing')).toEqual({ ok: true })
    const back = (await tasks.list()).tasks[0]!
    expect(back).not.toHaveProperty('owner_ask')
    expect(back.transitions?.at(-1)).toMatchObject({ from: 'confirm', to: 'doing' })
    // 重开回「等你」:不带旧请求,要事务官重新标。
    expect(await tasks.move(id as string, 'confirm')).toEqual({ ok: true })
    expect((await tasks.list()).tasks[0]).not.toHaveProperty('owner_ask')
  })
})
