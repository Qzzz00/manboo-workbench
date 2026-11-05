import { useEffect, useMemo, useRef, useState } from 'react'
import { Orb } from './Orb.tsx'
import { FrameProfiler, ParticleLoop, QualityGovernor, cloudScaleFor, coreNoticeOf, orbFrameRate, particleHostVisible, sceneSettings, type ParticleSceneKind } from './particleScene.ts'
import { BuiltinGlyphCache, SwarmRenderer, SwarmV4, type Glyph, type Tuning } from './swarm/core.js'
import type { ParticleNotice } from './butlerSceneModel.ts'
import { afterHandoffLaunch, handoffLaunching } from './brand/blackhole.js'
import { getParticleSettingsStore, useParticleSettings, type ParticleSettingsStore } from './particleSettingsStore.ts'
import { useRestMode } from './restMode.ts'

export type ParticleMode = 'idle' | 'listening' | 'acknowledging' | 'working' | 'speaking' | 'calling'
export interface ParticlePreview { mode: ParticleMode | 'custom' | 'builtin'; glyph?: Glyph; notice?: ParticleNotice; label: string }
export interface ParticleOrbProps {
  mode: ParticleMode
  notice: ParticleNotice
  visible: boolean
  settings: Tuning
  paused?: boolean
  preview?: ParticlePreview | undefined
  onClick?: (() => void) | undefined
  large?: boolean
  /** Quality tier and performance mode live in the shared settings store; tests inject their own. */
  store?: ParticleSettingsStore
  /** 在哪儿露面(2026-09-23):`onboarding` 关中心光团,见 particleScene.ts sceneSettings。缺省 workbench,原样。 */
  scene?: ParticleSceneKind
  /** 读屏名的后半句;缺省按 mode 取(引导里「在想」借 listening 的动作,名字要说真话)。 */
  label?: string
}
/**
 * 待命那一档一帧多少毫秒(2026-09-25 从 30 帧降到 20 帧,卡 fix/evening-gaps 第 6 条)。
 * 各档帧数统一在 particleScene.ts 的 {@link orbFrameRate}:待命 20、执行中 30、其余 60;歇着时再降。
 */
export const IDLE_FRAME_BUDGET = 1000 / 20
/** 降档那一下在球旁边淡淡闪一句,几秒后自己走(2026-09-18:球突然变稀,人不该只能靠猜)。 */
export const BUSY_HINT = '机器忙,先省着画'
export const BUSY_HINT_MS = 4000
const LABELS: Record<ParticleMode, string> = { idle: '待命', listening: '文字输入中', acknowledging: '事项已建下', working: '执行中', speaking: '说话动效预览', calling: '电话动效预览' }

