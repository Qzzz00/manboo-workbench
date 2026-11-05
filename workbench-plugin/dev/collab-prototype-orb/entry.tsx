// 协作区原型用的真粒子球(2026-10-27):把产品的 ParticleOrb 原样打成一个独立脚本,给 docs/assets/collab-wireframe-1027 用。
// 不进构建、不进测试;只挂组件,形态与提示色由原型那一格示例状态传进来。
import { createRoot, type Root } from 'react-dom/client'
import { ParticleOrb, type ParticleMode } from '../../src/client/ParticleOrb.tsx'
import type { ParticleNotice } from '../../src/client/butlerSceneModel.ts'
import { PARTICLE_STYLE } from '../../src/client/particleStyle.ts'
import { getParticleSettingsStore, useParticleSettings } from '../../src/client/particleSettingsStore.ts'

interface OrbProps { mode: ParticleMode, notice: ParticleNotice, label?: string, large?: boolean }

function Orb(props: OrbProps) {
  const settings = useParticleSettings(getParticleSettingsStore())
  return (
    <>
      <style>{PARTICLE_STYLE}</style>
      <ParticleOrb mode={props.mode} notice={props.notice} visible settings={settings.preset.settings} paused={settings.paused} {...(props.label === undefined ? {} : { label: props.label })} {...(props.large ? { large: true } : {})} />
    </>
  )
}

const roots = new WeakMap<Element, Root>()
;(window as unknown as { ProductOrb: unknown }).ProductOrb = {
  render(el: Element, props: OrbProps) {
    let root = roots.get(el)
    if (root === undefined) { root = createRoot(el); roots.set(el, root) }
    root.render(<Orb {...props} />)
  },
}
