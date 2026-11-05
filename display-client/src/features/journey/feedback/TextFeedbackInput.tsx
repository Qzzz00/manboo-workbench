import { useState } from 'react';
import type { TaskEvaluation } from '../types.ts';

type TextFeedbackInputProps = {
  evaluation?: TaskEvaluation['text'];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
};

export function TextFeedbackInput({
  evaluation,
  value,
  onChange,
  disabled,
}: TextFeedbackInputProps) {
  const [touched, setTouched] = useState(false);
  const minLength = evaluation?.minLength ?? 0;
  const tooShort = value.trim().length > 0 && value.trim().length < minLength;
  const showError = touched && tooShort;

  return (
    <label className="task-field">
      <span>文字反馈</span>
      <textarea
        className={`task-textarea ${showError ? 'task-input-error' : ''}`}
        rows={4}
        placeholder="写下你想说的话…"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onBlur={() => setTouched(true)}
        disabled={disabled}
        aria-invalid={showError}
      />
      {showError && (
        <span className="task-input-error-text" role="alert">
          至少需要 {minLength} 个字符
        </span>
      )}
    </label>
  );
}
