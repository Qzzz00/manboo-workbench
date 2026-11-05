/**
 * 设置弹窗里的「事务官 · 形象与音色」一节(2026-09-11)。
 *
 * 形象与音色的配置后台是 butler-server 自己托管的一整套页面(搬自 Aiboo admin-ui),
 * 不往工作台里再画一遍——这里只放三样:它在不在跑、一个「打开配置后台」、启停。
 * 入口统一在设置(设计-事务官形态 §7.2),不暴露第二个入口。
 *
 * 数字纪律(D13):/state.butler 里没给 avatarCount/voiceCount 就整句不显示,不写 0。
 * 服务端拒绝的话原样转达(「launchd 里没有 …」),不自己编一句。
 *
 * 形象靠上传(2026-10-21 维护者定:仓库与安装包里不带任何 Live2D 模型):配置后台「形象」里传 zip、点发布,
 * 手机下载后横竖屏与展示台才选得到;一个都没有时明说「先用粒子球」,不让人对着粒子球猜形象去哪了。
 */
import { useState } from 'react'
import { CONFIRMS, ConfirmDialog } from './ui/index.tsx'
import type { ButlerView } from '../protocol.ts'
import { SetActions, SetBtn, SetFold, SetMsg, SetRow, SetSection } from './settings/setKit.tsx'

export function ButlerPanel({ baseUrl, fetchImpl, butler }: {
  baseUrl: string
  fetchImpl?: typeof fetch
  butler: ButlerView
}) {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  /** 「停止服务」先问一句(共用确认弹层,10-22 统筹定 28)。 */
  const [asking, setAsking] = useState(false)
  const adminUrl = `http://127.0.0.1:${butler.port}/admin/`

  async function act(action: 'start' | 'stop' | 'open', okText: string): Promise<void> {
    setBusy(true)
    setMessage(null)
    try {
      const res = await (fetchImpl ?? fetch)(`${baseUrl}/butler/${action}`, { method: 'POST' })
      const body = await res.json() as { ok?: boolean, error?: string }
      setMessage(res.ok && body.ok === true ? okText : (body.error ?? '操作失败'))
    }
    catch (error) {
      setMessage(error instanceof Error ? error.message : '操作失败')
    }
    finally {
      setBusy(false)
    }
  }

  const counts = butler.avatarCount === undefined && butler.voiceCount === undefined
    ? null
    : [
        ...(butler.avatarCount === undefined ? [] : [`形象 ${butler.avatarCount} 个`]),
        ...(butler.voiceCount === undefined ? [] : [`音色绑定 ${butler.voiceCount} 条`]),
      ].join(' · ')

  // 评审页 `section('voice', '形象与音色', …)`:一行「服务运行中 / 形象与音色仍在独立配置页管理。」+ 描边「打开配置 ↗」,
  // 底下文字「停止服务」。怎么上传形象、直接在浏览器里开那一页,收进「怎么换形象」折叠。
  return (
    <SetSection id="ben-wb-butler" title="形象与音色">
      <SetRow
        title={butler.running ? '服务运行中' : '服务没在跑'}
        sub={`${butler.running ? '形象与音色仍在独立配置页管理。' : '形象与音色这一套这会儿没起来 —— 起来之后才改得了。'}${counts === null ? '' : `现在有${counts}。`}`}
      >
        <SetBtn kind="outline" disabled={busy || !butler.running} onClick={() => { void act('open', '已在浏览器里打开') }}>打开配置 ↗</SetBtn>
      </SetRow>
      {butler.running && butler.avatarCount === 0 && <SetMsg>还没有形象:手机和展示台先用粒子球。</SetMsg>}
      <SetActions>
        {butler.running
          ? <SetBtn kind="text" disabled={busy} onClick={() => setAsking(true)}>停止服务</SetBtn>
          : <SetBtn kind="text" disabled={busy} onClick={() => { void act('start', '已发送启动,几秒后状态会变') }}>启动服务</SetBtn>}
      </SetActions>
      <SetFold summary="怎么换形象">
        <p>
          形象靠上传:在配置后台「形象」里上传 Live2D 形象包(zip),点「发布」之后手机上就能下载、换上;音色也在那一页挑;
          <a href={adminUrl} target="_blank" rel="noreferrer">也可以自己在浏览器里打开那一页</a>
          。
        </p>
      </SetFold>
      {message !== null && <SetMsg>{message}</SetMsg>}
      {asking && (
        <ConfirmDialog
          {...CONFIRMS.stopService}
          body="停下之后配置后台打不开,改不了形象与音色;点「启动服务」再起来。"
          busy={busy}
          onCancel={() => setAsking(false)}
          onConfirm={() => { setAsking(false); void act('stop', '已发送停止') }}
        />
      )}
    </SetSection>
  )
}
