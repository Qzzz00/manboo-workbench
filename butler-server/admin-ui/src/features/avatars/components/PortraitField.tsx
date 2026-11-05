// 来源:Aiboo origin/main 1f430c3f admin-ui/src/features/avatars/components/PortraitField.tsx
/**
 * 头像图编辑字段：拖拽/点击上传 + URL 手填 双通道，圆形裁切预览。
 * 上传走 POST /admin/avatars/portraits，成功后把返回的绝对 URL 回填 value。
 */
import { useRef, useState, type DragEvent } from 'react';
import { uploadPortrait } from '@/features/avatars/api';

const ACCEPT = 'image/png,image/jpeg,image/webp';

export function PortraitField({ value, onChange }: { value: string; onChange: (url: string) => void }) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const doUpload = async (file: File) => {
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
      setError('只支持 PNG / JPEG / WebP 图片');
      return;
    }
    setError(null);
    setUploading(true);
    try {
      const url = await uploadPortrait(file);
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
      <label style={{ marginTop: 12 }}>头像图</label>
      <div
        role="button"
        tabIndex={0}
        onClick={() => !uploading && fileInputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click();
        }}
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
        }}
      >
        <div
          style={{
            width: 72,
            height: 72,
            borderRadius: '50%',
            border: `2px dashed ${dragOver ? '#2563eb' : '#cbd5e1'}`,
            background: dragOver ? 'rgba(37,99,235,0.06)' : '#f1f5f9',
            overflow: 'hidden',
            flexShrink: 0,
            cursor: uploading ? 'wait' : 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {value.trim() ? (
            <img
              src={value}
              alt="头像预览"
              style={{ display: 'block', width: '100%', height: '100%', objectFit: 'cover', borderRadius: '50%' }}
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.display = 'none';
              }}
            />
          ) : (
            <span style={{ fontSize: '0.7rem', color: '#94a3b8', textAlign: 'center', padding: 4 }}>
              未设置
            </span>
          )}
        </div>
        <span className="hint">
          {uploading ? '上传中…' : '点击或拖拽图片可' + (value.trim() ? '替换' : '上传（PNG / JPEG / WebP，≤10MB）')}
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
      <label style={{ marginTop: 8 }}>或直接填图片链接（URL）</label>
      <input
        type="url"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="https://… 留空则用默认头像"
      />
    </div>
  );
}
