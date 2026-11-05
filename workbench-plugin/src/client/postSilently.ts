/**
 * 由 Workbench.tsx 拆出(2026-08-25 地基:六窗口并行前的接缝切分)。**逐字搬运,
 * 没有改一行行为**——原文件 1190 行,四块需求都要改它,不拆开必冲突。
 */

/** POST 且失败静默——真相以服务端下一拍推送/轮询为准，跟 markRead 同一套规矩。 */
export async function postSilently(url: string, body: unknown, fetchImpl: typeof fetch): Promise<void> {
  try {
    await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch {
    // 静默失败：下一拍轮询会显示真实状态，或者用户自己再操作一次。
  }
}
