/** Production UI, real HTTP only. The absent DSH host contributes empty workspace/session slots. */
import { createRoot } from 'react-dom/client'
import { WorkbenchOverlay } from '../../src/client/Workbench.tsx'
import { createWorkbenchStore } from '../../src/client/store.ts'
import { UNUSED_STANDARD_PROPS } from '../../tests/helpers/standardProps.ts'
const instance = createWorkbenchStore().create()
const workspace = { items: [], phase: 'ready', archivedSessionIds: [], state: 'idle', error: null, baselinesReady: true, recentWorkspaceId: undefined }
document.body.setAttribute('data-ds-dark-theme', '')
createRoot(document.getElementById('app')!).render(<WorkbenchOverlay
  {...UNUSED_STANDARD_PROPS}
  useStore={selector => selector(instance.getSnapshot())} actions={instance.actions}
  useWorkspaces={selector => selector(workspace as never)} useSessions={selector => selector({} as never)}
  openWorkspace={async () => {}} openSession={() => {}}
  serviceBaseUrl={`${location.origin}/api`} servicePollMs={200}
/> )
