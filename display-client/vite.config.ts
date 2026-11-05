import { defineConfig, type Plugin, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import legacy from '@vitejs/plugin-legacy';
import fs from 'node:fs';
import path from 'node:path';

// 「电子吧唧」素材导出落盘中间件（仅 dev server 生效，生产构建不包含）：
// - POST /__badge_export，body { path, base64 }，写入仓库根 badge-assets/（已 .gitignore，素材不入库）；
// - GET  /__badge_export/<relPath>，读取 badge-assets/ 内文件（工具页取背景图等素材用）。
// path 均做穿越防护，只允许落在 badge-assets/ 内。
const BADGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.json': 'application/json',
  '.bin': 'application/octet-stream',
};

function badgeExportSink(): Plugin {
  return {
    name: 'badge-export-sink',
    apply: 'serve',
    configureServer(server: ViteDevServer) {
      server.middlewares.use('/__badge_export', (req, res) => {
        if (req.method === 'GET') {
          try {
            const root = path.resolve(server.config.root, 'badge-assets');
            const relPath = decodeURIComponent((req.url ?? '/').replace(/^\/+/, '').split('?')[0]);
            const target = path.resolve(root, relPath);
            if (!target.startsWith(root + path.sep) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
              res.statusCode = 404;
              res.end('not found');
              return;
            }
            res.setHeader('content-type', BADGE_MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream');
            res.end(fs.readFileSync(target));
          } catch (error) {
            res.statusCode = 500;
            res.end(String(error));
          }
          return;
        }
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end(JSON.stringify({ ok: false, error: 'method not allowed' }));
          return;
        }
        let body = '';
        req.on('data', (chunk: Buffer) => { body += chunk; });
        req.on('end', () => {
          try {
            const { path: relPath, base64 } = JSON.parse(body) as { path?: string; base64?: string };
            if (!relPath || typeof base64 !== 'string') {
              throw new Error('body 需为 { path, base64 }');
            }
            const root = path.resolve(server.config.root, 'badge-assets');
            const target = path.resolve(root, relPath);
            if (target !== root && !target.startsWith(root + path.sep)) {
              throw new Error('path 越出 badge-assets 目录');
            }
            const bytes = Buffer.from(base64, 'base64');
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, bytes);
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ ok: true, path: path.relative(server.config.root, target), bytes: bytes.length }));
          } catch (error) {
            res.statusCode = 400;
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
          }
        });
      });
    },
  };
}

// 吧唧素材上传 dev 落盘（App 内烘焙→投放链路的本地验证端；生产走 server/routes/badge-assets.cjs）：
// POST /badge/assets { deviceId, meta, abpBase64 } → badge-assets/uploads/<assetId>.abp + .json 边车
function badgeAssetSink(): Plugin {
  return {
    name: 'badge-asset-sink',
    apply: 'serve',
    configureServer(server: ViteDevServer) {
      server.middlewares.use('/badge/assets', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end(JSON.stringify({ ok: false, error: 'method not allowed' }));
          return;
        }
        let body = '';
        req.on('data', (chunk: Buffer) => { body += chunk; });
        req.on('end', () => {
          try {
            const { deviceId, meta, abpBase64 } = JSON.parse(body) as {
              deviceId?: string; meta?: { avatarId?: string }; abpBase64?: string;
            };
            if (typeof abpBase64 !== 'string' || !meta?.avatarId) throw new Error('body 需为 { deviceId, meta{avatarId}, abpBase64 }');
            const bytes = Buffer.from(abpBase64, 'base64');
            if (bytes.subarray(0, 4).toString('latin1') !== 'ABP1') throw new Error('不是合法 .abp（magic 校验失败）');
            const assetId = `${meta.avatarId}-${Date.now()}`;
            const dir = path.resolve(server.config.root, 'badge-assets', 'uploads');
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, `${assetId}.abp`), bytes);
            fs.writeFileSync(path.join(dir, `${assetId}.json`), JSON.stringify({ deviceId: deviceId ?? 'default', meta, bytes: bytes.length }, null, 2));
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ ok: true, assetId, bytes: bytes.length }));
          } catch (error) {
            res.statusCode = 400;
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
          }
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    badgeExportSink(),
    badgeAssetSink(),
    // 老设备兼容（如 Android 8.1 出厂 Chrome 61 WebView）：产 SystemJS legacy 包。
    // Chrome 61 支持静态 ESM 但不支持动态 import()（需 63+），plugin-legacy 会注入检测脚本，
    // 缺动态 import 的浏览器自动改走 SystemJS legacy 包（内含 core-js polyfill + 语法降级）。
    // CSS 的 @layer/oklch/color-mix 另由 postcss 降级。
    legacy({
      targets: ['chrome >= 61'],
      modernPolyfills: true,
    }),
  ],
  base: './',
  build: {
    rollupOptions: {
      input: {
        // 主 App 入口（务必保留，否则主入口会丢）
        main: 'index.html',
        // 屏保（Daydream）独立精简入口
        screensaver: 'screensaver.html',
        // 桌宠浮窗（overlay）独立精简入口：只渲染 Live2DScene（无卡片/时钟/DJ）
        pet: 'pet.html',
        // 全息屏立牌（投屏展示）独立精简入口：白底全屏、只渲染 Live2DScene，上下滑动切角色
        holo: 'holo.html',
        // 展示台（1200×800，PRD §6）。与 holo 并存，各自独立入口。
        display: 'display.html',
      },
    },
  },
  server: {
    watch: {
      // 吧唧素材导出往 badge-assets/ 落盘（含外部脚本重组），别触发 dev server 重载打断导出会话
      // .superpowers/ 是 SDD 进度账本，导出会话中随时追加——同样不能触发整页重载（实测打断过连拍）
      ignored: ['**/badge-assets/**', '**/.superpowers/**'],
    },
    proxy: {
      '/ai': {
        target: 'http://localhost:3456',
        changeOrigin: true,
      },
    },
  },
});
