/**
 * 登录屏与首次流程共用的那颗粒子球(2026-09-23 抽出来:维护者「桌面端也很丑...不需要弹窗」,
 * 登录页也要「粒子球在上方」,与引导同一片背景、同一个位置)。
 *
 * 引导场景关中心光团(particleScene.ts sceneSettings)。「在找你的项目」那一整段交核心原版的 working 形
 * (莫比乌斯环;2026-09-24 傍晚维护者澄清 09-23 那次只是不要中间的光团,不是不要这一形)。
 * 用户在外观里调过的那 24 项照样生效(同一份 settings store)。
 * `data-mode` 是交给核心的那一态,给样式与用例认(jsdom 里画不了 canvas)。
 */
import { ParticleOrb } from '../ParticleOrb.tsx'
import { getParticleSettingsStore, useParticleSettings } from '../particleSettingsStore.ts'
import type { StageView } from './onboardingStage.ts'

export function OnboardingOrb({ stage }: { stage: Pick<StageView, 'cue' | 'mode' | 'notice' | 'label'> }) {
  const settings = useParticleSettings(getParticleSettingsStore())
  return (
    <div className="ben-wb__onb-orb" data-scene="onboarding" data-mode={stage.mode}>
      <ParticleOrb
        mode={stage.mode}
        notice={stage.notice}
        visible
        settings={settings.preset.settings}
        paused={settings.paused}
        scene="onboarding"
        label={stage.label}
        large
      />
    </div>
  )
}
