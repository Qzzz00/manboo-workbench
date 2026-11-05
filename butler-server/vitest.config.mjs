import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.mjs'],
    // 每个文件独立进程:db.cjs 在 require 时就打开数据库,各文件用各自的临时 BUTLER_HOME。
    pool: 'forks',
    isolate: true,
    testTimeout: 15_000,
    // 测试里**绝不**去问本机真的 8791(那台上可能跑着真的工作台,会把真的语音钥匙拉进测试进程)。
    // 要测「工作台下发」的用例自己起一个假 8791 并把这个变量指过去。见 services/workbenchVoiceCreds.cjs。
    env: { BUTLER_WORKBENCH_URL: 'off' },
  },
});
