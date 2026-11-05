import { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, CameraResultType, CameraSource } from '@capacitor/camera';
import { Capacitor } from '@capacitor/core';
import type { JourneyTask, JourneyTaskOption, TaskFeedback } from '../types/journey.ts';
import { useVoiceRecorder } from '../hooks/useVoiceRecorder.ts';
import { useCrisisResources } from '../hooks/useCrisisResources.ts';
import { FEEDBACK_MESSAGES } from '../lib/journeyTaskFeedback.ts';
import { CrisisResourceReminder } from './CrisisResourceReminder.tsx';

interface JourneyTaskCardProps {
  task: JourneyTask;
  // 返回 Promise 时，卡片会等待提交结果：成功才切换到完成态，失败则保留卡片并展示错误（可重试）。
  onComplete: (feedback: TaskFeedback) => void | Promise<void>;
  onRetry?: () => void;
}

// 任务模板的 options 可能是字符串或 {id,label}，统一成 {id,label}。
function normalizeOptions(options?: Array<JourneyTaskOption | string>): JourneyTaskOption[] {
  if (!Array.isArray(options)) return [];
  return options.map((o) => (typeof o === 'string' ? { id: o, label: o } : { id: o.id, label: o.label ?? o.id }));
}

export function formatElapsed(ms: number) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${rem.toString().padStart(2, '0')}`;
}

/**
 * 调用 Capacitor Camera（原生：拍照/选图；Web：降级为 <input type="file">）。
 * 返回图片的 data URL 或 blob URL，作为任务 value 上传。
 */
async function pickImage(): Promise<string | null> {
  if (!Capacitor.isNativePlatform()) {
    return null;
  }
  const photo = await Camera.getPhoto({
    source: CameraSource.Prompt,
    resultType: CameraResultType.DataUrl,
    quality: 85,
    allowEditing: false,
    correctOrientation: true,
  });
  return photo.dataUrl ?? null;
}

/**
 * 读取浏览器地理位置（原生 Capacitor Geolocation 插件未安装，先用浏览器 API）。
 * 返回 "lat,lng" 字符串作为任务 value。
 */
function getCurrentPosition(): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('浏览器不支持地理位置'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const { latitude, longitude } = position.coords;
        resolve(`${latitude.toFixed(6)},${longitude.toFixed(6)}`);
      },
      (error) => {
        reject(new Error(error.message || '无法获取位置'));
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 },
    );
  });
}

interface NDEFReaderInstance {
  scan(): Promise<void>;
  addEventListener(type: 'reading' | 'error', listener: (event: Event) => void, options?: AddEventListenerOptions): void;
}

type NDEFReadingEventLike = Event & { serialNumber?: string };

/**
 * Web NFC 读取。返回 tag 序列号字符串，或 null（不支持/失败）。
 * 原生 NFC 插件未安装，MVP 先用浏览器 NDEFReader 做能力探测。
 */
async function scanNfc(): Promise<string | null> {
  const NDEFReaderConstructor = (window as unknown as { NDEFReader?: new () => NDEFReaderInstance }).NDEFReader;
  if (!NDEFReaderConstructor) return null;

  const reader: NDEFReaderInstance = new NDEFReaderConstructor();
  await reader.scan();
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error('NFC 扫描超时')), 20000);
    reader.addEventListener(
      'reading',
      (event: Event) => {
        window.clearTimeout(timer);
        resolve((event as NDEFReadingEventLike).serialNumber || 'nfc-unknown');
      },
      { once: true },
    );
    reader.addEventListener(
      'error',
      () => {
        window.clearTimeout(timer);
        reject(new Error('NFC 扫描失败'));
      },
      { once: true },
    );
  });
}

export function JourneyTaskCard({ task, onComplete, onRetry }: JourneyTaskCardProps) {
  const [feedbackType, setFeedbackType] = useState<string>(task.feedback_types[0] || 'text');
  const [value, setValue] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const voiceObjectUrlRef = useRef<string | null>(null);
  const { state: recorderState, startRecording, stopRecording, cancelRecording } = useVoiceRecorder();
  const crisisResources = useCrisisResources();
  const isRecording = recorderState.status === 'recording';

  const reset = useCallback(() => {
    setValue('');
    setCompleted(false);
    setError(null);
    setPreviewUrl(null);
    if (voiceObjectUrlRef.current) {
      URL.revokeObjectURL(voiceObjectUrlRef.current);
      voiceObjectUrlRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      if (voiceObjectUrlRef.current) {
        URL.revokeObjectURL(voiceObjectUrlRef.current);
      }
    };
  }, []);

  async function handleSubmit() {
    let feedback: TaskFeedback;
    switch (feedbackType) {
      case 'confirm':
        feedback = { type: 'confirm', value: true };
        break;
      case 'option':
        if (!value) return;
        feedback = { type: 'option', value };
        break;
      case 'number': {
        const n = Number(value);
        if (value.trim() === '' || Number.isNaN(n)) {
          setError('请输入有效数字');
          return;
        }
        feedback = { type: 'number', value: n };
        break;
      }
      case 'image':
        feedback = { type: 'image', value };
        break;
      case 'location':
        feedback = { type: 'location', value };
        break;
      case 'nfc_tag':
        feedback = { type: 'nfc_tag', value };
        break;
      case 'voice':
        feedback = { type: 'voice', value };
        break;
      case 'text':
      default:
        feedback = { type: 'text', value };
        break;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onComplete(feedback);
      setCompleted(true);
    } catch (e) {
      // 提交失败：保留卡片，展示错误，用户可再次点击提交重试。
      setError(e instanceof Error ? e.message : '提交失败，请重试');
    } finally {
      setSubmitting(false);
    }
  }

  async function handlePickImage() {
    setError(null);
    setPending(true);
    try {
      const dataUrl = await pickImage();
      if (dataUrl) {
        setValue(dataUrl);
        setPreviewUrl(dataUrl);
      } else if (fileInputRef.current) {
        fileInputRef.current.click();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '图片获取失败');
    } finally {
      setPending(false);
    }
  }

  function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    setValue(url);
    setPreviewUrl(url);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }

  async function handleGetLocation() {
    setError(null);
    setPending(true);
    try {
      const position = await getCurrentPosition();
      setValue(position);
    } catch (err) {
      setError(err instanceof Error ? err.message : '位置获取失败');
    } finally {
      setPending(false);
    }
  }

  async function handleScanNfc() {
    setError(null);
    setPending(true);
    try {
      const tag = await scanNfc();
      if (tag) {
        setValue(tag);
      } else {
        setError('当前设备或浏览器不支持 NFC，请手动输入标签 ID');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'NFC 读取失败');
    } finally {
      setPending(false);
    }
  }

  function handleToggleVoice() {
    setError(null);
    if (isRecording) {
      const result = stopRecording();
      if (result?.blob) {
        if (voiceObjectUrlRef.current) {
          URL.revokeObjectURL(voiceObjectUrlRef.current);
        }
        const url = URL.createObjectURL(result.blob);
        voiceObjectUrlRef.current = url;
        setValue(url);
      }
    } else {
      cancelRecording();
      void startRecording();
    }
  }

  if (completed) {
    return (
      <div className="card p-4">
        <div className="font-semibold">{task.name}</div>
        <div className="text-sm text-emerald-600 mt-2">{FEEDBACK_MESSAGES[feedbackType] || '已完成'}</div>
        {task.follow_up_message_template && (
          <div className="mt-2 text-sm text-slate-700">{task.follow_up_message_template}</div>
        )}
        <CrisisResourceReminder resources={crisisResources} className="mt-3" />
        {onRetry && (
          <button className="btn btn-sm mt-2" onClick={onRetry}>
            重试
          </button>
        )}
      </div>
    );
  }

  const options = normalizeOptions(task.options);
  const numberValid = (() => {
    if (feedbackType !== 'number') return true;
    const n = Number(value);
    if (value.trim() === '' || Number.isNaN(n)) return false;
    if (typeof task.min === 'number' && n < task.min) return false;
    if (typeof task.max === 'number' && n > task.max) return false;
    return true;
  })();
  const textLikeTypes = new Set(['text', 'nfc_tag']);
  const submitDisabled =
    feedbackType === 'confirm'
      ? false
      : feedbackType === 'option'
        ? !value
        : feedbackType === 'number'
          ? !numberValid
          : textLikeTypes.has(feedbackType)
            ? !value.trim()
            : !value && feedbackType !== 'image' && feedbackType !== 'voice';

  return (
    <div className="card p-4">
      <div className="font-semibold">{task.name}</div>
      <div className="text-sm text-slate-500 mb-3">{task.description}</div>
      <div className="flex gap-2 mb-3 flex-wrap">
        {task.feedback_types.map((t) => (
          <button
            key={t}
            className={`text-xs px-2 py-1 rounded border ${feedbackType === t ? 'bg-indigo-100 border-indigo-300' : 'bg-white'}`}
            onClick={() => {
              setFeedbackType(t);
              reset();
            }}
          >
            {t}
          </button>
        ))}
      </div>

      {feedbackType === 'text' && (
        <textarea
          className="w-full border rounded p-2 text-sm"
          rows={3}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="输入文字反馈..."
        />
      )}

      {feedbackType === 'image' && (
        <div className="space-y-2">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={handleFileChange}
          />
          <button
            type="button"
            className="btn btn-sm"
            onClick={handlePickImage}
            disabled={pending}
          >
            {pending ? '打开中...' : '拍照或选图'}
          </button>
          {previewUrl && (
            <img src={previewUrl} alt="预览" className="w-full max-h-48 object-contain rounded border" />
          )}
        </div>
      )}

      {feedbackType === 'confirm' && (
        <p className="text-sm text-gray-500">点击下方「提交」即表示确认完成本任务。</p>
      )}

      {feedbackType === 'option' && (
        <div className="flex flex-col gap-2" role="radiogroup" aria-label="选项">
          {options.length === 0 ? (
            <p className="text-sm text-gray-400">暂无可选项</p>
          ) : (
            options.map((opt) => (
              <button
                key={opt.id}
                type="button"
                role="radio"
                aria-checked={value === opt.id}
                className={`btn btn-sm justify-start ${value === opt.id ? 'btn-primary' : ''}`}
                onClick={() => setValue(opt.id)}
              >
                {opt.label ?? opt.id}
              </button>
            ))
          )}
        </div>
      )}

      {feedbackType === 'number' && (
        <div className="space-y-1">
          <input
            type="number"
            className="w-full border rounded p-2 text-sm"
            value={value}
            min={task.min}
            max={task.max}
            onChange={(e) => setValue(e.target.value)}
            placeholder="输入数字..."
          />
          {(typeof task.min === 'number' || typeof task.max === 'number') && (
            <p className="text-xs text-gray-400">
              范围：{typeof task.min === 'number' ? task.min : '不限'} ~ {typeof task.max === 'number' ? task.max : '不限'}
            </p>
          )}
        </div>
      )}

      {feedbackType === 'location' && (
        <div className="space-y-2">
          <button
            type="button"
            className="btn btn-sm"
            onClick={handleGetLocation}
            disabled={pending}
          >
            {pending ? '定位中...' : '获取当前位置'}
          </button>
          {value && <div className="text-sm text-slate-700">{value}</div>}
        </div>
      )}

      {feedbackType === 'nfc_tag' && (
        <div className="space-y-2">
          <button
            type="button"
            className="btn btn-sm"
            onClick={handleScanNfc}
            disabled={pending}
          >
            {pending ? '扫描中...' : '扫描 NFC'}
          </button>
          <input
            type="text"
            className="w-full border rounded p-2 text-sm"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="或手动输入 NFC 标签 ID..."
          />
        </div>
      )}

      {feedbackType === 'voice' && (
        <div className="space-y-2">
          <button
            type="button"
            className={`btn btn-sm ${isRecording ? 'bg-rose-100 border-rose-300' : ''}`}
            onClick={handleToggleVoice}
            disabled={recorderState.status === 'requesting'}
          >
            {recorderState.status === 'requesting'
              ? '请求权限...'
              : isRecording
                ? `停止录音 (${formatElapsed(recorderState.status === 'recording' ? recorderState.elapsedMs : 0)})`
                : '开始录音'}
          </button>
          {value && (
            <audio src={value} controls className="w-full" />
          )}
        </div>
      )}

      {(error || recorderState.status === 'error') && (
        <div className="text-sm text-rose-600 mt-2">
          {recorderState.status === 'error' ? recorderState.message : error}
        </div>
      )}

      <CrisisResourceReminder resources={crisisResources} className="mt-3" />

      <button
        className="btn btn-primary btn-sm mt-3"
        onClick={handleSubmit}
        disabled={submitDisabled || submitting}
      >
        {submitting ? '提交中…' : '提交'}
      </button>
    </div>
  );
}
