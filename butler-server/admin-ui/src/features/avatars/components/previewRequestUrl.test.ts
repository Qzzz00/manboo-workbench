/** 预览模型 URL 编码往返:原名 / 已编码 / 混合输入都归一成逐段 encodeURIComponent 的 ASCII URL,且幂等。 */
import { describe, expect, it } from 'vitest';
import { toPreviewRequestUrl } from '@/features/avatars/components/previewRequestUrl';

const BASE = '/admin/avatars/fwGOBmQAAA/preview/ZndHT0Jt.QUFB-_x';

describe('toPreviewRequestUrl', () => {
  it('原名(未编码)中文路径 → 逐段编码,斜杠保留', () => {
    expect(toPreviewRequestUrl(`${BASE}/爱伶Rin.model3.json`)).toBe(`${BASE}/${encodeURIComponent('爱伶Rin.model3.json')}`);
    expect(toPreviewRequestUrl(`${BASE}/爱伶Rin.4096/texture_00.png`)).toBe(
      `${BASE}/${encodeURIComponent('爱伶Rin.4096')}/texture_00.png`,
    );
  });

  it('服务端已编码的 modelUrl 原样通过,不双重编码(幂等)', () => {
    const encoded = `${BASE}/${encodeURIComponent('【雪熊企划】黑客少女.png')}`;
    expect(toPreviewRequestUrl(encoded)).toBe(encoded);
    expect(toPreviewRequestUrl(toPreviewRequestUrl(encoded))).toBe(encoded);
  });

  it('encodeURI 放过的保留字符(# ? 空格)也编码,避免被当成 hash/query', () => {
    expect(toPreviewRequestUrl(`${BASE}/a #1 (2).png`)).toBe(`${BASE}/a%20%231%20(2).png`);
  });

  it('名字里本来就有 % 但不是合法转义 → 按字面编码,不抛错', () => {
    expect(toPreviewRequestUrl(`${BASE}/100%.png`)).toBe(`${BASE}/100%25.png`);
  });

  it('绝对 URL 保留 scheme 与 host;基址段(id / token)不受影响', () => {
    expect(toPreviewRequestUrl(`http://127.0.0.1:8792${BASE}/凛.model3.json`)).toBe(
      `http://127.0.0.1:8792${BASE}/${encodeURIComponent('凛.model3.json')}`,
    );
    expect(toPreviewRequestUrl(`${BASE}/x.json`)).toBe(`${BASE}/x.json`);
  });
});
