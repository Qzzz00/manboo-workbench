// 来源:Aiboo origin/main 1f430c3f admin-ui/src/features/avatars/AvatarVersionUpload.test.tsx
/** AvatarVersionUpload 历史版本区：列表展示 / 恢复按钮 / 确认弹窗 / 成功后刷新。 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { AvatarVersionUpload } from '@/features/avatars/AvatarVersionUpload';
import { getAvatar, reextractAvatarVersion, restoreAvatarVersion } from '@/features/avatars/api';
import type { AvatarAdminDetail, AvatarAssetVersion } from '@/shared/types';

vi.mock('@/features/avatars/api', () => ({
  getAvatar: vi.fn(),
  uploadVersion: vi.fn(),
  restoreAvatarVersion: vi.fn(),
  reextractAvatarVersion: vi.fn(),
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
}));

const getAvatarMock = vi.mocked(getAvatar);
const restoreMock = vi.mocked(restoreAvatarVersion);
const reextractMock = vi.mocked(reextractAvatarVersion);

function version(over: Partial<AvatarAssetVersion> & { version: number }): AvatarAssetVersion {
  return {
    size_bytes: 1024,
    checksum: `${'abcdef0'.repeat(9)}${over.version}`,
    uploaded_at: 1700000000 + over.version,
    restore_source_version: null,
    restore_reason: null,
    restored_at: null,
    ...over,
  };
}

function avatar(over: Partial<AvatarAdminDetail>): AvatarAdminDetail {
  return {
    id: 'av1',
    name: '小希',
    summary: '',
    persona: { tone: 'warm', traits: [], styleRules: [] },
    transform: { scaleMultiplier: 1, verticalOffset: 0 },
    motions: null,
    prompt_template: null,
    model_entry: 'char.model3.json',
    current_version: 2,
    status: 'published',
    llm_model_id: null,
    voice: null,
    default_background: null,
    portrait_url: null,
    ringtone_url: null,
    notify_sound_url: null,
    dj_binding: null,
    opening_enabled: false,
    opening_text: null,
    journey_runtime_enabled: false,
    idle_enhance_enabled: true,
    idle_enhance_interval_sec: null,
    public_profile: { identity: null, occupation: null, age: null, world_summary: null },
    created_at: 1700000000,
    updated_at: 1700000000,
    versions: [version({ version: 1 }), version({ version: 2 })],
    ...over,
  };
}

async function renderPage() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(<AvatarVersionUpload id="av1" />);
  });
  return {
    container,
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

function restoreButtons(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll('button')).filter((b) =>
    (b.textContent ?? '').includes('恢复为新版本'),
  ) as HTMLButtonElement[];
}

function reextractButtons(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll('button')).filter((b) =>
    (b.textContent ?? '').includes('重新解压'),
  ) as HTMLButtonElement[];
}

describe('AvatarVersionUpload 历史版本区', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('渲染版本列表：版本号/大小/checksum 短码/时间 + 当前版本标记，当前行无恢复按钮', async () => {
    getAvatarMock.mockResolvedValue(avatar({}));
    const { container, cleanup } = await renderPage();

    const text = container.textContent ?? '';
    expect(text).toContain('历史版本');
    expect(text).toContain('v1');
    expect(text).toContain('v2（当前）');
    expect(text).toContain('sha256 abcdef0a');
    // 当前版本 v2 不显示恢复按钮，仅 v1 行有
    expect(restoreButtons(container)).toHaveLength(1);

    await cleanup();
  });

  it('恢复生成的版本展示「从 vX 恢复」来源标记', async () => {
    getAvatarMock.mockResolvedValue(
      avatar({
        current_version: 3,
        model_entry: 'char.model3.json',
        versions: [
          version({ version: 1 }),
          version({ version: 2 }),
          version({ version: 3, restore_source_version: 1, restored_at: 1700000003 }),
        ],
      }),
    );
    const { container, cleanup } = await renderPage();

    expect(container.textContent ?? '').toContain('从 v1 恢复');
    // v3 是当前版本：v1、v2 两行有恢复按钮
    expect(restoreButtons(container)).toHaveLength(2);

    await cleanup();
  });

  it('点「恢复为新版本」→ 确认弹窗写清来源与目标版本 → 调接口并刷新为新当前版本', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const before = avatar({});
    const after = avatar({
      current_version: 3,
      versions: [
        version({ version: 1 }),
        version({ version: 2 }),
        version({ version: 3, restore_source_version: 1, restored_at: 1700000003 }),
      ],
    });
    getAvatarMock.mockResolvedValueOnce(before).mockResolvedValueOnce(after);
    restoreMock.mockResolvedValue({
      version: 3,
      restored_from: 1,
      checksum: after.versions[2].checksum,
      size_bytes: 1024,
      model_entry: 'char.model3.json',
    });

    const { container, cleanup } = await renderPage();
    const btn = restoreButtons(container)[0];

    await act(async () => {
      btn.click();
    });

    expect(confirmSpy).toHaveBeenCalledOnce();
    const msg = confirmSpy.mock.calls[0][0];
    expect(msg).toContain('将从 v1 生成 v3');
    expect(msg).toContain('v1 与当前版本 v2 都不会被删除');
    expect(restoreMock).toHaveBeenCalledWith('av1', 1);
    // 成功后重新拉详情，页面显示新的当前版本与来源标记
    expect(getAvatarMock).toHaveBeenCalledTimes(2);
    expect(container.textContent ?? '').toContain('当前版本 v3');
    expect(container.textContent ?? '').toContain('从 v1 恢复');

    await cleanup();
  });

  it('确认弹窗取消 → 不调用恢复接口', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    getAvatarMock.mockResolvedValue(avatar({}));
    const { container, cleanup } = await renderPage();

    await act(async () => {
      restoreButtons(container)[0].click();
    });

    expect(restoreMock).not.toHaveBeenCalled();
    expect(getAvatarMock).toHaveBeenCalledTimes(1);

    await cleanup();
  });

  it('恢复失败 → 错误提示且停留在原当前版本', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    getAvatarMock.mockResolvedValue(avatar({}));
    restoreMock.mockRejectedValue(new Error('当前已经是 v2，无需恢复'));

    const { container, cleanup } = await renderPage();
    await act(async () => {
      restoreButtons(container)[0].click();
    });

    expect(container.textContent ?? '').toContain('当前版本 v2');

    await cleanup();
  });

  it('每个版本(含当前版本)都有「重新解压」按钮;归档角色没有', async () => {
    getAvatarMock.mockResolvedValue(avatar({}));
    const { container, cleanup } = await renderPage();
    expect(reextractButtons(container)).toHaveLength(2);
    await cleanup();

    getAvatarMock.mockResolvedValue(avatar({ status: 'archived' }));
    const archived = await renderPage();
    expect(reextractButtons(archived.container)).toHaveLength(0);
    await archived.cleanup();
  });

  it('点当前版本的「重新解压」→ 确认弹窗说明不生成新版本并同步 model_entry → 调接口并刷新详情', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const before = avatar({ model_entry: '����Rin.model3.json' });
    const after = avatar({ model_entry: '爱伶Rin.model3.json' });
    getAvatarMock.mockResolvedValueOnce(before).mockResolvedValueOnce(after);
    reextractMock.mockResolvedValue({ version: 2, model_entry: '爱伶Rin.model3.json', extracted_files: 46, checksum: 'c'.repeat(64), current: true });

    const { container, cleanup } = await renderPage();
    // 列表顺序 v1、v2;v2 是当前版本
    const btn = reextractButtons(container)[1];
    await act(async () => {
      btn.click();
    });

    expect(confirmSpy).toHaveBeenCalledOnce();
    const msg = confirmSpy.mock.calls[0][0];
    expect(msg).toContain('v2 的原始 zip 重新解压');
    expect(msg).toContain('不会生成新版本');
    expect(msg).toContain('同步更新 model_entry');
    expect(reextractMock).toHaveBeenCalledWith('av1', 2);
    expect(restoreMock).not.toHaveBeenCalled();
    expect(getAvatarMock).toHaveBeenCalledTimes(2);
    await cleanup();
  });

  it('重新解压确认取消 → 不调接口;失败 → 不刷新', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    getAvatarMock.mockResolvedValue(avatar({}));
    const { container, cleanup } = await renderPage();
    await act(async () => {
      reextractButtons(container)[0].click();
    });
    expect(reextractMock).not.toHaveBeenCalled();
    await cleanup();

    vi.spyOn(window, 'confirm').mockReturnValue(true);
    reextractMock.mockRejectedValue(new Error('bundle.zip on disk does not match the recorded checksum'));
    const again = await renderPage();
    await act(async () => {
      reextractButtons(again.container)[0].click();
    });
    expect(reextractMock).toHaveBeenCalledWith('av1', 1);
    expect(again.container.textContent ?? '').toContain('当前版本 v2');
    await again.cleanup();
  });
});
