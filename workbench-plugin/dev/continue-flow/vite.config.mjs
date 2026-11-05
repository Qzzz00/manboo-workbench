// 协作A「继续这件事」真浏览器验收页:真 NoteDialog 对隔离/验收实例(代理同源)。
// 目标实例用 WB_TARGET 指(缺省 8799 = 本地内存假;真 DSH 验收用 http://127.0.0.1:8993)。
const target = process.env.WB_TARGET ?? 'http://127.0.0.1:8799'
export default {
  root: '.',
  server: {
    port: Number(process.env.WB_FLOW_PORT ?? 4331),
    host: '127.0.0.1',
    strictPort: true,
    proxy: {
      '/butler': target,
      '/sessions': target,
      '/task': target,
      '/jobs': target,
      '/state': target,
      '/collab': target,
    },
  },
}
