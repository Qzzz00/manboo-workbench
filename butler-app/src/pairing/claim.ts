/**
 * 拿 6 位配对码换设备令牌:POST /pair/claim { code, device_name, platform }。
 * 这是唯一一个不带令牌的非本机请求。服务端的话原样转达(「配对码不对或已失效」「连续错 5 次…」)。
 * 字段名是 `device_name`(下划线)——以 workbench-plugin/src/server/http.ts 为准,不是任务卡里写的 deviceName。
 */
import type { Pairing } from '../api/tokenStore';
import { NETWORK_ERROR_TEXT } from '../api/client';
import { baseUrlOf } from './pairUrl';

export type ClaimResult =
  | { ok: true; pairing: Pairing }
  | { ok: false; error: string; lockedUntil?: string };

export interface ClaimInput {
  fetchImpl?: typeof fetch;
  target: { host: string; port: number };
  code: string;
  deviceName: string;
}

export async function claimPairing(input: ClaimInput): Promise<ClaimResult> {
  const fetchImpl = input.fetchImpl ?? ((u, i) => fetch(u, i));
  let res: Response;
  try {
    res = await fetchImpl(`${baseUrlOf(input.target)}/pair/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: input.code.trim(), device_name: input.deviceName, platform: 'android' }),
    });
  } catch {
    return { ok: false, error: NETWORK_ERROR_TEXT };
  }
  let body: { ok?: boolean; token?: unknown; device_id?: unknown; mac_id?: unknown; error?: unknown; locked_until?: unknown } = {};
  try { body = await res.json(); } catch { /* 空 body 按失败处理 */ }
  if (!res.ok || typeof body.token !== 'string' || body.token === '' || typeof body.device_id !== 'string') {
    const error = typeof body.error === 'string' && body.error !== '' ? body.error : `配对失败(${res.status})`;
    return {
      ok: false, error,
      ...(typeof body.locked_until === 'string' ? { lockedUntil: body.locked_until } : {}),
    };
  }
  return {
    ok: true,
    pairing: {
      token: body.token,
      host: input.target.host,
      port: input.target.port,
      deviceId: body.device_id,
      // 配对的是哪一台(局域网 M2 起回这一格):在家的判据之一是「答话的就是这一台」。老工作台不回就缺席。
      ...(typeof body.mac_id === 'string' && body.mac_id !== '' ? { macId: body.mac_id } : {}),
    },
  };
}
