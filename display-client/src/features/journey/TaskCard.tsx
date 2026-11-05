import { useEffect, useMemo, useState } from 'react';
import { formatFollowUpMessage } from './formatFollowUp.ts';
import { ImageFeedbackInput } from './feedback/ImageFeedbackInput.tsx';
import { LocationFeedbackInput } from './feedback/LocationFeedbackInput.tsx';
import { NfcFeedbackInput } from './feedback/NfcFeedbackInput.tsx';
import { TextFeedbackInput } from './feedback/TextFeedbackInput.tsx';
import { VoiceFeedbackInput } from './feedback/VoiceFeedbackInput.tsx';
import type {
  DimensionSignalEvent,
  FeedbackType,
  TaskFeedbackValue,
  TaskSubmitPayload,
  TaskTemplate,
} from './types.ts';

export type TaskCardProps = {
  task: TaskTemplate;
  slots?: Record<string, string>;
  onSubmit: (payload: TaskSubmitPayload) => Promise<void>;
  onSignal?: (event: DimensionSignalEvent) => void;
};

type CardStatus = 'idle' | 'submitting' | 'completed' | 'failed';

const FEEDBACK_LABELS: Record<FeedbackType, string> = {
  text: '文字',
  image: '图片',
  location: '位置',
  nfc_tag: 'NFC',
  voice: '录音',
};

function makeClientCompletionId(): string {
  return crypto.randomUUID();
}

function getSelectedValue(
  value: TaskFeedbackValue | null,
  type: FeedbackType,
): TaskFeedbackValue | null {
  if (!value) return null;
  return value.kind === type ? value : null;
}

function validateValue(value: TaskFeedbackValue | null, task: TaskTemplate): string | null {
  if (!value) return '请先完成反馈内容';

  switch (value.kind) {
    case 'text': {
      const text = value.text.trim();
      if (!text) return '请输入文字反馈';
      const min = task.evaluation?.text?.minLength ?? 0;
      if (text.length < min) return `至少需要 ${min} 个字符`;
      return null;
    }
    case 'image':
      return value.file ? null : '请选择图片';
    case 'location':
      return Number.isFinite(value.lat) && Number.isFinite(value.lng) ? null : '请获取或输入位置';
    case 'nfc_tag':
      return value.tagId.trim() ? null : '请读取或输入 NFC 标签';
    case 'voice':
      return value.blob.size > 0 ? null : '请录制语音';
    default:
      return '不支持的反馈类型';
  }
}

