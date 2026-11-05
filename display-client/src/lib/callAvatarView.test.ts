import { describe, expect, it } from 'vitest';
import { resolveCallAvatarView } from './callAvatarView.ts';

describe('resolveCallAvatarView → 来电类 UI 头像/名字兜底', () => {
  it('有 avatar 且有 portraitUrl → 返回该图 url + avatar.name', () => {
    const view = resolveCallAvatarView(
      { name: '小美', portraitUrl: 'https://cdn.example.com/p.png' },
      { title: '来自小美的邀请' },
    );
    expect(view.portraitUrl).toBe('https://cdn.example.com/p.png');
    expect(view.name).toBe('小美');
  });

  it('有 avatar 但无 portraitUrl → portraitUrl 为 null（保留占位圆的关键分支），名字用 avatar.name', () => {
    const view = resolveCallAvatarView({ name: '小美' }, { title: '来自小美的邀请' });
    expect(view.portraitUrl).toBeNull();
    expect(view.name).toBe('小美');
  });

  it('无 avatar 但有 event.title → portraitUrl 为 null，名字落回 title', () => {
    const view = resolveCallAvatarView(undefined, { title: '未知来电' });
    expect(view.portraitUrl).toBeNull();
    expect(view.name).toBe('未知来电');
  });

  it('avatar 与 title 都没有 → portraitUrl 为 null，名字落回默认文案"来电"', () => {
    const view = resolveCallAvatarView(undefined, {});
    expect(view.portraitUrl).toBeNull();
    expect(view.name).toBe('来电');
  });

  it('事件带 portraitUrl 时优先用事件值（远端/非当前角色来电场景，SSE 载荷带图但本地 avatar 缓存未同步）', () => {
    const view = resolveCallAvatarView(
      { name: '小美', portraitUrl: 'https://cdn.example.com/local-stale.png' },
      { title: '来自小美的邀请', portraitUrl: 'https://cdn.example.com/event-fresh.png' },
    );
    expect(view.portraitUrl).toBe('https://cdn.example.com/event-fresh.png');
  });

  it('事件无 portraitUrl 但 avatar 有 → 回落 avatar.portraitUrl', () => {
    const view = resolveCallAvatarView(
      { name: '小美', portraitUrl: 'https://cdn.example.com/p.png' },
      { title: '来自小美的邀请' },
    );
    expect(view.portraitUrl).toBe('https://cdn.example.com/p.png');
  });
});
