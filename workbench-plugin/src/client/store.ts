import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'

export interface WorkbenchState {
  open: boolean
  openingProjectId: string | null
  error: string | null
}

type WorkbenchActions = {
  open: (draft: WorkbenchState) => void
  close: (draft: WorkbenchState) => void
  startOpening: (draft: WorkbenchState, projectId: string) => void
  failOpening: (draft: WorkbenchState, message: string) => void
}

/** Declare the shared root state used by the overlay and sidebar entry. */
export function createWorkbenchStore(): EngineStoreHandle<WorkbenchState, WorkbenchActions> {
  return defineStore({
    init: (): WorkbenchState => ({ open: true, openingProjectId: null, error: null }),
    actions: {
      open: (draft) => {
        draft.open = true
        draft.error = null
      },
      close: (draft) => {
        draft.open = false
        draft.openingProjectId = null
        draft.error = null
      },
      startOpening: (draft, projectId: string) => {
        draft.openingProjectId = projectId
        draft.error = null
      },
      failOpening: (draft, message: string) => {
        draft.open = true
        draft.openingProjectId = null
        draft.error = message
      },
    },
  })
}
