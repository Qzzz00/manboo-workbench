/**
 * 量耗电的试验页(2026-09-25,卡 fix/evening-gaps 第 6 条)。只挂一样或几样动效,别的什么都没有:
 *   ?scene=blank | idle(待命的球)| working(执行中的环)| beam(当前卡沿边走的光)| pulse(待确认的呼吸光)
 *          | composer(输入框底边的光)| all(执行中 + 当前卡的光 + 呼吸光)| idle-all(待命 + 呼吸光 + 不亮的输入框光)
 *   &active=1  假装有人在用这扇窗(每 3 秒一个 focus + pointermove);不带 = 这扇窗本来的样子
 *              (webhost 那扇点不中的窗不在前台 → restMode 判「歇着」)
 * 页面还数 2D 画布每秒调了几次 fillRect / stroke / clearRect(与引擎无关的开销量,Chrome 那一路读它)。
 */
import { createRoot } from 'react-dom/client'
import { ParticleOrb } from '../../src/client/ParticleOrb.tsx'
import { FxBeam } from '../../src/client/fx/Fx.tsx'
import { BEAM } from '../../src/client/fx/fxModel.ts'
import { FX_STYLE } from '../../src/client/fx/fxStyle.ts'
import { TUNING_DEFAULTS } from '../../src/client/swarm/core.js'

const counts: Record<string, number> = {}
for (const name of ['fillRect', 'drawImage', 'stroke', 'clearRect']) {
  const proto = CanvasRenderingContext2D.prototype as unknown as Record<string, (...args: unknown[]) => unknown>
  const original = proto[name] as (...args: unknown[]) => unknown
  proto[name] = function (this: unknown, ...args: unknown[]) { counts[name] = (counts[name] ?? 0) + 1; return original.apply(this, args) }
}
let frames = 0
const tick = (): void => { frames += 1; requestAnimationFrame(tick) }
requestAnimationFrame(tick)
Object.assign(window, { __counts: counts, __frames: () => frames })

const query = new URLSearchParams(location.search)
if (query.get('active') === '1') {
  const poke = (): void => { window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('pointermove')) }
  poke()
  setInterval(poke, 3000)
}
const style = document.createElement('style')
style.textContent = FX_STYLE
document.head.appendChild(style)

// 维护者真在用的那一份外观(GET /butler/appearance,09-24):3600 颗、柔光关 —— 与核心的缺省一致。
const settings = TUNING_DEFAULTS as never
const orb = (mode: 'idle' | 'working') => <div className="orb"><ParticleOrb mode={mode} notice="idle" visible settings={settings} large /></div>
const card = (spec: (typeof BEAM)[keyof typeof BEAM], active = true) => <div style={{ marginTop: 24 }}><FxBeam name="probe" spec={spec} active={active}><div className="card">事项卡</div></FxBeam></div>
const scenes: Record<string, () => JSX.Element> = {
  blank: () => <div>blank</div>,
  idle: () => orb('idle'),
  working: () => orb('working'),
  beam: () => card(BEAM.currentCard),
  pulse: () => card(BEAM.confirm),
  composer: () => card(BEAM.composer),
  all: () => <>{orb('working')}{card(BEAM.currentCard)}{card(BEAM.confirm)}</>,
  'idle-all': () => <>{orb('idle')}{card(BEAM.confirm)}{card(BEAM.composer, false)}</>,
}
const scene = query.get('scene') ?? 'blank'
createRoot(document.getElementById('root')!).render((scenes[scene] ?? scenes.blank)!())
document.title = `fx power: ${scene}`
