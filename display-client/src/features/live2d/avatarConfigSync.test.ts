import { describe, expect, it } from 'vitest';
import { normalizeAvatarConfig } from './avatarConfigSync.ts';

describe('normalizeAvatarConfig → touch 三字段 (portrait/ringtone/notifySound)', () => {
  it('把服务端 snake_case 三字段映射为客户端 camelCase', () => {
    const cfg = normalizeAvatarConfig({
      portrait_url: 'https://cdn.example.com/p.png',
      ringtone_url: 'https://cdn.example.com/r.mp3',
      notify_sound_url: 'https://cdn.example.com/n.mp3',
    });
    expect(cfg).not.toBeNull();
    expect(cfg?.portraitUrl).toBe('https://cdn.example.com/p.png');
    expect(cfg?.ringtoneUrl).toBe('https://cdn.example.com/r.mp3');
    expect(cfg?.notifySoundUrl).toBe('https://cdn.example.com/n.mp3');
  });

  it('空字符串/空白字段一律丢弃，不透传', () => {
    const cfg = normalizeAvatarConfig({
      portrait_url: '',
      ringtone_url: '   ',
      notify_sound_url: undefined,
    });
    // 三字段均无效 → 视作没拿到配置
    expect(cfg).toBeNull();
  });

  it('三字段全无效但其余字段有效时，不应因新字段判空逻辑漏加而丢弃整份配置', () => {
    const cfg = normalizeAvatarConfig({
      voice: 'some-voice',
      portrait_url: '',
    });
    expect(cfg).not.toBeNull();
    expect(cfg?.voice).toBe('some-voice');
    expect(cfg?.portraitUrl).toBeUndefined();
  });

  it('只有三字段之一有效时也不应被判空丢弃', () => {
    const cfg = normalizeAvatarConfig({
      notify_sound_url: 'https://cdn.example.com/n.mp3',
    });
    expect(cfg).not.toBeNull();
    expect(cfg?.notifySoundUrl).toBe('https://cdn.example.com/n.mp3');
  });
});
