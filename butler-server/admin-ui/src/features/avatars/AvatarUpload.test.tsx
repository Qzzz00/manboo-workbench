// 来源:Aiboo origin/main 1f430c3f admin-ui/src/features/avatars/AvatarUpload.test.tsx
/** AvatarUpload：zip 上传成功 → toast 成功 + 离开上传页（navigate /avatars）；失败 → 错误 + loading 恢复。 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { AvatarUpload } from '@/features/avatars/AvatarUpload';
import { createAvatar } from '@/features/avatars/api';

const createMock = vi.fn<typeof createAvatar>();

vi.mock('@/features/avatars/api', () => ({
  createAvatar: (...args: unknown[]) => (createMock as unknown as (...a: unknown[]) => Promise<unknown>)(...args),
}));

const navigateMock = vi.fn();
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateMock,
}));

/** toast 库的 success/error（AvatarUpload 用的是 shared/components/toast）——这里 spy 其实现 */
vi.mock('@/shared/components/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));
import { toast } from '@/shared/components/toast';

const toastSuccess = vi.mocked(toast.success);
const toastError = vi.mocked(toast.error);

/** 后端 serializeAvatar 的真实形状（POST /admin/avatars → 201 { avatar }） */
function createdAvatar(id: string): { avatar: { id: string; name: string; current_version: number; status: string } } {
  return {
    avatar: {
      id,
      name: '雪熊',
      current_version: 1,
      status: 'draft',
    },
  };
}

async function renderPage() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(<AvatarUpload />);
  });
  return { container, root, cleanup: async () => { await act(async () => root.unmount()); container.remove(); } };
}

/** 通过受控 onChange 填 name/summary/zip，避免依赖真实 input 交互的细节差异 */
function fillForm(container: HTMLElement) {
  const nameInput = Array.from(container.querySelectorAll('input')).find((i) => i.type === 'text')!;
  const textareas = Array.from(container.querySelectorAll('textarea'));
  // textareas: [0]=summary, [1]=tone, [2..]=traits/styleRules 的动态项
  const summaryTextarea = textareas[0]!;
  const toneTextarea = textareas[1]!;
  const fileInput = Array.from(container.querySelectorAll('input')).find((i) => i.type === 'file')!;
  Object.defineProperty(nameInput, 'value', { writable: true, value: '雪熊' });
  const setText = (el: Element, value: string) => {
    const proto = Object.getPrototypeOf(el);
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const change = (el: Element, file: File | null) => {
    // jsdom 不允许程序化设置 <input type=file>.value；用 defineProperty 注入 files
    Object.defineProperty(el, 'files', {
      configurable: true,
      value: file ? [file] : [],
    });
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  setText(nameInput, '雪熊');
  setText(summaryTextarea, '一只小熊');
  setText(toneTextarea, '温柔'); // tone 非空才能通过 canSubmit 门禁
  const zip = new File(['zip-bytes'], 'NexEli.zip', { type: 'application/zip' });
  change(fileInput, zip);
}

beforeEach(() => {
  navigateMock.mockReset();
  createMock.mockReset();
  toastSuccess.mockReset();
  toastError.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AvatarUpload 上传闭环', () => {
  it('createAvatar 返回 201 { avatar } → toast 成功并 navigate /avatars（离开上传页）', async () => {
    createMock.mockResolvedValue(createdAvatar('av_nexeli') as never);
    const { container, cleanup } = await renderPage();

    await act(async () => {
      fillForm(container);
    });

    const createBtn = Array.from(container.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes('创建角色'))!;
    // 等待表单状态更新（name/summary/zip 都填上 enable 按钮）
    await act(async () => {
      createBtn.click();
    });

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(toastSuccess).toHaveBeenCalledTimes(1);
    expect(toastSuccess.mock.calls[0][0]).toContain('已创建草稿角色');
    expect(navigateMock).toHaveBeenCalledWith('/avatars');
    await cleanup();
  });

  it('上传失败 → toast 错误且不跳转（loading 恢复可再次点击）', async () => {
    createMock.mockRejectedValue(Object.assign(new Error('avatar_zip_invalid: no model'), { code: 'avatar_zip_invalid' }));
    const { container, cleanup } = await renderPage();

    await act(async () => {
      fillForm(container);
    });
    const createBtn = Array.from(container.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes('创建角色'))!;
    await act(async () => {
      createBtn.click();
    });

    expect(toastError).toHaveBeenCalledTimes(1);
    expect(navigateMock).not.toHaveBeenCalled();
    // loading 恢复：按钮回到「创建角色」文案（不再「上传中…」）
    const btnAfter = Array.from(container.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes('创建角色'));
    expect(btnAfter).toBeTruthy();
    await cleanup();
  });
});
