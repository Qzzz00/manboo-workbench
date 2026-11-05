import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.mjs'],
    // 每个文件独立进程:db.cjs 建的是进程内的一个 DatabaseSync,各文件用各自的临时库。
    pool: 'forks',
    isolate: true,
    testTimeout: 15_000,
  },
});
