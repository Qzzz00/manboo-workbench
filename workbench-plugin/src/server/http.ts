/**
 * 工作台本地服务的 HTTP + WS 外壳。
 *
 * 为什么必须是真实监听端口、而不是走 DSH 内部的 Cordis/Typert RPC：
 * Claude Code 的 hook 是外部进程用一条 curl 打进来的，够不到 DSH 进程内的服务总线。
 *
 * 只监听 127.0.0.1。这台服务承载的是本机各 agent 的会话状态，不该出本机。
 *
 * 2026-09-11 起多一道门:「允许手机在局域网访问」开着时**另起一台**监听 0.0.0.0 的服务
 * (同一个 handler)，回环那台照旧;非本机来源一律要设备令牌(devices.ts)，本机来源
 * 一切不变——这是回归的重点。
 */
import { createOrdinaryDispatchRulesFor, dispatchRuleTaskText } from './dispatchRuleAdapter.ts'
import { access, copyFile, mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { basename, dirname, join } from 'node:path'
import { homedir as osHomedir, hostname as osHostname, tmpdir as osTmpdir } from 'node:os'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { createReadStream, existsSync, readdirSync } from 'node:fs'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import type {
  PhoneEvent,
  PhoneEventType,
  AgentId,
  AgentView,
  ClientsView,
  InstalledAgentsView,
  SessionTurn,
  DirRule,
  EventReason,
  HelperRect,
  LayoutModule,
  LayoutAct,
  LayoutAskView,
  LiveMessage,
  ActorNoteRegion,
  ProjectDdl,
  ProjectsState,
  QuotaEntry,
  RuleAction,
  SessionStatus,
  SprintVersion,
  TaskLink,
  TaskKind,
  TaskPriority,
  TaskStatus,
  TaskAssignee,
  AgentCardAssignee,
  TaskView,
  AgentDispatchFamily,
  ComposerMode,
  TopicContentType,
  TopicStage,
  UsageState,
  WaitReason,
  UsageTotals,
  WorkbenchEvent,
  WorkbenchLayout,
  WorkbenchState,
  DeviceView,
  LanView,
  PairingView,
  RoutineName,
  CallOutReason,
  CallOutFailKind,
  DispatchChoicesView,
  JobKind,
  TasksState,
  SessionView,
  WorkbenchProject,
  ScheduleRisk,
  NoteFrom,
  NoteReceiptKind,
  ExecutionRoleFact,
  CollabGoal,
  RunSegment,
} from '../protocol.ts'
import {
  isCapFamily, isJobKind, DEFAULT_ITEM_BUDGET,
  AGENT_IDS, DISPATCH_HANDS, LANDSCAPE_RAIL_MAX_PCT, LANDSCAPE_RAIL_MIN_PCT, LANDSCAPE_REGIONS,
  LANDSCAPE_SIDE_MAX_PCT, LANDSCAPE_SIDE_MIN_PCT,
  LAYOUT_MODULE_IDS, LAYOUT_ORIENTATIONS, MIN_BUTLER_H_PX, MIN_BUTLER_W_PX, ROUTINE_NAMES,
  TASK_PRIORITIES, TASK_STATUSES, WAIT_REASONS, isAgentDispatchFamily, isComposerMode, DISPATCH_FAMILY_TITLES, PERSON_ASSIGNEES,
  TASK_KINDS, TOPIC_CONTENT_TYPES, TOPIC_STAGES, CLIENT_DISPATCH_TITLES, isPublishDay,
  DEFAULT_TOPIC_STAGE, TOPIC_DOC_TABS, TOPIC_REVIEW_ACTIONS, publishPlanDescOf,
  feedNoteTextOf, feedTaskDescOf,
  DECK_REVIEW_ACTIONS, FEATURE_DOC_TABS, FEATURE_STAGES, isFeatureStage,
  sessionDisplayTitle, CALL_OUT_FAIL_KINDS, callOutFailKindOf,
  isReceiptKind, receiptStatus, statusPathTo, isAgentCardAssignee, STATUS_TITLES, isExecutionRole, executionRoleOf,
  isOwnerAskKind, OWNER_ASK_KINDS, ownerAskOf,
} from '../protocol.ts'
import type {
  DeckReviewAction, FeatureDocTab, FeatureDocView, FeatureReviewEntry,
  ItemSayIntent, TaskDispatch, TopicDocTab, TopicDocView, TopicReviewAction, TopicReviewEntry,
} from '../protocol.ts'
import { parseClaudeStatusLine } from '../quota/claude.ts'
import type { CredentialProvider } from './credentials.ts'
import { credentialStatus, defaultCredentialFile, isCredentialProvider, saveCredential } from './credentials.ts'
// 首次引导里「一键测试连接」(2026-11-12):判定与外发都在 credentialTest.ts,这里只收 key、送回人话。
import { testDeepSeekKey } from './credentialTest.ts'
import type { ModelService } from './modelService.ts'
import type { ModelAutoSetup } from './modelAutoSetup.ts'
import type { OnboardingWarm } from './onboardingWarm.ts'
import { progressMark } from './onboardingWarm.ts'
import { parseModelPatch } from './modelConfig.ts'
import type { SentinelInput, SentinelService } from './sentinel.ts'
import type { LoginProgress } from './webLogin.ts'
import { LOGIN_TARGETS, captureRefreshToken, closeProfileWindows, openLoginWindow } from './webLogin.ts'
import { fetchKimiWebUsageWithRefresh } from '../quota/kimiWeb.ts'
// Claude 额度「一键接上」(2026-10-03):工作台自己起那条命令、替她开浏览器,密钥直接进凭据库。
import type { ClaudeConnectIo, ClaudeConnectProgress, ClaudeConnectRun } from '../quota/claudeSetupToken.ts'
import { claudeQuotaWords, connectClaudeQuota } from '../quota/claudeSetupToken.ts'
import { attachTranscriptDetails, parseHookEvent } from './hooks.ts'
import { extractClaudeDetails } from './transcript.ts'
import { APP_COMMANDS, activateApp } from './apps.ts'
import type { RingActive } from './ringActive.ts'
import { listRings, pruneRings, startRing, stopRing } from './ringActive.ts'
import type { WorkbenchService } from './service.ts'
import type { ProjectsService } from './projectsService.ts'
// 引导里的「真去扫一遍仓库」(2026-09-20):把项目区已经算好的那份翻译成电话里念得出来的清单。
import { dayVerdict, workdaysBetween } from './holidays.ts'
import { LOCATE_FALLBACK_CANDIDATES, scanResultOf, type OnboardingScanResult } from './onboardingScan.ts'
import {
  BRANCH_REFUSAL, BRIEF_NOTE, READ_CONSENT_NOTE, briefPathKey, createBriefReuse, createSurfacedPaths, projectNameOf, readProjectBrief,
  resolveBriefPath, type BriefIo, type ProjectBrief,
} from './projectBrief.ts'
import { createRiskWatcher, decorateRisk } from './scheduleRisk.ts'
import { createWorkTypesStore } from './collabTypes.ts'
import { createCollabRoutes, placeSession, runSegmentsOf } from './collabRoutes.ts'
import type { CollabRelay, RelayLink } from './collabRelay.ts'
import { createCollabRelay } from './collabRelay.ts'
import { createCollabRelayRoutes } from './collabRelayRoutes.ts'
import { createAvatarStore } from './collabAvatars.ts'
import { createCollabAvatarRoutes } from './collabAvatarRoutes.ts'
import { defaultRelayInboxFile } from './relayInbox.ts'
import { createPresenceBoard, presenceOfJob } from './collabPresence.ts'
import { boardCanvasFile } from './collabCanvas.ts'
import { sessionProposals, singleOpenGoal } from './collabProposals.ts'
import { goalRisks } from './collabRisk.ts'
import { PERSONAL_TOKEN_PREFIX, type PersonalTokens } from './personalToken.ts'
import { dispatchGate, noteGate } from './noteGate.ts'
import type { GitHubDevice } from './githubDevice.ts'
import type { McpSecrets } from './mcpSecrets.ts'
import { createTimerRunner } from './collabTimers.ts'
import type { HelperChannel, HelperRequest } from './helperChannel.ts'
import type { AgentDiscovery } from './agentDiscovery.ts'
import { etagMatches } from './agentIcons.ts'
// 坞上每一格的图标(2026-09-26,卡 LG2):键 → 包标识只在服务端换算,见 appIcons.ts 的文件头。
import { resolveDockApp } from './appIcons.ts'
import type { SessionChildren } from './sessionChildren.ts'
import type { CallState } from './callState.ts'
import {
  CLIENT_DISPATCH_SOURCES,
  clientDispatchSource,
  createDispatchMatcher,
  submitForSource,
} from './dispatchClient.ts'
import type { ClientDispatchSource } from './dispatchClient.ts'
/*
 * ★ **派活送话后面是引擎**(2026-10-02,卡「引擎接线与删复制品」)。
 * `dispatchClient.sendOnce` + 外面那一圈换包全删了 —— 挑包、拉起来、叫台前、开窗重试、存草稿、
 * 打字发送、读窗核实都在 `engine/adapters/window.ts` 一处,闸与账在 `engine/engine.ts` 一处。
 */
import { createClientDispatch } from './dispatchSend.ts'
/** 「这件事的键」只有一处定法(`jobKey.ts`):有事项用事项 id,没有就用会话键 / 这一条自己的 id。 */
import { SESSION_JOB_PREFIX, SETTLED_TASK_STATUS, jobPhaseOf, legacySessionOfJob, relayWaitJobId, sessionOfJob } from './jobKey.ts'
import type { JobKeyTask } from './jobKey.ts'
import type { Engine } from './engine/engine.ts'
import { READ_SEEN_EVIDENCE } from './engine/adapter.ts'
import type { AdapterRegistry } from './engine/registry.ts'
import type { FamilyLanes } from './familyLanes.ts'
import { resetFamily } from './familyReset.ts'

/*
 * ★ **「包标识 → 家名」只问家族目录一处**(2026-10-02,接线那张卡;审计第二表第 9 条)。
 *
 * 这里原来有一张 `FAMILY_BY_BUNDLE` 反查表,是从 `CLIENT_DISPATCH_BUNDLES`(只有**主包**)拼的 ——
 * 于是同一件事两份答案:`relayAgentName` 只认主包(Air 上 `com.work.pc.doubao` 认不出是豆包),
 * 而 `relayFamilyOf` 先问 `bindingForBundle`(认一家的**全部**包)。
 * 两份都删,只剩 `agentSources.bindingForBundle` 那一处(它本来就认全部包)。
 */
import { saveClientDraft } from './clientDrafts.ts'
import { CLIENT_KEY_PATHS, clientKeyOf, createClientKeyLedger, type ClientKeyBegin, type ClientKeyLedger } from './clientKeys.ts'
import type { Orchestrator } from './orchestrator.ts'
import type { ScenesService } from './scenes.ts'
import type { TemplateService } from './templateStore.ts'
import { withFallbackTemplateModules, withLayoutTitles } from './templateStore.ts'
import type { CustomModulesService } from './modules.ts'
import { isModuleId } from './modules.ts'
import type { UserLayerService, UserLayerSkill } from './userLayer.ts'
import { FAMILY_PLUGINS, USER_LAYER_FOLDERS, WIDGET_SLOTS, scanUserLayerSkills, userLayerFixBrief } from './userLayer.ts'
import type { ModuleOriginServer, ModuleTokens } from './moduleOrigin.ts'
import {
  MODULE_TOKEN_PREFIX, createModuleTokens, isModuleApiAllowed, startModuleOriginServer,
} from './moduleOrigin.ts'
import type { DevToolSketch, DevToolStore } from './devTool.ts'
// 进化循环（2026-09-22，卡 ⑥）：发现重复 → 提议固化 → 她点头 → 走现有三条路 → 留痕可撤。
// 判据、阈值、全部纯函数与那个服务都在 server/evolve.ts —— 这里只接线与开门。
import type { EvolveService } from './evolve.ts'
// 他的规矩(2026-09-24 晚,卡 K;docs/设计-全局自进化-2026-09-24.md):一张表、四个时刻。
// 判据与那几段字全在 server/rules.ts,这里只接线与开门。
import type { RulesService } from './rules.ts'
import { REVIEW_FILE_MAX_BYTES, explicitRuleOf, withDispatchRules, workAreasOf } from './rules.ts'
// 集中改提示词那一页(2026-10-01):覆盖层与写回全在 server/promptsPage.ts,这里只接线与开门。
import type { PromptsService, PromptsWriteResult } from './promptsPage.ts'
import {
  BUTLER_RULE_CHANNELS, isAgentDispatchFamily as isRuleFamily, isButlerRuleArea,
  type ButlerRuleArea, type ButlerRuleChannel, type ButlerRuleReviewView,
} from '../protocol.ts'
import type { CollectorsService } from './collectors.ts'
import type { DispatchSkillLibraryView } from '../protocol.ts'
import { EVOLVE_WAYS, registryOnlySession } from '../protocol.ts'
import {
  DEV_TOOL_ACCEPT_EVERY_MS, NO_CODER_FOR_MODULE, checkModuleName, devToolAcceptNote, devToolBrief,
  devToolRestate, isDevToolRequest, newModuleId,
} from './devTool.ts'
// 用自然语言改布局(2026-09-22):词表在 src/layoutWords.ts、映射在 src/layoutActs.ts,
// 待确认那一条落盘在 server/layoutAsk.ts。三个文件都不碰 I/O 以外的东西,这里只接线。
import type { LayoutAskStore } from './layoutAsk.ts'
import type { LayoutActApplied } from '../layoutActs.ts'
import { applyLayoutActs, parseLayoutActs } from '../layoutActs.ts'
import { LAYOUT_DONE_LINE, LAYOUT_MAX_TITLE, isLayoutUndoWord, parseLayoutWords } from '../layoutWords.ts'
import { templateModuleTitle } from '../templates.ts'
import { localDayOf, todayTodosOf } from '../todayTodos.ts'
import type { XhsService } from './xhsCreator.ts'
import type { XhsCollectApi } from './xhsCollect.ts'
import type { AppsRegistry } from './appsRegistry.ts'
// 2026-09-17「每个区域单独解锁」:扫到哪几家、接上哪几家;模型从哪儿来。两者都只在生产注入。
import type { ClientScan } from './clientScan.ts'
// 「本机装了哪几家 AI」的单一真相(2026-09-27,卡 HC)。
import type { InstalledAgentScan } from './installedAgents.ts'
import { shownAgentIds } from './installedAgents.ts'
import type { ModelModeReader } from './modelMode.ts'
// 中转上配了哪几家上游(2026-09-26,卡 GH):配了哪家才出现哪家。只在生产注入。
import type { RelayProvidersReader, RelayProvidersView } from './relayProviders.ts'
import type { DockService } from './dock.ts'
import type { BriefService } from './brief.ts'
import { localDateStr } from './brief.ts'
import type { DailyService } from './daily.ts'
import type { LayoutSnapshotService } from './layoutSnapshot.ts'
import { renderLayoutSnapshot, snapshotInputOf } from './layoutSnapshot.ts'
import { MEETING_SEGMENT_MAX_BYTES } from './meeting.ts'
import { draftMeetingPlan, looksLikeMeetingPlan } from './meetingPrep.ts'
import type { MeetingService } from './meeting.ts'
import type { CreateTaskInput, TasksService, UpdateTaskInput } from './tasks.ts'
import { sanitizeDeliverables, TasksFileUnreadableError } from './tasks.ts'
// 演示数据那两条(2026-10-13):哪几条数据、怎么放、怎么清都在那个文件里,这里只接线。
import { clearDemoData, seedDemoData } from './demoSeed.ts'
import { effortFor } from './butlerEffort.ts'
import type { ButlerSessionOpener } from './butlerItem.ts'
import { BUTLER_NO_SESSION_NOTE, butlerSayFailureOf, butlerConversation, butlerFirstMessage, butlerItemFields } from './butlerItem.ts'
import type { ButlerBriefFacts } from './butlerBrief.ts'
import { butlerSkillForItem } from './butlerBrief.ts'
// 「随手问一句不算一件事」(2026-09-25,卡 Y):会话收场那一判;「接着说算同一件」随旧路删(A#22)。
import { CASUAL_ASK_NOTE } from './casualAsk.ts'
import { deriveButlerInbox } from './butlerInbox.ts'
import type { DigTurn, FeedService } from './feed.ts'
import { DIG_MAX_TURNS, digConclusionPrompt, digPrompt } from './feed.ts'
import type { FeedDigContext } from './feedDig.ts'
import type { AidjService } from './aidj.ts'
import type { NotesService } from './notes.ts'
import type { GraphifyService } from './graphify.ts'
import type { ArchifyService } from './archify.ts'
import type { RevealService } from './reveal.ts'
import { TOPIC_DIR, appendTopicSource, ensureTopicDir, listTopicAssets, topicDirOf } from './topicAssets.ts'
import { validateTopicReview, writeTopicReview } from './topicReview.ts'
import {
  TOPIC_CONFIRM_TAB, TOPIC_STAGE_TAB, appendTopicReview, buildTopicReviseMessage, buildTopicRunPrompt,
  topicConfirmPoints, topicConfirmed,
  readTopicDocs, readTopicReviews, saveTopicDoc, stageNeedsRelay,
} from './topicRun.ts'
import {
  FEATURE_DOC_FILES, FEATURE_STAGE_TAB, appendFeatureReview, appendDecisionRecord, buildFeatureReviseMessage,
  FEATURE_CONFIRM_TAB, buildFeatureRunPrompt, featureConfirmPoints, featureConfirmed,
  featureDirOf, featureStageOfTask, parseDecisionEntry, readFeatureDocs,
  readFeatureRecordDraft, readFeatureReviews, recordDay, saveFeatureDoc, stageNeedsHands,
} from './featureRun.ts'
import type { ConfirmPoint } from './confirmPoints.ts'
import {
  ACCEPTANCE_SECTION_TITLE, CONFIRM_SECTION_TITLE, acceptanceLines, applyConfirmSections,
  buildConfirmPoints, changedIndexes, confirmTrace, formatConfirmBlock, isSimpleErrand, parseConfirmPoints,
  spokenConfirmBlock, spokenSimpleConfirm,
} from './confirmPoints.ts'
import type { RunCommand as RunInCwd } from './featureResult.ts'
import {
  collectChangedFiles, listFeatureResults, probeTestScript, resultFileOf, runProjectTest, writeFeatureResult,
} from './featureResult.ts'
import {
  branchOfFeature, detectSelfProject, featureSlug, notesFromRequirement, worktreeOfFeature,
} from './selfUpdate.ts'
import type { SelfShipDeps } from './selfShip.ts'
import { prepareSelfBranch, runSelfShip } from './selfShip.ts'
import { linkWorktreeNodeModules, nodeWorktreeDepsIo } from './worktreeDeps.ts'
import type { SelfShipFollowUp } from './selfShipFollowUp.ts'
import type { QuotaAlerts } from './quotaAlerts.ts'
import type { QuotaSpendTips } from './quotaSpendTips.ts'
import type { HighlightService } from './highlight.ts'
import { actorOfRequest, pointNote, withActorNote } from './actorNotes.ts'
import type { ActorTokens } from './herself.ts'
import { isDisplayStateWrite, notButlerOrHerself, notHerself, whoIsAsking, type Asker } from './herself.ts'
import type { PeakScheduleService } from './peakSchedule.ts'
import type { ButlerService } from './butler.ts'
import { BUTLER_PROBE_TIMEOUT_MS } from './butler.ts'
import type { ProcessHealth } from './processHealth.ts'
import type { ConnectorService } from './connector/service.ts'
import type { ChannelService } from './channel.ts'
import { CHANNEL_DEVICE_HEADER, CHANNEL_ROUTES, CHANNEL_ROUTE_HEADER, type ChannelCaller, type ChannelRoute } from './channel.ts'
import type { ChannelWorkerService } from './channelWorker.ts'
import type { LocalRoomView } from './localRoom.ts'
import type { DeviceDirectoryService } from './deviceDirectory.ts'
import type { FetchRoot, FetchScope, FileAskView, ProjectRef } from './fileFetch.ts'
import { FETCH_MAX_DEPTH, FILE_ACCESS_DENIED_NOTE, buildFileAsk, checkOfferFile, contentDisposition, createFileOffers, fetchKindOf, fetchMimeOf, fileWantHint, isAccessDenied, parseFetchRequest, planFileQuery, sha256OfFile } from './fileFetch.ts'
import type { FileDeliveryStore } from './fileDelivery.ts'
import { DELIVERY_WHY_NOT_FOUND, createFileDeliveryStore, deliveredNote, notDeliveredNote, sendFileNote } from './fileDelivery.ts'
import { createFileDeliveryPersist, defaultFileDeliveryFile } from './fileDeliveryFile.ts'
import type { DirectAnswerStore } from './directAnswer.ts'
import { createDirectAnswerStore } from './directAnswer.ts'
import { createDirectAnswerPersist, defaultDirectAnswerFile } from './directAnswerFile.ts'
import { answerToShow, answerWorthNotifying, answersCellOf, freshResultsOf } from '../answerCell.ts'
import { createChannelLatencyStore, latencySummary } from './channelLatency.ts'
import type { CallUtterance, RtcCallService } from './rtcCall.ts'
import { CALL_TOOL_DOING, CALL_TOOL_REMEMBER, RTC_CALLBACK_PATH, addressNameOf, callContextBlock, formatCallDuration, parseToolCalls } from './rtcCall.ts'
import { onboardingCallSummary, plainCallSummary } from './callSummary.ts'
import type { CallRecordsService } from './callRecords.ts'
import { maybeTodosOf } from './callRecords.ts'
import type { CallRecordItemDid, CallRecordItemLink } from '../protocol.ts'
import { CALL_RECORD_FROM_PREFIX } from '../protocol.ts'

/** 拖窗进槽:等壳把原生光圈亮起来最多多久,再告诉页面(见 helper.onEvent 那一段)。 */
const HOVER_NATIVE_WAIT_MS = 250
import type { RoutinesService } from './routines.ts'
import type { CallOutService } from './callOut.ts'
import { CALL_OUT_STOP_RING_ERROR, isCallRoom } from './callOut.ts'
// 「此刻能不能出声」那一处判断(2026-09-26,卡 QH)。/state.quiet 那一格由它算,别处不再算一遍。
import { quietViewOf } from './quietHours.ts'
import type { PairingService } from './devices.ts'
import { deviceKindOf } from './devices.ts'
// 「签票先核归属」与那句「已经从账号里移除了」(2026-10-03,卡 claude/device-revoke-complete)。
import { DEVICE_LEFT_ACCOUNT_TEXT, createDeviceAccountGate } from './deviceAccountGate.ts'
import { isAuthKey, type AuthorizationService } from './authorization.ts'
import type { AppearanceService } from './appearance.ts'
import type { OnboardingService, OpenSessionOptions, RestartScope } from './onboarding.ts'
import type { OnboardingTurnsStore } from './onboardingTurns.ts'
import { createOnboardingActivity, type ActivityWire } from './onboardingActivity.ts'
import { RESTART_SCOPES } from './onboarding.ts'
import type { Exchange } from './onboardingConsent.ts'
import { NO_INTERNAL_TALK, approvesSetup, guardAnswer, lastExchange, unansweredAsked, wantsToMoveOn, wantsToSkipRest } from './onboardingConsent.ts'
import type { OnboardingStage } from './onboardingStages.ts'
import { FILE_ACCESS_WHY, FULL_PLAN, requiredKeys, stageDef, SYSTEM_AUTH_WHY } from './onboardingStages.ts'
import type { AppConfig, AppConfigService } from './appConfig.ts'
import type { AccountService } from './account.ts'
import { attachDeviceToAccount, isServerAccount } from './serverAccount.ts'
import {
  SESSION_TTL_MS, accountCookieHeader, clearedAccountCookieHeader, tokenFromCookieHeader,
} from './account.ts'
import type { WbHooksAgent } from './hooksConfig.ts'
import { wbHooksInstructions, wbHooksRender, wbHooksResolveRepoRoot } from './hooksConfig.ts'
// 钩子脚本随插件走(2026-09-25 卡 R):同步到 ~/.dsh/workbench/hooks/,命令只指那里,不找仓库。
import { fileURLToPath } from 'node:url'
import type { WbHookScripts } from './hookScripts.ts'
import { createHookScripts } from './hookScripts.ts'
// 钩子由工作台代写(2026-09-17):POST /config/hooks/apply|revert。
import { WB_SKILL_DISPATCH, wbHooksApply, wbHooksRestartHint, wbHooksRevert, wbSkillApply, wbSkillRevert, wbOpsSkillsApply } from './hooksApply.ts'
// 电话里攒下的那两段人设(2026-09-23):称呼表与长期偏好,写进 ~/.dsh/AGENTS.md 的标记段。
import { CALL_ADDRESS_BLOCK, CALL_PREFS_BLOCK, appendToMarkedBlock, listInMarkedBlock } from './memoryMd.ts'
// 派活给别家 Agent(2026-09-21,参赛冲刺卡 ④):技能正文、本机 CLI 探测、目录门、进度那句话。
import { dispatchCwdAllowed, dispatchFamilyOf, dispatchNote, dispatchSkillBody, mentionsDispatchFamily, resolveAgentCli } from './agentDispatch.ts'
import { API_DISPATCH_FAMILIES, apiDispatchFamilyOf, createApiDispatch } from './dispatchApi.ts'
import type { DispatchRunDeps, DispatchStartResult } from './dispatchRun.ts'
import { createDispatchRunner, worktreeSlugOf } from './dispatchRun.ts'
import { createExecutionLeaseStore } from './executionLease.ts'
import { createExecutionStore } from './taskExecutionStore.ts'
import { discoverDoubaoCacheDirs, findDoubaoImage } from './doubaoImage.ts'
import { KLING_BUNDLE, KLING_FILE_RE, KLING_LOG, pickFreshKlingFile, runKlingStep, waitKlingVideo } from './klingStep.ts'
import { createVideoChain, videoChainPlan } from './videoChain.ts'
// 一句话排进发布计划(2026-10-13,卡「座机一句话记发布计划」):认话 + 日子 + 回话那一句。
import {
  PUBLISH_PLAN_ASK_DAY, PUBLISH_PLAN_ASK_SUBJECT, parsePublishDay, publishPlanAlreadyReply, publishPlanConfirmLine,
  publishPlanOf, publishPlanReply, publishPlanTitleOf, samePublishPlanOn,
} from './publishPlan.ts'
/**
 * ★ **一个「听懂」入口**(2026-10-13,卡「三个入口一套管线」):`/butler/understand`(电话工人每句先问它)、
 * `/confirm/points` 共用。2026-10-29 删规矩第一批:文字入口(/butler/say、/butler/item)不再调它 ——
 * 一律进理解中枢;四张专项词表只剩电话这一条缝在用,随工人那条缝的改造再下线(交接注明)。
 */
import { looksLikeProductRequirement, understand, type UnderstandContext, type Understanding } from './understand.ts'
/** 补细节只认紧跟着那件事之后的第一句(2026-10-13 晚,卡 P):数的那道闸在 `followUp.ts`。 */
import { createAppendGate } from './followUp.ts'
import { understoodTrace } from './understoodTrace.ts'
import { DEMO_APPEND_ON_CARD, DEMO_APPEND_ON_CARD_AND_PROMPT, demoAppendSay, demoTodayViewSameSay, demoTodayViewSay } from './demoPlaybook.ts'
import { progressOnCard } from './progressOnCard.ts'
import { CLI_FAMILIES, createCliAdapter, type CliAdapterDeps } from './engine/adapters/cli.ts'
import { createApiAdapter } from './engine/adapters/api.ts'
/** 动作闸 + 任务日志(2026-10-02,卡 AG):对别家 App 的自动动作一处放行,四步查得回来。 */
import { createActionGate } from './actionGate.ts'
import type { ActionGate, JobPhase } from './actionGate.ts'
import { createJobLog } from './jobLog.ts'
import type { JobEvent, JobLog } from './jobLog.ts'
import type { AgentCli, AgentCliProbe } from './agentDispatch.ts'
// 派活的眼睛(2026-09-25,卡 O):能力体检、挑手、余额、每件事的上限与「停掉这一件」。
import type { AgentCaps, CapCliFact } from './agentCaps.ts'
// CODE_CLI_FAMILIES / hasCodeCli 的唯一定义在 protocol.ts(卡「名片编辑表单重排」挪过去的),这里引协议那份。
import { CODE_CLI_FAMILIES, hasCodeCli } from '../protocol.ts'
import type { OpenQuotaFamily, QuotaAdapterContext, WindowQuotaReader } from './agentQuota.ts'
import { openQuotaFamilies, quotaCheckSaid, quotasFor } from './agentQuota.ts'
import type { Division } from './dispatchChoice.ts'
import { dispatchChoices, dispatchUsesWindowHand, divisionOf, familiesIn, jobKindOf } from './dispatchChoice.ts'
import type { DispatchPrefsService } from './dispatchPrefs.ts'
import { canReadSkills, checkSkillNames, DISPATCH_SKILLS, findSkillsRoot, installSkills, skillsUnreadableWhy } from './dispatchSkills.ts'
import type { CallAskPick, CallAskView } from './callAsk.ts'
import { callAskVerdict, isCallAskFor } from './callAsk.ts'
import type { DispatchTarget } from './dispatchTargets.ts'
import { allowBundlesOf, dispatchReadiness, dispatchTargets, isDispatchTarget, targetTitle } from './dispatchTargets.ts'
import { relayHasProviderFor } from './relayProviders.ts'
import type { UnreadableApp } from './dispatchTargets.ts'
import { appBundleNameOf, bindingFor, bindingForApp, bindingForBundle, openCommandFor, FAMILY_SOURCES, packagesOf } from './agentSources.ts'
import type { BudgetStore, ItemBudget, OuterAsker } from './itemBudget.ts'
import { choiceOnlyAsk, createItemBudget } from './itemBudget.ts'
import { BUDGET_STUCK_UNKNOWN } from './budgetPolicy.ts'
import type { DshSessionUsage } from './dshSessionFeed.ts'

/** 技能正文在仓库里的位置。**一处写死**:GET /config/skill 与两条写路读的是同一份。 */
const DISPATCH_SKILL_DOC = 'docs/技能/派活给别家Agent.md'
import type { WbHooksApplyIo } from './hooksApply.ts'
// 「全部接上」(2026-09-25):Claude、Codex 一次看、一次点;真写的仍是 wbHooksApply。
import type { ConnectAllDeps } from './quotaConnect.ts'
import { connectAllApply, connectAllPreview, quotaConnectStatus } from './quotaConnect.ts'
// 运营技能包(2026-09-21):清单与模板闸在 opsSkills.ts,写盘走 hooksApply 那一套备份纪律。
import { WORDLIST_REL, bundledSkillDoc, bundledWordlistFile, pointServiceAt, pointWordlistAt, readSkillDoc, skillBodyFile } from './bundledSkills.ts'
// 技能正文里的 `{{工作台地址}}` 渲成这台服务真在听的地址(2026-09-26,卡 SP)。
// 跟页面那一半(卡 GP 的注入表)同一个算法、同一个回环收敛规矩 —— 两处算法不同就是两个端口。
import { serviceBaseUrl } from '../serviceOrigin.ts'
import { OPS_WORDLIST_DOC, opsSkillDoc, opsSkillsAttachState, opsSkillsForTemplate } from './opsSkills.ts'
import type { OpsSkillDef, OpsSkillsAttachState } from './opsSkills.ts'
import {
  WB_PATHS_RESTART_REQUIRED_HINT,
  wbPathsDefaults,
  wbPathsDirsToCheck,
  wbPathsEffective,
  wbPathsParsePatch,
  wbPathsRestartRequired,
} from './pathConfig.ts'
import type { SetupService } from './setup/service.ts'
import { createSetupService } from './setup/service.ts'
import { createDiagService, type DiagService } from './diagnostics/service.ts'
import { diagCode } from '../diag.ts'
// 本体的毛病反馈给开发者(2026-09-28 卡 FB)。分流的判据是纯函数(src/productFeedback.ts),
// 落盘 + 发出去那一半在 diagnostics/feedback.ts —— 走的是自动上报同一条路、同一道脱敏。
import { createFeedbackService, defaultFeedbackFile, type FeedbackService } from './diagnostics/feedback.ts'
import { FEEDBACK_REPLY_LINE, feedbackNote, triageRequest } from '../productFeedback.ts'
import { nodeDiagIo } from './diagnostics/io.ts'
import { loadModelConfig, RELAY_LINK_NO_RELAY } from './modelConfig.ts'
import { nodeSetupIo } from './setup/io.ts'
import { createCodexHookTrustProbe } from './codexHookTrust.ts'
import { askCodexAppServerOnce } from './engine/adapters/codexAppServerClient.ts'
import { setupPaths } from './setup/paths.ts'
import { isSetupInstallStep, isSetupPane } from './setup/types.ts'
import { createRuntimeRepair, type RuntimeRepairService } from './setup/runtimeRepair.ts'
import type { UpdateService } from './update/service.ts'
import { createUpdateService } from './update/service.ts'
import { appJsonChannelStore } from './update/channel.ts'
import { isUpdateChannel, type UpdateCheckView } from './update/types.ts'
import { loadEndpoints, UPDATE_NOT_CONFIGURED } from './endpoints.ts'
import { DEFAULT_SCAN_ROOTS } from './projectsService.ts'
import { PLUGIN_VERSION } from '../version.ts'
import type { MdnsAdvertiser } from './mdns.ts'
import { lanAddress as defaultLanAddress, pairQrContent } from './lan.ts'
import { peakPhase } from '../quota/peakHours.ts'
import { createHandoffPerfLog, parseHandoffPerf } from './handoffPerf.ts'
import { createExecutionReconciler, executionOverview } from './executionState.ts'
import { COLD_PARSE_PER_BEAT } from './codexExecutionFacts.ts'
import {
  PLAN_ONLY_DISPATCH_ERROR, approvalViews, attachmentIds, composerAgents, composerOptions, composerTail, modeOfTask,
  DISPATCH_APPROVAL_PREFIX,
  modelTakesImages, composerModels, refInputs, refLines, submitForMode,
} from './composer.ts'
import type { ApprovalBroker, ComposerService, ResolvedAttachment } from './composer.ts'
// 事务官要问的话、要批的事摆到外层(2026-09-25,卡 M)。
import { QUESTION_ASK_KEY, askCallOutEvents, askNotice, grantTaskAlive, grantViews, questionViews, spokenOptionOf, voiceAnswerFor, voiceVerdict, type ApprovalGrants, type QuestionBroker } from './butlerAsks.ts'
// 某家会话自己弹的那个框:台账上的 item_id 认这一路(2026-09-28,卡 WQ)。
import { isSessionAskItem, sessionAskCallOutEvents, sessionAskItemId, sessionAskSessionId } from './sessionAskCalls.ts'
import { sessionAgentName, waitingOnHim } from '../waiting.ts'
// 事务官捎话给**任何一条**会话(2026-09-26,卡 BR):认出他点名那一条 + 送进去那句话的记号。
import { matchRelaySession, relayReadMark } from './sessionRelay.ts'
import type { RelaySessionView } from './sessionAnswer.ts'
import { lookupSession } from './sessionLookup.ts'
import { matchSpokenFamily, spokenFamilies, type SpokenFamily } from './spokenFamily.ts'
import type { RelayFrom, RelayWatchService } from './relayWatch.ts'
import {
  RELAY_PROMISE_CALL,
  RELAY_PROMISE_CALL_UNSURE,
  RELAY_PROMISE_NOWATCH,
  RELAY_PROMISE_NOWATCH_UNSURE,
  relayLedgerLineOf,
} from './relayWatch.ts'
/** 「这一刻电脑锁着屏没有」那一拍(2026-10-03,卡「锁屏时窗口型的家送不进」)。 */
import type { ScreenLockWatch } from './screenLockWatch.ts'
/** ★ 巡登记表那一拍(2026-10-23,卡「捎话到没开着的会话留言等它醒」)。 */
import type { SessionAwakeWatch } from './sessionAwakeWatch.ts'
/** 没名字的会话借挂着它的那张卡的标题(2026-10-23)。 */
import { withCardTitles, syncBorrowedCardTitles } from './sessionTitleFallback.ts'
import { continueFactOf, continueSourcesOf, intentPlanOf, intentReceiptOf, intentUnsupportedWhy, parseItemSayIntent, resolveContinueTarget, type ContinueEnv } from './itemContinue.ts'
import { cliDispatchSessions, cliDispatchSessionCwd } from './cliDispatchSessions.ts'
import { readKimiCliSession, safeCliSessionId, locateCodexCliSession, locateKimiCliSession, createKimiExecutionLocator, createCodexExecutionLocator } from './cliSessionRead.ts'
import { createCodexRolloutLookup } from './codexThreadIndex.ts'
import { createSessionTranscript } from './sessionTranscript.ts'
import { readHeadTail, readSessionDigest } from './sessionDigest.ts'
import { createSayBook } from './hub/reply.ts'
import { hubContext, hubExecute, hubSay, type HubFacts, type HubRunDeps } from './hub/run.ts'
import { askIfAmbiguous } from './hub/understand.ts'
import type { HubCommand } from './hub/commands.ts'
import { CALL_HUB_BAD_OUTPUT, CALL_HUB_UNREACHABLE, callReplyOf, hubEntranceOf } from './hubEntrances.ts'
import type { HubEntrance, HubHand } from './hub/context.ts'
import { DEFAULT_ACCEPTANCE_EXTRACT_SYSTEM, VERIFY_SYSTEM, createArtifactCheckDeps } from './dispatchVerify.ts'
import { createTaskDelivery } from './taskExecutionDelivery.ts'
import { sayCardsOf } from './sayCards.ts'
import { missingCardSayLine, reassignSayLine, REASSIGN_SETTLED_TAIL } from './sayTarget.ts'
/** 那条会话没开着时留言的那一句(2026-10-23)。 */
import { SESSION_CLOSED_QUEUED_SAY } from './sessionClosed.ts'
import type { AwayAwakeWatch } from './awayAwake.ts'
import { relayIntoNewConversation } from './relayNewConversation.ts'
// 「执行 n」全工作台一个数、页面自己报错的那个盒子(2026-09-25,卡 V)。
import { runningNow } from '../running.ts'
// 球此刻的样子(2026-10-04,卡「球的颜色一处算」):一处算、两端只显示(src/orbCell.ts)。
import { orbCellOf } from '../orbCell.ts'
import { PHONE_CELLS } from '../phoneCells.ts'
import { createClientErrorStore } from './clientErrors.ts'
import { plainForHim, stateForHim } from '../plainText.ts'
import type { SessionAnswerService } from './sessionAnswer.ts'
/*
 * ★ **日志那几行不在这个文件里了**(2026-10-02,卡「引擎接线与删复制品」;审计第二表第 17 条)。
 *
 * 这里原来有 11 处各自手拼的 `[answer]` / `[relay]` / `[approval]` / `[dispatch]` 行(还各带一个
 * `logStampOf` 的时间与 `frontTraceText` 的尾巴),于是:只盯不发、去回答两路一个字不记;
 * 电话里点一个普通选项也记成 `[approval]`;改一处措辞要改十一处。
 * 现在**每一次送话的结局由引擎记一行**(`engine.ts` 的 `ENGINE_LOGGED_STEPS`),这里一行都不拼。
 */
import type { ButlerOpenExtras } from './butlerItem.ts'
import type { MaterializeService } from './materializeService.ts'
import type { CardOwner } from './materialize.ts'
import type { SessionDigestService } from './sessionDigestService.ts'
import type { SessionLibrary } from './sessionLibrary.ts'
// 固定入口那一档的上限(2026-10-03):`?per_family=` 超了就 400,说清是 1 到几。
import { PER_FAMILY_MAX } from './sessionHistory.ts'
// 一件事一份、进度靠证据(2026-09-25,卡 N)。
import type { ProgressService } from './progress.ts'
import type { DispatchChoicesLike, ItemDriver } from './itemDriver.ts'
import { createItemDriver } from './itemDriver.ts'
import { itemMover } from './itemMover.ts'
import { itemStanding } from './itemStanding.ts'
import { appendDetail, appendSaid } from './itemIdentity.ts'
import { BEHAVIOR_EVENTS, approvalNoteOf, behaviorEndOf, parseBehaviorQuery, questionPickOf, reviewResultText, taskMoveNoteOf } from './behaviorLog.ts'
import type { BehaviorEnd, BehaviorInput, BehaviorLog } from './behaviorLog.ts'
import { dispatchClassOf, GRANT_REVOKED, type HabitService } from './habits.ts'
import { revisionNoteOf, revisionStyleOfDiff } from './styleHabits.ts'
import { DEFAULT_COMPOSER_MODE, isTaskAssigneeValue } from '../protocol.ts'
import type { SessionView as ItemSessionView, TasksState as ItemTasksState } from '../protocol.ts'
import type { SessionPlaced, SessionProposal } from '../protocol.ts'
import { TODAY_VIEWS, TODAY_VIEW_TITLES } from '../protocol.ts'
import type { TodayViewStyle } from '../protocol.ts'
import {
  DELEGATE_DEFAULT_TEXT, EXPERIMENT_OFF_LINE, FIRST_USE_SAY, audienceOf, experimentOfUnderstanding, experimentsOf,
  firstTryOf, isExperimentKey, isMainPath, windowDispatchExperiment, type ExperimentKey, type ExperimentsView, type FirstUseView,
} from '../mainPaths.ts'
import { PROTOCOL_FAMILIES, podcastDoor, type FirstUseService, type ObserveInput, type Readiness, type SelfCheckPorts } from './firstUse.ts'

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 8791
/** 未指定时的响铃巡检间隔。响铃靠"等待时长"触发，没有新事件也得有人掐表。 */
const DEFAULT_TICK_MS = 1000

/** 自检里派出去的那一句(设计稿:读本机项目列表写一段话,走协议路)。只读,不改文件。 */
const SELF_CHECK_DELEGATE_TEXT = '自检:看一下这台电脑上有哪些项目(工作台项目区里那几个,或你当前目录下的文件夹),用一段话介绍它们各在做什么。只读,不改任何文件,不超过 200 字。'
/** 自检等通话工人进房间:每 2 秒看一眼,最多 15 次(半分钟)。 */
const SELF_CHECK_WORKER_WAIT_TRIES = 15
const SELF_CHECK_WORKER_WAIT_MS = 2000
/** 三件主路从现成记录里看一眼的间隔(挂在既有那根节拍上)。 */
const FIRST_USE_OBSERVE_MS = 10_000

/**
 * `/state` 里带几通来电记录(2026-09-21)。快照每秒发一遍给手机与展示台,
 * 整本台账(最多 200 通)塞进来是白花的带宽;面板上要看的本来就只有最近几通。
 * 全本在 `GET /call/log`。
 */
const STATE_CALL_OUT_MAX = 20
/**
 * 「🔔 试铃」排的那一通挂在哪件事上(2026-09-23)。
 *
 * **一个固定的假 id,不借用看板上真的那一件**:`callOut.request` 排完会把
 * `confirm:<item_id>` 记进 `seen`(「只打一次」那道门),借真卡的话,那件事真轮到
 * 要响的时候就被这次试铃吃掉了 —— 试一次铃,少一通真电话。
 *
 * 代价写在明处:接起来之后她那句 `wb_decide_item` 落不到任何一张卡上(本来也不该落)。
 */
const TEST_RING_ITEM_ID = 'ring-test'
/** 电话里念的那一句、手机来电页上那一行。就叫它本来的名字。 */
const TEST_RING_TITLE = '试铃'
/**
 * 心跳周期。展示台那边的看门狗按 60 秒判死，取三分之一，掉一两拍不会误杀。
 * 别调大到接近 60 秒：那样一次丢包就够触发一轮没必要的重连。
 */
const DEFAULT_HEARTBEAT_MS = 20_000

/**
 * 一条 /live 连接的发送缓冲攒到这么多字节就先不往里堆(2026-10-19)。
 * 8MB ≈ 二十几份快照:正常的页面几毫秒就收完,只有卡住的对端才会攒到这个数。
 */
export const LIVE_SEND_BUFFER_MAX_BYTES = 8 * 1024 * 1024
/** 跳过那一行日志的行首(一条连接只记一次)。 */
export const LIVE_SKIP_LOG_TAG = '[live] 跳过一条收不动的连接'
/**
 * 用量刷新周期(2026-08-31 风暴修复,标签时灵时不灵一案):原来挂在 1 秒 tick 上,
 * "上一轮没完就跳过"在真机上等于一轮接一轮连轴转——~/.codex/sessions 已 4.6GB,
 * 磁盘被扫描持续打满,叠上每 30 秒的项目区 git 扫描,把 /dock/switch 实测拖到 3–15 秒。
 * 用量面板的数字迟一分钟无所谓(Ben 拍板),降到独立的分钟级节拍。
 *
 * 2026-10-12 降到 10 秒(运营同学 10-09 那一条「实时记录」,卡 `claude/ops-patch-1012`):
 * 08-31 那场风暴的根子是 Codex 那一家**每轮整份重读**;同一张卡把它改成了增量追读
 * (`usage/collector.ts` 的 `ingestCodexFile`),一轮只剩 stat 遍历 + 新追加的那几行,
 * 10 秒一轮的代价与原来 60 秒一轮相当。
 */
const DEFAULT_USAGE_INTERVAL_MS = 10_000

const STATUSES: readonly SessionStatus[] = ['waiting', 'running', 'done', 'error', 'offline']
const EVENT_REASONS: readonly EventReason[] = [
  'permission_prompt', 'idle_prompt', 'stop', 'error', 'interrupted', 'offline',
]

/** 放完演示数据之后等早报多久,还没回就算「在跑了」(一份早报要搜资讯、问模型,不能让她按着键干等)。 */
export const DEMO_MORNING_WAIT_MS = 2000

/**
 * 放完演示数据顺手跑一遍早报(2026-10-13):**不等它跑完,但要等得够久以分出「接下了」与「拒了」**。
 *
 * `routines.run` 的 promise 要等整条例程跑完才 resolve;而「这条例程正在跑」那一类拒绝是
 * **当场**就 resolve 的。所以这里等 {@link DEMO_MORNING_WAIT_MS}:这段时间里回话了就照它说
 * (多半是拒绝),没回话就是接下了、正在跑 —— 两种都不编一句话。
 */
export async function runMorningForDemo(
  routines: Pick<RoutinesService, 'run'>,
  waitMs = DEMO_MORNING_WAIT_MS,
): Promise<{ ok: boolean, reason?: string }> {
  const ran = routines.run('morning', 'manual').then(
    result => ({ ok: result.ok, ...(result.ok ? {} : { reason: result.reason }) }),
    (error: unknown) => ({ ok: false, reason: error instanceof Error ? error.message : String(error) }),
  )
  const started = { ok: true as const }
  return await Promise.race([ran, new Promise<typeof started>((resolve) => { setTimeout(() => resolve(started), waitMs).unref?.() })])
}

/** 等待原因(2026-09-09 拍板第 4 条)。会话上报与看板的阻塞原因共用这一份判断。 */
function isWaitReason(value: unknown): value is WaitReason {
  return typeof value === 'string' && (WAIT_REASONS as readonly string[]).includes(value)
}

/**
 * statusLine 命令自己还得负责打印状态栏，所以这个口子除了收额度，
 * 还要回一行现成的文本，脚本原样 echo 即可，不必自己算。
 */
function statusLineText(quota: { windows: readonly { label: string, left_pct: number }[] }): string {
  return quota.windows.map(window => `${window.label} ${window.left_pct}%`).join(' · ')
}

export interface WorkbenchServer {
  host: string
  port: number
  url: string
  /** 走一拍响铃判定并把结果推给所有订阅者。生产由定时器调用，测试里手动调。 */
  tick: () => void
  /**
   * 把当前快照推给所有连着的展示台。
   *
   * 额度是**采集**出来的，不像会话那样有 event 天然触发广播。不主动推的话，
   * 展示台要等下一次重连才看得到新数字——Ben 实报的「客户端已经 90%、展示台还挂着 91%」，
   * 一半原因就在这里（另一半是选错了会话文件）。
   */
  broadcastState: () => void
  /**
   * 立刻对一账(合并进在途那一拍;8791 第六轮第 3 轮)。读路(/state、/collab/*)一律不触发对账后,
   * 用例与排障靠这个显式口推进对账 —— 同 `jobLog` / `broadcastState` 那条「验收与排障要摸得到
   * 进程里的东西」的理由。不受事件节流(2 秒)限制。
   */
  reconcileNow?: () => Promise<void>
  /**
   * 当前连着的展示台条数。
   *
   * 上一轮排查最费时间的一件事就是「不知道到底有几条连接」——
   * 展示台那边曾经每掉一次线就把连接数翻倍，而两边都没有一个地方能数出来。
   */
  liveClients: () => number
  /**
   * /live 广播的两个计数(2026-10-19):`skipped` 收不动的连接被跳过了几次,`merged` 整块快照的广播合并掉了几次。
   * 用例与排障看;不进 /state。
   */
  liveStats: () => { skipped: number, merged: number }
  /** 「允许手机在局域网访问」那台 0.0.0.0 的监听现在开着没有(2026-09-11)。 */
  lanListening: () => boolean
  /**
   * 自定义模块那台单开来源的 origin(2026-09-22,C7)。没配 / 没起来就是 undefined ——
   * 这一档整块缺席(**不会退回同源**)。
   */
  moduleOrigin: () => string | undefined
   /**
   * 诊断服务(2026-09-22)。**露出来只为一件事**:index.ts 里那些比这台服务先造出来的
   * 东西(通话工人的看护)要能把故障报上来,而它们造出来的时候 `diag` 还不存在。
   * 所以 index.ts 的做法是:先给工人一个读可变变量的闭包,拿到 server 之后把这一格填进去。
   * 没启用(测试里那一大批)就是 undefined,那些闭包一律 no-op。
   */
  diag?: DiagService
  /**
   * 热更新服务(2026-09-23)。**露出来只为一件事**,与 `diag` 逐字同一条理由:
   * 「改自己」那条闭环的第 ⑧ 步要按一下更新,而那个按钮(`update.apply()`)
   * 是这台服务里面造出来的,`index.ts` 在把 `selfUpdate` 那两样传进来的时候还拿不到它。
   * 所以 index.ts 的做法是:传一个读可变变量的闭包,拿到 server 之后这一格就有值了。
   *
   * 没启用(没配 HOME / 那一大批用例)就是 undefined,那个闭包如实回一句"没启用"。
   */
  update?: UpdateService
  /**
   * 进程内派活口(2026-09-24,卡 F;卡 B「引导落地」派第一件用)。对一张**已经建好的卡**做和手机派活
   * 完全同一件事:新对话里送话 + 按发送 → 收回结果 → 挪「等我确认」,**不开 DSH 会话**。
   * 看板没接线时缺席。
   */
  dispatchItem?: (taskId: string, input: { family: AgentDispatchFamily, text: string, source?: ClientDispatchSource, kind?: JobKind, cwd?: string, cwdFixed?: boolean }) => Promise<DispatchStartResult>
  /**
   * 等到所有 fire-and-forget 的后台派发落定(2026-10-28,卡「从机制上修 dispatch-recovery-1027」)。
   * 直派那一支接口先回、派发后台跑;失败写卡 await 在派发那条链里,所以 drain 返回时卡上账已落。
   * 只给用例与排障用(同 `diag` 那一格的理由),生产路径不调用。
   */
  drainDispatches: () => Promise<void>
  /**
   * 这件活派给谁的选项表(2026-09-25,卡 O):是什么活、按规矩默认派谁、列全能做这件活的几家、各家还剩多少。
   * 卡 N「负责人驱动派活」在问「这张派给 X 开工?」之前调它。看板没接线时缺席。
   * (「事务官自己做」那一项 2026-09-28 拿掉了 —— 卡 BS2、设计 C1。)
   */
  dispatchChoices?: (taskId: string, input?: { kind?: JobKind, text?: string }) => Promise<DispatchChoicesView | undefined>
  /** 每件事的上限与「停掉这一件」(卡 O)。index.ts 的事项生命周期要问它「这一次被停了是不是我们停的」。 */
  itemBudget?: ItemBudget
  /**
   * 「要一份文件」那一类事项的**交付回执台账**(2026-10-04,卡 `claude/phone-file-send-loop`)。
   * index.ts 的事项生命周期在收尾那一刻问它一句:回执没到就不许 done、不许「只是问了一句」。
   */
  fileDelivery: FileDeliveryStore
  /**
   * ★ **把一条「问一句」的答案送到她面前**(2026-10-04,卡 `claude/answer-comes-to-her`)。
   * index.ts 的事项生命周期在收尾那一刻调它:记进回答账(两端的字幕 / 事务官页从 `/state.answers` 读),
   * 并弹一条**正文就是答案本身**的系统通知。**绝不抛**。
   */
  deliverAnswer: (input: { taskId: string, question: string, answer: string, sessionId?: string }) => void
  /**
   * 按证据核过再派(2026-09-25,卡 N):先核这张卡真到哪了,指令按证据写,不照调用方手里的旧话。
   * 引导落地的第一件走它。没起负责人驱动时缺席(调用方退回 `dispatchItem`)。
   */
  dispatchChecked?: (taskId: string, input: { family: AgentDispatchFamily }) => Promise<{ ok: boolean, note: string }>
  /**
   * 这本只追加的任务账(2026-10-24 协作区事实层):`index.ts` 传进来的就是这一本,全进程一份。
   * 露出来只为验收 / 排障 —— 用例要往运行中的服务记一条真实事件(presence、运行片段都听它),
   * 同 `diag` 那一条理由。
   */
  jobLog: JobLog
  close: () => Promise<void>
}

export interface StartWorkbenchServerOptions {
  /** 0 表示由系统分配空闲端口（测试用）。 */
  port: number
  /**
   * 「等你确认」只认她本人、发版要她点头那道门要的两把**进程令牌**
   * (2026-09-28,卡 BS;`server/herself.ts` 里有整段理由与那个还没关上的洞)。
   *
   * **缺席 = 一把都认不出来**:于是事务官与电话工人都落到「认不出来」上,
   * 那四个口只放页面 / 壳 / 配对设备过。
   */
  actorTokens?: ActorTokens
  /**
   * 停掉一次派活时怎么杀那个进程(2026-09-21)。缺省 `process.kill(pid, 'SIGTERM')`。
   * **用例必须注入**:默认那份会真的往本机进程发信号。
   */
  killProcess?: (pid: number) => void
  /**
   * 派活从头到尾由工作台自己跑(2026-09-24,卡 F,`server/dispatchRun.ts`)要的几样本机能力:
   * 起命令行进程、看 pid 还在不在、读结果文件、结果文件放哪。**缺席 = 命令行那只手不在**
   * (窗口与接口两只手照样能派)。用例注入假的,绝不在本机起真进程。
   *
   * `resolveCli`(2026-10-01 加的)= 「这台电脑上有没有那一家的命令行」。缺席照旧**现探这台机器**
   * (`resolveAgentCli`)—— 有这一格才写得出「与这台机器上装没装无关」的用例。
   */
  dispatchRun?: Partial<Pick<DispatchRunDeps, 'alive' | 'readFile' | 'pollMs' | 'headSha'>> & Partial<Pick<CliAdapterDeps, 'runCli' | 'envForCli' | 'resolveCli' | 'resultDir'>> & {
    /** 技能库在哪(卡 S;用例注入)。缺席 = 从这份代码往上找 `third_party/skills`,找不到就派不了带技能的活。 */
    skillsRoot?: string
    /** 执行租约用哪个存储(2026-10-26,卡「事务官机制D」;用例注入内存/临时文件件)。 */
    lease?: import('./executionLease.ts').ExecutionLeaseStore
    /** 租约文件落点(缺席 = `~/.dsh/workbench/execution-leases.json`,与 client-keys 同目录)。 */
    leaseFile?: string
  }
  /**
   * 他的规矩(卡 K「全局自进化」合进来之后接这一格;缺席 = 派活不附规矩、收回来不自查,行为同没有卡 K):
   * `rulesFor` = `rules.brief('dispatch', 原话).text`,`review` = `rules.review(...)`。见 `dispatchRun.ts` 那两个口。
   */
  dispatchRules?: Pick<DispatchRunDeps, 'rulesFor' | 'review'>
  /**
   * 交回核验推进模块的测试缝(2026-10-29 第 4 步,`server/taskExecutionDelivery.ts`):
   * 产物核对替身、代跑超时(缺省 120s)、核不了 / 恢复重试间隔(缺省 60s)。缺席 = 全套真实现。
   */
  taskDelivery?: {
    artifacts?: import('./dispatchVerify.ts').ArtifactCheckDeps
    runTestTimeoutMs?: number
    retryMs?: number
  }
  /**
   * 各家能力体检(2026-09-25,卡 O,`server/agentCaps.ts`)。缺席 = /state 没有 agent_caps,
   * 派活不先看体检(老行为:派出去才知道 Claude 命令行没登录)。
   */
  agentCaps?: AgentCaps
  /**
   * 「登录 X」那颗键(卡 O):在这台电脑上开一扇终端窗口跑那家**自己的**登录命令,账号密码在它自己的登录页上填,
   * 工作台不经手。**只认回环**(它在这台电脑上开窗口)。缺席 = /agents/login 回 404。
   */
  loginLauncher?: (family: 'claude' | 'codex') => Promise<{ ok: boolean, note: string }>
  /**
   * 从窗口上读额度的那几家(卡 O,`server/agentQuota.ts`:Manus 首页右上角的积分、Muse「使用情况」页上的百分比)。
   * 缺席 = 那几家的额度一律「没接上」(老行为:什么都没有)。
   *
   * ★ 2026-09-26(卡 QO):**开集那条路也挂在它身上** —— 登记表里新接上、还没有专门读法的那几家,
   * 那一格的「读一下」与读回来的数都从这里来。缺席 = 那几家照旧是「没接上:还没找到这家的额度来源」。
   */
  windowQuota?: WindowQuotaReader
  /**
   * 每件事的花费 / 时长上限(卡 O,`server/itemBudget.ts`):上限配置、那条会话的用量(DSH 会话 feed)、
   * 卡 M 的外层提问(合进来之后接上;缺席 = 只挂卡上的三颗键)。缺席 = 不设上限(老行为)。
   */
  itemBudget?: { store: BudgetStore, usage: (sessionId: string) => DshSessionUsage | undefined, asker?: OuterAsker }
  /** 那家的 app 装没装(卡 O 的派活选项;缺省看 /Applications 与 ~/Applications 下那个 .app)。 */
  appInstalled?: (family: AgentDispatchFamily) => boolean
  /**
   * 监听地址，缺省 127.0.0.1（只出本机）。
   * 展示台跑在另一台设备上（ThinkSmart View），够不到本机回环，才需要显式对外绑。
   */
  host?: string
  service: WorkbenchService
  /** 0 表示不起定时器，响铃只在手动 tick 时判定。 */
  tickIntervalMs?: number
  /**
   * 心跳周期，缺省 20 秒；0 表示不发（测试用）。
   * 每拍做两件事：给展示台发一条应用层 ping（喂它的看门狗），
   * 以及发一个协议层 ping 帧、下一拍检查 pong 有没有回来（把死连接清出去）。
   */
  heartbeatMs?: number
  /** 用量刷新周期，缺省 60 秒（见 DEFAULT_USAGE_INTERVAL_MS 的理由）；0 表示不起定时器（测试用）。 */
  usageIntervalMs?: number
  /** 凭据落盘位置，缺省 ~/.dsh/workbench/credentials.json。 */
  credentialFile?: string
  /**
   * Claude 额度「一键接上」要的那三只手(2026-10-03,`quota/claudeSetupToken.ts`):
   * 找到这台电脑上的 `claude`、起 `claude setup-token`、用默认浏览器开授权链接。
   *
   * **缺席 = 这台服务没接这条路**:`/quota/connect/claude` 整条 404,设置里那颗「接上」键不画
   * (照旧只剩粘密钥那条退路)。起进程与开 App 一律在 `src/index.ts` 那半区接线,这一层不碰 child_process。
   */
  claudeConnect?: ClaudeConnectIo
  /**
   * 模型服务(2026-09-17):默认「用工作台提供的服务」= 自家中转,可切「用自己的 DeepSeek Key」。
   * 不传就没有 /model 路由,行为与之前完全一样(设置里那一节也不渲染)。
   */
  model?: ModelService
  /**
   * 「注册/登录那一刻自动把模型服务接上」(2026-09-18,决策记录同日「新用户零凭据」)。
   * 不传就退回 09-17 那一版的行为(要在设置里点一下「用工作台提供的服务」),
   * `/state.setup_alerts.model_service` 随之缺席、`POST /model/auto-setup` 404。
   */
  modelAutoSetup?: ModelAutoSetup
  /**
   * 重启之后把引导会话先热起来(2026-09-24,onboardingWarm.ts)。不传就没有这一步(既有用例照旧)。
   */
  onboardingWarm?: OnboardingWarm
  /**
   * 判断一条请求是不是来自本机回环。默认按 socket 的远端地址判，测试可注入。
   * 只用于挡住"远程写凭据"，读状态不受影响。
   */
  isLoopback?: (req: IncomingMessage) => boolean
  /**
   * 判断一条请求的来源允不允许访问（HTTP 与 WS 都走这道门）。
   * 默认按 socket 远端地址判：回环，或「允许手机在局域网访问」开关开着（见 isAllowedRemoteAddress），测试可注入。
   */
  isRemoteAllowed?: (req: IncomingMessage) => boolean
  /**
   * 一条请求的远端地址。缺省读 socket;测试注入一个可变的函数就能在同一台服务上
   * 交替扮演「本机」与「手机」——isLoopback 与来源门都从这里取地址。
   */
  remoteAddress?: (req: IncomingMessage) => string | undefined
  /**
   * 一条请求是从这台机器的哪块网卡进来的(2026-10-21,局域网主路)。缺省读 `req.socket.localAddress`。
   * `/channel/token` 给局域网里的设备签的地址就是它(设备连得上 8791 的那个地址,就连得上 7880);测试注入。
   */
  localAddress?: (req: IncomingMessage) => string | undefined
  /**
   * 这台 Mac 的机器 id(2026-10-21,server/machineId.ts)。`/pair/claim` 回包多一格 `mac_id`,
   * 手机配对那一刻就记下「我配的是哪一台」(同一局域网里有好几台 8791 时靠它认)。不传 = 那一格缺席。
   */
  machineId?: () => Promise<string | undefined>
  /**
   * 手机配对与设备令牌(2026-09-11)。不传就没有 /pair/*、/lan 路由,/state 里也没有
   * lan/pairing/devices,鉴权行为与之前完全一样(只有回环门)。
   */
  pairing?: PairingService
  /**
   * 「允许手机在局域网访问」开关的落盘与 mDNS 广播。config 是 app.json;mdns 不传就只开监听不广播;
   * lanAddress 缺省读本机网卡(二维码里的 host),测试注入。
   */
  lan?: {
    config: AppConfigService
    mdns?: MdnsAdvertiser
    lanAddress?: () => string | undefined
    /** mDNS 里的实例名与版本(TXT name / v)。 */
    name?: string
    version?: string
  }
  /**
   * 路径可配(2026-09-17 卡 C):`GET/PUT /config/paths` 与 `GET /config/hooks`。
   * 不传就这三条路由 404,行为与改造前完全一样(默认值仍然写在各服务里)。
   */
  paths?: {
    /** 落盘用的同一份 app.json 服务(与 lan.config 可以是同一个实例)。 */
    config: AppConfigService
    /** 家目录,用来算默认值。 */
    home: string
    /** `process.env.WORKBENCH_BUTLER_CWD`。它压过 app.json,见 pathConfig.ts。 */
    envButlerCwd?: string
    /**
     * 一个路径是目录、是别的东西、还是压根没有。缺省读真实文件系统;测试注入。
     *
     * 三态而不是布尔:"没有这个目录"与"这是个文件不是目录"对 Ben 是两件事(后者最常见——
     * 把某个文件拖进了输入框),错误信息要能分开说。校验放在服务端而不是界面:
     * 两处各写一份迟早不一致,而不一致的那次一定是界面放过了服务端要拒的东西。
     */
    statPath?: (path: string) => Promise<'dir' | 'other' | 'missing'>
    /**
     * 改完之后要做的事(扫描缓存作废 + 收件箱重挂)。由 index.ts 接线——
     * http.ts 不认识 projectsService 的缓存,也不该认识 fs.watch。
     */
    onChanged?: (next: AppConfig) => void | Promise<void>
    /**
     * 这个插件所在目录。缺省用 http.ts 自己的位置。两处用:技能正文找开发仓库(仓库优先、包内兜底),
     * 以及钩子脚本的来源(下面 `hookScripts` 没传时,从这里往上找插件包自己的 `bin/`)。
     */
    moduleDir?: string
    /** 技能正文找开发仓库用:某个文件在不在。缺省读真实文件系统;测试注入。(钩子不再找仓库。) */
    fileExists?: (path: string) => Promise<boolean>
    /**
     * 钩子脚本的固定位置与同步(2026-09-25 卡 R,hookScripts.ts)。生产由 index.ts 传进来 ——
     * 与起服务时那次同步、「接上没有」的判定是同一份。不传就按 `home` + `moduleDir` 现造一份
     * (用例给临时 HOME,写只写进那里)。
     */
    hookScripts?: WbHookScripts
    /**
     * 钩子由工作台代写(2026-09-17 Ben 拍板)。**不传就 apply/revert 两条 404**,
     * 只剩只读的 `GET /config/hooks` —— 既有的一大批 `startWorkbenchServer(...)` 用例
     * 因此一个字都不用改,更不会有哪条用例意外写到真实家目录里去(同 clientScan 那条纪律)。
     *
     * `files` 是两家配置文件的绝对路径(生产在 index.ts 里由 setupPaths 算,测试给临时 HOME 下的)。
     */
    applyHooks?: {
      files: Readonly<Record<WbHooksAgent, string>>
      /** 读写与备份用的 I/O。缺省用登录台那一套(nodeSetupIo),测试注入假的。 */
      io?: WbHooksApplyIo['io']
      /** 备份文件名里那个时间戳。测试注入固定时刻。 */
      now?: () => Date
    }
  }
  /** 推送型额度（目前只有 Claude 的 statusLine）落进快照后调用，用来跨重启保住它。 */
  onQuotaPushed?: (agent: AgentId, entry: QuotaEntry) => void
  /**
   * Ben 在工作台填完 Key 之后调用：立刻重采一轮额度。
   * 采完这里会把整份快照推给展示台，所以他填完不用等下一个五分钟。
   *
   * 带上**是哪一家、是不是清空**(2026-09-18):清空时接线那头还要把这一家的上一次采样
   * 当场作废,不能只等重采 —— 重采要打好几家的接口,中间那几秒界面上还挂着用已经删掉的
   * Key 取来的余额(quota/collector.ts 的 forgetCredential)。
   */
  onCredentialsChanged?: (change: { provider: CredentialProvider, cleared: boolean }) => Promise<void>
  /** v5 项目区(Task 7)。不传就是没接项目区，/state.projects 与相关写路由都缺省/404。 */
  projects?: ProjectsService
  /** 机器信号一次采样(machine.ts createMachineSampler 的返回值)。不传就 /state.machine 缺省。 */
  machine?: () => Promise<WorkbenchState['machine']>
  /**
   * 用量采集器(2026-08-25)。首轮全扫约 30 秒(实测 29.6s / 689MB 日志),所以
   * **绝不在 composeState 里 await**——refresh 走自己的定时器,composeState 只读
   * 同步快照。首轮出结果前 view() 返回 { error },界面如实显示"未接入"。
   */
  usage?: {
    refresh: () => Promise<void>
    view: () => UsageState | { error: string }
    /**
     * 按会话汇总(2026-09-09 任务卡费用归因),键 `${agent}:${session_id}`,查不到的缺席。
     * 可选:旧桩/不带这一手的采集器照常跑,只是 /state.tasks.session_usage 缺席。
     */
    sessionTotals?: (keys: readonly string[]) => Record<string, UsageTotals>
  }
  /** 各来源角标数。不传就 /state.badges 缺省。 */
  badges?: () => Promise<Record<string, number | null>>
  /**
   * Codex 会话源的请求驱动对账(codexSessionFeed.reconcile,2026-08-26)。composeState
   * 每次被真实请求触发时同步调一下(内部自带 15s 限频与终态过滤,fire-and-forget)——
   * FSEvents 整段静默时(真机实测过 5 分 39 秒),"有人在看"是唯一还活着的触发源。
   */
  codexReconcile?: () => void
  /** 系统日历采样(calendar.ts createCalendarSampler 的返回值)。不传就 /state.calendar 缺省。 */
  calendar?: () => Promise<WorkbenchState['calendar']>
  /**
   * 供 /activate 使用的命令执行器（同源于 machine 采样用的那个 execFile 包装）。
   * 测试在这里注入假的，不必真的拉起一个 App。
   */
  runCommand?: (cmd: readonly string[]) => Promise<{ ok: boolean, stdout: string }>
  /**
   * 带**工作目录与退出码**的命令执行器(2026-09-23,断点 B 与 C)。
   *
   * 与上面那个 `runCommand` 分开而不是改它:那一个是给 `/activate` 拉应用用的,
   * 它既没有 cwd 也没有退出码 —— 而这条线上"成没成"的唯一判据就是退出码
   * (`docs/交接-0921-派活给别家Agent.md` 第四节那次真跑记录里,凭据就是 `退出码 0`)。
   * 改它的签名要动四五处既有调用,而那几处一个都不需要这两样。
   *
   * 不传:`/feature/result` 照样落结果(git 与测试那两段如实写「没取」),
   * `/feature/branch` 与 `/feature/ship` 一律 404。
   */
  runInCwd?: RunInCwd
  /**
   * 「改工作台自己」那条闭环上**真的会动外面的东西**的那两样(2026-09-23,断点 C)。
   *
   * 单拎出来做一个注入点,就是为了让用例**没有任何办法**不小心跑到它们:
   * `publish` 会往公网 rsync 产物,`applyUpdate` 会把这台机器上跑着的工作台换掉。
   * 不传 = `/feature/ship` 一律 404(那条闭环整块不启用)。
   *
   * ★ 这里**没有** `runningVersion`:「等版本号变了」那一步已经不在这条请求里了
   * (它跑不完 —— `applyUpdate` 会把这个进程换掉)。问版本号的那一段挪到了
   * 重启之后的 `shipFollowUp`,见 `selfShip.ts` 文件头。
   */
  selfUpdate?: {
    publish: SelfShipDeps['publish']
    applyUpdate: SelfShipDeps['applyUpdate']
    /** `$HOME`。硬边界判 `~/.dsh` 要用;不传就按 `process.env.HOME` 读。 */
    home?: string
  }
  /**
   * 上一次「改自己」重启之后那一句收尾(2026-09-23,`selfShipFollowUp.ts`)。
   *
   * **是个取值函数而不是一个值**:那一段跑在服务起来**之后**(它要读盘、要问这台机器上
   * 装着的是哪一版),而这份 options 在那之前就传进来了 —— 同 `codexReconcile`
   * 与 `cloudApk` 那两处"先占位后接线"的手法。
   * 不传、或者回 undefined = 收件箱里这一档整档不出(绝大多数次都是这样)。
   */
  shipFollowUp?: () => SelfShipFollowUp | undefined
  /**
   * 剩余额度告警(2026-10-23,卡 t-8e617888;`server/quotaAlerts.ts`)。消费 `agent_quota`
   * 同一份统一视图,低额/耗尽各提醒一次,走收件箱 `quota` 那一档(只是工作台消息)。
   * 不传 = 这一档整档不出(测试与未接线的实例照旧)。
   */
  quotaAlerts?: QuotaAlerts
  /**
   * 额度活用建议(2026-10-28,卡 t-f68365f6;`server/quotaSpendTips.ts`,任务书「额度按到期先花」
   * 第 10 条)。消费 `agent_quota` 同一份统一视图 + 看板:重置前 6 小时某扇窗还剩一半以上 →
   * 把板上「待排」的研发活列成建议走收件箱 `spend` 那一档(只提议不自动派)。
   * 不传 = 这一档整档不出(测试与未接线的实例照旧)。
   */
  quotaSpendTips?: QuotaSpendTips
  /**
   * 试铃翻转态自动归零的时限，缺省 60 秒——对齐展示台 ringVisibleMs 的兜底自停：
   * 展示台那头早就不响了，这头还记着"响着"的话，下一按会变成一次空停铃。
   */
  testRingResetMs?: number
  /** 窗口编排壳(工作台.app)的 WS 通道。不传就 /helper 升级直接拒绝,/state.helper 缺省。 */
  helper?: HelperChannel
  /** 贴合编排(Task 4)。不传就 /snap /unsnap 404「窗口编排未启用」,/state.snap 缺省。 */
  orchestrator?: Orchestrator
  /** 场景服务(Task 5)。不传就 /scene/* 404「窗口编排未启用」,/state.scenes 缺省。 */
  scenes?: ScenesService
  /**
   * 布局模板(2026-09-21)。不传就 /template* 404「布局模板未启用」、`/state.template` 缺省
   * ——缺席即"这台服务没有模板这回事",界面按现状(做产品)那一套文案走。
   */
  template?: TemplateService
  /**
   * 自定义模块容器(2026-09-21)。不传就 `/modules*` 404「自定义模块未启用」、
   * `/state.modules` 整块缺席 —— 窗位叠里一个自定义标签都不画,与加这块之前逐字相同。
   */
  modules?: CustomModulesService
  /**
   * 用户层的加载口(2026-10-21,`server/userLayer.ts`)。不传就 `/user-layer*` 404、`/state.user_layer` 整块缺席 ——
   * 客户端那几格一律用本体自带的那一版。
   */
  userLayer?: UserLayerService
  /**
   * 自定义模块的**单开来源**(2026-09-22,C7)。不传就不另起那台监听 —— 于是
   * `/state.modules[].frame_url` 整块缺席、窗位叠里一格自定义模块都挂不出来
   * (**不是退回同源**:同源那条路 2026-09-22 起在这台服务上已经没有了)。
   *
   * 生产由 `index.ts` 传 `{ port: 8794 }`(或 `WORKBENCH_MODULE_PORT`);用例传 `{ port: 0 }`。
   */
  moduleOrigin?: {
    /** 0 = 由系统分配(用例用)。 */
    port: number
    /** 只绑回环。留这个参数是为了用例,不是为了给谁改成 0.0.0.0。 */
    host?: string
    /** 工作台服务那个 origin,给模块页面的 CSP 与注入用。缺省按本服务的监听地址算。 */
    apiOrigin?: string
    /** 测试注入:让令牌可预期、时间可拨。 */
    tokens?: ModuleTokens
  }
  /**
   * 「开发一个小工具」那条链路的依赖(2026-09-21)。不传就不认那句话,
   * `POST /butler/item` 照旧把它当一条普通事项建下来(= 这块功能之前的行为)。
   */
  /**
   * 用自然语言改布局(2026-09-22)。不传就 `/layout/act`、`/layout/undo`、`/layout/confirm`
   * 一律 404「改布局未启用」,`/butler/item` 也不去认布局句 —— 这块功能之前的行为一字不变。
   *
   * `template` 那一支是**快照/回退**的落点(复用切模板那个栈,见 templateStore.snapshotLayout);
   * 它没接线时 `/layout/act` 照改,但会在回包里如实说一句"这次没有快照,撤不回来"。
   */
  layoutAsk?: LayoutAskStore
  /**
   * 进化循环（2026-09-22，卡 ⑥）。不传就 `/evolve/*` 一律 404「进化循环未启用」、
   * `/state.evolve` 缺省、收件箱里那一档一条不出 —— 这块功能之前的行为一字不变。
   */
  evolve?: EvolveService
  /**
   * 他的规矩(2026-09-24 晚,卡 K)。不传就 `/butler/rules*` 一律 404「规矩表未启用」,
   * 派活不附规矩、交回来不自查、明说的规矩不记 —— 这块功能之前的行为一字不变。
   */
  rules?: RulesService
  /**
   * 集中改提示词那一页(2026-10-01)。不传就 `/butler/prompts*` 一律 404「集中改提示词未启用」 ——
   * 这块功能之前的行为一字不变(覆盖层也不装,各条写入路照写默认)。
   */
  prompts?: PromptsService
  /**
   * Agent 登记表(2026-09-25,卡 Q「Agent 自动发现与统一接入」,`server/agentDiscovery.ts`)。
   * 不传就 `/agents*` 一律 404「登记表未启用」、`/state.agent_registry` 缺省 —— 这块功能之前的行为一字不变。
   */
  agents?: AgentDiscovery
  /**
   * 此刻在不在通话(工人报的,同通话护栏的 `inCall` 口径;`server/callState.ts`)。
   * 不传就 `POST /channel/call-state` 404,登记表的巡检不因通话暂停。
   */
  callState?: CallState
  /**
   * 后台任务挂在主会话上(2026-09-25,卡 Q,`server/sessionChildren.ts`):`/state.sessions` 里每条主会话带上它底下的
   * `children`(Claude 子代理、事务官派出去的活)。不传就没有这一格 —— 之前的行为一字不变。
   */
  sessionChildren?: Pick<SessionChildren, 'attach'>
  devTool?: {
    store: DevToolStore
    /** 模块目录的**绝对路径**,要写进那条交代里(干活的那一家得知道写到哪)。 */
    modulesDir: string
    /** 草图端口。不接就没有草图,界面如实说一句 —— 不拿模板话冒充(D13)。 */
    sketch?: DevToolSketch
    /** 测试注入:让 module id 可预期。 */
    random?: () => number
    /**
     * 验收那一拍隔多久看一次(2026-10-01,C2;缺省 `DEV_TOOL_ACCEPT_EVERY_MS` = 10 秒)。
     * **测试注入**:用例等不起 10 秒,而把这个数写死就只能靠睡 —— 睡出来的绿是会漂的。
     */
    acceptEveryMs?: number
  }
   /**
   * 数据复盘的小红书自取(2026-09-21)。不传就 /xhs/* 404「数据复盘自取未启用」、
   * `/state.xhs` 缺省 —— 缺席即"这台服务没接自取",「数据复盘」那一格按
   * 「还没接上」那一版显示。
   */
  xhs?: XhsService
  /**
   * 采集器(2026-09-23,用户层;`server/collectors.ts`)。不传就 `/collector/*` 与
   * `GET /module/data` 一律 404、`/state.collectors` 缺席 —— 这块之前的行为一字不变。
   */
  collectors?: CollectorsService
  /**
   * 采集类三项(2026-09-22)。不传就 `/collect/*` 404「采集未启用」、
   * `/state.xhs_collect` 缺省 —— 缺席即"这台服务没接采集",界面上一个入口都不出。
   */
  collect?: XhsCollectApi
  /** 窗口槽应用清单(spec S4)。不传就 /apps/* 404「窗口编排未启用」,/state.apps 缺省。 */
  registry?: AppsRegistry
  /** 窗位叠(spec 2026-08-24 窗位叠 v2 V1–V6)。不传就 /slot/rect /dock/* 404「窗位叠未启用」,/state.dock 缺省。 */
  dock?: DockService
  /**
   * 窗口槽那圈原生流线光(2026-09-25 卡 P 补三起只剩「他亲手拖进新应用、松手」那一下)。不传就没有那一下的光,
   * 别的照跑。事务官动作的那一行字不经这里(页面自己画,见 server/actorNotes.ts)。
   */
  highlight?: HighlightService
  /** 今晨快报(W4)。不传就 /brief/dismiss 404「快报未启用」,/state.brief 缺省。 */
  brief?: BriefService
  /**
   * 资讯与播客(2026-09-21,server/feed.ts)。不传就 /feed* 一律 404「资讯未启用」,
   * 收件箱里那一档整档不出 —— 与「今天没搜到」是两回事,界面要分得开。
   */
  feed?: FeedService
  /**
   * 「她要跟你聊的那一条资讯」那一格(2026-10-13,卡「播客页重做」;server/feedDig.ts)。
   * 不传 = `POST /feed/dig/call` 回 404「这台机器上没接通话上下文」,**文字与按住说话照样能聊**
   * (那两样只用 `quickAnswer`)。生产由 index.ts 注入,同一个实例也给通话人设(channel 的 `digBlock`)。
   */
  feedDig?: FeedDigContext
  /**
   * 资讯播客接 Aiboo AIDJ(2026-09-22,server/aidj.ts)。不传就 `/feed/aidj*` 404,
   * 手机上那条播放条**原样退回**上一版的单人口播 —— 与「接了但今天 Aiboo 没生成」分得开。
   */
  aidj?: AidjService
  /** 日结(PRD 5.7,2026-09-02)。不传就 /state.daily 缺省,日结条维持占位文案。 */
  daily?: DailyService
  /**
   * 布局快照落盘(2026-09-10,记忆第一族「工作台长什么样」)。不传就只有两条**只读**路由
   * (/snapshot/layout.md|.html 现渲现给),没有每天那一份落盘文件——路由不依赖这个服务。
   *
   * 节拍挂在**既有的** tick 上(下方 tick() 里那一段),不新起定时器;服务内部判「到点了
   * 没有、今天落过没有」,只有真要生成时才回来组装一次 state。
   */
  layoutSnapshot?: LayoutSnapshotService
  /**
   * DeepSeek 峰谷时间表(2026-09-09)。不传就 /peak-schedule 404「峰谷时段未启用」、
   * /state.deepseek_peak 缺省,额度格那一行不出现(缺席即"没这功能",不摆空壳)。
   */
  peakSchedule?: PeakScheduleService
  /**
   * 事务官本机后端(butler-server,2026-09-11)。不传就 /butler/* 404「本机后端未接线」,
   * /state.butler 缺省,设置弹窗那一节不出现。
   */
  butler?: ButlerService
  /**
   * 插件进程自己的内存与事件循环(2026-10-19,卡「插件内存增长与 GC 抖动」;`server/processHealth.ts`)。
   * 接上后:`/state.machine.process` 有那几个数、诊断包概要有同一份、1 秒节拍上每 10 分钟记一行 `[内存]`,
   * 而且语音后端「从在跑变没在跑」那一下会先问一句「是不是我自己慢」。缺省不接 = 全部缺席、老行为。
   */
  processHealth?: ProcessHealth
  /** 一条 /live 连接的发送缓冲攒到多少字节就先不往里堆。缺省 {@link LIVE_SEND_BUFFER_MAX_BYTES};用例注入小的。 */
  liveSendBufferMaxBytes?: number
  /**
   * 连接器(open-connector,卡 OC2)。不传就 `/connector/*` 一律 404「连接器未接线」、
   * `/state.connector` 缺席、设置里那一行不出现 —— 这块功能之前的行为一字不变。
   */
  connector?: ConnectorService
  /**
   * 通话模式(2026-09-17)。不传就没有 /butler/rtc/callback 与 /butler/call/record,
   * 经代理去 /api/rtc/start 的请求也不再被注入人设——手机那边会拿到一通没有事务官人设的电话,
   * 所以这条**没接线就等于通话模式没做**,不是可选装饰。
   */
  rtcCall?: RtcCallService
  /**
   * 通道层(2026-09-17,docs/设计-手机通道层-2026-09-17.md)。不传就没有 /channel/*——
   * 手机拿不到进房凭证,工人也取不到人设,整条通道等于没开。见 server/channel.ts。
   */
  channel?: ChannelService
  /**
   * 工人的常驻那一层(2026-09-17)。不传就没有 /channel/start|stop、/channel/worker,
   * /channel/status 里也没有 `process` 那一格——工人还是只能手工起。见 server/channelWorker.ts。
   */
  channelWorker?: ChannelWorkerService
  /**
   * 本机房间的看管(2026-10-21,局域网主路卡 M1;`server/localRoom.ts`)。接上后 `/channel/status` 多一格
   * `local_room`:livekit-server 装没装、在不在、地址、8791 上一次因为换了网卡重起它的时刻。没有任何钥匙。
   * 不传 = 没有这一格。
   */
  localRoom?: { view: () => Promise<LocalRoomView> }
  /**
   * 在线设备表 + 传输流水(2026-09-21)。不传就没有 /devices/online、/devices/transfers
   * 与工人那两条上报路由 —— 设备间传文件照常能传(那全在房间里),只是电脑端看不到那张表。
   */
  deviceDirectory?: DeviceDirectoryService
  /**
   * 手机从电脑取文件(2026-09-25,卡 J):事务官自己的文件夹(`~/Documents/事务官`)。
   * 不传就从 `composer.inboxDir` 的上一级推;两样都没有时只在授权的扫描根里找。
   */
  fileWorkDir?: string
  /** 取文件时「这台电脑叫什么」(卡上那一句「书房 Mac 上」)。缺省主机名去掉 `.local`。 */
  computerName?: string
  /** Claude 会话恢复(2026-09-02):每次组装 /state 顺手调一次,内部限频。不传即不启用。 */
  claudeRecover?: () => void
  /**
   * 「在等你」(2026-09-25,卡 T):每次组装 /state 顺手调一次(读各家会话、判在不在等他;内部限频,同 claudeRecover)。
   * 不传即不启用(会话表照旧只按各家报的状态摆)。
   */
  waitingPump?: () => void
  /**
   * 别家会话在等他时,答了送回去 / 「去回答」(卡 T):`POST /sessions/answer`、`POST /sessions/reveal`。
   * 不传就这两条 404「送回那家会话的路没接上」。
   */
  sessionAnswer?: SessionAnswerService
  /**
   * 哨兵(2026-09-09,借鉴 dsh-sentinel)。不传就 /sentinel/* 404「哨兵未启用」,/state.sentinel 缺省。
   *
   * 探测节拍挂在**既有的** tick 上(下方 tick() 里那一段),不新起定时器——每个监视项
   * 自己的 interval_sec 决定这一拍要不要真去探,服务内部还有单飞守卫。
   */
  /**
   * 座机主动来电(2026-09-21)。没接就 `/call/*` 全 404、`/state.call_out` 缺省 ——
   * **缺席就说缺席**,不回一份空台账(那会被读成「一通都没打过」,而事实是这台机器压根没接)。
   * 节拍挂在 tick() 上,这里不起定时器。
   */
  callOut?: CallOutService
  /**
   * 捎完话等回话那本轻账(2026-09-27,卡 CB)。捎进去了记一条,巡检读到回话就回个电话。
   * 缺席 = 捎话照旧能捎,只是没人替他盯回话(老工作台、没接座机服务时)。
   */
  relayWatch?: RelayWatchService
  /**
   * ★ **一处动作闸 + 一本只追加的任务日志**(2026-10-02,卡 AG)。由 `index.ts` 造、往下传给
   * 每一条会去动别家 App 的管线(派活送话 / 开窗重试 / 派活盯窗 / 捎话巡检)—— 全进程一本账、一处判据。
   * 缺席 = 这一处自己造一份(用例、老宿主:闸照样生效,账里只有本进程的事件)。
   */
  actionGate?: ActionGate
  jobLog?: JobLog
  /**
   * 个人访问令牌(2026-10-21 协作区,`server/personalToken.ts`)。缺席 = `/token/personal*` 404,
   * 命令行照旧只能走授权表那一道。
   */
  personalTokens?: PersonalTokens
  /**
   * 协作区板的工作目录(板在 `<它>/协作区/板.canvas`)。缺席 = 与事务官会话同一个工作目录现问
   * (`WORKBENCH_BUTLER_CWD` > app.json 的 butler_cwd),再没有落到 `~/Documents/事务官`。
   */
  collabWorkdir?: () => Promise<string | undefined>
  /** GitHub 设备码登录(2026-10-21 协作区全量)。缺席 = `/collab/github*` 404。由 index.ts 造(令牌落 `~/.dsh/workbench/github.json`)。 */
  githubDevice?: GitHubDevice
  /** 工作室 MCP 库的本机密钥(值只在本机)。缺席 = 填密钥那条 404,`missing` 全按缺。 */
  mcpSecrets?: McpSecrets
  /**
   * 协作区跨机(2026-10-21,`collabRelay.ts`)。缺席时有 HOME(`setupEnv`)就按 model.json 的设备令牌 + 账号会话令牌自己连,
   * 再没有就 `/collab/relay/*` 404。`loop` = 起两条长轮询(只有 index.ts 传;用例靠 `tick()`)。
   */
  /**
   * 名片头像(2026-10-21,`collabAvatars.ts`):存在 `<home>/.dsh/workbench/avatars*`。缺席时取 setupHome;
   * 都没有就 `/collab/avatar/*` 404。
   */
  collabAvatars?: { home: string }
  /**
   * 1a(2026-10-24):`/butler/say` 模型听懂的 fetch 注入(用例塞假模型;生产缺席走全局)。
   * 凭据不进这里 —— 只换传输层。
   */
  fetchImpl?: typeof fetch
  collabRelay?: {
    link?: () => Promise<RelayLink | undefined>
    fetchImpl?: typeof fetch
    inboxFile?: string
    borrowFile?: string
    loop?: boolean
  }
  /**
   * ★ **一条引擎**(2026-10-02,卡「引擎接线与删复制品」;设计 `docs/设计-一条引擎替八条管线-2026-10-02.md`)。
   *
   * 「往别家 AI 送一句话、把回答拿回来」只有这一条路。三条通道(Claude socket / Codex 协议 / 窗口)
   * 在 `index.ts` 里接线,这里只**用**它:派活送话走 `engine.run`,派活盯窗读回话走 `engine.read`。
   * 缺席 = 送话整条能力缺席(`/dispatch/client` 回 404)—— **不假装送得出去**(与壳没接时同一条纪律)。
   */
  engine?: Engine
  /**
   * 登记处:**有哪几家、每家能做什么**(候选名单那三处消费方改读它)。
   * 缺席 = 退回登记表那一份(老宿主 / 用例)。
   */
  engineRegistry?: AdapterRegistry
  /** 每一家一条窗口通道(2026-10-21,卡「派活按家隔离」):「重置这一家」清它、`/state` 报它。缺席 = 那颗键回「这台没接通道」。 */
  familyLanes?: FamilyLanes
  /** 「重置这一家」重开那扇窗那一下(`open -b`,与引擎开窗同一只手)。缺席 = 不重开(话里如实说)。 */
  reopenApp?: (bundleId: string) => Promise<{ ok: boolean }>
  /**
   * ★ **「这一刻电脑锁着屏没有」那一拍**(2026-10-03,卡「锁屏时窗口型的家送不进」)。
   *
   * 挂在下面那根既有的 1 秒节拍上(与 `relayWatch.pump` / `callOut.pump` 同一处,内部 3 秒限频):
   * 问壳一句,**解锁了就把排着的那几件按原顺序重送**。那一格也进 `/state.helper.screen_locked` ——
   * 她在界面上看得见「这会儿是锁着的」,不用靠对比日志才知道为什么那句话没送出去。
   * 缺席 = 不问(行为与 2026-10-03 之前一字不差:锁屏时照旧报「一扇标准窗口都没有」)。
   */
  screenLock?: ScreenLockWatch
  /**
   * ★ **巡登记表那一拍**(2026-10-23,卡「捎话到没开着的会话留言等它醒」)。
   *
   * 同样挂在下面那根既有的 1 秒节拍上(内部 5 秒限频,见 `sessionAwakeWatch.ts`):
   * 排着等它醒的那几条留言,哪条会话的 socket 在了就把哪条重送。缺席 = 不巡
   * (行为与这张卡之前一字不差:那条会话一醒,留言照旧躺着等她自己重说)。
   */
  sessionAwake?: SessionAwakeWatch
  /**
   * ★ **行为账**(2026-10-09,卡「行为账」;`server/behaviorLog.ts`):她点了什么、选了哪个、对事务官说了什么。
   * 缺席 = 不记(用例大多不挂)。只读接口 `GET /behavior` 只给本机。
   */
  behaviorLog?: BehaviorLog
  /**
   * ★ **三件主路成没成**(2026-10-21,卡「引导三件事」;`server/firstUse.ts`):早报、交代、电话各成没成、第几天成的,
   * 首次引导「第一次有用」那一段与首页「现在能做什么」读它;安装器末尾的自检也走它。缺席 = `/first-use*` 404。
   */
  firstUse?: FirstUseService
  /** 自检那三样各怎么试(用例注入;缺席的那几样用这台工作台自己的那一套)。 */
  firstUsePorts?: Partial<SelfCheckPorts>
  /**
   * ★ **请求号台账**(2026-10-12,卡「手机交代只执行一次」;`server/clientKeys.ts`):手机带 `client_key` 的那几条
   * ({@link CLIENT_KEY_PATHS})同一个号只办一次。缺席 = 只记在内存里(用例;重启就忘)。
   */
  clientKeys?: ClientKeyLedger
  /**
   * ★ **从行为账里数出来的习惯**(2026-10-09,卡「数出习惯」;`server/habits.ts`):默认分派接进派活推荐(`choicesFor`),
   * `GET /habits` 列出来、`POST /habits/revoke` 她撤掉。缺席 = 没学(推荐照旧、两个口 404)。
   */
  habits?: HabitService
  /**
   * ★ **「出门时电脑不睡」那一拍**(2026-10-03,卡「出门时电脑不睡」)。
   *
   * 同样挂在下面那根既有的 1 秒节拍上(内部 5 秒限频,见 `awayAwake.ts`):算一次
   * 「开关开着 + 有已配对手机经中转连着」,**变了就下发给壳**(`away_awake` op)。
   * 缺席 = 这颗开关整件事没接线 —— `GET/POST /shell/away-keep-awake` 照旧落盘,
   * 但如实说壳那头不会生效(不谎报);壳那一格缺省假,行为与 2026-10-03 之前一字不差。
   */
  awayAwake?: AwayAwakeWatch
  sentinel?: SentinelService
  /** 随手记(2026-08-25 版面重排)。不传就 /note/* 404「随手记未启用」,/state.notes 缺省。 */
  notes?: NotesService
  /**
   * Graphify 图谱(2026-10-23,卡「系统文件夹改成Graphify图谱」):「图谱」那一格嵌
   * graphify 产出的 graph.html。不传就 /graphify/* 404「图谱未启用」。
   */
  graphify?: GraphifyService
  /**
   * Archify 产品架构图服务(2026-10-23,卡「图谱显示修复与Archify产品图接入」)。
   */
  archify?: ArchifyService
  /**
   * 「在 Finder 里显示」(2026-09-11 图谱交互)。不传就 POST /files/reveal 404。
   * 图谱**唯一的写接口**,只做定位(`open -R`),路径越界由服务层 realpath 判定并拒绝。
   */
  reveal?: RevealService
  /**
   * 任务看板(设计稿 §3.5)。不传就 /task/* 404「任务看板未启用」,/state.tasks 缺省。
   *
   * 这里**只接一个能读能改的服务,没有任何回调口子**——tasks 不像 dock/quota 那样需要
   * onChanged 主动推:卡片只会因为 Ben 点了什么而变,而每条 /task/* 路由自己会在改完
   * 之后广播一次快照。服务端没有第二条能改动卡片的路径,这是不可改清单第 5 条延伸
   * 约束(不得建议删除待办)在传输层的对应做法。
   */
  tasks?: TasksService
  /**
   * 会议模式(2026-09-21)。不传就 `/meeting/*` 404「会议模式未启用」、`/state.meetings` 缺省。
   * **没配工作目录的机器上照样不传** —— 会议没地方落,整块缺席比建一个猜出来的目录好。
   */
  meeting?: MeetingService
  /**
   * 通话记录(2026-10-22:通电话是记录不是事项)。不传就 `/butler/call/record` 404「通话记录未接线」、
   * `/state.calls` 缺席。
   */
  callRecords?: CallRecordsService
  /**
   * 开事务官会话的端口(2026-09-10 事项收件箱)。不传就是**没接会话通道**:
   * POST /butler/item 照常建事项,只是如实回「会话未开」——不假装开成了(D13)。
   * 真正的实现在 host 那边(src/index.ts 用 DSH 的 sessionController),这里只认端口。
   */
  butlerSession?: ButlerSessionOpener
  /**
   * 统一输入框(2026-09-24)。不传就 `/composer/*` 404「输入框的菜单没接上」;
   * `POST /butler/item` 的附件字段认不出(没有收件文件夹),其余照旧。
   */
  composer?: ComposerService
  /**
   * 偏好:办完提醒的范围 + 桌面活直派(2026-10-23,卡「分层第二刀一」;`server/dispatchPrefs.ts`)。
   * 不传就 `/dispatch/prefs` 404、「桌面那一类不问就派」关、通知范围取缺省 —— 这块功能之前的行为一字不变。
   */
  dispatchPrefs?: DispatchPrefsService
  /**
   * 「先问我」的审批经纪人(2026-09-24)。不传就 `/approvals/*` 404、`/state.approvals` 缺席。
   */
  approvals?: ApprovalBroker
  /**
   * 「这件事里同类的都允许」记在哪(2026-09-25,卡 M)。不传就没有这颗键、`/state.approval_grants` 缺席。
   */
  approvalGrants?: ApprovalGrants
  /**
   * 事务官在 DSH 会话里问他的话(2026-09-25,卡 M)。不传就 `/questions/*` 404、`/state.questions` 缺席。
   */
  questions?: QuestionBroker
  /**
   * DSH 会话的回合列表(2026-09-15,手机端事务官要念的那段对话)。给 GET /butler/item/:id/turns 用:
   * 回 undefined 表示 DSH 这边不认识这条会话(重启过 / 已释放)→ 404。不传就 /butler/item/:id/turns
   * 404「DSH 会话未接线」。生产接 dshSessionFeed.turns;它与 /state.sessions[].summary 出自同一份内存表。
   */
  sessionTurns?: (sessionId: string, limit: number) => readonly SessionTurn[] | undefined
  /**
   * 点开一条「某家在跑的会话」看什么(2026-09-25,卡 P):`GET /sessions/digest?agent=&id=` —— 标题、在哪个项目、
   * 最近在做什么、最近几轮,当场读那条会话的记录(server/sessionDigestService.ts)。不传就 404「会话读取未接线」。
   */
  sessionDigest?: SessionDigestService
  /**
   * 手机读对话(2026-10-01):各家最近的对话、完整对话、附件(server/sessionLibrary.ts)。
   * 不传就 `/sessions/history` 等 404「读对话未接线」。
   */
  sessionLibrary?: SessionLibrary
  /**
   * 各家 hook 报来的每一条事件(2026-09-25,卡 P):index.ts 借此记下「哪些 Claude 会话有 hook 在管」——
   * 那些会话的状态听 hook 的,读会话文件那一路只补标题与在做什么(claudeSessionRecover.ts)。
   */
  onAgentHook?: (event: WorkbenchEvent) => void
  /**
   * 引导流程的阶段机(2026-09-15)。不传就 /onboarding/* 404「引导未启用」,/state.onboarding 缺省。
   * 开会话走上面那个 butlerSession 端口,同一条路。
   */
  onboarding?: OnboardingService
  /**
   * 引导落地(2026-09-24 晚,卡 feat/onboarding-materialize):存档 → 预览「我照你说的摆好了」→ 他点头才落 → 派第一件。
   * 不传就 `/onboarding/materialize/*` 404、/state.materialize 缺省。
   */
  materialize?: MaterializeService
  /**
   * 引导会话的回合表(2026-09-16,手机端引导):GET /onboarding/turns 从这里读,POST /onboarding/session
   * 开成后把会话 id 与种子句登记进去,restart 清空。不传就 /onboarding/turns 回空表(手机只显示自己说的)。
   */
  onboardingTurns?: OnboardingTurnsStore
  /**
   * 事务官外观的真相源(2026-09-16):~/.dsh/workbench/appearance.json。不传就 /butler/appearance 404
   * 「外观同步未接线」、/state.appearance_version 缺省;Mac 端照旧只用 localStorage。
   */
  appearance?: AppearanceService
  /**
   * 授权表(2026-09-15,docs/记忆/授权.md)。接了之后,**程序来源**(不是页面、不是已配对手机)
   * 打 /butler/item、/task|sprint|module/*、/board/project 这几条写路由时读一次 write_api:
   * 不是「可以」就 403 带人话。页面与手机是 Ben 自己在点,不受这张表管——表管的是事务官。
   * 不传就是老样子(回环即放行)。
   */
  authorization?: AuthorizationService
  /**
   * 读一个项目的说明和最近记录(2026-09-24,已有项目拉齐;设计 docs/设计-已有项目拉齐-2026-09-24.md)。
   * 接了之后 `POST /onboarding/project-brief {path}` 可用,`POST /onboarding/scan {name}` 只找到一个时顺手读好、
   * 摘要随回包带回。**不传就都不读**:project-brief 503,scan 照老样子只回名字与路径 ——
   * 既有用例一个字不用改,也不会有哪条用例意外去读真实家目录里的仓库(同 applyHooks 那条纪律)。
   * `io` 生产用 projectBrief.ts 的 nodeBriefIo();`home` 用来展开 `~`。
   */
  projectBrief?: { io: BriefIo, home: string }
  /**
   * 事务官的日常例程(2026-09-15):开工汇报 / 下班例程 / 每周知识 lint。不传就 /routine/* 404
   * 「例程未启用」、/state.routines 缺省、收件箱里没有例程那一档。
   *
   * 定时挂在**既有的** tick 上(下方 tick() 里那一段),不新起定时器;「工作台露面」由本机来源的
   * GET /state 报给它(开工汇报没设时刻时靠这个触发)。起服务时把 composeState 接给它(attach),
   * 例程跑完广播一次快照。
   */
  routines?: RoutinesService
  /**
   * 窗口槽应用增删成功后调用——窗位叠借此立刻重发 observe 订阅集合(新增/删掉的应用要跟着
   * 加入/退出壳的 AXObserver 监听范围)。不传就是没接窗位叠,index.ts 才会真正传。
   */
  onAppsChanged?: () => void
  /**
   * 登录台(2026-09-17,docs/设计-电脑端登录台梳理-2026-09-17.md)。
   *
   * **不传时这里会自己造一个真的**(见 startWorkbenchServer 里那一处)——理由是登录台要
   * 解决的正是「一台新 Mac 什么都没装」,而那种机器上 index.ts 那一长串接线大半都还没接上;
   * 把它做成"必须由 index.ts 注入"等于让它在最需要它的时候缺席。测试注入一个指向临时 HOME
   * 的假的,于是一行也碰不到真实 ~/.dsh。
   */
  setup?: SetupService
  /** 登录台默认实现要读的 HOME 与仓库路径。只在 `setup` 没传时用得上;缺省 process.env。 */
  setupEnv?: Record<string, string | undefined>
  /**
   * 热更新(2026-09-18,Ben:「能加热更新的按钮吗,更新完之后重启」)。
   *
   * 跟 `setup` 同一条规矩:**不传就整块不启用**(`/update/*` 一律 404、`/state.update` 缺席)。
   * 它跟登录台共用同一套路径与同一份 io,所以默认实现也跟着 `setupEnv` 走 —— 既有那一大批
   * 直接 `startWorkbenchServer(...)` 的用例不会因此多出一条往 api.aibooo.cn 的请求。
   */
  update?: UpdateService
  /**
   * 运行环境漂移那一格(2026-09-26,卡 U6)。**不传就整块不启用**
   * (`/state.update.runtime_stale` 缺席、`/update/runtime` 404),同 `setup` / `update`。
   * 默认实现要 `setup`(它装东西用的是登录台那三步),所以没接登录台时它也不存在。
   */
  runtimeRepair?: RuntimeRepairService
  /**
   * 诊断包与自动上报(2026-09-22,Ben:「我弄了台新 Mac,到时候就是脱机运行了,
   * 报错信息和日志什么的得准备好」)。
   *
   * 跟 `setup` / `update` 同一条规矩:**不传就整块不启用**(`/diag/*` 一律 404)。
   * 没注入时在下面按 `setupEnv` 自己造一个 —— 它要服务的正是那台"统筹够不着"的机器。
   */
  diag?: DiagService
  /**
   * 「反馈给开发者」(2026-09-28 卡 FB,2026-10-01 按新 main 重做)。与 `diag` 同一条规矩:
   * 不传就按 `setupEnv` 自己造一个,没有 `setupEnv`(测试里那一大批)就整块不启用 ——
   * 那时 `/diag/feedback*` 一律 404,`/butler/item` 上那条分流也**整条不走**:
   * 记不下的反馈不如不拦,拦了她那句话就没人接了。
   */
  feedback?: FeedbackService
  /**
   * 这台机器上**有没有源码仓库**(2026-10-01 重做时补的那道门)。
   *
   * AGENTS.md 第一节:「改工作台自己」那条闭环(需求卡 → 派 Codex → 测试 → 合并 → 发版)
   * **只在有源码仓库的机器上跑,是给维护者的**。所以本体那一档的分流只在**用户机器**上拦:
   *
   * - 没有仓库(双击安装包装出来的那台)→ 派活之前先分流,本体的毛病一家都不派,发一条反馈;
   * - 有仓库(维护者的开发机 / worktree)→ **照旧往下走**,那条闭环本来就该在这儿跑,
   *   把它拦成一条"反馈给开发者"等于让维护者自己给自己发工单。
   *
   * 不传就按 `wbHooksResolveRepoRoot` 现探一次并记住(一台机器上有没有仓库不会中途变)。
   */
  sourceRepo?: () => Promise<boolean>
  /**
   * 各家客户端扫到没有、接上没有(2026-09-17「每个区域单独解锁」)。
   *
   * **不传就整块缺席** —— `/state.clients` 没有这一格,前台退回"全都显示"(跟这一版之前
   * 一模一样)。跟 `setup` 那一处的理由正好相反:那一格有"新机器上必须自己造"的处境,
   * 这一格没有;而扫一轮要跑五条 `mdfind`,让既有那一大批 `startWorkbenchServer(...)` 用例
   * 默认去跑它,等于每跑一次测试就在开发机上起五个子进程。生产由 index.ts 注入。
   */
  clientScan?: ClientScan
  /**
   * **这台电脑上装了哪几家 AI**(2026-09-27,卡 HC「不写死各家 AI」)。
   *
   * 「有哪几家该出现在界面上」的唯一出处:`/state.agents`、额度、派活对象、引导都过它。
   * **不传就整块缺席** —— `/state.installed_agents` 没有这一格,上面那几处退回这一版之前的
   * 行为(全都显示),既有那一大批用例一个字不用改。理由与 `clientScan` 那一格逐字相同
   * (一轮几条 `mdfind`,不该默认挂在每个用例上)。生产由 index.ts 注入。
   */
  installedAgents?: InstalledAgentScan
  /**
   * 一件事一份、进度靠证据(2026-09-25,卡 N)。**不传就是老行为**(既有那一大批用例):
   * /state 里卡上不挂 `progress` / `mover`、不起负责人驱动、`/progress*` 与 `/item/drive` 404。生产由 index.ts 注入。
   */
  items?: {
    /** 进度核对(证据评估器)。 */
    progress?: ProgressService
    /** 负责人驱动的记账文件(`~/.dsh/workbench/drive.json`)。缺席 = 不起驱动。 */
    driveFile?: string
    /** 卡 O 的挑手(`dispatchChoices`,合并时接)。缺席 = 照卡 F 的三只手顺序。 */
    choices?: (taskId: string, input: { text: string }) => Promise<DispatchChoicesLike | undefined>
  }
  /**
   * 模型从哪儿来(`~/.dsh/workbench/model.json` 的 mode)。不传就 `/state.model_mode` 缺席,
   * 额度面板的 DeepSeek 那格按今天的逻辑照旧。生产由 index.ts 注入。
   */
  modelMode?: ModelModeReader
  /**
   * **中转上配了哪几家上游**(2026-09-26,卡 GH;`server/relayProviders.ts`)。
   *
   * 不传 = 从没问到过 → 只走接口那只手的那几家(今天 = GPT)**一处都不出现**:
   * 派活名单、额度面板、事务官技能里那张「现在怎么派」的表、设置里各家能力那一页都没有它。
   * 宁可少一家,不摆空壳 —— 线上那台中转此刻回的就是 `openai:false`。生产由 index.ts 注入。
   */
  relayProviders?: RelayProvidersReader
  /**
   * 本机账号(2026-09-17,决策记录「登录就是账号密码」)。不传就 `/account*` 一律 404
   * 「账号未启用」,界面据此**照旧直接显示工作台**(既有的一大批用例、展示台、手机都不受影响)。
   *
   * **它不是鉴权**:回环来源仍然放行现有的一切(壳、本机浏览器、DSH 会话、例程都靠它),
   * 登录只决定界面显示登录屏还是工作台。以后账号搬到自家服务器时,这道门才真的要变成
   * 鉴权 —— 那一天改的是这里的来源门,不是 account.ts(理由见交接第三节)。
   */
  account?: AccountService
  /**
   * 工作台自己的开关(app.json)。`lan.config` / `paths.config` 传的是**同一个实例**;
   * 这里单列一条是给「首次流程走完没有」(`first_run_done_at`)用的 —— 它跟局域网、
   * 跟目录配置都没关系,借道另外两个选项去拿会让接线看不明白。不传就 `/first-run` 404。
   */
  appConfig?: AppConfigService
  /**
   * 「多人协作区」总开关(2026-11-09,开源版默认关)。由 `index.ts` 从环境变量 / app.json 算好后传进来;
   * **缺席 = 开**是给老宿主与全部单测留的兼容位(它们不传这一格,行为与改动前逐字相同)。
   * 生产入口只有 `index.ts` 一个,它会显式传值:没配就是 `false`。
   *
   * 关着时:不装配 /collab/* 路由、不建跨机 relay 与定时派活、不起长轮询与 pump、不合并协作区快照、
   * 不放行 `collab-peer` 设备,并在 `/state.collab_enabled` 里如实下发 `false` 给桌面与手机。
   */
  collabEnabled?: boolean
  /**
   * **一问一答当场答那一下问模型的口**(2026-10-02,卡「语音交代慢与老问上限」)。
   *
   * 走的是工作台模型服务定的那一家(`index.ts` 的 `askModel`:`deepseek-v4-flash` + 关思考 +
   * **不带工具**),与资讯 / 小红书建议 / 会议纪要同一条通道,**不另存令牌、不另开通道**。
   *
   * 不传就整块缺席 —— `POST /butler/item` 上那一道「一问一答」的岔口不生效,
   * 一字不变地照旧建卡 + 开会话(既有那一大批用例一个字不用改)。生产由 index.ts 注入。
   */
  quickAnswer?: (prompt: string) => Promise<string>
}

/**
 * 解析端口配置。
 *
 * 环境变量写坏时**立刻抛错**而不是退回默认值——静默退回会让人以为服务在自己配的端口上，
 * 然后对着一个永远连不上的地址查半天。
 */
export function resolveWorkbenchPort(env: Record<string, string | undefined>): number {
  const raw = env.WORKBENCH_PORT
  if (raw === undefined || raw === '') return DEFAULT_PORT

  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`WORKBENCH_PORT 不是合法端口号：${raw}`)
  }
  return port
}

/**
 * 解析监听地址。
 *
 * 默认 127.0.0.1：这台服务承载本机各 agent 的会话状态，默认不该出本机。
 * ★只有显式配了 WORKBENCH_HOST 才对外监听——那意味着同网段任何人都能读到
 * 会话状态、也能往 /event 打上报，请只在可信网段（如 Ben 的手机热点）这么做。
 * 与端口同样的原则：写坏了立刻抛错，绝不静默退回本机，
 * 否则人会对着一个永远连不上的地址查半天。
 */
export function resolveWorkbenchHost(env: Record<string, string | undefined>): string {
  const raw = env.WORKBENCH_HOST
  if (raw === undefined || raw === '') return DEFAULT_HOST

  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(raw)
  if (ipv4 !== null) {
    const ok = ipv4.slice(1).every((part) => {
      const n = Number(part)
      return Number.isInteger(n) && n >= 0 && n <= 255
    })
    if (!ok) throw new Error(`WORKBENCH_HOST 不是合法的监听地址：${raw}`)
    return raw
  }

  // 主机名：字母数字与连字符、点分隔。带空格之类的一律挡掉。
  if (!/^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/.test(raw)) {
    throw new Error(`WORKBENCH_HOST 不是合法的监听地址：${raw}`)
  }
  return raw
}

/**
 * 只放行回环来源的跨源访问。
 *
 * 工作台界面由 DSH 托在 :3080，本服务在 :8791——**不同端口就是不同源**，
 * 浏览器不给 CORS 头连 GET /state 都读不到（表现是界面一直显示「Agent 掉线」，
 * 看着像服务没起，其实是从来没连上过）。
 *
 * 但服务现在绑 0.0.0.0，所以不能无脑 `*`：那等于你浏览器打开的任意网页
 * 都能读到你的会话标题。只反射回环来源。
 */
function loopbackOrigin(origin: string | undefined): string | undefined {
  if (origin === undefined) return undefined
  let host: string
  try {
    host = new URL(origin).hostname
  }
  catch {
    return undefined
  }
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host.startsWith('127.')
    ? origin
    : undefined
}

/**
 * 这个来源允不允许碰这台服务。
 *
 * 背景（2026-08-21 实测）：Mac 同时挂在手机热点和公司 WPA2-Enterprise 两个网上，
 * 服务一旦对外 bind，公司网段任何人都能 GET /state 读全部会话状态（含项目名与 cwd），
 * 也能 POST /event 写假数据。当时的处置是「先放到我的手机热点区」：
 * 本机回环之外，再放行 iPhone 热点固定使用的 172.20.10.0/28。
 *
 * 2026-10-01 维护者拍板：**撤掉那条热点网段例外**。热点网段不是本机，它凭网段放行，
 * 等于绕过了「允许手机在局域网访问」这一个开关；同一张热点上的别人也在这个网段里。
 * 现在这个函数只认本机回环（::1 / ::ffff:127.x / 127.x），
 * 局域网访问一律走 lanEnabled 开关那条门（见下面 isRemoteAllowed：
 * `isLoopbackAddress(address) || lanEnabled || isAllowedRemoteAddress(address)`）。
 *
 * 拿不到地址或看不懂的地址一律拒绝，绝不默认放行。
 */
export function isAllowedRemoteAddress(address: string | undefined): boolean {
  if (address === undefined || address === '') return false
  if (address === '::1') return true
  // IPv6 映射的 IPv4（::ffff:127.0.0.1）剥掉前缀后按 IPv4 判。
  const bare = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(bare)
  if (match === null) return false
  const parts = match.slice(1).map(Number)
  if (parts.some(n => n > 255)) return false
  return parts[0] === 127
}

/** 地址是不是本机回环。IPv6 映射的 IPv4（::ffff:127.0.0.1）也算。 */
export function isLoopbackAddress(address: string | undefined = ''): boolean {
  return address === '127.0.0.1'
    || address === '::1'
    || address === '::ffff:127.0.0.1'
    || address.startsWith('127.')
    || address.startsWith('::ffff:127.')
}

/** 上报字段校验。不合法的一律挡在门外，绝不半信半疑地写进状态。 */
function parseEvent(body: unknown): { event: WorkbenchEvent } | { error: string } {
  if (typeof body !== 'object' || body === null) return { error: 'body 必须是 JSON 对象' }
  const raw = body as Record<string, unknown>

  if (!isAgentId(raw.agent)) {
    return { error: `agent 必须是 ${AGENT_IDS.join(' / ')} 之一，收到：${String(raw.agent)}` }
  }
  if (typeof raw.session_id !== 'string' || raw.session_id === '') {
    return { error: 'session_id 必须是非空字符串' }
  }
  if (!STATUSES.includes(raw.type as SessionStatus)) {
    return { error: `type 必须是 ${STATUSES.join(' / ')} 之一，收到：${String(raw.type)}` }
  }
  if (raw.reason !== undefined && !EVENT_REASONS.includes(raw.reason as EventReason)) {
    return { error: `reason 必须是 ${EVENT_REASONS.join(' / ')} 之一，收到：${String(raw.reason)}` }
  }
  // 认不出的等待原因**整条拒绝**而不是悄悄丢掉这个字段:上报方以为自己说清了,
  // 界面上却什么都没有,那种沉默最难查(与上面 reason 同一条纪律)。
  if (raw.wait_reason !== undefined && !isWaitReason(raw.wait_reason)) {
    return { error: `wait_reason 必须是 ${WAIT_REASONS.join(' / ')} 之一，收到：${String(raw.wait_reason)}` }
  }

  const event: WorkbenchEvent = {
    agent: raw.agent,
    session_id: raw.session_id,
    type: raw.type as SessionStatus,
    ...str('project', raw.project),
    ...str('cwd', raw.cwd),
    ...str('title', raw.title),
    // 摘要拿不到就留空。PRD §5.3 明令不许编造。
    ...str('summary', raw.summary),
    ...(raw.reason === undefined ? {} : { reason: raw.reason as EventReason }),
    ...(raw.wait_reason === undefined ? {} : { wait_reason: raw.wait_reason as WaitReason }),
    ...(typeof raw.ts === 'number' && Number.isFinite(raw.ts) ? { ts: raw.ts } : {}),
  }
  return { event }
}

const PHONE_EVENT_TYPES: readonly PhoneEventType[] = ['offhook', 'onhook', 'missed']

/** POST /phone/event 的请求体校验（来电链 v0）。导出供测试直测，先例见 isAllowedRemoteAddress。 */
export function parsePhoneEvent(body: unknown): { event: PhoneEvent } | { error: string } {
  if (typeof body !== 'object' || body === null) return { error: 'body 必须是 JSON 对象' }
  const raw = body as Record<string, unknown>

  if (!PHONE_EVENT_TYPES.includes(raw.type as PhoneEventType)) {
    return { error: `type 必须是 ${PHONE_EVENT_TYPES.join(' / ')} 之一，收到：${String(raw.type)}` }
  }
  if (!isAgentId(raw.agent)) {
    return { error: `agent 必须是 ${AGENT_IDS.join(' / ')} 之一，收到：${String(raw.agent)}` }
  }
  if (typeof raw.session_id !== 'string' || raw.session_id === '') {
    return { error: 'session_id 必须是非空字符串' }
  }

  const event: PhoneEvent = {
    type: raw.type as PhoneEventType,
    agent: raw.agent,
    session_id: raw.session_id,
    ...(typeof raw.ts === 'number' && Number.isFinite(raw.ts) ? { ts: raw.ts } : {}),
  }
  return { event }
}

function isAgentId(value: unknown): value is AgentId {
  return typeof value === 'string' && (AGENT_IDS as readonly string[]).includes(value)
}

function str<K extends string>(key: K, value: unknown): Partial<Record<K, string>> {
  return typeof value === 'string' && value !== '' ? ({ [key]: value } as Record<K, string>) : {}
}

/** POST /attribution/rule 的请求体校验(spec D5/D7)。 */
function parseRule(body: unknown): { rule: DirRule } | { error: string } {
  if (typeof body !== 'object' || body === null) return { error: 'body 必须是 JSON 对象' }
  const raw = body as Record<string, unknown>

  if (typeof raw.dir !== 'string' || raw.dir === '') return { error: 'dir 必须是非空字符串' }
  const actions: readonly RuleAction[] = ['project', 'ignore', 'not_mine']
  if (typeof raw.action !== 'string' || !(actions as readonly string[]).includes(raw.action)) {
    return { error: `action 必须是 ${actions.join(' / ')} 之一，收到：${String(raw.action)}` }
  }

  const rule: DirRule = {
    dir: raw.dir,
    action: raw.action as RuleAction,
    ...(typeof raw.projectId === 'string' && raw.projectId !== '' ? { projectId: raw.projectId } : {}),
  }
  return { rule }
}

function isLayoutModule(value: unknown): value is LayoutModule {
  if (typeof value !== 'object' || value === null) return false
  const m = value as Record<string, unknown>
  return typeof m.id === 'string'
    && typeof m.order === 'number'
    && (m.basis_pct === undefined || typeof m.basis_pct === 'number')
    && (m.hidden === undefined || typeof m.hidden === 'boolean')
    && (m.row === undefined || typeof m.row === 'number')
    && (m.width_pct === undefined || typeof m.width_pct === 'number')
    && (m.col === undefined || typeof m.col === 'number')
    // 2026-09-20 横屏模块挪区:region / side_pct 是两个 additive 可选字段。缺席照旧
    // (= 全在底部一排,旧存档一格不挪);带了就必须形状对——认不出的 region 明确 400,
    // 不悄悄当成 deck:那是把"用户把它挪去哪了"这件事静静改掉,下次读出来还是错的。
    && (m.region === undefined || (LANDSCAPE_REGIONS as readonly string[]).includes(m.region as string))
    && (m.side_pct === undefined || (typeof m.side_pct === 'number' && Number.isFinite(m.side_pct)))
}

const BUTLER_CORNERS = ['br', 'bl', 'tr', 'tl'] as const

/** 与客户端 layout.ts 的 resizeModule 用同一对界，clamp 逻辑重复一次没关系——两边各自独立可测。 */
const MIN_BASIS_PCT = 8
const MAX_BASIS_PCT = 70

function clampBasisPct(value: number): number {
  return Math.min(MAX_BASIS_PCT, Math.max(MIN_BASIS_PCT, value))
}

/** A6:事务官浮窗拖动位置的合法区间——0–95(留一点边距,不许把浮窗整个拖出视口)。 */
const MIN_BUTLER_POS_PCT = 0
const MAX_BUTLER_POS_PCT = 95

function clampButlerPosPct(value: number): number {
  return Math.min(MAX_BUTLER_POS_PCT, Math.max(MIN_BUTLER_POS_PCT, value))
}

/**
 * 按 LAYOUT_MODULE_IDS 过滤 + basis_pct clamp(终审 F1:提议自动执行链路的硬前置)。
 *
 * 此前这里只校验形状，不校验 id——客户端三个纯函数(moveModule/resizeModule/toggleHidden)
 * 已经把 butler/foot 排除在外，但那只在客户端函数层生效；直接拼 JSON 打 /layout 能绕过去
 * (`tests/server-projects-http.test.ts` › "POST /layout" 的未知 id/越界 basis 用例)。
 * 未知 id(包括 butler/foot 本身，以及 __proto__ 这类原型链字面量)直接剔除而不是报错——
 * 跟客户端"认不出就不显示"的降级纪律一致，不为了一条脏 id 拒绝整个 layout 写入。
 *
 * I2(review 修复):这是写路径(POST /layout)专用的版本(多做 basis_pct clamp)。
 * 读路径(projectsService.ts 的 getLayout())需要同一条 id 白名单规则,但特意没有从
 * 这里 import——server 服务层反过来依赖 http 传输层是反向层级关系,projectsService.ts
 * 改成本地维护一份最小过滤(sanitizeStoredModules,同样基于 protocol.ts 的
 * LAYOUT_MODULE_IDS 常量,id 白名单不会走漂,只是各自独立不做 clamp)。
 */
/** 顶部行的默认宽度切分:项目区六成、右列四成。 */
const TOP_ROW_PROJECT_WIDTH = 60
const TOP_ROW_USAGE_WIDTH = 40

/** 顶部行的两列:左列项目区、右列(消耗数据 + 余额上下堆叠)。 */
const LEFT_COL = 0
const RIGHT_COL = 1

/**
 * 顶部行在引入 usage 时的最小篇幅。
 *
 * 真机实证两轮:
 * - 第一轮:Ben 把项目区拖到 23.8%(那时那行只放项目列表),加进消耗面板后内容区
 *   只剩 34px,数据都在但一行都看不见,界面像是坏了。
 * - 第二轮(2026-08-25 右列堆叠):这一行现在要装**三个**模块(左列项目区,右列
 *   消耗数据 + 余额上下摞),34% 下右列两个各自只有 140px / 76px,又都被截住。
 *   实测 48% 时指标卡两行全出来、余额四家卡片完整,故取 48。
 * 这一行的**职责一变再变**,所以每次形态变更那一次一次性抬到够用高度;
 * 之后 Ben 想拖多矮都随他,这里只在形态迁移那一次生效。
 */
const TOP_ROW_MIN_BASIS = 48

/**
 * 底部两栏在 widgets 退休时的最小篇幅(2026-08-25 版面重排,Ben 当日拍板 24%)。
 *
 * 跟 TOP_ROW_MIN_BASIS 同一条理由:**这一行的职责变了**——原来是一条只放两个数字格的
 * 组件小条(Ben 存的多半是 12%),现在要装随手记与一整格 Finder。12% 在真机上只有两三行
 * 可见,搬过去就是"数据都在但一行都看不见"。所以迁移时一次性抬到下限;之后他想拖多矮
 * 都随他,这里只在退休 widgets 那一次生效。**别的模块的高度一律不动。**
 */
const BOTTOM_ROW_MIN_BASIS = 24
const BOTTOM_ROW_NOTES_WIDTH = 40
const BOTTOM_ROW_FILES_WIDTH = 60

/**
 * 组件条退休(2026-08-25 版面重排):widgets → notes(40%) + files(60%),同一行并排。
 * 已经没有 widgets 时原样返回(幂等)。
 */
function migrateWidgetsModule(modules: readonly LayoutModule[]): LayoutModule[] {
  const sorted = [...modules].sort((left, right) => left.order - right.order)
  const at = sorted.findIndex(module => module.id === 'widgets')
  if (at === -1) return sorted
  const widgets = sorted[at] as LayoutModule
  const basis = Math.max(widgets.basis_pct ?? BOTTOM_ROW_MIN_BASIS, BOTTOM_ROW_MIN_BASIS)
  // 行号:旧存档有 row 就沿用;更老的存档没有这个字段,得自己给一个——客户端是按
  // 「排序后相邻且 row 相同」分组成一行的(见 client/Workbench.tsx 的 moduleRows),
  // row 缺省的模块永不参与合并,不给号这两栏就并不起来。取"现有最大行号 + 1",
  // 既保证跟前一个模块不同号(不会被并进上一行),又不跟任何已有行撞车。
  const maxRow = sorted.reduce((max, module) => Math.max(max, module.row ?? -1), -1)
  const row = widgets.row ?? maxRow + 1
  // 收起状态跟着走:他自己收起过的东西,不该在一次迁移里被擅自展开。
  const hidden = widgets.hidden === true ? { hidden: true } : {}
  const notes: LayoutModule = { id: 'notes', order: 0, basis_pct: basis, row, width_pct: BOTTOM_ROW_NOTES_WIDTH, ...hidden }
  const files: LayoutModule = { id: 'files', order: 0, basis_pct: basis, row, width_pct: BOTTOM_ROW_FILES_WIDTH, ...hidden }
  // **必须插在 widgets 原来的位置上,不能追加到末尾**——理由同下面 usage 那次迁移:
  // 相邻才是并排的充分条件,追到末尾会被中间的模块隔开。
  return [...sorted.slice(0, at), notes, files, ...sorted.slice(at + 1)]
    .map((module, order) => ({ ...module, order }))
}

/**
 * 旧布局存档迁移(2026-08-25 顶部分栏)。
 *
 * Ben 已经存过不含 usage 的布局。读到时自动补一条并与项目区并排,
 * **不重设他调过的其他模块高度**——那会把他的手动调整一次性抹掉。
 */
export function migrateLayoutModules(modules: readonly LayoutModule[]): LayoutModule[] {
  // **先迁移、后过滤**:'widgets' 已经不在 LAYOUT_MODULE_IDS 里了(见 protocol.ts 的
  // LEGACY_LAYOUT_MODULE_IDS 注释),先过滤的话迁移永远看不见它,界面上就是"底部两栏
  // 没出现,组件条也没了"。
  const retired = migrateWidgetsModule(modules)
  const known = retired.filter(module => (LAYOUT_MODULE_IDS as readonly string[]).includes(module.id))
  const sorted = [...known].sort((left, right) => left.order - right.order)

  /**
   * **模板写出来的排布一律原样放过**(2026-09-27,卡 TM)。
   *
   * todo / publish / review 三个 id 是 2026-09-21 布局模板那一次才有的;一份布局里出现
   * 它们任一个,就说明这份布局是模板(或用户在模板之上调过)写出来的,下面那两串迁移
   * (widgets 退休、把 projects/usage/quota 摆成"左列项目区 + 右列上下堆叠")说的全是
   * **更早的旧存档**形态,对它没有任何可迁的东西 —— 硬套上去就是改形:
   * 自媒体运营那份竖排里 usage / quota 是收起着摆在底部一排的(没有 col),
   * 迁移会把它们拔到项目区旁边,还把项目区从模板给的 20% 顶到 48%,
   * 于是**他看到的排布跟他刚切的那个模板不是一套**(选题池 / 发布计划被挤到屏幕下面)。
   *
   * 保留的是与别处同一条的两道:按白名单过滤(挡 butler/foot/幽灵 id)、order 重排成下标。
   */
  if (sorted.some(module => ['todo', 'publish', 'review'].includes(module.id))) {
    return sorted.map((module, order) => ({ ...module, order }))
  }

  const projects = sorted.find(module => module.id === 'projects')
  const row = projects?.row ?? 0
  const topBasis = Math.max(projects?.basis_pct ?? TOP_ROW_MIN_BASIS, TOP_ROW_MIN_BASIS)

  const hasUsage = sorted.some(module => module.id === 'usage')
  const hasQuota = sorted.some(module => module.id === 'quota')
  const rightPlaced = sorted.some(module => module.id === 'quota' && module.col === RIGHT_COL)

  // 已经是目标形态就原样返回(只补 order),不反复搬动用户后来自己调过的布局。
  if (hasUsage && hasQuota && rightPlaced) return sorted.map((m, order) => ({ ...m, order }))

  /**
   * 目标形态(2026-08-25 右侧上下堆叠):
   * 左列 = 项目区独占;右列 = 消耗数据 在上、余额/额度 在下。
   * 三者同 row;项目区 col=0,消耗数据与余额 col=1(同列即竖向堆叠)。
   *
   * **必须在项目区原来的位置就地插入,不能把这三个提到最前**——分组是按"排序后
   * 相邻"做的,所以三者必须连续;但把它们整体提前会打乱用户自己排过的顺序
   * (真机验收实证:用户把组件条放在第一位,迁移后被挤到项目区后面)。
   * 就地插入两者兼顾:既连续,又不动用户的相对排列。
   */
  const usageOld: LayoutModule = sorted.find(m => m.id === 'usage') ?? { id: 'usage', order: 0 }
  const quotaOld: LayoutModule = sorted.find(m => m.id === 'quota') ?? { id: 'quota', order: 0 }
  // 宽度用 `?? 默认值`:用户自己拖过的宽度要保住,迁移只补没有的,不覆盖已有的。
  // 右列两个模块共享同一个宽度(它们是竖着摞的),以 usage 的为准。
  const rightWidth = usageOld.width_pct ?? quotaOld.width_pct ?? TOP_ROW_USAGE_WIDTH

  const trio: LayoutModule[] = [
    {
      ...(projects ?? { id: 'projects', order: 0 }),
      row,
      col: LEFT_COL,
      width_pct: projects?.width_pct ?? TOP_ROW_PROJECT_WIDTH,
      basis_pct: topBasis,
    },
    // 高度:**只在"第一次进右列"那一次**按比例给新值,之后保住用户自己拖的。
    // 判据是 col 有没有落在 RIGHT_COL——没落过说明它还带着上一种布局形态下的尺寸,
    // 而那个数字换到竖向堆叠里含义完全变了(真机实证:usage 旧值 8 是它跟项目区
    // 左右并排时拖的,搬进列里后只剩一条标题栏,面板整个不可用)。
    // 消耗数据内容多(指标卡 + 方格图 + 趋势),给六五开的大头。
    {
      ...usageOld,
      row,
      col: RIGHT_COL,
      width_pct: rightWidth,
      basis_pct: usageOld.col === RIGHT_COL && usageOld.basis_pct !== undefined
        ? usageOld.basis_pct
        : Math.round(topBasis * 0.65),
    },
    {
      ...quotaOld,
      row,
      col: RIGHT_COL,
      width_pct: rightWidth,
      basis_pct: quotaOld.col === RIGHT_COL && quotaOld.basis_pct !== undefined
        ? quotaOld.basis_pct
        : Math.round(topBasis * 0.35),
    },
  ]

  const out: LayoutModule[] = []
  let placed = false
  for (const module of sorted) {
    if (['usage', 'quota'].includes(module.id)) continue
    if (module.id === 'projects') {
      out.push(...trio)
      placed = true
      continue
    }
    out.push(module)
  }
  // 存档里连 projects 都没有(理论上不该发生)时,把这一组放到最后,总比丢掉强。
  if (!placed) out.push(...trio)

  // 重排 order,让它与数组下标一致——插入后原来的号码会重号。
  return out.map((module, order) => ({ ...module, order }))
}

function sanitizeModules(modules: readonly LayoutModule[]): LayoutModule[] {
  return migrateLayoutModules(modules)
    .map(module => ({
      ...module,
      ...(module.basis_pct === undefined ? {} : { basis_pct: clampBasisPct(module.basis_pct) }),
    }))
}

/**
 * 横屏分支的净化(2026-09-18 横屏布局)。跟竖屏那份的差别只有一处,但很重要:
 * **不跑 migrateLayoutModules**。那一串迁移(widgets → notes+files、把 projects/usage/quota
 * 按 row/col 摆成"左列项目区 + 右列上下堆叠")说的全是**竖屏**那一版的形态;
 * 横屏是写死的五个区域,把竖屏的迁移套上去只会往横屏分支里塞一组它不使用的 row/col,
 * 还会把用户在横屏上排过的顺序按竖屏的规矩重排一遍。
 *
 * 保留的是与竖屏同一条的两道:按 LAYOUT_MODULE_IDS 白名单过滤(挡 butler/foot/__proto__,
 * 不可改清单第 1、4 条在服务端的兜底)、basis_pct clamp 到 8–70。
 */
function sanitizeLandscapeModules(modules: readonly LayoutModule[]): LayoutModule[] {
  return modules
    .filter(module => (LAYOUT_MODULE_IDS as readonly string[]).includes(module.id))
    .map((module, order) => ({
      ...module,
      order,
      ...(module.basis_pct === undefined ? {} : { basis_pct: clampBasisPct(module.basis_pct) }),
      // 2026-09-20 挪区:右侧栏里那一格的高度占比,同 rail_pct 那条纪律——客户端拖拽
      // 夹过一遍 14–80,直接拼 JSON 打过来能绕过去,存进一个只剩一条标题栏、自己拖不
      // 回来的格子。region 不用夹(它是枚举,isLayoutModule 那儿认不出就已经 400 了)。
      ...(module.side_pct === undefined ? {} : { side_pct: clampSidePct(module.side_pct) }),
    }))
}

function clampSidePct(value: number): number {
  return Math.min(LANDSCAPE_SIDE_MAX_PCT, Math.max(LANDSCAPE_SIDE_MIN_PCT, value))
}

/** 看板可选字段的三态解析:缺省=不动(undefined)、null=清掉、有值=写上;认不出就是 INVALID。 */
const INVALID = Symbol('invalid')

function parseNullable<T>(value: unknown, guard: (candidate: unknown) => candidate is T): T | null | undefined | typeof INVALID {
  if (value === undefined) return undefined
  if (value === null) return null
  return guard(value) ? value : INVALID
}

function isTaskPriority(value: unknown): value is TaskPriority {
  return typeof value === 'string' && (TASK_PRIORITIES as readonly string[]).includes(value)
}

/* —— 选题那三样(2026-09-21 选题池)。三个都按枚举把关,写错回 400 + 原话(同 priority)。 —— */

function isTaskKind(value: unknown): value is TaskKind {
  return typeof value === 'string' && (TASK_KINDS as readonly string[]).includes(value)
}

function isTopicContentType(value: unknown): value is TopicContentType {
  return typeof value === 'string' && (TOPIC_CONTENT_TYPES as readonly string[]).includes(value)
}

function isTopicStage(value: unknown): value is TopicStage {
  return typeof value === 'string' && (TOPIC_STAGES as readonly string[]).includes(value)
}

/**
 * 关联的 agent 窗口(一个功能点可以有好几个:额度耗尽做过交接就会跨家)。
 * 认不出 agent、或没有 session_id 的整条丢掉——界面拿它去 sessions 里现查状态,
 * 一个查不到的来源只会误导。
 */
function parseLinks(value: unknown, roleOrigin?: ExecutionRoleFact['origin']): TaskLink[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return []
    const raw = entry as Record<string, unknown>
    if (!isAgentId(raw.agent)) return []
    const sessionId = typeof raw.session_id === 'string' ? raw.session_id.trim() : ''
    if (sessionId === '') return []
    const note = typeof raw.note === 'string' ? raw.note.trim() : ''
    return [{ agent: raw.agent, session_id: sessionId, ...(note === '' ? {} : { note }),
      ...(roleOrigin !== undefined && isExecutionRole(raw.execution_role) ? { execution_role: { kind: raw.execution_role, origin: roleOrigin } } : {}) }]
  })
}

/** 冲刺的组成版本号。半条(只有 label 没有 version,或反过来)整条丢掉,不留读不懂的东西。 */
function parseVersions(value: unknown): SprintVersion[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return []
    const raw = entry as Record<string, unknown>
    const label = typeof raw.label === 'string' ? raw.label.trim() : ''
    const version = typeof raw.version === 'string' ? raw.version.trim() : ''
    return label === '' || version === '' ? [] : [{ label, version }]
  })
}

/** 项目区/文件夹的展示模式枚举(2026-08-25 地基)。与 protocol.ts 的字面量类型一一对应。 */
const PROJECTS_VIEWS = ['overview', 'board'] as const

/** 事务官那一行字能挂的三块(`POST /highlight` 校验用;动作 → 哪一块那张真表在 server/actorNotes.ts)。 */
const NOTE_REGIONS: readonly ActorNoteRegion[] = ['slot', 'files', 'board']

/** 看板排布方向(2026-08-25 横排/竖排开关)。与 protocol.ts 的字面量类型一一对应。 */
const BOARD_AXES = ['module-rows', 'module-columns', 'status-columns'] as const

/** POST /layout 的请求体校验(spec D11/D12)。 */
function parseLayout(body: unknown): { layout: WorkbenchLayout } | { error: string } {
  if (typeof body !== 'object' || body === null) return { error: 'body 必须是 JSON 对象' }
  const raw = (body as Record<string, unknown>).layout
  if (typeof raw !== 'object' || raw === null) return { error: 'layout 必须是对象' }
  const l = raw as Record<string, unknown>

  if (!Array.isArray(l.modules) || !l.modules.every(isLayoutModule)) {
    return { error: 'layout.modules 必须是模块数组' }
  }
  if (typeof l.butler !== 'object' || l.butler === null) return { error: 'layout.butler 必须是对象' }
  const butler = l.butler as Record<string, unknown>
  if (typeof butler.corner !== 'string' || !(BUTLER_CORNERS as readonly string[]).includes(butler.corner)) {
    return { error: `layout.butler.corner 必须是 ${BUTLER_CORNERS.join(' / ')} 之一` }
  }
  if (typeof butler.min !== 'boolean') return { error: 'layout.butler.min 必须是布尔值' }

  // A6:pos 是 additive 可选字段——旧存档/旧客户端不带这个键,不该因此拒绝整条 /layout 写入。
  // 带了就必须形状对(x_pct/y_pct 都是数字),否则明确报错(不是悄悄丢掉一个写坏的值)。
  let pos: { x_pct: number, y_pct: number } | undefined
  if (butler.pos !== undefined) {
    if (typeof butler.pos !== 'object' || butler.pos === null) return { error: 'layout.butler.pos 必须是对象' }
    const p = butler.pos as Record<string, unknown>
    if (typeof p.x_pct !== 'number' || typeof p.y_pct !== 'number') {
      return { error: 'layout.butler.pos 必须包含数字 x_pct 与 y_pct' }
    }
    pos = { x_pct: clampButlerPosPct(p.x_pct), y_pct: clampButlerPosPct(p.y_pct) }
  }

  // W4:size 同 pos 的规矩——additive 可选,旧客户端不带这个键不该被拒;带了就必须形状对。
  // **下限在这里也夹一遍**:客户端拖拽时已经夹过,但直接拼 JSON 打 /layout 能绕过客户端,
  // 存进一个把叫停入口挤没的尺寸(不可改清单第 1 条,与 sanitizeModules 挡 butler/foot
  // 是同一条纪律:客户端函数层的排除只在客户端生效)。**这里只夹下限,不夹上限**——
  // 上限依赖视口(屏幕多宽多高),服务端拿不到这个信息,由客户端渲染时再夹一次
  // (见 Butler.tsx 的 clampButlerSize 调用)。下限不一样:它守的不是"数值是否合法",
  // 而是不可改清单第 1 条本身,所以服务端必须自己也兜一层,不能只信客户端。
  let size: { w_px: number, h_px: number } | undefined
  if (butler.size !== undefined) {
    if (typeof butler.size !== 'object' || butler.size === null) return { error: 'layout.butler.size 必须是对象' }
    const s = butler.size as Record<string, unknown>
    if (typeof s.w_px !== 'number' || typeof s.h_px !== 'number') {
      return { error: 'layout.butler.size 必须包含数字 w_px 与 h_px' }
    }
    size = {
      w_px: Number.isFinite(s.w_px) ? Math.max(MIN_BUTLER_W_PX, s.w_px) : MIN_BUTLER_W_PX,
      h_px: Number.isFinite(s.h_px) ? Math.max(MIN_BUTLER_H_PX, s.h_px) : MIN_BUTLER_H_PX,
    }
  }

  // 2026-08-25 地基:项目区的展示模式。同 butler.pos 的规矩——旧客户端不带这个
  // 键不该被拒,带了就必须是合法枚举值(不是悄悄丢掉一个写坏的值)。**必须在这里原样透传**,
  // 否则下面重建 layout 对象时会把它们整个丢掉,界面切了模式刷新一下就弹回去。
  if (l.projects_view !== undefined && !(PROJECTS_VIEWS as readonly string[]).includes(l.projects_view as string)) {
    return { error: `layout.projects_view 必须是 ${PROJECTS_VIEWS.join(' / ')} 之一` }
  }
  if (l.board_axis !== undefined && !(BOARD_AXES as readonly string[]).includes(l.board_axis as string)) {
    return { error: `layout.board_axis 必须是 ${BOARD_AXES.join(' / ')} 之一` }
  }
  if (l.today_view !== undefined && !(TODAY_VIEWS as readonly string[]).includes(l.today_view as string)) {
    return { error: `layout.today_view 必须是 ${TODAY_VIEWS.join(' / ')} 之一` }
  }
  // 2026-09-11 纯净模式:同上的规矩——旧客户端不带这个键不该被拒,带了就必须是布尔值。
  if (l.pureMode !== undefined && typeof l.pureMode !== 'boolean') {
    return { error: 'layout.pureMode 必须是布尔值' }
  }
  /**
   * 2026-09-22「用自然语言改布局」:用户自己起的模块名。同 butler.pos 那条规矩 ——
   * additive 可选,旧客户端不带这个键不该被拒;带了就必须形状对。
   *
   * **认不出的模块 id 明确 400,不悄悄丢掉**(同 region 那一条):悄悄丢掉的话他改了个名、
   * 刷新一下又变回去,而界面上没有任何地方能告诉他为什么。
   * 长度也在这里夹一道 —— 客户端与词表都挡过一遍,直接拼 JSON 打 /layout 能绕过去,
   * 存进一个把模块头挤爆的名字(同 side_pct 那条"两处都夹"的理由)。
   */
  let titles: Record<string, string> | undefined
  if (l.titles !== undefined) {
    if (typeof l.titles !== 'object' || l.titles === null || Array.isArray(l.titles)) {
      return { error: 'layout.titles 必须是对象' }
    }
    const next: Record<string, string> = {}
    for (const [id, value] of Object.entries(l.titles as Record<string, unknown>)) {
      if (!(LAYOUT_MODULE_IDS as readonly string[]).includes(id)) {
        return { error: `layout.titles 里没有「${id}」这一格` }
      }
      if (typeof value !== 'string') return { error: `layout.titles.${id} 必须是字符串` }
      const trimmed = value.trim()
      if (trimmed === '') continue // 空串 = 撤掉这个自定义名字,同 renameModule。
      if (trimmed.length > LAYOUT_MAX_TITLE) {
        return { error: `layout.titles.${id} 最多 ${LAYOUT_MAX_TITLE} 个字` }
      }
      next[id] = trimmed
    }
    // 一个都不剩时整个键缺席 —— 存一个 `{}` 进去,读的人会以为"他设过、只是设成了空"。
    if (Object.keys(next).length > 0) titles = next
  }
  // 2026-09-18 横屏布局:横屏那一版排布单独一个分支。同 butler.pos 的规矩——
  // additive 可选,旧客户端(以及从没在横屏上动过布局的机器)不带这个键不该被拒;
  // 带了就必须形状对,否则明确报错而不是悄悄吞掉一份写坏的排布。
  let landscape: {
    modules: LayoutModule[]
    rail_pct?: number
    butler_pos?: { x_pct: number, y_pct: number }
  } | undefined
  if (l.landscape !== undefined) {
    if (typeof l.landscape !== 'object' || l.landscape === null) {
      return { error: 'layout.landscape 必须是对象' }
    }
    const land = l.landscape as Record<string, unknown>
    if (!Array.isArray(land.modules) || !land.modules.every(isLayoutModule)) {
      return { error: 'layout.landscape.modules 必须是模块数组' }
    }
    // 2026-09-18 分栏把手:左栏宽度。同 butler.size 下限那条纪律——客户端拖拽已经夹过
    // 一遍 5–30,但直接拼 JSON 打过来能绕过客户端,存进一个自己拖不回来的界面。
    // 非有限数字(NaN / Infinity / 字符串)明确报错,不悄悄换成一个默认值:那是把一份
    // 写坏的排布静静吞掉,下次读出来还是它。
    let railPct: number | undefined
    if (land.rail_pct !== undefined) {
      if (typeof land.rail_pct !== 'number' || !Number.isFinite(land.rail_pct)) {
        return { error: 'layout.landscape.rail_pct 必须是数字' }
      }
      railPct = Math.min(LANDSCAPE_RAIL_MAX_PCT, Math.max(LANDSCAPE_RAIL_MIN_PCT, land.rail_pct))
    }
    // 2026-09-18:横屏那一份事务官浮窗落点。形状与夹法跟顶层 butler.pos 逐字相同
    // ——同一件事在两处必须同一个读法,不能一处夹 0–95、另一处不夹。
    let landButlerPos: { x_pct: number, y_pct: number } | undefined
    if (land.butler_pos !== undefined) {
      if (typeof land.butler_pos !== 'object' || land.butler_pos === null) {
        return { error: 'layout.landscape.butler_pos 必须是对象' }
      }
      const p = land.butler_pos as Record<string, unknown>
      if (typeof p.x_pct !== 'number' || typeof p.y_pct !== 'number') {
        return { error: 'layout.landscape.butler_pos 必须包含数字 x_pct 与 y_pct' }
      }
      landButlerPos = { x_pct: clampButlerPosPct(p.x_pct), y_pct: clampButlerPosPct(p.y_pct) }
    }
    landscape = {
      modules: sanitizeLandscapeModules(land.modules),
      ...(railPct === undefined ? {} : { rail_pct: railPct }),
      ...(landButlerPos === undefined ? {} : { butler_pos: landButlerPos }),
    }
  }

  return {
    layout: {
      modules: sanitizeModules(l.modules),
      butler: {
        corner: butler.corner as typeof BUTLER_CORNERS[number],
        min: butler.min,
        ...(pos === undefined ? {} : { pos }),
        ...(size === undefined ? {} : { size }),
      },
      ...(l.projects_view === undefined
        ? {}
        : { projects_view: l.projects_view as typeof PROJECTS_VIEWS[number] }),
      ...(l.board_axis === undefined ? {} : { board_axis: l.board_axis as typeof BOARD_AXES[number] }),
      ...(l.today_view === undefined ? {} : { today_view: l.today_view as TodayViewStyle }),
      ...(l.pureMode === undefined ? {} : { pureMode: l.pureMode as boolean }),
      ...(titles === undefined ? {} : { titles }),
      ...(landscape === undefined ? {} : { landscape }),
    },
  }
}

/** POST /snap 的 rect 字段校验(spec W1–W9):{x,y,w,h} 四项都得是有限数字,少一样就整体判失败。 */
function parseRect(value: unknown): HelperRect | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const r = value as Record<string, unknown>
  const nums = [r.x, r.y, r.w, r.h]
  if (!nums.every(n => typeof n === 'number' && Number.isFinite(n))) return undefined
  return { x: r.x as number, y: r.y as number, w: r.w as number, h: r.h as number }
}

/**
 * 把这一条的回包记进请求号台账(2026-10-12):路由照常 `sendJson`,这里在 `end` 那一下抄一份状态与原文。
 * 没回包连接就断了 = 没办成,不记(下一次照常办)。
 */
function recordForClientKey(res: ServerResponse, got: Extract<ClientKeyBegin, { kind: 'fresh' }>): void {
  const end = res.end.bind(res) as (...args: unknown[]) => ServerResponse
  res.end = ((...args: unknown[]) => {
    const chunk = args[0]
    const body = typeof chunk === 'string' ? chunk : chunk instanceof Uint8Array ? Buffer.from(chunk).toString('utf8') : ''
    // 先记账再发(2026-10-24):客户端断开后再 end 可能抛错——账得在,同号重送才拿得到同一回包。
    got.finish(res.statusCode, body)
    return end(...args)
  }) as ServerResponse['end']
  res.on('close', () => got.abort())
}

/** 同一个号又来了:原样回第一次那一份,对象上多一格 `replayed: true`(手机据此知道这一句早就到了)。 */
function sendReplay(res: ServerResponse, status: number, body: string): void {
  let payload: unknown
  try { payload = JSON.parse(body) }
  catch { payload = undefined }
  if (payload !== null && typeof payload === 'object' && !Array.isArray(payload)) {
    sendJson(res, status, { ...(payload as Record<string, unknown>), replayed: true })
    return
  }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(body)
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(text)
}

/**
 * `GET /agents/icon/:id` 的缓存策略(2026-09-26,卡 LG)。
 * 图标很少变,但**得能变**(他换了一版客户端、换了图标):所以是「缓存一小时,过期必须回来问一次」,
 * 配 ETag 走 304 —— 过期之后那一趟也只是几十字节的头,不是十几 KB 的图。
 */
const ICON_CACHE_CONTROL = 'max-age=3600, must-revalidate'

/**
 * 一张图标的回包(2026-09-26,卡 LG2 从 `/agents/icon` 里提出来)。
 * `/agents/icon/:id`(登记表里那几家)与 `/apps/icon/:key`(坞上每一格)**走同一份**:
 * 两条路的缓存口径不能各写一遍,不然一条走了 304、另一条没走,同一张图在同一页上传两遍。
 */
function sendIcon(req: IncomingMessage, res: ServerResponse, icon: { png: Uint8Array, etag: string }): void {
  const ifNoneMatch = req.headers['if-none-match']
  if (etagMatches(typeof ifNoneMatch === 'string' ? ifNoneMatch : undefined, icon.etag)) {
    res.writeHead(304, { etag: icon.etag, 'cache-control': ICON_CACHE_CONTROL })
    res.end()
    return
  }
  res.writeHead(200, {
    'content-type': 'image/png',
    'content-length': String(icon.png.length),
    etag: icon.etag,
    'cache-control': ICON_CACHE_CONTROL,
  })
  res.end(Buffer.from(icon.png))
}

/**
 * 带编号的错误(2026-09-22)。回 `{ error, code }`,同时往本机日志里写同一个编号。
 *
 * ## 为什么要有编号
 *
 * Ben 不看日志、不走命令行。他能做的是**念出屏幕上那六个数字**。
 * 有了这一行,统筹在 `~/.dsh/logs/web.stdout.log` 里 grep 一下 `WB-123456` 就落到现场;
 * 自动上报开着的话,中转那边同一个编号也躺着一条。三处对得上,靠的就是这一个函数。
 *
 * ## 为什么不是所有 sendJson 都换成它
 *
 * 这一版只给**体检与修复那条路**(`/setup/*`、`/update/*`、`/diag/*`)上的错误加编号。
 * 看板那一大片是 `postSilently` 的地盘(失败了等下一拍轮询),给那里加编号等于
 * 在一个本来就不显示错误的地方造一个没人看的号。范围写在交接里,以后要扩是另一刀。
 *
 * 客户端那边 `parse()` 读的是 `body.error`,多一个 `code` 字段是**向后兼容**的:
 * 老页面看不见它,新页面把它显示在报错后面。
 */
function sendCodedError(
  res: ServerResponse,
  status: number,
  message: string,
  log: (line: string) => void = line => console.log(line),
  atMs: number = Date.now(),
): void {
  const code = diagCode('plugin', atMs)
  log(`[诊断] ${code} plugin/http:${message}`)
  sendJson(res, status, { error: message, code })
}

/**
 * 纯文本响应(布局快照那两条只读路由)。charset 必须带:markdown/html 里全是中文,
 * 不带的话浏览器按 latin-1 猜,拿到的是乱码。
 */
function sendText(res: ServerResponse, status: number, contentType: string, text: string): void {
  res.writeHead(status, { 'content-type': `${contentType}; charset=utf-8` })
  res.end(text)
}

/** 原样取出 ?query 那一截(含问号),代理转发时拼回去;没有就是空串。 */
function queryOf(rawUrl: string | undefined): string {
  const idx = (rawUrl ?? '').indexOf('?')
  return idx === -1 ? '' : (rawUrl ?? '').slice(idx)
}

/** 从 `?a=1&token=x` 这样的 query 串里去掉一个参数;去空了就返回空串。 */
function stripQueryParam(query: string, name: string): string {
  if (query === '' || !query.includes(`${name}=`)) return query
  const params = new URLSearchParams(query.slice(1))
  params.delete(name)
  const rest = params.toString()
  return rest === '' ? '' : `?${rest}`
}

const BUTLER_PROXY_PREFIX = '/butler/proxy/'

/** GET /butler/item/:id/turns 的 limit:默认 20、上限 100;不是正整数就按默认。 */
export const TURNS_LIMIT_DEFAULT = 20
export const TURNS_LIMIT_MAX = 100

export function turnsLimit(url: string | undefined): number {
  const query = (url ?? '').split('?')[1]
  if (query === undefined) return TURNS_LIMIT_DEFAULT
  const raw = new URLSearchParams(query).get('limit')
  if (raw === null || !/^\d+$/.test(raw)) return TURNS_LIMIT_DEFAULT
  const parsed = Number(raw)
  if (parsed <= 0) return TURNS_LIMIT_DEFAULT
  return Math.min(parsed, TURNS_LIMIT_MAX)
}

/**
 * 本机后端里手机能碰的那一面(去掉 /butler/proxy/ 前缀后的路径)。
 * 转发用的是 fetch,WHATWG URL 会把 `..`、`%2e%2e`、反斜杠都归一化——`api/../admin/x` 到后端就是 /admin/x,
 * 所以先解码、把反斜杠当斜杠,任何一段是 `.`/`..` 就直接不算公开路径。
 */
export function isButlerPublicPath(rest: string): boolean {
  let decoded: string
  try {
    decoded = decodeURIComponent(rest)
  }
  catch {
    return false
  }
  const segments = decoded.replace(/\\/g, '/').split('/')
  if (segments.some((seg) => seg === '.' || seg === '..' || seg === '')) {
    // 空段 = 连续斜杠或结尾斜杠;/uploads/x/ 这种目录形态后端也不服务,一并拒。
    return false
  }
  return decoded.startsWith('api/') || decoded.startsWith('uploads/') || decoded === 'health'
}

/**
 * 读**二进制** body,带一个上限(2026-09-21 会议模式)。
 *
 * 为什么不用 `readBody` 再 base64:会议的一段录音是几 MB,base64 之后多 33% 的内存与带宽,
 * 而这一段的唯一去处就是落盘。超过上限就**当场停住并如实回一句**——不是悄悄截断:
 * 截断出来的音频文件解码器一样能打开,只是后半段没了,那种错没人查得出来。
 */
async function readRawBody(req: IncomingMessage, maxBytes: number): Promise<{ ok: true, body: Buffer } | { ok: false, error: string }> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    total += buf.length
    if (total > maxBytes) return { ok: false, error: `这一段超过 ${Math.round(maxBytes / 1024 / 1024)}MB,没有收` }
    chunks.push(buf)
  }
  return { ok: true, body: Buffer.concat(chunks) }
}

/**
 * 请求号那一层先读过的 body(2026-10-12,卡「手机交代只执行一次」):它要先看 `client_key` 再决定办不办,
 * 读过之后流就空了 —— 路由里那一次 `readBody` 从这里拿原文。
 */
const bufferedBodies = new WeakMap<IncomingMessage, string>()

async function readBody(req: IncomingMessage): Promise<string> {
  const buffered = bufferedBodies.get(req)
  if (buffered !== undefined) return buffered
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * 读 body 并解析成对象。解析不了就**在这里**回 400 并返回 undefined——
 * 调用处只要 `if (body === undefined) return`,不用每条路由重抄六行 try/catch。
 * 空 body 当成 `{}`(有些路由的参数全是可选的)。
 */
/**
 * 选题指挥台那四条路由(2026-09-22)。**一张表,不是四个 `||`**:
 * 四条共用同一道门、同一份 `选题/<名>/` 目录解析,分支从"这是哪一条"开始。
 */
const TOPIC_DECK_PATHS: ReadonlySet<string> = new Set([
  '/topic/docs', '/topic/doc/save', '/topic/review', '/topic/run',
  // 2026-09-23:接需求先给确认点(维护者 13:05)。挂在同一道门下 —— 它读写的是同一个
  // `选题/<名>/` 目录(`框架.md` 顶部那一节 + `审核记录.jsonl` 那一行)。
  '/topic/confirm',
])

/**
 * 需求指挥台那五条路由(2026-09-22,审视第三节「两条模板要的是同一个东西」)。
 * 与上面那张表同一个路子:五条共用同一道门、同一份 `docs/需求/<名>/` 目录解析。
 *
 * 第五条 `/feature/record` 是需求卡独有的那一件 —— 把结论落进她仓库的决策记录。
 */
const FEATURE_DECK_PATHS: ReadonlySet<string> = new Set([
  '/feature/docs', '/feature/doc/save', '/feature/review', '/feature/run', '/feature/record',
  // 2026-09-23 断点 B 与 C 各加的那三条。挂在同一道门下,因为它们要的是同一样东西:
  // 「这张卡是需求吗、挂的哪个项目、那个项目在本机的路径是什么」。
  '/feature/result', '/feature/branch', '/feature/ship',
  // 2026-09-23:接需求先给确认点(维护者 13:05)。同一道门、同一个 `docs/需求/<名>/`。
  '/feature/confirm',
])

async function readJsonBody(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<Record<string, unknown> | undefined> {
  const text = await readBody(req)
  let parsed: unknown
  try {
    parsed = JSON.parse(text === '' ? '{}' : text) as unknown
  }
  catch {
    sendJson(res, 400, { error: 'body 不是合法 JSON' })
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    sendJson(res, 400, { error: 'body 必须是一个对象' })
    return undefined
  }
  return parsed as Record<string, unknown>
}

export async function startWorkbenchServer(
  options: StartWorkbenchServerOptions,
): Promise<WorkbenchServer> {
  const {
    service, projects, machine, badges, calendar, runCommand, helper, orchestrator, scenes, template, xhs, collect, collectors, registry, dock, brief,
    feed,
    aidj,
    modules, userLayer, devTool, layoutAsk, meeting, callRecords, evolve,
    daily, onAppsChanged, usage, tasks, notes, graphify, archify, codexReconcile, claudeRecover, waitingPump, sessionAnswer, peakSchedule,
    sentinel, reveal, layoutSnapshot, highlight, butlerSession, butler, connector, onboarding, authorization, routines,
    materialize,
    callOut,
    relayWatch,
    deviceDirectory,
    appearance, onboardingTurns, sessionTurns, sessionDigest, sessionLibrary, onAgentHook, rtcCall, channel, channelWorker,
    runInCwd, selfUpdate, shipFollowUp,
    composer, approvals, approvalGrants, questions,
  } = options
  const { rules } = options

  /**
   * 用户层「技能」格现扫一遍(2026-10-22,卡「用户层技能生效」):派活技能库 = 本体 ∪ 这一格,
   * 同名以用户层为准。扫不动回空表(用户层缺席 / 读坏),本体那几件照常可用。
   */
  const userLayerSkillsNow = async (): Promise<UserLayerSkill[]> => {
    if (userLayer === undefined) return []
    try { return await scanUserLayerSkills(join(userLayer.dir, '技能')) }
    catch { return [] }
  }
  const processHealth = options.processHealth
  const liveSendBufferMax = options.liveSendBufferMaxBytes ?? LIVE_SEND_BUFFER_MAX_BYTES
  const { prompts } = options
  const { agentCaps, loginLauncher, windowQuota } = options
  // 一问一答当场答那一下问模型的口(2026-10-02,卡「语音交代慢与老问上限」)。缺席 = 那道岔口不生效。
  const { quickAnswer } = options
  // 她要跟电话那头聊的那一条资讯(2026-10-13,卡「播客页重做」)。缺席 = /feed/dig/call 404。
  const { feedDig } = options
  /**
   * 一件事一份、进度靠证据(2026-09-25,卡 N)。驱动在 createButlerItem 之后才造得出来(它要那几个函数),
   * 但 composeState 在那之前就可能被叫到 —— 所以这里先占个位,造好了再填。
   */
  const progressService = options.items?.progress
  let itemDriver: ItemDriver | undefined
  const { agents, callState, sessionChildren } = options
  /**
   * 通话每回合的计时(2026-09-23,通话延迟那张卡)。**不是一件可选依赖** ——
   * 它只是个空柜台,工人不报就一直是空的,没有任何代价;而做成可选项的话,
   * 「体检页为什么没数」就多了一种解释(没启用 / 没报上来),那是多出来的一处会错的地方。
   */
  const channelLatency = createChannelLatencyStore()
  /**
   * 自定义模块的单开来源(2026-09-22,C7「自定义模块真边界」)。
   *
   * 令牌在这儿就建好(那台监听要等本服务 listen 完才起得来,而 handle 里从第一条请求起
   * 就要能验令牌)。没配 `moduleOrigin` 就一个都不签 —— 于是任何带模块令牌的请求都验不过,
   * 而模块页面本来也端不出来。
   */
  const moduleTokens: ModuleTokens | undefined = options.moduleOrigin === undefined
    ? undefined
    : options.moduleOrigin.tokens ?? createModuleTokens()
  let moduleOriginServer: ModuleOriginServer | undefined
  /**
   * ★ **一本只追加的任务日志 + 一处动作闸**(2026-10-02,卡 AG;维护者:「网易云是一个例子,你要有机制上的调整」)。
   *
   * 闸管两件事,**判据只在 `actionGate.ts` 一处**,管线只许问 `allow()`:
   * ① 这件事收场了(她点了办完 / 取消)→ 一下都不再动那一家;
   * ② 同一件事 · 同一家 · 同一种动作有次数与间隔上限,到顶停下并如实说。
   *
   * 「这件事此刻什么状态」要的是**同步**答案(闸挂在几条热路上:送话、开窗、每一拍读窗),
   * 而看板那一份是落盘的、读它要 await。所以这里放一张**小缓存**:问到的时候拿缓存答,
   * 顺手踢一次异步刷新(至多 `JOB_PHASE_FRESH_MS` 一次)。
   * **第一次问必然答「查不出」→ 放行**(那是对的:什么都不知道时不许拦她的活);
   * 之后最多差这么一点点,而盯窗那几条路本来 4~8 秒才一拍,够用。
   */
  /** 此刻认得出的那几条会话(文件型 + 窗口型登记表里那几条)。闸判会话键要它。 */
  function jobSessionsNow(): readonly { agent: string, session_id: string }[] {
    const out: { agent: string, session_id: string }[] = []
    for (const one of service.getState().sessions) out.push({ agent: one.agent, session_id: one.session_id })
    for (const entry of agents?.view().entries ?? []) {
      for (const one of entry.sessions) {
        if (!registryOnlySession(one)) continue
        if (out.some(had => had.agent === entry.id && had.session_id === one.session_id)) continue
        out.push({ agent: entry.id, session_id: one.session_id })
      }
    }
    return out
  }

  const JOB_PHASE_FRESH_MS = 2000
  /**
   * ★ **「这件事收场了没有」只有一处判法**(2026-10-02;审计第二表第 14 条)。
   *
   * 这里原来自己拼一张 `job -> phase` 的表,而且**只认事项 id** —— 会话键(替她答 / 捎话那几条路的键)
   * 一律答「查不出」,于是那几条路上闸的第一条规矩(收场了就不再动那一家)等于没有。
   * 现在与 `index.ts` 那一份**同一个函数**:`jobKey.jobPhaseOf`(事项 id 看卡;会话键先看有没有卡
   * 认领了这条会话,再看这条会话还在不在清单上;什么都查不到 → `unknown` 放行)。
   */
  let jobPhaseTasks: readonly JobKeyTask[] = []
  let jobPhaseAt = 0
  let jobPhaseLoading = false
  function refreshJobPhases(): void {
    if (tasks === undefined || jobPhaseLoading) return
    const nowMs = Date.now()
    if (nowMs - jobPhaseAt < JOB_PHASE_FRESH_MS) return
    jobPhaseLoading = true
    void tasks.list()
      .then((state) => {
        jobPhaseTasks = state.tasks.map(task => ({
          id: task.id,
          status: task.status,
          ...(task.client_dispatch === undefined
            ? {}
            : { client_dispatch: {
                family: task.client_dispatch.family,
                ...(task.client_dispatch.session_id === undefined ? {} : { session_id: task.client_dispatch.session_id }),
              } }),
        }))
        jobPhaseAt = Date.now()
      })
      .catch(() => { jobPhaseAt = Date.now() })
      .finally(() => { jobPhaseLoading = false })
  }
  /**
   * 账与闸**优先用传进来的那一份**(`index.ts` 造的,捎话巡检用的也是它 —— 全进程一本账)。
   * 没传(用例、老宿主)就在这儿造一份本地的:闸照样生效,只是账查不到别的进程里的事件。
   */
  const jobLog = options.jobLog ?? createJobLog()
  /** 多人协作区总开关:放在最前面,下面所有装配点都读它(缺席 = 开,兼容老宿主与单测)。 */
  const collabEnabled = options.collabEnabled ?? true
  /**
   * 协作区的 Agent 小鼠标(2026-10-21,`collabPresence.ts`):账上记一条,板上那只小鼠标跟着动。
   * 经 `/live` 推 `kind:'presence'`,**不进快照、不落盘**。总开关关着就一条都不推。
   */
  const collabPresence = createPresenceBoard()
  jobLog.listen?.((event) => {
    if (!collabEnabled) return
    const presence = presenceOfJob(event)
    if (presence === undefined) return
    collabPresence.apply(presence)
    broadcast({ kind: 'presence', presence })
  })
  /** 带着有效个人访问令牌的那几条请求(授权表那一道按「他本人在点」放行)。 */
  const personalRequests = new WeakSet<IncomingMessage>()
  const actionGate = options.actionGate ?? createActionGate({
    phaseOf: (job) => {
      refreshJobPhases()
      return jobPhaseOf({
        job,
        tasks: jobPhaseTasks,
        // 此刻认得出的那几条会话(文件型 + 窗口型登记表里那几条,与捎话候选池同一份)——
        // 会话键要靠它才判得出收没收场;两处判得不一样的话,闸会把还在的那条会话当成「没了」。
        sessions: jobSessionsNow(),
      })
    },
    log: jobLog,
    now: () => new Date(),
    name: family => targetTitle(dispatchTargetsNow(), family),
  })

  /**
   * 派活第一段:**把那段交代送进那家客户端的窗口**(2026-09-21;2026-10-02 后面换成引擎)。
   *
   * 这里只剩派活自己的事:那句话归哪张卡、送出那一刻的会话基线(认新会话用)、
   * 候选里有没有这一家、读不到窗口的那几家当场拦下。**怎么送**一样都不在这儿 ——
   * 挑包、拉起来、叫台前、没窗口就开窗、存草稿、打字发送、读窗核实全在
   * `engine/adapters/window.ts` 一处;过闸、落账、重试、换路在 `engine/engine.ts` 一处。
   *
   * 引擎没接进来就整条能力缺席(`/dispatch/client` 回 404),**不假装送得出去**。
   */
  const clientDispatch = options.engine === undefined ? undefined : createClientDispatch({
    engine: options.engine,
    // 能送话的有哪几家:登记表那一份(卡 Z)。
    targets: () => dispatchTargetsNow(),
    // 读不到窗口的那几家(2026-10-01):送之前当场拦下,与派活、电话里「能派谁」同一句。
    unreadable: () => unreadableAppsNow(),
    sessionIdsOf: family => service.getState().sessions
      .filter(session => session.agent === family)
      .map(session => session.session_id),
    now: () => new Date(),
  })

  /** 送出去的那段话对上了哪条会话(请求驱动 + 10s 限频,搭在 /state 那一拍上)。 */
  const dispatchMatcher = tasks === undefined ? undefined : createDispatchMatcher({
    update: (id, dispatch) => tasks.update(id, { clientDispatch: dispatch }),
    now: () => new Date(),
  })

  /** 排期风险的「上一拍是什么档」记忆。只活在内存里,重启即忘(重启后第一拍重新建基线)。 */
  const riskWatcher = createRiskWatcher(() => Math.floor(Date.now() / 1000))
  const host = options.host ?? DEFAULT_HOST
  const tickIntervalMs = options.tickIntervalMs ?? DEFAULT_TICK_MS
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS
  const credentialFile = options.credentialFile ?? defaultCredentialFile()
  /** 「一键接上」的那三只手。缺席 = 这台服务没接这条路(那条路由整条 404,界面照旧只剩粘密钥)。 */
  const claudeConnect = options.claudeConnect
  const model = options.model
  /**
   * 派活的第二只手:**经中转发给 GPT / 豆包**(2026-09-22)。
   *
   * 模型服务整块没接进来就**缺席**(`/dispatch/api` 回 404),不假装发得出去 ——
   * 与窗口那只手在壳没接时回 404 是同一条纪律。凭据用的就是工作台自己那一份中转令牌
   * (`model.endpoint()`),这条路不新存、不新领、不碰任何上游 Key。
   */
  const apiDispatch = model === undefined
    ? undefined
    : createApiDispatch({ endpoint: () => model.endpoint(), now: () => new Date() })
  /*
   * ★ **命令行 / 接口两条通道登进引擎的登记表**(2026-10-03,卡「派活三只手收进引擎」;
   * 设计 `docs/设计-派活三只手收进引擎-2026-10-03.md`)。
   *
   * 它们要的几样本机能力(起进程、探命令行、备环境、接口那条中转)都在这一层手里,所以在这儿登;
   * 引擎本身在 `index.ts` 造。从此派活三条通道都在引擎里:同一道闸、同一本账、一个挑路的主人。
   * 没有登记处(老宿主 / 用例没给)= 这两条通道不存在,派活如实说「没有能用的手」—— 不假装。
   */
  if (options.engineRegistry !== undefined) {
    const resolveCli = options.dispatchRun?.resolveCli ?? (family => resolveAgentCli(family, {
      pathEnv: process.env.PATH,
      home: options.paths?.home ?? process.env.HOME ?? '',
      exists: existsSync,
      listDir: (dir) => { try { return readdirSync(dir) } catch { return [] } },
    }))
    const runCli = options.dispatchRun?.runCli
    const nameOf = (family: string): string => dispatchTargetsNow().find(one => one.id === family)?.title ?? family
    // 起进程那一样没接(老宿主 / 用例没给)→ 命令行这条通道不登记,与从前「这台电脑上没接」同义。
    if (runCli !== undefined) {
      for (const family of CLI_FAMILIES) {
        options.engineRegistry.register(createCliAdapter(family, {
          resolveCli,
          runCli,
          ...(options.dispatchRun?.envForCli === undefined ? {} : { envForCli: options.dispatchRun.envForCli }),
          resultDir: options.dispatchRun?.resultDir ?? '/tmp',
          // relay(续说)那一次起进程要的 cwd:续跑不吃 cwd(Kimi 会话自带上下文),给一个稳的落点。
          sayCwd: () => (options.paths?.home === undefined ? '/tmp' : join(options.paths.home, '.dsh', 'workbench')),
          sessionCwd: (sessionId) => cliDispatchSessionCwd('kimi', sessionId),
          now: () => new Date(),
          name: nameOf,
        }))
      }
    }
    if (apiDispatch !== undefined) {
      for (const family of API_DISPATCH_FAMILIES) {
        options.engineRegistry.register(createApiAdapter(family, {
          send: input => apiDispatch.send(input),
          // 中转明说没配这一家 → 这条通道不存在(2026-09-27 卡 MS);没问到过照旧算有,不猜。
          configured: (one) => { const providers = relayProvidersNow(); return providers === undefined ? undefined : relayHasProviderFor(one, providers) },
          name: nameOf,
        }))
      }
    }
  }
  /**
   * 派活从头到尾由工作台自己跑(2026-09-24,卡 F,理由在 `server/dispatchRun.ts` 文件头)。
   * 三只手各自缺席时这一格照样在:派不出去就如实失败,卡上写清是哪只手、为什么。
   */
  /*
   * ★ 交回核验 → 推进模块(2026-10-29,可靠执行闭环第一批第 4 步):`settleVerify` / `verifyDelivered`
   * 的职责迁入 `server/taskExecutionDelivery.ts` —— 凡交回都核(CLI / 窗口 / 接口 / 事务官自办)、
   * 缺验收从委托提取默认条件、缺证据补证据(代跑超时异步回写)、退修派不出去卡回「等你确认」由
   * 恢复记录接着推、用户层热装 ok 才记交付、重启后待核验接着核。这里只注入本机能力(模型调用、
   * 产物核对、退修重派、用户层热装检查),旧路由只调它,不再复制分支。
   */
  async function askVerifyModel(system: string, userText: string): Promise<string | undefined> {
    if (options.model === undefined) return undefined
    try {
      const ep = await options.model.endpoint()
      if (!ep.ready || ep.key === undefined) return undefined
      const res = await (options.fetchImpl ?? fetch)(`${ep.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ep.key}` },
        body: JSON.stringify({
          model: ep.model ?? 'deepseek-chat', temperature: 0, max_tokens: 800,
          messages: [{ role: 'system', content: system }, { role: 'user', content: userText }],
        }),
        signal: AbortSignal.timeout(60_000),
      })
      if (!res.ok) return undefined
      const body = await res.json().catch(() => undefined) as { choices?: { message?: { content?: unknown } }[] } | undefined
      const content = body?.choices?.[0]?.message?.content
      return typeof content === 'string' ? content : undefined
    }
    catch { return undefined }
  }
  const taskDelivery = tasks === undefined ? undefined : createTaskDelivery({
    tasks,
    execution: createExecutionStore(tasks),
    askVerify: async (userText) => await askVerifyModel(VERIFY_SYSTEM, userText),
    // 缺验收:从委托原话 / 交回提取可验证的默认条件(写明「由委托提取」),真有目标歧义才问一句。
    askExtract: async ({ title, said, receipt }) => await askVerifyModel(DEFAULT_ACCEPTANCE_EXTRACT_SYSTEM, [
      `事项:「${title}」`,
      `委托原话:${said.slice(0, 1500)}`,
      `执行者交回汇报:${receipt.slice(0, 1500)}`,
    ].join('\n')),
    // 按产物核(2026-10-28):文件 / diff / 测试输出由程序在独立工作区里自己核;代跑超时用例可调小。
    artifacts: options.taskDelivery?.artifacts ?? createArtifactCheckDeps({ ...(options.taskDelivery?.runTestTimeoutMs === undefined ? {} : { runTestTimeoutMs: options.taskDelivery.runTestTimeoutMs }) }),
    // 退修重派那一下 = 派活口同一只(派发词带退修要求,续跑原会话;被挡不停卡,恢复记录接着推)。
    dispatchRepair: async (taskId, input) => await dispatchItem(taskId, {
      family: input.family as AgentDispatchFamily, text: input.text, source: 'item',
      ...(input.kind === undefined ? {} : { kind: input.kind as 'code' }), resume: input.resume, repair: input.repair,
    }),
    targetTitle: (family) => targetTitle(dispatchTargetsNow(), family),
    // 用户层修复:派发那一刻 cwd 钉在用户层目录(这条路与派活口「用户层那条路」同一份判据的落点部分)。
    isUserLayerTask: (task) => userLayer !== undefined && task.dispatch?.cwd === userLayer.dir,
    // 交付就绪 = 越界守门核完 + 那一格热装 ok(scan 每拍重读;broken/rolled_back 都如实不过)。
    userLayerDeliverable: async (task) => {
      if (userLayer === undefined) return { ok: undefined }
      const pending = await userLayer.pendingFixGuards()
      if (pending.includes(task.id)) return { ok: false, why: '越界守门还没核完(等下一拍)' }
      const view = await userLayer.scan()
      const broken = view.widgets.find(one => one.status !== 'ok')
      if (broken !== undefined) return { ok: false, why: `「${broken.name}」这一格装得不好(${broken.problem ?? '没装上'})` }
      return { ok: true }
    },
    onChanged: () => { void composeState().then(state => broadcast({ kind: 'snapshot', state })).catch(() => {}) },
    ...(options.taskDelivery?.retryMs === undefined ? {} : { retryMs: options.taskDelivery.retryMs }),
  })

  /**
   * 中枢 verify 命令的那只手(任务书 1029「中枢核一遍已交回的卡」):她说「按卡上条件核一遍」,
   * 与交回那一刻同一套推进(taskDelivery.verifyOnDemand,不另写一份)。她点名要核,不去重、
   * 不数退修轮次;非 confirm / 没回执 / 四类拍板请求,如实 unknown,卡不动。
   */
  async function verifyCardOnDemand(taskId: string, acceptance: readonly string[]): Promise<{ verdict: 'pass' | 'fail' | 'unknown', text: string }> {
    if (taskDelivery === undefined) return { verdict: 'unknown', text: '任务看板未启用' }
    return await taskDelivery.verifyOnDemand(taskId, acceptance)
  }

  const dispatchRunner = tasks === undefined ? undefined : createDispatchRunner({
    tasks,
    // ★ 执行记录(2026-10-29,可靠执行闭环第一批第 3 步):派发口派出前先经它持久化
    // (dispatching + attemptId + 候选表 + 授权引用),写不上不起子进程;接单 / 起跑失败 / 回执
    // 都先写事实再动卡;重启后从记录恢复没完的换手。挂在卡上一格,不新建 JSON 账。
    execution: createExecutionStore(tasks),
    // 执行租约(2026-10-26,卡「事务官机制D」):同卡/同树同时刻至多一个活跃写者。
    // 用例注入 lease/leaseFile;生产落 `~/.dsh/workbench/execution-leases.json`(与 client-keys 同目录)。
    // ★ 用例进程(VITEST)绝不落真实家目录:默认进系统临时目录,免得用例互相串、也不碰他的机器。
    ...(options.dispatchRun?.lease !== undefined
      ? { lease: options.dispatchRun.lease }
      : {
          lease: createExecutionLeaseStore(process.env.VITEST === 'true'
            ? { file: join(osTmpdir(), `wb-test-leases-${process.pid}.json`) }
            : options.dispatchRun?.leaseFile === undefined ? {} : { file: options.dispatchRun.leaseFile }),
        }),
    choicesFor: async (id, input) => await choicesFor(id, input),
    // 用户层目录(2026-10-29 任务书「派活智能体文件与起跑换手」③):cwdFixed 且落在它底下的活
    // 一律不带仓库那份 coder 智能体文件(交代本身已带用户层契约)。
    ...(userLayer === undefined ? {} : { userLayerDir: () => userLayer.dir }),
    runtimeContext: async (family, sessionId, cwd) => {
      if (family !== 'codex') return undefined
      const registered = sessionDigest?.files().find(ref => ref.agent === family && ref.session_id === sessionId && ref.format === 'codex-rollout')
      const ref = await locateCodexCliSession({ codexHome: process.env.CODEX_HOME ?? join(options.paths?.home ?? osHomedir(), '.codex'), sessionId, cwds: [cwd], ...(registered === undefined ? {} : { registeredFile: registered.file }) })
      if (ref === undefined) return undefined
      const parts = await readHeadTail(ref, { headBytes: 64 * 1024, maxHeadBytes: 64 * 1024, tailBytes: 256 * 1024 }).catch(() => undefined)
      return parts === undefined ? undefined : `${parts.head}\n${parts.tail}`
    },
    // 能接活的有哪几家、每家几只手、叫什么:登记表那一份(卡 Z)。
    targets: () => dispatchTargetsNow(),
    // 读不到窗口的那几家(2026-10-01):开口之前当场拦下,卡挂「等你处理」,不走那一串重试。
    unreadable: () => unreadableAppsNow(),
    /*
     * 盯窗读回话走引擎(2026-10-02):`reply_watch` 那道闸在 `engine.read` 里面 ——
     * 闸只接在引擎一处,这一层不再自己问一遍。
     */
    ...(options.engine === undefined ? {} : { engine: options.engine }),
    jobLog,
    ...(helper === undefined ? {} : { helper }),
    ...(clientDispatch === undefined ? {} : { clientDispatch }),
    ...(options.dispatchRun?.alive === undefined ? {} : { alive: options.dispatchRun.alive }),
    readFile: options.dispatchRun?.readFile ?? (async (file) => { try { return await readFile(file, 'utf8') } catch { return undefined } }),
    // 派发基线(2026-10-28 洞1):派出那一刻 `git rev-parse HEAD` 于工作目录,记进 dispatch.base_sha
    // 给交回核验的 diff 类当比对基线。用例注入替身;读不出(不是 git 仓库)回 undefined,不编。
    headSha: options.dispatchRun?.headSha ?? (async (cwd) => await new Promise<string | undefined>((resolvePromise) => {
      execFile('git', ['-C', cwd, 'rev-parse', 'HEAD'], { timeout: 10_000 }, (err, stdout) => {
        const sha = stdout.trim()
        resolvePromise(err === null && sha !== '' ? sha : undefined)
      })
    })),
    ...(options.dispatchRun?.pollMs === undefined ? {} : { pollMs: options.dispatchRun.pollMs }),
    cwdAllowed: async (cwd) => {
      const roots = (await dispatchRoots()).map(root => root.path)
      return roots.length === 0 || dispatchCwdAllowed(cwd, roots)
    },
    sessions: () => service.getState().sessions,
    /**
     * 会话里的那几个回合(2026-09-28,卡 RC):派出去的那条对话按记号认会话、结果取**最后一个回合的完整回答**。
     * 与「等你」读的是同一份(`sessionTurns` = `dshSessionFeed.turns`),所以事项上那一句与「等你」里那一问必是同一段话。
     */
    ...(sessionTurns === undefined ? {} : { turnsOf: (id: string) => sessionTurns(id, 20) }),
    now: () => new Date(),
    onChanged: () => { void composeState().then(state => broadcast({ kind: 'snapshot', state })).catch(() => {}) },
    /*
     * ★ 交回即核验(2026-10-27 交回闭环;第 4 步起四只手同一钩):CLI / 窗口 / 接口 / 事务官自办
     * 挪进「等你确认」那一刻,交给核验交付推进模块(不依赖事务官 DSH 会话活着 —— c0253b 那条
     * 靠会话,会话不在整条链停摆)。核验异步跑,不阻塞交回那条 HTTP。
     */
    onDelivered: (taskId: string) => { taskDelivery?.onReturned(taskId) },
    /**
     * 他的规矩(卡 K):工作台自己派出去的活,同样贴「这件活要守的规矩」、同样在叫他之前自查一遍。
     * 明着传进来的 `dispatchRules` 优先(用例用它),否则接卡 K 的规矩表;两样都没有 = 不附、不查。
     */
    ...(options.dispatchRules?.rulesFor !== undefined
      ? { rulesFor: options.dispatchRules.rulesFor }
      : rules === undefined ? {} : { rulesFor: createOrdinaryDispatchRulesFor({ tasks, rules })! }),
    ...(options.dispatchRules?.review !== undefined
      ? { review: options.dispatchRules.review }
      : rules === undefined ? {} : {
          review: async ({ taskId, text, taskText, instruction }: { taskId: string, text: string, taskText: string, instruction?: string }) => {
            const task = (await tasks?.list())?.tasks.find(one => one.id === taskId)
            const family = task?.client_dispatch?.family ?? task?.dispatch?.family
            const verdict = await rules.review({
              itemId: taskId,
              text,
              taskText,
              ...(family === undefined ? {} : { family: targetTitle(dispatchTargetsNow(), family) }),
              ...(instruction === undefined ? {} : { instruction }),
            })
            return {
              pass: verdict.pass,
              violations: verdict.violations.map(one => `${one.rule}:${one.why}`),
              ...(verdict.reject_text === undefined ? {} : { reject_text: verdict.reject_text }),
            }
          },
        }),
    /**
     * 派活的眼睛(2026-09-25,卡 O):写代码的活先看这家「能改本机文件」那一格;挑不到手时列能换的几家;
     * 项目是工作台自己时换到为这件事新开的独立工作区(不在他正用着的那份仓库里切分支、改文件)。
     */
    ...(agentCaps === undefined ? {} : { editCap: (family: AgentDispatchFamily) => agentCaps.view().agents.find(one => one.family === family)?.cells.edit }),
    alternativesFor: async (taskId: string, family: AgentDispatchFamily, kind: JobKind) => {
      const view = await choicesFor(taskId, { kind })
      return (view?.options ?? [])
        .filter(one => one.family !== family && one.ok)
        .map(one => ({ family: one.family, title: one.title, ...(one.balance === undefined ? {} : { note: one.balance.text }) }))
    },
    workdirFor: async (task, cwd, family) => await selfWorkdir(task, cwd, family),
    // 带技能的活(卡 S):拷进任务工作树。技能库 = 本体 ∪ 用户层(2026-10-22,卡「用户层技能生效」B):
    // 本体那份找不到不接这一口,用户层那份照常可拷 —— 两件都没有时 installSkills 如实说派不了。
    ...(() => {
      const root = options.dispatchRun?.skillsRoot ?? findSkillsRoot(fileURLToPath(new URL('.', import.meta.url)))
      const install: NonNullable<DispatchRunDeps['installSkills']> = async (input) => await installSkills({ ...input, root: root ?? '', userSkills: await userLayerSkillsNow() })
      return { installSkills: install }
    })(),
    // 命令行的活也有时长上限(统筹拍板 ③):跟「每件事的上限」同一份设置,只管时间;到了先停那个进程再问。
    ...(options.itemBudget === undefined ? {} : { cliBudget: () => options.itemBudget?.store.get() }),
    killPid: pid => killDispatch(pid),
    // 取消收场(2026-10-28,任务书「取消要收场执行者」):SIGTERM 十秒没退,补 SIGKILL。
    killPidHard: pid => { try { process.kill(pid, 'SIGKILL') } catch { /* 那一瞬刚好退了 */ } },
    /*
     * 这件事还有下一步(两步接力,`videoChain.ts`):回话照记,卡不挪去「等你确认」—— 收卡的是接力那一层。
     * `videoChain` 在下面才建;起服务时那一拍要是先问到,就当没有接力(照老行为)。
     */
    continues: (id) => { try { return videoChain?.owns(id) === true } catch { return false } },
    /*
     * ★ 同一家同一时刻只送一件(2026-10-21,卡「派活按家隔离」):**只靠窗口**的那几家(没有协议那一条)。
     * 协议型(Claude / Codex)各开各的线程,不排。登记表查不出来就不排(老行为)。
     */
    exclusive: (family) => {
      try {
        const vias = options.engineRegistry?.channelsOf(family).map(one => one.via) ?? []
        return vias.includes('window') && !vias.includes('protocol')
      }
      catch { return false }
    },
  })
  void dispatchRunner?.resume()
  // ★ 核验交付接续(第 4 步⑥):重启后待核(verify)/ 待恢复(recover)的卡从执行记录接回接着推,
  // 不只靠一次 onDelivered 回调;已收场的卡记录落终态。
  void taskDelivery?.resume().catch(() => undefined)

  /**
   * ★ **「帮我做一个 XXX 的视频」两步接力**(2026-10-12,卡「演示 · 出图进可灵」;理由在 `videoChain.ts` 文件头)。
   * 第一步是普通派活(豆包出参考图),图从豆包自己的本机缓存取;第二步把这张图交给可灵桌面版。
   * 壳没接上 = 第二步做不了,那就整条不接(不派出半件事)。
   */
  const chainHome = options.paths?.home ?? process.env.HOME ?? ''
  const videoChain = tasks === undefined || helper === undefined || options.runCommand === undefined ? undefined : createVideoChain({
    tasks: {
      list: async () => await tasks.list(),
      update: async (id, patch) => await tasks.update(id, patch as Parameters<typeof tasks.update>[1]),
      move: async (id, status) => await tasks.move(id, status),
    },
    dispatch: async (taskId, input) => await dispatchItem(taskId, { family: input.family, text: input.text, source: 'call', kind: 'chat' }),
    /*
     * ★ 找图那一趟留一行(2026-10-13 晚,卡 Q):演示机那一单只说「缓存里没找到这一轮出的图」,
     * 诊断包里看不出是**目录名变了**还是**尺寸筛掉了**。判据一个字没改,只把看到的东西写进日志。
     */
    findImage: async since => await findDoubaoImage({ cacheDirs: await discoverDoubaoCacheDirs(chainHome), since, log: line => console.log(line) }),
    root: async () => {
      const configured = (await pathsOption?.config.get())?.butler_cwd
      return configured === undefined || configured === '' ? undefined : configured
    },
    fallbackRoot: `${chainHome}/Documents/事务官`,
    writeFile: async (path, body) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, body) },
    kling: async input => await runKlingStep(input, {
      openApp: async () => {
        const ran = await options.runCommand?.(['open', '-b', KLING_BUNDLE])
        if (ran?.ok !== true) throw new Error('open -b 没成')
      },
      helper: { request: async (req, timeoutMs) => await helper.request(req as unknown as HelperRequest, timeoutMs) as Record<string, unknown> },
      sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
      /*
       * ★ 只用在一处(2026-10-13 晚,统筹 21:2x):「没读到新一条、图和词都还在」时等那 90 秒,
       * 日志里出现按下之后的 `AllTaskFinish` 也算它接下了。读不到就只靠读窗。
       */
      readLog: async () => await readFile(`${chainHome}/${KLING_LOG}`, 'utf8'),
      now: () => Date.now(),
    }),
    /*
     * 这一通打哪一档由接力那一层按结果给(2026-10-13,卡 D):办成了 `confirm`(开场「办完了,等你验收」),
     * 下载 / 推手机没成 `failed`(开场念 note 收拾出来的那句人话)。来电台账形状一个字没改。
     */
    announce: async input => await callOut?.request({ reason: input.reason, item_id: input.item_id, title: input.title, note: input.note }),
    /*
     * ★ **「前一条还在可灵里,排着」这一句给她留一行**(2026-10-13,卡 M)。
     * 不打电话:来电只有「办完了等你验收」与「没办成」两档,排队两档都不是(理由写在 `videoChain.ts`)。
     * 走的是现成那本回答账(`/state.answers`:电脑事务官页球下那一处 + 手机那行字幕,两端「看过了」同步),
     * 指回这张卡(她点得开)、**不推系统通知**(`deliverAnswer` 才推那一条)。
     */
    trace: (input) => {
      try { directAnswers.record({ itemId: input.item_id, question: input.title, answer: input.text }) }
      catch { /* 留一行痕迹失败不该把这条接力拦下来 */ }
    },
    /*
     * 出片之后(2026-10-12 晚):等可灵出片、下下来(判据都是可灵自己的日志)→ 复制进选题素材文件夹 → 推到她手机上。
     * 推那一下走 `/butler/send-file` 的 path 分支同一道门、同一份台账(`pushFileToPhone`)。
     */
    fetchVideo: async input => await waitKlingVideo(input, {
      readLog: async () => await readFile(`${chainHome}/${KLING_LOG}`, 'utf8'),
      /*
       * ★ 日志读不到 / 字段不一样时的旁路(2026-10-13 晚,卡 O):「下载」文件夹里那一刻之后
       * 新冒出来的那个 `kling_*.mp4`。只读目录项、改动时刻与大小,一个字节的内容都不读。
       * ★ 大小也回去(2026-10-13 22:06,卡 R):可灵直接写最终文件名,`waitKlingVideo` 要看它停住了没有。
       */
      findDownload: async (since) => {
        try {
          const dir = `${chainHome}/Downloads`
          const names = (await readdir(dir)).filter(one => KLING_FILE_RE.test(one))
          const files = (await Promise.all(names.map(async (name) => {
            try {
              const info = await stat(`${dir}/${name}`)
              return { name, mtimeMs: info.mtimeMs, size: info.size }
            }
            catch { return undefined }
          }))).filter((one): one is { name: string, mtimeMs: number, size: number } => one !== undefined)
          const picked = pickFreshKlingFile(files, since)
          if (picked === undefined) return undefined
          return { path: `${dir}/${picked}`, bytes: files.find(one => one.name === picked)?.size ?? 0 }
        }
        catch { return undefined }
      },
      helper: { request: async (req, timeoutMs) => await helper.request(req as unknown as HelperRequest, timeoutMs) as Record<string, unknown> },
      sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
      now: () => Date.now(),
      // ★ 每一步记一行进插件日志(2026-10-14,卡 AD):演示机上出了事,诊断包里的 web.stdout.log 才看得出这一层在等什么。
      log: line => console.log(line),
    }),
    copyFile: async (from, to) => { await mkdir(dirname(to), { recursive: true }); await copyFile(from, to) },
    pushToPhone: async input => await pushFileToPhone(input.item_id, input.path),
    file: `${chainHome}/.dsh/workbench/video-chains.json`,
    now: () => Date.now(),
    onChanged: () => { void composeState().then(state => broadcast({ kind: 'snapshot', state })).catch(() => {}) },
  })
  void videoChain?.load()
  /** 接力接上了没有(壳的允许名单要据此报不报可灵;起服务那一拍先问到就当没接)。 */
  function videoChainWired(): boolean {
    try { return videoChain !== undefined }
    catch { return false }
  }

  /**
   * 这件事挂在哪个项目、在哪个目录(派活要带着它说)。**现查,不落第二份**;查不到就缺席 ——
   * 没挂项目的活(「用一句话说说 X」)本来就没有目录,编一个出来正是 D13 说的编。
   */
  async function dispatchContextOf(taskId: string): Promise<{ cwd?: string, project?: string }> {
    try {
      const task = (await tasks?.list())?.tasks.find(one => one.id === taskId)
      if (task?.project_id === undefined || projects === undefined) return {}
      const found = (await projects.getProjectsState()).projects.find(one => one.id === task.project_id)
      if (found === undefined) return {}
      return { project: found.name, ...(found.path === undefined ? {} : { cwd: found.path }) }
    }
    catch { return {} }
  }

  /**
   * 那家的 app 装在这台电脑上没有(2026-09-24,卡 F;给「指定谁来办」那个下拉用)。
   *
   * ★ 2026-09-27(卡 HC):原来这里写死着一张六家的**显示名**表(`{ claude:'Claude', … }`),
   * 表外的一家一律回 `false` —— 新接上的一家(Grok Bot、Antigravity……)于是永远"没装",
   * 派活下拉里点不到它。现在**先问探测那一份**(`installedAgents`,按包标识 mdfind,
   * 候选表自己从 `FAMILY_SOURCES` 长出来),探不到才退回看 `.app` 在不在。
   *
   * 退回那一路也不再靠显示名表:包标识从 `FAMILY_SOURCES` 里取,`open` 命令里那个名字
   * (`open -a ChatGPT`)就是 .app 的名字 —— 与这两张知识表一一对应,不再写第三份。
   */
  function clientAppInstalled(family: AgentDispatchFamily): boolean {
    // 探到过一轮就只认它(没探到的那一家就是没装,D13 的另一半:探过了、没有,就是没有)。
    const probed = installedAgents?.installedIds()
    if (probed !== undefined) return probed.has(family)
    const name = appBundleNameOf(family)
    if (name === undefined) return false
    const home = options.paths?.home ?? process.env.HOME ?? ''
    return existsSync(`/Applications/${name}.app`) || (home !== '' && existsSync(`${home}/Applications/${name}.app`))
  }


  /**
   * 「帮我接上」那一家登好了(卡 O;统筹 09-25 设计原则:按第一次用的人想):因为它**卡在「派不出去」**的那几件
   * (派不出去的原因正是「还差一步:登录」)接着派出去,卡上写一句 —— 不让他再回去找那张卡、再点一次。
   * 别的原因卡住的不动;他已经换给别家 / 自己做 / 取消了的,卡上已经没有这个 block,也不动。
   */
  agentCaps?.whenLoggedIn?.((family) => {
    void (async () => {
      const list = (await tasks?.list())?.tasks ?? []
      for (const task of list) {
        const block = task.dispatch_block
        if (task.status !== 'blocked' || block === undefined || block.family !== family || block.fix?.kind !== 'login_cli') continue
        await tasks?.update(task.id, { note: `${DISPATCH_FAMILY_TITLES[family]} 接上了,接着派过去` }).catch(() => false)
        await dispatchItem(task.id, { family, text: task.desc ?? task.title, source: 'item', kind: block.kind }).catch(() => undefined)
      }
    })().catch(() => {})
  })

  /** 进程内派活口:`/dispatch/run`、`/butler/item` 点了名那一支、卡 B 的落地都走它。 */
  /**
   * 在途的「后台接着派」登记处(2026-10-28,卡「从机制上修 dispatch-recovery-1027 高负载偶发」)。
   *
   * 直派那一支(`confirmed`)故意不等派活:**接口先回,派发在后台跑**。这条设计不变 ——
   * 变的是「后台跑完没有」从前只能靠轮询时长猜(负载一高,固定预算的轮询先超时,用例偶发红)。
   * 现在凡 fire-and-forget 的派发 promise 都在这里登记一枚,`drainDispatches()` 等到全部落定
   * 再返回;失败写卡本来就在派活那条 promise 链里 await,落定 = 账已落,读卡不再碰运气。
   * 登记是同步的、先于接口回包,所以收到回包时这一枚一定在表里。
   */
  const dispatchPending = new Set<Promise<unknown>>()
  function trackDispatch<T>(started: Promise<T>): Promise<T> {
    dispatchPending.add(started)
    // 双回调而不是 finally:拒绝由调用方那条链照原样处理(直派处已 catch / await),
    // 这里只摘登记,不再衍生一条没人接的拒绝。
    const done = (): void => { dispatchPending.delete(started) }
    void started.then(done, done)
    return started
  }
  async function drainDispatches(): Promise<void> {
    // 一轮一轮等到空:落定过程里新登记进来的(接力 / 重派)也算在内。
    while (dispatchPending.size > 0) await Promise.all([...dispatchPending])
  }
  async function dispatchItem(taskId: string, input: {
    family: AgentDispatchFamily | AgentCardAssignee
    text: string
    source?: ClientDispatchSource
    kind?: JobKind
    /**
     * 在哪个目录里干 —— **调用方自己定**(2026-10-01,C2「小组件派出去」:
     * 落点是 `~/.dsh/workbench/modules/<id>/`,那不是她的任何一个项目)。
     * 缺席 = 老行为:从卡上挂的项目现查(`dispatchContextOf`)。
     */
    cwd?: string
    /** 那个 `cwd` 是工作台自己定的落点:不开独立工作区、不过扫描根那道门(理由见 `DispatchStartInput.cwdFixed`)。 */
    cwdFixed?: boolean
    /** 带哪几件技能(卡 S;`/dispatch/run` 校验过)。缺席 = 老行为。 */
    skills?: readonly string[]
    /** 续跑接原会话(2026-10-23 卡「派活给名片的四处」③):到时长上限他说「继续」那一下。缺席 = 新起。 */
    resume?: boolean
    /** 显式人工接管(卡「事务官机制D」缺口3):只从可信入口(她本人在页面/手机上点重派)传来。 */
    takeover?: boolean
    /** 退修重派那一下(核验交付推进模块,第 4 步):被挡下不把卡停进「卡住」,由恢复记录接着推。 */
    repair?: boolean
    /**
     * **这一下是她点名的**(2026-10-29,任务书「派活智能体文件与起跑换手」③):只有中枢 `pickHand`
     * 的 named 才传 true(她原话点了家 / command.to);缺席 = 中枢按默认推荐挑的,选人理由写
     * 「按默认推荐挑的」/「在跑少」,不写「你点名要」。
     */
    named?: boolean
  }): Promise<DispatchStartResult> {
    if (dispatchRunner === undefined) return { ok: false, note: '任务看板未启用,派不了' }
    const context = input.cwd === undefined ? await dispatchContextOf(taskId) : { cwd: input.cwd }
    /**
     * 这是什么活(卡 O):明说的照明说的;没明说按字认(挂着代码项目、又是「做 / 改 / 修」的算写代码)。
     * 写代码的活只走能改本机文件的手(Claude / Codex / Kimi 的命令行),挑不到就不派、如实说。
     * 负责人是名片、名片写了仓库:那个仓库就是「在仓库里改」的判据(2026-10-22 卡 D —— 用哪一家、在哪个
     * 仓库干活由派活那一层按名片解析,这里只为「这是什么活」的现认看一眼)。
     */
    let inRepo = context.cwd !== undefined
    if (!inRepo && tasks !== undefined) {
      try {
        const state = await tasks.list()
        const task = state.tasks.find(one => one.id === taskId)
        const card = task !== undefined && isAgentCardAssignee(task.assignee)
          ? (state.agent_cards ?? []).find(one => one.id === task.assignee)
          : undefined
        if ((card?.project?.repo ?? '').trim() !== '') inRepo = true
      }
      catch { /* 认不出就按没仓库,照旧按字认 */ }
    }
    const kind = input.kind ?? jobKindOf(input.text, { inRepo }).kind
    const started = await dispatchRunner.start(taskId, {
      family: input.family,
      said: input.text,
      ...context,
      ...(input.cwdFixed === true ? { cwdFixed: true } : {}),
      submit: input.source === undefined ? true : submitForSource(input.source),
      kind,
      ...(input.skills === undefined || input.skills.length === 0 ? {} : { skills: input.skills }),
      ...(input.resume === true ? { resume: true } : {}),
      ...(input.takeover === true ? { takeover: true } : {}),
      ...(input.repair === true ? { repair: true } : {}),
      ...(input.named === true ? { named: true } : {}),
    })
    // 派出去了(卡 K 的账):这件活上次自查没过的那一笔清掉,记一条「派出去了」给试用的规矩验效果用。
    if (started.ok && rules !== undefined) {
      const work = [await ruleTaskText(taskId), input.text].join('\n')
      await rules.clearReview(taskId).catch(() => undefined)
      await rules.feedback({ kind: 'run', where: taskId, area: ruleWorkArea(work), channel: 'butler' }).catch(() => undefined)
    }
    return started
  }

  /**
   * ★ **改派 = 同卡换负责人重派,永不改名**(2026-10-28,卡「机制退修任务书-接续对题与改派语义」)。
   * 「改派/换人/改给 X」先给**旧派发收场**(命令行有 pid 就停掉、照实记一条收场;没 pid 也要把
   * 账标成已收场,不许留一条"还在跑"的僵尸派活),再把卡上负责人换成那家、同卡重派。
   * 电脑对话框 / 电话 / 手机同一个执行函数 —— 目标卡解析在 `sayTarget.ts`,那里唯一。
   */
  async function settleRunningDispatch(task: TaskView): Promise<{ settled: boolean, note?: string }> {
    const running = task.dispatch
    if (running === undefined || running.status !== 'running') return { settled: false }
    if (running.pid !== undefined) {
      try { killDispatch(running.pid) }
      catch (error) {
        // ESRCH = 进程早退了,不算失败;其余如实说停不掉,派活账也不动(不假装停了)。
        if ((error as { code?: string }).code !== 'ESRCH') {
          return { settled: false, note: `停不掉(${String((error as Error).message ?? error)})` }
        }
      }
    }
    const settled: NonNullable<TaskView['dispatch']> = {
      ...running,
      status: 'failed',
      ended_at: new Date().toISOString(),
      note: '改派收场:这件换给别家做,这一次停在这里。',
    }
    await tasks?.update(task.id, { dispatch: settled }).catch(() => false)
    return { settled: true }
  }

  /**
   * 造小组件这件活派给谁(2026-10-01,C2「小组件派出去」)。
   *
   * **问的是派活那张选项表**(`choicesFor(..., { kind:'code' })` → `dispatchChoice.ts`):
   * 写代码的活只列能改本机文件的那几家,家与包由 `agentSources.pickFamilyPackage` 一处挑 ——
   * 这里不新造一张「家→包」表,也不写死「派给 Codex」。
   *
   * 次序:规矩表里「写代码的活派谁」那一条(选项表的默认项)→ 第一家派得出去的。
   * 一家都派不出去回 `undefined`,调用方据此如实说 `NO_CODER_FOR_MODULE`,**不退回让事务官自己写**。
   */
  async function devToolCoder(brief: string): Promise<{ family: AgentDispatchFamily, title: string } | undefined> {
    if (dispatchRunner === undefined) return undefined
    const view = await choicesFor(undefined, { kind: 'code', text: brief }).catch(() => undefined)
    if (view === undefined) return undefined
    const byRule = view.default === undefined ? undefined : view.options.find(one => one.family === view.default && one.ok)
    const option = byRule ?? view.options.find(one => one.ok)
    return option === undefined ? undefined : { family: option.family, title: option.title }
  }

  /**
   * 事务官验收派出去的那一格小组件(2026-10-01,C2 的后半句)。**判据是模块清单**,不是那一家说了什么:
   * 清单里出现了这一格 = 做好了;那边收工了而清单里还是没有 = 如实说没落盘(`devToolAcceptNote`)。
   *
   * 挂在既有那根节拍上(`tick()`),内部 10 秒一拍 —— 没有在等验收的就一次 I/O 都不做。
   */
  let devToolAcceptAt = 0
  async function pumpDevToolAccept(): Promise<void> {
    if (devTool === undefined || modules === undefined || tasks === undefined) return
    const waiting = devTool.store.dispatched()
    if (waiting.length === 0) return
    const nowMs = Date.now()
    if (nowMs - devToolAcceptAt < (options.devTool?.acceptEveryMs ?? DEV_TOOL_ACCEPT_EVERY_MS)) return
    devToolAcceptAt = nowMs
    const ids = (await modules.list()).map(one => one.id)
    const board = (await tasks.list()).tasks
    let changed = false
    for (const record of waiting) {
      const task = board.find(one => one.id === record.task_id)
      const verdict = devToolAcceptNote(record, { moduleIds: ids, ...(task === undefined ? {} : { taskStatus: task.status }) })
      if (verdict === undefined) continue
      await tasks.update(record.task_id, { note: verdict.note }).catch(() => false)
      await devTool.store.dropDispatched(record.module_id)
      changed = true
    }
    if (changed) broadcast({ kind: 'snapshot', state: await composeState() })
  }

  /** 那家的 app 装没装(派活选项:没装的不列)。 */
  function appInstalledNow(family: AgentDispatchFamily): boolean {
    if (options.appInstalled !== undefined) return options.appInstalled(family)
    return clientAppInstalled(family)
  }

  /**
   * **能接活的有哪几家 —— 只问 Agent 登记表**(2026-09-25,卡 Z;设计第一节第 6 条)。
   *
   * 派活候选、能力体检、额度列表、看板小头像的颜色、@ 候选、认他原话里点了谁,全读这一份:
   * 登记表里判成 Agent、接上了的每一家(名字、颜色、开着没、包标识都是它给的)+ 只走接口、连 App 都没有的那几家。
   * 代码里再没有「有哪几家」的表 —— 新发现一家不改一行代码就能被派活(默认窗口那只手)。
   *
   * 没接发现引擎(老宿主、大多数用例)时退回「写过专门接法、装在这台电脑上的那几家」,行为与 09-25 之前一字不变。
   *
   * **不缓存**:他刚点完「这不是 Agent」,下一下点派活就不该还看见它 —— 隔一拍才消失的候选比没有更费解。
   * 算一次就是过一遍登记表里那几条(纯函数),比一次 HTTP 便宜得多。
   */
  function dispatchTargetsNow(): readonly DispatchTarget[] {
    let registry: ReturnType<AgentDiscovery['view']> | undefined
    try { registry = agents?.view() }
    catch { registry = undefined }
    const providers = relayProvidersNow()
    const probed = installedAgentsNow()?.agents
    const targets = dispatchTargets({
      ...(registry === undefined ? {} : { registry }),
      apiReady: apiDispatch !== undefined,
      // 中转配了哪家才出现哪家(2026-09-26,卡 GH):没配 OpenAI 时 GPT 整家不出现。
      ...(providers === undefined ? {} : { relayProviders: providers }),
      installed: family => appInstalledNow(family),
      /*
       * ★ **装了、登记表里还没有的那几家也能派**(2026-09-28,卡 CF)。新 Air 上 Codex 装着、
       * 没开过 → 登记表里一条都没有 → 「让 Codex 办」被答成「这台电脑上还没接上 codex」。
       * 用的是与顶栏、坞、@ 候选同一份探测(卡 HC),于是**「能派谁」只有一份答案**。
       */
      /*
       * ★ 2026-09-28(卡 DP):探到的那几条里,**一家装着两个 App 的那一条带着两个包**;
       * 顺手给每个包补一格「此刻开着没」—— 她只说「豆包」时派给正开着的那一个。
       * 问不到(登记表还没接上)就缺席,照旧退回主包,不猜。
       */
      ...(probed === undefined ? {} : {
        installedAgents: probed.map(one => (one.packages === undefined ? one : {
          ...one,
          packages: one.packages.map((pkg) => {
            let running: boolean | undefined
            try { running = agents?.appRunning(pkg.bundle_id) }
            catch { running = undefined }
            return running === undefined ? pkg : { ...pkg, running }
          }),
        })),
      }),
      /*
       * ★ **引擎登记处那一份**(2026-10-02,卡「引擎接线与删复制品」;设计第七节「四件套的根子」):
       * 「有哪几家」再补上目录认识 + 某条通道此刻答应得上的那几家,
       * 「每家能做什么」只问各适配器现查(`can` / `write`)—— 窗口结构从此只是其中一项能力,
       * 不再是「这是不是一家」的门。
       */
      ...(options.engineRegistry === undefined ? {} : { engineTargets: options.engineRegistry.targetsNow().map(one => ({
        family: one.family,
        name: one.name,
        ...(one.bundle_id === undefined ? {} : { bundle_id: one.bundle_id }),
        can: one.can,
        ...(one.write === undefined ? {} : { write: one.write }),
        here: one.here,
      })) }),
    })
    tellShellWhoIsAnAgent(targets)
    return targets
  }

  /**
   * **认出是 AI 应用、可那扇窗读不到**的那几家(2026-10-01,卡「派给读不到的那家当场说」)。
   *
   * 登记表现算的那一截(`AgentRegistryView.unreadable`)—— Air 上对上的是新版 Kimi、可灵、
   * App Store 版豆包。派活 / 捎话 / 替她答都过同一份:派进去一个字都送不到,当场说、不折腾。
   * 读不到登记表(老宿主 / 用例)就回空数组,行为一字不变。
   */
  function unreadableAppsNow(): readonly UnreadableApp[] {
    try {
      return (agents?.view().unreadable ?? []).map(one => ({ id: one.id, name: one.name, bundle_id: one.bundle_id }))
    }
    catch { return [] }
  }

  /**
   * **认她原话里点了哪一家的名**用的那一份名单(2026-10-02,卡「语音交代慢与老问上限」)。
   *
   * 比 {@link dispatchTargetsNow}(真能派的那几家)**松一格**:再补上
   * {@link unreadableAppsNow}(认出是 AI 应用、可那扇窗读不到的那几家 —— Air 上是新版 Kimi、
   * 可灵、App Store 版豆包)。它们不在派活候选里,于是她点名它们的那一句**连「这是派活」都没被认出来**:
   *
   * > 诊断包 `工作台诊断包-20261002-112711`:`t-0a166196`「让 Kimi 查一下国庆放假多少天?」
   * > (2026-10-01 09:42)—— Kimi 在 `快照/agents.json` 的 `unreadable` 里、不在 `entries` 里,
   * > 于是 `dispatchFamilyOf` 认不出这一家,整句落给事务官自己跑:**45 步、2.5 分钟、0.295 元**,
   * > 她被问了三遍「到上限了」(`日志/channel-worker.log.2026-10-01` 2616 / 2618 / 2620 行),
   * > 那件事到最后一个字都没发出去。
   *
   * 认出来之后走的还是 2026-10-01 那张卡已经铺好的路:`dispatchReadiness` 当场回一句
   * 「Kimi 这台读不到它的窗口,派不了 —— 换 豆包办公、Codex 吗?」。**认出来才说得出这句话。**
   *
   * 只收**仓库认得的家名**(`isAgentDispatchFamily`):一个谁也不认得的 id 落到 `assignee` 上
   * 会让底下那一串「这是哪一家」全部拿不准(D13:不猜)。
   */
  function dispatchNameTargetsNow(): readonly DispatchTarget[] {
    const targets = dispatchTargetsNow()
    const extra = unreadableAppsNow()
      .filter(one => isAgentDispatchFamily(one.id) && !targets.some(target => target.id === one.id))
      .map(one => ({ id: one.id, title: one.name, aliases: [] as readonly string[], hands: [], from_registry: false }))
    return extra.length === 0 ? targets : [...targets, ...extra]
  }

  /**
   * **交代一件事时一起摆上的那几条事实**(2026-10-02,卡「事务官为什么要跑这么多步」)。
   *
   * 每一条都是这一侧**数出来的**:卡的标题(刚建的那张)、此刻真派得出去的几家
   * (`dispatchTargetsNow`)、读不到窗口派不了的几家(`unreadableAppsNow`)、这台服务真在听的地址
   * (`skillServiceBaseUrl` —— 不写死 8791,卡 SP 那一处的病)、该读哪一份技能正文。
   * 算不出来的那一条**整行不出现**(`butlerBrief.ts` 的规矩),不编、不写「未知」。
   *
   * 为什么要有这一下:见 `butlerBrief.ts` 文件头那张逐步表 —— 两件简单事 34 次工具调用、
   * 一次都不在干活,全在问这几个问题。
   */
  function butlerFactsNow(input: { itemId: string, title: string, assignee?: TaskAssignee, fileWant?: { query?: string, device: string } }): ButlerBriefFacts {
    // 家目录不知道 = 算不出技能正文落在哪 → 那一行不出现(不写一个 `/.dsh/…` 的假路径)。
    const home = pathsOption?.home
    const skill = butlerSkillForItem({
      ...(input.assignee === undefined ? {} : { assignee: input.assignee }),
      ...(home === undefined || home === '' ? {} : { skillFile: (name: string) => skillBodyFile(home, name) }),
      ...(input.fileWant === undefined ? {} : { fileWant: true }),
    })
    const named = skill !== undefined && input.fileWant === undefined
    return {
      itemId: input.itemId,
      title: input.title,
      dispatchable: dispatchTargetsNow().map(one => ({ id: one.id, title: one.title })),
      unreadable: unreadableAppsNow().map(one => ({ id: one.id, name: one.name })),
      baseUrl: skillServiceBaseUrl(),
      // 点了名才列口:那几条是派活技能正文里写明的(`/dispatch/run`、`/dispatch/choices`)。
      // 没点名的事要用哪个口,由它读了那一条技能正文再说 —— 这里不猜一个。
      ...(named ? { endpoints: [`POST /dispatch/run`, `GET /dispatch/choices?item=${input.itemId}`] } : {}),
      // 要文件那一类:口就一个,别让它去试(10-04 那两轮 `aborted` 全花在试口上)。
      ...(input.fileWant === undefined ? {} : { endpoints: ['POST /butler/send-file'], fileWant: input.fileWant }),
      ...(skill === undefined ? {} : { skill }),
    }
  }

  /**
   * 把「登记表里接上了的那几家」报给壳(2026-09-25,卡 Z,`agent_allow`)。
   *
   * 壳那边送话原来只认它自己写死的一张表(`SendTextPolicy.allowedBundleIds`),运行时新发现的一家送不进去。
   * 现在服务端报一份过来,壳据此放行;**壳的两道底线照旧**:微信 / 企业微信一律拒(服务端报了也不算)、
   * 真找不到聊天输入框就不送。名单变了才发;老壳没有这件本事就不发 —— 那时只有壳里实测过的那几家送得进去,
   * 派活如实说要新版工作台 App。
   */
  /**
   * 「负责人」这一格 / 事务官报进度时认不认得这个家名(2026-09-25,卡 Z)。
   * **比真派活那道门松一格**:登记表里接上了的算,仓库里为它写过专门接法的也算 ——
   * 他在电话里说「让 GPT 写三个标题」,接口这会儿没接上也该落到卡上(派的时候再如实说派不出去);
   * 而一个谁也不认得的名字(`gemini`)照旧当没点名 / 400,不猜。
   */
  function knownFamilyName(value: unknown): boolean {
    if (!isAgentDispatchFamily(value)) return false
    return isDispatchTarget(dispatchTargetsNow(), value) || bindingFor(value) !== undefined
  }

  /**
   * **这个名字是哪一家**(2026-09-28,卡 CF):家名(`doubao`)、显示名(`豆包办公`)、
   * 别名与听错的写法(`豆包工作` / `minus`)都认,认不出回 undefined(**不猜**,D13)。
   *
   * 为什么要它:09-28 那两通电话里,电话那头往 `/confirm/points` 递的是**显示名**,而那一头只认家名 ——
   * 他点的名当场被丢掉,确认点里念的是「事务官自己办」。卡 FX(认家)、卡 HC(本机探测)、
   * 卡 Z(派活候选)三样本来就该是同一份答案,这个函数就是把「名字 → 那一家」收到一处。
   */
  function resolveFamily(value: unknown): { id: string, title: string } | undefined {
    if (typeof value !== 'string' || value.trim() === '') return undefined
    const said = value.trim()
    const targets = dispatchTargetsNow()
    const lower = said.toLowerCase()
    const direct = targets.find(one => one.id.toLowerCase() === lower || one.title.trim().toLowerCase() === lower)
    if (direct !== undefined) return { id: direct.id, title: direct.title }
    // 别名与听错的写法:与「他嘴里那一家」同一套打分(卡 FX)。
    const match = matchSpokenFamily(said, targets.map(one => ({ id: one.id, title: one.title, aliases: one.aliases })))
    if (match.kind === 'one') return { id: match.id, title: match.title }
    // 候选里没有它,但仓库里为它写过专门接法(还没装 / 还没开)→ 认得出是谁,派的时候再如实说派不出去。
    const binding = bindingFor(lower) ?? bindingForApp({ name: said })
    return binding === undefined ? undefined : { id: binding.agent, title: binding.name }
  }

  let toldShell: string | undefined
  function tellShellWhoIsAnAgent(targets: readonly DispatchTarget[]): void {
    if (helper === undefined || !helper.connected()) { toldShell = undefined; return }
    if (helper.supports !== undefined && !helper.supports('agent_allow')) return
    /*
     * 可灵(两步接力的第二步,2026-10-12)不在派活候选里(发现那一层判它「窗口读不到」),
     * 不报它的话壳当场拒掉读它 / 往它框里写 / 按它的「生成」。接力接上了才报。
     */
    const bundleIds = [...new Set([...allowBundlesOf(targets), ...(videoChainWired() ? [KLING_BUNDLE] : [])])].sort()
    const key = bundleIds.join(',')
    if (key === toldShell) return
    toldShell = key
    void helper.request({ op: 'agent_allow', bundle_ids: bundleIds }, 5000).catch(() => { toldShell = undefined })
  }

  /*
   * ★ **壳重连时重发允许名单**(2026-09-30,止血第 5 条;设计-重构 根子 4 末尾那一条)。
   *
   * 上面那道去重(名单没变就不发)漏了一种:**壳自己重启过**。壳那一侧什么都不记得,
   * 服务端这边却因为「名单跟上次报的一样」再也不报 —— 于是工作台 App 重启一次之后,
   * 派活就送不进那几家的窗口,而两头都没有错误。
   *
   * 这里盯的是「断 → 连」那一拍(不是每次壳报状态):去重清零,名单原样再报一次。
   * `dispatchTargetsNow()` 自己末尾就会调 `tellShellWhoIsAnAgent`,所以这里不重复拼名单。
   */
  let shellWasConnected = helper?.connected() ?? false
  helper?.onChange(() => {
    const nowConnected = helper.connected()
    const reconnected = nowConnected && !shellWasConnected
    shellWasConnected = nowConnected
    if (!reconnected) return
    toldShell = undefined
    try { dispatchTargetsNow() }
    catch { /* 登记表这会儿读不出来:下一次 /state 还会报一遍 */ }
  })

  /** 规矩表里「派活默认分工」那一条读出来的分工(卡 O;没有就缺席)。 */
  function divisionNow(): Division | undefined {
    try { return divisionOf(rules?.counting() ?? [], dispatchTargetsNow()) }
    catch { return undefined }
  }

  /**
   * 额度适配器要的其余几样(卡 O,`agentQuota.ts`):装没装 / 接没接(clients)、模型从哪来、窗口上读到的那几家。
   * 派活确认点与 `/state.agent_quota` 读同一份。
   */
  function quotaCtxNow(): Omit<QuotaAdapterContext, 'quota'> {
    const clients = clientsNow()
    const mode = modelModeNow()
    const providers = relayProvidersNow()
    return {
      ...(clients === undefined ? {} : { clients }),
      ...(mode === undefined ? {} : { modelMode: mode }),
      apiReady: apiDispatch !== undefined,
      // 走接口那只手的那几家:「中转没配这家」与「这台电脑没接上模型服务」要说得出区别(卡 GH)。
      ...(providers === undefined ? {} : { relayProviders: providers }),
      ...(windowQuota === undefined ? {} : { window: windowQuota.readings() }),
      // 开集那条路(2026-09-26,卡 QO):没有专门读法、又有本机窗口的那几家**每家都留一格** ——
      // 那一格在不在,就是「这一家给不给『读一下』」;读到了就是「有数」,读不到也说得清差哪一步。
      ...(windowQuota === undefined ? {} : { open: windowQuota.openReadings(openFamiliesNow()) }),
      now: new Date(),
    }
  }

  /**
   * 该走**开集读法**的那几家(2026-09-26,卡 QO):派活名单里有本机窗口、又没有专门读法的那几家。
   * 名字用登记表里的 —— 问模型那一段里念的、额度区那一行写的,是他在顶栏看到的同一个名字。
   */
  function openFamiliesNow(): readonly OpenQuotaFamily[] {
    try { return openQuotaFamilies(dispatchTargetsNow()) }
    catch { return [] }
  }
  /**
   * ★ 2026-09-27(卡 AG 追加):**开集那几家是谁,只有这一层数得出来**(要登记表)。
   * 读数器那边的事件触发重读(他从那家切走 / 切回工作台)要用它,所以在这里塞进去一次。
   */
  windowQuota?.bindOpenFamilies(openFamiliesNow)

  /**
   * 能接活的每一家的额度(卡 O;统筹 09-25「额度要覆盖派活名单里的每一家」)。
   *
   * ★ 2026-09-25(卡 Z):**哪几家从 Agent 登记表来**(`dispatchTargetsNow`),不再读写死的名单。
   * 登记表里新接上一家,额度区就多一行 —— 读不到它的额度时那一行是「没接上:还没找到这家的额度来源」
   * (`quotaFor` 认不出的 id 就是这一格),不空着、也不假装有数。
   */
  function agentQuotaNow(quota: WorkbenchState['quota']): ReturnType<typeof quotasFor> {
    const targets = dispatchTargetsNow()
    const views = quotasFor(targets.map(one => one.id), { ...quotaCtxNow(), quota })
    // 名字用登记表里的(卡 Z):额度区那一行写的就是他在顶栏看到的同一个名字。
    return views.map(view => ({ ...view, title: targetTitle(targets, view.id) }))
  }

  /**
   * 这件活的选项表(卡 O):挂的项目、他点名的那家(卡上的负责人)、体检、额度、规矩里的分工、上限。
   * `text` 缺席用卡上的原话。看板没接线 / 没这张卡回 undefined。
   */
  async function choicesFor(taskId: string | undefined, input: { kind?: JobKind, text?: string, named?: AgentDispatchFamily, projectId?: string, skills?: readonly string[], ignoreAssignee?: true } = {}): Promise<DispatchChoicesView | undefined> {
    return (await choicesAndClass(taskId, input))?.view
  }

  /** 写代码的那几家命令行此刻探到的事实;一家都还没探过(体检那一轮没跑)回一份空的 = 调用方不带它,走老行为。 */
  function cliFactsNow(): { cliFacts: Record<string, CapCliFact> } | Record<string, never> {
    const facts: Record<string, CapCliFact> = {}
    for (const family of CODE_CLI_FAMILIES) {
      if (family !== 'claude' && family !== 'codex' && family !== 'kimi') continue
      const fact = agentCaps?.cliFact?.(family)
      if (fact !== undefined) facts[family] = fact
    }
    return Object.keys(facts).length === 0 ? {} : { cliFacts: facts }
  }

  /**
   * 同上,另回这件活算哪一类(`habits.dispatchClassOf`:活的种类 + 挂的项目)—— 行为账记派活时带上它,
   * 数「默认分派」按它分。
   */
  async function choicesAndClass(taskId: string | undefined, input: { kind?: JobKind, text?: string, named?: AgentDispatchFamily, projectId?: string, skills?: readonly string[], ignoreAssignee?: true } = {}): Promise<{ view: DispatchChoicesView, klass: string } | undefined> {
    let task: TaskView | undefined
    if (taskId !== undefined) {
      task = (await tasks?.list())?.tasks.find(one => one.id === taskId)
      if (task === undefined) return undefined
    }
    const text = input.text ?? (task === undefined ? '' : [task.title, task.desc ?? ''].join('\n').trim())
    let project: { name?: string, path?: string } | undefined
    const projectId = input.projectId ?? task?.project_id
    if (projectId !== undefined && projects !== undefined) {
      try {
        const found = (await projects.getProjectsState()).projects.find(one => one.id === projectId)
        if (found !== undefined) project = { name: found.name, ...(found.path === undefined ? {} : { path: found.path }) }
      }
      catch { project = undefined }
    }
    const assignee = task?.assignee
    /*
     * `ignoreAssignee`(2026-10-29,任务书「派活智能体文件与起跑换手」③):派发那一步明说了这一下
     * **不是**点名(中枢按默认推荐挑的)—— 卡上负责人是中枢刚写上的挑选结果,不能据此把这一下
     * 记成「你点名要」。她真点名的路(原话里点了家 / 中枢 command.to)带 `named` 进来,不受影响。
     */
    const named = input.named ?? (input.ignoreAssignee === true ? undefined : assignee !== undefined && assignee !== 'dsh' && isAgentDispatchFamily(assignee) ? assignee : undefined)
    const division = divisionNow()
    // 派活确认之前顺手读一眼窗口上的额度(Manus 积分、Muse 用量;1 分钟节流、后台读,这一次用上一轮的数)。
    // 2026-09-27:定时读窗口那一轮撤了(维护者:「我觉得就是读一下的机制(十分钟取一次)导致的」)——只剩他切走那家时读。
    const view = dispatchChoices({
      text,
      ...(input.kind === undefined ? {} : { kind: input.kind }),
      ...(project === undefined ? {} : { project }),
      ...(named === undefined ? {} : { named }),
      ...(agentCaps === undefined ? {} : { caps: agentCaps.view() }),
      // 写代码的那几家命令行此刻探到的事实:挑「能换的几家」只列真探到、且登录状态不是 no 的
      // (2026-10-22 卡 C 收尾:没装 Kimi 的机器不把 Kimi 推荐出去)。体检那一轮还没跑过 = 一份空的,
      // 不带它,挑手照旧只看体检那一格(老行为,一字不变)。
      ...(agentCaps?.cliFact === undefined ? {} : cliFactsNow()),
      quota: service.getState().quota,
      quotaCtx: quotaCtxNow(),
      ...(division === undefined ? {} : { division }),
      // ★ 候选就是登记表那一份(卡 Z)。`installed` 只剩兜底那一路在用。
      targets: dispatchTargetsNow(),
      installed: appInstalledNow,
      apiReady: apiDispatch !== undefined,
      // 从行为账里学到的「这类事默认给谁」(卡「数出习惯」):排在她点名之后、规矩分工之前。
      ...(options.habits === undefined ? {} : { learned: (kind: JobKind, name?: string) => options.habits?.dispatchDefault(kind, name) }),
      ...(input.skills === undefined || input.skills.length === 0 ? {} : { skills: input.skills }),
    })
    return { view, klass: dispatchClassOf(view.kind, project?.name) }
  }

  /**
   * 这件新交代的活属于哪个项目(卡 O:写代码的活要知道在哪个仓库里改)。认得出才给:
   * 话里点到了某个项目的名字 / 规矩里写的仓库别名(「Lapis(仓库 Echo)」);或者说的是工作台自己的界面
   * (首页、事务官、粒子球、看板、窗口槽……)→ 工作台自己那个项目。认不出回 undefined(派活那一层会如实说没挂项目)。
   */
  async function inferProjectId(text: string): Promise<string | undefined> {
    if (projects === undefined) return undefined
    let list: readonly { id: string, name: string, path?: string }[]
    try { list = (await projects.getProjectsState()).projects }
    catch { return undefined }
    const lower = text.toLowerCase()
    for (const one of list) {
      if (one.name !== '' && lower.includes(one.name.toLowerCase())) return one.id
    }
    for (const rule of divisionNow()?.projects ?? []) {
      if (![rule.name, ...rule.aliases].some(name => name !== '' && lower.includes(name.toLowerCase()))) continue
      const hit = list.find(one => [rule.name, ...rule.aliases].some(name => one.name.toLowerCase() === name.toLowerCase() || (one.path ?? '').toLowerCase().endsWith(`/${name.toLowerCase()}`)))
      if (hit !== undefined) return hit.id
    }
    if (!/事务官|工作台|首页|粒子球|看板|窗口槽|收件箱|设置页|手机上的|电话里/.test(text)) return undefined
    for (const one of list) {
      if (one.path === undefined || one.path === '') continue
      try {
        if ((await detectSelfProject(one.path, file => readFile(file, 'utf8').catch(() => undefined))).self) return one.id
      }
      catch { /* 读不出来就跳过这一个 */ }
    }
    return undefined
  }

  /**
   * 写代码的活在哪个目录里干(卡 O + 统筹补充):**项目是工作台自己时,不在他正用着的那份仓库里改** ——
   * 为这件事开一个独立工作区(`<项目>/.claude/worktrees/<名>`,分支 `feat/<名>`,同「改工作台自己」那条路的
   * `POST /feature/branch`),派出去的命令行就在那里跑;合并与发布只走 `/feature/ship` 那固定的八步。
   * 别的项目原样(那是他自己的项目目录,Codex / Claude 命令行本来就在那里干活)。
   */
  /**
   * 别的项目的写代码的活也在独立工作区里跑(统筹 09-25 拍板 ②:「跟工作台自己同一套,这样不会弄乱他的目录」)。
   *
   * 工作区**开在他那份仓库外面**(`~/.dsh/workbench/worktrees/<项目>/<这件事>`):开在仓库里的 `.claude/worktrees`
   * 会在他的 `git status` 里多出一堆没跟踪的文件,那正是「弄乱他的目录」。分支叫 `workbench/<这件事>`,一眼看得出是工作台开的;
   * 改完不替他合,卡上写清改动在哪条分支、他看过再合。不是 git 仓库就开不出来 → 不派、说清楚(不退回他那份目录里直接改)。
   */
  /**
   * 分支名里那家名的守卫(2026-10-22 卡 D):只把「简单家名」用在分支前缀里 —— 包标识那种带点的不算
   * (前缀是给人一眼认的,越朴素越好);缺席 / 不合格退回老分支名,一字不变。
   */
  function branchPrefixOf(family: string | undefined): string | undefined {
    return family !== undefined && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(family) ? family : undefined
  }

  /**
   * 开出来的工作树软链依赖(2026-10-23,卡「派活给名片的四处」②):主检出里凡有 `<子目录>/node_modules`
   * 的,新工作树里同位置软链过去(相对路径)并写进 `info/exclude` —— 那家不用自己 `pnpm install`
   * (慢、占盘;10-21 并行卡死的教训)。主检出里一处都没有(别的布局)就不链、照常派活。
   * `prepareSelfBranch` 新开那一拍才调;链不上不拖垮开工作区(那家照旧自己装)。
   */
  const linkWorktreeDepsNow = async (created: { projectPath: string, worktree: string }): Promise<void> => {
    await linkWorktreeNodeModules(nodeWorktreeDepsIo(), created)
  }

  async function otherWorkdir(task: TaskView, cwd: string, family?: string): Promise<{ ok: true, cwd: string, note?: string, branch?: string } | { ok: false, why: string }> {
    if (runInCwd === undefined) return { ok: true, cwd }
    const existing = task.dispatch?.branch !== undefined && task.dispatch.cwd !== undefined ? task.dispatch.cwd : undefined
    // 短名(2026-10-23 卡「派活给名片的四处」①):卡的 from.ref 指向 docs/卡/<卡名>.md 用 <卡名>,否则
    // 标题前 12 个字 + 卡号后四位;认不出退回老的整条标题 slug。
    const slug = worktreeSlugOf(task) ?? featureSlug(task.title)
    if (slug === undefined) return { ok: false, why: '这件事的标题拼不出分支名,开不了独立工作区 —— 改一下标题再派' }
    // 名片派活(2026-10-22 卡 D):分支 `<family>/<这件事>`,一眼看得出是哪家的活;非名片派活一字不变(`workbench/<名>`)。
    const prefix = branchPrefixOf(family)
    const branch = task.dispatch?.branch ?? (prefix === undefined ? `workbench/${slug}` : `${prefix}/${slug}`)
    const home = options.paths?.home ?? process.env.HOME ?? ''
    if (home === '') return { ok: false, why: '找不到家目录,开不了独立工作区(不在你那份目录里直接改)' }
    const worktree = existing ?? join(home, '.dsh', 'workbench', 'worktrees', featureSlug(basename(cwd)) ?? 'project', slug)
    const prepared = await prepareSelfBranch({ run: runInCwd, afterCreate: linkWorktreeDepsNow }, { projectPath: cwd, branch, worktree })
    if (!prepared.ok) return { ok: false, why: `开不出独立工作区(不在你那份目录里直接改):${prepared.reason ?? '没说原因'}` }
    const at = prepared.worktree ?? worktree
    return { ok: true, cwd: at, branch: prepared.branch ?? branch, note: `在独立工作区 ${at} 里改(分支 ${prepared.branch ?? branch})` }
  }

  async function selfWorkdir(task: TaskView, cwd: string, family?: string): Promise<{ ok: true, cwd: string, note?: string, branch?: string } | { ok: false, why: string }> {
    if (runInCwd === undefined) return { ok: true, cwd }
    let verdict: { self: boolean }
    try { verdict = await detectSelfProject(cwd, one => readFile(one, 'utf8').catch(() => undefined)) }
    catch { verdict = { self: false } }
    if (!verdict.self) return await otherWorkdir(task, cwd, family)
    const existing = task.self_ship?.worktree
    if (existing !== undefined && existing !== '') return { ok: true, cwd: existing, note: `在独立工作区 ${existing} 里改` }
    // 名片派活(2026-10-22 卡 D):分支 `<family>/<这件事>`;非名片派活一字不变(`feat/<名>`)。
    // 短名(2026-10-23 卡「派活给名片的四处」①):同 otherWorkdir,卡名 / 标题前 12 字 + 卡号后四位。
    const slug = worktreeSlugOf(task) ?? featureSlug(task.title)
    const prefix = branchPrefixOf(family)
    const branch = slug === undefined ? undefined : (prefix === undefined ? branchOfFeature(slug) : `${prefix}/${slug}`)
    const worktree = slug === undefined ? undefined : worktreeOfFeature(cwd, slug)
    if (branch === undefined || worktree === undefined) return { ok: false, why: '这件事的标题拼不出分支名,开不了独立工作区 —— 改一下标题再派' }
    const prepared = await prepareSelfBranch({ run: runInCwd, afterCreate: linkWorktreeDepsNow }, { projectPath: cwd, branch, worktree })
    if (!prepared.ok) return { ok: false, why: `开不出独立工作区(不在你正用的那份仓库里改):${prepared.reason ?? '没说原因'}` }
    const at = prepared.worktree ?? worktree
    await tasks?.update(task.id, { selfShip: { branch: prepared.branch ?? branch, worktree: at, status: 'branched', started_at: new Date().toISOString() } })
    return { ok: true, cwd: at, note: `在独立工作区 ${at} 里改` }
  }

  /**
   * 每件事的上限与「停掉这一件」(卡 O,`server/itemBudget.ts`)。
   * 「换 X 来做」那一家 = 写代码的活的选项表里第一家派得出去的(按规矩排在前面)。
   */
  const itemBudget: ItemBudget | undefined = options.itemBudget === undefined || tasks === undefined ? undefined : createItemBudget({
    tasks,
    config: () => options.itemBudget?.store.get() ?? DEFAULT_ITEM_BUDGET,
    usage: sessionId => options.itemBudget?.usage(sessionId),
    ...(butlerSession?.cancel === undefined ? {} : { cancelSession: (sessionId: string) => (butlerSession.cancel as NonNullable<typeof butlerSession.cancel>)(sessionId) }),
    ...(butlerSession?.say === undefined ? {} : { say: (sessionId: string, text: string) => (butlerSession.say as NonNullable<typeof butlerSession.say>)(sessionId, text) }),
    ...(options.itemBudget.asker === undefined ? {} : { asker: options.itemBudget.asker }),
    switchCandidate: async (taskId, exclude) => {
      const view = await choicesFor(taskId, { kind: 'code' })
      const one = view?.options.find(option => option.ok && option.family !== exclude)
      if (one === undefined) return undefined
      return { family: one.family, title: one.title, ...(one.balance === undefined ? {} : { note: one.balance.text }) }
    },
    switchTo: async (taskId, family) => {
      const task = (await tasks.list()).tasks.find(one => one.id === taskId)
      if (task === undefined) return { ok: false, note: '没有这个事项' }
      const started = await dispatchItem(taskId, { family, text: task.desc ?? task.title, source: 'item', kind: 'code' })
      return { ok: started.ok, note: started.note }
    },
    killPid: pid => killDispatch(pid),
    // 命令行那件到时长上限停下来,他说「继续」:同一家、同一个目录(独立工作区照旧)再派一次,接着做。
    // 续跑接原会话(2026-10-23 卡「派活给名片的四处」③):带着 resume —— 上一次留下的会话号照原样接着
    // (Kimi --session / Claude --resume),那家不从头再读一遍;会话号缺席照旧新起。
    resumeCli: async (taskId, family) => {
      const task = (await tasks.list()).tasks.find(one => one.id === taskId)
      if (task === undefined) return { ok: false, note: '没有这个事项' }
      const said = `${task.desc ?? task.title}\n\n(上一次做到一半,到时长上限先停了;改过的东西都还在工作目录里 —— 先看一眼做到哪了,接着把它做完。)`
      const started = await dispatchItem(taskId, { family, text: said, source: 'item', kind: task.dispatch?.kind ?? 'code', resume: true })
      return { ok: started.ok, note: started.note }
    },
    now: () => new Date(),
    onChanged: () => { void composeState().then(state => broadcast({ kind: 'snapshot', state })).catch(() => {}) },
    /*
     * ★ **撞线记一条**(2026-10-04,卡「事务官上限只看钱」第 3 条)。
     * 落在**现成的**那本任务账上(`jobLog.ts`),不另起一个数据库。四样:哪件事(`job`)、
     * 哪类事(`kind`,按标题现判,与 `/dispatch/choices` 同一个 `jobKindOf`)、撞的哪条线(`action`)、
     * 卡在哪那句话(`why` —— 事务官自己报的;它没报就是那句如实话)。**不自动调高线。**
     */
    onLimit: ({ taskId, title, line, stuck }) => {
      jobLog.append({
        job: taskId,
        step: 'budget_stop',
        action: line,
        kind: jobKindOf(title).kind,
        why: stuck ?? BUDGET_STUCK_UNKNOWN,
      })
    },
  })

  const modelAutoSetup = options.modelAutoSetup
  const onboardingWarm = options.onboardingWarm
  const remoteAddress = options.remoteAddress ?? ((req: IncomingMessage) => req.socket.remoteAddress)
  const localAddress = options.localAddress ?? ((req: IncomingMessage) => req.socket.localAddress)
  const isLoopback = options.isLoopback ?? ((req: IncomingMessage) => isLoopbackAddress(remoteAddress(req)))
  const { pairing, lan } = options
  /** 本机账号与「首次流程走完没有」那面旗子(2026-09-17)。没接就各自 404,界面照旧。 */
  const { account, appConfig } = options
  /**
   * 签票那一处的「这台设备还属于这个账号吗」(2026-10-03,卡 claude/device-revoke-complete)。
   *
   * 判法、为什么只在数得出来的时候拒、为什么不缓存,全文在 server/deviceAccountGate.ts。
   * 两样都接上了才有它:账号不在服务器上(或者压根没接账号)时这一层没有「归属」可核。
   */
  const deviceAccountGate = pairing !== undefined && isServerAccount(account)
    && pairing.accountScopeOf !== undefined && pairing.noteAccountScope !== undefined
    ? createDeviceAccountGate({
        scope: () => account.accountScope(),
        accountDeviceIds: async () => {
          const listed = await account.devices()
          // 问不到就回 undefined(**不是空数组**):「账号名下一台都没有」与「没问到」是两件事。
          return listed.ok ? listed.view.devices.map(one => one.device_id) : undefined
        },
        markOf: async id => pairing.accountScopeOf?.(id),
        note: async (id, scope) => { await pairing.noteAccountScope?.(id, scope) },
        revokePairing: async (id) => { await pairing.revoke(id, 'account') },
      })
    : undefined
  const pathsOption = options.paths
  /** 路径可配(2026-09-17 卡 C)的两个文件系统依赖。缺省读真实文件系统,测试注入假的。 */
  const pathsStat = pathsOption?.statPath ?? (async (path: string): Promise<'dir' | 'other' | 'missing'> => {
    try {
      return (await stat(path)).isDirectory() ? 'dir' : 'other'
    }
    catch {
      return 'missing'
    }
  })
  const pathsFileExists = pathsOption?.fileExists ?? (async (path: string) => {
    try {
      await access(path)
      return true
    }
    catch {
      return false
    }
  })
  /** 这个模块自己在哪:技能正文从这里往上找开发仓库根。 */
  const pathsModuleDir = pathsOption?.moduleDir ?? new URL('.', import.meta.url).pathname
  /**
   * 钩子脚本(卡 R,2026-09-25):固定位置 `~/.dsh/workbench/hooks/` + 从插件包同步(hookScripts.ts)。
   * 「接上」的三条路(`GET /config/hooks`、`POST /config/hooks/apply`、「全部接上」)都先 `ensure` 一次:
   * 起服务时那一下没放成(磁盘满之类)的话这里再试一次 —— 能自己修的自己修,不叫他去改设置。
   */
  const hookScripts: WbHookScripts | undefined = pathsOption === undefined
    ? undefined
    : pathsOption.hookScripts ?? createHookScripts({
      home: pathsOption.home,
      moduleDir: pathsOption.moduleDir ?? fileURLToPath(new URL('.', import.meta.url)),
    })
  /** 脚本放好了就回固定位置;放不成回给人看的那一句,技术细节只进日志。 */
  async function hooksDirNow(): Promise<{ ok: true, dir: string } | { ok: false, error: string }> {
    if (hookScripts === undefined) return { ok: false, error: '代写钩子未启用' }
    const ready = await hookScripts.ensure()
    if (ready.ok) return { ok: true, dir: ready.dir }
    console.log(`[钩子] 钩子脚本没放好(${ready.reason}):${ready.detail}`)
    return { ok: false, error: ready.error }
  }
  /**
   * 代写钩子用的真实 I/O。用登录台那一套(nodeSetupIo)而不是另写一份:它的 writeFile
   * 会先把父目录建出来 —— `~/.codex` 在一台只装了 Claude 的机器上可能压根不存在。
   * **只有 applyHooks 接了线才会被造出来**,既有用例碰不到它。
   */
  const hooksApplyIo = (): WbHooksApplyIo['io'] => nodeSetupIo()

  /**
   * 「全部接上」(2026-09-25)要的那一份依赖 —— 与 `POST /config/hooks/apply` **同一套**:同一对文件路径、
   * 同一个 I/O、同一份钩子脚本(固定位置)、同一份探测结论。没接代写(`paths.applyHooks` 缺席)就 undefined,
   * 路由回 404 —— 既有那一大批用例碰不到它,更不会有哪条用例写到真实家目录里去。
   */
  function connectAllDeps(): ConnectAllDeps | undefined {
    const option = pathsOption
    const applyOption = option?.applyHooks
    if (option === undefined || applyOption === undefined) return undefined
    return {
      files: applyOption.files,
      io: applyOption.io ?? hooksApplyIo(),
      now: applyOption.now ?? (() => new Date()),
      hooksDir: hooksDirNow,
      clients: () => clientScan?.view(),
    }
  }

  /** GET/PUT 共用的回包形状。顶层三项是**配置值**(没配就是 null),别跟 effective 混了。 */
  async function pathsPayload(): Promise<Record<string, unknown>> {
    const option = pathsOption
    if (option === undefined) return {}
    const config = await option.config.get()
    const defaults = wbPathsDefaults(option.home)
    const effective = wbPathsEffective(config, {
      home: option.home,
      ...(option.envButlerCwd === undefined ? {} : { envButlerCwd: option.envButlerCwd }),
    })
    return {
      scan_roots: config.scan_roots ?? null,
      inbox_dirs: config.inbox_dirs ?? null,
      butler_cwd: config.butler_cwd ?? null,
      defaults: { scan_roots: defaults.scan_roots, inbox_dirs: defaults.inbox_dirs },
      effective: {
        scan_roots: effective.scan_roots,
        inbox_dirs: effective.inbox_dirs,
        butler_cwd: effective.butler_cwd ?? null,
        butler_cwd_source: effective.butler_cwd_source,
      },
    }
  }
  /**
   * 派活允许落脚的目录(2026-09-21,任务书第 4 条)。取的是**授权的扫描根** ——
   * 跟「事务官能读哪些目录」同一份配置,不另立一张表:两张表迟早会漂,而漂出来的后果
   * 是在一个他没授权的仓库里改文件。
   *
   * 路径配置整块没接时回空数组,那时这道门**不拦**(行为与这件功能出现之前一致);
   * 接上了就按它拦。
   */
  async function dispatchRoots(): Promise<readonly { path: string }[]> {
    const option = pathsOption
    if (option === undefined) return []
    const config = await option.config.get()
    const effective = wbPathsEffective(config, {
      home: option.home,
      ...(option.envButlerCwd === undefined ? {} : { envButlerCwd: option.envButlerCwd }),
    })
    return effective.scan_roots.map(root => ({ path: root.path }))
  }

  /**
   * ——— 手机从电脑取文件(2026-09-25,卡 J;docs/交接-0925-手机取文件.md) ———
   *
   * 找的范围与工人那一侧(`GET /channel/search-roots`)同一份:扫描根要 `read_scan_roots`
   * 是「可以」;事务官自己的文件夹一直能找。取件单只活在内存里(重启就作废,他再说一次就是)。
   */
  const fileOffers = createFileOffers()
  /**
   * 「要一份文件」那一类事项的**交付回执台账**(2026-10-04,卡 `claude/phone-file-send-loop`;
   * 为什么要它见 `fileDelivery.ts` 文件头)。登记在 `/butler/item`,开单在 `POST /butler/send-file`,
   * 回执从三条路报进来(直连下载完 / 工人推完 / 手机自己说收到了),收尾那一刻 `butlerLifecycle` 问它一句。
   */
  /**
   * ★ **台账落盘**(2026-10-04 午后统筹定,卡 `claude/three-small-1004`):
   * `~/.dsh/workbench/file-delivery.json`。从前它只在内存里 —— 工作台重启一次,
   * 「这件事还差一个回执」就忘了,收尾那一问答「没登记过」,那张卡又成了「办完了」。
   * 读写与容错在 `fileDeliveryFile.ts`(老数据读得懂、读不出来就从空的开始、写不下去不抛)。
   * 家目录认不出来(单测、没有 HOME)就照旧只在内存里。
   */
  // 落盘只认调用方给的 home(生产由 index.ts 传):不再退回 process.env.HOME —— 10-13 整包里几份用例没传 paths,
  // 把 direct-answers / file-delivery 写进了维护者真家目录,事务官页上冒出三条假「你说(电话):…」。
  const fileDeliveryHome = options.paths?.home ?? ''
  const fileDelivery = createFileDeliveryStore(
    fileDeliveryHome === ''
      ? {}
      : { persist: createFileDeliveryPersist(defaultFileDeliveryFile(fileDeliveryHome)) },
  )
  /**
   * ★ **「问一句」那本回答账**(2026-10-04,卡 `claude/answer-comes-to-her`;
   * 为什么要它见 `directAnswer.ts` 文件头 —— 维护者 10-04:「信息直接从正在办切到办完了,
   * 我是自己追过去点开查看的」)。
   *
   * 记在会话收尾那一步(`butlerLifecycle` 的 `deliverAnswer`),投影进 `/state.answers`,
   * 「她看过了」从 `POST /answers/seen` 进来(两端同一处)。
   * 落盘 `~/.dsh/workbench/direct-answers.json`:不落盘的话重启一次,她看过的那条会**又推一次通知**。
   * 家目录认不出来(单测、没有 HOME)就照旧只在内存里。
   */
  /**
   * ★ **她在哪问的**(2026-10-04,卡 `claude/answer-comes-to-her`):卡 id → 手机 / 电脑 / 电话里。
   *
   * 建卡那一步落一格(`ruleChannelOf` 一处算 —— 它本来就是「她这句话在哪儿说的」的主人,
   * 规矩表那一侧用的是同一个函数),收尾那一步 `deliverAnswer` 读一次就删。
   *
   * **只在内存里**,而且故意不落盘:它说的是「这一轮里她在哪问的」,不是一件要跨重启记住的事实。
   * 读不到就缺席 —— 那时两端都摆、都推通知(宁可多推一处,不能让答案没去处)。
   */
  const askedWhere = new Map<string, ButlerRuleChannel>()

  const directAnswers: DirectAnswerStore = createDirectAnswerStore({
    ...(fileDeliveryHome === '' ? {} : { persist: createDirectAnswerPersist(defaultDirectAnswerFile(fileDeliveryHome)) }),
    // 账一动两端立刻看得见(同 questions.onChange 那一处的做法)。
    onChange: () => { void composeState().then(state => broadcast({ kind: 'snapshot', state })).catch(() => {}) },
  })

  const fileWorkDir = options.fileWorkDir ?? (composer === undefined ? undefined : dirname(composer.inboxDir))
  const computerName = options.computerName ?? (osHostname().replace(/\.local$/i, '').trim() || '这台电脑')
  async function fileFetchScope(withProjects = true): Promise<FetchScope> {
    let authorized = false
    let note: string | undefined
    if (authorization === undefined) note = '这台工作台没接授权表,只在事务官文件夹里找了。'
    else if (!(await authorization.isAllowed('read_scan_roots'))) {
      note = `${authorization.denialMessage('read_scan_roots')}(这一次只在事务官文件夹里找了)`
    }
    else authorized = true
    const roots: FetchRoot[] = []
    const scanRoots = authorized ? await dispatchRoots() : []
    // 找文件的深度与「扫仓库」的深度不是一回事:扫描根配的 depth 是仓库藏多深,文件还在仓库里面几层。
    for (const root of scanRoots) roots.push({ path: root.path, label: basename(root.path), depth: FETCH_MAX_DEPTH })
    if (fileWorkDir !== undefined) roots.push({ path: fileWorkDir, label: '事务官文件夹', depth: 3, labelPrefix: true })
    let projectRefs: ProjectRef[] = []
    if (withProjects && authorized && projects !== undefined) {
      try {
        const state = await projects.getProjectsState()
        projectRefs = state.projects
          .filter(project => typeof project.path === 'string' && project.path !== '')
          .map(project => ({ name: project.name, path: project.path as string }))
          // 只认在扫描根底下的项目:项目区里手填的一条路径,不该绕开授权。
          .filter(project => scanRoots.some(root => project.path === root.path || project.path.startsWith(`${root.path}/`)))
      }
      catch { projectRefs = [] }
    }
    return { authorized, ...(note === undefined ? {} : { note }), roots, projects: projectRefs }
  }
  /**
   * 要文件那一类**送到哪一台**(2026-10-04)。
   *
   * 她手里这台是手机 / 平板 → 就是它(她刚在上面说的那句话);
   * 她在电脑上打的那句话 → 取此刻在线的那台手机(工人报的那份表,`GET /devices/online` 同一份);
   * 一台都认不出 → **undefined,整件事不登记** —— 说不出送到哪儿就别立一个"要送到"的牌子(D13)。
   *
   * 话筒(`handset`,树莓派上那只)不算:**发不了文件给一只听筒**(同手机那头
   * `channel/devices.ts` 的 `WBCH_FILE_TARGET_KINDS`)。
   */
  function fileWantTarget(from: { id: string, name: string, kind?: string } | undefined): { id: string, name: string } | undefined {
    if (from !== undefined && from.kind !== 'handset') return { id: from.id, name: from.name }
    const online = deviceDirectory?.view().devices ?? []
    const phone = online.find(one => one.kind === 'phone')
    return phone === undefined ? undefined : { id: phone.device_id, name: phone.name }
  }

  /**
   * **把一个本机文件推到她手机上**(2026-10-12 晚,两步接力出片之后用)。与 `POST /butler/send-file` 的 path 分支
   * 同一道门(`checkOfferFile`:还在、普通文件、在能取的根底下、不超 200MB、不是密钥)、同一份台账(`fileDelivery`)——
   * 手机那头照旧是那张「点一下就取」的卡;通话里收到视频那张卡,手机自己弹播放器。
   * 文件不在能取的根底下(选题文件夹在她工作目录里,不一定在根里)→ 先复制进事务官文件夹再推。
   */
  async function pushFileToPhone(itemId: string, askedPath: string): Promise<{ ok: boolean, note: string }> {
    const task = (await tasks?.list())?.tasks.find(one => one.id === itemId)
    if (task === undefined) return { ok: false, note: '没有这张卡' }
    let need = fileDelivery.need(itemId)
    if (need === undefined) {
      const to = fileWantTarget(undefined)
      if (to === undefined) return { ok: false, note: '这会儿认不出要送到哪一台手机上(手机没连上来)' }
      need = fileDelivery.expect({ itemId, request: task.title, deviceId: to.id, deviceName: to.name })
    }
    const roots = await fileFetchRootPaths()
    let path = askedPath
    let checked = await checkOfferFile(path, roots)
    if (!checked.ok && fileWorkDir !== undefined) {
      const copy = join(fileWorkDir, '视频', basename(askedPath))
      try {
        await mkdir(dirname(copy), { recursive: true })
        await copyFile(askedPath, copy)
        path = copy
        checked = await checkOfferFile(path, roots)
      }
      catch { /* 复制不过去就照第一次那句如实说 */ }
    }
    if (!checked.ok) {
      fileDelivery.failed(itemId, checked.error)
      return { ok: false, note: checked.error }
    }
    const name = basename(path)
    const offer = fileOffers.add({ path, name, bytes: checked.bytes, where: '事务官给的', device_id: need.device_id, source: 'typed' })
    const ask: FileAskView = {
      id: randomUUID(),
      request: need.request,
      query: name,
      device: computerName,
      hits: [{ offer: offer.id, name, where: '事务官给的', bytes: checked.bytes, kind: fetchKindOf(name) }],
      total: 1,
    }
    fileDelivery.offered(itemId, { what: name, offers: [offer.id], ask })
    broadcast({ kind: 'snapshot', state: await composeState() })
    return { ok: true, note: sendFileNote(name, need.device_name) }
  }

  /** 取的那一刻核一遍「还在不在能找的根底下」要用的根(扫描根 + 事务官文件夹)。不用认项目,省一次项目区。 */
  async function fileFetchRootPaths(): Promise<string[]> {
    return (await fileFetchScope(false)).roots.map(root => root.path)
  }

  /**
   * ——— 读一个项目(2026-09-24,已有项目拉齐;设计 docs/设计-已有项目拉齐-2026-09-24.md 第三~五节) ———
   *
   * `POST /onboarding/scan {name}` 只找到一个时顺手读好、`POST /onboarding/project-brief {path}` 读指定的那个,
   * **两处同一道门**({@link projectReadGate})、同一个读法({@link readBriefAt})、同一段话术(projectBrief.ts 的 note)。
   */
  const projectBriefOption = options.projectBrief
  /** 这一次进程里按名字 / 路径找到过、扫描回过的路径(记 30 分钟)。读项目的路径白名单认它。 */
  const surfacedPaths = createSurfacedPaths()
  /**
   * 「她去找 / 读你的项目」那一整段等待的窗口(2026-09-24 傍晚,卡 fix/scan-orb-working-whole-wait;
   * 见 onboardingActivity.ts 文件头)。找、读两条路由用它包住真动手的那一段;`turns.scan` 与 `/onboarding/scan/status`
   * 交的是它的 view。DSH 那条路上窗口撑到回合表里她的下一句;电话那条路活儿做完就收(她开口由手机本地看)。
   */
  const onboardingActivity = projects === undefined ? undefined : createOnboardingActivity({
    // 每次现问(不在起服务时摘下来):项目区那一份是随时能读的纯内存。
    progress: () => projects.scanProgress?.() ?? { scanning: false, done: 0 },
    ...(onboardingTurns === undefined
      ? {}
      : {
          turns: {
            busy: () => onboardingTurns.status().busy,
            lastSeq: () => onboardingTurns.list(0).reduce((max, turn) => Math.max(max, turn.seq), 0),
            spokeAfter: (seq: number) => onboardingTurns.list(seq).some(turn => turn.role === 'assistant'),
          },
        }),
  })
  /** 界面拿的那一份扫描进度(窗口的 view)。项目区没有进度这一格就缺席(老规矩:不回一个「没在扫」冒充)。 */
  const scanView = (): ActivityWire | undefined =>
    projects?.scanProgress === undefined ? undefined : onboardingActivity?.view()
  /** 在窗口里干一段活儿(没接项目区就直接干)。 */
  const inScanWindow = async <T>(work: () => Promise<T>): Promise<T> =>
    onboardingActivity === undefined ? await work() : await onboardingActivity.run(work)
  /** 刚读过的那几份(同一个 path 60 秒内再读直接回上一份;2026-09-24 下午小修「别读两遍」)。钟用读项目那一套 I/O 的。 */
  const briefReuse = projectBriefOption === undefined ? undefined : createBriefReuse(() => projectBriefOption.io.now())

  /**
   * 找项目、读项目共用的门:
   *   ① 新点子 / 运营那一支(②′ 这一段的 key 里没有 read_scan_roots)→ 403 `reason:'branch'`:不找也不读(设计第五节「接口 403 兜底」);
   *   ② `read_scan_roots` 不是「可以」→ 403 `reason:'consent'`,带那句人话与「先问后看」的用法(`note`,工人原样交给模型);
   * 没接授权表 → 503。项目区 / 读项目没接,由各条路由自己说。
   */
  async function projectReadGate(): Promise<{ status: number, body: Record<string, unknown> } | undefined> {
    if (authorization === undefined) return { status: 503, body: { error: '这台工作台没接授权表,找不了也读不了项目' } }
    const detail = onboarding?.detail()
    if (detail !== undefined && !detail.done && detail.stage === 'projects' && !(detail.next?.keys ?? []).includes('read_scan_roots')) {
      return { status: 403, body: { error: BRANCH_REFUSAL, reason: 'branch' } }
    }
    if (!(await authorization.isAllowed('read_scan_roots'))) {
      return { status: 403, body: { error: authorization.denialMessage('read_scan_roots'), reason: 'consent', note: READ_CONSENT_NOTE } }
    }
    return undefined
  }

  /** 读好的一份 → 回包(200)。新读的与「用刚才读的」同一个形状、同一段 note。 */
  function briefBody(read: ProjectBrief): Record<string, unknown> {
    return {
      ok: true,
      name: read.name,
      path: read.path,
      brief: read.brief,
      sources: read.sources,
      ...(read.missing.length === 0 ? {} : { missing: read.missing }),
      ...(read.redacted === 0 ? {} : { redacted: read.redacted }),
      note: BRIEF_NOTE,
    }
  }

  /**
   * 读一个项目:路径白名单(扫描根之下 / 项目区录过的 / 这次找到过的)→ 读(扫描进度里算一段 `phase:'read'`)→ 回包。
   * **只读**:不写项目区缓存、不写记忆;摘要只随这一次回包走,不落盘。没接读项目 → 503。
   *
   * 2026-09-24 下午小修:
   *   - **同一个 path 60 秒内再读,直接回上一份**(日志注明「用刚才读的」),不再跑 git、不再读文件,
   *     路径白名单也不再核一遍(上一次读的时候核过)。门(授权 / 分支)在调用方那里,照旧每次都过。
   *   - 读成了(新读或用上一份)就告诉阶段机「这一次引导里读过它」:之后他点头记下的那几句按事实标「读仓库说明,他确认」。
   */
  async function readBriefAt(raw: unknown): Promise<{ status: number, body: Record<string, unknown> }> {
    const option = projectBriefOption
    if (option === undefined) return { status: 503, body: { error: '这台工作台没接读项目' } }
    const reuseKey = briefPathKey(raw, option.home)
    const reused = reuseKey === undefined ? undefined : briefReuse?.get(reuseKey)
    if (reused !== undefined) {
      // 用刚才读的也算「读了一遍 X」(2026-09-24 傍晚):扫描进度照样留 last_read,
      // 等她开口那一段里那一行说的是「正在读 X 的说明…」,不是笼统的「正在找你的项目…」。不跑 git、不读文件。
      if (projects?.trackRead !== undefined) await projects.trackRead(reused.brief.name, async () => undefined)
      onboarding?.noteBriefRead?.(reused.brief.path)
      console.log(`[引导] 读项目 ${reused.brief.name} → 用刚才读的(${Array.from(reused.brief.brief).length} 字,`
        + `${Math.round(reused.ageMs / 1000)} 秒前读的,没再跑 git)`)
      return { status: 200, body: briefBody(reused.brief) }
    }
    let roots: readonly string[] = []
    try { roots = (await projects?.scanRootPaths?.()) ?? (await dispatchRoots()).map(root => root.path) }
    catch { roots = [] }
    let known: readonly string[] = []
    try { known = (await projects?.knownPaths?.()) ?? [] }
    catch { known = [] }
    const verdict = await resolveBriefPath(raw, { home: option.home, roots, known, surfaced: surfacedPaths.list() }, option.io)
    if (!verdict.ok) return { status: verdict.status, body: { error: verdict.error, reason: verdict.reason } }
    const name = projectNameOf(verdict.path)
    const run = async () => await readProjectBrief({ root: verdict.real, path: verdict.path, name }, option.io)
    let read: Awaited<ReturnType<typeof run>>
    try { read = projects?.trackRead === undefined ? await run() : await projects.trackRead(name, run) }
    catch (err) { return { status: 500, body: { error: `读项目没读成:${err instanceof Error ? err.message : String(err)}` } } }
    briefReuse?.put(verdict.path, read)
    onboarding?.noteBriefRead?.(verdict.path)
    console.log(`[引导] 读项目 ${name} → ${Array.from(read.brief).length} 字(${read.sources.map(source => source.label).join('、') || '什么都没读到'})`
      + `${read.missing.length > 0 ? ` · 没读到:${read.missing.join(';')}` : ''}`)
    return { status: 200, body: briefBody(read) }
  }

  /**
   * 停掉一次派活 = 给那个 pid 发 SIGTERM。**注入的**(测试不许真杀本机进程)。
   *
   * 为什么是 SIGTERM 不是 SIGKILL:两家 CLI 收到 TERM 都会把手上写了一半的文件收尾再退。
   * KILL 会在半个文件上留下个半截 —— 那比多等两秒坏得多。
   */
  const killDispatch = options.killProcess ?? ((pid: number) => { process.kill(pid, 'SIGTERM') })

  /**
   * 技能正文里 `{{工作台地址}}` 该渲成什么(2026-09-26,卡 SP)。
   *
   * 取的是**真在听的那个端口**(`listeningPort()`,不是 `options.port` —— 后者可能是 0
   * 「由系统分配」),和真绑上的那个 host;收敛规矩由 `serviceBaseUrl` 管(通配地址 / localhost
   * 一律收成回环,那也是账号 cookie 认的那个域)。
   *
   * 为什么不用一个常量:服务端口是 `WORKBENCH_PORT` 算出来的,灰度实例在 8890。技能正文里写死
   * 8791 的后果是灰度实例里的事务官**照那个地址把活派给了生产**(卡 ZM 2026-09-26 撞出)。
   * 这跟文末那张「这台电脑上现在怎么派」表同一条路:凡每台机器不一样的东西都接上那一刻现渲。
   *
   * 只在写技能正文时调 —— 一律在 `listen` 之后(`/config/skill`、`/config/ops-skills*` 是
   * 请求里调的,起服务补那一次在 `void ensureOpsSkills()`,它排在 `server.listen` 后面)。
   */
  function skillServiceBaseUrl(): string {
    return serviceBaseUrl(host, listeningPort())
  }

  /**
   * 派活技能段要写的东西(2026-09-21)。`GET /config/skill` 与两条写路共用这一份 ——
   * **"看到的"与"写进去的"必定一致**(同 /config/hooks 的取舍)。
   *
   * 三样都得齐:代写钩子那一套 io(它带着备份纪律)、本机仓库根(技能正文在仓库里)、
   * 家目录(`~/.dsh/AGENTS.md`)。缺一样就如实回一句,不猜。
   */
  async function prepareDispatchSkill(): Promise<
    | { ok: true, file: string, body: string, bodyFile: string, clis: readonly AgentCli[], deps: WbHooksApplyIo }
    | { ok: false, status: number, error: string }
  > {
    const applyOption = pathsOption?.applyHooks
    if (pathsOption === undefined || applyOption === undefined) {
      return { ok: false, status: 404, error: '代写事务官技能未启用' }
    }
    const home = pathsOption.home
    if (home === '') return { ok: false, status: 404, error: '不知道家目录在哪,写不了 ~/.dsh/AGENTS.md' }

    const config = await pathsOption.config.get()
    const effective = wbPathsEffective(config, {
      home,
      ...(pathsOption.envButlerCwd === undefined ? {} : { envButlerCwd: pathsOption.envButlerCwd }),
    })
    const repo = await wbHooksResolveRepoRoot({
      moduleDir: pathsModuleDir,
      ...(effective.butler_cwd === undefined ? {} : { butlerCwd: effective.butler_cwd }),
      exists: pathsFileExists,
    })
    const io = applyOption.io ?? hooksApplyIo()
    // 仓库优先,包内兜底(2026-09-23,bundledSkills.ts):普通用户机器上没有仓库也接得上。
    const found = await readSkillDoc(
      DISPATCH_SKILL_DOC,
      repo === undefined ? undefined : async rel => await io.readFile(`${repo.root}/${rel}`),
    )
    if (found === undefined) {
      // 读不到就一个字都不写 —— 半份技能比没有技能更坏(事务官会开始自己编命令)。
      return { ok: false, status: 404, error: `仓库与插件包里都没有 ${DISPATCH_SKILL_DOC},这次一个字都没写。` }
    }
    const docText = found.text

    const clis = probeAgentClis(home)
    return {
      ok: true,
      file: `${home}/.dsh/AGENTS.md`,
      // 地址那一半也是"每台机器不一样"的东西(卡 SP):正文里的 `{{工作台地址}}` 渲成真在听的那个。
      body: dispatchSkillBody(pointServiceAt(docText, skillServiceBaseUrl()), clis),
      // 正文落在哪(2026-10-02):段里只留索引,与起服务那条路同一个路径算法。
      bodyFile: skillBodyFile(home, WB_SKILL_DISPATCH),
      clis,
      deps: { io, now: applyOption.now ?? (() => new Date()) },
    }
  }

  /**
   * 各家命令行在哪(本机现探)。CLI 探测走同步的 fs:与 quota/codexAppServer.ts 的 resolveCodexBinary
   * 同一个路子(它也是 existsSync)。这是一次几十个 stat 的本机探测,不值得为它把整条链路改成异步。
   */
  function probeAgentClis(home: string): AgentCli[] {
    const probe: AgentCliProbe = {
      pathEnv: process.env.PATH,
      home,
      exists: existsSync,
      listDir: (dir) => { try { return readdirSync(dir) } catch { return [] } },
    }
    // 探哪几家:登记表那一份(卡 Z)。没为它写过专门探法的那一家会如实回「没查过」,照旧走窗口那只手。
    return dispatchTargetsNow().map(one => resolveAgentCli(one.id, probe))
  }

  /**
   * 运营技能包要的那一份准备(2026-09-22,卡 ①「技能一键接上」)。
   *
   * **四条路共用这一份**:`GET /config/ops-skills`(先看)、`POST /config/ops-skills/apply`
   * (后写,设置里那颗「重新接上」)、**切模板之后自动接一次**、**起服务时补一次**。
   * 共用的理由与 `/config/hooks` 同:「界面上看到的」与「真写进去的」必须是同一份,
   * 两处各算一遍迟早会漂,而漂出来的现象是"界面说接上了、事务官其实没读到"。
   */
  interface OpsSkillsPrepared {
    ok: true
    /** `~/.dsh/AGENTS.md`。 */
    file: string
    /** 当前模板 id。没接模板服务时 undefined —— 那等于做产品,于是只摘不写。 */
    templateId: string | undefined
    /** 这个模板下该写的那几段。 */
    skills: readonly OpsSkillDef[]
    /** 本机仓库根。找不到就缺席 —— 那时技能正文用包内那份(bundledSkills.ts)。 */
    repoRoot?: string
    /** 用包内技能时违禁词表落在哪(`~/.dsh/workbench/技能/违禁词表.md`)。 */
    wordlistFile: string
    readDoc: (skill: OpsSkillDef) => Promise<string | undefined>
    /** 这一段的正文落在哪(2026-10-02:AGENTS.md 里只留索引)。 */
    bodyFile: (name: string) => string
    deps: WbHooksApplyIo
  }

  async function prepareOpsSkills(): Promise<OpsSkillsPrepared | { ok: false, status: number, error: string }> {
    const applyOption = pathsOption?.applyHooks
    if (pathsOption === undefined || applyOption === undefined) {
      return { ok: false, status: 404, error: '代写事务官技能未启用' }
    }
    const home = pathsOption.home
    if (home === '') return { ok: false, status: 404, error: '不知道家目录在哪,写不了 ~/.dsh/AGENTS.md' }

    const templateId = template?.view().id
    const config = await pathsOption.config.get()
    const effective = wbPathsEffective(config, {
      home,
      ...(pathsOption.envButlerCwd === undefined ? {} : { envButlerCwd: pathsOption.envButlerCwd }),
    })
    const repo = await wbHooksResolveRepoRoot({
      moduleDir: pathsModuleDir,
      ...(effective.butler_cwd === undefined ? {} : { butlerCwd: effective.butler_cwd }),
      exists: pathsFileExists,
    })
    const deps: WbHooksApplyIo = { io: applyOption.io ?? hooksApplyIo(), now: applyOption.now ?? (() => new Date()) }
    // 技能正文:仓库优先(跟钩子同一个仓库根解析法,改技能不用发版),找不到仓库就用包内那份
    // (2026-09-23,bundledSkills.ts)。包内那份里的违禁词表路径换成落盘到 ~/.dsh 的那份。
    const wordlistFile = bundledWordlistFile(home)
    const readDoc = async (skill: OpsSkillDef): Promise<string | undefined> => {
      const found = await readSkillDoc(
        opsSkillDoc(skill),
        repo === undefined ? undefined : async rel => await deps.io.readFile(`${repo.root}/${rel}`),
      )
      if (found === undefined) return undefined
      /**
       * 工作台地址(2026-09-26,卡 SP):正文里的 `{{工作台地址}}` 换成这台服务真在听的地址。
       * **仓库那份与包内那份都要换** —— 两份都不知道这台服务听在哪(违禁词表那一处只换包内那份,
       * 因为仓库那份写的相对路径在仓库里本来就是对的)。没有占位的技能这一下什么都不做。
       */
      const text = pointServiceAt(found.text, skillServiceBaseUrl())
      /**
       * 「派活给别家Agent」那一段(2026-09-24,卡 F,进了基础那一包):正文后面接一张**这台电脑现探的**
       * 「现在怎么派」表(同 `/config/skill` 那一份),路径那一半每台机器不一样,不写死在仓库里。
       */
      if (skill.name === WB_SKILL_DISPATCH) return dispatchSkillBody(text, probeAgentClis(home))
      return found.source === 'bundled' ? pointWordlistAt(text, wordlistFile) : text
    }
    return {
      ok: true,
      file: `${home}/.dsh/AGENTS.md`,
      templateId,
      skills: opsSkillsForTemplate(templateId),
      ...(repo === undefined ? {} : { repoRoot: repo.root }),
      wordlistFile,
      readDoc,
      bodyFile: (name: string) => skillBodyFile(home, name),
      deps,
    }
  }

  /** 现在接上了没有:读一遍 AGENTS.md,按标记段数(纯判断在 opsSkills.ts)。 */
  async function opsSkillsAttached(prepared: OpsSkillsPrepared): Promise<OpsSkillsAttachState> {
    const text = await prepared.deps.io.readFile(prepared.file)
    return opsSkillsAttachState(text, prepared.templateId)
  }

  type OpsSkillsEnsured =
    | { ok: true, changed: boolean, written: string[], removed: string[], missing: string[], backup_path?: string, note: string }
    | { ok: false, error: string }

  /**
   * **自动接上**(2026-09-22,卡 ① 的第一件事)。切到自媒体运营模板时调一次、起服务时补一次。
   *
   * ## 为什么要有这一下
   *
   * 在这之前,十份运营技能写好了、清单也有了,可把它们写进 `~/.dsh/AGENTS.md` 的**唯一**入口是
   * `POST /config/ops-skills/apply`,而**界面上没有任何一颗按钮会去调它** —— 于是切了运营模板的
   * 用户,事务官根本不知道有这几条技能。她说「我想做一期讲 X 的」,事务官按通用口径随便聊两句,
   * 不会去梳理框架、更不会落 `选题/<选题名>/框架.md`。
   *
   * ## 纪律与「钩子由工作台代写」完全一致(docs/交接-0917-钩子由工作台代写.md)
   *
   * 先看后写(`GET /config/ops-skills` 与这条路吐的是同一份)、**写前备份**(备份没做成就一个字
   * 都不写)、**只动自己那几个标记段**(段外一个字不动)、**可撤**(切回做产品模板会把运营那十段
   * 摘掉,`wbOpsSkillsApply` 里那一支)。**幂等**:内容一模一样时不写、不备份,所以每次重启
   * 都调一遍不会在他的 `~/.dsh` 里堆出一串 `.bak`。
   *
   * 失败**不连累调用方**:切模板本身已经成功了,技能没接上只是那一次 200 里多一句实话
   * (D13:如实回,不总结成"成功")。
   */
  /**
   * 排队(2026-09-22)。三处会调 `ensureOpsSkills`:起服务那一下、切模板、设置里那颗按钮,
   * 而它们**可能撞在一起**(起服务那一下是 fire-and-forget,用户这会儿正好点了切模板)。
   *
   * 两次「读全文 → 换段 → 写回」交错的后果是**丢段**:后写的那一份是基于更早那一次读到的
   * 全文算出来的。排成一条队之后,后一次读到的必定是前一次写完的结果。
   * (同 templateStore 里那个 `enqueue` 的理由;这里的队列不需要跨进程 —— 写这个文件的
   * 只有工作台自己。)
   */
  let opsSkillsChain: Promise<unknown> = Promise.resolve()
  function ensureOpsSkills(): Promise<OpsSkillsEnsured | undefined> {
    const next = opsSkillsChain.then(async () => await ensureOpsSkillsNow())
    // 链条本身不许因为某一次失败就断掉(断了之后每一次调用都会立刻被拒)。
    opsSkillsChain = next.catch(() => undefined)
    return next
  }

  async function ensureOpsSkillsNow(): Promise<OpsSkillsEnsured | undefined> {
    const prepared = await prepareOpsSkills()
    // 整块没接线(既有那一大批 `startWorkbenchServer(...)` 用例就是这样)→ 什么都不做,
    // 更不会有哪条用例意外写到真实家目录里去(同 applyHooks 那条纪律)。
    if (!prepared.ok) return undefined

    // 没有仓库(普通用户机器):技能用包内那份,它读的违禁词表先落到 ~/.dsh(内容一样就不写)。
    if (prepared.repoRoot === undefined && prepared.skills.some(skill => skill.name.startsWith('运营-'))) {
      const wordlist = bundledSkillDoc(WORDLIST_REL)
      if (wordlist !== undefined) {
        try {
          const current = await prepared.deps.io.readFile(prepared.wordlistFile)
          if (current !== wordlist) await prepared.deps.io.writeFile(prepared.wordlistFile, wordlist)
        }
        catch {
          // 词表没落成:技能照写,查词那一段会如实说读不到表(它的规矩是没有判据就不判)。
        }
      }
    }
    const result = await wbOpsSkillsApply(prepared.deps, {
      file: prepared.file,
      templateId: prepared.templateId,
      readDoc: prepared.readDoc,
      // 2026-10-02:正文落 `~/.dsh/workbench/技能/`,AGENTS.md 里只留索引(卡「为什么要跑这么多步」)。
      bodyFile: prepared.bodyFile,
    })
    if (!result.ok) return { ok: false, error: result.error }


    // 「真改了没有」与「该有哪几段」是两回事:幂等地重跑一次,written 照样是满的,
    // 但这次一个字节都没写。两种情况说同一句话,那句话就等于没说(D13)。
    const parts: string[] = []
    if (result.changed && result.written.length > 0) parts.push(`事务官技能已接上 ${result.written.length} 段`)
    if (result.removed.length > 0) parts.push(`摘掉了 ${result.removed.length} 段不属于这个模板的`)
    if (result.missing.length > 0) parts.push(`仓库里读不到的 ${result.missing.length} 段没写:${result.missing.join('、')}`)
    return {
      ok: true,
      changed: result.changed,
      written: result.written,
      removed: result.removed,
      missing: result.missing,
      ...(result.backup_path === undefined ? {} : { backup_path: result.backup_path }),
      note: parts.length === 0
        ? `事务官技能本来就是对的(${result.written.length} 段都在),这次一个字没改。`
        : parts.join(';'),
    }
  }

  /**
   * 「允许手机在局域网访问」的内存态(2026-09-11)。真相在 app.json,这里是起服务时读进来、
   * /lan 路由改一次同步一次的副本——来源门每条请求都要看它,不能每次读盘。
   */
  let lanEnabled = false
  const isRemoteAllowed = options.isRemoteAllowed
    ?? ((req: IncomingMessage) => {
      const address = remoteAddress(req)
      // 开关开着:任何来源都能到门口,进不进得去看令牌(下面的鉴权那一段)。
      // 开关关着:只剩本机回环——2026-08-21 那条手机热点网段的老例外已于 2026-10-01 撤掉。
      return isLoopbackAddress(address) || lanEnabled || isAllowedRemoteAddress(address)
    })
  const lanAddress = lan?.lanAddress ?? defaultLanAddress
  /**
   * 按 Authorization: Bearer <token>(HTTP)或 ?token=(/live 的 WS 升级,浏览器的 WebSocket
   * 设不了请求头)认设备。回环来源根本不走这里——回环本身就是凭证。
   */
  async function deviceOf(req: IncomingMessage, allowQuery = false): Promise<DeviceView | undefined> {
    if (pairing === undefined) return undefined
    const header = req.headers.authorization
    let token: string | undefined
    if (typeof header === 'string' && header.startsWith('Bearer ')) token = header.slice('Bearer '.length).trim()
    if (token === undefined && allowQuery) {
      const query = (req.url ?? '').split('?')[1]
      if (query !== undefined) token = new URLSearchParams(query).get('token') ?? undefined
    }
    if (token === undefined || token === '') return undefined
    return pairing.authenticate(token)
  }
  /**
   * 「这台设备是从账号里被移除的那一台吗」(2026-10-03,卡 claude/device-revoke-complete)。
   *
   * 只影响**那句 401 说什么**,不影响放不放行(放不放行上面那两道门已经判完了)。
   * 手机把服务端这句话原样显示给人看:说成「没配对过,先去配对」会让她以为是哪里坏了,
   * 而真相是「这台已经被移出账号,要重新配对」—— 那句话自带下一步。
   * 问不出来就缺席,照旧说老那句话;**不编别的原因**。
   */
  async function leftAccount(input: { id?: string, token?: string }): Promise<boolean> {
    if (pairing?.revokedReasonOf === undefined) return false
    try { return (await pairing.revokedReasonOf(input)) === 'account' }
    catch { return false }
  }
  /**
   * 壳内页面身份校验第二道(矩形投毒案二审,2026-08-26):壳的 WKWebView 通过
   * applicationNameForUserAgent 在 UA 末尾带 `BenWorkbenchShell/1` 标记,浏览器页面
   * 改不了自己的 UA——source:'app' 只是页面自称,得两道一起过。子串匹配而非全等:
   * UA 前半段是 WebKit 版本号,随系统升级变,壳只保证追加的标记不变。
   */
  const isShellUserAgent = (req: IncomingMessage): boolean => {
    const ua = req.headers['user-agent']
    return typeof ua === 'string' && ua.includes('BenWorkbenchShell/')
  }
  /**
   * 登录台(2026-09-17)。没注入就在这里造一个真的 —— 理由写在 StartWorkbenchServerOptions.setup
   * 那条注释里(它要服务的正是"什么都还没接线"的那台新机器)。
   *
   * **为什么非要 `setupEnv` 才造**:体检会真去跑 `mdfind` / `osascript` / `launchctl`、真去读
   * `$HOME/.dsh`。直接 `startWorkbenchServer(...)` 的那一大批既有用例没传 env,要是这里默认拿
   * `process.env` 兜底,跑一次测试就会在**这台真机**上起一堆子进程(`osascript` 那条还可能弹一个
   * 系统日历授权框)。所以:生产走 `startFromEnv`(它显式把 env 传下来),测试要么传一个指向
   * 临时 HOME 的 `setup`,要么整块不启用 —— 不启用时 `/setup/*` 一律 404、`setup_required` 缺席。
   *
   * 三个接缝先按今天的事实接:
   *   - 扫描根走 `DEFAULT_SCAN_ROOTS`(卡 C 的 `GET /config/paths` 合并后换成读配置);
   *   - 仓库根走 `WORKBENCH_BUTLER_CWD`(与事务官会话、引导同一个变量,不另造一个);
   *   - APK 的二维码地址只有在局域网开着、且真拿得到本机地址时才给 —— 手机连不上的地址
   *     不如不给(D13 同款:宁可缺席,不给一个假的)。
   */
  // 2026-09-17「每个区域单独解锁」:两者都**只认注入**,不在这里自己造 —— 理由见
  // StartWorkbenchServerOptions.clientScan 那条注释(五条 mdfind 不该挂在既有用例上)。
  const clientScan = options.clientScan
  const installedAgents = options.installedAgents
  const modelMode = options.modelMode
  const relayProviders = options.relayProviders
  const setupEnvSource = options.setupEnv
  const setupRepoRoot = setupEnvSource?.WORKBENCH_BUTLER_CWD
  const setupHome = setupEnvSource?.HOME ?? ''
  const setupPathTable = setupPaths({ home: setupHome, ...(setupRepoRoot === undefined || setupRepoRoot === '' ? {} : { repoRoot: setupRepoRoot }) })
  /**
   * Codex 放没放行工作台的钩子(2026-10-21):体检那一项问的就是它。带缓存 ——
   * 两份文件(钩子、Codex 设置)都没变就不再起 `codex app-server`;配置里没有工作台的钩子就一次都不起。
   */
  const codexHookTrust = setupEnvSource === undefined ? undefined : createCodexHookTrustProbe({
    readFile: nodeSetupIo().readFile,
    ask: async (method, params) => await askCodexAppServerOnce(method, params, { clientName: 'ben-dsh-workbench' }),
    hooksFile: setupPathTable.codexHooks,
    configFile: setupPathTable.codexConfig,
    cwd: setupHome,
    now: () => Date.now(),
  })
  const setup: SetupService | undefined = options.setup ?? (setupEnvSource === undefined ? undefined : createSetupService({
    io: nodeSetupIo(),
    paths: setupPathTable,
    ...(codexHookTrust === undefined ? {} : { codexHookTrust: codexHookTrust.check }),
    pluginVersion: PLUGIN_VERSION,
    ...(helper === undefined ? {} : { helper: () => helper.view() }),
    scanRoots: async () => DEFAULT_SCAN_ROOTS(setupHome).map(root => root.path),
    ...(setupRepoRoot === undefined || setupRepoRoot === '' ? {} : { repoRoot: setupRepoRoot }),
    // 落脚目录跟别处同一条优先级:环境变量 > app.json(2026-09-18 起 dsh-start 不再写死它,
    // 所以装出来的机器上**只有** app.json 这一条路)。现问,不缓存 —— 设置里改得动。
    butlerCwd: async () => {
      if (setupRepoRoot !== undefined && setupRepoRoot !== '') return setupRepoRoot
      const configured = (await pathsOption?.config.get())?.butler_cwd
      return configured === '' ? undefined : configured
    },
    // 技能那一项要知道现在是哪个模板(该有哪几段)。没接模板服务就按"没选过"办,同 /config/ops-skills。
    templateId: () => template?.currentId(),
    now: () => Date.now(),
    newId: () => randomUUID(),
    apkUrl: () => {
      const view = lanView()
      if (!view.enabled || view.host === undefined) return undefined
      return `http://${view.host}:${view.port}/setup/apk`
    },
    /**
     * 二维码优先给阿里云上那份(2026-09-18)。Ben 真机反馈:「扫码下载是失效的,IP 是局域网。」
     * 局域网那条从此只是兜底。**这里读的是热更新那份清单**(同一份真相,不另开一条取包的路);
     * 没接热更新(既有那一大批用例)就当云上没有,行为与今天一模一样。
     *
     * `update` 在下面才声明 —— 这是个闭包,真调用时它早就有值了。
     */
    cloudApk: async () => await update?.ensureCloudApk(),
  }))
  /**
   * 运行环境漂移:发现 → 亮出来 → 补上(2026-09-26,卡 U6;来龙去脉在 setup/runtimeRepair.ts)。
   *
   * 跟登录台同一份 io 与同一套路径,装东西用的就是登录台那三步(`profile` / `runtime` / `restart`)
   * —— 它不联网、不碰清单,所以一台断网的机器也补得上(那天统筹手工敲的正是这三条)。
   * 没接登录台(既有那一大批用例)就整块不存在:`/state.update.runtime_stale` 缺席、
   * `/update/runtime` 404。
   */
  const runtimeRepair: RuntimeRepairService | undefined = options.runtimeRepair
    ?? (setup === undefined || setupEnvSource === undefined ? undefined : createRuntimeRepair({
      io: nodeSetupIo(),
      paths: setupPaths({ home: setupHome, ...(setupRepoRoot === undefined || setupRepoRoot === '' ? {} : { repoRoot: setupRepoRoot }) }),
      now: () => Date.now(),
      newId: () => randomUUID(),
      install: step => setup.install(step),
      waitJob: id => setup.waitJob(id),
      /**
       * 弹一条系统通知。走的是壳那条 `notify`(与「她有话问你」同一条路),
       * **交不到壳手上就当没弹** —— 老壳不认这个 op、壳没开着都不算故障。
       */
      notify: notice => void helper?.request({ op: 'notify', ...notice }, 5000).catch(() => {}),
      /**
       * **只有生产那一份实例许自己动手**(2026-09-26,卡 U6)。
       *
       * 补的最后一步是 `launchctl kickstart gui/<uid>/<固定 label>` —— 那个 label
       * 不跟 HOME 走。灰度按纪律跑在 scratch HOME 上(决策记录 09-26「灰度里任何 dsh 命令
       * 都要带 WORKBENCH_PORT」那一节旁边的同一条纪律),它要是自动补起来,
       * 会把**生产那个 DSH** 重启掉。所以判据就是"HOME 是不是真的家目录"。
       * 不自动补时那一格照样亮、按钮照样能按(他按就是他的决定)。
       */
      autoRepair: setupHome !== '' && setupHome === osHomedir(),
    }))
  /**
   * 热更新(2026-09-18)。跟登录台同一份 io 与同一套路径 —— 它装东西走的就是 `setup/install.ts`
   * 那十一步里的六步(见 server/update/apply.ts),路径算错一处两边一起错,共用比各算一份安全。
   *
   * 清单地址可以用 `WORKBENCH_UPDATE_URL` 或 endpoints.json 的 `update_manifest_url` 覆盖:真机走
   * https://api.aibooo.cn/updates/latest.json,而验收要在临时 HOME 里对着一个本地 http 假服务器真走一遍
   * (manifest.ts 只在回环上放行 http)。写 "off" 就不建这个服务:不查更新(endpoints.ts)。
   */
  const updateManifestUrl = setupEnvSource === undefined ? undefined : loadEndpoints(setupHome, setupEnvSource).update_manifest_url
  const update: UpdateService | undefined = options.update ?? (setupEnvSource === undefined || updateManifestUrl === undefined ? undefined : createUpdateService({
    io: nodeSetupIo(),
    paths: setupPaths({ home: setupHome, ...(setupRepoRoot === undefined || setupRepoRoot === '' ? {} : { repoRoot: setupRepoRoot }) }),
    now: () => Date.now(),
    newId: () => randomUUID(),
    currentVersion: PLUGIN_VERSION,
    manifestUrl: updateManifestUrl,
    // 收稳定版还是热修(2026-10-21):落在 app.json 的 `update_channel`,设置 → 更新里切。
    channel: appJsonChannelStore(setupPaths({ home: setupHome }).appJson),
    /**
     * 更新失败自动报一条(2026-09-22,四类里的 `update_failed`)。
     * `diag` 在下面才声明 —— 这是个闭包,真调用时它早就有值了(同 `cloudApk` 那一处)。
     */
    onFailed: job => void diag?.report({
      component: 'plugin',
      kind: 'update_failed',
      message: `更新到 ${job.version ?? '?'} 失败:${job.error}`,
      log: job.tail,
    }),
    /**
     * 重启那一下的保险(2026-10-13,0.4.115「装完没自己起来」)。
     *
     * 装完发出 `launchctl kickstart -k` 之后 20 秒这个进程还活着 = 那一下没生效,
     * 这时候自己以**非 0** 退出,让 plist 的 `KeepAlive.SuccessfulExit=false` 把它拉起来。
     * 判据同 `autoRepair`:**只有真家目录那一份实例**许这么干 —— 灰度跑在 scratch HOME 上、
     * 不由 launchd 管,它退出去没有谁会拉。
     */
    ...(setupHome !== '' && setupHome === osHomedir() ? { hardRestart: () => { process.exit(1) } } : {}),
    /**
     * 「有更新」不只看插件版本号(2026-09-26,卡 U6)。这两条都**只是读** ——
     * 判据在 `setup/dshRuntimeLock.ts` 的 `readRuntimeDrift`,由上面那个服务节流地探,
     * 体检那一项读的是同一个函数。三处读一份,才不会再出现"体检说要装、检查更新说没有"。
     */
    ...(runtimeRepair === undefined ? {} : {
      runtimeDrift: async () => await runtimeRepair.refresh(),
      runtimeStale: () => runtimeRepair.view(),
    }),
  }))

  /**
   * 诊断包与自动上报(2026-09-22)。跟登录台、热更新同一份 io 与同一套路径 ——
   * 它要收的日志路径正是 `setupPaths` 算出来的那几条,各算一份迟早会漂。
   *
   * **`link` 读的是 model.json 里那把设备令牌**(与 channelCredentials.ts 同一条路),
   * 没登录就回 undefined:那会儿不发、不排队、不落盘(理由写在 diagnostics/report.ts)。
   *
   * 时区偏移在这里取一次而不是每次现算:它是"这台机器的天从几点开始"这件事,
   * 一天之内不会变;传进去之后 rotate / 包名两处用的是同一个数。
   */
  const diag: DiagService | undefined = options.diag ?? (setupEnvSource === undefined ? undefined : createDiagService({
    io: nodeDiagIo(nodeSetupIo()),
    paths: setupPaths({ home: setupHome, ...(setupRepoRoot === undefined || setupRepoRoot === '' ? {} : { repoRoot: setupRepoRoot }) }),
    now: () => Date.now(),
    tzOffsetMinutes: -new Date().getTimezoneOffset(),
    pluginVersion: PLUGIN_VERSION,
    // 导出这份包的那个进程:rss / heap / 堆上限 / 起了多久 / 事件循环 p99(2026-10-19)。
    ...(processHealth === undefined ? {} : { process: () => processHealth.view() }),
    link: async () => {
      const config = await loadModelConfig(`${setupHome}/.dsh/workbench/model.json`)
      return config.relay_token === undefined ? undefined : { relayUrl: config.relay_url, token: config.relay_token }
    },
    /**
     * 快照。**每一样都是现问现取**,取不到就整格缺席 —— 诊断包里宁可少一格,
     * 也不要一格编出来的 JSON(D13)。
     */
    snapshots: [
      { name: 'state.json', title: '/state 此刻的快照(含 dock.recent_switches)', load: async () => await composeState() },
      { name: 'setup-status.json', title: '体检与修复的逐项结果', load: async () => await setup?.status() },
      { name: 'channel-status.json', title: '通话通道:连上没有、工人在不在', load: async () => await channel?.status() },
      { name: 'channel-worker.json', title: '通话工人进程:重启过几次、日志在哪', load: async () => channelWorker?.view() },
      /*
       * ★ **登记表整份 + 判过的每个 App**(2026-10-01)。里面带着每家最后一次看窗口时那扇窗的
       * **结构摘要**(`ax`:各角色各几个、窗口多大、藏没藏、敲没敲过门)——**只有数,一个字的内容都没有**。
       * Air 上「认出是 AI 应用、却读不到它的窗口」的那几家(新版 Kimi、可灵、App Store 版豆包),
       * 以前只能上真机现取一份 AX 结构才说得清;现在诊断包里就有。
       *
       * ★ **2026-10-02 再加一份明细**(`ax_detail`,卡「适配自绘界面的 Kimi」):只带数的那一份
       * 认得出「它是自绘界面」,还是写不出「输入框是哪一个节点、怎么往里写」。明细一个元素一行 ——
       * 角色、子角色、在树上第几层、位置大小、按得下去哪些动作、哪几条属性写得进去,
       * 以及标题 / 说明 / 帮助 / 值各**几个字**。**文字一个都没有,只有字数。**
       * 只对「输入框没认出来」的那几家收(`agentJudge.wantsAxDetail`)。
       */
      { name: 'agents.json', title: 'Agent 登记表:接上了哪几家、判过哪些 App、那扇窗的结构摘要与树的明细(只有数与字数,没有内容)', load: async () => agents?.detail() },
      { name: 'call-log.json', title: '最近的来电记录', load: async () => callOut?.view() },
      { name: 'update.json', title: '热更新:装着的是哪一版', load: async () => await update?.check() },
    ],
    log: line => console.log(line),
  }))

  /**
   * 「反馈给开发者」(2026-09-28,卡 FB)。与 `diag` 同一把设备令牌、同一条中转路 ——
   * 它就是自动上报的第五类(`kind: 'feedback'`),只是内容是**人说的**而不是机器崩的。
   *
   * `context` 取当时的模板与摆着的那几格:统筹拉到一条「发布计划没标今天」时,
   * 得知道她那台机器上用的是哪套模板、那一格在不在(两套模板的标题不一样)。
   * **取不到就整格缺席**,不编一个(D13)。
   */
  const feedback: FeedbackService | undefined = options.feedback ?? (setupEnvSource === undefined ? undefined : createFeedbackService({
    file: defaultFeedbackFile(setupHome),
    version: PLUGIN_VERSION,
    now: () => Date.now(),
    link: async () => {
      const config = await loadModelConfig(`${setupHome}/.dsh/workbench/model.json`)
      return config.relay_token === undefined ? undefined : { relayUrl: config.relay_url, token: config.relay_token }
    },
    context: async () => {
      const view = template?.view()
      const layout = await projects?.getLayout().catch(() => undefined)
      const shown = (layout?.modules ?? [])
        .filter(one => one.hidden !== true)
        .map(one => templateModuleTitle(template?.current(), one.id))
      const parts: string[] = []
      if (view !== undefined) parts.push(`模板:${view.name}`)
      if (shown.length > 0) parts.push(`摆着的:${shown.join('、')}`)
      return parts.length === 0 ? undefined : parts.join(';')
    },
    log: line => console.log(line),
  }))

  /**
   * 这台机器上有没有源码仓库(2026-10-01 重做时补的那道门,理由见
   * `StartWorkbenchServerOptions.sourceRepo`)。**现探一次就记住** ——
   * 一台机器上有没有仓库不会在一次运行里变,而 `/butler/item` 每收一句话都要问它。
   */
  const sourceRepoProbe = (() => {
    let once: Promise<boolean> | undefined
    return async (): Promise<boolean> => {
      once ??= (async () => {
        const butlerCwd = pathsOption?.envButlerCwd ?? setupRepoRoot
        const repo = await wbHooksResolveRepoRoot({
          moduleDir: pathsModuleDir,
          ...(butlerCwd === undefined || butlerCwd === '' ? {} : { butlerCwd }),
          exists: pathsFileExists,
        }).catch(() => undefined)
        return repo !== undefined
      })()
      return await once
    }
  })()
  const hasSourceRepo = options.sourceRepo ?? sourceRepoProbe

  /**
   * ★ **实验开关此刻各开没开**(2026-10-21,卡「引导三件事」;四样与默认在 `src/mainPaths.ts`)。
   * 存了的照 app.json,没存的按内外默认(环境变量 `WORKBENCH_AUDIENCE` > app.json 的 `audience` > 有源码仓库算内部)。
   * 没接 app.json 的工作台(老宿主、多数用例)= 不设闸,四样都当开着 —— 与加开关之前一字不差。
   */
  async function experimentsNow(): Promise<ExperimentsView | undefined> {
    if (appConfig === undefined) return undefined
    const config = await appConfig.get().catch(() => undefined)
    const audience = audienceOf({
      ...(process.env.WORKBENCH_AUDIENCE === undefined ? {} : { env: process.env.WORKBENCH_AUDIENCE }),
      ...(config?.audience === undefined ? {} : { saved: config.audience }),
      sourceRepo: await hasSourceRepo().catch(() => false),
    })
    return { audience, on: experimentsOf(config?.experiments, audience) }
  }
  /** 这一样关着吗(没接开关 = 不关)。 */
  async function experimentOff(key: ExperimentKey): Promise<boolean> {
    const view = await experimentsNow()
    return view !== undefined && !view.on[key]
  }

  /** 配过手机没(座机听筒不算:第三件说的是手机拨一通)。 */
  async function phonePairedNow(): Promise<boolean> {
    const list = await pairing?.list().catch(() => []) ?? []
    return list.some(one => one.kind !== 'handset')
  }

  /**
   * 三件主路「还没试就看得出来的门」要的那几样(2026-10-21):模型接没接、Claude / Codex 装没装登没登、
   * 通话工人在不在、语音后端在不在。**查不出来的一律当不知道**(不许说成缺)。
   */
  async function firstUseReadiness(): Promise<Readiness> {
    // 只看配置(`ready()`):`status()` 还要去中转查一趟用量,挂在每秒一拍的 `/state` 上就是隔几秒等一次中转。
    const modelReady = model === undefined ? true : await (model.ready?.() ?? model.status().then(view => view.ready)).catch(() => true)
    const caps = agentCaps?.view()
    const coders = caps === undefined
      ? undefined
      : PROTOCOL_FAMILIES.flatMap((family) => {
          const one = caps.agents.find(agent => agent.family === family)
          if (one === undefined) return []
          const edit = one.cells.edit
          const chatOk = one.cells.chat.state === 'ok'
          const loginFix = edit.fix?.kind === 'login_cli'
          const login: 'yes' | 'no' | 'unknown' = edit.state === 'ok' || chatOk ? 'yes' : edit.state === 'no' && loginFix ? 'no' : 'unknown'
          const installed = one.installed === true || edit.state !== 'no' || loginFix || chatOk
          return [{ family, title: one.title, installed, login }]
        })
    const worker = channelWorker === undefined ? 'unknown' as const : channelWorker.view().running ? 'up' as const : 'down' as const
    const voice = butler === undefined ? undefined : await butler.view().then(view => view.running, () => undefined)
    return { model: modelReady, ...(coders === undefined ? {} : { coders }), worker, ...(voice === undefined ? {} : { voice }) }
  }

  /** 从现成记录里看三件成没成要的那几样(`firstUse.observe`)。 */
  async function firstUseObserveInput(): Promise<ObserveInput> {
    const run = routines?.view().last.morning
    const podcast = run === undefined || feed === undefined ? undefined : feed.view(run.date).podcast
    return {
      ...(run === undefined ? {} : { morning: run }),
      ...(podcast === undefined ? {} : { podcast: { date: podcast.date, file: podcast.file !== undefined, ...(podcast.error === undefined ? {} : { error: podcast.error }) } }),
      podcastWanted: feed?.config().podcast ?? false,
      tasks: (await tasks?.list().catch(() => undefined))?.tasks ?? [],
    }
  }

  /** 看一眼、记新出现的那几笔;有新记的回 true。 */
  async function observeFirstUse(): Promise<boolean> {
    if (options.firstUse === undefined) return false
    return await options.firstUse.observe(await firstUseObserveInput()).catch(() => false)
  }

  async function firstUseViewNow(): Promise<FirstUseView | undefined> {
    if (options.firstUse === undefined) return undefined
    await options.firstUse.ready()
    return options.firstUse.view({ readiness: await firstUseReadiness(), phonePaired: await phonePairedNow() })
  }

  /** /state 那两格(取不到的整格缺席)。 */
  async function firstUseStateNow(): Promise<{ first_use?: FirstUseView, experiments?: ExperimentsView }> {
    const [view, experiments] = await Promise.all([firstUseViewNow().catch(() => undefined), experimentsNow().catch(() => undefined)])
    return { ...(view === undefined ? {} : { first_use: view }), ...(experiments === undefined ? {} : { experiments }) }
  }

  /**
   * 「试一下」那一件:交代(2026-10-21)。挑一家协议路上接得上的(Claude / Codex,已登录优先),
   * 建一张卡、派过去 —— 走的是 `/butler/item` 点了名那一支同一个 `dispatchItem`,不另开一条派活的路。
   * 一家都接不上就如实回缺哪道门,一张卡都不建。
   */
  async function firstUseDelegate(text: string): Promise<
    | { ok: true, id: string, family: string, title: string, note?: string }
    | { ok: false, door: 'ai_missing' | 'ai_login' | 'other', note?: string, families?: readonly { family: string, title: string }[] }
  > {
    const readiness = await firstUseReadiness()
    const coders = readiness.coders
    const usable = coders === undefined
      ? PROTOCOL_FAMILIES.map(family => ({ family, title: DISPATCH_FAMILY_TITLES[family] ?? family, login: 'unknown' as const }))
      : coders.filter(one => one.installed && one.login !== 'no')
    if (usable.length === 0) {
      const installed = (coders ?? []).filter(one => one.installed)
      return installed.length === 0
        ? { ok: false, door: 'ai_missing' }
        : { ok: false, door: 'ai_login', families: installed.map(one => ({ family: one.family, title: one.title })) }
    }
    const pick = usable.find(one => one.login === 'yes') ?? usable[0]
    if (pick === undefined || dispatchRunner === undefined) return { ok: false, door: 'other', note: '这台工作台没接派活,派不出去' }
    const made = await createButlerItem(text, pick.family, undefined, { skipSession: true })
    if (!made.ok) return { ok: false, door: 'other', note: made.error }
    const started = await dispatchItem(made.id, { family: pick.family, text, source: 'item', kind: 'chat' })
    broadcast({ kind: 'snapshot', state: await composeState() })
    return started.ok
      ? { ok: true, id: made.id, family: pick.family, title: pick.title, ...(started.note === undefined ? {} : { note: started.note }) }
      : { ok: false, door: 'other', ...(started.note === undefined ? {} : { note: started.note }) }
  }

  /**
   * 自检那三样(2026-10-21,安装器末尾那一遍;用例可以逐样替换)。
   *   · 早报:跑一遍开工汇报(先搜一轮资讯、写稿、合成播客),看出没出、播客有没有声;
   *   · 交代:派一件一句话的活(读本机项目列表写一段话)给协议路那一家,卡交回由 `observe` 改成「成」;
   *   · 电话:把通话工人拉起来、等它进房间,核语音后端;手机没配对就说缺这道门。
   *     **不真拨一通**:能不出声地拨一通的「文字回合测试口」安装包里是关着的(那是一道安全设计,不在这张卡里开)。
   */
  const selfCheckPorts: SelfCheckPorts = {
    readiness: options.firstUsePorts?.readiness ?? (async () => ({ ...(await firstUseReadiness()), phonePaired: await phonePairedNow() })),
    morning: options.firstUsePorts?.morning ?? (async () => {
      const readiness = await firstUseReadiness()
      if (!readiness.model) return { ok: false, door: 'model' }
      if (routines === undefined) return { ok: false, door: 'service', note: '这台工作台没接例程' }
      const ran = await routines.run('morning', 'manual')
      if (!ran.ok) return { ok: false, door: 'other', note: ran.reason }
      const run = ran.run
      if (run.status === 'failed') return { ok: false, door: 'other', startedAt: run.started_at, ...(run.note === undefined ? {} : { note: run.note }) }
      const podcast = feed?.view(run.date).podcast
      const wanted = feed?.config().podcast ?? false
      if (!wanted || podcast?.file !== undefined) return { ok: true, startedAt: run.started_at }
      const error = podcast?.error ?? '这一遍没出播客'
      return { ok: false, startedAt: run.started_at, door: podcastDoor(error), note: error }
    }),
    delegate: options.firstUsePorts?.delegate ?? (async () => {
      const sent = await firstUseDelegate(SELF_CHECK_DELEGATE_TEXT)
      return sent.ok
        ? { started: true, taskId: sent.id, family: sent.family, title: sent.title }
        : { started: false, door: sent.door, ...(sent.note === undefined ? {} : { note: sent.note }) }
    }),
    call: options.firstUsePorts?.call ?? (async () => {
      if (channelWorker === undefined || channel === undefined) return { ok: false, door: 'worker', note: '这台工作台没接通话' }
      if (!channelWorker.view().running) {
        const pulled = await channelWorker.start()
        if (!pulled.ok) return { ok: false, door: 'worker', note: pulled.error ?? pulled.note ?? '通话工人拉不起来' }
      }
      let inRoom = false
      for (let i = 0; i < SELF_CHECK_WORKER_WAIT_TRIES && !inRoom; i++) {
        const status = await channel.status().catch(() => undefined)
        if (status?.needs_login === true) return { ok: false, door: 'model', note: '通话要先登录工作台账号' }
        inRoom = status?.worker === true
        if (!inRoom) await new Promise(resolve => setTimeout(resolve, SELF_CHECK_WORKER_WAIT_MS))
      }
      if (!inRoom) return { ok: false, door: 'worker', note: '通话工人起来了,但没进房间' }
      if (butler !== undefined && !(await butler.view()).running) return { ok: false, door: 'voice', note: '语音后端没起来,电话里听不到声音' }
      if (!(await phonePairedNow())) return { ok: false, door: 'phone' }
      return { ok: true, note: '通话工人在房间里等着接' }
    }),
  }

  /**
   * ★ **电话那一件当场记**(2026-10-21):电话工人在通话里建成一张卡 / 捎出一句话(`/butler/item`、`/task/create`、
   * `/sessions/relay` 回了成)就记「成」。没配过手机的人(iPhone / 没手机),在电脑上对她说一句建成事项也算这一件。
   * 只读回包、不改那几条路的任何一个分支。
   */
  function watchCallPath(req: IncomingMessage, res: ServerResponse, path: string, end: BehaviorEnd | undefined, phonePaired: boolean): void {
    const firstUse = options.firstUse
    if (firstUse === undefined || req.method !== 'POST') return
    const viaCall = end === '电话' && (path === '/butler/item' || path === '/task/create' || path === '/sessions/relay')
    const viaDesk = end === '电脑' && !phonePaired && path === '/butler/item'
    if (!viaCall && !viaDesk) return
    const send = res.end.bind(res) as (...args: unknown[]) => ServerResponse
    res.end = ((...args: unknown[]) => {
      try {
        const chunk = args[0]
        const text = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : ''
        const body = res.statusCode === 200 && text !== '' ? JSON.parse(text) as { ok?: unknown, id?: unknown, experiment_off?: unknown } : undefined
        const made = body?.ok === true && body.experiment_off === undefined && (typeof body.id === 'string' || path === '/sessions/relay')
        if (made) {
          const at = new Date().toISOString()
          void firstUse.record({ key: `call:${typeof body.id === 'string' ? body.id : at}`, path: 'call', ok: true, at }, viaCall ? '电话' : '电脑').catch(() => false)
        }
      }
      catch { /* 回包读不懂就不记,不能连累那一条路 */ }
      return send(...args)
    }) as typeof res.end
  }

  /**
   * 事务官(或别的程序)做的写动作:前后各往 `/live` 广播一行字(2026-09-25 卡 P 补三),页面挂在真实的元素上画
   * (看板动作挂那张卡或项目区,文件动作挂文件区,窗口槽动作挂窗口槽)。**不打光、不让壳画任何东西**。
   * 他自己在页面上点的不出字。动作 → 哪一块那张表在 server/actorNotes.ts,这里只把动作名(和那张卡)交上去;
   * **出字永远不是动作的前置条件**。
   */
  const withActorNoteFor = <T>(req: IncomingMessage, action: string, run: () => Promise<T>, target?: { task_id?: string }): Promise<T> =>
    withActorNote({
      action,
      actor: actorOfRequest(req.headers),
      run,
      notify: note => broadcast({ kind: 'actor_note', note }),
      ...(target === undefined ? {} : { target }),
    })
  const clientKeys = options.clientKeys ?? createClientKeyLedger()
  /*
   * ★ 2026-10-29 删规矩第一批(入口归一):1a 的 say 账(sayLedger)、挂起确认账(sayPendingAsks)、
   * suggest / decided 账随旧路一并删除 —— 所有入口进理解中枢,挂着的问与答问全在 hubBook 这一本账
   * (A#19 / A#20 / A#21 / A#25 / A#26 的词表与快路径不再有任何调用方)。
   */
  /** 理解中枢(A1,2026-10-28)自己的 say 账与挂着的问:三入口同一本;跨请求,所以在 server 作用域。 */
  const hubBook = createSayBook()
  /**
   * ——— 通话里动过哪几张卡(2026-10-22,通电话是记录不是事项)———
   *
   * 通话记录上要挂「这一通里建过 / 挪过 / 补过话的事项」。判据只认**电话那一端**(`behaviorEnd === '电话'`:
   * 工人带着它那把令牌打来的,或者座机那台设备)在 `/task/create`、`/butler/item` 上建成的卡,
   * `/task/move` 挪的卡,`/butler/item/say` 补过话的卡;落记录时取「挂断前这一通时长 + 一分钟」以内的那几条。
   *
   * **为什么按时间窗、不按 call_id**:工人那几件工具不带 call_id(老工人、话筒那一路都没有),
   * 而电话一次只通一通 —— 窗口就是这一通。代价写清楚:通话中途她在电脑上点的不算(端不是电话);
   * 前后两通隔不到一分钟,后一通会把前一通挂断前那一分钟里的卡也挂上(两份记录都挂着,不丢)。
   * 只在内存里:插件重启后落的那份记录挂不上重启前的卡(卡本身一张没少)。
   */
  const CALL_ITEM_TRAIL_KEEP = 200
  const CALL_ITEM_TRAIL_MAX_AGE_MS = 3 * 3600_000
  const CALL_ITEM_SLACK_MS = 60_000
  const callItemTrail: { at: number, task_id: string, did: CallRecordItemDid, to?: TaskStatus }[] = []
  function noteCallItem(end: BehaviorEnd | undefined, taskId: string, did: CallRecordItemDid, to?: TaskStatus): void {
    if (end !== '电话' || taskId === '') return
    const at = Date.now()
    callItemTrail.push({ at, task_id: taskId, did, ...(to === undefined ? {} : { to }) })
    while (callItemTrail.length > CALL_ITEM_TRAIL_KEEP || (callItemTrail[0] !== undefined && at - callItemTrail[0].at > CALL_ITEM_TRAIL_MAX_AGE_MS)) callItemTrail.shift()
  }
  /** 建卡那两条路(`/task/create`、`/butler/item`)的回包里有 `{ ok:true, id }` 就记一笔「建了」。只读回包,不改那两条路。 */
  function watchCallItemCreated(res: ServerResponse, end: BehaviorEnd | undefined): void {
    if (end !== '电话') return
    const send = res.end.bind(res) as (...args: unknown[]) => ServerResponse
    res.end = ((...args: unknown[]) => {
      try {
        const chunk = args[0]
        const text = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : ''
        const body = res.statusCode === 200 && text !== '' ? JSON.parse(text) as { ok?: unknown, id?: unknown } : undefined
        if (body?.ok === true && typeof body.id === 'string') noteCallItem(end, body.id, 'created')
      }
      catch { /* 回包读不懂就不记,不能连累那一条路 */ }
      return send(...args)
    }) as typeof res.end
  }
  /** 某一刻以来电话那一端动过的卡;同一张同一种动作只留最后一次。 */
  function callItemsSince(fromMs: number): CallRecordItemLink[] {
    const out: CallRecordItemLink[] = []
    for (const one of callItemTrail) {
      if (one.at < fromMs) continue
      const at = out.findIndex(item => item.task_id === one.task_id && item.did === one.did)
      const link: CallRecordItemLink = { task_id: one.task_id, did: one.did, ...(one.to === undefined ? {} : { to: one.to }) }
      if (at === -1) out.push(link)
      else out[at] = link
    }
    return out
  }

  /**
   * 授权表的门(2026-09-15,docs/记忆/授权.md)。只拦**程序来源**:回环上没有 Origin、也不是壳的
   * UA 的请求——那是事务官(或 Ben 自己的 curl)在打写接口。页面与已配对的手机是 Ben 在点,不拦。
   * 表没接就不拦。拒绝时回 403 + 一句人话(怎么放开)。
   */
  async function agentWriteDenied(req: IncomingMessage, device: DeviceView | undefined): Promise<string | undefined> {
    if (authorization === undefined || device !== undefined) return undefined
    // 个人访问令牌(2026-10-21):设置页里他亲手发的那一枚,带着它的就是他本人(命令行 / 他的脚本)。
    if (personalRequests.has(req)) return undefined
    if (actorOfRequest(req.headers) === 'page') return undefined
    if (await authorization.isAllowed('write_api')) return undefined
    return authorization.denialMessage('write_api')
  }

  /**
   * 规矩表的写门(2026-09-24 晚,卡 K)。与 `/butler/memory/preference` 同一档 `write_docs`
   * (写的是她的人设,不是业务数据);页面与配对过的手机是他本人在点,不拦。
   */
  async function rulesWriteDenied(req: IncomingMessage, device: DeviceView | undefined): Promise<string | undefined> {
    if (authorization === undefined || device !== undefined) return undefined
    if (actorOfRequest(req.headers) === 'page') return undefined
    if (await authorization.isAllowed('write_docs')) return undefined
    return authorization.denialMessage('write_docs')
  }

  /** 这句话是从哪条路来的。明着传了就用它;没传按来源猜:手机 → 手机上打字,页面 → 电脑上打字,回环程序 → 电话工人。 */
  function ruleChannelOf(req: IncomingMessage, device: DeviceView | undefined, raw: unknown, fallback: ButlerRuleChannel = 'call'): ButlerRuleChannel {
    if ((BUTLER_RULE_CHANNELS as readonly unknown[]).includes(raw)) return raw as ButlerRuleChannel
    if (device !== undefined) return 'phone'
    if (actorOfRequest(req.headers) === 'page') return 'desk'
    return fallback
  }

  /** 一件活的原文(标题 + 描述),给「这件活沾哪几块」用。查不到回空串。 */
  async function ruleTaskText(itemId: string | undefined): Promise<string> {
    return dispatchRuleTaskText(tasks, itemId)
  }

  /** 一件活主要沾哪一块(界面 / 内容;都不沾就是全局)。反馈里的 `area` 用它,派活与通过两头才对得上。 */
  function ruleWorkArea(text: string): ButlerRuleArea {
    return workAreasOf(text)[0] ?? 'all'
  }

  /**
   * 自查要读的文件:**只读 cwd 底下的**(不许 `..`、不许绝对路径),每个最多 REVIEW_FILE_MAX_BYTES,最多 20 个;
   * cwd 本身要在授权的扫描根底下(与派活同一道门)。读不到的如实跳过,不编内容。
   */
  async function readRuleReviewFiles(cwd: string, files: unknown): Promise<{ files: { path: string, text: string }[], skipped: string[] }> {
    const out: { path: string, text: string }[] = []
    const skipped: string[] = []
    if (!Array.isArray(files) || cwd === '') return { files: out, skipped }
    const roots = (await dispatchRoots()).map(root => root.path)
    if (roots.length > 0 && !dispatchCwdAllowed(cwd, roots)) return { files: out, skipped: files.filter((one): one is string => typeof one === 'string') }
    for (const one of files.slice(0, 20)) {
      if (typeof one !== 'string' || one === '' || one.startsWith('/') || one.split('/').includes('..')) {
        if (typeof one === 'string') skipped.push(one)
        continue
      }
      try {
        const buffer = await readFile(join(cwd, one))
        out.push({ path: one, text: buffer.subarray(0, REVIEW_FILE_MAX_BYTES).toString('utf8') })
      }
      catch { skipped.push(one) }
    }
    return { files: out, skipped }
  }
  /**
   * 一组布局动作 → 落盘(2026-09-22「用自然语言改布局」)。
   *
   * 三步,顺序是**先存快照再改**:
   *   ① `template.snapshotLayout(reason)` 存一份整布局的可回退快照(复用切模板那个栈);
   *   ② `applyLayoutActs` 在内存里一次跑完;
   *   ③ `projects.setLayout` 落盘一次。
   *
   * **快照存不下不拦这次改动**,但回包里如实说一句"撤不回来"。这跟切模板那条
   * (存不下就整件作罢)不一样,故意的:切模板是把整个工作台换一套,回不去的代价是
   * 他排了半天的布局全没了;这里一次只改一格,回不去的代价是他自己再说一句反过来的话。
   * 为了一次存不下快照就拒绝"把随手记藏起来",他会觉得这功能坏了。
   *
   * 中途一个字节都不落盘:要么最后 setLayout 一次,要么什么都没发生。
   */
  async function applyLayoutActions(
    acts: readonly LayoutAct[], orientation: 'portrait' | 'landscape', reason: string,
  ): Promise<
    | { ok: true, applied: LayoutActApplied[], snapshotId?: string, note?: string }
    | { ok: false, status: number, error: string }
  > {
    if (projects === undefined) return { ok: false, status: 404, error: '项目区未启用' }
    const current = await projects.getLayout()
    if (current === undefined) return { ok: false, status: 409, error: '此刻读不到布局,没改。' }

    let snapshotId: string | undefined
    let note: string | undefined
    if (template === undefined) note = '这台机器没接布局快照,这次改完撤不回来。'
    else {
      const saved = await template.snapshotLayout(reason)
      if (saved.ok && saved.id !== undefined) snapshotId = saved.id
      else note = `没存下回退用的快照(${saved.reason ?? '原因不明'}),这次改完撤不回来。`
    }

    const result = applyLayoutActs(current, acts, orientation)
    if (!result.ok) return { ok: false, status: 400, error: result.error }
    await projects.setLayout(result.layout)
    return {
      ok: true,
      applied: result.applied,
      ...(snapshotId === undefined ? {} : { snapshotId }),
      ...(note === undefined ? {} : { note }),
    }
  }

  /**
   * 建一条「我交给事务官」的事项:先建卡,再在 DSH 里开一条会话把原话发出去(一事项一会话)。
   *
   * POST /butler/item(收件箱输入框 / 手机打字 / 通话里的 wb_dispatch_item)与旧 RTC 通话那件
   * wb_remember_item(rtcCall.ts)**共用这一段**。LiveKit 通话里的 wb_remember_item 从 2026-09-23 起
   * 只记不开会话,走的是 /task/create,不进这里。
   * 两条入口建出来的必须是同一种东西——不然「电话里说的」和「手机上打的」会长成两类卡,
   * 他在看板上看到的就不是一回事了。门(信任、授权)各自在调用处把,这里只管建。
   *
   * **开不出会话时事项照常建**并如实标「会话未开」:伪装成"事务官在办"是最坏的一种失真(D13)。
   */
  async function createButlerItem(text: string, assignee?: TaskAssignee, extras?: {
    /** 统一输入框(2026-09-24):交办时的档、模型、附件、引用。缺席 = 老入口(电话里的工具)。 */
    mode: ComposerMode
    model?: { provider: string, id: string }
    attachments: readonly ResolvedAttachment[]
    refs: readonly string[]
  }, opts?: {
    /**
     * 只建卡、**不开 DSH 会话**(2026-09-24,卡 F):他点了名的活由工作台直接派(`dispatchRun.ts`),
     * 再开一条会话去"按技能派"就是同一件事两条路在派。
     */
    skipSession?: boolean
    /**
     * 看板上已经有这件(2026-09-25,卡 N「一件事一份」,itemIdentity.sameItemFor 认出来的):**不再建一张**,
     * 他这一句记进那张卡的描述(带时刻),点了名就把负责人改成那一家,没点名又没负责人的交给事务官;其余照旧。
     */
    existingId?: string
    /**
     * ★ **这一句像在要一份文件**(2026-10-04,卡 `claude/phone-file-send-loop`;
     * 判据 `fileFetch.ts` 的 `fileWantHint`,宽的那一档)。带了它就两件事:
     *   ① 这张卡登记进交付回执台账(`fileDelivery.expect`)—— 没有回执不算办完;
     *   ② 第一条消息里写明「要把文件送到她手机上,只走 `POST /butler/send-file`」(`butlerBrief.ts`)。
     * 缺席 = 老行为,一个字不变。
     */
    fileWant?: { query?: string, deviceId: string, deviceName: string }
    /**
     * ★ **她在哪说的这一句**(2026-10-04,卡 `claude/answer-comes-to-her`):手机 / 电脑输入框 / 电话里。
     * 判出「问一句」时答案先往这儿送;缺席 = 认不出来(那时两端都摆、都推通知)。
     * 算它的是 `ruleChannelOf` 一处 —— 规矩表那一侧本来就用它,这里不另判一遍。
     */
    askedWhere?: ButlerRuleChannel
  }): Promise<
    | { ok: true, id: string, conversation?: ReturnType<typeof butlerConversation>, note?: string, assignee?: TaskAssignee }
    | { ok: false, error: string }
  > {
    if (tasks === undefined) return { ok: false, error: '任务看板未启用' }
    const fields = butlerItemFields(text)
    // 先建卡拿到 id:第一条消息里要带上事项 id(将来在会话里能回指到这张卡),
    // 而且**卡在先**——会话开不出来时至少他交代的这件事留下来了。
    //
    // 「让 Codex 做」那一句(2026-09-21):点了名就把 assignee 落在卡上。**只落负责人,
    // 这里不起任何子进程** —— 派活是事务官在它那条会话里按技能段做的事,由它自己报进度
    // (POST /butler/item/dispatch)。这一层要是也能 spawn,同一件事就有两条路能起进程了。
    let created: { ok: boolean, id?: string, reason?: string }
    if (opts?.existingId !== undefined) {
      const have = (await tasks.list()).tasks.find(one => one.id === opts.existingId)
      if (have === undefined) return { ok: false, error: '那张卡不在了' }
      const owner: TaskAssignee | undefined = assignee ?? (have.assignee === undefined ? 'dsh' : undefined)
      await tasks.update(have.id, { desc: appendSaid(have.desc, text, new Date()), ...(owner === undefined ? {} : { assignee: owner }) })
      created = { ok: true, id: have.id }
    }
    else {
      created = await tasks.create({
        title: fields.title,
        ...(fields.desc === undefined ? {} : { desc: fields.desc }),
        ...(assignee === undefined ? {} : { assignee }),
        // 管理(2026-10-27,协作区 §3.1):这张卡是事务官建的,派活与验收归它。
        manager: 'dsh',
        direction: 'mine',
        // 他亲口交代的(2026-09-25):固化提议只数这一种。
        origin: 'user',
        // 协作区(2026-10-21):便签从哪来 = 他说的这一句(原话留着,详情「前因后果」里点得开)。
        from: { kind: 'said', quote: text.trim().slice(0, 400) },
        status: 'todo',
      })
    }
    if (!created.ok || created.id === undefined) return { ok: false, error: created.reason ?? '建事项失败' }

    /**
     * ★ **她在哪问的,记一格**(2026-10-04,卡 `claude/answer-comes-to-her`)。
     * 收尾那一步判出「问一句」时 `deliverAnswer` 读它一次就删(「她在哪问就在哪答」)。
     */
    if (opts?.askedWhere !== undefined) askedWhere.set(created.id, opts.askedWhere)

    /**
     * 要文件那一类:**先登记回执,再交代活**(2026-10-04)。顺序是故意的 ——
     * 登记在前,会话开不出来、第一条消息没发成,这张卡照样被"没送到不算完"那条规矩兜着。
     */
    if (opts?.fileWant !== undefined) {
      fileDelivery.expect({
        itemId: created.id,
        request: text.trim(),
        ...(opts.fileWant.query === undefined ? {} : { query: opts.fileWant.query }),
        deviceId: opts.fileWant.deviceId,
        deviceName: opts.fileWant.deviceName,
      })
    }

    // 端口的实现方有"绝不抛"的责任,这里仍然兜一层:它是外部实现,兜底不能只写在注释里。
    /**
     * 统一输入框带来的那几样(2026-09-24)。图片**直接给事务官看**(维护者拍板推翻「存文件给路径」):
     * 这条会话用的模型能看图,就把图读成 base64 放进第一条消息;不能看的(比如 V4 Pro)照样给路径。
     * 路径无论如何都写在原话后面 —— 它要转交给 Claude / Codex 时,那边要的是文件。
     */
    let tail: string | undefined
    let openExtras: ButlerOpenExtras | undefined
    if (extras !== undefined) {
      const hasImages = extras.attachments.some(one => one.imageType !== undefined)
      let imagesInline = false
      if (hasImages && butlerSession?.catalog !== undefined) {
        try {
          const catalog = await butlerSession.catalog()
          const target = extras.model ?? (catalog === undefined ? undefined : { provider: catalog.default.provider, id: catalog.default.model })
          imagesInline = catalog !== undefined && modelTakesImages(composerModels(catalog), target)
        }
        catch { imagesInline = false }
      }
      const images: { mediaType: string, data: string, name: string }[] = []
      if (imagesInline && composer !== undefined) {
        for (const file of extras.attachments) {
          if (file.imageType === undefined) continue
          const data = await composer.readImage(file)
          if (data !== undefined) images.push({ mediaType: file.imageType, data, name: file.name })
        }
      }
      tail = composerTail({ mode: extras.mode, attachments: extras.attachments, imagesInline: images.length > 0, refs: extras.refs })
      openExtras = {
        mode: extras.mode,
        ...(extras.model === undefined ? {} : { model: extras.model }),
        ...(images.length === 0 ? {} : { images }),
      }
      await tasks.update(created.id, {
        mode: extras.mode,
        ...(extras.attachments.length === 0 ? {} : { attachments: extras.attachments.map(one => ({ name: one.name, image: one.imageType !== undefined })) }),
      })
    }

    if (opts?.skipSession === true) {
      return { ok: true, id: created.id, ...(assignee === undefined ? {} : { assignee }) }
    }

    let sessionId: string | undefined
    try {
      const facts = butlerFactsNow({
        itemId: created.id,
        title: fields.title,
        ...(assignee === undefined ? {} : { assignee }),
        ...(opts?.fileWant === undefined ? {} : { fileWant: { ...(opts.fileWant.query === undefined ? {} : { query: opts.fileWant.query }), device: opts.fileWant.deviceName } }),
      })
      const first = butlerFirstMessage(text, created.id, assignee, tail, facts)
      /**
       * 思考档(2026-09-28,卡 BS,设计 6.2):**她点了名 = 关**(照名单派,没什么要挑的);
       * 没点名 = low(要在几家里挑一家、写一句理由)。她点名与没点名的差别就在 `assignee`。
       */
      const effort = assignee === undefined ? effortFor('dispatchChoose') : effortFor('dispatchNamed')
      sessionId = await butlerSession?.open(first, { ...openExtras, effort })
    }
    catch {
      sessionId = undefined
    }

    if (sessionId !== undefined && sessionId !== '') {
      const conversation = butlerConversation(sessionId)
      // 会话真的开起来了 = 事务官已经在办。状态与 links 分开记:conversation 是"这条事项
      // 自己那段对话",links 是"实际上谁在干"——两者都指同一条会话,但回答的是两个问题。
      // 挂到已有的卡上时(卡 N)不冲掉它原来挂着的几条会话(派出去的活那几家),接在后面。
      const kept = opts?.existingId === undefined ? [] : ((await tasks.list()).tasks.find(one => one.id === created.id)?.links ?? [])
      await tasks.update(created.id, { conversation, links: [...kept, { agent: 'dsh', session_id: sessionId }] })
      await tasks.move(created.id, 'doing')
      return { ok: true, id: created.id, conversation, ...(assignee === undefined ? {} : { assignee }) }
    }

    // 卡上也记这一句(2026-09-16):没有它,界面分不清"会话开启中"与"开不出来",会给它画一条等着会话的虚线。
    await tasks.update(created.id, { note: BUTLER_NO_SESSION_NOTE })
    return { ok: true, id: created.id, note: BUTLER_NO_SESSION_NOTE, ...(assignee === undefined ? {} : { assignee }) }
  }

  /**
   * **回执落到卡上**(2026-10-04,卡 `claude/phone-file-send-loop`)。
   *
   * 到了:卡上写「「X」已经到你手机上了(大小)」,停在「阻塞 · 等你点那张卡」上的那张挪进「完成」——
   * 她要的就是这个文件,拿到了就没什么要她验收的。
   * 没成:卡上那句原因换成实话(**只在它已经停下来等的时候**;还在办的让它接着办,别抢它的卡面)。
   *
   * 还在 `doing` 的不动状态:会话可能还在办别的,收尾那一刻 `butlerLifecycle` 会再问一次台账。
   * **绝不抛**:回执这一下失败不该把下载那条流打断。
   */
  async function settleDeliveredItem(itemId: string, delivered?: { name: string, bytes: number }): Promise<void> {
    if (tasks === undefined) return
    try {
      const task = (await tasks.list()).tasks.find(one => one.id === itemId)
      if (task === undefined) return
      /**
       * ★ **电话里那条没有收尾那一刻**(2026-10-04,卡 `claude/three-small-1004`):
       * 手机打字要文件那条有一条事务官会话,会话结束时 `butlerLifecycle` 会再问台账一次;
       * 电话里那条只有一张"还没到"的牌子(`pushed`),回执这一下**就是**它的收尾 ——
       * 所以这一类的卡从「进行中」也要挪:到了进「完成」,没成进「阻塞」。
       */
      const pushed = fileDelivery.need(itemId)?.pushed === true
      if (delivered === undefined) {
        if (task.status !== 'blocked' && !(pushed && task.status === 'doing')) return
        const still = fileDelivery.pending(itemId)
        if (still === undefined) return
        await tasks.update(itemId, { note: notDeliveredNote(still.what, still.why), blockReason: still.waitingTap ? 'input' : 'error' })
        if (task.status === 'doing') await tasks.move(itemId, 'blocked')
      }
      else {
        await tasks.update(itemId, { note: deliveredNote(delivered.name, delivered.bytes) })
        if (task.status === 'blocked' || task.status === 'confirm' || (pushed && task.status === 'doing')) {
          const moved = await tasks.move(itemId, 'done')
          // 转换表不许直达就先过「进行中」(同 `butlerLifecycle` 那一处的做法)。
          if (!moved.ok) {
            const via = await tasks.move(itemId, 'doing')
            if (via.ok) await tasks.move(itemId, 'done')
          }
        }
      }
      broadcast({ kind: 'snapshot', state: await composeState() })
    }
    catch { /* 回执记不上不该把传输打断 */ }
  }

  /**
   * 负责人是事务官的那张卡,他点头了(或自动办):给**这张已有的卡**开她那条会话(2026-09-25,卡 N)。
   * 与 createButlerItem 的后半段同一套(第一条消息、挂会话、挪进行中、开不成如实写「会话未开」),只是不建卡。
   */
  async function startButlerOnItem(taskId: string, text: string): Promise<{ ok: boolean, note?: string }> {
    if (tasks === undefined) return { ok: false, note: '任务看板未启用' }
    const have = (await tasks.list()).tasks.find(one => one.id === taskId)
    if (have === undefined) return { ok: false, note: '没有这张卡' }
    let sessionId: string | undefined
    // 她点头把这张卡交给事务官 = 它要写交代、跟进(设计 6.2 的 low 那一档)。
    // 2026-10-02:这条路也摆事实(与 `createButlerItem` 同一份,卡「为什么要跑这么多步」)。
    const facts = butlerFactsNow({ itemId: taskId, title: have.title })
    try { sessionId = await butlerSession?.open(butlerFirstMessage(text, taskId, 'dsh', undefined, facts), { effort: effortFor('brief') }) }
    catch { sessionId = undefined }
    if (sessionId === undefined || sessionId === '') {
      await tasks.update(taskId, { note: BUTLER_NO_SESSION_NOTE })
      return { ok: false, note: BUTLER_NO_SESSION_NOTE }
    }
    const conversation = butlerConversation(sessionId)
    await tasks.update(taskId, { conversation, links: [...(have.links ?? []), { agent: 'dsh', session_id: sessionId }], note: null })
    await tasks.move(taskId, 'doing')
    broadcast({ kind: 'snapshot', state: await composeState() })
    return { ok: true, note: '交给事务官了,她在办' }
  }

  /**
   * 修复交回守门(2026-10-23,卡「分层自愈完善」):挂在既有 tick 上,没有待核的派活就一次 I/O 都不做。
   * 那一家交回来(窗口手回了话 / 命令行手结束)→ 对照派活那一刻的快照核本体目录:被改过就拒装 —
   * 维修窗口内用户层变过的一切**原样保留**(分不清是那家还是她自己改的;卡的原文:无法安全归因则
   * 保留现状、明确阻塞),变过的小组件按指纹组合「先不装」;卡上说一句,记录与派活前的备份
   * (唯一证据)长留在 用户层/.修复/<itemId>/。本体一份文件都不由这里回写。
   *
   * 覆盖范围(明确受限,独立审 Minor 2):只有 `/user-layer/fix` 这条路派的活带守门 —— 它也是唯一
   * 把 cwd 钉在用户层目录的路。卡面手动重派/负责人驱动重派走派活那条线(主人是派活接缝),那边的
   * cwd 不由本卡定,等那条线把 cwd 钉过来,这里照 `pendingFixGuards` 同一套核。
   */
  let fixGuardsBusy = false
  const pumpFixGuards = async (): Promise<void> => {
    if (userLayer === undefined || tasks === undefined || fixGuardsBusy) return
    const pending = await userLayer.pendingFixGuards()
    if (pending.length === 0) return
    fixGuardsBusy = true
    try {
      const { tasks: cards } = await tasks.list()
      for (const itemId of pending) {
        const card = cards.find(one => one.id === itemId)
        if (card === undefined) continue
        const replyState = card.client_dispatch?.reply_state
        const completedAt = card.client_dispatch?.reply_at ?? card.dispatch?.ended_at
        // 还没交回(在跑 / 在等回话)就不核;窗口手的别的态(在送)也一样等下一拍。
        if (completedAt === undefined) continue
        if (replyState !== undefined && replyState !== 'done' && replyState !== 'unreadable') continue
        const outcome = await userLayer.finishFixGuard(itemId, completedAt)
        if (outcome.kind !== 'out-of-bounds') continue
        const lines = [`这次改用户层动了工作台本体,先不装:维修窗口内变过的 ${outcome.blocked.length} 份分不清是谁改的,都保留原样`]
        if (outcome.held_back.length > 0) lines.push(`那一格(${outcome.held_back.join('、')})先不端,改一个码就回来`)
        lines.push(`证据与派活前的备份在 用户层/.修复/${itemId}/`)
        await tasks.update(itemId, { note: lines.join(';') })
        broadcast({ kind: 'snapshot', state: await composeState() })
      }
    }
    catch { /* 守门自己坏了不能连累这根节拍;下一次 tick 再核 */ }
    finally { fixGuardsBusy = false }
  }

  /**
   * 负责人驱动(2026-09-25,卡 N;理由在 `server/itemDriver.ts` 文件头)。只在 index.ts 给了记账文件时起
   * (既有那一大批用例不起 —— 它们的看板上有写着 codex 的卡,驱动会真去问 / 真去派)。
   */
  const itemsOption = options.items
  if (tasks !== undefined && itemsOption?.driveFile !== undefined) {
    const board = tasks
    itemDriver = createItemDriver({
      tasks: { list: () => board.list(), update: (id, input) => board.update(id, input) },
      now: () => new Date(),
      file: itemsOption.driveFile,
      mode: async () => (await composer?.choice().catch(() => undefined))?.mode ?? DEFAULT_COMPOSER_MODE,
      ...(approvals === undefined ? {} : { approvals }),
      ...(dispatchRunner === undefined ? {} : {
        dispatch: async (taskId: string, input: { family: AgentDispatchFamily, text: string, kind?: string }) => {
          // 这是什么活(合并卡 W 接卡 O 的那一根):驱动给了就照它,没给用卡 O 那条按字认的规矩(纯函数,不多一次 I/O)。
          // 认出写代码的活,派活才走「能改本机文件」的那只手、开独立工作区。
          const kind = isJobKind(input.kind) ? input.kind : jobKindOf(input.text).kind
          const started = await dispatchItem(taskId, { family: input.family, text: input.text, source: 'item', kind })
          return { ok: started.ok, note: started.note }
        },
      }),
      butlerStart: (taskId, text) => startButlerOnItem(taskId, text),
      ...(progressService === undefined ? {} : {
        precheck: async (taskId: string) => (await progressService.evaluate({ trigger: 'dispatch', taskIds: [taskId] })).results[0]?.progress,
        onReturn: (taskId: string) => { void progressService.evaluate({ trigger: 'return', taskIds: [taskId], force: true }).catch(() => {}) },
      }),
      // 挑手(合并卡 W 接卡 O 的那一根):调用方没给就用卡 O 的 `choicesFor` —— 派之前按活的类型挑手、
      // 问句里带余额;那一家这件做不了就不问不派,把原因与修法写在卡上(卡 N 交接第八节第 4 条)。
      choices: itemsOption.choices ?? (async (id: string, input: { text: string }) => await choicesFor(id, input)),
      onChanged: () => { void composeState().then(state => broadcast({ kind: 'snapshot', state })).catch(() => {}) },
    })
    // 起服务之后十秒跑第一拍(不挡起服务;重启前挂着的问一并重新挂上)。
    const driver = itemDriver
    setTimeout(() => driver.kick(), 10_000).unref?.()
  }

  /**
   * 卡上挂「现在到哪」与「现在该谁动」(2026-09-25,卡 N;同一张卡两种排法,事项那一排读 mover)。
   * 没接 items 就原样返回 —— 老行为逐字不变。
   */
  function decorateItems(state: ItemTasksState | undefined, sessions: readonly ItemSessionView[]): ItemTasksState | undefined {
    if (state === undefined || options.items === undefined) return state
    const cards = progressService?.cardViews()
    const running = new Set(sessions.filter(one => one.status === 'running').map(one => `${one.agent}:${one.session_id}`))
    const asking = new Set((approvals?.list() ?? [])
      .filter(one => one.session_id.startsWith(DISPATCH_APPROVAL_PREFIX))
      .map(one => one.session_id.slice(DISPATCH_APPROVAL_PREFIX.length)))
    const held = itemDriver?.held()
    const sessionMap = new Map(sessions.map(one => [`${one.agent}:${one.session_id}`, { status: one.status, updated_at: one.updated_at }]))
    const now = new Date()
    // 任务账整本只过一遍,按事项分好(/state 每秒组装,一件一件去筛整本账太费)。
    const jobEvents = new Map<string, JobEvent[]>()
    for (const event of jobLog.all()) {
      const list = jobEvents.get(event.job)
      if (list === undefined) jobEvents.set(event.job, [event])
      else list.push(event)
    }
    return {
      ...state,
      tasks: state.tasks.map((task) => {
        // 收场的卡以主状态为准、比卡还旧的进度不下发(2026-10-12,`progressOnCard`)。
        const progress = progressOnCard(task, cards?.get(task.id))
        const mover = itemMover(task, { askingDispatch: asking, runningSessions: running, ...(held === undefined ? {} : { held }) })
        // 没办完的停在哪(2026-10-12):按卡上的派活记录、任务账、会话现算,不经模型。
        const standing = itemStanding(task, { now, mover, sessions: sessionMap, jobEvents: jobEvents.get(task.id) ?? [] })
        return {
          ...task,
          ...(progress === undefined ? {} : { progress }),
          mover,
          ...(standing === undefined ? {} : { standing }),
        }
      }),
    }
  }
  /**
   * 通话里的一次工具调用 → 一句回给智能体的话(她会在电话里把这句话说成人话)。
   *
   * **回的永远是一句人话,不是状态码**:她拿到什么就说什么。没办成也要说出来——
   * 电话里最坏的失真是「她说记下了,实际没记」。
   */
  async function runCallTool(name: string, args: Record<string, unknown>): Promise<string> {
    if (name === CALL_TOOL_REMEMBER) {
      const text = typeof args.text === 'string' ? args.text.trim() : ''
      if (text === '') return '没听清他要记什么,请他再说一遍。'
      /**
       * ★ 电话里那一条(2026-10-04,卡 `claude/answer-comes-to-her`):记成 `call`。
       * 它的答案**本来就在电话里当场说了**,所以 `answerWorthNotifying` 不会再推一次通知 ——
       * 只在字幕 / 事务官页上摆一行(她挂了电话回头还能看见刚才问的那一句答什么)。
       */
      const result = await createButlerItem(text, undefined, undefined, { askedWhere: 'call' })
      if (!result.ok) return `没记上:${result.error}。如实告诉他这条没落下。`
      broadcast({ kind: 'snapshot', state: await composeState() })
      return result.note === undefined
        ? `记下了:「${text}」,已经在工作台上排上了。`
        : `记下了:「${text}」。不过${result.note},这条先搁在待办里。`
    }
    if (name === CALL_TOOL_DOING) {
      if (tasks === undefined) return '工作台的看板这会儿拿不到,如实告诉他查不了。'
      try {
        return callContextBlock(await tasks.list())
      }
      catch {
        return '工作台的看板这会儿拿不到,如实告诉他查不了。'
      }
    }
    // 认不得的工具名:如实回一句,别静默丢掉——她会一直等这个结果。
    return `工作台没有「${name}」这件工具,这件事办不了。`
  }

  /** 把一次工具结果交回给通话里的智能体(经 butler-server 的 UpdateVoiceChat)。绝不抛。 */
  async function replyCallToolResult(input: { roomId: string, taskId: string, toolCallId: string, content: string }): Promise<void> {
    if (butler === undefined) return
    try {
      await butler.proxy({
        method: 'POST',
        path: '/api/rtc/function-result',
        contentType: 'application/json',
        body: Buffer.from(JSON.stringify(input)),
      })
    }
    catch {
      // 回填失败只影响她这一句怎么说,通话本身还在;卡已经建好了,不回滚。
    }
  }

  /** 火山一条 tool_calls 回调里的全部调用,顺次办完并各自回填。 */
  async function handleCallToolCalls(raw: Record<string, unknown>): Promise<void> {
    const roomId = typeof raw.RoomID === 'string' ? raw.RoomID : ''
    const taskId = typeof raw.TaskID === 'string' ? raw.TaskID : ''
    for (const call of parseToolCalls(raw.Message)) {
      let content: string
      try {
        content = await runCallTool(call.name, call.args)
      }
      catch {
        content = '工作台这边出错了,这件事没办成。'
      }
      if (roomId === '' || taskId === '') continue
      await replyCallToolResult({ roomId, taskId, toolCallId: call.id, content })
    }
  }

  /**
   * 手机发往 /api/rtc/start 的请求体 → 注入事务官人设。
   *
   * **人设不经手机的手**:它拿不到 ~/.dsh/AGENTS.md,也不该拿到;手机自己塞的 systemMessage
   * 一律被覆盖(否则一个改过的 App 就能把事务官换成任何角色)。手机原有的其它字段(roomId、
   * voice、avatarId)一个不动。注入失败就原样转发——那样通话仍然打得通,只是没有人设。
   */
  async function injectCallPersona(body: Buffer): Promise<Buffer> {
    if (rtcCall === undefined) return body
    let parsed: Record<string, unknown>
    try {
      const text = body.toString('utf8')
      const decoded = JSON.parse(text === '' ? '{}' : text) as unknown
      parsed = decoded !== null && typeof decoded === 'object' && !Array.isArray(decoded) ? decoded as Record<string, unknown> : {}
    }
    catch {
      return body
    }
    try {
      const injection = await rtcCall.injection()
      return Buffer.from(JSON.stringify({
        ...parsed,
        systemMessage: injection.systemMessage,
        welcomeMessage: injection.welcomeMessage,
        ...(injection.tools === undefined ? {} : { tools: injection.tools }),
        ...(injection.functionCalling === undefined ? {} : { functionCalling: injection.functionCalling }),
      }))
    }
    catch {
      return body
    }
  }
  // 当前这一次登录的进展与上下文。只有状态和人话，绝不含 Cookie。
  let loginProgress: LoginProgress | undefined
  let loginSession: { provider: 'kimi_web', profileDir: string } | undefined
  let loginTimer: ReturnType<typeof setInterval> | undefined
  /**
   * 工作台是否暂停(spec §5 诚实边界)。只影响 tick() 的响铃广播与这里组装出的 paused 字段，
   * 没有任何通道能借此挂起/控制 Agent 进程——见下方 tick() 与 /pause 路由的注释。
   */
  let paused = false
  /**
   * 手动试铃（/ring/test）的翻转态：true=刚广播过 ring 且还没停。
   * 只是按钮的记性，不进 /state——试铃不该在任何界面留下会话痕迹。
   */
  let testRinging = false
  /**
   * 当前正在响的铃(2026-08-25 新增)。在此之前响铃只活在消息流里，
   * 订阅者一断线重连就永久丢失，派接不了、网页停不掉——详见 ringActive.ts 开头。
   */
  let ringActive: RingActive = {}
  let testRingTimer: ReturnType<typeof setTimeout> | undefined
  const testRingResetMs = options.testRingResetMs ?? 60_000

  /**
   * **页面上最近出的几个错**(2026-09-25,卡 V)。09-25 晚维护者点「事务官」没反应、页面卡死,
   * 而没有任何地方记录 —— 页面里的错只落在 WKWebView 的控制台里,他打不开、统筹也看不到。
   * 客户端 `window.onerror` / `unhandledrejection` → `POST /client/error` → 这里 + 服务端日志。
   * 只在内存(最近 20 条、同一条折叠计数):它是「此刻这台机器上出了什么」,不是台账。
   */
  const clientErrors = createClientErrorStore({ log: line => console.error(line) })

  /** 台账里还在响的那些。每次读都顺手清掉超时的，时限对齐展示台 60 秒兜底自停。 */
  function activeRings(): ReturnType<typeof listRings> {
    ringActive = pruneRings(ringActive, Date.now(), testRingResetMs)
    return listRings(ringActive)
  }

  /**
   * 停掉当前正在响的所有铃，返回停掉的那些。
   *
   * 对每条**真实的会话键**广播 call/offhook——展示台本来就认这条消息(来电链 v0)，
   * 所以停真响铃不需要展示台改一行代码。在此之前唯一的停铃口是 /ring/test，
   * 而它只认 dsh:test-ring：真响铃期间按它非但停不掉，第一下还会再加一个测试铃。
   */
  function stopAllRings(): ReturnType<typeof listRings> {
    const stopped = activeRings()
    for (const ring of stopped) {
      broadcast({ kind: 'call', phase: 'offhook', agent: ring.agent, session_id: ring.session_id })
      ringActive = stopRing(ringActive, ring)
    }
    if (stopped.length > 0) {
      if (testRingTimer !== undefined) { clearTimeout(testRingTimer); testRingTimer = undefined }
      testRinging = false
    }
    return stopped
  }

  /**
   * 试铃排出去的**那一通真电话**(2026-09-23)。「🔕 停铃」按的就是它。
   * 只活在内存里:进程重启后那一通该怎么收场由工人和台账说了算,不归这颗按钮管。
   */
  let testCallId: string | undefined

  /**
   * 「🔔 试铃 / 🔕 停铃」的一按:**排一通真的,或者取消刚排的那一通**。
   *
   * 取消只取消得了**还排着(`queued`)的**那一通 —— 把它记成 `failed`,
   * `claim()` 只认 `queued`,所以工人再也不会领走它,等于这通没打出去。
   * 已经被工人领走(`ringing`)的那通**这里取消不了**:8791 与工人之间只有工人主动
   * 发起的那一条链(callOut.ts 文件头),没有「喂,把那通掐了」的路。如实说一句,
   * 让他在手机上按挂断、或者等工人自己的 60 秒收场 —— 不假装停掉了。
   */
  async function toggleTestCall(): Promise<Record<string, unknown>> {
    if (callOut === undefined) return { ok: false, error: '主动来电未启用' }
    if (testCallId !== undefined) {
      const live = callOut.view().entries.find(entry => entry.id === testCallId)
      if (live?.state === 'queued' || live?.state === 'ringing') {
        const canceled = live.state === 'queued'
        if (canceled) await callOut.ack({ id: live.id, result: 'failed', error: CALL_OUT_STOP_RING_ERROR, fail_kind: 'declined' })
        testCallId = undefined
        testRinging = false
        return {
          ok: true,
          ringing: false,
          canceled,
          ...(canceled ? {} : { note: '这一通工人已经领走了,停不掉:在手机上按挂断,或者等它自己收场(60 秒)' }),
        }
      }
      // 早就收场了(接了 / 未接 / 只发了通知):这一按是**重新试一通**,不是停铃。
      testCallId = undefined
    }
    const queued = await callOut.request({ reason: 'confirm', item_id: TEST_RING_ITEM_ID, title: TEST_RING_TITLE })
    if (!queued.ok) return { ok: false, ringing: false, ...(queued.error === undefined ? {} : { error: queued.error }) }
    testCallId = queued.entry?.id
    testRinging = true
    testRingTimer = setTimeout(() => { testRingTimer = undefined; testRinging = false }, testRingResetMs)
    testRingTimer.unref?.()
    return {
      ok: true,
      ringing: true,
      ...(testCallId === undefined ? {} : { call_id: testCallId }),
      // 夜间静默时段里这一通只发通知、不响(callOut.ts 的规矩)。**如实说**,
      // 否则他按了没动静,只会以为链路坏了。
      ...(queued.entry?.silent === true ? { silent: true, note: '这会儿是夜间静默时段:只发了一条通知,手机不响' } : {}),
    }
  }

  /**
   * 把 base state 摊平上项目区/布局/机器采样/角标/暂停位。
   * 每一块都各自 try/catch：一个可选服务挂了只让它自己那一块缺省或带 error，
   * 绝不能因为机器采样炸了就连累 /state 整个 500（brief 明令）。
   */
  async function tryCall<T>(fn: (() => Promise<T>) | undefined): Promise<T | undefined> {
    if (fn === undefined) return undefined
    try {
      return await fn()
    }
    catch {
      return undefined
    }
  }

  /**
   * 走一拍哨兵。**请求驱动 + 心跳限频**:这里被 tick()(既有的 1 秒节拍)和 composeState
   * (有人真的来看时)两处调用,自己不起定时器。真正的限频在服务内部——每个监视项的
   * interval_sec 决定要不要真探,外加一道单飞守卫,所以多调几次不会多探几次。
   *
   * 触发出来的事件走**现有通道**:写进会话表 + 增量广播,跟 hook 入口(/hook/:agent)
   * 一模一样的两步,不为哨兵另开一条消息类型。
   */
  function pumpSentinel(): void {
    if (sentinel === undefined) return
    void sentinel.tick()
      .then((events) => {
        for (const event of events) {
          service.applyEvent(event)
          broadcast({ kind: 'event', event })
        }
      })
      .catch(() => {
        // 探针那一层已经把失败记进 watch.error 了;这里兜的是没预料到的拒绝,
        // 不能让它变成 unhandledRejection 炸掉宿主进程(同 helper 事件回调那道兜底)。
      })
  }

  /**
   * 排期风险的「说一句」(2026-09-09)。风险**变成**赶不上时产出一条 WorkbenchEvent,
   * 走的是哨兵那条现成通道(写进会话表 + 增量广播),**不新增模块、不响铃**:
   * ring.ts 只让「等审批」响,排期不是审批;要它响就得在会话数据里谎称是审批(D13)。
   *
   * 第一次看到某个项目只建基线不报——重启一次报一次会很吵(同哨兵「第一拍只建基线」)。
   * 判断本身在 scheduleRisk.ts 的纯函数里,这里只负责把结果送上现有的路。
   */
  function pumpRisk(projectRows: ProjectsState['projects']): void {
    for (const event of riskWatcher.observe(projectRows)) {
      service.applyEvent(event)
      broadcast({ kind: 'event', event })
    }
  }

  /**
   * 引导答案的「他亲口答的」凭据(2026-09-23,见 onboardingConsent.ts)。
   * - 电话那条路:工人在 body 里带 `heard: { asked, reply }`(她最近问的那句、他之后说的那句);
   * - DSH 会话那条路:回合表绑着的正是当前引导会话 → 从回合表里取最近一问一答
   *   (他一句都还没说过 → 空的一问一答,照样过门:没有凭据就是没有凭据)。
   * 两样都拿不到(老调用方、没绑回合表)→ undefined,不拦 —— 见交接「与要求不一样处」。
   */
  function exchangeFor(heard: unknown): { exchange: Exchange, fromTurns: boolean } | undefined {
    const record = typeof heard === 'object' && heard !== null && !Array.isArray(heard) ? heard as Record<string, unknown> : undefined
    if (record !== undefined && typeof record.reply === 'string') {
      return { exchange: { asked: typeof record.asked === 'string' ? record.asked : '', reply: record.reply }, fromTurns: false }
    }
    if (onboardingTurns === undefined || onboarding === undefined) return undefined
    const bound = onboardingTurns.status().session_id
    if (bound === undefined || bound !== onboarding.detail().session_id) return undefined
    return { exchange: lastExchange(onboardingTurns.list(0)) ?? { asked: '', reply: '' }, fromTurns: true }
  }

  /**
   * `/onboarding/answer` 之前那道门。回 undefined = 放行;回一句话 = 409 带给模型。
   * 页面上他自己按的按钮(浏览器发的请求带 `Origin`)不拦 —— 那就是他本人的手。
   */
  function answerGuard(req: IncomingMessage, raw: Record<string, unknown>): string | undefined {
    if (onboarding === undefined) return undefined
    if (typeof raw.stage !== 'string' || typeof raw.key !== 'string') return undefined
    if (!(FULL_PLAN as readonly string[]).includes(raw.stage)) return undefined
    const origin = req.headers.origin
    if (typeof origin === 'string' && origin !== '') return undefined
    const evidence = exchangeFor(raw.heard)
    if (evidence === undefined) return undefined
    const detail = onboarding.detail()
    const stage = raw.stage as OnboardingStage
    const verdict = guardAnswer({
      stage,
      key: raw.key,
      value: raw.value,
      required: requiredKeys(stage, detail.mode).includes(raw.key),
      exchange: evidence.exchange,
      seed: stageDef(stage, detail.mode).seed,
    })
    if (!verdict.ok) return verdict.error
    // K:这一段收尾之前,问出口却没答上的那一项(现在只盯「开口说还是发文字」)。
    if (raw.key === 'done' && raw.value === true && evidence.fromTurns && onboardingTurns !== undefined) {
      const missing = unansweredAsked({
        stage,
        answeredKeys: detail.answered[stage] ?? [],
        askedTexts: onboardingTurns.stageTurns().filter(turn => turn.role === 'assistant' && turn.kind !== 'error').map(turn => turn.text),
      })
      if (missing !== undefined) {
        // W(2026-09-23):他明说「下一步 / 先这样」了 —— 不追问,按默认记并明说一句就收。
        if (wantsToMoveOn(evidence.exchange.reply)) {
          return `他说要往下走了,**别再追问**:先把 ${missing.key} 按默认记成「${missing.fallback}」,`
            + '跟他明说一句「那我先按这个来,以后随时能改」,再收这一段。' + NO_INTERNAL_TALK
        }
        return `这一段还不能收:你问过他 ${missing.key}(比如「开口说还是发文字」),他没给有效回答。`
          + `**追问一次**,换个说法问清楚;还是不答就按默认记 ${missing.key}=「${missing.fallback}」,并跟他明说「那我先按这个来,以后随时能改」,再收这一段。`
          + NO_INTERNAL_TALK
      }
    }
    return undefined
  }

  /**
   * 系统授权(辅助功能)的信号(2026-09-23)。`ask`:现在在 ③ 授权阶段、而且还没开 —— 界面据此亮「去授权」
   * (按钮走 `open` 里那一条,与横幅同一条),她据此把「为什么要」说给他听(`why`)。
   * 壳没连上时 `unknown`:不冒充开着,也不冒充没开;这时仍然 ask(宁可多问一句)。
   */
  function systemAuthView(stage: string): {
    accessibility: 'granted' | 'missing' | 'unknown'
    ask: boolean
    why: string
    open: { method: 'POST', path: '/setup/open', body: { pane: 'accessibility' } }
    /**
     * 「完全磁盘访问」给没给(2026-10-13)。读**上一次体检的结论**(不触发新的体检),
     * `unknown` = 还没体检过 / 这台机器上探不着 —— 引导那一条看到 unknown 就整个不提
     * (判断不了的时候不许催她去点一个可能已经给过的授权)。
     */
    file_access: 'granted' | 'missing' | 'unknown'
    file_access_why: string
    /** 这一项**没有"替他按一下"那条路** —— macOS 不给程序请求它的机会,只能指路。 */
    file_access_open: { method: 'POST', path: '/setup/open', body: { pane: 'all_files' } }
  } {
    const accessibility = helper === undefined || !helper.connected()
      ? 'unknown' as const
      : helper.view().authorized ? 'granted' as const : 'missing' as const
    let fileAccess: 'granted' | 'missing' | 'unknown' = 'unknown'
    try {
      const alert = setup?.alerts()?.file_access
      if (alert !== undefined) fileAccess = alert ? 'missing' : 'granted'
    }
    catch { fileAccess = 'unknown' }
    return {
      accessibility,
      ask: stage === 'authorization' && accessibility !== 'granted',
      why: SYSTEM_AUTH_WHY,
      open: { method: 'POST', path: '/setup/open', body: { pane: 'accessibility' } },
      file_access: fileAccess,
      file_access_why: FILE_ACCESS_WHY,
      file_access_open: { method: 'POST', path: '/setup/open', body: { pane: 'all_files' } },
    }
  }

  /**
   * 开(或续)引导会话,登记回合表、推一次快照。`POST /onboarding/session` 与重启后的预热(onboardingWarm)共用。
   * 模型在会话里用这个地址 POST /onboarding/answer —— 永远是回环:事务官与工作台在同一台机器上。
   */
  /** 最近一次往引导会话里推话那一刻,回合表里她最后一句的 seq(2026-09-24 防「接着」说两遍)。 */
  let nudgeAssistantSeq: number | undefined
  function lastAssistantSeq(): number {
    try {
      const list = onboardingTurns?.list(0) ?? []
      for (let i = list.length - 1; i >= 0; i--) if (list[i]!.role === 'assistant') return list[i]!.seq
    }
    catch { /* 回合表读不到就当她还没开口 */ }
    return 0
  }

  async function openOnboardingSession(options?: OpenSessionOptions): Promise<Awaited<ReturnType<OnboardingService['openSession']>> | { ok: false, status: 404, error: string }> {
    if (onboarding === undefined) return { ok: false, status: 404, error: '引导未启用' }
    const address = server.address()
    const listening = typeof address === 'object' && address !== null ? address.port : DEFAULT_PORT
    // 上一次推「接着」之后她已经开过口了(回合表里多了她的话):那一次有了回音,这一次照常推。
    if (nudgeAssistantSeq !== undefined && lastAssistantSeq() > nudgeAssistantSeq) onboarding.clearNudge?.()
    const result = await onboarding.openSession(butlerSession, `http://127.0.0.1:${listening}`, options)
    if (!result.ok) return result
    if (result.quiet !== true) nudgeAssistantSeq = lastAssistantSeq()
    // 回合表认这条会话;第一条 user 消息登记进去不算用户回合;当前阶段种子句登记进去,模型照念的那条标 kind:seed。
    // quiet(2026-09-24):同一条会话刚推过「接着」,这一次没往里说 —— 那一轮可能还在答,不重绑(会把「在想」清掉)。
    if (result.session_id !== undefined && result.quiet !== true) onboardingTurns?.bind(result.session_id, result.first_message, result.seed)
    broadcast({ kind: 'snapshot', state: await composeState() })
    return result
  }

  /**
   * 账号用户名(`/state.me` 的后备)。/state 每秒都在拼,而账号在服务器上时 `view()` 要问中转,
   * 所以只记一份、半分钟顺手刷一次;`/account/*` 动过就清掉,下一拍等它回来(最多等 1.5 秒)。
   */
  let accountName: string | undefined
  let accountNameAt = 0
  function refreshAccountName(): Promise<void> {
    accountNameAt = Date.now()
    return (account?.view() ?? Promise.resolve(undefined))
      .then((view) => { accountName = view?.username === '' ? undefined : view?.username })
      .catch(() => undefined)
  }
  async function meNow(): Promise<WorkbenchState['me']> {
    if (account !== undefined) {
      if (accountNameAt === 0) await Promise.race([refreshAccountName(), new Promise(done => setTimeout(done, 1_500))])
      else if (Date.now() - accountNameAt > 30_000) void refreshAccountName()
    }
    const nick = onboarding?.nickname?.()?.trim()
    const name = nick !== undefined && nick !== '' ? nick : accountName
    return name === undefined ? undefined : { name }
  }

  type LinkedSourceSnapshot = {
    tasks: readonly TaskView[]
    projects: () => Promise<readonly WorkbenchProject[]>
    files: () => readonly import('./sessionHistory.ts').SessionFileRef[]
    kimi: (input: Omit<Parameters<typeof locateKimiCliSession>[0], 'home'>) => ReturnType<typeof locateKimiCliSession>
    codex: (sessionId: string) => string | undefined
  }
  const executionKimiLocator = createKimiExecutionLocator(options.paths?.home ?? osHomedir())
  // CODEX_HOME 保持每次调用现读(runtimeContext 那条路如此),locator 只在 home 真变时重建,hint 不丢。
  let codexLocatorHome: string | undefined
  let executionCodexLocator: ReturnType<typeof createCodexExecutionLocator> | undefined
  let codexExecutionLookup: Awaited<ReturnType<ReturnType<typeof createCodexExecutionLocator>['prepare']>> | undefined
  const codexLocatorNow = (): ReturnType<typeof createCodexExecutionLocator> => {
    const home = process.env.CODEX_HOME ?? join(options.paths?.home ?? osHomedir(), '.codex')
    if (executionCodexLocator === undefined || codexLocatorHome !== home) {
      codexLocatorHome = home
      executionCodexLocator = createCodexExecutionLocator(home)
      codexExecutionLookup = undefined
    }
    return executionCodexLocator
  }
  async function linkedExecutionSource(agent: string, id: string, snapshot?: LinkedSourceSnapshot): Promise<
    { ok: true, ref: import('./sessionHistory.ts').SessionFileRef } | { ok: false, status: number, error: string } | undefined
  > {
    if ((agent !== 'codex' && agent !== 'kimi') || tasks === undefined) return undefined
    if (!safeCliSessionId(id)) return { ok: false, status: 400, error: '要给准确的 Codex 会话号，不能给文件路径' }
    const linked = (snapshot?.tasks ?? (await tasks.list()).tasks).filter(task => task.links?.some(link => link.agent === agent && link.session_id === id))
    // 非事项来源仍用既有桌面会话读口；已登记事项不能从宽扫描回退绕过项目核验。
    if (linked.length === 0) return undefined
    if (authorization === undefined || !(await authorization.isAllowed('read_client_files'))) {
      return { ok: false, status: 403, error: authorization?.denialMessage('read_client_files') ?? '这台工作台还没允许读客户端的会话记录' }
    }
    const projectList = snapshot === undefined
      ? await projects?.getProjectsState().then(state => state.projects).catch(() => []) ?? []
      : await snapshot.projects()
    const cwds: string[] = []
    for (const task of linked) {
      const dispatch = task.dispatch
      const dispatchedCwd = dispatch?.hand === 'cli' && dispatch.family === agent && dispatch.session_id === id ? dispatch.cwd : undefined
      const project = projectList.find(p => p.id === task.project_id)
      if (task.project_id !== undefined && project?.path === undefined) continue
      if (dispatchedCwd !== undefined && (project?.path === undefined || dispatchCwdAllowed(dispatchedCwd, [project.path]))) cwds.push(dispatchedCwd)
      else if (project?.path !== undefined) cwds.push(project.path)
    }
    const registered = (snapshot?.files() ?? sessionDigest?.files())?.find(ref => ref.session_id === id && (ref.agent === agent || ref.format === 'codex-rollout'))
    const codexInput = {
      sessionId: id, cwds,
      ...(registered?.format !== 'codex-rollout' ? {} : { registeredFile: registered.file }),
      ...(snapshot === undefined ? {} : { rolloutPathLookup: snapshot.codex }),
    }
    // snapshot 与非 snapshot 两条路共用同一份 hint:命中条件只看解析出的路径、cwds 串与文件 stamp。
    // codexLocatorNow 每次都要先调:??= 在 lookup 已存在时短路,不先走这道,CODEX_HOME 变了发现不了、旧 hint 照用。
    const codexRef = async () => {
      const locator = codexLocatorNow()
      const lookup = codexExecutionLookup ??= await locator.prepare()
      return lookup(codexInput)
    }
    const kimiInput = { sessionId: id, cwds, ...(registered === undefined ? {} : { registeredFile: registered.file }) }
    const ref = agent === 'codex' || registered?.format === 'codex-rollout' ? await codexRef()
      : await (snapshot?.kimi(kimiInput) ?? locateKimiCliSession({ home: options.paths?.home ?? osHomedir(), ...kimiInput })) ?? await codexRef()
    return ref === undefined
      ? { ok: false, status: 404, error: '这条执行来源还没同步，或原件与这件事的项目/本机不符；没有读取其它会话' }
      : { ok: true, ref: { ...ref, agent } }
  }

  async function codexLinkedSource(agent: string, id: string) {
    return agent === 'codex' ? linkedExecutionSource(agent, id) : undefined
  }

  const reconcileExecutions = tasks === undefined ? undefined : createExecutionReconciler({
    tasks, jobLog, now: () => new Date(service.getState().now),
    cacheDir: join(options.paths?.home ?? osHomedir(), '.dsh/workbench/execution-cache'),
    coldParsePerBeat: COLD_PARSE_PER_BEAT,
    // 每拍对账跑完推一次快照:对账自己发现的回执 / 挪卡不靠在场的请求替它广播(8791 第六轮)。
    onFinished: () => { void composeState().then(state => broadcast({ kind: 'snapshot', state })).catch(() => {}) },
    prepareAuthorization: (board) => {
      // 一次对账认一份任务/项目/登记快照；授权许可仍在每个来源的 linkedExecutionSource 内现查。
      let projectList: Promise<readonly WorkbenchProject[]> | undefined
      let registered: readonly import('./sessionHistory.ts').SessionFileRef[] | undefined
      let kimiLookup: Awaited<ReturnType<typeof executionKimiLocator.prepare>> | undefined
      const codexLookup = createCodexRolloutLookup(process.env.CODEX_HOME ?? join(options.paths?.home ?? osHomedir(), '.codex'))
      const snapshot: LinkedSourceSnapshot = {
        tasks: board.tasks,
        projects: () => projectList ??= projects?.getProjectsState().then(state => state.projects).catch(() => []) ?? Promise.resolve([]),
        files: () => registered ??= sessionDigest?.files() ?? [],
        kimi: async input => (kimiLookup ??= await executionKimiLocator.prepare())(input),
        codex: id => codexLookup.get(id),
      }
      const authorize = async (_task: TaskView, link: TaskLink) => {
        const found = await linkedExecutionSource(link.agent, link.session_id, snapshot)
        if (found === undefined) return undefined
        if (!found.ok) throw Object.assign(new Error('source unavailable'), { code: found.status === 403 ? 'denied' : 'missing' })
        return found.ref
      }
      authorize.dispose = () => codexLookup.close()
      return authorize
    },
    authorize: async (_task, link) => {
      const found = await linkedExecutionSource(link.agent, link.session_id)
      if (found === undefined) return undefined
      if (!found.ok) throw Object.assign(new Error('source unavailable'), { code: found.status === 403 ? 'denied' : 'missing' })
      return found.ref
    },
  })
  /*
   * 8791 第六轮:对账事件驱动 —— 任务账写成功(派发 / 交回 / 回执 / 改卡)经 notifyChanged 触发,
   * 两拍之间至少隔 2 秒(连写合并成一拍);读路(/state、/collab/*、广播)只读 snapshot() 一拍不触发。
   * 对账自己的写(applying())不递归触发。起服务先对一冷拍:首屏 /state 就有执行来源,不用等第一个事件。
   */
  const unsubscribeTaskMutations = tasks?.onMutated?.(() => {
    reconcileExecutions?.notifyChanged()
  })
  // 8791 第六轮第 4 轮:桌面登记表进了新来源(sessionDigest.note)→ 对账的来源定位要重读。
  const unsubscribeDigestChanged = options.sessionDigest?.onChanged?.(() => {
    reconcileExecutions?.notifyChanged()
  })
  reconcileExecutions?.request().catch(() => {})

  /** 运行片段按拍缓存(8791 第六轮):账代数 + 同一秒(同一拍)内,同一张卡只算一次。 */
  let runsMemoCache: { revision: number, second: number, results: Map<string, readonly RunSegment[]> } | undefined

  /**
   * composeState 按拍缓存(8791 第六轮第 3 轮,退修):同一秒 + 会话表版本 + 对账快照引用都没变,
   * 本拍内第 N 个 /state、广播、live 推送直接复用上一份组好的整份状态(每拍一次的 compose 复用同一拍结果)。
   * 任何写都会作废:各变化口的 broadcast() 与非 GET 请求(见 handle)把 epoch +1;拍跨过下一秒自然作废。
   * 组装途中被作废的不入库(拿 epoch 对账),不会把旧结果重新贴回去。
   */
  let composeEpoch = 0
  let composeCache: { epoch: number, beat: number, version: number, snapshot: unknown, state: WorkbenchState } | undefined
  function invalidateComposeCache(): void {
    composeEpoch += 1
    composeCache = undefined
  }

  async function composeState(): Promise<WorkbenchState> {
    const cacheBase = service.getState()
    const cacheSnap = reconcileExecutions?.snapshot()
    const cacheBeat = Math.floor(Date.parse(cacheBase.now) / 1000)
    const cacheVersion = service.version?.() ?? 0
    if (composeCache !== undefined && composeCache.epoch === composeEpoch && composeCache.beat === cacheBeat
      && composeCache.version === cacheVersion && composeCache.snapshot === cacheSnap) {
      return composeCache.state
    }
    const epochAtStart = composeEpoch
    // Codex 会话对账(2026-08-26):同步 fire-and-forget,内部自带限频,绝不拖慢 /state。
    try {
      codexReconcile?.()
      // 哨兵:有人来看 /state 就顺手走一拍(内部按 interval_sec 限频,fire-and-forget)。
      pumpSentinel()
      // Claude 会话恢复(2026-09-02):同款请求驱动 + 内部限频。Claude 靠 hook 推送,
      // 但会话表只在内存里——重启前就在跑的会话要等下一次 hook 才会重现,这条把它们捞回来。
      claudeRecover?.()
      // 「在等你」(卡 T):同款请求驱动 + 内部限频。
      waitingPump?.()
    }
    catch {
      // 对账失败只是这一拍没兜到,不能连累 /state。
    }
    const base = cacheBase
    /** 两条横幅那一格,只读一次(下面要用两处:缺席判断与取值)。 */
    const alertsNow = setupAlertsNow()
    /** 插件进程自己的内存与事件循环;没接采样器或取不到就缺席(进机器那一格)。 */
    let processView: ReturnType<NonNullable<typeof processHealth>['view']>
    try { processView = processHealth?.view() }
    catch { processView = undefined }
    const [
      projectsState, layout, machineSample, badgesResult, calendarSample, scenesList, appsList, dockView, notesList,
      briefView,
    ] = await Promise.all([
      tryCall(projects === undefined ? undefined : () => projects.getProjectsState()),
      tryCall(projects === undefined ? undefined : () => projects.getLayout()),
      tryCall(machine),
      tryCall(badges),
      tryCall(calendar),
      tryCall(scenes === undefined ? undefined : () => scenes.list()),
      tryCall(registry === undefined ? undefined : () => registry.list()),
      tryCall(dock === undefined ? undefined : () => dock.view()),
      tryCall(notes === undefined ? undefined : () => notes.list()),
      tryCall(brief === undefined ? undefined : () => brief.view()),
    ])
    /*
     * 8791 第六轮:对账不再由 /state 驱动。这里用 awaitFresh():平时白拿上一拍快照(零文件系统);
     * 任务账刚写过、对账在途或排着时,等到那一拍落地再组 —— 撤权 / 建卡之后紧跟的 /state
     * 一定带着新结论(第 4 轮:授权变化即时生效,不等 30 秒到期)。任务看板这一拍照常现读。
     */
    const reconciled = reconcileExecutions === undefined ? undefined : await reconcileExecutions.awaitFresh()
    let tasksRaw = await tryCall(tasks === undefined ? undefined : () => tasks.list())
    const executorSessions = reconciled?.sessions ?? []
    const executionSources = reconciled?.tasks.tasks.flatMap(task => task.execution_sources ?? []) ?? []
    /**
     * ★ **借源会话名的卡,随来源改名**(2026-10-23,卡 A「同事项接续与动作契约」):挂在读路径上,
     * 同「读路径迁移」那几条的老做法 —— 来源一改名,下一拍卡名就跟上。用户改过的卡(custom)不跟着动;
     * 没变不写盘(返回 0,这一拍没有第二遍读)。失败不连累 /state:这一拍没同步成,下一拍再来。
     */
    if (tasks !== undefined && tasksRaw !== undefined) {
      try {
        if (await syncBorrowedCardTitles(tasks, base.sessions) > 0) tasksRaw = await tasks.list()
      }
      catch { /* 同上:下一拍再来 */ }
    }
    /*
     * execution_sources 恒在(退修第 2 轮):接执行事实的宿主里,每张卡都带这一格 —— 快照里还没有
     * 这张卡(刚建卡、对账的冷拍/事件拍还没落地)时照贴 [],不许缺席(旧路每拍同步对账,恒是 [] 或现算值)。
     */
    if (tasksRaw !== undefined) tasksRaw = { ...tasksRaw, tasks: tasksRaw.tasks.map(task => ({
      ...task, execution_sources: executionSources.filter(source => source.task_id === task.id),
    })) }
    const me = await meNow()
    /**
     * 每张事务官自己在办的卡带上「花了多少 / 上限多少」(卡 O):落盘的是上限与状态,花了多少、跑了多久现算
     * (那条会话的用量在 DSH 会话 feed 的内存里)。不是她自己在办的卡一个字不加。
     */
    const tasksState = tasksRaw === undefined || itemBudget === undefined
      ? tasksRaw
      : {
          ...tasksRaw,
          tasks: tasksRaw.tasks.map((task) => {
            const view = itemBudget.viewOf(task)
            return view === undefined ? task : { ...task, budget: view }
          }),
        }
    // Agent 登记表(卡 Q):这一拍只出一次视图(外层那一句与 agent_registry 用同一份)。
    const agentView = agents?.view()
    // 送话之后那条会话认上没有(2026-09-21):**请求驱动 + 限频**,不新开轮询 ——
    // 只有真的有卡在等会话时才做事,而且 10 秒内最多一次(先例 claudeSessionRecover)。
    // fire-and-forget:认会话失败不该把 /state 带塌(matcher 内部自己吞异常)。
    if (dispatchMatcher !== undefined && tasksState !== undefined) {
      void dispatchMatcher.reconcile(tasksState.tasks, base.sessions)
    }
    // 已配对设备(2026-09-11):同款单独一发;devices.json 读坏了只是列表空着。
    const devicesList = await tryCall(pairing === undefined ? undefined : () => pairing.list())
    // 费用归因(2026-09-09):只问卡上 links 指到的那几条会话,同步查内存里的账,不扫盘。
    // 一张卡都没关联、或采集器不会按会话给数,字段整个缺席——不摆一个空对象让界面误读成「都是 0」。
    const linkedKeys = tasksState === undefined
      ? []
      : [...new Set(tasksState.tasks.flatMap(task => (task.links ?? []).map(link => `${link.agent}:${link.session_id}`)))]
    const sessionUsage = usage?.sessionTotals !== undefined && linkedKeys.length > 0
      ? usage.sessionTotals(linkedKeys)
      : undefined
    /**
     * 排期风险(2026-09-09,决策记录 傍晚拍板第 6 条)。**现算不落盘**:两块都齐了才算得出
     * ——项目行那层的截止日在 projects,速度在 tasks。缺任何一块就整块不挂 risk 字段
     * (界面据此照旧显示,不出现一个凭空的「无法判断」)。
     *
     * 时钟取 service 那份(base.now):测试注入的假时钟才管得住这条,同一拍里
     * 会话表与风险判断也才是同一个「现在」。
     */
    const nowSecForRisk = Math.floor(Date.parse(base.now) / 1000)
    const risked = projectsState === undefined || tasksState === undefined || Number.isNaN(nowSecForRisk)
      ? undefined
      : decorateRisk(projectsState, tasksState, nowSecForRisk)
    if (risked !== undefined) pumpRisk(risked.projects.projects)
    // 卡上挂「现在到哪」「现在该谁动」(2026-09-25,卡 N)。看板与收件箱读同一份。
    const shownTasks = decorateItems(risked?.tasks ?? tasksState, base.sessions)
    // 日结同款单发。view() 只回现成的(生成在后台,见 daily.ts),不会拖 /state。
    const dailyReport = await tryCall(daily === undefined ? undefined : () => daily.view())
    /**
     * 自定义模块清单(2026-09-21)。**每一拍都重读目录** —— 这正是「DSH 做完了,标签当场
     * 出现」靠的那条路:DSH 在盘上建好 `modules/<id>/`,下一拍 /state 里就多一条,
     * 窗位叠那一排末尾就多一个标签。没有任何人需要通知任何人。
     *
     * 读目录那几个 `readdir`/`readFile` 落在 1 秒一拍的 /state 上,量级是"几个模块 ×
     * 一个小 json";真嫌它重的那天再加缓存,现在加缓存等于给"标签什么时候出现"引入一个
     * 说不清的延迟。取不到就整块缺席(同 projects/usage 那套降级纪律)。
     */
    const modulesRaw = await tryCall(modules === undefined ? undefined : () => modules.list())
    // 用户层的页内小组件清单(2026-10-21)。同上每一拍重读 —— 她改了 index.js,下一拍指纹就变,那一格当场换上;
    // 入口文件的哈希按 (mtime, size) 缓存,不是每拍都算。读坏了整块缺席,那几格退回本体自带的。
    const userLayerView = await tryCall(userLayer === undefined ? undefined : () => userLayer.scan())
    /**
     * 每条模块带上**那块 iframe 的 src**(2026-09-22,C7)。它指向单开的那个来源,
     * 而且签着这个模块自己那把令牌 —— 客户端不自己拼这个地址,也拼不出来(端口与令牌
     * 只有服务端知道)。没起那台监听就整条不带:界面据此一格都不挂,
     * 而不是挂一块打不开的白 iframe。
     */
    const origins = moduleOriginServer
    const modulesList = modulesRaw === undefined || origins === undefined
      ? modulesRaw
      : modulesRaw.map(view => ({ ...view, frame_url: origins.frameUrl(view.id, view.entry) }))
    /**
     * 会议(2026-09-21)。同款单发,同样吃 `tryCall` —— meetings.json 读坏了只是
     * 事务官面板里那条「最近一次会议」不出,**硬盘上的会议目录一个都没少**。
     */
    const meetingsView = await tryCall(meeting === undefined ? undefined : () => meeting.view())
    // 通话记录(2026-10-22)。同款单发:calls.json 读坏了只是手机上那一页空着,目录里的 md 一份没少。
    const callsView = await tryCall(callRecords === undefined ? undefined : () => callRecords.view())
    // 本机后端同款单发:view() 内部 3 秒缓存,1 秒轮询不会变成每秒探一次 8792。
    const butlerView = await tryCall(butler === undefined ? undefined : () => butler.view())
    const connectorView = await tryCall(connector === undefined ? undefined : () => connector.view())
    if (butlerView !== undefined) noteButlerHealth(butlerView.running)
    // 引导进度(2026-09-15):view() 是同步的内存态。顺手把扫描到的项目名喂给它——引导做完之后
    // 冒出来的新仓库只补问那一个(设计 §五);内部按名字去重,只在第一次见到时 stat 一下文件。
    // 门关着的那一份(没看目录,只有落盘的几条)不喂:拿它立基线,等门开了整片仓库都会被当成「新冒出来的」。
    if (onboarding !== undefined && projectsState !== undefined && projectsState.scan_blocked === undefined) {
      void tryCall(() => onboarding.noticeProjects(projectsState.projects.map(project => project.name)))
    }
    // 先落一个局部变量再判断:直接在展开式里连着调用两次 snapView() 在
    // exactOptionalPropertyTypes 下会被拓宽回 SnapView | undefined(TS 不跨闭包边界做控制流收窄,
    // 先例见 orchestrator.ts snap() 里对 last.reason 的同一处理)。
    const snap = orchestrator?.snapView()
    const appearanceVersion = appearance?.version()
    /*
     * 同上那条纪律(先落一个局部变量再判断):`locked()` 回 `boolean | undefined`,
     * 直接写在展开式里 `exactOptionalPropertyTypes` 下会被拓宽回 `undefined`。
     * `undefined` = **不知道**(老壳 / 壳没连上 / 没授权)→ 这一格不摆。
     */
    const screenLockedNow = options.screenLock?.locked()
    /**
     * **只报这台电脑上真有的那几家**(2026-09-27,卡 HC)。维护者在全新 Air(只装了豆包办公与 Codex)上:
     * 「顶部栏也是一样,现在还是有 claude 和 kimi……千万不能写死」。
     * 探不出来时 `shown` 就是 `AGENT_IDS`,这一段等于没做事(D13:查不到不许冒充没有)。
     */
    const installedView = installedAgentsNow()
    const shownAgents = shownAgentsOf(base)
    const agentsShown = base.agents.filter(one => (shownAgents as readonly string[]).includes(one.id))
    const quotaShown = Object.fromEntries(
      Object.entries(base.quota).filter(([id]) => (shownAgents as readonly string[]).includes(id)),
    ) as typeof base.quota
    const taskViews = tasksState?.tasks ?? []
    const linkedExecutionKeys = new Set(taskViews.flatMap(task => (task.links ?? []).map(link => `${link.agent}:${link.session_id}`)))
    // Linked sessions are projected only from the freshly authorized execution read.
    // A cached general session snapshot must not survive a denied or ambiguous source read.
    const titledSessions = withCardTitles(base.sessions.filter(session =>
      !linkedExecutionKeys.has(`${session.agent}:${session.session_id}`)), taskViews)
    /**
     * 能接活的每一家的额度视图(卡 O)+ 剩余额度告警(2026-10-23,卡 t-8e617888)要消费的那一份。
     * 窗口型那几家的兜底重读泵(卡 QZ)照旧**先泵后读**;`agent_quota` 与告警读的是同一份
     * 统一视图(`quotaAlerts` 只消费、不另抓),所以在这里一次算好,下面两处用。
     */
    let quotaViewsNow: ReturnType<typeof agentQuotaNow> | undefined
    if (agentCaps !== undefined) {
      windowQuota?.pumpNative?.(openFamiliesNow())
      windowQuota?.pump()
      windowQuota?.pumpOpen(openFamiliesNow())
      quotaViewsNow = agentQuotaNow(base.quota)
    }
    // 告警只在接了这条链路的实例上跑(真机接线在 index.ts;测试不传 = 这一档整档不出)。
    const quotaAlertItems = quotaViewsNow === undefined || options.quotaAlerts === undefined
      ? []
      : options.quotaAlerts.itemsFor(quotaViewsNow, new Date(base.now))
    // 额度活用建议(2026-10-28,卡 t-f68365f6)同一拍算好:同样只消费统一视图,另加看板
    // (tasksState 缺席 = 看板读不到 → 整档不出,同「stale 不清账」那条纪律)。
    const quotaSpendItems = quotaViewsNow === undefined || options.quotaSpendTips === undefined
      ? []
      : options.quotaSpendTips.itemsFor(quotaViewsNow, tasksState?.tasks, new Date(base.now))
    const composed: WorkbenchState = {
      ...base,
      // 多人协作区总开关(2026-11-09):桌面与手机都读这一格收起入口,不再各自猜。
      collab_enabled: collabEnabled,
      agents: agentsShown,
      quota: quotaShown,
      ...(installedView === undefined ? {} : { installed_agents: installedView }),
      // 后台任务挂在主会话上(卡 Q):子任务不单独成一条会话,只在主会话的 children 里。
      // ★ 没名字的会话借挂着它的那张卡的标题(2026-10-23,`sessionTitleFallback.ts`;exec 起的 Codex 线程没名字,
      //   维护者在手机上找不到它)—— 先借名字,再挂子任务。
      sessions: sessionChildren === undefined ? [...titledSessions, ...executorSessions.filter(one => !titledSessions.some(had => had.session_id === one.session_id && had.agent === one.agent))] : sessionChildren.attach([...titledSessions, ...executorSessions]),
      ...(projectsState === undefined ? {} : { projects: risked?.projects ?? projectsState }),
      // 迁移必须也挂在**读**路径上:落盘的旧布局是原样透传的,只在 POST /layout 的
      // 写路径迁移的话,界面永远读不到新模块——真机实证:部署后 usage 模块没出现,
      // /state.layout 里只有 projects/slot/widgets。用户不主动拖一次布局就永远补不上。
      // 模板后来才加的格子(2026-10-12「今天的待办」)同样挂在读路径上补:老布局缺它就永远看不见。
      // 2026-10-23(分层二刀二):她选的模板这会儿解析不出来(用户层那份被删 / 改坏了)→
      // 横竖 modules 按 product 那份换掉(不只补格),界面回到通用样子;模板正常时行为一字不变。
      ...(layout === undefined
        ? {}
        : { layout: withFallbackTemplateModules({ ...layout, modules: migrateLayoutModules(layout.modules) }, template?.current(), template?.currentId()) }),
      /*
       * 机器那一格顺带带上**插件进程自己**的内存与事件循环(2026-10-19)。机器采样整格缺席时它也缺席 ——
       * 它是机器格的一个子格,不另开顶层键(/state 已经 67 个键,见接缝设计根子 4)。
       */
      ...(machineSample === undefined ? {} : { machine: processView === undefined ? machineSample : { ...machineSample, process: processView } }),
      ...(badgesResult === undefined ? {} : { badges: badgesResult }),
      ...(calendarSample === undefined ? {} : { calendar: calendarSample }),
      /*
       * 壳那一格。2026-10-03 多带一样:**这一刻电脑锁着屏没有**(卡「锁屏时窗口型的家送不进」)——
       * 出处是那一拍问来的(`screenLock.locked()`),`undefined` = 不知道 → **这一格就不摆**
       * (不许把「不知道」显示成「没锁」)。
       */
      ...(helper === undefined ? {} : { helper: { ...helper.view(), ...(screenLockedNow === undefined ? {} : { screen_locked: screenLockedNow }) } }),
      ...(scenesList === undefined ? {} : { scenes: scenesList }),
      /**
       * 模块标题:模板给的那一份**之上再盖一层用户自己起的名字**(2026-09-22)。
       *
       * 盖在这里而不是客户端,是因为客户端 `titleOf(id)` 早就只读 `/state.template.module_titles`
       * 一处(见 client/Workbench.tsx)—— 服务端把两份并好,客户端一行都不用改,
       * 也不会出现"某个组件记得叠、某个组件忘了叠"。
       */
      ...(template === undefined ? {} : { template: withLayoutTitles(template.view(), layout) }),
      /**
       * 今天的待办(2026-10-12):看板事项按 `due` 切出来的今天那一刀(src/todayTodos.ts)。只在摆了
       * 「今天的待办」那一格的模板下;「今天」按电脑本机时钟(`base.now`),手机在别的时区也看同一天。
       * 判据(2026-10-23,分层二刀二):当前模板解析出来的排布里有没有 id 'today' 的模块 ——
       * 不再硬编码 'ops',用户层加的别的模板摆了那一格就有。电脑那一格与手机事项页都读这一份。
       */
      ...(template === undefined || tasksState === undefined
        || ![...template.current().portrait, ...template.current().landscape].some(one => one.id === 'today')
        ? {}
        : { today_todos: todayTodosOf((shownTasks ?? tasksState).tasks, localDayOf(new Date(base.now)), layout?.today_view ?? 'flat') }),
      ...(modulesList === undefined ? {} : { modules: modulesList }),
      ...(userLayerView === undefined ? {} : { user_layer: userLayerView }),
      ...(devTool === undefined ? {} : { dev_tool: { pending: devTool.store.pending() } }),
      ...(layoutAsk === undefined ? {} : { layout_ask: { pending: layoutAsk.pending() } }),
      // 进化循环（2026-09-22）。view() 同步、只读内存（同 layoutAsk）。
      ...(evolve === undefined ? {} : { evolve: evolve.view() }),
      ...(xhs === undefined ? {} : { xhs: xhs.view() }),
      // 采集器(2026-09-23,用户层)。同步、只读内存(清单在每次增删采之后刷新)。
      ...(collectors === undefined ? {} : { collectors: collectors.view() }),
      // 采集类(2026-09-22)。没接就整块缺席 —— 界面据此连入口都不出。
      ...(collect === undefined ? {} : { xhs_collect: await collect.view() }),
      ...(meetingsView === undefined ? {} : { meetings: meetingsView }),
      ...(callsView === undefined ? {} : { calls: callsView }),
      ...(snap === undefined ? {} : { snap }),
      ...(appsList === undefined ? {} : { apps: appsList }),
      ...(dockView === undefined ? {} : { dock: dockView }),
      ...(briefView === undefined ? {} : { brief: briefView }),
      ...(dailyReport === undefined ? {} : { daily: dailyReport }),
      // 峰谷现算(不进上面那个 Promise.all:它是同步的,也没有 I/O)。每次组装 /state
      // 都重算一遍,所以"12:02 转低谷"永远是当下的——挂在五分钟一轮的额度采集上的话,
      // 12:02 之后还会挂着"高峰"最多五分钟。时区取本机(设计-借鉴功能落位 §二)。
      ...(peakSchedule === undefined
        ? {}
        : {
            deepseek_peak: {
              ...peakPhase(new Date(), peakSchedule.get()),
              periods: peakSchedule.get().periods,
            },
          }),
      ...(usage === undefined ? {} : { usage: usage.view() }),
      // 看板那一块同时带两样(2026-09-09 两条线并入):**冲刺上的排期风险**(risked.tasks
      // 里换过 sprints 的那一份)与**按会话算的本卡消耗**。两者互不相干,各自缺省时
      // 各自缺席——不能因为其中一条算不出就把另一条也吞掉。
      ...(tasksState === undefined
        ? {}
        : {
            tasks: {
              ...(shownTasks ?? risked?.tasks ?? tasksState),
              ...(sessionUsage === undefined ? {} : { session_usage: sessionUsage }),
              // 总开关关着时整块不合并:目标 / 工作室 / 跨机 / 头像 / 事项类型都不进 /state。
              ...(collabEnabled ? await collabStateOf(tasksState, base.sessions, projectsState?.projects ?? [], base.now) : {}),
            },
          }),
      ...(notesList === undefined ? {} : { notes: notesList }),
      ...(butlerView === undefined ? {} : { butler: butlerView }),
      ...(connectorView === undefined ? {} : { connector: connectorView }),
      // list() 同样是同步的,不进上面那个 Promise.all。
      ...(sentinel === undefined ? {} : { sentinel: { watches: sentinel.list() } }),
      /**
       * 事项收件箱里「事务官交给我」那一半(2026-09-10)。**现拼不落盘**——四个来源
       * (等我确认的卡 / 等着的 DSH 会话 / 哨兵命中 / 排期赶不上)在这一拍里都已经取好了,
       * 这里只是把它们翻成可渲染的条目(server/butlerInbox.ts 是纯函数,不碰 I/O)。
       * **字段恒在**:空列表本身就是"这会儿事务官没什么要找你"的真话,不是缺省。
       */
      execution: executionOverview(tasksRaw?.tasks ?? [], tasksRaw !== undefined && !base.stale,
        // 在跑数从任务日志现算(与 GET /collab/runs 同一函数同一本账;2026-10-29 改口,见 executionState)。
        // 整本一次取回按卡分组(与 /collab/capacity 同一路),不逐卡 events() —— 读预算用例钉着每拍防御副本次数。
        // ★ 按拍缓存(8791 第六轮):同一账代数(revision)+ 同一秒(同一拍)内,同一张卡只算一次 ——
        // /state、广播、live 几秒里各 composeState 一遍,runSegmentsOf 不再每张卡每遍重算。
        (() => {
          const byJob = new Map<string, JobEvent[]>()
          for (const event of jobLog.all()) byJob.set(event.job, [...(byJob.get(event.job) ?? []), event])
          const nowMs = Date.parse(base.now)
          const revision = jobLog.revision?.() ?? -1
          const second = Math.floor(nowMs / 1000)
          if (runsMemoCache === undefined || runsMemoCache.revision !== revision || runsMemoCache.second !== second) {
            runsMemoCache = { revision, second, results: new Map() }
          }
          return (task: TaskView): readonly RunSegment[] => {
            const cached = runsMemoCache!.results.get(task.id)
            if (cached !== undefined) return cached
            const computed = runSegmentsOf(task.id, byJob.get(task.id) ?? [], nowMs, task)
            runsMemoCache!.results.set(task.id, computed)
            return computed
          }
        })()),
      butler_inbox: deriveButlerInbox({
        ...(tasksState === undefined ? {} : { tasks: shownTasks ?? risked?.tasks ?? tasksState }),
        sessions: base.sessions,
        // 「执行中」的事项数(2026-09-16 口径统一)要看那家在不在线、快照冻没冻结。
        // 卡 HC:与 /state.agents 同一份(没装的那家不该在这里贡献计数)。
        agents: agentsShown,
        stale: base.stale,
        ...(sentinel === undefined ? {} : { sentinel: sentinel.list() }),
        ...(projectsState === undefined ? {} : { projects: (risked?.projects ?? projectsState).projects }),
        // 例程开口那一档(2026-09-15):view() 同步、只读内存,不进上面那个 Promise.all。
        ...(routines === undefined ? {} : { routines: routines.view() }),
        // 资讯里「要跟进」那一档(2026-09-21):followUps() 同样同步、只读内存。
        ...(feed === undefined ? {} : { feed: feed.followUps() }),
        // 选题建议那一档(2026-09-22 卡 ③):同样同步、只读内存。运营模板之外恒为空。
        ...(feed === undefined ? {} : { topics: feed.topicSuggestions() }),
        // 最近一次会议那一档(2026-09-21)。上面已经取好了,这里只是喂给纯函数。
        ...(meetingsView === undefined ? {} : { meetings: meetingsView }),
        // 固化提议那一档（2026-09-22）。同样同步、只读内存。
        ...(evolve === undefined ? {} : { evolve: evolve.view().pending, evolve_notices: evolve.view().notices }),
        // 上一次「改自己」重启之后那一句收尾(2026-09-23)。取值函数,没有上一版待确认时回 undefined。
        ...(shipFollowUp?.() === undefined ? {} : { shipFollowUp: shipFollowUp() }),
        // 手机发来的文件(2026-09-25,卡 J):传输流水同步、只读内存。
        ...(deviceDirectory === undefined ? {} : { transfers: deviceDirectory.transfers() }),
        // Agent 登记表的外层那一句(卡 Q):拿不准的问一句、新接上的说一句。
        ...(agentView === undefined ? {} : { agentRegistry: agentView }),
        // 新学到一条(2026-10-10):试用中、还没告诉过她的那几条。同步、只读规矩表。
        ...(options.habits === undefined ? {} : { habits: options.habits.notices() }),
        // 剩余额度告警那一档(2026-10-23,卡 t-8e617888):与 agent_quota 同一份统一视图算出来,
        // 只是工作台消息 —— 不进「等你」、不触发来电(同 habit 那一档的纪律)。
        ...(quotaAlertItems.length === 0 ? {} : { quotaAlerts: quotaAlertItems }),
        // 额度活用建议那一档(2026-10-28,卡 t-f68365f6):同一纪律,只是工作台消息,只提议不自动派。
        ...(quotaSpendItems.length === 0 ? {} : { quotaSpendTips: quotaSpendItems }),
        now: base.now,
      }),
      // Agent 登记表(2026-09-25,卡 Q)。view() 同步、只读内存(读窗口在它自己的节拍里做,不挂在 /state 上)。
      ...(agentView === undefined ? {} : { agent_registry: agentView }),
      ...(routines === undefined ? {} : { routines: routines.view() }),
      // 进度核对此刻的样子(2026-09-25,卡 N):上一轮、花了多少、读不读得了各家会话。
      ...(progressService === undefined ? {} : { progress: progressService.runState() }),
      /**
       * 座机主动来电的台账(2026-09-21)。**只带最近 {@link STATE_CALL_OUT_MAX} 通**:
       * 这份快照每秒都在发给手机与展示台,整本台账(最多 200 通)塞进来是白花的带宽;
       * 要看全本去 `GET /call/log`。未接数 `missed` 是**整本**的,不受这一刀影响 ——
       * 界面上「未接来电 3」必须是真的 3。
       */
      ...(callOut === undefined
        ? {}
        : { call_out: (() => { const view = callOut.view(); return { ...view, entries: view.entries.slice(0, STATE_CALL_OUT_MAX) } })() }),
      /**
       * **此刻能不能出声**(2026-09-26,卡 QH)。一处判断,谁要出声谁读它 ——
       * 手机的朗读、展示台的铃、提示音全看这一格,**没人再自己算一遍时段**。
       *
       * 时段那两格本来就住在 `/call/config` 里(座机的免打扰),所以这里跟着座机服务走;
       * 注意它**不看座机开没开**(`config.enabled`):他把座机关了不等于半夜可以念东西给他听。
       * 没接座机服务时整格缺席 —— 缺席按「能出声」算(同 `inQuietHours` 读不出来就不静音的纪律)。
       */
      ...(callOut === undefined
        ? {}
        : { quiet: (() => { const c = callOut.config(); return quietViewOf({ at: new Date(base.now), from: c.quiet_from, to: c.quiet_to }) })() }),
      // 手机与设备(2026-09-11):开关状态与已配对设备列表。**配对码不在这里**——它只在
      // GET /state 对回环来源单独拼上,这份 composeState 还要广播给 /live 上的手机与展示台。
      ...(lan === undefined ? {} : { lan: lanView() }),
      ...(lan?.name === undefined ? {} : { workbench: { name: lan.name } }),
      ...(devicesList === undefined ? {} : { devices: devicesList }),
      ...(onboarding === undefined ? {} : { onboarding: onboarding.view() }),
      ...(me === undefined ? {} : { me }),
      // 引导落地那张单子(2026-09-24 晚):电脑首页球下面与手机「等你确认」都画它。没排过就缺席。
      ...(materialize?.view() === undefined ? {} : { materialize: materialize.view() as NonNullable<WorkbenchState['materialize']> }),
      // 外观版本(2026-09-16):没存过就缺省,前端据此决定要不要重新拉 /butler/appearance。
      ...(appearanceVersion === undefined ? {} : { appearance_version: appearanceVersion }),
      // 认请求号(2026-10-12):手机据此才自动补发没送到的那几句(server/clientKeys.ts)。
      client_keys: true,
      /**
       * 登录台(2026-09-17):**读上一次体检的结论,顺手触发一次节流过的重检**。
       * 界面每秒轮询 /state,而一次体检要跑十几条子命令 —— 挂在这里同步做就是每秒十几个
       * 子进程。同 pumpSentinel / codexReconcile 那条"请求驱动 + 内部限频"的老规矩。
       * 还没体检过时这一格**缺席**(而不是猜一个 false):壳据此不弹初始化页,等第一次
       * 体检出来再说。
       */
      ...(setupRequiredNow() === undefined ? {} : { setup_required: setupRequiredNow() as boolean }),
      /**
       * 热更新(2026-09-18)。同一条老规矩:**读上一次检查的结论,顺手泵一拍**(内部一天
       * 才真查一次)。有新版时齿轮上打一个点 —— **不弹窗**,Ben 要的是一颗按钮,不是被打扰。
       * 没查过时整格缺席(不编一个 false)。
       */
      ...(updateNow() === undefined ? {} : { update: updateNow() as NonNullable<ReturnType<typeof updateNow>> }),
      /**
       * 手机端的新包(2026-09-18)。电脑这边查到清单里带着 apk 就把地址与大小转给手机看,
       * **电脑不下载它** —— 手机自己从同一个地址下,装还是走系统那一套(我们装不了别人的手机)。
       */
      ...(updateApkNow() === undefined ? {} : { update_available_apk: updateApkNow() as NonNullable<ReturnType<typeof updateApkNow>> }),
      /**
       * 云上那份手机包在哪(2026-09-18「包一律放阿里云」)。跟上面那一格的区别是**不比版本**:
       * 那一格说「有新的」,这一格说「那个包在哪」—— 手机端设置里「重新下载手机包」用它
       * (装坏了、换手机了,跟有没有新版没关系)。**只读缓存,不联网**:/state 每拍都会过这里。
       */
      ...(phoneApkNow() === undefined ? {} : { phone_apk: phoneApkNow() as NonNullable<ReturnType<typeof phoneApkNow>> }),
      /** 手机才显示的那几格从哪一版起有(2026-10-09):手机据此判断自己是不是该更新了。 */
      phone_cells: PHONE_CELLS,
      /**
       * 各家客户端扫到没有、接上没有(2026-09-17「每个区域单独解锁」)。跟 setup_required
       * 同一条老规矩:**读上一轮的结论,顺手触发一次节流过的重扫**(一轮五条 mdfind,
       * 挂在一秒一拍的 /state 上同步跑就是每秒五个子进程)。没扫过时这一格缺席,
       * 前台照今天那样全都显示 —— 空着的界面比多一格更吓人。
       *
       * 「接上没有」= **钩子在不在**(2026-09-17 Ben 拍板),不再掺"本次运行收到过事件"。
       */
      ...(clientsNow() === undefined ? {} : { clients: clientsNow() as NonNullable<ReturnType<typeof clientsNow>> }),
      ...(modelModeNow() === undefined ? {} : { model_mode: modelModeNow() as 'relay' | 'own' }),
      // 这台接没接中转(零服务器档 = false):手机、展示台与界面据此说「这台没接中转」。没接 modelMode 时缺席 = 不知道。
      ...(modelMode?.relayConfigured === undefined ? {} : { relay_configured: modelMode.relayConfigured() }),
      // 有额度的四家接没接上(2026-09-25):同一份 clients / quota / model_mode 现算,球下面那张卡与引导落地照念。
      ...(quotaConnectNow(base.quota) === undefined ? {} : { quota_connect: quotaConnectNow(base.quota) as NonNullable<ReturnType<typeof quotaConnectNow>> }),
      // 派活的眼睛(卡 O):六家各三格(命令行登没登按 10 分钟节流在后台重查,不拖 /state)与每件事的上限配置。
      ...(agentCaps === undefined ? {} : { agent_caps: (agentCaps.pump(), agentCaps.view()) }),
      // 能接活的每一家的额度(卡 O):三格之一(有数 / 不限 / 没接上:原因)。窗口上读的那几家按 10 分钟节流在后台读;
      // 开集那几家(卡 QO)同样 10 分钟一轮,**认出来之后只用上次命中的那几条正则重读、不再叫模型**。
      /*
       * ★ **10 分钟那一轮真的接上了**(2026-10-03,卡 QZ)。
       *
       * `pump` / `pumpOpen` 从 2026-09-27(卡 AG 把定时改成事件触发)起**一处都没有人叫** ——
       * 于是唯一的自动重读路是「她从那家切走」(`nudge`)与「她切回工作台」(`catchUp`)。
       * 现场的后果 10-03 现形了:Manus **没在跑**,她永远不会从它切走,那一格就停在 10-01;
       * 豆包 / Muse / Grok Bot 被窗口槽藏着,自动那几路又一律不放出来读,于是停在 09-26。
       * 这一行把兜底那一轮接回来(10 分钟,节流在读数器自己身上),整条链见 `agentQuota.ts` 的 `readOne`:
       * 她在用就不碰 → 没在跑就后台起它、藏回去 → 放出来读 → 读完藏回去。
       * (泵与读取 2026-10-23 起挪到上面与告警共用那一拍:`quotaViewsNow`,行为不变。)
       */
      ...(quotaViewsNow === undefined ? {} : { agent_quota: quotaViewsNow }),
      ...(options.itemBudget === undefined ? {} : { item_budget: options.itemBudget.store.get() }),
      // 「先问我」那一档在等批准的操作(2026-09-24)。一条都没有时不读看板。
      ...(approvals === undefined ? {} : { approvals: await approvalsNow() ?? [] }),
      // 她在 DSH 会话里问他的话、「这件事里同类的都允许」那几条(2026-09-25,卡 M)。
      ...(questions === undefined ? {} : { questions: await questionsNow() }),
      ...(approvalGrants === undefined ? {} : { approval_grants: await grantsNow() }),
      ...(composerNow() === undefined ? {} : { composer: composerNow() as NonNullable<WorkbenchState['composer']> }),
      // 顶上那两条横幅(2026-09-17):同一份上一次体检的结论,同样"没查过就缺席"。
      ...(alertsNow === undefined ? {} : { setup_alerts: alertsNow }),
      // 三件主路与实验开关(2026-10-21,卡「引导三件事」):第一次有用那一屏、首页「现在能做什么」、设置那一节读它。
      ...(await firstUseStateNow()),
      paused,
      test_ringing: testRinging,
      ringing: activeRings(),
    }
    /**
     * 「等你」的那一堆(2026-09-25,卡 M 追加;维护者硬规矩「同一件事的数字各处一致」):从上面这一整份现算,
     * 电脑球下、「事务官」标签、手机「等你确认」都读这一格(src/waiting.ts)。
     *
     * 「此刻有几件在跑」(2026-09-25,卡 V,同一条规矩):舞台「正在执行 n」、球下「执行 n」、
     * 窗口槽标签气泡、汇报条「运行会话 n 个」、手机首页**都读 `running` 这一格**(src/running.ts)。
     * 页面上最近出的几个错也挂在这里 —— 设置里看得到,`curl /state` 查得到。
     */
    // 她和别家说的话在这里统一洗掉 markdown 记号(卡 M 补:「**B**」原样露出了 `**`),再算「等你」那一堆。
    const shown = stateForHim(composed)
    const running = runningNow(shown)
    const inbox = shown.butler_inbox === undefined ? undefined : { ...shown.butler_inbox }
    if (inbox !== undefined) {
      if (running.count === undefined) delete inbox.executing
      else inbox.executing = running.count
    }
    // 卡 V(2026-09-25):「执行 n」与「等你 n」一样,从这**同一份洗过的快照**现算一次,各处都读它。
    const settled = {
      ...shown,
      ...(inbox === undefined ? {} : { butler_inbox: inbox }),
      waiting: waitingOnHim(shown),
      running,
      client_errors: clientErrors.list(),
      /**
       * ★ **答案来找她那两格**(2026-10-04,卡 `claude/answer-comes-to-her`):
       * 「问一句」的回答(字幕 / 事务官页那一处 + 通知正文)与「刚办完 · 结果一句话」。
       * **一处算、两端只显示**,判据全在 `src/answerCell.ts`。
       */
      // 时钟取 service 那一份(同「排期风险」那一处的理由:测试注入的假时钟才管得住这两格);
      // 那一格读不出来(不该)才退回真时钟 —— 宁可用真时钟,也不能让这两格算成空的。
      answers: answersCellOf(directAnswers.list(), Date.parse(shown.now) || Date.now()),
      fresh_results: freshResultsOf(shown, Date.parse(shown.now) || Date.now()),
    }
    /**
     * 球此刻的样子(2026-10-04,卡「球的颜色一处算」):**一处算、两端只显示**。
     * 排在最后 —— 它要读上面刚算好的 `waiting` 与 `running`(「同一件事的数字各处一致」那条规矩,
     * 球下「受阻 N」、球的颜色与那两个数同源)。判据全在 `src/orbCell.ts`。
     */
    const composedNow = { ...settled, orb: orbCellOf(settled) }
    // 按拍缓存入库:组装期间没有任何写作废(广播/非 GET 会 +epoch),这份结果本拍内直接复用。
    // 键里的快照引用用落地后的那份 —— awaitFresh 等到新拍时,旧引用作键会让下一拍永远失中。
    if (epochAtStart === composeEpoch) {
      composeCache = { epoch: epochAtStart, beat: cacheBeat, version: cacheVersion, snapshot: reconciled, state: composedNow }
    }
    return composedNow
  }

  /**
   * composeState 里那一格的取数(2026-09-17)。跟 setupRequiredNow 一个写法:泵一拍、读快照。
   *
   * 2026-09-17 改:**不再掺事件证据**(Ben 拍板「钩子在就算」)。原先这里会把
   * `AgentView.connected`(本次运行收到过上报)当成第二条证据喂进去 —— 去掉之后,
   * 「接上没有」只由配置文件里那几条钩子说了算,跨重启稳定,而且跟「代写钩子」那颗按钮
   * 一一对应(理由写在 clientScan.ts 头部)。
   */
  function clientsNow(): ClientsView | undefined {
    if (clientScan === undefined) return undefined
    try {
      clientScan.pump()
      return clientScan.view()
    }
    catch {
      // 扫描自己坏了不能连累 /state —— 这一格缺席,界面照旧。
      return undefined
    }
  }

  /**
   * **本机装了哪几家 AI**(2026-09-27,卡 HC)。与 `clientsNow` 一个写法:泵一拍(内部限频)、读上一次的结论。
   * 探测自己坏了 / 没注入 → 缺席,上层退回"全都显示"。
   */
  function installedAgentsNow(): InstalledAgentsView | undefined {
    if (installedAgents === undefined) return undefined
    try {
      installedAgents.pump()
      return installedAgents.view()
    }
    catch { return undefined }
  }

  /**
   * **他嘴里那一家可能是哪几家**(2026-09-28,卡 FX):认家名的候选表。
   *
   * 只取**本机真装的那几家**(`installed_agents`,卡 HC)+ 此刻真有会话的那几家 ——
   * 没装的家被"认出来"只会得到一句「它没有在跑的对话」,而他根本没提它。
   * 探测那一格缺席时 `spokenFamilies` 自己退回知识表(D13:查不到不等于没有)。
   */
  function spokenFamiliesNow(): readonly SpokenFamily[] {
    const base = spokenFamilies({
      installed: installedAgentsNow()?.agents,
      agents: service.getState().sessions.map(one => one.agent),
    })
    /**
     * **登记表里运行时发现的那几家也要能被点名**(2026-09-28,卡 WR 接卡 FX)。
     *
     * 卡 FX 的候选只有探测到的那几家(家名写在 `DISPATCH_FAMILY_TITLES` 里),而 Grok Bot /
     * Antigravity 这类是运行时判出来的、id 就是包标识 —— 不补进来,「Grok Bot 那条…」
     * 在**认家**那一步就落空,于是退回全池打分,又回到卡 FX 修掉的那个病。
     *
     * 已经在表里的那几家(豆包 / Manus / Muse…)**不重复添**:它们的会话按家名筛得到
     * (`relayAgentName` 把包标识换成了那一家的正名)。同名的也不添 —— 两条同名候选会让
     * `matchSpokenFamily` 判成「两家都像」,那还不如没有。
     */
    let extras: SpokenFamily[] | undefined
    try {
      const seen = new Set(base.map(one => one.title.trim().toLowerCase()))
      for (const entry of agents?.view().entries ?? []) {
        if (entry.self === true || entry.bundle_id === undefined) continue
        if (bindingForBundle(entry.bundle_id) !== undefined) continue
        const title = entry.name?.trim()
        if (title === undefined || title === '' || seen.has(title.toLowerCase())) continue
        seen.add(title.toLowerCase())
        ;(extras ??= []).push({ id: entry.id, title })
      }
    }
    catch { /* 登记表读不出来只是少几家候选,认家照旧按探测那一份 */ }
    return extras === undefined ? base : [...base, ...extras]
  }

  /**
   * **界面上该出现哪几家**(2026-09-27,卡 HC)。`/state.agents` 与 `/state.quota` 都过这一道。
   *
   * 探测之外还留两种:此刻真有会话的那一家(它在说话,装在非标准位置也算)、
   * 登记表里已经接上的那一家(判过、接过,不能因为 Spotlight 索引不到就消失)。
   */
  function shownAgentsOf(base: ReturnType<typeof service.getState>): readonly AgentId[] {
    const installed = installedAgents?.installedIds()
    if (installed === undefined) return AGENT_IDS
    const extras = new Set<string>(base.sessions.map(one => one.agent))
    try {
      for (const entry of agents?.view().entries ?? []) extras.add(entry.id)
    }
    catch { /* 登记表读不出来只是少一层兜底,不影响探测那一份 */ }
    return shownAgentIds(AGENT_IDS, installed, extras)
  }

  /**
   * 热更新那一格:先泵一拍(内部一天一次),再读上一次的结论。
   *
   * 2026-09-26 起还顺手泵一拍**运行环境漂移**(内部一分钟一次,只读本机的运行时目录)——
   * 它是 `update.lastCheck()` 里 `runtime_stale` 那一格的来源,而且**跟联网无关**:
   * 09-26 那台机器要看见的正是这一句,而它「检查更新」一直说没有新版。
   */
  function updateNow(): ReturnType<NonNullable<typeof update>['lastCheck']> {
    try { runtimeRepair?.pump() }
    catch { /* 探漂移自己坏了不能连累 /state */ }
    if (update === undefined) return undefined
    try {
      update.pump()
      return update.lastCheck()
    }
    catch {
      // 查更新自己坏了不能连累 /state —— 这一格缺席,界面照旧。
      return undefined
    }
  }

  /** 手机端新包那一格。**不泵** —— updateNow 每拍已经泵过了,这里只读同一份结论。 */
  function updateApkNow(): ReturnType<NonNullable<typeof update>['apk']> {
    if (update === undefined) return undefined
    try { return update.apk() }
    catch { return undefined }
  }

  /** 云上那份手机包在哪。同样**不泵、不联网**,只读缓存着的那份清单。 */
  function phoneApkNow(): ReturnType<NonNullable<typeof update>['cloudApk']> {
    if (update === undefined) return undefined
    try { return update.cloudApk() }
    catch { return undefined }
  }

  /**
   * 顶上那几条横幅那一格。**不泵** —— setupRequiredNow 每拍已经泵过了,这里只读同一份结论。
   *
   * 两个来源,各说各的一格(2026-09-18 多了第三格):
   * - 体检(setup.alerts):辅助功能、DeepSeek 密钥;**没体检过时那两格缺席**;
   * - 自动接模型服务(modelAutoSetup.alert):试过、没成才为真;没试过 / 不归它管时缺席。
   *
   * 所以这里是**逐格合并**,不是"哪边有就用哪边整块":一边还没有结论的时候,
   * 另一边已经有的那一格照样要说出来 —— 把它一起吞掉就是让人对着一个空横幅等。
   * 而"缺席"与"false"的区别一路留到界面:没查过不是没缺(同 setup_required 的老规矩)。
   */
  function setupAlertsNow(): WorkbenchState['setup_alerts'] {
    let base: ReturnType<NonNullable<typeof setup>['alerts']>
    try { base = setup?.alerts() }
    catch { base = undefined }
    let modelMissing: boolean | undefined
    try { modelMissing = modelAutoSetup?.alert() }
    catch { modelMissing = undefined }
    if (base === undefined && modelMissing === undefined) return undefined
    return {
      ...(base ?? {}),
      ...(modelMissing === undefined ? {} : { model_service: modelMissing }),
    }
  }

  /** 四家接没接上(2026-09-25)。clients 没扫过 → undefined(整格缺席)。 */
  function quotaConnectNow(quota: WorkbenchState['quota']): WorkbenchState['quota_connect'] {
    try {
      return quotaConnectStatus({ clients: clientsNow(), quota, model_mode: modelModeNow() })
    }
    catch { return undefined }
  }

  function modelModeNow(): 'relay' | 'own' | undefined {
    if (modelMode === undefined) return undefined
    try {
      modelMode.pump()
      return modelMode.view()
    }
    catch { return undefined }
  }

  /**
   * **中转上配了哪几家上游**(2026-09-26,卡 GH)。同 `modelModeNow` 那一套:
   * 请求驱动、内部限频(10 分钟问一次 `/health`),取不到就是上次那份。
   *
   * 没注入 / 从没问到过 → `undefined`,调用方当「一家都没配」:只走接口那只手的那几家
   * (今天 = GPT)一处都不出现。**宁可少一家,不摆空壳**。
   */
  function relayProvidersNow(): RelayProvidersView | undefined {
    if (relayProviders === undefined) return undefined
    try {
      void relayProviders.pump()
      return relayProviders.view()
    }
    catch { return undefined }
  }

  /**
   * 语音后端(butler-server,本机 8792)**从在跑变成不在跑**那一下(2026-09-22)。
   *
   * ## 为什么用「状态翻转」而不是让它自己报
   *
   * 卡上写的是「插件/工人/语音后端捕到未处理错误…… 上报」。工人那一头做得到
   * (它的看护就在插件里,见 channelWorker 的 onCrash);语音后端做不到:
   * 它是 launchd 拉起来的**另一个进程**,手上没有设备令牌,也没有一条通往中转的路。
   * 让它长出这条路要给它一份凭据 —— 那跟这张卡"凭据不外流"的主题正好相反。
   *
   * 所以这里用插件**已经在做**的那件事:`/state.butler` 每拍探一次它的 `/health`
   * (3 秒缓存)。从 true 变 false 的那一下就是"它挂了",报一条 `crash_restart`。
   * 它的报错原文进不了这条路,但**进得了诊断包**(`~/.dsh/logs/butler.stderr.log`),
   * 上报里那句话会明说"去看那份日志"。
   *
   * **只报翻转,不报持续**:它一直没起来(没装、被关掉)不是故障,
   * 每拍报一条会把这条路刷爆。
   */
  let butlerWasRunning: boolean | undefined
  function noteButlerHealth(running: boolean): void {
    const previous = butlerWasRunning
    butlerWasRunning = running
    if (previous !== true || running) return
    /**
     * ★ **先问一句「是不是我自己慢」**(2026-10-19,卡「插件内存增长与 GC 抖动」)。
     * 本进程事件循环 p99 比探测超时还长时,这一次「探不到」分不清是它挂了还是我没来得及收回包 ——
     * 10-19 真机那 12 条误报就是这么来的(8792 一直活着)。那时不报;`butler.ts` 接了同一只手时
     * 根本翻不到这里(它沿用上一次的结论),这一道是给没接那只手的旧接线兜底。
     */
    const loopP99 = processHealth?.loopP99Ms()
    if (loopP99 !== undefined && loopP99 > BUTLER_PROBE_TIMEOUT_MS) return
    void diag?.report({
      component: 'butler',
      kind: 'crash_restart',
      message: '语音后端(8792)刚才还在跑,这会儿探不到了 —— 通话会没有声音。',
      log: ['原因看 ~/.dsh/logs/butler.stderr.log(诊断包里带着它)'],
    })
  }

  /** composeState 里那一格的取数:先泵一拍(内部限频),再读上一次的结论。 */
  function setupRequiredNow(): boolean | undefined {
    // 诊断那一摊的后台活(收拾日志 + 把攒着的合并上报发出去)也挂在这一拍上,
    // 内部各自限频 —— 同 setup.pump / pumpSentinel 那条"请求驱动 + 内部限频"的老规矩。
    try { diag?.pump() }
    catch { /* 收拾日志坏了不能连累 /state */ }
    if (setup === undefined) return undefined
    try {
      setup.pump()
      return setup.setupRequired()
    }
    catch {
      // 体检自己坏了不能连累 /state —— 这一格缺席,界面照旧。
      return undefined
    }
  }

  /**
   * 布局快照落盘走一拍(2026-09-10)。挂在既有 tick 上、不起定时器,**到点之前不组装
   * state**——read 是回调,服务只在真要生成时才调它(composeState 会顺手做项目区/哨兵
   * 那些活,不能每秒白跑一遍)。
   */
  function pumpLayoutSnapshot(): void {
    layoutSnapshot?.pump(async () => snapshotInputOf(await composeState()))
  }

  const loginProfileDir = (provider: string): string =>
    `${credentialFile.replace(/\/[^/]*$/, '')}/login-profile-${provider}`

  function stopLoginLoop(): void {
    if (loginTimer !== undefined) clearInterval(loginTimer)
    loginTimer = undefined
  }

  /**
   * 拿这份凭据真读一次额度——**这才是"登录成功"的判定**。
   * 按 cookie 名判断那条路真机上是错的：Ben 登录完了界面还说未登录。
   */
  async function validateAndSave(provider: 'kimi_web', refreshToken: string): Promise<string> {
    // 读得到才算数；读不到就把原因如实报出来（错误里已经抹过凭证）。
    // 这一步会走一次续期，服务端顺带换发新的 refresh token——存那个新的，别存刚抓到的旧值。
    let toSave = refreshToken
    await fetchKimiWebUsageWithRefresh({
      refreshToken,
      fetch: (url, init) => globalThis.fetch(url, init),
      onRefreshed: (rotated) => { toSave = rotated },
    })
    await saveCredential(credentialFile, provider, toSave)
    // 「Kimi 接上没有」按凭据里有没有 kimi_web 判(clientScan.ts):刚存进去就让探测作废,
    // 不然额度面板与球下面那张卡还要挂着「Kimi 要你自己登一次」最多一分钟(2026-09-25)。
    clientScan?.invalidate()
    // 8791 第六轮第 4 轮:登录状态改「能不能读这家」 —— 触发对账(2 秒事件节拍内重读各来源)。
    reconcileExecutions?.notifyChanged()
    // 这条路只会**存**一份刚验过的凭据,清空走不到这里(cleared 恒为 false)。
    await onCredentialsChanged?.({ provider, cleared: false })
    // 走 composeState() 而不是 service.getState()：WS snapshot 是整体替换，
    // 漏了这一步会让展示台在这次推送里把 projects/machine/paused 全部丢掉。
    broadcast({ kind: 'snapshot', state: await composeState() })
    return '登录已接上，额度已读到'
  }

  /**
   * 抓一次并判定。成功/失败都写进 loginProgress，绝不带 cookie。
   * 单飞(2026-09-07):每次抓取要在窗口里等最多 20 秒,而定时器每 5 秒来一次——原来
   * 会叠出四五个并发的抓取,各自对着同一个登录窗口发号施令(那时每个还会导航一次,
   * 二维码页就被刷个不停)。上一轮没结束就跳过这一轮。
   */
  let captureInFlight = false
  async function tryCapture(): Promise<void> {
    const session = loginSession
    if (session === undefined || captureInFlight) return
    captureInFlight = true
    try {
      const token = await captureRefreshToken(session.profileDir, LOGIN_TARGETS[session.provider])
      const message = await validateAndSave(session.provider, token)
      stopLoginLoop()
      loginProgress = { provider: session.provider, state: 'done', message }
    }
    catch (error) {
      // 还没登完是常态，不当失败；只把最近一次的原因显示出来。
      loginProgress = {
        provider: session.provider,
        state: 'waiting',
        message: `等你在窗口里登录…（${error instanceof Error ? error.message : '还没读到'}）`,
      }
    }
    finally {
      captureInFlight = false
    }
  }
  const { onCredentialsChanged, onQuotaPushed } = options

  /**
   * Claude 额度「一键接上」那一次(2026-10-03,卡「不让用户知道什么叫 setup-token」)。
   *
   * 维护者原话:「你得考虑产品化啊,你不说我咋知道要咋弄啊。」—— 用的人不写代码,不该知道终端。
   * 所以这一格的交互是**一颗键**:工作台自己起 `claude setup-token`、替她把授权链接用默认浏览器打开,
   * 她在浏览器里用自己的账号授权一次(账号密码工作台一个字都不经手),命令打印出来的长期密钥
   * 直接进 0600 的凭据文件,随后立刻采一轮 —— 格子就从「未接入」变成实时。
   *
   * 只留**一次**在飞:重复点「接上」顶掉上一次(同 Kimi 那条登录路的老规矩:
   * 上一个窗口她可能已经关了,不该把人锁死)。
   */
  let claudeConnectRun: ClaudeConnectRun | undefined
  /** 上一次的结局(「接上了 · 本周还剩 81%」/「没成:…」)。重启即忘 —— 那时只剩「已配置」那一行,也是实话。 */
  let claudeConnectLast: ClaudeConnectProgress | undefined

  function claudeConnectNow(): ClaudeConnectProgress {
    const live = claudeConnectRun?.progress()
    if (live !== undefined && live.state !== 'idle') return live
    return claudeConnectLast ?? { state: 'idle', message: '' }
  }

  /**
   * 拿到密钥之后那一步。**密钥到这里就停**:写进 0600 的凭据文件,然后只回一句「本周还剩 81%」。
   * 它不进返回值、不进进度、不进日志、不进 HTTP 回包(`quota/claudeSetupToken.ts` 文件头那条纪律)。
   */
  async function saveClaudeSetupToken(token: string): Promise<string | undefined> {
    await saveCredential(credentialFile, 'claude_api', token)
    // 「Claude 接上没有」按凭据判的那几处(clientScan.ts)要当场作废,不然额度面板还要挂一分钟。
    clientScan?.invalidate()
    reconcileExecutions?.notifyChanged() // 8791 第六轮第 4 轮:能读哪家了变,触发对账。
    // 立刻重采一轮(与设置里粘一串密钥那条路同一只手),再把整份快照推给展示台。
    await onCredentialsChanged?.({ provider: 'claude_api', cleared: false })
    broadcast({ kind: 'snapshot', state: await composeState() })
    // 采到了就把那个数说出来 —— 她按完那一下最想看见的就是它;采不到就只说「接上了」(不编一个数)。
    return claudeQuotaWords(service.getState().quota.claude)
  }

  const clients = new Set<WebSocket>()
  const wss = new WebSocketServer({ noServer: true })

  /** 协作区板的文件:`<工作目录>/协作区/板.canvas`(工作目录与事务官会话同一个,见 `collabWorkdir` 那条注释)。 */
  async function collabCanvasFile(): Promise<string> {
    const injected = await options.collabWorkdir?.()
    if (injected !== undefined && injected !== '') return boardCanvasFile(injected)
    const env = pathsOption?.envButlerCwd ?? setupRepoRoot
    if (env !== undefined && env !== '') return boardCanvasFile(env)
    const configured = (await pathsOption?.config.get().catch(() => undefined))?.butler_cwd
    if (configured !== undefined && configured !== '') return boardCanvasFile(configured)
    return boardCanvasFile(`${pathsOption?.home ?? process.env.HOME ?? ''}/Documents/事务官`)
  }
  /**
   * 定时派活(2026-10-21 协作区全量,`collabTimers.ts`):挂在下面那根既有节拍上,一分钟才看一次。
   * 负责人是这台电脑上能派的那一家时顺手走现有派活(`dispatchItem`,同她点「派给 X」那一条)。
   */
  const collabTimers = !collabEnabled || tasks === undefined ? undefined : createTimerRunner({
    tasks,
    canDispatch: family => isAgentDispatchFamily(family) && isDispatchTarget(dispatchTargetsNow(), family),
    dispatch: async (noteId, family, text) => await dispatchItem(noteId, { family: family as AgentDispatchFamily, text }),
    onChanged: () => { void composeState().then(state => broadcast({ kind: 'snapshot', state })).catch(() => {}) },
  })
  /**
   * 协作区跨机(2026-10-21,`collabRelay.ts`):设备令牌读 model.json(与诊断 / 反馈同一条路),
   * 会话令牌问账号;两样都只进请求头。中转那边一有变化 `relay_tick` +1 并推一拍。
   */
  const relayHome = setupHome
  const avatarHome = options.collabAvatars?.home ?? setupHome
  const collabAvatars = !collabEnabled || avatarHome === '' ? undefined : createAvatarStore({ home: avatarHome })
  const relayLink = options.collabRelay?.link ?? (relayHome === '' ? undefined : async (): Promise<RelayLink | undefined> => {
    const config = await loadModelConfig(`${relayHome}/.dsh/workbench/model.json`)
    let session: string | undefined
    try { session = isServerAccount(account) ? await account.sessionToken() : undefined }
    catch { session = undefined }
    return {
      relayUrl: config.relay_url,
      ...(config.relay_token === undefined ? {} : { deviceToken: config.relay_token }),
      ...(session === undefined ? {} : { sessionToken: session }),
    }
  })
  const collabRelay: CollabRelay | undefined = !collabEnabled || tasks === undefined || relayLink === undefined ? undefined : createCollabRelay({
    link: relayLink,
    ...(options.collabRelay?.fetchImpl === undefined ? {} : { fetchImpl: options.collabRelay.fetchImpl }),
    inboxFile: options.collabRelay?.inboxFile ?? defaultRelayInboxFile(relayHome),
    borrowFile: options.collabRelay?.borrowFile ?? `${relayHome}/.dsh/workbench/collab-borrows.json`,
    tasks,
    canDispatch: family => isAgentDispatchFamily(family) && isDispatchTarget(dispatchTargetsNow(), family),
    dispatch: async (noteId, family, text) => await dispatchItem(noteId, { family: family as AgentDispatchFamily, text }),
    runTimer: async timerId => collabTimers === undefined ? { ok: false, why: '定时派活没接上' } : await collabTimers.runNow(timerId),
    onChanged: () => { void composeState().then(state => broadcast({ kind: 'snapshot', state })).catch(() => {}) },
    log: line => console.log(line),
    // 名片登记到工作室时只带内置 id 或小图;原图不出这台电脑。
    ...(collabAvatars === undefined ? {} : { avatarOf: owner => collabAvatars.shareOf(owner) }),
  })
  // 总开关关着时连那两条跨机长轮询都不起(既有「loop === true」规矩照旧)。
  if (collabEnabled && options.collabRelay?.loop === true) collabRelay?.start()
  const collabRelayRoutes = createCollabRelayRoutes({
    ...(collabRelay === undefined ? {} : { relay: collabRelay }),
    changed: async () => { broadcast({ kind: 'snapshot', state: await composeState() }) },
  })
  const collabAvatarRoutes = createCollabAvatarRoutes({
    ...(collabAvatars === undefined ? {} : { store: collabAvatars }),
    changed: async () => { broadcast({ kind: 'snapshot', state: await composeState() }) },
  })
  // 事项类型表(2026-10-22):`<工作目录>/协作区/事项类型.json`,/state 带整张表。
  const collabWorkTypes = createWorkTypesStore(collabCanvasFile)
  // 总开关关着时整块路由对象都不造:下面三处 handle 判空后直接落到「没这条路由」。
  const collabRoutes = collabEnabled ? createCollabRoutes({
    ...(feed === undefined ? {} : { feed }),
    dispatch: (id, input) => dispatchItem(id, input),
    lanPeerFile: async () => join(dirname(await collabCanvasFile()), '.lan-peers.json'),
    now: () => Date.parse(service.getState().now),
    workTypes: collabWorkTypes,
    ...(collabTimers === undefined ? {} : { timers: collabTimers }),
    ...(options.githubDevice === undefined ? {} : { github: options.githubDevice }),
    ...(options.mcpSecrets === undefined ? {} : { mcpSecrets: options.mcpSecrets }),
    ...(tasks === undefined ? {} : { tasks }),
    presence: collabPresence,
    canvasFile: collabCanvasFile,
    ...(options.personalTokens === undefined ? {} : { tokens: options.personalTokens }),
    // 运行片段与容量只读这本账(2026-10-24 契约 §4);全进程就这一本(index.ts 传进来的那份)。
    jobLog,
    // 8791 第六轮第 3 轮:collab 读路(/collab/runs|trace|capacity|note/activity)不再触发对账,
    // 只读上一次对账快照(0.4.188 真机:这些读每拍一次把对账连轴转)。对账只由任务账写事件
    // (notifyChanged,两拍 ≥2 秒)+ 30 秒到期驱动。原 refreshExecutionFacts 接缝整个拆掉。
    // 名片勾技能的校验(2026-10-22,卡「用户层技能生效」B):本体 ∪ 用户层,两边都查。
    skillNames: async () => [...DISPATCH_SKILLS, ...(await userLayerSkillsNow()).map(one => one.id)],
    changed: async () => {
      itemDriver?.kick()
      broadcast({ kind: 'snapshot', state: await composeState() })
    },
  }) : undefined

  /**
   * 协作区那几格现算(2026-10-21):目标上的排期风险(**只在有截止日时**)与「这条会话挂到哪个目标?」。
   * 都不落盘;说过「不挂」的那几条从账上读。
   */
  /** 正在放的那几条(同一条不放两次;/state 每秒都在拼)。 */
  const placing = new Set<string>()
  function placeInto(goalId: string, proposals: readonly SessionProposal[]): void {
    if (tasks === undefined) return
    const fresh = proposals.filter(one => !placing.has(`${one.agent}:${one.session_id}`))
    if (fresh.length === 0) return
    for (const one of fresh) placing.add(`${one.agent}:${one.session_id}`)
    void (async () => {
      for (const one of fresh) {
        const key = `${one.agent}:${one.session_id}`
        try {
          const done = await placeSession(tasks, {
            agent: one.agent, sessionId: one.session_id,
            body: { title: one.title, goal_id: goalId, ...(one.project_id === undefined ? {} : { project_id: one.project_id }) },
          })
          if (done.ok && done.already !== true) await tasks.setPlacedNotice(key, true)
        }
        catch { /* 这一拍没放成,下一拍再来 */ }
        finally { placing.delete(key) }
      }
      broadcast({ kind: 'snapshot', state: await composeState() })
    })()
  }

  async function collabStateOf(state: TasksState, sessions: readonly SessionView[], projectList: readonly WorkbenchProject[], nowIso: string): Promise<Partial<TasksState>> {
    const nowMs = Date.parse(nowIso)
    const goalsRaw = state.goals ?? []
    const risks = Number.isNaN(nowMs) ? {} : goalRisks(goalsRaw, state.tasks, Math.floor(nowMs / 1000))
    const goals = goalsRaw.map(goal => (risks[goal.id] === undefined ? goal : { ...goal, risk: risks[goal.id] as ScheduleRisk }))
    let dismissed: string[] = []
    try { dismissed = (await tasks?.dismissedProposals?.()) ?? [] } catch { dismissed = [] }
    // ★ 删过的会话也不再提出来(2026-10-23,卡「待排的卡不许被派出去」④):与「他说过不挂」
    // 走同一道过滤 —— 不然「这条会话挂到哪个目标?」会一直问一条删过了的会话。
    try {
      const removed = (await tasks?.removedSessionCards?.()) ?? []
      dismissed = [...dismissed, ...removed]
    }
    catch { /* 那张表读不到:只按「他说过不挂」过滤,一字不变 */ }
    const proposed = Number.isNaN(nowMs) ? [] : sessionProposals({ sessions, tasks: state.tasks, goals: goalsRaw, projects: projectList, dismissed, nowMs })
    // 不问的情形(10-22 第三轮 4 维护者定 B + 10-28 任务书 11 维护者 15:0x):只有一个还在推的目标 → 全部放进去;
    // 有多个但提案对得上(标题 / 项目,collabProposals 现算)→ 逐条放进它自己的那个目标。放完下一拍快照里就是那行已办说明,
    // 那行上可换目标 / 不进看板(可撤回)。对不上的才留在「等你」里问她,带默认选项(新目标,名默认会话标题)。
    const onlyGoal = singleOpenGoal(goalsRaw)
    if (onlyGoal !== undefined) {
      if (proposed.length > 0) placeInto(onlyGoal, proposed)
    }
    else {
      for (const one of proposed) {
        if (one.goal_id !== undefined) placeInto(one.goal_id, [one])
      }
    }
    const proposals = (onlyGoal === undefined ? proposed : []).filter(one => one.goal_id === undefined)
    let placedKeys: string[] = []
    try { placedKeys = (await tasks?.placedNotices?.()) ?? [] } catch { placedKeys = [] }
    const placed = placedKeys.flatMap((key): SessionPlaced[] => {
      const task = state.tasks.find(one => (one.links ?? []).some(link => `${link.agent}:${link.session_id}` === key))
      const link = task?.links?.find(one => `${one.agent}:${one.session_id}` === key)
      if (task === undefined || link === undefined) return []
      return [{ agent: link.agent, session_id: link.session_id, title: task.title, task_id: task.id, ...(task.goal_id === undefined ? {} : { goal_id: task.goal_id }), at: task.created_at }]
    })
    // MCP 库每条现算「本机还缺哪几把」(只看名字,值不出这台电脑)。
    let filled = new Set<string>()
    try { filled = (await options.mcpSecrets?.names()) ?? new Set() } catch { filled = new Set() }
    const mcp = (state.mcp ?? []).map(one => ({ ...one, missing: one.secret_names.filter(name => !filled.has(name)) }))
    // 跨机:等我批的借用有几条、中转那边变了几回(界面拿它当该重读 /collab/relay/* 的信号)。
    let relayAsks = 0
    try { relayAsks = (await collabRelay?.askCount()) ?? 0 } catch { relayAsks = 0 }
    let avatars: TasksState['avatars']
    try { avatars = await collabAvatars?.table() } catch { avatars = undefined }
    let workTypes: TasksState['work_types']
    try { workTypes = await collabWorkTypes.read() } catch { workTypes = undefined }
    return {
      goals, session_proposals: proposals, session_placed: placed, mcp,
      ...(workTypes === undefined ? {} : { work_types: workTypes }),
      ...(avatars === undefined ? {} : { avatars }),
      ...(collabRelay === undefined ? {} : { relay_asks: relayAsks, relay_tick: collabRelay.tickCount() }),
    }
  }

  /**
   * 胶囊上那两个字(2026-09-24)。与 clientsNow 一个写法:读上一次的结论,顺手触发一次节流过的刷新
   * (要问 DSH 拿模型表,不该挂在一秒一拍的 /state 上同步跑)。换档 / 换模型之后立刻刷(refreshComposerView)。
   */
  let composerView: WorkbenchState['composer']
  let composerViewAt = 0
  function composerNow(): WorkbenchState['composer'] {
    if (composer === undefined) return undefined
    if (Date.now() - composerViewAt > 30_000) {
      composerViewAt = Date.now()
      void refreshComposerView()
    }
    return composerView
  }
  async function refreshComposerView(): Promise<void> {
    if (composer === undefined) return
    try {
      const choice = await composer.choice()
      let catalog: Awaited<ReturnType<NonNullable<ButlerSessionOpener['catalog']>>>
      try { catalog = await butlerSession?.catalog?.() } catch { catalog = undefined }
      const models = catalog === undefined ? [] : composerModels(catalog)
      const target = choice.model !== undefined && models.some(one => one.provider === choice.model?.provider && one.id === choice.model.id)
        ? choice.model
        : catalog === undefined ? choice.model : { provider: catalog.default.provider, id: catalog.default.model }
      const found = target === undefined ? undefined : models.find(one => one.provider === target.provider && one.id === target.id)
      composerView = {
        mode: choice.mode,
        ...(target === undefined ? {} : { model: { ...target, title: found?.title ?? target.id, images: found?.images ?? false } }),
      }
    }
    catch { /* 读不到就保留上一次的 */ }
  }

  /** 这件事明着选过哪一档(卡上没记 = undefined,老卡)。 */
  async function itemModeOf(itemId: string | undefined): Promise<ComposerMode | undefined> {
    if (itemId === undefined || tasks === undefined) return undefined
    try { return (await tasks.list()).tasks.find(one => one.id === itemId)?.mode }
    catch { return undefined }
  }

  /** composeState 里 approvals 那一格:挂着的审批配上卡。 */
  async function approvalsNow(): Promise<WorkbenchState['approvals']> {
    const pending = approvals?.list() ?? []
    if (pending.length === 0) return []
    let list: readonly TaskView[] = []
    try { list = (await tasks?.list())?.tasks ?? [] } catch { list = [] }
    return approvalViews(pending, list)
  }
  // 有一条挂上 / 答掉 / 取消,两端立刻看得见(档上与手机上那一行)。
  approvals?.onChange(() => { void composeState().then(state => broadcast({ kind: 'snapshot', state })).catch(() => {}) })

  /** 看板那几张卡(配会话 → 事项用)。读不到就当没有。 */
  async function taskRefsNow(): Promise<readonly TaskView[]> {
    try { return (await tasks?.list())?.tasks ?? [] } catch { return [] }
  }
  /** 他在这条会话挂的那件事上刚动过手(答了一问 / 批了一条):记一笔,之后几分钟不为它打电话(卡 M 补)。 */
  async function touchSession(sessionId: string): Promise<void> {
    if (callOut?.touch === undefined) return
    const task = (await taskRefsNow()).find(one => one.conversation?.session_id === sessionId)
    if (task !== undefined) callOut.touch(task.id)
  }
  /** composeState 里 questions 那一格:她在 DSH 会话里问他的话,配上卡、文字收拾好(2026-09-25,卡 M)。 */
  async function questionsNow(): Promise<NonNullable<WorkbenchState['questions']>> {
    const pending = questions?.list() ?? []
    if (pending.length === 0) return []
    return questionViews(pending, await taskRefsNow())
  }
  /** composeState 里 approval_grants 那一格:「这件事里同类的都允许」记下的那几条。 */
  async function grantsNow(): Promise<NonNullable<WorkbenchState['approval_grants']>> {
    if (approvalGrants === undefined || approvalGrants.list().length === 0) return []
    const tasksNow = await taskRefsNow()
    // 那件事收了(完成 / 取消,验收通过就是完成)或者看板上没它了:记在它上面的「同类的都允许」作废(卡 M 追加)。
    approvalGrants.prune(grantTaskAlive(tasksNow))
    return grantViews(approvalGrants.list(), tasksNow)
  }
  /**
   * 壳不在前台时弹系统通知(2026-09-25,卡 M;维护者:「它有很多要我给权限的,它也不弹出来」)。
   * 每一问 / 每一条审批只弹一次(记在内存里,答掉了就忘);壳在前台就不弹(壳自己判);老壳不认这个 op,忽略。
   */
  const notifiedAsks = new Set<string>()
  async function notifyNewAsks(): Promise<void> {
    if (helper === undefined || !helper.connected()) return
    const current = new Map<string, { title: string, body: string }>()
    for (const one of questions === undefined ? [] : await questionsNow()) current.set(`question:${one.id}`, askNotice({ kind: 'question', view: one }))
    for (const one of approvals === undefined ? [] : (await approvalsNow() ?? [])) current.set(`approval:${one.id}`, askNotice({ kind: 'approval', view: one }))
    for (const key of [...notifiedAsks]) {
      if (current.has(key)) continue
      notifiedAsks.delete(key)
      // 答掉了 / 撤了:通知中心里那一条一起收掉。
      void helper.request({ op: 'notify', key, title: '', body: '', clear: true }, 5000).catch(() => {})
    }
    for (const [key, notice] of current) {
      if (notifiedAsks.has(key)) continue
      notifiedAsks.add(key)
      /**
       * 交出去的结果不再吞掉(卡 M 补;统筹:以前这一路静默失败)。壳收下之后,系统收没收由壳自己回(`notify_status`);
       * 这一头只记「根本没交到壳手上」的那几种:老壳不认 notify、壳没回话、壳断了。
       */
      void helper.request({ op: 'notify', key, title: notice.title, body: notice.body }, 5000)
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err)
          helper.recordNotify?.({ key, ok: false, error: /未知 op|unknown op/i.test(message) ? '这一版壳不会弹系统通知(要换新壳)' : message })
        })
    }
  }
  /**
   * ★ **答案来找她 —— 电脑这一端**(2026-10-04,卡 `claude/answer-comes-to-her`)。
   *
   * 做两件事,一件都不许吞:
   * 1. **记进回答账**(`directAnswers.record`)→ `/state.answers` → 电脑事务官页球下那一处与手机字幕
   *    (账一动 `onChange` 就推一拍快照,两端立刻看得见);
   * 2. **弹一条系统通知,正文就是答案本身**。
   *
   * 第 2 件的用词是这张卡的全部意思:维护者要的不是「有回复了」(那还得她自己追过去点开,
   * 正是 10-04 她抱怨的那一下),而是**答案直接摆在通知里**。所以 `body` 是原文、
   * `title` 才是她问的那一句 —— 通知中心里一眼看完,不用再开 App。
   *
   * 走的是现成那条路(`helper` 的 `notify` op,与「她有话问你」同一条),**没加新通道**。
   * 老壳不认这个 op 时它自己记一条「交不到壳手上」(`recordNotify`),界面上说得出为什么。
   *
   * 电话里问的那一条**不再推一次通知**(`answerWorthNotifying`):她刚在电话里听过了。
   * 她在哪问的那一格由建卡那一步落下(`ruleChannelOf` 一处算),这里只读。
   */
  function deliverAnswer(input: { taskId: string, question: string, answer: string, sessionId?: string }): void {
    try {
      const recorded = directAnswers.record({
        itemId: input.taskId,
        question: input.question,
        answer: input.answer,
        ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
        ...(askedWhere.get(input.taskId) === undefined ? {} : { where: askedWhere.get(input.taskId)! }),
      })
      askedWhere.delete(input.taskId)
      if (recorded === undefined) return
      if (!answerWorthNotifying(recorded)) return
      if (helper === undefined || !helper.connected()) return
      void helper.request({
        op: 'notify',
        key: `answer:${recorded.id}`,
        // 她问的那一句当抬头、**答案原文当正文**。
        title: recorded.question === '' ? '事务官答你' : recorded.question,
        body: recorded.answer,
      }, 5000).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        helper.recordNotify?.({
          key: `answer:${recorded.id}`,
          ok: false,
          error: /未知 op|unknown op/i.test(message) ? '这一版壳不会弹系统通知(要换新壳)' : message,
        })
      })
    }
    catch { /* 送不出去不该把会话收尾那一步整个作废 */ }
  }

  /**
   * ★ **固定流程办掉的那一件 → 回答账里一行**(2026-10-13,卡「固定流程办的事留痕」;
   * 判法与措辞在 `server/understoodTrace.ts`,为什么用这本账见那个文件头)。
   *
   * 维护者 10-13:「场景二我也没看到事务官那里有什么记录啊」—— 切待办版本 / 记发布计划 /
   * 做视频起步 / 补细节这几件**办掉了却不建卡**,于是她在事务官那里看不到任何痕迹。
   *
   * 三条分寸:
   *   · **只在真办成那一下记**(调用处把 `done` 留空就什么都不记)—— 不许说成办成了(D13);
   *   · **同一句不重记**:账上已经有这个 id 就一个字不动(不擦 `seen_at`、不换时刻)——
   *     `record()` 本来是「再记一次 = 覆盖 + 擦掉看过了」,那是为「事务官又说了一句」设计的;
   *     留痕这一行不需要那条,她看过之后同一句话不该再冒出来一次。标点不同算同一句(id 里不含标点);
   *   · **不推系统通知**:她刚在那一端说完这句话,人就在那儿;通知等于同一件事说两遍
   *     (这也是不走 `deliverAnswer` 的原因 —— 那一条是「会话收尾把答案送到她面前」)。
   */
  function noteUnderstood(req: IncomingMessage, device: DeviceView | undefined, input: {
    kind: string
    said: unknown
    done: string | undefined
  }): void {
    try {
      const where = ruleChannelOf(req, device, undefined, 'call')
      const trace = understoodTrace({
        kind: input.kind,
        said: typeof input.said === 'string' ? input.said : '',
        done: input.done ?? '',
        where,
      })
      if (trace === undefined) return
      if (directAnswers.get(trace.id) !== undefined) return
      directAnswers.record({ itemId: trace.id, question: trace.question, answer: trace.answer, where, cardless: true })
    }
    catch { /* 留一行痕迹失败不该把那件已经办成的事退回去 */ }
  }

  approvals?.onChange(() => { void notifyNewAsks().catch(() => {}) })
  // 她问了一句 / 答掉了 / 她不等了;「同类的都允许」记下 / 放行一次 / 收回 —— 两端立刻看得见。
  questions?.onChange(() => {
    void composeState().then(state => broadcast({ kind: 'snapshot', state })).catch(() => {})
    void notifyNewAsks().catch(() => {})
  })
  approvalGrants?.onChange(() => { void composeState().then(state => broadcast({ kind: 'snapshot', state })).catch(() => {}) })

  /** 跳过过这一条连接几次(用例与排障看)。 */
  let liveSkipped = 0
  /** 已经为它记过一行日志的连接(一条连接只记一次,不刷屏)。 */
  const liveSkipWarned = new WeakSet<WebSocket>()
  function broadcast(message: LiveMessage): void {
    // 8791 第六轮第 3 轮:能走到广播说明有东西变了 —— 按拍缓存的 composeState 立即作废。
    invalidateComposeCache()
    const text = JSON.stringify(message)
    for (const client of clients) {
      if (client.readyState !== client.OPEN) continue
      /**
       * ★ **收不动的连接不再往它的发送缓冲里堆**(2026-10-19,卡「插件内存增长与 GC 抖动」)。
       * 一份快照几百 KB、一秒里可能广播好几份;对端卡住(手机息屏、半开连接)时 `send` 照样「成功」,
       * 字节全攒在本进程的缓冲里,两拍心跳(40 秒)判死之前能堆几十 MB。超过上限就跳过这一条 ——
       * 快照是整块的,下一份会顶替这一份,少发一份不丢事实;心跳那边照旧负责把它清掉。
       */
      if (client.bufferedAmount > liveSendBufferMax) {
        liveSkipped += 1
        if (!liveSkipWarned.has(client)) {
          liveSkipWarned.add(client)
          console.warn(`${LIVE_SKIP_LOG_TAG}:这条 /live 连接的发送缓冲已有 ${Math.round(client.bufferedAmount / 1024 / 1024)}MB 没发出去,先不往里堆;两拍心跳不回会被清掉`)
        }
        continue
      }
      client.send(text)
    }
  }

  /**
   * ★ **整块快照的广播合并**(2026-10-19,同一张卡)。`broadcastState()` 是 index.ts 那头 29 处、
   * 这头 `onChange` 回调们共用的口;一次变化常常连着叫它几次(改卡 → 回执 → 落盘各一次),
   * 每次都整块 `composeState()`(几百 KB 的对象树 + 一份字符串)。合并的规矩只有一条:
   * **正在组装的时候又被叫,不再起一份,等这份发完再组一份**——所以叫了 N 次至多组两份,
   * 而最后那一份一定在最后一次叫之后组装,事实不丢、只是少做了几份一模一样的。
   */
  let snapshotInFlight = false
  let snapshotAgain = false
  /** 合并掉了几次(用例看)。 */
  let snapshotMerged = 0
  function broadcastSnapshot(): void {
    if (snapshotInFlight) { snapshotAgain = true; snapshotMerged += 1; return }
    snapshotInFlight = true
    void (async () => {
      try {
        do {
          snapshotAgain = false
          try { broadcast({ kind: 'snapshot', state: await composeState() }) }
          catch { /* 组装失败只是这一拍没推,下一次变化再推 */ }
        } while (snapshotAgain)
      }
      finally {
        snapshotInFlight = false
      }
    })()
  }

  /** 上一拍发了协议层 ping、还没等到 pong 的连接。两拍不回就判死。 */
  const awaitingPong = new Set<WebSocket>()

  function forget(ws: WebSocket): void {
    clients.delete(ws)
    lanClients.delete(ws)
    awaitingPong.delete(ws)
  }

  /**
   * 一拍心跳。
   *
   * 为什么两层都要发：
   * - **应用层 `{kind:'ping'}`** 是发给展示台的。浏览器会自动回协议层 pong，
   *   但既不把 ping 帧也不把 pong 帧暴露给 JS，所以展示台的看门狗只认得这一条。
   * - **协议层 ping 帧**是发给我们自己的。半开连接（对端已经没了、本端仍是 ESTABLISHED）
   *   在发送侧完全看不出来，send 照样"成功"；只有 pong 不回来能证明对端已经不在。
   *   真机上实测出现过这种连接：设备侧 /proc/net/tcp 是 ESTABLISHED，服务端这边压根没有这条。
   */
  function heartbeat(): void {
    const text = JSON.stringify({ kind: 'ping', ts: Date.now() } satisfies LiveMessage)
    for (const client of [...clients]) {
      if (client.readyState !== client.OPEN) {
        forget(client)
        continue
      }
      if (awaitingPong.has(client)) {
        // 上一拍的 pong 没回来：这条已经死了，清掉，别让它一直留在广播列表里。
        forget(client)
        client.terminate()
        continue
      }
      awaitingPong.add(client)
      client.ping()
      client.send(text)
    }
  }

  /**
   * 「允许手机在局域网访问」(2026-09-11):开着时另起一台监听 0.0.0.0、同端口的服务,
   * 复用同一个 handler 与升级处理;回环那台照旧。macOS 上两者可以并存(实测):回环连接
   * 走 127.0.0.1 那台,局域网连接走 0.0.0.0 那台,关掉后者局域网立刻拒连。
   * WORKBENCH_HOST 已经显式对外绑的旧用法不再另起——本来就对外了。
   */
  let lanServer: Server | undefined
  /** 从 0.0.0.0 那台进来的 TCP 连接;订阅时据此把 WS 记进 lanClients。 */
  const lanSockets = new WeakSet<object>()
  const lanClients = new Set<WebSocket>()
  let lanAdvertising = false
  const listeningPort = (): number => {
    const address = server.address()
    return typeof address === 'object' && address !== null ? address.port : options.port
  }
  async function openLan(): Promise<void> {
    if (lanServer !== undefined || host === '0.0.0.0' || host === '::') return
    const second = createServer(onRequest)
    second.on('connection', (socket) => { lanSockets.add(socket) })
    second.on('upgrade', onUpgrade)
    await new Promise<void>((resolve, reject) => {
      second.once('error', reject)
      second.listen(listeningPort(), '0.0.0.0', () => resolve())
    })
    lanServer = second
  }
  async function closeLan(): Promise<void> {
    const second = lanServer
    if (second === undefined) return
    lanServer = undefined
    for (const client of lanClients) { client.terminate(); forget(client) }
    lanClients.clear()
    second.closeAllConnections()
    await new Promise<void>((resolve) => { second.close(() => resolve()) })
  }
  async function applyLan(enabled: boolean): Promise<void> {
    lanEnabled = enabled
    if (enabled) {
      await openLan()
      if (lan?.mdns !== undefined && !lan.mdns.active()) {
        try {
          let advertisedMacId: string | undefined
          try { advertisedMacId = await options.machineId?.() }
          catch { advertisedMacId = undefined }
          await lan.mdns.start({
            name: lan.name ?? '工作台',
            port: listeningPort(),
            version: lan.version ?? '0',
            ...(advertisedMacId === undefined ? {} : { macId: advertisedMacId }),
          })
          lanAdvertising = true
        }
        catch {
          // 广播起不来(端口被占、网卡没起来)不该连累监听;/state.lan.advertising 如实为 false。
          lanAdvertising = false
        }
      }
      return
    }
    if (lan?.mdns !== undefined) {
      try { await lan.mdns.stop() } catch { /* 停不掉也只能如实标 false */ }
    }
    lanAdvertising = false
    await closeLan()
  }
  function lanView(): LanView {
    const address = lanAddress()
    return {
      enabled: lanEnabled,
      ...(address === undefined ? {} : { host: address }),
      port: listeningPort(),
      advertising: lanAdvertising && (lan?.mdns?.active() ?? false),
    }
  }
  function pairingView(): PairingView | undefined {
    const code = pairing?.current()
    if (code === undefined) return undefined
    const address = lanAddress()
    return {
      code: code.code,
      expires_at: code.expires_at,
      // 取不到局域网 IP 就没有二维码,只显示数字码——不编一个地址。
      ...(address === undefined ? {} : { qr: pairQrContent(address, listeningPort(), code.code) }),
    }
  }

  /**
   * ★ **补细节只认紧跟着那件事之后的第一句**(2026-10-13 晚,卡 P)。
   *
   * 一台服务一道闸:`/butler/understand` 每一句都问它一次(见 `createAppendGate` 那一段
   * 为什么要数在这一侧 —— 单看工人带来的那一份 `open` 分不出中间插过话没有)。
   * 这一格只喂给 `understand()` 的 `ctx.open.first`,**一行都不写盘、回包形状一个字没变**。
   */
  const appendGate = createAppendGate()
  const handoffPerfLog = createHandoffPerfLog()
  const onRequest = (req: IncomingMessage, res: ServerResponse): void => {
    void handle(req, res).catch((error: unknown) => {
      // tasks.json 读坏了而拒写(2026-10-21):不是程序出错,是「为了不盖掉原文件而没写」,回 409 + 那句人话。
      if (error instanceof TasksFileUnreadableError) {
        if (!res.headersSent) sendJson(res, 409, { error: error.message })
        return
      }
      /**
       * 兜底:任何未预料的异常都回 500,绝不让整台服务因为一条坏请求崩掉。
       *
       * 2026-09-22 起这里**同时是四类自动上报里 `unhandled` 的入口**。
       * 为什么挂在这儿:这台服务是整个工作台的中枢,而"一条请求把它打出异常"
       * 正是那种在开发机上从来不发生、在 Ben 那台新 Mac 上出了却没人知道的事。
       * 编号回给界面(`sendCodedError`)、写进本机日志、报给中转 —— 三处同一个号。
       *
       * 上报本身**绝不抛**(report 内部吞掉一切),所以这段不会把兜底变成第二次崩溃。
       */
      const at = Date.now()
      const code = diagCode('plugin', at)
      const message = error instanceof Error ? error.message : String(error)
      console.log(`[诊断] ${code} plugin/unhandled:${req.method} ${(req.url ?? '').split('?')[0]} — ${message}`)
      void diag?.report({
        component: 'plugin',
        kind: 'unhandled',
        message: `${req.method} ${(req.url ?? '').split('?')[0]}:${message}`,
        ...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {}),
        atMs: at,
      })
      if (!res.headersSent) sendJson(res, 500, { error: '内部错误', code })
    })
  }
  const server = createServer(onRequest)

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // 8791 第六轮第 3 轮:任何非 GET 请求都可能改状态 —— 按拍缓存的 composeState 立即作废,
    // 下一拍现算(POST 之后跟 GET /state 的用例与界面因此永远拿得到新账)。
    if (req.method !== 'GET' && req.method !== 'HEAD') invalidateComposeCache()
    // 来源不在允许名单里就整台拒绝，任何路由都不给碰——包括读 /state。
    if (!isRemoteAllowed(req)) {
      sendJson(res, 403, { error: '此来源不允许访问' })
      return
    }

    // 兜底成 '/'：路由里有 startsWith 判断，undefined 会在类型层就拦下来。
    const path = (req.url ?? '/').split('?')[0] ?? '/'

    /**
     * 鉴权(2026-09-11 手机配对):非本机来源除了预检与 /pair/claim(它就是拿令牌的入口)
     * 一律要设备令牌,读 /state 也要;本机来源不看令牌、行为不变。只在接了配对服务时生效——
     * 没接就是老样子(回环门在各条写路由里)。
     */
    /**
     * 回环来源的**降权**(2026-09-17,通道层房间代理)。
     *
     * 事务官工人跑在本机回环上,而 8791 对回环是全权信任的。工人要替房里的手机来调 8791,
     * 要是原样发一条回环请求,房里任何参与者就都拿到了这台 Mac 的全部权限(配对码、凭据、窗位……)。
     * 所以工人转发时带 `X-Workbench-Channel-Device: <设备 id>`,这里把这条请求**降成那台设备的权限**
     * —— 和这台手机自己在局域网里打 8791 时走的是同一道门、同一批 403。
     *
     * 三条纪律:
     *   ① **只在回环上看这条头**。非回环来源本来就要设备令牌,轮不到它自称是谁;
     *   ② 它**只降不升**。回环本来就是最高权限,所以认这条头不可能是提权;
     *   ③ 设备 id 认不出来(没配对过、已解除)就 **401**,绝不退回回环全权 —— 那才是真的洞。
     * 白名单在工人那一侧(channel-worker/src/rpc.ts):8791 这边只管权限,不管路径挑没挑对。
     */
    const rawLoopback = isLoopback(req)
    /**
     * 自定义模块的**降权**(2026-09-22,C7「自定义模块真边界」)。
     *
     * 模块页面现在挂在另一台监听(server/moduleOrigin.ts,默认 8794)上,所以它打过来的
     * 每一条都是**跨源**请求 —— 浏览器一定会带 `Origin`,而且模块作者在页面里改不掉它
     * (fetch 不许设 Origin)。加了 `sandbox` 之后那个文档是不透明来源,带过来的是字面量 `null`。
     *
     * 两条都当成"这是模块在说话",**当场降权**:回环那一半信任作废,只剩白名单里那几条。
     *
     *   - 为什么不能只看令牌:不带令牌的那条同样是从回环 TCP 上来的,不降权就是全权。
     *   - 为什么连 `Origin: null` 也算:这台服务上**只有**模块页面是不透明来源。
     *     宁可把一条来路不明的请求降成模块,也不能把一条模块的请求当成本机。
     *   - `mode:'no-cors'` 那种"发出去就不看回什么"的写请求也拦得住:门在这儿,不在浏览器。
     */
    const originHeader = Array.isArray(req.headers.origin) ? req.headers.origin[0] : req.headers.origin
    const moduleBearer = ((): string | undefined => {
      const raw = req.headers.authorization
      if (typeof raw !== 'string' || !raw.startsWith('Bearer ')) return undefined
      const token = raw.slice('Bearer '.length).trim()
      return token.startsWith(MODULE_TOKEN_PREFIX) ? token : undefined
    })()
    const moduleCaller = moduleTokens !== undefined
      && (moduleBearer !== undefined
        || originHeader === 'null'
        || (moduleOriginServer !== undefined && originHeader === moduleOriginServer.origin))
    const moduleClaims = moduleCaller ? moduleTokens?.verifyApi(moduleBearer) : undefined

    const claimedHeader = req.headers[CHANNEL_DEVICE_HEADER]
    const claimedDevice = !moduleCaller && rawLoopback && typeof claimedHeader === 'string' && claimedHeader.trim() !== ''
      ? claimedHeader.trim()
      : undefined
    let device: DeviceView | undefined
    if (claimedDevice !== undefined) {
      // 工人替手机办成了这一下 = 手机在线:顺手刷 lastSeenAt(限频一分钟,2026-10-12);老的假服务没有 touch 就只在表里找。
      device = pairing === undefined
        ? undefined
        : pairing.touch !== undefined
          ? await pairing.touch(claimedDevice)
          : (await pairing.list()).find(item => item.id === claimedDevice)
      if (device === undefined) {
        // 「从账号里移除了这台」要说得出来(2026-10-03):工人替手机办事走的就是这条头,
        // 手机把这句话原样显示给人看,说成「没配对过」会让她去翻一个不存在的毛病。
        const left = await leftAccount({ id: claimedDevice })
        sendJson(res, 401, { error: left ? DEVICE_LEFT_ACCOUNT_TEXT : '这台设备没配对过,或者已经解除配对了' })
        return
      }
    }
    /**
     * 回环上**带着有效设备令牌**的,就是那台手机(2026-09-27,统筹)。有线 ADB(`adb reverse tcp:8791`)
     * 让手机的请求从回环进来;原来回环一律不看令牌、当成本机测试页,签出 `wb-dev-page` 的进房凭证,
     * 工人不认 → 手机「电脑不在线 / 不认这台手机」。令牌认不出就不采信(本机页面的 Bearer 另有用处),照旧按本机走。
     */
    if (device === undefined && rawLoopback && !moduleCaller && pairing !== undefined && typeof req.headers.authorization === 'string') {
      device = await deviceOf(req)
    }
    /** 降权之后的「是不是本机」。**handle 里从这里往下一律用它**,不要再直接问 isLoopback(req)。 */
    const loopback = rawLoopback && device === undefined && !moduleCaller
    /**
     * 火山的 Function Calling 回调(2026-09-17)是**第二条不要设备令牌的非本机入口**,理由与
     * /pair/claim 同类:火山没有、也不该有工作台的设备令牌。它的门是那条路由自己的进程级随机签名
     * (48 位十六进制,重启即换),签名对不上一律 401,除此之外什么都不做。
     * 顺带一提,内网穿透多半把请求从回环发过来,这一条只是为了不依赖穿透工具的实现细节。
     */
    const isRtcCallback = req.method === 'POST' && path === RTC_CALLBACK_PATH
    /**
     * 第三条不要设备令牌的非本机入口(2026-09-17 登录台):手机端的安装包本身。
     * 一台还没装 App 的新手机不可能有令牌,而它要先拿到 App 才谈得上配对(双端流程,
     * 设计-电脑端登录台梳理 §八)。给出去的只是一个安装包,里面没有任何本机凭据;
     * 而且这条路只在「允许手机在局域网访问」开着时才有人到得了。
     */
    const isApkDownload = req.method === 'GET' && path === '/setup/apk'
    if (pairing !== undefined && device === undefined && !loopback && !moduleCaller && req.method !== 'OPTIONS' && !isRtcCallback && !isApkDownload && !(req.method === 'POST' && path === '/pair/claim')) {
      // 2026-09-14:经代理去本机后端的 GET 也认 ?token=——手机 WebView 里 <img>/<audio> 拉头像、铃声、
      // Live2D 包时设不了请求头,与 /live 的 WS 是同一个理由。只给这一段路径开,转发前把 token 摘掉(见下)。
      device = await deviceOf(req, req.method === 'GET' && path.startsWith(BUTLER_PROXY_PREFIX))
      if (device === undefined) {
        // 这把令牌正是「从账号里移除的那一台」的那把时,说那一句(2026-10-03;见 leftAccount)。
        const bearer = typeof req.headers.authorization === 'string' && req.headers.authorization.startsWith('Bearer ')
          ? req.headers.authorization.slice('Bearer '.length).trim()
          : ''
        const left = bearer === '' ? false : await leftAccount({ token: bearer })
        /**
         * `/channel/route` 的 401 带上这台的 `mac_id`(2026-10-21,局域网主路;卡 M3 连接规格要的):
         * 设备据此分得清「我配的那台不认我了(撤了)」与「这是办公室里别人的 Mac」。机器 id 不是秘密(mDNS 里也广播),
         * 房间名、地址表一格都不给。
         */
        let deniedMacId: string | undefined
        if (path === '/channel/route' && req.method === 'GET') {
          try { deniedMacId = await options.machineId?.() }
          catch { deniedMacId = undefined }
        }
        sendJson(res, 401, { error: left ? DEVICE_LEFT_ACCOUNT_TEXT : '需要设备令牌:先在工作台设置里配对', ...(deniedMacId === undefined ? {} : { mac_id: deniedMacId }) })
        return
      }
    }
    /**
     * 回环,或者带着有效令牌的已配对设备,或者带着有效模块令牌的自定义模块。
     * 普通写路由认这个;碰凭据/登录/配对管理/开关的只认回环(模块永远不是回环)。
     *
     * ★ **2026-09-23 Ben 拍板「同一个事务官」**(docs/设计-同一个事务官-2026-09-23.md):
     *
     * > 「我希望电脑上的事务官和手机上的事务官是一种数字分身的概念,而不是两个人,
     * >  更不是两个权限不同的人。」
     *
     * 于是这道门的口径从此是:**配对过的设备就是本人,权限与本机一样**;
     * 两边的差别只在**设备能力**(手机没有这台 Mac 的文件系统、没有它的屏幕),不在权限。
     *
     * 落法只有两档,判据是「**这是事务官的事,还是这台机器的事**」:
     *   - **事务官的事**(需求卡、选题卡、事项、收件箱、例程、记忆、技能、派活、
     *     通话纪要、进化……)→ `trusted`。她在哪台设备上按都是她在按。
     *   - **这台机器的装配**(配对本身、钩子、路径配置、安装/热更新、诊断包、
     *     凭据/登录窗口、本机后端启停、窗位叠与壳)→ 仍然 `loopback`。
     *     那不是"手机权限低",是那件事**在手机上没有意义**:它动的是这台 Mac 自己。
     *
     * **重的动作不靠端口区分,靠界面上的二次确认**(合并发版、删除类)——
     * 见设计文档第四节那张表。
     */
    const trusted = loopback || device !== undefined || moduleClaims !== undefined

    /**
     * 这条请求的**来路**(2026-10-21,局域网主路;server/channel.ts 的 `channelPlanOf`)。
     * `/channel/token`、`/channel/status`、`/channel/route` 按它签地址、报地址:
     * 工人转来的(回环 + 设备头)看工人报的那间房(`CHANNEL_ROUTE_HEADER`,认不出的值当没报);
     * 其余看 socket 的两头。`want`(点名要哪条)**只有本机说了才算** —— 设备在哪条路由来路定,自己说了不算。
     */
    const channelCaller = (want?: unknown): ChannelCaller => {
      const routeOf = (value: unknown): ChannelRoute | undefined => {
        const one = typeof value === 'string' ? value.trim() : ''
        return (CHANNEL_ROUTES as readonly string[]).includes(one) ? one as ChannelRoute : undefined
      }
      if (claimedDevice !== undefined) {
        const route = routeOf(req.headers[CHANNEL_ROUTE_HEADER])
        return { proxied: route === undefined ? {} : { route } }
      }
      const local = localAddress(req)
      const remote = remoteAddress(req)
      const wanted = loopback ? routeOf(want) : undefined
      return {
        ...(local === undefined ? {} : { localAddress: local }),
        ...(remote === undefined ? {} : { remoteAddress: remote }),
        ...(wanted === undefined ? {} : { want: wanted }),
      }
    }

    /**
     * 这一条到底是**谁**打来的(2026-09-28,卡 BS;整段理由与那个还没关上的洞在 `server/herself.ts`)。
     *
     * `trusted` 回答的是「这台机器 / 她的设备信不信这条」;`asker` 回答的是**「是不是她本人」**——
     * 「等你确认」与发版这四个口只认后者,事务官与派出去的别家一律拒。
     * 两者各管一档,不要互相替代。
     */
    /**
     * 个人访问令牌(2026-10-21 协作区):**只在本机回环上认**。认得 = 他本人(命令行 / 他的脚本),
     * 与页面同一档;带了却认不得 = 401 并说清(令牌错了或收回了),不悄悄降成「认不出的程序」。
     */
    const personalBearer = rawLoopback && !moduleCaller && typeof req.headers.authorization === 'string'
      && req.headers.authorization.startsWith(`Bearer ${PERSONAL_TOKEN_PREFIX}`)
      ? req.headers.authorization.slice('Bearer '.length).trim()
      : undefined
    if (personalBearer !== undefined && options.personalTokens !== undefined) {
      if (!(await options.personalTokens.verify(personalBearer))) {
        sendJson(res, 401, { error: '个人访问令牌不对或已经收回了:去工作台设置里重新发一枚' })
        return
      }
      personalRequests.add(req)
    }
    // 总开关关着时,协作成员凭据一律不认(它只随协作区 LAN 配对产生,不该有别的入口)。
    if (!collabEnabled && device?.platform === 'collab-peer') {
      sendJson(res, 403, { error: '多人协作区已关闭' })
      return
    }
    // 协作成员只获同项目消息的传输权,不继承手机的看板/文件/房间访问权。
    if (device?.platform === 'collab-peer' && !((req.method === 'GET' && path === '/collab/lan/hello') || (req.method === 'POST' && path === '/collab/lan/receive') || req.method === 'OPTIONS')) {
      sendJson(res, 403, { error: '协作成员凭据只用于局域网消息,不能访问工作台其它内容' })
      return
    }

    const asker: Asker = personalRequests.has(req) ? 'page' : whoIsAsking({ headers: req.headers, device: device !== undefined, tokens: options.actorTokens })

    /**
     * ★ **行为账这一条记在哪一端**(2026-10-09,卡「行为账」;`server/behaviorLog.ts`)。
     * 端由这里认出来,不靠各端自己报:手机在家(局域网带设备令牌)与出门(房间里工人带 `x-workbench-channel-device`
     * 回环代发)都已在上面落成同一个 `device`,于是三条路记出来是同一个「手机」。不是她(事务官 / 别家 / 认不出)不进账。
     */
    // 自定义模块带着 Origin 头,`asker` 会认成 page —— 那是模块代码在调,不算她亲手做的。
    const behaviorEnd = moduleCaller ? undefined : behaviorEndOf({ asker, deviceKind: device?.kind })
    const noteBehavior = (input: Omit<BehaviorInput, '端'>, end: BehaviorEnd | undefined = behaviorEnd): void => {
      if (end === undefined || options.behaviorLog === undefined) return
      options.behaviorLog.record({ 端: end, ...input })
    }
    if (behaviorEnd === '手机') options.behaviorLog?.seen('手机')

    /**
     * ★ **座机听筒是实验那一样**(2026-10-21,卡「引导三件事」):开关关着时,座机那台设备的请求一律挡下
     * (它已经配过也一样),手机照常。座机来配对在 `/pair/claim` 那里挡。
     */
    if (device?.kind === 'handset' && await experimentOff('handset')) {
      sendJson(res, 403, { error: EXPERIMENT_OFF_LINE, experiment_off: 'handset' })
      return
    }
    // 通话里电话那一端建成的卡,挂到这一通的记录上(2026-10-22)。
    if (req.method === 'POST' && (path === '/butler/item' || path === '/task/create')) watchCallItemCreated(res, behaviorEnd)
    // 电话那一件(三件主路的第三件)从建卡 / 捎话那几条路的回包里当场记。
    if (req.method === 'POST' && (path === '/butler/item' || path === '/task/create' || path === '/sessions/relay') && options.firstUse !== undefined) {
      watchCallPath(req, res, path, behaviorEnd, await phonePairedNow())
    }

    /**
     * 自定义模块那道门(2026-09-22)。**在任何路由之前**,因为它要拦的正是"打到别的路由上去"。
     *
     * 三件事,顺序不能换:
     *   ① 预检(OPTIONS)带不了 `Authorization`,所以只按路径判 —— 白名单里的才给跨源头,
     *      表外的不给(浏览器据此直接把请求掐死)。预检本身不泄露任何东西。
     *   ② 令牌验不过 401。过期、被吊销(模块移进回收站)、伪造的签名都落在这儿。
     *   ③ 白名单之外一律 403,**一个字都不办**。`/credentials`、`/pair/start`、`/hooks`、
     *      `/dock/*`、`/layout` 全在这一条里被挡住 —— 这就是 C7 要的那道真边界。
     */
    if (moduleCaller) {
      const allowed = req.method === 'OPTIONS'
        ? isModuleApiAllowed(
            typeof req.headers['access-control-request-method'] === 'string'
              ? req.headers['access-control-request-method']
              : undefined,
            path,
          )
        : isModuleApiAllowed(req.method, path)
      if (allowed && originHeader !== undefined) {
        // 反射回去的是模块那个 origin(sandbox 之后是字面量 null)。
        // **不发 Allow-Credentials**:模块不带 cookie,拿不到工作台的账号会话。
        res.setHeader('Access-Control-Allow-Origin', originHeader)
        res.setHeader('Vary', 'Origin')
      }
      if (req.method === 'OPTIONS') {
        if (allowed) {
          res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
          res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization')
          res.setHeader('Access-Control-Max-Age', '600')
        }
        res.writeHead(204)
        res.end()
        return
      }
      if (moduleClaims === undefined) {
        sendJson(res, 401, { error: '模块令牌无效或已过期:刷新一下工作台这一格' })
        return
      }
      if (!allowed) {
        sendJson(res, 403, { error: '自定义模块用不了这条接口(只放行 docs/自定义模块-接口.md 里那几条)' })
        return
      }
    }

    const allowOrigin = moduleCaller ? undefined : loopbackOrigin(originHeader)
    if (allowOrigin !== undefined) {
      res.setHeader('Access-Control-Allow-Origin', allowOrigin)
      res.setHeader('Vary', 'Origin')
      /**
       * 账号那张 cookie(2026-09-17)。工作台页面在 127.0.0.1:3080、服务在 127.0.0.1:8791 ——
       * **同站不同源**,所以 cookie 本身带得上(SameSite 看站点、不看端口),但跨源的 fetch
       * 要这一行 + `credentials: 'include'` 才带。放行的来源本来就只有回环(loopbackOrigin),
       * 这一行不扩大任何暴露面。
       */
      res.setHeader('Access-Control-Allow-Credentials', 'true')
    }

    /**
     * **A11:改工作台上各模组显示的状态,只许事务官与她本人做**
     * (2026-09-28 维护者拍板 + 同日 15:5x 第 1 条;卡 BS2。整段理由与那张表在 `server/herself.ts`)。
     *
     * 一处判、一处拒:表在 `isDisplayStateWrite`,话在 `DISPLAY_STATE_DENIED`。
     * 放过去的是页面 / 壳、配对设备、电话工人、事务官那把进程令牌;**认不出来的程序 403**
     * (派出去的 Codex / Claude 在本机随手一条 curl 就是这一种 —— 那正是这道门要关的)。
     *
     * 三条边界:
     * - **这个进程没现生令牌时不判**(`options.actorTokens` 缺席 = 老宿主 / 用例):
     *   那时候压根分不出事务官与别家,**宁可认不出也不认错**(同 `whoIsAsking` 的规矩)。
     * - **自定义小组件不在这道门里**:它带的是工作台自己签的模块令牌,而且能打哪几条早有白名单
     *   (上面那道门);它是「用户层」,不是别家。
     * - **报事实的口不在表里**:`/event`、`/hook/<哪一家>`、`/statusline` 与座机那条信令照旧敞着。
     *
     * 摆在预检之后、所有路由之前 —— 跟模块那道门同一个道理:它要拦的正是「打到别的路由上去」。
     */
    if (
      options.actorTokens !== undefined
      && moduleClaims === undefined
      && isDisplayStateWrite(req.method, path)
    ) {
      const notAllowed = notButlerOrHerself(asker)
      if (notAllowed !== undefined) { sendJson(res, 403, { error: notAllowed }); return }
    }

    // 预检。带 content-type 的 POST 会先发这个，不放行的话请求根本发不出去。
    if (req.method === 'OPTIONS') {
      if (allowOrigin !== undefined) {
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS')
        res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization, range')
        res.setHeader('Access-Control-Max-Age', '600')
      }
      res.writeHead(204)
      res.end()
      return
    }

    // 名片头像(2026-10-21,`collabAvatarRoutes.ts`)。
    /**
     * ★ **同一个请求号只办一次**(2026-10-12,卡「手机交代只执行一次」;交接 `docs/交接-1012-手机交代只执行一次.md`)。
     *
     * 手机交代、捎话、派活、答问、批准…那几条(表在 `server/clientKeys.ts` 的 `CLIENT_KEY_PATHS`)带一个它自己编的
     * `client_key`。断线重发、直连断了改走房间、App 重开后补发,带的都是同一个号;这里按「哪台设备 · 哪条路 · 哪个号」认,
     * 办过的原样回第一次那份回包,正在办的等它办完。手机在家(令牌)与出门(工人代发带设备头)上面已落成同一个 `device`,
     * 所以两条路是同一本账。不带号(老手机包、电脑页面)一字不变。
     */
    if (req.method === 'POST' && trusted && CLIENT_KEY_PATHS.has(path)) {
      const bodyText = await readBody(req)
      bufferedBodies.set(req, bodyText)
      const key = clientKeyOf(bodyText)
      if (key !== undefined) {
        const got = await clientKeys.begin(`${device?.id ?? (moduleCaller ? 'module' : 'local')} ${path}`, key)
        if (got.kind === 'replay') { sendReplay(res, got.status, got.body); return }
        recordForClientKey(res, got)
      }
    }

    // 多人协作区总开关(2026-11-09):关着时下面三条 handler 一条都不进,
    // /collab/* 与 /token/personal* 直接落到后面的「没这条路由」(404)。
    if (collabEnabled && await collabAvatarRoutes.handle({
      req, res, path, trusted, loopback, page: asker === 'page', sendJson, readJsonBody,
      writeDenied: () => agentWriteDenied(req, device),
    })) return
    // 协作区跨机那几条(2026-10-21,`collabRelayRoutes.ts`)。
    if (collabEnabled && await collabRelayRoutes.handle({
      req, res, path, trusted, loopback, page: asker === 'page', sendJson, readJsonBody,
      writeDenied: () => agentWriteDenied(req, device),
    })) return
    // 协作区那几条(2026-10-21,`collabRoutes.ts`):新路径,老路由一条不碰。
    if (collabEnabled && await collabRoutes?.handle({
      ...(device === undefined ? {} : { device }),
      req, res, path, trusted, loopback, page: asker === 'page', sendJson, readJsonBody,
      writeDenied: () => agentWriteDenied(req, device),
    }) === true) return

    /**
     * 「工作台起来了没有」(2026-09-26,卡 U6)。**壳在让页面开始加载之前先探这一条**。
     *
     * 09-26 生产切换:热更新重启 DSH 之后壳里整窗一片白 —— 3080(DSH 自己的 web)先起来了,
     * 壳把页面加载进来、提交了,而工作台插件这一层还没挂上,于是盖板等不到插件的 ready、
     * 20 秒兜底一到就揭开,露出下面那张空页。8791 答话 = 插件真的挂上了,所以壳探的是这里。
     *
     * **为什么不让它去探 `/state`**:那一条会算一整份快照,而且会记一次「工作台露面了」
     * (开工汇报)—— 开机自启的壳探它等于替他露了个面。这一条什么都不做、什么都不记,
     * 只答一句"我在,我是哪一版"(版本号顺手给,壳日志里能看出它连上的是哪一版)。
     */
    if (req.method === 'GET' && path === '/ready') {
      sendJson(res, 200, { ok: true, version: PLUGIN_VERSION })
      return
    }

    /**
     * ★ **行为账只读口**(2026-10-09,卡「行为账」):`GET /behavior?since=<时间>&事=<拍板|派活|…>&limit=<n>`。
     * **只给本机**:原话在里面,手机、模块、别家一律 403。给后续「数出习惯」那几张卡读。
     */
    if (req.method === 'GET' && path === '/behavior') {
      if (!loopback) { sendJson(res, 403, { error: '行为账只能在这台电脑上读' }); return }
      if (options.behaviorLog === undefined) { sendJson(res, 404, { error: '行为账没接上' }); return }
      const parsed = parseBehaviorQuery(new URL(req.url ?? '/', 'http://x').searchParams)
      if (!parsed.ok) { sendJson(res, 400, { error: parsed.error }); return }
      sendJson(res, 200, { entries: await options.behaviorLog.read(parsed.query) })
      return
    }

    /**
     * ★ 从行为账里数出来的习惯(2026-10-09,卡「数出习惯」;`server/habits.ts`)。
     *   GET  /habits               正在试用 / 已留下 / 已撤的(「它学到了什么」那一页读这个)。本机与配对过的手机都能读。
     *   POST /habits/revoke {id}   她撤掉一条:不再照做、进化日志补一行、以后不再自动学回来。**只认她本人**。
     *   POST /habits/restore {id}  撤错了恢复(2026-10-10):重新试用、照常验证、日志补一行。**只认她本人**(同 revoke)。
     *   POST /habits/seen {id}     收件箱里「新学到一条」那一句她看过了(「知道了」)。**只认她本人**:事务官替她点掉就等于没告诉她。
     */
    if (req.method === 'GET' && path === '/habits') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机或已配对的手机上看' }); return }
      if (options.habits === undefined) { sendJson(res, 404, { error: '习惯没接上' }); return }
      sendJson(res, 200, options.habits.view())
      return
    }
    if (req.method === 'POST' && path === '/habits/revoke') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机或已配对的手机上撤' }); return }
      const notHerRevoke = notHerself(asker, 'answer')
      if (notHerRevoke !== undefined) { sendJson(res, 403, { error: notHerRevoke }); return }
      if (options.habits === undefined) { sendJson(res, 404, { error: '习惯没接上' }); return }
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      const id = typeof body.id === 'string' ? body.id : ''
      if (id === '') { sendJson(res, 400, { error: '要带 id' }); return }
      const done = await options.habits.revoke(id)
      if (!done.ok) { sendJson(res, done.error === '没有这条习惯' ? 404 : 409, { error: done.error }); return }
      noteBehavior({ 事: BEHAVIOR_EVENTS.decide, 对象: `习惯 ${id}`, 结果: '撤掉习惯' })
      sendJson(res, 200, { ok: true, habit: done.habit, note: done.note })
      return
    }
    if (req.method === 'POST' && (path === '/habits/restore' || path === '/habits/seen')) {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机或已配对的手机上点' }); return }
      const notHerHabit = notHerself(asker, 'answer')
      if (notHerHabit !== undefined) { sendJson(res, 403, { error: notHerHabit }); return }
      if (options.habits === undefined) { sendJson(res, 404, { error: '习惯没接上' }); return }
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      const id = typeof body.id === 'string' ? body.id : ''
      if (id === '') { sendJson(res, 400, { error: '要带 id' }); return }
      if (path === '/habits/seen') {
        const seen = await options.habits.seen(id)
        if (!seen.ok) { sendJson(res, 404, { error: seen.error }); return }
        sendJson(res, 200, { ok: true, note: '好,在「它学到了什么」里随时能看、能撤。' })
        return
      }
      const done = await options.habits.restore(id)
      if (!done.ok) { sendJson(res, done.error === '没有这条习惯' ? 404 : 409, { error: done.error }); return }
      noteBehavior({ 事: BEHAVIOR_EVENTS.decide, 对象: `习惯 ${id}`, 结果: '恢复习惯' })
      sendJson(res, 200, { ok: true, habit: done.habit, note: done.note })
      return
    }

    if (req.method === 'GET' && path === '/state') {
      // 工作台露面了(2026-09-15 开工汇报):只认本机来源——展示台/手机整夜轮询不算"人来了"。
      if (loopback) routines?.sighted()
      const state = await composeState()
      // 配对码只给本机来源:它就是钥匙。广播快照(composeState)里永远没有它。
      const view = pairingView()
      sendJson(res, 200, loopback && view !== undefined ? { ...state, pairing: view } : state)
      return
    }

    /**
     * 手机配对(2026-09-11,设计-事务官完整材料 §2)。
     * /pair/start 与 /pair/revoke、/lan 只认回环——它们改的是信任边界本身,带令牌的手机不能碰。
     * /pair/claim 是唯一不要令牌的非本机入口(鉴权那一段放行的),码对了才给令牌,错 5 次锁 10 分钟。
     */
    if (path === '/pair/start' && req.method === 'POST') {
      if (!loopback) { sendJson(res, 403, { error: '只能在本机生成配对码' }); return }
      if (pairing === undefined) { sendJson(res, 404, { error: '配对未启用' }); return }
      pairing.start()
      sendJson(res, 200, { ok: true, pairing: pairingView() })
      return
    }
    if (path === '/pair/claim' && req.method === 'POST') {
      if (pairing === undefined) { sendJson(res, 404, { error: '配对未启用' }); return }
      const text = await readBody(req)
      let body: unknown
      try { body = JSON.parse(text) } catch { sendJson(res, 400, { error: 'body 不是合法 JSON' }); return }
      const raw = (body ?? {}) as Record<string, unknown>
      if (typeof raw.code !== 'string' || typeof raw.device_name !== 'string' || typeof raw.platform !== 'string') {
        sendJson(res, 400, { error: 'code / device_name / platform 都必须是字符串' }); return
      }
      // 座机听筒是实验那一样(2026-10-21):关着时座机来配对挡下(配对码不消耗,开了再配一次就行)。
      if (deviceKindOf(raw.platform) === 'handset' && await experimentOff('handset')) {
        sendJson(res, 403, { error: EXPERIMENT_OFF_LINE, experiment_off: 'handset' }); return
      }
      const result = await pairing.claim({ code: raw.code, device_name: raw.device_name, platform: raw.platform })
      if (!result.ok) {
        sendJson(res, result.status, { error: result.error, ...(result.locked_until === undefined ? {} : { locked_until: result.locked_until }) })
        return
      }
      // 令牌明文只在这一刻出现一次;之后本机也拿不回来。
      broadcast({ kind: 'snapshot', state: await composeState() })
      /**
       * `mac_id`(2026-10-21,局域网主路):手机这一刻记下「我配的是哪一台」,之后 `GET /channel/route`
       * 答回的 `mac_id` 对不上就不算在家(同一个地址换了一台 Mac、同一局域网好几台 8791)。取不到就缺席。
       */
      let pairedMacId: string | undefined
      try { pairedMacId = await options.machineId?.() }
      catch { pairedMacId = undefined }
      sendJson(res, 200, { ok: true, device_id: result.device_id, token: result.token, ...(pairedMacId === undefined ? {} : { mac_id: pairedMacId }) })
      return
    }
    if (path === '/pair/revoke' && req.method === 'POST') {
      if (!loopback) { sendJson(res, 403, { error: '只能在本机解除配对' }); return }
      if (pairing === undefined) { sendJson(res, 404, { error: '配对未启用' }); return }
      const text = await readBody(req)
      let body: unknown
      try { body = JSON.parse(text) } catch { sendJson(res, 400, { error: 'body 不是合法 JSON' }); return }
      const raw = (body ?? {}) as Record<string, unknown>
      if (typeof raw.id !== 'string' || raw.id === '') { sendJson(res, 400, { error: 'id 必须是非空字符串' }); return }
      const removed = await pairing.revoke(raw.id)
      if (!removed) { sendJson(res, 404, { error: '没有这台设备' }); return }
      // 已连着的 /live 订阅不主动踢:它下次重连时令牌就认不出了。写接口从这一刻起立即 401。
      broadcast({ kind: 'snapshot', state: await composeState() })
      sendJson(res, 200, { ok: true })
      return
    }
    /**
     * 给一台已配对的设备改名(2026-09-25,卡 fix/evening-gaps 第 2 条:设置 → 手机与设备)。
     * 与 /pair/revoke 同一道门:只认回环 —— 设备列表是信任边界的一部分,带令牌的手机不能碰。
     */
    if (path === '/pair/rename' && req.method === 'POST') {
      if (!loopback) { sendJson(res, 403, { error: '只能在本机改设备名' }); return }
      if (pairing?.rename === undefined) { sendJson(res, 404, { error: '配对未启用' }); return }
      const text = await readBody(req)
      let body: unknown
      try { body = JSON.parse(text) } catch { sendJson(res, 400, { error: 'body 不是合法 JSON' }); return }
      const raw = (body ?? {}) as Record<string, unknown>
      if (typeof raw.id !== 'string' || raw.id === '') { sendJson(res, 400, { error: 'id 必须是非空字符串' }); return }
      if (typeof raw.name !== 'string' || raw.name.trim() === '') { sendJson(res, 400, { error: '名字不能是空的' }); return }
      const renamed = await pairing.rename(raw.id, raw.name)
      if (!renamed) { sendJson(res, 404, { error: '没有这台设备' }); return }
      broadcast({ kind: 'snapshot', state: await composeState() })
      sendJson(res, 200, { ok: true })
      return
    }
    if (path === '/lan' && req.method === 'POST') {
      if (!loopback) { sendJson(res, 403, { error: '只能在本机改这个开关' }); return }
      if (lan === undefined) { sendJson(res, 404, { error: '局域网访问未启用' }); return }
      const text = await readBody(req)
      let body: unknown
      try { body = JSON.parse(text) } catch { sendJson(res, 400, { error: 'body 不是合法 JSON' }); return }
      const raw = (body ?? {}) as Record<string, unknown>
      if (typeof raw.enabled !== 'boolean') { sendJson(res, 400, { error: 'enabled 必须是布尔值' }); return }
      await lan.config.set({ lan_access: raw.enabled })
      await applyLan(raw.enabled)
      broadcast({ kind: 'snapshot', state: await composeState() })
      sendJson(res, 200, { ok: true, lan: lanView() })
      return
    }

    /**
     * 本机账号(2026-09-17,决策记录「登录就是账号密码」)。四条路,**都只认回环**:
     *
     *   GET  /account            {registered, logged_in, username?}(没有哈希、没有 salt)
     *   POST /account/register   没账号时注册;已登录时改密(要当前密码)。成功即种 cookie。
     *   POST /account/login      对了就种 cookie(HttpOnly,30 天)。
     *   POST /account/logout     清掉那张 cookie。
     *
     * **这道门不是鉴权**(整张卡最要紧的一句):回环来源照旧放行工作台的一切 —— 壳、本机浏览器、
     * DSH 会话里的事务官、例程,全都靠回环,一条都没改。登录只决定**界面**显示登录屏还是工作台,
     * 前端看的就是这里的 logged_in。局域网/设备令牌那一套(手机)一个字没动:手机的"登录"仍然
     * 是配对,账号同步到手机是下一步。
     *
     * 为什么只认回环:账号只存在这台机器上,局域网上的手机既没有也不需要它;而"用户名+密码"
     * 这种东西一旦对局域网开着,就等于在局域网上开了一个可以慢慢猜的入口。
     * 暴力破解那一层仍然在(错 5 次锁 10 分钟,同 devices.ts):回环上也可能是别的程序在猜。
     */
    if (path === '/account' || path.startsWith('/account/')) {
      if (account === undefined) { sendJson(res, 404, { error: '账号未启用' }); return }
      if (!loopback) { sendJson(res, 403, { error: '账号只在这台机器上:手机请用配对' }); return }
      const token = tokenFromCookieHeader(req.headers.cookie)
      // 注册 / 改名 / 重置都可能换掉用户名:下一拍 /state 重新取(`/state.me`)。
      if (req.method === 'POST') res.once('finish', () => { accountNameAt = 0 })

      if (path === '/account' && req.method === 'GET') {
        sendJson(res, 200, await account.view(token))
        return
      }
      /**
       * 「我的设备」(2026-09-21)。只有账号真的在服务器上时才有这两条 ——
       * 本机账号谈不上"我名下有哪几台"。
       *
       *   GET  /account/devices          列出来(**回包里没有任何令牌**)
       *   POST /account/devices/revoke   移除一台(它的设备令牌当场失效)
       *
       * 与 /account 其余几条同一道门:只认回环。设备列表说得出用户有几台机器、
       * 上次什么时候在线 —— 那是不该对局域网开着的东西。
       *
       * ★ **一处撤销、三处生效**(2026-10-03,卡 claude/device-revoke-complete;
       *   审计附证 A,docs/审计材料/2026-10-03/devices.md 第 39 行起)。
       *
       *   这条路从前只调 `account.revokeDevice` —— 撤的只有**中转那一个凭据体系**。
       *   那台手机回到同一个 Wi-Fi 还照常用 8791(本机设备令牌一个字没动),房里那条
       *   代理也照旧替它办事,还能再签一张七天的进房票。于是「移除这台设备」这句承诺
       *   只兑现了三分之一。现在同一下动三处:
       *     ① 账号归属:`account.revokeDevice`(中转把它的设备令牌删掉);
       *     ② 本机配对:`pairing.revoke(id, 'account')` —— 设备令牌当场作废、落盘,
       *        重启不复活;之后带它来的请求一律 401,那句话说的是「从账号里移除了」;
       *     ③ 房票:签票那一处(`/channel/token`)自己核归属(server/deviceAccountGate.ts),
       *        而续票走的正是那一条,所以**已签的那张到期就续不上**。
       *   已经签出去、还没过期的那张票作废不了(那是 LiveKit 签的 JWT);但它进了房也
       *   什么都办不成 —— 工人代办走的是 `X-Workbench-Channel-Device` 那道门,①② 之后一律 401。
       */
      if (path === '/account/devices' || path === '/account/devices/revoke') {
        if (!isServerAccount(account)) { sendJson(res, 404, { error: '账号还在这台机器上,没有设备列表' }); return }
        if (path === '/account/devices') {
          if (req.method !== 'GET') { sendJson(res, 404, { error: '没有这个路径' }); return }
          const result = await account.devices()
          if (!result.ok) { sendJson(res, 503, { error: result.error }); return }
          sendJson(res, 200, result.view)
          return
        }
        if (req.method !== 'POST') { sendJson(res, 404, { error: '没有这个路径' }); return }
        const body = await readJsonBody(req, res)
        if (body === undefined) return
        const deviceId = typeof body.device_id === 'string' ? body.device_id.trim() : ''
        if (deviceId === '') { sendJson(res, 400, { error: '要说移除哪一台' }); return }
        const result = await account.revokeDevice(deviceId)
        if (!result.ok) { sendJson(res, 503, { error: result.error }); return }
        /**
         * 本机配对也撤掉。顺序是**账号先、本机后**:账号那一下没成(没登录、中转不通)时
         * 这台手机还好着,不该先把它在家里那条路砸了。
         *
         * 回 false 不是错:这台设备可能从来没在局域网里配过对 —— 手机 App 配网那条流程
         * 给座机的 `handset-<machine-id>` 就压根没有本机配对记录(phone-bridge/pairing.py
         * 的 `acquire_ticket` 注释写了那条路不经局域网配对)。那时账号那一撤已经够了。
         */
        const pairingRevoked = pairing === undefined ? false : await pairing.revoke(deviceId, 'account')
        // 本机那份「手机与设备」少了一台:/state 里的 devices 要跟着变。
        if (pairingRevoked) broadcast({ kind: 'snapshot', state: await composeState() })
        sendJson(res, 200, result.view)
        return
      }

      if (req.method !== 'POST') { sendJson(res, 404, { error: '没有这个路径' }); return }

      if (path === '/account/logout') {
        // 账号在服务器上时,登出还要把**服务器那张会话**也吊销(2026-09-21):
        // 只清 cookie 等于"这台看起来下线了,实际上那张长期令牌还在服务器上活着"。
        if (isServerAccount(account)) await account.logout()
        res.setHeader('Set-Cookie', clearedAccountCookieHeader())
        sendJson(res, 200, { ok: true })
        return
      }


      if (path === '/account/reset') {
        // 只认回环(上面那道门已经挡了非本机)。删的是账号记录,记忆/事项/凭据一个字不动。
        await account.reset()
        res.setHeader('Set-Cookie', clearedAccountCookieHeader())
        sendJson(res, 200, { ok: true })
        return
      }
      if (path === '/account/register' || path === '/account/login') {
        const body = await readJsonBody(req, res)
        if (body === undefined) return
        const result = path === '/account/login'
          ? await account.login({ username: body.username, password: body.password })
          : await account.register({
              username: body.username,
              password: body.password,
              confirm: body.confirm,
              current_password: body.current_password,
              ...(token === undefined ? {} : { token }),
            })
        if (!result.ok) {
          sendJson(res, result.status, {
            error: result.error,
            ...(result.locked_until === undefined ? {} : { locked_until: result.locked_until }),
          })
          return
        }
        // 令牌只经这一条 Set-Cookie 出去:不进回包正文(页面脚本读不到才叫 HttpOnly)、不进日志。
        res.setHeader('Set-Cookie', accountCookieHeader(result.token, Math.floor(SESSION_TTL_MS / 1000)))
        sendJson(res, 200, { ok: true, username: result.username, expires_at: result.expires_at })
        /**
         * 注册/登录成功那一刻,顺手把模型服务接上(2026-09-18)。**在响应之后、不 await**:
         *
         * - 领令牌要打一次外网,那台服务器可能慢、可能还没部署好。把它挡在登录响应前面,
         *   等于把"能不能进工作台"绑在一件可有可无的事上 —— 任务卡原话「失败不阻塞登录」。
         * - 失败不声不响也不行:`model.autoSetup()` 会把结论记下来,`/state.setup_alerts.model_service`
         *   据此在顶上出一条「模型服务还没接上 → 重试」。
         *
         * 两条路(注册、登录)都要:注册那台是新机器,登录那台可能是"清过凭据"的旧机器
         * —— Ben 09-18 真机就是后者。
         */
        modelAutoSetup?.kick()
        return
      }
      sendJson(res, 404, { error: '没有这个路径' })
      return
    }

    /**
     * 「首次流程走完没有」(2026-09-17 引导入口)。一面旗子,落在 app.json 的 `first_run_done_at`。
     *
     * 为什么不放 onboarding.json:引导本身可以重来好几遍(`/onboarding/restart`),而**这一面旗子
     * 说的是"注册完之后那三屏给他看过了"**,两件事寿命不同。设置里「重新走一遍首次流程」
     * 就是 POST 一个 `{ done: false }` 把它擦掉。
     */
    /**
     * ★ **三件主路**(2026-10-21,卡「引导三件事」;判法在 `server/firstUse.ts`,口径在 `src/mainPaths.ts`)。
     *
     *   · `GET /first-use` —— 这台机器三件事各成没成、第几天成的(`ledger` 从行为账算)+ 界面那一份(`view`);
     *   · `POST /first-use/prefer {path}` —— 她答的「想先试哪一件」(说「都行」= 清掉,按默认);
     *   · `POST /first-use/try {path, text?}` —— 第一次有用那一屏上点「试一下」:早报现跑一份、交代派一件、电话等她拨;
     *   · `POST /first-use/selfcheck` / `GET` —— 安装器末尾那一遍(只给本机)。
     */
    if (path === '/first-use' && req.method === 'GET') {
      if (options.firstUse === undefined) { sendJson(res, 404, { error: '三件主路未接线' }); return }
      if (!trusted) { sendJson(res, 403, { error: '只能在本机或已配对的手机上看' }); return }
      if (await observeFirstUse()) broadcast({ kind: 'snapshot', state: await composeState() })
      sendJson(res, 200, { view: await firstUseViewNow(), ledger: await options.firstUse.ledgerSummary() })
      return
    }
    if (path === '/first-use/prefer' && req.method === 'POST') {
      if (options.firstUse === undefined) { sendJson(res, 404, { error: '三件主路未接线' }); return }
      if (!trusted) { sendJson(res, 403, { error: '只能在本机或已配对的手机上答' }); return }
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      if (typeof body.path !== 'string') { sendJson(res, 400, { error: 'path 要是 morning / delegate / call 之一,或她说的那句话' }); return }
      await options.firstUse.setPrefer(firstTryOf(body.path))
      broadcast({ kind: 'snapshot', state: await composeState() })
      sendJson(res, 200, { ok: true, ...(firstTryOf(body.path) === undefined ? {} : { prefer: firstTryOf(body.path) }) })
      return
    }
    if (path === '/first-use/try' && req.method === 'POST') {
      if (options.firstUse === undefined) { sendJson(res, 404, { error: '三件主路未接线' }); return }
      if (!loopback && device === undefined) { sendJson(res, 403, { error: '只能在本机或已配对的手机上试' }); return }
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      if (!isMainPath(body.path)) { sendJson(res, 400, { error: 'path 要是 morning / delegate / call 之一' }); return }
      const firstUse = options.firstUse
      await firstUse.trying(body.path)
      if (body.path === 'morning') {
        if (routines === undefined) {
          await firstUse.record({ key: `morning:unavailable:${Date.now()}`, path: 'morning', ok: false, at: new Date().toISOString(), door: 'service', note: '这台工作台没接例程' }, '电脑')
          sendJson(res, 404, { error: '这台工作台没接例程' }); return
        }
        // 现跑一份要一分钟上下(搜一轮、写稿、合成),不让这一下等它:跑完由 observe 记成没成,界面跟着 /state 变。
        void routines.run('morning', 'manual').then(async () => {
          await observeFirstUse()
          broadcast({ kind: 'snapshot', state: await composeState() })
        }, async (err: unknown) => {
          await firstUse.record({ key: `morning:error:${Date.now()}`, path: 'morning', ok: false, at: new Date().toISOString(), door: 'other', note: err instanceof Error ? err.message : '早报没生成，请重试' }, '电脑')
          broadcast({ kind: 'snapshot', state: await composeState() })
        })
        broadcast({ kind: 'snapshot', state: await composeState() })
        sendJson(res, 200, { ok: true, note: FIRST_USE_SAY.morning })
        return
      }
      if (body.path === 'delegate') {
        const text = typeof body.text === 'string' && body.text.trim() !== '' ? body.text.trim() : DELEGATE_DEFAULT_TEXT
        const sent = await firstUseDelegate(text)
        if (!sent.ok) await firstUse.record({ key: `delegate:blocked:${Date.now()}`, path: 'delegate', ok: false, at: new Date().toISOString(), door: sent.door, ...(sent.note === undefined ? {} : { note: sent.note }) }, '电脑')
        broadcast({ kind: 'snapshot', state: await composeState() })
        sendJson(res, 200, sent.ok
          ? { ok: true, id: sent.id, family: sent.family, note: `交给 ${sent.title} 了,回来的结果会写在那张卡上,手机上也看得到。` }
          : { ok: false, door: sent.door, ...(sent.note === undefined ? {} : { note: sent.note }) })
        return
      }
      broadcast({ kind: 'snapshot', state: await composeState() })
      sendJson(res, 200, { ok: true, note: (await phonePairedNow()) ? FIRST_USE_SAY.call : FIRST_USE_SAY.call_desk })
      return
    }
    if (path === '/first-use/selfcheck' && (req.method === 'GET' || req.method === 'POST')) {
      if (options.firstUse === undefined) { sendJson(res, 404, { error: '三件主路未接线' }); return }
      if (!loopback) { sendJson(res, 403, { error: '自检只在这台电脑上跑' }); return }
      const firstUse = options.firstUse
      if (req.method === 'GET') {
        // 自检里派出去的那张卡交回没有,看一眼再答。
        await observeFirstUse()
        const view = firstUse.selfcheck.view()
        if (view === undefined) { sendJson(res, 404, { error: '还没跑过自检' }); return }
        sendJson(res, 200, { ...view, running: firstUse.selfcheck.running() })
        return
      }
      if (firstUse.selfcheck.running()) { sendJson(res, 202, { ok: true, running: true }); return }
      void firstUse.selfcheck.run(selfCheckPorts).then(async () => {
        broadcast({ kind: 'snapshot', state: await composeState() })
      }, () => undefined)
      sendJson(res, 202, { ok: true, running: true })
      return
    }
    /**
     * 实验开关(2026-10-21,卡「引导三件事」):`{ key, on }` 一样一样地改,只在这台电脑上改得了。
     */
    if (path === '/experiments' && req.method === 'POST') {
      if (appConfig === undefined) { sendJson(res, 404, { error: '实验开关未接线' }); return }
      if (!loopback) { sendJson(res, 403, { error: '实验开关只能在这台电脑上改' }); return }
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      if (!isExperimentKey(body.key) || typeof body.on !== 'boolean') { sendJson(res, 400, { error: 'key 要是 video / meeting / handset / window_dispatch 之一,on 要是布尔' }); return }
      await appConfig.set({ experiments: { [body.key]: body.on } })
      broadcast({ kind: 'snapshot', state: await composeState() })
      sendJson(res, 200, { ok: true, experiments: await experimentsNow() })
      return
    }

    if (path === '/first-run' && (req.method === 'GET' || req.method === 'POST')) {
      if (appConfig === undefined) { sendJson(res, 404, { error: '首次流程未启用' }); return }
      if (!loopback) { sendJson(res, 403, { error: '只能在本机看首次流程' }); return }
      if (req.method === 'GET') {
        const config = await appConfig.get()
        sendJson(res, 200, config.first_run_done_at === undefined ? {} : { done_at: config.first_run_done_at })
        return
      }
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      if (typeof body.done !== 'boolean') { sendJson(res, 400, { error: 'done 必须是布尔值' }); return }
      // 擦掉用空字符串:appConfig 的 set 是"部分更新",undefined 表示"这次不改"。
      const next = await appConfig.set({ first_run_done_at: body.done ? new Date().toISOString() : '' })
      /**
       * 首次流程走完这一刻,把"刚写进 DSH 的凭证"落实一次(2026-09-18,任务卡第 2 条)。
       * 与 `/onboarding/session` 那一处是同一份判断(没有会话在跑才真重启),这里只是另一个时机:
       * 跳过引导直接进工作台的那一支走的正是这条 —— 没有它,那条路上领到的令牌要等到
       * 下一次开机才生效。`restartIfPending` 只是**把那一下排上队**(延迟几百毫秒才真发),
       * 所以这个响应仍然出得去 —— 它真发的时候会把跑着这段代码的进程一起换掉。
       */
      const restart = body.done === true ? await modelAutoSetup?.restartIfPending() : undefined
      sendJson(res, 200, {
        ok: true,
        ...(next.first_run_done_at === undefined ? {} : { done_at: next.first_run_done_at }),
        ...(restart?.restarted === true ? { restarting: true, note: restart.note } : {}),
      })
      return
    }

    /**
     * 路径可配(2026-09-17 卡 C,设计-电脑端登录台梳理 §四 + Ben §八④拍板)。
     *
     * - `GET /config/paths` 读:配置值(没配是 null)+ 默认值 + 此刻生效值。**任何允许的来源可读**,
     *   与 /state 同一道门:里面没有凭据,只有几条本机目录路径,而手机端的登录台也要看得到。
     * - `PUT /config/paths` 改:**只认回环**。改的是这台机器要去扫、去盯、去开会话的目录,
     *   跟 /lan、/pair/* 一样属于"信任边界本身",带令牌的手机不能碰。
     *
     * 校验两道:形状与写法在纯函数层(pathConfig.ts),"目录真的在不在"在这里读盘。
     * 两道都过不了就 400 + 一句人话,**一个字都不落盘**——半落盘的配置比没改更难查。
     */
    if (path === '/config/paths' && (req.method === 'GET' || req.method === 'PUT')) {
      if (pathsOption === undefined) { sendJson(res, 404, { error: '路径配置未启用' }); return }
      if (req.method === 'GET') { sendJson(res, 200, await pathsPayload()); return }
      if (!loopback) { sendJson(res, 403, { error: '只能在本机改目录配置' }); return }

      const text = await readBody(req)
      let body: unknown
      try { body = JSON.parse(text) } catch { sendJson(res, 400, { error: 'body 不是合法 JSON' }); return }

      const parsed = wbPathsParsePatch(body, pathsOption.home)
      if (!parsed.ok) { sendJson(res, 400, { error: parsed.error }); return }

      for (const { path: dir, label } of wbPathsDirsToCheck(parsed.patch)) {
        const kind = await pathsStat(dir)
        if (kind === 'dir') continue
        // 分两句话说:压根没有,和"有但是个文件"——后者最常见(把某个文件拖进了输入框)。
        sendJson(res, 400, { error: `${label} ${dir} ${kind === 'other' ? '不是一个目录' : '不存在'}` })
        return
      }

      const next = await pathsOption.config.set(parsed.patch)
      // 扫描缓存作废 + 收件箱重挂。这一步失败不该把"已经落盘了"说成失败,所以吞掉并照常回 200;
      // 最坏情况是晚一个节流周期/一次对账才看到变化,而不是配置丢了。
      try { await pathsOption.onChanged?.(next) }
      catch { /* 接线那一侧自己会记;这里不把落盘成功的结果说成失败 */ }

      const payload = await pathsPayload()
      const restart = wbPathsRestartRequired(parsed.patch)
      const effective = payload.effective as { butler_cwd_source?: string }
      // 环境变量压着 app.json 时要当场说破:不然他改完看见 effective 没变,会以为接口坏了。
      const overridden = parsed.patch.butler_cwd !== undefined && effective.butler_cwd_source === 'env'
      const hint = overridden
        ? '已经写进 app.json,但此刻生效的是环境变量 WORKBENCH_BUTLER_CWD(它优先);'
          + '要让 app.json 这一条生效,得先把 dsh-start 里那个环境变量去掉,再 kickstart 重启。'
        : (restart ? WB_PATHS_RESTART_REQUIRED_HINT : undefined)
      sendJson(res, 200, {
        ok: true,
        restart_required: restart,
        ...(hint === undefined ? {} : { hint }),
        ...payload,
      })
      return
    }

    /**
     * hooks 生成器(卡 C 第 4 条;卡 R 起命令只指钩子脚本的固定位置)。回一份渲染好的 hooks JSON + 一段人话。
     *
     * 这一条**只读**(不碰他的配置文件)。2026-09-17 Ben 拍板放开了「程序不写这两个文件」的护栏之后,
     * 真写那一步在下面的 `POST /config/hooks/apply` —— 界面上是「先看后写」的那个"看":先 GET 摆出来给他看,
     * 他点「写入」才 POST。两条路调的是同一个渲染函数,所以看到的与写进去的必定一致。
     *
     * 摆出来之前先把钩子脚本放到固定位置(`~/.dsh/workbench/hooks/`,工作台自己的目录,内容一样就一个字不写):
     * 摆给他看的命令指着的文件,此刻就得真在。放不成回 503 + 一句人话(下一步「再试一次」)。
     */
    if (path === '/config/hooks' && req.method === 'GET') {
      if (pathsOption === undefined) { sendJson(res, 404, { error: '路径配置未启用' }); return }
      const agentRaw = new URLSearchParams(queryOf(req.url)).get('agent')
      if (agentRaw !== 'claude' && agentRaw !== 'codex') {
        sendJson(res, 400, { error: 'agent 要是 claude 或 codex(Kimi 没有 hook 机制,整家进不来)' })
        return
      }
      const agent: WbHooksAgent = agentRaw
      const scripts = await hooksDirNow()
      if (!scripts.ok) { sendJson(res, 503, { error: scripts.error }); return }
      const rendered = wbHooksRender(agent, scripts.dir)
      const applyable = pathsOption.applyHooks
      sendJson(res, 200, {
        agent,
        hooks_dir: scripts.dir,
        ...rendered,
        // 「先看后写」那一半要的两样:**会写进哪个文件**,以及这台服务接没接代写。
        // 没接代写(老版本、或者故意不接)时界面就退回"照着复制"那条老路,不会画出一颗按不动的按钮。
        ...(applyable === undefined ? {} : { file: applyable.files[agent] }),
        can_apply: applyable !== undefined,
        instructions: wbHooksInstructions(agent),
      })
      return
    }

    /**
     * 钩子由工作台代写 / 一键撤回(2026-09-17,Ben:「按你建议的做」——放开
     * 「程序不写 ~/.claude/settings.json、~/.codex/hooks.json」的护栏)。
     *
     *   POST /config/hooks/apply   {agent}  → 备份 → 只合并工作台自己的那几条 → 回 {ok, backup_path, added, replaced}
     *   POST /config/hooks/revert  {agent}  → 备份 → 只摘掉工作台自己的那几条 → 回 {ok, backup_path, removed}
     *
     * **只认回环**:它写的是这台机器家目录里的文件,比 `/config/paths` 的 PUT 还要重 ——
     * 局域网上拿着令牌的手机一律 403。
     *
     * ★ 2026-09-23「同一个事务官」这一轮**有意留在 `loopback`**,与隔壁 `/config/skill/apply`
     * (那一条改成了 `trusted`)分道扬镳。判据不是"落在哪个文件",是**这是谁的事**:
     * 钩子改的是**这台机器上每一条 DSH 会话怎么起**——机器的接线;技能段改的是
     * **事务官说话与做事的规矩**——事务官自己的能力。手机上没有这台机器的会话要接。
     *
     * 界面上的顺序是**先看后写**:解锁卡上的按钮先 `GET /config/hooks` 把要写的内容摆出来,
     * 他点「写入」才轮到这条路。服务端不强制这个顺序(那要另存一份会话状态),
     * 但两条路吐的是同一份渲染结果,所以"看到的"与"写进去的"必定一致。
     */
    if ((path === '/config/hooks/apply' || path === '/config/hooks/revert') && req.method === 'POST') {
      const applyOption = pathsOption?.applyHooks
      if (pathsOption === undefined || applyOption === undefined) {
        sendJson(res, 404, { error: '代写钩子未启用' })
        return
      }
      if (!loopback) { sendJson(res, 403, { error: '只能在本机改钩子' }); return }

      const body = await readJsonBody(req, res)
      if (body === undefined) return
      const agentRaw = body.agent
      if (agentRaw !== 'claude' && agentRaw !== 'codex') {
        sendJson(res, 400, { error: 'agent 要是 claude 或 codex(Kimi 没有 hook 机制,整家进不来)' })
        return
      }
      const agent: WbHooksAgent = agentRaw
      const file = applyOption.files[agent]
      const deps: WbHooksApplyIo = { io: applyOption.io ?? hooksApplyIo(), now: applyOption.now ?? (() => new Date()) }

      if (path === '/config/hooks/revert') {
        // 撤回**不需要知道脚本在哪** —— 靠的是条目上那个标记(新旧两种位置都认),不是路径。
        // (旧条目还指着开发仓库、或者脚本没放成时,撤回照样摘得干净,这一点要紧。)
        const result = await wbHooksRevert(deps, { file })
        if (!result.ok) { sendJson(res, 400, { error: result.error }); return }
        // 「接上没有」是按钩子判的,钩子刚变了就得重扫 —— 不然界面还要挂 60 秒才跟上。
        clientScan?.invalidate()
        reconcileExecutions?.notifyChanged() // 8791 第六轮第 4 轮:接入状态改「能不能读这家」。
        sendJson(res, 200, {
          ok: true,
          file,
          ...(result.backup_path === undefined ? {} : { backup_path: result.backup_path }),
          removed: result.removed,
          status_line_removed: result.statusLineRemoved,
          note: result.removed === 0 && !result.statusLineRemoved
            ? '这个文件里本来就没有工作台的条目,什么都没改。'
            : '工作台自己的那几条已经撤掉了,文件里别的内容一个字没动。正开着的会话要重开一次才认新配置。',
        })
        return
      }

      // 脚本没放到固定位置就**不写** —— 写进去一条指着空位置的命令,就是几条静默失败的钩子。
      const scripts = await hooksDirNow()
      if (!scripts.ok) { sendJson(res, 503, { error: scripts.error }); return }

      const result = await wbHooksApply(deps, { agent, file, hooksDir: scripts.dir })
      if (!result.ok) { sendJson(res, 400, { error: result.error }); return }
      // 同上:钩子刚写进去,下一拍 /state 就该说"接上了"。
      clientScan?.invalidate()
      reconcileExecutions?.notifyChanged() // 8791 第六轮第 4 轮:接入状态改「能不能读这家」。
      sendJson(res, 200, {
        ok: true,
        agent,
        file,
        hooks_dir: scripts.dir,
        ...(result.backup_path === undefined ? {} : { backup_path: result.backup_path }),
        added: result.added,
        replaced: result.replaced,
        status_line: result.statusLine,
        // hooks 要下一次开会话才生效 —— 不说这一句,他会以为按钮没起作用。
        restart_hint: wbHooksRestartHint(agent),
      })
      return
    }

    /**
     * 「全部接上」(2026-09-25,卡 fix/quota-and-slot-apps)。Claude、Codex **一次看、一次点**:
     *
     *   GET|POST /quota/connect-all/preview        → 两家各要写进哪个文件、写什么(干跑一次合并)+ Kimi 那一句
     *   POST     /quota/connect-all/apply {agents?} → 逐家「备份 → 只合并工作台自己的那几条 → 写回」
     *
     * 每家各自一份备份,所以**撤回仍是一家一颗**:`POST /config/hooks/revert {agent}`,一个字没改。
     * 维护者 09-24:「授权要自己点就算了」—— 可以要他点,但只点一次。引导落地那张卡(卡 B)的
     * 「就这样」带上这一步时,确认仍由他点(那张卡上摆的就是 preview 的内容)。
     *
     * 门与 `/config/hooks/*` 一致:预览只读 → trusted;**真写只认回环**(它动的是这台机器家目录里的文件)。
     * 业务上写不成(一家的文件坏了)不是接口出错:HTTP 200、逐家的结果如实回出去。
     */
    // 四家接没接上(只读,2026-09-25):与 /state.quota_connect 同一份。clients 还没扫过 → 404 说一句。
    if (path === '/quota/connect' && req.method === 'GET') {
      if (!trusted) { sendJson(res, 403, { error: '只有这台电脑或配对过的设备能看' }); return }
      const status = quotaConnectNow(service.getState().quota)
      if (status === undefined) { sendJson(res, 404, { error: '还没扫过这台电脑上装了哪几家(或者没接扫描),过一会儿再看' }); return }
      sendJson(res, 200, status)
      return
    }

    /**
     * **Claude 额度一键接上**(2026-10-03,卡「不让用户知道什么叫 setup-token」):
     *
     *   POST /quota/connect/claude         → 起一次:开浏览器让她用 Claude 账号授权,拿到长期密钥直接存
     *   GET  /quota/connect/claude         → 这一次走到哪了(界面每两秒问一次,同 Kimi 那条登录路)
     *   POST /quota/connect/claude/cancel  → 放弃:把子进程杀干净,状态回「没在接」
     *
     * 门与写凭据一致:**真起进程、真写密钥只认回环**(它在这台机器上弹浏览器、往家目录里写 0600 的文件);
     * 读进度 `trusted` 就够 —— 里面只有状态和一句人话,**一个字节的密钥都没有**(用例 grep 回包)。
     */
    if (path === '/quota/connect/claude' || path === '/quota/connect/claude/cancel') {
      if (claudeConnect === undefined) {
        sendJson(res, 404, { error: '这台工作台没接「一键接上」(照旧可以把一串密钥粘进设置里那一行)' })
        return
      }
      if (req.method === 'GET' && path === '/quota/connect/claude') {
        if (!trusted) { sendJson(res, 403, { error: '只有这台电脑或配对过的设备能看' }); return }
        sendJson(res, 200, claudeConnectNow())
        return
      }
      if (req.method !== 'POST') { sendJson(res, 405, { error: '只支持 GET / POST' }); return }
      if (!loopback) { sendJson(res, 403, { error: '只能在这台电脑上接' }); return }

      if (path === '/quota/connect/claude/cancel') {
        claudeConnectRun?.cancel()
        claudeConnectRun = undefined
        claudeConnectLast = undefined
        sendJson(res, 200, { state: 'idle', message: '' })
        return
      }

      // 重复点直接顶掉上一次 —— 上一次那个浏览器窗口她可能已经关了,不该把人锁死。
      claudeConnectRun?.cancel()
      claudeConnectLast = undefined
      claudeConnectRun = connectClaudeQuota({
        ...claudeConnect,
        save: async token => await saveClaudeSetupToken(token),
      })
      // 没装那条命令行时这一下就已经是终局(如实说那一句,一次 spawn 都没做)。
      const started = claudeConnectRun.progress()
      if (started.state === 'failed') { claudeConnectLast = started; claudeConnectRun = undefined }
      sendJson(res, 200, started)
      return
    }

    if (path === '/quota/connect-all/preview' && (req.method === 'GET' || req.method === 'POST')) {
      if (!trusted) { sendJson(res, 403, { error: '只有这台电脑或配对过的设备能看' }); return }
      const deps = connectAllDeps()
      if (deps === undefined) { sendJson(res, 404, { error: '代写钩子未启用' }); return }
      const preview = await connectAllPreview(deps)
      // 唯一会走到这里的是钩子脚本没放好(卡 R):503 + 一句人话(下一步「再试一次」)。
      if (!preview.ok) { sendJson(res, 503, { error: preview.error }); return }
      sendJson(res, 200, preview)
      return
    }

    if (path === '/quota/connect-all/apply' && req.method === 'POST') {
      const deps = connectAllDeps()
      if (deps === undefined) { sendJson(res, 404, { error: '代写钩子未启用' }); return }
      if (!loopback) { sendJson(res, 403, { error: '只能在本机改钩子' }); return }
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      let agents: ('claude' | 'codex')[] | undefined
      if (body.agents !== undefined) {
        if (!Array.isArray(body.agents) || body.agents.some(agent => agent !== 'claude' && agent !== 'codex')) {
          sendJson(res, 400, { error: 'agents 要是 ["claude","codex"] 里的几项(Kimi 要他自己登,工作台代不了)' })
          return
        }
        agents = body.agents as ('claude' | 'codex')[]
      }
      const applied = await connectAllApply(deps, agents === undefined ? {} : { agents })
      // 钩子脚本没放好 = 整件事一个字没写(不是"写了一半"),同 /config/hooks/apply 回 503 那句人话。
      if (!('results' in applied)) { sendJson(res, 503, { error: applied.error }); return }
      // 「接上没有」是按钩子判的,钩子刚变了就得重扫 —— 不然额度面板还要挂 60 秒才跟上。
      clientScan?.invalidate()
      reconcileExecutions?.notifyChanged() // 8791 第六轮第 4 轮:接入状态改「能不能读这家」。
      broadcast({ kind: 'snapshot', state: await composeState() })
      sendJson(res, 200, applied)
      return
    }

    /**
     * 事务官的技能段:派活给别家 Agent(2026-09-21,参赛冲刺卡 ④)。
     *
     *   GET  /config/skill          → 要写什么(先看后写的那个"看")+ 这台电脑上各家 CLI 的实测表
     *   POST /config/skill/apply    → 备份 → 只换那一个标记段 → 回 {ok, backup_path, block}
     *   POST /config/skill/revert   → 备份 → 只摘掉那一段 → 回 {ok, backup_path, removed}
     *
     * 写的是 `~/.dsh/AGENTS.md`,机制与「说话方式」一模一样(标记段,段外一个字不动)。
     * **只认回环**:同 /config/hooks/apply —— 它动的是这台机器家目录里的文件。
     *
     * 正文 = 仓库里那份 `docs/技能/派活给别家Agent.md` + **现探的 CLI 表**。
     * 仓库里那份读不到就**一个字都不写**(而不是写一份空技能):事务官拿着半份技能去派活,
     * 比没有技能更坏 —— 它会开始自己编命令。
     */
    if (path === '/config/skill' && req.method === 'GET') {
      const prepared = await prepareDispatchSkill()
      if (!prepared.ok) { sendJson(res, prepared.status, { error: prepared.error }); return }
      sendJson(res, 200, {
        file: prepared.file,
        block: WB_SKILL_DISPATCH,
        body: prepared.body,
        clis: prepared.clis,
      })
      return
    }

    if ((path === '/config/skill/apply' || path === '/config/skill/revert') && req.method === 'POST') {
      /**
       * ★ 2026-09-23:`loopback` → `trusted`(Ben 拍板「同一个事务官」,见 `trusted` 那段注释)。
       * **技能是事务官自己的能力,不是这台机器的装配** —— 她在手机上决定"事务官从今天起会派活",
       * 和在电脑上决定,是同一个人的同一个决定。
       *
       * 与 `/config/hooks/apply` 的分界(那一条**留在 loopback**):钩子改的是这台机器上
       * **每一条 DSH 会话怎么起**,那是机器的接线;技能段改的是**事务官说话与做事的规矩**。
       * 两条都落在 `~/.dsh/AGENTS.md` 附近,但"落在哪个文件"从来不是这道门的判据。
       *
       * 先例:`/evolve/wire`(固化一条技能草稿进 `~/.dsh/AGENTS.md` 的标记段)本来就是 `trusted`。
       * 这一改是把同一族的两条对齐,不是开一条新口子。写法照旧:备份 → 只换标记段 → 可 revert。
       */
      if (!trusted) { sendJson(res, 403, { error: '只有这台电脑或配对过的设备能改事务官的技能' }); return }
      const prepared = await prepareDispatchSkill()
      if (!prepared.ok) { sendJson(res, prepared.status, { error: prepared.error }); return }

      if (path === '/config/skill/revert') {
        const reverted = await wbSkillRevert(prepared.deps, { file: prepared.file, name: WB_SKILL_DISPATCH })
        if (!reverted.ok) { sendJson(res, 400, { error: reverted.error }); return }
        sendJson(res, 200, {
          ok: true,
          file: prepared.file,
          ...(reverted.backup_path === undefined ? {} : { backup_path: reverted.backup_path }),
          removed: reverted.removed,
          note: reverted.removed
            ? '派活技能那一段已经摘掉了,AGENTS.md 里别的内容一个字没动。'
            : 'AGENTS.md 里本来就没有这一段,什么都没改。',
        })
        return
      }

      // 2026-10-02:正文落盘、段里只留索引(与起服务那条路同形,见 `opsSkillIndexEntry`)。
      const applied = await wbSkillApply(prepared.deps, {
        file: prepared.file,
        name: WB_SKILL_DISPATCH,
        body: prepared.body,
        ...(prepared.bodyFile === undefined ? {} : { bodyFile: prepared.bodyFile }),
      })
      if (!applied.ok) { sendJson(res, 400, { error: applied.error }); return }
      sendJson(res, 200, {
        ok: true,
        file: prepared.file,
        block: WB_SKILL_DISPATCH,
        ...(applied.backup_path === undefined ? {} : { backup_path: applied.backup_path }),
        result: applied.block,
        clis: prepared.clis,
        // 技能段跟钩子一样要**下一次开会话**才读得到 —— 不说这一句他会以为没写进去。
        restart_hint: '正开着的那条事务官会话还是旧的系统提示 —— 新开一条它才读得到这份技能。',
      })
      return
    }

    /**
     * 运营技能包(2026-09-21,白板第四节第 4 条)。
     *
     *   GET  /config/ops-skills        这个模板下要写哪几段、每段落什么产物、仓库里读到了没有
     *   POST /config/ops-skills/apply  备份 → 逐段换进 ~/.dsh/AGENTS.md 的标记段 → 写回
     *
     * **模板闸在 `wbOpsSkillsApply` 里**(server/opsSkills.ts 的 `opsSkillsForTemplate`):
     * 自媒体运营模板下写那十段,做产品模板下把它们**摘掉**。所以这条路在做产品模板下
     * 不是"什么都不做",而是"确保一段都不剩" —— 切了模板事务官的行为必须跟着变。
     *
     * **只认回环**:它写的是他家目录里的 `~/.dsh/AGENTS.md`,同 `/config/hooks/apply`。
     *
     * 与 `feat/agent-dispatch-skill` 那条 `/config/skill` **互不相干**:那一条管"派活"
     * 单独一段,这一条管运营那十段,两边共用的只有 hooksApply 里那套"备份 → 换段 → 写回"。
     *
     * 2026-09-22(卡 ①):准备那一半挪进了 `prepareOpsSkills()` —— 切模板与起服务时的
     * **自动接上**走的是同一份,免得"自动接的"与"界面上看到的"各算一遍。
     * GET 多回一格 `attached`:现在 AGENTS.md 里到底有没有那几段(设置里那行状态、
     * 体检页那一项读的都是它)。
     */
    if ((path === '/config/ops-skills' && req.method === 'GET')
      || (path === '/config/ops-skills/apply' && req.method === 'POST')) {
      const prepared = await prepareOpsSkills()
      if (!prepared.ok) { sendJson(res, prepared.status, { error: prepared.error }); return }
      // ★ 2026-09-23:同 `/config/skill/apply`,`loopback` → `trusted`(Ben 拍板「同一个事务官」)。
      // 运营那十段技能是事务官的能力;判据见 `trusted` 那段注释,不是"落在哪个文件"。
      if (!trusted) { sendJson(res, 403, { error: '只有这台电脑或配对过的设备能改事务官的技能' }); return }
      const { file: agentsFile, templateId, skills, readDoc } = prepared

      if (req.method === 'GET') {
        // 「先看后写」那一半:摆出这个模板下要写哪几段、仓库里读到了没有、现在接上了没有。
        const state = await opsSkillsAttached(prepared)
        const rows = await Promise.all(skills.map(async (skill) => {
          const text = await readDoc(skill)
          return {
            name: skill.name,
            summary: skill.summary,
            artifacts: skill.artifacts,
            doc: opsSkillDoc(skill),
            // 读不到就如实说读不到 —— 点了「接上」之后那一段本来也不会写(D13)。
            found: text !== undefined && text.trim() !== '',
            /** 这一段此刻在不在 `~/.dsh/AGENTS.md` 里。 */
            attached: state.attached.includes(skill.name),
          }
        }))
        sendJson(res, 200, {
          template: templateId ?? null,
          file: agentsFile,
          ...(prepared.repoRoot === undefined ? {} : { repo_root: prepared.repoRoot }),
          wordlist: OPS_WORDLIST_DOC,
          skills: rows,
          /**
           * 「已接上 n 条 / 没接上」那一行的全部依据。`ok` 不是"该在的都在"这一条 ——
           * 还要"不该在的都不在"(切回做产品却没摘干净,事务官会继续按运营那套做事)。
           */
          attached: {
            ok: state.ok,
            expected: state.expected,
            attached: state.attached,
            absent: state.absent,
            stray: state.stray,
          },
          note: skills.length === 0
            ? '当前不是自媒体运营模板,这里一段都不会写;点「接上」只会把以前写过的运营技能段摘掉。'
            : `自媒体运营模板下要写 ${skills.length} 段,写进 ${agentsFile} 的标记段里,段外一个字不动。`,
        })
        return
      }

      const ensured = await ensureOpsSkills()
      // prepareOpsSkills 刚回过 ok,这里不可能是"没接线";真走到就是代码改坏了,如实报 500。
      if (ensured === undefined) { sendJson(res, 500, { error: '代写事务官技能这会儿不可用' }); return }
      if (!ensured.ok) { sendJson(res, 400, { error: ensured.error }); return }
      sendJson(res, 200, {
        ok: true,
        file: agentsFile,
        template: templateId ?? null,
        ...(ensured.backup_path === undefined ? {} : { backup_path: ensured.backup_path }),
        changed: ensured.changed,
        written: ensured.written,
        removed: ensured.removed,
        missing: ensured.missing,
        note: ensured.note,
        // 技能段跟钩子一样要**下一次开会话**才读得到 —— 不说这一句他会以为没写进去。
        restart_hint: '正开着的那条事务官会话还是旧的系统提示 —— 新开一条它才读得到这几份技能。',
      })
      return
    }

    /**
     * 登录台(2026-09-17,docs/设计-电脑端登录台梳理-2026-09-17.md 第二、三节)。
     *
     *   GET  /setup/status        逐项体检。
     *   POST /setup/install       起一步安装,立刻回 job id。
     *   GET  /setup/install/:job  这一步跑到哪了(界面轮询它)。
     *   POST /setup/open          打开系统设置的某一页(授权只能 Ben 自己点,这里只引路)。
     *   GET  /setup/apk.json      手机端的包出过没有。
     *   GET  /setup/apk           下载那个包。
     *
     * **除了下载 APK,其余一律只认回环**:这几条路能改这台机器的运行时、写 launchd、
     * 往 /Applications 里装东西 —— 手机拿着设备令牌也不该碰得到。
     * APK 那条是故意的例外,理由与 /pair/claim 同类:一台还没配对的新手机要先有 App 才谈得上
     * 配对,而它此刻手上什么令牌都没有。暴露面就是一个安装包(里头没有任何本机凭据),
     * 而且只有「允许手机在局域网访问」开着时那条 0.0.0.0 监听才存在。
     */
    /**
     * 热更新(2026-09-18,Ben:「能加热更新的按钮吗,更新完之后重启」)。
     *
     *   GET  /update/check      去服务器取一次清单、比一次版本(界面那颗「检查更新」)。
     *   POST /update/apply      起一条更新作业,立刻回 job id。
     *   GET  /update/job/:id    这条作业跑到哪了(`/setup/install/:job` 也认同一批 id)。
     *
     * **一律只认回环**,理由与 `/setup/*` 同一条:这几条路会往这台机器上下载并安装代码、
     * 重启服务。手机拿着有效的设备令牌也碰不到(有用例钉着)。
     */
    /**
     * 「装运行环境」那颗按钮(2026-09-26,卡 U6):一趟里跑 `profile` → `runtime` → `restart`。
     *
     * **单开一条而不是走 `/update/apply`**:它不联网、不要清单 —— 判据与要装的东西都在本机
     * (见 setup/runtimeRepair.ts)。一台连不上 api.aibooo.cn 的机器照样补得上,
     * 那天统筹手工敲的也正是这三条命令。
     *
     * 回的是 `SetupJobView`,所以界面用 `/setup/install/:job` 那同一套轮询。
     */
    if (path === '/update/runtime' && req.method === 'POST') {
      if (runtimeRepair === undefined) { sendCodedError(res, 404, '这一版没有「装运行环境」这条路'); return }
      if (!loopback) { sendCodedError(res, 403, '只能在本机装运行环境'); return }
      const started = runtimeRepair.start()
      if ('error' in started) { sendJson(res, 409, { error: started.error }); return }
      sendJson(res, 200, started)
      return
    }
    if (path.startsWith('/update/') && update === undefined) {
      // 真装着的这一份(有 HOME)只是没有更新地址:「检查更新」如实说一句,不当成出错(零服务器档)。
      if (setupEnvSource !== undefined && updateManifestUrl === undefined && path === '/update/check' && req.method === 'GET') {
        sendJson(res, 200, { current: PLUGIN_VERSION, available: false, checked_at: new Date().toISOString(), error: UPDATE_NOT_CONFIGURED, not_configured: true } satisfies UpdateCheckView)
        return
      }
      sendCodedError(res, 404, setupEnvSource !== undefined && updateManifestUrl === undefined ? UPDATE_NOT_CONFIGURED : '热更新未启用')
      return
    }
    if (path === '/update/check' && req.method === 'GET' && update !== undefined) {
      if (!loopback) { sendCodedError(res, 403, '只能在本机查更新'); return }
      sendJson(res, 200, await update.check())
      return
    }
    if (path === '/update/apply' && req.method === 'POST' && update !== undefined) {
      if (!loopback) { sendCodedError(res, 403, '只能在本机更新'); return }
      const started = update.apply()
      if ('error' in started) { sendJson(res, 409, { error: started.error }); return }
      sendJson(res, 200, started)
      return
    }
    /**
     * 更新通道(2026-10-21,内测发版底座)。`GET` 回这台机器收哪条;`POST { channel }` 切过去,
     * 当场按新通道查一次并回那一趟的结论(界面直接拿它重画)。
     * 同 `/update/*` 一律只认回环:收哪条通道是这台机器的装配,不是手机上的事。
     */
    if (path === '/update/channel' && req.method === 'GET' && update !== undefined) {
      if (!loopback) { sendCodedError(res, 403, '只能在本机看更新通道'); return }
      sendJson(res, 200, { channel: await update.channel() })
      return
    }
    if (path === '/update/channel' && req.method === 'POST' && update !== undefined) {
      if (!loopback) { sendCodedError(res, 403, '只能在本机切更新通道'); return }
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      if (!isUpdateChannel(body.channel)) { sendCodedError(res, 400, 'channel 只能是 stable 或 hotfix'); return }
      const switched = await update.setChannel(body.channel)
      if ('error' in switched) { sendJson(res, 409, { error: switched.error }); return }
      sendJson(res, 200, switched)
      return
    }
    if (path.startsWith('/update/job/') && req.method === 'GET' && update !== undefined) {
      if (!loopback) { sendCodedError(res, 403, '只能在本机看更新进度'); return }
      const job = update.job(decodeURIComponent(path.slice('/update/job/'.length)))
      if (job === undefined) { sendCodedError(res, 404, '没有这条更新作业(服务重启过?重新点一次)'); return }
      sendJson(res, 200, job)
      return
    }

    /**
     * 串联真机打点(2026-09-24 第五轮,见 handoffPerf.ts):两端登录 / 配对后送来一份 3 秒帧间隔摘要,
     * 只收白名单数字,写一行进本机日志;`GET` 只认回环,看最近每端一份。
     */
    if (path === '/perf/handoff' && req.method === 'POST') {
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      const parsed = parseHandoffPerf(body)
      if ('error' in parsed) { sendJson(res, 400, { error: parsed.error }); return }
      handoffPerfLog.record(parsed)
      sendJson(res, 200, { ok: true })
      return
    }
    if (path === '/perf/handoff' && req.method === 'GET') {
      if (!loopback) { sendJson(res, 403, { error: '只能在本机看' }); return }
      sendJson(res, 200, handoffPerfLog.view())
      return
    }

    /**
     * 诊断包与自动上报(2026-09-22)。
     *
     *   POST /diag/export     打一个包落到桌面并在访达里选中(体检页那颗按钮)。
     *   GET  /diag/settings   那颗「出错自动报告给开发者」的开关此刻什么样。
     *   POST /diag/settings   开 / 关它。
     *   POST /diag/notice-seen 「那段说明我看过了」。
     *
     * **一律只认回环**,理由与 `/setup/*`、`/update/*` 同一条:导出会把这台机器上的
     * 日志与配置写成一个文件放到桌面,而那个文件里有路径、项目名、应用名。
     * 手机拿着有效的设备令牌也碰不到(有用例钉着)。
     */
    /**
     * 「我反馈过的问题」(2026-09-28,卡 FB)。
     *
     *   GET  /diag/feedback         发了几条、各自什么状态(体检页那一行读它)。
     *   POST /diag/feedback         手工记一条(她自己说「我要反馈一个问题」,或别的入口认出本体的毛病)。
     *   POST /diag/feedback/settle  拿不准那一条定档:`to: 'product'` 真是本体(发出去)/ `'hers'` 不是(撤掉,当普通一件事办)。
     *
     * **只认回环**,理由同下面诊断那几条:这几条路里有她的原话。手机与电话不直接碰它们 ——
     * 那两头说的话走 `/butler/item`,分流在那儿做,记这一条也在那儿顺手做掉。
     *
     * **摆在诊断那道「没接线就 404」的闸之前**:反馈通道与诊断是两件事,
     * 一台没接诊断的机器(测试里那一大批、将来某个精简装法)照样该反馈得出去。
     */
    if (path.startsWith('/diag/feedback') && feedback === undefined) {
      sendCodedError(res, 404, '反馈通道未启用')
      return
    }
    if (path === '/diag/feedback' && req.method === 'GET' && feedback !== undefined) {
      if (!loopback) { sendCodedError(res, 403, '只能在本机看反馈过什么'); return }
      sendJson(res, 200, await feedback.list())
      return
    }
    if (path === '/diag/feedback' && req.method === 'POST' && feedback !== undefined) {
      if (!loopback) { sendCodedError(res, 403, '只能在本机记反馈'); return }
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      const said = typeof body.said === 'string' ? body.said.trim() : ''
      if (said === '') { sendCodedError(res, 400, 'said(她的原话)不能空着'); return }
      // 一句整理仍然由代码拼(`feedbackNote`),调用方说不说都一样 —— 整理不许整理出她没说过的意思。
      const ui = triageRequest(said).ui
      const entry = await feedback.add({ said, note: feedbackNote(said, ui), ...(ui === undefined ? {} : { ui }) })
      sendJson(res, 200, { ok: true, feedback: entry, note: FEEDBACK_REPLY_LINE })
      return
    }
    if (path === '/diag/feedback/settle' && req.method === 'POST' && feedback !== undefined) {
      if (!loopback) { sendCodedError(res, 403, '只能在本机定这一条'); return }
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      const id = typeof body.id === 'string' ? body.id : ''
      const toRaw = typeof body.to === 'string' ? body.to : ''
      const to = toRaw === 'product' || toRaw === 'hers' ? toRaw : undefined
      if (id === '' || to === undefined) { sendCodedError(res, 400, "要带 id 与 to('product' 或 'hers')"); return }
      const before = await feedback.find(id)
      const entry = await feedback.settle(id, to)
      if (entry === undefined) { sendCodedError(res, 404, '没有这一条反馈(服务重启过?再说一次)'); return }
      if (to === 'product') {
        sendJson(res, 200, { ok: true, feedback: entry, note: FEEDBACK_REPLY_LINE })
        return
      }
      /*
       * 她说「不是本体的毛病」→ 那条反馈撤掉,**她原来那句话不能就这么丢了**:
       * 照旧当一件事建卡(同 /devtool/confirm 那一步之后回到既有那条路)。看板没接线就如实说。
       */
      if (tasks === undefined || before === undefined) {
        sendJson(res, 200, { ok: true, feedback: entry, note: '那我不反馈了。这件事你再说一遍我就去办。' })
        return
      }
      const made = await createButlerItem(before.said)
      broadcast({ kind: 'snapshot', state: await composeState() })
      sendJson(res, 200, {
        ok: true,
        feedback: entry,
        ...(made.ok ? { id: made.id } : {}),
        note: made.ok ? '好,那这件我当成一件活来办。' : '那我不反馈了,可这件事也没建上卡,你再说一遍。',
      })
      return
    }

    if (path.startsWith('/diag/') && diag === undefined) {
      sendCodedError(res, 404, '诊断未启用')
      return
    }
    if (path === '/diag/export' && req.method === 'POST' && diag !== undefined) {
      if (!loopback) { sendCodedError(res, 403, '只能在本机导出诊断包'); return }
      const result = await diag.export()
      // 业务失败 HTTP 层照样 200,把 { ok:false, error } 如实回去(同 /channel/start)。
      sendJson(res, 200, result)
      return
    }
    /**
     * 「发诊断包」(2026-10-21,内测发版底座):手机设置与电脑体检页上同一颗键。
     *
     * **认 `trusted`(配对过的设备),不像 `/diag/export` 只认回环** —— 那是这一页的一处有意的例外:
     * export 把一个 zip 落在这台 Mac 的桌面上、弹访达,在手机上没有意义;这一条只是让电脑把包
     * **交给我们自己的中转**(用这台电脑的设备令牌),手机拿回来的只有一个六位编号与「包在哪」那句话,
     * 包里的任何文件都不经手机。她出门在外出了事,能自己把现场交出去,正是这张卡要的。
     *
     * 起作业、立刻回(打包几十秒,手机那条房间代理 15 秒就放弃);`GET` 看最近那一趟。
     */
    if (path === '/diag/send' && req.method === 'POST' && diag !== undefined) {
      if (!trusted) { sendCodedError(res, 403, '要配对过的设备才能发诊断包'); return }
      sendJson(res, 200, diag.send())
      return
    }
    if (path === '/diag/send' && req.method === 'GET' && diag !== undefined) {
      if (!trusted) { sendCodedError(res, 403, '要配对过的设备才能看诊断包'); return }
      sendJson(res, 200, diag.sendView() ?? { state: 'none' })
      return
    }
    if (path === '/diag/settings' && req.method === 'GET' && diag !== undefined) {
      if (!loopback) { sendCodedError(res, 403, '只能在本机看诊断设置'); return }
      sendJson(res, 200, await diag.settings())
      return
    }
    if (path === '/diag/settings' && req.method === 'POST' && diag !== undefined) {
      if (!loopback) { sendCodedError(res, 403, '只能在本机改诊断设置'); return }
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      if (typeof body.report_enabled !== 'boolean') {
        sendCodedError(res, 400, 'report_enabled 必须是 true 或 false')
        return
      }
      sendJson(res, 200, await diag.setReportEnabled(body.report_enabled))
      return
    }
    if (path === '/diag/notice-seen' && req.method === 'POST' && diag !== undefined) {
      if (!loopback) { sendCodedError(res, 403, '只能在本机记这一条'); return }
      sendJson(res, 200, await diag.markNoticeSeen())
      return
    }

    if (path.startsWith('/setup/') && setup === undefined) {
      sendCodedError(res, 404, '登录台未启用')
      return
    }
    /**
     * ★ **一眼查这件事走到哪一步**(2026-10-02,卡 AG;设计第 1 段 B「任务记录」那条 `GET /jobs/:id/trace`)。
     *
     * 回的是从任务日志里**数出来**的四步:指派 → 投递 → 完成 / 超时 / 读不到 → 已打电话 / 按规矩不打,
     * 加上这件事的全部事件(含动作闸每一次放行 / 拦下与原因)。**没走到的那一格缺席**,一个字都不编。
     * 这一版账在内存里 —— 工作台重启就空了,回包里如实说一句。
     */
    if (path.startsWith('/jobs/') && path.endsWith('/trace') && req.method === 'GET') {
      if (!loopback) { sendCodedError(res, 403, '只能在本机查任务记录'); return }
      const id = decodeURIComponent(path.slice('/jobs/'.length, -'/trace'.length))
      if (id === '') { sendCodedError(res, 400, '要查哪一件事(事项 id)'); return }
      const trace = jobLog.trace(id)
      /*
       * ★ **写盘坏了要说出来**(2026-10-02,卡 AG2;设计根子 3「回电台账落盘失败被吞」那条教训)。
       * 账现在落盘(只追加的 jsonl,重启还查得到),可盘写不进去的时候**不许装作记上了**:
       * 这里原样带上那句原话 —— 查的人看见 `persist_error` 就知道这一份可能不全。
       */
      const persistError = jobLog.persistError()
      sendJson(res, 200, {
        ...trace,
        note: trace.events.length === 0
          ? '这件事账上一条都没有 —— 查不到不等于没发生过(账只记派活 / 捎话 / 动作闸那几步)'
          : undefined,
        dropped: jobLog.dropped(),
        ...(jobLog.unreadable() > 0 ? { unreadable: jobLog.unreadable() } : {}),
        ...(persistError === undefined ? {} : { persist_error: persistError }),
      })
      return
    }
    if (path === '/setup/status' && req.method === 'GET' && setup !== undefined) {
      if (!loopback) { sendCodedError(res, 403, '只能在本机做就绪检查'); return }
      sendJson(res, 200, await setup.status())
      return
    }
    if (path === '/setup/install' && req.method === 'POST' && setup !== undefined) {
      if (!loopback) { sendCodedError(res, 403, '只能在本机装'); return }
      const text = await readBody(req)
      let body: unknown
      try { body = JSON.parse(text) } catch { sendCodedError(res, 400, 'body 不是合法 JSON'); return }
      const raw = (body ?? {}) as Record<string, unknown>
      if (!isSetupInstallStep(raw.step)) { sendCodedError(res, 400, 'step 不是认得的安装步骤'); return }
      sendJson(res, 200, setup.install(raw.step))
      return
    }
    if (path.startsWith('/setup/install/') && req.method === 'GET' && setup !== undefined) {
      if (!loopback) { sendCodedError(res, 403, '只能在本机看安装进度'); return }
      const id = decodeURIComponent(path.slice('/setup/install/'.length))
      // 热更新的作业也从这条路查(2026-09-18):两边作业**同一个形状**,界面那个进度框
      // 与那套 1 秒轮询因此一份代码两处用。id 认不出来才 404。
      // 2026-09-26 起「装运行环境」那一趟(三步合成的一条)也在这里查。
      const job = setup.job(id) ?? update?.job(id) ?? runtimeRepair?.job(id)
      if (job === undefined) { sendCodedError(res, 404, '没有这条安装作业(服务重启过?重新点一次)'); return }
      sendJson(res, 200, job)
      return
    }
    if (path === '/setup/open' && req.method === 'POST' && setup !== undefined) {
      if (!loopback) { sendCodedError(res, 403, '只能在本机打开系统设置'); return }
      const text = await readBody(req)
      let body: unknown
      try { body = JSON.parse(text) } catch { sendCodedError(res, 400, 'body 不是合法 JSON'); return }
      const raw = (body ?? {}) as Record<string, unknown>
      if (!isSetupPane(raw.pane)) { sendCodedError(res, 400, 'pane 不是认得的系统设置页'); return }
      /**
       * 辅助功能那一页(2026-09-23 从零重装验收):壳启动时不再弹系统框,**这里才是弹框的时机** ——
       * 他在引导第 3 步 / 体检 / 横幅 / 窗位槽红字上点了「去授权」,旁边已经写着为什么要它。
       * 先让壳调带 prompt 的那一下(系统弹框 + 把「工作台」登记进辅助功能列表;从没调过的话
       * 那张表里根本没有「工作台」这一行,打开设置页他也找不到开关),再照旧打开设置页 ——
       * 两样都做,是因为系统那个框同一个进程里不一定每次都肯再弹,设置页保证按下去一定有反应。
       * 壳没连上 / 老壳不认这个 op / 超时:都不挡打开设置页,只是少了那个系统框。
       */
      if (raw.pane === 'accessibility' && helper !== undefined && helper.connected() && !helper.view().authorized) {
        await helper.request({ op: 'request_accessibility' }, 3_000).catch(() => undefined)
      }
      const result = await setup.openPane(raw.pane)
      sendJson(res, result.ok ? 200 : 500, result.ok ? { ok: true } : { error: result.error })
      return
    }
    if (path === '/setup/apk.json' && req.method === 'GET' && setup !== undefined) {
      if (!loopback) { sendCodedError(res, 403, '只能在本机看手机端的包'); return }
      sendJson(res, 200, await setup.apk())
      return
    }
    if (path === '/setup/apk' && req.method === 'GET' && setup !== undefined) {
      const file = await setup.apkFile()
      if (file === undefined) {
        sendCodedError(res, 404, '手机端的包还没出过。在仓库 butler-app/ 里跑一次 `pnpm android:debug`。')
        return
      }
      res.writeHead(200, {
        'content-type': 'application/vnd.android.package-archive',
        'content-length': String(file.size),
        'content-disposition': 'attachment; filename="butler.apk"',
      })
      const stream = createReadStream(file.path)
      // 读到一半出错时连接已经在发了,改不了状态码 —— 只能掐断,让手机那边显示下载失败。
      stream.on('error', () => { res.destroy() })
      stream.pipe(res)
      return
    }

    /**
     * 布局快照(2026-09-10,记忆第一族「工作台长什么样」)。**只读、任何来源可读**——
     * 和 /state 同一道来源门(isRemoteAllowed),不额外设门:它是 /state 的一个可读视图,
     * 里面没有任何 /state 没有的东西(尤其没有凭据)。
     *
     * 现渲现给,不读落盘那一份:回的是**此刻**的布局。每天那一份归档在
     * ~/.dsh/workbench/snapshots/,由 layoutSnapshot 服务在「下班」时刻落。
     */
    if (req.method === 'GET' && (path === '/snapshot/layout.md' || path === '/snapshot/layout.html')) {
      const snapshot = renderLayoutSnapshot(snapshotInputOf(await composeState()))
      if (path.endsWith('.md')) sendText(res, 200, 'text/markdown', snapshot.markdown)
      else sendText(res, 200, 'text/html', snapshot.html)
      return
    }

    if (req.method === 'POST' && path === '/event') {
      const text = await readBody(req)
      let body: unknown
      try {
        body = JSON.parse(text)
      } catch {
        sendJson(res, 400, { error: 'body 不是合法 JSON' })
        return
      }

      const parsed = parseEvent(body)
      if ('error' in parsed) {
        sendJson(res, 400, { error: parsed.error })
        return
      }

      service.applyEvent(parsed.event)
      // 增量先推出去，展示台不必等下一次快照。
      broadcast({ kind: 'event', event: parsed.event })
      sendJson(res, 200, { ok: true })
      return
    }

    if (req.method === 'POST' && path === '/phone/event') {
      const text = await readBody(req)
      let body: unknown
      try {
        body = JSON.parse(text)
      } catch {
        sendJson(res, 400, { error: 'body 不是合法 JSON' })
        return
      }

      const parsed = parsePhoneEvent(body)
      if ('error' in parsed) {
        sendJson(res, 400, { error: parsed.error })
        return
      }

      // 工作台不在这儿做任何判断，只把话机动向翻给订阅者——
      // 停铃、切画面都是展示台按消息自己渲染（C2：判断不下放，但渲染归它）。
      broadcast({
        kind: 'call',
        phase: parsed.event.type,
        agent: parsed.event.agent,
        session_id: parsed.event.session_id,
      })
      // 例外：POP 摘机/未接停掉的是**试铃**时要顺手清掉翻转态——不清的话
      // 展示台早就不响了、这头还记着"响着"，下一次按钮会变成一次空停铃
      //（真机实测：Ben 用 POP 停试铃后再按，得按两下才响）。
      // 摘机/未接都意味着这条不再响了，销账；onhook 与铃无关(挂断时铃早停了)。
      // 老座机那一路的铃(按会话响的):摘机 = 接了,未接 = 没接(行为账;试铃不算)。
      if (parsed.event.type !== 'onhook' && parsed.event.session_id !== 'test-ring') {
        noteBehavior({ 事: BEHAVIOR_EVENTS.call, 对象: `铃 ${parsed.event.agent}/${parsed.event.session_id}`, 结果: parsed.event.type === 'offhook' ? '接了' : '没接' }, '电话')
      }
      if (parsed.event.type !== 'onhook') {
        ringActive = stopRing(ringActive, {
          agent: parsed.event.agent,
          session_id: parsed.event.session_id,
        })
      }
      if (
        parsed.event.agent === 'dsh' && parsed.event.session_id === 'test-ring'
        && parsed.event.type !== 'onhook'
      ) {
        if (testRingTimer !== undefined) { clearTimeout(testRingTimer); testRingTimer = undefined }
        testRinging = false
      }
      sendJson(res, 200, { ok: true })
      return
    }

    /**
     * **页面自己报错**(2026-09-25,卡 V)。电脑页面与手机都走这一条。
     *
     * 一条纪律:**它自己失败了不许再报**(客户端那一半负责,见 client/reportClientError.ts)——
     * 报错的请求失败又触发一次报错,就是一个打不住的循环。这头也只回 `{ok:true}`,不回别的,
     * 让客户端没有可解析的东西、少一处出错的可能。
     *
     * 认不出 JSON / 连一句话都没有:回 200、不记。报错这条路**绝不给页面添一个新的失败**。
     */
    if (req.method === 'POST' && path === '/client/error') {
      const text = await readBody(req)
      let body: unknown
      try {
        body = JSON.parse(text)
      } catch {
        sendJson(res, 200, { ok: true })
        return
      }
      const raw = (body ?? {}) as Record<string, unknown>
      const entry = clientErrors.record(
        { message: raw.message, stack: raw.stack, view: raw.view, where: raw.where },
        service.getState().now,
      )
      // 记下了就顺手推一份快照:设置里那一格不必等下一次轮询。
      if (entry !== undefined) broadcast({ kind: 'snapshot', state: await composeState() })
      sendJson(res, 200, { ok: true })
      return
    }

    if (req.method === 'POST' && path === '/read') {
      const text = await readBody(req)
      let body: unknown
      try {
        body = JSON.parse(text)
      } catch {
        sendJson(res, 400, { error: 'body 不是合法 JSON' })
        return
      }

      const raw = (body ?? {}) as Record<string, unknown>
      if (!isAgentId(raw.agent) || typeof raw.session_id !== 'string') {
        sendJson(res, 400, { error: '需要 agent 和 session_id' })
        return
      }
      if (!service.markRead(raw.agent, raw.session_id)) {
        sendJson(res, 404, { error: '没有这个会话' })
        return
      }
      sendJson(res, 200, { ok: true })
      return
    }

    /**
     * 登录抓取：开一个独立 profile 的 Chrome 窗口让 Ben 自己登录，登完把 Cookie 取回来。
     *
     * 2026-08-20 真机反馈修掉的三个毛病：
     * 1. 他登录完了界面还说未登录——原来按 cookie 名判断，名字猜错了。
     *    现在的判定是「拿这份 cookie 能不能真的读到额度」，那才是我们要的东西。
     * 2. 关掉窗口再点登录，说"已经有一个窗口打开"——原来卡在 pending 直到五分钟超时。
     *    现在重复发起直接顶掉上一次，另有 /login/cancel 可以主动清掉。
     * 3. Claude 压根打不开——就是被第 2 条那个 409 挡住的，不是它自己的问题。
     *
     * 和写凭据一样只认回环：这会在本机弹出浏览器窗口，不能让局域网触发。
     */
    if (path === '/login' || path === '/login/capture' || path === '/login/cancel') {
      if (req.method === 'GET') {
        sendJson(res, 200, loginProgress ?? { state: 'idle' })
        return
      }

      if (req.method !== 'POST') {
        sendJson(res, 405, { error: '只支持 GET / POST' })
        return
      }
      if (!loopback) {
        sendJson(res, 403, { error: '只能在本机发起登录' })
        return
      }

      if (path === '/login/cancel') {
        stopLoginLoop()
        loginSession = undefined
        loginProgress = undefined
        sendJson(res, 200, { ok: true })
        return
      }

      if (path === '/login/capture') {
        // 手动兜底：他自己确认登录完了。用于自动判定读不到额度的情况
        //（比如某一家的用量接口我们还没接对），至少把登录态先存下来。
        if (loginSession === undefined) {
          sendJson(res, 409, { error: '还没有打开过登录窗口' })
          return
        }
        await tryCapture()
        sendJson(res, 200, loginProgress ?? { state: 'idle' })
        return
      }

      const text = await readBody(req)
      let body: unknown
      try {
        body = JSON.parse(text)
      } catch {
        sendJson(res, 400, { error: 'body 不是合法 JSON' })
        return
      }

      const provider = (body as Record<string, unknown>).provider
      if (provider !== 'kimi_web') {
        sendJson(res, 400, { error: '这一家不走登录（Claude 走 statusLine，DeepSeek 只有 API Key）' })
        return
      }

      // 重复发起直接顶掉上一次——上一个窗口他可能已经关了，不该把人锁死。
      stopLoginLoop()
      loginSession = { provider, profileDir: loginProfileDir(provider) }
      loginProgress = { provider, state: 'opening', message: '正在打开登录窗口' }

      void (async () => {
        try {
          await openLoginWindow({ target: LOGIN_TARGETS[provider], profileDir: loginProfileDir(provider) })
          loginProgress = { provider, state: 'waiting', message: '请在打开的窗口里登录' }
          // 之后每 5 秒试一次；他登完就会自己接上，不用他再点什么。
          loginTimer = setInterval(() => { void tryCapture() }, 5000)
          loginTimer.unref?.()
        }
        catch (error) {
          loginProgress = {
            provider,
            state: 'failed',
            message: error instanceof Error ? error.message : '打不开登录窗口',
          }
        }
      })()

      sendJson(res, 200, { ok: true })
      return
    }

    /**
     * 凭据接口。DeepSeek 与 Kimi 要 Key 才能取数，Ben 在工作台里填。
     *
     * GET 只回"配了没有"，**绝不回显 Key**（AGENTS.md：不展示或写入凭据）。
     * POST 存完立刻重采一轮并把整份快照推给展示台——「填完展示台马上更新」
     * 就是靠这两步，而不是等下一个五分钟的定时拉。
     */
    if (path === '/credentials') {
      if (req.method === 'GET') {
        sendJson(res, 200, await credentialStatus(credentialFile))
        return
      }

      if (req.method === 'POST') {
        // 服务可以按需对外 bind（展示台在另一台机器上要读状态），但**写 Key 只认回环**。
        // 否则同一个热点下任何人都能往这台机器里塞凭据。
        if (!loopback) {
          sendJson(res, 403, { error: '凭据只能在本机填写' })
          return
        }

        const text = await readBody(req)
        let body: unknown
        try {
          body = JSON.parse(text)
        } catch {
          sendJson(res, 400, { error: 'body 不是合法 JSON' })
          return
        }

        const raw = (body ?? {}) as Record<string, unknown>
        if (!isCredentialProvider(raw.provider)) {
          sendJson(res, 400, { error: 'provider 必须是 deepseek 或 kimi' })
          return
        }
        if (typeof raw.key !== 'string') {
          sendJson(res, 400, { error: 'key 必须是字符串（空字符串＝清除这一家）' })
          return
        }

        const key = raw.key.trim()
        await saveCredential(credentialFile, raw.provider, key)
        // 先采后推：这样推出去的快照里已经是新 Key 取到的数。
        // 清空时还要告诉那头**是哪一家被清空了**——它得当场作废这一家的上一次采样,
        // 否则重采那几秒里界面上还挂着用刚删掉的 Key 取来的余额(2026-09-18 Ben 真机)。
        await onCredentialsChanged?.({ provider: raw.provider, cleared: key === '' })
        // 同上：composeState() 保住 projects/machine/paused，不整体替换成一份缺字段的快照。
        broadcast({ kind: 'snapshot', state: await composeState() })
        // 回包只给状态，不回显 Key。
        sendJson(res, 200, await credentialStatus(credentialFile))
        return
      }
    }

    /**
     * 「一键测试连接」(2026-11-12,首次引导)。用**草稿里那把还没保存的 Key** 打一次最小对话,
     * 把 401 / 402 / 连不上翻成人话。与 POST /credentials 的区别:这里**一个字都不落盘** ——
     * 测不通的 Key 不该先被存进凭据库,用户还得回头去删。
     *
     * 只认回环(同 POST /credentials,而且这一下花的是他自己 Key 的钱)。回包只有
     * { ok, message, status? },不含 Key、不含上游正文、不进日志(连请求体都不记)。
     */
    if (path === '/credentials/test' && req.method === 'POST') {
      if (!loopback) {
        sendJson(res, 403, { error: '只能在本机测试连接' })
        return
      }
      const text_ = await readBody(req)
      let body: unknown
      try { body = JSON.parse(text_) } catch { sendJson(res, 400, { error: 'body 不是合法 JSON' }); return }
      const raw = (body ?? {}) as Record<string, unknown>
      if (typeof raw.key !== 'string') {
        sendJson(res, 400, { error: 'key 必须是字符串' })
        return
      }
      const result = await testDeepSeekKey({ key: raw.key })
      sendJson(res, 200, result)
      return
    }

    /**
     * 模型服务(2026-09-17,决策记录同日「模型 API 是后面的可选步骤,默认用我们提供的服务」)。
     *
     *   GET  /model          用的哪一家、准备好了没有、今天用了多少(**没有令牌,只有布尔与数字**)
     *   PUT  /model          切换(body: { mode, relay_url?, own_base_url?, own_model? })
     *   POST /model/reissue  重新领一次凭证(凭证失效、换了服务器时)
     *   POST /model/try      「试一下」(2026-10-23):用此刻该用的端点打一句话回来,成了才算接上
     *
     * GET 跟 /credentials 的 GET 一样任何允许的来源都能读——里面没有秘密,而手机那边
     * 以后也要看得到「今天还剩多少」。写只认回环:它改的是这台机器往哪儿发模型请求,
     * 跟 /lan、/pair/* 同属信任边界本身。
     */
    if (path === '/model' && (req.method === 'GET' || req.method === 'PUT')) {
      if (model === undefined) { sendJson(res, 404, { error: '模型服务未启用' }); return }
      if (req.method === 'GET') { sendJson(res, 200, await model.status()); return }
      if (!loopback) { sendJson(res, 403, { error: '只能在本机改模型服务' }); return }

      const text = await readBody(req)
      let body: unknown
      try { body = JSON.parse(text) } catch { sendJson(res, 400, { error: 'body 不是合法 JSON' }); return }
      const parsed = parseModelPatch(body)
      if (!parsed.ok) { sendJson(res, 400, { error: parsed.error }); return }

      const result = await model.update({
        mode: parsed.mode,
        ...(parsed.relay_url === undefined ? {} : { relay_url: parsed.relay_url }),
        ...(parsed.own_base_url === undefined ? {} : { own_base_url: parsed.own_base_url }),
        ...(parsed.own_model === undefined ? {} : { own_model: parsed.own_model }),
      })
      // 结论只有一份:他自己在设置里改过之后,顶上那条横幅要跟着这一次的结果走,
      // 而不是继续说着注册那一刻留下的那句(2026-09-18)。
      modelAutoSetup?.note(result)
      /*
       * 换了模式 / 换了中转地址(2026-09-26,卡 GH):**立刻重问一次 `/health`**,不等那 10 分钟的节流。
       * 换一台中转等于换了一套「配了哪几家」;隔十分钟才变的名单会让他以为没生效。
       */
      void relayProviders?.refresh()
      sendJson(res, result.ok ? 200 : result.code === 'no_relay' ? 409 : 500, result)
      return
    }

    if (path === '/model/reissue' && req.method === 'POST') {
      if (model === undefined) { sendJson(res, 404, { error: '模型服务未启用' }); return }
      if (!loopback) { sendJson(res, 403, { error: '只能在本机重新领取凭证' }); return }
      const result = await model.reissue()
      modelAutoSetup?.note(result)
      void relayProviders?.refresh()
      sendJson(res, result.ok ? 200 : result.code === 'no_relay' ? 409 : 500, result)
      return
    }

    /**
     * 「试一下」(2026-10-23,卡「事务官换Key」):设置里那颗键按一下,用此刻该用的端点
     * 打一句话回来。回包 `{ ok, message }`:message 是模型的半句话或一句人话错因,
     * **没有 key、没有地址之外的信息**。只认回环(它花的是他自己 Key 的钱)。
     */
    if (path === '/model/try' && req.method === 'POST') {
      if (model === undefined) { sendJson(res, 404, { error: '模型服务未启用' }); return }
      if (!loopback) { sendJson(res, 403, { error: '只能在本机试模型服务' }); return }
      const result = await model.try()
      sendJson(res, 200, result)
      return
    }

    /**
     * 顶上那条「模型服务还没接上」横幅里的**重试**(2026-09-18)。
     *
     * 跑的是注册/登录那一刻跑的**同一份** `autoSetup()`,所以它守着同样的判据:
     * 他要是在这中间自己填了 DeepSeek Key,这一下就什么都不做(而 `/model/reissue` 会照领不误
     * —— 那是设置里那颗按钮的语义,不是横幅的)。
     */
    if (path === '/model/auto-setup' && req.method === 'POST') {
      if (model === undefined) { sendJson(res, 404, { error: '模型服务未启用' }); return }
      if (!loopback) { sendJson(res, 403, { error: '只能在本机接模型服务' }); return }
      const result = modelAutoSetup === undefined ? await model.autoSetup() : await modelAutoSetup.run()
      sendJson(res, result.ok ? 200 : 500, result)
      return
    }

    /**
     * v5 项目区/布局/激活/暂停的写路由(spec §6/D11/D12，Task 8)。
     * 和 /credentials 一样：这些要么改本机文件、要么在本机拉起一个 App，只认回环来源。
     */
    if (path === '/project/status' && req.method === 'POST') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机操作项目区' }); return }
      if (projects === undefined) { sendJson(res, 404, { error: '项目区未启用' }); return }

      const text = await readBody(req)
      let body: unknown
      try {
        body = JSON.parse(text)
      } catch {
        sendJson(res, 400, { error: 'body 不是合法 JSON' })
        return
      }
      const raw = (body ?? {}) as Record<string, unknown>
      if (typeof raw.id !== 'string' || raw.id === '') { sendJson(res, 400, { error: 'id 必须是非空字符串' }); return }
      if (typeof raw.text !== 'string') { sendJson(res, 400, { error: 'text 必须是字符串' }); return }

      // author 固定「你」——这台服务只有 Ben 一个人用，projectsService.confirmStatus 内部已经写死。
      const ok = await projects.confirmStatus(raw.id, raw.text)
      if (!ok) { sendJson(res, 404, { error: '没有这个项目' }); return }
      broadcast({ kind: 'snapshot', state: await composeState() })
      sendJson(res, 200, { ok: true })
      return
    }

    if (path === '/project/ddl' && req.method === 'POST') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机操作项目区' }); return }
      if (projects === undefined) { sendJson(res, 404, { error: '项目区未启用' }); return }

      const text = await readBody(req)
      let body: unknown
      try {
        body = JSON.parse(text)
      } catch {
        sendJson(res, 400, { error: 'body 不是合法 JSON' })
        return
      }
      const raw = (body ?? {}) as Record<string, unknown>
      if (typeof raw.id !== 'string' || raw.id === '') { sendJson(res, 400, { error: 'id 必须是非空字符串' }); return }

      // 缺 date 或缺 title 都当作清除——半条 DDL 没有意义，宁可清空也不留一个瘸腿的值。
      const date = typeof raw.date === 'string' && raw.date !== '' ? raw.date : undefined
      const title = typeof raw.title === 'string' && raw.title !== '' ? raw.title : undefined
      const ddl: ProjectDdl | null = date !== undefined && title !== undefined ? { date, title } : null

      const ok = await projects.setDdl(raw.id, ddl)
      if (!ok) { sendJson(res, 404, { error: '没有这个项目' }); return }
      broadcast({ kind: 'snapshot', state: await composeState() })
      sendJson(res, 200, { ok: true })
      return
    }

    if (path === '/attribution/rule' && req.method === 'POST') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机操作项目区' }); return }
      if (projects === undefined) { sendJson(res, 404, { error: '项目区未启用' }); return }

      const text = await readBody(req)
      let body: unknown
      try {
        body = JSON.parse(text)
      } catch {
        sendJson(res, 400, { error: 'body 不是合法 JSON' })
        return
      }
      const parsed = parseRule(body)
      if ('error' in parsed) { sendJson(res, 400, { error: parsed.error }); return }

      await projects.addRule(parsed.rule)
      broadcast({ kind: 'snapshot', state: await composeState() })
      sendJson(res, 200, { ok: true })
      return
    }

    if (path === '/layout' && req.method === 'POST') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机操作项目区' }); return }
      if (projects === undefined) { sendJson(res, 404, { error: '项目区未启用' }); return }

      const text = await readBody(req)
      let body: unknown
      try {
        body = JSON.parse(text)
      } catch {
        sendJson(res, 400, { error: 'body 不是合法 JSON' })
        return
      }
      const parsed = parseLayout(body)
      if ('error' in parsed) { sendJson(res, 400, { error: parsed.error }); return }

      await projects.setLayout(parsed.layout)
      broadcast({ kind: 'snapshot', state: await composeState() })
      sendJson(res, 200, { ok: true })
      return
    }

    /**
     * 用自然语言改布局(2026-09-22,决策记录 2026-09-20「非标需求由事务官直接改」第一层)。
     * 四条:
     *
     *   POST /layout/act     { orientation, actions:[…] }  一次原子地应用一组动作
     *   POST /layout/undo    {}                            回退上一步(复用切模板那个栈)
     *   POST /layout/confirm { id }                        他点了「就这样」→ 这一刻才改
     *   POST /layout/cancel  { id }                        他点了「不动」→ 这条就地作废
     *
     * **`/layout/act` 是底下那一层**:界面上那张确认卡、电话里那件 `wb_layout` 工具,
     * 点完头之后走的都是它,不各写一条。草案怎么来的(词表认的 / 模型填的 / 手拼的 JSON)
     * 与"应用一组动作"是两件事,混在一条路由里会让复述与执行绑死在同一个入口上。
     *
     * 一律只认本机(同 /layout、/template、/devtool/*)。
     */
    if (path === '/layout/act' && req.method === 'POST') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机改布局' }); return }
      if (projects === undefined) { sendJson(res, 404, { error: '项目区未启用' }); return }
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      const orientation = body.orientation
      if (typeof orientation !== 'string' || !(LAYOUT_ORIENTATIONS as readonly string[]).includes(orientation)) {
        sendJson(res, 400, { error: `orientation 必须是 ${LAYOUT_ORIENTATIONS.join(' / ')} 之一` })
        return
      }
      const parsedActs = parseLayoutActs(body.actions)
      if ('error' in parsedActs) { sendJson(res, 400, { error: parsedActs.error }); return }
      const done = await applyLayoutActions(
        parsedActs.acts,
        orientation as 'portrait' | 'landscape',
        typeof body.reason === 'string' ? body.reason : '用说话改布局',
      )
      if (!done.ok) { sendJson(res, done.status, { error: done.error }); return }
      broadcast({ kind: 'snapshot', state: await composeState() })
      sendJson(res, 200, {
        ok: true,
        applied: done.applied,
        ...(done.snapshotId === undefined ? {} : { before_snapshot_id: done.snapshotId }),
        ...(done.note === undefined ? {} : { note: done.note }),
      })
      return
    }

    /**
     * 「今天的待办」换一版显示(2026-10-12,周三演示):`{ view: 'by_date' | 'flat' }`。
     * 电话里那件 `wb_todo_view`、设置里那两颗键、手机(房间代理)都走这一条。
     * 存在布局的 `today_view` 里,切之前存一份布局快照(`/layout/undo` 能切回上一版);
     * 换了就广播快照,两端那一格看到版本变了自己先盖「正在优化…」再切(TODAY_SWITCH_MS)。
     */
    if (path === '/today/view' && req.method === 'POST') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机或配对过的手机上换' }); return }
      if (projects === undefined) { sendJson(res, 404, { error: '项目区未启用' }); return }
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      const view = body.view
      if (typeof view !== 'string' || !(TODAY_VIEWS as readonly string[]).includes(view)) {
        sendJson(res, 400, { error: `view 必须是 ${TODAY_VIEWS.join(' / ')} 之一` })
        return
      }
      // 2026-10-13:换版那几步挪进 `switchTodayView`(`/butler/item` 上那一道新岔口走的是同一处)。
      // `said` = 她那一句原话(固定流程那条路带着它来,留痕用;设置里两颗键不带 = 不留痕)。
      const next = view as TodayViewStyle
      const switched = await switchTodayView(next, body.said)
      if (!switched.ok) { sendJson(res, switched.status, { error: switched.error }); return }
      sendJson(res, 200, {
        ok: true,
        view: next,
        changed: switched.changed,
        ...(switched.note === undefined ? {} : { note: switched.note }),
      })
      return
    }

    if (path === '/layout/undo' && req.method === 'POST') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机改布局' }); return }
      if (template === undefined) { sendJson(res, 404, { error: '布局快照未启用,撤不回来' }); return }
      const restored = await template.restore()
      if (!restored.ok) { sendJson(res, 409, { error: restored.reason ?? '没有可回退的布局' }); return }
      broadcast({ kind: 'snapshot', state: await composeState() })
      sendJson(res, 200, { ok: true, note: '回到上一步了。' })
      return
    }

    if ((path === '/layout/confirm' || path === '/layout/cancel') && req.method === 'POST') {
      if (layoutAsk === undefined) { sendJson(res, 404, { error: '用说话改布局未启用' }); return }
      if (!trusted) { sendJson(res, 403, { error: '只能在本机确认' }); return }
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      const id = typeof body.id === 'string' ? body.id : ''
      const ask = layoutAsk.find(id)
      if (ask === undefined) { sendJson(res, 404, { error: '没有这条待确认的布局改动' }); return }

      if (path === '/layout/cancel') {
        await layoutAsk.drop(id)
        broadcast({ kind: 'snapshot', state: await composeState() })
        sendJson(res, 200, { ok: true, note: '那就不动。' })
        return
      }
      if (projects === undefined) { sendJson(res, 404, { error: '项目区未启用' }); return }
      const done = await applyLayoutActions(ask.actions, ask.orientation, ask.restate)
      if (!done.ok) { sendJson(res, done.status, { error: done.error }); return }
      // 改成了才把这条待确认清掉:改不动时它还在,他能再点一次。
      await layoutAsk.drop(id)
      broadcast({ kind: 'snapshot', state: await composeState() })
      sendJson(res, 200, {
        ok: true,
        applied: done.applied,
        ...(done.snapshotId === undefined ? {} : { before_snapshot_id: done.snapshotId }),
        // 快照没存下时**不许说「不合适说撤销」** —— 那是一句办不到的承诺(D13)。
        note: done.note === undefined ? LAYOUT_DONE_LINE : `改好了。${done.note}`,
      })
      return
    }

    /**
     * Graphify 图谱(2026-10-23,卡「系统文件夹改成Graphify图谱」):「图谱」那一格嵌
     * graphify 按项目生成的 graph.html。产物全本地(tree-sitter AST,只收代码文件,
     * 语义那一路不启动、不叫模型),读路由不设门;build/install 会在本机起子进程,只认本机回环。
     */
    if (path === '/graphify/status' && req.method === 'GET') {
      if (graphify === undefined) { sendJson(res, 404, { error: '图谱未启用' }); return }
      const project = new URL(req.url ?? '/', 'http://x').searchParams.get('project') ?? ''
      if (project === '') { sendJson(res, 400, { error: 'project 必须是非空字符串' }); return }
      const status = await graphify.status(project)
      sendJson(res, 200, { ...status, running: graphify.running(project) })
      return
    }

    if (path === '/graphify/build' && req.method === 'POST') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机生成图谱' }); return }
      if (graphify === undefined) { sendJson(res, 404, { error: '图谱未启用' }); return }
      const text = await readBody(req)
      let body: unknown
      try { body = JSON.parse(text) } catch { sendJson(res, 400, { error: 'body 不是合法 JSON' }); return }
      const raw = (body ?? {}) as Record<string, unknown>
      if (typeof raw.projectId !== 'string' || raw.projectId === '') {
        sendJson(res, 400, { error: 'projectId 必须是非空字符串' })
        return
      }
      const result = await graphify.build(raw.projectId)
      if (!result.ok) { sendJson(res, 400, { error: result.error }); return }
      sendJson(res, 200, { jobId: result.jobId })
      return
    }

    if (path === '/graphify/install' && req.method === 'POST') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机装图谱工具' }); return }
      if (graphify === undefined) { sendJson(res, 404, { error: '图谱未启用' }); return }
      const result = await graphify.install()
      if (!result.ok) { sendJson(res, 400, { error: result.error }); return }
      sendJson(res, 200, { jobId: result.jobId })
      return
    }

    if (path === '/graphify/job' && req.method === 'GET') {
      if (graphify === undefined) { sendJson(res, 404, { error: '图谱未启用' }); return }
      const id = new URL(req.url ?? '/', 'http://x').searchParams.get('id') ?? ''
      const job = graphify.job(id)
      if (job === undefined) { sendJson(res, 404, { error: '没有这条作业' }); return }
      sendJson(res, 200, job)
      return
    }

    /**
     * 嵌进格子的那一份 graph.html(以及它的 graph.json / 静态资源)。
     * `/graphify/view/<projectId>` 不带文件名时给 graph.html 本身。
     * 越界路径服务层 read() 一律 undefined,这里如实回 404。
     */
    if (path.startsWith('/graphify/view/') && req.method === 'GET') {
      if (graphify === undefined) { sendJson(res, 404, { error: '图谱未启用' }); return }
      const remainder = path.slice('/graphify/view/'.length)
      const slash = remainder.indexOf('/')
      const rawId = slash === -1 ? remainder : remainder.slice(0, slash)
      const relRaw = slash === -1 ? '' : remainder.slice(slash + 1)
      let projectId: string
      try { projectId = decodeURIComponent(rawId) }
      catch { sendJson(res, 404, { error: '没有这个路径' }); return }
      if (projectId === '') { sendJson(res, 404, { error: '没有这个路径' }); return }
      const hit = await graphify.read(projectId, relRaw === '' ? 'graph.html' : relRaw)
      if (hit === undefined) { sendJson(res, 404, { error: '没有这份图谱文件' }); return }
      res.writeHead(200, {
        'content-type': hit.contentType,
        'content-length': String(hit.data.length),
        'cache-control': 'no-store',
      })
      res.end(hit.data)
      return
    }

    /**
     * Archify 产品图(2026-10-23,卡「图谱显示修复与Archify产品图接入」):
     * 架构图/时序图/流程图离线展示、Agent规格提取以及官方工具链自校验生成;
     * /archify/generate-agent 是「由 Agent 生成」的路:服务端派已授权 CLI 只读项目
     * 源码产规格,校验后原子落地,失败保留可用版。
     */
    if (path === '/archify/status' && req.method === 'GET') {
      if (archify === undefined) { sendJson(res, 404, { error: '架构图服务未启用' }); return }
      const project = new URL(req.url ?? '/', 'http://x').searchParams.get('project') ?? ''
      if (project === '') { sendJson(res, 400, { error: 'project 必须是非空字符串' }); return }
      const status = await archify.status(project)
      sendJson(res, 200, status)
      return
    }

    if (path.startsWith('/archify/spec/') && req.method === 'GET') {
      if (archify === undefined) { sendJson(res, 404, { error: '架构图服务未启用' }); return }
      const parts = path.slice('/archify/spec/'.length).split('/')
      if (parts.length < 2 || !parts[0] || !parts[1]) {
        sendJson(res, 400, { error: '缺少 projectId 或 diagramId' })
        return
      }
      const [projectId, diagramId] = parts
      const resSpec = await archify.readSpec(projectId, diagramId)
      if (!resSpec.found) {
        sendJson(res, 404, { error: resSpec.error ?? '未找到规格文件' })
        return
      }
      sendJson(res, 200, resSpec.spec)
      return
    }

    if (path.startsWith('/archify/view/') && req.method === 'GET') {
      if (archify === undefined) { sendJson(res, 404, { error: '架构图服务未启用' }); return }
      const remainder = path.slice('/archify/view/'.length)
      const slash = remainder.indexOf('/')
      if (slash === -1) { sendJson(res, 400, { error: '缺少文件名' }); return }
      const rawId = remainder.slice(0, slash)
      const filename = remainder.slice(slash + 1)
      let projectId: string
      try { projectId = decodeURIComponent(rawId) }
      catch { sendJson(res, 404, { error: '没有这个路径' }); return }
      const hit = await archify.readView(projectId, filename)
      if (!hit.found || !hit.content) {
        sendJson(res, 404, { error: hit.error ?? '没有这份架构图文件' })
        return
      }
      res.writeHead(200, {
        'content-type': hit.contentType ?? 'application/octet-stream',
        'content-length': String(hit.content.length),
        'cache-control': 'no-store',
      })
      res.end(hit.content)
      return
    }

    if (path === '/archify/generate' && req.method === 'POST') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机生成架构图' }); return }
      if (archify === undefined) { sendJson(res, 404, { error: '架构图服务未启用' }); return }
      const text = await readBody(req)
      let body: unknown
      try { body = JSON.parse(text) } catch { sendJson(res, 400, { error: 'body 不是合法 JSON' }); return }
      const raw = (body ?? {}) as Record<string, unknown>
      if (typeof raw.projectId !== 'string' || !raw.projectId) {
        sendJson(res, 400, { error: 'projectId 必须是非空字符串' }); return
      }
      if (typeof raw.diagramId !== 'string' || !raw.diagramId) {
        sendJson(res, 400, { error: 'diagramId 必须是非空字符串' }); return
      }
      if (typeof raw.type !== 'string' || !raw.type) {
        sendJson(res, 400, { error: 'type 必须是非空字符串' }); return
      }
      const genResult = await archify.generate(raw.projectId, raw.diagramId, raw.type, raw.spec)
      if (!genResult.ok) {
        sendJson(res, 400, { error: genResult.error ?? '生成失败' }); return
      }
      sendJson(res, 200, { ok: true, receipt: genResult.receipt })
      return
    }

    /**
     * 「由 Agent 生成」(2026-10-23 集中收口):Agent 只读项目源码,现场产出结构化规格,
     * 服务端用官方离线工具链校验后原子落地;任何一步失败都保留上一次可用版,如实报错。
     * 只收 projectId/diagramId/type —— 项目路径由服务端按登记解析,不接受客户端 arbitrary path。
     */
    if (path === '/archify/generate-agent' && req.method === 'POST') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机生成架构图' }); return }
      if (archify === undefined) { sendJson(res, 404, { error: '架构图服务未启用' }); return }
      const text = await readBody(req)
      let body: unknown
      try { body = JSON.parse(text) } catch { sendJson(res, 400, { error: 'body 不是合法 JSON' }); return }
      const raw = (body ?? {}) as Record<string, unknown>
      if (typeof raw.projectId !== 'string' || !raw.projectId) {
        sendJson(res, 400, { error: 'projectId 必须是非空字符串' }); return
      }
      const agentResult = await archify.generateWithAgent({
        projectId: raw.projectId,
        ...(typeof raw.diagramId === 'string' && raw.diagramId ? { diagramId: raw.diagramId } : {}),
        ...(typeof raw.type === 'string' && raw.type ? { type: raw.type } : {}),
      })
      if (!agentResult.ok) {
        sendJson(res, 400, { error: agentResult.error ?? 'Agent 生成失败' })
        return
      }
      sendJson(res, 200, { ok: true, diagramId: agentResult.diagramId, agent: agentResult.agent, receipt: agentResult.receipt })
      return
    }

    /**
     * 「在 Finder 里显示」(2026-09-11 图谱交互):双击图上的文件圈 → Finder 弹出并选中它。
     * 只认回环(它会拉起本机 Finder);越界路径(`..`、扫描根之外、符号链接出根)是**请求不合法**
     * → 400 + 服务层那句人话,而不是 200 {ok:false}:这不是业务上"办不成",是根本不该来。
     */
    if (path === '/files/reveal' && req.method === 'POST') {
      // 自定义模块也能用这条(它在给模块的那张接口表里,2026-09-21 起就写着)——
      // 模块不是回环,所以这儿要单说一句。它拉起的是 Finder,不读也不写任何内容。
      if (!loopback && moduleClaims === undefined) { sendJson(res, 403, { error: '只能在本机操作文件夹格' }); return }
      if (reveal === undefined) { sendJson(res, 404, { error: 'Finder 定位未启用' }); return }
      const text = await readBody(req)
      let body: unknown
      try { body = JSON.parse(text) } catch { sendJson(res, 400, { error: 'body 不是合法 JSON' }); return }
      const raw = (body ?? {}) as Record<string, unknown>
      if (typeof raw.path !== 'string' || raw.path === '') { sendJson(res, 400, { error: 'path 必须是非空字符串' }); return }
      const result = await reveal.reveal(raw.path)
      if (!result.ok) { sendJson(res, 400, { error: result.reason }); return }
      sendJson(res, 200, { ok: true })
      return
    }

    /**
     * 「打开一个**素材文件夹**」(2026-10-01,卡「小组件派出去与改造内置」第 3 件)。
     *
     * 她自己那一版「素材管理」(照技能《改造内置小组件》做出来的那一格)要能点开一个文件夹 ——
     * 内置那一排按钮干的就是这件事。但**不把 `POST /files/reveal` 放回小组件白名单**:
     * 那一条收**任意路径**,而且会在她屏幕上弹 Finder(2026-09-22 正因为这两样被拿掉)。
     *
     * 所以换一条:**只收一个素材文件夹名**,路径由这里从 `/state.template.asset_dirs`
     * 里查 —— 那一份是模板服务按工作目录算好的(`templateStore.ts`),**这里不拼路径**。
     * 于是模块能打开的集合是「模板建出来的那几个文件夹」,有限、她自己在界面上看得见;
     * 名字不在那一份里就 404,`reveal` 一次都不调(名字绝不当路径使)。
     *
     * 门与 `/files/reveal` 同一道:回环,或者带着模块令牌的小组件(白名单里有这一条)。
     */
    if (path === '/files/asset-reveal' && req.method === 'POST') {
      if (!loopback && moduleClaims === undefined) { sendJson(res, 403, { error: '只能在本机打开素材文件夹' }); return }
      if (reveal === undefined) { sendJson(res, 404, { error: 'Finder 定位未启用' }); return }
      if (template === undefined) { sendJson(res, 404, { error: '布局模板未启用,没有素材文件夹这回事' }); return }
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      if (name === '') { sendJson(res, 400, { error: 'name 必须是素材文件夹名(在 /state.template.asset_dirs 里)' }); return }
      const dirs = template.view().asset_dirs
      // `Object.hasOwn` 而不是直接取:`{name:'constructor'}` 那种从原型上取到的东西不算一个素材文件夹。
      const target = dirs !== undefined && Object.hasOwn(dirs, name) ? dirs[name] : undefined
      if (target === undefined || target === '') {
        sendJson(res, 404, { error: `没有叫「${name}」的素材文件夹(名字在 /state.template.asset_dirs 里,没配工作目录时那一份整块缺席)` })
        return
      }
      const opened = await reveal.reveal(target)
      if (!opened.ok) { sendJson(res, 400, { error: opened.reason }); return }
      sendJson(res, 200, { ok: true, name })
      return
    }

    /**
     * 选题的关联素材(2026-09-21 选题池)。两条,都只认回环 —— 一条列本机盘上的文件名,
     * 一条在本机建目录并拉起 Finder(同 `/files/reveal` 的门)。
     *
     * ★ 2026-09-23「同一个事务官」这一轮**有意留在 `loopback`**,而且理由换了:不是"手机权限低",
     * 是 `/topic/open` 动的是**这台 Mac 屏幕上的一扇 Finder 窗**、`/topic/assets` 列的是
     * **这台 Mac 盘上的文件名** —— 手机那头没有这台机器的屏幕,也没有它的文件系统,
     * 这两条在手机上**没有意义**。那是设备能力的差别,不是权限的差别(见 `trusted` 那段注释)。
     * 要放也得连着"手机上真有一页在用它"一起放,现在没有调用方。
     *
     * 目录从 `/state.template.asset_dirs` 里取,**不自己拼**:那份是模板服务按工作目录算好的,
     * 工作目录没配时它整块缺席,这两条就如实说「还没配工作目录」——不猜一条路径出来(D13)。
     */
    if ((path === '/topic/assets' || path === '/topic/open') && req.method === 'POST') {
      if (!loopback) { sendJson(res, 403, { error: '只能在本机操作选题目录' }); return }
      if (template === undefined) { sendJson(res, 404, { error: '布局模板未启用' }); return }
      const text = await readBody(req)
      let body: unknown
      try { body = JSON.parse(text) } catch { sendJson(res, 400, { error: 'body 不是合法 JSON' }); return }
      const raw = (body ?? {}) as Record<string, unknown>

      const dirs = template.view().asset_dirs
      const topicsDir = dirs?.[TOPIC_DIR]
      if (topicsDir === undefined) {
        sendJson(res, 409, { error: '还没配工作目录,选题目录无处可落(设置 → 目录)' })
        return
      }
      // 七类素材库 = 模板建的文件夹里除了「账号」与「选题」之外那几个。
      const materialDirs = Object.fromEntries(
        Object.entries(dirs ?? {}).filter(([name]) => name !== TOPIC_DIR && name !== '账号'),
      )

      if (path === '/topic/assets') {
        const names = Array.isArray(raw.names) ? raw.names.filter((n): n is string => typeof n === 'string') : []
        sendJson(res, 200, { ok: true, topics: await listTopicAssets({ topicsDir, materialDirs, names }) })
        return
      }

      if (typeof raw.name !== 'string' || raw.name.trim() === '') { sendJson(res, 400, { error: 'name 必须是非空字符串' }); return }
      const made = await ensureTopicDir(topicsDir, raw.name)
      if (!made.ok) { sendJson(res, 400, { error: made.reason }); return }
      if (reveal === undefined) { sendJson(res, 200, { ok: true, dir: made.dir, revealed: false }); return }
      const shown = await reveal.reveal(made.dir)
      // 目录已经建出来了,Finder 没弹出来是第二件事:**如实说,但不假装整件事失败**。
      sendJson(res, 200, { ok: true, dir: made.dir, revealed: shown.ok, ...(shown.ok ? {} : { note: shown.reason }) })
      return
    }

    /**
     * 复盘自评落盘(2026-09-22 卡④):`POST /topic/<选题名>/review`。
     *
     * 选题名在**路径**里(URL 编码过),因为这条路是「对这一条选题做一件事」——
     * 与卡 ② 的 `/topic/*` 那一族同一个命名。正文是五格自评加一个 `account`。
     *
     * 三件事在这里各归各:
     * - 校验(五格全空、分数不在 1–5)→ **400 + 原话**,不悄悄收下一份空复盘;
     * - 写盘 → `选题/<名>/复盘.md` 追加一节(幂等),经验一句话 → `账号/<名>/经验.md`;
     * - 经验没落(没给账号 / 写不进去)→ 仍然 200,`note` 里说清楚 ——
     *   `复盘.md` 已经落了是事实,把它说成失败她会再点一次。
     *
     * ★ 2026-09-23:`loopback` → `trusted`(Ben 拍板「同一个事务官」,见 `trusted` 那段注释)。
     * 复盘是**选题卡那一族的最后一步**,与 `/topic/review` 同一条线上的事;她在手机上填完一份
     * 自评,和在电脑上填完同一份,是同一个人做的同一件事。写的是工作目录里的 .md,不是机器装配。
     */
    if (/^\/topic\/[^/]+\/review$/.test(path) && req.method === 'POST') {
      if (!trusted) { sendJson(res, 403, { error: '只有这台电脑或配对过的设备能写复盘' }); return }
      if (template === undefined) { sendJson(res, 404, { error: '布局模板未启用' }); return }
      let name: string
      try { name = decodeURIComponent(path.slice('/topic/'.length, -'/review'.length)) }
      catch { sendJson(res, 400, { error: '路径里的选题名不是合法的 URL 编码' }); return }

      const dirs = template.view().asset_dirs
      const topicsDir = dirs?.[TOPIC_DIR]
      const accountsRoot = dirs?.['账号']
      if (topicsDir === undefined || accountsRoot === undefined) {
        sendJson(res, 409, { error: '还没配工作目录,复盘无处可落(设置 → 目录)' })
        return
      }

      const text = await readBody(req)
      let body: unknown
      try { body = JSON.parse(text) } catch { sendJson(res, 400, { error: 'body 不是合法 JSON' }); return }
      const raw = (body ?? {}) as Record<string, unknown>
      const validated = validateTopicReview(raw)
      if (!validated.ok) { sendJson(res, 400, { error: validated.reason }); return }
      if (raw.account !== undefined && raw.account !== null && typeof raw.account !== 'string') {
        sendJson(res, 400, { error: 'account 必须是字符串(这条选题归哪个账号)' })
        return
      }
      if (raw.origin !== undefined && raw.origin !== null && typeof raw.origin !== 'string') {
        sendJson(res, 400, { error: 'origin 必须是字符串(谁填的这份自评)' })
        return
      }

      const written = await writeTopicReview({
        topicsDir,
        accountsRoot,
        name,
        review: validated.review,
        ...(typeof raw.account === 'string' && raw.account.trim() !== '' ? { account: raw.account.trim() } : {}),
        date: localDateStr(Date.now()),
        origin: typeof raw.origin === 'string' && raw.origin.trim() !== '' ? raw.origin.trim() : '她在工作台上填的',
      })
      if (!written.ok) { sendJson(res, 400, { error: written.reason }); return }
      sendJson(res, 200, written)
      return
    }

    /**
     * 选题卡 = 指挥台(2026-09-22,设计第一节)。四条,都只认回环 —— 它们读写的是
     * 本机盘上 `选题/<名>/` 里的文件,与 `/topic/assets` 同一道门、同一份目录来源。
     *
     *   POST /topic/docs      { name }                          七个页签一次读回来
     *   POST /topic/doc/save  { name, tab, text }               写回一份产物(顺手存上一版、回 diff)
     *   POST /topic/review    { id, name, tab, action, text? }  把关三键 + 留痕
     *   POST /topic/run       { id, name, account?, note? }     「让事务官推进这一步」
     *
     * ★ **「推进」与「改一改」走的是 `/butler/item/say` 同一个端口**(`butlerSession.say`),
     * 不另开第二条通道:设计第一节的规矩是「卡上的按钮,或对事务官说一句 —— 两条路进的是
     * 同一个口」。这一层只负责把上下文拼成一段话,派给谁、怎么落盘是事务官按技能做的事。
     */
    /**
     * 确认点:**规则的唯一出口**(2026-09-23,维护者 13:05)。
     *
     *   POST /confirm/points { text, max? } → { ok, kinds, points, block, spoken }
     *
     * 为什么要这么一条不挂任何卡的路由:确认点有三个入口(需求卡、选题卡、**电话**),
     * 而电话那条链路跑在 `channel-worker` 里 —— 顶层各子目录互不 import(AGENTS.md)。
     * 不给它一条口子,工人就只能自己再写一份规则,于是两份规则开始漂,
     * 「她问了哪几件」就再也说不清了。
     *
     * **一行都不写盘、一行都不留痕**:它是纯算的。真正的"过了确认点"在
     * `/topic/confirm` 与 `/feature/confirm` 上。
     */
    if (path === '/confirm/points' && req.method === 'POST') {
      if (!trusted) { sendJson(res, 403, { error: '只有这台电脑或配对过的设备能问确认点' }); return }
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      const said = typeof body.text === 'string' ? body.text.trim() : ''
      if (said === '') { sendJson(res, 400, { error: 'text 必须是非空字符串(他那句需求)' }); return }
      if (said.length > 4000) { sendJson(res, 400, { error: '这句太长了(上限 4000 字)' }); return }
      const max = typeof body.max === 'number' && Number.isFinite(body.max) ? Math.round(body.max) : undefined
      /**
       * 他点名要哪一家做(2026-09-27,卡 MS):「这件事谁去执行」那一条的默认理解要说那一家的名字,
       * 不能一律写「事务官自己办,动的是工作台这一处」(21:23「找豆包总结一下」那一通听到的正是这句)。
       * **只认登记表里那几家**的名字;认不出就当没点名(照老样子),不把他说的字直接念回去。
       */
      /*
       * ★ **他点的那个名认家名也认显示名**(2026-09-28,卡 CF)。09-28 那两通里电话那头递上来的是
       * **显示名**(「豆包办公」「Codex」),而这里只认家名(`doubao` / `codex`)—— 于是
       * `knownFamilyName('豆包办公')` 为假,他点的名被丢掉,确认点里念的是「事务官自己办」。
       * 现在过一遍 `resolveFamily`(家名 / 显示名 / 别名,与「他嘴里那一家」卡 FX 同一套判据)。
       */
      const namedWho = resolveFamily(body.who)?.title
      const points: ConfirmPoint[] = buildConfirmPoints({
        need: said,
        ...(max === undefined ? {} : { max }),
        ...(namedWho === undefined ? {} : { who: namedWho }),
      })
      /*
       * **简单的事只确认一句**(卡 CF 第 6 条):点了名 + 一句话说得清的打听。
       * 三条确认点照旧算出来、照旧进回包(卡上那一节、验收标准都从它生成),
       * 只是**电话里念的那一句**换成一句话 —— 念经是电话里的事,卡上不是。
       */
      const simple = isSimpleErrand({ need: said, ...(namedWho === undefined ? {} : { who: namedWho }) })
      /*
       * ★ **她在排一条发布计划**(2026-10-13,卡「座机一句话记发布计划」):电话里念的那一句
       * 换成「我把它记进发布计划:10 月 18 号,XXX 的视频 —— 对吗?」。
       *
       * 为什么要这一条:电话里 `wb_dispatch_item` 第一次调用一定先问一遍(老规矩没动),
       * 而派活那几条确认点问的是「谁去执行 / 失败怎么办」—— 对一条只往日历上记一格的计划,
       * 那几句既对不上又长。**卡上那几条确认点一个字没动**(`points` / `block` 照旧):
       * 念经是电话里的事,卡上不是(同上面「简单的事只确认一句」那一条的分寸)。
       */
      const confirmPlan = publishPlanOf(said, Date.now())
      const planSpoken = confirmPlan?.day === undefined ? undefined : publishPlanConfirmLine(confirmPlan, confirmPlan.day)
      /*
       * ★ **《需求确认点》只念给真的产品需求**(2026-10-13,卡「三个入口一套管线」;
       * 判据 `understand.ts` 的 `looksLikeProductRequirement`,写得清:造东西的动词 + 产品那一头的对象 + 话不短)。
       *
       * 10-13 早那一通:「帮我生成一个小女孩在花海里面漫步的视频」+ 细节,`wb_dispatch_item` 第一次调用
       * 回的是「从哪儿触发…不新开入口」那三条 —— 她要的是一条视频,不是一个功能。
       * 那三条是 09-23 为「把音色改成可配置」那种句子造的。
       *
       * **卡上那几条确认点一个字没动**(`points` / `block` 照旧):念经是电话里的事,卡上不是
       * (同上面「简单的事只确认一句」那一条的分寸)。
       *
       * 这一条与下面那一格 `call`(「电话里要不要先问」,`callAsk.ts`)**各管一头**:
       * `call.ask` 答「要不要问」,这一条答「要问的话念哪一句」—— 要问而这一句不是产品需求时念短的那一句。
       */
      const oneLine = planSpoken !== undefined || simple || !looksLikeProductRequirement(said)
      const spoken = planSpoken ?? (oneLine
        ? spokenSimpleConfirm({ understanding: said, ...(namedWho === undefined ? {} : { who: namedWho }) })
        : spokenConfirmBlock({ understanding: said, points }))
      /*
       * ★ **电话里要不要先问**(2026-10-12,维护者拍板「电话里只在拿不准时先确认」;判据在 `callAsk.ts`)。
       * 只对带 `for` 的调用方给(电话那头);老调用方照旧只拿确认点。① 的家数用的是 `/butler/item`
       * 真派活时同一张选项表(`choicesFor`),并照它同样的条件跳过:没接派活、「只出方案」档 → 不按家派。
       */
      let call: CallAskView | undefined
      if (isCallAskFor(body.for)) {
        // 点没点名与 `/butler/item` 同一个认法:带了 who,或者原话里「让 X 做」认得出一家。
        const named = (typeof body.who === 'string' && body.who.trim() !== '') || dispatchFamilyOf(said, dispatchNameTargetsNow()) !== undefined
        let pick: CallAskPick | 'none' | undefined
        if (body.for === 'dispatch' && !named) {
          let modeNow: ComposerMode | undefined
          try { modeNow = composer === undefined ? undefined : (await composer.choice()).mode } catch { modeNow = undefined }
          if (dispatchRunner === undefined || modeNow === 'plan') pick = 'none'
          else {
            try {
              const projectGuess = await inferProjectId(said)
              pick = await choicesFor(undefined, { text: said, ...(projectGuess === undefined ? {} : { projectId: projectGuess }) })
            }
            catch { pick = undefined }
          }
        }
        const verdict = callAskVerdict({
          for: body.for,
          text: said,
          ...(typeof body.said === 'string' && body.said.trim() !== '' ? { said: body.said.slice(0, 4000) } : {}),
          named,
          ...(pick === undefined ? {} : { pick }),
        })
        call = verdict.ask ? { ...verdict, spoken: verdict.spoken ?? spoken } : verdict
      }
      sendJson(res, 200, {
        ok: true,
        need: said,
        points,
        simple: oneLine,
        block: formatConfirmBlock({ understanding: said, points }),
        spoken,
        ...(call === undefined ? {} : { call }),
      })
      return
    }

    if (TOPIC_DECK_PATHS.has(path) && req.method === 'POST') {
      /**
       * ★ 2026-09-23:同需求卡那一族,`loopback` → `trusted`(Ben 拍板,见 `trusted` 那段注释)。
       * 选题卡是**事务官的事**;它读写的是工作目录里 `选题/<名>/` 的产物,不是这台机器的装配。
       * 注意与下面 `/topic/open` 的分界:那一条会在这台 Mac 上**弹出一个 Finder 窗口**,
       * 手机上没有那扇窗,所以它留在 `loopback` —— 那是能力差别,不是权限差别。
       */
      if (!trusted) { sendJson(res, 403, { error: '只有这台电脑或配对过的设备能操作选题目录' }); return }
      if (template === undefined) { sendJson(res, 404, { error: '布局模板未启用' }); return }
      const body = await readJsonBody(req, res)
      if (body === undefined) return

      const topicsDir = template.view().asset_dirs?.[TOPIC_DIR]
      if (topicsDir === undefined) {
        sendJson(res, 409, { error: '还没配工作目录,选题目录无处可落(设置 → 目录)' })
        return
      }
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      if (name === '') { sendJson(res, 400, { error: 'name 必须是非空字符串' }); return }
      const dir = topicDirOf(topicsDir, name)
      if (dir === undefined) { sendJson(res, 400, { error: '选题名不能带 / 或 \\,也不能以点开头' }); return }

      if (path === '/topic/docs') {
        try {
          sendJson(res, 200, {
            ok: true,
            dir,
            docs: await readTopicDocs(dir),
            reviews: await readTopicReviews(dir),
          })
        }
        catch (error) {
          sendJson(res, 500, { error: `读不了这条选题的产物:${(error as Error).message}` })
        }
        return
      }

      const tab = (TOPIC_DOC_TABS as readonly string[]).includes(body.tab as string)
        ? body.tab as TopicDocTab
        : undefined

      if (path === '/topic/doc/save') {
        if (tab === undefined) { sendJson(res, 400, { error: `tab 必须是 ${TOPIC_DOC_TABS.join(' / ')} 之一` }); return }
        if (typeof body.text !== 'string') { sendJson(res, 400, { error: 'text 必须是字符串' }); return }
        const saved = await saveTopicDoc({ dir, tab, text: body.text, now: new Date() })
        if (!saved.ok) { sendJson(res, 500, { error: saved.reason ?? '写不进去' }); return }
        // 她亲手存的这一版与上一版比,只记改了哪类(卡「学风格」;事务官 / 别家存的不进账)。
        const revised = saved.diff === undefined ? undefined : revisionNoteOf({ 对象: `选题 ${name} · ${tab}`, ids: revisionStyleOfDiff(saved.diff) })
        if (revised !== undefined) noteBehavior(revised)
        sendJson(res, 200, {
          ok: true,
          ...(saved.diff === undefined ? {} : { diff: saved.diff }),
          ...(saved.diff_note === undefined ? {} : { diff_note: saved.diff_note }),
        })
        return
      }

      // 下面两条都要认卡:留痕要记"当时在哪一段",推进要把话说进那条事项的会话里。
      if (tasks === undefined) { sendJson(res, 404, { error: '任务看板未启用' }); return }
      const itemId = typeof body.id === 'string' ? body.id.trim() : ''
      if (itemId === '') { sendJson(res, 400, { error: 'id 必须是非空字符串' }); return }
      const task = (await tasks.list()).tasks.find(candidate => candidate.id === itemId)
      if (task === undefined) { sendJson(res, 404, { error: '没有这个事项' }); return }
      if (task.kind !== 'topic') { sendJson(res, 409, { error: '这张卡不是选题,没有选题目录' }); return }
      const stage = task.stage ?? DEFAULT_TOPIC_STAGE

      /**
       * 把一句话送给事务官。**回 undefined = 送到了**;送不进去回那句原话。
       *
       * 三种送不进去各说各的(与 `/butler/item/say` 逐字同一套口径):
       * 会话没开 / 通道没接上 / 这条会话在 DSH 里已经没了。
       */
      const sayToButler = async (text: string): Promise<string | undefined> => {
        if (task.conversation === undefined) return '这条选题底下还没有事务官的会话,话说不进去'
        if (butlerSession?.say === undefined) return '会话通道没接上,这句话说不进去'
        let accepted = false
        let rejection: 'model' | 'host' | undefined
        try { accepted = await butlerSession.say(task.conversation.session_id, text, reason => { rejection = reason }) } catch { accepted = false }
        return accepted ? undefined : rejection === 'model' ? '当前模型还没完成应用，这句话没有发送；请重试模型设置。' : rejection === 'host' ? '会话通道暂时不可用，这句话没有发送；请稍后重试。' : '这条会话在 DSH 里已经没了'
      }

      /**
       * 接需求先给确认点(2026-09-23,维护者 13:05:「不能假装自己搞懂了」)。
       *
       * 一条路由两件事,分界只看 body 里有没有 `points`:
       *
       * - **没有** → 只按规则挑几条回给她看(不写盘、不留痕)。事务官在「构思」那一态
       *   照这几条问她;界面上也能先看一眼要问什么。
       * - **有** → 她逐条答完了:写进 `框架.md` 顶部那一节、往 `审核记录.jsonl` 追一行
       *   `confirm_points`,并把「验收标准」那一节**按确认点生成**。
       *
       * ★ **过了这一下才算确认**。判据只在留痕里,不在产物文件里(产物是会被改写的)。
       */
      if (path === '/topic/confirm') {
        let existing: TopicReviewEntry[] = []
        let docs: TopicDocView[] = []
        try {
          existing = await readTopicReviews(dir)
          docs = await readTopicDocs(dir)
        }
        catch (error) { sendJson(res, 500, { error: `读不了这条选题的产物:${(error as Error).message}` }); return }

        const said = typeof body.need === 'string' && body.need.trim() !== ''
          ? body.need.trim()
          : (task.desc ?? '').trim() === '' ? name : (task.desc as string).trim()

        if (body.points === undefined) {
          const points = topicConfirmPoints(said)
          sendJson(res, 200, {
            ok: true,
            confirmed: topicConfirmed(existing),
            need: said,
            points,
            block: formatConfirmBlock({ understanding: said, points }),
            spoken: spokenConfirmBlock({ understanding: said, points }),
          })
          return
        }

        const parsed = parseConfirmPoints(body.points)
        if (!parsed.ok) { sendJson(res, 400, { error: parsed.error }); return }
        if (parsed.points.length < 2) { sendJson(res, 400, { error: '确认点至少两条(一条分歧点 + 怎么算做完)' }); return }
        const changed = changedIndexes(parsed.points)
        const at = new Date()

        const before = docs.find(one => one.tab === TOPIC_CONFIRM_TAB)?.text ?? ''
        const saved = await saveTopicDoc({
          dir,
          tab: TOPIC_CONFIRM_TAB,
          text: applyConfirmSections({ text: before, points: parsed.points, confirmed: true, at: at.toISOString(), changed }),
          now: at,
        })
        if (!saved.ok) { sendJson(res, 500, { error: saved.reason ?? '写不进去' }); return }

        const logged = await appendTopicReview(dir, {
          at: at.toISOString(),
          tab: TOPIC_CONFIRM_TAB,
          action: 'confirm_points',
          stage,
          points: confirmTrace(parsed.points),
          ...(changed.length === 0 ? {} : { changed }),
        })
        if (!logged.ok) { sendJson(res, 500, { error: logged.reason }); return }
        sendJson(res, 200, {
          ok: true,
          confirmed: true,
          points: parsed.points,
          changed,
          acceptance: acceptanceLines(parsed.points),
          section: CONFIRM_SECTION_TITLE,
          acceptance_section: ACCEPTANCE_SECTION_TITLE,
        })
        return
      }

      if (path === '/topic/review') {
        if (tab === undefined) { sendJson(res, 400, { error: `tab 必须是 ${TOPIC_DOC_TABS.join(' / ')} 之一` }); return }
        const action = (TOPIC_REVIEW_ACTIONS as readonly string[]).includes(body.action as string)
          ? body.action as TopicReviewAction
          : undefined
        if (action === undefined) { sendJson(res, 400, { error: `action 必须是 ${TOPIC_REVIEW_ACTIONS.join(' / ')} 之一` }); return }
        const said = typeof body.text === 'string' ? body.text.trim() : ''
        // 「改一改」**必须带那一句**:一次没有理由的打回,事务官改出来的还是同一份。
        if (action === 'revise' && said === '') { sendJson(res, 400, { error: '「改一改」要带一句话,告诉它改哪儿' }); return }
        if (said.length > 4000) { sendJson(res, 400, { error: '一句话太长了(上限 4000 字)' }); return }

        // **先留痕再送话**:送不出去的那一次她照样把过关了,那一行不能因为 DSH 掉线就丢。
        const logged = await appendTopicReview(dir, {
          at: new Date().toISOString(),
          tab,
          action,
          stage,
          ...(said === '' ? {} : { text: said }),
        })
        if (!logged.ok) { sendJson(res, 500, { error: logged.reason }); return }
        noteBehavior({ 事: BEHAVIOR_EVENTS.review, 对象: `选题 ${name} · ${tab}`, 结果: reviewResultText(action), ...(said === '' ? {} : { 原话: said }) })

        /**
         * 每一次把关都是一次学习(2026-09-23,自进化最小闭环):留痕之后让进化循环学一遍 ——
         * 试用中的偏好按这一次的结果保留或撤,不止一条选题上打回过的同一处记成新偏好。
         * 它抛了不连累把关本身(那一行已经在文件里了),原因如实带回。
         */
        let evolveNote: string | undefined
        if (evolve !== undefined) {
          try { evolveNote = (await evolve.learn()).note }
          catch (error) { evolveNote = `偏好那一步没跑成:${(error as Error).message}` }
        }
        const learned = evolveNote === undefined ? {} : { evolve_note: evolveNote }

        if (action !== 'revise') { sendJson(res, 200, { ok: true, sent: false, ...learned }); return }
        const failed = await sayToButler(buildTopicReviseMessage({ name, taskId: itemId, tab, text: said }))
        // 留痕成了、话没送出去:**如实说**,不假装整件事失败(那一行已经在文件里了)。
        sendJson(res, 200, { ok: true, sent: failed === undefined, ...(failed === undefined ? {} : { note: failed }), ...learned })
        return
      }

      // path === '/topic/run'
      const note = typeof body.note === 'string' ? body.note.trim() : ''
      if (note.length > 4000) { sendJson(res, 400, { error: '一句话太长了(上限 4000 字)' }); return }

      /**
       * GPT / 豆包 这一次派不派得出去。**只问得到"通道是哪一种"**:
       * 中转上有没有配这两家的 Key 要发一次才知道(`classifyApiFailure` 的 `not_configured`)。
       * 所以这里只判两件看得见的事 —— 模型服务接没接进来、走的是不是中转。
       * 自己的 Key 直连官方是发不出这两家的(`API_FAILURE_HINTS.not_relay` 那一句)。
       */
      let relayReady = false
      let relayNote: string | undefined = '模型服务没接进来,派不出去'
      if (model !== undefined) {
        try {
          const endpoint = await model.endpoint()
          relayReady = endpoint.mode === 'relay' && endpoint.ready
          relayNote = relayReady
            ? undefined
            : endpoint.mode === 'relay' ? '模型服务还没就绪' : '现在用的是你自己的 Key,直连官方发不出这两家'
        }
        catch (error) {
          relayNote = `问不到模型服务:${(error as Error).message}`
        }
      }
      const standin = stageNeedsRelay(stage) && !relayReady

      let docs: TopicDocView[] = []
      let reviews: TopicReviewEntry[] = []
      try {
        docs = await readTopicDocs(dir)
        reviews = await readTopicReviews(dir)
      }
      catch (error) {
        sendJson(res, 500, { error: `读不了这条选题的产物:${(error as Error).message}` })
        return
      }

      const account = typeof body.account === 'string' ? body.account.trim() : ''
      // 她说过不止一次的偏好(2026-09-23):进化循环攒够依据的那几条,拼进话里她就不必再交代。
      const preferences = [
        ...(evolve?.preferenceLines() ?? []),
        // 他明说过的内容规矩(卡 K):同一张规矩表里「内容」那几条,推进的话里一起带上。
        ...(rules?.counting().filter(one => one.area === 'content' && one.origin !== 'topic').map(one => `「${one.text}」—— 他明说过的规矩`) ?? []),
      ]
      const text = buildTopicRunPrompt({
        name,
        taskId: itemId,
        stage,
        dir,
        docs,
        reviews,
        relayReady,
        // 接需求先给确认点(2026-09-23)。没过这一下,构思那一段先问、后面几段不许派活。
        confirmed: topicConfirmed(reviews),
        ...((task.desc ?? '').trim() === '' ? {} : { need: (task.desc as string).trim() }),
        ...(account === '' ? {} : { account }),
        ...(note === '' ? {} : { note }),
        ...(relayNote === undefined ? {} : { relayNote }),
        ...(preferences.length === 0 ? {} : { preferences }),
      })

      const failed = await sayToButler(text)
      // 交出去这件事照样留痕(送没送成都记):卡上的「排队 / 在做」靠这一行算,
      // 而"她点过这颗按钮"本身就是这条选题上发生过的事。
      const logged = await appendTopicReview(dir, {
        at: new Date().toISOString(),
        tab: TOPIC_STAGE_TAB[stage],
        action: 'run',
        stage,
        ...(note === '' ? {} : { text: note }),
        ...(standin ? { standin: true } : {}),
      })
      sendJson(res, 200, {
        ok: true,
        sent: failed === undefined,
        stage,
        standin,
        text,
        ...(failed === undefined ? {} : { note: failed }),
        ...(logged.ok ? {} : { log_note: logged.reason }),
      })
      return
    }


    /**
     * 需求卡 = 指挥台(2026-09-22,审视第三节 + 第四节第三幕)。五条,都只认回环 ——
     * 它们读写的是**她自己项目仓库**里 `docs/需求/<名>/` 的文件,以及 `docs/决策记录.md`。
     *
     *   POST /feature/docs      { id }                       四个页签一次读回来
     *   POST /feature/doc/save  { id, tab, text }            写回一份产物(顺手存上一版、回 diff)
     *   POST /feature/review    { id, tab, action, text? }   把关三键 + 留痕
     *   POST /feature/run       { id, note? }                「让事务官推进这一步」
     *   POST /feature/record    { id, record_rel? }          把结论追加进她仓库的决策记录
     *
     * ★ **「推进」与「改一改」走的是 `/butler/item/say` 同一个端口**(`butlerSession.say`),
     * 与选题那一族逐字同一条规矩:卡上的按钮,或对事务官说一句 —— 两条路进的是同一个口。
     * 这一层不起任何活:真去操作 Codex / Claude 窗口的是事务官,按「派活给别家Agent」做。
     *
     * ★ **需求名只从卡上取,不收 body**(与 `/topic/*` 的差别):目录名是拿卡的标题拼的,
     * 收一个界面传进来的名字等于多一条"往哪儿写"的输入,而这里写的是她的**代码仓库**。
     */
    if (FEATURE_DECK_PATHS.has(path) && req.method === 'POST') {
      /**
       * ★ 2026-09-23:这道门从 `loopback` 放宽到 `trusted`(Ben 拍板,见 `trusted` 那段注释)。
       * 「同一个事务官」:手机上的她和电脑前的她是同一个人,需求卡是**事务官的事**不是机器的事。
       * 代价 Ben 明知并点头:配对过的手机因此能往项目的 `docs/需求/` 写产物、往决策记录追一节,
       * **`/feature/ship` 按一下会合并 main 并发一版**。重的那几下由界面上的二次确认把着,
       * 不靠"只认本机"把她自己挡在外面。
       */
      if (!trusted) { sendJson(res, 403, { error: '只有这台电脑或配对过的设备能操作需求目录' }); return }
      /**
       * **发版只有她点头才走**(2026-09-28,卡 BS;决策记录同日 15:5x 第 3 条)。
       * 只拦 `/feature/ship` 这一下 —— 需求目录里那几下(写产物、把关、记决策、开分支)
       * 本来就是事务官该做的活(A10「按工作台的固定流程键」),拦了它就没法替她准备这一版。
       */
      if (path === '/feature/ship') {
        const notHerShip = notHerself(asker, 'ship')
        if (notHerShip !== undefined) { sendJson(res, 403, { error: notHerShip }); return }
      }
      if (tasks === undefined) { sendJson(res, 404, { error: '任务看板未启用' }); return }
      const body = await readJsonBody(req, res)
      if (body === undefined) return

      const itemId = typeof body.id === 'string' ? body.id.trim() : ''
      if (itemId === '') { sendJson(res, 400, { error: 'id 必须是非空字符串' }); return }
      const task = (await tasks.list()).tasks.find(candidate => candidate.id === itemId)
      if (task === undefined) { sendJson(res, 404, { error: '没有这个事项' }); return }
      if (task.kind !== 'feature') { sendJson(res, 409, { error: '这张卡不是需求,没有需求目录' }); return }

      // 往哪个仓库写 —— **服务端自己查**,不收界面传进来的路径(那是一把往任何地方写文件的钥匙)。
      if (projects === undefined) { sendJson(res, 404, { error: '项目区未启用,不知道这条需求归哪个仓库' }); return }
      if (task.project_id === undefined || task.project_id === '') {
        sendJson(res, 409, { error: '这张需求卡还没归到项目,不知道往哪个仓库写(在卡上选一个项目)' })
        return
      }
      const project = (await projects.getProjectsState()).projects
        .find(candidate => candidate.id === task.project_id)
      if (project === undefined) { sendJson(res, 409, { error: '这条需求所在的项目现在找不到了' }); return }
      if (project.path === undefined || project.path === '') {
        sendJson(res, 409, { error: `「${project.name}」在本机没有路径,需求目录无处可落` })
        return
      }
      const name = task.title
      const dir = featureDirOf(project.path, name)
      if (dir === undefined) {
        sendJson(res, 400, { error: '需求卡的标题不能带 / 或 \\,也不能以点开头 —— 它要当文件夹名用' })
        return
      }
      const stage = featureStageOfTask(task.feature_stage)

      if (path === '/feature/docs') {
        try {
          sendJson(res, 200, {
            ok: true,
            dir,
            stage,
            project: project.name,
            project_path: project.path,
            docs: await readFeatureDocs(dir),
            reviews: await readFeatureReviews(dir),
            // 派出去的那几件子事项各自的结果(2026-09-23,断点 B)。**现扫目录**,
            // 不另存清单;「验收」页签铺的就是这一份。一件都没有就是空数组。
            results: await listFeatureResults(dir),
            // 「改工作台自己」那条闭环对这条需求开不开门(2026-09-23,断点 C)。
            // **两种结论都给理由** —— 界面上要能说清"为什么这张卡上没有那颗按钮"。
            ...(await (async () => {
              const verdict = await detectSelfProject(
                project.path as string,
                one => readFile(one, 'utf8').catch(() => undefined),
              )
              return { self: verdict.self, self_why: verdict.why }
            })()),
          })
        }
        catch (error) {
          sendJson(res, 500, { error: `读不了这条需求的产物:${(error as Error).message}` })
        }
        return
      }

      const featureTab = (FEATURE_DOC_TABS as readonly string[]).includes(body.tab as string)
        ? body.tab as FeatureDocTab
        : undefined

      if (path === '/feature/doc/save') {
        if (featureTab === undefined) { sendJson(res, 400, { error: `tab 必须是 ${FEATURE_DOC_TABS.join(' / ')} 之一` }); return }
        if (typeof body.text !== 'string') { sendJson(res, 400, { error: 'text 必须是字符串' }); return }
        const saved = await saveFeatureDoc({ dir, tab: featureTab, text: body.text, now: new Date() })
        if (!saved.ok) { sendJson(res, 500, { error: saved.reason ?? '写不进去' }); return }
        const revised = saved.diff === undefined ? undefined : revisionNoteOf({ 对象: `需求 ${name} · ${featureTab}`, ids: revisionStyleOfDiff(saved.diff) })
        if (revised !== undefined) noteBehavior(revised)
        sendJson(res, 200, {
          ok: true,
          ...(saved.diff === undefined ? {} : { diff: saved.diff }),
          ...(saved.diff_note === undefined ? {} : { diff_note: saved.diff_note }),
        })
        return
      }

      /**
       * 派出去的那件子事项**跑完了,结果自己回到卡上**(2026-09-23,断点 B)。
       *
       *   POST /feature/result { id, item, exit_code, log?, hand?, cwd?, shot? }
       *
       * 事务官报的只有**退出码与原始输出**这两样它手上才有的东西;
       * 「改了哪些文件」与「测试跑没跑」由**工作台自己去问**(`git status --short` /
       * `git diff --stat`,以及项目根 package.json 里有 test 就 `npm test` 一次)——
       * 这几样让模型转述一遍,它想写多少写多少,而这正是断点 B 要治的病。
       *
       * `cwd` **必须在这个项目里**:它是一条"去哪个目录跑命令"的输入,
       * 收一个界面(或事务官)传进来的任意路径等于一把在任何目录里跑 git 的钥匙。
       */
      if (path === '/feature/result') {
        const item = typeof body.item === 'string' ? body.item.trim() : ''
        if (item === '') { sendJson(res, 400, { error: 'item 必须是非空字符串(哪件子事项)' }); return }
        if (resultFileOf(item) === undefined) {
          sendJson(res, 400, { error: '子事项的名字不能带 / 或 \\,也不能以点开头 —— 它要当文件名用' })
          return
        }
        // **没有默认退出码**:不知道成没成就不该落一份结果(编一个 0 出来是最坏的一种)。
        if (typeof body.exit_code !== 'number' || !Number.isInteger(body.exit_code)) {
          sendJson(res, 400, { error: 'exit_code 必须是整数 —— 成没成只有退出码说了算' })
          return
        }
        const wanted = typeof body.cwd === 'string' && body.cwd.trim() !== '' ? body.cwd.trim() : project.path
        if (!(wanted === project.path || wanted.startsWith(`${project.path}/`)) || wanted.split('/').includes('..')) {
          sendJson(res, 400, { error: `cwd 必须在这个项目里(${project.path})` })
          return
        }
        const log = typeof body.log === 'string' ? body.log : ''
        const shot = typeof body.shot === 'string' && body.shot.trim() !== '' ? body.shot.trim() : undefined
        const hand = typeof body.hand === 'string' && body.hand.trim() !== '' ? body.hand.trim() : undefined

        const changed = runInCwd === undefined ? undefined : await collectChangedFiles(runInCwd, wanted)
        const pkgText = await readFile(join(wanted, 'package.json'), 'utf8').catch(() => undefined)
        const probe = probeTestScript(pkgText)
        const test = runInCwd === undefined
          ? { ran: false, why: '这台机器上没接命令执行器,没跑测试' }
          : await runProjectTest(runInCwd, wanted, probe)

        const written = await writeFeatureResult(dir, {
          item,
          exitCode: body.exit_code,
          cwd: wanted,
          log,
          ...(hand === undefined ? {} : { hand }),
          ...(changed === undefined ? {} : { changed }),
          test,
          ...(shot === undefined ? {} : { shot }),
          at: new Date(),
        })
        if (!written.ok) { sendJson(res, 500, { error: written.reason ?? '写不进结果文件' }); return }
        sendJson(res, 200, {
          ok: true,
          path: written.path,
          file: written.file,
          results: await listFeatureResults(dir),
        })
        return
      }

      /**
       * 「改工作台自己」这条需求,**派活之前先开分支**(2026-09-23,断点 C 第 1 条)。
       *
       *   POST /feature/branch { id }
       *
       * 只对「项目 = 这个仓库」的需求卡开门(判据在 `selfUpdate.ts`:项目根有
       * `deploy/publish-update.sh`,且 `workbench-plugin/package.json` 的包名是 `@ben/dsh-workbench`)。
       * 别的项目**如实回一句为什么**,不是一颗按了没反应的按钮。
       *
       * 分支落 `feat/<需求名-slug>`,worktree 落 `.claude/worktrees/<slug>` ——
       * **不在 main 那份 checkout 上改**(记忆「合并在主 checkout 做」那条教训的另一半)。
       */
      if (path === '/feature/branch' || path === '/feature/ship') {
        if (runInCwd === undefined) {
          sendJson(res, 404, { error: '这台机器上没接命令执行器,「改自己」这条路没启用' })
          return
        }
        const verdict = await detectSelfProject(project.path, one => readFile(one, 'utf8').catch(() => undefined))
        if (!verdict.self) {
          sendJson(res, 409, { error: `这条需求改的不是工作台自己:${verdict.why}` })
          return
        }
        const branch = branchOfFeature(name)
        const worktree = worktreeOfFeature(project.path, name)
        if (branch === undefined || worktree === undefined) {
          sendJson(res, 400, { error: '这条需求的标题拼不出分支名(去掉 ~^:?* 与空白之后一个字都不剩)' })
          return
        }

        if (path === '/feature/branch') {
          const prepared = await prepareSelfBranch({ run: runInCwd, afterCreate: linkWorktreeDepsNow }, { projectPath: project.path, branch, worktree })
          if (!prepared.ok) { sendJson(res, 500, { error: prepared.reason ?? '开不出分支' }); return }
          await tasks.update(itemId, {
            selfShip: {
              branch,
              worktree,
              status: 'branched',
              started_at: new Date().toISOString(),
            },
          })
          sendJson(res, 200, { ok: true, branch, worktree, created: prepared.created === true, why: verdict.why })
          return
        }

        /**
         * 「验收」态她点「通过」之后那条闭环(断点 C 第 2 条)。八步,**每一步失败就停**。
         *
         *   POST /feature/ship { id, notes, handoff? }
         *
         * ★ **第 ⑧ 步(热更新)按下就回**:那一下会把跑着这条请求的这个进程换掉并重启,
         * 所以这条响应是在**重启之前**发出去的,`note` 是「已触发热更新,重启后见」。
         * 这一版到底生没生效,由重启之后那一段收尾说(`selfShipFollowUp.ts` → 收件箱)。
         *
         * `notes` 是**人话**(来自 `需求.md`):发版记录那一列与 `--notes` 用的都是它,
         * 而那段文字会原样显示在她的设置里,是她决定要不要点「立即更新」的唯一依据。
         * **不替她编**:没带就 400(`publish-update.sh` 那边也是必填)。
         *
         * 停下来时做三件事,一件都不少(断点 C 第 3 条):
         * ① 卡上标出(`self_ship.status='failed'` + 停在哪一步 + 原话);
         * ② 收件箱一条带原话(`butlerInbox.ts` 里 ①.6 那一段现拼);
         * ③ 座机排一通 failed —— 走**既有那条路**:把卡挂成 `blocked` + `block_reason:'error'`
         *    + `note` 原话,`callOut.taskCallOutEvent` 据此排一通 `failed`。
         *    不另造一条打电话的路:同一件事有两条路能打电话,迟早会打两遍。
         */
        if (selfUpdate === undefined) {
          sendJson(res, 404, { error: '发版与热更新没接进来,「改自己」那条闭环没启用' })
          return
        }
        /**
         * 发版那一句**人话**。带了就用带的;**没带就从 `需求.md` 里取**(卡里钉死:
         * 「人话,来自需求.md」)—— 她在手机上点「通过」,不该还要打一段字。
         * 两头都没有就 400:**一个字都不编**,那段文字会原样显示在她的设置里。
         */
        const given = typeof body.notes === 'string' ? body.notes.trim() : ''
        const notes = given !== ''
          ? given
          : notesFromRequirement(await readFile(join(dir, FEATURE_DOC_FILES.需求), 'utf8').catch(() => undefined)) ?? ''
        if (notes === '') {
          sendJson(res, 400, {
            error: '不知道这一版该怎么跟她说 —— 需求.md 里没有「目标」那一行,也没带 notes。'
              + '发版记录与更新提示里显示的就是这一句,不能编一个',
          })
          return
        }
        if (notes.length > 2000) { sendJson(res, 400, { error: '这一句太长了(上限 2000 字)' }); return }
        const handoff = typeof body.handoff === 'string' && body.handoff.trim() !== '' ? body.handoff.trim() : undefined

        const startedAt = new Date().toISOString()
        await tasks.update(itemId, {
          selfShip: { branch, worktree, status: 'running', started_at: startedAt },
        })
        const shipped = await runSelfShip({
          projectPath: project.path,
          worktree,
          branch,
          name,
          featureDir: dir,
          notes,
          ...(handoff === undefined ? {} : { handoff }),
          ...(task.conversation === undefined ? {} : { sessionId: task.conversation.session_id }),
        }, {
          run: runInCwd,
          readText: one => readFile(one, 'utf8').catch(() => undefined),
          writeText: (one, text) => writeFile(one, text, 'utf8'),
          publish: selfUpdate.publish,
          applyUpdate: selfUpdate.applyUpdate,
          now: () => new Date(),
          home: selfUpdate.home ?? process.env.HOME ?? '',
        })

        await tasks.update(itemId, {
          selfShip: {
            branch,
            worktree,
            status: shipped.ok ? 'ok' : 'failed',
            ...(shipped.stopped_at === undefined ? {} : { stopped_at: shipped.stopped_at }),
            ...(shipped.note === undefined ? {} : { note: shipped.note }),
            ...(shipped.version === undefined ? {} : { version: shipped.version }),
            ...(shipped.previous_version === undefined ? {} : { previous_version: shipped.previous_version }),
            steps: shipped.steps,
            started_at: startedAt,
            ended_at: shipped.ended_at,
          },
          // 成功:推到「记录」态,她在那儿点一下「写进决策记录」就收尾。
          ...(shipped.ok ? { featureStage: '记录' as const } : {}),
        })
        if (!shipped.ok) {
          /**
           * 停下来了。**挂成「阻塞 · 出错」并把原话记在卡上** —— 座机那一通 `failed`
           * (`callOut.taskCallOutEvent`)与收件箱那一条(`butlerInbox` ①.6)都靠这两样,
           * 这里**不另造一条打电话的路**:同一件事有两条路能打电话,迟早会打两遍。
           *
           * 挪不过去(七态不许从这一格去「阻塞」)**不当成错**:卡上的 `self_ship` 已经
           * 记下了停在哪一步与原话,收件箱那一条照样出得来。如实把那句拒绝带回去。
           */
          const moved = await tasks.move(itemId, 'blocked')
          await tasks.update(itemId, {
            ...(moved.ok ? { blockReason: 'error' as const } : {}),
            note: shipped.note ?? '没拿到原因',
          })
          sendJson(res, 200, {
            ok: false,
            ...(shipped.stopped_at === undefined ? {} : { stopped_at: shipped.stopped_at }),
            ...(shipped.note === undefined ? {} : { note: shipped.note }),
            ...(shipped.version === undefined ? {} : { version: shipped.version }),
            ...(moved.ok ? {} : { move_note: moved.reason ?? '这张卡挪不进「阻塞」' }),
            steps: shipped.steps,
          })
          return
        }
        sendJson(res, 200, {
          ok: shipped.ok,
          ...(shipped.stopped_at === undefined ? {} : { stopped_at: shipped.stopped_at }),
          ...(shipped.note === undefined ? {} : { note: shipped.note }),
          ...(shipped.version === undefined ? {} : { version: shipped.version }),
          steps: shipped.steps,
        })
        return
      }

      /** 把一句话送给事务官。**回 undefined = 送到了**;送不进去回那句原话(同 /topic/*)。 */
      const sayToButler = async (text: string): Promise<string | undefined> => {
        if (task.conversation === undefined) return '这条需求底下还没有事务官的会话,话说不进去'
        if (butlerSession?.say === undefined) return '会话通道没接上,这句话说不进去'
        let accepted = false
        let rejection: 'model' | 'host' | undefined
        try { accepted = await butlerSession.say(task.conversation.session_id, text, reason => { rejection = reason }) } catch { accepted = false }
        return accepted ? undefined : rejection === 'model' ? '当前模型还没完成应用，这句话没有发送；请重试模型设置。' : rejection === 'host' ? '会话通道暂时不可用，这句话没有发送；请稍后重试。' : '这条会话在 DSH 里已经没了'
      }

      /**
       * 接需求先给确认点(2026-09-23,维护者 13:05)。与 `/topic/confirm` **逐字同一套**:
       * 没带 `points` 就只按规则挑几条回来;带了就写进 `需求.md` 顶部那一节 + 留痕 +
       * 按确认点生成「验收标准」。
       *
       * ★ 这一下过了之后,`/feature/run` 拼的那段话里才不再有「不要派活」那句硬话。
       */
      if (path === '/feature/confirm') {
        let existing: FeatureReviewEntry[] = []
        let docsNow: FeatureDocView[] = []
        try {
          existing = await readFeatureReviews(dir)
          docsNow = await readFeatureDocs(dir)
        }
        catch (error) { sendJson(res, 500, { error: `读不了这条需求的产物:${(error as Error).message}` }); return }

        const said = typeof body.need === 'string' && body.need.trim() !== ''
          ? body.need.trim()
          : (task.desc ?? '').trim() === '' ? name : (task.desc as string).trim()

        if (body.points === undefined) {
          const points = featureConfirmPoints(said)
          sendJson(res, 200, {
            ok: true,
            confirmed: featureConfirmed(existing),
            need: said,
            points,
            block: formatConfirmBlock({ understanding: said, points }),
            spoken: spokenConfirmBlock({ understanding: said, points }),
          })
          return
        }

        const parsed = parseConfirmPoints(body.points)
        if (!parsed.ok) { sendJson(res, 400, { error: parsed.error }); return }
        const changed = changedIndexes(parsed.points)
        const at = new Date()

        const before = docsNow.find(one => one.tab === FEATURE_CONFIRM_TAB)?.text ?? ''
        const saved = await saveFeatureDoc({
          dir,
          tab: FEATURE_CONFIRM_TAB,
          text: applyConfirmSections({ text: before, points: parsed.points, confirmed: true, at: at.toISOString(), changed }),
          now: at,
        })
        if (!saved.ok) { sendJson(res, 500, { error: saved.reason ?? '写不进去' }); return }

        const logged = await appendFeatureReview(dir, {
          at: at.toISOString(),
          tab: FEATURE_CONFIRM_TAB,
          action: 'confirm_points',
          stage,
          points: confirmTrace(parsed.points),
          ...(changed.length === 0 ? {} : { changed }),
        })
        if (!logged.ok) { sendJson(res, 500, { error: logged.reason }); return }
        sendJson(res, 200, {
          ok: true,
          confirmed: true,
          points: parsed.points,
          changed,
          acceptance: acceptanceLines(parsed.points),
          section: CONFIRM_SECTION_TITLE,
          acceptance_section: ACCEPTANCE_SECTION_TITLE,
        })
        return
      }

      if (path === '/feature/review') {
        if (featureTab === undefined) { sendJson(res, 400, { error: `tab 必须是 ${FEATURE_DOC_TABS.join(' / ')} 之一` }); return }
        const action = (DECK_REVIEW_ACTIONS as readonly string[]).includes(body.action as string)
          ? body.action as DeckReviewAction
          : undefined
        if (action === undefined) { sendJson(res, 400, { error: `action 必须是 ${DECK_REVIEW_ACTIONS.join(' / ')} 之一` }); return }
        const said = typeof body.text === 'string' ? body.text.trim() : ''
        // 「改一改」**必须带那一句**:一次没有理由的打回,事务官改出来的还是同一份。
        if (action === 'revise' && said === '') { sendJson(res, 400, { error: '「打回」要带一句话,告诉它改哪儿' }); return }
        if (said.length > 4000) { sendJson(res, 400, { error: '一句话太长了(上限 4000 字)' }); return }

        // **先留痕再送话**:送不出去的那一次她照样把过关了,那一行不能因为 DSH 掉线就丢。
        const logged = await appendFeatureReview(dir, {
          at: new Date().toISOString(),
          tab: featureTab,
          action,
          stage,
          ...(said === '' ? {} : { text: said }),
        })
        if (!logged.ok) { sendJson(res, 500, { error: logged.reason }); return }
        noteBehavior({ 事: BEHAVIOR_EVENTS.review, 对象: `需求 ${name} · ${featureTab}`, 结果: reviewResultText(action), ...(said === '' ? {} : { 原话: said }) })
        // 他的把关也进规矩表的反馈(2026-09-24 晚,卡 K):通过 / 打回各记一条;打回原因在不止一件活上重复 → 试用。
        if (rules !== undefined && (action === 'pass' || action === 'revise')) {
          await rules.feedback({
            kind: action,
            where: typeof itemId === 'string' && itemId !== '' ? itemId : name,
            area: ruleWorkArea(`${name}\n${said}`),
            channel: 'review',
            ...(said === '' ? {} : { text: said }),
          }).catch(() => undefined)
        }

        if (action !== 'revise') { sendJson(res, 200, { ok: true, sent: false }); return }
        const failed = await sayToButler(buildFeatureReviseMessage({ name, taskId: itemId, tab: featureTab, text: said }))
        sendJson(res, 200, { ok: true, sent: failed === undefined, ...(failed === undefined ? {} : { note: failed }) })
        return
      }

      if (path === '/feature/record') {
        /**
         * 「写进决策记录」。**一个字都不代她写**:`记录.md` 还没有、或者那四行缺一行,
         * 一律如实拒绝(同 topicReview.ts 第 1 条纪律)—— 一条编出来的「遗留:无」
         * 会变成半年后没人敢信的历史。
         */
        let draft: string | undefined
        try { draft = await readFeatureRecordDraft(dir) }
        catch (error) { sendJson(res, 500, { error: `读不了 记录.md:${(error as Error).message}` }); return }
        if (draft === undefined || draft.trim() === '') {
          sendJson(res, 409, { error: '记录.md 还没有内容 —— 先让事务官把这一条写出来' })
          return
        }
        const parsed = parseDecisionEntry(draft)
        if (!parsed.ok) {
          sendJson(res, 409, { error: `记录.md 里缺这几行:${parsed.missing.join(' / ')} —— 补齐再写进决策记录` })
          return
        }
        const rel = typeof body.record_rel === 'string' && body.record_rel.trim() !== ''
          ? body.record_rel.trim()
          : undefined
        const written = await appendDecisionRecord({
          projectPath: project.path,
          ...(rel === undefined ? {} : { rel }),
          day: recordDay(new Date()),
          name,
          entry: parsed.entry,
        })
        if (!written.ok) { sendJson(res, 500, { error: written.reason ?? '写不进决策记录', path: written.path }); return }
        // 这件事也进同一份留痕:这条需求上发生过什么只该有一处可查。
        const logged = await appendFeatureReview(dir, {
          at: new Date().toISOString(),
          tab: '记录',
          action: 'record',
          stage,
          text: written.path,
        })
        sendJson(res, 200, {
          ok: true,
          path: written.path,
          added: written.added === true,
          ...(logged.ok ? {} : { log_note: logged.reason }),
        })
        return
      }

      // path === '/feature/run'
      const note = typeof body.note === 'string' ? body.note.trim() : ''
      if (note.length > 4000) { sendJson(res, 400, { error: '一句话太长了(上限 4000 字)' }); return }

      /**
       * Codex / Claude 这一次派不派得出去。**只问得到一件看得见的事**:
       * 窗口编排壳接没接上(`/dispatch/client` 靠的就是它)。窗口在不在、登没登录
       * 要真送一次才知道,所以这一版**不去试送** —— 与选题那边"不试发一次"同一条分寸。
       */
      const handsReady = clientDispatch !== undefined
      const handsNote = handsReady ? undefined : '窗口编排壳没接上,话送不进 Codex / Claude 的窗口'
      const standin = stageNeedsHands(stage) && !handsReady

      let featureDocs: FeatureDocView[] = []
      let featureReviews: FeatureReviewEntry[] = []
      try {
        featureDocs = await readFeatureDocs(dir)
        featureReviews = await readFeatureReviews(dir)
      }
      catch (error) {
        sendJson(res, 500, { error: `读不了这条需求的产物:${(error as Error).message}` })
        return
      }

      const text = buildFeatureRunPrompt({
        name,
        taskId: itemId,
        stage,
        dir,
        project: project.name,
        projectPath: project.path,
        docs: featureDocs,
        reviews: featureReviews,
        handsReady,
        // 接需求先给确认点(2026-09-23)。没过这一下,梳理那一态先问、后面几态不许派活。
        confirmed: featureConfirmed(featureReviews),
        ...((task.desc ?? '').trim() === '' ? {} : { need: (task.desc as string).trim() }),
        ...(note === '' ? {} : { note }),
        ...(handsNote === undefined ? {} : { handsNote }),
      })

      const failed = await sayToButler(text)
      const logged = await appendFeatureReview(dir, {
        at: new Date().toISOString(),
        tab: FEATURE_STAGE_TAB[stage],
        action: 'run',
        stage,
        ...(note === '' ? {} : { text: note }),
        ...(standin ? { standin: true } : {}),
      })
      sendJson(res, 200, {
        ok: true,
        sent: failed === undefined,
        stage,
        standin,
        text,
        ...(failed === undefined ? {} : { note: failed }),
        ...(logged.ok ? {} : { log_note: logged.reason }),
      })
      return
    }

    /**
     * 哨兵(2026-09-09,借鉴 dsh-sentinel 的设计)。增删查三条,风格照 /note/* 与 /credentials。
     *
     * **写只认回环**(同 /credentials):8791 对手机热点网段开放,而监视项是"让这台机器
     * 定时去探某个目标"的指令——同一个热点下的任何人都能塞进来的话,这个口子的性质
     * 就变了。查不设限:展示台在另一台机器上,也该看得见在盯什么。
     *
     * `command` 类不做(审计结论),服务层 validate 会拒,这里把它的错误如实转成 400。
     */
    if (path === '/sentinel' && req.method === 'GET') {
      if (sentinel === undefined) { sendJson(res, 404, { error: '哨兵未启用' }); return }
      sendJson(res, 200, { watches: sentinel.list() })
      return
    }

    if (path === '/sentinel/add' && req.method === 'POST') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机加监视项' }); return }
      if (sentinel === undefined) { sendJson(res, 404, { error: '哨兵未启用' }); return }
      const text = await readBody(req)
      let body: unknown
      try { body = JSON.parse(text) } catch { sendJson(res, 400, { error: 'body 不是合法 JSON' }); return }
      const raw = (body ?? {}) as Record<string, unknown>
      const input = {
        kind: raw.kind as SentinelInput['kind'],
        target: typeof raw.target === 'string' ? raw.target : '',
        note: typeof raw.note === 'string' ? raw.note : '',
        ...(typeof raw.interval_sec === 'number' ? { interval_sec: raw.interval_sec } : {}),
        ...(typeof raw.cooldown_sec === 'number' ? { cooldown_sec: raw.cooldown_sec } : {}),
        ...(typeof raw.max_fires === 'number' ? { max_fires: raw.max_fires } : {}),
        ...(typeof raw.expires_at === 'string' && raw.expires_at !== '' ? { expires_at: raw.expires_at } : {}),
      }
      let watch
      try {
        watch = await sentinel.add(input)
      }
      catch (error) {
        // 校验失败是**用户填错了**,不是服务出错:400 + 服务层那句人话原文
        // (「只有 file/http/process/port;command 类不做」这句要原样到界面上)。
        sendJson(res, 400, { error: error instanceof Error ? error.message : '加不上这条监视项' })
        return
      }
      broadcast({ kind: 'snapshot', state: await composeState() })
      sendJson(res, 200, { ok: true, watch })
      return
    }

    if (path === '/sentinel/remove' && req.method === 'POST') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机取消监视项' }); return }
      if (sentinel === undefined) { sendJson(res, 404, { error: '哨兵未启用' }); return }
      const text = await readBody(req)
      let body: unknown
      try { body = JSON.parse(text) } catch { sendJson(res, 400, { error: 'body 不是合法 JSON' }); return }
      const raw = (body ?? {}) as Record<string, unknown>
      if (typeof raw.id !== 'string' || raw.id === '') { sendJson(res, 400, { error: 'id 必须是非空字符串' }); return }
      const removed = await sentinel.remove(raw.id)
      // 取消掉的监视项那条会话要跟着收掉,否则黄点会一直挂着——事件走跟触发同一条通道。
      if (removed.event !== undefined) {
        service.applyEvent(removed.event)
        broadcast({ kind: 'event', event: removed.event })
      }
      broadcast({ kind: 'snapshot', state: await composeState() })
      // 取消不存在的回 ok:false 而不是 404,同 /note/remove:那是"它已经不在了"的如实回答。
      sendJson(res, 200, { ok: removed.ok })
      return
    }

    /**
     * 随手记(PRD §5.5,2026-08-25 版面重排起落盘)。只认本机回环——这是本人的私记,
     * 不给远端写入口(同 /layout /project/* 的规矩)。
     */
    if (path === '/note/add' && req.method === 'POST') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机记' }); return }
      if (notes === undefined) { sendJson(res, 404, { error: '随手记未启用' }); return }
      const text = await readBody(req)
      let body: unknown
      try { body = JSON.parse(text) } catch { sendJson(res, 400, { error: 'body 不是合法 JSON' }); return }
      const raw = (body ?? {}) as Record<string, unknown>
      // 空白直接在这里挡掉:服务层也会拒(抛),但那是防线不是接口契约,400 要说人话。
      if (typeof raw.text !== 'string' || raw.text.trim() === '') {
        sendJson(res, 400, { error: 'text 必须是非空字符串' }); return
      }
      const note = await notes.add(raw.text)
      broadcast({ kind: 'snapshot', state: await composeState() })
      sendJson(res, 200, { ok: true, note })
      return
    }

    if (path === '/note/remove' && req.method === 'POST') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机删' }); return }
      if (notes === undefined) { sendJson(res, 404, { error: '随手记未启用' }); return }
      const text = await readBody(req)
      let body: unknown
      try { body = JSON.parse(text) } catch { sendJson(res, 400, { error: 'body 不是合法 JSON' }); return }
      const raw = (body ?? {}) as Record<string, unknown>
      if (typeof raw.id !== 'string' || raw.id === '') { sendJson(res, 400, { error: 'id 必须是非空字符串' }); return }
      // 删不存在的返回 ok:false 而不是 404:这是"那条已经不在了"的如实回答,
      // 不是路由不存在——界面下一拍轮询自然会看到真相,不需要为此弹错。
      const removed = await notes.remove(raw.id)
      broadcast({ kind: 'snapshot', state: await composeState() })
      sendJson(res, 200, { ok: removed })
      return
    }

    /**
     * 事务官本机后端(butler-server,2026-09-11)。
     * - GET  /butler/status        当前状态(同 /state.butler,给不想拉整份快照的调用方)
     * - POST /butler/start|stop    启停,走 launchctl;只认本机回环(它拉起/杀掉的是本机进程)
     * - POST /butler/open          在浏览器里打开 http://127.0.0.1:<port>/admin/,同样只认回环
     * - *    /butler/proxy/<path>  原样转发到 butler-server 并带上工作台令牌——入口统一在 8791,
     *                              手机以后从这里进;来源门由 isRemoteAllowed 统一把守
     */
    /**
     * 事务官外观(2026-09-16,决策记录同日第 1 条):一份配置两端共用。
     * - GET /butler/appearance  回环与已配对手机都能读;没存过 404「还没有保存过外观」(不编默认值)
     * - PUT /butler/appearance  只认回环——外观在 Mac 上调,手机只继承(Ben:「可不是两套不一样的东西」)
     */
    if (path === '/butler/appearance' && (req.method === 'GET' || req.method === 'PUT')) {
      if (appearance === undefined) { sendJson(res, 404, { error: '外观同步未接线' }); return }
      if (req.method === 'GET') {
        if (!trusted) { sendJson(res, 403, { error: '只能在本机或已配对的手机上读外观' }); return }
        const doc = appearance.get()
        if (doc === undefined) { sendJson(res, 404, { error: '还没有保存过外观' }); return }
        sendJson(res, 200, doc)
        return
      }
      if (!loopback) { sendJson(res, 403, { error: '只能在 Mac 上改外观' }); return }
      const text = await readBody(req)
      let body: unknown
      try { body = JSON.parse(text === '' ? '{}' : text) } catch { sendJson(res, 400, { error: 'body 不是合法 JSON' }); return }
      const result = await appearance.put(body)
      if (!result.ok) { sendJson(res, 400, { error: result.error }); return }
      broadcast({ kind: 'snapshot', state: await composeState() })
      sendJson(res, 200, { ok: true, version: result.doc.version, updated_at: result.doc.updated_at })
      return
    }
    if (path === '/butler/status' && req.method === 'GET') {
      if (butler === undefined) { sendJson(res, 404, { error: '本机后端未接线' }); return }
      sendJson(res, 200, await butler.view())
      return
    }
    if ((path === '/butler/start' || path === '/butler/stop' || path === '/butler/open') && req.method === 'POST') {
      if (!loopback) { sendJson(res, 403, { error: '只能在本机操作本机后端' }); return }
      if (butler === undefined) { sendJson(res, 404, { error: '本机后端未接线' }); return }
      const action = path.slice('/butler/'.length) as 'start' | 'stop' | 'open'
      const result = await butler[action]()
      // 业务失败 HTTP 层照样 200、把 { ok:false, error } 如实回去——话是说给人听的,界面原样转达。
      sendJson(res, 200, result)
      return
    }
    /**
     * 连接器(卡 OC2)。默认装上,开机后由 index.ts 在后台叫一次 `ensure()`,所以这几条只是
     * 「看一眼」与「手动来一次」:
     * - GET  /connector/status      状态(设置里那一行读它)
     * - POST /connector/install     手动「再试一次」(上次装失败之后)
     * - POST /connector/start|stop  启停
     * - POST /connector/uninstall   卸掉,**连各家账号的凭据一起删**
     * 写的那四条只认回环 —— 手机不该能把她机器上的连接器卸掉。
     */
    if (path === '/connector/status' && req.method === 'GET') {
      if (connector === undefined) { sendJson(res, 404, { error: '连接器未接线' }); return }
      sendJson(res, 200, await connector.view())
      return
    }
    if ((path === '/connector/install' || path === '/connector/start' || path === '/connector/stop' || path === '/connector/uninstall') && req.method === 'POST') {
      if (!loopback) { sendJson(res, 403, { error: '只能在本机操作连接器' }); return }
      if (connector === undefined) { sendJson(res, 404, { error: '连接器未接线' }); return }
      const action = path.slice('/connector/'.length) as 'install' | 'start' | 'stop' | 'uninstall'
      const result = await connector[action]()
      broadcast({ kind: 'snapshot', state: await composeState() })
      // 业务失败照样 200、把 { ok:false, error } 如实回去 —— 界面原样转达。
      sendJson(res, 200, result)
      return
    }
    /**
     * 通话模式(2026-09-17,Ben:「点一下说一声的方式还是一半,不如做 RTC 通话模式吧」)。
     *
     * - POST /butler/rtc/callback   火山把电话里的 tool_calls POST 到这里。**唯一的门是进程级随机签名**
     *                               (设备令牌那一道在上面按 RTC_CALLBACK_PATH 放行了——火山没有设备令牌)。
     *                               先 200 再异步办:火山的回调不该等我们建卡。
     * - POST /butler/call/record    挂断后手机 / 工人把这一通(时长 + 字幕)交上来,落成一条**通话记录**(2026-10-22 起不建卡)。
     */
    if (path === RTC_CALLBACK_PATH && req.method === 'POST') {
      if (rtcCall === undefined) { sendJson(res, 404, { error: '通话模式未接线' }); return }
      // 火山发这条回调时不带 Content-Type,所以按文本收再自己解析。
      const text = await readBody(req)
      let body: unknown
      try { body = JSON.parse(text === '' ? '{}' : text) } catch { sendJson(res, 400, { error: 'body 不是合法 JSON' }); return }
      const raw = (body ?? {}) as Record<string, unknown>
      if (!rtcCall.verify(raw.Signature)) {
        // 签名不符不解释原因(那等于给猜的人递线索),日志里也不记签名本身。
        sendJson(res, 401, { error: '签名不符' })
        return
      }
      sendJson(res, 200, { ok: true })
      // information(调用通知)这类只确认接收,不办事。
      if (raw.Type !== 'tool_calls') return
      setImmediate(() => { void handleCallToolCalls(raw) })
      return
    }

    if (path === '/butler/call/record' && req.method === 'POST') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机或已配对的手机上写通话记录' }); return }
      if (callRecords === undefined) { sendJson(res, 404, { error: '通话记录未接线' }); return }
      const denied = await agentWriteDenied(req, device)
      if (denied !== undefined) { sendJson(res, 403, { error: denied }); return }
      const text = await readBody(req)
      let body: unknown
      try { body = JSON.parse(text === '' ? '{}' : text) } catch { sendJson(res, 400, { error: 'body 不是合法 JSON' }); return }
      const raw = (body ?? {}) as Record<string, unknown>
      const transcript: CallUtterance[] = Array.isArray(raw.transcript)
        ? (raw.transcript as unknown[])
            .map((entry) => (entry ?? {}) as { who?: unknown, text?: unknown })
            .filter((entry): entry is { who: 'me' | 'butler', text: string } =>
              (entry.who === 'me' || entry.who === 'butler') && typeof entry.text === 'string' && entry.text.trim() !== '')
            .map(entry => ({ who: entry.who, text: entry.text.trim() }))
        : []
      const duration = typeof raw.durationSeconds === 'number' && Number.isFinite(raw.durationSeconds) && raw.durationSeconds >= 0
        ? Math.round(raw.durationSeconds)
        : undefined
      /**
       * 工人带来的「要办」(`todos`):通话里建卡那一下**工作台连不上**的那几张(工人那一侧的判法在
       * `channel-worker/src/callRecord.ts` 的 `unsavedTodoOf`)。只有这一种算「明确要办」,按建卡那一套补建;
       * 字幕里她说「记一下」却没卡对得上的,只标「可能要办」(`maybeTodosOf`),不建。
       */
      const todos = Array.isArray(raw.todos)
        ? (raw.todos as unknown[])
            .map(entry => (entry ?? {}) as { title?: unknown, desc?: unknown, feature?: unknown })
            .filter(entry => typeof entry.title === 'string' && entry.title.trim() !== '')
            .slice(0, 10)
            .map(entry => ({
              title: (entry.title as string).trim(),
              ...(typeof entry.desc === 'string' && entry.desc.trim() !== '' ? { desc: entry.desc.trim() } : {}),
              ...(entry.feature === true ? { feature: true } : {}),
            }))
        : []
      // 引导那一通**不落字幕**,只落时长 + 按阶段机拼的一句话(server/callSummary.ts);别的一律当平时那一通。
      const callKind = raw.kind === 'onboarding' ? 'onboarding' as const : 'call' as const
      if (callKind === 'call' && transcript.length === 0 && duration === undefined && todos.length === 0) {
        sendJson(res, 200, { ok: true, skipped: true, why: '这一份里既没有时长也没有字幕,不是一通电话' })
        return
      }
      /**
       * 这一通的编号。手机与工人都可能报同一通 —— 带着同一个 call_id 就只落一份(**先到的那份的时刻与文件名算数**,
       * 后到的字幕更全就补上)。**不带**(老手机)就由工作台编一个、照旧落一份,不去猜「这是不是刚才那一通」:
       * 猜错了会把两通不同的电话并成一份(D13)。
       */
      const callId = typeof raw.call_id === 'string' && raw.call_id.trim() !== '' ? raw.call_id.trim().slice(0, 64) : undefined
      const id = callId ?? callRecords.newId()
      const existing = callId === undefined ? undefined : await callRecords.get(callId)
      const kind = existing?.kind ?? callKind
      const incoming = kind === 'onboarding' ? [] : transcript
      const keepOld = existing !== undefined && existing.transcript.length >= incoming.length
      const lines = keepOld ? existing.transcript : incoming
      // 通话里电话那一端动过的卡:先到那份挂上的照留,这一份的窗口里新冒出来的补上。
      const items: CallRecordItemLink[] = [...(existing?.items ?? [])]
      for (const one of callItemsSince(Date.now() - (duration ?? existing?.duration_seconds ?? 0) * 1000 - CALL_ITEM_SLACK_MS)) {
        const at = items.findIndex(item => item.task_id === one.task_id && item.did === one.did)
        if (at === -1) items.push(one)
        else items[at] = { ...items[at]!, ...one }
      }
      const fromCall = { kind: 'said' as const, ref: `${CALL_RECORD_FROM_PREFIX}${id}` }
      if (tasks !== undefined) {
        // 「要办」补建:同一通里已经建过同名的那张就不再建(两边各报一次时不建两张)。
        const known = new Set((await tasks.list()).tasks.filter(task => items.some(item => item.did === 'created' && item.task_id === task.id)).map(task => task.title))
        for (const todo of todos) {
          if (known.has(todo.title)) continue
          const made = await tasks.create({
            title: todo.title,
            ...(todo.desc === undefined ? {} : { desc: todo.desc }),
            ...(todo.feature === true ? { kind: 'feature' as const } : {}),
            // 与工人在通话里建卡那一下同一个来源(channel-worker/src/workbench.ts 的 createTask)。
            source: { kind: 'session', ref: '电话' },
            from: fromCall,
          })
          if (made.ok && made.id !== undefined) {
            known.add(todo.title)
            items.push({ task_id: made.id, did: 'created' })
          }
        }
        // 标题按此刻看板上的写;建的那几张指回这一通(已经有来源的不改)。
        const board = (await tasks.list()).tasks
        for (const item of items) {
          const task = board.find(one => one.id === item.task_id)
          if (task === undefined) continue
          item.title = task.title
          if (item.did === 'created' && task.from === undefined) await tasks.update(task.id, { from: fromCall })
        }
      }
      const linked = items.filter(item => item.title !== undefined || tasks === undefined)
      const summary = kind === 'onboarding'
        ? (() => { const input = onboarding?.summaryInput?.(); return input === undefined ? '引导那一通' : onboardingCallSummary(input) })()
        : plainCallSummary(lines)
      const maybe = kind === 'onboarding' ? [] : maybeTodosOf(lines, linked)
      const durationSeconds = duration ?? existing?.duration_seconds
      const put = await callRecords.put({
        id,
        kind,
        at: existing?.at ?? new Date().toISOString(),
        ...(durationSeconds === undefined ? {} : { duration_seconds: durationSeconds }),
        summary,
        lines: lines.length,
        transcript: lines,
        items: linked,
        ...(maybe.length === 0 ? {} : { maybe_todo: maybe }),
      })
      if (!put.ok) { sendJson(res, 500, { error: put.error }); return }
      /**
       * 行为账(2026-10-09 卡「行为账」;2026-10-22 起多记一条「通了电话」):只在第一次落下时记
       * (同一通后到的那份不重记)。谁报上来的(手机 / 工人)都算「电话」那一端;事务官自己、认不出来的不记。
       * 引导那一通不落字幕,也就不记「说」。
       */
      if (put.created && asker !== 'butler' && asker !== 'unknown') {
        noteBehavior({ 事: BEHAVIOR_EVENTS.talk, 对象: `通话 ${id}`, 结果: [formatCallDuration(durationSeconds) ?? '时长没记下', `${lines.length} 句`].join(' · ') }, '电话')
        if (kind === 'call') {
          for (const line of lines) {
            if (line.who === 'me') noteBehavior({ 事: BEHAVIOR_EVENTS.say, 对象: `通话 ${id}`, 结果: '电话里说', 原话: line.text }, '电话')
          }
        }
      }
      broadcast({ kind: 'snapshot', state: await composeState() })
      sendJson(res, 200, {
        ok: true,
        id,
        summary,
        ...(put.record.file === undefined ? {} : { file: put.record.file }),
        ...(put.file_error === undefined ? {} : { file_error: put.file_error }),
        ...(existing === undefined ? {} : { deduped: true, merged: !keepOld }),
      })
      return
    }

    if (path.startsWith(BUTLER_PROXY_PREFIX)) {
      if (butler === undefined) { sendJson(res, 404, { error: '本机后端未接线' }); return }
      const rest = path.slice(BUTLER_PROXY_PREFIX.length)
      /**
       * 手机(带设备令牌的非本机来源,2026-09-14)只能到后端的公开面:/api/*(形象、TTS、ASR、RTC)、
       * /uploads/*(头像/背景/铃声)、/health。/admin/* 是配置后台(供应商密钥、形象编辑),
       * 与 /butler/start|stop 同一条规矩——碰密钥和本机进程的只认回环。
       */
      if (!loopback && !isButlerPublicPath(rest)) {
        sendJson(res, 403, { error: '手机只能访问本机后端的公开接口' })
        return
      }
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const contentType = req.headers['content-type']
      /**
       * 通话人设在这里注入(2026-09-17)。只改 /api/rtc/start 这一条的请求体,别的路径原样转发。
       * 为什么在代理层而不是让手机先取一遍人设:少一个来回(通话建连每一百毫秒都在体感里),
       * 而且人设与工具清单从此**只在工作台这一侧存在**,改过的 App 换不掉事务官。
       */
      const forwardBody = rtcCall !== undefined && req.method === 'POST' && (rest.split('?')[0] ?? '') === 'api/rtc/start'
        ? await injectCallPersona(Buffer.concat(chunks))
        : Buffer.concat(chunks)
      // 转发时挑着带的头:设备身份(后端按它落通话记录)、手机看到的地址(后端据此拼绝对 URL)、Range/Accept。
      // 设备令牌(Authorization 或 ?token=)到此为止,绝不往后端送。
      const forwarded: Record<string, string> = {
        'x-forwarded-proto': 'http',
        'x-forwarded-prefix': BUTLER_PROXY_PREFIX.slice(0, -1),
      }
      const hostHeader = req.headers.host
      if (typeof hostHeader === 'string' && hostHeader !== '') forwarded['x-forwarded-host'] = hostHeader
      if (device !== undefined) forwarded['x-workbench-device'] = device.id
      for (const name of ['range', 'accept', 'if-none-match', 'if-range'] as const) {
        const value = req.headers[name]
        if (typeof value === 'string' && value !== '') forwarded[name] = value
      }
      const upstream = await butler.proxy({
        method: req.method ?? 'GET',
        path: `/${rest}${stripQueryParam(queryOf(req.url), 'token')}`,
        ...(typeof contentType === 'string' ? { contentType } : {}),
        body: forwardBody,
        headers: forwarded,
      })
      res.writeHead(upstream.status, {
        ...(upstream.headers ?? {}),
        ...(upstream.contentType === undefined ? {} : { 'content-type': upstream.contentType }),
        // 手机 WebView 里的 fetch 才读得到这几个头(分段下包、缓存对账)。
        ...(allowOrigin === undefined ? {} : { 'access-control-expose-headers': 'etag, content-range, accept-ranges, content-length' }),
      })
      res.end(upstream.body)
      return
    }

    /**
     * 应用激活(spec R1/R2)。只发命令、不做前台校验——理由见 apps.ts 顶部注释
     * （open -a 是异步且 flaky 的，前台校验要用 lsappinfo，属于后续任务）。
     */
    if (path === '/activate' && req.method === 'POST') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机激活应用' }); return }
      if (runCommand === undefined) { sendJson(res, 404, { error: '激活未启用' }); return }

      const text = await readBody(req)
      let body: unknown
      try {
        body = JSON.parse(text)
      } catch {
        sendJson(res, 400, { error: 'body 不是合法 JSON' })
        return
      }
      const raw = (body ?? {}) as Record<string, unknown>
      if (typeof raw.app !== 'string' || raw.app === '') { sendJson(res, 400, { error: 'app 必须是非空字符串' }); return }

      // 程序化激活抑制(2026-09-09,dock.ts ACTIVATE_SUPPRESS_MS):这是我们自己发起的激活,
      // 标记必须先于 open 发出——应用自摆窗口的 moved 事件可能紧跟着来。dock 未接线时不影响。
      if (dock !== undefined && Object.hasOwn(APP_COMMANDS, raw.app)) await dock.noteActivated(raw.app)
      const ok = await activateApp(raw.app, runCommand)
      if (!ok) { sendJson(res, 404, { error: `不认识这个应用：${raw.app}` }); return }
      sendJson(res, 200, { ok: true })
      return
    }

    /**
     * 窗口编排写路由(spec W1–W9,Task 6):贴合/取消贴合/场景增删改与恢复。
     * 和 /activate 一样,这些要么摆动本机真窗口、要么改本机场景文件,只认回环来源。
     * 业务失败(比如壳没授权、场景没内容)HTTP 层照样 200、把 { ok:false, reason } 如实回出去——
     * 那不是接口出错,是执行结果;404 才是"这条能力压根没接线"。
     */
    if (path === '/snap' && req.method === 'POST') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机操作窗口' }); return }
      if (orchestrator === undefined) { sendJson(res, 404, { error: '窗口编排未启用' }); return }
      const text = await readBody(req)
      let body: unknown
      try { body = JSON.parse(text) } catch { sendJson(res, 400, { error: 'body 不是合法 JSON' }); return }
      const raw = (body ?? {}) as Record<string, unknown>
      if (typeof raw.app !== 'string' || raw.app === '') { sendJson(res, 400, { error: 'app 必须是非空字符串' }); return }
      const rect = parseRect(raw.rect)
      if (rect === undefined) { sendJson(res, 400, { error: 'rect 必须是 {x,y,w,h} 数字对象' }); return }
      const result = await orchestrator.snap(raw.app, rect)
      broadcast({ kind: 'snapshot', state: await composeState() })
      sendJson(res, 200, result)
      return
    }

    if (path === '/unsnap' && req.method === 'POST') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机操作窗口' }); return }
      if (orchestrator === undefined) { sendJson(res, 404, { error: '窗口编排未启用' }); return }
      const result = await orchestrator.unsnap()
      broadcast({ kind: 'snapshot', state: await composeState() })
      sendJson(res, 200, result)
      return
    }

    /**
     * 窗口槽应用增删(spec S4):只认回环来源,跟 /scene/* 同一条纪律——
     * 业务失败(找不到应用、名字/bundle id 重复、基础应用不可删)HTTP 层照样 200、
     * { ok:false, reason } 如实回出去;404 才是"appsRegistry 压根没接线"。
     */
    if (path === '/apps/add' && req.method === 'POST') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机管理应用清单' }); return }
      if (registry === undefined) { sendJson(res, 404, { error: '窗口编排未启用' }); return }
      const text = await readBody(req)
      let body: unknown
      try { body = JSON.parse(text) } catch { sendJson(res, 400, { error: 'body 不是合法 JSON' }); return }
      const raw = (body ?? {}) as Record<string, unknown>
      if (typeof raw.name !== 'string' || raw.name === '') { sendJson(res, 400, { error: 'name 必须是非空字符串' }); return }
      const label = typeof raw.label === 'string' ? raw.label : undefined
      const result = await registry.add(raw.name, label)
      broadcast({ kind: 'snapshot', state: await composeState() })
      // 真加成了才要紧——窗位叠的 observe 订阅集合得跟着新应用扩一份,业务失败(找不到应用等)
      // 应用清单压根没变,不必重发。
      if (result.ok) onAppsChanged?.()
      sendJson(res, 200, result)
      return
    }

    if (path === '/apps/remove' && req.method === 'POST') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机管理应用清单' }); return }
      if (registry === undefined) { sendJson(res, 404, { error: '窗口编排未启用' }); return }
      const text = await readBody(req)
      let body: unknown
      try { body = JSON.parse(text) } catch { sendJson(res, 400, { error: 'body 不是合法 JSON' }); return }
      const raw = (body ?? {}) as Record<string, unknown>
      if (typeof raw.key !== 'string' || raw.key === '') { sendJson(res, 400, { error: 'key 必须是非空字符串' }); return }
      const result = await registry.remove(raw.key)
      broadcast({ kind: 'snapshot', state: await composeState() })
      // 同上:只在真删掉了才重发 observe。
      if (result.ok) onAppsChanged?.()
      sendJson(res, 200, result)
      return
    }

    /**
     * 窗位叠(spec 2026-08-24 窗位叠 v2 V1–V6):槽位矩形上报 + 标签切换/放出。
     * 跟 /scene/* 同一条纪律:只认回环来源,未接线 404「窗位叠未启用」,业务失败
     * (switchTo/release 回 ok:false)HTTP 层仍是 200、原样透传 reason——
     * 那不是接口出错,是执行结果;404 才是"这条能力压根没接线"。
     */
    if (path === '/slot/rect' && req.method === 'POST') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机操作窗位叠' }); return }
      if (dock === undefined) { sendJson(res, 404, { error: '窗位叠未启用' }); return }
      const text = await readBody(req)
      let body: unknown
      try { body = JSON.parse(text) } catch { sendJson(res, 400, { error: 'body 不是合法 JSON' }); return }
      const raw = (body ?? {}) as Record<string, unknown>
      // 真机实证(2026-08-25 矩形上报只认壳内页面):壳内 WKWebView、Chrome 里开的工作台
      // 标签、浏览器窗格各自按自己的视口量矩形上报,互相矛盾的合法值交替覆盖会把窗位
      // 贴合位置搞乱——source !== 'app' 一律不进 dock.setSlotRect(含 rect:null 清除
      // 这条路径,不然浏览器标签的一次卸载清除就能抹掉壳内页面刚报的真值)。业务拒绝
      // 不是接口出错(先例 /snap):HTTP 层仍是 200、把 { ok:false, reason } 如实回出去。
      // 这同时天然掐死"开了几天没刷新的旧版页面标签"的污染——旧客户端的上报请求压根不带
      // source 字段,不需要单独识别版本号,缺字段本身就足够被这条规则拒绝。
      //
      // 评审补(2026-08-25):被拒的请求不能对 recent_rects 观测环完全失明——部署兼容
      // 窗口期(壳内页面还没跟上带 source 这条规则)排障时,不然"环是空的"和"确实没在报"
      // 无法区分。recordRejectedRect 只进环、绝不碰 slotRect(parseRect 认不出就记 null,
      // 不为了诊断这一条额外放宽矩形校验)。
      // 矩形投毒案二审(2026-08-26 真机实证):source:'app' 是页面自称——`?ben-workbench=app`
      // 谁都能加,真机抓到一个开在真实浏览器窄窗口里的工作台页(槽体被挤到 min-height
      // 兜底的 1240×120)带着 app 参数把假矩形当壳的身份报了进来,点谁的标签谁被塞进
      // 假槽再被判"拖出"除名。URL 参数与 body 字段都改得了,唯 UA 是壳进程给自己
      // WKWebView 配置的属性(applicationNameForUserAgent),网页伪造不了——source 之外
      // 再验 UA 里的壳标记,两道都过才算壳内页面。
      if (raw.source !== 'app' || !isShellUserAgent(req)) {
        dock.recordRejectedRect(raw.rect === null ? null : (parseRect(raw.rect) ?? null), raw.reason === 'resize' ? 'resize' : undefined)
        sendJson(res, 200, { ok: false, reason: '仅壳内页面可上报窗位矩形' })
        return
      }
      // I3:rect:null 是显式清除——窗位隐藏时槽体已经卸载,客户端借此让服务端
      // 忘掉上一次的矩形,不留着一份指向空处的旧值继续参与认领/切换判定。
      if (raw.rect === null) {
        dock.setSlotRect(undefined)
        // 矩形失效时「拖进来松手」那一下的光也得忘掉它(I3 那条清除路径)。
        highlight?.setSlotRect(undefined)
        broadcast({ kind: 'snapshot', state: await composeState() })
        sendJson(res, 200, { ok: true })
        return
      }
      const rect = parseRect(raw.rect)
      if (rect === undefined) { sendJson(res, 400, { error: 'rect 必须是 {x,y,w,h} 数字对象或 null' }); return }
      // S5:reason 是"这次上报能不能驱动当前在台窗口跟随重贴"的唯一凭证——只认字面量
      // 'resize'(用户真的拖了窗位模块把手松手,或 slot 模块 basis 真的变了),其余一律
      // 当没传(保守:不认识的值当被动上报处理,不给它挪窗口的权力,而不是放行)。
      const reason = raw.reason === 'resize' ? 'resize' : undefined
      dock.setSlotRect(rect, reason)
      highlight?.setSlotRect(rect)
      broadcast({ kind: 'snapshot', state: await composeState() })
      sendJson(res, 200, { ok: true })
      return
    }

    /**
     * 壳窗口的「前台 / 桌面」两档(2026-09-18,Ben:「安装完……现在的层级已经在底部了,导致我
     * 缩小了很多应用才看到页面,用户会觉得出 bug 了。登录和引导的时候,应该是和其他应用一样,
     * 能在顶部的,现在写死是底部」)。
     *
     * 网页按自己此刻在哪一屏(登录 / 首次流程+引导 / 工作台本体)算出该是哪一档,发到这里,
     * 这里原样转给壳。**判断不在服务端**——服务端并不知道浏览器上此刻渲染的是哪一屏,
     * 那份纯判断在 src/client/shellWindowMode.ts(有单测)。
     *
     * 三道门,前两道照抄 /slot/rect 那条纪律:
     *   1. 只认回环(`trusted` 里回环那一半由 loopback 单独判:这动的是本机屏幕上的一扇窗,
     *      手机拿着有效设备令牌也没道理去掀电脑窗口的层级);
     *   2. `source:'app'` + 壳的 UA 标记两道一起过 —— 浏览器里随手开的工作台标签页不该
     *      有权把壳的窗口掀到最前或压到底下(矩形投毒案二审同款理由:URL 参数与 body 字段
     *      都改得了,UA 里那个标记是壳进程给自己 WKWebView 配的,网页伪造不了);
     *   3. `helper` 没接线 → 404「窗口编排壳未接入」。这条**不判 dock**:窗口模式跟窗位叠
     *      没关系(壳自己那扇窗的层级而已),没有窗位叠的部署照样该能把登录屏顶到前面。
     *
     * 业务失败(壳没连上 / 超时 / 壳回错)HTTP 层仍是 200、如实回 { ok:false, reason }
     * —— 先例 /snap、/debug/helper:那不是接口出错,是执行结果。
     */
    if (path === '/shell/window-mode' && req.method === 'POST') {
      if (!loopback) { sendJson(res, 403, { error: '只能在本机切换壳的窗口模式' }); return }
      if (helper === undefined) { sendJson(res, 404, { error: '窗口编排壳未接入' }); return }
      const text = await readBody(req)
      let body: unknown
      try { body = JSON.parse(text) } catch { sendJson(res, 400, { error: 'body 不是合法 JSON' }); return }
      const raw = (body ?? {}) as Record<string, unknown>
      if (raw.source !== 'app' || !isShellUserAgent(req)) {
        sendJson(res, 200, { ok: false, reason: '仅壳内页面可切换壳的窗口模式' })
        return
      }
      // 只认这两个字面量(同 /slot/rect 的 reason:不认识的值一律拒,不挑一个缺省值替人做主)。
      if (raw.mode !== 'front' && raw.mode !== 'desktop') {
        sendJson(res, 400, { error: "mode 只认 'front' 或 'desktop'" })
        return
      }
      const mode = raw.mode
      try {
        await helper.request({ op: 'window_mode', mode })
        sendJson(res, 200, { ok: true, mode })
      }
      catch (error) {
        sendJson(res, 200, { ok: false, reason: error instanceof Error ? error.message : String(error) })
      }
      return
    }

    /**
     * ax_probe 透传口(Chromium AX 修复,诊断专用):壳侧提供了一个能直接摆弄某个 bundle
     * 某条 AX 属性的调试接口,这里原样转发给壳——白名单只放 ax_probe 这一个 op,不能让
     * 这条口子变成任意 op 都能打的通用注入后门。跟 /slot/rect 用同一个"窗位叠是否启用"
     * 的开关(dock === undefined 判未接线):这条诊断口是窗位叠 + ax_stale 诊断环配套的
     * 排障工具,不是独立能力,helper 与 dock 在 index.ts 里总是配对接线,dock 有就
     * 意味着 helper 也有——这里一并判空只是给类型检查收窄,不是新增一条独立开关语义。
     * 业务失败(壳未连/未授权/报错)HTTP 层仍是 200、如实回 { ok:false, reason }——
     * 先例 /snap:那不是接口出错,是执行结果。
     */
    if (path === '/debug/helper' && req.method === 'POST') {
      if (!loopback) { sendJson(res, 403, { error: '只能在本机操作窗位叠' }); return }
      if (dock === undefined || helper === undefined) { sendJson(res, 404, { error: '窗位叠未启用' }); return }
      const text = await readBody(req)
      let body: unknown
      try { body = JSON.parse(text) } catch { sendJson(res, 400, { error: 'body 不是合法 JSON' }); return }
      const raw = (body ?? {}) as Record<string, unknown>
      if (raw.op !== 'ax_probe') {
        sendJson(res, 400, { error: 'op 只支持 ax_probe(白名单,这不是通用 op 注入口)' })
        return
      }
      try {
        // 安全修复(终审必修2):不能把整个 body(...raw)原样铺进 req——helperChannel 的
        // ws.send(JSON.stringify({ kind:'req', id, ...req }))里,信封字段 id/kind 是先赋值
        // 再被 ...req 铺开覆盖的,body 里混进的 "id":<在途请求号> 会把发出去的这条消息的
        // id 换成别人的在途请求号,壳侧一回 res 就会把这个 ax_probe 的结果错误 resolve 成
        // 别的请求(比如 set_window_frame)的结果。这里显式只挑 ax_probe 真正认识的四个
        // 字段,body 里其余任何键(包括 id/kind)一律不进入 req。
        const result = await helper.request({
          op: 'ax_probe',
          action: raw.action,
          ...(raw.bundle_id === undefined ? {} : { bundle_id: raw.bundle_id }),
          ...(raw.attr === undefined ? {} : { attr: raw.attr }),
          ...(raw.value === undefined ? {} : { value: raw.value }),
        } as HelperRequest)
        sendJson(res, 200, { ok: true, result })
      }
      catch (error) {
        sendJson(res, 200, { ok: false, reason: error instanceof Error ? error.message : String(error) })
      }
      return
    }

    /**
     * 「工作台开着时电脑不睡」(2026-09-28,卡 AW)。
     *
     * 维护者 09-28 早的现场:新 Air、不插电,电脑自己睡过去,手机上立刻写「找不到你的电脑」——
     * 而她只是没在用电脑而已。所以工作台在运行期间让**整台电脑**不因空闲睡眠
     * (屏幕照样会黑、会锁,合盖睡眠挡不住也不去挡);代价是不插电时更费电,
     * 所以给一颗开关,**默认开**。
     *
     *   GET  /shell/system-awake  → { enabled }(app.json 的 system_awake_while_running,缺席 = 开)
     *   POST /shell/system-awake  { enabled } → 落盘 + 告诉壳当场生效
     *
     * 只认回环(这动的是这台电脑睡不睡,手机拿着设备令牌也不该替她决定)。
     * 壳没接上 / 是旧壳不认这个 op → 落盘照样算数,但**如实说**要重开工作台才生效,
     * 不谎报当场生效(`applied: false` + 原话)。
     */
    if (path === '/shell/system-awake' && (req.method === 'GET' || req.method === 'POST')) {
      // 先判回环再判接没接线(同 /highlight、/shell/window-mode):这动的是本机这台电脑睡不睡,
      // 外面的人连"这台部署接没接工作台开关"都不该问出来。
      if (!loopback) { sendJson(res, 403, { error: '只能在本机改这个开关' }); return }
      if (appConfig === undefined) { sendJson(res, 404, { error: '工作台开关未启用' }); return }
      if (req.method === 'GET') {
        const config = await appConfig.get()
        sendJson(res, 200, { enabled: config.system_awake_while_running !== false })
        return
      }
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      if (typeof body.enabled !== 'boolean') { sendJson(res, 400, { error: 'enabled 必须是布尔值' }); return }
      const enabled = body.enabled
      await appConfig.set({ system_awake_while_running: enabled })
      if (helper === undefined) {
        sendJson(res, 200, { ok: true, enabled, applied: false, reason: '窗口编排壳未接入,重开工作台后生效' })
        return
      }
      try {
        await helper.request({ op: 'system_awake', enabled })
        sendJson(res, 200, { ok: true, enabled, applied: true })
      }
      catch (error) {
        sendJson(res, 200, { ok: true, enabled, applied: false, reason: error instanceof Error ? error.message : String(error) })
      }
      return
    }

    /**
     * ★ **「出门时电脑不睡」**(2026-10-03,卡「出门时电脑不睡」)。**缺省关**。
     *
     * 开着的时候:只要有一台**已配对手机经中转连着**(= 她出门了),壳就按住那条
     * 「别让显示器因为闲着而暗 / 睡」—— 不管工作台在不在最前面。为什么要这一颗:本机
     * `displaysleep 10` + `screenLock delay is immediate`,她离开 10 分钟屏幕就睡、一睡立刻锁,
     * 而锁屏时窗口型的家一扇窗都列不出来(`docs/交接-1003-锁屏时窗口型的家.md` 第四节)。
     * 代价是**她不在家时家里那块屏一直亮着**,所以缺省关、那句代价写在开关旁边。
     *
     *   GET  /shell/away-keep-awake  → `{ enabled, phone_away?, active? }`
     *        `phone_away` / `active` 缺席 = **不知道**(没接那一拍)—— 界面不许显示成「没出门」。
     *   POST /shell/away-keep-awake  `{ enabled }` → 落盘 + 当场重算并下发给壳
     *
     * 只认回环(同 `/shell/system-awake`:这动的是这台电脑的屏幕,手机拿着设备令牌也不该替她决定)。
     * 壳没接上 / 是旧壳不认 `away_awake` → 落盘照样算数,但**如实说**要重开工作台才生效。
     */
    if (path === '/shell/away-keep-awake' && (req.method === 'GET' || req.method === 'POST')) {
      if (!loopback) { sendJson(res, 403, { error: '只能在本机改这个开关' }); return }
      if (appConfig === undefined) { sendJson(res, 404, { error: '工作台开关未启用' }); return }
      if (req.method === 'GET') {
        const config = await appConfig.get()
        // 没接那一拍:只答得出那颗开关本身。**另外两格缺席 = 不知道**,不编一个 false。
        const view = options.awayAwake?.view()
        sendJson(res, 200, {
          enabled: config.away_keep_awake === true,
          ...(view === undefined ? {} : { ...(view.phone_away === undefined ? {} : { phone_away: view.phone_away }), active: view.active }),
        })
        return
      }
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      if (typeof body.enabled !== 'boolean') { sendJson(res, 400, { error: 'enabled 必须是布尔值' }); return }
      const enabled = body.enabled
      await appConfig.set({ away_keep_awake: enabled })
      if (options.awayAwake === undefined) {
        sendJson(res, 200, { ok: true, enabled, applied: false, reason: '出门那一拍未接线,重开工作台后生效' })
        return
      }
      const out = await options.awayAwake.apply()
      sendJson(res, 200, {
        ok: true,
        enabled,
        ...(out.view.phone_away === undefined ? {} : { phone_away: out.view.phone_away }),
        active: out.view.active,
        applied: out.applied,
        ...(out.reason === undefined ? {} : { reason: out.reason }),
      })
      return
    }


    /**
     * Agent 登记表(2026-09-25,卡 Q「Agent 自动发现与统一接入」)。
     *
     *   GET  /agents                  登记表 + 判过的每个 App(诊断)+ 今天判了几次、花了多少
     *   POST /agents/not-agent {id}   他说「这不是 Agent」:撤掉,以后不判、不读
     *   POST /agents/connect {id}     他说「接上」(拿不准的那一家答「要」,或者撤回一次「这不是 Agent」)
     *   POST /agents/read {id}        他看过了(没看过的回复、气泡收掉)
     *   POST /agents/notice/dismiss {id}  「新接上一家:XX」那一句收掉
     *
     * 本机与已配对的手机都能用(手机上也要能说「这不是 Agent」);自定义模块不行。
     */
    /**
     * 一家的 **logo**(2026-09-26,卡 LG;维护者:「把对应的 logo 也搞上;桌面端的应用标签,也加各家的 logo icon」)。
     *
     *   GET /agents/icon/<登记表条目 id>   → image/png(壳按 64pt@2x 渲的那一张)
     *
     * - **图片不进 `/state`**:一张十几 KB,九家一百多 KB,每秒一拍的快照塞不下。快照里只有
     *   `agent_registry.entries[].icon` 那一格真假,界面据此决定画这张图还是退回色点。
     * - 取不到(这台电脑上没装 / 渲不出 / 壳是旧版没有 `app_icon` / 还没取到)→ **404**;
     *   界面 `<img>` 的 onError 退回色点(现有样子),不出错、不空白。
     * - 带 ETag(内容变了才变)与 `Cache-Control`:图标很少变,壳与服务端一次运行内也各自缓存着;
     *   浏览器带 `If-None-Match` 回来就回 304,省一次十几 KB 的传输。
     * - **本机与已配对的手机都能用**:一张公开的 App 图标,只读、没有隐私。
     */
    /**
     * **图标清单**(2026-09-26,卡 LG3:手机客户端上也要显示各家的 logo)。
     *
     *   GET /agents/icons   → { icons: [{ id, etag, bytes }] }
     *
     * 为什么要这一条:手机不是浏览器里的一张 `<img>`,它取图要带设备令牌(`Authorization`),
     * 拿不到浏览器那套自动的 `If-None-Match` / 304。手机上存着上一次的那几张(本地缓存),
     * **先问一次这份清单**(一份 JSON,九家不到 1 KB),etag 没变的那几张**一个图片请求都不发**;
     * 变了的那几家才去 `GET /agents/icon/:id` 取一张。开 App 那一下从九次十几 KB 变成一次几百字节。
     *
     * `bytes` 只是给人 / 诊断看的大小,界面不用它。门与 `/agents/icon/:id` 同一道(本机或已配对的手机)。
     */
    if (req.method === 'GET' && path === '/agents/icons') {
      if (!(loopback || device !== undefined)) { sendJson(res, 403, { error: '只能在本机或已配对的手机上看登记表' }); return }
      if (agents === undefined) { sendJson(res, 404, { error: '登记表未启用' }); return }
      const icons: { id: string, etag: string, bytes: number }[] = []
      for (const entry of agents.view().entries) {
        const icon = agents.icon(entry.id)
        if (icon !== undefined) icons.push({ id: entry.id, etag: icon.etag, bytes: icon.png.length })
      }
      sendJson(res, 200, { icons })
      return
    }

    if (req.method === 'GET' && path.startsWith('/agents/icon/')) {
      if (!(loopback || device !== undefined)) { sendJson(res, 403, { error: '只能在本机或已配对的手机上看登记表' }); return }
      if (agents === undefined) { sendJson(res, 404, { error: '登记表未启用' }); return }
      let id = path.slice('/agents/icon/'.length)
      try { id = decodeURIComponent(id) }
      catch { /* 编码坏了就按原样找,反正找不到就是 404 */ }
      const icon = agents.icon(id)
      if (icon === undefined) { sendJson(res, 404, { error: '这一家还没有取到图标' }); return }
      sendIcon(req, res, icon)
      return
    }

    /**
     * 坞上**那一格**的图标(2026-09-26,卡 LG2;维护者 18:05 看着坞:「做事做一半,
     * 现在只有 Agent 有 logo,你看着怪不怪」)。
     *
     *   GET /apps/icon/<坞项的键>   → image/png
     *
     * 与上面那条 `/agents/icon/:id` 的分别:那条只认**登记表**里的家,所以微信、企业微信、
     * Notion、终端、Finder、Pen 这些判过了「不是 Agent」的一辈子也拿不到图。这一条认的是
     * **坞与窗位清单里登记过的键**(`appIcons.resolveDockApp`:基础键查 `APP_BUNDLES`、
     * 自定义应用查 apps.json),取图与缓存与那条**同一份**(`agents.appIcon`)。
     *
     * - 键→包的换算**只在服务端**:界面递过来的是一个登记过的键,不是一个随手写的包标识 ——
     *   不然这条接口就成了「把这台电脑上任意一个 App 的图标念给我听」,连已配对的手机也能问。
     * - 认不出这一格 / 这台电脑上没装 / 壳是旧版或没接上 → **404 + 一句人话**,界面画中性小方块。
     * - ETag / `Cache-Control` / 304 与 `/agents/icon` 同一套(`sendIcon`)。
     * - 本机与已配对的手机都能用:一张公开的 App 图标,只读、没有隐私。
     */
    if (req.method === 'GET' && path.startsWith('/apps/icon/')) {
      if (!(loopback || device !== undefined)) { sendJson(res, 403, { error: '只能在本机或已配对的手机上看坞上的图标' }); return }
      if (registry === undefined) { sendJson(res, 404, { error: '窗口编排未启用' }); return }
      let key = path.slice('/apps/icon/'.length)
      try { key = decodeURIComponent(key) }
      catch { /* 编码坏了就按原样找,反正认不出就是 404 */ }
      const target = await resolveDockApp(key, registry)
      if (target === undefined) { sendJson(res, 404, { error: `认不出这一格是哪个应用:${key}` }); return }
      if (agents === undefined) { sendJson(res, 404, { error: '取图标那条路没接上(登记表未启用)' }); return }
      const icon = await agents.appIcon(target.bundle_id)
      if (icon === undefined) { sendJson(res, 404, { error: `没取到 ${target.key} 的图标(这台电脑上没装,或者工作台 App 还是旧版)` }); return }
      sendIcon(req, res, icon)
      return
    }

    // 只认这几条(卡 O 另有 /agents/quota、/agents/caps……,不在这里拦)。
    if ((path === '/agents' && req.method === 'GET')
      || (req.method === 'POST' && ['/agents/not-agent', '/agents/connect', '/agents/read', '/agents/notice/dismiss'].includes(path))) {
      if (!(loopback || device !== undefined)) { sendJson(res, 403, { error: '只能在本机或已配对的手机上看登记表' }); return }
      if (agents === undefined) { sendJson(res, 404, { error: '登记表未启用' }); return }
      if (path === '/agents') { sendJson(res, 200, agents.detail()); return }
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      const id = typeof body.id === 'string' ? body.id.trim() : ''
      if (id === '') { sendJson(res, 400, { error: '要带 id(登记表里那一家)' }); return }
      if (path === '/agents/not-agent') {
        const result = await agents.notAgent(id)
        sendJson(res, result.ok ? 200 : 409, result)
        return
      }
      if (path === '/agents/connect') {
        const result = await agents.connect(id)
        sendJson(res, result.ok ? 200 : 409, result)
        return
      }
      if (path === '/agents/read') { sendJson(res, 200, { ok: true, changed: await agents.markRead(id) }); return }
      // 只剩 /agents/notice/dismiss(上面那道门只放这四条)。
      const ok = await agents.dismissNotice(id)
      sendJson(res, ok ? 200 : 404, ok ? { ok } : { ok, error: '没有这一条' })
      return
    }

    /**
     * 工人报「现在在不在通话」(2026-09-25,卡 Q):同通话护栏的 `inCall` 口径。登记表的巡检据此在通话中暂停。
     * **只认回环**(同 /channel/devices):手机不能替工人说「挂了」。
     */
    if (path === '/channel/call-state' && req.method === 'POST') {
      if (!loopback) { sendJson(res, 403, { error: '只有本机的工人能报通话状态' }); return }
      if (callState === undefined) { sendJson(res, 404, { error: '通话状态未启用' }); return }
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      if (typeof body.in_call !== 'boolean') { sendJson(res, 400, { error: 'in_call 要是 true / false' }); return }
      // 两条工人各报各的(卡 M6):一条刚起报「不在」,不盖掉另一条正在打的那通。
      callState.report(body.in_call, ...(CHANNEL_ROUTES.includes(body.route as ChannelRoute) ? [body.route as string] : []))
      sendJson(res, 200, { ok: true, ...callState.view() })
      return
    }

    if (path === '/dock/switch' && req.method === 'POST') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机操作窗位叠' }); return }
      if (dock === undefined) { sendJson(res, 404, { error: '窗位叠未启用' }); return }
      const text = await readBody(req)
      let body: unknown
      try { body = JSON.parse(text) } catch { sendJson(res, 400, { error: 'body 不是合法 JSON' }); return }
      const raw = (body ?? {}) as Record<string, unknown>
      if (typeof raw.app !== 'string' || raw.app === '') { sendJson(res, 400, { error: 'app 必须是非空字符串' }); return }
      const result = await withActorNoteFor(req, 'dock.switch', () => dock.switchTo(raw.app as string))
      broadcast({ kind: 'snapshot', state: await composeState() })
      sendJson(res, 200, result)
      return
    }

    /**
     * 派活第一段:**把一段话送进那家客户端的输入框**(2026-09-21)。
     *
     * ★ **2026-09-23 改成 `trusted`**(Ben 拍板「同一个事务官」,见 `trusted` 那段注释)。
     * 这一条**推翻了 09-21 写在这里的那段理由**(原话是「在手机上点一下就让 Ben 的 Mac 激活一扇窗、
     * 往里打一行字,是这类功能最吓人的行为」)。推翻的依据是 Ben 的原话:
     * 「不是两个人,更不是两个权限不同的人」——**派活是事务官的核心活**(审视第二节 A 档),
     * 她在手机上按「派给 Codex」和在电脑前按,是同一个人的同一个动作。
     * 手机上说「让 Claude 看看 X」仍然走事务官那条路;这一条是给**界面上那颗按钮**用的。
     *
     * `submit` **缺省 false**:送进框里和按下回车是两件事,后者会用他的账号真跑一次会话。
     *
     * 2026-09-22 Ben 定了 A2:**事务官主动派的替他按,他自己在界面上点的不按**。
     * 落法是加一格 `source`(`item` / `call` / `inbox` / `ui`),由 `submitForSource` 算出 `submit`
     * —— `submit` 的语义与壳那条原语**一个字没动**,明着传的 `submit` 照旧压过来源。
     * 认不出的来源当场 400:传错名字的那一方要立刻知道,不能悄悄按成"不按"。
     */
    if (path === '/dispatch/client' && req.method === 'POST') {
      if (!trusted) { sendJson(res, 403, { error: '只有这台电脑或配对过的设备能把话送进客户端窗口' }); return }
      if (clientDispatch === undefined) { sendJson(res, 404, { error: '窗口编排壳未接入,送不了话' }); return }
      const text = await readBody(req)
      let body: unknown
      try { body = JSON.parse(text) } catch { sendJson(res, 400, { error: 'body 不是合法 JSON' }); return }
      const raw = (body ?? {}) as Record<string, unknown>
      const family = typeof raw.app === 'string' ? raw.app : ''
      if (family === '') { sendJson(res, 400, { error: 'app 必须是非空字符串' }); return }
      if (typeof raw.text !== 'string' || raw.text.trim() === '') {
        sendJson(res, 400, { error: 'text 必须是非空字符串' }); return
      }
      const source = clientDispatchSource(raw.source)
      if (raw.source !== undefined && source === undefined) {
        sendJson(res, 400, { error: `不认识的来源:${String(raw.source)}(要 ${CLIENT_DISPATCH_SOURCES.join(' / ')} 之一)` })
        return
      }
      const itemId = typeof raw.item_id === 'string' && raw.item_id !== '' ? raw.item_id : undefined
      /**
       * 统一输入框的模式(2026-09-24)。「只出方案」那件一律不派;明着选过档的那件,
       * 回车按不按由档定(先问我 = 不按,自动办 = 按)。卡上没记档的(老卡)照旧按来源。
       */
      const itemMode = await itemModeOf(itemId)
      if (itemMode === 'plan') { sendJson(res, 409, { error: PLAN_ONLY_DISPATCH_ERROR }); return }
      /**
       * 附规矩(2026-09-24 晚,卡 K):送进那家窗口的话末尾贴「这件活要守的规矩」,做界面的活带界面那几条。
       * **由工作台贴,不靠事务官记得**;同一段已经附过就不再附(withDispatchRules)。
       */
      const ruleWork = [await ruleTaskText(itemId), raw.text as string].join('\n')
      const ruleBlock = rules?.brief('dispatch', ruleWork)
      /*
       * ★ **这一下过闸了**(2026-10-02;审计第二表第 13 条:同一个 `DC.send`,派活那条带 `job` 过闸,
       * 这一条不带 —— 于是她把卡收了之后,从这个口还送得进去)。带上事项 id 之后闸就查得到卡的状态;
       * 没有事项(界面上点「送进窗口」那一种)时引擎用这一送自己的 id 当键,`jobPhaseOf` 答「查不出」→
       * 照旧放行,但次数照算。
       */
      const resend = itemId === undefined || tasks === undefined
        ? false
        : (await tasks.list()).tasks.find(one => one.id === itemId)?.client_dispatch?.family === family
      const sent = await withActorNoteFor(req, 'dispatch.client', () => clientDispatch.send({
        family,
        ...(itemId === undefined ? {} : { job: itemId }),
        // 卡上有上一次派给这一家 = 这是重派(闸里另有一档:2 回、隔一分钟)。判据是**证据**,不是话里有没有这个词。
        ...(resend ? { resend: true } : {}),
        text: withDispatchRules(raw.text as string, ruleBlock?.text),
        // 明着传的说了算;没传就按档,再按来源(事务官主动派的按回车,界面手点的不按)。
        submit: typeof raw.submit === 'boolean' ? raw.submit : itemMode !== undefined ? submitForMode(itemMode) : submitForSource(source),
        restoreFront: raw.restore_front === true,
        // 2026-09-24(卡 F):先开新对话再送。缺省不开(老调用方一字不变);派活请走 /dispatch/run。
        newConversation: raw.new_conversation === true,
      }))
      // 记到卡上:送成了记「已送出」,没送成也记 —— **不假装成功**,卡上要看得见那句原因。
      if (itemId !== undefined && tasks !== undefined && sent.dispatch !== undefined) {
        await tasks.update(itemId, { clientDispatch: sent.dispatch })
      }
      // 派出去了:这件活上次自查没过的那一笔清掉(重新交活了),记一条「派出去了」给试用的规矩验效果用。
      if (sent.ok && itemId !== undefined && rules !== undefined) {
        await rules.clearReview(itemId)
        await rules.feedback({ kind: 'run', where: itemId, area: ruleWorkArea(ruleWork), channel: 'butler' }).catch(() => undefined)
      }
      /*
       * ★ **派活这一下从前一行都不记**(2026-10-01,卡 AX3)。真机上「豆包只剩菜单栏图标」那一次
       * (Air 诊断包 095718)查不出是不是「窗没露出来」、我们又开了几回窗、最后换没换包 —— 现在记一行。
       * **她那句交代一个字不记**(卡 BR 那条没松):只记哪一家、成没成、怎么开到前台的。
       */
      broadcast({ kind: 'snapshot', state: await composeState() })
      sendJson(res, 200, {
        ...(ruleBlock === undefined || ruleBlock.ids.length === 0 ? {} : { rules: ruleBlock.ids }),
        ok: sent.ok,
        ...(sent.reason === undefined ? {} : { reason: sent.reason }),
        ...(sent.kind === undefined ? {} : { kind: sent.kind }),
        ...(sent.front_note === undefined ? {} : { front_note: sent.front_note }),
        ...(sent.dispatch === undefined ? {} : { dispatch: sent.dispatch }),
        ...(sent.ok && sent.dispatch !== undefined
          ? { note: `已送到 ${CLIENT_DISPATCH_TITLES[sent.dispatch.family]} 窗口` }
          : {}),
      })
      return
    }

    /**
     * 派活的第二只手:**把这件事经中转发给 GPT / 豆包**(2026-09-22)。
     *
     * 门与 `/dispatch/client` 逐字相同:★ **2026-09-23 一起改成 `trusted`**
     * (Ben 拍板「同一个事务官」,见 `trusted` 那段注释)。09-22 写在这里的理由
     * (「在手机上点一下就花掉他今天的模型额度」)**一并推翻** —— 额度是她的额度,
     * 她在哪台设备上决定花都是她在决定花;真要拦的是"花多少",那是配额的事不是端口的事。
     *
     * 与那一条的两点不同,都是这只手的性质决定的:
     * 1. **它同步等结果**(几秒到几分钟),所以回包里直接带着回答 —— 窗口那只手只负责送进去;
     * 2. **它不碰文件**,所以 `cwd` 可缺席(没挂项目的活也派得出去,见 protocol 的 TaskDispatch.cwd)。
     *
     * 记到卡上的是同一种记录(`TaskDispatch`,`hand:'api'`)、同一块小标、
     * 失败进同一个收件箱 —— 三只手在卡面上长得一样,区别只在小标里那三个字。
     */
    if (path === '/dispatch/api' && req.method === 'POST') {
      if (!trusted) { sendJson(res, 403, { error: '只有这台电脑或配对过的设备能把事情发给接口那两家' }); return }
      if (apiDispatch === undefined) { sendJson(res, 404, { error: '模型服务未接入,发不出去' }); return }
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      const family = apiDispatchFamilyOf(body.app ?? body.family)
      if (family === undefined) {
        sendJson(res, 400, { error: `app 要是 ${API_DISPATCH_FAMILIES.join(' / ')} 里的一个(别家走命令行或窗口那两只手)` })
        return
      }
      const text = typeof body.text === 'string' ? body.text.trim() : ''
      if (text === '') { sendJson(res, 400, { error: 'text 必须是非空字符串' }); return }
      const itemId = typeof body.item_id === 'string' && body.item_id !== '' ? body.item_id : undefined
      if (await itemModeOf(itemId) === 'plan') { sendJson(res, 409, { error: PLAN_ONLY_DISPATCH_ERROR }); return }

      /**
       * 项目上下文摘要。**现查现拼,不落第二份**:事项挂了哪个项目在卡上,
       * 项目叫什么、在哪在 projects 那一份快照里。查不到就整块缺席 ——
       * 没挂项目的活(「写条小红书文案」)本来就没有上下文,编一个出来正是 D13 说的编。
       */
      let context: { project?: string, cwd?: string, note?: string } | undefined
      if (itemId !== undefined && tasks !== undefined) {
        const task = (await tasks.list()).tasks.find(one => one.id === itemId)
        const projectId = task?.project_id
        if (projectId !== undefined && projects !== undefined) {
          let found
          try { found = (await projects.getProjectsState()).projects.find(one => one.id === projectId) }
          catch { found = undefined }
          if (found !== undefined) {
            context = {
              project: found.name,
              ...(found.path === undefined ? {} : { cwd: found.path }),
              ...(found.status?.text === undefined ? {} : { note: found.status.text }),
            }
          }
        }
      }

      /**
       * 目录门(与命令行那只手同一道)。接口这条路**不碰文件**,所以这道门在这里
       * 不是为了拦住"在错的仓库里改东西",而是为了**不把授权范围外的目录名发到上游去** ——
       * 路径本身也是信息。不在范围内就把 cwd 摘掉,活照派(它不需要目录也做得了)。
       */
      if (context?.cwd !== undefined) {
        const roots = (await dispatchRoots()).map(root => root.path)
        if (roots.length > 0 && !dispatchCwdAllowed(context.cwd, roots)) {
          const { cwd: _dropped, ...rest } = context
          context = rest
        }
      }

      // 附规矩(2026-09-24 晚,卡 K):同 /dispatch/client 那一处。
      const ruleWork = [await ruleTaskText(itemId), text].join('\n')
      const ruleBlock = rules?.brief('dispatch', ruleWork)
      const sent = await withActorNoteFor(req, 'dispatch.api', () => apiDispatch.send({
        family,
        text: withDispatchRules(text, ruleBlock?.text),
        ...(context === undefined ? {} : { context }),
        ...(typeof body.model === 'string' && body.model !== '' ? { model: body.model } : {}),
      }))
      // 记到卡上:成了记「完成」,没成也记 —— **不假装成功**,卡上要看得见那句原因。
      if (itemId !== undefined && tasks !== undefined) {
        await tasks.update(itemId, { dispatch: sent.dispatch })
      }
      /**
       * 接口这只手**同步拿回结果**:派出去就记一条「派出去了」,拿回来就按规矩自查一遍(卡 K)。
       * 没过:回包里带 review 与打回原话,事务官照发给那家;这件活不进「等我确认」(butlerLifecycle 的 heldBack)。
       */
      let ruleReview: ButlerRuleReviewView | undefined
      if (sent.ok && itemId !== undefined && rules !== undefined) {
        await rules.clearReview(itemId)
        await rules.feedback({ kind: 'run', where: itemId, area: ruleWorkArea(ruleWork), channel: 'butler' }).catch(() => undefined)
        if (typeof sent.reply === 'string' && sent.reply !== '') {
          ruleReview = await rules.review({
            itemId, text: sent.reply, taskText: ruleWork, family: targetTitle(dispatchTargetsNow(), family),
            ...(ruleBlock?.text === undefined ? {} : { instruction: ruleBlock.text }),
          })
        }
      }
      broadcast({ kind: 'snapshot', state: await composeState() })
      sendJson(res, 200, {
        ...(ruleBlock === undefined || ruleBlock.ids.length === 0 ? {} : { rules: ruleBlock.ids }),
        ...(ruleReview === undefined ? {} : { review: ruleReview }),
        ok: sent.ok,
        dispatch: sent.dispatch,
        // 卡面那句话由服务端统一生成(三只手同一个 dispatchNote),事务官照着念。
        note: dispatchNote(sent.dispatch),
        ...(sent.reply === undefined ? {} : { reply: sent.reply }),
        ...(sent.reason === undefined ? {} : { reason: sent.reason }),
        ...(sent.kind === undefined ? {} : { kind: sent.kind }),
        ...(sent.tokens === undefined ? {} : { tokens: sent.tokens }),
      })
      return
    }

    /**
     * POST /dispatch/run { item_id, app, text?, source?, kind?, skills? }(2026-09-24,卡 F;`skills` 2026-10-21 卡 S)
     *
     * **派活的唯一入口**:对一张已经建好的卡,由工作台自己把活派给那一家、盯着、把结果收回来、
     * 挪「等我确认」(`server/dispatchRun.ts`)。事务官(DSH 会话)自己要派的时候调这一条,
     * 卡 B 的落地走同一个函数(进程内的 `dispatchItem`)。
     *
     * `text` 缺席就用卡上的原话(描述优先,没有就标题)。回包里的 `note` 是给人念的那一句。
     * 门与 `/dispatch/client` 相同(`trusted`:本机或配对过的设备,「同一个事务官」)。
     */
    /*
     * ★ **重置这一家**(2026-10-21,卡「派活按家隔离」;`familyReset.ts`):清闸计数、撤在等的读(插件 + 壳)、
     * 重开那扇窗、清卡上「通道堵了」—— 不重启插件,别家一点不动。门与派活同一道(这台电脑 / 配对过的设备)。
     */
    if (path === '/dispatch/family/reset' && req.method === 'POST') {
      if (!trusted) { sendJson(res, 403, { error: '只有这台电脑或配对过的设备能重置派活通道' }); return }
      if (tasks === undefined) { sendJson(res, 404, { error: '任务看板未启用' }); return }
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      const family = typeof body.family === 'string' ? body.family.trim() : ''
      if (family === '' || !isAgentDispatchFamily(family)) { sendJson(res, 400, { error: '要带 family(要重置的那一家)' }); return }
      const titles = dispatchTargetsNow()
      const result = await withActorNoteFor(req, 'dispatch.family.reset', () => resetFamily({
        ...(options.familyLanes === undefined ? {} : { lanes: options.familyLanes }),
        ...(options.actionGate === undefined ? {} : { gate: options.actionGate }),
        ...(options.jobLog === undefined ? {} : { jobLog: options.jobLog }),
        name: one => targetTitle(titles, one),
        now: () => new Date(),
        packagesOf: (one) => {
          const binding = FAMILY_SOURCES.find(source => source.agent === one)
          if (binding !== undefined) return packagesOf(binding).map(pkg => pkg.bundle_id)
          const bundle = options.engineRegistry?.packageFor(one)?.bundle_id
          return bundle === undefined ? (one.includes('.') ? [one] : []) : [bundle]
        },
        ...(helper === undefined ? {} : {
          helper: {
            supports: cap => helper.supports?.(cap) === true,
            request: async (one, timeoutMs) => await helper.request(one, timeoutMs),
          },
        }),
        ...(options.reopenApp === undefined ? {} : { openApp: options.reopenApp }),
        tasks: { list: async () => await tasks.list(), update: async (id, patch) => await tasks.update(id, patch) },
        behavior: input => noteBehavior(input),
      }, family))
      broadcast({ kind: 'snapshot', state: await composeState() })
      sendJson(res, 200, result)
      return
    }

    if (path === '/dispatch/run' && req.method === 'POST') {
      if (!trusted) { sendJson(res, 403, { error: '只有这台电脑或配对过的设备能派活' }); return }
      if (tasks === undefined || dispatchRunner === undefined) { sendJson(res, 404, { error: '任务看板未启用' }); return }
      const denied = await agentWriteDenied(req, device)
      if (denied !== undefined) { sendJson(res, 403, { error: denied }); return }
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      const itemId = typeof body.item_id === 'string' ? body.item_id.trim() : ''
      if (itemId === '') { sendJson(res, 400, { error: 'item_id 必须是非空字符串' }); return }
      const family = typeof body.app === 'string' ? body.app.trim().toLowerCase() : ''
      /*
       * ★ 2026-09-25(卡 Z):把关**按 Agent 登记表**(`dispatchTargetsNow`),不再按写死的名单。
       * 名字打错了当场知道,而且报得出这台电脑上到底认得哪几家(那几家就是登记表里接上了的)。
       */
      const runTargets = dispatchTargetsNow()
      if (!isAgentDispatchFamily(family) || !isDispatchTarget(runTargets, family)) {
        sendJson(res, 400, { error: `app 要是这台电脑上接上了的那几家里的一个:${runTargets.map(one => one.id).join(' / ')}` })
        return
      }
      const source = clientDispatchSource(body.source)
      if (body.source !== undefined && source === undefined) {
        sendJson(res, 400, { error: `不认识的来源:${String(body.source)}(要 ${CLIENT_DISPATCH_SOURCES.join(' / ')} 之一)` })
        return
      }
      const task = (await tasks.list()).tasks.find(one => one.id === itemId)
      if (task === undefined) { sendJson(res, 404, { error: '没有这个事项' }); return }
      if (task.mode === 'plan') { sendJson(res, 409, { error: PLAN_ONLY_DISPATCH_ERROR }); return }
      /**
       * ★ **派活那一处的门**(2026-10-21 协作区,`noteGate.ts`):**事务官**派活之前便签上要写清「做到什么算完」——
       * 那是项目经理的活(维护者 10-21:「事务官首先是派活就派不明白」)。她自己点「派给 X」、电话里点名
       * 不挡:那是她明说的交代;认不出来的程序本来就过不了上面那道「显示状态写入」的门。
       */
      if (asker === 'butler') {
        const gate = dispatchGate(task)
        if (gate !== undefined) { sendJson(res, 409, { error: gate }); return }
      }
      const text = typeof body.text === 'string' && body.text.trim() !== '' ? body.text.trim() : (task.desc ?? task.title)
      // 这是什么活(卡 O):明说 `kind:'code'|'chat'` 的照它;不说按字认。
      if (body.kind !== undefined && !isJobKind(body.kind)) { sendJson(res, 400, { error: 'kind 要是 code(写代码 / 改文件)、chat(聊天 / 问答)或 desk(要在你电脑上动手)' }); return }
      /*
       * 带哪几件技能(2026-10-21,卡 S):可选。带了就只派给读得了技能目录的那几家、按「改文件」那一类走;
       * 窗口与接口那几家当场 400,不静默丢掉技能照派。不带 = 一字不变。
       * 2026-10-22(卡「用户层技能生效」B):技能库 = 本体 ∪ 用户层,校验时把用户层那份名单也递进去。
       */
      const skillsChecked = checkSkillNames(body.skills, body.skills === undefined ? undefined : (await userLayerSkillsNow()).map(one => one.id))
      if (!skillsChecked.ok) { sendJson(res, 400, { error: skillsChecked.error }); return }
      const skills = skillsChecked.skills
      if (skills.length > 0 && !canReadSkills(family)) { sendJson(res, 400, { error: skillsUnreadableWhy(targetTitle(runTargets, family)) }); return }
      if (skills.length > 0 && body.kind !== undefined && body.kind !== 'code') { sendJson(res, 400, { error: '带技能的活按「改文件」那一类派:kind 要是 code 或不传' }); return }
      const kind = skills.length > 0 ? 'code' : isJobKind(body.kind) ? body.kind : undefined
      /*
       * ★ 2026-10-27(卡 t-bd1c04ed 第一批):实验门按**最终执行通道**判,不按 family 判 ——
       * 门在手与活种算出之后:Kimi 写代码的活走命令行(`dispatchUsesWindowHand` 回 false),
       * 不该吃 window_dispatch 的 409;会真走窗口的那一派(kind 缺席 / 聊天 / 桌面活)照旧拦。
       */
      if (windowDispatchExperiment(family) && await experimentOff('window_dispatch')
        && dispatchUsesWindowHand({ family, ...(kind === undefined ? {} : { kind }), target: runTargets.find(one => one.id === family) })) {
        sendJson(res, 409, { error: EXPERIMENT_OFF_LINE, experiment_off: 'window_dispatch' })
        return
      }
      // 行为账(卡「行为账」):派之前先记下原来在谁手上、事务官这会儿推荐谁 —— 派完那张卡就变了。只在是她按的时候算。
      const before = task.dispatch?.family ?? task.client_dispatch?.family
      const picked = behaviorEnd === undefined ? undefined : await choicesAndClass(itemId, { ...(kind === undefined ? {} : { kind }), ...(skills.length === 0 ? {} : { skills }) }).catch(() => undefined)
      const recommended = picked?.view.default
      // 她亲手再派一次(卡上已经派过):这件事的闸次数从头数(2026-10-21;从前 `forget` 没人调,到顶了只能重启)。
      if (before !== undefined) options.actionGate?.forget(itemId)
      // ★ 接管只许她本人从界面点(卡「事务官机制D」缺口3):asker 是页面/已配对手机才带 takeover;
      // 事务官与一切自动/排队/恢复路不带,永不把「不确定」当放行。
      const humanTakeover = body.takeover === true && (asker === 'page' || asker === 'device')
      const started = await withActorNoteFor(req, 'dispatch.run', () => dispatchItem(itemId, { family, text, ...(source === undefined ? {} : { source }), ...(kind === undefined ? {} : { kind }), ...(skills.length === 0 ? {} : { skills }), ...(humanTakeover ? { takeover: true } : {}) }))
      noteBehavior({
        事: before !== undefined && before !== family ? BEHAVIOR_EVENTS.redispatch : BEHAVIOR_EVENTS.dispatch,
        对象: `${itemId} ${task.title}`,
        结果: started.ok ? family : `${family}(没派成)`,
        ...(recommended === undefined ? {} : { 推荐: recommended }),
        ...(picked === undefined ? {} : { 类: picked.klass }),
      })
      broadcast({ kind: 'snapshot', state: await composeState() })
      sendJson(res, 200, {
        ok: started.ok,
        ...(started.hand === undefined ? {} : { hand: started.hand }),
        note: started.note,
        ...(started.block === undefined ? {} : { block: started.block }),
      })
      return
    }

    /**
     * 派活的眼睛(2026-09-25,卡 O)。
     *
     *   GET  /agents/caps                 六家各三格(能聊天 / 能改本机文件 / 能把结果收回来),与 /state.agent_caps 同一份
     *   POST /agents/caps/check {window?} 现查一遍(命令行登没登;window:true 连窗口一起看 —— 只找输入框、不送字、不抢焦点)
     *   POST /agents/login {family}       「登录 X」:开一扇终端窗口跑那家自己的登录命令(账号密码工作台不经手)。**只认回环**
     *
     * 「把那家叫到台前」那一条口 2026-09-30 整条删了(维护者拍板,见 `docs/决策记录.md` 末尾那一条):
     * 该他自己去点的那一步,如实写成一句话摆在那一格里,不替他动别家的窗。
     *   GET  /dispatch/choices?item=&kind=&text=&skills=   这件活派给谁的选项表(是什么活、按规矩默认谁、各家还剩多少;带技能只列读得了的)
     *   GET|POST /butler/budget {cny, minutes}     每件事的上限(设置里改)
     *   POST /butler/item/stop {id}                外层「停掉这一件」
     *   POST /butler/item/budget {id, choice}      到上限了他说:continue / stop / switch
     *   POST /butler/item/stuck {id, text}         ★ 事务官报「我卡在哪」(2026-10-04)
     *
     * ★ `/butler/item/stuck` 是**事务官往里报**的那一条(不是她点的):它在干活途中随时报一句
     * 「我在找 X,试了 A、B,还差 C」,到上限先停下来时工作台把这一句原样放进问她那一问里
     * (手机 / 电话 / 电脑三处同一句)。它没报就照实说「它没说卡在哪」,**不编**。
     * 门与上面两条同一道(A11 那道门认得出事务官那把进程令牌)。
     *
     * 「事务官自己做」那一支(`POST /butler/item/self`)2026-09-28 拿掉了(卡 BS2,设计 C1):
     * 事务官不干活,三选一只剩 continue / stop / switch。
     */
    if (path === '/agents/caps' && req.method === 'GET') {
      if (agentCaps === undefined) { sendJson(res, 404, { error: '这台工作台没接能力体检' }); return }
      sendJson(res, 200, agentCaps.view())
      return
    }
    if (path === '/agents/caps/check' && req.method === 'POST') {
      if (!trusted) { sendJson(res, 403, { error: '只有这台电脑或配对过的设备能体检' }); return }
      if (agentCaps === undefined) { sendJson(res, 404, { error: '这台工作台没接能力体检' }); return }
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      const families = Array.isArray(body.families) ? body.families.filter(isCapFamily) : undefined
      const view = await agentCaps.check({ window: body.window === true, ...(families === undefined || families.length === 0 ? {} : { families }) })
      // 连窗口一起看时,顺手把窗口上的额度也读一遍(Manus 的积分、Muse 的用量;只读命中的那一小段)。
      // 开集那几家也顺手读一遍,但**走省钱那条**(认出来过的只带上次那几条正则、不叫模型)——
      // 体检这颗键他会连点几下,不该每一下都是钱;要重判就点那一家的「读一下」(卡 QO)。
      if (body.window === true) {
        await windowQuota?.refresh().catch(() => {})
        await windowQuota?.refreshOpen(openFamiliesNow()).catch(() => {})
      }
      broadcast({ kind: 'snapshot', state: await composeState() })
      sendJson(res, 200, view)
      return
    }
    /**
     *   GET  /agents/quota          能接活的每一家的额度(三格之一:有数 / 不限 / 没接上:原因),与 /state.agent_quota 同一份
     *   POST /agents/quota/check    现读一遍窗口上的那几家(只读命中的那一小段、不激活、不动焦点)
     *                               `{ family }` = 只读这一家(界面上那一格的「读一下」就是这么点的);缺席 = 全读。
     *
     * 这就是**「读一下」那颗键**(2026-09-26,卡 QO)。对开集那几家它走**全套**:八条通用正则都带上,
     * 判词变了就再叫一次模型 —— 他刚打开了一页新的用量页,点这一下才该重判。
     */
    if (path === '/agents/quota' && req.method === 'GET') {
      if (agentCaps === undefined) { sendJson(res, 404, { error: '这台工作台没接额度适配器' }); return }
      sendJson(res, 200, { agents: agentQuotaNow(service.getState().quota) })
      return
    }
    if (path === '/agents/quota/check' && req.method === 'POST') {
      if (!trusted) { sendJson(res, 403, { error: '只有这台电脑或配对过的设备能查' }); return }
      if (agentCaps === undefined) { sendJson(res, 404, { error: '这台工作台没接额度适配器' }); return }
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      // 点的是哪一格就读哪一家(名字对不上就全读,与老宿主那一下一字不变)。
      const only = typeof body.family === 'string' && body.family !== '' ? body.family : undefined
      const open = openFamiliesNow().filter(one => only === undefined || one.id === only)
      /*
       * 她点的「读一下」:**可以按键替她走到额度那一页**(只这一下)。
       *
       * 2026-10-03(卡 QZ)这里原来给的是 `unhide`(「只有她点这一下才放出藏着的家」,09-27 那条拍板)——
       * 放出来已经改成**一律放**(自动那一轮也放,否则格子永远停在 09-26),所以这一格换成了 `press`:
       * 今天壳按一颗键要把那家**叫到台前**,那才是真会打扰她的一下,只许她亲手点的时候走。
       */
      await windowQuota?.refresh(only === undefined ? undefined : [only], { press: only !== undefined }).catch(() => {})
      // `byHand`(2026-10-19):她点的是哪一格,那一家没在跑才许起它;全读那一下与自动那几路一样,只读在跑的。
      await windowQuota?.refreshOpen(open, { full: true, byHand: only !== undefined }).catch(() => {})
      broadcast({ kind: 'snapshot', state: await composeState() })
      const agents = agentQuotaNow(service.getState().quota)
      // 那颗键底下说的那一句(2026-09-26,卡 MQ3):**照这一格此刻的话说真话**,
      // 不再让界面写死一句「读过了,这一格会跟着变」—— 读没读到、读到的是什么,这里都知道。
      // 「读到了」只认**这一轮真读着了**(读数器那一笔 `attempt.found`):卡 QS 起读不到的时候
      // 上次那个数照摆着,拿「那一格有数」当读到了就又是一句假话。
      const found = only === undefined
        ? false
        : (windowQuota?.readings()[only]?.attempt?.found === true
          || windowQuota?.openReadings()[only]?.attempt?.found === true)
      const note = only === undefined ? undefined : quotaCheckSaid(agents.find(one => one.id === only), found)
      sendJson(res, 200, { agents, ...(note === undefined ? {} : { note }) })
      return
    }
    if (path === '/agents/login' && req.method === 'POST') {
      if (loginLauncher === undefined || agentCaps === undefined) { sendJson(res, 404, { error: '这台工作台没接「登录」那颗键' }); return }
      // 它在这台电脑上开一扇窗口:只有坐在这台电脑前的人点得了(手机上只说一句「要在电脑前登录一次」)。
      if (!loopback) { sendJson(res, 403, { error: '登录要在这台电脑前做:会开一个窗口跑它自己的登录页' }); return }
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      const family = body.family
      // 「登录 X」那扇窗口只有 Claude / Codex 两家有(2026-10-22 卡 C:Kimi 没有只本地的登录命令,不跑猜的)。
      if (typeof family !== 'string' || family !== 'claude' && family !== 'codex') { sendJson(res, 400, { error: 'family 要是 claude 或 codex(只有这两家有「登录」那颗键)' }); return }
      const opened = await loginLauncher(family)
      if (opened.ok) agentCaps.waitLogin(family)
      broadcast({ kind: 'snapshot', state: await composeState() })
      sendJson(res, opened.ok ? 200 : 500, { ok: opened.ok, note: opened.note })
      return
    }
    /**
     * 派活技能库的两组(2026-10-22,卡「用户层技能生效」B):本体随版本那几件 + 用户层「技能」格里那几件。
     * 设置 → 协作区 →「Agent 名片」的勾选列表用它分「本体 / 我的」两组显示。
     */
    if (path === '/dispatch/skills' && req.method === 'GET') {
      if (!trusted) { sendJson(res, 403, { error: '只有这台电脑或配对过的设备能看' }); return }
      const mine = (await userLayerSkillsNow()).map(one => ({ id: one.id, name: one.name, ...(one.description === undefined ? {} : { description: one.description }) }))
      const view: DispatchSkillLibraryView = { builtin: [...DISPATCH_SKILLS], mine }
      sendJson(res, 200, view)
      return
    }
    if (path === '/dispatch/choices' && (req.method === 'GET' || req.method === 'POST')) {
      if (!trusted) { sendJson(res, 403, { error: '只有这台电脑或配对过的设备能看' }); return }
      if (tasks === undefined) { sendJson(res, 404, { error: '任务看板未启用' }); return }
      const body = req.method === 'POST' ? await readJsonBody(req, res) : Object.fromEntries(new URL(req.url ?? '/', 'http://x').searchParams.entries()) as Record<string, unknown>
      if (body === undefined) return
      const itemId = typeof body.item_id === 'string' && body.item_id.trim() !== '' ? body.item_id.trim() : typeof body.item === 'string' && body.item.trim() !== '' ? body.item.trim() : undefined
      const text = typeof body.text === 'string' && body.text.trim() !== '' ? body.text.trim() : undefined
      if (itemId === undefined && text === undefined) { sendJson(res, 400, { error: '要带 item(事项 id)或 text(这件活的原话)' }); return }
      if (body.kind !== undefined && body.kind !== '' && !isJobKind(body.kind)) { sendJson(res, 400, { error: 'kind 要是 code、chat 或 desk' }); return }
      // 带技能(卡 S):POST 给数组,GET 给逗号分开的一串。技能库含用户层那几件(2026-10-22,卡「用户层技能生效」B)。
      const rawSkills = typeof body.skills === 'string' ? body.skills.split(',').filter(one => one.trim() !== '') : body.skills
      const skillsChecked = checkSkillNames(rawSkills, rawSkills === undefined ? undefined : (await userLayerSkillsNow()).map(one => one.id))
      if (!skillsChecked.ok) { sendJson(res, 400, { error: skillsChecked.error }); return }
      const view = await choicesFor(itemId, { ...(isJobKind(body.kind) ? { kind: body.kind } : {}), ...(text === undefined ? {} : { text }), ...(skillsChecked.skills.length === 0 ? {} : { skills: skillsChecked.skills }) })
      if (view === undefined) { sendJson(res, 404, { error: '没有这个事项' }); return }
      sendJson(res, 200, view)
      return
    }
    if (path === '/butler/budget' && (req.method === 'GET' || req.method === 'POST')) {
      const store = options.itemBudget?.store
      if (store === undefined) { sendJson(res, 404, { error: '这台工作台没接每件事的上限' }); return }
      if (req.method === 'GET') { sendJson(res, 200, store.get()); return }
      if (!trusted) { sendJson(res, 403, { error: '只有这台电脑或配对过的设备能改上限' }); return }
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      const saved = await store.save(body)
      if (!saved.ok) { sendJson(res, 400, { error: saved.error }); return }
      broadcast({ kind: 'snapshot', state: await composeState() })
      sendJson(res, 200, { ok: true, ...saved.value, note: `记下了:每件事到 ${saved.value.cny} 元或 ${saved.value.minutes} 分钟先停下来问你` })
      return
    }
    if ((path === '/butler/item/stop' || path === '/butler/item/budget' || path === '/butler/item/stuck') && req.method === 'POST') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机或已配对的手机上做' }); return }
      if (tasks === undefined) { sendJson(res, 404, { error: '任务看板未启用' }); return }
      const denied = await agentWriteDenied(req, device)
      if (denied !== undefined) { sendJson(res, 403, { error: denied }); return }
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      const itemId = typeof body.id === 'string' ? body.id.trim() : ''
      if (itemId === '') { sendJson(res, 400, { error: 'id 必须是非空字符串' }); return }
      if (path === '/butler/item/stop') {
        if (itemBudget === undefined) { sendJson(res, 404, { error: '这台工作台没接「停掉这一件」' }); return }
        const stopped = await itemBudget.stopItem(itemId)
        broadcast({ kind: 'snapshot', state: await composeState() })
        sendJson(res, stopped.ok ? 200 : (stopped.status ?? 409), { ok: stopped.ok, note: stopped.note, ...(stopped.ok ? {} : { error: stopped.note }) })
        return
      }
      if (path === '/butler/item/stuck') {
        if (itemBudget === undefined) { sendJson(res, 404, { error: '这台工作台没接每件事的上限' }); return }
        // `text` 必须是字符串(空串 = 撤掉上一句「卡在哪」);不是字符串就 400,不把 undefined 当空串。
        if (typeof body.text !== 'string') { sendJson(res, 400, { error: 'text 要是一句人话:我在找 X,试了 A、B,还差 C(空字符串 = 撤掉上一句)' }); return }
        const noted = await itemBudget.stuck(itemId, body.text)
        broadcast({ kind: 'snapshot', state: await composeState() })
        sendJson(res, noted.ok ? 200 : 409, { ok: noted.ok, note: noted.note, ...(noted.ok ? {} : { error: noted.note }) })
        return
      }
      if (path === '/butler/item/budget') {
        if (itemBudget === undefined) { sendJson(res, 404, { error: '这台工作台没接每件事的上限' }); return }
        const choice = body.choice
        if (choice !== 'continue' && choice !== 'stop' && choice !== 'switch') { sendJson(res, 400, { error: 'choice 要是 continue(继续)/ stop(停掉)/ switch(换一家)' }); return }
        const done = await itemBudget.choose(itemId, choice)
        if (done.ok) {
          noteBehavior(choice === 'switch'
            ? { 事: BEHAVIOR_EVENTS.redispatch, 对象: itemId, 结果: done.note }
            : { 事: BEHAVIOR_EVENTS.decide, 对象: `${itemId} 到上限了`, 结果: choice === 'continue' ? '继续' : '停掉' })
        }
        broadcast({ kind: 'snapshot', state: await composeState() })
        sendJson(res, done.ok ? 200 : 409, { ok: done.ok, note: done.note, ...(done.ok ? {} : { error: done.note }) })
        return
      }
      sendJson(res, 404, { error: '没有这个口' })
      return
    }

    /**
     * 窗口槽「拉进来」(2026-09-25,卡 fix/quota-and-slot-apps)。维护者 09-24:「他说把一些应用拉进去,
     * 它也没拉啊」—— 引导 ④ 只把五家写进了 apps.json 的 enabled,窗口槽空着。
     *
     *   POST /dock/claim         {app, launch?}  标签上「点一下拉进来」:缺省先开应用、拉完置前
     *   POST /dock/claim-enabled {launch?}       enabled 里还没进窗口槽的一口气拉进来(引导落地点「就这样」之后);
     *                                            缺省**不替他开应用**,也不换当前在台的那一扇
     *   GET  /dock/claim-preview                 同上但只读:每一家会是什么结果(`ready` = 会直接拉进来)
     *
     * 门同 /dock/switch(trusted)。业务上拉不成不是接口出错:HTTP 200、逐家的 state + note 如实回出去。
     * 引导落地(卡 B)只在 `claimed` / `already` 时说「摆好了」。
     */
    if (path === '/dock/claim' && req.method === 'POST') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机操作窗位叠' }); return }
      if (dock?.claim === undefined) { sendJson(res, 404, { error: '窗位叠未启用' }); return }
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      if (typeof body.app !== 'string' || body.app === '') { sendJson(res, 400, { error: 'app 必须是非空字符串' }); return }
      const app = body.app
      const launch = body.launch !== false
      const claim = dock.claim.bind(dock)
      const result = await withActorNoteFor(req, 'dock.claim', () => claim(app, { launch }))
      broadcast({ kind: 'snapshot', state: await composeState() })
      sendJson(res, 200, result)
      return
    }

    if (path === '/dock/claim-enabled' && req.method === 'POST') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机操作窗位叠' }); return }
      if (dock?.claimEnabled === undefined) { sendJson(res, 404, { error: '窗位叠未启用' }); return }
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      const claimEnabled = dock.claimEnabled.bind(dock)
      const report = await withActorNoteFor(req, 'dock.claim', () => claimEnabled({ launch: body.launch === true }))
      broadcast({ kind: 'snapshot', state: await composeState() })
      sendJson(res, 200, report)
      return
    }

    if (path === '/dock/claim-preview' && req.method === 'GET') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机操作窗位叠' }); return }
      if (dock?.claimPreview === undefined) { sendJson(res, 404, { error: '窗位叠未启用' }); return }
      sendJson(res, 200, await dock.claimPreview())
      return
    }

    if (path === '/dock/reorder' && req.method === 'POST') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机操作窗位叠' }); return }
      if (dock === undefined) { sendJson(res, 404, { error: '窗位叠未启用' }); return }
      const text = await readBody(req)
      let body: unknown
      try { body = JSON.parse(text) } catch { sendJson(res, 400, { error: 'body 不是合法 JSON' }); return }
      const raw = (body ?? {}) as Record<string, unknown>
      if (!Array.isArray(raw.keys) || raw.keys.some(k => typeof k !== 'string')) {
        sendJson(res, 400, { error: 'keys 必须是字符串数组' }); return
      }
      const result = await dock.reorder(raw.keys as string[])
      broadcast({ kind: 'snapshot', state: await composeState() })
      sendJson(res, 200, result)
      return
    }

    if (path === '/dock/release' && req.method === 'POST') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机操作窗位叠' }); return }
      if (dock === undefined) { sendJson(res, 404, { error: '窗位叠未启用' }); return }
      const text = await readBody(req)
      let body: unknown
      try { body = JSON.parse(text) } catch { sendJson(res, 400, { error: 'body 不是合法 JSON' }); return }
      const raw = (body ?? {}) as Record<string, unknown>
      if (typeof raw.app !== 'string' || raw.app === '') { sendJson(res, 400, { error: 'app 必须是非空字符串' }); return }
      const result = await withActorNoteFor(req, 'dock.release', () => dock.release(raw.app as string))
      broadcast({ kind: 'snapshot', state: await composeState() })
      sendJson(res, 200, result)
      return
    }

    // W4:事务官标签占用窗位——把当前在台的窗藏起来但不除名。无参数,不读 body。
    if (path === '/dock/hide' && req.method === 'POST') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机操作窗位叠' }); return }
      if (dock === undefined) { sendJson(res, 404, { error: '窗位叠未启用' }); return }
      const result = await dock.hideCurrent()
      broadcast({ kind: 'snapshot', state: await composeState() })
      sendJson(res, 200, result)
      return
    }

    /**
     * 弹层让开窗位(2026-09-11):`{on:true}` = 有弹层打开 → dock.veil();`{on:false}` = 弹层关闭
     * → dock.unveil()。计数在 dock 里,这条路由只做转呼。只认回环(同 /dock/hide:它驱动的是
     * 本机屏幕上的原生窗)。**不走 withGlow**:让路不是事务官的动作,不打光圈。
     */
    if (path === '/dock/veil' && req.method === 'POST') {
      if (!loopback) { sendJson(res, 403, { error: '只能在本机操作窗位叠' }); return }
      if (dock === undefined) { sendJson(res, 404, { error: '窗位叠未启用' }); return }
      const text = await readBody(req)
      let body: unknown
      try { body = JSON.parse(text) } catch { sendJson(res, 400, { error: 'body 不是合法 JSON' }); return }
      const raw = (body ?? {}) as Record<string, unknown>
      if (typeof raw.on !== 'boolean') { sendJson(res, 400, { error: 'on 必须是布尔' }); return }
      const result = raw.on ? await dock.veil() : await dock.unveil()
      broadcast({ kind: 'snapshot', state: await composeState() })
      sendJson(res, 200, result)
      return
    }

    /**
     * 事务官手动指一下某一块(2026-09-10 起的手动那一口;2026-09-25 卡 P 补三起**只是一行字**)。
     * 上面那些写动作已经会**自动**前后出字,这条是给"没有对应写动作、但确实在动某一块"的场合用的
     * (事务官在读一块内容、或它想在说话时指一下),以及把还挂着的字收掉(`region:null`)。
     *
     * 跟写动作一样:**不让壳画任何东西**,只往 `/live` 广播一行字,页面挂在那一块真实的元素上画;
     * 那一块看不见(纯净模式、模块收起)页面就不画。所以这条也不再有「未接线 404」—— 它不依赖壳。
     * **写只认回环**(决策记录 2026-09-10):事务官在电脑上的示意,不由手机触发。
     */
    if (path === '/highlight' && req.method === 'POST') {
      if (!loopback) { sendJson(res, 403, { error: '只能在本机指示' }); return }
      const text = await readBody(req)
      let body: unknown
      try { body = JSON.parse(text) } catch { sendJson(res, 400, { error: 'body 不是合法 JSON' }); return }
      const raw = (body ?? {}) as Record<string, unknown>
      if (raw.region === null) {
        broadcast({ kind: 'actor_note_clear' })
        sendJson(res, 200, { ok: true })
        return
      }
      if (!NOTE_REGIONS.includes(raw.region as ActorNoteRegion)) {
        sendJson(res, 400, { error: `region 必须是 ${NOTE_REGIONS.join(' / ')} 之一,或 null(收掉)` })
        return
      }
      // 一行小字截断到 40 字:再长也没地方显示,任由它铺开只会挡住底下的东西(不 400)。
      const label = typeof raw.label === 'string' && raw.label !== '' ? raw.label.slice(0, 40) : undefined
      broadcast({ kind: 'actor_note', note: pointNote(raw.region as ActorNoteRegion, label) })
      sendJson(res, 200, { ok: true })
      return
    }

    /**
     * 资讯与播客(2026-09-21,server/feed.ts)。五条,门一律 `trusted`
     * ——手机就是这一块的主场(舞台页的「资讯」入口),它拿着设备令牌进来。
     *
     *   GET  /feed              今天的资讯流(按项目分组)+ 今天那段播客 + 偏好
     *   POST /feed/config       改「资讯偏好」(每项目关键词、每天几条、播客要不要、时长)
     *   POST /feed/feedback     「跟进 / 不看了 / 不要」。后两个会回写偏好(降权 / 记住这一条)
     *   POST /feed/adopt        一键「加入选题池」:建一条 kind:'topic' 的卡 + 来源落 `来源.md`
     *   POST /feed/run          手工跑一轮(平时由早报例程在开工汇报之前自己跑)
     *   GET  /feed/podcast      今天那段播客的音频字节(手机上那条播放条拉的就是它)
     *
     * **没接资讯服务 → 404「资讯未启用」**,与「接了但今天一条都没搜到」分得开:
     * 后者回 200 + 空分组 + `last_error`,界面照实说是为什么(中转没配搜索就说没配)。
     */
    if (path === '/feed' && req.method === 'GET') {
      if (feed === undefined) { sendJson(res, 404, { error: '资讯未启用' }); return }
      if (!trusted) { sendJson(res, 403, { error: '只能在本机或已配对的手机上看资讯' }); return }
      const date = new URL(req.url ?? '/', 'http://x').searchParams.get('date') ?? undefined
      sendJson(res, 200, feed.view(date))
      return
    }

    if (path === '/feed/config' && req.method === 'POST') {
      if (feed === undefined) { sendJson(res, 404, { error: '资讯未启用' }); return }
      if (!trusted) { sendJson(res, 403, { error: '只能在本机或已配对的手机上改资讯偏好' }); return }
      const text = await readBody(req)
      let body: unknown
      try { body = JSON.parse(text) } catch { sendJson(res, 400, { error: 'body 不是合法 JSON' }); return }
      sendJson(res, 200, { ok: true, config: await feed.setConfig(body) })
      broadcast({ kind: 'snapshot', state: await composeState() })
      return
    }

    if (path === '/feed/feedback' && req.method === 'POST') {
      if (feed === undefined) { sendJson(res, 404, { error: '资讯未启用' }); return }
      if (!trusted) { sendJson(res, 403, { error: '只能在本机或已配对的手机上反馈' }); return }
      const text = await readBody(req)
      let body: unknown
      try { body = JSON.parse(text) } catch { sendJson(res, 400, { error: 'body 不是合法 JSON' }); return }
      const raw = (body ?? {}) as Record<string, unknown>
      const id = typeof raw.id === 'string' ? raw.id : ''
      const action = raw.action
      // `decline` =「不要」(2026-09-22 选题建议那一档):只针对这一条,回写 declined_*。
      // **不收 `adopted`**:那是 /feed/adopt 自己记的,外面把一条标成"已建成选题"而
      // 盘上并没有那张卡,收件箱就会安静地少一条(D13)。
      if (id === '' || (action !== 'follow' && action !== 'mute' && action !== 'decline')) {
        sendJson(res, 400, { error: 'id 要是字符串,action 只能是 follow / mute / decline' })
        return
      }
      const result = await feed.feedback(id, action)
      if (!result.ok) { sendJson(res, 404, { error: result.error }); return }
      noteBehavior(action === 'follow'
        ? { 事: BEHAVIOR_EVENTS.adopt, 对象: `选题建议 ${id}`, 结果: '关注' }
        : { 事: BEHAVIOR_EVENTS.dismiss, 对象: `选题建议 ${id}`, 结果: action === 'mute' ? '这一类都不要' : '不要' })
      sendJson(res, 200, { ok: true })
      broadcast({ kind: 'snapshot', state: await composeState() })
      return
    }

    /**
     * 一键「加入选题池」(2026-09-22 卡 ③ 第 2 条)。收件箱里那条选题建议上的第一颗键。
     *
     * 一次请求做完四件事,**顺序是有讲究的**:
     *   ① 建卡(`kind:'topic'`,挂在这个账号上)—— 这是她真正要的东西,先把它落下;
     *   ② 建 `选题/<名>/` 与它底下的 `素材/`(同 POST /task/create 里那一段);
     *   ③ 把来源链接追加进 `选题/<名>/来源.md`;
     *   ④ 把这一条记成 `adopted`,收件箱里不再问第二遍。
     *
     * **②③④ 失败都不让整件事失败**:卡已经在看板上了,目录与来源是它的附属品。
     * 失败的原因如实带在回执的 `note` 里,不静默吞掉(D13)。
     * ① 失败才回 400 —— 那时候什么都没发生,说"建好了"就是撒谎。
     */
    if (path === '/feed/adopt' && req.method === 'POST') {
      if (feed === undefined) { sendJson(res, 404, { error: '资讯未启用' }); return }
      if (tasks === undefined) { sendJson(res, 404, { error: '任务板未启用,建不了选题' }); return }
      if (!trusted) { sendJson(res, 403, { error: '只能在本机或已配对的手机上建选题' }); return }
      const text = await readBody(req)
      let body: unknown
      try { body = JSON.parse(text) } catch { sendJson(res, 400, { error: 'body 不是合法 JSON' }); return }
      const raw = (body ?? {}) as Record<string, unknown>
      const id = typeof raw.id === 'string' ? raw.id : ''
      if (id === '') { sendJson(res, 400, { error: 'id 要是字符串' }); return }
      const item = feed.item(id)
      if (item === undefined) { sendJson(res, 404, { error: '没有这一条资讯(多半已经过了 14 天)' }); return }
      // 选题标题:提炼出来的那一句。**没提炼出来就退回资讯原标题**,不在这里现编一个。
      const title = item.topic?.title ?? item.title
      const created = await tasks.create({
        title,
        kind: 'topic',
        projectId: item.project_id,
        // 卡面上那一句:为什么现在做 + 来源。她点开卡就看得见这条选题是哪来的。
        desc: [
          item.topic?.why_now,
          `来源:${item.title}${item.source === undefined ? '' : `(${item.source})`}`,
          item.url,
        ].filter((one): one is string => one !== undefined && one !== '').join('\n'),
      })
      if (!created.ok) { sendJson(res, 400, { error: created.reason ?? '建不了这条选题' }); return }
      const notes: string[] = []
      const topicsDir = template?.view().asset_dirs?.[TOPIC_DIR]
      let dir: string | undefined
      if (topicsDir === undefined) notes.push('还没配工作目录,这条选题暂时没有自己的目录')
      else {
        const made = await ensureTopicDir(topicsDir, title)
        if (!made.ok) notes.push(made.reason)
        else {
          dir = made.dir
          const source = await appendTopicSource(made.dir, {
            title: item.title,
            url: item.url,
            ...(item.source === undefined ? {} : { source: item.source }),
            ...(item.topic?.why_now === undefined ? {} : { why: item.topic.why_now }),
            date: localDateStr(Date.now()),
          })
          if (!source.ok) notes.push(source.reason)
        }
      }
      // 记成「已建成选题」。记不下只影响收件箱里多问一遍,卡已经建好了 —— 不因此报失败。
      const marked = await feed.feedback(id, 'adopted')
      if (!marked.ok) notes.push(marked.error)
      noteBehavior({ 事: BEHAVIOR_EVENTS.adopt, 对象: `选题建议 ${id}`, 结果: '加入选题池' })
      sendJson(res, 200, {
        ok: true,
        id: created.id,
        title,
        ...(dir === undefined ? {} : { dir }),
        ...(notes.length === 0 ? {} : { note: notes.join(';') }),
      })
      broadcast({ kind: 'snapshot', state: await composeState() })
      return
    }

    if (path === '/feed/run' && req.method === 'POST') {
      if (feed === undefined) { sendJson(res, 404, { error: '资讯未启用' }); return }
      if (!trusted) { sendJson(res, 403, { error: '只能在本机或已配对的手机上跑资讯' }); return }
      const result = await feed.run()
      sendJson(res, 200, result)
      broadcast({ kind: 'snapshot', state: await composeState() })
      return
    }

    /**
     * ★ **就一条资讯深聊**(2026-10-13,卡「播客页重做」;纯函数在 server/feed.ts)。
     *
     * 维护者原话:「我点击之后,可以打断正在播放的播客,我可以与事务官针对这条信息进行深入挖掘和
     * 交流,文字和语音两种选项……聊完之后的结论同步到电脑的随手记,如果需要形成待办的则做成事项卡
     * 出现在项目区的看板里,要带上来源于」。
     *
     *   POST /feed/dig        { id, text, turns?, want? }  就这一条答一句(`want:'conclusion'` = 收一句结论)
     *   POST /feed/dig/note   { id, text }                 结论落电脑随手记,末尾带「来源:《标题》 链接」
     *   POST /feed/dig/task   { id, title }                结论建一张事项卡,desc 带「来源于:…」
     *   POST /feed/dig/call   { id, said? }                告诉下一通电话「她要聊这一条」
     *
     * **为什么是这四条窄路,而不是让手机直接打 `/note/add` 与 `/task/create`**:
     * ① 来源那一行的形状**写与读只认一处记号**(protocol.ts 的 `feedNoteTextOf` / `feedTaskDescOf`),
     *    让手机自己拼等于把记号抄到第二处;
     * ② `/task/create` 收的是一整张卡,`channel-worker/src/rpc.ts` 那张白名单**刻意没放它**
     *    (理由写在那个文件里:「要放就放一条只改这一个字段的窄路」)。这四条正是那样的窄路,
     *    于是出了局域网经房间代理也按得动 —— 而资讯与播客的用法本来就是「在路上翻」。
     *
     * 门一律 `trusted`(同 `/feed`):手机拿着设备令牌进来。
     * **文字与按住说话走同一条路** —— 手机那头把识别出来的字当她打的字发过来,这里一个岔口都不多。
     */
    if (path.startsWith('/feed/dig') && req.method === 'POST') {
      if (feed === undefined) { sendJson(res, 404, { error: '资讯未启用' }); return }
      if (!trusted) { sendJson(res, 403, { error: '只能在本机或已配对的手机上聊资讯' }); return }
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      const id = typeof body.id === 'string' ? body.id.trim() : ''
      if (id === '') { sendJson(res, 400, { error: 'id 必须是非空字符串' }); return }
      const item = feed.item(id)
      // 这一条不在今天的资讯里(清掉了、id 写错了):**不编一条**,如实 404。
      if (item === undefined) { sendJson(res, 404, { error: '没有这一条资讯(可能已经过了保留期)' }); return }
      /** 手机带上来的那几轮(她说的 / 事务官答的)。形状不对的逐条挑掉,不拒整条请求。 */
      const turns: DigTurn[] = []
      if (Array.isArray(body.turns)) {
        for (const raw of body.turns.slice(-DIG_MAX_TURNS)) {
          if (typeof raw !== 'object' || raw === null) continue
          const one = raw as Record<string, unknown>
          const text = typeof one.text === 'string' ? one.text.trim() : ''
          if (text === '' || (one.who !== 'her' && one.who !== 'butler')) continue
          turns.push({ who: one.who, text })
        }
      }

      if (path === '/feed/dig') {
        const said = typeof body.text === 'string' ? body.text.trim() : ''
        const want = body.want === 'conclusion' ? 'conclusion' : 'answer'
        if (want === 'answer' && said === '') { sendJson(res, 400, { error: 'text 必须是非空字符串' }); return }
        if (said.length > 4000) { sendJson(res, 400, { error: '一句话太长了(上限 4000 字)' }); return }
        // 模型服务没接上:**如实 409**,不摆一个空答案(D13)。界面照原话显示。
        if (quickAnswer === undefined) {
          sendJson(res, 409, { error: '这台机器上的模型服务还没接上,这一条暂时聊不了' })
          return
        }
        let answer: string
        try {
          answer = (await quickAnswer(want === 'conclusion'
            ? digConclusionPrompt({ item, turns })
            : digPrompt({ item, turns, said }))).trim()
        }
        catch (err) {
          sendJson(res, 502, { error: `模型没答上来:${(err as Error)?.message ?? '没说原因'}`.slice(0, 200) })
          return
        }
        if (answer === '') { sendJson(res, 502, { error: '模型没回话' }); return }
        sendJson(res, 200, { ok: true, said: answer, item_id: item.id })
        return
      }

      if (path === '/feed/dig/note') {
        if (notes === undefined) { sendJson(res, 404, { error: '随手记未启用' }); return }
        const text = typeof body.text === 'string' ? body.text.trim() : ''
        if (text === '') { sendJson(res, 400, { error: 'text 必须是非空字符串' }); return }
        const note = await notes.add(feedNoteTextOf({ said: text, title: item.title, url: item.url }))
        broadcast({ kind: 'snapshot', state: await composeState() })
        sendJson(res, 200, { ok: true, note })
        return
      }

      if (path === '/feed/dig/task') {
        if (tasks === undefined) { sendJson(res, 404, { error: '任务看板未启用' }); return }
        const denied = await agentWriteDenied(req, device)
        if (denied !== undefined) { sendJson(res, 403, { error: denied }); return }
        const title = typeof body.title === 'string' ? body.title.trim() : ''
        if (title === '') { sendJson(res, 400, { error: 'title 必须是非空字符串' }); return }
        const created = await tasks.create({
          title,
          desc: feedTaskDescOf({ title: item.title, url: item.url, why: item.why }),
          // 挂在这条资讯所属的项目上 —— 她说的是「出现在项目区的看板里」。
          projectId: item.project_id,
          // 来源是她自己记下来的一条(不是派活、不是文件):与随手记那一档同一个 `kind`。
          source: { kind: 'note', ref: item.url },
        })
        if (!created.ok) { sendJson(res, 400, { error: created.reason ?? '建卡失败' }); return }
        itemDriver?.kick()
        broadcast({ kind: 'snapshot', state: await composeState() })
        sendJson(res, 200, { ok: true, id: created.id })
        return
      }

      if (path === '/feed/dig/call') {
        if (feedDig === undefined) { sendJson(res, 404, { error: '这台机器上没接通话上下文' }); return }
        feedDig.set({
          title: item.title,
          url: item.url,
          ...(item.source === undefined ? {} : { source: item.source }),
          ...(item.why === '' ? {} : { why: item.why }),
          ...(item.project_name === '' ? {} : { project_name: item.project_name }),
          ...(turns.length === 0 ? {} : { said: turns.filter(one => one.who === 'her').map(one => one.text) }),
        })
        sendJson(res, 200, { ok: true })
        return
      }

      sendJson(res, 404, { error: `不认识的深聊操作:${path}` })
      return
    }

    /**
     * AIDJ 通勤播客(2026-09-22,server/aidj.ts)。两条:
     *
     *   GET  /feed/aidj         今天那期双主播节目(归一化过的,音频是**指向 Aiboo 的绝对地址**)
     *   POST /feed/aidj/config  开关:要不要用 Aiboo 的节目、要不要把资讯推给它、Aiboo 的写路由令牌
     *
     * **令牌只进不出**:`token` 收得下、落在 `~/.dsh/workbench/aidj-config.json`,
     * 但两条路由回的 `config` 都是 `publicAidjConfig()` —— 只有 `token_set: true/false`。
     *
     * **音频不经这里**:手机拿到绝对地址之后直接从 Aiboo 拉。这样出了局域网也听得了
     * (上一版 `/feed/podcast` 走不了房间代理的老毛病),电脑合上盖也不影响已经拉到的那期。
     * 取不到节目时回的仍然是 200 + `status` + 一句 Aiboo 原话,**不是错误** ——
     * 界面凭这个退回单人口播。
     */
    if (path === '/feed/aidj' && req.method === 'GET') {
      if (aidj === undefined) { sendJson(res, 404, { error: '还没接 Aiboo 的 AIDJ' }); return }
      if (!trusted) { sendJson(res, 403, { error: '只能在本机或已配对的手机上听播客' }); return }
      const view = await aidj.program()
      // `publicConfig()` 而不是 `config()`:那份偏好里有 Aiboo 的写路由令牌,
      // **一个字节都不下发**(2026-09-22)。手机只拿得到 `token_set`。
      sendJson(res, 200, { ...view, config: aidj.publicConfig() })
      return
    }

    if (path === '/feed/aidj/config' && req.method === 'POST') {
      if (aidj === undefined) { sendJson(res, 404, { error: '还没接 Aiboo 的 AIDJ' }); return }
      if (!trusted) { sendJson(res, 403, { error: '只能在本机或已配对的手机上改' }); return }
      const text = await readBody(req)
      let body: unknown
      try { body = JSON.parse(text) } catch { sendJson(res, 400, { error: 'body 不是合法 JSON' }); return }
      // 存得下令牌(`token`),但**回包里不回显** —— 同上,只说存没存。
      await aidj.setConfig(body)
      sendJson(res, 200, { ok: true, config: aidj.publicConfig() })
      return
    }

    /**
     * 播客音频。**用 stream 不用一次读进内存**(一段四分钟的口播 3–4MB,与 /setup/apk 同一条路子)。
     * 手机上那条播放条拿到的是一整段,不支持 Range —— 这一版不做拖进度条里的"跳到中间再下载",
     * 文件本来就不大,整段拉下来再播最简单。
     */
    if (path === '/feed/podcast' && req.method === 'GET') {
      if (feed === undefined) { sendJson(res, 404, { error: '资讯未启用' }); return }
      if (!trusted) { sendJson(res, 403, { error: '只能在本机或已配对的手机上听播客' }); return }
      const date = new URL(req.url ?? '/', 'http://x').searchParams.get('date') ?? undefined
      const file = feed.podcastPath(date)
      if (file === undefined) { sendJson(res, 404, { error: '这一天没有合成好的播客(只有文字稿,或者还没跑过)' }); return }
      let size: number
      try { size = (await stat(file)).size }
      catch { sendJson(res, 404, { error: '播客文件不在了(多半被清理掉了)' }); return }
      res.writeHead(200, {
        'content-type': file.endsWith('.mp3') ? 'audio/mpeg' : 'application/octet-stream',
        'content-length': String(size),
        'cache-control': 'no-store',
      })
      const stream = createReadStream(file)
      stream.on('error', () => { res.destroy() })
      stream.pipe(res)
      return
    }

    // W4:划走今晨快报——当天不再推(规则③)。无参数,不读 body。
    if (path === '/brief/dismiss' && req.method === 'POST') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机操作快报' }); return }
      if (brief === undefined) { sendJson(res, 404, { error: '快报未启用' }); return }
      await brief.dismiss()
      noteBehavior({ 事: BEHAVIOR_EVENTS.dismiss, 对象: '早报', 结果: '收起' })
      broadcast({ kind: 'snapshot', state: await composeState() })
      sendJson(res, 200, { ok: true })
      return
    }

    /**
     * DeepSeek 峰谷时间表(2026-09-09)。只认本机回环——这是本机的配置文件,
     * 跟 /layout /note/* /credentials 同一条规矩:热点网段上的别人不许改这台机器的设置。
     *
     * 读走 /state.deepseek_peak(连同当前峰谷一起下发),所以这里只有 POST。
     */
    if (path === '/peak-schedule' && req.method === 'POST') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机改峰谷时段' }); return }
      if (peakSchedule === undefined) { sendJson(res, 404, { error: '峰谷时段未启用' }); return }
      const text = await readBody(req)
      let body: unknown
      try { body = JSON.parse(text) } catch { sendJson(res, 400, { error: 'body 不是合法 JSON' }); return }
      const raw = (body ?? {}) as Record<string, unknown>
      try {
        const saved = await peakSchedule.set({ periods: raw.periods })
        broadcast({ kind: 'snapshot', state: await composeState() })
        sendJson(res, 200, { ok: true, schedule: saved })
      }
      catch (error) {
        // 校验话术是说给人听的(「第 2 段的起点要早于终点」),原样回给界面。
        sendJson(res, 400, { error: error instanceof Error ? error.message : '时间表不合法' })
      }
      return
    }

    /**
     * 自定义模块容器(2026-09-21;2026-09-22 单开来源之后只剩三条)。
     *
     *   GET  /modules                看清单(活着的 + 回收站里的)。设置那一节读它。
     *   POST /modules/<id>/remove    移进回收站(不删),**顺手吊销这个模块的令牌**。
     *   POST /modules/<id>/restore   从回收站拿回来。
     *
     * **`GET /modules/<id>/<路径>` 在这台服务上没有了**(C7)。模块的静态文件只从单开的
     * 那个来源端(server/moduleOrigin.ts,默认 8794)—— 留一条同源的备用路等于把刚立起来
     * 的边界留一个后门:只要还能同源打开,那张接口表就还只是一份规范。
     *
     * **门**:一律 `trusted`(回环,或带着设备令牌的已配对手机)。模块自己**打不到这几条**
     * (它们不在白名单里),所以一个模块删不掉另一个模块。
     */
    /**
     * 用户层(2026-10-21,卡「分层第一刀」)。三条,**只认本机**:它们说的是这台 Mac 上的一个目录,
     * 手机上没有意义;网页小组件的令牌在上面那道白名单门就被挡掉了(不在九条里)。
     *
     *   GET  /user-layer                      设置里「用户层」那一节:目录、骨架、清单、能替哪几格、插件清单
     *   GET  /user-layer/widgets/<id>/code    一格的入口代码。id 只当清单里的名字查,不拼路径
     *   GET  /user-layer/layouts/<id>/skin     一份布局模板的皮肤 css。id 只当清单里的名字查,不拼路径
     *   POST /user-layer/reveal               在访达里打开用户层目录
     *   POST /user-layer/report { id, rev, ok, problem? }   页面报一格装得怎样(画好过 → 存成上一版;坏了 → 下一拍端上一版)
     *   POST /user-layer/fix    { said }      派一家能写代码的去改用户层(自愈,10-21 统筹补的硬要求 ②):
     *       工作区**只开到用户层目录**(`cwd` + `cwdFixed`,同「开发一个小工具」那条路):Codex 的 workspace-write、
     *       Claude 的 --add-dir 都只放行这一个目录可写,本体对它只读。交代见 `userLayerFixBrief`。
     */
    if (path === '/user-layer' || path.startsWith('/user-layer/')) {
      if (userLayer === undefined) { sendJson(res, 404, { error: '用户层未启用' }); return }
      if (!loopback) { sendJson(res, 403, { error: '只能在本机看用户层' }); return }
      if (path === '/user-layer' && req.method === 'GET') {
        const view = await userLayer.scan()
        // 每格带存下的可用版本历史(设置里「选回」用;最多 3 份)。/state 不背这份 —— 一秒一拍别带。
        const widgets = []
        for (const widget of view.widgets) widgets.push({ ...widget, history: await userLayer.widgetHistory(widget.id) })
        sendJson(res, 200, {
          ...view,
          widgets,
          dir: userLayer.dir,
          web_widgets_dir: userLayer.webWidgetsDir,
          folders: USER_LAYER_FOLDERS,
          slots: WIDGET_SLOTS,
          plugins: FAMILY_PLUGINS,
        })
        return
      }
      if (path === '/user-layer/report' && req.method === 'POST') {
        const body = await readJsonBody(req, res)
        if (body === undefined) return
        if (typeof body.id !== 'string' || typeof body.rev !== 'string' || typeof body.ok !== 'boolean'
          || (body.style_rev !== undefined && typeof body.style_rev !== 'string')) {
          sendJson(res, 400, { error: 'id、rev 是字符串,ok 是 true / false;style_rev 是字符串、可缺' })
          return
        }
        await userLayer.report({ id: body.id, rev: body.rev, ok: body.ok, ...(typeof body.style_rev === 'string' ? { style_rev: body.style_rev } : {}), ...(typeof body.problem === 'string' ? { problem: body.problem.slice(0, 500) } : {}) })
        sendJson(res, 200, { ok: true })
        return
      }
      if (path === '/user-layer/fix' && req.method === 'POST') {
        const body = await readJsonBody(req, res)
        if (body === undefined) return
        const said = typeof body.said === 'string' ? body.said.trim() : ''
        if (said === '') { sendJson(res, 400, { error: '说一句要改什么' }); return }
        const brief = userLayerFixBrief(said, userLayer.dir)
        const coder = await devToolCoder(brief)
        if (coder === undefined) { sendJson(res, 409, { error: NO_CODER_FOR_MODULE }); return }
        const created = await createButlerItem(brief, coder.family, undefined, { skipSession: true })
        if (!created.ok) { sendJson(res, 400, { error: created.error }); return }
        await userLayer.ensure()
        itemDriver?.claim(created.id)
        const started = await dispatchItem(created.id, {
          family: coder.family,
          text: brief,
          source: 'item',
          kind: 'code',
          cwd: userLayer.dir,
          cwdFixed: true,
        })
        // 越界守门(2026-10-23,卡「分层自愈完善」):派活那一刻记本体目录与用户层的快照;
        // 那一家交回来后挂在既有 tick 上核对 —— 本体被改过就拒装(见下方 pumpFixGuards)。
        // 记不上不静默:落到卡上一句,这次交回就没有越界核对(独立审 Minor 2)。
        if (started.ok) {
          void userLayer.beginFixGuard(created.id).then(async (guard) => {
            if (guard.ok) return
            if (tasks !== undefined) await tasks.update(created.id, { note: guard.reason }).catch(() => false)
            broadcast({ kind: 'snapshot', state: await composeState() })
          }, () => undefined)
        }
        broadcast({ kind: 'snapshot', state: await composeState() })
        sendJson(res, 200, {
          ok: true,
          id: created.id,
          assignee: coder.family,
          dispatch_ok: started.ok,
          dispatch_note: started.ok ? `交给 ${coder.title} 改了,只改用户层目录;改完那一格自己换上` : started.note,
        })
        return
      }
      if (path === '/user-layer/reveal' && req.method === 'POST') {
        const opened = await userLayer.reveal()
        sendJson(res, opened.ok ? 200 : 500, opened.ok ? { ok: true } : { ok: false, error: opened.reason })
        return
      }
      const code = /^\/user-layer\/widgets\/([^/]+)\/code$/.exec(path)
      if (code !== null && req.method === 'GET') {
        const hit = await userLayer.widgetCode(code[1] ?? '')
        if (hit === undefined) { sendJson(res, 404, { error: '没有这个小组件,或者它的清单没过(设置 → 这台电脑 → 用户层 看原因)' }); return }
        res.setHeader('cache-control', 'no-store')
        sendText(res, 200, 'text/javascript', hit.code)
        return
      }
      // 组件专属兼容样式(2026-10-23,分层二刀二第三轮)。id 只当清单里的名字查、不拼路径;
      // 只有带了 style.css 的组件才回 200。
      const widgetStyle = /^\/user-layer\/widgets\/([^/]+)\/style$/.exec(path)
      if (widgetStyle !== null && req.method === 'GET') {
        const hit = await userLayer.widgetStyle(widgetStyle[1] ?? '')
        if (hit === undefined) { sendJson(res, 404, { error: '没有这个小组件的样式' }); return }
        res.setHeader('cache-control', 'no-store')
        sendText(res, 200, 'text/css', hit.css)
        return
      }
      // 选回历史里的某一版(2026-10-23,卡「分层自愈完善」):先存当前版(选回可逆),再写回清单与入口;
      // 她的 style.css 不动。rev 是设置里看得见的那份入口指纹,style_rev 可缺(缺了取存下的这一版里最新的)。
      const restore = /^\/user-layer\/widgets\/([^/]+)\/restore$/.exec(path)
      if (restore !== null && req.method === 'POST') {
        const body = await readJsonBody(req, res)
        if (body === undefined) return
        if (typeof body.rev !== 'string' || (body.style_rev !== undefined && typeof body.style_rev !== 'string')) {
          sendJson(res, 400, { error: 'rev 是这一版的入口指纹(设置 → 这台电脑 → 用户层 里看得见);style_rev 可缺' })
          return
        }
        const result = await userLayer.restoreWidget(restore[1] ?? '', body.rev, typeof body.style_rev === 'string' ? body.style_rev : undefined)
        sendJson(res, result.ok ? 200 : 400, result)
        return
      }
      // 布局模板的那一份皮肤(2026-10-23,分层二刀二)。id 只当清单里的名字查、不拼路径,
      // 同上面 widgets 那条的规矩;只有清单里 ok 且带了皮肤的模板才回 200。
      const skin = /^\/user-layer\/layouts\/([^/]+)\/skin$/.exec(path)
      if (skin !== null && req.method === 'GET') {
        const hit = userLayer.layoutSkin(skin[1] ?? '')
        if (hit === undefined) { sendJson(res, 404, { error: '没有这个布局模板,它没装上,或者它没带皮肤(设置 → 这台电脑 → 用户层 看原因)' }); return }
        res.setHeader('cache-control', 'no-store')
        sendText(res, 200, 'text/css', hit.css)
        return
      }
      sendJson(res, 404, { error: '没有这个路径' })
      return
    }

    if (path === '/modules' && req.method === 'GET') {
      if (modules === undefined) { sendJson(res, 404, { error: '自定义模块未启用' }); return }
      if (!trusted) { sendJson(res, 403, { error: '只能在本机看自定义模块' }); return }
      sendJson(res, 200, { modules: await modules.list(), trash: await modules.trash() })
      return
    }

    if (path.startsWith('/modules/') && req.method === 'POST') {
      if (modules === undefined) { sendJson(res, 404, { error: '自定义模块未启用' }); return }
      if (!trusted) { sendJson(res, 403, { error: '只能在本机改自定义模块' }); return }
      const rest = path.slice('/modules/'.length)
      const slash = rest.lastIndexOf('/')
      const id = slash < 0 ? '' : rest.slice(0, slash)
      const action = slash < 0 ? '' : rest.slice(slash + 1)
      if (action !== 'remove' && action !== 'restore') { sendJson(res, 404, { error: '没有这个路径' }); return }
      if (!isModuleId(id)) { sendJson(res, 400, { error: '认不出这个模块' }); return }
      const result = action === 'remove' ? await modules.remove(id) : await modules.restore(id)
      /**
       * 吊销这个模块的全部令牌(2026-09-22)。移进回收站之后那一格 iframe 可能还开着 ——
       * 它手里那把令牌必须**当场**作废,不能等 30 分钟过期。恢复也吊销一次:
       * 拿回来的是一份新开始,旧令牌没有理由继续能用。
       */
      if (result.ok) moduleTokens?.revoke(id)
      // 移不动 / 恢复不了都是**业务上的拒绝**(重名、不存在),不是接口错:200 + 如实一句,
      // 同 /scene/save 那套规矩。设置里原样上屏。
      if (!result.ok) { sendJson(res, 200, result); return }
      broadcast({ kind: 'snapshot', state: await composeState() })
      sendJson(res, 200, { ok: true })
      return
    }

    /**
     * 老路的墓碑(2026-09-22)。`GET /modules/<id>/<路径>` **不再端文件** ——
     * 装过 0.2.54 之前那一版、缓存里还留着老 src 的 iframe 会打到这儿,
     * 给它一句能查的话,而不是一个查不出成因的 404。
     */
    if (path.startsWith('/modules/') && req.method === 'GET') {
      sendJson(res, 404, { error: '模块文件不在这台服务上了:它有自己的来源(见 docs/自定义模块-接口.md)' })
      return
    }

    /**
     * 「开发一个小工具」的提议流程(2026-09-21,PRD §5.6 门槛②③)。两条:
     *
     *   POST /devtool/confirm { id, name }         他点了「就这样」→ 这一刻才**派出去**
     *   POST /devtool/cancel  { id }               他点了「不做了」→ 这条需求就地作废
     *
     * ★ 2026-10-01(C2「小组件派出去」):确认之后**不再开一条事务官自己的会话让她写网页** ——
     * 事务官只写交代(`devToolBrief`,原样带上)+ 验收。整段理由在 `server/devTool.ts` 文件头。
     *
     * 需求本身是 `POST /butler/item` 认出来的(见下面那条路由),**认出来那一刻什么都不做**:
     * 不建卡、不开会话、不在盘上写一个字节。PRD §9「不得自行执行」在这里是一道代码门槛,
     * 不是一句文案。
     */
    if ((path === '/devtool/confirm' || path === '/devtool/cancel') && req.method === 'POST') {
      if (devTool === undefined) { sendJson(res, 404, { error: '自定义模块未启用' }); return }
      if (!trusted) { sendJson(res, 403, { error: '只能在本机确认' }); return }
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      const id = typeof body.id === 'string' ? body.id : ''
      const proposal = devTool.store.find(id)
      if (proposal === undefined) { sendJson(res, 404, { error: '没有这条待确认的需求' }); return }

      if (path === '/devtool/cancel') {
        await devTool.store.drop(id)
        broadcast({ kind: 'snapshot', state: await composeState() })
        sendJson(res, 200, { ok: true })
        return
      }

      const named = checkModuleName(body.name)
      if (!named.ok) { sendJson(res, 400, { error: named.error }); return }
      // 交代就是这一份:写到哪、`module.json` 长什么样、能打哪九条、不许引外网。
      // **原样带上**,一个字都不重新组织 —— 它是给机器执行的那一份(人话那一份在 docs/自定义模块-接口.md)。
      const brief = devToolBrief({
        need: proposal.restate,
        moduleId: proposal.module_id,
        name: named.name,
        modulesDir: devTool.modulesDir,
        serviceOrigin: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`,
      })
      /**
       * 派给她机器上**能写代码的那一家**(2026-10-01,C2)。挑法就是派活那张选项表
       * (`choicesFor` → `dispatchChoice.ts`:写代码的活只列能改本机文件的几家,家与包由
       * `agentSources.pickFamilyPackage` 一处挑)—— **这里不新造一张「家→包」表**。
       *
       * 一家都挑不到就**如实说**(`NO_CODER_FOR_MODULE`)、这条待确认**留着**:
       * 她装上 / 登上一家再点一次「就这样」,原话一个字都没丢。
       * **不退回让事务官自己写**(那条退路 09-28 拍板拿掉了)。
       */
      const coder = await devToolCoder(brief)
      if (coder === undefined) { sendJson(res, 409, { error: NO_CODER_FOR_MODULE }); return }
      // 建卡**不开会话**(`skipSession`):这件活由工作台直接派,再开一条会话去"按技能派"
      // 就是同一件事两条路在派(同 /butler/item 点了名那一支)。复用 createButlerItem,
      // 不另开一条路 —— 两条路建出来的卡长得不一样,她在看板上看到的就不是一回事了。
      const created = await createButlerItem(brief, coder.family, undefined, { skipSession: true })
      if (!created.ok) { sendJson(res, 400, { error: created.error }); return }
      // 事项建下来了才把这条待确认清掉:建不下来时它还在,他能再点一次。
      await devTool.store.drop(id)
      // 派活记录:派给了谁、等哪一格出现。**落盘**,验收要跨重启(devTool.ts 的 dispatched)。
      await devTool.store.markDispatched({
        task_id: created.id,
        module_id: proposal.module_id,
        name: named.name,
        family: coder.family,
        at: new Date().toISOString(),
      })
      /**
       * 落点是**用户层那个固定目录**(`~/.dsh/workbench/modules/<id>/`),不是她的任何一个项目 ——
       * 所以带着 `cwd` 派、并且 `cwdFixed`(不开独立工作区、不过扫描根那道门;理由在
       * `dispatchRun.ts` 的 `cwdFixed`)。这一下**没有第二道「要你批一下」**:
       * 她刚点的那下「就这样」就是确认点(PRD §9 门槛③),再问一次等于同一件事问两遍。
       *
       * 目录在派之前**先建出来**:命令行那只手是在 `cwd` 里起进程的,目录不在就起不来
       * (而 `modules/` 在第一个模块落盘之前确实可能还不存在)。建的是模块根,
       * 模块自己那一格由干活的那一家按交代建 —— 交代里写的就是 `mkdir <modulesDir>/<id>`。
       */
      await mkdir(devTool.modulesDir, { recursive: true }).catch(() => undefined)
      // 这张的「派不派」由这条路管(同 /butler/item 点了名那一支):负责人驱动别再问一次(卡 N)。
      itemDriver?.claim(created.id)
      const startedDispatch = await dispatchItem(created.id, {
        family: coder.family,
        text: brief,
        source: 'item',
        kind: 'code',
        cwd: devTool.modulesDir,
        cwdFixed: true,
      })
      broadcast({ kind: 'snapshot', state: await composeState() })
      sendJson(res, 200, {
        ok: true,
        id: created.id,
        module_id: proposal.module_id,
        name: named.name,
        assignee: coder.family,
        // 真派出去了吗(同 /butler/item 那条回执的口径):假的时候界面与电话里都不许说「派出去了」。
        dispatch_ok: startedDispatch.ok,
        dispatch_note: startedDispatch.ok
          ? `交给 ${coder.title} 做了(交代里带着产出规范);做好了我读一眼模块清单再告诉你`
          : startedDispatch.note,
        ...(created.note === undefined ? {} : { note: created.note }),
      })
      return
    }

    /**
     * 进化循环(2026-09-22,卡 ⑥;设计文档 §五「持续进化的一条线」)。五条:
     *
     *   GET  /evolve            → 这会儿有几条提议、上一次固化的回看那一句(也在 /state.evolve 里)
     *   GET  /evolve/log        → 进化日志全文(她想自己看一眼)
     *   POST /evolve/scan       → 现在就扫一遍(平时挂在下班例程之后,见 index.ts 的 afterEvening)
     *   POST /evolve/accept     → 她点「做」{ id, way?, name? }
     *   POST /evolve/decline    → 她点「不要」{ id }:以后不再提这一条
     *   POST /evolve/later      → 她点「以后再说」{ id }:这次撤下,下次还问
     *   POST /evolve/wire       → 技能草稿她过了,接进 ~/.dsh/AGENTS.md 的标记段 { id }
     *   POST /evolve/revert     → 撤一条已固化的 { id }
     *
     * **写路一律只认本机**(同 /devtool/*、/layout/*):它们会往她的仓库、她的家目录写文件。
     *
     * 这条链路**不碰工作台自己的源码**——设计文档 §五 末尾钉死的那一句。能被它写出去的
     * 只有两样:仓库 `docs/技能/固化-*.md` 一份文档,与走既有造模块链路的一条**待确认**需求。
     */
    if (path === '/evolve' && req.method === 'GET') {
      if (evolve === undefined) { sendJson(res, 404, { error: '进化循环未启用' }); return }
      sendJson(res, 200, evolve.view())
      return
    }

    if (path === '/evolve/log' && req.method === 'GET') {
      if (evolve === undefined) { sendJson(res, 404, { error: '进化循环未启用' }); return }
      const text = await evolve.log()
      // 还没固化过任何东西时日志文件根本不存在。**如实说**,不回一份空模板冒充(D13)。
      if (text === undefined) { sendJson(res, 404, { error: '还没有进化日志——一样东西都还没固化过' }); return }
      sendJson(res, 200, { text })
      return
    }

    if (path === '/evolve/scan' && req.method === 'POST') {
      if (evolve === undefined) { sendJson(res, 404, { error: '进化循环未启用' }); return }
      if (!trusted) { sendJson(res, 403, { error: '只能在本机扫' }); return }
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      const done = await evolve.scan({ force: body.force === true })
      broadcast({ kind: 'snapshot', state: await composeState() })
      sendJson(res, 200, { ok: true, added: done.added, note: done.note })
      return
    }

    if ((path === '/evolve/accept' || path === '/evolve/decline' || path === '/evolve/later'
      || path === '/evolve/wire' || path === '/evolve/revert') && req.method === 'POST') {
      if (evolve === undefined) { sendJson(res, 404, { error: '进化循环未启用' }); return }
      if (!trusted) { sendJson(res, 403, { error: '只能在本机决定要不要固化' }); return }
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      const id = typeof body.id === 'string' ? body.id : ''
      if (id === '') { sendJson(res, 400, { error: '没说是哪一条' }); return }

      if (path === '/evolve/decline' || path === '/evolve/later') {
        const dropped = path === '/evolve/decline' ? await evolve.decline(id) : await evolve.later(id)
        if (!dropped) { sendJson(res, 404, { error: '没有这条提议' }); return }
        noteBehavior({ 事: BEHAVIOR_EVENTS.dismiss, 对象: `提议 ${id}`, 结果: path === '/evolve/decline' ? '以后不提' : '先放下' })
        broadcast({ kind: 'snapshot', state: await composeState() })
        sendJson(res, 200, {
          ok: true,
          note: path === '/evolve/decline' ? '好,这一条以后不提了。' : '放下了,下次还会问一声。',
        })
        return
      }

      let done: { ok: true, note: string } | { ok: false, error: string }
      if (path === '/evolve/wire') done = await evolve.wire(id)
      else if (path === '/evolve/revert') done = await evolve.revert(id)
      else {
        // 三条路只认枚举里那三个词。认不出就**不猜**——那一下会往她的仓库里写文件。
        const way = EVOLVE_WAYS.find(name => name === body.way)
        done = await evolve.accept({ id, ...(way === undefined ? {} : { way }), ...(body.name === undefined ? {} : { name: body.name }) })
      }
      if (!done.ok) { sendJson(res, 400, { error: done.error }); return }
      noteBehavior(path === '/evolve/accept'
        ? { 事: BEHAVIOR_EVENTS.adopt, 对象: `提议 ${id}`, 结果: '固化' }
        : { 事: BEHAVIOR_EVENTS.decide, 对象: `提议 ${id}`, 结果: path === '/evolve/wire' ? '接上' : '撤回' })
      broadcast({ kind: 'snapshot', state: await composeState() })
      sendJson(res, 200, { ok: true, note: done.note })
      return
    }

    /**
     * 布局模板(2026-09-21)。三条:看一眼 / 切过去 / 回退上一次。
     *
     * **切换不重启工作台**:界面每秒轮询一次 `GET /state`,apply 写完盘、广播一次快照,
     * 下一拍布局就是新的了 —— 不需要 `location.reload()`(全仓没有这条路,页面 reload
     * 是壳在插件版本变了之后自己做的,跟切模板没关系),更不需要 kickstart。
     *
     * **贴在窗位槽里的原生窗**跟着走的是既有那条路:模块矩形一变,`/slot/rect`
     * 下一拍照旧上报新矩形,壳把窗摆过去。
     */
    /**
     * 数据复盘:小红书创作者中心自取(2026-09-21)。
     *
     * 四条路由**一律只认本机**(同 /layout、/template、/files/*):这几条会在他的机器上
     * 开浏览器窗口、读他自己的后台、往他盘上写文件 —— 展示台与手机一条都不该碰得到。
     *
     * | | 干什么 |
     * |---|---|
     * | `POST /xhs/login`   | 开一个专用档案的 Chrome 窗口,**他自己登录**。我们不代填任何东西,也不取任何凭据。可选 body `{profile: N}` 指定第几个档案 |
     * | `POST /xhs/login/new` | 再开一个**纯净的**档案,登下一个账号(2026-09-22 多账号) |
     * | `POST /xhs/refresh` | 他点了模块里那颗「刷新」。频率闸在服务里(两次之间至少 10 分钟) |
     * | `POST /xhs/peek`    | 「让我看看这页」:把当前那一页的**可见文字**导出到本地文件(不含 cookie) |
     * | `GET  /xhs`         | 这一格的全部数据。与 `/state.xhs` 同一份,给不方便轮 /state 的地方用 |
     */
    if (path.startsWith('/xhs')) {
      if (xhs === undefined) { sendJson(res, 404, { error: '数据复盘自取未启用' }); return }

      if (path === '/xhs' && req.method === 'GET') {
        sendJson(res, 200, xhs.view())
        return
      }

      // 开浏览器、读他的后台、往他盘上写文件 —— **只认回环**,不是 trusted。
      // trusted 里还包含配对过的手机;在手机上点一下就让他的 Mac 弹出一个浏览器窗口,
      // 是这类功能最吓人的行为(同 /pair、/hooks、/config/paths 那几条的口径)。
      //
      // ★ 2026-10-01 一个例外:`POST /xhs/refresh` 给**自定义小组件**也放行(白名单第八条,
      // `moduleOrigin.ts` 的 `MODULE_API_ROUTES`)。她自己那一版「数据复盘」上得有一颗「刷新」,
      // 而这一条受它原有那道闸(两次之间至少 10 分钟,闸在 `xhs.collect` 自己身上)——
      // 给不出任何比内置那一格更多的东西。**只这一条**:登录、翻页那几条照旧只认回环。
      const byModule = moduleClaims !== undefined && req.method === 'POST' && path === '/xhs/refresh'
      if (!loopback && !byModule) { sendJson(res, 403, { error: '只能在这台机器上做这件事' }); return }

      /**
       * 多账号(2026-09-22):一个账号一个浏览器档案。
       *
       * - `POST /xhs/login`(不带 body)= 第一个档案,**与 9/21 那一版逐字相同**;
       * - `POST /xhs/login {profile: N}` = 第 N 个档案(重登某一个);
       * - `POST /xhs/login/new` = 再开一个**纯净的**档案,登下一个号。
       */
      if (path === '/xhs/login/new' && req.method === 'POST') {
        sendJson(res, 200, await xhs.startLogin('new'))
        return
      }
      if (path === '/xhs/login' && req.method === 'POST') {
        const body = await readJsonBody(req, res)
        if (body === undefined) return
        const which = typeof body.profile === 'number' ? body.profile : undefined
        sendJson(res, 200, await xhs.startLogin(which))
        return
      }
      if (path === '/xhs/refresh' && req.method === 'POST') {
        const result = await xhs.collect('manual')
        // 取完立刻把整份快照推出去(同 /template/apply 那一条):界面下一拍就变,
        // 不用刷新、不用重启。例程那条路没有 HTTP 请求,走的是服务自己的 onChanged;
        // 手动这一条两边都会推一次 —— 两份一模一样的快照,前台是整体替换,推两次无害,
        // 而少推一次会让他点完「刷新」盯着旧数字看一秒。
        broadcast({ kind: 'snapshot', state: await composeState() })
        sendJson(res, 200, result)
        return
      }
      if (path === '/xhs/peek' && req.method === 'POST') {
        const body = await readJsonBody(req, res)
        if (body === undefined) return
        const result = await xhs.peek(typeof body.profile === 'number' ? body.profile : undefined)
        broadcast({ kind: 'snapshot', state: await composeState() })
        sendJson(res, 200, result)
        return
      }
      sendJson(res, 404, { error: '没有这条路由' })
      return
    }

    /**
     * 采集类三项(2026-09-22):评论区采集 ① + 笔记采集 ② + 爆款拆解 ③。
     *
     * | | 干什么 |
     * |---|---|
     * | `POST /collect/note {url}` | ①②同一次读取:打开**他自己给的**那一条笔记页,落两份 markdown |
     * | `POST /collect/breakdown {url}` | ③:拆已经采过的那一条(**不再开一次页面**) |
     * | `GET  /collect` | 这一块的全部数据。与 `/state.xhs_collect` 同一份 |
     *
     * 门与 `/xhs/*` 完全一样:**只认回环**。这几条会在他的机器上开浏览器窗口、
     * 打开别人的笔记页、往他盘上写文件,手机与展示台一条都不该碰得到。
     *
     * ★ **这里没有任何一条能"按关键词采一批"的路由,也不会有。**
     * 只从他自己给的一条链接进,是这件事和爬虫的分界线(预研 3.4 第 1 条)。
     */
    /**
     * 小组件读她的采集器采回来的那一份(2026-09-23,用户层;白名单第七条,`moduleOrigin.ts`)。
     * **模块身份也能走**(上面那道门已经按白名单放行),回环自然也能。只读、只认 `?name=`。
     * 名字过路径闸在 `collectors.latest` 里;没有这个采集器 → 404;没采成过 → 200 但 `text` 为空。
     */
    if (path === '/module/data' && req.method === 'GET') {
      if (collectors === undefined) { sendJson(res, 404, { error: '采集器未启用' }); return }
      const name = new URL(req.url ?? '/', 'http://x').searchParams.get('name') ?? ''
      const result = await collectors.latest(name)
      sendJson(res, result.ok ? 200 : 404, result)
      return
    }

    /**
     * 采集器那五条(2026-09-23,用户层;`docs/设计-用户自己的那一层-2026-09-23.md` 第二节)。
     * 门与 `/xhs/*`、`/collect/*` 完全一样:**只认回环**(会在她机器上开浏览器窗口、往工作目录写文件)。
     * 事务官按《做一个看数据的小组件》那份技能调它们。
     */
    if (path.startsWith('/collector')) {
      if (collectors === undefined) { sendJson(res, 404, { error: '采集器未启用' }); return }
      if (path === '/collector' && req.method === 'GET') { sendJson(res, 200, collectors.view()); return }
      if (!loopback) { sendJson(res, 403, { error: '只能在这台机器上做这件事' }); return }
      if (req.method !== 'POST') { sendJson(res, 404, { error: '没有这条路由' }); return }
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      const name = typeof body.name === 'string' ? body.name : ''
      let result: { ok: boolean, error?: string }
      if (path === '/collector/add') result = await collectors.add({ name: body.name, url: body.url, profile: body.profile, note: body.note })
      else if (path === '/collector/login') result = await collectors.login(name)
      else if (path === '/collector/run') result = await collectors.run(name, 'manual')
      else if (path === '/collector/remove') result = await collectors.remove(name)
      else { sendJson(res, 404, { error: '没有这条路由' }); return }
      // 增删采之后把整份快照推出去(同 /xhs/refresh):界面下一拍就变。
      broadcast({ kind: 'snapshot', state: await composeState() })
      sendJson(res, result.ok ? 200 : (path === '/collector/add' ? 400 : 409), result)
      return
    }

    if (path.startsWith('/collect')) {
      if (collect === undefined) { sendJson(res, 404, { error: '采集未启用' }); return }

      if (path === '/collect' && req.method === 'GET') {
        sendJson(res, 200, await collect.view())
        return
      }
      if (!loopback) { sendJson(res, 403, { error: '只能在这台机器上做这件事' }); return }

      if (path === '/collect/note' && req.method === 'POST') {
        const body = await readJsonBody(req, res)
        if (body === undefined) return
        const result = await collect.collectNote(body.url)
        broadcast({ kind: 'snapshot', state: await composeState() })
        sendJson(res, result.ok ? 200 : 409, result)
        return
      }
      if (path === '/collect/breakdown' && req.method === 'POST') {
        const body = await readJsonBody(req, res)
        if (body === undefined) return
        const result = await collect.breakdown(body.url)
        broadcast({ kind: 'snapshot', state: await composeState() })
        sendJson(res, result.ok ? 200 : 409, result)
        return
      }
      sendJson(res, 404, { error: '没有这条路由' })
      return
    }

    if (path === '/template' && req.method === 'GET') {
      if (template === undefined) { sendJson(res, 404, { error: '布局模板未启用' }); return }
      sendJson(res, 200, await template.detail())
      return
    }

    if ((path === '/template/apply' || path === '/template/restore') && req.method === 'POST') {
      // 换整套布局、在用户盘上建文件夹、改窗位清单——一律只认本机(同 /layout、/files/*)。
      if (!trusted) { sendJson(res, 403, { error: '只能在本机切布局模板' }); return }
      if (template === undefined) { sendJson(res, 404, { error: '布局模板未启用' }); return }

      if (path === '/template/restore') {
        const restored = await template.restore()
        if (!restored.ok) { sendJson(res, 200, restored); return }
        broadcast({ kind: 'snapshot', state: await composeState() })
        sendJson(res, 200, restored)
        return
      }

      const text = await readBody(req)
      let body: unknown
      try { body = JSON.parse(text) } catch { sendJson(res, 400, { error: 'body 不是合法 JSON' }); return }
      const raw = (body ?? {}) as Record<string, unknown>
      const result = await template.apply(raw.id)
      // 认不出的 id 是**请求写错了**,给 400;建文件夹/登记应用那几件的失败不是接口错,
      // 它们在 200 的 body 里如实写着(同 /scene/save 那套"业务拒绝照样 200"的规矩)。
      if (!result.ok) { sendJson(res, 400, { error: result.reason ?? '切不过去' }); return }
      /**
       * ★ 切完**顺手把事务官的技能接上**(2026-09-22,卡 ①)。
       *
       * 切到自媒体运营模板 = 把那十段运营技能写进 `~/.dsh/AGENTS.md`;切回做产品 = 摘掉。
       * 在这之前这一步只能靠人去调一条没有按钮的接口,结果是"切了模板、事务官不知道有技能"。
       *
       * 放在 `template.apply` 之后而不是里面:模板服务管的是布局、文件夹与窗位,
       * 让它去写家目录里的 AGENTS.md 会把两件事的纪律搅在一起(那边没有备份那一套)。
       *
       * **失败不回滚切换**:布局已经换过去了,技能没接上只是这一次回包里多一句实话
       * (`ops_skills.error`),界面照着说 —— 同 `onApplied` 清缓存抛了也不拦切换那一条。
       */
      const ensured = await ensureOpsSkills().catch((error: unknown) => ({
        ok: false as const,
        error: error instanceof Error ? error.message : '接技能时出错了',
      }))
      broadcast({ kind: 'snapshot', state: await composeState() })
      sendJson(res, 200, {
        ...result,
        // 这台服务没接代写(既有那批用例)时整格缺席 —— 不摆一个"没接上"吓人。
        ...(ensured === undefined ? {} : { ops_skills: ensured }),
      })
      return
    }

    if (path.startsWith('/scene/') && req.method === 'POST') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机操作场景' }); return }
      if (scenes === undefined) { sendJson(res, 404, { error: '窗口编排未启用' }); return }
      const text = await readBody(req)
      let body: unknown
      try { body = JSON.parse(text) } catch { sendJson(res, 400, { error: 'body 不是合法 JSON' }); return }
      const raw = (body ?? {}) as Record<string, unknown>
      const id = typeof raw.id === 'string' && raw.id !== '' ? raw.id : undefined
      const name = typeof raw.name === 'string' ? raw.name : undefined

      if (path === '/scene/save') {
        if (id === undefined) { sendJson(res, 400, { error: 'id 必须是非空字符串' }); return }
        const result = await scenes.save(id)
        broadcast({ kind: 'snapshot', state: await composeState() })
        sendJson(res, 200, result)
        return
      }
      if (path === '/scene/restore') {
        if (id === undefined) { sendJson(res, 400, { error: 'id 必须是非空字符串' }); return }
        const report = await withActorNoteFor(req, 'scene.restore', () => scenes.restore(id))
        broadcast({ kind: 'snapshot', state: await composeState() })
        sendJson(res, 200, report)
        return
      }
      if (path === '/scene/create') {
        if (name === undefined) { sendJson(res, 400, { error: 'name 必须是字符串' }); return }
        const result = await scenes.create(name)
        broadcast({ kind: 'snapshot', state: await composeState() })
        sendJson(res, 200, result)
        return
      }
      if (path === '/scene/rename') {
        if (id === undefined || name === undefined) { sendJson(res, 400, { error: '需要 id 和 name' }); return }
        const ok = await scenes.rename(id, name)
        broadcast({ kind: 'snapshot', state: await composeState() })
        sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: '没有这个场景' })
        return
      }
      if (path === '/scene/delete') {
        if (id === undefined) { sendJson(res, 400, { error: 'id 必须是非空字符串' }); return }
        const ok = await scenes.remove(id)
        broadcast({ kind: 'snapshot', state: await composeState() })
        sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: '没有这个场景' })
        return
      }
      sendJson(res, 404, { error: '没有这个路径' })
      return
    }

    /**
     * 引导流程(2026-09-15,docs/设计-引导流程.md v2;交接 docs/交接-0915-引导流程后端.md)。
     * 四条:开会话 / 交答案 / 重来 / 补问新项目,外加一条 GET 给前台看全貌。
     * 写路由认「回环或已配对手机」(手机 App 就是引导的前台);**不过授权表的门**——授权表就是
     * 引导写出来的,拿它拦引导等于把钥匙锁在屋里。
     */
    if (path.startsWith('/onboarding') && (req.method === 'POST' || req.method === 'GET')) {
      if (onboarding === undefined) { sendJson(res, 404, { error: '引导未启用:没配 WORKBENCH_BUTLER_CWD(记忆所在仓库)' }); return }
      if (req.method === 'GET' && path === '/onboarding') { sendJson(res, 200, onboarding.detail()); return }
      /**
       * 引导简报(2026-09-18,手机引导改通话模式)。给**通道层的工人**用:它不进 DSH 会话、自己接话,
       * 所以要一次性把「阶段 / 要弄清的 / 能写的 key 与值的形状 / 引导技能全文 / 这一阶段的种子句出过声没有」
       * 交给它。只给本机与已配对的手机 —— 里头有引导技能与已答项,与 /onboarding/turns 同一条门。
       */
      /**
       * 各家客户端里各有几份记忆(2026-09-22,设置 → 体检与修复那颗按钮)。
       *
       * **只读、只数**:`readdir` / `lstat`,一个字节的正文都不读、不落盘,所以它
       * **不过授权表那道门**(拷那一下过)—— 要他决定「拷不拷」,总得先让他看见有几份。
       * 回包里带着授权现在是哪一档,界面据此决定那颗「拷」按不按得下去。
       *
       * 与简报同一条门:只给本机与已配对的手机 —— 里头是他电脑上有哪几家客户端。
       */
      if (req.method === 'GET' && path === '/onboarding/memories') {
        if (!trusted) { sendJson(res, 403, { error: '只能在本机或已配对的手机上看各家记忆' }); return }
        sendJson(res, 200, await onboarding.probeMemories())
        return
      }
      if (req.method === 'GET' && path === '/onboarding/brief') {
        if (!trusted) { sendJson(res, 403, { error: '只能在本机或已配对的手机上取引导简报' }); return }
        // 引导做完、落地单子还等他点头(2026-09-24 晚):工人据此别急着换回平时那套,留着 setup_apply 那件工具。
        sendJson(res, 200, { ...(await onboarding.brief()), ...(materialize === undefined ? {} : { setup: materialize.brief() }) })
        return
      }
      /** 落地那张单子(2026-09-24 晚)。/state.materialize 是同一份;这一条给 curl 那条路(电脑上的 DSH 会话)看全貌。 */
      if (req.method === 'GET' && path === '/onboarding/materialize') {
        if (!trusted) { sendJson(res, 403, { error: '只能在本机或已配对的手机上看落地单子' }); return }
        if (materialize === undefined) { sendJson(res, 404, { error: '这台工作台没接引导落地' }); return }
        const view = materialize.view()
        if (view === undefined) { sendJson(res, 404, { error: '还没排过单子,先 POST /onboarding/materialize/preview' }); return }
        sendJson(res, 200, view)
        return
      }
      /**
       * 引导会话的回合(2026-09-16,手机端):`?after=<seq>` 只回之后的;随带 busy(事务官在想)、
       * ended(会话没了,该重新 /onboarding/session)与阶段进度。对话内容只给本机与已配对手机。
       */
      if (req.method === 'GET' && path === '/onboarding/turns') {
        if (!trusted) { sendJson(res, 403, { error: '只能在本机或已配对的手机上看引导对话' }); return }
        const afterRaw = new URLSearchParams(queryOf(req.url)).get('after')
        const after = afterRaw === null || afterRaw === '' ? 0 : Number(afterRaw)
        if (!Number.isFinite(after) || after < 0) { sendJson(res, 400, { error: 'after 要是非负整数(上次拿到的最后一个 seq)' }); return }
        const detail = onboarding.detail()
        const status = onboardingTurns?.status() ?? { busy: false, ended: false }
        // 回合与扫描窗口在同一拍里读(中间没有 await):这一包里有她的新一句,窗口就一定已经收了。
        const turnList = onboardingTurns?.list(Math.floor(after)) ?? []
        const scan = scanView()
        sendJson(res, 200, {
          turns: turnList,
          ...status,
          stage: detail.stage,
          done: detail.done,
          // 当前阶段的种子句(2026-09-16 开场体验):阶段推进时手机先显示这句,模型补的话接在后面。
          ...(detail.next === undefined ? {} : { seed: detail.next.seed }),
          // 扫描进度(2026-09-23):**只报引导里她主动发起的那一次**(按名字找 / 「你帮我找找」),
          // 项目区自己每 30 秒的刷新不算。没接项目区就缺席。
          // 2026-09-24 傍晚起是「那一整段等待」的窗口(onboardingActivity.ts):从动手找到她下一句开口都是 scanning:true。
          ...(scan === undefined ? {} : { scan }),
          // 系统授权(辅助功能)那一步的信号(2026-09-23):界面据此在授权阶段亮「去授权」。
          system_auth: systemAuthView(detail.stage),
        })
        return
      }
      /**
       * 系统授权(辅助功能)现在开没开、这一阶段要不要问(2026-09-23)。模型在授权阶段先查一眼:
       * 开着就提一句跳过,没开才讲为什么要、问他。字段见 systemAuthView。
       */
      if (req.method === 'GET' && path === '/onboarding/system-auth') {
        if (!trusted) { sendJson(res, 403, { error: '只能在本机或已配对的手机上看系统授权' }); return }
        sendJson(res, 200, systemAuthView(onboarding.detail().stage))
        return
      }
      /**
       * 扫描进度(2026-09-23,维护者:「扫描要有进度」)。纯内存,读它不触发扫描。
       * `{ scanning, phase?: 'list'|'repos'|'read', done, total?, current?, started_at?, finished_at?, last_read? }`
       * (`read` = 读一个项目的说明和最近记录,2026-09-24),
       * 字段说明在 projectsService.ts 的 ScanProgress。没接项目区 → 503(不回一个「没在扫」冒充)。
       * 2026-09-24 傍晚起与 `turns.scan` 同一份窗口 view(多 `id` / `held` 两格,见 onboardingActivity.ts)。
       */
      if (req.method === 'GET' && path === '/onboarding/scan/status') {
        if (!trusted) { sendJson(res, 403, { error: '只能在本机或已配对的手机上看扫描进度' }); return }
        const scan = scanView()
        if (scan === undefined) { sendJson(res, 503, { error: '这台工作台没接项目区' }); return }
        sendJson(res, 200, scan)
        return
      }
      /**
       * 「到某一天还有几个工作日」(2026-09-20,Ben:「10 月 4 号,智能一点就该知道这是国庆」)。
       *
       * 表在 `holidays.ts`,**纯算**:不碰磁盘、不上网、不读系统日历。电话里她说到任何一个日期
       * 都先走这一条,**不自己心算** —— 模型算日期是出了名的会错,而这件事他一听就知道对不对。
       * `to` 必填;`from` 缺省今天。算不出来就 400 带一句人话,**不回一个 0**(D13)。
       */
      if (req.method === 'GET' && path === '/onboarding/workdays') {
        const query = new URLSearchParams(queryOf(req.url))
        const to = query.get('to') ?? ''
        const from = query.get('from') ?? new Date().toISOString().slice(0, 10)
        const counted = workdaysBetween(from, to)
        if (counted === undefined) {
          sendJson(res, 400, { error: `算不出来:from=${from}、to=${to} —— 要两个 YYYY-MM-DD 的真日期,而且 from 不能晚于 to` })
          return
        }
        const target = dayVerdict(to)
        sendJson(res, 200, { ...counted, ...(target === undefined ? {} : { target }) })
        return
      }
      if (req.method !== 'POST') { sendJson(res, 404, { error: '没有这个路径' }); return }
      if (!trusted) { sendJson(res, 403, { error: '只能在本机或已配对的手机上做引导' }); return }

      const text = await readBody(req)
      let body: unknown = {}
      if (text.trim() !== '') {
        try { body = JSON.parse(text) } catch { sendJson(res, 400, { error: 'body 不是合法 JSON' }); return }
      }
      const raw = (body ?? {}) as Record<string, unknown>

      if (path === '/onboarding/session') {
        /**
         * 开口之前先把"刚写进 DSH 的那份凭证"落实(2026-09-18,任务卡第 2 条)。
         *
         * DSH 的 `.env` 是**启动时**读进快照的,所以刚领到的令牌要重启一次那个进程才认 ——
         * 09-17 那一版是在界面上写一行 `launchctl kickstart -k …` 让用户自己去终端里跑。
         * Ben 是 PM,不写代码;"去终端里跑一行"对他等于这件事没做完。所以改由工作台自己来。
         *
         * 只在**没有会话在跑**的时候真重启(restartIfPending 里判):这一下会把工作台自己
         * 一起换掉(插件就住在 DSH 进程里),正在跑的活儿会当场没掉。
         * 真重启了就**不开这条会话** —— 开了也会跟着进程一起没,不如老老实实说一句
         * "十几秒后再点一次",而不是给他一条马上就断的会话。
         */
        // 不只看 restartPending():重启已经发出去、这个进程还没被换掉的那几秒里,它回的也是「正在重启」
        // (modelAutoSetup 的 restartFired),不在快没了的进程里开会话。没排重启时它当场回 not_pending。
        if (modelAutoSetup !== undefined) {
          const outcome = await modelAutoSetup.restartIfPending()
          if (outcome.restarted) {
            // 这次重启是为引导排的:新进程一起来就把会话先开出来(onboardingWarm.ts),他那句话不再等冷启动。
            await onboardingWarm?.mark()
            sendJson(res, 503, { error: outcome.note, restarting: true })
            return
          }
        }
        // 新进程刚替他把会话热起来了:直接交出去,不再往里说一遍「接着上次」(她会念两遍)。
        // 热起来之后阶段机变了(2026-09-24):那条的第一条消息是按旧阶段写的,不交它,另开一条按现在写的
        // (为什么另开、不往里补一句,见 onboardingWarm.ts 文件头)。
        const detailNow = onboarding.detail()
        const claimed = onboardingWarm?.claim(detailNow.session_id, progressMark(detailNow))
        if (claimed?.kind === 'warm') {
          sendJson(res, 200, {
            ok: true, stage: detailNow.stage, session_id: claimed.session_id, first_message: '',
            seed: detailNow.next?.seed ?? '', resumed: true, warmed: true,
          })
          return
        }
        const result = await openOnboardingSession(claimed?.kind === 'stale' ? { replace: claimed.session_id } : undefined)
        if (!result.ok) { sendJson(res, result.status, { error: result.error }); return }
        sendJson(res, 200, result)
        return
      }
      /**
       * 手机上用户说的一句话(2026-09-16):排进当前引导会话的队列。会话没开 / 已结束 / 说不进去都 409 带人话,
       * 手机据此重新 POST /onboarding/session 接着聊。文字进 DSH 会话日志,不进工作台日志。
       */
      /**
       * **他喊停:剩下的按默认记完,直接进页面**(2026-09-27,卡 OB)。
       *
       * 词表判在代码里(`wantsToSkipRest`),不靠模型自觉 —— 新 Air 上他连说「你好啰嗦啊」
       * 「快点让开」「我怎么还没进页面」,事务官还在依次问音乐、性格、取名。
       * 页面上**不加**「跳过引导」按钮(09-23 那条不变),只认他说出来的这一句。
       */
      if (path === '/onboarding/skip-rest') {
        const reason = typeof raw.reason === 'string' && raw.reason.trim() !== '' ? raw.reason.trim().slice(0, 80) : undefined
        const skipped = await onboarding.skipRest(reason)
        sendJson(res, 200, skipped)
        return
      }
      if (path === '/onboarding/say') {
        const text = typeof raw.text === 'string' ? raw.text.trim() : ''
        if (text === '') { sendJson(res, 400, { error: 'text 要是非空字符串' }); return }
        if (text.length > 4000) { sendJson(res, 400, { error: '一句话太长了(上限 4000 字)' }); return }
        const detail = onboarding.detail()
        if (detail.done) { sendJson(res, 409, { error: '引导已经完成,现在不用再说了。要重来用 POST /onboarding/restart。' }); return }
        /**
         * 他这一句是在喊停(「跳过」「快点」「让开」「我怎么还没进页面」)→ **先落地再说话**:
         * 剩下的按默认记完、阶段到「完成」,再把那一句连同「只回这一句、别再问」送进会话。
         * 判据是代码里的词表,模型没有酌情权。
         */
        if (wantsToSkipRest(text)) {
          const skipped = await onboarding.skipRest(text.slice(0, 40))
          const told = `[引导 · 他喊停了]他刚说:「${text}」。剩下的我已经按默认记完了,引导到此结束。`
            + `**你只回这一句,一个字都别多说、别再问任何问题**:「${skipped.line}」`
          let delivered = false
          const sessionId = detail.session_id
          if (sessionId !== undefined && butlerSession?.say !== undefined) {
            try { delivered = await butlerSession.say(sessionId, told) }
            catch { delivered = false }
          }
          sendJson(res, 200, { ok: true, skipped: true, done: true, line: skipped.line, delivered, ...(sessionId === undefined ? {} : { session_id: sessionId }) })
          return
        }
        let sessionId = detail.session_id
        if (sessionId === undefined) { sendJson(res, 409, { error: '引导会话还没开:先 POST /onboarding/session(手机上点「开始引导」)' }); return }
        /**
         * 这条会话上一轮以错误结束(2026-09-23:模型没接好时开的会话,provider 钉在坏路由上,
         * 往里说多少句都是 `no API key`)。先另开一条(第一条消息照旧「接着上次」),再把这句说进新的那条。
         * 新的也开不出来就照旧往老的里说 —— 至少回合表还会再报一次「模型没接上」,不静默。
         */
        // 回合表看见了错误但服务还没落盘(回调是异步的,或没接):先补记一笔,openSession 才认得它坏了。
        if (!onboarding.sessionBroken() && onboardingTurns?.status().failed === true && onboardingTurns.status().session_id === sessionId) {
          await onboarding.noteTurnEnd(sessionId, { ok: false })
        }
        if (onboarding.sessionBroken()) {
          const address = server.address()
          const listening = typeof address === 'object' && address !== null ? address.port : DEFAULT_PORT
          const reopened = await onboarding.openSession(butlerSession, `http://127.0.0.1:${listening}`)
          if (reopened.ok && reopened.session_id !== undefined) {
            onboardingTurns?.bind(reopened.session_id, reopened.first_message, reopened.seed)
            sessionId = reopened.session_id
          }
        }
        if (onboardingTurns?.status().ended === true) { sendJson(res, 409, { error: '这条引导会话已经结束:重新 POST /onboarding/session 接着聊' }); return }
        if (butlerSession?.say === undefined) { sendJson(res, 409, { error: '会话通道没接上,这句话说不进去:等工作台接上 DSH 再试' }); return }
        let accepted = false
        let rejection: 'model' | 'host' | undefined
        try { accepted = await butlerSession.say(sessionId, text, reason => { rejection = reason }) } catch { accepted = false }
        if (!accepted) {
          onboarding.clearNudge?.()
          sendJson(res, 409, rejection === 'model'
            ? { code: 'model_alignment_failed', error: '当前模型还没完成应用，这句话没有发送；请重试模型设置后接着聊。' }
            : rejection === 'host' ? { code: 'session_send_failed', error: '会话通道暂时不可用，这句话没有发送；请稍后重试。' }
            : { error: '这条引导会话在 DSH 里已经没了:重新 POST /onboarding/session 接着聊' })
          return
        }
        sendJson(res, 200, { ok: true, session_id: sessionId })
        return
      }
      /**
       * **真去扫一遍仓库**(2026-09-20,Ben 真机第二轮:「授权扫仓库,但是没去扫,
       * 大概意思是聊完了才能去扫」)。给通话里的工人用:它拿到 `read_scan_roots` 授权之后
       * 调这一条,拿回一份念得出来的仓库清单当②′ 的素材,不再一个一个凭空问。
       *
       * 三条纪律:
       *   ① **这一条认授权表的门**。/onboarding/* 其余几条故意不过它(授权表就是引导写出来的,
       *      拿它拦引导等于把钥匙锁在屋里);但这一条要去**读他的硬盘**,那正是
       *      `read_scan_roots` 这一项的字面意思。不是「可以」就 403 带那句人话。
       *   ② **复用项目区那一份扫描**(projectsService),不另起一套:电话里听到的
       *      「你有 13 个仓库」和电脑上项目区看到的必须是同一个 13。它自带 30 秒节流与
       *      single-flight,连着问几次不会把 git 打成拒绝服务。
       *   ③ 没接项目区就如实回 503 —— **不回一个空清单**,空清单会被模型读成「你一个仓库都没有」。
       */
      if (path === '/onboarding/scan') {
        // 门与读项目同一道(2026-09-24):新点子 / 运营那一支 403、没授权 403 带「先问后看」的用法。
        const blocked = await projectReadGate()
        if (blocked !== undefined) { sendJson(res, blocked.status, blocked.body); return }
        if (projects === undefined) { sendJson(res, 503, { error: '这台工作台没接项目区,扫不了仓库' }); return }
        const named = typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name.trim() : undefined
        if (named !== undefined && projects.locate === undefined) { sendJson(res, 503, { error: '这台工作台的项目区不支持按名字找' }); return }
        /**
         * 真动手的这一段放进「那一整段等待」的窗口(2026-09-24 傍晚,onboardingActivity.ts):
         * 按名字找、只找到一个时顺手读、按名字没找到退一步全量扫 —— 同一个请求里的几段算同一段,界面上不断。
         */
        const scanned = await inScanWindow(async (): Promise<{ status: number, body: unknown }> => {
          /**
           * 带 `name`(2026-09-23,维护者:「我只想录工作台这一个」):**只找这一个**,不全量扫 ——
           * 只列扫描根下的目录名,不跑 git、不读会话。回 `{ located: [{ name, path }], query, errors }`;
           * 一个都没找到就回空数组 + 一句人话,由模型再问他在哪、或者他说「你帮我找找」再全量扫。
           */
          if (named !== undefined && projects.locate !== undefined) {
            const query = named
            const found = await projects.locate(query)
            if (found.matches.length > 0) {
              surfacedPaths.add(found.matches.map(one => one.path))
              /**
               * 只找到一个(2026-09-24,已有项目拉齐):**顺手读好**,摘要随回包带回(省一个来回)。
               * 她用读到的内容问「是这个吗」,复述两句请他纠正 —— 用法在 note 里(与 project-brief 同一段)。
               * 读不成就照老样子只回名字与路径,note 里如实带一句。
               */
              if (found.matches.length === 1 && projectBriefOption !== undefined) {
                const read = await readBriefAt((found.matches[0] as { path: string }).path)
                if (read.status === 200) {
                  return {
                    status: 200,
                    body: {
                      query,
                      located: found.matches,
                      errors: found.errors,
                      brief: read.body.brief,
                      sources: read.body.sources,
                      ...(read.body.missing === undefined ? {} : { missing: read.body.missing }),
                      note: BRIEF_NOTE,
                    },
                  }
                }
                return {
                  status: 200,
                  body: {
                    query,
                    located: found.matches,
                    errors: found.errors,
                    note: `它的说明没读成(${String(read.body.error ?? read.status)}),别替它编。跟他对一句「是这个吗」;`
                      + '他确认之后,记 project 时把这里的 path 原样带上(project.path),项目区里就是同一行,不会多出一条。',
                  },
                }
              }
              return {
                status: 200,
                body: {
                  query,
                  located: found.matches,
                  errors: found.errors,
                  // 2026-09-23:引导录的「工作台」与项目区的 desktop-workbench 成了两行。带上 path,项目区里就是同一行。
                  note: found.matches.length === 1
                    ? '他确认「是这个」之后,记 project 时把这里的 path 原样带上(project.path),项目区里就是同一行,不会多出一条。'
                    : `找到 ${found.matches.length} 个像的:一句话把名字念给他挑(别念路径);`
                      + (projectBriefOption === undefined ? '' : '挑中之后带上它的 path 读一遍(POST /onboarding/project-brief {"path":"…"}),照回包里的 note 说;')
                      + '挑中的那个记 project 时把它的 path 原样带上。',
                },
              }
            }
            /**
             * 按名字没找到(2026-09-24 真机第五轮:「工作台」→ 没扫成,「work bench」→ 又没扫成,真仓库叫 desktop-workbench)。
             * 读目录的授权上面已经过了 —— 不再让他报路径,**自己退一步扫一遍**,把最近在动的前几个名字交给模型,
             * 让她一句话念给他挑。这一趟走引导自己的全量扫描(scanForOnboarding):进度照样推进,
             * 界面上的扫描进度 / 粒子工作态据此显示(`turns.scan`)。扫不成就退回老话:问他放在哪。
             */
            let candidates: OnboardingScanResult['repos'] = []
            try {
              const state = await (projects.scanForOnboarding ?? projects.getProjectsState)()
              candidates = scanResultOf(state, LOCATE_FALLBACK_CANDIDATES).repos
            }
            catch { candidates = [] }
            surfacedPaths.add(candidates.map(one => one.path))
            return {
              status: 200,
              body: {
                query,
                located: [],
                ...(candidates.length === 0 ? {} : { candidates }),
                errors: found.errors,
                note: candidates.length === 0
                  ? `在放仓库的目录里没找到叫「${query}」的,也没扫出别的仓库。问他一句它放在哪(说个大概位置就行)。`
                  : `按名字没找到「${query}」。这是最近在动的几个:${candidates.map(one => one.name).join('、')}。`
                    + '一句话把这几个名字念给他挑(别念路径、别让他报路径);'
                    + (projectBriefOption === undefined ? '' : '他挑中哪个,带上那个的 path 读一遍(POST /onboarding/project-brief {"path":"…"}),照回包里的 note 说;')
                    + '记 project 时把那个的 path 原样带上。',
              },
            }
          }
          let state: ProjectsState
          // 引导里的全量扫描走自己那一趟(2026-09-23):不看「引导没做完」那道门(授权门上面已经过了),
          // 不写项目区的缓存,进度只记这一趟。老的项目区实现没有它就退回共用那一份。
          try { state = await (projects.scanForOnboarding ?? projects.getProjectsState)() }
          catch (err) {
            return { status: 503, body: { error: `扫描没跑成:${err instanceof Error ? err.message : String(err)}` } }
          }
          const listed = scanResultOf(state)
          surfacedPaths.add(listed.repos.map(one => one.path))
          return { status: 200, body: listed }
        })
        sendJson(res, scanned.status, scanned.body)
        return
      }
      /**
       * **读一个项目**(2026-09-24,维护者 12:40:「我真的很需要她能扫仓库啊,不然我还得口述一遍吗」)。
       *
       * 给电话工人(`read_project`)与电脑上的 DSH 会话(curl)用:他从几个里挑中了、或者说「你再看看」时,
       * 带上找项目时回的那个 path 来读。回 `{ ok, name, path, brief, sources, missing?, note }` ——
       * brief 是有上限的摘要(说明 / 最近的设计 / 最近的交接 / 决策记录末尾 / 最近提交),note 是怎么复述的那段用法。
       *
       * 门与 /onboarding/scan 同一道(新点子 / 运营那一支 403、没授权 403);路径只认扫描根之下、项目区录过的、
       * 这一次找到过的,`..` / 符号链接跳出 / 不存在 一律拒。只读,不落盘。
       */
      if (path === '/onboarding/project-brief') {
        const blocked = await projectReadGate()
        if (blocked !== undefined) { sendJson(res, blocked.status, blocked.body); return }
        if (projects === undefined) { sendJson(res, 503, { error: '这台工作台没接项目区,读不了项目' }); return }
        // 读的这一段也在「那一整段等待」的窗口里(2026-09-24 傍晚,onboardingActivity.ts)。
        const read = await inScanWindow(async () => await readBriefAt(raw.path))
        sendJson(res, read.status, read.body)
        return
      }
      /**
       * 「这一阶段的种子句我已经念出去了」(2026-09-18)。通话里种子句由工人**直接**流式 TTS 说出来,
       * 不等模型;这条把它落盘,于是挂断再进来不会重说一遍(开场白只说一次)。
       * 顺手记 askedAt —— 那本来就是「事务官开过口」的意思,手机上那条横幅认的也是它。
       */
      if (path === '/onboarding/spoken') {
        const result = await onboarding.markSeedSpoken(raw.stage)
        if (!result.ok) { sendJson(res, result.status, { error: result.error }); return }
        broadcast({ kind: 'snapshot', state: await composeState() })
        sendJson(res, 200, result)
        return
      }
      /**
       * 谁主导引导(2026-09-18,Ben:「似乎电脑手机同时都能操作;如果手机已经扫码,优先手机的引导流程」)。
       *
       * 手机开始引导通话时由工人落 `phone`;人在电脑上按「改在电脑上做」落 `desktop`;
       * 手机上那颗「改回手机」也走这一条(它在房间代理的白名单里)。
       * **改的只是界面归属** —— 两端照旧共用同一份 onboarding.json,谁都写得进去。
       */
      if (path === '/onboarding/leader') {
        const result = await onboarding.setLeader(raw.leader)
        if (!result.ok) { sendJson(res, result.status, { error: result.error }); return }
        broadcast({ kind: 'snapshot', state: await composeState() })
        sendJson(res, 200, result)
        return
      }
      /**
       * 「把各家客户端里记的东西拷一份给事务官」(2026-09-21,②′ 那一问)。
       *
       * 与 `/onboarding/answer` 里 `import_memories: true` 是**同一件事**(阶段机里同一个函数):
       * 电话里工人手上只有 record_answer 一件工具,走那条;人在电脑上点按钮走这条。
       *
       * **这一条过授权表的门**(2026-09-22,Ben 定的 C5):`read_client_files` 不是「可以」
       * 就一个字节都不拷,回 `ok:false` + 那句原话,而且**不把这一问记成答过了**。
       * 那道门在 onboarding.ts 的 `clientFilesAllowed()`,两条路(电话 / 按钮)共用同一处。
       * 授权之外的护栏在 agentMemory.ts:只读、只收 .md、不出各家自己那个根、软链不跟。
       */
      /**
       * ——— 引导落地(2026-09-24 晚,卡 feat/onboarding-materialize;设计 docs/设计-引导落地-引导结束后的样子-2026-09-24.md) ———
       *
       * preview:读存档排一张「我照你说的摆好了」(不写看板,只存那张单子),回 `{ ok, plan }`;`plan.line` 是电话里那一句。
       * apply `{ id?, uncheck?, check?, edits?, skip? }`:他点「就这样」/ 电话里说「可以」才落。
       *   - 页面上的按钮(带 Origin)与手机(设备令牌)就是他本人的手,不拦;
       *   - 程序调(工人的 setup_apply、电脑上 DSH 会话的 curl)带着他刚才那句话:听着是不同意 → 409,别替他落。
       */
      if (path === '/onboarding/materialize/preview') {
        if (materialize === undefined) { sendJson(res, 404, { error: '这台工作台没接引导落地' }); return }
        const snapshot = await composeState()
        const result = await materialize.preview({
          force: raw.force === true,
          state: { quota_connect: (snapshot as unknown as Record<string, unknown>).quota_connect, clients: snapshot.clients, agent_caps: snapshot.agent_caps },
        })
        if (!result.ok) { sendJson(res, result.status, { error: result.error }); return }
        broadcast({ kind: 'snapshot', state: await composeState() })
        sendJson(res, 200, {
          ok: true,
          id: result.plan.id,
          line: result.plan.line,
          counts: result.plan.counts,
          source: result.plan.source,
          ...(result.plan.model_note === undefined ? {} : { model_note: result.plan.model_note }),
          reused: result.reused,
          plan: materialize.view(),
          note: '单子已经摆上屏了(电脑首页球下面、手机「等你确认」)。**只说 line 这一句**,别的不念、不复述、不念文件路径;'
            + '他说可以 / 就这样 → POST /onboarding/materialize/apply {"id":"<id>"};他说哪件不要 → apply 带 "skip":["那件的说法"];'
            + '他想改别的 → 说「你在屏幕上点改一下改,改完点就这样」;他说先不落 → 说一句「好,单子放在屏幕上,你想好了点就这样」。',
        })
        return
      }
      if (path === '/onboarding/materialize/apply') {
        if (materialize === undefined) { sendJson(res, 404, { error: '这台工作台没接引导落地' }); return }
        const origin = req.headers.origin
        if (!(typeof origin === 'string' && origin !== '') && device === undefined) {
          const evidence = exchangeFor(raw.heard)
          if (evidence !== undefined && !approvesSetup(evidence.exchange.reply)) {
            sendJson(res, 409, { error: `他刚才说的是「${evidence.exchange.reply.slice(0, 40)}」,听着没点头:先别落,问他要改哪一件(或者让他在屏幕上勾掉)。${NO_INTERNAL_TALK}` })
            return
          }
        }
        const strings = (value: unknown): string[] | undefined => Array.isArray(value) ? value.filter((one): one is string => typeof one === 'string') : undefined
        const edits = raw.edits !== null && typeof raw.edits === 'object' && !Array.isArray(raw.edits)
          ? raw.edits as Record<string, { title?: string, owner?: CardOwner, to?: string }>
          : undefined
        const result = await materialize.apply({
          ...(typeof raw.id === 'string' && raw.id !== '' ? { id: raw.id } : {}),
          ...(strings(raw.uncheck) === undefined ? {} : { uncheck: strings(raw.uncheck) as string[] }),
          ...(strings(raw.check) === undefined ? {} : { check: strings(raw.check) as string[] }),
          ...(strings(raw.skip) === undefined ? {} : { skip: strings(raw.skip) as string[] }),
          ...(edits === undefined ? {} : { edits }),
        })
        broadcast({ kind: 'snapshot', state: await composeState() })
        if (!result.ok) { sendJson(res, result.status, { error: result.error }); return }
        sendJson(res, 200, {
          ok: result.result.ok,
          id: result.plan_id,
          line: result.result.line,
          result: result.result,
          note: '照 line 那一句说,别的不念。',
        })
        return
      }
      if (path === '/onboarding/import-memories') {
        const imported = await onboarding.importMemories()
        broadcast({ kind: 'snapshot', state: await composeState() })
        sendJson(res, 200, imported)
        return
      }
      if (path === '/onboarding/answer') {
        const blocked = answerGuard(req, raw)
        if (blocked !== undefined) { sendJson(res, 409, { error: blocked }); return }
        // 他刚才那句(与凭据门同一份):阶段机拿它判「读了仓库、他只是点头」那几句的出处(2026-09-24 下午小修)。
        const heard = exchangeFor(raw.heard)?.exchange
        const result = await onboarding.answer({ stage: raw.stage, key: raw.key, value: raw.value, ...(heard === undefined ? {} : { heard }) })
        if (!result.ok) { sendJson(res, result.status, { error: result.error }); return }
        // 8791 第六轮第 4 轮:授权项(read_client_files 等)与项目目录项的回答会改「能不能读 / 从哪读」,
        // 走 notifyChanged 触发对账(2 秒事件节拍)——撤权那一拍把快照里的来源置未知、移除旧运行会话。
        if (typeof raw.key === 'string' && (isAuthKey(raw.key) || raw.key === 'project' || raw.key === 'idea'
          || raw.key === 'account' || raw.key === 'scan_roots' || raw.key === 'read_scan_roots')) {
          reconcileExecutions?.notifyChanged()
        }
        /**
         * 收尾那一问「要不要每天早上给你一段资讯播客」(2026-09-21)要**真的落到开关上**。
         *
         * 只写这一个字段(`podcast`),不碰 enabled、不碰关键词:他答的就是"要不要那段音频",
         * 不是"要不要资讯"。写失败不影响引导 —— 那是设置里能自己改的一个开关,
         * 不该因为它让收尾这一步整步失败。
         */
        if (raw.stage === 'wrapup' && raw.key === 'feed_podcast' && typeof raw.value === 'boolean' && feed !== undefined) {
          try { await feed.setConfig({ podcast: raw.value }) }
          catch { /* 设置里还能改 */ }
        }
        // 阶段推进:回合表换成下一阶段的种子句(模型接着照念的那条才标得上 kind:seed)。
        if (result.advanced) onboardingTurns?.setStageSeed(result.next?.seed)
        /**
         * 引导落地(2026-09-24 晚):进收尾就在后台先把模型那一份问好(卡片抽取),做完那一刻就把单子摆上屏 ——
         * 她不调 setup_preview、他挂了电话,手机「等你确认」里照样有这张单子。回包多一格 `setup_next`:工人与 DSH 会话据此接着调预览。
         */
        let setupNext = false
        if (materialize !== undefined) {
          if (result.advanced && result.stage === 'wrapup') materialize.warm()
          if (result.done && materialize.brief().applied !== true) {
            setupNext = true
            void composeState()
              .then(snapshot => materialize.preview({ state: { quota_connect: (snapshot as unknown as Record<string, unknown>).quota_connect, clients: snapshot.clients, agent_caps: snapshot.agent_caps } }))
              .then(async () => { broadcast({ kind: 'snapshot', state: await composeState() }) })
              .catch(() => undefined)
          }
        }
        broadcast({ kind: 'snapshot', state: await composeState() })
        sendJson(res, 200, setupNext ? { ...result, setup_next: true } : result)
        return
      }
      /**
       * **改一项已经答过的**(2026-09-20,Ben:「包括它说不能改,我当时一度想要停下」)。
       *
       * 与 /onboarding/answer 的差别全在阶段机里(不看当前阶段、不推进阶段、必须先答过),
       * 这一层只多做一件事:改称呼会动记忆文件名与 AGENTS.md 的标记段,所以照旧广播一次快照。
       * **引导做完了也走得通** —— 「称呼记错了」不会因为引导做完就不算数。
       */
      /**
       * 授权阶段「系统授权(辅助功能)」那一下(2026-09-23)。与 `/setup/open {pane:'accessibility'}` 同一件事
       * (先让壳弹系统框、再打开设置页),差别只在**谁按的**:这一条给引导会话里的她用 ——
       * 她讲清为什么要、他点了头,她替他按这一下。所以同样过对话凭据门:没问出口、他没点头就 409。
       * 界面上那颗「去授权」按钮照旧走 /setup/open(那是他自己的手)。
       */
      if (path === '/onboarding/system-auth') {
        if (!loopback) { sendJson(res, 403, { error: '只能在本机打开系统设置' }); return }
        const view = systemAuthView(onboarding.detail().stage)
        if (view.accessibility === 'granted') { sendJson(res, 200, { ok: true, already: true, note: '辅助功能已经开着了,跟他说一句不用再弄。' }); return }
        const blocked = answerGuard(req, { stage: 'authorization', key: 'system_accessibility', value: true, heard: raw.heard })
        if (blocked !== undefined) { sendJson(res, 409, { error: blocked }); return }
        if (setup === undefined) { sendJson(res, 503, { error: '这台工作台没接体检那一摊,打不开系统设置。让他点屏幕上的「去授权」。' }); return }
        if (helper !== undefined && helper.connected() && !helper.view().authorized) {
          await helper.request({ op: 'request_accessibility' }, 3_000).catch(() => undefined)
        }
        const opened = await setup.openPane('accessibility')
        if (!opened.ok) { sendJson(res, 500, { error: opened.error }); return }
        sendJson(res, 200, { ok: true, note: '系统设置已经打开了。跟他说:系统要是弹了框就点「打开系统设置」,在列表里把「工作台」的开关打开;回到工作台会自己复查。' })
        return
      }
      if (path === '/onboarding/correct') {
        const result = await onboarding.correct({ stage: raw.stage, key: raw.key, value: raw.value })
        if (!result.ok) { sendJson(res, result.status, { error: result.error }); return }
        broadcast({ kind: 'snapshot', state: await composeState() })
        sendJson(res, 200, result)
        return
      }
      if (path === '/onboarding/restart') {
        if (!(RESTART_SCOPES as readonly unknown[]).includes(raw.scope)) {
          sendJson(res, 400, { error: `scope 要 ${RESTART_SCOPES.join(' / ')} 之一` })
          return
        }
        const result = await onboarding.restart(raw.scope as RestartScope)
        onboardingTurns?.reset()
        broadcast({ kind: 'snapshot', state: await composeState() })
        sendJson(res, 200, result)
        return
      }
      if (path === '/onboarding/project') {
        if (typeof raw.name !== 'string' || raw.name.trim() === '') { sendJson(res, 400, { error: 'name 必须是非空字符串' }); return }
        const added = await onboarding.noticeProjects([raw.name], { explicit: true })
        sendJson(res, 200, { ok: true, added, supplement: onboarding.detail().supplement })
        return
      }
      sendJson(res, 404, { error: '没有这个路径' })
      return
    }

    /**
     * 事务官的日常例程(2026-09-15)。两条写路由,都只对本机与已配对设备开:
     * - POST /routine/run { name }:手动跑一条(Ben 说「下班」就是这条)。同一例程在跑时 409,不排队。
     * - POST /routine/config { morning?, evening?, lint?, repo? }:部分更新 routines.json(设置面板用)。
     * 结果都在 /state.routines 里;收件箱那一档由 composeState 现拼。
     */
    if (path.startsWith('/routine/') && req.method === 'POST') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机或已配对的手机上操作例程' }); return }
      if (routines === undefined) { sendJson(res, 404, { error: '例程未启用' }); return }
      const text = await readBody(req)
      let body: unknown
      try {
        body = JSON.parse(text === '' ? '{}' : text)
      } catch {
        sendJson(res, 400, { error: 'body 不是合法 JSON' })
        return
      }
      const raw = (body ?? {}) as Record<string, unknown>
      if (path === '/routine/run') {
        if (typeof raw.name !== 'string' || !(ROUTINE_NAMES as readonly string[]).includes(raw.name)) {
          sendJson(res, 400, { error: `name 必须是 ${ROUTINE_NAMES.join(' / ')} 之一` })
          return
        }
        const result = await routines.run(raw.name as RoutineName, 'manual')
        if (!result.ok) { sendJson(res, 409, { error: result.reason }); return }
        // run() 里已经 onChanged → 广播过一次;这里再回给调用方那一条记录。
        sendJson(res, 200, { ok: true, run: result.run })
        return
      }
      if (path === '/routine/config') {
        const config = await routines.setConfig(raw)
        broadcast({ kind: 'snapshot', state: await composeState() })
        sendJson(res, 200, { ok: true, config })
        return
      }
      sendJson(res, 404, { error: '没有这个路径' })
      return
    }

    /**
     * 建一条「我交给事务官」的事项(2026-09-10 事项收件箱)。
     *
     * **为什么不复用 /task/create**:那条路由是看板的手动建卡,建完就完了;这条要多做一件
     * 有副作用的事——在 DSH 里开一条会话并把事项文本发出去(一事项一会话)。把"开会话"
     * 挂在 /task/create 上,等于以后每一次手建卡都可能悄悄开出一条会话来,那是另一回事。
     *
     * **开不出会话时事项照常建**:回 200 + `note:'会话未开'`,状态留在待办。伪装成
     * 「事务官在办」是这里最坏的一种失真——他会等一件根本没人在做的事(D13)。
     */
    /**
     * 接续契约的几个现成判据(2026-10-23,卡 A):外部会话能不能捎与 digest 里 relay 那一格
     * 同一个出处;事务官会话那道梯就是 {@link sayIntoTaskConversation} 头上那两道。
     * (const 要在下面两条路由**之前**初始化:路由体在运行时才碰它,但同一函数体内 const 不提升。)
     */
    const itemContinueEnv: ContinueEnv = {
      butlerSayReady: () => butlerSession?.say === undefined
        ? { ok: false, why: '会话通道没接上,这句话说不进去' }
        : { ok: true },
      relayReady: (agent, sessionId) => sessionAnswer?.relayReady(agent, sessionId),
      sessionTitle: (agent, sessionId) =>
        relaySessionPool().find(one => one.agent === agent && one.session_id === sessionId)?.title,
    }

    /**
     * GET /butler/item/:id/turns?limit=20(2026-09-15,交接-0914-butler-app 第五节第 1 条)。
     * 手机端事务官要念的那段对话:该事项底下那条 DSH 会话最近几个回合,正文已去掉工具调用与代码块。
     *
     * 门与 POST /butler/item 同一道(回环或已配对设备;非本机裸请求在鉴权那一段就 401 了)。
     * 三种 404 各说各的原因,不混:事项不存在 / 事项建了但会话没开 / 会话 DSH 这边已经没了。
     * limit 默认 20、上限 100;不是正整数就按默认——参数错了不该让手机什么都拿不到。
     */
    const turnsMatch = req.method === 'GET' ? /^\/butler\/item\/([^/]+)\/turns$/.exec(path) : null
    if (turnsMatch !== null) {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机或已配对的手机上看事项对话' }); return }
      if (tasks === undefined) { sendJson(res, 404, { error: '任务看板未启用' }); return }
      if (sessionTurns === undefined) { sendJson(res, 404, { error: 'DSH 会话未接线' }); return }
      let itemId: string
      try {
        itemId = decodeURIComponent(turnsMatch[1] ?? '')
      } catch {
        sendJson(res, 400, { error: '事项 id 不合法' })
        return
      }
      const task = (await tasks.list()).tasks.find(candidate => candidate.id === itemId)
      if (task === undefined) { sendJson(res, 404, { error: '没有这个事项' }); return }
      if (task.conversation === undefined) { sendJson(res, 404, { error: '会话未开' }); return }
      const turns = sessionTurns(task.conversation.session_id, turnsLimit(req.url))
      if (turns === undefined) { sendJson(res, 404, { error: '没有这个会话' }); return }
      // 她说的那几句洗掉 markdown 记号再给他看(卡 M 补,同 /state 那一个出口);他自己说的原样。
      sendJson(res, 200, { session_id: task.conversation.session_id, turns: turns.map(turn => (turn.role === 'assistant' ? { ...turn, text: plainForHim(turn.text) } : turn)) })
      return
    }

    /**
     * GET /butler/item/:id/continue(2026-10-23,卡 A「同事项接续与动作契约」):这件事现在能从哪儿接着做。
     * 来源只有两类:它自己的事务官会话 + `links` 里的外部会话(与 `TaskLink` 同一个键),不另建来源账;
     * 每条来源带**动作**(能续 / 这会儿为什么续不了,why 与真发话回的那一句同一个出处)。
     * 电脑事项详情与手机下级页同一个口;门同 `/butler/item/:id/turns`。
     */
    const continueMatch = req.method === 'GET' ? /^\/butler\/item\/([^/]+)\/continue$/.exec(path) : null
    if (continueMatch !== null) {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机或已配对的手机上看事项' }); return }
      if (tasks === undefined) { sendJson(res, 404, { error: '任务看板未启用' }); return }
      let itemId: string
      try {
        itemId = decodeURIComponent(continueMatch[1] ?? '')
      } catch {
        sendJson(res, 400, { error: '事项 id 不合法' })
        return
      }
      const task = (await tasks.list()).tasks.find(candidate => candidate.id === itemId)
      if (task === undefined) { sendJson(res, 404, { error: '没有这个事项' }); return }
      const sources = continueSourcesOf(task, itemContinueEnv)
      sendJson(res, 200, {
        id: task.id,
        sources,
        ...(sources.length > 0
          ? {}
          : { note: '这件事没有连着能接续的会话 —— 可以只留一句记在卡上,会话从「各家对话」里开。' }),
      })
      return
    }

    /**
     * **能捎话 / 能认名字的那几条会话**(2026-09-28,卡 WR)= `/state.sessions` 那几条文件型会话
     * **加上窗口型各家登记表里那几条对话**(`window:<hash>`)。
     *
     * 统筹 09-28 早真机:`POST /sessions/relay {agent:'manus', session_id:'window:825f1900'}` 回
     * 「那条会话不在了」、`{who:'Manus 的 DramaWise'}` 回「没认出…(这会儿有 4 条)」——
     * 两处都是因为只看了 `/state.sessions`(那 4 条是文件型的)。认名字(`matchRelaySession`)、
     * 看一眼(`/sessions/lookup`)、真捎话(`sessionAnswer.relay`)现在认的是**同一份池子**。
     */
    function relaySessionPool(): readonly RelaySessionView[] {
      const own = service.getState().sessions
      const windows = windowRelaySessions()
      // ★ CLI 派活起的会话同池(2026-10-24 Minor①):认名字/来源标题与 relay 同一批,不然标题回退「X 的会话」。
      const cli = cliDispatchSessions()
      if (windows.length === 0 && cli.length === 0) return own
      const seen = new Set(own.map(one => `${one.agent}\u0000${one.session_id}`))
      return [...own, ...[...windows, ...cli].filter(one => !seen.has(`${one.agent}\u0000${one.session_id}`))]
    }

    /** 窗口型各家登记表里那几条对话(只在登记表里的:读窗口的、读它自己记录的;见 `registryOnlySession`)。 */
    function windowRelaySessions(): readonly RelaySessionView[] {
      const entries = agents?.view().entries ?? []
      const out: RelaySessionView[] = []
      for (const entry of entries) {
        for (const one of entry.sessions) {
          if (!registryOnlySession(one)) continue
          out.push(one)
        }
      }
      return out
    }

    /**
     * 这一家**在人话里叫什么**(2026-09-28,卡 WR;卡 FX 的「先认家」也认这一份)。
     *
     * 窗口型各家的会话 `agent` 是**登记表条目 id**(多数就是包标识),`sessionAgentName` 只认写死那几家、
     * 会把「com.bot.pc.doubao」原样念出来。所以两级:
     * 1. 这个条目的包在**派活那张家名表**里(豆包 / Manus / Muse …)→ 用**那一家的正名**
     *    (与派活、电话、卡 FX 的 `spokenFamilies` 同一个名字 —— 不然「豆包」认成家之后,
     *    按家名筛会筛不到登记表里那条叫「豆包办公」的);
     * 2. 不在那张表里(Grok Bot / Antigravity 这类运行时发现的)→ 用登记表里的显示名。
     */
    function relayAgentName(agent: string): string {
      const entry = agents?.view().entries.find(one => one.id === agent)
      const family = entry?.bundle_id === undefined ? undefined : bindingForBundle(entry.bundle_id)?.agent
      if (family !== undefined) return sessionAgentName(family)
      const name = entry?.name?.trim()
      return name === undefined || name === '' ? sessionAgentName(agent) : name
    }

    /**
     * 登记表 id / 家名 → **家名**(`com.work.pc.doubao` 与 `doubao` 都认成 `doubao`)。
     * 捎话轻账上记的是家名(新开一条那一路)或登记表 id(捎进已有对话那一路),「看一眼」要把两边对上。
     */
    function relayFamilyOf(agent: string): string {
      if (bindingFor(agent) !== undefined) return agent
      const entry = agents?.view().entries.find(one => one.id === agent)
      const bundle = entry?.bundle_id ?? agent
      return bindingForBundle(bundle)?.agent ?? agent
    }

    /**
     * ★ **把一句补话说进这条事项的 DSH 会话**(2026-10-23,卡 A):`/butler/item/say` 与
     * `/butler/item/continue` 同一道梯,**一处实现** —— 两种说不进去的原因(没开会话 /
     * 通道没接 / 会话没了)由这里统一翻,两个路由各自说成自己的那一档(HTTP 状态 / 结果事实)。
     *
     * ★ 2026-10-23 晚(吸收 main 787f4d8f8,Key 最终):**完整继承最终拒发分类** ——
     * `butlerSession.say` 的第三个回调按本次调用区分 `'model' | 'host'`
     * (`butlerItem.ts` 的契约:model = 模型还没完成应用,host = 会话通道暂不可用;
     * 两种都**没有发送**,零新卡 / 零新会话 / 零 prompt,原事项和会话保留);
     * 会话不存在 = 只回 false、不给分类(老边界,不许降级新建)。
     *
     * ★ 2026-10-26(卡「事务官机制A」)第三参 `{intent}`:四意图的落地**只在这一处**(撤回除外,
     * 见 recallSettleOnCard):改方向 / 撤回先作废队列里经工作台递进去的旧句(旧队列不复活,
     * 读不清/清不动就拒 stale-queue,宁可原样不动);改方向 / 加速在跑才 steer、没在跑退化 queue;
     * 撤回只停轮+清队列、**一个字不进会话**(递了等于又把它叫醒),交代写在卡上。
     * `interrupted` = 发送前这条会话在跑、这句以 steer 打断进去(回执照实说「打断 / 没在跑」)。
     */
    async function sayIntoTaskConversation(
      task: TaskView,
      say: string,
      opts?: { intent?: ItemSayIntent },
    ): Promise<
      | { ok: true, session_id: string, interrupted?: boolean, cancelledRunning?: boolean, wasRunning?: boolean, cleared?: readonly string[] }
      | { ok: false, why: 'no-conversation' | 'no-channel' | 'gone' | 'model' | 'host' | 'cancel-failed' | 'stale-queue' | 'evidence-refused', cancelWhy?: string | undefined, cancelledRunning?: boolean, partial?: { removed: readonly string[], remaining: readonly string[] }, evidencePersisted?: boolean }
    > {
      if (task.conversation === undefined) return { ok: false, why: 'no-conversation' }
      if (butlerSession?.say === undefined && (opts?.intent ?? 'supplement') !== 'recall') return { ok: false, why: 'no-channel' }
      const intent = opts?.intent ?? 'supplement'
      const plan = intentPlanOf(intent)
      const sessionId = task.conversation.session_id
      const wasRunning = butlerSession?.running?.(sessionId)
      // 撤回:先把在跑的那一轮停住(cancel 走 keepInbox,上游已核)。在跑但停不住:
      // **后续一律不做** —— 停轮是最重的那一下,停不住就什么都没发生,如实回。
      let cancelledRunning: boolean | undefined
      if (plan.cancelFirst && wasRunning !== false) {
        const cancelled = await butlerSession?.cancel?.(sessionId).catch(() => ({ ok: false as const, why: '停会话那一下没应答' }))
        if (wasRunning === true && cancelled?.ok !== true) {
          return { ok: false, why: 'cancel-failed', cancelWhy: cancelled?.why }
        }
        cancelledRunning = cancelled?.ok === true && cancelled.running === true
      }
      // 改方向 / 撤回:先作废队列里**这条事项自己**的旧句(按 taskId 精确认,别的事项保留;
      // 读不清/清不动 → stale-queue 拒:怕旧方案在新方向之后复活,宁可这句不送)。
      // ★ 顺序钉死(二轮验收):将要作废的原文**先写进卡**(证据回调),写不进就一条不摘
      // (evidence-refused —— 没凭据不动手);部分失败时终证**等落盘**再回,落不进也照实说
      // (evidencePersisted:false,但原文已在先留证里、进度可恢复)。
      let cleared: readonly string[] | undefined
      if (plan.clearFirst) {
        if (butlerSession?.clearQueued === undefined) {
          return { ok: false, why: 'stale-queue', ...(cancelledRunning === undefined ? {} : { cancelledRunning }) }
        }
        const result = await butlerSession.clearQueued(sessionId, task.id, async (texts) => {
          if (texts.length === 0) return true
          const wrote = await tasks?.comment(task.id, {
            by: commentByOf(),
            text: [
              `【${plan.label} · 事项 ${task.id}】动手前先留证:以下 ${texts.length} 句排队旧话即将作废,原文留存 —— 一句不丢。`,
              ...texts.map(one => `· ${one}`),
            ].join('\n'),
            intent,
          }).then(one => one.ok).catch(() => false)
          return wrote === true
        }).catch(() => undefined)
        if (result === undefined) {
          return { ok: false, why: 'stale-queue', ...(cancelledRunning === undefined ? {} : { cancelledRunning }) }
        }
        if (result.refused === 'evidence') {
          // 证据没落盘,一条都没摘(队列原样):照实回,不谎称作废、不谎称留证。
          return { ok: false, why: 'evidence-refused', ...(cancelledRunning === undefined ? {} : { cancelledRunning }) }
        }
        cleared = result.removed
        if (result.incomplete) {
          const evidencePersisted = await noteQueueClearEvidence(task, intent, { removed: result.removed, remaining: result.remaining }, commentByOf())
          return { ok: false, why: 'stale-queue', partial: { removed: result.removed, remaining: result.remaining }, evidencePersisted, ...(cancelledRunning === undefined ? {} : { cancelledRunning }) }
        }
      }
      // 撤回:不进会话(递了等于又把它叫醒跑一轮);交代写在卡上(路由层 settle)。
      if (plan.noSay) {
        return { ok: true, session_id: sessionId, ...(wasRunning === undefined ? {} : { wasRunning }), ...(cancelledRunning === undefined ? {} : { cancelledRunning }), cleared: cleared ?? [] }
      }
      if (butlerSession?.say === undefined) return { ok: false, why: 'no-channel' }
      const outgoing = plan.frame(task.id, say) ?? say
      // 没在跑:steer 没有意义(没有要打断的),退化成 queue —— 空闲时两种模式都等于开头。
      const mode = plan.mode === 'steer' && plan.fallbackQueueWhenIdle && wasRunning === false ? 'queue' : plan.mode
      let accepted = false
      let rejection: 'model' | 'host' | undefined
      try { accepted = await butlerSession.say(sessionId, outgoing, reason => { rejection = reason }, { mode, taskId: task.id }) } catch { accepted = false }
      if (accepted) return { ok: true, session_id: sessionId, interrupted: mode === 'steer' && wasRunning === true, ...(wasRunning === undefined ? {} : { wasRunning }), ...(cancelledRunning === undefined ? {} : { cancelledRunning }), ...(cleared === undefined ? {} : { cleared }) }
      // 会话不存在仍只回 false(没有 onRejected)—— 老边界:不许借「说进去」偷开新会话。
      return { ok: false, why: rejection === 'model' ? 'model' : rejection === 'host' ? 'host' : 'gone' }
    }

    /**
     * 撤回收尾(2026-10-26,卡「事务官机制A」):卡上带框留言(intent 结构化留痕,清掉的旧句
     * 附在同一格里 —— **一句不丢**),并把卡挪回待排(blocked 那档进路退一格到 todo;
     * 收场的卡由路由先挡住)。`/butler/item/say` 与 `/butler/item/continue` 同一处。
     */
    async function recallSettleOnCard(
      task: TaskView,
      text: string,
      cleared: readonly string[],
      by: string,
    ): Promise<{ moved: boolean }> {
      const frame = intentPlanOf('recall').frame(task.id, text) ?? text
      const withCleared = cleared.length > 0
        ? `${frame}\n—— 撤回前还排着 ${cleared.length} 句旧话,已一并作废留存:\n${cleared.map(one => `· ${one}`).join('\n')}`
        : frame
      await tasks?.comment(task.id, { by, text: withCleared, intent: 'recall' }).catch(() => undefined)
      const target = task.status === 'blocked' ? 'todo' : 'backlog'
      const moved = await tasks?.move(task.id, target).catch(() => ({ ok: false as const }))
      return { moved: moved?.ok === true }
    }

    /** 留言「谁说的」按 asker 认(与 record 档同口径)。 */
    function commentByOf(): string {
      return asker === 'page' || asker === 'device' ? 'me' : asker === 'butler' ? 'butler' : 'agent'
    }

    /**
     * 清队列**部分失败**的终证留言(2026-10-26 验收修复;二轮:必须**等它落盘**再回响应,
     * 回 false = 终证没写进 —— 调用方照实说,但原文已在「先留证」里、进度可恢复)。
     * updateQueue 可能摘一条成、下一条抛 —— 已摘/没摘的原文都留在卡上同一条(一句不丢),
     * 重试先清剩下的;重启动安全:证据在卡上不在内存。
     */
    async function noteQueueClearEvidence(
      task: TaskView,
      intent: ItemSayIntent,
      partial: { removed: readonly string[], remaining: readonly string[] },
      by: string,
    ): Promise<boolean> {
      const label = intentPlanOf(intent).label
      const lines = [
        `【${label} · 事项 ${task.id}】清队列没清完,进度照实留在卡上:`,
        ...partial.removed.map(one => `· 已作废:${one}`),
        ...partial.remaining.map(one => `· 没清动(原文留存,重试先清它):${one}`),
      ]
      const wrote = await tasks?.comment(task.id, { by, text: lines.join('\n'), intent }).then(one => one.ok).catch(() => false)
      return wrote === true
    }

    /**
     * 他对这件事又补了一句要记的账(2026-10-23,卡 A):行为账、刚动过手(不打电话)、
     * 通话挂账、他明说的规矩 —— `/butler/item/say` 与 `/butler/item/continue` 同一处,不各写一遍。
     * 2026-10-26(卡「事务官机制A」):带意图时行为账「结果」记意图(改方向 / 催一下 / 撤回),
     * 让这张卡的账上四意图可区分;补充仍记「补一句」(旧账逐字不变)。
     */
    function noteHandedToItem(
      req: IncomingMessage,
      device: DeviceView | undefined,
      behaviorEnd: BehaviorEnd | undefined,
      task: TaskView,
      say: string,
      channel: string | undefined,
      intent?: ItemSayIntent,
    ): void {
      if (behaviorEnd === '电脑' || behaviorEnd === '手机') {
        noteBehavior({ 事: BEHAVIOR_EVENTS.say, 对象: `${task.id} ${task.title}`, 结果: intent === undefined ? '补一句' : intentPlanOf(intent).label, 原话: say }, behaviorEnd)
      }
      callOut?.touch?.(task.id)
      noteCallItem(behaviorEnd, task.id, 'said')
      if (rules !== undefined) {
        const ruleSaid = explicitRuleOf(say)
        if (ruleSaid !== undefined) {
          void rules.add({ text: ruleSaid, channel: ruleChannelOf(req, device, channel, 'call'), said: say, where: task.id }).catch(() => undefined)
        }
      }
    }

    /**
     * ★ **答上了就把排着的那一通撤掉**(2026-09-28,卡 AQ;2026-10-02 **五处收成一处** ——
     * 审计第二表第 11 条:从前 `/asks/*` 那四条各写一遍,而 `/sessions/answer` 压根不撤、等下一拍)。
     *
     * 真机 18:0x:她在电脑上答了(`confirmed:true`),可 `call-out.json` 里那一通还挂着 `queued`
     * (房里没有在线手机、没响)—— 等手机上线就要为一个**已经答掉的问**打过去。
     *
     * 两条纪律没动:
     * - **核实过才撤**(`confirmed`):点了没看到它收下的,那一问可能还在等她;
     * - **正在响的撤不回来**(`callOut.drop` 自己只撤 `queued` 那几通,如实回 `dropped:0`)。
     */
    async function dropQueuedAsk(itemId: string, confirmed: boolean): Promise<void> {
      if (!confirmed) return
      await callOut?.drop?.({ reason: 'ask', item_id: itemId }).catch(() => ({}))
    }

    /** 捎话账上这一家最近那一条的人话(故障 ③;没有就 undefined)。 */
    function relayLedgerLine(family: string): string | undefined {
      if (relayWatch === undefined) return undefined
      return relayLedgerLineOf(relayWatch.list(), agent => relayFamilyOf(agent) === family, Date.now())
    }

    /**
     * GET /sessions/digest?agent=claude&id=<会话 id>(2026-09-25,卡 P;维护者:「事务官中并没有显示会话的标题和内容」)。
     * 点开一条「某家在跑的会话」:标题、在哪个项目、最近在做什么、最近几轮 —— **当场读**那条会话的记录(头尾各一段),
     * 不经模型、不落盘。电脑事务官页与手机「在办」同一个口。
     *
     * 门同 `/butler/item/:id/turns`(回环或已配对的手机):他在自己的屏上看自己的会话。
     * 只认各家接入登记过的会话(按会话 id 找文件,**不收路径**),认不出 / 读不到 → 404 + 一句人话。
     */
    if (req.method === 'GET' && path === '/sessions/digest') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机或已配对的手机上看会话' }); return }
      const query = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams
      const agent = query.get('agent') ?? ''
      const id = query.get('id') ?? ''
      const codex = await codexLinkedSource(agent, id)
      if (codex !== undefined) {
        if (!codex.ok) { sendJson(res, codex.status, { error: codex.error }); return }
        const digest = await readSessionDigest(codex.ref, { finalReply: 'excerpt' })
        if (digest === undefined) { sendJson(res, 404, { error: '这条 Codex 会话记录暂时读不到，过一阵再来' }); return }
        sendJson(res, 200, { agent, session_id: id, title: digest.title, rounds: digest.rounds, read_at: new Date().toISOString(), ...(sessionAnswer?.relayReady(agent, id) === undefined ? {} : { relay: sessionAnswer.relayReady(agent, id) }) })
        return
      }
      if (sessionDigest === undefined) {
        // 读口未接线也有 CLI 回退(task.links 登记的 Kimi CLI 来源不依赖桌面登记表)。
        const cliOnly = await cliSourceRead(agent, id).catch(() => ({ kind: 'not_linked' as const }))
        if (cliOnly.kind === 'ok') {
          sendJson(res, 200, { agent, session_id: id, title: 'CLI 派活会话', rounds: cliOnly.turns.slice(-6), rounds_note: 'CLI 派活的那条会话:从它的记录文件现读', read_at: cliOnly.read_at })
          return
        }
        sendJson(res, 404, { error: '会话读取未接线' })
        return
      }
      // 哪一家按字符串认(不收窄成固定几家,卡 Q 自动发现的也走这里);只挡明显不像 id 的输入。
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(agent) || id === '' || id.length > 200) {
        sendJson(res, 400, { error: '要带上是哪一家(agent)和哪条会话(id)' })
        return
      }
      // 读窗口读出来的那一条(卡 Q:登记表里没有会话记录文件的那几家):我们只存了标题与最新一句,不存对话 —— 如实说。
      if (id.startsWith('window:')) {
        const entry = agents?.view().entries.find(one => one.id === agent)
        const name = entry?.name ?? agent
        /**
         * **读窗口读出来的那一条:对话读不到,可话还是捎得进去**(2026-09-28,卡 WR)。
         *
         * 以前这里一律 404,于是手机上点开窗口型那几家的卡片连输入框都没有(卡 PS 那个框是靠
         * 这一条回的 `relay` 摆出来的)。现在:最近几轮照旧没有(我们只存了标题与最新一句,如实说),
         * **但带上 `relay`** —— 能捎就摆框,不能捎就一行人话,与文件型那几条同一个口径。
         */
        const one = windowRelaySessions().find(row => row.agent === agent && row.session_id === id)
        if (one === undefined) {
          sendJson(res, 404, { error: `${name} 这会儿没有这条对话(可能关掉了,或者这一拍没读到)` })
          return
        }
        const relayHere = sessionAnswer?.relayReady(agent, id)
        sendJson(res, 200, {
          agent,
          session_id: id,
          ...(one.title === undefined ? {} : { title: one.title }),
          project: one.project,
          status: one.status,
          ...(one.activity === undefined ? {} : { activity: one.activity }),
          rounds: [],
          rounds_note: `${name} 是读它的窗口读出来的:这里只有标题和最新一句,完整的对话在 ${name} 里`,
          read_at: new Date().toISOString(),
          ...(relayHere === undefined ? {} : { relay: relayHere }),
        })
        return
      }
      const view = await sessionDigest.view(agent, id)
      if (view === undefined) {
        // CLI 派活会话(task.links 登记过的 Kimi CLI 来源):登记表读不到,从它的会话文件现读。
        const cli = await cliSourceRead(agent, id)
        if (cli.kind === 'ok') {
          const relayHere = sessionAnswer?.relayReady(agent, id)
          sendJson(res, 200, {
            agent, session_id: id,
            title: 'CLI 派活会话',
            rounds: cli.turns.slice(-6).map(one => ({ k: one.k, text: one.text, ...(one.at === undefined ? {} : { at: one.at }) })),
            rounds_note: 'CLI 派活的那条会话:从它的记录文件现读,可能还在长',
            read_at: cli.read_at,
            ...(relayHere === undefined ? {} : { relay: relayHere }),
          })
          return
        }
        const why = cli.kind === 'unsupported' ? `${agent} 这家这会儿不支持从记录文件读`
          : cli.kind === 'not_synced' ? '这条 CLI 会话还没落盘(可能还在跑),过一阵再点开'
            : '读不到这条会话的记录'
        sendJson(res, 404, { error: why })
        return
      }
      /**
       * 这张卡下面给不给输入框(2026-09-27,卡 PS):按**真捎话那道门**问一句(不碰任何一只手)。
       * 捎话那条路没接上(旧壳、`sessionAnswer` 缺席)就不带这一格 —— 界面据此不摆输入框,不假装能送。
       */
      const relay = sessionAnswer?.relayReady(agent, id)
      sendJson(res, 200, relay === undefined ? view : { ...view, relay })
      return
    }

    /**
     * GET /sessions/history?agent=&before=&limit=&per_family=(2026-10-01,手机读对话 A;维护者:「每一个智能体只显示一个最近会话」)。
     * 各家最近 7 天的对话,从各家的会话记录文件读(关掉的也在),按最后动静排、分页;窗口型那几家带 `window_only`。
     * 门同 `/sessions/digest`。
     *
     * `per_family=n`(2026-10-03,卡「手机各家最近会话固定入口」):另一档 —— 各家各取最近 n 条、一次全给,
     * 回包多一格 `per_family`(手机靠它分辨这台电脑认不认这个参数);不带它的老调用方形状一个字没变。
     */
    if (req.method === 'GET' && path === '/sessions/history') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机或已配对的手机上看对话' }); return }
      if (sessionLibrary === undefined) { sendJson(res, 404, { error: '读对话未接线' }); return }
      const query = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams
      const agent = query.get('agent') ?? ''
      const before = query.get('before') ?? ''
      const limit = Number(query.get('limit') ?? '')
      const perFamilyRaw = query.get('per_family')
      if ((agent !== '' && !/^[A-Za-z0-9._-]{1,64}$/.test(agent)) || before.length > 400) {
        sendJson(res, 400, { error: '看哪一家(agent)写得不对' })
        return
      }
      const perFamily = perFamilyRaw === null ? undefined : Number(perFamilyRaw)
      if (perFamily !== undefined && !(Number.isInteger(perFamily) && perFamily > 0 && perFamily <= PER_FAMILY_MAX)) {
        sendJson(res, 400, { error: `每家最多几条(per_family)要是 1 到 ${PER_FAMILY_MAX} 之间的整数` })
        return
      }
      sendJson(res, 200, await sessionLibrary.history({
        ...(agent === '' ? {} : { agent }),
        ...(before === '' ? {} : { before }),
        ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}),
        ...(perFamily === undefined ? {} : { per_family: perFamily }),
      }))
      return
    }

    /**
     * GET /sessions/transcript?agent=&id=&before=(2026-10-01,手机读对话 B;维护者:「往上就没了」)。
     * 一条对话的完整内容,从最新往前按轮分页;`before` 是上一页给的游标(往上翻);`from` = 只要那一行到末尾
     * (开着的对话还在长时刷新最新那一段)。只认各家的会话 id,**不收路径**。
     * 门同 `/sessions/digest`。
     */
    if (req.method === 'GET' && path === '/sessions/transcript') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机或已配对的手机上看对话' }); return }
      const query = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams
      const agent = query.get('agent') ?? ''
      const id = query.get('id') ?? ''
      const before = query.get('before') ?? ''
      const from = query.get('from') ?? ''
      const codex = await codexLinkedSource(agent, id)
      if (codex !== undefined) {
        if (!codex.ok) { sendJson(res, codex.status, { error: codex.error }); return }
        const result = await createSessionTranscript({ locate: async () => codex.ref }).read({ agent, id, ...(before === '' ? {} : { before }), ...(from === '' ? {} : { from }) })
        if (result.ok) sendJson(res, 200, result.value)
        else sendJson(res, result.status, { error: result.error })
        return
      }
      if (sessionLibrary?.transcript === undefined) {
        const cliOnly = await cliSourceRead(agent, id).catch(() => ({ kind: 'not_linked' as const }))
        if (cliOnly.kind === 'ok') {
          sendJson(res, 200, { agent, session_id: id, turns: cliOnly.turns, read_at: cliOnly.read_at })
          return
        }
        sendJson(res, 404, { error: cliOnly.kind === 'not_synced' ? '这条 CLI 会话还没落盘(可能还在跑),过一阵再来' : '读对话未接线' })
        return
      }
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(agent) || id === '' || id.length > 200 || before.length > 20 || from.length > 20) {
        sendJson(res, 400, { error: '要带上是哪一家(agent)和哪条对话(id)' })
        return
      }
      const got = await sessionLibrary.transcript({ agent, id, ...(before === '' ? {} : { before }), ...(from === '' ? {} : { from }) })
      if (got.ok) { sendJson(res, 200, got.value); return }
      // CLI 派活会话(task.links 登记的 Kimi CLI 来源)的回退读口:同一份信封形状。
      const cli = await cliSourceRead(agent, id)
      if (cli.kind === 'ok') {
        sendJson(res, 200, {
          agent, session_id: id,
          turns: cli.turns.map(one => ({ k: one.k, text: one.text, ...(one.at === undefined ? {} : { at: one.at }) })),
          read_at: cli.read_at,
          ...(sessionAnswer?.relayReady(agent, id) === undefined ? {} : { relay: sessionAnswer.relayReady(agent, id) }),
        })
        return
      }
      // CLI 回退不支持这一家不代表原读取器不支持；无可用回退时保留原来源的错误。
      const why = cli.kind === 'not_synced' ? '这条 CLI 会话还没落盘(可能还在跑),过一阵再来' : got.error
      sendJson(res, got.status, { error: why })
      return
    }

    /**
     * GET /sessions/attachment?agent=&id=&ref=&view=info|thumb|full|text|page&part=&page=(2026-10-01,手机读对话 C)。
     * 对话里的附件,按需取、分块(每块装得进中转 1MB 一条)。`ref` 是完整对话里给的编号,**只认这条会话里出现过的**
     * (回到记录里那一行核);转换(缩略图、HEIC、正文、逐页)在这台 Mac 上做。门同 `/sessions/digest`。
     */
    if (req.method === 'GET' && path === '/sessions/attachment') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机或已配对的手机上看对话' }); return }
      if (sessionLibrary?.attachment === undefined) { sendJson(res, 404, { error: '读对话未接线' }); return }
      const query = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams
      const agent = query.get('agent') ?? ''
      const id = query.get('id') ?? ''
      const ref = query.get('ref') ?? ''
      const view = query.get('view') ?? 'info'
      const part = Number(query.get('part') ?? '0')
      const page = Number(query.get('page') ?? '0')
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(agent) || id === '' || id.length > 200 || ref === '' || ref.length > 4100
        || !['info', 'thumb', 'full', 'text', 'page', 'keep'].includes(view) || !Number.isInteger(part) || !Number.isInteger(page)) {
        sendJson(res, 400, { error: '要带上是哪一家、哪条对话、哪个附件' })
        return
      }
      /**
       * `view=keep`(2026-10-04):把这个附件**存到手机上**。压缩包、设计稿、几百 MB 的视频这一类
       * 在手机上看不了全 —— 这里开一张取件单,手机走现成的 `GET /files/offer/<单号>`
       * (在家直连、出门让工人经房间推),**不另造一条传输路**。
       * 这一个文件的 realpath 跟着单子走(`offer.roots`):对话里的图不一定落在扫描根底下,
       * 取的那一刻照旧过 `checkOfferFile` 那一整套门,只是「在授权目录里」这一问多认这一个文件。
       */
      if (view === 'keep') {
        if (device === undefined) { sendJson(res, 403, { error: '「存到手机上」要在手机上点(这是电脑,文件就在本机)' }); return }
        if (sessionLibrary.attachmentFile === undefined) { sendJson(res, 404, { error: '存到手机上这条路没接上' }); return }
        const found = await sessionLibrary.attachmentFile({ agent, id, ref })
        if (!found.ok) { sendJson(res, found.status, { error: found.error }); return }
        let real: string
        try { real = await realpath(found.value.path) }
        catch { sendJson(res, 410, { error: '电脑上这个文件已经不在了(被挪走或删了)' }); return }
        const offer = fileOffers.add({
          path: found.value.path,
          name: found.value.name,
          bytes: found.value.bytes,
          where: found.value.where,
          device_id: device.id,
          source: 'typed',
          roots: [real],
        })
        sendJson(res, 200, { offer: offer.id, name: offer.name, bytes: offer.bytes, where: offer.where, kind: fetchKindOf(offer.name) })
        return
      }
      const got = await sessionLibrary.attachment({ agent, id, ref, view: view as 'info', part, page })
      if (got.ok) sendJson(res, 200, got.value)
      else sendJson(res, got.status, { error: got.error })
      return
    }

    /**
     * POST /sessions/answer {agent, session_id, text}(2026-09-25,卡 T「在等你」):别家那段会话停着在等他,
     * 他在外层 / 手机上答了 —— 送回那段会话。门同 `/questions/answer`(回环或已配对的手机)。
     * 送不回去的**如实说**:200 + `{ ok:false, where:'desk', why:'这一问要到电脑上 Claude 里回', reveal }`
     * (界面据此写那一句、电脑上给「去回答」);这一问已经不在了 → 409;字是空的 → 400。
     * 他答的原话只送进那家那段会话,不落盘、不进 /state。
     */
    if (req.method === 'POST' && path === '/sessions/answer') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机或已配对的手机上答' }); return }
      if (sessionAnswer === undefined) { sendJson(res, 404, { error: '送回那家会话的路没接上' }); return }
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      const agent = typeof body.agent === 'string' ? body.agent : ''
      const id = typeof body.session_id === 'string' ? body.session_id : ''
      const text = typeof body.text === 'string' ? body.text : ''
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(agent) || id === '' || id.length > 200) {
        sendJson(res, 400, { error: '要带上是哪一家(agent)和哪条会话(session_id)' })
        return
      }
      if (text.length > 4000) { sendJson(res, 400, { error: '回答太长了(最多 4000 字)' }); return }
      const result = await sessionAnswer.answer(agent, id, text)
      if (result.ok) {
        /*
         * ★ **答上了就把排着的那一通撤掉**(2026-10-02:审计第二表第 11 条 ——
         * 从前只有 `/asks/*` 那几条撤,这一条不撤、等下一拍;那一拍之前手机一上线就会为一个
         * 已经答掉的问打过去)。**核实过才撤**,判断在 `dropQueuedAsk` 一处。
         */
        await dropQueuedAsk(sessionAskItemId(agent, id), result.confirmed !== false)
        // 核不上也照实报(2026-10-01,卡 AW):`confirmed:false` + 那句人话,界面照说,**不说成答上了**。
        sendJson(res, 200, { ok: true, route: result.route, ...(result.confirmed === undefined ? {} : { confirmed: result.confirmed }), ...(result.note === undefined ? {} : { note: result.note }) })
        void composeState().then(state => broadcast({ kind: 'snapshot', state })).catch(() => {})
        return
      }
      // `permission`(卡 AP):撞上的是权限弹窗 —— 界面据此收起输入框、切到「批准 / 拒绝」那几颗键。
      if (result.status === 200) { sendJson(res, 200, { ok: false, where: result.where, why: result.why, reveal: result.reveal, ...(result.permission === true ? { permission: true } : {}) }); return }
      sendJson(res, result.status, { error: result.error })
      return
    }

    /**
     * POST /sessions/approval/read {agent, session_id}(2026-10-01,卡 AP「手机替她批准」):
     * 那条会话停在权限弹窗上,界面打开那张卡时问一次 —— 壳读出弹窗上**真实的那几颗键**,只回「批准一次 / 拒绝」
     * (`held` = 认出来、但不替她按的放宽那几颗)。读到的记下来,`/state` 那一格据此带上那几颗(电脑、手机、电话同一份)。
     * 先只读一眼不动她的窗口,没认出再把那段对话开到前面读。门同 `/sessions/answer`(回环或已配对的手机)。
     */
    if (req.method === 'POST' && path === '/sessions/approval/read') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机或已配对的手机上看' }); return }
      if (sessionAnswer === undefined) { sendJson(res, 404, { error: '替你按那个弹窗的路没接上' }); return }
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      const agent = typeof body.agent === 'string' ? body.agent : ''
      const id = typeof body.session_id === 'string' ? body.session_id : ''
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(agent) || id === '' || id.length > 200) {
        sendJson(res, 400, { error: '要带上是哪一家(agent)和哪条会话(session_id)' })
        return
      }
      const read = await sessionAnswer.approvalRead(agent, id)
      noteBehavior({ 事: BEHAVIOR_EVENTS.open, 对象: `待确认 ${agent}/${id}`, 结果: '点开' })
      void composeState().then(state => broadcast({ kind: 'snapshot', state })).catch(() => {})
      if (read.ok) { sendJson(res, 200, { ok: true, keys: read.keys, held: read.held }); return }
      if (read.status === 200) { sendJson(res, 200, { ok: false, where: read.where, why: read.why, reveal: read.reveal }); return }
      sendJson(res, read.status, { error: read.error })
      return
    }

    /**
     * POST /sessions/relay {text, who?} | {text, agent, session_id}(2026-09-26,卡 BR):
     * **事务官捎话** —— 他点名的任何一条会话,不要求它挂在事项上、也不要求它此刻在等他。
     *
     * 维护者 16:41 那一通:「给那个 Claude,现在正在做统筹交接的那个会话窗口,发个信息问一下……」——
     * 事务官答的是「它归哪件事」。那条路本来没有:`/sessions/answer` 要求那条会话正在等他(`ask` 挂着),
     * 而统筹交接那条在**跑**。这一条就是那条路(为什么不改 `/sessions/answer`:那条的 409
     * 「这一问已经不在了」是真守门 —— 他答的是某一问,那一问没了就不该照送)。
     *
     * - `who` = **他点名那句原话**(「统筹交接那条」「Claude 刚才那条正在跑的」):按 `/state.sessions` 里的
     *   标题 / 家名 / 状态认(`sessionRelay.ts` 的 `matchRelaySession`)。**认不准不猜**:
     *   200 + `{ok:false, where:'pick', candidates, note}`,事务官把 `note` 念给他选,他说了哪一条再带
     *   `agent` + `session_id` 调一次;一条都对不上 → `where:'none'`。
     * - `text` = **他自己说的话**,原样送(前面只加一个 `【事务官捎话 xxxxxx】` 记号)。
     * - 捎不到的三种如实说(`where:'desk'`):那只手对这家不通 / 那家的窗口没开 / 窗口里没认出那段对话。
     *
     * 门同 `/sessions/answer`(回环或已配对的手机)。他的话只送进那条会话,**不落盘、不进 /state**。
     */
    /**
     * ★ **家名候选池一处下发**(2026-10-03,卡「两条接缝」;决策记录 10-03 早 ⑦ 第一条)。
     *
     * 从前有三个池各自认「他嘴里那一家」:这里的 {@link spokenFamiliesNow}、电话工人
     * `channel-worker/src/agentName.ts` 的 `FALLBACK_FAMILIES`、手机那份只有显示名的表。
     * 09-30 那道对照测试只钉住两份别名**逐字相同**,候选池仍是两样 —— 于是运行时新接上的一家
     * (Grok Bot / Antigravity)电话里点名一次都认不出,而电脑上认得出。
     *
     * **主人是这一处**(插件的家族目录 + 本机探测 + 登记表)。这条口是只读的下发口:
     * 工人启动时拉一份,拉不到才用它自带的兜底(那份是「写过专门接法的那几家」的子集)。
     *
     * 回包故意只有候选池那三格(`id` / `title` / `aliases`)—— 它是**认名字**用的,
     * 装没装、额度、能不能派活各有各的口(`/state.installed_agents`、`/agents/caps`、`/dispatch/choices`),
     * 不在这里重复一份。
     */
    if (req.method === 'GET' && path === '/families') {
      sendJson(res, 200, { families: spokenFamiliesNow() })
      return
    }

    /**
     * GET /sessions/lookup?who=…(2026-09-27,卡 LK):**看一眼那一家现在什么状态,只读。**
     *
     * 维护者 21:2x 电话里问「Codex 现在是什么状态?他正在跑那个参赛网页那个东西」,
     * 事务官答的是看板上的旧事项,又去给 Codex 捎了一次话(他明说「不要给他发信息,就看一眼」)。
     * 这条路就是「只看一眼」那条:认出**那一家此刻正开着的那条对话**,回一句
     * 「在跑还是停了 · 最后一次动静多久前 · 最后一句在干什么」。
     *
     * **一个字节都不送出去**(与 `/sessions/relay` 泾渭分明):不落盘、不进 /state、不碰那家的窗口。
     * 认不准同捎话:`where:'pick'` 把候选念给他选;一条都对不上 `where:'none'`。
     */
    if (req.method === 'GET' && path === '/sessions/lookup') {
      const who = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('who') ?? ''
      if (who.trim() === '') { sendJson(res, 400, { error: '要带上他点名那一句(who)' }); return }
      const found = lookupSession({
        // 窗口型各家的对话也能「看一眼」(2026-09-28,卡 WR)。
        sessions: relaySessionPool(),
        who,
        agentName: relayAgentName,
        now: new Date().toISOString(),
        families: spokenFamiliesNow(),
      })
      /*
       * ★ 捎话账上这一家最近那一条(2026-09-30 晚,故障 ③):窗口型那几家(豆包)读不出对话,
       * 电话里问「它回了没」只能说看不到 —— 可我们捎进去的那句、读回来的那段回话在账上,原样带上。
       */
      if (found.kind === 'none') {
        const family = matchSpokenFamily(who, spokenFamiliesNow())
        const ledger = family.kind === 'one' ? relayLedgerLine(family.id) : undefined
        if (ledger !== undefined && family.kind === 'one') {
          sendJson(res, 200, { ok: true, agent: family.id, note: `${family.title}这会儿读不到开着的那条对话。${ledger}` })
          return
        }
        sendJson(res, 200, { ok: false, where: 'none', note: found.line })
        return
      }
      if (found.kind === 'many') {
        sendJson(res, 200, { ok: false, where: 'pick', note: found.line, candidates: found.candidates })
        return
      }
      const ledger = relayLedgerLine(relayFamilyOf(found.agent))
      sendJson(res, 200, {
        ok: true,
        agent: found.agent,
        session_id: found.session_id,
        title: found.title,
        status: found.status,
        note: ledger === undefined ? found.line : `${found.line}\n${ledger}`,
      })
      return
    }

    if (req.method === 'POST' && path === '/sessions/relay') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机或已配对的手机上捎话' }); return }
      if (sessionAnswer === undefined) { sendJson(res, 404, { error: '往那家会话里捎话的路没接上' }); return }
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      const text = typeof body.text === 'string' ? body.text : ''
      const who = typeof body.who === 'string' ? body.who : ''
      let agent = typeof body.agent === 'string' ? body.agent : ''
      let id = typeof body.session_id === 'string' ? body.session_id : ''
      if (text.trim() === '') { sendJson(res, 400, { error: '要捎的话是空的' }); return }
      if (text.length > 4000) { sendJson(res, 400, { error: '捎的话太长了(最多 4000 字)' }); return }
      /**
       * ★ **「回了打电话给我」那个勾选**(2026-10-04,卡 `claude/relay-call-optin`)。
       *
       * 维护者原话:「现在每次我在手机里给你发信息,你回信息他就给我打电话……不是每次都要的,
       * 能不能给个勾选,勾了才需要盯和打电话」。
       *
       * **这一处就是「盯着就打电话」被打开的地方** —— 回电是在这条路里 `relayWatch.remember` 登记的,
       * 所以开关放在这儿(送出去那一刻),不在回电那头加过滤:同一个人同一天捎十句,
       * 哪一句要电话是她发那一句时的决定。
       *
       * **缺省不勾**(`call_on_reply` 缺席 / false):**一条都不登记** —— 没有巡检、没有读窗、
       * 没有通知、没有电话(2026-10-04 下午维护者追的那一句「不勾的时候可以不读」,
       * 卡 `claude/relay-nocall-noread`)。她那句话照旧一个字不少地送进去,回话留在那条会话里,
       * 她在手机「各家对话」里看得到。老手机包没有这一格 → 走的正是这一路。
       */
      const callOnReply = body.call_on_reply === true
      /*
       * ★ **微信 / 企业微信的联系人不走这条路**(2026-09-28 Air 维护包:她要找微信里的人,电话沿用了上一次的
       * 目标,话差点发进豆包)。这条路只往 AI 会话里送;点名微信就停,一个字都不发。
       */
      if (/(?:微信|wechat|weixin|企业微信|wecom)/i.test(`${who} ${agent}`)) {
        sendJson(res, 200, { ok: false, where: 'none', note: '已停止:微信联系人不能通过 AI 会话捎话接口发送,没有向任何 AI 应用发送。' })
        return
      }
      /*
       * **只盯着、不发**(`watch_only`;2026-09-28 Air 维护包):她那句已经发进去了(她自己发的、或者上一轮发的),
       * 要的是「它回了告诉我」。先在那家对话区里核实看得见这句话,再登记一条跟踪 —— **不重发**。
       *
       * ★ 2026-10-02(卡「引擎接线与删复制品」)两处改了:
       * ① 核那一眼走 `engine.read`(与捎话巡检、派活盯窗同一处;从前这里自己拿壳、自己按
       *    `CLIENT_DISPATCH_BUNDLES` 查包 —— 那是四份「家→包」表里的一份,而且只认主包);
       * ② 这一下**过闸**了(审计第二表第 13 条:从前 `/dispatch/client`、新开一条、只盯不发都不过闸,
       *    而同一扇窗被捎话巡检读的时候是过闸的)—— `reply_watch` 那道闸在 `engine.read` 里面。
       */
      if (body.watch_only === true) {
        /*
         * ★ 这一路(「只盯着,它回了告诉我」)**本身就是她明说的那一下** —— 调它的唯一出处是
         * 电话里那件 `wb_watch_reply`,那件工具的全部意思就是「回了打电话给我」。所以缺省就是要回电;
         * 她明着送了 `call_on_reply:false`,这条路就**什么都不做**(2026-10-04,卡
         * `claude/relay-nocall-noread`:不盯就不读 —— 连核那一眼窗都不读了)。
         */
        if (body.call_on_reply === false) {
          sendJson(res, 200, { ok: false, watched: false, note: '没登记回电:这一下明说了不用盯,那就没盯 —— 它回了要你自己去那扇窗里看;没有重发消息。' })
          return
        }
        const family = matchSpokenFamily(who === '' ? agent : who, spokenFamiliesNow())
        if (family.kind !== 'one' || relayWatch === undefined || options.engine === undefined) {
          sendJson(res, 200, { ok: false, note: '没能登记回电:目标不明确或跟踪服务未连接。' })
          return
        }
        const mark = relayReadMark(text)
        const waitId = randomUUID()
        const read = await options.engine.read({
          // 还认不出它开的是哪条对话 —— 键用这一条自己的(`jobKey.relayWaitJobId`),不冒充会话键。
          id: relayWaitJobId(waitId),
          family: family.id,
          kind: 'relay',
          target: { kind: 'current' },
          text: '',
          marks: [mark],
          expect: 'reply',
        })
        // 读到了 = 在那家确实看得见这句话(对话区里,或它自己的记录里;判据一处 `READ_SEEN_EVIDENCE`);读不到 / 闸拦下都不登记。
        if (read.evidence === undefined || !READ_SEEN_EVIDENCE.includes(read.evidence)) {
          sendJson(res, 200, { ok: false, note: '还没在目标对话里核实到这句消息,暂未登记回电,也没有重发。' })
          return
        }
        // 落不了盘就说登记不上(2026-09-30 止血 ①:`remember` 现在会抛)——不许许一通不会来的电话。
        try {
          await relayWatch.remember({
            agent: family.id,
            session_id: waitId,
            session_placeholder: true,
            /*
             * ★ **账上这一条记 `seen`,不记 `sent`**(2026-10-03,卡「接缝清理」第 1 条;
             * 决策记录「2026-10-03 早」⑦)。这一句是她自己发的,上面那一下只核到
             * 「它在对话区里看得见」(`evidence:'window'`)—— 一个字都没送。
             */
            watch_only: true,
            title: '刚才的会话',
            mark,
            from: 'call',
            ...(options.engineRegistry?.packageFor(family.id)?.bundle_id === undefined
              ? {}
              : { bundle_id: options.engineRegistry.packageFor(family.id)?.bundle_id as string }),
          })
        }
        catch {
          sendJson(res, 200, { ok: false, watched: false, note: '没能登记回电(台账写不进去):它回了我不会自己打电话,要你自己去那扇窗里看;没有重发消息。' })
          return
        }
        sendJson(res, 200, { ok: true, watched: true, note: '已登记后台跟踪,读到回复后会按来电设置通知你;没有重发消息。' })
        return
      }
      /*
       * **她明说了新开一条**(`new_conversation`;电话里 `relayIntent` 认出来的,2026-09-28 Air 维护包):
       * 在那一家新开一条对话发她的原话 —— 走派活那只手(开新对话、送完核对话区里看得见)。
       */
      if (body.new_conversation === true) {
        const family = matchSpokenFamily(who === '' ? agent : who, spokenFamiliesNow())
        if (family.kind !== 'one' || clientDispatch === undefined) {
          sendJson(res, 200, { ok: false, note: '没新开:请明确给哪一家应用发消息,且该应用须已接入工作台。' })
          return
        }
        /*
         * 送 → 登记回电 → 说实话,三档见 `relayNewConversation.ts`(2026-09-30 晚,故障 ②:
         * 按了发送、对话区没当场核上时以前回「没发出去」、回电也不登记;豆包其实收到了、两分钟后就回了)。
         */
        const from: RelayFrom = body.from === 'call' ? 'call' : device === undefined ? 'desk' : 'phone'
        const outcome = await relayIntoNewConversation({
          send: input => clientDispatch.send(input),
          ...(relayWatch === undefined ? {} : { watch: relayWatch }),
          newId: () => randomUUID(),
        }, {
          family: family.id,
          title: family.title,
          text,
          from,
          ...(body.overwrite === true ? { overwrite: true } : {}),
          // 她勾了「回了打电话给我」没有(2026-10-04);缺席 = 不回电,只发一条不响的通知。
          ...(callOnReply ? { callOnReply: true } : {}),
        })
        sendJson(res, 200, {
          ok: outcome.ok,
          delivered: outcome.delivered,
          watched: outcome.watched,
          note: outcome.note,
          ...(outcome.mark === undefined ? {} : { mark: outcome.mark }),
        })
        return
      }
      if (agent === '' && id === '') {
        if (who.trim() === '') { sendJson(res, 400, { error: '要带上给哪一条会话捎(who,他点名那句原话;或者 agent + session_id)' }); return }
        const match = matchRelaySession({
          // 窗口型各家的已有对话也认(2026-09-28,卡 WR;见 relaySessionPool 那一段)。
          sessions: relaySessionPool(),
          who,
          agentName: relayAgentName,
          now: new Date().toISOString(),
          /** 捎话认人与「看一眼」**同一套**(卡 MS/LK 的口径):先认家,再只在这家里认对话。 */
          families: spokenFamiliesNow(),
        })
        if (match.kind === 'none') { sendJson(res, 200, { ok: false, where: 'none', note: match.line }); return }
        if (match.kind === 'many') {
          sendJson(res, 200, { ok: false, where: 'pick', note: match.line, candidates: match.candidates })
          return
        }
        agent = match.target.agent
        id = match.target.session_id
      }
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(agent) || id === '' || id.length > 200) {
        sendJson(res, 400, { error: '要带上是哪一家(agent)和哪条会话(session_id)' })
        return
      }
      /**
       * `interrupt`(2026-09-28,卡 WR):**先打断它再说这句话**。缺省 false = 「补一句」。
       * 两处入口都要他明着要:电话里他说「打断它 / 先停下 / 别做了改成…」,
       * 手机卡片上他点那颗次级键并回一句「要先停下它吗」。
       */
      const interrupt = body.interrupt === true
      const result = await sessionAnswer.relay(agent, id, text, {
        interrupt,
        ...(body.overwrite === true ? { overwrite: true } : {}),
        // 她勾了「回了打电话给我」(2026-10-04):挂在这件活上,锁着屏排队重送那一路才登记得对。
        ...(callOnReply ? { callOnReply: true } : {}),
      })
      /*
       * ★ **「按了发送、当场没核上」只看那一格**(2026-10-02;审计第二表第 18 条)。
       * 从前这里还靠 `why.includes('回执尚未确认')` 认一遍 —— 而那句文案有两份、还不一样
       * (`sessionAnswer.SEND_RECEIPT_UNSURE` / `dispatchClient` 那一句),改一个字这一道就瞎了。
       * 现在结局由引擎说(`delivered`),服务翻成 `unconfirmed` 那一格,不认文案。
       */
      const unconfirmed = !result.ok && result.status === 200 && result.unconfirmed === true
      const where = relayAgentName(agent)
      /**
       * **记一条轻账**(2026-09-27,卡 CB):哪条会话、什么记号、几点、从哪一端问的。
       * 巡检按记号读回话,读到了回个电话给他(`server/relayWatch.ts`)。
       * **送成了才记**:捎不到的那几种一个字不记(不然他会等一通永远不来的电话)。
       * 他捎进去那句话**不记**——卡 BR 那条「他的话只送进那条会话、不落盘」没有松。
       * `from` 认三样:通话里那只工人自己说(`from:'call'`),别的按这一趟是从手机还是本机来的算。
       *
       * 2026-09-30 止血:这里以前是 `void …remember(…)` —— 记没记上从来没人看,落不了盘也照说
       * 「它回了我打电话告诉你」。现在等它回来,记不上就换一句实话(口径同 `relayNewConversation.ts`)。
       */
      const rememberRelay = async (input: { mark: string, bundleId?: string, unconfirmed?: true, turnId?: string }): Promise<boolean> => {
        if (relayWatch === undefined) return false
        /*
         * ★ **她没勾 = 这一条压根不登记**(2026-10-04 下午,卡 `claude/relay-nocall-noread`;
         * 维护者原话「可以不读」)。上午那一版还登记、还 8 秒一拍读那扇窗,只是不响铃 ——
         * 她追问之后收到底:不勾就不盯、不读,回话留在那条会话里。
         * 「等太久也说一声」那条 09-27 的纪律因此只对勾了的生效(她拍的)。
         */
        if (!callOnReply) return false
        const from: RelayFrom = body.from === 'call' || body.from === 'phone' || body.from === 'desk'
          ? body.from
          : (device === undefined ? 'desk' : 'phone')
        const view = relaySessionPool().find(one => one.agent === agent && one.session_id === id)
        try {
          await relayWatch.remember({
            agent,
            session_id: id,
            title: view === undefined ? '' : sessionDisplayTitle(view, where),
            mark: input.mark,
            from,
            ...(input.bundleId === undefined ? {} : { bundle_id: input.bundleId }),
            ...(input.unconfirmed === true ? { unconfirmed: true } : {}),
            // 哪一轮(协议型报的;2026-10-03):巡检只认这一轮。
            ...(input.turnId === undefined ? {} : { turn_id: input.turnId }),
          })
          return true
        }
        catch { return false }
      }
      if (result.ok && result.sessionClosed === true) {
        /*
         * ★ **那条会话没开着、留言排上队了**(2026-10-23,卡「捎话到没开着的会话留言等它醒」):
         * 回包**形状不变**(ok / route / delivered / watched / agent / session_id / mark / note),
         * 只是 note 就是那句完整的话(不套「捎到了 / 送进了」的框 —— 一个字都没送出去)、
         * **不登记回电**(那一条由醒来重送那一下补,见 `index.ts` 的 drain.after)。
         */
        sendJson(res, 200, {
          ok: true,
          route: result.route,
          delivered: 'kept',
          watched: false,
          agent,
          session_id: id,
          mark: result.mark,
          note: result.note ?? SESSION_CLOSED_QUEUED_SAY,
        })
        return
      }
      if (result.ok) {
        /*
         * ★ **那道「命令行那一路不登记回电」的门删了**(2026-10-03,卡「接缝清理」第 3 条;
         * 决策记录「2026-10-03 早」⑦)。
         *
         * 2026-09-30 止血加的是 `const byWindow = result.route === 'window'`:`codex exec resume`
         * 没有窗口可读,登记了就等于安排一通 20 分钟后的假话。可那只手 2026-10-02 整只删了
         * (`index.ts` 一次都没传过 `cli`),`sessionJobs.relay` 从此只回 `route:'window'` ——
         * 这道门**恒为真**,写不出一条用例走它(交接 1002 第六节 ⑥)。
         *
         * 纪律没松:**没有那条路,就不会为它登记回电**。现在由
         * `sessionAnswer.RELAY_ROUTES` 钉着(`tests/relay-route-watch.test.ts`:现有每一种 route
         * 都登记回电)—— 哪天真接上第二条路,那张表一改用例就红,到那时必须明说它登不登记。
         */
        const watched = await rememberRelay({ mark: result.mark, ...(result.bundle_id === undefined ? {} : { bundleId: result.bundle_id }), ...(result.turn_id === undefined ? {} : { turnId: result.turn_id }) })
        /*
         * ★ 2026-10-04(卡 `claude/relay-call-optin` → `claude/relay-nocall-noread`):
         * 许的那一句**照她勾没勾说**。没勾就不许说「我打电话告诉你」、也不许说「我盯着」
         * (那一句压根不盯了),可也不许一声不吭 —— 说清它回的那句会留在哪儿、
         * 要电话该怎么要(两句都在 `relayWatch.ts` 的常量里)。
         */
        const promise = relayWatch === undefined
          // 这台工作台压根没接这本轻账(老版本 / 没接座机):不多说那句承诺,也不提那个勾选。
          ? ''
          : !callOnReply
            // 没勾:不盯、不读,说的就是这一件(不许再许「回了我告诉你」)。
            ? RELAY_PROMISE_NOWATCH
            : watched
              ? RELAY_PROMISE_CALL
              : `但回电没登记上 —— 它回了我不会自己打电话,要你去${where}那条会话里看。`
        sendJson(res, 200, {
          ok: true,
          route: result.route,
          delivered: 'sent',
          watched,
          agent,
          session_id: id,
          mark: result.mark,
          ...(result.queued === true ? { queued: true } : {}),
          ...(result.interrupted === true ? { interrupted: true } : {}),
          /*
           * 末尾那一截:**替她做了的、必须当场说的那一句**(今天只有「替她按掉了她窗口上那层框」,
           * 卡 DP;2026-10-02 审计第二表第 5 条收成一份 —— 从前只有派活那一处说)。
           */
          note: `${result.interrupted === true ? '先按了它的停止键、停下了,' : ''}捎到了 —— 你那句话已经送进${/[A-Za-z0-9]$/.test(where) ? ` ${where} ` : where}那条会话里了${result.queued === true ? '(它这会儿还在跑,这句话排在它后面,它跑完就看得见)' : ''}。${promise}${result.note === undefined ? '' : `(${result.note})`}`,
        })
        return
      }
      /**
       * ★ **按了发送、当场没在对话区里核上**(2026-09-30 止血 ③;口径同新开会话那条
       * `relayNewConversation.ts`):它多半已经收到了 —— 以前这里回 ok:false、一条回电都不登记,
       * 于是她既不敢重发、也永远等不到电话。现在照样登记(标 `unconfirmed`,巡检读到这句话才算核上),
       * 回 ok:true,把「没看见它收下」说清楚。
       */
      if (unconfirmed && !result.ok && result.status === 200) {
        const mark = result.mark ?? relayReadMark(text)
        // ★ 2026-10-03:这儿原来还有一道同样的门(`result.route === 'cli' ? false : …`)—— 同一个
        // 产不出来的值,同一条恒为真的判断,一起删(见上面那一段;纪律由 `RELAY_ROUTES` 钉着)。
        const watched = await rememberRelay({ mark, ...(result.bundle_id === undefined ? {} : { bundleId: result.bundle_id }), ...(result.turn_id === undefined ? {} : { turnId: result.turn_id }), unconfirmed: true })
        const tail = relayWatch !== undefined && !callOnReply
          // 没勾:不盯也不读,所以这一句到底进没进去也只能她自己去那条会话里看一眼(2026-10-04)。
          ? RELAY_PROMISE_NOWATCH_UNSURE
          : watched
            ? RELAY_PROMISE_CALL_UNSURE
            : `回电也没登记上 —— 它回了我不会自己打电话,去${where}那扇窗里看一眼是不是还停在输入框里。`
        sendJson(res, 200, {
          ok: true,
          delivered: 'unconfirmed',
          watched,
          agent,
          session_id: id,
          mark,
          ...(result.route === undefined ? {} : { route: result.route }),
          reveal: result.reveal,
          why: result.why,
          note: `按了发送,还没在它对话区里看到这句话,先别重发;${tail}`,
        })
        return
      }
      if (result.status === 200) {
        sendJson(res, 200, { ok: false, where: result.where, why: result.why, note: `捎不进去:${result.why}`, reveal: result.reveal, agent, session_id: id })
        return
      }
      sendJson(res, result.status, { error: result.error })
      return
    }

    /**
     * POST /sessions/ask/dismiss {agent, session_id}(卡 T):「不用管这条」—— 按内容判出来的这一问从「等你」里拿掉
     * (判错了,或他知道了不想回);那家说了新的一句再重新判。弹窗那种拿不掉(409)。门同 /sessions/answer。
     */
    if (req.method === 'POST' && path === '/sessions/ask/dismiss') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机或已配对的手机上操作' }); return }
      if (sessionAnswer === undefined) { sendJson(res, 404, { error: '送回那家会话的路没接上' }); return }
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      const agent = typeof body.agent === 'string' ? body.agent : ''
      const id = typeof body.session_id === 'string' ? body.session_id : ''
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(agent) || id === '' || id.length > 200) {
        sendJson(res, 400, { error: '要带上是哪一家(agent)和哪条会话(session_id)' })
        return
      }
      const result = await sessionAnswer.dismiss(agent, id)
      if (!result.ok) { sendJson(res, result.status, { error: result.error }); return }
      noteBehavior({ 事: BEHAVIOR_EVENTS.dismiss, 对象: `待确认 ${agent}/${id}`, 结果: '不用管这条' })
      sendJson(res, 200, { ok: true })
      void composeState().then(state => broadcast({ kind: 'snapshot', state })).catch(() => {})
      return
    }

    /**
     * POST /sessions/reveal {agent, session_id}(卡 T):电脑上那颗「去回答」—— 把那段对话调到前面
     * (Claude / Codex 用它们自己的深链开到那一段;Kimi 只能把它叫到前面)。只认本机(手机上按了也调不到电脑前面给谁看)。
     */
    if (req.method === 'POST' && path === '/sessions/reveal') {
      if (!loopback) { sendJson(res, 403, { error: '「去回答」只在这台电脑上用' }); return }
      if (sessionAnswer === undefined) { sendJson(res, 404, { error: '送回那家会话的路没接上' }); return }
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      const agent = typeof body.agent === 'string' ? body.agent : ''
      const id = typeof body.session_id === 'string' ? body.session_id : ''
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(agent) || id === '' || id.length > 200) {
        sendJson(res, 400, { error: '要带上是哪一家(agent)和哪条会话(session_id)' })
        return
      }
      const result = await sessionAnswer.reveal(agent, id)
      sendJson(res, 200, result)
      return
    }

    /**
     * 会议模式(2026-09-21)。六条路由(10-09 加了 `/meeting/retry`),全部同一道门 `trusted`(回环或已配对的手机)——
     * 录音是这台机器上最私密的东西之一,跟 `/butler/item` 同门,不多开一条。
     *
     * 上传走的是**直连 8791 的 HTTP**,不是房间的 byte stream:一段十分钟的录音几 MB,
     * `wb.rpc` 那条文本流装不下(RPC_MAX_RESPONSE_BYTES 才 1MB),而 `wb.file` 那条会落进
     * 收件目录、变成一条「收到一个文件」的通知——那不是我们要的。代价写在交接第三节:
     * **出了局域网(走中转代理那条)传不了分段**,手机上会攒着等回到同一个网。
     */
    if (path === '/meeting/start' && req.method === 'POST') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机或已配对的手机上开会议' }); return }
      // 会议录音转纪要是实验那一样(2026-10-21):关着时开录那一下就挡下。
      if (await experimentOff('meeting')) { sendJson(res, 409, { error: EXPERIMENT_OFF_LINE, experiment_off: 'meeting' }); return }
      if (meeting === undefined) { sendJson(res, 404, { error: '会议模式未启用' }); return }
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      // client_key / started_at(2026-10-09):手机在外面先录着、连上了才补开 —— 同一个号回同一场,日期按开录那一刻。
      // plan_id(2026-10-10):会前登记过的那一场,开录接到同一个会议对象上。
      const started = await meeting.start({ title: body.title, client_key: body.client_key, started_at: body.started_at, plan_id: body.plan_id })
      if (!started.ok) { sendJson(res, 409, { error: started.error ?? '开不了' }); return }
      broadcast({ kind: 'snapshot', state: await composeState() })
      sendJson(res, 200, started)
      return
    }

    if (path === '/meeting/segment' && req.method === 'POST') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机或已配对的手机上传录音' }); return }
      if (meeting === undefined) { sendJson(res, 404, { error: '会议模式未启用' }); return }
      const query = new URLSearchParams(queryOf(req.url))
      const id = (query.get('id') ?? '').trim()
      const seq = Number(query.get('seq') ?? '')
      if (id === '' || !Number.isInteger(seq) || seq < 1) { sendJson(res, 400, { error: '要带 id 与 seq(从 1 开始)' }); return }
      const msRaw = Number(query.get('ms') ?? '')
      const raw = await readRawBody(req, MEETING_SEGMENT_MAX_BYTES)
      if (!raw.ok) { sendJson(res, 413, { error: raw.error }); return }
      const saved = await meeting.segment({
        id,
        seq,
        bytes: raw.body,
        ...(req.headers['content-type'] === undefined ? {} : { mimeType: String(req.headers['content-type']) }),
        ...(Number.isFinite(msRaw) && msRaw > 0 ? { ms: msRaw } : {}),
      })
      if (!saved.ok) { sendJson(res, 400, { error: saved.error ?? '这一段没收下' }); return }
      // 收一段不广播:一场会几十段,每段推一次整份快照是白费的(界面上也看不出差别)。
      sendJson(res, 200, { ok: true })
      return
    }

    if (path === '/meeting/finish' && req.method === 'POST') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机或已配对的手机上结束会议' }); return }
      if (meeting === undefined) { sendJson(res, 404, { error: '会议模式未启用' }); return }
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      const id = typeof body.id === 'string' ? body.id : ''
      if (id === '') { sendJson(res, 400, { error: '要带 id' }); return }
      const finished = await meeting.finish({ id, title: body.title })
      if (!finished.ok) { sendJson(res, 404, { error: finished.error ?? '没有这一场会议' }); return }
      broadcast({ kind: 'snapshot', state: await composeState() })
      sendJson(res, 200, { ok: true })
      return
    }

    /**
     * 拿现成材料出一份纪要(2026-10-13,卡「会议纪要按规则出 + 不靠现场录音的演示样例」)。
     *
     * **只给本机(`loopback`)**,与花名档案同一道门,不进房间代理白名单:`audio_path` 等于
     * 「读这台电脑上任意一个文件」,那条能力不交给远端(出门的手机、中转)。
     * 手机那边照旧只看、只建事项(`GET /meeting`、`/meeting/apply` 在白名单里)。
     */
    if (path === '/meeting/import' && req.method === 'POST') {
      if (!loopback) { sendJson(res, 403, { error: '导入转写只在这台电脑上做' }); return }
      if (await experimentOff('meeting')) { sendJson(res, 409, { error: EXPERIMENT_OFF_LINE, experiment_off: 'meeting' }); return }
      if (meeting === undefined) { sendJson(res, 404, { error: '会议模式未启用' }); return }
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      const imported = await meeting.import({ text: body.text, audio_path: body.audio_path, title: body.title, from: body.from, plan_id: body.plan_id })
      if (!imported.ok) { sendJson(res, 409, { error: imported.error ?? '导不进来' }); return }
      broadcast({ kind: 'snapshot', state: await composeState() })
      sendJson(res, 200, imported)
      return
    }

    /**
     * 放三场演示用的会(2026-10-13,卡「会议页不再空着」)。**只给本机**(同 `/meeting/import`):
     * 它会在她的工作目录里建三场会、问几次模型,这条能力不交给远端(出门的手机、中转),
     * 房间白名单里一个字没加(`channel-worker/src/rpc.ts`,那边有用例钉着「不进」)。
     *
     * 走的全是真路(`plan` → `answer` → `import`),所以这里不另造一条写数据的路 —— 一条调用而已。
     */
    if (path === '/meeting/seed-demo' && req.method === 'POST') {
      if (!loopback) { sendJson(res, 403, { error: '放演示用的会只在这台电脑上做' }); return }
      if (meeting === undefined) { sendJson(res, 404, { error: '会议模式未启用' }); return }
      const seeded = await meeting.seedDemo()
      if (!seeded.ok) { sendJson(res, 409, { error: seeded.error ?? '放不进去' }); return }
      broadcast({ kind: 'snapshot', state: await composeState() })
      sendJson(res, 200, seeded)
      return
    }

    /**
     * **放一套演示数据 / 清掉它**(2026-10-13,卡「演示数据一键放进去」)。
     *
     * **只给本机**(同 `/meeting/seed-demo`):它在她的看板上建十几张卡、往任务账上记一摞记录,
     * 这条能力不交给远端(出门的手机、中转),房间白名单里一个字没加
     * (`channel-worker/src/rpc.ts`,那边有用例钉着这两条「不进」)。
     *
     * 走的全是真路(`tasks.create` + 七态表 `move` + `jobLog.append` + `meeting.plan`),
     * 所以这里只做接线:哪几条数据、档位怎么判,都在 `demoSeed.ts` 与 `agentDayReview.ts` 里。
     */
    if ((path === '/demo/seed' || path === '/demo/clear') && req.method === 'POST') {
      if (!loopback) { sendJson(res, 403, { error: '放 / 清演示数据只在这台电脑上做' }); return }
      if (tasks === undefined) { sendJson(res, 404, { error: '任务看板未启用' }); return }
      // 看板的写门(同 `/task/*`、`/butler/item`):这两条在她的看板上建卡 / 挪卡,
      // 所以本机那条会话要动它也得过授权表那一关 —— 不因为「只给本机」就少一道门。
      const demoDenied = await agentWriteDenied(req, device)
      if (demoDenied !== undefined) { sendJson(res, 403, { error: demoDenied }); return }
      const board = {
        list: async () => (await tasks.list()).tasks,
        create: (input: CreateTaskInput) => tasks.create(input),
        move: (id: string, status: TaskStatus) => tasks.move(id, status),
        update: (id: string, input: UpdateTaskInput) => tasks.update(id, input),
      }
      if (path === '/demo/clear') {
        const cleared = await clearDemoData({ tasks: board })
        broadcast({ kind: 'snapshot', state: await composeState() })
        sendJson(res, 200, { ok: true, ...cleared })
        return
      }
      const topicsDir = template?.view().asset_dirs?.[TOPIC_DIR]
      const seeded = await seedDemoData({
        now: () => Date.now(),
        ...(routines === undefined ? {} : { lastMorningAt: () => routines.view().last.morning?.started_at }),
        tasks: board,
        appendJob: event => jobLog.append(event),
        ...(topicsDir === undefined
          ? {}
          : {
              ensureTopicDir: async (title: string) => {
                const made = await ensureTopicDir(topicsDir, title).catch((error: unknown) =>
                  ({ ok: false as const, reason: error instanceof Error ? error.message : String(error) }))
                return made.ok ? { ok: true } : { ok: false, reason: made.reason }
              },
            }),
        ...(meeting === undefined
          ? {}
          : {
              planMeeting: async (text: string) => {
                const planned = await meeting.plan({ text })
                return { ok: planned.ok, ...(planned.meeting === undefined ? {} : { title: planned.meeting.title }), ...(planned.error === undefined ? {} : { error: planned.error }) }
              },
              listMeetings: async () => {
                const view = await meeting.view()
                return [...view.recent, ...(view.upcoming ?? [])].map(one => ({ title: one.title, date: one.date }))
              },
              draftMeetingTitle: (said: string, nowMs: number) => draftMeetingPlan(said, nowMs),
            }),
        ...(routines === undefined ? {} : { runMorning: () => runMorningForDemo(routines) }),
      })
      broadcast({ kind: 'snapshot', state: await composeState() })
      sendJson(res, 200, { ok: true, ...seeded })
      return
    }

    if (path === '/meeting' && req.method === 'GET') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机或已配对的手机上看会议' }); return }
      if (meeting === undefined) { sendJson(res, 404, { error: '会议模式未启用' }); return }
      const id = (new URLSearchParams(queryOf(req.url)).get('id') ?? '').trim()
      if (id === '') { sendJson(res, 200, await meeting.view()); return }
      const view = await meeting.get(id)
      if (view === undefined) { sendJson(res, 404, { error: '没有这一场会议' }); return }
      sendJson(res, 200, view)
      return
    }

    /**
     * 「重新来」(2026-10-09):转写或梳理没成的那一场再跑一遍,只重做没成的那一截(meeting.ts 的 retry)。
     * 手机会议页与电脑收件箱那一档按的都是这一条。立刻返回,后台跑;状态变了照常广播。
     */
    if (path === '/meeting/retry' && req.method === 'POST') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机或已配对的手机上重新整理会议' }); return }
      if (meeting === undefined) { sendJson(res, 404, { error: '会议模式未启用' }); return }
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      const id = typeof body.id === 'string' ? body.id : ''
      if (id === '') { sendJson(res, 400, { error: '要带 id' }); return }
      const retried = await meeting.retry(id)
      if (!retried.ok) { sendJson(res, 409, { error: retried.error ?? '重来不了' }); return }
      broadcast({ kind: 'snapshot', state: await composeState() })
      sendJson(res, 200, { ok: true })
      return
    }

    /**
     * 会前(2026-10-10,卡「会前画像与预案」):登记一场待开的会、一问一答、预案卡、撤掉登记、会后那一句。
     * 同一道门 `trusted`;出门的手机经工人代理(白名单同步加了这几条)。花名档案两条**只给本机**(用户层,只在她电脑上)。
     */
    if (path === '/meeting/plan' && req.method === 'POST') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机或已配对的手机上登记会' }); return }
      if (meeting === undefined) { sendJson(res, 404, { error: '会议模式未启用' }); return }
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      const planned = await meeting.plan({ text: typeof body.text === 'string' ? body.text : '' })
      if (!planned.ok) { sendJson(res, 400, { error: planned.error ?? '没记上' }); return }
      broadcast({ kind: 'snapshot', state: await composeState() })
      sendJson(res, 200, planned)
      return
    }

    if (path === '/meeting/answer' && req.method === 'POST') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机或已配对的手机上答' }); return }
      if (meeting === undefined) { sendJson(res, 404, { error: '会议模式未启用' }); return }
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      const answered = await meeting.answer({
        ...(typeof body.id === 'string' && body.id !== '' ? { id: body.id } : {}),
        ...(typeof body.question === 'string' && body.question !== '' ? { question: body.question } : {}),
        answer: typeof body.answer === 'string' ? body.answer : '',
      })
      if (!answered.ok) { sendJson(res, 409, { error: answered.error ?? '没记上' }); return }
      broadcast({ kind: 'snapshot', state: await composeState() })
      sendJson(res, 200, answered)
      return
    }

    if (path === '/meeting/card' && req.method === 'POST') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机或已配对的手机上做预案卡' }); return }
      if (meeting === undefined) { sendJson(res, 404, { error: '会议模式未启用' }); return }
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      const id = typeof body.id === 'string' ? body.id : ''
      if (id === '') { sendJson(res, 400, { error: '要带 id' }); return }
      const made = await meeting.card({ id, proceed: body.proceed === true })
      if (!made.ok) { sendJson(res, 409, { error: made.error ?? '做不了', ...(made.note === undefined ? {} : { note: made.note }) }); return }
      broadcast({ kind: 'snapshot', state: await composeState() })
      sendJson(res, 200, made)
      return
    }

    if (path === '/meeting/drop' && req.method === 'POST') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机或已配对的手机上撤' }); return }
      if (meeting === undefined) { sendJson(res, 404, { error: '会议模式未启用' }); return }
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      const dropped = await meeting.drop(typeof body.id === 'string' ? body.id : '')
      if (!dropped.ok) { sendJson(res, 409, { error: dropped.error ?? '撤不了' }); return }
      broadcast({ kind: 'snapshot', state: await composeState() })
      sendJson(res, 200, dropped)
      return
    }

    if (path === '/meeting/outcome' && req.method === 'POST') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机或已配对的手机上回' }); return }
      if (meeting === undefined) { sendJson(res, 404, { error: '会议模式未启用' }); return }
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      const saved = await meeting.outcome({ id: typeof body.id === 'string' ? body.id : '', settled: body.settled, said: body.said })
      if (!saved.ok) { sendJson(res, 409, { error: saved.error ?? '没记上' }); return }
      broadcast({ kind: 'snapshot', state: await composeState() })
      sendJson(res, 200, saved)
      return
    }

    if (path === '/meeting/people' && req.method === 'GET') {
      if (!loopback) { sendJson(res, 403, { error: '花名档案只在这台电脑上看' }); return }
      if (meeting === undefined) { sendJson(res, 404, { error: '会议模式未启用' }); return }
      sendJson(res, 200, { people: await meeting.people() })
      return
    }

    if (path === '/meeting/people/forget' && req.method === 'POST') {
      if (!loopback) { sendJson(res, 403, { error: '花名档案只在这台电脑上改' }); return }
      if (meeting === undefined) { sendJson(res, 404, { error: '会议模式未启用' }); return }
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      const forgot = await meeting.forgetPerson(typeof body.alias === 'string' ? body.alias : '')
      if (!forgot.ok) { sendJson(res, 409, { error: forgot.error ?? '删不了' }); return }
      sendJson(res, 200, forgot)
      return
    }

    if (path === '/meeting/apply' && req.method === 'POST') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机或已配对的手机上建事项' }); return }
      if (meeting === undefined) { sendJson(res, 404, { error: '会议模式未启用' }); return }
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      const id = typeof body.id === 'string' ? body.id : ''
      if (id === '') { sendJson(res, 400, { error: '要带 id' }); return }
      // `todos` 不给 = 全建(手机上那颗「都建」);给了就只建挑中的那几条。
      const todos = Array.isArray(body.todos) ? body.todos.filter((one): one is string => typeof one === 'string') : []
      const applied = await meeting.apply(id, todos)
      if (!applied.ok) { sendJson(res, 409, { error: applied.error ?? '建不了' }); return }
      broadcast({ kind: 'snapshot', state: await composeState() })
      sendJson(res, 200, applied)
      return
    }

    /**
     * 统一输入框的四个菜单(2026-09-24,docs/设计-统一输入框-2026-09-24.md 第四节)。
     * **一份数据两端用**:电脑的档与手机的首页调的是这同一条。事务官的事,`trusted`。
     */
    if (path === '/composer/options' && req.method === 'GET') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机或已配对的手机上看' }); return }
      if (composer === undefined) { sendJson(res, 404, { error: '输入框的菜单没接上' }); return }
      const state = await composeState()
      let clis: ReadonlySet<AgentDispatchFamily>
      if (composer.clis !== undefined) clis = composer.clis()
      else {
        const home = pathsOption?.home ?? process.env.HOME ?? ''
        const probe: AgentCliProbe = {
          pathEnv: process.env.PATH,
          home,
          exists: existsSync,
          listDir: (dir) => { try { return readdirSync(dir) } catch { return [] } },
        }
        clis = new Set(dispatchTargetsNow().map(one => one.id).filter(family => resolveAgentCli(family, probe).found))
      }
      let apiReady = false
      try { apiReady = model === undefined ? false : (await model.endpoint()).ready } catch { apiReady = false }
      let catalog: Awaited<ReturnType<NonNullable<ButlerSessionOpener['catalog']>>>
      try { catalog = await butlerSession?.catalog?.() } catch { catalog = undefined }
      let projectList: readonly { id: string, name: string, idle?: boolean }[] = []
      try { projectList = (await projects?.getProjectsState())?.projects ?? [] } catch { projectList = [] }
      sendJson(res, 200, composerOptions({
        agents: composerAgents({
          state,
          clis,
          windowReady: clientDispatch !== undefined,
          apiReady,
          // 接口那只手上标「中转没配这家」要靠它(卡 GH);GPT 压根不在 targets 里。
          ...(relayProvidersNow() === undefined ? {} : { relayProviders: relayProvidersNow() as RelayProvidersView }),
          now: new Date(),
          appInstalled: clientAppInstalled,
          targets: dispatchTargetsNow(),
        }),
        choice: await composer.choice(),
        ...(catalog === undefined ? {} : { catalog }),
        tasks: state.tasks?.tasks ?? [],
        projects: projectList,
      }))
      return
    }

    /** 下拉里换了档 / 模型:记成默认(粘性,电脑与手机共用)。 */
    if (path === '/composer/choice' && req.method === 'POST') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机或已配对的手机上改' }); return }
      if (composer === undefined) { sendJson(res, 404, { error: '输入框的菜单没接上' }); return }
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      if (body.mode !== undefined && !isComposerMode(body.mode)) {
        sendJson(res, 400, { error: 'mode 要是 plan / ask / auto 之一(没有「全权」这一档)' })
        return
      }
      const rawModel = body.model as Record<string, unknown> | undefined
      const next = {
        ...(isComposerMode(body.mode) ? { mode: body.mode } : {}),
        ...(rawModel !== undefined && typeof rawModel.provider === 'string' && typeof rawModel.id === 'string'
          ? { model: { provider: rawModel.provider, id: rawModel.id } }
          : {}),
      }
      try {
        const saved = await composer.saveChoice(next)
        await refreshComposerView()
        composerViewAt = Date.now()
        broadcast({ kind: 'snapshot', state: await composeState() })
        sendJson(res, 200, { ok: true, choice: saved })
      }
      catch (err) { sendJson(res, 500, { error: `没记下:${(err as Error)?.message ?? '没说原因'}` }) }
      return
    }

    /**
     * 「+」里的加文件 / 粘贴 / 拖进来(2026-09-24)。原样字节,文件名在 `?name=`。
     * 落进电脑的收件文件夹 —— 与手机「发文件」那条字节流同一个地方;回执里的 id 就是文件名。
     */
    if (path === '/composer/upload' && req.method === 'POST') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机或已配对的手机上传文件' }); return }
      if (composer === undefined) { sendJson(res, 404, { error: '输入框的菜单没接上' }); return }
      const query = new URLSearchParams(queryOf(req.url))
      const name = (query.get('name') ?? '').trim()
      const raw = await readRawBody(req, 50 * 1024 * 1024)
      if (!raw.ok) { sendJson(res, 413, { error: raw.error }); return }
      const type = typeof req.headers['content-type'] === 'string' ? req.headers['content-type'] : undefined
      const saved = await composer.upload({ name, data: raw.body, ...(type === undefined ? {} : { type }) })
      if (!saved.ok) { sendJson(res, 400, { error: saved.error }); return }
      sendJson(res, 200, { ok: true, ...saved.view })
      return
    }

    /**
     * 「先问我」的审批:档上 / 手机上点「允许」「不行」。
     *
     * `scope: 'kind'`(2026-09-25,卡 M):「这件事里<同类的>都允许」—— 记下这件事的这一类,这一条放行,
     * 这件事里同类的、还挂着的几条一起放行(同一件事里同类的请求合并成一次),后面再来的同类的不再问。
     * 那一条没有「类」(命令里有删东西 / sudo、分不出类)就不收这个 scope(400),只能一条条批。
     */
    if (path === '/approvals/answer' && req.method === 'POST') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机或已配对的手机上批' }); return }
      // 「等你确认」只有她本人能答(2026-09-28,卡 BS):事务官、派出去的别家、随手一条 curl 一律拒。
      const notHer = notHerself(asker, 'answer')
      if (notHer !== undefined) { sendJson(res, 403, { error: notHer }); return }
      if (approvals === undefined) { sendJson(res, 404, { error: '审批没接上' }); return }
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      const id = typeof body.id === 'string' ? body.id : ''
      if (id === '' || typeof body.allow !== 'boolean') { sendJson(res, 400, { error: '要带 id 与 allow(true / false)' }); return }
      if (body.scope === 'kind') {
        const one = approvals.list().find(entry => entry.id === id)
        if (one === undefined) { sendJson(res, 409, { error: '这一条已经答过或取消了' }); return }
        if (body.allow !== true || one.kind === undefined || approvalGrants === undefined) {
          sendJson(res, 400, { error: '这一条分不出「同类的」,只能这一次一次地批' })
          return
        }
        // 记在这件事上(卡 M 追加:落盘,DSH 重启后同一类不再问;这件事收了就作废)。会话没挂在事项上时只记这条会话。
        const taskId = (await taskRefsNow()).find(task => task.conversation?.session_id === one.session_id)?.id
        const scope = { sessionId: one.session_id, ...(taskId === undefined ? {} : { taskId }) }
        approvalGrants.grant(scope, one.kind)
        if (taskId !== undefined) callOut?.touch?.(taskId)
        const kindKey = one.kind.key
        const same = approvals.list().filter(entry => entry.session_id === one.session_id && entry.kind?.key === kindKey)
        noteBehavior({ ...approvalNoteOf(one, true), 结果: '同意(同类的都放行)' })
        let merged = 0
        for (const entry of same) {
          if (!approvals.answer(entry.id, true)) continue
          if (entry.id !== id) { merged += 1; approvalGrants.noteAllowed(scope, kindKey) }
        }
        sendJson(res, 200, { ok: true, granted: one.kind.title, merged })
        return
      }
      const answeredOne = approvals.list().find(entry => entry.id === id)
      if (!approvals.answer(id, body.allow)) { sendJson(res, 409, { error: '这一条已经答过或取消了' }); return }
      if (answeredOne !== undefined) noteBehavior(approvalNoteOf(answeredOne, body.allow))
      if (answeredOne !== undefined) await touchSession(answeredOne.session_id)
      sendJson(res, 200, { ok: true })
      return
    }

    /**
     * 电话里答(2026-09-25,卡 M):事务官为「等你回答」打来的那一通里,他说了一句意思,工人原话转过来。
     * `{ item_id, said }` —— 那件事有一问在等:说中了某个选项就选它,认不准就把原话当「我自己说」交上去(不替他挑);
     * 有一条要批的在等:听出「批 / 不批」才交,听不出回 400(工人如实说没听清)。回包 `text` 是给工人念的那一句的依据。
     */
    if (path === '/asks/voice' && req.method === 'POST') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机或已配对的手机上答' }); return }
      // 电话里答的那一句也只认她本人(工人那把进程令牌 = 她在电话里亲口说的,见 herself.ts)。
      const notHerVoice = notHerself(asker, 'answer')
      if (notHerVoice !== undefined) { sendJson(res, 403, { error: notHerVoice }); return }
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      const itemId = typeof body.item_id === 'string' ? body.item_id.trim() : ''
      const said = typeof body.said === 'string' ? body.said.trim() : ''
      if (itemId === '' || said === '') { sendJson(res, 400, { error: '要带 item_id 与 said' }); return }
      // 电话里答的也算他刚动过手(卡 M 补:手机上答的同理)。
      callOut?.touch?.(itemId)
      const list = await taskRefsNow()
      /**
       * 答完这一问之后还有没有下一问(2026-09-25,卡 M 追加:「电话里一问一问答下去」)。几分钟内接连几问只响一次,
       * 所以这一通电话里要把在等他的挨个问完:回话里带上下一问(哪件事、那一句、选项),工人接着问;他说「先这样」就停。
       */
      const nextAsk = async (): Promise<{ item_id: string, title: string, note?: string } | undefined> => {
        const pending = [
          ...askCallOutEvents(questions === undefined ? [] : questionViews(questions.list(), list), approvals === undefined ? [] : (await approvalsNow() ?? [])),
          /**
           * 别家会话弹的那几个框也排在这一串里(2026-09-28,卡 WQ):他在电话里答完一道,
           * 同一通里接着问下一道(维护者那次就是两道题:菜系、菜品)。判据与座机那一路同一个函数。
           */
          // 窗口型各家(豆包)那一问也算下一问(2026-10-12):与答题那一路同一个池子,与座机排电话那一份对得上。
          ...sessionAskCallOutEvents({ sessions: relaySessionPool(), tasks: list, nowMs: Date.now() }),
          /**
           * 刚答的那一条会话**不算下一问**(判断要下一拍重扫才更新,不然会把同一个框问第二遍)。
           * 事项那一路不过这道筛子:同一件事上「答完一问、还有一条要批」是真有的下一问(卡 M 那条用例)。
           */
        ].filter(one => !(isSessionAskItem(one.item_id) && one.item_id === itemId))
        const first = pending[0]
        return first === undefined ? undefined : { item_id: first.item_id, title: first.title, ...(first.note === undefined ? {} : { note: first.note }) }
      }
      const question = questions === undefined ? undefined : questionViews(questions.list(), list).find(one => one.task_id === itemId)
      if (question !== undefined && questions !== undefined) {
        const item = question.questions[0]
        if (item === undefined) { sendJson(res, 409, { error: '这一问已经不在了' }); return }
        const { answer, picked } = voiceAnswerFor(item, said)
        /*
         * ★ **「只能选一项」的那几问:听不出是哪一项就一个字都不交**(2026-10-13 下午,卡 C;
         * 验收交接第三节第 19 条)。
         *
         * 14:3x 那一通:卡 t-86856ebb 撞上限、挂着一问「继续、停掉、还是换 Claude」,他说
         * 「看见了,嗯」→ 这里把它当「我自己说」交上去 → 200 ok → 她说「好了,替你选上了」,
         * 而 `budgetChoiceOf` 认不出这句话,**一个动作都没发生**,那张卡仍然 blocked。
         * 回 400 之后工人说的是「这一问得在电脑上答」(`answerAskSay` 的 400 那一档)。
         * 别的问照旧收「我自己说」(那一种交上去模型真读得到)。
         */
        if (picked === undefined && item.options.length > 0 && choiceOnlyAsk(item.id)) {
          sendJson(res, 400, { error: `没听准你要哪一个(它给的是:${item.options.map(one => one.text).join(' / ')}),一个都没选` })
          return
        }
        const result = questions.answer(question.id, [answer])
        if (!result.ok) { sendJson(res, result.status, { error: result.error }); return }
        noteBehavior({ 事: BEHAVIOR_EVENTS.decide, ...questionPickOf([item], [answer]), 原话: said, 起: question.at })
        const next = await nextAsk()
        sendJson(res, 200, { ok: true, kind: 'question', ...(picked === undefined ? { custom: said } : { picked }), ...(next === undefined ? {} : { next }) })
        return
      }
      const approval = approvals === undefined ? undefined : (await approvalsNow() ?? []).find(one => one.task_id === itemId)
      if (approval !== undefined && approvals !== undefined) {
        const verdict = voiceVerdict(said)
        if (verdict === undefined) { sendJson(res, 400, { error: '没听出是批还是不批' }); return }
        if (!approvals.answer(approval.id, verdict === 'allow')) { sendJson(res, 409, { error: '这一条已经答过或取消了' }); return }
        noteBehavior({ ...approvalNoteOf(approval, verdict === 'allow'), 原话: said })
        const next = await nextAsk()
        sendJson(res, 200, { ok: true, kind: 'approval', allow: verdict === 'allow', ...(next === undefined ? {} : { next }) })
        return
      }
      /**
       * ★ **某家会话自己弹的那个框**(2026-09-28,卡 WQ;`item_id` = `jobKey.sessionJobId` 那一种,
       * 2026-10-03 起 `session:<家>/<会话 id>`;**迁不动的老行**(`session:<会话 id>`)照旧读得出会话 id)。
       *
       * 电话里他说了一句 —— 说中了它写出来的某一项就**替他点下去**(壳 `agent_press`,点完重读一次核实);
       * 认不准(说的不是那几项里的)就**如实说没替他点**,绝不替他挑一个。
       * 这一路的 404 从前是句假话:那一问明明在等他,只是不挂在事项卡上。
       */
      const sessionItem = sessionAskSessionId(itemId)
      if (sessionItem !== undefined) {
        // 窗口型各家(豆包办公)那一问也在这里答(2026-09-28 Air 维护包:电话里答的豆包那一问一直 409)。
        const one = relaySessionPool().find(view => view.session_id === sessionItem && view.ask !== undefined)
        if (one === undefined || one.ask === undefined) { sendJson(res, 409, { error: '这一问已经不在了(那边已经往下走了)' }); return }
        /**
         * ★ **权限弹窗那一问**(2026-10-01,卡 AP):电话里她说「批准 / 可以 / 拒绝」→ 走手机上按键那同一条路
         * (`sessionAnswer.press` 认意思、重读弹窗、只按批准一次 / 拒绝、按完核实)。听不出 → 一颗都不按。
         */
        if (one.ask.permission !== undefined && (one.ask.options ?? []).length === 0) {
          if (sessionAnswer === undefined) { sendJson(res, 400, { error: '替你按那个弹窗的路没接上,一颗都没按' }); return }
          if (voiceVerdict(said) === undefined) { sendJson(res, 400, { error: '没听出是批准还是拒绝,一颗都没按' }); return }
          const pressed = await sessionAnswer.press(one.agent, one.session_id, said)
          if (pressed.ok) {
            await dropQueuedAsk(itemId, pressed.confirmed)
            sendJson(res, 200, { ok: true, kind: 'session', picked: pressed.label, confirmed: pressed.confirmed, ...(pressed.approved === undefined ? {} : { approved: pressed.approved }), ...(pressed.note === undefined ? {} : { note: pressed.note }) })
            void composeState().then(state => broadcast({ kind: 'snapshot', state })).catch(() => {})
            return
          }
          sendJson(res, pressed.status === 200 ? 400 : pressed.status, { error: pressed.status === 200 ? pressed.why : pressed.error })
          return
        }
        const option = spokenOptionOf(one.ask.options ?? [], said)
        if (option === undefined) {
          /**
           * ★ **她说的那一句不在那几项里 —— 那就把她那句原话送进去**(2026-09-28,卡 AT)。
           *
           * ★ 2026-10-02(审计第二表第 12 条,卡「引擎接线与删复制品」收成一份):
           * 从前这里只在 `ask.write === true`(= 那一家的提问面板认准了,今天只有豆包办公那一个包)
           * 时才肯送,别的一律回 400「一项都没点」—— 于是**同一句话从手机 / 电脑上答得进去,
           * 从电话里答不进去**(手机那条走 `sessionAnswer.answer`,它在面板写不进时会把她那句
           * 原样送进这条对话、按发送)。维护者 09-28 20:1x 的原话是「是把我的文字复制过去发送」,
           * 两条路本来就该是同一句话的两个入口。
           *
           * 现在**三条入口同一条路**:`sessionAnswer.answer` —— 它自己分岔(面板认准了就写面板,
           * 写不进就原样送进这条对话;权限弹窗那一类照旧不打字,如实说去点那两颗键)。
           */
          if (sessionAnswer !== undefined) {
            const sent = await sessionAnswer.answer(one.agent, one.session_id, said)
            if (sent.ok) {
              const confirmed = sent.confirmed !== false
              await dropQueuedAsk(itemId, confirmed)
              sendJson(res, 200, {
                ok: true,
                kind: 'session',
                custom: said,
                confirmed,
                ...(sent.note === undefined ? {} : { note: sent.note }),
              })
              void composeState().then(state => broadcast({ kind: 'snapshot', state })).catch(() => {})
              return
            }
            if (sent.status === 200) {
              /*
               * 送不进去:如实说是哪一种。**认不准她说的是哪一项**那一句照旧摆在前面
               * (电话里最要紧的是让她知道「我没替你挑」),后面接上那一家送不进去的原话。
               */
              const missed = one.ask.press === true
                ? `没听准他要哪一项(它给的是:${(one.ask.options ?? []).map(opt => opt.label).join(' / ')}),一项都没点`
                : undefined
              sendJson(res, 400, { error: missed === undefined ? sent.why : `${missed};${sent.why}` })
              return
            }
            sendJson(res, sent.status, { error: sent.error })
            return
          }
          sendJson(res, 400, {
            error: one.ask.press === true
              ? `没听准他要哪一项(它给的是:${(one.ask.options ?? []).map(opt => opt.label).join(' / ')}),一项都没点`
              : one.ask.where ?? '这一问得在电脑上那家自己的窗口里点,我替你点不了',
          })
          return
        }
        if (sessionAnswer === undefined) { sendJson(res, 400, { error: '替你点那个框的路没接上,这一项没点' }); return }
        const pressed = await sessionAnswer.press(one.agent, one.session_id, option.label)
        if (pressed.ok) {
          // 电话里替她点上了 → 排着的那一通(同一件事的另一通)撤掉(卡 AQ),核实过才撤。
          await dropQueuedAsk(itemId, pressed.confirmed)
          sendJson(res, 200, {
            ok: true,
            kind: 'session',
            picked: pressed.label,
            confirmed: pressed.confirmed,
            ...(pressed.note === undefined ? {} : { note: pressed.note }),
          })
          void composeState().then(state => broadcast({ kind: 'snapshot', state })).catch(() => {})
          return
        }
        sendJson(res, pressed.status === 200 ? 400 : pressed.status, { error: pressed.status === 200 ? pressed.why : pressed.error })
        return
      }
      sendJson(res, 404, { error: '这件事这会儿没有在等你回答的' })
      return
    }

    /**
     * ★ **「等你」那一堆里的一件,他答了**(2026-09-28,卡 WQ;设计-派活到收回一条链 第 ⑧ 环:**一个口**)。
     *
     * `{ key, choice?, text? }` —— `key` 就是 `/state.waiting` 里那一行的键(电脑、手机、电话读的是同一份):
     *   - `session:<哪一家>:<会话 id>`:`choice` = 它弹的框上那一项(替他点下去,壳 `agent_press`);
     *     `text` = 打一句送回那条会话(老路 `/sessions/answer`,弹框那种照旧送不进去、如实回「到电脑上点」);
     *   - `question:<id>`:事务官自己问的那一问(`choice` 选一项 / `text` 我自己说);
     *   - `approval:<id>`:要他批的那一条(`choice` = `allow` / `deny`)。
     *
     * 为什么要这一个口:同一件事以前电脑一份、手机一份、电话一份,漏改哪一份链就在那一环断。
     * 回包一律带 `confirmed`(核实过了没有)与一句 `note` —— **核不上就不说答上了**。
     */
    if (path === '/asks/answer' && req.method === 'POST') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机或已配对的手机上答' }); return }
      // 「等你确认」只有她本人能答(卡 BS 那道门;卡 WQ 新开的这个口同一条规矩)。
      const notHerAnswer = notHerself(asker, 'answer')
      if (notHerAnswer !== undefined) { sendJson(res, 403, { error: notHerAnswer }); return }
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      const key = typeof body.key === 'string' ? body.key.trim() : ''
      const choice = typeof body.choice === 'string' ? body.choice.trim() : ''
      const text = typeof body.text === 'string' ? body.text.trim() : ''
      if (key === '') { sendJson(res, 400, { error: '要带 key(「等你」那一行的键)' }); return }
      if (choice === '' && text === '') { sendJson(res, 400, { error: '要带 choice(点哪一项)或者 text(自己说一句)' }); return }
      if (key.startsWith(SESSION_JOB_PREFIX)) {
        /*
         * ★ **这一行的键只有一个定法**(2026-10-03,卡「两条接缝」;审计第二表第 15 条)。
         * 拼在 `jobKey.sessionJobId`、拆在 `jobKey.sessionOfJob`,这里不再自己切刀。
         *
         * 老格式(`session:<家>:<会话 id>`)照旧收:**手机包与插件是分开发版的**,
         * 她手机上那一版还在送老的那一种。收下来就当那一种读(`withAgent:true`),
         * 不去猜它是不是台账里那种 —— 两种老格式彼此有歧义,见 `legacySessionOfJob`。
         */
        const ref = sessionOfJob(key) ?? legacySessionOfJob(key, { withAgent: true })
        const agent = ref?.agent ?? ''
        const sessionId = ref?.sessionId ?? ''
        if (agent === '' || sessionId === '') { sendJson(res, 400, { error: 'key 不对:要 session:<哪一家>/<会话 id>' }); return }
        if (sessionAnswer === undefined) { sendJson(res, 404, { error: '送回那家会话的路没接上' }); return }
        /**
         * 他刚对这件事动过手(卡 M 补):之后 10 分钟里同一件的后续只发通知不响 ——
         * 一道题接一道题地答时,人就在屏幕前,不该每答一道手机就响一次。
         */
        callOut?.touch?.(sessionAskItemId(agent, sessionId))
        if (choice !== '') {
          const pressed = await sessionAnswer.press(agent, sessionId, choice)
          // 别家弹的框:只记她点了哪一项;那一问的正文是别家的聊天内容,不进账。
          if (pressed.ok) noteBehavior({ 事: BEHAVIOR_EVENTS.decide, 对象: `${agent} 的提问`, 结果: pressed.label })
          if (pressed.ok) {
            /**
             * ★ **答上了就把排着的那一通撤掉**(2026-09-28,卡 AQ)。真机 18:0x:她在电脑上答了
             * (`confirmed:true`),可 `call-out.json` 里那一通还挂着 `queued`(当时房里没有在线手机、没响)——
             * 等手机上线就要为一个**已经答掉的问**打过去,电话里那句「Codex 在等你选…」是句假话。
             * 不等下一拍是因为:那家窗口重读回来之前,那一问在事实源里还挂着。
             * **只在核实过之后撤**(`confirmed`):点了没看到它收下的,那一问可能还在等她。
             */
            await dropQueuedAsk(sessionAskItemId(agent, sessionId), pressed.confirmed)
            sendJson(res, 200, {
              ok: true,
              picked: pressed.label,
              confirmed: pressed.confirmed,
              note: !pressed.confirmed
                ? pressed.note
                : pressed.approved === 'once'
                  ? `已替你批准了这一次(按的是「${pressed.label}」)`
                  : pressed.approved === 'deny' ? `已替你拒绝了(按的是「${pressed.label}」)` : `已替你答了:${pressed.label}`,
            })
            void composeState().then(state => broadcast({ kind: 'snapshot', state })).catch(() => {})
            return
          }
          if (pressed.status === 200) { sendJson(res, 200, { ok: false, where: 'desk', why: pressed.why, reveal: pressed.reveal }); return }
          sendJson(res, pressed.status, { error: pressed.error })
          return
        }
        /**
         * ★ **她自己打的那一句**(卡 AT 2026-09-28 把弹框那一问接上了)。维护者原话:
         * 「做半天还是不能送进去?……你就复制黏贴我贴在框里的文字输入进去不就好了吗。」
         *
         * 一条路两种落点,`sessionAnswer.answer` 里分岔:打字送得回去的会话照旧打字送回去;
         * **弹框那一问**走壳的 `agent_write_ask` —— 她那句原文写进**那个面板自己的**自由作答框、
         * 按**面板自己的**发送键,再核实一次。`confirmed` 缺席(打字送回那两路)按「送到了」算,
         * 行为与从前一字不差;卡 AT 那一路核不上时 `confirmed:false`,**不许说成答上了**。
         */
        const sent = await sessionAnswer.answer(agent, sessionId, text)
        // 她写给别家的那句是别家的聊天正文,不进账;只记她自己写了一句。
        if (sent.ok) noteBehavior({ 事: BEHAVIOR_EVENTS.decide, 对象: `${agent} 的提问`, 结果: '自己写了一句' })
        if (sent.ok) {
          const confirmed = sent.confirmed !== false
          // 她那句送进去了 —— 同上(卡 AQ):那一问不再等她,排着的那一通撤掉。**核实过才撤。**
          await dropQueuedAsk(sessionAskItemId(agent, sessionId), confirmed)
          // 「已替你答了:<她那句>」只在**真核实过**那一路说(卡 AT);打字送回会话那两路照旧那句「送过去了」。
          sendJson(res, 200, { ok: true, confirmed, note: sent.note ?? (sent.confirmed === true ? `已替你答了:${text}` : '送过去了,它接着办') })
          void composeState().then(state => broadcast({ kind: 'snapshot', state })).catch(() => {})
          return
        }
        if (sent.status === 200) { sendJson(res, 200, { ok: false, where: 'desk', why: sent.why, reveal: sent.reveal, ...(sent.permission === true ? { permission: true } : {}) }); return }
        sendJson(res, sent.status, { error: sent.error })
        return
      }
      if (key.startsWith('question:')) {
        if (questions === undefined) { sendJson(res, 404, { error: '提问没接上' }); return }
        const id = key.slice('question:'.length)
        const pending = questions.list().find(one => one.id === id)
        if (pending === undefined) { sendJson(res, 409, { error: '这一问已经答过或撤了' }); return }
        const first = pending.questions[0]
        if (first === undefined) { sendJson(res, 409, { error: '这一问已经不在了' }); return }
        const answer = choice === ''
          ? { id: first.id, selected: [], custom: text }
          : { id: first.id, selected: [choice] }
        const result = questions.answer(pending.id, [answer])
        if (!result.ok) { sendJson(res, result.status, { error: result.error }); return }
        noteBehavior({ 事: BEHAVIOR_EVENTS.decide, ...questionPickOf(pending.questions, [answer]), 起: pending.at })
        await touchSession(pending.session_id)
        sendJson(res, 200, { ok: true, confirmed: true, note: choice === '' ? '你说的那句交上去了' : `已替你答了:${choice}` })
        return
      }
      if (key.startsWith('approval:')) {
        if (approvals === undefined) { sendJson(res, 404, { error: '审批没接上' }); return }
        const id = key.slice('approval:'.length)
        // 批不批只认这两个词(电话那一路在工人侧已经收成了 allow / deny):听不出的不许替他批。
        const allow = choice === 'allow' ? true : choice === 'deny' ? false : undefined
        if (allow === undefined) { sendJson(res, 400, { error: '要批的那一条只收 choice=allow / deny' }); return }
        const one = approvals.list().find(entry => entry.id === id)
        if (!approvals.answer(id, allow)) { sendJson(res, 409, { error: '这一条已经答过或取消了' }); return }
        if (one !== undefined) noteBehavior(approvalNoteOf(one, allow))
        if (one !== undefined) await touchSession(one.session_id)
        sendJson(res, 200, { ok: true, confirmed: true, note: allow ? '批了,它接着办' : '没批,它会换个办法或者停下来' })
        return
      }
      sendJson(res, 400, { error: `这种「等你」还没有一个口能替你答(key:${key.slice(0, 40)})` })
      return
    }

    /** 收回「这件事里同类的都允许」(2026-09-25,卡 M)。之后同类的又一条条问他。 */
    if (path === '/approvals/grant/revoke' && req.method === 'POST') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机或已配对的手机上改' }); return }
      if (approvalGrants === undefined) { sendJson(res, 404, { error: '审批没接上' }); return }
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      const sessionId = typeof body.session_id === 'string' ? body.session_id : ''
      const taskId = typeof body.task_id === 'string' && body.task_id !== '' ? body.task_id : undefined
      const key = typeof body.key === 'string' ? body.key : ''
      if ((sessionId === '' && taskId === undefined) || key === '') { sendJson(res, 400, { error: '要带 key,和 task_id 或 session_id' }); return }
      const revoking = approvalGrants.list().find(one => one.key === key && (taskId === undefined ? one.session_id === sessionId : one.task_id === taskId))
      if (!approvalGrants.revoke({ sessionId, ...(taskId === undefined ? {} : { taskId }) }, key)) { sendJson(res, 409, { error: '本来就没有这一条' }); return }
      // 收回 = 她纠正了「这一类不用问」(学到的「不问」据此撤,`habits.ts`)。
      noteBehavior({ 事: BEHAVIOR_EVENTS.decide, 对象: `${taskId ?? sessionId} ${revoking?.title ?? key}`, 结果: GRANT_REVOKED, 类: key })
      sendJson(res, 200, { ok: true })
      return
    }

    /**
     * 她在 DSH 会话里问他的话,电脑 / 手机上答(2026-09-25,卡 M;维护者点名的 bug)。
     * `{ id, answers: [{ id, selected, custom? }] }` —— 与 DSH 的回答同形;选的必须是原样的选项名。
     * 答完那一问从两端同时消失,答案送回那条会话,她接着干。
     */
    if (path === '/questions/answer' && req.method === 'POST') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机或已配对的手机上答' }); return }
      // 同 /approvals/answer:她问他的话只有他能答(2026-09-28,卡 BS)。
      const notHerAsk = notHerself(asker, 'answer')
      if (notHerAsk !== undefined) { sendJson(res, 403, { error: notHerAsk }); return }
      if (questions === undefined) { sendJson(res, 404, { error: '提问没接上' }); return }
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      const id = typeof body.id === 'string' ? body.id : ''
      if (id === '') { sendJson(res, 400, { error: '要带 id 与 answers' }); return }
      // 这一问挂在哪件事上(答之前先查:答完它就不在了)—— 他刚对这件事动过手,之后几分钟不为它打电话(卡 M 补)。
      const pendingOne = questions.list().find(one => one.id === id)
      const result = questions.answer(id, body.answers)
      if (!result.ok) { sendJson(res, result.status, { error: result.error }); return }
      if (pendingOne !== undefined) noteBehavior({ 事: BEHAVIOR_EVENTS.decide, ...questionPickOf(pendingOne.questions, body.answers), 起: pendingOne.at })
      if (pendingOne !== undefined) await touchSession(pendingOne.session_id)
      sendJson(res, 200, { ok: true })
      return
    }

    /**
     * ★ **此刻挂着的第一问**(2026-10-13,卡「三个入口一套管线」)。
     * 池子与 `/asks/voice` 的「下一问」**一模一样**(问句 / 审批 / 窗口型各家那个面板),
     * 不另起一份:那边答完一道接着问下一道,这边判「她这一句是在答那一问」,看的必须是同一份。
     */
    async function firstPendingAsk(): Promise<{ item_id: string, title: string, options?: readonly string[] } | undefined> {
      const list = await taskRefsNow()
      const asked = questions === undefined ? [] : questionViews(questions.list(), list)
      const pending = [
        ...askCallOutEvents(asked, approvals === undefined ? [] : (await approvalsNow() ?? [])),
        ...sessionAskCallOutEvents({ sessions: relaySessionPool(), tasks: list, nowMs: Date.now() }),
      ]
      const first = pending[0]
      if (first === undefined) return undefined
      /*
       * ★ **那一问摆着哪几项,一起带下去**(2026-10-13 下午,卡 C):`understand()` 判
       * 「她这一句是在答那一问」要对着选项比 —— 不带下去,随口一句都会被当成答案(第 19 条)。
       *
       * 两个池子两个出处:窗口型各家那个面板在事件的 `ask.options` 上;事务官自己问的那一问
       * 在 `questionViews` 里(事件只带一个 `note`,不解析那一句)。要批的那一条没有选项
       * (批 / 不批由 `voiceVerdict` 认),照旧缺席。
       */
      const options = (() => {
        const fromForm = (first as { ask?: { options?: readonly string[] } }).ask?.options
        if (fromForm !== undefined && fromForm.length > 0) return fromForm
        const id = first.key.startsWith(QUESTION_ASK_KEY) ? first.key.slice(QUESTION_ASK_KEY.length) : undefined
        const labels = id === undefined ? [] : (asked.find(one => one.id === id)?.questions[0]?.options ?? []).map(one => one.text)
        return labels.length > 0 ? labels : undefined
      })()
      return { item_id: first.item_id, title: first.title, ...(options === undefined ? {} : { options }) }
    }

    /**
     * ★ **这一句怎么理解**(2026-10-13,卡「三个入口一套管线」;判据与顺序在 `server/understand.ts`)。
     *
     * 这一层只做一件事:把 `understand()` 要的那几样**数出来**(认不认得名字、挂着哪一问、
     * 在办哪一件、此刻是哪一版待办),然后调那一个纯函数。
     * **认名字用的是家族目录那一套**(`dispatchFamilyOf` + `dispatchNameTargetsNow`,与派活同一份),
     * 没抄第二份名单。
     *
     * 挂着的那一问只在**电话**那条路上数(答那一问与补细节两档只对电话岔;电脑 / 手机上她在界面里点)——
     * 省掉文字入口每一句话一次扫池子。
     */
    async function understandingFor(said: string, input: {
      source?: unknown
      open?: unknown
      can_file_ask?: unknown
      can_meeting_plan?: unknown
    }): Promise<Understanding> {
      const source = input.source === 'call' ? 'call' as const : input.source === 'phone' ? 'phone' as const : 'desk' as const
      /*
       * **数不出来的那几样一律缺席**(认名字、此刻哪一版待办、挂着哪一问)。
       * 这几样都是「锦上添花」:缺了只是少认出一档,而抛出来会把一句普通的交代整条打回。
       */
      let family: AgentDispatchFamily | undefined
      try { family = dispatchFamilyOf(said, dispatchNameTargetsNow()) } catch { family = undefined }
      let layout: WorkbenchLayout | undefined
      try { layout = await projects?.getLayout?.() } catch { layout = undefined }
      const open = (input.open ?? undefined) as { item_id?: unknown, said?: unknown, at_ms?: unknown } | undefined
      /*
       * ★ `first`(2026-10-13 晚,卡 P):这是那件事之后的第一句吗。**只在电话那条路上数**
       * (补细节本来就只认电话;文字入口压根不带 `open`)。中间插过别的话 → `false`,
       * `understand()` 第 ⑤ 档据此不再往那件事上并。
       */
      const openItem = typeof open?.item_id === 'string' && open.item_id !== '' && typeof open.at_ms === 'number'
        ? {
            item_id: open.item_id,
            said: typeof open.said === 'string' ? open.said : '',
            at_ms: open.at_ms,
            ...(source === 'call' ? { first: appendGate.firstAfter({ item_id: open.item_id, at_ms: open.at_ms }, said) } : {}),
          }
        : undefined
      const openAsk = source === 'call' ? await firstPendingAsk().catch(() => undefined) : undefined
      const ctx: UnderstandContext = {
        nowMs: Date.now(),
        source,
        ...(family === undefined ? {} : { named: { family, title: DISPATCH_FAMILY_TITLES[family] ?? family } }),
        ...(openItem === undefined ? {} : { open: openItem }),
        ...(openAsk === undefined ? {} : { openAsk }),
        ...(layout?.today_view === undefined ? {} : { todayView: layout.today_view }),
        ...(input.can_file_ask === true ? { canFileAsk: true } : {}),
        ...(input.can_meeting_plan === true ? { canMeetingPlan: true } : {}),
      }
      const understood = understand(said, ctx)
      /*
       * ★ 实验开关(2026-10-21,卡「引导三件事」):认出来的是关着的那一类(做视频、登记一场会)→ 不打任何一条路,
       * 只回那一句「这一类还在内测,我先不接」。电话工人照 `ask` 念它(「只回问一句、什么都不办」那一档)。
       */
      const gated = experimentOfUnderstanding(understood.kind)
      if (gated === undefined || !(await experimentOff(gated))) return understood
      const { route: _route, ...rest } = understood
      return { ...rest, confirm: { needed: false }, say: { start: '' }, ask: EXPERIMENT_OFF_LINE, experiment_off: gated, why: `${understood.why}(实验开关关着,不接)` }
    }

    /**
     * ★ **换「今天的待办」那一版只有这一处**(2026-10-13):`POST /today/view` 与 `/butler/item` 上
     * 那一道新岔口(文字交代 / 电话里说的那一句)走的是同一个函数 —— 两头各写一遍必然漂。
     */
    async function switchTodayView(next: TodayViewStyle, said?: unknown): Promise<
      { ok: true, changed: boolean, note?: string } | { ok: false, status: number, error: string }
    > {
      if (projects?.getLayout === undefined || projects.setLayout === undefined) return { ok: false, status: 404, error: '项目区未启用' }
      const current = await projects.getLayout()
      if (current === undefined) return { ok: false, status: 409, error: '此刻读不到布局,没换。' }
      if ((current.today_view ?? 'flat') === next) {
        // 本来就是这一版 = 什么都没发生,**不留痕**(留了她会以为刚换过一次)。
        return { ok: true, changed: false, note: demoTodayViewSameSay(next) }
      }
      if (template !== undefined) await template.snapshotLayout(`今天的待办改成${TODAY_VIEW_TITLES[next]}`)
      await projects.setLayout({ ...current, today_view: next })
      console.log(`[版面] 今天的待办 → ${TODAY_VIEW_TITLES[next]}(${behaviorEnd ?? '本机'})`)
      noteBehavior({ 事: BEHAVIOR_EVENTS.layout, 对象: '今天的待办', 结果: TODAY_VIEW_TITLES[next] })
      /*
       * ★ 留痕(2026-10-13):**她说了一句话才留**(`said` 在) —— 设置里那两颗键是她自己在页面上点的,
       * 不出字。电话那条路(`/today/view`)与交代框那条路(`/butler/item`)都走这一个函数,所以只记这一处。
       */
      noteUnderstood(req, device, { kind: 'today_view', said, done: demoTodayViewSay(next) })
      broadcast({ kind: 'snapshot', state: await composeState() })
      return { ok: true, changed: true }
    }

    /**
     * ★ **一条发布计划落盘只有这一处**(2026-10-13 下午,卡 B)。
     *
     * `POST /butler/item` 上那一道岔口(她一句话说完)与 `POST /publish/plan`(模型那条路调
     * `wb_publish_plan`)走的是同一个函数 —— 两头各写一遍,落出来的卡必然两样,
     * 而「与『卡片内填』逐字同形」正是这件事的全部要求(`client/PublishModule.tsx` 文件头那张两状态表)。
     *
     * 不开会话、不建派活卡、不另起一套存储;同一天同一条重复说不重复记。
     */
    async function recordPublishPlan(input: {
      title: string
      day: string
      contentType: TopicContentType
      said: string
      from?: string
    }): Promise<{ ok: true, body: Record<string, unknown> } | { ok: false, status: number, error: string }> {
      if (tasks === undefined) return { ok: false, status: 404, error: '任务看板未启用' }
      const { title, day, contentType } = input
      // 同一天同一条重复说不重复记:回原来那张,如实说一句「没重复记」。
      const already = samePublishPlanOn((await tasks.list()).tasks, day, title)
      if (already !== undefined) {
        return { ok: true, body: { ok: true, id: already.id, publish_plan: { day, title, already: true }, note: publishPlanAlreadyReply({ title }, day) } }
      }
      const created = await tasks.create({
        title,
        desc: publishPlanDescOf({ said: input.said, ...(input.from === undefined ? {} : { from: input.from }) }),
        status: 'todo',
        kind: 'topic',
        stage: DEFAULT_TOPIC_STAGE,
        contentType,
        plannedAt: day,
        /*
         * **不盖 `direction:'mine'` / `origin:'user'`** —— 与「卡片内填」那一条逐字同形(它只给这五格)。
         * 盖上去就多两件事:这条计划会跑进事项收件箱「我交给事务官的」那一摞(而没有谁在办它),
         * 而且 desc 里她那句原话会被固化提议当成「她反复在说的话」去数(见 protocol.ts `TaskOrigin` 那一段)。
         */
      })
      if (!created.ok || created.id === undefined) return { ok: false, status: 400, error: created.reason ?? '这条发布计划没记上' }
      /*
       * 一条选题 = 顺手把 `选题/<名>/` 与它底下的 `素材/` 建出来(与 `/task/create` 那一段同一个口):
       * 她在日历上点一天填出来的那一条有这个目录,电话里说出来的那一条也该有。
       * 建不出来(没配工作目录)**不让这条计划失败** —— 原因如实带在回执里,不静默吞掉(D13)。
       */
      const topicsDir = template?.view().asset_dirs?.[TOPIC_DIR]
      const dir = topicsDir === undefined ? undefined : await ensureTopicDir(topicsDir, title).catch(() => undefined)
      // ★ 留痕(2026-10-13):日历上多了一条,但事务官那里也该有一行「你说… → 记进发布计划了」。
      noteUnderstood(req, device, { kind: 'publish_plan', said: input.said, done: publishPlanReply({ title }, day) })
      broadcast({ kind: 'snapshot', state: await composeState() })
      return {
        ok: true,
        body: {
          ok: true,
          id: created.id,
          publish_plan: { day, title, content_type: contentType },
          note: publishPlanReply({ title }, day),
          ...(dir?.ok === true ? { dir: dir.dir } : dir?.reason === undefined ? {} : { dir_note: dir.reason }),
        },
      }
    }

    /**
     * ★ **`POST /publish/plan`**(2026-10-13 下午,卡 B;**新增、additive**)——
     * `{ title, date, content_type?, said? }` → 日历上多一条发布计划。
     *
     * 为什么要这么一条路由:场景 4 那一通里她说「你帮我记到日历上面去啊?」—— 8791 没认出来,
     * 电话工人手上又没有一件「记发布计划」的工具,于是模型**编了一件不存在的** `wb_calendar_add`,
     * 转头用 `wb_dispatch_item` 建了张没负责人的卡说「我去办」(卡 B′ 那一条)。
     * 现在工人那头有 `wb_publish_plan`,打的就是这一条;判据与落盘仍只在工作台这一侧。
     *
     * `date` 两种都收:`YYYY-MM-DD`(模型自己算好的)或她的原话那一截(「20 号」「下周三」)——
     * 后者交给 `parsePublishDay`(**日子那张表只有那一份**)。算不出 / 没说要发什么:
     * **400 + 回问那一句**,一张卡都不建、一个字都不猜(同 `/butler/item` 那一档)。
     *
     * 门同 `/butler/item`(回环或已配对设备);房间代理白名单也放了这一条
     * (`channel-worker/src/rpc.ts` —— **房间协议那条接缝,主人工人**),出门经中转时手机 / 听筒照样记得上。
     */
    if (path === '/publish/plan' && req.method === 'POST') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机或已配对的手机上记发布计划' }); return }
      const denied = await agentWriteDenied(req, device)
      if (denied !== undefined) { sendJson(res, 403, { error: denied }); return }
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      const contentType: TopicContentType = body.content_type === '图文' ? '图文' : '视频'
      const title = publishPlanTitleOf(typeof body.title === 'string' ? body.title : '', contentType)
      if (title === '') { sendJson(res, 400, { error: PUBLISH_PLAN_ASK_SUBJECT }); return }
      const date = typeof body.date === 'string' ? body.date.trim() : ''
      const day = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : parsePublishDay(date, Date.now()).day
      if (day === undefined) { sendJson(res, 400, { error: PUBLISH_PLAN_ASK_DAY }); return }
      const said = typeof body.said === 'string' && body.said.trim() !== '' ? body.said.trim() : title
      // 来源那一格照 `behaviorEndOf` 那一份口径算(工人带着 actor 令牌 → 「电话」);算不出就整行不写,不编一个。
      const done = await recordPublishPlan({ title, day, contentType, said, ...(behaviorEnd === undefined ? {} : { from: behaviorEnd }) })
      if (!done.ok) { sendJson(res, done.status, { error: done.error }); return }
      sendJson(res, 200, done.body)
      return
    }

    /**
     * ★ **`POST /butler/understand`**(2026-10-13,卡「三个入口一套管线」)——
     * 文字进、一份 {@link Understanding} 出,**一个字都不办、一行都不写盘**。
     *
     * 为什么要这么一条路由:电话工人跑在 `channel-worker` 里(顶层各子目录互不 import,AGENTS.md),
     * 不给它一条口子,它就只能自己再写一份认话 —— 那正是 10-13 早那一通的病根(三个入口三套)。
     * 同 `/confirm/points` 的分寸:规则在工作台,工人只负责把这一句送过来、照回包办。
     *
     * 门同 `/butler/item`(回环或已配对设备);房间代理白名单也放了这一条
     * (`channel-worker/src/rpc.ts` —— **房间协议那条接缝,主人工人**),出门时手机照样问得到。
     */
    if (path === '/butler/understand' && req.method === 'POST') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机或已配对的手机上问' }); return }
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      const said = typeof body.text === 'string' ? body.text.trim() : ''
      if (said === '') { sendJson(res, 400, { error: 'text 必须是非空字符串(她那一句)' }); return }
      if (said.length > 2000) { sendJson(res, 400, { error: '这句太长了(上限 2000 字)' }); return }
      const understanding = await understandingFor(said, body)
      // 1a(2026-10-24)加的 `list` 格保留(1d 对照测试读它);快路径 2026-10-29 随旧路删除,
      // 一律按规则那一档映射成单件(保守:不认拿不准的,记或闲聊)。
      const list = {
        items: [understanding.kind === 'none'
          ? { kind: '闲聊', title: said, risk: 'none', confidence: 0.5, why: understanding.why }
          : { kind: '记', title: said.slice(0, 60), risk: 'none', confidence: 0.5, why: understanding.why }],
      }
      sendJson(res, 200, { ok: true, understanding, list })
      return
    }


    /** 协作区名片(最小必要格;@候选与点名解析同一源)。 */
    async function tasksStateCardsNow(): Promise<readonly import('../protocol.ts').AgentCard[]> {
      try { return (await tasks?.list())?.agent_cards ?? [] } catch { return [] }
    }


    /*
     * ★ 2026-10-29 删规矩第一批(入口归一):1a 听懂单中枢(understandSaid / runSayPlan / sayCompatForItem,
     * 连带快路径、四档置信度、旁人声快判、指令清单)随旧路一并删除 —— /butler/say 与 /butler/item
     * 都进理解中枢,判断全在 `hub/`;这里只留中枢要用的模型端点与几只手。
     */
    /** 模型端点:与产品同一个 modelService 入口;接不上由中枢如实回「没接上」。 */
    async function sayModelEndpointNow(): Promise<import('./hub/understand.ts').HubModelEndpoint> {
      if (options.model === undefined) throw new Error('no model')
      const ep = await options.model.endpoint()
      return { baseUrl: ep.baseUrl, key: ep.key, ...(ep.model === undefined ? {} : { model: ep.model }), ready: ep.ready }
    }

    async function switchVoiceGender(want: 'female' | 'male'): Promise<{ ok: boolean, note: string }> {
      if (butler === undefined) return { ok: false, note: '语音后端没接上,音色换不了' }
      try {
        const listRes = await butler.proxy({ method: 'GET', path: '/api/voices' })
        if (listRes.status !== 200) return { ok: false, note: '语音后端没回话,音色这会儿换不了' }
        const list = JSON.parse(listRes.body.toString('utf8')) as { voices?: { id?: string, gender?: string, speaks_chinese?: boolean }[] }
        const wantRe = want === 'female' ? /女|female/i : /男|male/i
        const pick = (list.voices ?? []).find(v => wantRe.test(v.gender ?? '') && v.speaks_chinese === true && typeof v.id === 'string' && v.id !== '')
          ?? (list.voices ?? []).find(v => wantRe.test(v.gender ?? '') && typeof v.id === 'string' && v.id !== '')
        if (pick?.id === undefined || pick.id === '') return { ok: false, note: `音色库里没找到${want === 'female' ? '女' : '男'}声,没换` }
        const putRes = await butler.proxy({ method: 'PUT', path: '/api/voices/current', contentType: 'application/json', body: Buffer.from(JSON.stringify({ voice_id: pick.id })) })
        return putRes.status === 200
          ? { ok: true, note: `音色换成${want === 'female' ? '女声' : '男声'}了` }
          : { ok: false, note: '语音后端没认这一换,音色还是原来那条' }
      } catch {
        return { ok: false, note: '语音后端没起来,音色没换成' }
      }
    }

    /**
     * 改派的落地(唯一一处):收场旧派发 → 换负责人 → 同卡重派。
     * `who` 已解析(名片 id 优先,家名兜底);回包给执行层拼回话。改派不改名 —— 卡的标题一字不动。
     * `source` 由调用方按派活者给(中枢手传 'hub' / 'call';旧 say 路传 sayPlanDispatchSource)。
     */
    async function applyReassignDispatch(req: IncomingMessage, cardId: string, who: { family: string, cardId?: string }, source: ClientDispatchSource): Promise<{ ok: boolean, note: string }> {
      if (tasks === undefined) return { ok: false, note: '任务看板未启用' }
      const board = await tasks.list().catch(() => ({ tasks: [] as TaskView[] }))
      const card = board.tasks.find(one => one.id === cardId)
      if (card === undefined) return { ok: false, note: missingCardSayLine(cardId) }
      const settled = await settleRunningDispatch(card)
      if (!settled.settled && settled.note !== undefined) return { ok: false, note: `没改派成:${settled.note}` }
      const assignee = who.cardId ?? who.family
      await tasks.update(cardId, { assignee }).catch(() => false)
      const cards = await tasksStateCardsNow()
      const whoTitle = who.cardId !== undefined
        ? (cards.find(one => one.id === who.cardId)?.name ?? who.family)
        : (DISPATCH_FAMILY_TITLES[who.family as keyof typeof DISPATCH_FAMILY_TITLES] ?? who.family)
      const prevTitle = card.assignee === undefined ? undefined
        : (cards.find(one => one.id === card.assignee)?.name
          ?? (isAgentDispatchFamily(card.assignee) ? DISPATCH_FAMILY_TITLES[card.assignee] : card.assignee))
      const settledTail = settled.settled ? `,原来${prevTitle ?? '那'}${REASSIGN_SETTLED_TAIL}` : ''
      const ran = await withActorNoteFor(req, 'dispatch.run', () => dispatchItem(cardId, {
        family: assignee as AgentDispatchFamily,
        text: card.desc ?? card.title,
        source,
        takeover: true,
      })).catch(() => ({ ok: false as const }))
      if (ran.ok !== true) {
        // 人换了、旧派收了场,这一句都照说;没派出去如实接原因,不冒称「已改派」。
        return { ok: false, note: `${cardId} 已改派给${whoTitle}${settledTail},可这次没派出去:${'note' in ran && typeof ran.note === 'string' ? ran.note : '没派成'}` }
      }
      return { ok: true, note: reassignSayLine(cardId, whoTitle, prevTitle, settled.settled) }
    }

    /**
     * Codex 事项来源只读 task.links 精确登记的会话，权限与项目逐次核验。
     * 从本机 feed/index 定位后复用 transcript/digest 解析，不用派活状态代替原文。
     */
    async function cliSourceRead(agent: string, id: string): Promise<{ kind: 'ok', turns: { k: 'ask' | 'reply', text: string, at?: string }[], read_at: string } | { kind: 'unsupported' | 'not_linked' | 'not_synced' }> {
      if (agent !== 'kimi') return { kind: 'unsupported' }
      if (!safeCliSessionId(id) || tasks === undefined) return { kind: 'not_linked' }
      const board = await tasks.list().catch(() => ({ tasks: [] as { links?: readonly { agent?: string, session_id?: string }[] }[] }))
      const linked = board.tasks.some(one => (one.links ?? []).some(link => link.agent === agent && link.session_id === id))
      if (!linked) return { kind: 'not_linked' }
      const home = process.env.KIMI_CODE_HOME ?? osHomedir()
      const got = await readKimiCliSession(home, id).catch(() => undefined)
      return got === undefined ? { kind: 'not_synced' } : { kind: 'ok', turns: got.turns, read_at: got.read_at }
    }

    /* ──────── 理解中枢 A1(2026-10-28,设计 `docs/设计-理解中枢-模型出命令-2026-10-28.md`):电脑对话框的新路。
       判断全在 `src/server/hub/`;这里只把现有的手(卡与目标的账、派活、停掉一件、用户层、规矩、反馈)
       与上下文包要的事实接给它,契约一个不改。─────── */

    /** 每只手此刻的状态:派活选项表(写代码 / 聊天两类)+ 命令行登录探测 + 板上在跑几件;名片随它那一家。 */
    async function hubHandsNow(said: string, board: { tasks: readonly TaskView[], agent_cards?: readonly import('../protocol.ts').AgentCard[] }): Promise<HubHand[]> {
      const code = await choicesFor(undefined, { kind: 'code', text: said }).catch(() => undefined)
      const chat = await choicesFor(undefined, { kind: 'chat', text: said }).catch(() => undefined)
      const running = (match: (task: TaskView) => boolean): number => board.tasks.filter(one => one.dispatch?.status === 'running' && match(one)).length
      const families = new Map<string, HubHand>()
      for (const family of new Set([...(code?.options ?? []), ...(chat?.options ?? [])].map(one => one.family))) {
        const codeOpt = code?.options.find(one => one.family === family)
        const chatOpt = chat?.options.find(one => one.family === family)
        const fact = (CODE_CLI_FAMILIES as readonly string[]).includes(family) ? agentCaps?.cliFact?.(family as never) : undefined
        const balance = (codeOpt?.ok === true ? codeOpt : chatOpt?.ok === true ? chatOpt : codeOpt ?? chatOpt)?.balance
        const why = codeOpt?.ok === true || chatOpt?.ok === true ? undefined : codeOpt?.why ?? chatOpt?.why
        families.set(family, {
          id: family,
          title: codeOpt?.title ?? chatOpt?.title ?? family,
          family,
          card: false,
          installed: fact === undefined ? undefined : fact.found,
          login: fact?.login ?? 'unknown',
          quota: balance?.level ?? 'unknown',
          ...(balance?.text === undefined ? {} : { quota_text: balance.text }),
          running: running(task => task.dispatch?.family === family),
          ok: codeOpt?.ok === true || chatOpt?.ok === true,
          ...(why === undefined ? {} : { why }),
          code: codeOpt?.ok === true,
          ...(code?.default === family ? { recommended: true } : {}),
        })
      }
      const cards = (board.agent_cards ?? []).flatMap((card): HubHand[] => {
        const family = card.runtime?.family ?? (card.hand === 'cli' || card.hand === 'window' ? undefined : card.hand)
        const base = family === undefined ? undefined : families.get(family)
        if (base === undefined) return [{ id: card.id, title: card.name, family: family ?? '?', card: true, installed: undefined, login: 'unknown', quota: 'unknown', running: running(task => task.assignee === card.id), ok: false, why: '名片底下那一家这台没接上', code: false }]
        return [{ ...base, id: card.id, title: card.name, card: true, running: running(task => task.assignee === card.id), recommended: false, ...(card.good_at === undefined || card.good_at === '' ? {} : { good_at: card.good_at }) }]
      })
      return [...families.values(), ...cards]
    }

    /** 句子里点名的文件(`docs/…md` 这类相对路径):在她的项目目录里找得到就读开头一段,验收条件从这里抽。 */
    async function hubNamedFiles(said: string): Promise<{ path: string, head: string }[]> {
      const named = [...new Set(said.match(/(?:[\w.\-一-龥]+\/)+[\w.\-一-龥]+\.(?:md|txt)/gu) ?? [])].filter(one => !one.includes('..')).slice(0, 2)
      if (named.length === 0 || projects === undefined) return []
      const roots = (await projects.getProjectsState().catch(() => ({ projects: [] as { path?: string }[] }))).projects.flatMap(one => (one.path === undefined ? [] : [one.path]))
      const out: { path: string, head: string }[] = []
      for (const rel of named) {
        for (const root of roots) {
          const text = await readFile(join(root, rel), 'utf8').catch(() => undefined)
          if (text !== undefined) { out.push({ path: rel, head: text.slice(0, 3000) }); break }
        }
      }
      return out
    }

    function hubDepsFor(entranceReq: IncomingMessage, hubEntrance: 'desktop' | 'call' | 'phone' = 'desktop', requestFacts: readonly string[] = []): HubRunDeps {
      const facts = async (said: string): Promise<HubFacts> => {
        const board = tasks === undefined ? { tasks: [] as TaskView[], goals: [], agent_cards: [] } : await tasks.list()
        const layer = userLayer === undefined ? undefined : await userLayer.scan().catch(() => undefined)
        const devMachine = await hasSourceRepo().catch(() => undefined)
        const ruleText = rules?.brief('say', said)?.text
        return {
          tasks: board.tasks.map(one => ({
            id: one.id, title: one.title, status: one.status, updated_at: one.updated_at,
            ...(one.assignee === undefined ? {} : { assignee: one.assignee }),
            ...(one.goal_id === undefined ? {} : { goal_id: one.goal_id }),
            ...(one.desc === undefined ? {} : { desc: one.desc }),
            ...(one.acceptance === undefined ? {} : { acceptance: one.acceptance }),
            ...(one.dispatch === undefined ? {} : { dispatch: { family: one.dispatch.family, status: one.dispatch.status, ...(one.dispatch.ended_at === undefined ? {} : { ended_at: one.dispatch.ended_at }) } }),
          })),
          goals: (board.goals ?? []).map(one => ({ id: one.id, title: one.title, status: one.status, ...(one.due === undefined ? {} : { due: one.due }), ...(one.conditions === undefined ? {} : { conditions: one.conditions }) })),
          hands: await hubHandsNow(said, board),
          widgets: (layer?.widgets ?? []).map(one => ({ id: one.id, name: one.name, status: one.status, ...(one.replaces === undefined ? {} : { replaces: one.replaces }) })),
          files: await hubNamedFiles(said),
          ...(devMachine === undefined ? {} : { devMachine }),
          ...(ruleText === undefined || ruleText === '' ? {} : { rules: ruleText }),
          // 入口适配层随请求带进来的事实(附件 / 引用 / 她点的名);没有就整格缺席。
          ...(requestFacts.length === 0 ? {} : { facts: requestFacts }),
        }
      }
      const taskOf = async (id: string): Promise<TaskView | undefined> => (tasks === undefined ? undefined : (await tasks.list()).tasks.find(one => one.id === id))
      /*
       * ★ **中枢三只手派出去的,来源按派活者记**(2026-10-29,任务书「中枢派到窗口手不按发送」):
       * 一律「事务官派的」('hub',送话那一下替她按发送)——中枢从电脑对话框 / 电话 / 手机进来,
       * 由事务官自己决定派给谁,意图已经明确。已验证的工人身份(回环 + worker 令牌)照旧 'call';
       * 入口自报 call 但不是已验证工人的,不授予电话来源(entrance 只是客户端上下文,不授予发送权,
       * say-phone-submit-http 用例钉着)——那一种仍只填字,等她自己在窗口里按。
       */
      const hubDispatchSource: ClientDispatchSource = loopback && asker === 'worker' ? 'call' : hubEntrance === 'call' ? 'ui' : 'hub'
      const runDispatch = async (id: string, to: string, text: string, named?: boolean): Promise<{ ok: boolean, note?: string }> => {
        const ran = await withActorNoteFor(entranceReq, 'dispatch.run', () => dispatchItem(id, { family: to as AgentDispatchFamily, text, source: hubDispatchSource, ...(named === true ? { named: true } : {}) })).catch(() => ({ ok: false as const, note: '没派成' }))
        return { ok: ran.ok === true, ...('note' in ran && typeof ran.note === 'string' ? { note: ran.note } : {}) }
      }
      return {
        book: hubBook,
        model: { endpoint: sayModelEndpointNow, ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }) },
        facts,
        hands: {
          createCard: async (input) => {
            if (tasks === undefined) return { ok: false, why: '任务看板未启用' }
            const projectGuess = await inferProjectId(input.said).catch(() => undefined)
            const made = await tasks.create({
              title: input.title, status: input.status, origin: 'user', manager: 'dsh', from: { kind: 'said', quote: input.said },
              ...(input.goalId === undefined ? {} : { goalId: input.goalId }),
              ...(input.acceptance === undefined ? {} : { acceptance: [...input.acceptance] }),
              ...(input.assignee === undefined ? {} : { assignee: input.assignee as TaskAssignee }),
              ...(projectGuess === undefined ? {} : { projectId: projectGuess }),
            }).catch(() => ({ ok: false as const, reason: '卡没建上' }))
            if (!made.ok || made.id === undefined) return { ok: false, why: made.reason ?? '卡没建上' }
            // 这张马上就由中枢派:负责人驱动别再问一遍 / 再派一路。
            if (input.assignee !== undefined) itemDriver?.claim(made.id)
            if (input.note !== undefined) await tasks.update(made.id, { note: input.note }).catch(() => false)
            return { ok: true, id: made.id }
          },
          updateCard: async (id, patch) => tasks === undefined ? false : tasks.update(id, {
            ...(patch.title === undefined ? {} : { title: patch.title }),
            ...(patch.titleFrom === undefined ? {} : { titleFrom: patch.titleFrom }),
            ...(patch.assignee === undefined ? {} : { assignee: patch.assignee as TaskAssignee }),
            ...(patch.goalId === undefined ? {} : { goalId: patch.goalId }),
            ...(patch.acceptance === undefined ? {} : { acceptance: [...patch.acceptance] }),
            ...(patch.note === undefined ? {} : { note: patch.note }),
          }).catch(() => false),
          moveCard: async (id, status) => tasks === undefined ? { ok: false, reason: '任务看板未启用' } : tasks.move(id, status),
          comment: async (id, text) => tasks === undefined ? { ok: false } : tasks.comment(id, { by: 'user', text }).catch(() => ({ ok: false })),
          carry: async (id, text) => {
            const task = await taskOf(id)
            if (task === undefined) return { ok: false, why: '卡不在了' }
            const handed = await sayIntoTaskConversation(task, text).catch(() => ({ ok: false as const, why: 'gone' as const }))
            return handed.ok ? { ok: true } : { ok: false, why: handed.why }
          },
          // 改派与电话 / 手机同一只手(小K 10-28 那支的 applyReassignDispatch):收场旧派发、换负责人、同卡重派。
          // 来源跟着中枢那一条:事务官派的('hub' / 已验证工人 'call')——不是她手点的那一种。
          reassign: async (id, input) => applyReassignDispatch(entranceReq, id, input.to.startsWith('agent:') ? { family: input.family, cardId: input.to } : { family: input.to }, hubDispatchSource),
          dispatch: async (id, input) => {
            const task = await taskOf(id)
            if (task === undefined) return { ok: false, note: '卡不在了' }
            return runDispatch(id, input.to, input.text ?? task.desc ?? task.title, input.named)
          },
          createGoal: async input => tasks === undefined ? { ok: false, why: '任务看板未启用' } : tasks.createGoal({ title: input.title, ...(input.due === undefined ? {} : { due: input.due }) }).then(one => ({ ok: one.ok, ...(one.id === undefined ? {} : { id: one.id }), ...(one.reason === undefined ? {} : { why: one.reason }) })),
          updateGoal: async (id, patch) => tasks === undefined ? false : tasks.updateGoal(id, patch),
          // 与 `/user-layer/fix` 同一套:只改用户层目录、派活那一刻记越界守门;人选由中枢核过手再给。
          userLayerFix: async (input) => {
            if (userLayer === undefined || tasks === undefined) return { ok: false, note: '用户层未启用' }
            const brief = userLayerFixBrief(input.said, userLayer.dir)
            let id = input.cardId
            if (id === undefined) {
              const created = await createButlerItem(brief, input.to as TaskAssignee, undefined, { skipSession: true })
              if (!created.ok) return { ok: false, note: created.error }
              id = created.id
            }
            else await tasks.update(id, { assignee: input.to as TaskAssignee }).catch(() => false)
            await userLayer.ensure()
            itemDriver?.claim(id)
            const started = await dispatchItem(id, { family: input.to as AgentDispatchFamily, text: brief, source: 'item', kind: 'code', cwd: userLayer.dir, cwdFixed: true, ...(input.named === true ? { named: true } : {}) })
            if (started.ok) {
              const guarded = id
              void userLayer.beginFixGuard(guarded).then(async (guard) => {
                if (guard.ok) return
                await tasks?.update(guarded, { note: guard.reason }).catch(() => false)
                broadcast({ kind: 'snapshot', state: await composeState() })
              }, () => undefined)
            }
            return { ok: started.ok, id, ...(started.ok ? {} : { note: started.note }) }
          },
          remember: async (input) => {
            if (rules === undefined) return { ok: false, why: '规矩表没接上' }
            const done = await rules.add({ text: input.text, channel: ruleChannelOf(entranceReq, device, undefined, hubEntrance === 'call' ? 'call' : 'desk'), said: input.said }).catch(() => ({ ok: false as const, error: '规矩没写进去' }))
            return done.ok ? { ok: true } : { ok: false, why: done.error }
          },
          feedback: async (text) => {
            if (feedback === undefined) return { ok: false, why: '反馈通道没接上' }
            const entry = await feedback.add({ said: text, note: feedbackNote(text) })
            return { ok: true, id: entry.code }
          },
          voice: async gender => switchVoiceGender(gender),
          sayNote: async (id, text) => { await tasks?.update(id, { sayNote: text }).catch(() => false) },
          // 核一遍已交回的卡(任务书 1029):与交回那一刻同一个推进模块,不另写。
          verifyAcceptance: async (id, input) => await verifyCardOnDemand(id, input.acceptance),
          // 人判通过(第 4 步⑤):「按通过结掉」那一下记一笔、执行记录终态。
          humanSettled: async (id) => { await taskDelivery?.humanSettled(id) },
        },
      }
    }

    /**
     * GET /butler/hub/context?entrance=call|phone|desktop&said=…(A2,2026-10-28):理解中枢的上下文包,只读。
     * 电话工人开场与每回合取这一份(与 `/butler/say` 中枢那条同一个 buildContext + renderContext)。
     * 回 `{ context, text }`:`context` 是结构化的包,`text` 是模型读的那一段。
     */
    if (path === '/butler/hub/context' && req.method === 'GET') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机或已配对的手机上拿' }); return }
      const params = new URL(req.url ?? '/', 'http://x').searchParams
      const entrance = hubEntranceOf(params.get('entrance') ?? 'call', undefined)
      if (entrance === undefined) { sendJson(res, 400, { error: 'entrance 只认 desktop / call / phone' }); return }
      sendJson(res, 200, await hubContext({ entrance, said: (params.get('said') ?? '').slice(0, 2000) }, hubDepsFor(req, entrance)))
      return
    }

    /**
     * POST /butler/hub/execute(A2,2026-10-28):理解中枢的执行口。
     * 请求 `{ entrance, said, commands[] }`(命令按 `hub/commands.ts` 的命令表)或 `{ entrance, said, confirmed:{ask_id, choice} }`
     * (她答了护栏那一问,commands 忽略);200 回 `{ say_id, results, say{screen,spoken} }`,每条结果
     * `{ command, ok, did, why?, next?, card_id?, goal_id?, who?, ask?{question, options, ask_id?} }`;400 commands 不是数组,409 那一问已不在。
     * 护栏、核手、执行全在这里(`hub/run.ts` 的 hubExecute),调用方不另判;不调模型。
     */
    if (path === '/butler/hub/execute' && req.method === 'POST') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机或已配对的手机上跟事务官说' }); return }
      const denied = await agentWriteDenied(req, device)
      if (denied !== undefined) { sendJson(res, 403, { error: denied }); return }
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      const entrance = body.entrance === 'desktop' || body.entrance === 'call' || body.entrance === 'phone' ? body.entrance : undefined
      if (entrance === undefined) { sendJson(res, 400, { error: 'entrance 只认 desktop / call / phone' }); return }
      const said = typeof body.said === 'string' ? body.said.trim().slice(0, 2000) : ''
      const raw = body.confirmed as { ask_id?: unknown, choice?: unknown } | undefined
      const confirmed = raw !== undefined && typeof raw.ask_id === 'string' ? { ask_id: raw.ask_id, choice: raw.choice } : undefined
      const deps = hubDepsFor(req, entrance)
      // 与 /butler/say 那条同一道「回指对上多张就问」(hub/understand.ts):命令是工人的模型出的,这一步在这里补上。
      const commands = confirmed === undefined && Array.isArray(body.commands)
        ? askIfAmbiguous(said, (await hubContext({ entrance, said }, deps)).context, body.commands as HubCommand[])
        : body.commands
      const out = await hubExecute({ said, entrance, commands, ...(confirmed === undefined ? {} : { confirmed }) }, deps)
      // 8791 第六轮:回包先行,广播异步 —— say 路不等对账(也不等这一拍 composeState),后续状态由快照推送。
      sendJson(res, out.status, out.body)
      if (out.status === 200) void composeState().then(state => broadcast({ kind: 'snapshot', state })).catch(() => {})
      return
    }

    /** GET /butler/say/cards(1a):@候选最小投影(稳定 card id/名字/家/running 真实证据),给事务官页与手机。 */
    if (path === '/butler/say/cards' && req.method === 'GET') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机或已配对的手机上拿' }); return }
      const cards = tasksStateCardsNow()
      const board = tasks === undefined ? [] : (await tasks.list()).tasks
      sendJson(res, 200, { cards: sayCardsOf(await tasksStateCardsNow(), board, Date.now()) })
      return
    }

    /**
     * POST /butler/say(2026-10-24 开;★ 2026-10-29 删规矩第一批入口归一重写):
     * 一句话 → **理解中枢**(hubSay:上下文包 → 模型按命令表出命令 → 护栏 → 执行 → 按真实结果回话)。
     *
     * 不再有「旧路」:`hubEntranceOf` 认不出的入口一律按 desktop 处理(A#7);专项词表分流
     * (本体反馈 / 发布计划 / 待办视图 / 要文件)、旧 say 管线(快路径 / 四档置信度 / 旁人声快判 /
     * suggest / decided / 挂起账)一并删除 —— 这些意图全部由中枢命令表出(A#1/8/9/19/20/21/25)。
     * 她答挂着的那一问走中枢自己的账(hubBook,`ctx.confirmed.ask_id`);旧账的 suggest / decided
     * 点选已随 10 分钟窗下线,如实 409。
     * 电话入口(`call`,老工人发 `phone` + `ctx.in_call`)理解没成也回 200 标准形状,念一句「没动」(callReplyOf)。
     */
    if (path === '/butler/say' && req.method === 'POST') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机或已配对的手机上跟事务官说' }); return }
      const denied = await agentWriteDenied(req, device)
      if (denied !== undefined) { sendJson(res, 403, { error: denied }); return }
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      const said = typeof body.text === 'string' ? body.text.trim() : ''
      if (said === '') { sendJson(res, 400, { error: 'text 必须是非空字符串(她那一句)' }); return }
      if (said.length > 2000) { sendJson(res, 400, { error: '这句太长了(上限 2000 字)' }); return }
      const ctx = (body.ctx ?? {}) as { in_call?: unknown, confirmed?: { ask_id?: unknown, choice?: unknown }, decided?: unknown, suggest?: unknown }
      // 旧 say 体系的点选(suggest / decided)随旧路删除:这两格还带着的,如实说已经不在了。
      if (ctx.suggest !== undefined || ctx.decided !== undefined) {
        sendJson(res, 409, { error: '这一条建议/改选已经不在了,要派直接在卡上派。' })
        return
      }
      // 入口映射:认得出的按映射走,认不出的一律 desktop —— 不再有「旧路」。
      const hubEntrance: HubEntrance = hubEntranceOf(body.entrance, ctx.in_call) ?? 'desktop'
      const confirmed = ctx.confirmed !== undefined && typeof ctx.confirmed.ask_id === 'string'
        ? { ask_id: ctx.confirmed.ask_id, choice: ctx.confirmed.choice }
        : undefined
      const said0 = await hubSay({ said, entrance: hubEntrance, ...(confirmed === undefined ? {} : { confirmed }) }, hubDepsFor(req, hubEntrance))
      const out = hubEntrance === 'call' ? callReplyOf(said0) : said0
      // 8791 第六轮:回包先行,广播异步 —— say 路不等对账,后续状态由快照推送。
      sendJson(res, out.status, out.body)
      if (out.status === 200) void composeState().then(state => broadcast({ kind: 'snapshot', state })).catch(() => {})
      return
    }


    /**
     * POST /butler/item(收件箱输入框 / 手机打字与语音 / 通话里 wb_dispatch_item / 协作区气泡 / 首次引导;
     * ★ 2026-10-29 删规矩第一批入口归一重写):**所有入口进理解中枢** —— 这条路由只做入口适配,
     * 不再认话、不再分流:
     *
     * - 身份:入口只按受信身份定(已验证电话工人 → call;已配对手机 → phone;其余 → desktop),
     *   **不看 body 自报的 entrance / source**(任务书①:A#7 / E#4);
     * - 附件 / 引用 / @点名 / 档位 / 模型:解析后作为**事实**随上下文包进中枢(request_facts),
     *   不再决定走哪条管线;附件找不到照旧整条 400,不建「图不在的卡」;
     * - 「只出方案」档:派活口一律 409(口径与 /dispatch/run 那几处同一句,PLAN_ONLY_DISPATCH_ERROR);
     * - 开发小工具那颗按钮(预填开头 / kind)是 PRD §9 澄清环节,照旧先摆待确认,不进中枢。
     *
     * 随旧路删除的岔口(A#1 四张专项词表、A#8 本体反馈词表、A#22 十分钟续进、A#23 只记不派、
     * A#24 进度尾巴/寒暄直答、A#25 直写规矩、A#26 刚才那件改派、A#30 布局撤销词表、点名再批 E#3):
     * 这些意图全部由中枢命令表出。回包保留旧 envelope({ok,id,note,say,dispatch_ok,dispatch_note}),
     * 电话工人与手机端消费方一字不改。
     */
    if (path === '/butler/item' && req.method === 'POST') {
      // 手机配对(2026-09-11):手机建事项正是用途,与其它写路由同门(回环或已配对设备)。
      if (!trusted) { sendJson(res, 403, { error: '只能在本机或已配对的手机上建事项' }); return }
      const denied = await agentWriteDenied(req, device)
      if (denied !== undefined) { sendJson(res, 403, { error: denied }); return }

      const text = await readBody(req)
      let body: unknown
      try {
        body = JSON.parse(text)
      } catch {
        sendJson(res, 400, { error: 'body 不是合法 JSON' })
        return
      }
      const raw = (body ?? {}) as Record<string, unknown>
      /**
       * 只贴了一张图、一个字没打(2026-09-24 统一输入框):**不替他编一句话**,
       * 话就写「附件:<文件名>」—— 那是事实,不是猜的意图。
       */
      const onlyAttachments = attachmentIds(raw.attachments)
      if ((typeof raw.text !== 'string' || raw.text.trim() === '') && onlyAttachments.length > 0 && composer !== undefined) {
        raw.text = `附件:${onlyAttachments.join('、')}`
      }
      if (typeof raw.text !== 'string' || raw.text.trim() === '') {
        sendJson(res, 400, { error: '事项内容不能为空' })
        return
      }
      const said = raw.text.trim()
      /**
       * 她对事务官说的话原文进行为账(2026-10-09,卡「行为账」)。只记电脑 / 手机上打的那一句:
       * 电话里的那几句由挂断时那份纪要(`/butler/call/record`)按原文记,工人在通话里转来的这一句是它理解后的转述,不算原话。
       */
      if (behaviorEnd === '电脑' || behaviorEnd === '手机') {
        noteBehavior({ 事: BEHAVIOR_EVENTS.say, 对象: '事务官', 结果: '交给事务官', 原话: said })
      }

      /*
       * ★ 入口只按受信身份定,不看 body 自报(任务书①「身份验证不依赖 body 自报」):
       * 已验证的电话工人(回环 + worker 令牌,或房间代理带上电话那一端)→ call;
       * 已配对手机(设备令牌)→ phone;其余(电脑页面 / 协作区气泡 / 首次引导)→ desktop。
       * 自报 entrance=call 但不是已验证工人的,不授予电话来源(旧行为同理,say-phone-submit-http 的口径)。
       */
      const entrance: HubEntrance = (loopback && asker === 'worker') || behaviorEnd === '电话' ? 'call' : device !== undefined ? 'phone' : 'desktop'

      /**
       * 「开发一个小工具」那一句(2026-09-21)。**在建卡之前岔出去** ——
       * 认出来这是一次造模块的请求,就先摆一条待确认的需求,不建卡、不开会话、
       * 不在盘上写一个字节(PRD §9「不得自行执行」;不可改清单·澄清环节,删规矩第一批不删)。
       * 他点了「就这样」才走 POST /devtool/confirm。
       *
       * 触发只认两种明确动作:那句预填开头(他点了那颗按钮)还在、或 body 显式 `kind:'dev_tool'` ——
       * 不是词表猜话;认不出就进中枢,当普通一句交代。
       */
      if (devTool !== undefined && isDevToolRequest(said, raw.kind)) {
        const restate = devToolRestate(said)
        // 他光点了按钮就回车,一个字都没接着说。**不替他编一个需求**,如实要他再说一句。
        if (restate === '') {
          sendJson(res, 400, { error: '还没说它要做什么 —— 在那句话后面接着说,比如「一个番茄钟,25 分钟一轮」' })
          return
        }
        // 草图端口是外部实现,绝不抛是它的责任,这里仍然兜一层。拿不到就整条缺席。
        let sketch: string | undefined
        try { sketch = await devTool.sketch?.(restate) }
        catch { sketch = undefined }
        const proposal = {
          id: randomUUID(),
          request: said,
          restate,
          ...(sketch === undefined || sketch.trim() === '' ? {} : { sketch: sketch.trim() }),
          module_id: newModuleId(devTool.random),
          created_at: new Date().toISOString(),
        }
        const added = await devTool.store.add(proposal)
        if (!added.ok) { sendJson(res, 400, { error: added.error ?? '这条需求没记下' }); return }
        broadcast({ kind: 'snapshot', state: await composeState() })
        // ok:true 是给输入框看的(他那句话已经被接住了,可以清空);note 是给他看的下一步。
        sendJson(res, 200, { ok: true, dev_tool: proposal, note: '先确认一下我理解得对不对' })
        return
      }

      /**
       * 统一输入框的几样(2026-09-24):档位与模型的粘性默认照记(维护者拍板:模型切换改默认);
       * 附件先解析 —— 找不到就**整条不建**(卡上写着「他附了图」而图不在,比让他再发一次更坏);
       * 引用拼成行。三样连同 @点名一起,作为事实随上下文包进中枢(不再决定走哪条管线)。
       * 「只出方案」档:派活口一律 409 —— 与 /dispatch/run、/butler/item/dispatch 那几处同一句。
       */
      const requestFacts: string[] = []
      if (typeof raw.assignee === 'string' && raw.assignee !== '' && raw.assignee !== 'dsh') {
        requestFacts.push(`这条请求点了名「${raw.assignee}」(@ 选的或电话里填的)——她点名的那家就是要办事的那家`)
      }
      if (tasks === undefined) { sendJson(res, 404, { error: '任务看板未启用' }); return }
      if (composer !== undefined) {
        const choice = await composer.choice()
        const mode = isComposerMode(raw.mode) ? raw.mode : choice.mode
        if (mode === 'plan') { sendJson(res, 409, { error: PLAN_ONLY_DISPATCH_ERROR }); return }
        const rawModel = (raw.model ?? undefined) as Record<string, unknown> | undefined
        const model = rawModel !== undefined && typeof rawModel.provider === 'string' && rawModel.provider !== '' && typeof rawModel.id === 'string' && rawModel.id !== ''
          ? { provider: rawModel.provider, id: rawModel.id }
          : choice.model
        const resolved = await composer.resolve(attachmentIds(raw.attachments), 5000)
        if (resolved.missing.length > 0) {
          sendJson(res, 400, { error: `附件没找到:${resolved.missing.join('、')}(再加一次试试)` })
          return
        }
        const refs = refInputs(raw.refs)
        let lines: string[] = []
        if (refs.length > 0) {
          let projectList: readonly { id: string, name: string, path?: string, status?: { text?: string } }[] = []
          try { projectList = (await projects?.getProjectsState())?.projects ?? [] } catch { projectList = [] }
          lines = refLines(refs, { tasks: (await tasks.list()).tasks, projects: projectList })
        }
        if (mode !== choice.mode || (model !== undefined && (model.provider !== choice.model?.provider || model.id !== choice.model?.id))) {
          try {
            await composer.saveChoice({ mode, ...(model === undefined ? {} : { model }) })
            await refreshComposerView()
            composerViewAt = Date.now()
          }
          catch { /* 记不下默认不挡这一件 */ }
        }
        if (resolved.found.length > 0) requestFacts.push(`附了文件(都在这台电脑上):\n${resolved.found.map(one => `- ${one.path}`).join('\n')}`)
        if (lines.length > 0) requestFacts.push(`引用了:\n${lines.map(one => `- ${one}`).join('\n')}`)
      }

      const out = await hubSay({ said, entrance }, hubDepsFor(req, entrance, requestFacts))
      // 理解没成(503 没接上 / 502 坏输出):照实回状态与原因,一张卡都没建 —— 不冒称听懂。
      if (out.status !== 200) { sendJson(res, out.status, out.body); return }
      const hubBody = out.body
      const screen = typeof hubBody.say === 'object' && hubBody.say !== null && typeof (hubBody.say as { screen?: unknown }).screen === 'string'
        ? (hubBody.say as { screen: string }).screen
        : ''
      const results = ((hubBody.hub as { results?: { command: string, ok: boolean, card_id?: string, who?: string }[] } | undefined)?.results ?? [])
      const items = (Array.isArray(hubBody.items) ? hubBody.items : []) as { card_id?: unknown }[]
      const firstCard = [...items, ...results].map(one => (typeof one.card_id === 'string' ? one.card_id : undefined)).find(one => one !== undefined)
      const dispatched = results.find(one => (one.command === 'dispatch' || one.command === 'user_layer_fix') && one.ok === true)
      // 他刚交代了这件事 = 他刚动过手:她几分钟里就答完了,不为这件事再打电话(卡 M 补;人就在跟前)。
      if (firstCard !== undefined) callOut?.touch?.(firstCard)
      // 8791 第六轮:回包先行,广播异步。
      void composeState().then(state => broadcast({ kind: 'snapshot', state })).catch(() => {})
      sendJson(res, 200, {
        ok: true,
        ...(firstCard === undefined ? {} : { id: firstCard }),
        note: screen,
        say: hubBody.say,
        // 落地口挂起确认(中枢护栏问):旧消费方(电脑收件箱)读 answer.ask,照实带出去。
        ...(hubBody.ask === undefined ? {} : { ask: hubBody.ask }),
        // 电话那头 rememberItem 读这两格决定说不说「派出去了」:真派出去了才给 dispatch_ok:true。
        ...(dispatched === undefined ? {} : { dispatch_ok: true, dispatch_note: screen, ...(dispatched.who === undefined ? {} : { assignee: dispatched.who }) }),
      })
      return
    }


    /**
     * POST /butler/item/say { id, text }(2026-09-17 通道层)。
     *
     * 往**已经在办**的那条事项的 DSH 会话里再补一句话。通道层第三件工具 wb_hand_to_butler 落在这里。
     *
     * 为什么不是「再建一条事项」:他在电话里说「刚才那件事,顺便把 X 也办了」,建第二张卡的话
     * 看板上会多出一件没头没尾的事,而正在办那条会话根本不知道。这条路复用 /onboarding/say
     * 同一个端口(butlerSession.say),只是收件人换成事项底下那条会话。
     *
     * 三种说不进去各说各的原因,不混:没有这个事项 / 事项建了但会话没开 / 会话在 DSH 里已经没了。
     *
     * ★ 2026-10-13(卡 G):**固定流程补细节那一句(`append:true`)碰上没有会话的那一件,不再说不进去** ——
     * 记进卡的描述,在视频接力里就连可灵那句提示词一起带上(下面那一段写了为什么只认这一句)。
     */
    if (path === '/butler/item/say' && req.method === 'POST') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机或已配对的手机上给事项补话' }); return }
      if (tasks === undefined) { sendJson(res, 404, { error: '任务看板未启用' }); return }
      const denied = await agentWriteDenied(req, device)
      if (denied !== undefined) { sendJson(res, 403, { error: denied }); return }

      const body = await readJsonBody(req, res)
      if (body === undefined) return
      const itemId = typeof body.id === 'string' ? body.id.trim() : ''
      const say = typeof body.text === 'string' ? body.text.trim() : ''
      if (itemId === '') { sendJson(res, 400, { error: 'id 必须是非空字符串' }); return }
      /** 意图(2026-10-26,卡「事务官机制A」):程序来源(统筹 / 事务官)同一句口走四意图;缺席 = 补充,旧调用逐字不变。 */
      const parsedSayIntent = parseItemSayIntent(body.intent)
      if (!parsedSayIntent.ok) { sendJson(res, 400, { error: 'intent 要 supplement / redirect / hurry / recall 之一(不带就是补充)' }); return }
      const sayIntent = parsedSayIntent.intent
      // 固定流程补细节那一档(append:true)不是她的原话,不承载意图 —— 保持它 pure。
      if (body.append === true && sayIntent !== 'supplement') { sendJson(res, 400, { error: 'append 那一句是固定流程的补细节,不带意图' }); return }
      if (say === '') { sendJson(res, 400, { error: 'text 必须是非空字符串' }); return }
      if (say.length > 4000) { sendJson(res, 400, { error: '一句话太长了(上限 4000 字)' }); return }

      const task = (await tasks.list()).tasks.find(candidate => candidate.id === itemId)
      if (task === undefined) { sendJson(res, 404, { error: '没有这个事项' }); return }
      // 收场的卡(做完 / 取消)撤不回:路由入口就挡,什么都不会发生(不停轮、不挪卡、不留痕)。
      if (sayIntent === 'recall' && SETTLED_TASK_STATUS.includes(task.status)) {
        sendJson(res, 409, { error: '这张卡已经收场(做完 / 取消),撤不回 —— 要推翻结论请用「改方向」,或先退回重开。' })
        return
      }
      /*
       * 行为账(2026-10-26 调位):补充沿用卡 A 旧序(发送前先记);**带意图的句在办成之后记** ——
       * 改方向 / 加速 / 撤回没办成的那句不算生效指令(与 /butler/item/continue 同一纪律)。
       */
      if (sayIntent === 'supplement') {
        noteHandedToItem(req, device, behaviorEnd, task, say, typeof body.channel === 'string' ? body.channel : undefined)
      }
      /*
       * ★ **没有会话的那一件,这句话也要真落下去**(2026-10-13,卡 G)。视频接力那一件是 `skipSession`
       * 建的,所以 10-13 14:02 真机上「七八岁吧,穿小碎花连衣裙」只换回一句「这件事的会话没开,说不进去」——
       * 而电话那头固定说「记下了。」= 一句**没落在任何地方**的话被说成记下了(D13 要治的正是这个)。
       * 现在:记进卡的描述,接力还在豆包那一步就连可灵那句提示词一起带上(已经交给可灵的不追、不改,
       * 豆包那一步已经派出去的那一句也不追 —— 回包的 `note` 如实说落在哪)。
       *
       * **只认固定流程那一句**(`append:true`,`understand()` 第 ⑤ 档「补细节」):界面上「推进 / 改一改」与工人的
       * `wb_hand_to_butler` 送进来的不是她的原话,那两条路照旧 409 —— 工人对 200 说的是「送到了,
       * 我跟事务官说了」,把记在卡上说成捎进了会话又是一句假话。
       * 已经收场的卡(做完 / 取消)也照旧 409:往一张收了的卡上写一句等于把这句话埋掉。
       */
      if (task.conversation === undefined && body.append === true && !SETTLED_TASK_STATUS.includes(task.status)) {
        // 卡上那一段**真写进去了**才敢说落下了;写不进去就落回下面那句「说不进去」(D13)。
        const wrote = await tasks.update(itemId, { desc: appendDetail(task.desc, say, new Date()) }).catch(() => false)
        if (wrote) {
          const amended = (await videoChain?.amendPrompt(itemId, say).catch(() => undefined)) ?? { kind: 'none' as const }
          const landed = amended.kind === 'added' ? DEMO_APPEND_ON_CARD_AND_PROMPT : DEMO_APPEND_ON_CARD
          noteUnderstood(req, device, { kind: 'append', said: say, done: landed })
          broadcast({ kind: 'snapshot', state: await composeState() })
          sendJson(res, 200, { ok: true, id: itemId, note: landed })
          return
        }
      }
      /*
       * ★ 撤回 · 没有会话的那一件(2026-10-26):没有要停的轮,照样回待排、照留痕 ——
       * 撤的是「这件还办不办」,不是「那条会话怎么说」。有会话的走下面那道梯。
       */
      if (sayIntent === 'recall' && task.conversation === undefined) {
        const settled = await recallSettleOnCard(task, say, [], commentByOf())
        broadcast({ kind: 'snapshot', state: await composeState() })
        noteHandedToItem(req, device, behaviorEnd, task, say, typeof body.channel === 'string' ? body.channel : undefined, 'recall')
        sendJson(res, 200, { ok: true, id: itemId, intent: 'recall', stopped: false, cleared: 0, ...(settled.moved ? {} : { note: '卡这会儿挪不动(状态进路不合),先停在这里。' }) })
        return
      }
      const handed = await sayIntoTaskConversation(task, say, { intent: sayIntent })
      if (!handed.ok) {
        // 三种说不进去各说各的原因,不混(这道梯的唯一实现就是 sayIntoTaskConversation;
        // model/host 两档按 Key 最终契约照原文回,两种都**没有发送**、零新卡/零新会话/零 prompt)。
        sendJson(res, 409, handed.why === 'no-conversation'
          ? { error: '这件事的会话没开,说不进去' }
          : handed.why === 'no-channel'
            ? { error: '会话通道没接上,这句话说不进去' }
            : handed.why === 'cancel-failed'
              ? { error: `想撤,但这条会话这会儿停不住(${handed.cancelWhy ?? '这一版没有停会话的那颗键'})—— 撤回没办成,它还在跑,请到电脑上手动停。` }
              : handed.why === 'stale-queue'
                ? (() => {
                    // 部分失败:拒发照旧,进度照实 —— 已摘 N 句、还有 M 句在队列里;绝不说「原样没动」;
                    // 终证没写进也照实(原文在先留证里,可恢复)。终证/先留证都已在梯子里等过落盘。
                    const progressError = handed.partial === undefined ? undefined
                      : `已把能清的 ${handed.partial.removed.length} 句作废(原文留在卡上),还有 ${handed.partial.remaining.length} 句清不动、仍在队列里 —— `
                    const progressErrorFull = handed.partial === undefined ? undefined
                      : (handed.evidencePersisted === false
                          ? `${progressError}进度的留痕这会儿没写进卡(原文动手前已留在卡上,可核对)—— `
                          : progressError)
                    return handed.cancelledRunning === true
                      ? { code: 'session_stale_queue', stopped: true, error: `在跑的那一轮已停住;${progressErrorFull ?? '队列里排着的旧话这会儿读不清 / 清不动 —— '}怕旧方案复活,撤回没办成:卡没挪,请再试(会先清剩下的)。` }
                      : { code: 'session_stale_queue', error: `${progressErrorFull ?? '改方向 / 撤回前要先清掉这条会话里排着的旧话(旧队列不复活),队列这会儿读不清 / 清不动 —— '}这句没有发送;再试会先清剩下的。` }
                  })()
                : handed.why === 'evidence-refused'
                  ? (handed.cancelledRunning === true
                      ? { code: 'session_stale_queue', stopped: true, error: '在跑的那一轮已停住;但把要作废的旧话先留在卡上这一步没写进去(留言这会儿落不了盘)—— 没凭据不动手:队列一条没动,撤回没办成,请再试。' }
                      : { code: 'session_stale_queue', error: '把要作废的旧话先留在卡上这一步没写进去(留言这会儿落不了盘)—— 没凭据不动手:队列一条没动,这句也没有发送,请再试。' })
                  : handed.why === 'model'
                  ? { code: 'model_alignment_failed', error: '当前模型还没完成应用，这句话没有发送；原事项和会话保留，请重试模型设置。' }
                  : handed.why === 'host'
                    ? { code: 'session_send_failed', error: '会话通道暂时不可用，这句话没有发送；请稍后重试。' }
                    : { error: '这条会话在 DSH 里已经没了' })
        return
      }
      /*
       * ★ 留痕(2026-10-13):**只有固定流程那一句带着 `append:true`**(`understand()` 第 ⑤ 档「补细节」)。
       * 界面上「推进 / 改一改」与工人的 `wb_hand_to_butler` 送进来的不是她的原话,一律不留痕。
       */
      if (body.append === true) noteUnderstood(req, device, { kind: 'append', said: say, done: demoAppendSay(say) })
      if (sayIntent === 'recall') {
        // 撤回收尾:挪回待排 + 卡上带框留言(清掉的旧句附在同一格);一个字没进会话。
        const settled = await recallSettleOnCard(task, say, handed.cleared ?? [], commentByOf())
        noteHandedToItem(req, device, behaviorEnd, task, say, typeof body.channel === 'string' ? body.channel : undefined, 'recall')
        broadcast({ kind: 'snapshot', state: await composeState() })
        sendJson(res, 200, {
          ok: true, id: itemId, intent: 'recall',
          stopped: handed.cancelledRunning === true,
          cleared: handed.cleared?.length ?? 0,
          note: intentReceiptOf('recall', {
            wasRunning: handed.wasRunning === true,
            cancelled: { ok: true, running: handed.cancelledRunning === true },
            cleared: handed.cleared,
          }) + (settled.moved ? '' : ' 卡这会儿挪不动(状态进路不合),先停在这里。'),
        })
        return
      }
      // 带意图的句办成了才记行为账(上面 supplement 已在发送前记过)。
      if (sayIntent !== 'supplement') {
        noteHandedToItem(req, device, behaviorEnd, task, say, typeof body.channel === 'string' ? body.channel : undefined, sayIntent)
      }
      // 显式带了 intent 的(哪怕「补充」):卡上留结构化 intent 痕 —— 四意图在卡上可区分;旧调用(不带 intent)不留。
      if (body.intent !== undefined && tasks !== undefined) {
        const frame = intentPlanOf(sayIntent).frame(task.id, say) ?? say
        const clearedSuffix = (handed.cleared?.length ?? 0) > 0
          ? `\n—— 递这句前还排着 ${handed.cleared?.length} 句旧话,已一并作废留存:\n${(handed.cleared ?? []).map(one => `· ${one}`).join('\n')}`
          : ''
        await tasks.comment(itemId, { by: commentByOf(), text: `${frame}${clearedSuffix}`, intent: sayIntent }).catch(() => undefined)
      }
      sendJson(res, 200, { ok: true, id: itemId, session_id: handed.session_id, ...(sayIntent === 'supplement' ? {} : { intent: sayIntent }) })
      return
    }

    /**
     * POST /butler/item/continue { id, text, target?, record?, client_key? }(2026-10-23,卡 A「同事项接续与动作契约」):
     * 把一句话接着发进这件事的**明确来源**(它自己的事务官会话,或 links 里某条外部会话),
     * 结果翻成「记下了 / 留着等它醒 / 送到了(还没核上) / 这条路走不通 / 要先选来源」那一档。
     *
     * 三条纪律:
     *   - **发哪儿由服务端认**(continueSourcesOf / resolveContinueTarget):不带目标多条来源回 pick,**不猜最新**;
     *     目标不认识回 failed,那句话不会掉进别的会话;
     *   - **record 档只记留言**(tasks.comment),一个字都不往外发;
     *   - **开工那一档这里永不报**(ItemContinueFact 没有 started)——发一句话报不出「它开工了」。
     *
     * 真发话走的还是那两条老路(事务官会话 = sayIntoTaskConversation;外部会话 = sessionAnswer.relay),
     * 这里只组装与翻译。不带「回了打电话给我」与回电登记 —— 那是 /sessions/relay  wrapper 上的那一层,
     * 接续第一版不替它代言(后续卡接)。
     */
    if (path === '/butler/item/continue' && req.method === 'POST') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机或已配对的手机上接着这件事说' }); return }
      if (tasks === undefined) { sendJson(res, 404, { error: '任务看板未启用' }); return }
      const denied = await agentWriteDenied(req, device)
      if (denied !== undefined) { sendJson(res, 403, { error: denied }); return }

      const body = await readJsonBody(req, res)
      if (body === undefined) return
      const itemId = typeof body.id === 'string' ? body.id.trim() : ''
      const text = typeof body.text === 'string' ? body.text.trim() : ''
      if (itemId === '') { sendJson(res, 400, { error: 'id 必须是非空字符串' }); return }
      /** 意图(2026-10-26,卡「事务官机制A」):缺席 = 补充,旧调用逐字兼容;带错拒,不静默当补充。 */
      const parsedIntent = parseItemSayIntent(body.intent)
      if (!parsedIntent.ok) { sendJson(res, 400, { error: 'intent 要 supplement / redirect / hurry / recall 之一(不带就是补充)' }); return }
      const intent = parsedIntent.intent
      if (body.record === true && intent !== 'supplement') { sendJson(res, 400, { error: '「只留记录」是纯留言档,不带意图 —— 要改方向 / 加速 / 撤回就别勾只留记录' }); return }
      // 撤回可以不带原话(意图本身就是那句交代);其余意图没有话可递是空动作。
      if (text === '' && intent !== 'recall') { sendJson(res, 400, { error: 'text 必须是非空字符串' }); return }
      if (text.length > 4000) { sendJson(res, 400, { error: '一句话太长了(上限 4000 字)' }); return }

      const task = (await tasks.list()).tasks.find(candidate => candidate.id === itemId)
      if (task === undefined) { sendJson(res, 404, { error: '没有这个事项' }); return }
      /** 只记一档:留言落在卡上,一个字都不往外发。
       * ★ record 是**纯记录**(2026-10-23 复审 Important 5):不记行为账、不挂通话、不激活长期规矩 ——
       * 她说「只留记录」的那句,哪怕长得像一条规矩,也只是卡上的一句留言。 */
      if (body.record === true) {
        const by = asker === 'page' || asker === 'device' ? 'me' : asker === 'butler' ? 'butler' : 'agent'
        const said = await tasks.comment(itemId, { by, text })
        if (!said.ok) { sendJson(res, 400, { error: said.reason ?? '没留上' }); return }
        broadcast({ kind: 'snapshot', state: await composeState() })
        sendJson(res, 200, { ok: true, fact: 'saved', note: '记下了 —— 这句话留在卡上,没有发给任何人。' })
        return
      }

      const sources = continueSourcesOf(task, itemContinueEnv)
      const target = typeof body.target === 'string' && body.target.trim() !== '' ? body.target.trim() : undefined
      const resolved = resolveContinueTarget(sources, target)
      if (resolved.kind === 'pick') {
        // 歧义那一句什么账都不记:还没选定发给谁,更不算生效指令(规矩不生效)。
        sendJson(res, 200, { ok: false, fact: 'pick', note: '这件事连着好几条能接续的会话 —— 选一条再发,不替你猜。', candidates: resolved.candidates })
        return
      }
      if (resolved.kind === 'unknown') {
        sendJson(res, 200, { ok: false, fact: 'failed', note: resolved.why })
        return
      }
      if (resolved.kind === 'blocked' || resolved.kind === 'none') {
        sendJson(res, 200, { ok: false, fact: 'unsupported', note: resolved.why })
        return
      }

      if (resolved.target.kind === 'butler') {
        // 收场的卡(做完 / 取消)撤不回:什么都不会发生(不停轮、不挪卡、不留痕)。
        if (intent === 'recall' && SETTLED_TASK_STATUS.includes(task.status)) {
          sendJson(res, 200, { ok: false, fact: 'unsupported', intent, target: resolved.key, note: '这张卡已经收场(做完 / 取消),撤不回 —— 要推翻结论请用「改方向」,或先退回重开。' })
          return
        }
        const handed = await sayIntoTaskConversation(task, text, { intent })
        if (!handed.ok) {
          // 没送进去:行为账与规矩都**不记** —— 那句没落地,不许当生效指令。
          // model/host 两档按 Key 最终契约照原文回(与 /butler/item/say 同一分类,两种都零发送、
          // 零新卡/零新会话/零 prompt,原事项与会话保留);会话没了是老边界。
          // 撤回特殊一档:cancel 已把在跑的停住、只是队列清不动 —— 停轮是真的,如实写在回执里。
          if (handed.why === 'cancel-failed') {
            sendJson(res, 200, { ok: false, fact: 'failed', intent, target: resolved.key, note: `想撤,但这条会话这会儿停不住(${handed.cancelWhy ?? '这一版没有停会话的那颗键'})—— 撤回没办成,它还在跑,请到电脑上手动停。` })
            return
          }
          if (handed.why === 'stale-queue') {
            // 部分失败(摘一条成、下一条抛):拒发照旧,进度照实 —— 已摘 N 句、还有 M 句在队列里;
            // 绝不说「原样没动」(已有摘动);终证没写进也照实(原文在先留证里,可恢复)。
            const progress = handed.partial === undefined ? undefined
              : `已把能清的 ${handed.partial.removed.length} 句作废(原文留在卡上),还有 ${handed.partial.remaining.length} 句清不动、仍在队列里 —— `
            const progressNote = handed.partial === undefined ? undefined
              : (handed.evidencePersisted === false
                  ? `${progress}进度的留痕这会儿没写进卡(原文动手前已留在卡上,可核对)—— `
                  : progress)
            sendJson(res, 200, handed.cancelledRunning === true
              ? { ok: false, fact: 'failed', code: 'session_stale_queue', stopped: true, intent, target: resolved.key, cleared: handed.partial?.removed.length ?? 0, note: `在跑的那一轮已停住;${progressNote ?? '队列里排着的旧话这会儿读不清 / 清不动 —— '}怕旧方案复活,撤回没办成:卡没挪,请再试(会先清剩下的)。` }
              : { ok: false, fact: 'failed', code: 'session_stale_queue', intent, target: resolved.key, cleared: handed.partial?.removed.length ?? 0, note: `${progressNote ?? '改方向 / 撤回前要先清掉这条会话里排着的旧话(旧队列不复活),队列这会儿读不清 / 清不动 —— '}这句没有发送;再试会先清剩下的。` })
            return
          }
          if (handed.why === 'evidence-refused') {
            // 先留证没写进卡:一条都没摘、队列原样(这句是真的)。停轮若已发生也照实带上。
            sendJson(res, 200, handed.cancelledRunning === true
              ? { ok: false, fact: 'failed', code: 'session_stale_queue', stopped: true, intent, target: resolved.key, cleared: 0, note: '在跑的那一轮已停住;但把要作废的旧话先留在卡上这一步没写进去(留言这会儿落不了盘)—— 没凭据不动手:队列一条没动,撤回没办成,请再试。' }
              : { ok: false, fact: 'failed', code: 'session_stale_queue', intent, target: resolved.key, cleared: 0, note: '把要作废的旧话先留在卡上这一步没写进去(留言这会儿落不了盘)—— 没凭据不动手:队列一条没动,这句也没有发送,请再试。' })
            return
          }
          if (handed.why === 'no-conversation') {
            sendJson(res, 200, { ok: false, fact: 'unsupported', target: resolved.key, note: '这件事的会话没开,说不进去 —— 可以只留一句记在卡上。' })
            return
          }
          sendJson(res, 200, handed.why === 'model'
            ? { ok: false, fact: 'failed', code: 'model_alignment_failed', target: resolved.key, note: '当前模型还没完成应用，这句话没有发送；原事项和会话保留，请重试模型设置。' }
            : handed.why === 'host'
              ? { ok: false, fact: 'failed', code: 'session_send_failed', target: resolved.key, note: '会话通道暂时不可用，这句话没有发送；请稍后重试。' }
              : { ok: false, fact: 'failed', target: resolved.key, note: '这条会话在 DSH 里已经没了' })
          return
        }
        // 真办成了,才记这一笔(行为账按意图记 改方向 / 催一下 / 撤回 / 补一句)。
        noteHandedToItem(req, device, behaviorEnd, task, text, typeof body.channel === 'string' ? body.channel : undefined, intent)
        if (intent === 'recall') {
          // 撤回收尾:挪回待排 + 卡上带框留言(intent 结构化,清掉的旧句附在同一格);一个字没进会话。
          const settled = await recallSettleOnCard(task, text, handed.cleared ?? [], commentByOf())
          broadcast({ kind: 'snapshot', state: await composeState() })
          sendJson(res, 200, {
            ok: true,
            fact: 'recalled',
            intent,
            stopped: handed.cancelledRunning === true,
            cleared: handed.cleared?.length ?? 0,
            target: resolved.key,
            note: intentReceiptOf('recall', {
              wasRunning: handed.wasRunning === true,
              cancelled: { ok: true, running: handed.cancelledRunning === true },
              cleared: handed.cleared,
            }) + (settled.moved ? '' : ' 卡这会儿挪不动(状态进路不合),先停在这里。'),
          })
          return
        }
        // 非补充意图在卡上留结构化 intent 痕(带框 + 清掉的旧句附在同一格):卡自己的历史里四意图可区分。
        if (intent !== 'supplement') {
          const frame = intentPlanOf(intent).frame(task.id, text) ?? text
          const clearedSuffix = (handed.cleared?.length ?? 0) > 0
            ? `\n—— 递这句前还排着 ${handed.cleared?.length} 句旧话,已一并作废留存:\n${(handed.cleared ?? []).map(one => `· ${one}`).join('\n')}`
            : ''
          await tasks.comment(itemId, { by: commentByOf(), text: `${frame}${clearedSuffix}`, intent }).catch(() => undefined)
        }
        broadcast({ kind: 'snapshot', state: await composeState() })
        sendJson(res, 200, {
          ok: true,
          fact: intent === 'redirect' ? 'redirected' : 'sent',
          ...(intent === 'supplement' ? {} : { intent }),
          delivered: 'sent',
          target: resolved.key,
          ...((handed.cleared?.length ?? 0) > 0 ? { cleared: handed.cleared?.length } : {}),
          note: intent === 'supplement'
            ? '捎到了 —— 你那句话已经送进事务官那条会话里了。'
            : intentReceiptOf(intent, {
                // steer 两意图:interrupted = 发送前在跑且真打断进去(没在跑退化成 queue,如实不说打断)。
                wasRunning: handed.interrupted === true,
                cleared: handed.cleared,
              }),
        })
        return
      }

      // 外部会话那条路只捎得动原话:改方向 / 加速 / 撤回打断不了它,如实说,不假装已改向。
      const relayWhy = intentUnsupportedWhy(intent, relayAgentName(resolved.target.agent))
      if (relayWhy !== undefined) {
        sendJson(res, 200, { ok: false, fact: 'unsupported', intent, target: resolved.key, note: relayWhy })
        return
      }
      if (sessionAnswer === undefined) { sendJson(res, 404, { error: '往那家会话里捎话的路没接上' }); return }
      const result = await sessionAnswer.relay(resolved.target.agent, resolved.target.sessionId, text, {})
      const fact = continueFactOf(result, relayAgentName(resolved.target.agent))
      if (fact.ok) {
        // 送到了 / 留着等它醒了,才记「他补了一句」;没办成的那句不算生效指令。
        noteHandedToItem(req, device, behaviorEnd, task, text, typeof body.channel === 'string' ? body.channel : undefined)
      }
      broadcast({ kind: 'snapshot', state: await composeState() })
      sendJson(res, 200, { ok: fact.ok, fact: fact.fact, note: fact.note, target: resolved.key, ...(fact.delivered === undefined ? {} : { delivered: fact.delivered }) })
      return
    }

    /**
     * 他的规矩:一处存、处处读(2026-09-24 晚,卡 K;docs/设计-全局自进化-2026-09-24.md)。
     *
     *   GET  /butler/rules                  表(算数的 + 留底的)。电脑与手机的设置、事务官都读这一份
     *   POST /butler/rules                  { text, area?, channel? }  他明说的一条 → 当场生效(同步 AGENTS.md)
     *   POST /butler/rules/update           { id, text?, area? }
     *   POST /butler/rules/remove           { id }   删(留底;`pref:` 开头的是选题卡偏好,走进化循环的撤)
     *   POST /butler/rules/restore          { id }
     *   POST /butler/rules/feedback         { kind: revise|pass|run, where, text?, area?, channel? }  他的反馈
     *   GET  /butler/rules/brief?for=dispatch|say|review|agents&item=<事项 id>&text=<这件活>   那几段字
     *   POST /butler/rules/check            { item_id?, text?, files?, cwd?, family?, spoken? }  按规矩自查
     *   POST /butler/rules/import           { from: 'observations' }  从 用户-*.md「观察」导入
     *
     * 门:都要 `trusted`。写的那几条对**程序来源**(事务官的 curl)再过授权表 `write_docs`;
     * 页面与手机是他本人在点,不拦。`check` 与 `brief` 只读,不过授权表。
     */
    /**
     * 事务官的提示词,集中改的那一页(2026-10-01;`server/promptsPage.ts`)。
     *
     *   GET  /butler/prompts          AGENTS.md 里每一段(全文、她改过没有、默认有没有更新)+ 段外只读
     *   POST /butler/prompts/save     { name, body }  保存即重写那一段(写前备份、段外一个字不动)
     *   POST /butler/prompts/reset    { name }        换回默认那一份
     *   POST /butler/prompts/undo     { name }        撤到上一版
     *
     * 2026-10-02(卡「提示词页改成她的偏好页」)多三条,改的是**一个环节的偏好**(不是正文):
     *
     *   POST /butler/prompts/pref         { name, lines: string[] }  整组替换,顺手重写那一段
     *   POST /butler/prompts/pref/undo    { name }                   撤到上一版
     *   POST /butler/prompts/pref/seen    { name }                   打发掉迁移那句提示
     *
     * 技能正文从此**改不动**(`save` 当场 400)—— 门在 `store.save` 里,不只是界面上灰一下。
     *
     * **门:只有她本人**(2026-09-28 卡 BS 那一套,`notHerself`;决策记录 2026-09-28 15:5x 第 1、4 条)。
     * 改的是事务官自己读的那份系统提示 —— **事务官与派出去的别家一律不许改**:
     * 能改它就等于能把「先问一句」「不许自己拍板」这些话自己删掉,那是这一整套门最不能漏的一处。
     * 她的页面 / 她的手机 / 电话里她亲口说的(工人转)放过。
     *
     * 不接 `prompts` 时一律 404 —— 这块功能之前的行为一字不变。
     */
    if (path === '/butler/prompts' && req.method === 'GET') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机或已配对的手机上看事务官的提示词' }); return }
      if (prompts === undefined) { sendJson(res, 404, { error: '集中改提示词未启用' }); return }
      sendJson(res, 200, await prompts.view())
      return
    }
    if (req.method === 'POST' && path.startsWith('/butler/prompts/')) {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机或已配对的手机上改事务官的提示词' }); return }
      const notHerPrompt = notHerself(asker, 'answer')
      if (notHerPrompt !== undefined) { sendJson(res, 403, { error: notHerPrompt }); return }
      if (prompts === undefined) { sendJson(res, 404, { error: '集中改提示词未启用' }); return }
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      if (name === '') { sendJson(res, 400, { error: '要带 name(哪一段)' }); return }
      let done: PromptsWriteResult
      if (path === '/butler/prompts/save') {
        if (typeof body.body !== 'string') { sendJson(res, 400, { error: '要带 body(这一段的全文)' }); return }
        done = await prompts.save({ name, body: body.body })
      }
      else if (path === '/butler/prompts/pref') {
        // 一行一条:给数组照收;给一整块文字就按行拆(界面上是一个框,手机上也好打)。
        const lines = Array.isArray(body.lines)
          ? body.lines.filter((one): one is string => typeof one === 'string')
          : typeof body.lines === 'string' ? body.lines.split('\n') : undefined
        if (lines === undefined) { sendJson(res, 400, { error: '要带 lines(这个环节的偏好,一行一条)' }); return }
        done = await prompts.setPrefs({ name, lines })
      }
      else if (path === '/butler/prompts/pref/undo') done = await prompts.undoPrefs(name)
      else if (path === '/butler/prompts/pref/seen') done = await prompts.dismissPrefNotice(name)
      else if (path === '/butler/prompts/reset') done = await prompts.reset(name)
      else if (path === '/butler/prompts/undo') done = await prompts.undo(name)
      else { sendJson(res, 404, { error: '没有这条路' }); return }
      if (!done.ok) { sendJson(res, 400, { error: done.error }); return }
      sendJson(res, 200, { ok: true, note: done.note, ...(done.backup_path === undefined ? {} : { backup_path: done.backup_path }) })
      return
    }

    /**
     * 「派活与办完提醒」(2026-10-23,卡「分层第二刀一」):哪几类事项办完要告诉她(交办 / 派活 / 会议 / 例程),
     * 以及「桌面那一类不问就派」。只认本机与配对的手机;写走规矩表同一档门(`write_docs` —— 程序来源不许替她改偏好)。
     */
    if (path === '/dispatch/prefs' && req.method === 'GET') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机或已配对的手机上看偏好' }); return }
      if (options.dispatchPrefs === undefined) { sendJson(res, 404, { error: '偏好未启用' }); return }
      sendJson(res, 200, options.dispatchPrefs.view())
      return
    }
    if (path === '/dispatch/prefs' && req.method === 'POST') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机或已配对的手机上改偏好' }); return }
      if (options.dispatchPrefs === undefined) { sendJson(res, 404, { error: '偏好未启用' }); return }
      const denied = await rulesWriteDenied(req, device)
      if (denied !== undefined) { sendJson(res, 403, { error: denied }); return }
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      const rawScope = (typeof body.tell_scope === 'object' && body.tell_scope !== null ? body.tell_scope : {}) as Record<string, unknown>
      const scopePatch = Object.fromEntries(Object.entries(rawScope).filter(([, value]) => typeof value === 'boolean'))
      const saved = await options.dispatchPrefs.save({
        ...(Object.keys(scopePatch).length === 0 ? {} : { tell_scope: scopePatch }),
        ...(typeof body.auto_desk === 'boolean' ? { auto_desk: body.auto_desk } : {}),
      })
      broadcast({ kind: 'snapshot', state: await composeState() })
      sendJson(res, 200, { ok: true, ...saved })
      return
    }

    if (path === '/butler/rules' && req.method === 'GET') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机或已配对的手机上看规矩' }); return }
      if (rules === undefined) { sendJson(res, 404, { error: '规矩表未启用' }); return }
      sendJson(res, 200, rules.view())
      return
    }
    if (path === '/butler/rules/brief' && req.method === 'GET') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机或已配对的手机上取规矩' }); return }
      if (rules === undefined) { sendJson(res, 404, { error: '规矩表未启用' }); return }
      const query = new URL(req.url ?? '/', 'http://x').searchParams
      const moment = query.get('for') ?? 'dispatch'
      if (moment !== 'dispatch' && moment !== 'say' && moment !== 'review' && moment !== 'agents') {
        sendJson(res, 400, { error: 'for 要是 dispatch / say / review / agents 之一' })
        return
      }
      const itemText = await ruleTaskText(query.get('item') ?? undefined)
      const taskText = [itemText, query.get('text') ?? ''].join('\n')
      sendJson(res, 200, rules.brief(moment, taskText))
      return
    }
    if (path.startsWith('/butler/rules') && req.method === 'POST'
      && ['/butler/rules', '/butler/rules/update', '/butler/rules/remove', '/butler/rules/restore', '/butler/rules/feedback',
        '/butler/rules/check', '/butler/rules/import', '/butler/rules/move'].includes(path)) {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机或已配对的手机上改规矩' }); return }
      if (rules === undefined) { sendJson(res, 404, { error: '规矩表未启用' }); return }
      const body = await readJsonBody(req, res)
      if (body === undefined) return

      if (path === '/butler/rules/check') {
        const itemId = typeof body.item_id === 'string' && body.item_id !== '' ? body.item_id : undefined
        const task = itemId === undefined || tasks === undefined ? undefined : (await tasks.list()).tasks.find(one => one.id === itemId)
        const cwd = typeof body.cwd === 'string' && body.cwd !== '' ? body.cwd : (task?.dispatch?.cwd ?? '')
        const read = await readRuleReviewFiles(cwd, body.files)
        const family = typeof body.family === 'string' && body.family !== ''
          ? body.family
          : (task?.dispatch === undefined ? undefined : targetTitle(dispatchTargetsNow(), task.dispatch.family))
        const review = await rules.review({
          ...(itemId === undefined ? {} : { itemId }),
          ...(typeof body.text === 'string' ? { text: body.text } : {}),
          files: read.files,
          taskText: task === undefined ? '' : [task.title, task.desc ?? ''].join('\n'),
          ...(family === undefined ? {} : { family }),
          spoken: body.spoken === true,
        })
        sendJson(res, 200, { ...review, ...(read.skipped.length === 0 ? {} : { skipped: read.skipped }) })
        return
      }

      const denied = await rulesWriteDenied(req, device)
      if (denied !== undefined) { sendJson(res, 403, { error: denied }); return }

      /**
       * 「从记忆里的观察学」(2026-10-09,卡「学风格」):观察**不再一次性导成规矩**,改走风格那一道
       * (观察 → 候选 → 不同两件事上都出现才试用 → 验)。回 `{ ok, added: 0, candidates, adopted, note }`。
       */
      if (path === '/butler/rules/import') {
        if (body.from !== 'observations') { sendJson(res, 400, { error: 'from 现在只认 observations' }); return }
        if (options.habits === undefined) { sendJson(res, 404, { error: '习惯没接上,观察这一路学不了' }); return }
        const learned = await options.habits.learnObservations()
        if (!learned.ok) { sendJson(res, 404, { error: learned.note }); return }
        broadcast({ kind: 'snapshot', state: await composeState() })
        sendJson(res, 200, { ok: true, added: 0, candidates: learned.candidates, adopted: learned.adopted, note: learned.note })
        return
      }

      if (path === '/butler/rules/feedback') {
        const kind = body.kind
        if (kind !== 'revise' && kind !== 'pass' && kind !== 'run') { sendJson(res, 400, { error: 'kind 要是 revise / pass / run' }); return }
        const where = typeof body.where === 'string' ? body.where.trim() : ''
        if (where === '') { sendJson(res, 400, { error: 'where 必须是非空字符串(哪件活:事项 id 或需求卡名)' }); return }
        const text = typeof body.text === 'string' ? body.text.trim() : undefined
        const area = isButlerRuleArea(body.area) ? body.area : ruleWorkArea(`${await ruleTaskText(where)}\n${text ?? ''}`)
        const learned = await rules.feedback({
          kind, where, area,
          channel: ruleChannelOf(req, device, body.channel, 'butler'),
          ...(text === undefined || text === '' ? {} : { text }),
        })
        broadcast({ kind: 'snapshot', state: await composeState() })
        sendJson(res, 200, { ok: true, ...learned })
        return
      }

      const id = typeof body.id === 'string' ? body.id.trim() : ''
      if (path === '/butler/rules') {
        const text = typeof body.text === 'string' ? body.text : ''
        const done = await rules.add({
          text,
          ...(body.area === undefined ? {} : { area: body.area }),
          channel: ruleChannelOf(req, device, body.channel, 'butler'),
          ...(typeof body.said === 'string' && body.said.trim() !== '' ? { said: body.said } : {}),
          ...(typeof body.where === 'string' && body.where.trim() !== '' ? { where: body.where.trim() } : {}),
        })
        if (!done.ok) { sendJson(res, 400, { error: done.error }); return }
        broadcast({ kind: 'snapshot', state: await composeState() })
        sendJson(res, 200, done)
        return
      }
      if (id === '') { sendJson(res, 400, { error: 'id 必须是非空字符串' }); return }
      // 选题卡偏好那几条(`pref:`)住在进化循环里:删 = 撤,改字不支持。
      if (id.startsWith('pref:')) {
        if (path !== '/butler/rules/remove') { sendJson(res, 400, { error: '选题卡学到的偏好只能撤,不能改字' }); return }
        if (evolve === undefined) { sendJson(res, 404, { error: '进化循环未启用' }); return }
        const done = await evolve.revert(id)
        if (!done.ok) { sendJson(res, 400, { error: done.error }); return }
        await rules.sync()
        broadcast({ kind: 'snapshot', state: await composeState() })
        sendJson(res, 200, { ok: true, note: done.note })
        return
      }
      const done = path === '/butler/rules/update'
        ? await rules.update(id, { text: body.text, area: body.area })
        : path === '/butler/rules/remove' ? await rules.remove(id)
          : path === '/butler/rules/move'
            ? body.dir === 'up' || body.dir === 'down'
              ? await rules.move(id, body.dir)
              : { ok: false as const, error: 'dir 要是 up 或 down' }
            : await rules.restore(id)
      if (!done.ok) { sendJson(res, 400, { error: done.error }); return }
      broadcast({ kind: 'snapshot', state: await composeState() })
      sendJson(res, 200, done)
      return
    }

    /**
     * POST /butler/memory/preference { text, kind? }(2026-09-23,Ben 第五通真机)。
     *
     * 他在电话里三次说「这个我记着了」「记住」,而工人**什么都没落盘** —— 下一通照旧。
     * 这条窄口就是那件事的出口:把一条**以后都算数**的规矩写进 `~/.dsh/AGENTS.md` 的
     * 标记段,下一通电话由 `GET /channel/persona` 原样读回系统提示里。
     *
     * 三条纪律:
     *   ① **只写两个标记段**(`通话偏好` / `称呼`),**段外一个字不动** —— 那份文件是他自己的,
     *      跟代写技能段、代写钩子同一条老规矩(先备份、只换段、写不成就整件作罢)。
     *   ② **门是授权表的 `write_docs`**,不是 `write_api`:写的是 docs 那一类(他的人设文件),
     *      不是工作台的业务数据。今天 `write_docs` 是「要问」,于是程序来源会吃 403 ——
     *      **那是对的**,工人拿到 403 会照实告诉他要改哪一行,而不是假装记住了。
     *   ③ **不新建一条事项、不开会话**:一条偏好不是一件活。
     *
     * 为什么不复用 `/config/ops-skills/apply`:那一条整段重写技能段,而这里是**往段里追一条**;
     * 混成一条路由,以后「接技能」那一下会把他在电话里攒的偏好一起抹掉。
     */
    if (path === '/butler/memory/preference' && req.method === 'POST') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机或已配对的手机上写人设' }); return }
      // 授权表那一档是 write_docs(见上面第 ② 条)。页面与手机是 Ben 自己在点,不受这张表管。
      if (authorization !== undefined && device === undefined && actorOfRequest(req.headers) !== 'page'
        && !(await authorization.isAllowed('write_docs'))) {
        sendJson(res, 403, { error: authorization.denialMessage('write_docs') })
        return
      }
      /**
       * 2026-09-24 晚(卡 K):**他立的规矩一律进规矩表**(一处存、处处读),不再只写「通话偏好」段 ——
       * 表一变就同步进 AGENTS.md 的「规矩」段,电话人设每通现取,派活、验收也读同一张表。
       * 称呼那一支照旧(它是一张轮着用的表,不是规矩)。没接规矩表时走老路,一字不变。
       */
      let early: Record<string, unknown> | undefined
      if (rules !== undefined) {
        early = await readJsonBody(req, res)
        if (early === undefined) return
        if (early.kind !== 'address') {
          const said = typeof early.text === 'string' ? early.text.trim().replace(/\s+/g, ' ') : ''
          if (said === '') { sendJson(res, 400, { error: 'text 必须是非空字符串' }); return }
          const done = await rules.add({ text: said, channel: ruleChannelOf(req, device, early.channel, 'call') })
          if (!done.ok) { sendJson(res, 400, { error: done.error }); return }
          broadcast({ kind: 'snapshot', state: await composeState() })
          sendJson(res, 200, { ok: true, block: '规矩', added: done.added, rule: done.rule, note: done.note })
          return
        }
      }
      const prepared = await prepareOpsSkills()
      // 拿不到家目录 / 没接代写这一档:如实 404,**不往别处写一份**。
      if (!prepared.ok) { sendJson(res, prepared.status, { error: `写不了人设:${prepared.error}` }); return }

      const body = early ?? await readJsonBody(req, res)
      if (body === undefined) return
      const text = typeof body.text === 'string' ? body.text.trim().replace(/\s+/g, ' ') : ''
      if (text === '') { sendJson(res, 400, { error: 'text 必须是非空字符串' }); return }
      if (text.length > 200) { sendJson(res, 400, { error: '一条偏好太长了(上限 200 字),说短一点' }); return }
      const kind = body.kind === 'address' ? 'address' : 'preference'
      const block = kind === 'address' ? CALL_ADDRESS_BLOCK : CALL_PREFS_BLOCK
      /**
       * 称呼**不带日期**:它是一张轮着用的表,日期写进去会被当成称呼的一部分念出来。
       * 偏好带日期:哪天立的规矩,他翻文件时看得见。
       */
      /*
       * 称呼**只存称呼本身**(2026-10-02,卡「电话里像个活人」):她说「以后叫我小笨蛋」,
       * 表里要存的是「小笨蛋」。以前存的是整句,于是开场白变成了
       * 「以后叫小笨蛋,有什么吩咐?」—— Air 那几通里 22 次。判据在 rtcCall.ts 的 `addressNameOf`
       * (读那一头也用同一个函数,把表里已经躺着的整句剥掉)。
       */
      const line = kind === 'address'
        ? (addressNameOf(text) === '' ? text : addressNameOf(text))
        : `${text}(${prepared.deps.now().toISOString().slice(0, 10)})`

      const original = await prepared.deps.io.readFile(prepared.file)
      const merged = appendToMarkedBlock(original, block, line)
      // 已经有一模一样的一条:**不写、不备份**,但照样回 200 —— 对他而言这句话确实记着了。
      if (merged === undefined) {
        sendJson(res, 200, { ok: true, file: prepared.file, block, added: false, note: '这一条已经在人设里了,没重复写。' })
        return
      }
      // 段正文 = 合并之后那一段里的每一行(备份 → 换段 → 写回仍然走 wbSkillApply 那一份)。
      const nextBody = listInMarkedBlock(merged, block).map(one => `- ${one}`).join('\n')
      const applied = await wbSkillApply(prepared.deps, { file: prepared.file, name: block, body: nextBody })
      if (!applied.ok) { sendJson(res, 409, { error: applied.error }); return }
      sendJson(res, 200, {
        ok: true,
        file: prepared.file,
        block,
        added: true,
        ...(applied.backup_path === undefined ? {} : { backup_path: applied.backup_path }),
        // 通话人设是**每通电话现取**的(GET /channel/persona),所以这条不用等重开会话就算数;
        // 事务官本尊那条 DSH 会话仍要新开一条才读得到(同技能段那条提示)。
        note: '下一通电话就算数;事务官本尊那条会话要新开一条才读得到。',
      })
      return
    }

    /**
     * 派活的进度回报与撤销(2026-09-21,参赛冲刺卡 ④)。
     *
     *   POST /butler/item/dispatch       { id, family, status, cwd, pid?, note? }  事务官报一次进度
     *   POST /butler/item/dispatch/stop  { id }                                    杀掉它报上来的那个 pid
     *
     * **这一层不起进程,只记账**:真正 spawn 的是事务官(它有 shell、有会话记录,跑的每一条
     * 命令在 DSH 里都看得见)。这里只做它做不了的三件事 —— 把状态记在卡上、按 pid 停掉、
     * 失败时在收件箱里问一句(那一句由 butlerInbox.ts 现拼)。
     *
     * 门与建事项同一道(回环或已配对设备 + 授权表 write_api),不另开一道。
     */
    if (path === '/butler/item/dispatch' && req.method === 'POST') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机或已配对的手机上报派活进度' }); return }
      if (tasks === undefined) { sendJson(res, 404, { error: '任务看板未启用' }); return }
      const denied = await agentWriteDenied(req, device)
      if (denied !== undefined) { sendJson(res, 403, { error: denied }); return }

      const body = await readJsonBody(req, res)
      if (body === undefined) return
      const itemId = typeof body.id === 'string' ? body.id.trim() : ''
      if (itemId === '') { sendJson(res, 400, { error: 'id 必须是非空字符串' }); return }
      // 「只出方案」那件不派(2026-09-24)。只挡「开始派」,报完成 / 失败照收 —— 那是事实。
      if (body.status === 'running' && await itemModeOf(itemId) === 'plan') { sendJson(res, 409, { error: PLAN_ONLY_DISPATCH_ERROR }); return }
      /*
       * ★ 2026-09-25(卡 Z):认不认得这一家问 **Agent 登记表**(`dispatchTargetsNow`)——
       * 事务官报了一个登记表里没有的家名,那是它搞错了,当场 400、卡上一个字不改(不猜)。
       */
      if (!knownFamilyName(body.family)) {
        const reportTargets = dispatchTargetsNow().map(one => one.id)
        sendJson(res, 400, { error: `family 要是这台电脑上认得的那几家里的一个:${reportTargets.join(' / ')}` })
        return
      }
      const reportFamily = body.family as string
      const status = body.status
      if (status !== 'running' && status !== 'done' && status !== 'failed') {
        sendJson(res, 400, { error: 'status 要是 running / done / failed' })
        return
      }
      /**
       * 哪只手(2026-09-21 Ben 纠正:派活 = 直接操作客户端窗口,命令行是备用的那只)。
       * **认不出就当缺席**(= 命令行),不退回整条:这件功能头一版只有命令行这一只手。
       *
       * **挪到 cwd 那道检查前面了**(2026-09-22):接口那只手没有工作目录,
       * 要先知道是哪只手,才知道该不该要 cwd。
       */
      const hand = (DISPATCH_HANDS as readonly unknown[]).includes(body.hand) ? body.hand as TaskDispatch['hand'] : undefined
      const cwd = typeof body.cwd === 'string' ? body.cwd.trim() : ''
      /**
       * ★ **`api` 那只手不要求 cwd**:它经中转问一家上游,只回一段字,不碰任何文件
       * (「让 GPT 写条文案」这种活根本没有仓库)。命令行与窗口那两只手仍然必填 ——
       * 它们真会在某个目录里动东西,而"在哪个仓库改的"是验收时第一个要问的。
       */
      if (cwd === '' && hand !== 'api') {
        sendJson(res, 400, { error: 'cwd 必须是非空字符串(活在哪个目录里跑的;走接口那只手可以不填)' })
        return
      }

      const task = (await tasks.list()).tasks.find(candidate => candidate.id === itemId)
      if (task === undefined) { sendJson(res, 404, { error: '没有这个事项' }); return }
      /**
       * ★ **派活那一处的门**(2026-10-21 协作区,`noteGate.ts`):开始派之前便签上要写清「做到什么算完」。
       * 只挡 `running`(开始派);报完成 / 失败照收 —— 那是事实。
       */
      if (status === 'running') {
        const gate = dispatchGate(task)
        if (gate !== undefined) { sendJson(res, 409, { error: gate }); return }
      }

      /**
       * 目录门(任务书第 4 条)。**只在扫描根底下跑** —— 这一道在"记账"这一层把,
       * 是因为它是唯一一处我们能拦住的地方:事务官自己那条 shell 我们管不着,
       * 但它报上来的目录不在授权范围内时,这条记账必须拒绝,并且这句拒绝会回到它的会话里。
       */
      const roots = (await dispatchRoots()).map(root => root.path)
      if (cwd !== '' && roots.length > 0 && !dispatchCwdAllowed(cwd, roots)) {
        sendJson(res, 403, {
          error: `${cwd} 不在授权的扫描根底下(${roots.join('、')}),派活不许在这里跑。`,
        })
        return
      }

      const at = new Date().toISOString()
      const note = typeof body.note === 'string' && body.note.trim() !== '' ? body.note.trim() : undefined
      const pid = typeof body.pid === 'number' && Number.isInteger(body.pid) && body.pid > 1 ? body.pid : undefined
      const dispatch: TaskDispatch = {
        family: reportFamily,
        status,
        ...(hand === undefined ? {} : { hand }),
        ...(cwd === '' ? {} : { cwd }),
        ...(pid === undefined ? {} : { pid }),
        // 还在跑的那次保留原来的开始时刻;`running` 是**这一次派活的起点**,重派一次就换一个。
        started_at: status === 'running' ? at : (task.dispatch?.started_at ?? at),
        ...(status === 'running' ? {} : { ended_at: at }),
        ...(note === undefined ? {} : { note }),
      }
      const written = await tasks.update(itemId, { dispatch })
      if (!written) { sendJson(res, 404, { error: '没有这个事项' }); return }
      /**
       * 规矩(2026-09-24 晚,卡 K)。开始派(running):清掉上次自查没过那一笔、记一条「派出去了」;
       * 报完成(done):按他的规矩自查一遍交回来的东西(`result` 原文 + `files` 改过的文件,相对 cwd)。
       * 没过 → 回包带 review 与一句给她的话(把打回原话发给那家,别叫他);这件活不进「等我确认」(heldBack)。
       */
      let ruleReview: ButlerRuleReviewView | undefined
      let rulesNote: string | undefined
      if (rules !== undefined) {
        const work = [task.title, task.desc ?? ''].join('\n')
        const who = targetTitle(dispatchTargetsNow(), reportFamily)
        if (status === 'running') {
          await rules.clearReview(itemId)
          await rules.feedback({ kind: 'run', where: itemId, area: ruleWorkArea(work), channel: 'butler' }).catch(() => undefined)
        }
        else if (status === 'done') {
          const read = await readRuleReviewFiles(cwd, body.files)
          const resultText = [note ?? '', typeof body.result === 'string' ? body.result : ''].filter(one => one !== '').join('\n')
          // 她派活时贴的就是这一段(/butler/rules/brief?for=dispatch 回的);交回来的话里抄着它 = 不合格。
          const instruction = rules.brief('dispatch', work).text
          ruleReview = await rules.review({
            itemId, text: resultText, files: read.files, taskText: work, family: who,
            ...(instruction === undefined ? {} : { instruction }),
          })
          const eye = ruleReview.by_eye
          rulesNote = ruleReview.pass
            ? `按他的规矩自查过了${eye.length === 0 ? '' : `(机器查不了、要你亲眼看的:${eye.slice(0, 4).join('、')}${eye.length > 4 ? ` 等 ${eye.length} 条,全文在 review.by_eye` : ''})`},可以叫他验收,带截图。`
            : `按他的规矩自查没过:${ruleReview.violations.map(one => `${one.rule}(${one.why})`).join(';')}。`
              + `把 review.reject_text 原样发回给 ${who} 让它改,改好再报 done —— 这时别叫他。`
        }
      }
      broadcast({ kind: 'snapshot', state: await composeState() })
      // 回一句**给事务官念的人话**:它会把这一句转述到事项的会话里,措辞由服务端统一生成。
      sendJson(res, 200, {
        ok: true, id: itemId, dispatch, note: dispatchNote(dispatch),
        ...(ruleReview === undefined ? {} : { review: ruleReview }),
        ...(rulesNote === undefined ? {} : { rules_note: rulesNote }),
      })
      return
    }

    if (path === '/butler/item/dispatch/stop' && req.method === 'POST') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机或已配对的手机上停派活' }); return }
      if (tasks === undefined) { sendJson(res, 404, { error: '任务看板未启用' }); return }
      const denied = await agentWriteDenied(req, device)
      if (denied !== undefined) { sendJson(res, 403, { error: denied }); return }

      const body = await readJsonBody(req, res)
      if (body === undefined) return
      const itemId = typeof body.id === 'string' ? body.id.trim() : ''
      if (itemId === '') { sendJson(res, 400, { error: 'id 必须是非空字符串' }); return }

      const task = (await tasks.list()).tasks.find(candidate => candidate.id === itemId)
      if (task === undefined) { sendJson(res, 404, { error: '没有这个事项' }); return }
      const running = task.dispatch
      if (running === undefined || running.status !== 'running') {
        sendJson(res, 409, { error: '这条事项上没有正在跑的派活' })
        return
      }
      // 停不掉就**如实说停不掉**,而且**不改卡上的状态** —— 把一条还在跑的活标成"停了",
      // 是这件功能里最坏的一种失真:他会以为文件不会再被改了。
      if (running.pid === undefined) {
        sendJson(res, 409, { error: '事务官没报这次派活的进程号,停不掉它;去它那条会话里让它自己停。' })
        return
      }
      try { killDispatch(running.pid) }
      catch (error) {
        const reason = (error as { code?: string }).code === 'ESRCH' ? '那个进程已经不在了' : String((error as Error).message ?? error)
        // ESRCH = 进程早就退了。这不是失败,但也不能当成"我停掉的" —— 如实记一句。
        if ((error as { code?: string }).code !== 'ESRCH') { sendJson(res, 409, { error: `停不掉(${reason})` }); return }
      }
      const at = new Date().toISOString()
      const dispatch: TaskDispatch = {
        ...running,
        status: 'failed',
        ended_at: at,
        note: `你在卡上停掉了它(pid ${running.pid})`,
      }
      await tasks.update(itemId, { dispatch })
      broadcast({ kind: 'snapshot', state: await composeState() })
      sendJson(res, 200, { ok: true, id: itemId, dispatch, note: dispatchNote(dispatch) })
      return
    }

    /**
     * 通道层(2026-09-17,docs/设计-手机通道层-2026-09-17.md §二)。这几条,一条都不多:
     *
     *   GET  /channel/credentials 工人要的第三方凭据(火山)。**只认回环**,见那一条上面的注释。
     *   POST /channel/token    进房凭证。门与建事项同一道——**能写事项的才能进房**。
     *   POST /channel/relay-device  把这台手机加到电脑登录的那个账号下,交给它一把中转设备令牌
     *                          (2026-09-21;有了它手机出门也能自己领房间凭证)。
     *   POST /channel/relay-handset 同上,但记的是**座机**(2026-09-27,卡 HS):手机上「添加座机」
     *                          最后一步由电脑代办 —— 扫码配对的手机没有账号会话。
     *   GET  /channel/status   服务器在不在、工人在不在房、本机还是远程。探不到就如实说探不到。
     *   GET  /channel/persona  只给本机(工人进程)。人设与事项摘要只有一个来源,工人不自己编。
     *   POST /channel/start|stop、GET /channel/worker   工人进程的启停与状态,**只认回环**
     *                          (同 /butler/start|stop:它拉起/杀掉的是本机进程)。
     *
     * 身份由服务端按设备令牌拼(wb-phone-<device_id>),调用方说了不算:将来要按设备踢人、
     * 按设备限权,身份里必须有设备。api key / secret 只在 server/channel.ts 里签 JWT 时出现,
     * 一个字节都不回给调用方。
     */
    if (path === '/channel/token' && req.method === 'POST') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机或已配对的手机上取进房凭证' }); return }
      if (channel === undefined) { sendJson(res, 404, { error: '通道层未启用' }); return }
      /**
       * **签票先核归属**(2026-10-03,卡 claude/device-revoke-complete;审计附证 A 第三条:
       * 这一处"用本地 paired device 签票,未核该设备是否仍属账号")。
       *
       * 从账号里移除这台设备时,撤销路由同一下已经把本机配对撤了 —— 那条路上的请求根本
       * 到不了这里。这一道是为**撤销没发生在这台电脑上**的那些情形:她在另一台电脑上移除、
       * 或者 devices.json 被从备份里恢复回去了。续票走的也是这一条,所以这一道同时兑现了
       * 「已签的房票不再续」。判法与放行口径见 server/deviceAccountGate.ts(问不到就放行)。
       */
      if (device !== undefined && deviceAccountGate !== undefined) {
        const belongs = await deviceAccountGate.check(device.id)
        if (!belongs.ok) { sendJson(res, 403, { error: belongs.error }); return }
      }
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      // `worker: true` 只有本机给:它拿的是工人那个固定身份,手机拿到就能冒充工人占着房。
      const asWorker = body.worker === true && loopback
      /**
       * 身份后缀。两种用途,都由**本机**给:
       *   - 测试页(`wb-dev-<后缀>`);
       *   - **同一个房间里的第二台电脑**(2026-09-21):`wb-channel-worker-<后缀>`。
       *     第一台不带后缀 —— 手机只认 `wb-channel-worker` 这个字符串(见 channel.ts 那段注释)。
       * 手机传 suffix 一律忽略:它的身份按设备令牌拼,自己说了不算。
       */
      const suffix = typeof body.suffix === 'string' && body.suffix !== '' && device === undefined
        ? body.suffix
        : undefined
      /**
       * 按来路签(2026-10-21,局域网主路):工人回环、局域网里的设备给它进来的那块网卡、外网来的才让中转签。
       * `route` 只有本机给的才算(卡 M6 的第二条工人要云房间时传 `relay`)。
       */
      const tokenCaller = channelCaller(body.route)
      const issued = await channel.issue({
        ...(asWorker ? { worker: true } : {}),
        // 种类和设备 id 一样,**由这一层按令牌查出来**,不看调用方报什么
        // (2026-09-21;一台手机自称 handset 就能把通话的声音抢过去)。
        ...(asWorker || device === undefined ? {} : { deviceId: device.id, kind: device.kind ?? 'phone' }),
        ...(suffix === undefined ? {} : { suffix }),
        /**
         * 设备名。**已配对设备用配对记录里的那个名字**(服务端的真相),
         * 不用它自称的 —— 「发到…」的选单里列的就是这个名字,不能让谁自己改。
         */
        ...(device !== undefined
          ? { name: device.name }
          : (typeof body.name === 'string' && body.name !== '' ? { name: body.name } : {})),
      }, tokenCaller)
      if (issued === undefined) {
        sendJson(res, 503, { error: '通道层没配 LiveKit 的 api key / secret,签不出进房凭证' })
        return
      }
      sendJson(res, 200, issued)
      return
    }
    /**
     * 「把这台手机加到这个账号」(2026-09-21)。**扫码配对的那条快捷方式**。
     *
     * 手机要出门进房,得有一把自己的**中转设备令牌**;领它要账号会话,而账号会话
     * 只在这台电脑上(它是密码换来的,一个字节都不该进手机)。所以这条路是:
     *
     *   已配对的手机 ──▶ 8791 这一条 ──▶ 电脑拿自己的账号会话替它去中转领 ──▶ 把令牌交给它
     *
     * 于是手机不用在小屏幕上输一次密码,就成了这个账号名下的一台设备;
     * 之后它自己就能向中转领房间凭证,**再也不需要这台电脑在同一个局域网里**。
     *
     * 门与 /channel/token 同一道:只有已配对的手机(或本机)进得来。
     * 交出去的是**那台手机自己的**设备令牌(按它的 device_id 领),不是这台电脑那把。
     */
    if (path === '/channel/relay-device' && req.method === 'POST') {
      if (!trusted) { sendJson(res, 403, { error: '只能在已配对的手机上做这件事' }); return }
      if (device === undefined) { sendJson(res, 400, { error: '这条只给手机用:要先配对' }); return }
      /**
       * **被移出账号的手机不能靠这一条把自己再挂回去**(2026-10-03,卡 claude/device-revoke-complete)。
       *
       * 这条路是「扫码配对之后电脑替它领一把账号设备令牌」,而它**任何时候都调得动** ——
       * 少了这一道,在别处移除的那台手机(本机配对还没被通知到)只要自己再调一次,
       * 就又成了这个账号名下的设备,拿回一把新钥匙。判法与签票那一处同一份(问不到就放行);
       * 刚配对、从没挂过账号的手机没有那一笔记号,照旧走得通。
       */
      if (deviceAccountGate !== undefined) {
        const belongs = await deviceAccountGate.check(device.id)
        if (!belongs.ok) { sendJson(res, 403, { error: belongs.error }); return }
      }
      // 没接中转(零服务器档):没有账号可挂,说清楚,不说「去登录」(那一步在这一档不存在)。
      if (model !== undefined && (await model.status()).relay_configured === false) {
        sendJson(res, 409, { error: RELAY_LINK_NO_RELAY, code: 'no_relay' })
        return
      }
      if (!isServerAccount(account)) { sendJson(res, 404, { error: '账号还在这台电脑上,手机暂时只能走局域网' }); return }
      const session = await account.sessionToken()
      if (session === undefined) {
        sendJson(res, 409, { error: '电脑上还没登录账号。在电脑的工作台里登录一次,再在手机上试。' })
        return
      }
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      if (model === undefined) { sendJson(res, 404, { error: '模型服务未接线,取不到中转地址' }); return }
      const relayUrl = (await model.status()).relay_url
      const attached = await attachDeviceToAccount({
        relayUrl,
        session,
        deviceId: device.id,
        // 种类按配对记录走(2026-09-23):一只在局域网里配过对的话筒走这条路挂到账号下时,
        // 中转那边要记成 handset —— 中转现在按这一列往进房凭证里签 `wb_kind`,记错了
        // 等于把话筒当手机,通话的声音就送错地方。
        kind: device.kind ?? 'phone',
        name: typeof body.name === 'string' && body.name.trim() !== ''
          ? body.name.trim().slice(0, 64)
          : device.name,
      })
      if (!attached.ok) { sendJson(res, 503, { error: attached.error }); return }
      // 令牌明文只在这一次的回包里出现,和中转发它时同一条规矩:不进日志、不落这台电脑的盘。
      sendJson(res, 200, { relay_url: relayUrl, token: attached.token, device_id: device.id })
      return
    }
    /**
     * 「把这台**座机**记到这个账号下」(2026-09-27,卡 HS)。**电脑代办**。
     *
     * 手机上「设置 → 座机 → 添加座机」走到最后一步,要给座机换一把中转设备令牌。以前是手机
     * 拿**自己的账号会话**去中转领 —— 可扫码配对进来的手机按设计**根本没有账号会话**
     * (密码只在电脑上,见 butler-app/src/account/accountStore.ts),于是蓝牙、Wi-Fi 全走通了,
     * 最后一步死在「这台手机还没登录账号」,而且把人退回第一步。
     *
     * 这一条把那一步搬到电脑上,和 `/channel/relay-device` 同一个道理、同一道门:
     *
     *   手机(已配对) ──▶ 8791 这一条 ──▶ 电脑拿**自己的**账号会话替座机去中转领 ──▶ 手机经 BLE 交给座机
     *
     * 与 relay-device 唯一的区别:领的是**别人的** device_id(座机自己报上来的那个),
     * 所以这里必须校验形状 —— 一个随手写的 id 会在账号的「我的设备」里变出一台不存在的设备。
     * 种类写死 `handset`:中转按这一列往进房凭证里签 `wb_kind`,记成手机的话通话的声音就送错台。
     */
    if (path === '/channel/relay-handset' && req.method === 'POST') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机或已配对的手机上把座机记到账号下' }); return }
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      const handsetId = typeof body.device_id === 'string' ? body.device_id.trim() : ''
      // 形状按 phone-bridge/provision.py 的 device_id_of:`handset-` + machine-id 的十六进制。
      if (!/^handset-[0-9a-f]{1,32}$/.test(handsetId)) {
        sendJson(res, 400, { error: '这不像座机自己报上来的那个编号(handset-… 那种),没往账号里记' })
        return
      }
      if (model !== undefined && (await model.status()).relay_configured === false) {
        sendJson(res, 409, { error: RELAY_LINK_NO_RELAY, code: 'no_relay' })
        return
      }
      if (!isServerAccount(account)) { sendJson(res, 404, { error: '账号还在这台电脑上,座机暂时只能走局域网' }); return }
      const handsetSession = await account.sessionToken()
      if (handsetSession === undefined) {
        sendJson(res, 409, { error: '这台电脑上还没登录账号,记不了座机。在电脑的工作台里登录一次,再回手机上点「重试记账号」。' })
        return
      }
      if (model === undefined) { sendJson(res, 404, { error: '模型服务未接线,取不到中转地址' }); return }
      const handsetRelay = (await model.status()).relay_url
      const attachedHandset = await attachDeviceToAccount({
        relayUrl: handsetRelay,
        session: handsetSession,
        deviceId: handsetId,
        kind: 'handset',
        name: typeof body.name === 'string' && body.name.trim() !== ''
          ? body.name.trim().slice(0, 64)
          : '座机话筒',
      })
      if (!attachedHandset.ok) { sendJson(res, 503, { error: attachedHandset.error }); return }
      /**
       * **记到了谁名下**(2026-09-27,卡 RM ②)。手机上那句「已经记到你的账号下」太含糊:
       * 比赛现场那只座机记到的是**另一台电脑**的账号,而屏上那句话照样是绿的
       * (docs/交接-0927-座机进错房间.md 第一节)。所以这里如实回两样,让手机原样显示:
       * 这台电脑叫什么、这个账号是谁。取不到就缺席 —— 手机那边缺席就说老那句话,**不编**。
       */
      let boundName: string | undefined
      // 这一问纯属**锦上添花**:问不出账号名也绝不能把「座机记进账号」这件事判成失败
      // (用例里的假账号连 view 都没有)。所以整块 try 住,拿不到就缺席。
      try {
        const boundAccount = await account.view(undefined)
        if (typeof boundAccount?.username === 'string' && boundAccount.username !== '') boundName = boundAccount.username
      }
      catch { boundName = undefined }
      sendJson(res, 200, {
        relay_url: handsetRelay,
        token: attachedHandset.token,
        device_id: handsetId,
        computer: computerName,
        ...(boundName === undefined ? {} : { account: boundName }),
      })
      return
    }
    if (path === '/channel/status' && req.method === 'GET') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机或已配对的手机上看通道状态' }); return }
      if (channel === undefined) { sendJson(res, 404, { error: '通道层未启用' }); return }
      // 地址与票同一条规矩(2026-10-21):局域网里的设备问到的是它该连的那个地址,`mode: lan`。
      const status = await channel.status(channelCaller())
      /**
       * 语音后端在不在(2026-09-18,Ben 真机:8792 没起来时通话「接不上」)。
       * 探的是 butler-server 的 `/health`,与 /state.butler 同一条路、同一份 3 秒缓存 ——
       * 两处的结论不会打架。**没接线就说不出**(缺席,不编一个 'ok'):
       * 手机据此可以显示「这一通可能没有声音」,而不是对着一颗不说话的球干等。
       */
      const ttsBackend = butler === undefined ? undefined : (await butler.view()).running ? 'ok' : 'down'
      const workerProcess = channelWorker?.view()
      /**
       * 两条工人各在不在房(2026-10-22,卡 M6):**只给本机问的**(设置页、体检、统筹量)—— 另一间房要多查一趟,
       * 云房间那一趟还要向中转要一张查房凭证;手机要的「我这间房里有没有人接」上面 `worker` 已经答了。
       */
      const workers = loopback && workerProcess?.routes !== undefined
        ? await Promise.all(workerProcess.routes.map(async (one) => {
          const probed = status.route === one.route ? status : await channel.status({ want: one.route }).catch(() => undefined)
          return {
            route: one.route,
            ...(one.room === undefined ? {} : { room: one.room }),
            running: one.running,
            in_room: probed?.worker === true,
            ...(probed?.worker !== true && probed?.note !== undefined ? { note: probed.note } : {}),
          }
        }))
        : undefined
      // 本机房间那一格(卡 M1):看管那一头出了岔子就缺席,不把整条路由带走。
      const localRoomView = options.localRoom === undefined ? undefined : await options.localRoom.view().catch(() => undefined)
      // 工人那一格手机也看得见:它要知道「电脑那头到底有没有人接」。里头没有路径以外的任何秘密。
      sendJson(res, 200, {
        ...status,
        ...(workerProcess === undefined ? {} : { process: workerProcess }),
        ...(workers === undefined ? {} : { workers }),
        ...(ttsBackend === undefined ? {} : { tts_backend: ttsBackend }),
        ...(localRoomView === undefined ? {} : { local_room: localRoomView }),
      })
      return
    }
    /**
     * **这台 Mac 是谁、在哪、哪间房**(2026-10-21,局域网主路;设计稿第二节)。连接规格「在家」的判据 ② ③ 用它:
     * 手机 / 听筒拿候选地址表并发问这一条,800 毫秒内答了、`mac_id` 等于配对时记下的那台,才算在家。
     *
     * 门是 `trusted`(设备令牌):设备令牌只存在配对过的那台的 devices.json 里,别的 Mac 上的 8791 对它一律 401
     * —— 同一局域网里有好几台 8791 时,401 本身就是「这不是你那台」。**不签票、不问中转、不探房**(1 秒内答得出)。
     * 房间代理的白名单里**没有**它:经云房间转来的一问答得出,也不能当「在家」。
     */
    if (path === '/channel/route' && req.method === 'GET') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机或已配对的设备上问这台电脑在哪' }); return }
      if (channel === undefined) { sendJson(res, 404, { error: '通道层未启用' }); return }
      sendJson(res, 200, await channel.route(channelCaller()))
      return
    }
    /**
     * 工人的启停(2026-09-17)。**只认回环** —— 与 /butler/start|stop 同一条规矩:
     * 它拉起/杀掉的是本机进程,手机不该能按这个开关(手机要的是「房里有没有人」,那在 status 里)。
     */
    if (path === '/channel/worker' && req.method === 'GET') {
      if (!loopback) { sendJson(res, 403, { error: '只能在本机看工人进程' }); return }
      if (channelWorker === undefined) { sendJson(res, 404, { error: '工人常驻未接线' }); return }
      sendJson(res, 200, channelWorker.view())
      return
    }
    if ((path === '/channel/start' || path === '/channel/stop') && req.method === 'POST') {
      if (!loopback) { sendJson(res, 403, { error: '只能在本机启停工人' }); return }
      if (channelWorker === undefined) { sendJson(res, 404, { error: '工人常驻未接线' }); return }
      const result = path === '/channel/start' ? await channelWorker.start() : await channelWorker.stop()
      // 业务失败 HTTP 层照样 200,把 { ok:false, error } 如实回去(同 /butler/start)。
      sendJson(res, 200, { ...result, process: channelWorker.view() })
      return
    }
    if (path === '/channel/persona' && req.method === 'GET') {
      // 只认回环:人设里带着他手上所有事项的摘要,那是本机工人要的东西,不该经手机的手。
      if (!loopback) { sendJson(res, 403, { error: '人设只给本机的工人取' }); return }
      if (channel === undefined) { sendJson(res, 404, { error: '通道层未启用' }); return }
      sendJson(res, 200, await channel.persona())
      return
    }
    /**
     * 工人要的第三方凭据(2026-09-21,通道密钥改由服务器下发)。
     *
     * **只认回环**,和 /channel/persona 同一道门,而且理由更硬:这条回包里有火山的
     * access token(识别是工人直连火山的流式 WebSocket,绕不开)。手机、局域网一律够不到。
     *
     * 工人以前是自己读 `~/.dsh/workbench/channel.json`;现在它**不读文件**,
     * 每轮进房前问这一条。于是:服务器上换一把钥匙 → 工人下一轮就跟上;
     * 而这台机器上再也不需要有那份文件。
     */
    if (path === '/channel/credentials' && req.method === 'GET') {
      if (!loopback) { sendJson(res, 403, { error: '通道凭据只给本机的工人取' }); return }
      if (channel === undefined) { sendJson(res, 404, { error: '通道层未启用' }); return }
      sendJson(res, 200, await channel.credentials())
      return
    }

    /**
     * ——— 座机主动来电(2026-09-21,Ben:「待确认 / 运行失败 / 完成提醒时座机响铃」) ———
     *
     * 六条路,两道门:
     *
     *   `POST /call/out`    手动 / 例程点名要打一通。**trusted**(本机或已配对手机):
     *                       手机上点「回拨」走的就是它,那是他自己的设备、他自己的事。
     *                       2026-09-22 起它也过完成策略与「一件一通」那道去重,拒的时候
     *                       照旧 HTTP 200 + `{ok:false, error}`,手机把那句话原样摆出来。
     *   `GET  /call/log`    台账(含未接来电)。同一道门 —— 手机回到前台要列「未接来电 N」。
     *   `POST /call/missed/clear` 「清空」未接来电(2026-09-22)。同一道门。**只标记不删**。
     *   `GET/POST /call/config` 开关与夜间静默时段。同一道门:**这台座机的设置就该在座机上调**。
     *   `POST /call/claim`  工人来领活(领走即转「振铃中」)。**只认回环** —— 它改的是
     *                       「这一通现在归谁」,房里任何人都能领就等于任何人都能把他的电话吃掉。
     *   `POST /call/ack`    工人回话:接了 / 没接 / 打不出去。同样只认回环。
     *
     * 为什么工人是**来领**而不是被推:8791 与工人之间今天只有工人主动发起的那一条(它跑在回环上,
     * 8791 够不到它,也不该为了推一条消息去认识 LiveKit)。领活这条挂在工人那根既有的 3 秒节拍旁边,
     * 不新开连接、不新开协议。
     */
    if (path === '/call/out' && req.method === 'POST') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机或已配对的手机上让座机响' }); return }
      if (callOut === undefined) { sendJson(res, 404, { error: '主动来电未启用' }); return }
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      const result = await callOut.request({
        reason: body.reason as CallOutReason,
        item_id: typeof body.item_id === 'string' ? body.item_id : '',
        ...(typeof body.title === 'string' && body.title !== '' ? { title: body.title } : {}),
        ...(typeof body.note === 'string' && body.note !== '' ? { note: body.note } : {}),
      })
      // 业务失败 HTTP 层照样 200,把 { ok:false, error } 如实回去(同 /channel/start)。
      sendJson(res, 200, result)
      return
    }
    if (path === '/call/log' && req.method === 'GET') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机或已配对的手机上看来电记录' }); return }
      if (callOut === undefined) { sendJson(res, 404, { error: '主动来电未启用' }); return }
      sendJson(res, 200, callOut.view())
      return
    }
    /**
     * 未接来电「清空」(2026-09-22)。**trusted**,同 `/call/log` —— 按这颗键的就是
     * 看那张列表的那台手机。
     *
     * **只标记不删**:台账一条不少,只给还没收过的未接记上 `dismissed_at`,
     * 之后 `GET /call/log` 的 `missed` 不再数它们(callOut.ts 文件头第 7 条)。
     * 为什么不叫 `/call/ack-all`:`/call/ack` 是**工人**回话「这通怎么收场的」,
     * 只认回环;这一条是**他**说「我看过了」,两件事不该共用一个名字。
     *
     * ⚠ 要在**局域网外**也按得动,`channel-worker/src/rpc.ts` 的白名单得加一行
     * `{ method: 'POST', path: '/call/missed/clear' }` —— 那个文件不归这张卡改,
     * 见 `docs/交接-0922-未接来电清空与折叠.md` 的遗留第 1 条。
     */
    if (path === '/call/missed/clear' && req.method === 'POST') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机或已配对的手机上收未接来电' }); return }
      if (callOut === undefined) { sendJson(res, 404, { error: '主动来电未启用' }); return }
      const cleared = await callOut.dismissMissed()
      if (cleared.ok && cleared.dismissed > 0) noteBehavior({ 事: BEHAVIOR_EVENTS.dismiss, 对象: '未接来电', 结果: `清空 ${cleared.dismissed} 条` })
      sendJson(res, 200, cleared)
      return
    }
    if (path === '/call/config' && (req.method === 'GET' || req.method === 'POST')) {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机或已配对的手机上改座机设置' }); return }
      if (callOut === undefined) { sendJson(res, 404, { error: '主动来电未启用' }); return }
      if (req.method === 'GET') { sendJson(res, 200, callOut.config()); return }
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      sendJson(res, 200, await callOut.setConfig(body))
      return
    }
    if (path === '/call/claim' && req.method === 'POST') {
      if (!loopback) { sendJson(res, 403, { error: '只有本机的工人能领这一通' }); return }
      if (callOut === undefined) { sendJson(res, 404, { error: '主动来电未启用' }); return }
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      /**
       * **按房间领**(2026-10-21,局域网主路 M2):工人带上自己那间房,同一通两间房都领得到(卡 M6 两间房);
       * 回包多一格 `answered_elsewhere`(这间房领过、已在别处接起的那几通,工人收掉自己的铃)。
       * 不带 `room`(今天的工人)照旧,回包一个字不变。
       */
      if (body.room !== undefined) {
        if (!isCallRoom(body.room)) { sendJson(res, 400, { error: '房间名不像样(只认字母、数字、- 与 _)' }); return }
        sendJson(res, 200, await callOut.claimRoom(body.room))
        return
      }
      sendJson(res, 200, { calls: await callOut.claim() })
      return
    }
    /**
     * **先接先得**(2026-10-21,局域网主路 M2)。工人报「我这间房里有人接起了这一通」;第一个报的 `first: true`、出声,
     * 后到的 `first: false` + 先接的那一间,工人挂掉自己这边(房里广播 `ring_end`)。**只认回环**,同 `/call/claim`。
     */
    if (path === '/call/answered' && req.method === 'POST') {
      if (!loopback) { sendJson(res, 403, { error: '只有本机的工人能报接起' }); return }
      if (callOut === undefined) { sendJson(res, 404, { error: '主动来电未启用' }); return }
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      if (typeof body.id !== 'string' || body.id === '') { sendJson(res, 400, { error: '要带上是哪一通(id)' }); return }
      if (!isCallRoom(body.room)) { sendJson(res, 400, { error: '要带上是哪间房(room,只认字母、数字、- 与 _)' }); return }
      const result = await callOut.answered({
        id: body.id,
        room: body.room,
        ...(typeof body.device_id === 'string' && body.device_id !== '' ? { device_id: body.device_id } : {}),
      })
      sendJson(res, result.ok ? 200 : 404, result)
      return
    }
    if (path === '/call/ack' && req.method === 'POST') {
      if (!loopback) { sendJson(res, 403, { error: '只有本机的工人能回这一通' }); return }
      if (callOut === undefined) { sendJson(res, 404, { error: '主动来电未启用' }); return }
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      const result = body.result
      if (result !== 'answered' && result !== 'missed' && result !== 'notified' && result !== 'failed') {
        sendJson(res, 400, { error: `不认识这种收场:${String(result)}` })
        return
      }
      const failKind = (CALL_OUT_FAIL_KINDS as readonly unknown[]).includes(body.fail_kind) ? body.fail_kind as CallOutFailKind : undefined
      const error = typeof body.error === 'string' && body.error !== '' ? body.error : undefined
      /**
       * 「这一通没打成」= 四类自动上报里的 `call_closed`(2026-09-22)。
       *
       * 为什么挑 `failed` 这一档而不是所有收场:`missed`(他没接)、`notified`(只推了条消息)
       * 都是**正常的**收场,报上去只会把信噪比压死。`failed` 是工人自己说"这通我打不出去",
       * 那才是通话链路真出了事。
       *
       * 2026-10-12 起**只报技术失败**(`fail_kind`,工人没报就按原话认):她停了铃、已无需再打不是链路出事。
       */
      if (result === 'failed' && callOutFailKindOf({ state: 'failed', ...(error === undefined ? {} : { error }), ...(failKind === undefined ? {} : { fail_kind: failKind }) }) === 'tech') {
        void diag?.report({
          component: 'worker',
          kind: 'call_closed',
          message: `一通电话没打成:${typeof body.error === 'string' && body.error !== '' ? body.error : '工人没说原因'}`,
        })
      }
      sendJson(res, 200, await callOut.ack({
        id: typeof body.id === 'string' ? body.id : '',
        result,
        ...(error === undefined ? {} : { error }),
        ...(failKind === undefined ? {} : { fail_kind: failKind }),
        // 按房间领的工人带上自己那间房(2026-10-21):一间房没接不落整通「未接」。
        ...(isCallRoom(body.room) ? { room: body.room } : {}),
      }))
      return
    }

    /**
     * ——— 设备间传文件(2026-09-21,docs/交接-0921-设备间传文件与找文件.md) ———
     *
     *   GET  /channel/search-roots  工人问「我能在哪些目录里找文件」。**只认回环**;
     *                               门是 docs/记忆/授权.md 里的 `read_scan_roots`。
     *   POST /channel/devices       工人报一份在线设备表。**只认回环** —— 这张表是电脑端
     *                               `GET /devices/online` 的唯一来源,不能让房里的谁来写。
     *   POST /channel/transfer      工人报一条传输记录。同样只认回环。
     *   GET  /devices/online        看此刻在线的设备(电脑端界面、手机的记录面板都读它)。
     *   GET  /devices/transfers     看最近的传输记录。**记录里没有文件内容**。
     *
     * 为什么读的两条给「已配对的设备」也能看:手机的记录面板要显示同样的东西,而它本来
     * 就在同一个房间里 —— 它看得见房里有谁,这条路由不多给它任何东西。
     */
    if (path === '/channel/search-roots' && req.method === 'GET') {
      if (!loopback) { sendJson(res, 403, { error: '这条只给本机的工人问' }); return }
      if (authorization === undefined) {
        sendJson(res, 200, { allowed: false, roots: [], note: '这台工作台没接授权表,不能在上面找文件。' })
        return
      }
      if (!(await authorization.isAllowed('read_scan_roots'))) {
        // 200 + allowed:false,不是 403 —— 这句话要**原样说给他听**,而不是变成一次失败。
        sendJson(res, 200, { allowed: false, roots: [], note: authorization.denialMessage('read_scan_roots') })
        return
      }
      if (pathsOption === undefined) {
        sendJson(res, 200, { allowed: true, roots: [], note: '这台工作台没接路径配置,说不出扫描根在哪。' })
        return
      }
      const pathsConfig = await pathsOption.config.get()
      const effective = wbPathsEffective(pathsConfig, {
        home: pathsOption.home,
        ...(pathsOption.envButlerCwd === undefined ? {} : { envButlerCwd: pathsOption.envButlerCwd }),
      })
      /**
       * `?q=` 带着他那句话时,顺手把**项目**认出来(2026-09-25,卡 J):「工作台 README」→
       * 只在 desktop-workbench 里找 readme。认项目用的是与引导同一把尺(projectNameScore),
       * 工人那边不用再抄一份中英对照表。认不出就没有 `focus`,工人照旧在所有根里找。
       */
      const query = new URL(req.url ?? '/', 'http://x').searchParams.get('q') ?? ''
      const plan = query.trim() === '' ? undefined : planFileQuery(query, (await fileFetchScope()).projects)
      sendJson(res, 200, {
        allowed: true,
        // 找文件的深度:扫描根配的 depth 是「仓库藏多深」(GitHub 底下一层),文件还在仓库里面几层 ——
        // 以前原样回了 1,于是电话里只找得到仓库根上的文件,docs/ 里的一个都找不到(卡 J 路上撞到的)。
        roots: effective.scan_roots.map(root => ({ path: root.path, depth: Math.max(root.depth ?? 1, FETCH_MAX_DEPTH), label: '扫描根' })),
        ...(plan?.project === undefined ? {} : { focus: { name: plan.project.name, path: plan.project.path, terms: plan.terms } }),
      })
      return
    }
    if (path === '/channel/devices' && req.method === 'POST') {
      if (!loopback) { sendJson(res, 403, { error: '在线设备表只由本机的工人报' }); return }
      if (deviceDirectory === undefined) { sendJson(res, 404, { error: '设备目录未启用' }); return }
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      // 两条工人各在一间房(卡 M6),各报各的:带上路线,表是两份合起来;老工人不带就是一份整表。
      const reported = deviceDirectory.report(
        Array.isArray(body.devices) ? body.devices : [],
        ...(CHANNEL_ROUTES.includes(body.route as ChannelRoute) ? [body.route as string] : []),
      )
      sendJson(res, 200, { devices: reported })
      return
    }
    /**
     * ——— 通话延迟(2026-09-23,Ben 真机:「延迟有点高」) ———
     *
     *   POST /channel/latency  工人报一回合的计时。**只认回环**,和在线设备表同一条门。
     *   GET  /channel/latency  看最近 20 回合。本机与已配对的设备都能读 ——
     *                          体检页在电脑上看,统筹在真机上量前后看的也是它。
     *
     * 每一段多久由**工人**算(channel-worker/src/latency.ts),8791 一段都不算:
     * 它不进房,什么都量不到。没测到的那一段原样是 `null`,这里不补 0。
     */
    if (path === '/channel/latency' && req.method === 'POST') {
      if (!loopback) { sendJson(res, 403, { error: '通话计时只由本机的工人报' }); return }
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      const row = channelLatency.add(body.turn)
      if (row === undefined) { sendJson(res, 400, { error: '这条通话计时看不懂,没记' }); return }
      sendJson(res, 200, { turn: row })
      return
    }
    if (path === '/channel/latency' && req.method === 'GET') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机或已配对的设备上看通话延迟' }); return }
      const turns = channelLatency.recent()
      sendJson(res, 200, { turns, note: latencySummary(turns) })
      return
    }
    if (path === '/channel/transfer' && req.method === 'POST') {
      if (!loopback) { sendJson(res, 403, { error: '传输记录只由本机的工人报' }); return }
      if (deviceDirectory === undefined) { sendJson(res, 404, { error: '设备目录未启用' }); return }
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      const entry = deviceDirectory.addTransfer(body.record)
      if (entry === undefined) { sendJson(res, 400, { error: '这条传输记录看不懂,没记' }); return }
      /**
       * ★ **出门那条路的回执**(2026-10-04):她不在局域网时字节是工人用 `wb.file` 推的,
       * 推成没推成只有工人知道。它报这条流水时带上单号(`TransferEntry.offer`),
       * 8791 就能按单号认出这是哪一件事的回执。**老工人不带那一格**(缺席 = 认不出,照旧只是一条流水)。
       */
      if (entry.offer !== undefined) {
        const settled = fileDelivery.receipt({
          offer: entry.offer,
          ok: entry.ok,
          name: entry.name,
          bytes: entry.bytes,
          ...(entry.error === undefined ? {} : { error: entry.error }),
        })
        if (settled !== undefined) void settleDeliveredItem(settled.item_id, entry.ok ? { name: entry.name, bytes: entry.bytes } : undefined)
      }
      sendJson(res, 200, { record: entry })
      return
    }
    /**
     * ★ **电话里要的文件也进交付回执台账**(2026-10-04 午后统筹定,卡 `claude/three-small-1004`;
     * 出处 `docs/交接-1004-手机要文件一条路走通.md` 第六节「没查」第一条 + 待拍板 ①)。
     *
     * 电话里那条路(工人那件 `wb_send_file`)从前**不经事项、也不经这本台账** ——
     * 它把字节从一台设备直推到另一台,成没成只有工人知道。于是「她在电话里要的文件没到」
     * 在看板上一个影子都没有:她挂了电话,以为发了,什么都没来。
     *
     * 现在:工人**真传之前**先来登记一条(这个口),拿一个单号;传完报流水
     * (`POST /channel/transfer`)时把单号带回来,8791 按单号认出这是哪一件事的回执 ——
     * 与手机打字要文件**同一套**(登记 → 开单 → 回执 → 到了才说「已经到你手机上了」)。
     *
     * 这一条与手机那条有一处不一样,写在 `FileDeliveryNeed.pushed` 上:
     * **没有卡要她点**(字节是直推的),所以「为什么还没到」说的是「正在传」,
     * 不是「点一下就到手」—— 她手机上压根没有那张卡。
     *
     * 只认回环(同 `/channel/transfer`:这个口只由本机的工人调)。
     * 卡**只建不开会话**:这不是交给事务官的一件活,它只是看板上一个"还没到"的牌子。
     */
    if (path === '/files/phone-delivery' && req.method === 'POST') {
      if (!loopback) { sendJson(res, 403, { error: '电话里那条交付只由本机的工人登记' }); return }
      if (tasks === undefined) { sendJson(res, 404, { error: '任务看板未启用' }); return }
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      const toId = typeof body.to_device === 'string' ? body.to_device.trim() : ''
      const toName = typeof body.to_name === 'string' && body.to_name.trim() !== '' ? body.to_name.trim() : toId
      if (name === '' || toId === '') { sendJson(res, 400, { error: '要带 name(文件名)与 to_device(送到哪一台)' }); return }
      const said = typeof body.said === 'string' && body.said.trim() !== '' ? body.said.trim() : `电话里要「${name}」`
      const created = await tasks.create({
        title: `把「${name}」发到${toName}`,
        desc: said,
        direction: 'mine',
        origin: 'user',
        status: 'doing',
      })
      if (!created.ok || created.id === undefined) { sendJson(res, 500, { error: created.reason ?? '建事项失败' }); return }
      /** 单号自己生一个:电话那条没有取件单(字节不经 8791),这一串只是「认出是哪件事」的钥匙。 */
      const offer = `call-${randomUUID()}`
      fileDelivery.expect({ itemId: created.id, request: said, query: name, deviceId: toId, deviceName: toName, pushed: true })
      fileDelivery.offered(created.id, { what: name, offers: [offer] })
      broadcast({ kind: 'snapshot', state: await composeState() })
      sendJson(res, 200, { offer, item: created.id })
      return
    }
    if (path === '/devices/online' && req.method === 'GET') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机或已配对的设备上看在线设备' }); return }
      if (deviceDirectory === undefined) { sendJson(res, 404, { error: '设备目录未启用' }); return }
      /**
       * 种类以**配对记录**为准(2026-09-23)。工人报上来的 kind 来自进房凭证里的属性,
       * 而中转签的那张一度不带 `wb_kind` —— 于是一只走中转进房的树莓派话筒在这张表里
       * 成了「手机」,手机的座机页(useHandsetOnline 只认 handset)就说「座机不在线」。
       * devices.json 是本机的真相,凭证属性只是它的影子:对得上就以它为准。
       * 读不出配对表(没接配对、文件坏了)就用上报里的那个,不把整张表弄空。
       */
      const pairedKinds = pairing === undefined
        ? undefined
        : await tryCall(async () => new Map(
          (await pairing.list()).map(one => [one.id, one.kind ?? 'phone'] as const),
        ))
      sendJson(res, 200, deviceDirectory.view(pairedKinds))
      return
    }
    if (path === '/devices/transfers' && req.method === 'GET') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机或已配对的设备上看传输记录' }); return }
      if (deviceDirectory === undefined) { sendJson(res, 404, { error: '设备目录未启用' }); return }
      sendJson(res, 200, { records: deviceDirectory.transfers() })
      return
    }

    /**
     * ——— 手机从电脑取文件(2026-09-25,卡 J) ———
     *
     *   GET /files/offer/<单号>          手机在家(直连)时**直接下载**。只有开单时那台设备取得到;
     *                                    取之前再核一遍(还在、普通文件、在根底下、没超限、不是密钥)。
     *   GET /channel/file-offer/<单号>   工人替**在外面的那台手机**来核单:只认回环 + 降权头,
     *                                    单子必须是开给头里那台设备的。回的是路径 —— 只给回环上的工人。
     */
    if (req.method === 'GET' && path.startsWith('/files/offer/')) {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机或已配对的手机上取文件' }); return }
      const offerId = decodeURIComponent(path.slice('/files/offer/'.length))
      const offer = device !== undefined ? fileOffers.forDevice(offerId, device.id) : loopback ? fileOffers.get(offerId) : undefined
      if (offer === undefined) {
        sendJson(res, 404, { error: '这张取件单不在了(过期了,或者不是开给这台手机的)。再说一次「把某某发我」就会重新找。' })
        return
      }
      const peer = device?.name ?? '本机'
      const record = (ok: boolean, bytes: number, error?: string): void => {
        deviceDirectory?.addTransfer({ direction: 'out', peer, name: offer.name, bytes, ok, by: 'typed', offer: offer.id, ...(error === undefined ? {} : { error }) })
        /**
         * ★ **回执**(2026-10-04,卡 `claude/phone-file-send-loop`)。流走完了 = 这个文件真到了
         * 她手机上那个 HTTP 客户端手里;断了 / 读不出来就是没到,原因原样记上。
         * 「要一份文件」那一类事项的"办完"认的就是这一下(`fileDelivery.ts`)。
         */
        const settled = fileDelivery.receipt({ offer: offer.id, ok, name: offer.name, bytes, ...(error === undefined ? {} : { error }) })
        if (settled !== undefined) void settleDeliveredItem(settled.item_id, ok ? { name: offer.name, bytes } : undefined)
      }
      const checked = await checkOfferFile(offer.path, [...await fileFetchRootPaths(), ...(offer.roots ?? [])])
      if (!checked.ok) {
        record(false, offer.bytes, checked.error)
        sendJson(res, checked.status, { error: checked.error })
        return
      }
      let sha: string | undefined
      try { sha = await sha256OfFile(offer.path) }
      catch { sha = undefined }
      fileOffers.markPulled(offer.id)
      res.writeHead(200, {
        'content-type': fetchMimeOf(offer.name),
        'content-length': String(checked.bytes),
        'content-disposition': contentDisposition(offer.name),
        'cache-control': 'no-store',
        'x-wb-name': encodeURIComponent(offer.name),
        ...(sha === undefined ? {} : { 'x-wb-sha256': sha }),
        'access-control-expose-headers': 'content-length, content-disposition, x-wb-name, x-wb-sha256',
      })
      const stream = createReadStream(offer.path)
      let settled = false
      stream.on('error', (err: unknown) => {
        // 2026-10-13:读到一半 EPERM 也说得清是哪一件事(checkOfferFile 过了之后仍可能撞上)。
        const why = isAccessDenied(err) ? FILE_ACCESS_DENIED_NOTE : '电脑上读这个文件时出错了'
        if (!settled) { settled = true; record(false, checked.bytes, why) }
        res.destroy()
      })
      res.on('finish', () => {
        if (!settled) { settled = true; record(true, checked.bytes) }
      })
      res.on('close', () => {
        if (!res.writableFinished) {
          stream.destroy()
          if (!settled) { settled = true; record(false, checked.bytes, '传到一半断了(手机那头断开了)') }
        }
      })
      stream.pipe(res)
      return
    }
    /**
     * ——— 事务官替她发文件:**正规的那一下**(2026-10-04,卡 `claude/phone-file-send-loop`) ———
     *
     *   POST /butler/send-file   { item, query? | path? }
     *
     * 10-04 早那一件(`t-63a9291b`):事务官手里**没有**任何一条「把文件推到手机」的路,
     * 于是它去 grep 工作台自己的源码找办法,两轮各十几步、都 `aborted`(她看到的「阻塞了两次」),
     * 第三轮把文件拷进事务官文件夹、回一句「你再打一句『把官网逐字稿发我』」就把事项记成了完成。
     * 这个口就是那条路:**它找文件、开取件单、把「点一下就到手」那张卡推到她手机上**,
     * 事务官只说一句"找什么",不碰路径、不碰协议、不读工作台源码。
     *
     * 三种回包,**一个数都不编**:
     *   - 找到一个 → `{ok:true}`:卡推过去了,等回执(回执没到这件事不算办完);
     *   - 找到几个 → `{ok:false, where:'pick'}`:卡上几个候选都摆着,**让它问她一句**「是 A 还是 B」,
     *     不许自己挑一个(挑错了她拿到的是另一个文件,而她以为是对的);
     *   - 一个都没找到 → `{ok:false, where:'none'}` + 在哪找的、找的什么,让它问她一句。
     *
     * `path` 那一支给「先干活再发」那一类(「把 README 改一下再发我」):它自己生成的文件已经有绝对路径,
     * 照样要过取文件那一整套门(还在、普通文件、在授权目录底下、没超 200MB、不是密钥),**不另开一条松的路**。
     */
    if (req.method === 'POST' && path === '/butler/send-file') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机或已配对的设备上发文件' }); return }
      if (tasks === undefined) { sendJson(res, 404, { error: '任务看板未启用' }); return }
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      const itemId = typeof body.item === 'string' ? body.item.trim() : ''
      if (itemId === '') { sendJson(res, 400, { error: '要带 item:这张卡的 id(第一条消息里就有)' }); return }
      const task = (await tasks.list()).tasks.find(one => one.id === itemId)
      if (task === undefined) { sendJson(res, 404, { error: '没有这张卡' }); return }
      /**
       * 台账里没登记过也照样能用(这张卡是老版本建的、或者从别的入口来的):
       * 这会儿现登记一条 —— **送到哪一台**按同一处判(`fileWantTarget`),说不出就如实回一句。
       */
      let need = fileDelivery.need(itemId)
      if (need === undefined) {
        const to = fileWantTarget(device)
        if (to === undefined) {
          sendJson(res, 409, { ok: false, where: 'none', note: '这会儿认不出要把文件送到哪一台手机上(工人没报过在线设备)。等她的手机连上来再发,或者让她在手机上说一句。' })
          return
        }
        need = fileDelivery.expect({ itemId, request: task.title, deviceId: to.id, deviceName: to.name })
      }
      const askedPath = typeof body.path === 'string' ? body.path.trim() : ''
      const query = typeof body.query === 'string' && body.query.trim() !== '' ? body.query.trim() : (need.query ?? task.title)
      if (askedPath !== '') {
        const checked = await checkOfferFile(askedPath, await fileFetchRootPaths())
        if (!checked.ok) {
          fileDelivery.failed(itemId, checked.error)
          sendJson(res, 200, { ok: false, where: 'none', note: `这个文件发不过去:${checked.error}` })
          return
        }
        const name = basename(askedPath)
        const offer = fileOffers.add({ path: askedPath, name, bytes: checked.bytes, where: '事务官给的', device_id: need.device_id, source: 'typed' })
        const ask: FileAskView = {
          id: randomUUID(),
          request: need.request,
          query,
          device: computerName,
          hits: [{ offer: offer.id, name, where: '事务官给的', bytes: checked.bytes, kind: fetchKindOf(name) }],
          total: 1,
        }
        fileDelivery.offered(itemId, { what: name, offers: [offer.id], ask })
        broadcast({ kind: 'snapshot', state: await composeState() })
        sendJson(res, 200, { ok: true, name, bytes: checked.bytes, note: sendFileNote(name, need.device_name) })
        return
      }
      const ask = await buildFileAsk(
        { request: need.request, query, deviceId: need.device_id, computer: computerName },
        { scope: fileFetchScope, offers: fileOffers },
      )
      if (ask.hits.length === 0) {
        fileDelivery.failed(itemId, ask.note ?? DELIVERY_WHY_NOT_FOUND)
        sendJson(res, 200, { ok: false, where: 'none', note: `${ask.note ?? DELIVERY_WHY_NOT_FOUND}问她一句要的是哪一个文件,别自己猜一个。` })
        return
      }
      const offers = ask.hits.map(hit => hit.offer)
      if (ask.hits.length > 1) {
        fileDelivery.offered(itemId, { offers, ask })
        broadcast({ kind: 'snapshot', state: await composeState() })
        sendJson(res, 200, {
          ok: false,
          where: 'pick',
          hits: ask.hits.map(hit => ({ name: hit.name, where: hit.where, bytes: hit.bytes })),
          note: `有 ${ask.total} 个都对得上:${ask.hits.map(hit => `「${hit.name}」(${hit.where})`).join('、')}。`
            + '这几个都摆在她手机那张卡上了,**问她一句是哪一个**(一次只问这一句),别自己挑一个。',
        })
        return
      }
      const only = ask.hits[0] as NonNullable<typeof ask.hits[0]>
      fileDelivery.offered(itemId, { what: only.name, offers, ask })
      broadcast({ kind: 'snapshot', state: await composeState() })
      sendJson(res, 200, { ok: true, name: only.name, bytes: only.bytes, where: only.where, note: sendFileNote(only.name, need.device_name) })
      return
    }

    /**
     * ——— 她手机上**等着她点**的那几张卡(2026-10-04) ———
     *
     *   GET  /files/pending            这台设备上还没取的那几张卡。手机每隔几秒问一次;
     *                                  出门经房间代理(工人白名单里有它),在家直连,两条路同一份数据。
     *   POST /files/received           **手机自己报的回执**:文件写进盘了、sha256 对上了。
     *                                  三条回执路里最真的那一条(另两条是直连流走完、工人推完)。
     *
     * 为什么要这一条:取件单那张卡原来**只能跟在她那句话的回包里**(`POST /butler/item` 的回执),
     * 于是事务官找到文件之后没有任何办法把卡摆到她面前 —— 它只能叫她「再说一遍」(10-04 早那一幕)。
     */
    if (req.method === 'GET' && path === '/files/pending') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机或已配对的手机上看' }); return }
      if (device === undefined) { sendJson(res, 200, { file_asks: [] }); return }
      sendJson(res, 200, { file_asks: fileDelivery.asksFor(device.id) })
      return
    }
    /**
     * ★ **她看过某一条回答了**(2026-10-04,卡 `claude/answer-comes-to-her`)。
     *
     * 「问一句」的答案摆在球下那一行字幕 / 电脑事务官页同一处;她**点开看过、或者划掉**都走这一下。
     * 两端同一条路、服务端只有这一格 —— 手机看过,电脑那一行下一拍快照就收(反过来也一样)。
     *
     * 认不出那条 id 就回 404 并如实说为什么(过期清掉了 / 账重建过),**不假装成功**(D13)。
     */
    if (req.method === 'POST' && path === '/answers/seen') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机或已配对的手机上标「看过了」' }); return }
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      const id = typeof body.id === 'string' ? body.id.trim() : ''
      if (id === '') { sendJson(res, 400, { error: '要带 id:那一条回答的 id' }); return }
      // 时钟同上:service 那一份(假时钟管得住)。
      const marked = directAnswers.markSeen(id, service.getState().now)
      if (marked !== undefined) noteBehavior({ 事: BEHAVIOR_EVENTS.open, 对象: `事务官的回答 ${id}`, 结果: '看过了', 起: marked.at })
      if (marked === undefined) {
        sendJson(res, 404, { error: '这一条回答不在账上了(留满 24 小时自己掉出去,或者工作台重建过这本账)' })
        return
      }
      sendJson(res, 200, { ok: true, seen_at: marked.seen_at })
      return
    }

    if (req.method === 'POST' && path === '/files/received') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机或已配对的手机上报收到了' }); return }
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      const offerId = typeof body.offer === 'string' ? body.offer.trim() : ''
      if (offerId === '') { sendJson(res, 400, { error: '要带 offer:那张取件单的单号' }); return }
      // 只有开给这台设备的单它报得了(别的设备报不了别人的单)。
      const offer = device === undefined ? fileOffers.get(offerId) : fileOffers.forDevice(offerId, device.id)
      if (offer === undefined) { sendJson(res, 404, { error: '这张取件单不在了' }); return }
      const ok = body.ok !== false
      const bytes = typeof body.bytes === 'number' && Number.isFinite(body.bytes) ? body.bytes : offer.bytes
      const error = typeof body.error === 'string' && body.error !== '' ? body.error : undefined
      const settled = fileDelivery.receipt({ offer: offerId, ok, name: offer.name, bytes, ...(error === undefined ? {} : { error }) })
      if (settled !== undefined) await settleDeliveredItem(settled.item_id, ok ? { name: offer.name, bytes } : undefined)
      sendJson(res, 200, { ok: true, counted: settled !== undefined })
      return
    }

    if (req.method === 'GET' && path.startsWith('/channel/file-offer/')) {
      if (!rawLoopback || device === undefined) {
        sendJson(res, 403, { error: '这条只给本机的工人替某台手机核单' })
        return
      }
      const offerId = decodeURIComponent(path.slice('/channel/file-offer/'.length))
      const offer = fileOffers.forDevice(offerId, device.id)
      if (offer === undefined) {
        sendJson(res, 404, { error: '这张取件单不在了(过期了,或者不是开给这台手机的)。再说一次「把某某发我」就会重新找。' })
        return
      }
      const checked = await checkOfferFile(offer.path, [...await fileFetchRootPaths(), ...(offer.roots ?? [])])
      if (!checked.ok) { sendJson(res, checked.status, { error: checked.error }); return }
      fileOffers.markPulled(offer.id)
      sendJson(res, 200, { path: offer.path, name: offer.name, bytes: checked.bytes, where: offer.where })
      return
    }

    /**
     * 暂停(spec §5 诚实边界)：只翻转 paused，只影响 tick() 的响铃广播与 /state.paused。
     * 没有任何通道能借此挂起/杀掉/唤醒 Agent 进程——工作台够不到那一层，暂停期间
     * 各 agent 该干嘛还干嘛，只是工作台不再为它们敲铃、不再自动推送。
     */
    /**
     * 任务看板(设计稿 §3.5 + 2026-08-25 的四层收敛)。三个前缀,对应三层实体:
     * /task/*(功能点)、/sprint/*(冲刺)、/module/*(模块),外加 /board/project(项目排期元数据)。
     *
     * **每一层都只有 create / update / delete 三个手动动作,没有第四个**。没有 archive、
     * 没有 cleanup、没有"扫一遍找出很久没动的"——不可改清单第 5 条的延伸约束(事务层
     * 不得建议删除待办)在这里是靠**路由不存在**保证的,不靠提示词。删冲刺/删模块也
     * 不级联删卡(见 server/tasks.ts),失去归属的卡退回「未归模块」继续在看板上待着。
     */
    /**
     * 进度靠证据(2026-09-25,卡 N;`server/progress.ts`):
     *
     * ```
     * GET  /progress                          → { state, cards: { <事项 id>: 现在到哪 · 依据 · 什么时候看的 } }
     * POST /progress/check { task_id? }       → 核一轮(不带 task_id = 看板上该核的全部;带了就当场重判那一张)
     * POST /progress/ask   { text }           → 「XX 到哪了」:认出是哪一张,当场核,回一句能念的
     * POST /progress/said  { task_id, text }  → 他说一句(记成口述证据,当场再核那一张;「不做了」改取消)
     * POST /item/drive     { task_id }        → 他在卡上点「派给 X」/「交给事务官」:按证据核过直接派
     * ```
     * 读的对本机与配对手机放行;写的同看板那几条(程序来源过授权表 `write_api`)。没接就 404。
     */
    if ((path === '/progress' || path.startsWith('/progress/') || path === '/item/drive')) {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机或已配对的手机上看' }); return }
      if (progressService === undefined && path !== '/item/drive') { sendJson(res, 404, { error: '进度核对没接上' }); return }
      if (path === '/progress' && req.method === 'GET') {
        const cards = Object.fromEntries(progressService?.cardViews() ?? [])
        sendJson(res, 200, { state: progressService?.runState(), cards })
        return
      }
      if (req.method !== 'POST') { sendJson(res, 405, { error: '只收 POST' }); return }
      const denied = await agentWriteDenied(req, device)
      if (denied !== undefined) { sendJson(res, 403, { error: denied }); return }
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      const taskId = typeof body.task_id === 'string' && body.task_id !== '' ? body.task_id : undefined
      if (path === '/progress/check') {
        const result = await (progressService as ProgressService).evaluate(taskId === undefined ? { trigger: 'manual' } : { trigger: 'ask', taskIds: [taskId], force: true })
        broadcast({ kind: 'snapshot', state: await composeState() })
        sendJson(res, 200, { ok: true, ...result })
        return
      }
      if (path === '/progress/ask') {
        const text = typeof body.text === 'string' ? body.text.trim() : ''
        if (text === '') { sendJson(res, 400, { error: '要带 text:他问的那句话' }); return }
        if (behaviorEnd === '电脑' || behaviorEnd === '手机') noteBehavior({ 事: BEHAVIOR_EVENTS.say, 对象: '问进度', 结果: '问到哪了', 原话: text })
        const answer = await (progressService as ProgressService).ask(text)
        broadcast({ kind: 'snapshot', state: await composeState() })
        sendJson(res, 200, answer)
        return
      }
      if (path === '/progress/said') {
        const text = typeof body.text === 'string' ? body.text : ''
        if (taskId === undefined || text.trim() === '') { sendJson(res, 400, { error: '要带 task_id 与 text' }); return }
        if (behaviorEnd === '电脑' || behaviorEnd === '手机') noteBehavior({ 事: BEHAVIOR_EVENTS.say, 对象: taskId, 结果: '说进度', 原话: text })
        const said = await (progressService as ProgressService).said(taskId, text)
        broadcast({ kind: 'snapshot', state: await composeState() })
        // 没办成时那一句也放进 `error`(手机的客户端只从 error 里取原因)。
        sendJson(res, said.ok ? 200 : 404, said.ok ? said : { ...said, error: said.note })
        return
      }
      if (path === '/item/drive') {
        if (itemDriver === undefined) { sendJson(res, 404, { error: '负责人驱动没接上' }); return }
        if (taskId === undefined) { sendJson(res, 400, { error: '要带 task_id' }); return }
        const driven = await itemDriver.driveNow(taskId)
        if (driven.ok) noteBehavior({ 事: BEHAVIOR_EVENTS.dispatch, 对象: taskId, 结果: `让事务官按默认推:${driven.note}` })
        broadcast({ kind: 'snapshot', state: await composeState() })
        sendJson(res, driven.ok ? 200 : 409, driven.ok ? driven : { ...driven, error: driven.note })
        return
      }
      sendJson(res, 404, { error: `不认识的进度操作:${path}` })
      return
    }

    if ((path.startsWith('/task/') || path.startsWith('/sprint/') || path.startsWith('/module/')
      || path === '/board/project') && req.method === 'POST') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机操作看板' }); return }
      if (tasks === undefined) { sendJson(res, 404, { error: '任务看板未启用' }); return }
      const denied = await agentWriteDenied(req, device)
      if (denied !== undefined) { sendJson(res, 403, { error: denied }); return }

      const text = await readBody(req)
      let body: unknown
      try {
        body = JSON.parse(text)
      } catch {
        sendJson(res, 400, { error: 'body 不是合法 JSON' })
        return
      }
      const raw = (body ?? {}) as Record<string, unknown>

      /** 改完就广播一次快照 + 回 200,三层十来个分支共用,免得每处重抄四行。 */
      const done = async (ok: boolean, extra: Record<string, unknown> = {}, missing = '没有这一条'): Promise<void> => {
        if (!ok) { sendJson(res, 404, { error: missing }); return }
        // 看板变了(改了负责人、挪回待办……):负责人驱动补一拍(2026-09-25,卡 N)。
        itemDriver?.kick()
        broadcast({ kind: 'snapshot', state: await composeState() })
        sendJson(res, 200, { ok: true, ...extra })
      }

      // —— 项目排期元数据(优先级/执行人;预期结束时间用项目自己的 DDL,不存第二份) ——
      if (path === '/board/project') {
        if (typeof raw.project_id !== 'string' || raw.project_id === '') {
          sendJson(res, 400, { error: 'project_id 必须是非空字符串' })
          return
        }
        const priority = parseNullable(raw.priority, isTaskPriority)
        if (priority === INVALID) { sendJson(res, 400, { error: `priority 必须是 ${TASK_PRIORITIES.join(' / ')} 之一` }); return }
        const assignee = parseNullable(raw.assignee, isAgentId)
        if (assignee === INVALID) { sendJson(res, 400, { error: `assignee 必须是 ${AGENT_IDS.join(' / ')} 之一` }); return }
        await done(await tasks.setProjectMeta(raw.project_id, {
          ...(priority === undefined ? {} : { priority }),
          ...(assignee === undefined ? {} : { assignee }),
          // 协作区(2026-10-21):项目挂的仓库与资源,整组替换;坏条由 tasks.ts 逐条挑掉。
          ...(Array.isArray(raw.repos) ? { repos: raw.repos as never[] } : {}),
          ...(Array.isArray(raw.resources) ? { resources: raw.resources as never[] } : {}),
        }), {}, '没有这个项目')
        return
      }

      const layer = path.startsWith('/task/') ? 'task' : path.startsWith('/sprint/') ? 'sprint' : 'module'
      const action = path.slice(path.indexOf('/', 1) + 1)

      if (action !== 'create' && (typeof raw.id !== 'string' || raw.id === '')) {
        sendJson(res, 400, { error: 'id 必须是非空字符串' })
        return
      }
      const id = raw.id as string

      // —— 冲刺 ——
      if (layer === 'sprint') {
        if (action === 'create') {
          if (typeof raw.project_id !== 'string' || raw.project_id === '') {
            sendJson(res, 400, { error: 'project_id 必须是非空字符串' })
            return
          }
          if (typeof raw.name !== 'string') { sendJson(res, 400, { error: 'name 必须是字符串' }); return }
          const created = await tasks.createSprint({
            projectId: raw.project_id,
            name: raw.name,
            ...(typeof raw.goal === 'string' ? { goal: raw.goal } : {}),
            ...(raw.versions === undefined ? {} : { versions: parseVersions(raw.versions) }),
            ...(typeof raw.starts_at === 'string' ? { startsAt: raw.starts_at } : {}),
            ...(typeof raw.ends_at === 'string' ? { endsAt: raw.ends_at } : {}),
          })
          if (!created.ok) { sendJson(res, 400, { error: created.reason ?? '建冲刺失败' }); return }
          await done(true, { id: created.id })
          return
        }
        if (action === 'update') {
          if (raw.name !== undefined && typeof raw.name !== 'string') { sendJson(res, 400, { error: 'name 必须是字符串' }); return }
          await done(await tasks.updateSprint(id, {
            ...(raw.name === undefined ? {} : { name: raw.name as string }),
            ...(raw.goal === undefined ? {} : { goal: raw.goal === null ? null : String(raw.goal) }),
            ...(raw.versions === undefined ? {} : { versions: parseVersions(raw.versions) }),
            ...(raw.starts_at === undefined ? {} : { startsAt: raw.starts_at === null ? null : String(raw.starts_at) }),
            ...(raw.ends_at === undefined ? {} : { endsAt: raw.ends_at === null ? null : String(raw.ends_at) }),
          }), {}, '没有这个冲刺,或名字为空')
          return
        }
        if (action === 'delete') { await done(await tasks.removeSprint(id), {}, '没有这个冲刺'); return }
        sendJson(res, 404, { error: `不认识的看板操作:${action}` })
        return
      }

      // —— 模块 ——
      if (layer === 'module') {
        if (action === 'create') {
          if (typeof raw.sprint_id !== 'string' || raw.sprint_id === '') {
            sendJson(res, 400, { error: 'sprint_id 必须是非空字符串' })
            return
          }
          if (typeof raw.name !== 'string') { sendJson(res, 400, { error: 'name 必须是字符串' }); return }
          const created = await tasks.createModule({
            sprintId: raw.sprint_id,
            name: raw.name,
            ...(typeof raw.goal === 'string' ? { goal: raw.goal } : {}),
            ...(typeof raw.version_label === 'string' ? { versionLabel: raw.version_label } : {}),
          })
          if (!created.ok) { sendJson(res, 400, { error: created.reason ?? '建模块失败' }); return }
          await done(true, { id: created.id })
          return
        }
        if (action === 'update') {
          if (raw.name !== undefined && typeof raw.name !== 'string') { sendJson(res, 400, { error: 'name 必须是字符串' }); return }
          await done(await tasks.updateModule(id, {
            ...(raw.name === undefined ? {} : { name: raw.name as string }),
            ...(raw.goal === undefined ? {} : { goal: raw.goal === null ? null : String(raw.goal) }),
            ...(raw.version_label === undefined
              ? {}
              : { versionLabel: raw.version_label === null ? null : String(raw.version_label) }),
          }), {}, '没有这个模块,或名字为空')
          return
        }
        if (action === 'delete') { await done(await tasks.removeModule(id), {}, '没有这个模块'); return }
        sendJson(res, 404, { error: `不认识的看板操作:${action}` })
        return
      }

      // —— 功能点 ——
      const roleRequested = raw.execution_role !== undefined || Array.isArray(raw.links) && raw.links.some(link =>
        typeof link === 'object' && link !== null && 'execution_role' in link)
      const shellUa = req.headers['user-agent']
      const verifiedPage = asker === 'page' && loopback && (personalRequests.has(req) || allowOrigin !== undefined
        || typeof shellUa === 'string' && shellUa.includes('BenWorkbenchShell/'))
      const roleOrigin: ExecutionRoleFact['origin'] | undefined = moduleCaller ? undefined
        : verifiedPage || asker === 'device' ? 'user' : asker === 'butler' ? 'delegation' : undefined
      if (roleRequested && roleOrigin === undefined) { sendJson(res, 403, { error: '这条来源不能认定事项的执行角色' }); return }
      if (raw.execution_role !== undefined && !isExecutionRole(raw.execution_role)
        || Array.isArray(raw.links) && raw.links.some(link => typeof link === 'object' && link !== null
          && 'execution_role' in link && !isExecutionRole((link as Record<string, unknown>).execution_role))) {
        sendJson(res, 400, { error: 'execution_role 必须是 business / coordination / unclassified' }); return
      }
      const requestedRole = isExecutionRole(raw.execution_role) && roleOrigin !== undefined
        ? { kind: raw.execution_role, origin: roleOrigin } : undefined
      const priority = parseNullable(raw.priority, isTaskPriority)
      if (priority === INVALID) { sendJson(res, 400, { error: `priority 必须是 ${TASK_PRIORITIES.join(' / ')} 之一` }); return }
      /*
       * 负责人(2026-09-25,卡 N):几家 AI、事务官,再加人那三档(me / colleague / other)。
       * ★ 卡 Z:几家 AI **从 Agent 登记表列**(那一句报错里写的就是这台电脑上认得的那几家),不再写死家名。
       */
      const assignee = parseNullable(raw.assignee, isTaskAssigneeValue)
      if (assignee === INVALID) {
        const who = [...dispatchTargetsNow().map(one => one.id), ...AGENT_IDS, ...PERSON_ASSIGNEES]
        sendJson(res, 400, { error: `assignee 必须是 ${[...new Set(who)].join(' / ')} 之一` })
        return
      }
      /*
       * 管理(2026-10-27,协作区 §3.1):谁派活、谁验收,判据同负责人。只在 /task/update 落盘 —— /task/create 是他自己建,
       * 不写管理;统筹手派时只能填真实的合法值,不许冒充事务官(没有合法值就留空)。
       */
      const manager = parseNullable(raw.manager, isTaskAssigneeValue)
      if (manager === INVALID) { sendJson(res, 400, { error: 'manager 的判据与 assignee 相同:必须是认得的负责人之一' }); return }
      const assigneeNote = raw.assignee_note === null ? null : typeof raw.assignee_note === 'string' ? raw.assignee_note : undefined
      const blockReason = parseNullable(raw.block_reason, isWaitReason)
      if (blockReason === INVALID) { sendJson(res, 400, { error: `block_reason 必须是 ${WAIT_REASONS.join(' / ')} 之一` }); return }
      // —— 选题那三样(2026-09-21)。三个都按枚举把关:写错回 400 + 原话,不悄悄归成缺省 ——
      //    2026-10-26(卡「事务官页接管队列」):`owner-ask` 动作里的 kind 是四类拍板请求的类别
      //    (花钱 / 发布 / 配对 / 取舍),不是选题种类,不走这道门(它自己那道在下面)。
      const kind = action === 'owner-ask' ? null : parseNullable(raw.kind, isTaskKind)
      if (kind === INVALID) { sendJson(res, 400, { error: `kind 必须是 ${TASK_KINDS.join(' / ')} 之一` }); return }
      const contentType = parseNullable(raw.content_type, isTopicContentType)
      if (contentType === INVALID) { sendJson(res, 400, { error: `content_type 必须是 ${TOPIC_CONTENT_TYPES.join(' / ')} 之一` }); return }
      const stage = parseNullable(raw.stage, isTopicStage)
      if (stage === INVALID) { sendJson(res, 400, { error: `stage 必须是 ${TOPIC_STAGES.join(' / ')} 之一` }); return }
      // —— 需求卡那一态(2026-09-22)。同上:写错回 400 + 原话,不悄悄归成缺省 ——
      const featureStage = parseNullable(raw.feature_stage, isFeatureStage)
      if (featureStage === INVALID) { sendJson(res, 400, { error: `feature_stage 必须是 ${FEATURE_STAGES.join(' / ')} 之一` }); return }
      // —— 发布计划那两个日期(2026-09-22 两状态)。**形状写错回 400 + 原话**,不悄悄丢掉:
      //    这两个日期唯一的用处是把卡摆进月历的某一格,收下一个摆不进去的日期等于让它人间蒸发 ——
      const plannedAt = parseNullable(raw.planned_at, isPublishDay)
      if (plannedAt === INVALID) { sendJson(res, 400, { error: 'planned_at 必须是 YYYY-MM-DD 那样的一天' }); return }
      const publishedAt = parseNullable(raw.published_at, isPublishDay)
      if (publishedAt === INVALID) { sendJson(res, 400, { error: 'published_at 必须是 YYYY-MM-DD 那样的一天' }); return }

      /**
       * 协作区那几格(2026-10-21)。建与改共用这一份解析;回执、留言各有自己的动作(见下面 receipt / comment)。
       * 数组整组替换;认不出的条目由 tasks.ts 挑掉,不拒整张(同 deliverables 的取舍)。
       */
      const strList = (value: unknown): string[] | undefined => (Array.isArray(value) ? value.filter((one): one is string => typeof one === 'string') : undefined)
      const noteFrom = typeof raw.from === 'object' && raw.from !== null ? raw.from as NoteFrom : undefined
      const noteFields: Pick<UpdateTaskInput, 'goalId' | 'from' | 'acceptance' | 'labels' | 'children' | 'watchers' | 'props' | 'module' | 'version' | 'start' | 'end' | 'workType' | 'collaborators' | 'squadId' | 'pullRequests'> = {}
      if (raw.goal_id !== undefined) noteFields.goalId = raw.goal_id === null ? null : String(raw.goal_id)
      if (raw.from === null) noteFields.from = null
      else if (noteFrom !== undefined) noteFields.from = noteFrom
      const acceptanceIn = strList(raw.acceptance)
      if (acceptanceIn !== undefined) noteFields.acceptance = acceptanceIn
      const labelsIn = strList(raw.labels)
      if (labelsIn !== undefined) noteFields.labels = labelsIn
      const childrenIn = strList(raw.children)
      if (childrenIn !== undefined) noteFields.children = childrenIn
      const watchersIn = strList(raw.watchers)
      if (watchersIn !== undefined) noteFields.watchers = watchersIn
      if (raw.props !== undefined) noteFields.props = raw.props === null ? null : raw.props as Record<string, string>
      if (raw.module !== undefined) noteFields.module = raw.module === null ? null : String(raw.module)
      if (raw.version !== undefined) noteFields.version = raw.version === null ? null : String(raw.version)
      // 时间 / 类型 / 协作 / 小队 / PR(2026-10-21 协作区全量)。**改时间只走 start / end 这两格**,拖动不碰它们。
      if (raw.start !== undefined) noteFields.start = raw.start === null ? null : String(raw.start)
      if (raw.end !== undefined) noteFields.end = raw.end === null ? null : String(raw.end)
      if (raw.work_type !== undefined) noteFields.workType = raw.work_type === null ? null : raw.work_type as never
      const collaboratorsIn = strList(raw.collaborators)
      if (collaboratorsIn !== undefined) noteFields.collaborators = collaboratorsIn
      if (raw.squad_id !== undefined) noteFields.squadId = raw.squad_id === null ? null : String(raw.squad_id)
      const pullsIn = strList(raw.pull_requests)
      if (pullsIn !== undefined) noteFields.pullRequests = pullsIn

      if (action === 'create') {
        if (typeof raw.title !== 'string') { sendJson(res, 400, { error: 'title 必须是字符串' }); return }
        if (raw.status !== undefined && !(TASK_STATUSES as readonly string[]).includes(raw.status as string)) {
          sendJson(res, 400, { error: `status 必须是 ${TASK_STATUSES.join(' / ')} 之一` })
          return
        }
        /**
         * ★ **贴便签的门**(2026-10-21,`noteGate.ts`;待拍板 4)。**用新形状建的**(带了 goal_id / from / acceptance
         * 任一格,或明说 `note:true`)四样缺一不贴 —— 事务官按技能建便签、命令行 `workbench note create` 走这一支。
         * 老形状(只有标题、描述……)照旧收:老客户端、老技能段不因为这一版断掉,板上那张会标出缺哪几样。
         */
        const noteShaped = raw.note === true || raw.goal_id !== undefined || raw.from !== undefined || raw.acceptance !== undefined
        let gatedGoal: string | undefined
        if (noteShaped) {
          const gate = noteGate({
            ...(typeof raw.goal_id === 'string' ? { goal_id: raw.goal_id } : {}),
            ...(noteFrom === undefined ? {} : { from: noteFrom }),
            ...(strList(raw.acceptance) === undefined ? {} : { acceptance: strList(raw.acceptance) }),
            ...(assignee === undefined || assignee === null ? {} : { assignee }),
          })
          if (!gate.ok) { sendJson(res, 400, { error: gate.error, missing: gate.missing }); return }
          gatedGoal = gate.goal_id
        }
        // source 是留痕字段,写坏了不该拒绝整张卡——认不出的 kind 由 tasks.ts 归成 manual。
        const source = typeof raw.source === 'object' && raw.source !== null
          ? raw.source as Record<string, unknown>
          : undefined
        const created = await withActorNoteFor(req, 'task.create', () => tasks.create({
          title: raw.title as string,
          ...(typeof raw.desc === 'string' ? { desc: raw.desc } : {}),
          /*
           * ★ **便签缺省「待排」**(2026-10-23,卡「待排的卡不许被派出去」③,统筹定):这条路上
           * 不传 status 的卡落 `backlog` —— 10-22 那 24 张排期卡就毁在「缺省待办 + 负责人驱动」
           * 那一档上,30 秒内被一张张派了出去。只有显式传 `todo`(界面各入口都显式传)、或她
           * 把卡拖进「待办」、或点「开工 / 派给 X」才进待办;驱动照旧只管待办。
           * 交办那条路(`/butler/item`)是**另一种建卡**,它自己显式落「待办」,不在这条路上。
           */
          ...(raw.status === undefined ? { status: 'backlog' as TaskStatus } : { status: raw.status as TaskStatus }),
          ...(typeof raw.project_id === 'string' ? { projectId: raw.project_id } : {}),
          ...(typeof raw.module_id === 'string' ? { moduleId: raw.module_id } : {}),
          // 建卡时 null 与不传是同一件事(没有"清掉一个还没写上去的字段"这回事)。
          ...(kind === undefined || kind === null ? {} : { kind }),
          ...(contentType === undefined || contentType === null ? {} : { contentType }),
          ...(stage === undefined || stage === null ? {} : { stage }),
          ...(featureStage === undefined || featureStage === null ? {} : { featureStage }),
          ...(priority === undefined || priority === null ? {} : { priority }),
          ...(assignee === undefined || assignee === null ? {} : { assignee }),
          ...(typeof assigneeNote === 'string' ? { assigneeNote } : {}),
          ...(typeof raw.due === 'string' ? { due: raw.due } : {}),
          ...(plannedAt === undefined || plannedAt === null ? {} : { plannedAt }),
          ...(publishedAt === undefined || publishedAt === null ? {} : { publishedAt }),
          ...(raw.links === undefined ? {} : { links: parseLinks(raw.links, roleOrigin) }),
          ...(requestedRole === undefined ? {} : { executionRole: requestedRole }),
          // 交付物是留痕字段,坏条由 tasks.ts 逐条挑掉,不拒绝整张卡;不是数组就当没传。
          ...(Array.isArray(raw.deliverables) ? { deliverables: sanitizeDeliverables(raw.deliverables) } : {}),
          // 协作区那几格(过了门的话目标已经补成「未归目标」那一块)。
          ...(noteFields.from === undefined || noteFields.from === null ? {} : { from: noteFields.from }),
          ...(noteFields.acceptance === undefined ? {} : { acceptance: noteFields.acceptance }),
          ...(noteFields.labels === undefined ? {} : { labels: noteFields.labels }),
          ...(noteFields.children === undefined ? {} : { children: noteFields.children }),
          ...(noteFields.watchers === undefined ? {} : { watchers: noteFields.watchers }),
          ...(noteFields.props === undefined || noteFields.props === null ? {} : { props: noteFields.props }),
          ...(noteFields.module === undefined || noteFields.module === null ? {} : { module: noteFields.module }),
          ...(noteFields.version === undefined || noteFields.version === null ? {} : { version: noteFields.version }),
          ...(typeof noteFields.start === 'string' ? { start: noteFields.start } : {}),
          ...(typeof noteFields.end === 'string' ? { end: noteFields.end } : {}),
          ...(noteFields.workType === undefined || noteFields.workType === null ? {} : { workType: noteFields.workType }),
          ...(noteFields.collaborators === undefined ? {} : { collaborators: noteFields.collaborators }),
          ...(typeof noteFields.squadId === 'string' ? { squadId: noteFields.squadId } : {}),
          ...(noteFields.pullRequests === undefined ? {} : { pullRequests: noteFields.pullRequests }),
          ...(gatedGoal !== undefined ? { goalId: gatedGoal } : typeof noteFields.goalId === 'string' ? { goalId: noteFields.goalId } : {}),
          ...(source === undefined
            ? {}
            : {
                source: {
                  kind: source.kind === 'note' || source.kind === 'session' || source.kind === 'file'
                    ? source.kind
                    : 'manual',
                  ...(typeof source.ref === 'string' && source.ref !== '' ? { ref: source.ref } : {}),
                },
              }),
        }))
        if (!created.ok) { sendJson(res, 400, { error: created.reason ?? '建卡失败' }); return }
        // 建一条选题 = 顺手把 `选题/<名>/` 与它底下的 `素材/` 建出来,`feat/ops-skills` 的
        // 产物有地方落、「素材」按钮点下去有东西可开。**只在他亲手建选题的这一刻建**,
        // 没有任何定时器会去补齐别的目录(不可改清单第 5 条的同一条道理)。
        // 建不出来(没配工作目录、权限)**不让整张卡失败**:卡已经在看板上了,
        // 目录是它的附属品;失败的原因如实带在回执的 `dir_note` 里,不静默吞掉(D13)。
        if (kind === 'topic' && typeof raw.title === 'string') {
          const topicsDir = template?.view().asset_dirs?.[TOPIC_DIR]
          const made = topicsDir === undefined
            ? { ok: false as const, reason: '还没配工作目录,这条选题暂时没有自己的目录' }
            : await ensureTopicDir(topicsDir, raw.title)
          await done(true, made.ok ? { id: created.id, dir: made.dir } : { id: created.id, dir_note: made.reason })
          return
        }
        await done(true, { id: created.id })
        return
      }

      /**
       * ★ **她看过这件事的结果了**(2026-10-04,卡 `claude/answer-comes-to-her`)。
       *
       * 维护者 10-04:「信息直接从正在办切到办完了,我是自己追过去点开查看的」。办完的事
       * 先在首页挂一张「刚办完 · 结果一句话」(`/state.fresh_results`),她**点开看过、或者划掉**
       * 都走这一下 —— 两样是同一件事实(「她看过了」),所以只有一条路、只记一格。
       *
       * **不是改状态**(状态还是 `done`,2026-09-09 那张七态表一个字没动):这一格说的是
       * 「她这一端看过了没有」,不是「这件事到哪一步了」。所以它在 `/task/seen-result`,
       * 不在 `/task/move` 上多一档。
       *
       * **两端同步**靠的就是「服务端只有这一格」:手机点了,电脑那张卡下一拍快照就收。
       */
      if (action === 'seen-result') {
        // 时钟取 service 那一份(`getState().now`,同「排期风险」那一处的理由):测试注入的假时钟才管得住这条。
        const seen = await tasks.update(id, { seenResultAt: service.getState().now })
        if (seen) noteBehavior({ 事: BEHAVIOR_EVENTS.open, 对象: `办完的结果 ${id}`, 结果: '看过了' })
        await done(seen, {}, '没有这张卡')
        return
      }

      /**
       * 改状态。**改状态只有这一条路由**(2026-09-09 七态状态机):不再加第二条,
       * 两条都能改状态就有两份真相,下一个人改转换表时一定漏掉一条。
       *
       * 三种回答分得清清楚楚:枚举写错 400、卡不存在 404、**这一步不许走 409 + 原因**
       * (D13:拒绝要如实说出为什么,不静默丢掉也不假装成功)。
       */
      if (action === 'move') {
        if (!(TASK_STATUSES as readonly string[]).includes(raw.status as string)) {
          sendJson(res, 400, { error: `status 必须是 ${TASK_STATUSES.join(' / ')} 之一` })
          return
        }
        const before = (rules === undefined || raw.status !== 'done') && behaviorEnd === undefined ? undefined : (await tasks.list()).tasks.find(one => one.id === id)
        const moved = await withActorNoteFor(req, 'task.move', () => tasks.move(id, raw.status as TaskStatus), { task_id: id })
        if (!moved.ok && moved.reason !== undefined) { sendJson(res, 409, { error: moved.reason }); return }
        // 通过 / 打回 / 随口问那张被拖回来(行为账;判据在 behaviorLog.ts 的 taskMoveNoteOf)。
        const moveNote = moved.ok && before !== undefined ? taskMoveNoteOf(before, raw.status as string) : undefined
        if (moveNote !== undefined) noteBehavior(moveNote)
        // 他点了这件事(确认收下 / 取消 / 挪一格)= 他刚动过手,之后几分钟不为它打电话(卡 M 补)。
        if (moved.ok) callOut?.touch?.(id)
        // 电话里挪的这一格挂到这一通的记录上(2026-10-22)。
        if (moved.ok) noteCallItem(behaviorEnd, id, 'moved', raw.status as TaskStatus)
        /**
         * ★ **取消要收场**(2026-10-28,任务书「取消要收场执行者」):卡挪进 `canceled` 这一下,
         * 对在跑的派发收场(命令行手 SIGTERM→SIGKILL、窗口手捎话、租约释放、账记 canceled_by_user)。
         * 三处取消入口(中枢 / 手机「取消这件」/ 板上取消键)都走这一条路由,一个口。
         * 回包里那句 `settle_note` 加在取消回话末尾;收场那一下坏了不连累这次挪章(绝不抛)。
         */
        let settleNote: string | undefined
        if (moved.ok && raw.status === 'canceled' && dispatchRunner !== undefined) {
          try { settleNote = (await dispatchRunner.cancel(id)).note } catch { settleNote = undefined }
        }
        /**
         * 他把「等我确认」那件点成完成 = 他**通过**了这件活(2026-09-24 晚,卡 K):记一条反馈,
         * 试用中的规矩靠它验(下一件通过就留下)。只认他自己交代的事项、只认从「等我确认」过来的那一步。
         */
        if (moved.ok && rules !== undefined && before?.direction === 'mine' && before.status === 'confirm') {
          await rules.feedback({
            kind: 'pass', where: id, area: ruleWorkArea([before.title, before.desc ?? ''].join('\n')),
            channel: ruleChannelOf(req, device, undefined, 'review'),
          }).catch(() => undefined)
        }
        await done(moved.ok, settleNote === undefined ? {} : { settle_note: settleNote }, '没有这张卡')
        return
      }

      if (action === 'update') {
        /**
         * ★ **状态不在这条路由上改**(2026-09-25,卡 fix/confirm-cancel)。改状态只有 `/task/move` 一条
         * (见那一条上面的注释:两条都能改状态就有两份真相)。以前这里对 `status` 一声不吭 —— 一个字没改却回 `ok:true`:
         * 统筹 0.2.89 真机拿它「取消」一件等我确认的事,回了 ok、卡却原封不动,事务官那一轮收尾时照常把它挪进
         * 「等我确认」,看上去就是「取消了又被后台挪回来」。现在**整件退回、一个字都不改**,并说清该走哪条。
         */
        if (raw.status !== undefined) {
          sendJson(res, 400, { error: '状态不在这条路由上改:改状态请用 POST /task/move {id, status}(同一张七态转换表)。这次一个字都没改。' })
          return
        }
        if (raw.title !== undefined && typeof raw.title !== 'string') {
          sendJson(res, 400, { error: 'title 必须是字符串' })
          return
        }
        await done(await withActorNoteFor(req, 'task.update', () => tasks.update(id, {
          ...(raw.title === undefined ? {} : { title: raw.title as string }),
          ...(raw.desc === undefined ? {} : { desc: raw.desc === null ? null : String(raw.desc) }),
          ...(raw.project_id === undefined ? {} : { projectId: raw.project_id === null ? null : String(raw.project_id) }),
          ...(raw.module_id === undefined ? {} : { moduleId: raw.module_id === null ? null : String(raw.module_id) }),
          // **kind 不在 update 里**:一条卡是不是选题由建它的时候决定。改这个字段等于
          // 把一条普通事项就地变成选题(或反过来),那不是"改一下",那是换一张卡。
          ...(contentType === undefined ? {} : { contentType }),
          ...(stage === undefined ? {} : { stage }),
          // 需求卡的「推进一步」走这里(四态是线性的,下一态卡上已经算好了)。
          ...(featureStage === undefined ? {} : { featureStage }),
          ...(priority === undefined ? {} : { priority }),
          ...(assignee === undefined ? {} : { assignee }),
          ...(manager === undefined ? {} : { manager }),
          ...(assigneeNote === undefined ? {} : { assigneeNote }),
          ...(raw.due === undefined ? {} : { due: raw.due === null ? null : String(raw.due) }),
          ...(plannedAt === undefined ? {} : { plannedAt }),
          ...(publishedAt === undefined ? {} : { publishedAt }),
          ...(blockReason === undefined ? {} : { blockReason }),
          // links 是**整组替换**(不是增量):交接时客户端把原来那几条 + 新的一条一起给回来。
          ...(raw.links === undefined ? {} : { links: parseLinks(raw.links, roleOrigin) }),
          ...(requestedRole === undefined ? {} : { executionRole: requestedRole }),
          // 交付物同 links:整组替换;不是数组就当没传(不动),不 400——留痕字段不值得拒一整次更新。
          ...(Array.isArray(raw.deliverables) ? { deliverables: sanitizeDeliverables(raw.deliverables) } : {}),
          // 协作区那几格(2026-10-21):拖到别的目标区 = 改 goal_id(**拖不改状态**);回执与留言不在这条路由上写。
          ...noteFields,
          ...(raw.evaluation === undefined ? {} : { evaluation: raw.evaluation === null ? null : { ...(raw.evaluation as Record<string, string>), at: service.getState().now } as never }),
        }), { task_id: id }), {}, '没有这张卡,或标题为空')
        return
      }

      /**
       * ★ **回执**(2026-10-21 协作区,设计稿第五节第 5 条):交回的那一句只许三种 —— 做完 / 有异议 / 卡住。
       * 别家 agent(带个人访问令牌的命令行 `workbench note receipt`)与事务官报这一条:`{id, receipt, text, evidence?, by?}`;
       * 落章照 `receiptStatus`:做完、有异议 → 等你;卡住 → 卡住。**只有他点「做完」才进 done**。
       * 他已经收掉(做完 / 不做)的那张只记回执、不挪章(同派活收尾那条:后台不许把收掉的事重新打开)。
       */
      if (action === 'receipt') {
        // 字段叫 `receipt` 不叫 `kind`:`kind` 在这一组路由上是事项种类(选题 / 需求),上面已经按那张表把过关。
        if (!isReceiptKind(raw.receipt)) { sendJson(res, 400, { error: 'receipt 要是 done / objection / blocked(做完 / 有异议 / 卡住)之一' }); return }
        const kind: NoteReceiptKind = raw.receipt
        const text = typeof raw.text === 'string' ? raw.text.trim() : ''
        if (text === '') { sendJson(res, 400, { error: 'text 不能是空的:做完带产物或证据、有异议带理由、卡住说卡在哪' }); return }
        const before = (await tasks.list()).tasks.find(one => one.id === id)
        if (before === undefined) { sendJson(res, 404, { error: '没有这张卡' }); return }
        const by = typeof raw.by === 'string' && raw.by.trim() !== '' ? raw.by.trim() : undefined
        const sourceSessionId = typeof raw.source_session_id === 'string' && raw.source_session_id.trim() !== '' ? raw.source_session_id.trim() : undefined
        const sourceRound = typeof raw.source_round === 'string' && raw.source_round.trim() !== '' ? raw.source_round.trim() : undefined
        if ((sourceSessionId === undefined) !== (sourceRound === undefined)) { sendJson(res, 400, { error: '来源会话与轮次要一起提供' }); return }
        const sourceLink = sourceSessionId === undefined ? undefined : before.links?.find(link => link.session_id === sourceSessionId)
        const businessReceipt = (sourceLink?.execution_role ?? executionRoleOf(before)).kind === 'business'
        const receipt = { kind, text, ...(typeof raw.message_id === 'string' && raw.message_id !== '' ? { message_id: raw.message_id } : {}), ...(strList(raw.evidence) === undefined ? {} : { evidence: strList(raw.evidence) as string[] }), ...(by === undefined ? {} : { by }),
          ...(sourceSessionId === undefined ? {} : { source_session_id: sourceSessionId }), ...(sourceRound === undefined ? {} : { source_round: sourceRound }), task_round: before.round ?? 1, at: service.getState().now }
        const saved = await tasks.recordReceipt(id, receipt, businessReceipt)
        if (!saved.fresh) { await done(saved.ok); return }
        const links = [...new Set((before.links ?? []).filter(link => (link.execution_role ?? executionRoleOf(before)).kind === 'business').map(link => link.session_id))]
        const currentReceipts = (await tasks.list()).tasks.find(one => one.id === id)?.receipts ?? []
        const allReturned = links.length <= 1 || links.every(sessionId => currentReceipts.some(one =>
          one.source_session_id === sessionId && (one.task_round ?? 1) === (before.round ?? 1)))
        if (businessReceipt && before.status !== 'done' && before.status !== 'canceled') {
          for (const step of statusPathTo(before.status, kind === 'blocked' ? 'blocked' : allReturned ? receiptStatus(kind) : 'doing') ?? []) {
            const moved = await tasks.move(id, step)
            if (!moved.ok) break
          }
          // 回执落进「等你确认」(做完 / 有异议且各家都回了)→ 同样进核验(第 4 步①:事务官自办 / 接口回执与派活三只手同一钩)。
          if ((await tasks.list()).tasks.find(one => one.id === id)?.status === 'confirm') taskDelivery?.onReturned(id)
        }
        // 小鼠标盖一下章(账上记一条「交回来了」,收尾的判据也认它)。
        if (by !== undefined || sourceSessionId !== undefined) jobLog.append({ job: id, step: 'replied', family: by ?? 'unknown', ...(sourceSessionId === undefined ? {} : {
          agent: before.links?.find(link => link.session_id === sourceSessionId)?.agent ?? by ?? 'unknown', session_id: sourceSessionId, source_round: sourceRound as string, task_round: receipt.task_round,
          source_event_id: typeof raw.message_id === 'string' && raw.message_id !== '' ? raw.message_id : `${sourceRound}:receipt`, occurred_at: receipt.at,
        }), why: `回执:${kind}` })
        await jobLog.flush()
        await done(true)
        return
      }

      /**
       * ★ **要本人拍板的结构化请求**(2026-10-26,卡「事务官页接管队列」):事务官核验完一件「等我确认」,
       * 认定属于花钱 / 新对外发布 / 本人账号与设备配对 / 习惯与范围取舍四类之一,把**类别 + 方案 + 依据**
       * 标到卡上;标了之后这件才进用户侧「等你」队列(`waiting.ts` 读 {@link ownerAskOf})。
       * `{id, kind, proposal, basis}`;类别不在四类里 400(未知不得自动放行)、方案或依据为空 400。
       * 覆盖写(同一 id 再标 = 改方案),离开「等我确认」由 `move` 清掉。
       */
      if (action === 'owner-ask') {
        if (!isOwnerAskKind(raw.kind)) { sendJson(res, 400, { error: `kind 要是 ${OWNER_ASK_KINDS.join(' / ')} 之一` }); return }
        const proposal = typeof raw.proposal === 'string' ? raw.proposal.trim() : ''
        if (proposal === '') { sendJson(res, 400, { error: 'proposal 不能是空的:带方案来(怎么做)' }); return }
        const basis = typeof raw.basis === 'string' ? raw.basis.trim() : ''
        if (basis === '') { sendJson(res, 400, { error: 'basis 不能是空的:带依据来(核过的事实、回执、账)' }); return }
        const by = asker === 'page' || asker === 'device' ? 'me' : asker === 'butler' ? 'butler' : 'agent'
        const ok = await tasks.update(id, {
          ownerAsk: { kind: raw.kind, proposal, basis, by, at: service.getState().now },
        })
        await done(ok, {}, '没有这张卡')
        return
      }

      /** 留言(2026-10-21 协作区,便签详情底部那一块)。谁说的按来路认:他本人(页面 / 手机 / 个人令牌)= me,事务官 = butler。 */
      if (action === 'comment') {
        const text = typeof raw.text === 'string' ? raw.text : ''
        const verdict = raw.verdict === 'pass' || raw.verdict === 'rework' || raw.verdict === 'self' ? raw.verdict : undefined
        const by = asker === 'page' || asker === 'device' ? 'me' : asker === 'butler' ? 'butler' : 'agent'
        const said = await tasks.comment(id, { by, text, ...(verdict === undefined ? {} : { verdict }) })
        if (!said.ok && said.reason !== undefined) { sendJson(res, 400, { error: said.reason }); return }
        await done(said.ok, said.id === undefined ? {} : { comment_id: said.id }, '没有这张卡')
        return
      }
      if (action === 'comment/resolve') {
        const commentId = typeof raw.comment_id === 'string' ? raw.comment_id : ''
        if (commentId === '') { sendJson(res, 400, { error: 'comment_id 必须是非空字符串' }); return }
        const by = asker === 'page' || asker === 'device' ? 'me' : asker === 'butler' ? 'butler' : 'agent'
        await done(await tasks.resolveComment(id, commentId, raw.resolved === false ? null : by), {}, '没有这张卡')
        return
      }

      /**
       * 「推进一步」(2026-09-21 选题池)。三种回答与 /task/move 逐字同一套口径:
       * 卡不存在 404、这一步走不了 409 + 原话、成功 200 并回新的那一段。
       *
       * **为什么不复用 /task/update**:那条是"把这个字段改成这个值",调用方说了算;
       * 这条是"往后走一格",下一段是哪一段由服务端的顺序说了算,而且它还要在离开
       * 「发布」时盖发布日。把这件事放进 update 里,等于以后每一次手改 stage 都可能
       * 悄悄往卡上写一个日期(同 /butler/item 不复用 /task/create 的那条理由)。
       */
      if (action === 'advance') {
        const advanced = await withActorNoteFor(req, 'task.advance', () => tasks.advanceTopic(id))
        if (!advanced.ok && advanced.reason !== undefined) { sendJson(res, 409, { error: advanced.reason }); return }
        await done(advanced.ok, advanced.stage === undefined ? {} : { stage: advanced.stage }, '没有这张卡')
        return
      }

      if (action === 'delete') { await done(await tasks.remove(id), {}, '没有这张卡'); return }

      sendJson(res, 404, { error: `不认识的看板操作:${action}` })
      return
    }

    if (path === '/pause' && req.method === 'POST') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机操作' }); return }
      paused = !paused
      broadcast({ kind: 'snapshot', state: await composeState() })
      sendJson(res, 200, { ok: true, paused })
      return
    }

    /**
     * 手动试铃（来电链 v0 的运维口）：正常响铃要等 waiting+permission_prompt 超 3 分钟，
     * 试铃声不该这么折腾。翻转型（与 /pause 同款）：没响就广播 ring，响着就广播
     * call/offhook 停铃。会话键固定 dsh:test-ring，不建会话、不进 /state——
     * 试铃只试铃，屏上不许多出一行假会话。翻转态 testRingResetMs 后自动归零，
     * 对齐展示台 60 秒兜底自停，免得那头早不响了、这头下一按变成空停铃。
     */
    /**
     * 停掉当前正在响的铃(2026-08-25 新增)。
     *
     * 真响铃在此之前压根没有停法：网页只有「🔕停铃」那一个口，而它只认 dsh:test-ring；
     * POP 按键则要求派在起铃那一刻正连着——断线重连就永久错过。于是真机上真响铃只能
     * 干等展示台 60 秒兜底自停(当天实测一次撑满 60 秒)。
     */
    if (path === '/ring/stop' && req.method === 'POST') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机操作' }); return }
      sendJson(res, 200, { ok: true, stopped: stopAllRings() })
      return
    }

    /**
     * ——— 「🔔 试铃」改走**真来电**(2026-09-23,Ben:「能不能自己在桌面端点击试铃」) ———
     *
     * 老的那条只往 `/live` 广播一条 `ring`:展示台会响,而**手机不响、听筒接不了** ——
     * 手机与听筒听的是房间里那条 `ring`(工人从 `/call/out` 的队列里领出来的),
     * 跟这条广播是两条不相干的链。于是桌面上按下去看见展示台在响,
     * 抓起听筒却接不到任何东西 —— 试的不是他要试的那条路。
     *
     * 现在按一下 = **排一通真的**(`callOut.request`,reason `confirm`、title「试铃」):
     * 工人下一拍(2 秒)领走 → 房里广播 ring → 手机响 → 提机接得起来。整条链一次试完。
     *
     * `item_id` 用一个**固定的测试 id**,不借用看板上真的那一件:排一通会把
     * `confirm:<那件>` 记进 `seen`,真等到那件事要响的时候就被「只打一次」吃掉了
     *(callOut.ts 的 `request` 里那段)。试铃不该偷走一通真电话。
     */
    if (path === '/ring/test' && req.method === 'POST') {
      if (!trusted) { sendJson(res, 403, { error: '只能在本机操作' }); return }
      if (testRingTimer !== undefined) { clearTimeout(testRingTimer); testRingTimer = undefined }
      // 有铃在响(不论是试铃还是真响铃)，这个按钮的语义就是「停掉现在响的那个」。
      // 翻转语义对试铃保持不变；真响铃期间按它不再多加一个测试铃——那只会让事情更糟。
      if (stopAllRings().length > 0) {
        sendJson(res, 200, { ok: true, ringing: false })
        return
      }
      if (callOut !== undefined) {
        sendJson(res, 200, await toggleTestCall())
        return
      }
      /**
       * 主动来电没启用时**退回老的展示台广播**(不是报错)。这条路今天还有人听:
       * 展示台认 `kind:'ring'`,派在 8791 上那条老路(popphone 的 `live_reader`)也认 ——
       * 房间没配起来时它是唯一还能让人提机接听的那条(只是没有声音)。
       */
      testRinging = true
      ringActive = startRing(ringActive, { agent: 'dsh', session_id: 'test-ring' }, Date.now())
      broadcast({ kind: 'ring', agent: 'dsh', session_id: 'test-ring' })
      testRingTimer = setTimeout(() => { testRingTimer = undefined; testRinging = false }, testRingResetMs)
      testRingTimer.unref?.()
      sendJson(res, 200, { ok: true, ringing: true })
      return
    }

    /**
     * 各 agent 客户端的 hook 入口（PRD §8.1，M2）。
     *
     * 路径尾巴是来源 id：/hook/claude、/hook/codex。body 是 hook 原样的 stdin JSON。
     * 认不出的事件回 200 但不写状态——绝不能让 agent 那头看到报错。
     */
    if (req.method === 'POST' && path.startsWith('/hook/')) {
      const agent = path.slice('/hook/'.length)
      const text = await readBody(req)
      let body: unknown
      try {
        body = JSON.parse(text)
      } catch {
        sendJson(res, 400, { error: 'body 不是合法 JSON' })
        return
      }

      let event = parseHookEvent(agent, body)
      if (event === undefined) {
        sendJson(res, 200, { ok: true, ignored: true })
        return
      }

      // 读 transcript 补 title/summary（PRD §5.3）。同步文件读、限定头尾各至多 200KB，
      // 不会明显拖慢这次请求——但仍然只对 claude 生效，且拿不到就原样放行，不能因为
      // 这一步失败让上报整个丢掉。
      event = attachTranscriptDetails(agent, body as Record<string, unknown>, event, extractClaudeDetails)

      service.applyEvent(event)
      onAgentHook?.(event)
      broadcast({ kind: 'event', event })
      sendJson(res, 200, { ok: true })
      return
    }

    /**
     * Claude Code 的额度入口（PRD §8.2）。
     *
     * Claude Code ≥2.1 把 rate_limits 随 statusLine 的 stdin 一起交出来，statusLine 脚本
     * 把整份 stdin POST 到这里。这是**推送**：不轮询、不读凭据、不碰未公开接口。
     */
    if (req.method === 'POST' && path === '/statusline') {
      const text = await readBody(req)
      let body: unknown
      try {
        body = JSON.parse(text)
      } catch {
        sendJson(res, 400, { error: 'body 不是合法 JSON' })
        return
      }

      try {
        // 第二个参数 = 收到这一份的时刻(卡 QA 的 `as_of`)。推送是实时的,但这一份会落盘、
        // 重启后顶回界面,那时它可能已经几天前了 —— 不写下时刻,界面就没法说它旧。
        const pushed = parseClaudeStatusLine(body, new Date())
        /**
         * 「读不到最新」时该说什么**跟着上一份走**(2026-10-02,卡 QK)。
         *
         * 那一格说的是「这台机器此刻缺什么」(那把密钥配了没有),由采集层每轮现盖
         * (`quota/collect.ts` 一处;声明在 `quota/liveSources.ts`)。推送这条路**不读凭据**
         * (文件头上那条纪律),所以自己算不出来 —— 带着上一份那个走。
         * 推上来的这一份本来就是刚收到的、不过线,这一格要到两小时后才用得上,
         * 而那之前采集早把它换成自己盖好的了;真走到那一步时少说半句,也绝不说错一句。
         */
        const carried = service.getState().quota.claude
        const hint = carried === undefined || carried.kind === 'unknown' ? undefined : carried.stale_hint
        const quota = hint === undefined ? pushed : { ...pushed, stale_hint: hint }
        service.setQuota('claude', quota)
        // statusLine 触发得不规律（真机实测隔几小时才来一批），而服务是纯内存的。
        // 不落盘的话，一次 DSH 重启就把刚收到的好数据擦掉，界面退回"等上报"。
        onQuotaPushed?.('claude', quota)
        // 同上：这条没有自纠正——Claude 每次上报都会重新触发，改错了就是每次都复现的丢字段。
        broadcast({ kind: 'snapshot', state: await composeState() })
        sendJson(res, 200, { ok: true, line: statusLineText(quota) })
      } catch {
        // 上报到了，但里面没有 rate_limits。这不是错误，但必须跟"根本没上报过"区分开——
        // 两者在界面上都是"未接入"，可原因和该做的事完全不同：
        // 前者是 Claude Code 版本太旧、或中间的代理把额度响应头吃掉了
        //（Ben 的 ANTHROPIC_BASE_URL 指向本机代理），后者是 statusLine 压根没配上。
        // ★这里**绝不能**直接覆盖已经拿到的额度。Claude Code 会为每个会话各调一次
        // statusLine，而只有其中一次带得出 rate_limits——真机日志里每条「带额度」
        // 后面同一秒都紧跟一条「无额度字段」。原来这条无额度的会把刚存下的好数据
        // 覆盖成 unknown，于是额度明明送到了，界面还是常年「未接入」。
        const known = service.getState().quota.claude
        if (known?.kind === 'quota') {
          // 已有已知值就保住它，并照常把状态栏那一行回出去。
          sendJson(res, 200, { ok: true, line: statusLineText(known) })
          return
        }
        service.setQuota('claude', {
          kind: 'unknown',
          note: 'statusLine 已上报但没带 rate_limits（Claude Code 低于 2.1，或中间代理吃掉了额度头）',
        })
        sendJson(res, 200, { ok: true, line: '' })
      }
      return
    }

    sendJson(res, 404, { error: '没有这个路径' })
  }

  // 只有 /live 与 /helper 接受 WS 升级，别的路径直接断开，不留下半开连接。
  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const path = (req.url ?? '/').split('?')[0]
    // 壳通道:能指挥本机真窗口,只认回环,连 hello 的机会都不给远端。
    if (path === '/helper') {
      if (helper === undefined || !isLoopback(req)) {
        socket.destroy()
        return
      }
      wss.handleUpgrade(req, socket, head, (ws) => { helper.attach(ws) })
      return
    }
    // WS 与 HTTP 同一道门：来源不允许就直接断开，连快照的影子都不给看。
    if (path !== '/live' || !isRemoteAllowed(req)) {
      socket.destroy()
      return
    }
    // 非本机的订阅也认令牌(2026-09-11):浏览器 WebSocket 设不了请求头,所以还认 ?token=。
    if (pairing !== undefined && !isLoopback(req)) {
      void deviceOf(req, true).then((device) => {
        if (device === undefined || socket.destroyed) { socket.destroy(); return }
        subscribe(req, socket, head)
      }).catch(() => socket.destroy())
      return
    }
    subscribe(req, socket, head)
  }
  server.on('upgrade', onUpgrade)

  function subscribe(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    wss.handleUpgrade(req, socket, head, (ws) => {
      clients.add(ws)
      // 从 0.0.0.0 那台进来的记一笔:关开关时要把它们一起断掉,不能留着继续收广播。
      if (lanSockets.has(req.socket)) lanClients.add(ws)
      // 合并说明:main 侧的 forget/error/pong 是心跳看门狗记账;v5 侧首帧改走
      // composeState(含项目区/机器采样,否则展示台首帧缺字段)。两边并集。
      ws.on('close', () => forget(ws))
      ws.on('error', () => forget(ws))
      ws.on('pong', () => awaitingPong.delete(ws))
      void (async () => {
        ws.send(JSON.stringify({ kind: 'snapshot', state: await composeState() } satisfies LiveMessage))
      })()
    })
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      // 端口被占是最常见的启动失败，必须说人话，不能只丢一个 EADDRINUSE。
      reject(err.code === 'EADDRINUSE'
        ? new Error(`端口 ${options.port} 已被占用，换一个或先停掉占用的进程`)
        : err)
    })
    server.listen(options.port, host, () => resolve())
  })

  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : options.port

  /**
   * 重启之后把引导会话先热起来(2026-09-24,onboardingWarm.ts 文件头)。只在「这次重启是为引导排的」
   * 那一次做;引导走完了、没接会话通道就什么都不做。fire-and-forget,出错吞掉 —— 页面照样会自己来开。
   */
  if (onboardingWarm !== undefined && onboarding !== undefined) {
    void (async () => {
      if (!(await onboardingWarm.take())) return
      if (onboarding.detail().done) return
      await new Promise(resolve => setTimeout(resolve, onboardingWarm.delayMs))
      const result = await openOnboardingSession()
      // 记下它第一条消息是按阶段机哪个样子写的:页面来领时对不上就不交(2026-09-24)。
      // quiet = 页面抢先开过、这一下只是把那条交回来,一个字没往里说 —— 不算热起来的那条。
      if (result.ok && result.session_id !== undefined && result.quiet !== true) {
        onboardingWarm.noteWarmed(
          result.session_id,
          result.answered === undefined ? undefined : progressMark({ stage: result.stage, answered: result.answered }),
        )
      }
    })().catch(() => { /* 热不起来就等页面来开 */ })
  }

  /**
   * ★ 存量用户补一次(2026-09-22,卡 ① 的第三件事)。
   *
   * 切模板那一下只管**以后**切的人;**已经在运营模板上的人**(Ben 自己、以及这之前装过的机器)
   * 切模板发生在这件功能存在之前,他们的 `~/.dsh/AGENTS.md` 里一段技能都没有。所以起服务时
   * 再走一遍同一条路 —— 它是**幂等**的:内容一模一样时不写、不备份,于是天天重启也不会在
   * `~/.dsh` 里堆出一串 `.bak`(用例钉着这一条)。
   *
   * **fire-and-forget、而且吞掉异常**:读不到仓库、写不进去、盘满 —— 哪一种都不该让整台
   * 工作台起不来。真出事时设置里那行状态与体检页那一项会红着,那才是给人看的地方。
   *
   * `pathsOption?.applyHooks` 没接线时 `ensureOpsSkills()` 回 undefined,**一个字节都不写**
   * —— 既有那一大批 `startWorkbenchServer(...)` 用例因此碰不到真实家目录(同 applyHooks 那条纪律)。
   */
  void ensureOpsSkills()
    .then((ensured) => {
      if (ensured === undefined) return
      if (!ensured.ok) { console.log(`[技能] 起服务时没接上事务官技能:${ensured.error}`); return }
      // 一个字没改的那种情况不出声 —— 每次重启打一行"本来就是对的"是纯噪音。
      if (ensured.changed) console.log(`[技能] ${ensured.note}`)
    })
    .catch(() => {})

  /**
   * 单开的那个来源(2026-09-22,C7)。**要等本服务 listen 完**才起得来:模块页面的 CSP 里
   * 要写死工作台服务那个 origin,而端口可能是 0(用例)或被 env 改过。
   *
   * 起不来(端口被占)**不连累整台服务**:如实让它缺席 —— 于是 `/state.modules[].frame_url`
   * 没有、窗位叠里一格自定义模块都不挂。宁可这一档整块不出,也不能退回同源那条老路。
   */
  if (options.moduleOrigin !== undefined && modules !== undefined && moduleTokens !== undefined) {
    try {
      moduleOriginServer = await startModuleOriginServer({
        port: options.moduleOrigin.port,
        ...(options.moduleOrigin.host === undefined ? {} : { host: options.moduleOrigin.host }),
        modules,
        tokens: moduleTokens,
        apiOrigin: options.moduleOrigin.apiOrigin ?? `http://127.0.0.1:${port}`,
      })
    }
    catch {
      moduleOriginServer = undefined
    }
  }

  // 开关落在 app.json 里:重启后照旧开着(或关着)。起不来(端口被占)就当关着,不让整台服务起不来。
  if (lan !== undefined) {
    try {
      if ((await lan.config.get()).lan_access) await applyLan(true)
    }
    catch {
      lanEnabled = false
    }
  }

  let firstUseObservedAt = 0
  function pumpFirstUse(): void {
    if (options.firstUse === undefined) return
    const nowMs = Date.now()
    if (nowMs - firstUseObservedAt < FIRST_USE_OBSERVE_MS) return
    firstUseObservedAt = nowMs
    void observeFirstUse().then(async (changed) => {
      if (changed) broadcast({ kind: 'snapshot', state: await composeState() })
    }, () => undefined)
  }
  function tick(): void {
    /**
     * 进程自己的内存与事件循环(2026-10-19):同款挂在这根既有节拍上,内部一分钟采一次样、十分钟记一行。
     * 放在最前面:它量的正是这根节拍被延误多少,别的拍子坏了也不该让它缺席。
     */
    try { processHealth?.pump() }
    catch { /* 量自己坏了不能连累节拍 */ }
    // service.tick() 照常跑（内部响铃冷却记账不能因为暂停就乱掉，见 /pause 路由注释），
    // 暂停时只是不把这一拍的响铃结果广播出去——spec §5 诚实边界：暂停管不到 Agent 进程，
    // 能管的只有工作台自己会不会为它敲铃。
    // 哨兵挂在这根既有的节拍上(不新起定时器)。放在 paused 判断之**前**:暂停管的是
    // 工作台会不会为它敲铃,不是"停止观察"——监视项照常记账,只是这一拍的响铃不广播。
    pumpSentinel()
    // 布局快照:同款「挂在这根既有节拍上」,到「下班」时刻之前每一拍只是两次比较。
    pumpLayoutSnapshot()
    // 例程定时(2026-09-15):同款。到点之前每一拍只是几次比较,不组装 state。
    routines?.pump()
    // 定时派活(2026-10-21 协作区全量):同款,内部一分钟才看一次。总开关关着两样都不挂上节拍。
    if (collabEnabled) {
      void collabTimers?.pump().catch(() => {})
      // 原F来源发布:复用既有节拍,仅显式启用项目按分钟检查,不新建定时器。
      void collabRoutes?.pumpSources().catch(() => {})
    }
    // 负责人驱动(2026-09-25,卡 N):同款,内部 30 秒一拍。
    itemDriver?.pump()
    // 修复交回守门(2026-10-23,卡「分层自愈完善」):同款,没有待核的派活就一次 I/O 都不做。
    void pumpFixGuards().catch(() => undefined)
    // 派出去的小组件验收没有(2026-10-01,C2):同款,内部 10 秒一拍;一条都没在等就一次 I/O 都不做。
    void pumpDevToolAccept().catch(() => {})
    // 两步接力(2026-10-12):同款,内部 3 秒一拍;没有在走的接力就一次 I/O 都不做。
    void videoChain?.pump().catch(() => {})
    // 三件主路成没成(2026-10-21,卡「引导三件事」):同款,内部 10 秒一拍;有新记的就广播一次。
    pumpFirstUse()
    /**
     * 运行环境漂没漂(2026-09-26,卡 U6):同款挂在这根既有节拍上,内部一分钟一拍。
     *
     * **为什么也挂在这儿、而不是只挂在 `/state`**:0.3.x 升上来那条路要顺 ——
     * 旧客户端那趟热更新重启完,新进程一起来就该发现"运行环境还没换",
     * 而那会儿他可能一个页面都没开(`/state` 没人问)。一拍里只是读十来个小 package.json。
     */
    try { runtimeRepair?.pump() }
    catch { /* 探漂移自己坏了不能连累这根节拍 */ }
    // 座机主动来电(2026-09-21):同款挂在这根既有节拍上。一拍里只是读一次看板 + 几次比较;
    // 真要排一通时才落盘。放在 paused 判断之**前**:暂停管的是工作台会不会为 agent 敲铃
    // (spec §5),不是「事务官不许找他」—— 那两件事的开关分别是 /pause 与 /call/config。
    void callOut?.pump()
    /**
     * 捎出去的话回了没有(2026-09-27,卡 CB):同款挂在这根既有节拍上,内部 8 秒一拍,
     * 而且**一条都没在等回话时一次窗口都不读**(planRelayWatch 先算,空的就直接回来)。
     */
    void relayWatch?.pump()
    /**
     * ★ **电脑锁着屏没有**(2026-10-03,卡「锁屏时窗口型的家送不进」):同款挂在这根既有节拍上,
     * 内部 3 秒一拍;**解锁了就把排着的那几件按原顺序重送**(09:04 那一句话因此不会再没了)。
     */
    void options.screenLock?.pump()
    /**
     * ★ **巡登记表**(2026-10-23,卡「捎话到没开着的会话留言等它醒」):同款挂在这根既有节拍上,
     * 内部 5 秒一拍;排着等它醒的那几条留言,哪条会话的 socket 在了就把哪条重送。
     */
    void options.sessionAwake?.pump()
    /**
     * 电脑这一端的「露面」(2026-10-09,卡「行为账」):屏幕开着没锁就算她在(锁屏 = 不在,不知道 = 不记)。
     * 行为账里一刻钟内只记一次。
     */
    if (options.screenLock?.locked() === false) options.behaviorLog?.seen('电脑')
    /**
     * ★ **「出门时电脑不睡」那一拍**(2026-10-03,卡「出门时电脑不睡」):同款挂在这根既有节拍上,
     * 内部 5 秒一拍 —— 算一次「开关开着 + 有已配对手机经中转连着」,**变了就下发给壳**。
     */
    void options.awayAwake?.pump()
    const rings = service.tick()
    if (paused) return
    const nowMs = Date.now()
    for (const ring of rings) {
      broadcast({ kind: 'ring', agent: ring.agent, session_id: ring.session_id })
      // 记进台账：重连的订阅者要靠快照知道现在在响什么。
      ringActive = startRing(ringActive, ring, nowMs)
    }
  }

  // 壳连接/授权状态变化时,把新快照推给所有展示台——不然界面要等下一次重连才看得到。
  helper?.onChange(() => {
    void (async () => { broadcast({ kind: 'snapshot', state: await composeState() }) })()
  })

  /**
   * 悬停高亮 v1:壳推来的 hover 事件原样转广播给 /live 上的订阅者(workbench-plugin
   * 客户端那条轻量 WS)。http.ts 对 dockService 内部一无所知,这条广播接线放在这里
   * 而不是 index.ts——onEvent 支持挂多个监听器,index.ts 那条 moved→dock.handleMoved
   * 的接线原样不动,两条互不干扰(那边按 event.kind==='moved' 收窄,忽略 hover;这里
   * 反过来只认 hover,忽略 moved)。没有 helper 就没有这条通道,不必判空。
   */
  helper?.onEvent((event) => {
    // 他点了壳弹的系统通知(2026-09-25,卡 M):页面切到事务官那一档、摊开那一张。
    if (event.kind === 'notification_click') { broadcast({ kind: 'focus_ask', key: event.key }); return }
    if (event.kind !== 'hover') return
    /**
     * 悬停:只转给页面画那句「松手认领到窗位」(2026-09-25,卡 P 起**不再亮光**)。
     * 以前进圈就亮原生光圈 —— 壳对程序化挪窗也报进圈,于是没拖东西槽上也时不时闪一下(维护者原话)。
     * 光改绑「放下」:见下面 dock.onDropClaimed。
     */
    broadcast({ kind: 'hover', inside: event.inside })
  })

  /**
   * 窗口槽那圈流线光(2026-09-25,卡 P):**只在他真把一个新应用拖进来、放手那一下**亮一轮。
   * 先让壳在槽的屏幕矩形上亮原生光圈(压在所有应用窗之上),等它最多 250ms;亮成了就告诉页面 `native:true`,
   * 页面不再画自己那圈(两圈叠着不是同一套光);没亮成页面自己那圈顶上。
   */
  dock?.onDropClaimed?.(() => {
    void (async () => {
      const drop = highlight?.drop
      const native = drop === undefined ? false : await Promise.race([
        drop().catch(() => false),
        new Promise<boolean>(resolve => { const timer = setTimeout(() => resolve(false), HOVER_NATIVE_WAIT_MS); timer.unref?.() }),
      ])
      broadcast({ kind: 'slot_drop', ...(native ? { native: true } : {}) })
    })()
  })

  // 例程接上 composeState(2026-09-15):它开会话前要读一份 /state,跑完要广播一次快照。
  routines?.attach({
    readState: composeState,
    /*
     * 正在走的两步接力(2026-10-13,卡 F):日报四段据此不把「豆包那一步回话了」当成交付。
     * **读法只有这一处**(`videoChain.view()`,接力那一层自己的记录);没接接力就回空。
     */
    videoChains: () => { try { return videoChain?.view() ?? [] } catch { return [] } },
    onChanged: () => {
      void (async () => { broadcast({ kind: 'snapshot', state: await composeState() }) })()
    },
  })

  const timer = tickIntervalMs > 0 ? setInterval(tick, tickIntervalMs) : undefined
  const heartbeatTimer = heartbeatMs > 0 ? setInterval(heartbeat, heartbeatMs) : undefined
  /**
   * 用量刷新独立成一根定时器。首轮全扫要 ~30 秒,挂在 composeState 里会把 /state 拖死;
   * 这里 fire-and-forget,失败已在 collector 内部按来源吞掉,不会波及其他字段。
   * 一次只允许一轮在跑——上一轮没跑完时后续节拍直接跳过,避免叠罗汉。
   * 节拍不再借用 1 秒 tick(2026-08-31 风暴修复):那样"跳过"等于一轮接一轮连轴转,
   * 磁盘被持续打满——用量的数字迟一分钟无所谓,见 DEFAULT_USAGE_INTERVAL_MS。
   */
  let usageRefreshing = false
  const runUsageRefresh = (): void => {
    if (usage === undefined || usageRefreshing) return
    usageRefreshing = true
    void usage.refresh().finally(() => { usageRefreshing = false })
  }
  runUsageRefresh()
  const usageIntervalMs = options.usageIntervalMs ?? DEFAULT_USAGE_INTERVAL_MS
  const usageTimer = usage !== undefined && usageIntervalMs > 0
    ? setInterval(runUsageRefresh, usageIntervalMs)
    : undefined
  // 别让这几个定时器把进程钉住不退出。
  timer?.unref?.()
  heartbeatTimer?.unref?.()
  usageTimer?.unref?.()

  return {
    host,
    port,
    url: `http://${host}:${port}`,
    tick,
    broadcastState() {
      broadcastSnapshot()
    },
    ...(reconcileExecutions === undefined ? {} : {
      reconcileNow: async () => { await reconcileExecutions.request().catch(() => { /* 这一拍坏了,下一拍再来 */ }) },
    }),
    liveClients() {
      return clients.size
    },
    liveStats() {
      return { skipped: liveSkipped, merged: snapshotMerged }
    },
    lanListening() {
      return lanServer !== undefined
    },
    moduleOrigin() {
      return moduleOriginServer?.origin
    },
    ...(diag === undefined ? {} : { diag }),
    // 「改自己」第 ⑧ 步那颗按钮(2026-09-23)。理由同上面那格 diag。
    ...(update === undefined ? {} : { update }),
    // 进程内派活口(2026-09-24,卡 F;卡 B 落地派第一件用)。
    ...(dispatchRunner === undefined ? {} : { dispatchItem }),
    // 在途后台派发等到落定;空表时立刻返回。用例与排障用。
    drainDispatches,
    ...(tasks === undefined ? {} : { dispatchChoices: async (taskId: string, input: { kind?: JobKind, text?: string } = {}) => await choicesFor(taskId, input) }),
    ...(itemBudget === undefined ? {} : { itemBudget }),
    // 要文件那一类事项的交付回执台账(2026-10-04):index.ts 的事项生命周期要问它「回执到了吗」。
    fileDelivery,
    // 答案来找她(2026-10-04):记一条 + 弹一条正文就是答案的通知。
    deliverAnswer,
    // 按证据核过再派(2026-09-25,卡 N;引导落地的第一件走它)。
    ...(itemDriver === undefined ? {} : { dispatchChecked: (itemDriver as ItemDriver).dispatchChecked }),
    /*
     * 这本账露出来只为验收 / 排障(2026-10-24 协作区事实层):往运行中的服务记一条真实的
     * assigned / 回执事件(presence 由它实时推),别的进程造的事件走文件它读不到。
     * 同 `diag` 那一条理由:用例与排障要摸得到进程里的东西。
     */
    jobLog,
    async close() {
      dispatchRunner?.stop()
      // 核验交付的定时再核 / 恢复重试一起收(第 4 步):收摊后不再悄悄跑。
      taskDelivery?.close()
      collabRelay?.stop()
      // 对账的到期调度与任务账订阅一起收(8791 第六轮):收摊后不再有一拍对账悄悄跑。
      reconcileExecutions?.dispose()
      unsubscribeTaskMutations?.()
      unsubscribeDigestChanged?.()
      // 起过的登录窗口(Chrome,detached)没人收就会留在她桌面上(2026-09-30,止血第 5 条)。
      closeProfileWindows()
      /*
       * 「接上」那条命令要是还在等她授权(最多 5 分钟),收摊时一起收掉 ——
       * 同上面那条:起过的东西自己收干净,不留一个谁也认不出来的进程在后台等。
       */
      claudeConnectRun?.cancel()
      claudeConnectRun = undefined
      itemBudget?.stop()
      agentCaps?.stop()
      await applyLan(false)
      if (timer !== undefined) clearInterval(timer)
      if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer)
      if (usageTimer !== undefined) clearInterval(usageTimer)
      if (testRingTimer !== undefined) { clearTimeout(testRingTimer); testRingTimer = undefined }
      for (const client of clients) client.terminate()
      clients.clear()
      awaitingPong.clear()
      wss.close()
      await moduleOriginServer?.close()
      await new Promise<void>((resolve) => { server.close(() => resolve()) })
    },
  }
}

/** 挂进 DSH 插件时用：从环境变量取端口，起服务。 */
export async function startFromEnv(
  service: WorkbenchService,
  env: Record<string, string | undefined> = process.env,
  extra: Pick<
    StartWorkbenchServerOptions,
    | 'credentialFile' | 'claudeConnect' | 'onCredentialsChanged' | 'onQuotaPushed' | 'projects' | 'machine' | 'badges' | 'behaviorLog' | 'clientKeys' | 'habits'
    | 'calendar' | 'runCommand' | 'runInCwd' | 'selfUpdate'
    | 'helper' | 'orchestrator' | 'scenes' | 'template' | 'xhs' | 'collect' | 'registry' | 'dock' | 'brief' | 'feed' | 'aidj'
    | 'modules' | 'userLayer' | 'moduleOrigin' | 'devTool' | 'layoutAsk' | 'evolve' | 'rules' | 'prompts' | 'collectors'
    | 'onAppsChanged' | 'usage' | 'tasks' | 'notes' | 'graphify' | 'archify' | 'codexReconcile' | 'daily' | 'claudeRecover' | 'waitingPump' | 'sessionAnswer'
    | 'peakSchedule' | 'sentinel' | 'model' | 'modelAutoSetup' | 'onboardingWarm'
    | 'reveal' | 'layoutSnapshot' | 'highlight' | 'butlerSession' | 'butler' | 'connector' | 'meeting' | 'callRecords' | 'pairing' | 'machineId' | 'lan' | 'paths'
    | 'onboarding' | 'materialize' | 'authorization' | 'appearance' | 'onboardingTurns' | 'projectBrief'
    | 'routines' | 'sessionTurns' | 'sessionDigest' | 'sessionLibrary' | 'onAgentHook' | 'rtcCall' | 'channel' | 'channelWorker' | 'localRoom' | 'deviceDirectory' | 'setup' | 'setupEnv' | 'update'
    | 'clientScan' | 'installedAgents' | 'modelMode' | 'relayProviders' | 'shipFollowUp' | 'items'
    | 'quickAnswer' | 'feedDig' | 'firstUse'
    | 'account' | 'appConfig' | 'callOut' | 'relayWatch' | 'actionGate' | 'jobLog' | 'engine' | 'engineRegistry' | 'familyLanes' | 'reopenApp'
    | 'composer' | 'approvals' | 'approvalGrants' | 'questions' | 'dispatchRun' | 'dispatchRules' | 'dispatchPrefs'
    | 'agentCaps' | 'loginLauncher' | 'itemBudget' | 'appInstalled' | 'windowQuota' | 'quotaAlerts' | 'quotaSpendTips'
    | 'agents' | 'callState' | 'sessionChildren'
    | 'actorTokens' | 'processHealth'
    | 'personalTokens' | 'collabWorkdir' | 'githubDevice' | 'mcpSecrets' | 'collabRelay' | 'collabAvatars' | 'collabEnabled'
  > = {},
): Promise<WorkbenchServer> {
  return startWorkbenchServer({
    port: resolveWorkbenchPort(env),
    host: resolveWorkbenchHost(env),
    service,
    // 登录台与热更新的默认实现都从这里读 HOME / WORKBENCH_BUTLER_CWD / WORKBENCH_UPDATE_URL
    // (测试传假 env 就整块搬进临时 HOME,清单也指到本地假服务器上)。
    setupEnv: env,
    ...extra,
  })
}
