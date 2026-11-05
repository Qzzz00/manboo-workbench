/**
 * 设置 › 关于与更新 › 发诊断包(2026-10-21,内测发版底座)。
 *
 * 出了事她自己把现场交出去:按一下,**电脑**打一个诊断包(与电脑上「导出诊断包」同一份白名单与脱敏),
 * 交到工作台的服务器上,回一个六位编号 —— 她把编号发给统筹,统筹拿编号取。包里的文件一个都不经手机。
 *
 * 电脑那边是一条作业(`POST /diag/send` 起、`GET /diag/send` 看):打包要几十秒,而出门时那条房间代理
 * 15 秒就放弃,所以这里起了就每隔一会儿问一次,跑完停。
 * 传不上去(电脑没登录、电脑那头也没网)时包留在电脑桌面上,这里说清在哪。
 */
import { useEffect, useRef, useState } from 'react';
import { useSession } from '../session';

/** 与工作台 `src/diag.ts` 的 `DiagSendView` 同形(手机只读这几格)。 */
export interface PhoneDiagSendView {
  id: string;
  state: 'running' | 'done' | 'failed';
  code?: string;
  expires_at?: string;
  error?: string;
  kept?: { file_redacted: string, name: string };
}

const POLL_MS = 2000;
/** 问多少次还没完就不问了(约 5 分钟):多半是电脑那头卡住了,话照实说。 */
const MAX_POLLS = 150;

export function DiagSendSection({ pollMs = POLL_MS }: { pollMs?: number }) {
  const session = useSession();
  const [view, setView] = useState<PhoneDiagSendView | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const polls = useRef(0);

  const start = async (): Promise<void> => {
    setError(undefined);
    polls.current = 0;
    const res = await session.client.json<PhoneDiagSendView>('/diag/send', { method: 'POST', body: {} });
    if (res.ok) setView(res.data);
    else setError(`诊断包没发出去:${res.error}。电脑要开着;在外面时电脑还得连得上网。`);
  };

  useEffect(() => {
    if (view?.state !== 'running') return undefined;
    const timer = setTimeout(() => {
      polls.current += 1;
      if (polls.current > MAX_POLLS) {
        setView(undefined);
        setError('等了好几分钟,电脑那边还没打完包。过一会儿再按一次看看。');
        return;
      }
      void session.client.json<PhoneDiagSendView | { state: 'none' }>('/diag/send').then((res) => {
        // 问一次没问到不算失败,下一拍再问。**每次都换一个新对象**:下一拍靠 view 变了才排得上。
        if (!res.ok || res.data.state === 'none') { setView(prev => (prev === undefined ? prev : { ...prev })); return; }
        setView({ ...res.data });
      });
    }, pollMs);
    return () => { clearTimeout(timer); };
  }, [pollMs, session.client, view]);

  const running = view?.state === 'running';
  return (
    <section className="ba-settings__sec">
      <h2 className="ba-inbox__h">发诊断包</h2>
      <p className="ba-settings__line ba-settings__dim">
        出了问题按一下:电脑把最近的日志与设置(密码、密钥不进去)打成一个包交到服务器上,这里给你一个编号,把编号发给统筹就行。
      </p>
      <div className="ba-row">
        <button type="button" className="ba-btn ba-btn--ghost" disabled={running} onClick={() => { void start(); }}>
          {running ? '电脑在打包…' : '发诊断包'}
        </button>
      </div>
      {running && <p className="ba-settings__line ba-settings__dim">要几十秒,不用一直看着。</p>}
      {view?.state === 'done' && view.code !== undefined && (
        <div role="status">
          <p className="ba-settings__line">诊断包编号</p>
          <p className="ba-settings__line ba-settings__code">{view.code}</p>
          <p className="ba-settings__line ba-settings__dim">把这个编号发给统筹。服务器上 7 天后自动删。</p>
        </div>
      )}
      {view?.state === 'failed' && (
        <div role="alert">
          <p className="ba-settings__line">{view.error ?? '诊断包没发出去。'}</p>
          {view.kept !== undefined && (
            <p className="ba-settings__line ba-settings__dim">
              {`包留在电脑桌面上了:${view.kept.name}。回到电脑前用微信发给统筹也行。`}
            </p>
          )}
        </div>
      )}
      {error !== undefined && <p className="ba-settings__line" role="alert">{error}</p>}
    </section>
  );
}
