import { useEffect, useState } from 'react'
import type { LanChannelCategory, LanChannelMessage, LanChannelSourceScope } from '../../protocol.ts'
import type { CollabApi } from './collabApi.ts'
import { ReportText } from './ReportText.tsx'

const CATEGORY_TITLES: Readonly<Record<LanChannelCategory | 'unknown', string>> = { news: '资讯', daily: '日报', weekly: '周报', unknown: '分类未知' }
// 正式来源成组消费；旧服务或残缺快照不靠正文推断分类。
function categoryOf(one: LanChannelMessage): LanChannelCategory | 'unknown' {
  return one.category !== undefined && one.topic !== undefined && one.source !== undefined && Array.isArray(one.refs) ? one.category : 'unknown'
}
function dateText(iso: string): string {
  const at = new Date(iso)
  return Number.isNaN(at.getTime()) ? '未知' : at.toLocaleString('zh-CN', { hour12: false })
}
function webUrl(url?: string): string | undefined {
  if (url === undefined) return undefined
  try { const parsed = new URL(url); return ['http:', 'https:'].includes(parsed.protocol) ? url : undefined } catch { return undefined }
}
function SourceScope({ scope, offline }: { scope?: LanChannelSourceScope, offline: boolean }) {
  return <aside className="ben-cl__source-scope" aria-label="本机来源范围">
    <b>{offline ? '上次已知本机来源范围' : '本机来源范围'}</b>
    {scope === undefined ? <p>本机来源范围未知，服务未提供来源状态。</p> : <>
      <p>{({ unwired: '本机资讯来源未接入', empty: '本机资讯来源已知为空', ready: '本机资讯来源已接入', unknown: '本机资讯来源状态未知' })[scope.news]}；{scope.reports === 'ready' ? '本机项目报告材料可读' : '本机项目报告材料未知'}。</p>
      <p>本机自动发布：{scope.publication_enabled ? '已启用' : '未启用'}。</p>
      {scope.notes?.map((note, index) => <p key={index}>{note}</p>)}
    </>}
    <p>仅说明本机来源，不代表整个局域网；本机未接入也能收到配对成员的来源消息。</p>
    <p>配对来源声明：来自发送成员的稳定身份，本机未独立核验对端源文件；未纳管材料与对端当前来源状态未知。</p>
  </aside>
}
function MessageSource({ one }: { one: LanChannelMessage }) {
  if (categoryOf(one) === 'unknown' || one.source === undefined || one.topic === undefined) return <p className="ben-cl__muted">分类未知 · 未提供完整正式来源快照。</p>
  const source = one.source
  const originalUrl = webUrl(source.url)
  return <div className="ben-cl__message-source">
    <p title={one.topic.id}>话题：{one.topic.title}</p>
    <p>来源：{source.kind === 'feed' ? '项目资讯' : '发送成员本机项目记录'} · <span title={source.id}>{source.id}</span></p>
    {source.kind === 'feed' && <p>发布者：{source.publisher ?? '未知'} · {originalUrl === undefined ? '原链接未知' : <a href={originalUrl} target="_blank" rel="noreferrer">原文</a>}</p>}
    {source.kind === 'feed' && <p>发表时间：{source.published_at === undefined ? '未知' : <time dateTime={source.published_at} title={source.published_at}>{dateText(source.published_at)}</time>}</p>}
    {source.kind === 'project-report' && <p>报告时期：{source.period === undefined ? '未知' : `${source.period.from} — ${source.period.to}`}</p>}
    <p>来源记录时间：<time dateTime={source.recorded_at} title={source.recorded_at}>{dateText(source.recorded_at)}</time></p>
    {(one.refs ?? []).map((ref, index) => {
      const url = ref.kind === 'url' ? webUrl(ref.url) : undefined
      return <p className="ben-cl__msg-ref" key={`${ref.kind}-${ref.id}-${index}`}>
        {ref.kind === 'task' ? <>发送成员原件，只读引用 · {one.author.name}（{one.author.member_id}） · {ref.title} · ID：{ref.id}</> : url === undefined ? <>原文引用 · {ref.title} · 链接未知</> : <a href={url} target="_blank" rel="noreferrer">{ref.title}</a>}
      </p>
    })}
  </div>
}

