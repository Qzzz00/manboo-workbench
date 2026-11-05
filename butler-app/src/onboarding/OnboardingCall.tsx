/** 手机保留旧引导入口，但首次配置统一在电脑继续，不自动拨号或重置进度。 */
import type { OnboardingApi } from './onboardingApi';
import type { CallClient } from '../call/rtcCall';
import { useBackHandler } from '../nav/back';
import { ParticleStage } from '../swarm/ParticleStage';
import { defaultPreset } from '../swarm/appearance';

export interface OnboardingCallProps {
  onClose(): void;
  api?: OnboardingApi;
  createCallClient?: () => CallClient;
}

export const DESKTOP_ONBOARDING_NOTE = '首次引导请在电脑上继续。打开电脑上的工作台，接着完成认识你和第一次有用；手机与座机可以最后再配。';

export function OnboardingCall(props: OnboardingCallProps) {
  useBackHandler(true, props.onClose);
  return (
    <div className="ba-chat ba-onboarding" data-ba-kb-page="onboarding">
      <div className="ba-chat__stage">
        <ParticleStage mode="idle" settings={defaultPreset().settings} scene="onboarding" />
      </div>
      <div className="ba-chat__thread">
        <p className="ba-onboard__note">{DESKTOP_ONBOARDING_NOTE}</p>
        <button type="button" className="ba-btn" onClick={props.onClose}>回主页</button>
      </div>
    </div>
  );
}
