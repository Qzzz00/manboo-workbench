/**
 * 「去授权」按下去那一下(2026-09-18 从 NeedBar 提出来)。
 *
 * 原来这段只长在顶上那条横幅里。这一版窗位槽与系统文件夹里那行红字也要带同一颗按钮
 * (任务卡:「窗位槽红字与『去授权』按钮同一句」),两处各抄一遍必然走漂 ——
 * 尤其是"点过才挂 focus 复查"这条不显眼的纪律:没点过的人回到窗口时不该白跑一次体检。
 *
 * 行为逐字沿用 09-17 那一版,一条都没改:
 *   ① 调 `POST /setup/open { pane: 'accessibility' }` 打开系统设置那一页;
 *   ② 打不开就把原因如实摆出来 —— 按下去没反应的话,人只会以为工作台坏了(D13);
 *   ③ 点过之后回到窗口(window focus)真跑一次体检,下一拍横幅/红字自己消失。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchSetupStatus, openSetupPane } from './setup/setupApi.ts'
import type { SetupPane } from '../server/setup/types.ts'

export interface AccessAuthorize {
  /** 按钮的 onClick。自己吞掉异常,失败落在 error 上。 */
  authorize: () => void
  /** 打不开系统设置时的原因原文;正常时 null。 */
  error: string | null
}

/**
 * @param pane 去哪一页。缺省是辅助功能(09-18 那一版唯一的用法)。
 *   2026-10-13 多一个用法:「完全磁盘访问」那条横幅传 `'all_files'` ——
 *   "点过才挂 focus 复查" 那条纪律两处共用,不再抄第二遍。
 */
export function useAccessAuthorize(baseUrl: string, fetchImpl?: typeof fetch, pane: SetupPane = 'accessibility'): AccessAuthorize {
  const doFetch = fetchImpl ?? fetch
  const [error, setError] = useState<string | null>(null)
  /** 点过「去授权」才挂 focus 复查 —— 没点过的人回到窗口时不该白跑一次体检。 */
  const waitingRef = useRef(false)

  const recheck = useCallback(() => {
    // 真跑一次体检:/state 那一格读的是它的结论,下一拍横幅就会自己消失。
    void fetchSetupStatus(baseUrl, doFetch).catch(() => {})
  }, [baseUrl, doFetch])

  useEffect(() => {
    const onFocus = (): void => {
      if (!waitingRef.current) return
      waitingRef.current = false
      recheck()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [recheck])

  const authorize = useCallback(() => {
    setError(null)
    waitingRef.current = true
    void openSetupPane(baseUrl, pane, doFetch).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : '打不开系统设置,请自己去「隐私与安全性」')
    })
  }, [baseUrl, doFetch, pane])

  return { authorize, error }
}