/** 人类只读；保留完整项目快照以定位筛选外的 reply_to，所有筛选只消费正式字段。 */
export function LanProjectFeed({ api, projectId, tick, nowMs: _nowMs }: { api: CollabApi, projectId: string, tick: unknown, nowMs: number }) {
  const [snapshot, setSnapshot] = useState<{ messages: readonly LanChannelMessage[], source_scope?: LanChannelSourceScope }>()
  const [offline, setOffline] = useState(false)
  const [category, setCategory] = useState('all')
  const [topic, setTopic] = useState('all')
  useEffect(() => {
    let alive = true
    void api.get<{ transport?: string, messages?: LanChannelMessage[], source_scope?: LanChannelSourceScope }>(`/collab/lan/channel?project_id=${encodeURIComponent(projectId)}`).then(got => {
      if (!alive) return
      if (got?.transport !== 'lan' || !Array.isArray(got.messages)) { setOffline(true); return }
      setOffline(false)
      setSnapshot({ messages: got.messages, ...(got.source_scope === undefined ? {} : { source_scope: got.source_scope }) })
    })
    return () => { alive = false }
  }, [api, projectId, tick])
  const messages = snapshot?.messages
  const categories = [...new Set(messages?.map(categoryOf) ?? [])]
  const selectedCategory = categories.some(value => value === category) ? category : 'all'
  const categoryMessages = messages?.filter(one => selectedCategory === 'all' || categoryOf(one) === selectedCategory) ?? []
  const topics = new Map(categoryMessages.filter(one => categoryOf(one) !== 'unknown' && one.topic !== undefined).map(one => [one.topic!.id, one.topic!.title]))
  const selectedTopic = topics.has(topic) ? topic : 'all'
  const visible = categoryMessages.filter(one => selectedTopic === 'all' || one.topic?.id === selectedTopic)
  return <>
    {offline && <p role="status" className="ben-cl__muted">局域网频道此刻读不到{messages === undefined ? '，消息状态未知。' : '，下面保留上次已知记录。'}</p>}
    {!offline && messages === undefined && <p role="status" className="ben-cl__muted">正在读局域网消息…</p>}
    {(snapshot !== undefined || offline) && <SourceScope {...(snapshot?.source_scope === undefined ? {} : { scope: snapshot.source_scope })} offline={offline && snapshot !== undefined} />}
    {messages?.length === 0 && <p className="ben-cl__muted">这个项目还没有局域网消息。</p>}
    {messages !== undefined && messages.length > 0 && <>
      <div className="ben-cl__source-filters">
        <label>分类 <select aria-label="局域网消息分类" value={selectedCategory} onChange={event => { setCategory(event.target.value); setTopic('all') }}><option value="all">全部分类</option>{categories.map(value => <option key={value} value={value}>{CATEGORY_TITLES[value]}</option>)}</select></label>
        {topics.size > 0 && <label>话题 <select aria-label="局域网消息话题" value={selectedTopic} onChange={event => setTopic(event.target.value)}><option value="all">全部话题</option>{[...topics].map(([id, title]) => <option key={id} value={id}>{title}</option>)}</select></label>}
      </div>
      <ul className="ben-cl__msgs" aria-label="局域网消息">{visible.map(one => {
        const original = messages.find(message => message.id === one.reply_to)
        const formalCategory = categoryOf(one)
        return <li key={one.id} id={`lan-message-${one.id}`} className="ben-cl__msg">
          <div className="ben-cl__msg-head"><b title={one.author.member_id}>{one.author.name}</b><small>局域网 · 消息时间：<time dateTime={one.at} title={one.at}>{dateText(one.at)}</time> · {one.kind === 'report' ? '报告' : '消息'} · {CATEGORY_TITLES[formalCategory]}</small></div>
          <MessageSource one={one} />
          <ReportText text={one.text} report={one.kind === 'report' || formalCategory === 'daily' || formalCategory === 'weekly'} />
          {one.reply_to !== undefined && (original === undefined ? <p className="ben-cl__muted">引用 · 原消息未在当前项目记录中 · {one.reply_to}</p> : <a className="ben-cl__link" href={`#lan-message-${one.reply_to}`} onClick={() => { setCategory('all'); setTopic('all'); requestAnimationFrame(() => document.getElementById(`lan-message-${one.reply_to}`)?.scrollIntoView?.({ block: 'nearest' })) }}>引用 · {original.text.slice(0, 80)}</a>)}
          {(one.deliveries ?? []).map(delivery => <small key={delivery.to} className="ben-cl__talk-delivery" data-status={delivery.status}>
            → {messages.find(message => message.author.member_id === delivery.to)?.author.name ?? delivery.to}：{({ pending: '待投递', delivered: '已送达', accepted: '已回执', failed: '未确认送达' })[delivery.status]}{delivery.error === undefined ? '' : ` · ${delivery.error}`}
          </small>)}
        </li>
      })}</ul>
    </>}
  </>
}
