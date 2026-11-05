/**
 * Aiboo 云(音乐 / 歌词 / 角色 / 对话后端)的**默认**地址。本仓库没有这台服务的源码,展示台仍实时调它。
 *
 * 默认值与之前写死的一字不差。自己构建时可用 `VITE_AIBOO_BASE_URL` 换默认(2026-10-21,开源整理);
 * 运行时另有 `?server=`、localStorage `llm-live2d:server-url`、原生桥接几层覆盖(screensaver/lib/serverConfig.ts)。
 * 全部对外连接见 docs/开源-对外连接清单-2026-10-21.md。
 */
const BUILT_IN = 'http://your-aiboo-host:3456';

export function aibooDefaultBase(fromEnv: string | undefined): string {
  const trimmed = (fromEnv ?? '').trim().replace(/\/+$/, '');
  return /^https?:\/\/[^\s/]+(\/\S*)?$/i.test(trimmed) ? trimmed : BUILT_IN;
}

export const AIBOO_DEFAULT_BASE_URL = aibooDefaultBase(
  (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_AIBOO_BASE_URL,
);
