/**
 * 设置 › 高级 › 删掉测试单子(2026-10-01,维护者:「测试单子删了吧,都是脏数据」)。
 *
 * 测试单子 = 我们测派活、测提问弹窗时建的那些(认法见 items/inboxTabs.ts `isTestTicket`)。事项页早已不摆它们;
 * 这里是真删:她按了、再点一次「删掉」,才一条条走 `POST /task/delete`(电脑看板上「删除」那条路,删了找不回)。
 * 删不掉的照实说几条。
 */
import { useMemo, useState } from 'react';
import { useSession } from '../session';
import { useFeed } from '../hooks';
import { testTickets } from '../items/inboxTabs';

export function TestTicketsSection() {
  const session = useSession();
  const feed = useFeed(session.feed);
  const tickets = useMemo(() => testTickets(feed.state), [feed.state]);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<string | undefined>(undefined);

  const run = async (): Promise<void> => {
    setBusy(true);
    let ok = 0;
    for (const one of tickets) {
      const res = await session.client.json<{ ok?: boolean }>('/task/delete', { method: 'POST', body: { id: one.id } }).catch(() => ({ ok: false as const }));
      if (res.ok) ok += 1;
    }
    const failed = tickets.length - ok;
    setReceipt(failed === 0 ? `删掉了 ${ok} 条测试单子。` : `删掉了 ${ok} 条,${failed} 条没删掉(电脑没连上,或那张已经不在了)。`);
    setAsking(false);
    setBusy(false);
    void session.feed.refresh().catch(() => undefined);
  };

  return (
    <section className="ba-settings__sec">
      <h2 className="ba-inbox__h">测试单子</h2>
      <p className="ba-settings__line">
        {tickets.length === 0 ? '看板上没有测试单子了。' : `看板上有 ${tickets.length} 条测试单子(派活测试、自测那些),事项页里已经不摆。`}
      </p>
      {tickets.length > 0 && !asking && (
        <button type="button" className="ba-btn ba-btn--ghost" disabled={busy} onClick={() => setAsking(true)}>删掉测试单子</button>
      )}
      {asking && (
        <>
          <p className="ba-settings__line">从电脑的看板上删掉这 {tickets.length} 条,删了找不回。</p>
          <button type="button" className="ba-btn" disabled={busy} onClick={() => { void run(); }}>{busy ? '正在删…' : '删掉'}</button>
          <button type="button" className="ba-btn ba-btn--ghost" disabled={busy} onClick={() => setAsking(false)}>先不删</button>
        </>
      )}
      {receipt !== undefined && <p className="ba-settings__line ba-settings__dim" role="status">{receipt}</p>}
    </section>
  );
}
