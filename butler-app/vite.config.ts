import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// @ts-expect-error 构建脚本是 .mjs,没有类型声明
import { relayUrlForBuild } from './scripts/build-relay.mjs';

export default defineConfig({
  plugins: [react()],
  // 缺省中转地址构建时注入(src/account/accountStore.ts):我们的包读 deploy/release-endpoints.env,开源构建是空(2026-10-21)。
  define: { __WORKBENCH_BUILD_RELAY_URL__: JSON.stringify(relayUrlForBuild()) },
  // Capacitor 从 http://localhost 根路径起服务,相对路径最稳(与 display-client 同法)。
  base: './',
  build: {
    target: 'es2020',
    sourcemap: false,
  },
});
