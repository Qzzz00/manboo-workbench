/**
 * 今天的待办(2026-10-12):电脑切好的那一份(自媒体模板里那一格同一份)。手机上只看;
 * 勾选、延到明天、新加一件都在电脑那一格里做,点一件打开那件事项的详情。
 *
 * 两种显示跟电脑那一格一致(`/state.today_todos.style`,周三演示):按日期汇总 = 今天 / 明天 / 更晚三组带件数,
 * 不汇总 = 今天那一条清单。版本变了先盖「正在优化…」,TODAY_SWITCH_MS 后换成新版、遮罩淡出。
 */
import { useEffect, useState } from 'react';
import { TODAY_SWITCH_MS, TODAY_SWITCH_TEXT, type TodayTodoItem, type TodayTodosView, type TodayViewStyle } from '../api/protocol';
import { shortDue } from '../stage/stageCardsModel';

/** 遮罩淡出用多久(毫秒)。 */
export const TODAY_VEIL_FADE_MS = 320;

function monthDayOf(day: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(day);
  return m === null ? day : `${Number(m[1])}月${Number(m[2])}日`;
}

function useVeiledStyle(incoming: TodayViewStyle): { shown: TodayViewStyle; veil: 'off' | 'on' | 'fading' } {
  const [shown, setShown] = useState(incoming);
  const [veil, setVeil] = useState<'off' | 'on' | 'fading'>('off');
  useEffect(() => {
    // 遮罩还盖着又切回原来那一版:不用换,揭掉。
    if (incoming === shown) { setVeil((now) => (now === 'on' ? 'off' : now)); return; }
    setVeil('on');
    const swap = setTimeout(() => { setShown(incoming); setVeil('fading'); }, TODAY_SWITCH_MS);
    return () => clearTimeout(swap);
  }, [incoming, shown]);
  useEffect(() => {
    if (veil !== 'fading') return;
    const fade = setTimeout(() => setVeil('off'), TODAY_VEIL_FADE_MS);
    return () => clearTimeout(fade);
  }, [veil]);
  return { shown, veil };
}

export function TodayTodos({ view, onOpen }: { view: TodayTodosView; onOpen(id: string): void }) {
  const open = view.items.filter((one) => !one.done).length;
  const { shown, veil } = useVeiledStyle(view.style ?? 'flat');
  const groups = shown === 'by_date' ? view.groups : undefined;
  const list = (items: readonly TodayTodoItem[]) => (
    <ul className="ba-list">
      {items.map((item) => (
        <li key={item.id}>
          <button type="button" className={item.done ? 'ba-item ba-item--tap ba-item--dim' : 'ba-item ba-item--tap'} onClick={() => onOpen(item.id)}>
            <span className="ba-item__body">
              <span className="ba-item__title">{item.title}</span>
              {(item.overdue || item.done) && (
                <span className="ba-item__meta">
                  <span className="ba-item__note">{item.done ? '已办完' : `逾期 · ${shortDue(item.due)}`}</span>
                </span>
              )}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
  return (
    <section className="ba-inbox__half" aria-label="今天的待办">
      <h3 className="ba-inbox__sub">{`今天的待办 · ${monthDayOf(view.date)} · ${open > 0 ? `还有 ${open} 件` : view.items.length > 0 ? '都办完了' : '还没有'}`}</h3>
      <div className="ba-today">
        {groups !== undefined
          ? groups.map((group) => (
              <div key={group.key} className="ba-today__group">
                <h4 className="ba-today__head">{`${group.label} · ${group.items.length} 件`}</h4>
                {group.items.length > 0 && list(group.items)}
              </div>
            ))
          : view.items.length > 0 && list(view.items)}
        {veil !== 'off' && (
          <div className="ba-today__veil" data-fading={veil === 'fading'} role="status" aria-live="polite">
            <span className="ba-today__spin" aria-hidden="true" />
            <span>{TODAY_SWITCH_TEXT}</span>
          </div>
        )}
      </div>
    </section>
  );
}
