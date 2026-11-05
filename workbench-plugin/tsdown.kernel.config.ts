import type { UserConfig } from 'tsdown'
import { buildEndpointDefines } from './scripts/build-endpoints.mjs'

/**
 * 安装器内核(`deploy/build-installer.sh` 打成一份单文件 .mjs,塞进「安装工作台.app」)。
 *
 * 单列一份而不是 `--no-config`(2026-10-21,局域网 M7):内核里装 DSH 设置那一步要用中转地址
 * (`setup/install.ts` 的 `renderDshSettingsSeed` → `modelConfig.ts` 的缺省),那个缺省是构建注入的 ——
 * 不注入的话我们自己的安装包会装出一台「没接中转」的机器。注入规矩与插件同一份(scripts/build-endpoints.mjs)。
 */
const config: UserConfig = {
  entry: { 'install-from-bundle': 'scripts/install-from-bundle.ts' },
  format: 'esm',
  platform: 'node',
  target: 'es2024',
  clean: false,
  define: buildEndpointDefines(),
}

export default config
