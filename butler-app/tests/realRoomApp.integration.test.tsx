import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from '../src/App';
import type { Pairing, KeyValueStore } from '../src/api/tokenStore';
import { createTokenStore } from '../src/api/tokenStore';
import { createSettingsStore } from '../src/settings/settingsStore';
import { createAccountStore } from '../src/account/accountStore';

const capture = vi.hoisted(() => ({ packets: [] as { direction: string; from?: string; message: Record<string, unknown> }[], rooms: [] as { disconnect(): Promise<void> }[] }));
vi.mock('@capacitor/app', () => ({ App: { getLaunchUrl: async () => ({ url: '' }), addListener: async () => ({ remove: async () => {} }) } }));
vi.mock('capacitor-zeroconf', () => ({ ZeroConf: { watch: async () => { throw new Error('web'); }, unwatch: async () => {}, close: async () => {} } }));
vi.mock('../src/channel/roomLink', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/channel/roomLink')>();
  if (!process.env.COLLAB_1C_ROOM_SESSION) return actual;
  const { resolve } = await import('node:path');
  const { createRequire } = await import('node:module');
  const nativeRequire = createRequire(resolve(process.cwd(), 'package.json'));
  const { nativePhoneRoomSdk } = nativeRequire(resolve(process.cwd(), '../workbench-plugin/dev/acceptance-three-entrances/fakePhone.ts')) as { nativePhoneRoomSdk: (capture: (direction: 'in' | 'out', text: string, from?: string) => void, onRoom?: (room: { disconnect(): Promise<void> }) => void) => unknown };
  return { ...actual, createWbchRoomLink: () => actual.createWbchRoomLink({ loadSdk: async () => nativePhoneRoomSdk((direction, text, from) => {
    try {
      const message = JSON.parse(text) as Record<string, unknown>;
      if (['call', 'call_state', 'say_decision'].includes(String(message.type))) capture.packets.push({ direction, ...(from === undefined ? {} : { from }), message });
    } catch { /* Only JSON product packets are evidence. */ }
  }, room => capture.rooms.push(room)) as unknown as import('../src/channel/roomLink').WbchLivekitSdk }) };
});

// Keep production hashing/chunking/save handling; bind only the native filesystem boundary
// to this run's controlled evidence directory. This is not Android storage or a real handset.
vi.mock('../src/channel/fileSink', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/channel/fileSink')>();
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  function target(raw: unknown): string {
    const root = process.env.COLLAB_1C_EVIDENCE_DIR;
    if (!root) throw new Error('controlled evidence directory required');
    const base = path.resolve(root, `received-${process.env.COLLAB_1C_RUN_ID ?? 'live'}`);
    const dest = path.resolve(base, String(raw));
    if (!dest.startsWith(base + path.sep)) throw new Error('outside controlled sink');
    return dest;
  }
  const Filesystem = {
    async stat(o: Record<string, unknown>) { return fs.stat(target(o.path)); },
    async writeFile(o: Record<string, unknown>) { const dest = target(o.path); await fs.mkdir(path.dirname(dest), { recursive: true }); await fs.writeFile(dest, Buffer.from(String(o.data), 'base64')); },
    async appendFile(o: Record<string, unknown>) { await fs.appendFile(target(o.path), Buffer.from(String(o.data), 'base64')); },
  };
  return { ...actual, saveWbchFile: (file: Parameters<typeof actual.saveWbchFile>[0]) => actual.saveWbchFile(file, { loadFilesystem: async () => ({ Filesystem, Directory: { Documents: 'controlled-node-documents' } }) }) };
});

function memory(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, async get(key) { return data.get(key) ?? null; }, async set(key, value) { data.set(key, value); }, async remove(key) { data.delete(key); } };
}
const contextFile = process.env.COLLAB_1C_ROOM_SESSION;
const liveIt = it.skipIf(!contextFile);
const evidenceDir = process.env.COLLAB_1C_EVIDENCE_DIR;
function evidence(name: string, value: unknown) {
  if (!evidenceDir) return;
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(join(evidenceDir, `${name}-${process.env.COLLAB_1C_RUN_ID ?? Date.now()}.json`), JSON.stringify(value, null, 2), { mode: 0o600 });
}
function uiText() { const copy = document.body.cloneNode(true) as HTMLElement; copy.querySelectorAll('style,script').forEach(one => one.remove()); return copy.textContent; }
function context() { return JSON.parse(readFileSync(contextFile!, 'utf8')) as { pairing: Pairing; base: string; origin: string; textTurn: { port: number; token?: string; tokenFile?: string } }; }
function mountApp(pairing: Pairing, fetchImpl: typeof fetch = fetch) {
  const kv = memory();
  kv.data.set('butler.settings', JSON.stringify({ voiceEnabled: true, avatarId: null, onboarding: 'done', stage: 'particles', callProvider: 'livekit', ringStandby: false }));
  return render(<App tokenStore={{ ...createTokenStore(memory()), async load() { return pairing; } }} settingsStore={createSettingsStore(kv)} accountStore={createAccountStore(memory())} fetchImpl={fetchImpl} />);
}
afterEach(() => { cleanup(); sessionStorage.clear(); });

