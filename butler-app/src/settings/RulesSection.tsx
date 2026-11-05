/**
 * 手机设置里的「记住的规矩」(2026-09-24 晚,卡 K;desktop-workbench docs/设计-全局自进化-2026-09-24.md 确认点 1)。
 *
 * 与电脑设置里那一节(workbench-plugin/src/client/RulesPanel.tsx)是**同一张表**:都读 `GET /butler/rules`、
 * 删 / 改 / 写一条 / 恢复都打同一组 `POST /butler/rules*`。维护者 9/29 起只带手机,这张表在手机上必须改得动
 * (出了局域网走房间代理,白名单在 channel-worker/src/rpc.ts)。
 *
 * 单开一个组件而不是写进 SettingsPage:那一页上同时有好几张卡在改,少碰一行少一次冲突(同 NewsSettings)。
 * 不露内部的东西:不显示 id、英文键名(他的规矩 ③)。
 */
import { useEffect, useState } from 'react';
import { useSession } from '../session';

/** 与 workbench-plugin/src/protocol.ts 的 ButlerRuleView 同形(两个仓库不互相 import)。只取这里用得到的几格。 */
export interface PhoneRuleView {
  id: string;
  text: string;
  area: 'all' | 'say' | 'ui' | 'review' | 'content';
  status: 'active' | 'trial' | 'kept' | 'reverted' | 'removed';
  origin: 'said' | 'repeated' | 'observation' | 'topic';
  evidence: readonly { channel: string; at: string; text: string }[];
  created_at: string;
  editable: boolean;
  verdict?: string;
}

export interface PhoneRulesView {
  rules: readonly PhoneRuleView[];
  retired: readonly PhoneRuleView[];
}

const AREA_TITLES: Record<PhoneRuleView['area'], string> = { all: '全局', say: '说话', ui: '界面', review: '验收', content: '内容' };

/** 一条规矩后面那一小行(块 · 哪天 · 试用到哪了)。 */
export function phoneRuleMeta(rule: PhoneRuleView): string {
  const day = (rule.evidence[0]?.at ?? rule.created_at).slice(0, 10);
  const state = rule.status === 'trial' ? ' · 试用中' : rule.status === 'kept' ? ' · 验过了' : '';
  return `${AREA_TITLES[rule.area]} · ${day}${state}`;
}

function isRulesView(body: unknown): body is PhoneRulesView {
  if (typeof body !== 'object' || body === null) return false;
  const raw = body as Record<string, unknown>;
  return Array.isArray(raw.rules) && Array.isArray(raw.retired);
}

export function RulesSection() {
  const session = useSession();
  const [view, setView] = useState<PhoneRulesView | null>(null);
  const [off, setOff] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [showRetired, setShowRetired] = useState(false);

  async function reload(): Promise<void> {
    const result = await session.client.json<unknown>('/butler/rules');
    if (!result.ok) { setOff(true); return; }
    if (isRulesView(result.data)) { setView(result.data); setOff(false); }
  }

  useEffect(() => { void reload(); }, [session]);

  // 没接规矩表(老工作台 404 / 连不上):整节不出现 —— 不摆一张点了没用的表。
  if (off || view === null) return null;

  async function send(path: string, body: Record<string, unknown>): Promise<void> {
    setBusy(true);
    setNote(null);
    const result = await session.client.json<{ ok?: boolean; note?: string; error?: string }>(path, { method: 'POST', body });
    if (!result.ok) setNote(result.error);
    else setNote(result.data?.note ?? '好了。');
    await reload();
    setBusy(false);
  }

  return (
    <section className="ba-settings__sec" aria-label="记住的规矩">
      <h2 className="ba-inbox__h">记住的规矩</h2>
      <p className="ba-settings__line ba-settings__dim">你说过一次就处处算数:打电话、回话、派活、验收、摆界面都照这张表做。不对就删掉或改一句。</p>
      {view.rules.length === 0 && <p className="ba-settings__line ba-settings__dim">还没有。跟事务官说「以后都…」「不要…」,或者在下面写一条。</p>}
      {view.rules.map(rule => (
        <div className="ba-settings__line" key={rule.id} data-rule-status={rule.status}>
          {editing?.id === rule.id
            ? (
                <input
                  className="ba-settings__input"
                  aria-label="改这条规矩"
                  value={editing.text}
                  onChange={(e) => setEditing({ id: rule.id, text: e.target.value })}
                />
              )
            : <span>{rule.text}</span>}
          <span className="ba-settings__dim"> {phoneRuleMeta(rule)}</span>
          <span className="ba-row">
            {rule.editable && (editing?.id === rule.id
              ? (
                  <button
                    type="button"
                    className="ba-btn ba-btn--ghost"
                    disabled={busy || editing.text.trim() === ''}
                    onClick={() => { const text = editing.text; setEditing(null); void send('/butler/rules/update', { id: rule.id, text }); }}
                  >
                    存
                  </button>
                )
              : <button type="button" className="ba-btn ba-btn--ghost" disabled={busy} onClick={() => setEditing({ id: rule.id, text: rule.text })}>改</button>)}
            <button type="button" className="ba-btn ba-btn--ghost" disabled={busy} onClick={() => { void send('/butler/rules/remove', { id: rule.id }); }}>
              {rule.origin === 'topic' ? '撤' : '删'}
            </button>
          </span>
        </div>
      ))}
      <p className="ba-settings__line">
        <input
          className="ba-settings__input"
          aria-label="写一条新规矩"
          placeholder="比如:以后派活先截图给我看"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button
          type="button"
          className="ba-btn ba-btn--ghost"
          disabled={busy || draft.trim() === ''}
          onClick={() => { const text = draft; setDraft(''); void send('/butler/rules', { text, channel: 'phone' }); }}
        >
          记下
        </button>
      </p>
      {view.retired.length > 0 && (
        <>
          <button type="button" className="ba-btn ba-btn--ghost" onClick={() => setShowRetired(!showRetired)}>
            {showRetired ? '收起' : `不再照做的(${view.retired.length})`}
          </button>
          {showRetired && view.retired.map(rule => (
            <div className="ba-settings__line ba-settings__dim" key={rule.id}>
              <span>{rule.text}</span>
              {rule.origin !== 'topic' && (
                <button type="button" className="ba-btn ba-btn--ghost" disabled={busy} onClick={() => { void send('/butler/rules/restore', { id: rule.id }); }}>恢复</button>
              )}
            </div>
          ))}
        </>
      )}
      {note !== null && <p className="ba-settings__line ba-settings__dim" role="status">{note}</p>}
    </section>
  );
}
