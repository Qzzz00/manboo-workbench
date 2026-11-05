/**
 * 把预览模型 URL 归一成可直接请求的形式:逐段 encodeURIComponent,斜杠保留,scheme://host 原样。
 * 输入可以是原名(`${baseUrl}/${modelEntry}`)、服务端已编码的 modelUrl、或两者混合;
 * 每段先尝试 decodeURIComponent 再编码,所以幂等,不会把 %E7 再编成 %25E7。
 * 之前用 encodeURI:它放过 # ? 等保留字符,且对已编码输入会双重编码。
 */
export function toPreviewRequestUrl(url: string): string {
  const m = /^([a-z][a-z0-9+.-]*:\/\/[^/]*)(.*)$/i.exec(url);
  const prefix = m ? m[1] : '';
  const pathPart = m ? m[2] : url;
  const encoded = pathPart
    .split('/')
    .map((seg) => {
      let plain = seg;
      try {
        plain = decodeURIComponent(seg);
      } catch {
        // 不是合法百分号转义(如文件名里本来就有 %):按字面处理
      }
      return encodeURIComponent(plain);
    })
    .join('/');
  return prefix + encoded;
}
