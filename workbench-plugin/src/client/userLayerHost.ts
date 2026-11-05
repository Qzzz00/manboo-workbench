/**
 * 本体给用户层小组件的接口:`require('@workbench/host')` 拿到的就是这一个对象
 * (2026-10-21,卡「分层第一刀」;契约见 `docs/设计-分层第一刀-2026-10-21.md` 第五节)。
 *
 * **这张表就是本体开出去的全部**:表里的名字一旦发出去就只增不改(`USER_LAYER_CONTRACT` 那条规矩)——
 * 改一个已有名字的意思或拿掉一个,等于让她那几格白屏。要加就往里加,本体内部重构时这张表的名字要守住。
 *
 * 第一批是照运营同学那六格**实际 import 过的东西**开的(她原件里 `import … from '../X.tsx'` 那几行),
 * 不多开一样:多开一样就多一样要守的名字。
 */
import { DEFAULT_TOPIC_STAGE, PUBLISH_PLAN_SOURCE_PREFIX, TOPIC_CONTENT_TYPES, TOPIC_STAGES, USER_LAYER_CONTRACT, nextTopicStage } from '../protocol.ts'
import { codexQuotaOf } from './codexQuota.ts'
import { EmptyState } from './EmptyState.tsx'
import { FilesModule } from './FilesModule.tsx'
import { ModuleBox } from './ModuleBox.tsx'
import { Dialog } from './ui/index.tsx'
import { Icon } from './ui/icons.tsx'
import { postSilently } from './postSilently.ts'
import {
  PUBLISH_VIEWS, WEEKDAYS, isOverdue, monthCells, pad, publishDayOf, publishHoverOf, publishHoverText, shiftMonth,
  tasksByPublishDay,
} from './PublishModule.tsx'
import { formatResetAt } from './quotaCells.ts'
import { AccountsTable, REVIEW_RANGES, reviewHasValue } from './ReviewModule.tsx'
import { TodoModule, isOpen, isTopic, stageOf } from './TodoModule.tsx'
import { formatTokens } from './UsagePanel.tsx'
import { airUsageSources } from './usageSources.ts'

export const USER_LAYER_HOST_ID = '@workbench/host'

export const userLayerHost = Object.freeze({
  contract: USER_LAYER_CONTRACT,
  /**
   * 格子的外壳与空态。整格小组件拿 `ModuleBox` 包住自己(props 里给的 `box` 原样摊进去)。
   * `Dialog`:居中弹层(给 props 里的 `veil` 就让窗位里的窗让开);`Icon`:评审页那套线性图标(2026-10-22 加)。
   */
  ui: Object.freeze({ ModuleBox, EmptyState, Dialog, Icon }),
  /** 本体自带的那一版格子,小组件可以把它包成自己的一页(她的素材管理、选题池就是这么做的)。 */
  builtin: Object.freeze({ FilesModule, TodoModule }),
  /** 发一条 POST、失败不吭声(真相以下一拍 /state 为准)。 */
  net: Object.freeze({ postSilently }),
  topics: Object.freeze({ DEFAULT_TOPIC_STAGE, TOPIC_CONTENT_TYPES, TOPIC_STAGES, nextTopicStage, isOpen, isTopic, stageOf }),
  publish: Object.freeze({
    PUBLISH_PLAN_SOURCE_PREFIX, PUBLISH_VIEWS, WEEKDAYS, isOverdue, monthCells, pad, publishDayOf, publishHoverOf, publishHoverText,
    shiftMonth, tasksByPublishDay,
  }),
  review: Object.freeze({ AccountsTable, REVIEW_RANGES, reviewHasValue }),
  /** `sourcesOf`:这台机器上真有用量的那几家(名册由数据给,不写死)。 */
  usage: Object.freeze({ formatTokens, formatResetAt, sourcesOf: airUsageSources, codexQuotaOf }),
})

export type UserLayerHost = typeof userLayerHost
