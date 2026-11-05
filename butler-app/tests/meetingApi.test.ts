/**
 * 会议对电脑说的话,各走哪条路(2026-10-09,卡「会后真机走通」)。
 *
 * - 只有文字的(开 / 结束 / 看纪要 / 建事项 / 重新来):走选好路的那个客户端,在家直连、出门经房间代理;
 * - **录音分段**:默认只走直连。出门(选路那边已经知道直连不通)就**不发**,回一个 offline,攒着等回家;
 *   她这一场点过「现在经服务器传」才交给选好路的那个(出门就经房间的 wb.meeting 字节流)。
 */
import { describe, expect, it } from 'vitest';
import type { ApiClient, ApiResult, RequestOptions } from '../src/api/client';
import { MEETING_AWAY_TEXT, createMeetingApi } from '../src/meeting/meetingApi';
import type { WbchMode } from '../src/channel/channelProtocol';

function client(name: string, log: string[], reply: (path: string) => ApiResult<unknown> = () => ({ ok: true, status: 200, data: { ok: true, id: 'srv-1' } })) {
  return {
    baseUrl: name,
    async json<T>(path: string, options: RequestOptions = {}): Promise<ApiResult<T>> {
      log.push(`${name} ${options.method ?? 'GET'} ${path.split('?')[0]}${options.body instanceof Blob ? ' blob' : ''}`);
      return reply(path) as ApiResult<T>;
    },
    async blob(): Promise<ApiResult<Blob>> { return { ok: false, status: 404, kind: 'http', error: '用不到' }; },
  } as ApiClient;
}

function wire(mode: WbchMode, directReply?: (path: string) => ApiResult<unknown>) {
  const log: string[] = [];
  const direct = client('direct', log, directReply);
  const routed = Object.assign(client('routed', log), { mode: () => mode });
  return { log, api: createMeetingApi({ direct, routed }) };
}

const SEG = { seq: 2, bytes: new Uint8Array([1, 2, 3]), mimeType: 'audio/mp4', ms: 600_000 };

describe('录音分段走哪条', () => {
  it('在家:直连,裸二进制', async () => {
    const { log, api } = wire('direct');
    expect(await api.sendSegment('srv-1', SEG, { viaRelay: false })).toEqual({ ok: true });
    expect(log).toEqual(['direct POST /meeting/segment blob']);
  });

  it('出门、没点过「经服务器传」:一个字节都不发,回 offline + 那句话', async () => {
    const { log, api } = wire('remote');
    expect(await api.sendSegment('srv-1', SEG, { viaRelay: false })).toEqual({ ok: false, offline: true, error: MEETING_AWAY_TEXT });
    expect(log).toEqual([]);
  });

  it('直连够不着(刚出门,选路那边还没察觉):也是 offline,不改走房间', async () => {
    const { log, api } = wire('direct', () => ({ ok: false, status: 0, kind: 'network', error: '连不上工作台' }));
    expect(await api.sendSegment('srv-1', SEG, { viaRelay: false })).toMatchObject({ ok: false, offline: true });
    expect(log).toEqual(['direct POST /meeting/segment blob']);
  });

  it('这一场她点过「现在经服务器传」:交给选好路的那个(出门就经房间)', async () => {
    const { log, api } = wire('remote');
    expect(await api.sendSegment('srv-1', SEG, { viaRelay: true })).toEqual({ ok: true });
    expect(log).toEqual(['routed POST /meeting/segment blob']);
  });
});

describe('只有文字的那几条走选好路的那个', () => {
  it('开 / 结束 / 看 / 建 / 重新来', async () => {
    const { log, api } = wire('remote');
    await api.start({ title: '周会', client_key: 'k1', started_at: '2026-10-09T02:00:00.000Z' });
    await api.finish('srv-1', '周会');
    await api.get('srv-1');
    await api.apply('srv-1', []);
    await api.retry('srv-1');
    expect(log).toEqual(['routed POST /meeting/start', 'routed POST /meeting/finish', 'routed GET /meeting', 'routed POST /meeting/apply', 'routed POST /meeting/retry']);
  });
});
