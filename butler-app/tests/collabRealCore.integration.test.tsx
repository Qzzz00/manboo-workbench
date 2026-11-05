// @vitest-environment jsdom
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SessionContext, type Session } from '../src/session';
import { createApiClient } from '../src/api/client';
import { createVoiceApi } from '../src/api/voice';
import { createCallApi } from '../src/api/call';
import { createAppearanceFeed } from '../src/swarm/appearance';
import type { WorkbenchState } from '../src/api/protocol';
import { createStateFeed, type StateFeed } from '../src/api/stateFeed';
import { createSendOutbox } from '../src/outbox/sendOutbox';
import { CollabPage } from '../src/collab/CollabPage';
import { guardBoardSummary } from '../src/collab/collabCore';
import { fakeChannel, fakeRouted } from './wbchFakes';
import { startCollabQaCore, type CollabQaCore } from '#collab-real-core';

const servers: CollabQaCore[] = [];
const dirs: string[] = [];
const feeds: StateFeed[] = [];

afterEach(async () => {
  while (feeds.length > 0) feeds.pop()?.stop();
  while (servers.length > 0) await servers.pop()?.close();
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe('真实 WorkbenchServer → 手机生产 React 协作区', () => {
  it('真实服务端与手机页闭环目标验收、关系、留言受理和身份改名', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-phone-collab-real-'));
    dirs.push(dir);
    const server = await startCollabQaCore({ dir });
    servers.push(server);

    const pairing = { token: 'integration-test-only', host: '127.0.0.1', port: server.port, deviceId: 'integration-test' };
    const apiRequests: string[] = [];
    const direct = createApiClient({ pairing, onUnauthorized: () => {}, fetchImpl: async (input, init) => {
      apiRequests.push(`${init?.method ?? 'GET'} ${new URL(String(input)).pathname + new URL(String(input)).search}`);
      return fetch(input, init);
    } });
    const mustPost = async (path: string, body: unknown): Promise<Record<string, unknown>> => {
      const res = await direct.json<Record<string, unknown>>(path, { method: 'POST', body });
      expect(res.ok, res.ok ? '' : res.error).toBe(true);
      expect(res.ok && res.data.ok !== false).toBe(true);
      return res.ok ? res.data : {};
    };

    const goal = await mustPost('/collab/goal/create', { title: '样片交付', why: '完成短片试样' });
    const task = await mustPost('/task/create', { title: '剪出 30 秒样片', status: 'todo' });
    const agent = await mustPost('/collab/agent/save', { name: '整合小助手', hand: 'codex' });
    const goalId = String(goal.id);
    const taskId = String(task.id);
    const agentId = String(agent.id);
    await mustPost('/task/update', { id: taskId, goal_id: goalId, assignee: agentId });
    await mustPost('/collab/goal/condition/save', {
      goal_id: goalId, text: '能看完并确认样片', task_id: taskId, evidence: ['deliverables/sample.mp4'],
    });
    await mustPost('/task/move', { id: taskId, status: 'doing' });
    await mustPost('/task/move', { id: taskId, status: 'confirm' });
    const relation = await mustPost('/task/create', { title: '给样片写字幕', status: 'todo' });
    await mustPost('/collab/relation/save', {
      from_id: String(relation.id), to_id: taskId, kind: 'depends_on', note: '样片确认后再定字幕',
    });
    await mustPost('/collab/relation/save', {
      from_id: taskId, to_id: String(relation.id), kind: 'handoff', note: '样片交给字幕制作',
    });
    const realRelations = await direct.json<{ relations: { from_id: string; to_id: string; note?: string }[] }>(`/collab/relations?task_id=${encodeURIComponent(taskId)}`);
    expect(realRelations.ok && realRelations.data.relations.some((one) => one.from_id === String(relation.id) && one.to_id === taskId)).toBe(true);

    const stateResult = await direct.json<WorkbenchState>('/state');
    expect(stateResult.ok).toBe(true);
    if (!stateResult.ok) throw new Error(stateResult.error);
    const initialBoard = await direct.json<{ summary: { conditions: { items: { text: string }[] } } }>(`/collab/goal/board?goal_id=${encodeURIComponent(goalId)}`);
    expect(initialBoard.ok && initialBoard.data.summary.conditions.items.map((one) => one.text)).toContain('能看完并确认样片');
    expect(initialBoard.ok && guardBoardSummary(initialBoard.data)?.items.map((one) => one.text)).toContain('能看完并确认样片');
    const feed = createStateFeed({ client: direct, pairing, liveBase: () => null, pollMs: 60_000 });
    feeds.push(feed);
    await waitFor(() => expect(feed.get().connected).toBe(true));
    const kv = new Map<string, string>();
    const storage = {
      get: async (key: string) => kv.get(key) ?? null,
      set: async (key: string, value: string) => { kv.set(key, value); },
      remove: async (key: string) => { kv.delete(key); },
    };
    const client = fakeRouted(direct, 'direct');
    const session: Session = {
      pairing,
      client,
      direct,
      feed,
      voice: createVoiceApi(direct),
      call: createCallApi(direct),
      channel: fakeChannel({}),
      appearance: createAppearanceFeed(direct),
      settings: { async load() { throw new Error('not used'); }, async update() { throw new Error('not used'); } },
      outbox: createSendOutbox({ kv: storage, client }),
      async unpair() {},
    };

    const renderCollab = (target?: { taskId: string }) => render(
      <SessionContext.Provider value={session}><CollabPage target={target} /></SessionContext.Provider>,
    );
    const first = renderCollab();
    const goalButton = await screen.findByText('样片交付');
    await act(async () => { fireEvent.click(goalButton); });
    expect(await screen.findByText('交回待验')).toBeTruthy();
    expect(await screen.findByText('能看完并确认样片')).toBeTruthy();
    expect(await screen.findByText(/证据:deliverables\/sample\.mp4/)).toBeTruthy();

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '验收通过' })); });
    expect(await screen.findByText('已验收通过')).toBeTruthy();
    expect(await screen.findByText(/我 通过 · 第1轮/)).toBeTruthy();
    expect(await screen.findByText(/1\/1 已验收 · 0\/1 当前可用/)).toBeTruthy();
    const deliverButton = await screen.findByRole('button', { name: '记交付' });
    await act(async () => { fireEvent.click(deliverButton); });
    expect(await screen.findByText('已记交付')).toBeTruthy();
    const board = await direct.json<Record<string, unknown>>(`/collab/goal/board?goal_id=${encodeURIComponent(goalId)}`);
    expect(board.ok && (board.data as { summary: { conditions: { items: { state: string }[] } } }).summary.conditions.items[0]?.state).toBe('delivered');
    expect(await screen.findByText(/1\/1 已验收 · 1\/1 当前可用/)).toBeTruthy();

    await act(async () => {
      await mustPost('/task/move', { id: taskId, status: 'doing' });
      await feed.refresh();
    });
    expect(await screen.findByText('退回重做', { selector: '.ba-collab__condstate' })).toBeTruthy();
    expect(screen.getByText(/我 通过 · 第1轮/)).toBeTruthy();
    expect(await screen.findByText(/0\/1 已验收 · 0\/1 当前可用/)).toBeTruthy();
    await act(async () => {
      await mustPost('/task/move', { id: taskId, status: 'confirm' });
      await feed.refresh();
    });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '验收通过' })); });
    expect(await screen.findByText(/我 通过 · 第2轮/)).toBeTruthy();

    first.unmount();
    const taskPage = renderCollab({ taskId });
    await screen.findByText('连续活动');
    await waitFor(() => expect(apiRequests).toContain(`GET /collab/relations?task_id=${encodeURIComponent(taskId)}`));
    await waitFor(() => expect(screen.getByRole('region', { name: '关系' }).textContent).toContain('样片确认后再定字幕'));
    expect(await screen.findByText(/上游重开.*需复核/)).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '请它处理' })); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '@ 名片' })); });
    await act(async () => { fireEvent.click(screen.getByText('@整合小助手', { selector: '.ba-collab__cardchip' })); });
    const draft = await screen.findByLabelText('留言草稿');
    await act(async () => { fireEvent.change(draft, { target: { value: '@整合小助手 检查样片' } }); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '留这条' })); });
    expect(await screen.findByText('已送达,等同步')).toBeTruthy();
    expect(await screen.findByText(/整合小助手:失败/)).toBeTruthy();
    await waitFor(async () => {
      const activity = await direct.json<{ items: { type: string; message?: { deliveries?: { status: string }[] } }[] }>(`/collab/note/activity?id=${encodeURIComponent(taskId)}`);
      expect(activity.ok && activity.data.items.some((one) => one.type === 'message' && one.message?.deliveries?.[0]?.status === 'failed')).toBe(true);
    });

    const beforeIdentity = await direct.json<{ identity: { member_id: string; name: string } }>('/collab/lan/identity');
    expect(beforeIdentity.ok).toBe(true);
    if (!beforeIdentity.ok) throw new Error(beforeIdentity.error);
    taskPage.unmount();
    const channelPage = renderCollab();
    await act(async () => { fireEvent.click(screen.getByRole('tab', { name: '频道' })); });
    const nameInput = await screen.findByLabelText('事务官名字');
    const saveName = screen.getByRole('button', { name: '保存名字' }) as HTMLButtonElement;
    await waitFor(() => expect(saveName.disabled).toBe(false));
    await act(async () => { fireEvent.change(nameInput, { target: { value: '手机整合验证' } }); });
    await act(async () => { fireEvent.click(saveName); });
    await waitFor(() => expect(apiRequests).toContain('POST /collab/lan/identity'));
    await waitFor(async () => {
      const current = await direct.json<{ identity: { member_id: string; name: string } }>('/collab/lan/identity');
      expect(current.ok && current.data.identity.name).toBe('手机整合验证');
    });
    expect(await screen.findByText(/已改名;稳定身份不变/)).toBeTruthy();
    const afterIdentity = await direct.json<{ identity: { member_id: string; name: string } }>('/collab/lan/identity');
    expect(afterIdentity.ok && afterIdentity.data.identity).toMatchObject({
      member_id: beforeIdentity.data.identity.member_id,
      name: '手机整合验证',
    });
    await mustPost('/collab/lan/identity', { name: '其他端刚改的名字' });
    await act(async () => { fireEvent.change(nameInput, { target: { value: '手机重新确认的名字' } }); });
    await act(async () => { fireEvent.click(saveName); });
    expect(await screen.findByText(/当前名字:其他端刚改的名字/)).toBeTruthy();
    expect((nameInput as HTMLInputElement).value).toBe('手机重新确认的名字');
    await act(async () => { fireEvent.click(saveName); });
    expect(await screen.findByText(/已改名;稳定身份不变/)).toBeTruthy();
    const retried = await direct.json<{ identity: { member_id: string; name: string } }>('/collab/lan/identity');
    expect(retried.ok && retried.data.identity).toMatchObject({ member_id: beforeIdentity.data.identity.member_id, name: '手机重新确认的名字' });
    channelPage.unmount();
  });
});
