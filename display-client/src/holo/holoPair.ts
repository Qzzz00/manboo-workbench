/**
 * Stackchan 配对码解析：URL ?pair= 优先；瘦终端本机访问（holo.exe 固定开
 * http://127.0.0.1:<port>）默认 'ben1'——明早零参数直接可用；
 * 其他环境不默认（普通用户/线上访客零轮询开销）。
 */
export const DEFAULT_LOCAL_PAIR = 'ben1';

const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1']);

export function resolveHoloPair(search: string, hostname: string): string | null {
  const fromUrl = new URLSearchParams(search).get('pair');
  if (fromUrl) return fromUrl.slice(0, 64);
  return LOCAL_HOSTNAMES.has(hostname) ? DEFAULT_LOCAL_PAIR : null;
}