export function ParticleOrb(props: ParticleOrbProps) {
  const canvas = useRef<HTMLCanvasElement>(null), [failed, setFailed] = useState(false), [busy, setBusy] = useState(false)
  const store = props.store ?? getParticleSettingsStore()
  const quality = useParticleSettings(store).quality
  // 没人在用这扇窗(切走了、藏起来了、两分钟没动静):降帧。见 restMode.ts。
  const resting = useRestMode()
  // The renderer receives the user's settings with the current tier applied; the props/preset stay untouched.
  const tiered = quality.tier > 0 ? store.effectiveSettings() : props.settings
  // 场景覆盖放在画质之后:降档换了一份设置,也照样关得掉光团。useMemo 保住引用,免得每拍都 configure。
  /**
   * 「执行中」交核心原版的 working 形(莫比乌斯环)。2026-09-23 一度换成「待命形 + 转快」(嫌它像一条长方形横带),
   * 维护者 09-24 傍晚澄清:「我当时的讲法,只是不要中间的光团……就用莫比乌斯环,但是没有光团的版本」——
   * 于是恢复 working 形,中心光团照关(sceneSettings 在所有场景都把 cloudSize 压成 0)。
   */
  const effective = useMemo(() => sceneSettings(tiered, props.scene), [tiered, props.scene])
  const current = useRef({ ...props, effective, quality, resting }); current.current = { ...props, effective, quality, resting }
  const refresh = useRef<(() => void) | null>(null)
  /**
   * 登录 → 粒子球的串联起步那 0.6 秒里不初始化渲染器(2026-09-24 去卡顿):造 SwarmRenderer + 光团在慢机器上
   * 要几十毫秒,原来正好和串联的头几帧挤在一起。画布照常挂着(串联靠它的位置找终点),只是晚一点开画;
   * 球在成形段(1.56 秒)才淡入,这之前早就画上了。不在串联里:当场就画,与以前一样。
   */
  const [armed, setArmed] = useState(() => !handoffLaunching())
  useEffect(() => armed ? undefined : afterHandoffLaunch(() => setArmed(true)), [armed])
  useEffect(() => {
    if (!armed) return
    const element = canvas.current
    // jsdom and older hosts lack CanvasRenderingContext2D; avoid their throwing getContext stub.
    if (!element || typeof CanvasRenderingContext2D === 'undefined') { setFailed(true); return }
    let renderer: SwarmRenderer | undefined, loop: ParticleLoop | undefined
    let dead = false, version = 0, intersecting = true
    const cleanups: (() => void)[] = []
    try {
      if (!element.getContext('2d')) throw new Error('Canvas unavailable')
      const swarm = new SwarmV4(current.current.effective.count)
      renderer = new SwarmRenderer(element, swarm)
      const painter = renderer, cache = new BuiltinGlyphCache()
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
      let lastMode = '', lastColor = '', lastSettings: Tuning | undefined, lastPreview: ParticlePreview | undefined, lastTier = -1
      const governor = new QualityGovernor()
      // `?profile=1` 采样(同 0914 原型的取证方法):rAF 间隔、回调耗时、>50ms 长帧,写到 data-profile 并打印。
      const profiler = /[?&]profile=1(?:&|$)/.test(location.search) ? new FrameProfiler(report => { element.dataset.profile = JSON.stringify(report); console.info('[粒子采样]', JSON.stringify({ ...report, tier: governor.tier, canvas: `${element.width}x${element.height}`, dpr: painter.dpr })) }) : undefined
      loop = new ParticleLoop((dt, snap) => {
        try { swarm.step(dt, snap); painter.paint(dt, snap) }
        catch { loop?.dispose(); if (!dead) setFailed(true) }
      }, undefined, undefined, (at, cost) => {
        profiler?.record(at, cost)
        const tier = governor.record(at)
        if (tier !== undefined && !dead) store.reportTier(tier)
      })
      const update = () => {
        if (dead) return
        const p = current.current, preview = p.preview
        const mode = preview?.mode ?? p.mode
        const notice = mode === 'calling' ? (preview?.notice === 'failed' ? 'failed' : 'confirmation') : preview?.notice ?? p.notice
        const ink = (getComputedStyle(element).color.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number)
        const scale = Math.max(...ink) > 1 ? 255 : 1
        const theme = ink.length === 3 && (ink[0]! * .2126 + ink[1]! * .7152 + ink[2]! * .0722) / scale < .5 ? 'light' : 'dark'
        if (p.quality.tier !== lastTier) {
          // Store owns the tier (shared by the normal and pure orbs); the governor mirrors it and never steps back up by itself.
          if (p.quality.performanceMode) governor.lock(p.quality.tier); else if (p.quality.tier < lastTier || lastTier < 0) governor.reset(p.quality.tier); else governor.tier = p.quality.tier
          painter.cloudScale = cloudScaleFor(p.quality.tier); lastTier = p.quality.tier
          element.dataset.quality = String(p.quality.tier)
        }
        if (p.effective !== lastSettings) { swarm.configure(p.effective); lastSettings = p.effective }
        // 「办完了、还没看」不再染蓝(2026-09-25,维护者:「球是蓝的」;09-24 全局去蓝):见 particleScene.coreNoticeOf。
        const coreNotice = coreNoticeOf(notice)
        if (`${theme}:${coreNotice}` !== lastColor) { painter.setColor(theme, coreNotice); lastColor = `${theme}:${coreNotice}` }
        if (mode !== lastMode || preview !== lastPreview) {
          const thisVersion = ++version
          if (preview?.glyph) swarm.glyphs[mode === 'calling' ? 'phone' : mode] = preview.glyph
          swarm.setMode(mode); lastMode = mode; lastPreview = preview
          const icon = !preview?.glyph && mode === 'calling' ? 'phone' : mode === 'acknowledging' ? 'mood-smile' : undefined
          if (icon) void cache.get(icon).then(result => {
            if (dead || version !== thisVersion) return
            swarm.glyphs[mode === 'calling' ? 'phone' : 'smile'] = result.glyph
            if (mode === 'calling') swarm.activeIcon = result.glyph
            if (current.current.visible && !document.hidden && particleHostVisible(element) && (reduced.matches || current.current.paused)) { swarm.step(0, true); painter.paint(0, true) }
          }).catch(() => { /* geometry unavailable: keep the particle sphere */ })
        }
        const active = p.visible && !document.hidden && intersecting && particleHostVisible(element)
        if (active && mode === 'calling') painter.paint(0, true)
        const running = active && !p.paused && !reduced.matches
        element.dataset.running = String(running)
        // 帧数:待命 20、执行中 30、其余(聆听 / 说话 / 电话 / 预览)60;歇着时再降(particleScene.orbFrameRate)。
        const fps = orbFrameRate(mode, preview !== undefined, p.resting)
        element.dataset.frameRate = String(fps)
        element.dataset.resting = String(p.resting)
        loop?.setBudget(fps >= 60 ? 0 : 1000 / fps)
        if (!running) governor.pause()
        loop?.update(active, reduced.matches || p.paused === true)
      }
      refresh.current = update
      const resize = () => { if (dead) return; painter.resize(); update() }
      if (typeof ResizeObserver !== 'undefined') { const observer = new ResizeObserver(resize); observer.observe(element); cleanups.push(() => observer.disconnect()) }
      if (typeof IntersectionObserver !== 'undefined') { const observer = new IntersectionObserver(entries => { intersecting = entries[0]?.isIntersecting ?? true; update() }); observer.observe(element); cleanups.push(() => observer.disconnect()) }
      const mutations = new MutationObserver(update)
      for (let node: HTMLElement | null = element.parentElement; node; node = node.parentElement) mutations.observe(node, { attributes: true, attributeFilter: ['style', 'class', 'hidden', 'data-theme'] })
      cleanups.push(() => mutations.disconnect())
      document.addEventListener('visibilitychange', update); cleanups.push(() => document.removeEventListener('visibilitychange', update))
      reduced.addEventListener('change', update); cleanups.push(() => reduced.removeEventListener('change', update))
      update()
    } catch { setFailed(true) }
    return () => {
      dead = true; version++; refresh.current = null; loop?.dispose()
      cleanups.forEach(clean => clean())
      // Release the detached cloud's GPU context; its event listener remains local to that canvas.
      renderer?.cloud.gl?.getExtension('WEBGL_lose_context')?.loseContext()
    }
  }, [armed])
  useEffect(() => { refresh.current?.() }, [props.mode, props.notice, props.visible, props.paused, props.settings, props.preview, effective, quality, resting])
  // 只有「自动降档」这一下吭声:升回、手动性能模式、按钮恢复都不吭声。
  const lastTier = useRef(quality.tier)
  useEffect(() => {
    const previous = lastTier.current; lastTier.current = quality.tier
    if (quality.performanceMode || quality.tier <= previous) return
    setBusy(true)
    const timer = setTimeout(() => setBusy(false), BUSY_HINT_MS)
    return () => clearTimeout(timer)
  }, [quality.tier, quality.performanceMode])
  const notice = props.preview?.mode === 'calling' ? (props.preview.notice === 'failed' ? 'failed' : 'confirmation') : props.preview?.notice ?? props.notice
  const fallback = notice === 'confirmation' ? 'needs-you' : props.mode === 'working' ? 'busy' : props.mode === 'listening' ? 'listening' : 'idle'
  const label = `事务官:${props.label ?? LABELS[props.mode]}`
  return <div className="ben-wb__particle-orb" data-large={props.large === true} data-notice={notice}>
    {failed ? <Orb state={fallback} amber={notice === 'confirmation'} size={props.large ? 'large' : 'normal'} {...(props.onClick ? { onClick: props.onClick } : {})} /> : <>
      <canvas ref={canvas} aria-hidden="true" />
      {props.onClick ? <button type="button" className="ben-wb__particle-hit" aria-label={`${label}(点一下展开)`} onClick={props.onClick} /> : <span className="ben-wb__particle-a11y" role="img" aria-label={label} />}
    </>}
    {busy && <p className="ben-wb__particle-busy" role="status">{BUSY_HINT}</p>}
  </div>
}
