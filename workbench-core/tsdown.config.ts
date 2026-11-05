import type { UserConfig } from 'tsdown'

// 运行时零依赖(WS 客户端用 Node 内置 WebSocket,WS 透传走裸 TCP),产物是一个文件,
// 装机只要拷 lib/core.js 过去、用 ~/.dsh/node 跑。
const config: UserConfig = {
  entry: { core: 'src/main.ts' },
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'node24',
  fixedExtension: false,
  clean: true,
}

export default config
