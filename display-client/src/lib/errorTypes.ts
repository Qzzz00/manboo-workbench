export class NetworkError extends Error {
  code = 'network_error' as const;
  constructor(message = '网络连接失败，请检查网络后重试') {
    super(message);
  }
}

export class UnauthorizedError extends Error {
  code = 'unauthorized' as const;
  constructor(message = '登录已过期，请重新登录') {
    super(message);
  }
}

export class ForbiddenError extends Error {
  code = 'forbidden' as const;
  constructor(message = '没有权限执行此操作') {
    super(message);
  }
}

export class QuotaExceededError extends Error {
  code = 'quota_exceeded' as const;
  constructor(message = 'API 配额已用完，请稍后再试或更换密钥') {
    super(message);
  }
}

export class ServerError extends Error {
  code = 'server_error' as const;
  status: number;
  constructor(status: number, message = '服务器繁忙，请稍后再试') {
    super(message);
    this.status = status;
  }
}

export function isQuotaError(message: string, status?: number): boolean {
  if (status === 429) return true;
  const lower = message.toLowerCase();
  const keywords = ['quota', 'rate limit', 'insufficient_quota', 'exceeded', '额度', '速率限制', '配额'];
  return keywords.some((k) => lower.includes(k));
}

export function classifyFetchError(status: number, message?: string): Error {
  if (status === 401) return new UnauthorizedError(message);
  if (status === 403) return new ForbiddenError(message);
  if (status === 429 || isQuotaError(message || '', status)) return new QuotaExceededError(message);
  if (status >= 500) return new ServerError(status, message);
  return new Error(message || `请求失败 (${status})`);
}
