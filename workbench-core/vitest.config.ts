import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    // 用例里起真端口、真断连再恢复;机器忙时 5 秒不够(同 workbench-plugin 那条理由)。
    testTimeout: 15_000,
    maxWorkers: 4,
  },
})
