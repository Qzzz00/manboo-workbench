/**
 * 只为「在本机把远程模式跑通一遍」而存在的一段**可以随手杀掉的**转发。
 *
 * 为什么需要它:要验「直连断了自动切到房间」,就得让手机那一侧的 8791 地址真的连不上,
 * 同时工人那一侧还连得上同一台工作台。所以:
 *
 *   手机 ──► 127.0.0.1:<listen>(这段转发)──► 127.0.0.1:<target>(真的旁路工作台)
 *   工人 ─────────────────────────────────► 127.0.0.1:<target>
 *
 * 杀掉这段转发 = 手机出了局域网。工人照常。
 *
 * 用法:node dev/proxy.mjs 8796 8797
 * **不要**把它当成任何生产用途:没有鉴权、没有 TLS、只转发。
 */
import { createServer, request } from 'node:http';

const listen = Number(process.argv[2] ?? 8796);
const target = Number(process.argv[3] ?? 8797);

const server = createServer((req, res) => {
  const upstream = request(
    { host: '127.0.0.1', port: target, path: req.url, method: req.method, headers: req.headers },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on('error', () => { res.writeHead(502); res.end('{"error":"转发不出去"}'); });
  req.pipe(upstream);
});

server.listen(listen, '127.0.0.1', () => {
  console.log(`[proxy] 127.0.0.1:${listen} → 127.0.0.1:${target}`);
});
