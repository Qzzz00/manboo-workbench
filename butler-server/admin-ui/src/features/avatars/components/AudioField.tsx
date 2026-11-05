// 来源:Aiboo origin/main 1f430c3f admin-ui/src/features/avatars/components/AudioField.tsx
/**
 * 音频编辑字段（通用）：拖拽/点击上传 + URL 手填 双通道，<audio controls> 试听。
 * 上传走 POST /admin/avatars/audio，成功后把返回的绝对 URL 回填 value。
 * 供来电铃声 / 消息提示音两处复用，label / placeholder 由调用方传入。
 */
import { useRef, useState, type DragEvent } from 'react';
import { uploadAudio } from '@/features/avatars/api';

const ACCEPT = 'audio/mpeg,.mp3';

export function AudioField({
  label,
  value,
  onChange,
  placeholder = '未设置（用默认音效）',
}: {
  label: string;
  value: string;
  onChange: (url: string) => void;
  placeholder?: string;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const doUpload = async (file: File) => {
    if (file.type !== 'audio/mpeg' && !/\.mp3$/i.test(file.name)) {
      setError('仅支持 MP3 音频文件');
      return;
    }
    setError(null);
    setUploading(true);
    try {
      const url = await uploadAudio(file);
      onChange(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : '上传失败，请重试');
    } finally {
      setUploading(false);
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void doUpload(file);
  };

  return (
    <div>
      <label style={{ marginTop: 12 }}>{label}</label>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
          padding: 8,
          borderRadius: 8,
          border: `2px dashed ${dragOver ? '#2563eb' : '#cbd5e1'}`,
          background: dragOver ? 'rgba(37,99,235,0.06)' : 'transparent',
        }}
      >
        {value.trim() ? (
          <audio controls src={value} style={{ height: 32, maxWidth: 260 }} />
        ) : (
          <span className="hint" style={{ margin: 0 }}>
            {placeholder}
          </span>
        )}
        <button
          type="button"
          className="btn"
          disabled={uploading}
          onClick={() => fileInputRef.current?.click()}
        >
          {uploading ? '上传中…' : value.trim() ? '替换文件' : '上传文件'}
        </button>
        <span className="hint" style={{ margin: 0 }}>
          {uploading ? '上传中…' : '或把 MP3 拖到这里'}
        </span>
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPT}
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void doUpload(file);
          e.target.value = '';
        }}
      />
      {error && (
        <p className="hint" style={{ marginTop: 4, color: '#dc2626' }}>
          {error}
        </p>
      )}
      <label style={{ marginTop: 8 }}>或直接填音频链接（URL）</label>
      <input
        type="url"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="https://… 留空则用默认音效"
      />
    </div>
  );
}
