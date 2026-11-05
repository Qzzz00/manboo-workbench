/**
 * 「电话里把视频弹到眼前」那一处判断(2026-10-12,周三演示「出图进可灵」那条链路的末尾)。
 *
 * 维护者原话:「看到视频之后推到手机端上,再打个电话过来,并且可以在手机上(通话过程中)看到视频。
 * 播放器以弹窗形式弹到通话页面上,给个关闭的 icon。」
 *
 * 所以这里只认一件事:**电脑推过来的那几张卡里,哪一个该在通话中自己弹出来**。
 *   · 只有视频自己弹(别的照旧等挂了电话再摆那张卡 —— 一张 PDF 弹在通话里没有意义);
 *   · 弹过一次就不再弹(她关掉的不要回来);
 *   · 卡上名字是视频、`kind` 没标对也认(名字是真相,`kind` 是网络上来的)。
 */
import { describe, expect, it } from 'vitest';
import type { FileAsk, FileAskHit } from '../src/files/fileFetch';
import { inCallVideoOffer, isVideoHit, playableFileSrc } from '../src/files/inCallVideo';

function hit(over: Partial<FileAskHit> = {}): FileAskHit {
  return { offer: 'o-1', name: '片子.mp4', where: '桌面', bytes: 1024, kind: 'video', ...over };
}

function ask(over: Partial<FileAsk> = {}): FileAsk {
  return { id: 'a-1', request: '', query: '', device: '电脑', hits: [hit()], total: 1, ...over };
}

describe('通话中自己弹的那一个', () => {
  it('视频就弹,挑第一个没弹过的', () => {
    const picked = inCallVideoOffer([ask()], new Set());
    expect(picked?.hit.offer).toBe('o-1');
    expect(picked?.ask.id).toBe('a-1');
  });

  it('弹过的不再弹(她关掉的不要回来)', () => {
    expect(inCallVideoOffer([ask()], new Set(['o-1']))).toBeNull();
  });

  /**
   * **上一通弹过(或她关掉)的,新一通不弹回来**(2026-10-13,卡 E 第 2 条)。
   * 弹窗本身随通话结束收掉(页上那一处:`inCall` 一翻就归零),而这本「弹过的」**跨通保留** ——
   * 两样合起来才是维护者要的「新一通从干净的屏开始」。
   */
  it('★上一通弹过的那一段,新一通不弹回来;新一通里新推来的那一段照弹', () => {
    const shown = new Set(['o-1']);
    expect(inCallVideoOffer([ask()], shown)).toBeNull();
    const picked = inCallVideoOffer([ask({ id: 'a-2', hits: [hit({ offer: 'o-2', name: '新成片.mp4' })] })], shown);
    expect(picked?.hit.offer).toBe('o-2');
  });

  it('不是视频的不弹(照旧等挂了电话摆那张卡)', () => {
    expect(inCallVideoOffer([ask({ hits: [hit({ name: '稿子.pdf', kind: 'pdf' })] })], new Set())).toBeNull();
  });

  it('kind 没标对、名字是视频也认', () => {
    const picked = inCallVideoOffer([ask({ hits: [hit({ name: '成片.mov', kind: 'other' })] })], new Set());
    expect(picked?.hit.name).toBe('成片.mov');
  });

  it('一张卡上几个候选时挑那个视频,不挑排在前面的文稿', () => {
    const picked = inCallVideoOffer(
      [ask({ hits: [hit({ offer: 'o-a', name: '分镜.md', kind: 'text' }), hit({ offer: 'o-b', name: '成片.m4v' })] })],
      new Set(),
    );
    expect(picked?.hit.offer).toBe('o-b');
  });

  it('没有卡、空卡都是 null(问不到就当这一拍没有)', () => {
    expect(inCallVideoOffer([], new Set())).toBeNull();
    expect(inCallVideoOffer([ask({ hits: [] })], new Set())).toBeNull();
  });

  it('isVideoHit 认 kind 也认名字', () => {
    expect(isVideoHit(hit({ kind: 'video', name: '没后缀的名字' }))).toBe(true);
    expect(isVideoHit(hit({ kind: 'other', name: 'a.mp4' }))).toBe(true);
    expect(isVideoHit(hit({ kind: 'other', name: 'a.png' }))).toBe(false);
  });
});

describe('存下来的那个文件 → 能放的地址', () => {
  it('有 file:// 地址就交给 Capacitor 换成同源地址', () => {
    const src = playableFileSrc(
      { uri: 'file:///storage/emulated/0/Documents/事务官/片子.mp4', path: '事务官/片子.mp4' },
      (uri) => uri.replace('file://', 'http://localhost/_capacitor_file_'),
    );
    // 非 ASCII 要编码:WebView 直接吃一个带中文的地址不保险。
    expect(src).toBe('http://localhost/_capacitor_file_/storage/emulated/0/Documents/%E4%BA%8B%E5%8A%A1%E5%AE%98/%E7%89%87%E5%AD%90.mp4');
  });

  it('没有 file:// 地址(浏览器里那条退路)就没有能放的地址 —— 不编一个', () => {
    expect(playableFileSrc({ path: '事务官/片子.mp4' }, (uri) => uri)).toBeUndefined();
    expect(playableFileSrc(undefined, (uri) => uri)).toBeUndefined();
  });
});
