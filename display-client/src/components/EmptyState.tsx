type EmptyStateProps = {
  icon?: string;
  title?: string;
  description?: string;
  children?: React.ReactNode;
};

export function EmptyState({ icon = '💬', title = '还没有消息', description = '开始和 AI 伴侣对话吧～', children }: EmptyStateProps) {
  return (
    <div className="empty-state">
      <div className="empty-state-icon">{icon}</div>
      <div className="empty-state-title">{title}</div>
      <div className="empty-state-desc">{description}</div>
      {children}
    </div>
  );
}
