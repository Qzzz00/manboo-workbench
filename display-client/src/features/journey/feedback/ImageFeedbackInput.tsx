import { useEffect, useRef, useState } from 'react';
import { isCancel, isNativeCamera, takePhoto } from '../../../lib/nativeCamera.ts';
import type { ImageFeedbackValue } from '../types.ts';

type ImageFeedbackInputProps = {
  value: ImageFeedbackValue | null;
  onChange: (value: ImageFeedbackValue | null) => void;
  disabled?: boolean;
};

export function ImageFeedbackInput({ value, onChange, disabled }: ImageFeedbackInputProps) {
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    return () => {
      // 清理非持久预览 URL，避免内存泄漏
      if (value && value.previewUrl.startsWith('blob:')) {
        URL.revokeObjectURL(value.previewUrl);
      }
    };
  }, [value]);

  const handleFile = (file: File | null) => {
    setError(null);
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setError('请选择图片文件');
      return;
    }
    const previewUrl = URL.createObjectURL(file);
    onChange({ kind: 'image', file, previewUrl });
  };

  const openPicker = async () => {
    setError(null);

    if (isNativeCamera()) {
      try {
        const file = await takePhoto();
        handleFile(file);
        return;
      } catch (err) {
        if (isCancel(err)) return;
        // 权限被拒绝或原生相机不可用时，降级到文件选择
      }
    }

    inputRef.current?.click();
  };

  return (
    <div className="task-field">
      <span>图片反馈</span>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="task-hidden-input"
        onChange={(event) => handleFile(event.target.files?.[0] ?? null)}
        disabled={disabled}
      />

      {value ? (
        <div className="task-image-preview-wrap">
          <img
            src={value.previewUrl}
            alt="任务反馈图片预览"
            className="task-image-preview"
          />
          <button
            type="button"
            className="task-image-remove"
            onClick={() => onChange(null)}
            disabled={disabled}
          >
            移除
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="task-media-button"
          onClick={openPicker}
          disabled={disabled}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20">
            <rect x="3" y="3" width="18" height="18" rx="4" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <path d="M21 15l-5-5L5 21" />
          </svg>
          拍照或选择图片
        </button>
      )}

      {error && <span className="task-input-error-text">{error}</span>}
    </div>
  );
}
