/**
 * 量「卡左上角那几个会蹦的小头像」有没有被切(2026-09-25,卡 fix/avatar-headroom)。
 *
 * 台上那三张卡照 `ButlerTaskStage` 真身渲染(与维护者截图里那三张同一套版面),
 * 然后一帧一帧读头像那块画布:画布里最上面那一行有色像素,与它**真正能露出来的上边界**
 * (祖先里所有 overflow 不是 visible 的盒子裁出来的那条线)比 —— 差多少就是被切多少。
 *
 * 参数:`?w=1180&h=430&run=7000`(舞台宽高、量多久)。页尾 report 给数字与祖先链,
 * strip 那一排图把「头顶最高的那 48 帧」并排画出来,红线就是那条裁切线。
 */
import { createRoot } from 'react-dom/client'
import { useEffect, useRef, useState } from 'react'
import { ButlerTaskStage } from '../../src/client/ButlerTaskStage.tsx'
import { BUTLER_LAYOUT_STYLE } from '../../src/client/butlerLayoutStyle.ts'
import { FX_STYLE } from '../../src/client/fx/fxStyle.ts'
import type { SceneItem } from '../../src/client/butlerSceneModel.ts'

const query = new URLSearchParams(location.search)
const W = Number(query.get('w') ?? 1180)
const H = Number(query.get('h') ?? 430)
const RUN_MS = Number(query.get('run') ?? 7000)

const DARK = `
:root{--dsw-alias-bg-layer-1:#17171a;--dsw-alias-bg-layer-2:#1e1e22;--dsw-alias-border-l1:#2a2a30;
--dsw-alias-label-primary:#e9e9ec;--dsw-alias-label-secondary:#a8a8b0;--dsw-alias-label-tertiary:#8a8a92;
--wb-surface-card:#17171a;--wb-surface-soft:#1e1e22;--wb-surface-border:#2a2a30}
.ben-wb__scene-top{width:${W}px;height:${H}px}
.ben-wb__task-stage{min-height:0!important}
`
const style = document.createElement('style')
style.textContent = DARK + BUTLER_LAYOUT_STYLE + FX_STYLE
document.head.appendChild(style)

/** 与 butlerSceneModel 里那几张真卡同形状:一张事务官的事项(codex)+ 两条别家的会话(Claude)。 */
function card(id: string, title: string, label: string, summary: string, minutes: number): SceneItem {
  return {
    id, kind: 'mine', title, dot: 'white', label: '进行中',
    at: new Date(Date.now() - minutes * 60000).toISOString(),
    group: 'working', notice: 'neutral', version: id, unread: false,
    executors: [{
      id: `${id}:e`, label,
      session: { agent: label.split(' / ')[0], session_id: `${id}-s`, status: 'running', elapsed_sec: minutes * 60, summary } as never,
      offline: false,
    }],
    executing: true, pending: false,
  }
}
const items: SceneItem[] = [
  card('c1', '参赛网页架构收尾', 'codex / 01a0d715', '第一条:让 Codex 把参赛网页的架构剩下的补完', 2),
  card('c2', 'Claude 的一条会话', 'claude / d9991aac', '等待下一次进度回传', 9 * 60 + 47),
  card('c3', 'Claude 的一条会话', 'claude / eff17a72', '等待下一次进度回传', 12),
]

function describe(node: Element): string {
  const cls = typeof node.className === 'string' ? node.className.split(' ').filter(Boolean).join('.') : ''
  return `${node.tagName.toLowerCase()}${cls ? `.${cls}` : ''}`
}

/** 真正能露出来的上边界:祖先里每一个 overflow 不是 visible 的盒子,它的上边(含 border)取最靠下的那条。 */
function clipTopOf(element: HTMLElement): number {
  let top = -Infinity
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    const cs = getComputedStyle(node)
    if (cs.overflowY === 'visible' && cs.overflowX === 'visible') continue
    const rect = node.getBoundingClientRect()
    const border = parseFloat(cs.borderTopWidth) || 0
    top = Math.max(top, rect.top + border)
  }
  return top === -Infinity ? -1e9 : top
}

/** 头像那一格往上数:谁在裁、裁在哪儿、那几格各多高 —— 被切的那一刀就出在这一串里。 */
function chainOf(canvas: HTMLCanvasElement): unknown[] {
  const top = canvas.getBoundingClientRect().top
  const out: unknown[] = []
  let node: HTMLElement | null = canvas
  for (let depth = 0; node && depth < 8; node = node.parentElement, depth++) {
    const cs = getComputedStyle(node)
    const rect = node.getBoundingClientRect()
    out.push({
      at: describe(node),
      topFromCanvasTop: Math.round((rect.top - top) * 100) / 100,
      h: Math.round(rect.height * 100) / 100,
      clientH: node.clientHeight,
      scrollH: node.scrollHeight,
      overflow: cs.overflow,
      flex: `${cs.flexGrow} ${cs.flexShrink} ${cs.flexBasis}`,
      clips: cs.overflowY !== 'visible' || cs.overflowX !== 'visible',
    })
  }
  return out
}

/** 这张卡里那三行的实际高度:头像那一行被挤扁了,别的两行就跟着受影响。 */
function rowsOf(canvas: HTMLCanvasElement): unknown[] {
  const button = canvas.closest('button')
  if (!button) return []
  return [...button.children].map((child) => ({
    at: describe(child),
    clientH: (child as HTMLElement).clientHeight,
    scrollH: (child as HTMLElement).scrollHeight,
    text: (child.textContent ?? '').slice(0, 16),
  }))
}

interface Shot { image: ImageData, top: number }

