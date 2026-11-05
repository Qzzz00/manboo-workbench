/**
 * 形象陈列页顶上那一句(2026-10-21):一个形象都没有时说清楚是哪一种 —— 没配对 / 连不上电脑 / 电脑上还没上传,
 * 以及去哪儿传。不让人对着一颗粒子球猜「形象去哪了」。
 */
import { describe, expect, it } from 'vitest';
import { AVATAR_UPLOAD_HOWTO, galleryNote } from '../src/avatars/AvatarGalleryPage';
import type { LibrarySnapshot } from '../src/avatars/library';

const item = { id: 'a1', name: '日和', base: 'b/', entry: 'm.model3.json', subject: { x0: 0, y0: 0, x1: 1, y1: 1 }, backdrop: null, idle: { loop: [], beats: [], muteMouth: false } };
const snap = (over: Partial<LibrarySnapshot>): Pick<LibrarySnapshot, 'server' | 'entries' | 'stage'> => ({ server: 'ok', entries: [], stage: [], ...over });

describe('galleryNote', () => {
  it('★电脑上还没上传:只有粒子球 + 去哪儿传', () => {
    const s = galleryNote(snap({}));
    expect(s).toContain('电脑上还没有形象');
    expect(s).toContain(AVATAR_UPLOAD_HOWTO);
    expect(AVATAR_UPLOAD_HOWTO).toContain('打开配置后台');
    expect(AVATAR_UPLOAD_HOWTO).toContain('发布');
  });
  it('没配对:形象放在电脑上;连不上:手机上下过的照常能用', () => {
    expect(galleryNote(snap({ server: 'unknown' }))).toContain('配对之后');
    expect(galleryNote(snap({ server: 'unknown' }))).toContain('只有粒子球');
    expect(galleryNote(snap({ server: 'offline', stage: [item] }))).toContain('手机上已经下过的照常能用');
    expect(galleryNote(snap({ server: 'offline' }))).toContain('只有粒子球');
  });
  it('有形象:讲怎么换、怎么下', () => {
    expect(galleryNote(snap({ entries: [{ id: 'a1', name: '日和', state: { kind: 'available' } }] }))).toContain('左右滑');
  });
});
