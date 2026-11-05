import { expect, it } from 'vitest';
import { collabClient } from '../src/api/collab';
import type { ApiClient, RequestOptions } from '../src/api/client';

it('condition/save 公共消费者保留 omitted/空串/null/重新绑定的区别', async () => {
  const calls: { path: string; options?: RequestOptions }[] = [];
  const client: ApiClient = {
    baseUrl: 'http://127.0.0.1',
    async json<T>(path: string, options?: RequestOptions) { calls.push({ path, options }); return { ok: true, status: 200, data: {} as T }; },
    async blob() { throw new Error('本例不下载文件'); },
  };
  const api = collabClient(client);
  for (const fields of [{}, { task_id: '' }, { task_id: null }, { task_id: 't-next' }]) {
    await api.saveCondition('goal', { text: '验收条件', id: 'condition', ...fields });
    expect(calls.at(-1)).toEqual({ path: '/collab/goal/condition/save', options: { method: 'POST', body: { goal_id: 'goal', text: '验收条件', id: 'condition', ...fields } } });
  }
});
