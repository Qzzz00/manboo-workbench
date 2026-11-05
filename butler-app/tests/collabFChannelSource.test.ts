import { expect, it } from 'vitest';
import type { ApiClient } from '../src/api/client';
import { collabClient } from '../src/api/collab';
import type { LanChannelMessage, LanChannelSourceScope } from '../src/api/protocol';

it('LAN typed读取保留正式来源/分类/引用与未知来源范围,只发精确过滤不造消息', async () => {
  const message: LanChannelMessage = { id: 'source-message', project_id: 'p 1', author: { member_id: 'peer', name: '来源成员' }, kind: 'message', text: '正式报告', at: '2026-10-19T02:00:00Z',
    category: 'daily', topic: { id: 'project:p 1', title: 'p 1' }, source: { kind: 'project-report', id: 'daily:1', recorded_at: '2026-10-19T02:00:00Z', scope: 'local-project-records', period: { from: '2026-10-18', to: '2026-10-18' } }, refs: [{ kind: 'task', id: 't-1', title: '真实事项引用' }] };
  const scope: LanChannelSourceScope = { news: 'unwired', reports: 'unknown', peer_sources: 'paired-origin-claims', publication_enabled: false };
  const seen: string[] = [];
  const api: ApiClient = { baseUrl: 'controlled', async json<T>(path: string) { seen.push(path); return { ok: true, status: 200, data: { messages: [message], transport: 'lan', scope: 'known-paired-members', source_scope: scope } as T }; },
    async blob() { return { ok: false, status: 0, kind: 'network', error: 'unused' }; } };
  const client = collabClient(api);
  const result = await client.lanChannel('p 1', { category: 'daily', topic_id: 'project:p 1', source_id: 'daily:1' });
  expect(seen).toEqual(['/collab/lan/channel?project_id=p%201&category=daily&topic_id=project%3Ap%201&source_id=daily%3A1']);
  expect(result.ok).toBe(true);
  if (result.ok) { expect(result.data.messages[0]).toEqual(message); expect(result.data.source_scope).toEqual(scope); }
  await client.lanChannel('p 1', { category: undefined });
  expect(seen.at(-1)).toBe('/collab/lan/channel?project_id=p%201');
});
