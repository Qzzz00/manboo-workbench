// 来源:Aiboo origin/main 1f430c3f admin-ui/src/features/avatars/AvatarVersionUpload.tsx
/** 为已有角色（draft / published）上传新版本 zip；archived 不可进入此页。 */
import { useEffect, useState } from 'react';
import { getAvatar, reextractAvatarVersion, restoreAvatarVersion, uploadVersion } from '@/features/avatars/api';
import { AdminApiError } from '@/shared/api/errors';
import { ZipUploader } from '@/shared/components/ZipUploader';
import { StatusBadge } from '@/shared/components/StatusBadge';
import { toast } from '@/shared/components/toast';
import { useNavigate } from 'react-router-dom';
import { formatBytes } from '@/features/avatars/zipValidation';
import type { AvatarAdminDetail } from '@/shared/types';

export function AvatarVersionUpload({ id }: { id: string }) {
  const navigate = useNavigate();
  const [avatar, setAvatar] = useState<AvatarAdminDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [zip, setZip] = useState<File | null>(null);
  const [progress, setProgress] = useState(-1);
  const [submitting, setSubmitting] = useState(false);
  const [restoring, setRestoring] = useState<number | null>(null);
  const [reextracting, setReextracting] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    getAvatar(id)
      .then((a) => alive && setAvatar(a))
      .catch((e) => toast.error(e instanceof AdminApiError ? e.message : '加载失败'))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [id]);

  const onSubmit = async () => {
    if (!zip) {
      toast.error('请先选择合法的 zip 包');
      return;
    }
    setSubmitting(true);
    setProgress(0);
    try {
      const res = await uploadVersion(id, zip, setProgress);
      toast.success(`已上传 v${res.version}`);
      navigate(`/avatars/${encodeURIComponent(id)}`);
    } catch (e) {
      toast.error(e instanceof AdminApiError ? e.message : '上传失败');
    } finally {
      setSubmitting(false);
      setProgress(-1);
    }
  };

  // 从历史版本恢复：生成 current_version + 1 的新版本，历史版本不删除、不覆盖。
  const onRestore = async (sourceVersion: number) => {
    if (!avatar) return;
    const target = avatar.current_version + 1;
    const ok = window.confirm(
      `将从 v${sourceVersion} 生成 v${target}，并切换当前角色到 v${target}。` +
        `v${sourceVersion} 与当前版本 v${avatar.current_version} 都不会被删除。`,
    );
    if (!ok) return;
    setRestoring(sourceVersion);
    try {
      const res = await restoreAvatarVersion(id, sourceVersion);
      toast.success(`已从 v${res.restored_from} 恢复为新版本 v${res.version}`);
      // 刷新详情：当前版本号 / model_entry / 历史列表（含「从 vX 恢复」标记）
      setAvatar(await getAvatar(id));
    } catch (e) {
      toast.error(e instanceof AdminApiError ? e.message : '恢复失败');
    } finally {
      setRestoring(null);
    }
  };

  // 重新解压:用该版本原 bundle.zip 按当前规则(支持 Windows GBK 文件名)覆盖 unpacked/,不生成新版本、不重传。
  // 2026-09-16 之前上传的 Windows 包解出乱码文件名、预览「模型加载失败」,点这个就能修。
  const onReextract = async (v: number) => {
    if (!avatar) return;
    const ok = window.confirm(
      `将用 v${v} 的原始 zip 重新解压并覆盖该版本的解压目录(修复乱码文件名)。` +
        `不会生成新版本,zip 原件不变${v === avatar.current_version ? ',并同步更新 model_entry' : ''}。`,
    );
    if (!ok) return;
    setReextracting(v);
    try {
      const res = await reextractAvatarVersion(id, v);
      toast.success(`v${res.version} 已重新解压 ${res.extracted_files} 个文件,入口 ${res.model_entry}`);
      setAvatar(await getAvatar(id));
    } catch (e) {
      toast.error(e instanceof AdminApiError ? e.message : '重新解压失败');
    } finally {
      setReextracting(null);
    }
  };

  if (loading) return <p className="loading">加载中…</p>;
  if (!avatar) return <p className="empty">角色不存在</p>;

  const archived = avatar.status === 'archived';

  return (
    <div>
      <h2>
        上传新版本：{avatar.name} <StatusBadge status={avatar.status} />
      </h2>
      <p className="subtitle mono">当前版本 v{avatar.current_version}，上传后版本号自增并更新 model_entry</p>

      {archived ? (
        <div className="card">
          <p className="error-text">归档角色不能上传新版本。</p>
        </div>
      ) : (
        <div className="card">
          <ZipUploader onFileChange={setZip} progress={progress} />
        </div>
      )}

      {/* 历史版本：可把任意旧版本恢复为新版本；恢复 = 复制生成 current+1，历史不删除 */}
      <div className="card edit-history" style={{ marginTop: 16 }}>
        <div className="section-title" style={{ marginTop: 0 }}>
          历史版本
        </div>
        <ul className="version-list" style={{ margin: 0, paddingLeft: 0, listStyle: 'none' }}>
          {avatar.versions.map((v) => (
            <li
              key={v.version}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                padding: '4px 0',
              }}
            >
              <span>
                v{v.version}
                {v.version === avatar.current_version ? '（当前）' : ''}
                {v.restore_source_version != null ? ` · 从 v${v.restore_source_version} 恢复` : ''}
                {v.restore_reason ? ` · ${v.restore_reason}` : ''} · {formatBytes(v.size_bytes)} · sha256{' '}
                {v.checksum.slice(0, 8)}… · {new Date(v.uploaded_at * 1000).toLocaleString('zh-CN', { hour12: false })}
              </span>
              <span style={{ display: 'flex', gap: 8 }}>
                {!archived && (
                  <button
                    className="btn btn-sm"
                    disabled={restoring !== null || reextracting !== null}
                    onClick={() => void onReextract(v.version)}
                    title="用原 zip 按当前规则重新解压,修复 Windows 压缩包的乱码文件名;不生成新版本"
                  >
                    {reextracting === v.version ? '解压中…' : '重新解压'}
                  </button>
                )}
                {v.version !== avatar.current_version && !archived && (
                  <button
                    className="btn btn-sm"
                    disabled={restoring !== null || reextracting !== null}
                    onClick={() => void onRestore(v.version)}
                  >
                    {restoring === v.version ? '恢复中…' : '恢复为新版本'}
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div className="actions">
        <button className="btn" onClick={() => navigate('/avatars')}>
          返回列表
        </button>
        <button
          className="btn btn-primary"
          disabled={archived || zip === null || submitting}
          onClick={() => void onSubmit()}
        >
          {submitting ? '上传中…' : '上传新版本'}
        </button>
      </div>
    </div>
  );
}
