/**
 * 图标那两条接口接到手机的取数那条路上(2026-09-26,卡 LG3)。
 *
 * 两条都走 `ApiClient`(局域网直连 / 出了门经房间,由 channel/routedClient.ts 决定),所以
 * **配对之后手机已经知道工作台地址与鉴权方式,这里一个字都不另配**:
 *
 *   - 清单 `GET /agents/icons` 是 JSON,房间那条路也走得了(工人白名单里有它);
 *   - 一张图 `GET /agents/icon/:id` 是字节,房间那条路只收 JSON —— 在外面它如实回一句
 *     (remoteParity.ts 里那句给人看的话),store 当「这张先没有」,界面色点。回到家自己就补上了。
 *
 * 两条都标 `idempotent`:重发一次无害,所以在外面那一下可以到点就掐、改走房间(见 routedClient.ts)。
 */
import type { ApiClient } from '../api/client';
import { createAgentIconStore, localIconStore, manifestRows, type AgentIconStore } from './agentIcons';

export const AGENT_ICONS_PATH = '/agents/icons';

export function agentIconPath(id: string): string {
  return `/agents/icon/${encodeURIComponent(id)}`;
}

export function createAgentIcons(client: ApiClient): AgentIconStore {
  return createAgentIconStore({
    async manifest() {
      const res = await client.json<unknown>(AGENT_ICONS_PATH, { idempotent: true });
      if (res.ok) return { ok: true, rows: manifestRows(res.data) };
      /**
       * **404 = 这台工作台没有这条路**(0.4.13 及更早只有 `/agents/icon/:id`),不是「这一趟没问到」。
       * 手机包与插件不是一起装的:先装了新手机包的那几天,退到「直取」照样有图(见 agentIcons.ts 的 noManifest)。
       * 404 也可能是「登记表未启用」(老装法)—— 那时直取每一张也是 404,一样退回色点,结果不差。
       */
      return res.status === 404 ? { ok: false, absent: true } : { ok: false };
    },
    async png(id) {
      const res = await client.blob(agentIconPath(id), { idempotent: true });
      if (!res.ok) return { ok: false };
      try {
        return { ok: true, bytes: new Uint8Array(await res.data.arrayBuffer()) };
      } catch {
        return { ok: false };
      }
    },
    store: localIconStore(),
  });
}
