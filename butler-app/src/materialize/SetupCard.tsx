/**
 * 「我照你说的摆好了」整张单子(2026-09-24 晚,卡 feat/onboarding-materialize;09-25 放进卡 A 的五卡首页)。
 *
 * 引导聊完,事务官把他说的摆成一张单子(项目、冲刺与卡、每天几点、撤掉的旧事项、第一件派给谁)。
 * 首页上它是「等你确认」那一格置顶的一行,整张卡点下去是这一页(StagePage 里那一层下一级页,顶上「‹」回首页)。
 * 维护者中秋起只拿手机:**这里点「就这样」就落**(`POST /onboarding/materialize/apply`,出了局域网经房间代理)。
 * 逐条能勾掉;「改一下」能改卡片的标题与负责人、免打扰到几点。真相在电脑那边:按完不本地乐观改,等下一拍 /state。
 * 只做深色,不用蓝色。
 */
import { useEffect, useState } from 'react';
import type { MaterializeOwner, MaterializeStateView } from '../api/protocol';
import { MATERIALIZE_OWNER_LABELS } from '../api/protocol';
import {
  OWNER_CHOICES, applyPayload, groupedRows, headLine, liveCount, quietEndChoices, rowCheckable, rowChecked, rowTitle, spokenClock,
  type ApplyPayload, type RowChoice,
} from './materializeModel';
import './materialize.css';

/** 那一页的页名(返回头上那一行)。 */
export const SETUP_TITLE = '我照你说的摆好了';

export function SetupCard({ view, apply, onReceipt }: {
  view: MaterializeStateView;
  /** 交上去;回 undefined = 收下了,回一句话 = 没落成。 */
  apply(payload: ApplyPayload): Promise<string | undefined>;
  onReceipt?(text: string): void;
}) {
  const [choices, setChoices] = useState<Record<string, RowChoice>>({});
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  useEffect(() => { setChoices({}); setEditing(false); setError(undefined); }, [view.id]);

  const choose = (key: string, patch: RowChoice): void => setChoices((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));
  const go = (): void => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    void apply(applyPayload(view, choices)).then((failed) => {
      setBusy(false);
      if (failed !== undefined) setError(failed);
      else { setEditing(false); onReceipt?.('收到,正在落'); }
    });
  };
  const count = liveCount(view, choices);

  return (
      <section className="ba-setup" aria-label={SETUP_TITLE} data-editing={editing}>
        <header className="ba-setup__head">
          <p className="ba-setup__sub">{headLine(view)}</p>
        </header>
        <div className="ba-setup__scroll">
          {groupedRows(view).map((group) => (
            <div key={group.id} className="ba-setup__group" data-group={group.id}>
              <p className="ba-setup__gtitle">{group.title}</p>
              <ul className="ba-setup__rows">
                {group.rows.map((row) => {
                  const checkable = rowCheckable(row);
                  const checked = rowChecked(row, choices);
                  const choice = choices[row.key];
                  const editable = editing && row.editable === true;
                  return (
                    <li key={row.key} className="ba-setup__item" data-done={row.done === true} data-off={checkable && !checked}>
                      <label className="ba-setup__check">
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={!checkable || busy}
                          aria-label={row.title}
                          onChange={(event) => choose(row.key, { checked: event.target.checked })}
                        />
                        <span className="ba-setup__text">
                          {editable
                            ? (
                              <input
                                className="ba-setup__input"
                                type="text"
                                value={choice?.title ?? row.title}
                                maxLength={40}
                                aria-label={`改标题:${row.title}`}
                                disabled={busy}
                                onChange={(event) => choose(row.key, { title: event.target.value })}
                              />
                            )
                            : <span className="ba-setup__rtitle">{rowTitle(row, choices)}</span>}
                          {row.detail !== undefined && row.detail !== '' && (
                            <span className="ba-setup__detail">
                              {choice?.owner !== undefined && choice.owner !== row.owner
                                ? row.detail.replace(/^负责:[^ ·]+/, `负责:${MATERIALIZE_OWNER_LABELS[choice.owner]}`)
                                : row.detail}
                            </span>
                          )}
                          {row.done === true && <span className="ba-setup__note">已经有了</span>}
                          {row.placeholder !== undefined && <span className="ba-setup__note">{row.placeholder}</span>}
                        </span>
                      </label>
                      {editing && row.time !== undefined && (
                        <select
                          className="ba-setup__owner"
                          value={choice?.to ?? row.time.to}
                          aria-label={`改到几点:${row.title}`}
                          disabled={busy}
                          onChange={(event) => choose(row.key, { to: event.target.value })}
                        >
                          {quietEndChoices(row.time.to).map((time) => <option key={time} value={time}>{`到${spokenClock(time)}`}</option>)}
                        </select>
                      )}
                      {editable && (
                        <select
                          className="ba-setup__owner"
                          value={choice?.owner ?? row.owner ?? 'me'}
                          aria-label={`改负责人:${row.title}`}
                          disabled={busy}
                          onChange={(event) => choose(row.key, { owner: event.target.value as MaterializeOwner })}
                        >
                          {OWNER_CHOICES.map((one) => <option key={one.id} value={one.id}>{one.label}</option>)}
                        </select>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
        {error !== undefined && <p className="ba-setup__err" role="alert">{error}</p>}
        <div className="ba-setup__acts">
          <button type="button" className="ba-setup__ghost" disabled={busy} aria-pressed={editing} onClick={() => setEditing((on) => !on)}>
            {editing ? '改好了' : '改一下'}
          </button>
          <button type="button" className="ba-setup__go" disabled={busy || view.status !== 'pending' || count === 0} onClick={go}>
            {busy || view.status === 'applying' ? '正在落…' : '就这样'}
          </button>
        </div>
      </section>
  );
}

/** 落完之后那一句回执与没落上的几样(那一页上;「收起」回首页)。 */
export function SetupReceipt({ view, onDismiss }: { view: MaterializeStateView; onDismiss(): void }) {
  const failed = view.result?.rows.filter((row) => !row.ok) ?? [];
  return (
    <section className="ba-setup ba-setup--done" aria-label="我照你说的摆好了">
      <p className="ba-setup__line" role="status">{view.result?.line ?? '落好了'}</p>
      {failed.length > 0 && (
        <ul className="ba-setup__failed" aria-label="没落上的">
          {failed.map((row) => <li key={row.key}>{row.title}{row.note === undefined ? '' : `:${row.note}`}</li>)}
        </ul>
      )}
      <button type="button" className="ba-setup__ghost" onClick={onDismiss}>收起</button>
    </section>
  );
}
