/**
 * 协作频道投影测试(2026-10-24,小K)。
 *
 * 频道是事务官局域网聊天室:人类**只读**(没有发送框);消息分资讯/日报/周报;
 * 发送者显示名与稳定身份分开(改名不丢关联是服务端的事,这里如实摆 account/device);
 * 未接中转/离线/没有工作室/已加入四态如实;撤回折成「已撤回」;坏了的消息跳过不炸。
 */
import { describe, expect, it } from 'vitest';
import { messageRows, projectStudio, CHANNEL_KIND_TITLES } from '../src/collab/channelApi';

describe('projectStudio:四态如实', () => {
  it('unwired / offline / none 原样带原因', () => {
    expect(projectStudio({ state: 'unwired', why: '没配中转' })).toEqual({ state: 'unwired', why: '没配中转' });
    expect(projectStudio({ state: 'offline', why: '中转连不上' })).toEqual({ state: 'offline', why: '中转连不上' });
    expect(projectStudio({ state: 'none' })).toEqual({ state: 'none' });
  });

  it('joined:成员稳定身份(account)与显示名(nick)分开,频道清单带版本', () => {
    const s = projectStudio({
      state: 'joined',
      workspace: { name: '测试工作室' },
      members: [
        { account_id: 'acct-1', nick: '阿真', role: 'admin', devices: ['pixel-9'] },
        { account_id: 'acct-2', nick: '小Z' },
        { bad: true },
      ],
      channels: [
        { id: 'ws:1/ch:1', name: '工作室', kind: 'workspace', version: 3 },
        { id: 'ws:1/ch:2', name: '项目甲', kind: 'project', version: 0 },
      ],
    });
    if (s.state !== 'joined') throw new Error('应 joined');
    expect(s.workspaceName).toBe('测试工作室');
    expect(s.members.map((m) => m.accountId)).toEqual(['acct-1', 'acct-2']);
    expect(s.members[0].devices).toEqual(['pixel-9']);
    expect(s.channels.map((c) => c.id)).toEqual(['ws:1/ch:1', 'ws:1/ch:2']);
  });

  it('认不出的/坏的数据 → 明确态,不编造', () => {
    expect(projectStudio(undefined).state).toBe('unknown');
    expect(projectStudio({ state: 'weird' }).state).toBe('unknown');
  });
});

describe('messageRows:消息流投影', () => {
  it('发送者/稳定身份/话题/引用/回复/时间,撤回折行', () => {
    const { messages } = messageRows({
      channel: { id: 'ch:1', name: '工作室', kind: 'workspace', version: 2 },
      messages: [
        {
          id: 'm1', seq: 1, kind: 'daily',
          author: { person: 'acct-1', nick: '阿真', device: 'pixel-9', butler: true },
          text: '今天日报:修了两处',
          refs: [{ object_id: 'task:t1', kind: 'task', title: '修目标页' }],
          reply_to: undefined, at: '2026-10-23T21:00:00+08:00',
        },
        {
          id: 'm2', seq: 2, kind: 'say',
          author: { person: 'acct-2', nick: '小Z', device: 'mbp' },
          text: '', retracted: { by: 'acct-2', at: '2026-10-23T22:00:00+08:00' },
          refs: [], at: '2026-10-23T21:30:00+08:00',
        },
        { bad: true },
      ],
      cursor: 9,
    });
    expect(messages).toHaveLength(2);
    const [m1, m2] = messages;
    expect(m1.authorName).toBe('阿真');
    expect(m1.identity).toBe('acct-1 · pixel-9');
    expect(m1.butler).toBe(true);
    expect(m1.kindTitle).toBe('日报');
    expect(m1.refs[0]).toEqual({ objectId: 'task:t1', kind: 'task', title: '修目标页' });
    expect(m2.retracted).toBe(true);
    expect(m2.text).toBe('已撤回');
  });

  it('话题名表:say=资讯、daily=日报、weekly=周报;未知 kind 原样', () => {
    expect(CHANNEL_KIND_TITLES.say).toBe('资讯');
    expect(CHANNEL_KIND_TITLES.daily).toBe('日报');
    expect(CHANNEL_KIND_TITLES.weekly).toBe('周报');
    expect(CHANNEL_KIND_TITLES.weird).toBeUndefined();
  });

  it('按 seq 升序排(快照本身就是升序;投影再钉一次,坏 seq 的排到后面也不丢)', () => {
    const { messages } = messageRows({
      channel: { id: 'c', name: 'c', kind: 'workspace', version: 1 },
      messages: [
        { id: 'b', seq: 2, kind: 'say', author: { person: 'a', nick: 'A', device: 'd' }, text: '二', refs: [], at: '2026-10-23T10:00:01+08:00' },
        { id: 'a', seq: 1, kind: 'say', author: { person: 'a', nick: 'A', device: 'd' }, text: '一', refs: [], at: '2026-10-23T10:00:00+08:00' },
      ],
      cursor: 0,
    });
    expect(messages.map((m) => m.text)).toEqual(['一', '二']);
  });
});
