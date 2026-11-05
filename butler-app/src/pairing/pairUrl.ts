/**
 * 配对地址的解析。二维码与深链都是同一种写法(工作台 lan.ts 拼的):
 *   workbench://pair?host=<局域网 IP>&port=<端口>&code=<6 位码>
 * 这里只做解析,不发请求;解析不出来就 null,不猜地址。
 */
export interface PairTarget {
  host: string;
  port: number;
  code?: string;
}

const DEFAULT_PORT = 8791;

export function isSixDigitCode(value: string): boolean {
  return /^\d{6}$/.test(value.trim());
}

function parsePort(raw: string | null): number | null {
  if (raw === null || raw === '') return DEFAULT_PORT;
  if (!/^\d{1,5}$/.test(raw)) return null;
  const port = Number(raw);
  return port >= 1 && port <= 65535 ? port : null;
}

export function parsePairUrl(raw: string): PairTarget | null {
  const text = raw.trim();
  const match = /^workbench:\/\/pair(?:\/)?(\?.*)?$/i.exec(text);
  if (match === null) return null;
  const params = new URLSearchParams(match[1] ?? '');
  const host = (params.get('host') ?? '').trim();
  if (host === '') return null;
  const port = parsePort(params.get('port'));
  if (port === null) return null;
  const code = (params.get('code') ?? '').trim();
  return isSixDigitCode(code) ? { host, port, code } : { host, port };
}

/** 手输的地址:`host`、`host:port`、`http://host:port/` 三种都认。 */
export function normalizeHostPort(raw: string): Omit<PairTarget, 'code'> | null {
  let text = raw.trim();
  if (text === '') return null;
  text = text.replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  const colon = text.lastIndexOf(':');
  let host = text;
  let portRaw: string | null = null;
  if (colon > 0 && !text.startsWith('[')) {
    host = text.slice(0, colon);
    portRaw = text.slice(colon + 1);
  }
  host = host.trim();
  if (host === '') return null;
  const port = parsePort(portRaw);
  if (port === null) return null;
  return { host, port };
}

export function baseUrlOf(target: { host: string; port: number }): string {
  const host = target.host.includes(':') && !target.host.startsWith('[') ? `[${target.host}]` : target.host;
  return `http://${host}:${target.port}`;
}