describe('production App with real worker and LiveKit transport', () => {
  liveIt('consumes an actual producer replay once and rejects the old call packet after rejoining', async () => {
    const ctx = context(); capture.packets.length = 0; capture.rooms.length = 0;
    const view = mountApp(ctx.pairing);
    const records: unknown[] = [];
    const headers = { 'content-type': 'application/json', 'x-workbench-text-turn': ctx.textTurn.tokenFile ? readFileSync(ctx.textTurn.tokenFile, 'utf8').trim() : ctx.textTurn.token ?? '' };
    async function qa(path: string, body?: unknown) {
      const res = await fetch(`http://127.0.0.1:${ctx.textTurn.port}${path}`, { headers: { ...headers, 'x-workbench-text-turn': ctx.textTurn.tokenFile ? readFileSync(ctx.textTurn.tokenFile, 'utf8').trim() : ctx.textTurn.token ?? '' }, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }), signal: AbortSignal.timeout(110_000) });
      const data = await res.json(); records.push({ path, status: res.status, data }); expect(res.status).toBe(200); return data;
    }
    async function enter() {
      const call = await screen.findByRole('button', { name: '通话' }, { timeout: 20_000 });
      await waitFor(() => expect(call).toHaveProperty('disabled', false), { timeout: 30_000 }); fireEvent.click(call);
      await screen.findByText('通话中', {}, { timeout: 30_000 });
      return capture.packets.filter(p => p.direction === 'out' && p.message.type === 'call' && p.message.action === 'start').at(-1)!.message.call_id;
    }
    const incoming = (id: unknown) => capture.packets.filter(p => p.direction === 'in' && p.from === 'wb-channel-worker' && p.message.type === 'say_decision' && p.message.event_id === id);
    const regions = () => screen.queryAllByRole('region', { name: '事务官处理结果' });
    try {
      const firstCall = await enter();
      await qa('/say', { text: '帮我建一个待办:周四下午给客户发样片,建之前先跟我确认一下' });
      const sent = await qa('/qa/room-decisions') as { events: { event_id: string; call_id?: string; packet: string }[] };
      const first = sent.events.find(event => event.call_id === firstCall)!; expect(first).toBeTruthy();
      const packet = JSON.parse(first.packet) as { say_id: string; say: { screen: string } };
      await waitFor(() => expect(incoming(first.event_id).length).toBe(1), { timeout: 30_000 });
      await waitFor(() => expect(regions().length).toBe(1)); expect(regions()[0]!.textContent).toContain(packet.say.screen);
      const before = regions()[0]!.innerHTML;
      await qa('/qa/room-decisions/replay', { event_id: first.event_id });
      await waitFor(() => expect(incoming(first.event_id).length).toBe(2), { timeout: 30_000 });
      expect(incoming(first.event_id)[0]!.message).toEqual(incoming(first.event_id)[1]!.message);
      expect(regions()).toHaveLength(1); expect(regions()[0]!.innerHTML).toBe(before);
      fireEvent.click(screen.getByRole('button', { name: '挂断' }));
      await screen.findByRole('button', { name: '通话' }, { timeout: 20_000 }); await capture.rooms.at(-1)!.disconnect();
      const secondCall = await enter(); expect(secondCall).not.toBe(firstCall); expect(regions()).toHaveLength(0);
      await qa('/qa/room-decisions/replay', { event_id: first.event_id });
      await waitFor(() => expect(incoming(first.event_id).length).toBe(3), { timeout: 30_000 });
      // Flush the actual network callback into React, without inventing a room event.
      await new Promise(resolve => setTimeout(resolve, 150)); expect(regions()).toHaveLength(0);
      await qa('/say', { text: '帮我建一个待办:周四下午给客户发样片,建之前先跟我确认一下' });
      const next = await qa('/qa/room-decisions') as typeof sent;
      const second = next.events.find(event => event.call_id === secondCall)!; expect(second).toBeTruthy(); expect(second.event_id).not.toBe(first.event_id);
      await waitFor(() => expect(incoming(second.event_id).length).toBe(1), { timeout: 30_000 });
      await waitFor(() => expect(regions()).toHaveLength(1)); expect(regions()[0]!.textContent).toContain(JSON.parse(second.packet).say.screen);
      expect(capture.rooms.length).toBeGreaterThanOrEqual(2);
      records.push({ assertions: 'Actual producer first packet received twice, one identical UI projection; old call replay received after actual reconnect, no projection; new event/call renders once.', firstCall, secondCall, first: first.event_id, second: second.event_id });
    } finally {
      evidence('producer-replay-app-live', { records, packets: capture.packets, ui: uiText(), boundary: 'Production App with actual native RTC data transport, explicit understanding fixture only. No fake events, microphone, browser geometry or physical device claim.' });
      const hangup = screen.queryByRole('button', { name: '挂断' }); if (hangup) fireEvent.click(hangup);
      await new Promise(resolve => setTimeout(resolve, 500)); view.unmount();
    }
  }, 350_000);

  liveIt('re-enters a real room after disconnect and gates the next producer event to the new call', async () => {
    const ctx = context(); capture.packets.length = 0; capture.rooms.length = 0;
    const view = mountApp(ctx.pairing);
    const rounds: unknown[] = [];
    try {
      for (let turn = 0; turn < 2; turn++) {
        const call = await screen.findByRole('button', { name: '通话' }, { timeout: 20_000 });
        await waitFor(() => expect(call).toHaveProperty('disabled', false), { timeout: 30_000 }); fireEvent.click(call);
        await screen.findByText('通话中', {}, { timeout: 30_000 });
        const started = capture.packets.filter(p => p.direction === 'out' && p.message.type === 'call' && p.message.action === 'start').at(-1)!;
        const before = capture.packets.length;
        const res = await fetch(`http://127.0.0.1:${ctx.textTurn.port}/say`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workbench-text-turn': ctx.textTurn.tokenFile ? readFileSync(ctx.textTurn.tokenFile, 'utf8').trim() : ctx.textTurn.token ?? '' }, body: JSON.stringify({ text: '帮我建一个待办:周四下午给客户发样片,建之前先跟我确认一下' }), signal: AbortSignal.timeout(110_000) });
        const result = await res.json();
        await waitFor(() => expect(capture.packets.slice(before).some(p => p.direction === 'in' && p.from === 'wb-channel-worker' && p.message.type === 'say_decision')).toBe(true), { timeout: 30_000 });
        const events = capture.packets.slice(before).filter(p => p.direction === 'in' && p.message.type === 'say_decision');
        for (const event of events) {
          expect(event.message.call_id).toBe(started.message.call_id);
          expect(screen.getAllByText((event.message.say as { screen: string }).screen).length).toBeGreaterThan(0);
        }
        rounds.push({ call_id: started.message.call_id, status: res.status, result, events });
        fireEvent.click(screen.getByRole('button', { name: '挂断' }));
        await screen.findByRole('button', { name: '通话' }, { timeout: 20_000 });
        // Tear down the actual data connection, not a synthetic disconnected event.
        await capture.rooms.at(-1)!.disconnect();
      }
      const calls = rounds as { call_id: string; events: { message: { event_id: string } }[] }[];
      expect(capture.rooms.length).toBeGreaterThanOrEqual(2);
      expect(calls[0]!.call_id).not.toBe(calls[1]!.call_id);
      expect(new Set(calls.flatMap(r => r.events.map(e => e.message.event_id))).size).toBe(calls.flatMap(r => r.events).length);
    } finally { evidence('room-reentry-live', { rounds, nativeRooms: capture.rooms.length, packets: capture.packets, ui: uiText(), boundary: 'Actual native RTC data reconnection through production App. No microphone/physical device. Producer has no replay/ACK; no duplicate broadcasts invented.' }); view.unmount(); }
  }, 350_000);

  liveIt('receives actual producer decisions through the App call and renders the same screen/original', async () => {
    const ctx = context();
    capture.packets.length = 0;
    const actions: { status: number; body: unknown; request: unknown }[] = [];
    const view = mountApp(ctx.pairing, async (input, init) => {
      const res = await fetch(input, init);
      if (String(input).endsWith('/butler/say') && init?.method === 'POST') actions.push({ status: res.status, body: await res.clone().json(), request: JSON.parse(String(init.body)) });
      return res;
    });
    let result: unknown;
    try {
      const call = await screen.findByRole('button', { name: '通话' }, { timeout: 20_000 });
      await waitFor(() => expect(call).toHaveProperty('disabled', false), { timeout: 30_000 });
      fireEvent.click(call);
      await screen.findByText('通话中', {}, { timeout: 30_000 });
      const started = capture.packets.find(one => one.direction === 'out' && one.message.type === 'call' && one.message.action === 'start');
      expect(started?.message.call_id).toBeTruthy();
      // Original s3 sentence. Text enters the existing ASR-final port; producer, API and room are real.
      const response = await fetch(`http://127.0.0.1:${ctx.textTurn.port}/say`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workbench-text-turn': ctx.textTurn.tokenFile ? readFileSync(ctx.textTurn.tokenFile, 'utf8').trim() : ctx.textTurn.token ?? '' }, body: JSON.stringify({ text: '帮我建一个待办:周四下午给客户发样片,建之前先跟我确认一下' }), signal: AbortSignal.timeout(110_000) });
      result = await response.json();
      await waitFor(() => expect(capture.packets.some(one => one.direction === 'in' && one.from === 'wb-channel-worker' && one.message.type === 'say_decision')).toBe(true), { timeout: 30_000 });
      const events = capture.packets.filter(one => one.direction === 'in' && one.message.type === 'say_decision');
      for (const event of events) {
        expect.soft(event.message.call_id).toBe(started!.message.call_id);
        const say = event.message.say as { screen: string };
        expect(await screen.findByText(say.screen)).toBeTruthy();
        const original = event.message.item as { title?: string; card_id?: string } | undefined;
        if (original?.card_id) expect(screen.getByText(new RegExp(`事项 ID ${original.card_id}`))).toBeTruthy();
      }
      fireEvent.click(await screen.findByRole('button', { name: '否定' }));
      await waitFor(() => expect(actions.length).toBe(1), { timeout: 15_000 });
      expect(actions[0]!.status, JSON.stringify(actions[0])).toBe(200);
      const reply = actions[0]!.body as { say: { screen: string } };
      await waitFor(() => expect(document.body.textContent).toContain(reply.say.screen));
    } finally {
      evidence('room-app-live', { packets: capture.packets, textTurn: result, actions, ui: uiText() });
      const hangup = screen.queryByRole('button', { name: '挂断' });
      if (hangup) fireEvent.click(hangup);
      await new Promise(resolve => setTimeout(resolve, 1000));
      view.unmount();
    }
  }, 200_000);

  liveIt('renders an actual file_ask response from production home composer and API', async () => {
    const ctx = context();
    let response: { status: number; body: Record<string, unknown> } | undefined;
    const transfers: { path: string; status: number; received?: unknown }[] = [];
    const view = mountApp(ctx.pairing, async (input, init) => {
      const res = await fetch(input, init);
      if (String(input).includes('/files/offer/') || String(input).endsWith('/files/received')) transfers.push({ path: new URL(String(input)).pathname.replace(/(offer\/).+$/, '$1<opaque-id>'), status: res.status, ...(String(input).endsWith('/files/received') ? { received: JSON.parse(String(init?.body)) } : {}) });
      if (String(input).endsWith('/butler/say') && init?.method === 'POST') response = { status: res.status, body: await res.clone().json() as Record<string, unknown> };
      return res;
    });
    try {
      const field = await screen.findByLabelText('打字说给事务官', {}, { timeout: 15_000 });
      fireEvent.change(field, { target: { value: '把 README 发到我手机上' } });
      fireEvent.click(screen.getByRole('button', { name: '发送' }));
      await waitFor(() => expect(response).toBeDefined(), { timeout: 110_000 });
      expect(response?.status).toBe(200);
      expect(response?.body.file_ask).toBeDefined();
      expect(document.querySelector('.ba-fileask')).toBeTruthy();
      const say = response!.body.say as { screen: string };
      expect(document.body.textContent).toContain(say.screen);
      const ask = response!.body.file_ask as { hits: { name: string; bytes: number }[] };
      expect(ask.hits.some(hit => hit.name === 'README.md')).toBe(true);
      fireEvent.click(screen.getByRole('button', { name: '把「README.md」发到这台手机' }));
      const dest = join(evidenceDir!, `received-${process.env.COLLAB_1C_RUN_ID ?? 'live'}`, '事务官', 'README.md');
      await waitFor(() => expect(readFileSync(dest, 'utf8')).toBe('# QA 1c 实际文件\n只用于隔离手机取件验收。\n'), { timeout: 30_000 });
      await waitFor(() => expect(transfers.some(one => one.path === '/files/received' && one.status === 200 && (one.received as { ok?: boolean; bytes?: number })?.ok === true && (one.received as { bytes?: number }).bytes === ask.hits[0]!.bytes)).toBe(true));
      expect(document.body.textContent).toContain('收到「README.md」');
    } finally { evidence('file-ask-app-live', { response, transfers, ui: uiText() }); view.unmount(); }
  }, 140_000);
});
