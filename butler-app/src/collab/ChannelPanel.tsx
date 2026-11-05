/**
 * 协作频道面板(2026-10-24,小K):事务官聊天室,人类**只读**。
 *
 * 工作室四态(未接中转/离线/没有/已加入)如实;已加入 → 频道清单 → 消息流
 * (全部/资讯/日报/周报筛选;撤回折「已撤回」;refs 摆标题);成员列表显示名与
 * 稳定身份(account)分开。发送框**不存在** —— 发言的是各台事务官。
 * LAN 项目频道与中转频道分开读取；身份改名不改变稳定关联，人类没有频道发送框。
 */
import { useCallback, useEffect, useState } from 'react';
import { friendlyWhen } from '../api/protocol';
import type { ApiClient } from '../api/client';
import { messageRows, type ChannelMessageRow, type ChannelView } from './channelApi';
import {
  guardLanIdentity,
  guardLanMembers,
  guardLanSave,
  type RawLanIdentity,
  type RawLanMember,
} from './collabCore';
import type { StudioData } from './useStudio';
import { LanChannelPanel } from './LanChannelPanel';

type Filter = 'all' | 'say' | 'daily' | 'weekly';

const FILTERS: readonly { key: Filter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'say', label: '资讯' },
  { key: 'daily', label: '日报' },
  { key: 'weekly', label: '周报' },
];

export function ChannelPanel(props: {
  client: ApiClient;
  studio: StudioData;
  tick: number | undefined;
  /** 电脑的钟(/state.now):消息时刻照它写,与全页同一口径。 */
  now: string;
  projects: readonly { id: string; name: string }[];
  refreshToken: unknown;
}) {
  const { client, studio, now } = props;
  const [channelId, setChannelId] = useState<string | null>(null);

  // 局域网身份与成员不依赖中转工作室:先摆(契约 §5 的真实底座),工作室四态在下面。
  const lan = <><LanSection client={client} /><LanChannelPanel client={client} projects={props.projects} refreshToken={props.refreshToken} now={now} /></>;
  if (studio.loading && studio.studio === undefined) {
    return (
      <>
        {lan}
        <p className="ba-collab__empty" role="status">正在读工作室…</p>
      </>
    );
  }
  if (studio.error !== undefined && studio.studio === undefined) {
    return (
      <>
        {lan}
        <p className="ba-collab__error" role="alert">{studio.error}</p>
        <p className="ba-collab__unwired">中转工作室资料由电脑读取;当前没有读到结果。</p>
        <button type="button" className="ba-btn ba-btn--ghost" onClick={studio.retry}>再读一次</button>
      </>
    );
  }
  const view = studio.studio;
  if (view === undefined || view.state === 'unknown') {
    return (
      <>
        {lan}
        <p className="ba-collab__empty">读不懂工作室的状态(可能是老工作台)。</p>
        <button type="button" className="ba-btn ba-btn--ghost" onClick={studio.retry}>再读一次</button>
      </>
    );
  }
  if (view.state === 'unwired') {
    return (
      <>
        {lan}
        <p className="ba-collab__empty">这台电脑还没接中转工作室{view.why !== undefined ? `:${view.why}` : ''}。</p>
      </>
    );
  }
  if (view.state === 'offline') {
    return (
      <>
        {lan}
        <p className="ba-collab__empty">工作室这会儿连不上{view.why !== undefined ? `:${view.why}` : ''}。</p>
        <button type="button" className="ba-btn ba-btn--ghost" onClick={studio.retry}>再读一次</button>
      </>
    );
  }
  if (view.state === 'none') {
    return (
      <>
        {lan}
        <p className="ba-collab__empty">还没有工作室。频道是事务官们的工作室聊天室,在电脑上建起来之后这里就能看。</p>
      </>
    );
  }

  // —— joined ——
  const active = channelId === null ? undefined : view.channels.find((c) => c.id === channelId);
  return (
    <>
      {active === undefined ? (
        <>
          {lan}
          <h3 className="ba-collab__sub">
            频道 <span className="ba-collab__n">{view.workspaceName ?? '工作室'} · 只读</span>
          </h3>
          {view.channels.length === 0 && <p className="ba-collab__empty">工作室里还没有频道。</p>}
          <div className="ba-collab__chans">
            {view.channels.map((c) => (
              <button key={c.id} type="button" className="ba-collab__chan" onClick={() => setChannelId(c.id)}>
                <span>
                  {c.name}
                  {c.kind === 'project' && <span className="ba-collab__tag">项目{c.projectName !== undefined ? ` · ${c.projectName}` : ''}</span>}
                </span>
                <span className="ba-collab__meta">{c.version > 0 ? `${c.version} 条` : '空的'}</span>
              </button>
            ))}
          </div>
          <h3 className="ba-collab__sub">成员 <span className="ba-collab__n">显示名 · 稳定身份</span></h3>
          <div className="ba-collab__facts">
            {view.members.map((m) => (
              <div key={m.accountId} className="ba-collab__fact">
                <span className="ba-collab__factk">{m.role === 'admin' ? '管理员' : '成员'}</span>
                <span className="ba-collab__factv">
                  {m.nick ?? m.accountId}
                  <span className="ba-collab__meta"> · {m.accountId}{m.devices !== undefined && m.devices.length > 0 ? ` · ${m.devices.join('/')}` : ''}</span>
                </span>
              </div>
            ))}
          </div>
          <p className="ba-collab__readonly">你在频道里只读:发言与日报/周报由各台事务官发。改名与重名扫描还没接入。</p>
          <p className="ba-collab__unwired">成员来自中转工作室名单;局域网成员发现底座未接入,不冒称 LAN 发现。</p>
        </>
      ) : (
        <ChannelMessages
          client={client}
          channelId={active.id}
          tick={props.tick}
          now={now}
          onBack={() => setChannelId(null)}
        />
      )}
    </>
  );
}

