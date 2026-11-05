// 测试公用:给当前进程一个干净的临时 BUTLER_HOME,再 require 服务端模块。
// 必须在任何 require('../server/…') 之前调用——db.cjs 在加载时就按 env 打开数据库。
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

export const require = createRequire(import.meta.url);

export function tempHome(label = 'butler') {
  const home = mkdtempSync(join(tmpdir(), `${label}-test-`));
  process.env.BUTLER_HOME = home;
  process.env.BUTLER_CONFIG_FILE = join(home, 'butler.json');
  delete process.env.BUTLER_PREVIEW_SECRET;
  return home;
}

export function cleanupHome(home) {
  // 只删自己 mkdtemp 出来的目录(2026-09-04 事故纪律:删除只在自己建的沙箱内)。
  if (home && home.includes('-test-')) rmSync(home, { recursive: true, force: true });
}

export async function listen(app) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    server,
    async close() {
      server.close();
      await once(server, 'close');
    },
  };
}

/** 最小 Live2D 包:一个 model3.json + moc3。 */
export function buildLive2dZip(entries) {
  const AdmZip = require('adm-zip');
  const zip = new AdmZip();
  const list = entries ?? [
    ['ben.model3.json', JSON.stringify({ Version: 3, FileReferences: {} })],
    ['ben.moc3', 'fake-moc'],
  ];
  for (const [name, content] of list) zip.addFile(name, Buffer.isBuffer(content) ? content : Buffer.from(content));
  return zip.toBuffer();
}

export function zipForm(bytes, meta) {
  const fd = new FormData();
  if (meta !== undefined) fd.set('meta', JSON.stringify(meta));
  fd.set('zip', new Blob([bytes], { type: 'application/zip' }), 'model.zip');
  return fd;
}

export async function json(base, path, init = {}) {
  const headers = { ...(init.headers || {}) };
  let body = init.body;
  if (body !== undefined && !(body instanceof FormData)) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(body);
  }
  const res = await fetch(`${base}${path}`, { ...init, headers, body });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed, headers: res.headers };
}
