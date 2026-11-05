// 来源:Aiboo origin/main 1f430c3f admin-ui/src/features/avatars/AvatarList.test.tsx
/** AvatarList 发布/取消发布开关：状态行显示正确操作、取消发布二次确认、成功后刷新、失败 toast 不乐观伪成功。 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { AvatarList } from '@/features/avatars/AvatarList';
import { listAvatars, publish, unpublish } from '@/features/avatars/api';
import type { AvatarAdminSummary, AvatarStatus } from '@/shared/types';
import { AdminApiError } from '@/shared/api/errors';

vi.mock('@/features/avatars/api', () => ({
  listAvatars: vi.fn(),
  publish: vi.fn(),
  unpublish: vi.fn(),
  archive: vi.fn(),
  deleteAvatar: vi.fn(),
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => () => {},
}));

const listMock = vi.mocked(listAvatars);
const publishMock = vi.mocked(publish);
const unpublishMock = vi.mocked(unpublish);

function summary(over: Partial<AvatarAdminSummary> & { id: string; status: AvatarStatus }): AvatarAdminSummary {
  return {
    name: '小希',
    summary: '',
    current_version: 1,
    updated_at: 1700000000,
    dj_binding: null,
    ...over,
  };
}

async function renderPage() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(<AvatarList />);
  });
  return {
    container,
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

function buttonsByText(container: HTMLElement, text: string): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll('button')).filter(
    (b): b is HTMLButtonElement => b instanceof HTMLButtonElement && b.textContent === text,
  );
}

describe('AvatarList 发布/取消发布', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('草稿行显示「发布」，已发布行显示「取消发布」，两者互斥', async () => {
    listMock.mockResolvedValue([
      summary({ id: 'av_draft', status: 'draft' }),
      summary({ id: 'av_pub', status: 'published' }),
    ]);
    const { container, cleanup } = await renderPage();
    expect(buttonsByText(container, '发布')).toHaveLength(1);
    expect(buttonsByText(container, '取消发布')).toHaveLength(1);
    await cleanup();
  });

  it('发布草稿成功后调用 publish(正确ID) 并刷新列表', async () => {
    const draft = summary({ id: 'av1', status: 'draft' });
    listMock.mockResolvedValueOnce([draft]).mockResolvedValueOnce([{ ...draft, status: 'published' }]);
    publishMock.mockResolvedValue({ ...draft, status: 'published' });
    const { container, cleanup } = await renderPage();

    await act(async () => {
      buttonsByText(container, '发布')[0].click();
    });

    expect(publishMock).toHaveBeenCalledTimes(1);
    expect(publishMock).toHaveBeenCalledWith('av1');
    expect(listMock).toHaveBeenCalledTimes(2); // 进入 + 发布后刷新
    await cleanup();
  });

  it('已发布行点「取消发布」弹出确认；确认后调 unpublish(正确ID) 并刷新', async () => {
    const pub = summary({ id: 'av1', status: 'published' });
    listMock.mockResolvedValueOnce([pub]).mockResolvedValueOnce([{ ...pub, status: 'draft' }]);
    unpublishMock.mockResolvedValue({ ...pub, status: 'draft' });
    const { container, cleanup } = await renderPage();

    await act(async () => {
      buttonsByText(container, '取消发布')[0].click();
    });
    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('确认取消发布'));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('停止对新用户开放'));
    expect(unpublishMock).toHaveBeenCalledTimes(1);
    expect(unpublishMock).toHaveBeenCalledWith('av1');
    expect(listMock).toHaveBeenCalledTimes(2);
    await cleanup();
  });

  it('取消发布弹窗选择「取消」不调用接口', async () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    const pub = summary({ id: 'av1', status: 'published' });
    listMock.mockResolvedValue([pub]);
    const { container, cleanup } = await renderPage();
    const callsBefore = listMock.mock.calls.length;

    await act(async () => {
      buttonsByText(container, '取消发布')[0].click();
    });
    expect(unpublishMock).not.toHaveBeenCalled();
    expect(listMock.mock.calls.length).toBe(callsBefore);
    await cleanup();
  });

  it('取消发布失败弹出错误 toast 且不刷新、按钮恢复可点', async () => {
    const toast = await import('@/shared/components/toast');
    const errorSpy = vi.spyOn(toast.toast, 'error');
    const pub = summary({ id: 'av1', status: 'published' });
    listMock.mockResolvedValueOnce([pub]);
    unpublishMock.mockRejectedValue(new AdminApiError('服务器拒绝', 409));
    const { container, cleanup } = await renderPage();
    const callsBefore = listMock.mock.calls.length;

    await act(async () => {
      buttonsByText(container, '取消发布')[0].click();
    });
    expect(errorSpy).toHaveBeenCalledWith('服务器拒绝');
    expect(listMock.mock.calls.length).toBe(callsBefore);
    await cleanup();
  });
});