export function TaskCard({ task, slots = {}, onSubmit, onSignal }: TaskCardProps) {
  const availableTypes = useMemo<FeedbackType[]>(() => {
    if (task.feedbackTypes && task.feedbackTypes.length > 0) return task.feedbackTypes;
    return ['text'];
  }, [task.feedbackTypes]);

  const [selectedType, setSelectedType] = useState<FeedbackType>(availableTypes[0] ?? 'text');
  const [value, setValue] = useState<TaskFeedbackValue | null>(null);
  const [status, setStatus] = useState<CardStatus>('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSelectedType(availableTypes[0] ?? 'text');
    setValue(null);
    setStatus('idle');
    setError(null);
  }, [availableTypes]);

  // 切换反馈类型时清空当前值，避免类型不匹配
  useEffect(() => {
    setValue(null);
    setError(null);
  }, [selectedType]);

  const handleRetry = () => {
    setStatus('idle');
    setError(null);
  };

  const handleSubmit = async () => {
    if (status === 'submitting' || status === 'completed') return;

    const validationError = validateValue(value, task);
    if (validationError) {
      setError(validationError);
      return;
    }

    setError(null);
    setStatus('submitting');

    try {
      await onSubmit({
        taskId: task.id,
        value: value!,
        clientCompletionId: makeClientCompletionId(),
      });
      setStatus('completed');
      onSignal?.({
        type: 'task_completed',
        taskId: task.id,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err ?? '提交失败');
      setStatus('failed');
      setError(reason);
      onSignal?.({
        type: 'task_failed_attempt',
        taskId: task.id,
        reason,
        timestamp: new Date().toISOString(),
      });
    }
  };

  const followUpMessage = useMemo(() => {
    return formatFollowUpMessage(task.onComplete?.followUpMessageTemplate ?? '', slots);
  }, [task.onComplete?.followUpMessageTemplate, slots]);

  const renderInput = () => {
    const disabled = status === 'submitting' || status === 'completed';

    switch (selectedType) {
      case 'text':
        return (
          <TextFeedbackInput
            evaluation={task.evaluation?.text}
            value={(getSelectedValue(value, 'text') as { text: string } | null)?.text ?? ''}
            onChange={(text) => setValue({ kind: 'text', text })}
            disabled={disabled}
          />
        );
      case 'image':
        return (
          <ImageFeedbackInput
            value={getSelectedValue(value, 'image') as Extract<TaskFeedbackValue, { kind: 'image' }> | null}
            onChange={(next) => setValue(next)}
            disabled={disabled}
          />
        );
      case 'location':
        return (
          <LocationFeedbackInput
            evaluation={task.evaluation?.location}
            value={getSelectedValue(value, 'location') as Extract<TaskFeedbackValue, { kind: 'location' }> | null}
            onChange={(next) => setValue(next)}
            disabled={disabled}
          />
        );
      case 'nfc_tag':
        return (
          <NfcFeedbackInput
            evaluation={task.evaluation?.nfcTag}
            value={getSelectedValue(value, 'nfc_tag') as Extract<TaskFeedbackValue, { kind: 'nfc_tag' }> | null}
            onChange={(next) => setValue(next)}
            disabled={disabled}
          />
        );
      case 'voice':
        return (
          <VoiceFeedbackInput
            value={getSelectedValue(value, 'voice') as Extract<TaskFeedbackValue, { kind: 'voice' }> | null}
            onChange={(next) => setValue(next)}
            disabled={disabled}
          />
        );
      default:
        return null;
    }
  };

  return (
    <article className="task-card" aria-label={`任务：${task.name}`}>
      <header className="task-card-header">
        <h3 className="task-card-title">{task.name}</h3>
        <p className="task-card-desc">{task.description}</p>
      </header>

      {status === 'completed' ? (
        <div className="task-card-success">
          <p className="task-card-success-title">任务完成</p>
          {followUpMessage ? (
            <p className="task-card-follow-up">{followUpMessage}</p>
          ) : (
            <p className="task-card-follow-up">{task.onComplete?.followUpMessageTemplate ?? '已收到你的反馈。'}</p>
          )}
        </div>
      ) : (
        <>
          {availableTypes.length > 1 && (
            <div className="task-card-tabs" role="tablist" aria-label="反馈类型">
              {availableTypes.map((type) => (
                <button
                  key={type}
                  type="button"
                  role="tab"
                  aria-selected={selectedType === type}
                  className={`task-card-tab ${selectedType === type ? 'task-card-tab-active' : ''}`}
                  onClick={() => setSelectedType(type)}
                  disabled={status === 'submitting'}
                >
                  {FEEDBACK_LABELS[type]}
                </button>
              ))}
            </div>
          )}

          <div className="task-card-body">{renderInput()}</div>

          {error && <div className="task-card-error">{error}</div>}

          <div className="task-card-actions">
            {status === 'failed' ? (
              <button type="button" className="task-card-retry" onClick={handleRetry}>
                重试
              </button>
            ) : (
              <button
                type="button"
                className="task-card-submit"
                onClick={handleSubmit}
                disabled={status === 'submitting'}
              >
                {status === 'submitting' ? '提交中…' : '提交反馈'}
              </button>
            )}
          </div>
        </>
      )}
    </article>
  );
}
