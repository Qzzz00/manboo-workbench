import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createApiClient } from '../src/api/client';
import { LanChannelPanel } from '../src/collab/LanChannelPanel';

const NOW = '2026-10-24T11:00:00+08:00';
const MESSAGE = {
  id: 'm-local', project_id: 'project:sample', author: { member_id: 'stable-a', name: '甲事务官' },
  text: '请核对样片字幕', kind: 'message', at: NOW,
  deliveries: [{ to: 'stable-b', status: 'accepted', at: NOW, receipt: {
    kind: 'done', text: '字幕已核对,第七秒需修改', message_id: 'm-local', by: 'member:stable-b', at: NOW, evidence: ['sample-review.txt'],
  } }],
};

function clientOf(data: unknown) {
  return createApiClient({
    pairing: { token: 'test-only', host: '127.0.0.1', port: 10092, deviceId: 'test' },
    onUnauthorized() {},
    fetchImpl: async () => new Response(JSON.stringify(data), { status: 200 }),
  });
}

describe('手机真实 LAN 频道消费', () => {
  it('只显示同项目 LAN 事实、稳定来源与精确回执,人类没有发送框', async () => {
    render(<LanChannelPanel client={clientOf({ transport: 'lan', scope: 'known-paired-members', messages: [MESSAGE] })} projects={[{ id: 'project:sample', name: '样片项目' }]} refreshToken={1} now={NOW} />);
    expect(await screen.findByText('请核对样片字幕')).toBeTruthy();
    expect(screen.getByText(/甲事务官.*stable-a/)).toBeTruthy();
    expect(screen.getByText(/已知配对成员范围/)).toBeTruthy();
    expect(screen.getByText(/字幕已核对,第七秒需修改/)).toBeTruthy();
    expect(screen.getByText(/sample-review.txt/)).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: /发送/ })).toBeNull();
  });

  it('relay 与坏回包不当作 LAN,也不伪装成没有消息', async () => {
    render(<LanChannelPanel client={clientOf({ transport: 'relay', messages: [MESSAGE] })} projects={[{ id: 'project:sample', name: '样片项目' }]} refreshToken={1} now={NOW} />);
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '局域网频道回包无法确认来源或项目');
    expect(screen.queryByText('请核对样片字幕')).toBeNull();
    expect(screen.queryByText(/还没有消息/)).toBeNull();
  });

  it('另一条消息的回执不能冒成本条已处理', async () => {
    const wrong = { ...MESSAGE, deliveries: [{ ...MESSAGE.deliveries[0], receipt: { ...MESSAGE.deliveries[0]!.receipt, message_id: 'another-message' } }] };
    render(<LanChannelPanel client={clientOf({ transport: 'lan', scope: 'known-paired-members', messages: [wrong] })} projects={[{ id: 'project:sample', name: '样片项目' }]} refreshToken={1} now={NOW} />);
    expect(await screen.findByText('回执关联未知,尚不能确认这条消息的处理结果')).toBeTruthy();
    expect(screen.queryByText(/字幕已核对,第七秒需修改/)).toBeNull();
  });

  it('切项目时旧消息立即退出,新数据没到之前不冒空结果', async () => {
    let finish: ((value: Response) => void) | undefined;
    const client = createApiClient({
      pairing: { token: 'test-only', host: '127.0.0.1', port: 10092, deviceId: 'test' }, onUnauthorized() {},
      fetchImpl: async (input) => String(input).includes('project%3Aother')
        ? new Promise<Response>((resolve) => { finish = resolve; })
        : new Response(JSON.stringify({ transport: 'lan', scope: 'known-paired-members', messages: [MESSAGE] })),
    });
    render(<LanChannelPanel client={client} projects={[{ id: 'project:sample', name: '样片项目' }, { id: 'project:other', name: '另一个项目' }]} refreshToken={1} now={NOW} />);
    await screen.findByText('请核对样片字幕');
    await act(async () => { fireEvent.change(screen.getByRole('combobox', { name: '局域网项目频道' }), { target: { value: 'project:other' } }); });
    expect(screen.queryByText('请核对样片字幕')).toBeNull();
    expect(screen.getByText('正在读局域网频道…')).toBeTruthy();
    await act(async () => { finish?.(new Response(JSON.stringify({ transport: 'lan', scope: 'known-paired-members', messages: [] }))); });
    expect(await screen.findByText('这个项目的已知成员范围里还没有消息。')).toBeTruthy();
  });
});
