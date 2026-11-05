// 来源:Aiboo origin/main 1f430c3f admin-ui/src/features/avatars/components/BackgroundField.tsx
/**
 * 默认背景图编辑字段：拖拽/点击上传 + URL 手填 双通道。
 * 上传走 POST /admin/avatars/backgrounds，成功后把返回的绝对 URL 回填 value。
 */
import { useRef, useState, type DragEvent } from 'react';
import { uploadBackground } from '@/features/avatars/api';

const ACCEPT = 'image/png,image/jpeg,image/webp';

export function BackgroundField({ value, onChange }: { value: string; onChange: (url: string) => void }) {
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
      const url = await uploadBackground(file);
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
      <label style={{ marginTop: 12 }}>默认背景图</label>
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
          border: `2px dashed ${dragOver ? '#2563eb' : '#cbd5e1'}`,
          borderRadius: 8,
          padding: value.trim() ? 0 : '20px 12px',
          textAlign: 'center',
          color: '#64748b',
          fontSize: '0.85rem',
          cursor: uploading ? 'wait' : 'pointer',
          background: dragOver ? 'rgba(37,99,235,0.06)' : 'transparent',
          overflow: 'hidden',
          position: 'relative',
        }}
      >
        {value.trim() ? (
          <>
            <img
              src={value}
              alt="背景预览"
              style={{ display: 'block', width: '100%', maxHeight: 160, objectFit: 'cover' }}
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.display = 'none';
              }}
            />
            <div
              style={{
                position: 'absolute',
                left: 0,
                right: 0,
                bottom: 0,
                padding: '4px 8px',
                background: 'rgba(15,23,42,0.55)',
                color: '#fff',
                fontSize: '0.75rem',
              }}
            >
              {uploading ? '上传中…' : '点击或拖拽图片可替换'}
            </div>
          </>
        ) : (
          <span>{uploading ? '上传中…' : '拖拽图片到这里，或点击选择文件（PNG / JPEG / WebP，≤10MB）'}</span>
        )}
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
        placeholder="https://… 留空则无默认背景"
      />
      <p className="hint" style={{ marginTop: 4 }}>
        用户在 App 内生成/上传的背景优先于此默认。
      </p>
    </div>
  );
}
