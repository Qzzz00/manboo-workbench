/**
 * 事务官问你的话、要你批的事 —— 手机这一侧的两条请求(2026-09-25,卡 M)。**全走 8791**,与电脑调的是同一组口:
 * POST /questions/answer、POST /approvals/answer(`scope: 'kind'` = 「这件事里同类的都允许」)。
 * 回 undefined = 交上去了;回一句话 = 没交上(原样给他看)。
 */
import type { QuestionAnswerItem, SessionApprovalKey } from '../api/protocol';
import type { Session } from '../session';

export async function answerQuestion(session: Session, id: string, answers: readonly QuestionAnswerItem[]): Promise<string | undefined> {
  const r = await session.client.json('/questions/answer', { method: 'POST', body: { id, answers } });
  return r.ok ? undefined : r.error;
}

export async function answerApprovalScoped(
  session: Session,
  id: string,
  allow: boolean,
  scope?: 'kind',
): Promise<{ ok: true; granted?: string; merged?: number } | { ok: false; error: string }> {
  const r = await session.client.json<{ granted?: unknown; merged?: unknown }>('/approvals/answer', {
    method: 'POST',
    body: { id, allow, ...(scope === undefined ? {} : { scope }) },
  });
  if (!r.ok) return { ok: false, error: r.error };
  return {
    ok: true,
    ...(typeof r.data?.granted === 'string' ? { granted: r.data.granted } : {}),
    ...(typeof r.data?.merged === 'number' ? { merged: r.data.merged } : {}),
  };
}

/**
 * 别家那段会话停着在等他,他在手机上答了(2026-09-25,卡 T):`POST /sessions/answer`,工作台送回那段会话。
 * 送不回去的工作台如实说(`where: 'desk'` + 一句人话「这一问得在电脑上的 Claude 里回答」)。
 */
export async function answerSession(
  session: Session,
  agent: string,
  sessionId: string,
  text: string,
): Promise<{ ok: true } | { ok: false; desk: boolean; text: string; permission?: true }> {
  const r = await session.client.json<{ ok?: unknown; where?: unknown; why?: unknown; permission?: unknown }>('/sessions/answer', {
    method: 'POST',
    body: { agent, session_id: sessionId, text },
  });
  if (!r.ok) return { ok: false, desk: false, text: r.error };
  if (r.data?.ok === true) return { ok: true };
  // `permission`(2026-10-01,卡 AP):撞上的是权限弹窗 —— 那张卡据此收起输入框、切到「批准 / 拒绝」那几颗键。
  if (r.data?.where === 'desk') {
    return { ok: false, desk: true, text: typeof r.data.why === 'string' ? r.data.why : '这一问得在电脑上那家的窗口里回答', ...(r.data.permission === true ? { permission: true as const } : {}) };
  }
  return { ok: false, desk: false, text: '没送过去' };
}

/**
 * **「等你」那一堆里的一件,他在手机上答了**(2026-09-28,卡 WQ;一个口 `POST /asks/answer`)。
 *
 * 维护者原话:「它现在几个选项给出来了,给完之后我还不能选,我还得回那个会话窗口回。」
 * 现在点一下就走这一条:工作台把那家叫到台前、在它弹的框上按标签点下去,**再重读一次核实**。
 * `confirmed:false` = 点了没看到它收下 —— 界面照 `text` 那句人话说,**不谎报答上了**。
 */
export async function answerAsk(
  session: Session,
  key: string,
  said: { choice: string } | { text: string },
): Promise<{ ok: true; confirmed: boolean; text?: string } | { ok: false; desk: boolean; text: string }> {
  const r = await session.client.json<{ ok?: unknown; confirmed?: unknown; note?: unknown; where?: unknown; why?: unknown }>('/asks/answer', {
    method: 'POST',
    body: { key, ...said },
  });
  if (!r.ok) return { ok: false, desk: false, text: r.error };
  if (r.data?.ok === true) {
    return {
      ok: true,
      confirmed: r.data.confirmed === true,
      ...(typeof r.data.note === 'string' && r.data.note !== '' ? { text: r.data.note } : {}),
    };
  }
  if (r.data?.where === 'desk') return { ok: false, desk: true, text: typeof r.data.why === 'string' ? r.data.why : '这一问得在电脑上那家的窗口里回答' };
  return { ok: false, desk: false, text: '没答上去' };
}

/**
 * **那家停在权限弹窗上:读出弹窗上那几颗键**(2026-10-01,卡 AP「手机替她批准」):`POST /sessions/approval/read`。
 * 工作台只回「批准一次 / 拒绝」(键名是壳读到的原字);读不到如实回一句(`desk`),界面照它说 + 「再看一次」。
 */
export async function readApprovalKeys(
  session: Session,
  agent: string,
  sessionId: string,
): Promise<{ ok: true; keys: readonly SessionApprovalKey[] } | { ok: false; desk: boolean; text: string }> {
  const r = await session.client.json<{ ok?: unknown; keys?: unknown; where?: unknown; why?: unknown }>('/sessions/approval/read', {
    method: 'POST',
    body: { agent, session_id: sessionId },
  });
  if (!r.ok) return { ok: false, desk: false, text: r.error };
  if (r.data?.ok === true && Array.isArray(r.data.keys)) {
    const keys = r.data.keys.filter((one): one is SessionApprovalKey =>
      typeof one === 'object' && one !== null && typeof (one as SessionApprovalKey).label === 'string'
      && ((one as SessionApprovalKey).does === 'once' || (one as SessionApprovalKey).does === 'deny'));
    return { ok: true, keys };
  }
  if (r.data?.where === 'desk') return { ok: false, desk: true, text: typeof r.data.why === 'string' ? r.data.why : '这一问得在电脑上那家的窗口里回答' };
  return { ok: false, desk: false, text: '没读到它弹窗上的键' };
}

/** 「不用管这条」(卡 T):按内容判出来的这一问从「等你」里拿掉。回 undefined = 拿掉了。 */
export async function dismissSessionAsk(session: Session, agent: string, sessionId: string): Promise<string | undefined> {
  const r = await session.client.json('/sessions/ask/dismiss', { method: 'POST', body: { agent, session_id: sessionId } });
  return r.ok ? undefined : r.error;
}
