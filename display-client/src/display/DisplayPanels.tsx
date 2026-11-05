/**
 * 展示台的右侧两块：会话区、余额用量。
 *
 * PRD §6.3 明确：展示台不做对话、不做判断、不做二级页面、**不做按钮**。
 * 所以这里一个可点元素都没有——要处理就转头看电脑。
 *
 * 2026-09-30(横屏补齐):数据换成与 Mac 顶栏 / 额度面板同一份(displayBoard.ts),
 * 「有哪几家」认 agent_registry、额度只画此刻真接上了的那几家。
 */

import type { FamilyGroup, QuotaLine } from './displayBoard';

function groupCount(group: FamilyGroup): string {
  const parts: string[] = [];
  if (group.waiting > 0) parts.push(`${group.waiting} 等你`);
  if (group.running > 0) parts.push(`${group.running} 在跑`);
  return parts.length > 0 ? parts.join(' · ') : group.line;
}

const SESSION_LAMP: Record<string, string> = { waiting: 'amber', running: 'teal', done: 'blue', error: 'red' };

export function SessionPanel({ groups, stale, counts }: {
  groups: readonly FamilyGroup[];
  stale: boolean;
  counts: { waiting: number; done: number; running: number };
}) {
  return (
    <section className="dp-card dp-card--fill dp-sesscard">
      <div className="dp-ttl">
        会话
        <span className="dp-ttl-r">
          {counts.waiting} 等你 · {counts.done} 刚完成 · {counts.running} 在跑
        </span>
      </div>
      <div className="dp-scroll">
        {/* C1：上游掉线要明示，但看板继续显示最后已知状态。 */}
        {stale && <p className="dp-offline">和电脑断开了 · 以下是最后一次已知状态</p>}
        {!stale && groups.length === 0 && <p className="dp-offline">还没读到这台电脑上有哪几家 AI</p>}

        {groups.map((group) => (
          <div className="dp-grp" key={group.id} data-connected={group.connected}>
            <div className="dp-ghead">
              <span className={`dp-lamp dp-lamp--${group.lamp}`} />
              <span className="dp-gname" style={group.color === undefined ? undefined : { color: group.color }}>{group.name}</span>
              <span className="dp-gct">{groupCount(group)}</span>
            </div>
            {group.connected && group.sessions.length > 0 && (
              <div className="dp-gbody">
                {group.sessions.map((session) => (
                  <div
                    key={session.key}
                    className={[
                      'dp-sess',
                      session.status === 'waiting' ? 'dp-sess--wait' : '',
                      session.status === 'done' && session.unread ? 'dp-sess--fresh' : '',
                      session.ringing ? 'dp-sess--ring' : '',
                    ].filter(Boolean).join(' ')}
                  >
                    <span className={`dp-lamp dp-lamp--${SESSION_LAMP[session.status] ?? 'off'}`} />
                    <div className="dp-sess-bd">
                      <div className="dp-sess-h">{session.title}</div>
                      <div className="dp-sess-m">{session.meta}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

export function QuotaPanel({ lines }: { lines: readonly QuotaLine[] }) {
  return (
    <section className="dp-card dp-quota">
      <div className="dp-ttl">余额 / 额度</div>
      {lines.length === 0
        ? <p className="dp-qempty">这台电脑上还没有接上能读额度的那一家</p>
        : (
          <div className="dp-qgrid">
            {lines.map((line) => (
              <div className="dp-q" key={line.id} data-stale={line.stale}>
                <span className="dp-qname">{line.name}</span>
                <span className="dp-qbars">
                  {line.bars.map((bar) => (
                    <span className="dp-qbar" key={bar.label}>
                      <span className="dp-lb">{bar.label}</span>
                      {/* 条长 = 剩余。越短越危险，方向与余额一致。 */}
                      <span className="dp-track"><i className={`dp-lv--${bar.level}`} style={{ width: `${bar.pct}%` }} /></span>
                      <span className={`dp-pc dp-pc--${bar.level}`}>{bar.pct}%</span>
                      {bar.reset !== undefined && <span className="dp-qreset">{bar.reset}</span>}
                    </span>
                  ))}
                  {line.value !== undefined && <span className="dp-qval">{line.value}</span>}
                </span>
                {line.note !== undefined && <span className="dp-qnote">{line.note}</span>}
              </div>
            ))}
          </div>
        )}
    </section>
  );
}
