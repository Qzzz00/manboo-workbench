// 来源:Aiboo origin/main 1f430c3f admin-ui/src/shared/components/StatusBadge.tsx
import type { AvatarStatus } from '@/shared/types';

const LABELS: Record<AvatarStatus, string> = {
  draft: '草稿',
  published: '已发布',
  archived: '已归档',
};

export function StatusBadge({ status }: { status: AvatarStatus }) {
  return <span className={`badge badge-${status}`}>{LABELS[status]}</span>;
}