function ChannelMessages(props: {
  client: ApiClient;
  channelId: string;
  tick: number | undefined;
  now: string;
  onBack(): void;
}) {
  const { client, channelId, tick, now, onBack } = props;
  const [view, setView] = useState<ChannelView | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const [filter, setFilter] = useState<Filter>('all');
  const [round, setRound] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(undefined);
    client
      .json<unknown>(`/collab/relay/channel?id=${encodeURIComponent(channelId)}`, { method: 'GET' })
      .then((res) => {
        if (!alive) return;
        if (res.ok) setView(messageRows(res.data));
        else setError(res.error || '读不到频道');
      })
      .catch(() => { if (alive) setError('读不到频道'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
    // tick 变(新消息/成员变动)与手动重试都重读。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, channelId, tick, round]);

  const shown = (view?.messages ?? []).filter((m) => filter === 'all' || m.kind === filter);

  return (
    <>
      <h3 className="ba-collab__sub">
        <button type="button" className="ba-collab__linkbtn" onClick={onBack}>‹ 频道</button>
        <span className="ba-collab__n">{view?.name ?? ''}</span>
      </h3>
      <div className="ba-collab__filters" role="group" aria-label="按话题筛选">
        {FILTERS.map((f) => (
          <button key={f.key} type="button" className="ba-collab__scope" data-on={filter === f.key} onClick={() => setFilter(f.key)}>
            {f.label}
          </button>
        ))}
      </div>
      {loading && view === undefined && <p className="ba-collab__empty" role="status">正在读消息…</p>}
      {error !== undefined && (
        <>
          <p className="ba-collab__error" role="alert">{error}</p>
          <button type="button" className="ba-btn ba-btn--ghost" onClick={() => setRound((r) => r + 1)}>再读一次</button>
        </>
      )}
      {!loading && error === undefined && shown.length === 0 && (
        <p className="ba-collab__empty">{filter === 'all' ? '这个频道还没有消息。' : `这个频道还没有${FILTERS.find((f) => f.key === filter)?.label ?? ''}。`}</p>
      )}
      {shown.map((m) => <MessageRow key={m.id} m={m} now={now} />)}
      <p className="ba-collab__readonly">人类在这个频道只读;没有发送框。</p>
    </>
  );
}

function MessageRow({ m, now }: { m: ChannelMessageRow; now: string }) {
  return (
    <div className="ba-collab__msg" data-retracted={m.retracted}>
      <div className="ba-collab__msgh">
        <span className="ba-collab__tag">{m.kindTitle}</span>
        <span>{m.authorName}{m.butler && <span className="ba-collab__tag">事务官代发</span>}</span>
        {m.identity !== '' && <span>{m.identity}</span>}
        <span>{friendlyWhen(m.at, now)}</span>
      </div>
      {m.replyToText !== undefined && <div className="ba-collab__actquote">回:{m.replyToText}</div>}
      <div className="ba-collab__msgt">{m.text}</div>
      {m.refs.length > 0 && (
        <div className="ba-collab__actquote">
          {m.refs.map((r) => (r.title !== undefined ? `关联:${r.title}` : `关联:${r.objectId}`)).join(' · ')}
        </div>
      )}
    </div>
  );
}


/**
 * 局域网身份与成员(契约 §5):本机事务官的展示名 + 稳定身份(member_id 改名不换);
 * 改名先归一查重(服务端),重名/成员列表不完整/并发冲突都保留输入并如实说;
 * 成员可达要她点「刷新可达」按需 ping —— 没有后台扫描,没 refresh 过 = 未知,不说在线。
 */
function LanSection({ client }: { client: ApiClient }) {
  const [identity, setIdentity] = useState<RawLanIdentity | undefined>(undefined);
  const [members, setMembers] = useState<RawLanMember[] | undefined>(undefined);
  const [identityError, setIdentityError] = useState<string>();
  const [memberError, setMemberError] = useState<string>();
  const [draft, setDraft] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    void client.json<unknown>('/collab/lan/identity', { method: 'GET' }).then((res) => {
      if (!alive) return;
      if (!res.ok) { setIdentityError(res.error); return; }
      const got = guardLanIdentity(res.data);
      if (got === undefined) { setIdentityError('身份回包格式不认识'); return; }
      setIdentity(got);
      setIdentityError(undefined);
      setDraft((d) => (d === '' ? got.name : d));
    }).catch(() => { if (alive) setIdentityError('这会儿读不到局域网身份'); });
    void client.json<unknown>('/collab/lan/members', { method: 'GET' }).then((res) => {
      if (!alive) return;
      if (!res.ok) { setMemberError(res.error); return; }
      const got = guardLanMembers(res.data);
      if (got === undefined) { setMemberError('成员回包格式不认识,名单范围未知'); return; }
      setMembers(got); setMemberError(undefined);
    }).catch(() => { if (alive) setMemberError('这会儿读不到成员,名单范围未知'); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  const save = async () => {
    setNotice(null);
    const name = draft.trim();
    if (name === '') { setNotice('名字不能为空'); return; }
    if (identity === undefined) { setNotice('身份还没读到,等一等再存'); return; }
    setSaving(true);
    try {
      const res = await client.json<unknown>('/collab/lan/identity', {
        method: 'POST',
        body: { name, expected_version: identity.version },
      });
      if (res.ok) {
        const got = guardLanSave(res.data);
        if (got.ok && got.identity !== undefined) {
          setIdentity(got.identity);
          setDraft(got.identity.name);
          setNotice('已改名;稳定身份不变,旧消息与协作关联不丢');
        } else setNotice(got.error ?? '没存上');
        return;
      }
      setNotice(`${res.error}(名字没存,输入给你留着)`);
      // ApiClient 的失败侧只有 error；用真实 GET 读最新版本，草稿保留给她核对后再存。
      if (res.status === 409) {
        const latest = await client.json<unknown>('/collab/lan/identity', { method: 'GET' });
        const current = latest.ok ? guardLanIdentity(latest.data) : undefined;
        if (current !== undefined) {
          setIdentity(current);
          setNotice(`${res.error} · 当前名字:${current.name};草稿已保留,核对后可再保存`);
        }
      }
    } catch {
      setNotice('这会儿读不到电脑,名字没存,输入已保留');
    } finally {
      setSaving(false);
    }
  };

  const refresh = useCallback(() => {
    setRefreshing(true);
    setNotice(null);
    void client.json<unknown>('/collab/lan/members?refresh=1', { method: 'GET' }).then((res) => {
      setRefreshing(false);
      if (res.ok) {
        const got = guardLanMembers(res.data);
        if (got === undefined) setMemberError('成员回包格式不认识,名单范围未知');
        else { setMembers(got); setMemberError(undefined); }
      } else setMemberError(`刷新没成:${res.error}`);
    }).catch(() => { setRefreshing(false); setMemberError('刷新没成,名单范围未知'); });
  }, [client]);

  return (
    <section aria-label="局域网身份与成员">
      <h3 className="ba-collab__sub">
        本机与局域网成员 <span className="ba-collab__n">显示名 · 稳定身份 {identity?.memberId ?? '…'}</span>
      </h3>
      {identity === undefined && <p className="ba-collab__unwired">{identityError ?? '正在读取局域网身份…'}</p>}
      <div className="ba-collab__intent">
        <input
          className="ba-collab__draft"
          style={{ minHeight: 0, padding: '6px 10px' }}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          aria-label="事务官名字"
          placeholder="这台事务官的名字"
        />
        <button type="button" className="ba-btn ba-btn--ghost" onClick={() => { void save(); }} disabled={identity === undefined || saving}>{saving ? '正在保存…' : '保存名字'}</button>
      </div>
      <p className="ba-collab__unwired">保存前服务端做归一查重(全半角/大小写/空白);成员列表不完整时可用性未知,不硬说「可用」。</p>
      <div className="ba-collab__facts">
        {members?.map((m) => (
          <div key={m.memberId} className="ba-collab__fact">
            <span className="ba-collab__factk">{m.memberId === identity?.memberId ? '本机' : '成员'}</span>
            <span className="ba-collab__factv">
              {m.name}
              <span className="ba-collab__meta">
                {' · '}{m.memberId}
                {' · '}{m.host}:{m.port}
                {' · '}{m.reachable === undefined ? '可达未知(还没刷过)' : m.reachable ? `可达${m.lastSeen !== undefined ? ` · ${friendlyWhen(m.lastSeen, undefined)}` : ''}` : '不可达'}
              </span>
            </span>
          </div>
        ))}
        {members === undefined && <p className="ba-collab__unwired">{memberError ?? '正在读取已知成员…'}</p>}
        {members !== undefined && memberError !== undefined && <p className="ba-collab__error">{memberError};下面保留上次读到的成员。</p>}
        {members?.length === 0 && <p className="ba-collab__unwired">注册表里还没有别的成员;配对/见面时登记。</p>}
      </div>
      <div className="ba-collab__intent">
        <button type="button" className="ba-btn ba-btn--ghost" onClick={refresh} disabled={refreshing}>
          {refreshing ? '正在逐个 ping…' : '刷新可达'}
        </button>
      </div>
      {notice !== null && <p className="ba-collab__notice" role="status">{notice}</p>}
    </section>
  );
}
