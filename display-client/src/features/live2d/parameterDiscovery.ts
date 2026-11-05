import {
  avatarList,
  discoverAvatarResourceParameters,
  mergeDiscoveredLive2DParameters,
  resolveAvatarManifest,
  type Live2DParameterDiscoveryResult,
} from './avatarManifest.ts';
import {
  createLive2DRuntime,
  destroyRuntime,
  getRuntimeParameterSnapshot,
} from './live2dEngine.ts';

function createHiddenRuntimeContainer() {
  const container = document.createElement('div');
  container.style.position = 'fixed';
  container.style.left = '-10000px';
  container.style.top = '0';
  container.style.width = '320px';
  container.style.height = '320px';
  container.style.pointerEvents = 'none';
  container.setAttribute('aria-hidden', 'true');
  document.body.appendChild(container);
  return container;
}

export async function discoverAllLive2DParameters(
  onAvatarComplete?: (result: Live2DParameterDiscoveryResult) => void,
) {
  const results: Live2DParameterDiscoveryResult[] = [];

  for (const baseAvatar of avatarList) {
    const avatar = await resolveAvatarManifest(baseAvatar);
    let container: HTMLDivElement | null = null;
    let runtime: Awaited<ReturnType<typeof createLive2DRuntime>> | null = null;

    try {
      const resourceParameters = await discoverAvatarResourceParameters(avatar, avatar.expressions);
      container = createHiddenRuntimeContainer();
      runtime = await createLive2DRuntime(container, avatar);
      const runtimeParameters = getRuntimeParameterSnapshot(runtime);

      const result = {
        avatarId: avatar.id,
        avatarName: avatar.name,
        parameters: mergeDiscoveredLive2DParameters(avatar, [resourceParameters, runtimeParameters]),
      };
      results.push(result);
      onAvatarComplete?.(result);
    } catch (error) {
      const resourceParameters = await discoverAvatarResourceParameters(avatar, avatar.expressions);
      const result = {
        avatarId: avatar.id,
        avatarName: avatar.name,
        parameters: resourceParameters,
        error: error instanceof Error ? error.message : String(error),
      };
      results.push(result);
      onAvatarComplete?.(result);
    } finally {
      if (runtime) {
        destroyRuntime(runtime);
      }
      container?.remove();
    }
  }

  return results;
}
