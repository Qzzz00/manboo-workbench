import { describe, expect, it } from 'vitest';
import { utils } from 'pixi.js';

/** bundleLoader 的前提与补丁:pixi 的 url.resolve 会把 blob: 绝对路径改坏,补丁之后原样返回。 */
describe('pixi-live2d-display 对 blob URL 的解析', () => {
  it('原生 url.resolve 会把 blob:http:// 改成 blob:http//(这就是要补的坑)', () => {
    expect(utils.url.resolve('blob:http://localhost/aaa-bbb', 'blob:http://localhost/ccc-ddd')).not.toBe('blob:http://localhost/ccc-ddd');
  });

  it('补丁后:绝对地址原样,相对路径照旧拼目录', async () => {
    const { ModelSettings } = await import('pixi-live2d-display/cubism4');
    const { installLive2DUrlPatch } = await import('../src/live2d/urlPatch');
    installLive2DUrlPatch();
    installLive2DUrlPatch();
    const settings = Object.create(ModelSettings.prototype) as { url: string; resolveURL(path: string): string };
    settings.url = 'http://x/a/b.model3.json';
    expect(settings.resolveURL('blob:http://localhost/ccc-ddd')).toBe('blob:http://localhost/ccc-ddd');
    expect(settings.resolveURL('tex.png')).toBe('http://x/a/tex.png');
  });

  it('isAbsoluteUrl', async () => {
    const { isAbsoluteUrl } = await import('../src/live2d/urlPatch');
    expect(isAbsoluteUrl('blob:http://a/b')).toBe(true);
    expect(isAbsoluteUrl('data:application/json,{}')).toBe(true);
    expect(isAbsoluteUrl('hijiki.moc3')).toBe(false);
    expect(isAbsoluteUrl('./x/y.png')).toBe(false);
  });
});
