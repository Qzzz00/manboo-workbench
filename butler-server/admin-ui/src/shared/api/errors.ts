// 来源:Aiboo origin/main 1f430c3f admin-ui/src/shared/api/errors.ts
/** 后端业务错误，message 取契约 error 文案，code 取契约错误码。 */
export class AdminApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
    this.name = 'AdminApiError';
  }
}
