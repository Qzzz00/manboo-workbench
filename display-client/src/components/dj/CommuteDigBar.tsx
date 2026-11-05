import { useCallback, useRef, useState } from 'react';
import type { DjModeView } from '../../hooks/useDjMode';

// 浏览器原生语音识别（Web Speech API）。Capacitor WebView 支持情况不一 → 不可用时降级为纯文字。
type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
};
function getRecognitionCtor(): (new () => SpeechRecognitionLike) | null {
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/**
 * 通勤深挖输入条：文字提问（可靠）+ 语音提问（Web Speech API，可用则优先）。
 * 提交 → view.dj.controls.dig(topic)：抬升音乐 → 生成插播口播 → 播完恢复常规口播。
 */
export function CommuteDigBar({ view }: { view: DjModeView }) {
  const [topic, setTopic] = useState('');
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const voiceSupported = getRecognitionCtor() != null;

  const submit = useCallback(
    async (text: string) => {
      const t = text.trim();
      if (t.length < 2 || busy) return;
      setBusy(true);
      try {
        await view.dj.controls.dig(t);
        setTopic('');
      } finally {
        setBusy(false);
      }
    },
    [busy, view.dj.controls],
  );

  const toggleVoice = useCallback(() => {
    if (listening) {
      recRef.current?.stop();
      return;
    }
    const Ctor = getRecognitionCtor();
    if (!Ctor) return;
    const rec = new Ctor();
    recRef.current = rec;
    rec.lang = 'zh-CN';
    rec.continuous = false;
    rec.interimResults = false;
    rec.onresult = (e) => {
      const said = e.results?.[0]?.[0]?.transcript ?? '';
      if (said) {
        setTopic(said);
        void submit(said); // 识别完直接深挖
      }
    };
    rec.onerror = () => setListening(false);
    rec.onend = () => setListening(false);
    setListening(true);
    try {
      rec.start();
    } catch {
      setListening(false);
    }
  }, [listening, submit]);

  return (
    <div className="dj-dig-bar">
      <input
        type="text"
        value={topic}
        disabled={busy}
        placeholder={busy ? '主播正在深挖…' : '想深入聊聊哪个话题？'}
        onChange={(e) => setTopic(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void submit(topic);
        }}
        className="dj-dig-input"
      />
      {voiceSupported && (
        <button
          type="button"
          onClick={toggleVoice}
          disabled={busy}
          className={`dj-dig-mic${listening ? ' dj-dig-mic--on' : ''}`}
          aria-label={listening ? '停止说话' : '语音提问'}
          title={listening ? '停止说话' : '按住说出你想深挖的话题'}
        >
          {listening ? '● 聆听中' : '🎤'}
        </button>
      )}
      <button
        type="button"
        onClick={() => void submit(topic)}
        disabled={busy || topic.trim().length < 2}
        className="dj-dig-send"
      >
        {busy ? '深挖中…' : '深挖'}
      </button>
    </div>
  );
}
