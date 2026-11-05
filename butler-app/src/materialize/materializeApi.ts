/**
 * 手机上点「就这样」(2026-09-24 晚,卡 feat/onboarding-materialize)。在家走局域网直连 8791,
 * 出了门经房间代理(channel-worker 白名单里有这一条);8791 认设备令牌降下来的权限,与直连同一道门。
 */
import type { Session } from '../session';
import type { ApplyPayload } from './materializeModel';

/** 回 undefined = 收下了(回执随下一拍 /state 来);回一句话 = 没落成(原话)。 */
export async function applyMaterialize(session: Pick<Session, 'client'>, payload: ApplyPayload): Promise<string | undefined> {
  const r = await session.client.json<{ ok?: boolean; line?: string; error?: string }>('/onboarding/materialize/apply', { method: 'POST', body: payload });
  return r.ok ? undefined : r.error;
}
