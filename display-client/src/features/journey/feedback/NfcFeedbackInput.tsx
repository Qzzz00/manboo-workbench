import { useState } from 'react';
import { useNfcReader } from '../../../hooks/useNfcReader.ts';
import type { NfcFeedbackValue, TaskEvaluation } from '../types.ts';

type NfcFeedbackInputProps = {
  evaluation?: TaskEvaluation['nfcTag'];
  value: NfcFeedbackValue | null;
  onChange: (value: NfcFeedbackValue | null) => void;
  disabled?: boolean;
};

export function NfcFeedbackInput({
  evaluation,
  value,
  onChange,
  disabled,
}: NfcFeedbackInputProps) {
  const { state: nfc, read, stop } = useNfcReader();
  const [manualTagId, setManualTagId] = useState('');

  const expectedTagId = evaluation?.expectedTagId;
  const showMismatch = value && expectedTagId && value.tagId !== expectedTagId;

  return (
    <div className="task-field">
      <span>NFC 反馈</span>

      {value && (
        <div className="task-nfc-result">
          读取标签：{value.tagId}
          {showMismatch && (
            <span className="task-input-error-text">与预期标签 {expectedTagId} 不一致</span>
          )}
        </div>
      )}

      {nfc.status === 'scanning' && <span className="task-hint">请将设备靠近 NFC 标签…</span>}
      {nfc.status === 'error' && <span className="task-input-error-text">{nfc.message}</span>}

      <div className="task-nfc-actions">
        <button
          type="button"
          className="task-media-button"
          onClick={read}
          disabled={disabled || nfc.status === 'scanning'}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20">
            <path d="M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2z" />
            <path d="M7 11v2" />
            <path d="M11 9v6" />
            <path d="M15 11v2" />
          </svg>
          {nfc.status === 'scanning' ? '读取中…' : '读取 NFC 标签'}
        </button>
        {nfc.status === 'scanning' && (
          <button type="button" className="task-secondary-button" onClick={stop} disabled={disabled}>
            取消
          </button>
        )}
        {value && (
          <button
            type="button"
            className="task-secondary-button"
            onClick={() => onChange(null)}
            disabled={disabled}
          >
            清除
          </button>
        )}
      </div>

      {(nfc.status === 'error' || nfc.status === 'idle') && (
        <div className="task-manual-fallback">
          <span className="task-hint">或手动输入标签 ID</span>
          <div className="task-manual-nfc">
            <input
              type="text"
              placeholder="标签 ID"
              value={manualTagId}
              onChange={(event) => setManualTagId(event.target.value)}
              disabled={disabled}
            />
            <button
              type="button"
              className="task-secondary-button"
              onClick={() => {
                if (manualTagId.trim()) {
                  onChange({ kind: 'nfc_tag', tagId: manualTagId.trim() });
                }
              }}
              disabled={disabled}
            >
              使用
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
