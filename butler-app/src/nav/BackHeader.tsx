/**
 * 下一级页顶上那一条(2026-09-24,卡 `fix/phone-nav-back`):左上角一个「‹」回首页,旁边是页名。
 * 事项、资讯、设置、对话记录、会议共用这一条 —— 深色底、白字、不用蓝(同 styles.css 的色板)。
 *
 * 不传 `onBack` 就只有页名:会议录着的时候没有别的出口(要走只有「结束」),见 MeetingPage。
 */
import type { ReactNode } from 'react';
import { BACK_LABEL } from './navModel';
import './nav.css';

export function BackHeader({ title, onBack }: { title: string; onBack?: () => void }) {
  return (
    <header className="ba-backhead">
      {onBack === undefined
        ? <span className="ba-backhead__gap" aria-hidden="true" />
        : (
          <button type="button" className="ba-backhead__back" aria-label={BACK_LABEL} onClick={onBack}>
            <span aria-hidden="true">‹</span>
          </button>
        )}
      <h1 className="ba-backhead__title">{title}</h1>
    </header>
  );
}

/** 一整个下一级页:顶上返回头,下面那一页自己滚。 */
export function SubPage({ title, onBack, children }: { title: string; onBack: () => void; children: ReactNode }) {
  return (
    <div className="ba-subpage">
      <BackHeader title={title} onBack={onBack} />
      <div className="ba-subpage__body">{children}</div>
    </div>
  );
}
