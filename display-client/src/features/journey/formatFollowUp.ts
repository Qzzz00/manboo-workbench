/**
 * 渲染任务完成后的角色反馈话术。
 * 仅支持 PRD 中 `{slot_xxx}` 形式的记忆槽占位符；无法替换的占位符保持原样，
 * 避免缺数据时暴露空字符串。
 */
export function formatFollowUpMessage(
  template: string,
  slots: Record<string, string> = {},
): string {
  if (!template.trim()) return '';
  return template.replace(/\{slot_([a-zA-Z0-9_]+)\}/g, (_match, name: string) => {
    const value = slots[name];
    return typeof value === 'string' ? value : `{slot_${name}}`;
  });
}
