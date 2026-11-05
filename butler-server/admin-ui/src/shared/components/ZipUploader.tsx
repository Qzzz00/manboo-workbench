// 来源:Aiboo origin/main 1f430c3f admin-ui/src/shared/components/ZipUploader.tsx
/** zip 选择 + 前端校验（.zip / <=100MB）+ 上传进度展示。受控：把校验通过的 File 抛给父级。 */
import { useState } from 'react';
import { validateZipFile, formatBytes } from '@/features/avatars/zipValidation';

interface Props {
  /** 选中并通过前端校验后回调（校验失败回调 null） */
  onFileChange: (file: File | null) => void;
  /** 上传进度 0-100，<0 表示未在上传 */
  progress?: number;
}

export function ZipUploader({ onFileChange, progress = -1 }: Props) {
  const [fileName, setFileName] = useState<string>('');
  const [fileSize, setFileSize] = useState<number>(0);
  const [error, setError] = useState<string>('');

  const handlePick = (file: File | null) => {
    const result = validateZipFile(file);
    if (!result.ok) {
      setError(result.message ?? '文件不合法');
      setFileName('');
      setFileSize(0);
      onFileChange(null);
      return;
    }
    setError('');
    setFileName(file!.name);
    setFileSize(file!.size);
    onFileChange(file);
  };

  return (
    <div>
      <label>角色 zip 包 *（.zip，≤ 100MB）</label>
      <input
        type="file"
        accept=".zip,application/zip"
        onChange={(e) => handlePick(e.target.files?.[0] ?? null)}
      />
      {fileName && (
        <p className="hint">
          已选择：{fileName}（{formatBytes(fileSize)}）
        </p>
      )}
      {error && <p className="error-text">{error}</p>}
      {progress >= 0 && (
        <div className="progress" aria-label="上传进度">
          <div style={{ width: `${progress}%` }} />
        </div>
      )}
      <p className="hint">
        包内必须含 *.model3.json；mock 模式下文件名含 nomodel / traversal / big 可触发对应错误码。
      </p>
    </div>
  );
}
