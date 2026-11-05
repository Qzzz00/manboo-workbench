/**
 * 深聊这一块对工作台说的四句话(2026-10-13,卡「播客页重做」)。
 *
 *   POST /feed/dig        就这一条答一句(`want:'conclusion'` = 收一句结论)
 *   POST /feed/dig/note   结论落电脑随手记(来源那一行由 8791 拼)
 *   POST /feed/dig/task   结论建一张事项卡(desc 带「来源于:…」)
 *   POST /feed/dig/call   告诉下一通电话「她要聊这一条」
 *
 * 走的是与资讯页同一个 `ApiClient`(局域网直连 8791 / 出了门经房间代理),
 * 这四条都在 `channel-worker/src/rpc.ts` 的白名单里 —— 通勤路上也聊得动。
 *
 * 错话一个字都不改写:404 =「这台工作台没接这一块」、409 =「接了但本机缺能力」,
 * 两者的人话都由服务端给。
 */
import type { ApiClient, ApiResult } from '../api/client';
import { turnsForServer, type DigTurn } from './digModel';

export interface DigApi {
  /** 她说一句,事务官就这一条答一句。 */
  say(itemId: string, text: string, turns: readonly DigTurn[]): Promise<ApiResult<{ said: string }>>;
  /** 让模型把这段对话收成一两句结论(她还能自己改)。 */
  conclude(itemId: string, turns: readonly DigTurn[]): Promise<ApiResult<{ said: string }>>;
  /** 结论 → 电脑随手记。 */
  note(itemId: string, text: string): Promise<ApiResult<{ ok: true }>>;
  /** 结论 → 事项卡(标题就是结论)。 */
  task(itemId: string, title: string): Promise<ApiResult<{ ok: true; id: string }>>;
  /** 「打电话聊」之前先说一声这一通是为哪条打的。 */
  callContext(itemId: string, turns: readonly DigTurn[]): Promise<ApiResult<{ ok: true }>>;
}

export function createDigApi(client: ApiClient): DigApi {
  return {
    say: (itemId, text, turns) => client.json<{ said: string }>('/feed/dig', {
      method: 'POST',
      body: { id: itemId, text, turns: turnsForServer(turns) },
    }),
    conclude: (itemId, turns) => client.json<{ said: string }>('/feed/dig', {
      method: 'POST',
      body: { id: itemId, want: 'conclusion', turns: turnsForServer(turns) },
    }),
    note: (itemId, text) => client.json<{ ok: true }>('/feed/dig/note', {
      method: 'POST',
      body: { id: itemId, text },
    }),
    task: (itemId, title) => client.json<{ ok: true; id: string }>('/feed/dig/task', {
      method: 'POST',
      body: { id: itemId, title },
    }),
    callContext: (itemId, turns) => client.json<{ ok: true }>('/feed/dig/call', {
      method: 'POST',
      body: { id: itemId, turns: turnsForServer(turns) },
    }),
  };
}
