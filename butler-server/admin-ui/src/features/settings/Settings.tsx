// 来源:Aiboo origin/main 1f430c3f admin-ui/src/features/llm-models/LlmModels.tsx 的 TTS/RTC 两个 Tab
// (Aiboo 的 Settings.tsx 管 DashScope/聊天/ASR/风险词等,本机版一项都不要;
//  供应商密钥在 TtsProviderLibrary / RtcProviderLibrary 里,这里只是把两块摆到一页。)
import { useState } from 'react';
import { TtsProviderLibrary } from '@/features/settings/components/TtsProviderLibrary';
import { RtcProviderLibrary } from '@/features/settings/components/RtcProviderLibrary';

type TabKey = 'tts' | 'rtc';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'tts', label: '语音合成(TTS)' },
  { key: 'rtc', label: '实时通话(RTC)' },
];

export function Settings() {
  const [tab, setTab] = useState<TabKey>('tts');

  return (
    <div>
      <h2>音色与供应商</h2>
      <p className="subtitle">
        密钥只存在这台 Mac 的 butler-server 里(~/.dsh/workbench/butler/),不进仓库、不回显;填过的只显示后 4 位。
        音色本身在「形象 → 编辑 → 配置」里按形象绑定。
      </p>

      <div className="actions" style={{ marginBottom: 16 }}>
        {TABS.map((t) => (
          <button key={t.key} className={`btn ${t.key === tab ? 'btn-primary' : ''}`} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'tts' && <TtsProviderLibrary />}
      {tab === 'rtc' && <RtcProviderLibrary />}
    </div>
  );
}
