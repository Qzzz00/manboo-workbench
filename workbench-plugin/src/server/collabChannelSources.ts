/** 原F来源适配:既有FeedService与项目任务/执行账,程序拼装;只在显式策略下发布。 */
import { createHash } from 'node:crypto'
import type { LanChannelCategory, LanChannelMessage, LanChannelRef, LanChannelSource, LanChannelSourceScope, LanChannelTopic, TaskView } from '../protocol.ts'
import { STATUS_TITLES, WAIT_REASON_TITLES } from '../protocol.ts'
import type { FeedService } from './feed.ts'
import type { JobLog } from './jobLog.ts'
import type { TasksService } from './tasks.ts'
import { localDateStr } from './brief.ts'
import { isoTime } from './collabStore.ts'

export type LanSourceMaterial = { project_id: string, text: string, category: LanChannelCategory, source: LanChannelSource, topic: LanChannelTopic, refs: readonly LanChannelRef[] }
function period(now: number, weekly: boolean) {
  const end = new Date(now); end.setHours(0, 0, 0, 0)
  if (weekly) end.setDate(end.getDate() - (end.getDay() + 6) % 7)
  const start = new Date(end); start.setDate(start.getDate() - (weekly ? 7 : 1))
  return { from: localDateStr(start.getTime()), to: localDateStr(end.getTime() - 1), start: start.getTime(), end: end.getTime() }
}
function projectReport(project: string, tasks: readonly TaskView[], jobLog: JobLog | undefined, now: number, category: 'daily' | 'weekly'): LanSourceMaterial | undefined {
  const p = period(now, category === 'weekly'), inside = (at: string | undefined) => at !== undefined && Date.parse(at) >= p.start && Date.parse(at) < p.end
  const mine = tasks.filter(t => t.project_id === project), ids = new Set(mine.map(t => t.id))
  const events = jobLog?.all().filter(e => ids.has(e.job) && inside(e.at)) ?? []
  const created = mine.filter(t => inside(t.created_at)), closed = mine.filter(t => inside(t.done_at))
  if (created.length === 0 && closed.length === 0 && events.length === 0) return undefined
  const byStatus = new Map<TaskView['status'], number>()
  for (const task of mine) byStatus.set(task.status, (byStatus.get(task.status) ?? 0) + 1)
  const incomplete = jobLog === undefined || jobLog.dropped() > 0 || jobLog.unreadable() > 0 || jobLog.persistError() !== undefined
  const title = `${category === 'daily' ? '日报' : '周报'} ${p.from}${p.from === p.to ? '' : `—${p.to}`}`
  const lines = [title, `项目:${project}`, '范围:仅本机当前纳管项目事项及可读执行账,不代表全源/全网。',
    `期间在册新建事项:${created.length};期间事项收卡:${closed.length}(不能作执行完成数)。`,
    `当前状态快照(${new Date(now).toISOString()}):${[...byStatus].map(([status, n]) => `${STATUS_TITLES[status]}=${n}`).join('、')};“进行中”仅为事项状态。`,
    ...(jobLog === undefined ? ['执行账未接入,实际开工/完成未知。'] : [
      `期间已记录事件:${[['assigned', '指派'], ['started', '核到开工'], ['replied', '收到交回'], ['timeout', '等待超时'], ['unreadable', '无法读取'], ['not_sent', '未送出']].map(([step, title]) => `${title}=${events.filter(e => e.step === step).length}`).join('、')}(含持续活动记录,不能作执行次数)。`,
      ...(events.some(e => e.step === 'started' || e.step === 'replied') ? [] : ['无执行源开工/交回证据,实际开工/完成未知。']),
      ...(incomplete ? ['执行账不完整,缺失范围未知,不把未记录解释为未发生。'] : ['计数只覆盖当前可读账,未纳管及已移除事项的历史未知。']),
    ]),
    ...mine.filter(t => t.status === 'blocked').slice(0, 10).map(t => `当前受阻:${t.title}${t.block_reason === undefined ? '(原因未知)' : `(${WAIT_REASON_TITLES[t.block_reason]})`}`),
    ...(mine.length > 100 ? ['引用只列前100条当前事项。'] : []),
  ]
  return { project_id: project, category, text: lines.join('\n'),
    source: { kind: 'project-report', id: `${category}:${project}:${p.from}:${p.to}`, scope: 'local-project-records', recorded_at: new Date(now).toISOString(), period: { from: p.from, to: p.to } },
    topic: { id: `project:${project}`, title: project }, refs: mine.slice(0, 100).map(t => ({ kind: 'task', id: t.id, title: t.title.slice(0, 200) })) }
}