interface Probe {
  agent: string
  canvasTop: number
  canvasCss: string
  bitmap: string
  clipFromCanvasTop: number
  restTop: number
  apexTop: number
  lowestBottom: number
  topRowZero: number
  maxCut: number
  frames: number
  shots: Shot[]
  chain: unknown[]
  rows: unknown[]
}

function Probe() {
  const [report, setReport] = useState('量着呢…')
  const strip = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const started = performance.now()
    const probes: Probe[] = []
    const canvases = [...document.querySelectorAll<HTMLCanvasElement>('.ben-fx__avatar canvas')]
    for (const canvas of canvases) {
      const holder = canvas.closest<HTMLElement>('.ben-fx__avatar')
      const rect = canvas.getBoundingClientRect()
      probes.push({
        agent: holder?.dataset.fxAgent ?? '?',
        canvasTop: rect.top,
        canvasCss: `${canvas.clientWidth}x${canvas.clientHeight}`,
        bitmap: `${canvas.width}x${canvas.height}`,
        clipFromCanvasTop: clipTopOf(canvas) - rect.top,
        restTop: -1,
        apexTop: Infinity,
        lowestBottom: 0,
        topRowZero: 0,
        maxCut: 0,
        frames: 0,
        shots: [],
        chain: chainOf(canvas),
        rows: rowsOf(canvas),
      })
    }
    const tick = (): void => {
      const now = performance.now()
      probes.forEach((probe, index) => {
        const canvas = canvases[index]!
        const rect = canvas.getBoundingClientRect()
        const ctx = canvas.getContext('2d')
        if (!ctx || canvas.width === 0) return
        const shot = ctx.getImageData(0, 0, canvas.width, canvas.height)
        const data = shot.data
        let row = -1, lastRow = -1
        for (let y = 0; y < canvas.height; y++) {
          for (let x = 0; x < canvas.width; x++) {
            if (data[(y * canvas.width + x) * 4 + 3]! > 32) { if (row < 0) row = y; lastRow = y; break }
          }
        }
        probe.frames += 1
        if (row < 0) return
        const perDevice = rect.height / canvas.height
        const top = row * perDevice
        probe.shots.push({ image: shot, top })
        const clip = clipTopOf(canvas) - rect.top
        probe.clipFromCanvasTop = clip
        probe.restTop = Math.max(probe.restTop, top)
        if (row === 0) probe.topRowZero += 1
        probe.lowestBottom = Math.max(probe.lowestBottom, lastRow * perDevice)
        if (top < probe.apexTop) probe.apexTop = top
        probe.maxCut = Math.max(probe.maxCut, clip - top)
      })
      if (now - started < RUN_MS) { requestAnimationFrame(tick); return }
      finish(probes)
    }
    const finish = (probes: Probe[]): void => {
      const round = (v: number) => Math.round(v * 100) / 100
      const target = strip.current
      const column = 26, count = 48
      if (target) {
        target.width = column * count
        target.height = probes.length * (column + 26)
        target.style.width = `${target.width}px`
        const sctx = target.getContext('2d')!
        sctx.fillStyle = '#000'
        sctx.fillRect(0, 0, target.width, target.height)
        probes.forEach((probe, index) => {
          const scale = column / probe.shots[0]!.image.width
          const y0 = index * (column + 26) + 20
          sctx.fillStyle = '#9ad'
          sctx.font = '12px monospace'
          sctx.fillText(`${index} ${probe.agent}:被切 ${round(probe.maxCut)}px / 蹦起 ${round(probe.restTop - probe.apexTop)}px`, 4, y0 - 6)
          const apex = [...probe.shots].sort((a, b) => a.top - b.top).slice(0, count)
          apex.forEach((shot, n) => {
            const tmp = document.createElement('canvas')
            tmp.width = shot.image.width; tmp.height = shot.image.height
            tmp.getContext('2d')!.putImageData(shot.image, 0, 0)
            sctx.imageSmoothingEnabled = false
            sctx.drawImage(tmp, n * column, y0, column, column)
          })
          sctx.strokeStyle = 'rgba(255,80,80,.95)'
          sctx.beginPath()
          sctx.moveTo(0, y0 + probe.clipFromCanvasTop * scale)
          sctx.lineTo(target.width, y0 + probe.clipFromCanvasTop * scale)
          sctx.stroke()
          sctx.strokeStyle = 'rgba(80,255,140,.8)'
          sctx.setLineDash([3, 3])
          sctx.beginPath()
          sctx.moveTo(0, y0); sctx.lineTo(target.width, y0); sctx.stroke()
          sctx.setLineDash([])
        })
      }
      const rows = probes.map((probe, index) => ({
        i: index, agent: probe.agent, canvasCss: probe.canvasCss, bitmap: probe.bitmap,
        clipFromCanvasTop: round(probe.clipFromCanvasTop),
        restTopFromCanvasTop: round(probe.restTop),
        apexTopFromCanvasTop: round(probe.apexTop),
        lowestBottomFromCanvasTop: round(probe.lowestBottom),
        framesTouchingCanvasTop: probe.topRowZero,
        rise: round(probe.restTop - probe.apexTop),
        maxCutPx: round(probe.maxCut),
        frames: probe.frames,
        chain: probe.chain,
        rows: probe.rows,
      }))
      setReport(JSON.stringify(rows, null, 1))
      document.title = 'done'
      Object.assign(window, { __report: rows })
    }
    requestAnimationFrame(tick)
  }, [])
  return <>
    <pre id="report">{report}</pre>
    <canvas id="strip" ref={strip} />
  </>
}

const probeOn = Number(query.get('run') ?? 7000) > 0
createRoot(document.getElementById('root')!).render(<>
  <div className="ben-wb__scene-top">
    <ButlerTaskStage items={items} now={new Date().toISOString()} focus={null} onChoose={() => {}} visible />
  </div>
  {probeOn && <Probe />}
</>)
