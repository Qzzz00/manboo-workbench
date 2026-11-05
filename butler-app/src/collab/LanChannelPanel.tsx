import { useEffect, useState } from 'react';
import type { ApiClient } from '../api/client';
import { collabClient } from '../api/collab';
import { friendlyWhen } from '../api/protocol';
import { Markdown } from '../ui/Markdown';
import { DeliveryList } from './DeliveryList';
import { CATEGORY_TITLES, readLanChannel, safeSourceUrl, type LanChannelSnapshot, type LanMessageRow, type Publication, type SourceScope } from './lanChannelSource';

/** 人类只读本地项目频道；来源快照不推成全LAN纳管，引用不假跳本机同ID事项。 */
export function LanChannelPanel(props: { client: ApiClient; projects: readonly { id: string; name: string }[]; refreshToken: unknown; now: string }) {
  const { client, projects, refreshToken, now } = props;
  const [chosen, setChosen] = useState<string>();
  const projectId = projects.find(project => project.id === chosen)?.id ?? projects[0]?.id;
  const [round, setRound] = useState(0);
  const [view, setView] = useState<{ client?: ApiClient; projectId?: string; snapshot?: LanChannelSnapshot; loading: boolean; error?: string }>({ loading: true });
  useEffect(() => {
    if (projectId === undefined) return;
    let alive = true;
    setView(old => ({ client, projectId, snapshot: old.client === client && old.projectId === projectId ? old.snapshot : undefined, loading: true }));
    void collabClient(client).lanChannel(projectId).then(result => {
      if (!alive) return;
      const snapshot = result.ok ? readLanChannel(result.data, projectId) : undefined;
      const error = result.ok ? snapshot === undefined ? '局域网频道回包无法确认来源或项目' : undefined : result.error;
      setView(old => ({ client, projectId, snapshot: snapshot ?? old.snapshot, loading: false, ...(error === undefined ? {} : { error }) }));
    }).catch(() => { if (alive) setView(old => ({ ...old, loading: false, error: '这会儿读不到局域网频道' })); });
    return () => { alive = false; };
  }, [client, projectId, refreshToken, round]);
  const current = view.projectId === projectId && view.client === client ? view : { loading: true, snapshot: undefined, error: undefined };
  return <section aria-label="局域网项目频道">
    <h3 className="ba-collab__sub">局域网项目频道 <span className="ba-collab__n">人类只读</span></h3>
    {projectId === undefined ? <p className="ba-collab__unwired">本机事项与目标尚未归到项目,局域网频道范围未知。</p> : <>
      <label className="ba-collab__intent">项目
        <select aria-label="局域网项目频道" value={projectId} onChange={event => setChosen(event.target.value)}>
          {projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>
      </label>
      <p className="ba-collab__unwired">LAN 本地传输 · 已知配对成员范围;未配对与失联成员的情况未知。</p>
      {current.error !== undefined && <p className="ba-collab__error" role="alert">{current.error}</p>}
      {current.error !== undefined && current.snapshot !== undefined && <p className="ba-collab__unwired">下面是上次读到的消息与来源快照,当前来源状态未知。</p>}
      {current.snapshot === undefined && current.loading && <p className="ba-collab__empty">正在读局域网频道…</p>}
      {current.snapshot !== undefined && <ChannelSnapshot key={projectId} snapshot={current.snapshot} now={now} stale={current.error !== undefined} />}
      <button type="button" className="ba-btn ba-btn--ghost" disabled={current.loading} onClick={() => setRound(n => n + 1)}>刷新局域网频道</button>
    </>}
  </section>;
}
function SourceStatus({ scope, stale }: { scope: SourceScope | undefined; stale: boolean }) {
  return <div className="ba-collab__sourceinfo" aria-label="本机来源入口">
    <p>{stale ? '上次来源入口快照,当前状态未知;本机入口不代表整个局域网。' : '本机来源入口,不代表整个局域网。'}</p>
    {scope === undefined ? <p>本机来源入口状态未知,旧来源未提供或当前无法确认。</p> : <>
      <p>{{ unwired: '本机资讯来源未接入', empty: '本机资讯来源已知为空或关闭', ready: '本机资讯来源可读', unknown: '本机资讯来源未知或失联' }[scope.news]}</p>
      <p>{scope.reports === 'ready' ? '本机报告材料可读' : '本机报告材料范围未知,不能当作没有发生'}</p>
      <p>{scope.publication_enabled ? '本机来源发布已启用' : '本机来源发布未启用'} · 手机只读</p>
      {scope.notes?.map((note, index) => <p key={index}>{note}</p>)}
    </>}
    <p>配对来源:来自已配对发送者的来源声明,本机未独立核验对端源文件。</p>
  </div>;
}
function ChannelSnapshot({ snapshot, now, stale }: { snapshot: LanChannelSnapshot; now: string; stale: boolean }) {
  const [category, setCategory] = useState('all'), [topic, setTopic] = useState('all'), [source, setSource] = useState('all');
  const rows = snapshot.rows;
  const categories = new Set<string>(rows.map(row => row.publication?.category ?? 'unknown'));
  const selectedCategory = category === 'all' || categories.has(category) ? category : 'all';
  const inCategory = rows.filter(row => selectedCategory === 'all' || (row.publication?.category ?? 'unknown') === selectedCategory);
  const topics = new Map(inCategory.flatMap(row => row.publication === undefined ? [] : [[row.publication.topic.id, row.publication.topic.title] as const]));
  const selectedTopic = topic === 'all' || topics.has(topic) ? topic : 'all';
  const inTopic = inCategory.filter(row => selectedTopic === 'all' || row.publication?.topic.id === selectedTopic);
  const sources = new Map(inTopic.flatMap(row => row.publication === undefined ? [] : [[row.publication.source.id, row.publication.source.publisher ?? row.publication.source.kind] as const]));
  const selectedSource = source === 'all' || sources.has(source) ? source : 'all';
  const shown = inTopic.filter(row => selectedSource === 'all' || row.publication?.source.id === selectedSource);
  return <>
    <SourceStatus scope={snapshot.sourceScope} stale={stale} />
    {rows.length > 0 && <div className="ba-collab__sourcefilters">
      <label>内容<select aria-label="频道内容分类" value={selectedCategory} onChange={event => { setCategory(event.target.value); setTopic('all'); setSource('all'); }}>
        <option value="all">全部内容</option>
        {Object.entries(CATEGORY_TITLES).filter(([key]) => categories.has(key)).map(([key, title]) => <option key={key} value={key}>{title}</option>)}
        {categories.has('unknown') && <option value="unknown">未分类记录</option>}
      </select></label>
      {topics.size > 0 && <label>话题<select aria-label="频道话题" value={selectedTopic} onChange={event => { setTopic(event.target.value); setSource('all'); }}>
        <option value="all">全部话题</option>{[...topics].map(([id, title]) => <option key={id} value={id}>{title} · {id}</option>)}
      </select></label>}
      {sources.size > 0 && <label>来源<select aria-label="频道来源" value={selectedSource} onChange={event => setSource(event.target.value)}>
        <option value="all">全部来源</option>{[...sources].map(([id, title]) => <option key={id} value={id}>{title} · {id}</option>)}
      </select></label>}
    </div>}
    {rows.length === 0 && <p className="ba-collab__empty">{stale ? '上次读到的消息为空,当前情况未知。' : '这个项目的已知成员范围里还没有消息。'}</p>}
    {rows.length > 0 && shown.length === 0 && <p className="ba-collab__empty">当前筛选没有已读消息,来源范围不因此改变。</p>}
    {shown.map(message => <article key={`${message.authorId}:${message.id}`} className="ba-collab__act" data-message-id={message.id}>
      <span className="ba-collab__actic" aria-hidden>{message.publication === undefined ? message.report ? '执' : '言' : CATEGORY_TITLES[message.publication.category].slice(0, 1)}</span>
      <div className="ba-collab__actbody">
        <div className="ba-collab__acthead"><span>{message.authorName} · {message.authorId}</span><span>消息记录时间 {friendlyWhen(message.at, now)}</span></div>
        {message.publication === undefined ? <p className="ba-collab__unwired">{message.report ? '执行回执 · ' : ''}未分类记录,没有正式来源快照;不按正文猜分类。</p> : <SourceDetails publication={message.publication} memberId={message.authorId} />}
        {message.replyTo !== undefined && <div className="ba-collab__actquote">回应:{rows.find(original => original.id === message.replyTo)?.text ?? `${message.replyTo}(原消息不在当前记录里)`}</div>}
        <MessageBody message={message} />
        {message.deliveries.length > 0 && <DeliveryList messageId={message.id} deliveries={message.deliveries} now={now} />}
      </div>
    </article>)}
  </>;
}
function SourceDetails({ publication: p, memberId }: { publication: Publication; memberId: string }) {
  const url = safeSourceUrl(p.source.url);
  const references = p.refs.map((ref, index) => ref.kind === 'task' ? <p key={index}>发送成员 {memberId} 的事项引用:{ref.title} · {ref.id};尚未接通跨机读取。</p>
    : <p key={index}>{safeSourceUrl(ref.url) === undefined ? `${ref.title} · ${ref.id}(链接不可用)` : <a href={safeSourceUrl(ref.url)} target="_blank" rel="noopener noreferrer">{ref.title} · {ref.id}</a>}</p>);
  return <div className="ba-collab__sourceinfo">
    <p>{CATEGORY_TITLES[p.category]} · 话题:{p.topic.title} · {p.topic.id}</p>
    <p>来源:{p.source.id} · {p.source.kind === 'feed' ? '该项目资讯材料' : '发送成员本机项目记录'}</p>
    <p>{p.source.publisher === undefined ? '发布者未知' : `发布者:${p.source.publisher}`}</p>
    <p>{p.source.published_at === undefined ? '发表时间未知' : `发表时间:${p.source.published_at}`} · 来源记录时间:{p.source.recorded_at}</p>
    {p.source.period !== undefined && <p>时期:{p.source.period.from} → {p.source.period.to}</p>}
    <p>{url === undefined ? `原链接${p.source.url === undefined ? '未知' : `无法安全打开:${p.source.url}`}` : <a href={url} target="_blank" rel="noopener noreferrer">原链接:{p.source.url}</a>}</p>
    {p.refs.some(ref => ref.kind === 'task') && <p>事项引用属于发送成员 {memberId},本机尚未接通跨机读取。</p>}
    {p.refs.length > 3 ? <details className="ba-collab__refs"><summary>查看 {p.refs.length} 项来源引用</summary>{references}</details> : references}
  </div>;
}
function MessageBody({ message }: { message: LanMessageRow }) {
  const category = message.publication?.category;
  const expandedReport = category === 'daily' || category === 'weekly' || message.text.length > 900;
  const body = <Markdown text={message.text} className="ba-collab__sourcebody" />;
  return expandedReport ? <details className="ba-collab__report"><summary>展开{category === 'daily' || category === 'weekly' ? CATEGORY_TITLES[category] : message.report ? '执行回执' : '消息'}正文 · {message.text.length} 字符</summary>{body}</details>
    : <div className="ba-collab__acttext">{message.text}</div>;
}