export function createChannelSourcePublisher(deps: {
  tasks: TasksService, feed?: Pick<FeedService, 'view'>, jobLog?: JobLog, now: () => number,
  publish: (material: LanSourceMaterial, recipients: readonly string[]) => Promise<{ status: number, message?: LanChannelMessage, error?: string }>,
  changed: () => Promise<void>,
}) {
  let queue: Promise<unknown> = Promise.resolve(), lastMinute = ''
  async function read(project: string) {
    const state = await deps.tasks.list(), at = deps.now(), materials: LanSourceMaterial[] = [], notes: string[] = []
    const scope: LanChannelSourceScope = { news: 'unwired', reports: 'unknown', peer_sources: 'paired-origin-claims', publication_enabled: false }
    if (deps.feed !== undefined) {
      try {
        const view = deps.feed.view()
        if (!view.config.enabled) { scope.news = 'empty'; notes.push('资讯来源已关闭') }
        else if (view.last_error !== undefined) { scope.news = 'unknown'; notes.push('资讯入口当前失败,旧消息保留') }
        else {
          const items = view.groups.filter(g => g.project_id === project).flatMap(g => g.items).filter(i => i.score > 0 && i.feedback !== 'mute' && i.feedback !== 'decline').slice(0, 20)
          scope.news = items.length === 0 ? 'unknown' : 'ready'
          if (items.length === 0) notes.push('本项目当前没有可用已选资讯材料,未纳管资讯未知')
          for (const item of items) {
            const hash = createHash('sha256').update(JSON.stringify([item.title, item.why, item.url, item.source, item.published_at, item.topic])).digest('hex').slice(0, 16)
            const publishedAt = isoTime(item.published_at)
            materials.push({ project_id: project, category: 'news', text: `${item.title}\n${item.why}`,
              source: { kind: 'feed', id: `feed:${project}:${item.id}:${hash}`, recorded_at: new Date(item.at).toISOString(), scope: 'project-feed', url: item.url,
                ...(item.source === undefined ? {} : { publisher: item.source }), ...(publishedAt === undefined ? {} : { published_at: publishedAt }) },
              topic: { id: `feed:${item.id}`, title: (item.topic?.title ?? item.title).slice(0, 200) }, refs: [{ kind: 'url', id: item.id, title: item.title.slice(0, 200), url: item.url }] })
          }
        }
      } catch { scope.news = 'unknown'; notes.push('资讯来源暂不可读,旧消息保留') }
    } else notes.push('这台未接资讯入口')
    for (const category of ['daily', 'weekly'] as const) {
      const report = projectReport(project, state.tasks, deps.jobLog, at, category)
      if (report !== undefined) { materials.push(report); scope.reports = 'ready' }
    }
    if (scope.reports === 'unknown') notes.push('最近完整日/周缺少可用项目材料,进展未知,不生成空报告')
    return { materials, scope: { ...scope, notes } }
  }
  async function publish(project: string) {
    const policy = (await deps.tasks.lanSourcePolicies()).find(p => p.project_id === project)
    if (policy?.enabled !== true) return { status: 409, error: '项目来源发布未启用', messages: [] }
    const state = await deps.tasks.list()
    if (!state.tasks.some(t => t.project_id === project) && !(state.goals ?? []).some(g => g.project_id === project)) return { status: 409, error: '这台未加入该项目', messages: [] }
    const { materials, scope } = await read(project), self = await deps.tasks.lanIdentity()
    // 已保存来源快照优先,失败重试不依赖来源再次在线,不重新生成同一期报告。
    const stored = (await deps.tasks.lanChannel(project)).filter(m => m.author.member_id === self.member_id && m.source !== undefined && m.category !== undefined)
    const pending = new Map<string, { material: LanSourceMaterial, recipients: readonly string[] }>()
    for (const material of materials) pending.set(material.source.id, { material, recipients: policy.recipients })
    for (const m of stored) {
      // 来源当前不可得时只重试原失败目标,更换接收者不隐式补发历史。
      const recipients = pending.has(m.source!.id) ? policy.recipients : policy.recipients.filter(to => m.deliveries?.some(d => d.to === to && (d.status === 'failed' || d.status === 'pending')))
      if (recipients.length > 0) pending.set(m.source!.id, { material: { project_id: m.project_id, text: m.text, category: m.category!, source: m.source!, topic: m.topic!, refs: m.refs! }, recipients })
    }
    const messages: LanChannelMessage[] = [], errors: { source_id: string, error: string }[] = []
    for (const { material, recipients } of pending.values()) {
      if (!policy.categories.includes(material.category)) continue
      if (material.category !== 'news' && new Date(deps.now()).getHours() < 9) continue
      const current = (await deps.tasks.lanSourcePolicies()).find(p => p.project_id === project)
      if (current?.enabled !== true || current.version !== policy.version) { errors.push({ source_id: material.source.id, error: '策略已变,后续发布已停止;已送出的内容仍保留' }); break }
      const result = await deps.publish(material, recipients)
      if (result.message !== undefined) messages.push(result.message)
      if (result.status !== 200 || result.error !== undefined) errors.push({ source_id: material.source.id, error: result.error ?? '来源发布失败,已有内容保留' })
    }
    if (messages.length > 0) await deps.changed()
    return { status: 200, ok: errors.length === 0, messages, errors, source_scope: { ...scope, publication_enabled: true } }
  }
  const enqueue = (project: string) => { const out = queue.then(() => publish(project)); queue = out.catch(() => undefined); return out }
  return {
    publish: enqueue,
    async scope(project: string) {
      const value = (await read(project)).scope
      value.publication_enabled = (await deps.tasks.lanSourcePolicies()).some(p => p.project_id === project && p.enabled)
      return value
    },
    async pump() {
      const key = String(Math.floor(deps.now() / 60_000))
      if (key === lastMinute) return
      lastMinute = key
      for (const policy of await deps.tasks.lanSourcePolicies()) if (policy.enabled) await enqueue(policy.project_id).catch(() => undefined)
    },
  }
}
