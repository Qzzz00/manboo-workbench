// 来源:Aiboo origin/main 1f430c3f admin-ui/src/features/avatars/AvatarList.tsx(去「AI 创建角色」,新建=上传 zip)
/** 角色列表：表格 + 状态 badge + 按状态控制的操作按钮；操作成功后刷新。 */
import { useCallback, useEffect, useState } from 'react';
import { archive, deleteAvatar, listAvatars, publish, unpublish } from '@/features/avatars/api';
import { AdminApiError } from '@/shared/api/errors';
import { StatusBadge } from '@/shared/components/StatusBadge';
import { toast } from '@/shared/components/toast';
import { useNavigate } from 'react-router-dom';
import type { AvatarAdminSummary, AvatarStatus } from '@/shared/types';

const FILTERS: { label: string; value?: AvatarStatus }[] = [
  { label: '全部' },
  { label: '草稿', value: 'draft' },
  { label: '已发布', value: 'published' },
];

function fmtTime(unix: number): string {
  return new Date(unix * 1000).toLocaleString('zh-CN', { hour12: false });
}

export function AvatarList() {
  const navigate = useNavigate();
  const [rows, setRows] = useState<AvatarAdminSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<AvatarStatus | undefined>(undefined);
  const [busyId, setBusyId] = useState<string>('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await listAvatars(filter));
    } catch (e) {
      toast.error(e instanceof AdminApiError ? e.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    void load();
  }, [load]);

  const runOp = async (id: string, op: () => Promise<unknown>, okMsg: string) => {
    setBusyId(id);
    try {
      await op();
      toast.success(okMsg);
      await load(); // 操作后刷新列表
    } catch (e) {
      toast.error(e instanceof AdminApiError ? e.message : '操作失败');
    } finally {
      setBusyId('');
    }
  };

  const onUnpublish = (a: AvatarAdminSummary) => {
    if (!window.confirm(`确认取消发布「${a.name}」？角色将停止对新用户开放、停止继续聊天和主动消息，但不会删除角色、版本或历史。`)) return;
    void runOp(a.id, () => unpublish(a.id), '已取消发布');
  };

  const onDelete = (a: AvatarAdminSummary) => {
    if (!window.confirm(`确认删除角色「${a.name}」？将永久删除其配置与资源，不可恢复。`)) return;
    // 后端要求角色处于 archived 才能删除。这里按需把角色推进到 archived 再删除，
    // 对运营透明——界面上只暴露「发布 / 删除」，不出现「归档」概念。
    void runOp(
      a.id,
      async () => {
        let status: AvatarStatus = a.status;
        if (status === 'draft') {
          await publish(a.id);
          status = 'published';
        }
        if (status === 'published') {
          await archive(a.id);
          status = 'archived';
        }
        await deleteAvatar(a.id);
      },
      '已删除',
    );
  };

  return (
    <div>
      <h2>形象列表</h2>
      <p className="subtitle">事务官的 Live2D 形象:草稿 / 已发布,以及各自的版本</p>

      <div className="actions" style={{ marginBottom: 16, justifyContent: 'space-between' }}>
        <div className="actions">
          {FILTERS.map((f) => (
            <button
              key={f.label}
              className={`btn btn-sm ${filter === f.value ? 'btn-primary' : ''}`}
              onClick={() => setFilter(f.value)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="actions">
          {/* 本机版没有「AI 创建角色」(creator 不搬);新建 = 上传 Live2D zip。 */}
          <button className="btn btn-primary" onClick={() => navigate('/avatars/new')} title="上传 Live2D 模型 ZIP">
            新建形象(上传 ZIP)
          </button>
        </div>
      </div>

      <div className="card" style={{ padding: 0 }}>
        {loading ? (
          <p className="loading" style={{ padding: 24 }}>
            加载中…
          </p>
        ) : rows.length === 0 ? (
          <p className="empty">暂无形象,先「新建形象」上传一个 Live2D zip</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>名称</th>
                <th>ID</th>
                <th>状态</th>
                <th>当前版本</th>
                <th>更新时间</th>
                <th style={{ width: 280 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => {
                const busy = busyId === a.id;
                const isArchived = a.status === 'archived';
                return (
                  <tr key={a.id}>
                    <td>{a.name}</td>
                    <td className="mono">{a.id}</td>
                    <td>
                      <StatusBadge status={a.status} />
                    </td>
                    <td>v{a.current_version}</td>
                    <td className="mono">{fmtTime(a.updated_at)}</td>
                    <td>
                      <div className="actions">
                        <button
                          className="btn btn-sm"
                          disabled={busy || isArchived}
                          title={isArchived ? '归档角色不可编辑' : ''}
                          onClick={() => navigate(`/avatars/${encodeURIComponent(a.id)}`)}
                        >
                          编辑
                        </button>
                        {/* archived 不显示上传新版本 */}
                        {!isArchived && (
                          <button
                            className="btn btn-sm"
                            disabled={busy}
                            onClick={() => navigate(`/avatars/${encodeURIComponent(a.id)}/upload`)}
                          >
                            上传新版本
                          </button>
                        )}
                        {a.status === 'draft' && (
                          <button
                            className="btn btn-sm btn-primary"
                            disabled={busy}
                            onClick={() => void runOp(a.id, () => publish(a.id), '已发布')}
                          >
                            发布
                          </button>
                        )}
                        {a.status === 'published' && (
                          <button
                            className="btn btn-sm"
                            disabled={busy}
                            onClick={() => onUnpublish(a)}
                          >
                            取消发布
                          </button>
                        )}
                        <button
                          className="btn btn-sm btn-danger"
                          disabled={busy}
                          onClick={() => onDelete(a)}
                        >
                          删除
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
