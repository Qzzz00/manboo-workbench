/**
 * 工作台插件的 host 半区：在 DSH 进程里起一台本地 HTTP/WS 服务。
 *
 * 为什么服务在这里而不在别处（PRD §8.3 / 架构约束 C1）：
 * - Claude Code 的 hook 是外部进程一条 curl 打进来的，够不到 DSH 内部的 Cordis/Typert RPC，
 *   所以必须有一个真实监听端口的服务。
 * - 这台服务持有最后一次已知快照。Agent 层挂掉时它照常应答、只把 stale 置真，
 *   看板因此不会跟着一起死。
 *
 * 界面部分全在浏览器 bundle（src/client），host 这边不碰渲染。
 */
import { loadEndpoints } from './server/endpoints.ts'
import { UNKNOWN_PROJECT } from './server/sessions.ts'
import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, realpathSync } from 'node:fs'
import { homedir, hostname, tmpdir } from 'node:os'
import { chmod, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { format, promisify } from 'node:util'
import { withOpenCommandLog } from './server/appOpenLog.ts'
import { installLogStamp } from './server/logStamp.ts'
import { createWorkbenchService } from './server/service.ts'
import { createReadMarks, defaultReadMarksFile } from './server/readMarks.ts'
import { migrateLayoutModules, startFromEnv, type WorkbenchServer } from './server/http.ts'
import { createOrdinaryDispatchRulesFor } from './server/dispatchRuleAdapter.ts'
import { createS4WindowQaRules, type S4WindowQaRulesInput } from './server/s4WindowQaRules.ts'
import { startQuotaCollector, type QuotaCollector } from './quota/collector.ts'
import { watchCodexSessions } from './quota/codexWatch.ts'
import { defaultCodexSessionFeedDeps, startCodexSessionFeed, type CodexSessionFeed } from './server/codexSessionFeed.ts'
import { defaultKimiAgentDir, defaultKimiSessionFeedDeps, startKimiSessionFeed, type KimiSessionFeed } from './server/kimiSessionFeed.ts'
import { createKimiConversationReader, defaultKimiConversationsDb } from './server/kimiConversations.ts'
import { registryOnlySession } from './protocol.ts'
import { createRecordReaders } from './server/agentRecords.ts'
import { createClaudeSessionRecover, defaultClaudeSessionRecoverDeps, readClaudeLiveSessions } from './server/claudeSessionRecover.ts'
import { createSessionDigestService } from './server/sessionDigestService.ts'
import { createSessionHistory } from './server/sessionHistory.ts'
// 送完回那条会话的记录文件里核一句(2026-10-01,卡 AW)。
import { createTranscriptEvidence } from './server/sessionSaid.ts'
import { createSessionTranscript } from './server/sessionTranscript.ts'
import { createSessionAttachments } from './server/sessionAttachments.ts'
import { createWaitingService, defaultWaitingLedgerFile, type WaitingService } from './server/waitingService.ts'
import { createSessionJobs } from './server/sessionJobs.ts'
import { cliDispatchSessions, seedCliDispatchSessions } from './server/cliDispatchSessions.ts'
/**
 * ★ 一条引擎(2026-10-02,卡「引擎接线与删复制品」):三条通道(Claude socket / Codex 协议 / 窗口)
 * 登记在一处,闸与账只接在它身上。`sessionAnswer.ts` 那六只手已经删了 —— 对照表见
 * `docs/交接-1002-窗口适配器.md` 第二节。
 */
import { createEngineWiring } from './server/engine/wire.ts'
import { createFamilyLanes } from './server/familyLanes.ts'
import { bringAgentToFront as bringAgentToFrontWith, codexWorkdirOf } from './server/engine/wireHands.ts'
import { engineJobKey, jobGateActionOf } from './server/engine/engine.ts'
import { windowUnconfirmedWhy } from './server/engine/adapters/window.ts'
/** 那条会话此刻开着没有(巡登记表那一拍问它;2026-10-23,卡「捎话留言等它醒」)。 */
import { claudeSessionOpen, CLAUDE_FAMILY } from './server/engine/adapters/claude.ts'
import type { StructureMode } from './server/agentJudge.ts'
import { bindingFor, openCommandFor } from './server/agentSources.ts'
import { ensureRunningWith } from './server/activation.ts'
import { sessionAgentName } from './waiting.ts'
import { readSessionDigest } from './server/sessionDigest.ts'
import { defaultClaudeDesktopUsageFile } from './quota/claudeDesktop.ts'
import { watchClaudeDesktopUsage } from './quota/claudeDesktopWatch.ts'
import { defaultLastQuotaFile, forgetLastQuota, loadLastQuota, saveLastQuota } from './quota/persist.ts'
import { createQuotaAlerts, defaultQuotaAlertsFile } from './server/quotaAlerts.ts'
import { createQuotaSpendTips, defaultQuotaSpendTipsFile } from './server/quotaSpendTips.ts'
import { createProjectsService, DEFAULT_SCAN_ROOTS } from './server/projectsService.ts'
import { nodeBriefIo, projectVersion } from './server/projectBrief.ts'
import { createAccountSource } from './server/accountSource.ts'
import {
  ACCOUNT_EXPERIENCE_FILE, accountsDir, composeGoalProgress, countPublishedInPeriod,
  listAccountNames, readAccountFile, readAccountGoal, readExperienceLines, writeAccount,
  writeAccountProfile,
} from './server/accounts.ts'
import { readReviewLogs } from './server/topicReview.ts'
import { readAllTopicReviews } from './server/topicRun.ts'
import { PRODUCT_TEMPLATE, TOPIC_DIR, setWorkbenchTemplateSource } from './templates.ts'
import type { ProjectSource } from './server/projectSource.ts'
import { createPairingService, defaultDevicesFile } from './server/devices.ts'
import { defaultMachineIdFile, readOrCreateMachineId } from './server/machineId.ts'
import { lanAddresses } from './server/lan.ts'
import { createLocalRoomService, type LocalRoomService } from './server/localRoom.ts'
import { defaultCredentialFile, loadCredentials, volcAsrOf } from './server/credentials.ts'
import { createFeedSearch } from './server/searchDirect.ts'
import { defaultModelFile, fetchRelayUsage, loadModelConfig } from './server/modelConfig.ts'
// 走中转时 DeepSeek 那一格报的是中转的今日用量(2026-09-18,quota/relay.ts)。
import { readRelayView } from './quota/relay.ts'
import { applyLiveModelConfig, type ConfigEditorLike } from './server/dshLiveConfig.ts'
import { needsAlign, retargetManagedSessions, type ModelRetargetChange } from './server/modelRetarget.ts'
import { createModelService } from './server/modelService.ts'
import type { DshCredentialStore } from './server/modelService.ts'
// 中转上配了哪几家上游(2026-09-26,卡 GH):配了哪家才出现哪家。
import { createRelayProvidersReader } from './server/relayProviders.ts'
import { createModelAutoSetup } from './server/modelAutoSetup.ts'
import { createOnboardingWarm, defaultOnboardingWarmFile } from './server/onboardingWarm.ts'
import { createAccountService, defaultAccountFile, defaultAccountSessionKeyFile } from './server/account.ts'
import { createServerAccountService, defaultServerAccountFile } from './server/serverAccount.ts'
import { createAppConfig, defaultAppConfigFile } from './server/appConfig.ts'
import { createMdnsAdvertiser } from './server/mdns.ts'
import { findRepos } from './server/scan.ts'
import type { ScanRoot } from './server/scan.ts'
import { wbPathsEffective } from './server/pathConfig.ts'
import { createDailyService, defaultDailyFile } from './server/daily.ts'
import { createLayoutSnapshotService, defaultLayoutSnapshotsDir } from './server/layoutSnapshot.ts'
import { createRoutinesService, defaultRoutineGit, defaultRoutinesFile, defaultRoutinesStateFile } from './server/routines.ts'
// 下班例程第 0 步「收」(2026-09-26):各家 AI 的记忆拷进 docs/记忆/来自-<家>/,算出要并的那份清单。
import { collectAgentMemories } from './server/memoryCollect.ts'
// 记忆的收尾检查(2026-09-27):刷各家「来源.md」顶上的进度、把没提交的改动提交掉——不指望模型活到最后。
import { runMemoryCloseout } from './server/memoryCloseout.ts'
import { defaultButlerSkillsManifest, nodeButlerSkillsIo, syncButlerSkills } from './server/butlerSkills.ts'
import { createXhsService } from './server/xhsCreator.ts'
import { XHS_PROFILE_NAME } from './server/xhsAccount.ts'
import { createXhsBrowser } from './server/xhsBrowser.ts'
import { createCollectorsService } from './server/collectors.ts'
import { createDshAskResume } from './server/dshAskResume.ts'
import { defaultXhsMetricsFile, defaultXhsSelectorsFile } from './server/xhsStore.ts'
import { createXhsCollectService, defaultCollectFile } from './server/xhsCollect.ts'
import { createXhsNoteBrowser } from './server/xhsNoteBrowser.ts'
import { findTool, modelsDir, runBreakdown, toolsNote } from './server/xhsBreakdown.ts'
import { defaultProjectsFile } from './server/projects.ts'
import { createTasksService, defaultTasksFile } from './server/tasks.ts'
import { createPersonalTokens, defaultPersonalTokenFile } from './server/personalToken.ts'
import { createGitHubDevice, defaultGitHubFile } from './server/githubDevice.ts'
import { createMcpSecrets, defaultMcpSecretsFile } from './server/mcpSecrets.ts'
/** 动作闸 + 任务日志(2026-10-02,卡 AG):全进程一本账、一处判据。 */
import { createActionGate, createGateFileStore, defaultGateFile } from './server/actionGate.ts'
import { createJobLog, defaultJobLogFile } from './server/jobLog.ts'
/** 锁着屏时那几件活排的队 + 解锁重送(2026-10-03,卡「锁屏时窗口型的家送不进」)。 */
import { createLockQueue, defaultLockQueueFile, drainLockQueue, type LockQueueDrainDeps } from './server/engine/lockQueue.ts'
import type { Job, JobResult } from './server/engine/adapter.ts'
import type { LockQueueDispatch } from './server/lockQueueDispatch.ts'
import { createLockQueueDispatch, LOCK_DROP_WHY_TEXT } from './server/lockQueueDispatch.ts'
import type { ScreenLockWatch } from './server/screenLockWatch.ts'
import { createScreenLockWatch } from './server/screenLockWatch.ts'
/** 巡登记表那一拍(2026-10-23,卡「捎话到没开着的会话留言等它醒」):留言排进队后,那条会话一醒就重送。 */
import type { SessionAwakeWatch } from './server/sessionAwakeWatch.ts'
import { createSessionAwakeWatch, SESSION_AWAKE_LOG } from './server/sessionAwakeWatch.ts'
/** 那条会话没开着时留言 / 作废的那两句人话(2026-10-23,全仓各一处)。 */
import { SESSION_CLOSED_EXPIRED_SAY } from './server/sessionClosed.ts'
import { createAwayAwakeWatch } from './server/awayAwake.ts'
import type { AwayAwakeWatch } from './server/awayAwake.ts'
import { screenLockedOf } from './server/screenLock.ts'
/** 读回话认「我们那一句」用的那截字:与捎话、派活同一份记号函数(排队重送登记回电时要它)。 */
import { relayReadMark } from './server/sessionRelay.ts'
/** 「这件事的键」与「这个键收场了没有」只有一处定法(2026-10-02,卡 AG2)。 */
import { itemOfSession, jobPhaseOf } from './server/jobKey.ts'
import type { JobKeyTask } from './server/jobKey.ts'
import { defaultCodexSessionSourceDeps } from './server/sessionSources.ts'
import { resolveCodexProject } from './server/codexProject.ts'
import { normalizeDir } from './server/attribution.ts'
import { loadProjectsFile } from './server/projects.ts'
import { createMachineSampler } from './server/machine.ts'
import { createUsageCollector, decompressZstdFrames, type UsageScanDiagnostic } from './usage/collector.ts'
import { createBadgesSampler } from './server/badges.ts'
import { createCalendarSampler } from './server/calendar.ts'
import { parseRead, transcriptRows } from './server/agentWindowModel.ts'
import { createHelperChannel } from './server/helperChannel.ts'
// 派活的眼睛(2026-09-25,卡 O):能力体检、登录那颗键、每件事的上限、不许在他正用的仓库里切分支改文件。
import type { AgentCaps } from './server/agentCaps.ts'
import { createAgentCaps } from './server/agentCaps.ts'
import { appInstalledWith, createCliLoginProbe, createLoginLauncher, createWindowProbe } from './server/agentCapsIo.ts'
import { antigravityNativeView, createWindowQuotaReader, windowQuotaFileStore } from './server/agentQuota.ts'
// Antigravity 的额度直接问它本机的语言服务(2026-09-27,卡 AN)。令牌现取现用、用完就丢。
import { ANTIGRAVITY_BUNDLE_ID, antigravityNativeDeps, readAntigravityNative } from './quota/antigravityNative.ts'
import { cliEnvWith, createCliEnv } from './server/cliEnv.ts'
import { resolveAgentCli } from './server/agentDispatch.ts'
// Claude 额度「一键接上」(2026-10-03):找那条命令行在哪;起进程 / 开浏览器在下面接线。
import { resolveClaudeCli } from './quota/claudeSetupToken.ts'
import { createBudgetStore, defaultBudgetFile, readBudgetCny } from './server/itemBudget.ts'
import { checkoutViolation, type GuardContext } from './server/checkoutGuard.ts'
import { DIVISION_TITLE, divisionFromArchive, divisionRuleText } from './server/dispatchChoice.ts'
import { extraProjects, type MaterializeArchive } from './server/materialize.ts'
import { PLUGIN_VERSION } from './version.ts'
import { createOrchestrator } from './server/orchestrator.ts'
import { createScenesService, defaultScenesFile } from './server/scenes.ts'
import { createTemplateService, defaultTemplateBackupsDir, defaultTemplateFile } from './server/templateStore.ts'
import { createCustomModulesService, defaultModulesDir } from './server/modules.ts'
import { createUserLayerService, defaultUserLayerDir, legacyPrefsMoves, migrateLegacyFilesOnce, scanUserLayerSkills } from './server/userLayer.ts'
import type { UserLayerSkill } from './server/userLayer.ts'
import { DEFAULT_MODULE_PORT } from './server/moduleOrigin.ts'
import { createDevToolStore, defaultDevToolFile } from './server/devTool.ts'
// 进化循环(2026-09-22,卡 ⑥)。判据与阈值全在 server/evolve.ts;这里只把四个口接上。
import { createEvolveService, createEvolveStore, defaultEvolveFile } from './server/evolve.ts'
import { userSaysOf, userSpokenOf } from './server/evolveSays.ts'
import { newModuleId } from './server/devTool.ts'
import { wbSkillApply, wbSkillRevert } from './server/hooksApply.ts'
import { lowPriorityCommand } from './server/lowPriority.ts'
// 他的规矩(2026-09-24 晚,卡 K;docs/设计-全局自进化-2026-09-24.md):一张表、四个时刻。
import { RULES_BLOCK, createRulesService, defaultRulesFile } from './server/rules.ts'
// 集中改提示词那一页(2026-10-01,卡「设置里集中改提示词」)。
import {
  createPromptOverrideStore, defaultPromptOverridesFile, defaultPromptOverridesLogFile, installPromptOverrides,
} from './server/promptOverrides.ts'
import { createPromptsService } from './server/promptsPage.ts'
import { opsSkillsForTemplate } from './server/opsSkills.ts'
import { wbHooksResolveRepoRoot } from './server/hooksConfig.ts'

/**
 * 模块来源的端口。缺省 8794;`WORKBENCH_MODULE_PORT` 认不出来的值一律当没写 ——
 * **不抛**:一个写错的环境变量不该让整个工作台起不来,顶多是这一档缺席。
 */
export function moduleOriginPort(env: Record<string, string | undefined> = process.env): number {
  const raw = env.WORKBENCH_MODULE_PORT
  if (raw === undefined || raw.trim() === '') return DEFAULT_MODULE_PORT
  const port = Number(raw)
  return Number.isInteger(port) && port >= 0 && port <= 65535 ? port : DEFAULT_MODULE_PORT
}
// 用自然语言改布局(2026-09-22):待确认的那几条落 ~/.dsh/workbench/layout-asks.json。
import { createLayoutAskStore, defaultLayoutAskFile } from './server/layoutAsk.ts'
import { createAppsRegistry, defaultAppsFile, loadAppsFile } from './server/appsRegistry.ts'
// 2026-09-17「每个区域单独解锁」:客户端探测与模型来源。两者都只在这里(生产)接线。
import { createClientScan } from './server/clientScan.ts'
import { createInstalledAgentScan } from './server/installedAgents.ts'
// 2026-09-25 卡 R:钩子脚本随插件走,起服务时同步到 ~/.dsh/workbench/hooks/。
import { fileURLToPath } from 'node:url'
import { createHookScripts } from './server/hookScripts.ts'
import { createModelModeReader } from './server/modelMode.ts'
import { nodeSetupIo } from './server/setup/io.ts'
import { setupPaths } from './server/setup/paths.ts'
import { createDockService, defaultDockFile } from './server/dock.ts'
import { createBriefService, defaultBriefFile, localDateStr } from './server/brief.ts'
import { createFeedService, defaultFeedConfigFile, defaultFeedFile } from './server/feed.ts'
import { createFeedDigContext } from './server/feedDig.ts'
import { createAidjService, defaultAidjConfigFile } from './server/aidj.ts'
import { createNotesService, defaultNotesFile } from './server/notes.ts'
import { createHighlightService } from './server/highlight.ts'
import { createDshSessionFeed, type DshEventLike, type DshSessionFeed } from './server/dshSessionFeed.ts'
import { createButlerLifecycle } from './server/butlerLifecycle.ts'
import { createPeakScheduleService, defaultPeakScheduleFile } from './server/peakSchedule.ts'
import { createSpendLedger, defaultSpendLedgerFile } from './quota/spendLedger.ts'
import { createSentinelService, defaultSentinelDeps, defaultSentinelFile } from './server/sentinel.ts'
import { createCallOutService, defaultCallOutFile, type CallOutEvent } from './server/callOut.ts'
import { createDispatchPrefsService, defaultDispatchPrefsFile } from './server/dispatchPrefs.ts'
import { createClientKeyLedger, defaultClientKeysFile } from './server/clientKeys.ts'
import { BEHAVIOR_EVENTS, callSettledNoteOf, createBehaviorLog, defaultBehaviorDir, type BehaviorLog } from './server/behaviorLog.ts'
import { createFirstUseService } from './server/firstUse.ts'
import { createHabitService, HABIT_POKE_EVENTS, type HabitService } from './server/habits.ts'
import { runCallOutSessionIdMigration, sessionFamilyMap } from './server/callOutMigrate.ts'
import { createEngineRelayReader, createRelayWatchService, defaultRelayWatchFile, relayWatchOnDrain } from './server/relayWatch.ts'
import { createSetupGate } from './server/setupGate.ts'
import { createGraphifyService } from './server/graphify.ts'
import { archifyAssetRootFrom, createArchifyService } from './server/archify.ts'
import { createRevealService } from './server/reveal.ts'
import { BUTLER_EFFORT_DEFAULT, resolveEffort } from './server/butlerEffort.ts'
import { BUTLER_ACTOR_ENV, WORKER_ACTOR_ENV, mintActorTokens } from './server/herself.ts'
import { butlerSayFailureOf, type ButlerOpenExtras, type ButlerSessionOpener, type ItemQueueClearResult } from './server/butlerItem.ts'
import { MODE_PERMISSION_PRESET, approvalViews, createApprovalBroker, createComposerService, defaultComposerInboxDir } from './server/composer.ts'
import { createDshSettingsStore } from './server/dshSettingsStore.ts'
import type { ApprovalBroker, ModelCatalogLike } from './server/composer.ts'
import { createButlerService, defaultButlerConfigFile } from './server/butler.ts'
import { createProcessHealth, type ProcessHealth } from './server/processHealth.ts'
import { createConnectorService } from './server/connector/service.ts'
// 事务官要问的话、要批的事摆到外层(2026-09-25,卡 M):提问经纪人、审批的人话与「同类的都允许」。
import {
  approvalKind, approvalSubject, askCallOutEvents, combineRequestSignal, createApprovalGrants, createQuestionBroker, defaultApprovalGrantsFile, describeApproval, findRepoRoot,
  questionViews, toolCallArgsOf,
  type ApprovalGrants, type QuestionBroker,
} from './server/butlerAsks.ts'
// 某家会话真在等他答 / 等他批 → 座机响(2026-09-28,卡 WQ)。
import { sessionAskCallOutEvents } from './server/sessionAskCalls.ts'
import { createMeetingService, defaultMeetingsFile } from './server/meeting.ts'
import { CALL_RECORDS_DIR_NAME, createCallRecordsService, defaultCallRecordsFile } from './server/callRecords.ts'
import { createMeetingFacts } from './server/meetingFacts.ts'
import { createAuthorizationService } from './server/authorization.ts'
import { createAppearanceService, defaultAppearanceFile } from './server/appearance.ts'
import type { OnboardingService } from './server/onboarding.ts'
import { createOnboardingService, defaultAgentsFile, defaultAuthorizationFile, defaultOnboardingFile } from './server/onboarding.ts'
import { importAgentMemories, probeAgentMemories } from './server/agentMemory.ts'
import { CHANNEL_INBOX_NAME, CHANNEL_ROUTES, CHANNEL_TOOL_NOTE, createChannelService } from './server/channel.ts'
import { createChannelCredentialStore } from './server/channelCredentials.ts'
import { resolveWorkbenchHost, resolveWorkbenchPort } from './server/http.ts'
import type { IndexInjectGlobalRow } from './serviceOrigin.ts'
import { serviceInjectRow } from './serviceOrigin.ts'
import type { ChannelWorkerFleet } from './server/channelWorkerFleet.ts'
import { CHANNEL_ROUTE_LABELS, channelWorkerForRoute, createChannelWorkerFleet } from './server/channelWorkerFleet.ts'
import { createChannelWorkerReaper, dshHomeOf } from './server/channelWorkerReap.ts'
import { createDeviceDirectoryService } from './server/deviceDirectory.ts'
import { CALL_TOOL_DOING, createRtcCallService, rtcCallbackUrlOf } from './server/rtcCall.ts'
import { createOnboardingTurns, wireOnboardingTurns } from './server/onboardingTurns.ts'
import type { MaterializeService } from './server/materializeService.ts'
import { createMaterializeService, dispatchExistingItem } from './server/materializeService.ts'
import { extractWithModel } from './server/materializeModel.ts'
import { findCodexThread } from './server/codexThreads.ts'
import { PUBLISH_SCRIPT_REL, SELF_SHIP_SKIP_LOCAL_CHECK, joinRel } from './server/selfUpdate.ts'
import type { SelfShipFollowUp } from './server/selfShipFollowUp.ts'
import { installedPluginVersion, runSelfShipFollowUp } from './server/selfShipFollowUp.ts'
// 一件事一份、进度靠证据(2026-09-25,卡 N)。
import type { ProgressService, SessionAccess } from './server/progress.ts'
import { createProgressService, defaultProgressFile } from './server/progress.ts'
import { defaultSourceDeps } from './server/progressSources.ts'
import { defaultDriveFile } from './server/itemDriver.ts'
import { ownerMorningLines } from './server/itemMover.ts'
import { ownerFromDesc } from './server/materialize.ts'
// Agent 自动发现与统一接入(2026-09-25,卡 Q)。
import { createBrokerAsker } from './server/agentAsk.ts'
import type { SessionChildren } from './server/sessionChildren.ts'
import { createSessionChildren } from './server/sessionChildren.ts'
import type { AgentDiscovery } from './server/agentDiscovery.ts'
import { createAgentDiscovery } from './server/agentDiscovery.ts'
import { draftSavedNote, saveClientDraft } from './server/clientDrafts.ts'
import { capTargetsFor } from './server/dispatchTargets.ts'
import { OWN_BUNDLE_ID, createFileRegistryStore, defaultAgentRegistryFile } from './server/agentRegistry.ts'
import { createCallState } from './server/callState.ts'

let running: WorkbenchServer | undefined
/** 插件进程自己的内存与事件循环(2026-10-19);一个进程一份,dispose 时关掉直方图。 */
let processHealth: ProcessHealth | undefined
/**
 * 上一次「改自己」重启之后那一句收尾(2026-09-23)。服务起来之后算一次就定下来,
 * 收件箱每拍现读它(`shipFollowUp: () => shipFollowUp`)。
 *
 * **只活在这个进程里**,不落盘:它说的就是"这一次启动对出来的结果"。
 * 真正的事实在 `docs/进化日志.md` 里(那一行已经改成「已生效」了),
 * 再存一份就要有人负责同步,而那个同步一定会漏(同 butlerInbox.ts 的纪律)。
 */
let shipFollowUp: SelfShipFollowUp | undefined
/** 工人的常驻那一层(2026-09-17;2026-10-22 起一条路线一条,卡 M6)。卸载插件时要把它一起停掉,所以放在模块级。 */
let channelWorker: ChannelWorkerFleet | undefined
/**
 * 「30 秒对一遍路线」那个定时器(2026-09-30,止血第 5 条;2026-10-22 起一直对,卡 M6)。
 * 原来没人记着它:插件卸载 / 重载之后这条 30 秒的链还在跑,拿着上一份 `channel` 的引用
 * 一直问下去 —— dispose 里清掉它。
 */
let stopWorkerWatch: (() => void) | undefined
/** 本机房间的看管(卡 M1):每 30 秒看一次局域网地址。卸载插件时停掉那个节拍。 */
let localRoom: LocalRoomService | undefined
let quota: QuotaCollector | undefined
let stopCodexWatch: (() => void) | undefined
let stopClaudeUsageWatch: (() => void) | undefined
let codexSessionFeed: CodexSessionFeed | undefined
let kimiSessionFeed: KimiSessionFeed | undefined
let dshSessionFeed: DshSessionFeed | undefined
/** Agent 登记表那个跑腿的(2026-09-25,卡 Q)。卸载插件时要停掉它的节拍。 */
let agentDiscovery: AgentDiscovery | undefined
/** 后台任务挂在主会话上(卡 Q,设计第六节)。 */
let sessionChildren: SessionChildren | undefined

const execFileAsync = promisify(execFile)

/**
 * 工作台自己在服务端直连模型时用哪个名字(2026-09-28,卡 BS)。
 *
 * 以前这几处写的是 `deepseek-chat`。中转把这个老名字转给上游的**本来就是 Flash**,
 * 但记账对认不出的名字一律按 Pro 那一档算(`relay/server/pricing.cjs` priceTierOf)——
 * 等于按 3–4 倍的价记一样的活。所以统一写成中转登记的那个名字,
 * 并且**每一处自己把思考关掉**(`thinking: { type: 'disabled' }`):
 * 这几问(资讯打分、口播稿、会议纪要、小红书建议、判是不是 Agent)都是照材料写几行字,不用想。
 * 同一条路上已经这么办的两处:`server/progress.ts` 的 PROGRESS_MODEL、`server/waitingService.ts` 的 WAIT_MODEL。
 */
const DIRECT_MODEL = 'deepseek-v4-flash'

/**
 * git 命令执行器，喂给 projectsService 的「算」行扫描（scan.ts 的 Exec 签名，带 cwd）。
 * 失败一律 `{ ok: false }`，不抛——scanRepo/build 靠这个信号把错误记进 scan_errors/signal_error，
 * 不能让一次 git 报错拖垮整批扫描。
 */
async function gitExec(args: readonly string[], cwd: string): Promise<{ ok: boolean, stdout: string }> {
  try {
    const { stdout } = await execFileAsync('git', args as string[], { cwd })
    return { ok: true, stdout }
  }
  catch {
    return { ok: false, stdout: '' }
  }
}

/**
 * 带 **cwd 与退出码**的命令执行器(2026-09-23,断点 B 与 C)。
 *
 * 与上面两个执行器都不同:`runCommand` 没有 cwd,`gitExec` 只回 `ok`。
 * 而「派出去那件活成没成」的唯一判据就是**退出码**,「改了哪些文件」要在那个目录里问 ——
 * 两样都缺,这条线只能靠事务官转述,而那正是断点 B 要治的病。
 *
 * **失败不抛**:退出码原样回去(`error.code`),输出把 stdout 与 stderr 接在一起
 * —— 测试框架的红字有一半在 stderr 上,只留 stdout 等于把她最想看的那几行扔了。
 * 20 分钟上限:一次全量 vitest 在这台机器上几分钟,跑到 20 分钟就是卡住了。
 */
async function runInCwd(input: { cmd: string, args: readonly string[], cwd: string }): Promise<{ code: number, out: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(input.cmd, input.args as string[], {
      cwd: input.cwd,
      timeout: 20 * 60 * 1000,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })
    return { code: 0, out: `${stdout}${stderr}` }
  }
  catch (error) {
    const one = error as { code?: number | string, stdout?: string, stderr?: string, message?: string }
    const code = typeof one.code === 'number' ? one.code : 1
    return { code, out: `${one.stdout ?? ''}${one.stderr ?? ''}${one.stdout === undefined && one.stderr === undefined ? one.message ?? '' : ''}` }
  }
}

async function gitCommonRoot(cwd: string): Promise<string | undefined> {
  const result = await gitExec(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd)
  if (!result.ok) return undefined
  const commonDir = result.stdout.trim()
  return commonDir === '' ? undefined : dirname(commonDir)
}

function isDirectoryPrefix(parent: string, child: string): boolean {
  const normalizedParent = normalizeDir(parent)
  const normalizedChild = normalizeDir(child)
  return normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}/`)
}

/** 列出一层子目录的绝对路径，供 findRepos 逐级下探（scan.ts 的 ScanRoot 深度语义）。 */
async function listDir(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  return entries.filter(entry => entry.isDirectory()).map(entry => join(dir, entry.name))
}

/** 一个目录算不算仓库：有没有 `.git`（worktree 下 `.git` 是文件不是目录，stat 两种都认）。 */
async function isRepo(dir: string): Promise<boolean> {
  try {
    await stat(join(dir, '.git'))
    return true
  }
  catch {
    return false
  }
}

/**
 * 不带 cwd 的命令执行器，喂给机器采样（df/top/sysctl）和应用激活（open -a）——
 * 这三类命令都不依赖某个仓库目录，和 gitExec 是两个不同的口子。
 */
async function runCommandRaw(cmd: readonly string[]): Promise<{ ok: boolean, stdout: string }> {
  const [bin, ...args] = cmd
  if (bin === undefined) return { ok: false, stdout: '' }
  try {
    const { stdout } = await execFileAsync(bin, args)
    return { ok: true, stdout }
  }
  catch {
    return { ok: false, stdout: '' }
  }
}

/**
 * ★ **每让系统开一个 App 就记一行**(2026-10-02,维护者拍板「诊断包加两样」第一样)。
 *
 * 包在**执行器**上,不在十几个「返回一条 open 命令」的地方各记一行:`open -b` / `open -a`
 * 散在 `apps.ts`(微信 / 企微 / 终端 / 日历)、`agentSources.ts`(六家 Agent)、`appsRegistry.ts`、
 * `reveal.ts`、`butler.ts`、`setup/panes.ts`、`update/apply.ts`,**而且还会加** ——
 * 逐处记必漏,记在这里新加一处自动跟着记。判据与行格式在 `server/appOpenLog.ts`。
 *
 * 10-02 那件事(「网易云每隔 10s 自行打开」)只能写「没查实」,病根之一正是这里一行记录都没有。
 */
const runCommand = withOpenCommandLog(runCommandRaw)

/**
 * 单独给日历采样用的执行器，比 runCommand 多一道超时保护(R1 教训：AppleScript 可能
 * 挂死，不像 df/top/sysctl 那样几乎不会卡住——尤其是系统日历首次授权那次，如果
 * 用户一直不点系统弹窗，`osascript` 进程会一直挂在那里)。
 *
 * execFile 自带的 `timeout` 选项到点直接 kill 子进程，60 秒上限——不用自己写轮询，
 * 也不会因为一次卡住的 AppleScript 拖垮后续所有 GET /state。
 */
async function runOsascript(cmd: readonly string[]): Promise<{ ok: boolean, stdout: string }> {
  const [bin, ...args] = cmd
  if (bin === undefined) return { ok: false, stdout: '' }
  try {
    const { stdout } = await execFileAsync(bin, args, { timeout: 60_000 })
    return { ok: true, stdout }
  }
  catch {
    return { ok: false, stdout: '' }
  }
}

/**
 * cordis 传给插件的上下文,我们只用到其中三样(事件订阅、服务注入、可选服务查询)。
 *
 * 为什么不 import DSH 的 `Context` 类型:host 半区的运行时依赖只有 Node 内置模块——
 * 引一个 @deepseek-ai 的类型进来会把这个文件绑到某个具体版本的类型形状上,
 * 而 DSH 明说会有破坏性变更(C3)。结构性最小接口就够,取不到就整块不接线。
 */
interface DshHostContext {
  on: (event: string, listener: (...args: never[]) => void) => unknown
  inject: (services: readonly string[], callback: (ctx: never) => void) => unknown
}

/**
 * 早报对进度要的那一个数:这个账号在数据复盘那一格里的**涨粉**(2026-09-22 卡④)。
 *
 * 三道闸,一道都不放:
 * ① 只认 `account_dir` **对上这个账号文件夹**的那个浏览器档案(xhsAccount 那套按名字挂钩)——
 *    对不上就没有,**不拿合计那一行顶**(多账号时合计是几个账号加起来的,安在一个账号头上就是编);
 * ② 范围优先「近 30 日」,没有才退「近 7 日」—— 目标周期默认一个月,近 30 日离它最近;
 * ③ `value` 与 `raw` **都要有**才算取到。后台没给那一项时这两样都缺席,早报如实说取不到。
 */
function fansOfAccount(
  view: { accounts: readonly { account_dir?: string, ranges: readonly { range: string, metrics: readonly { key: string, value?: number, raw?: string, why?: string }[] }[] }[] },
  account: string,
): { fans?: { value: number, raw: string, range: string }, fans_absent_why?: string } {
  const matched = view.accounts.find(item => item.account_dir === account)
  if (matched === undefined) return { fans_absent_why: '数据复盘那一格里没有对上这个账号的登录档案' }
  const ranges = ['近 30 日', '近 7 日']
  for (const wanted of ranges) {
    const range = matched.ranges.find(item => item.range === wanted)
    if (range === undefined) continue
    const metric = range.metrics.find(item => item.key === 'new_fans')
    if (metric?.value === undefined || metric.raw === undefined) continue
    return { fans: { value: metric.value, raw: metric.raw, range: wanted } }
  }
  const why = matched.ranges
    .flatMap(range => range.metrics.filter(metric => metric.key === 'new_fans'))
    .map(metric => metric.why)
    .find((text): text is string => text !== undefined)
  return { fans_absent_why: why ?? '这个账号还没取到过涨粉数' }
}

/**
 * **把自己的服务地址告诉页面**(2026-09-26,卡 GP)。整条链路与为什么走这条通道见
 * `serviceOrigin.ts` 文件头;一句话:页面原来把 8791 写死,于是灰度实例的页面一直在拿
 * **生产**那台服务做事(包括注册这种写操作),而界面上一切正常。
 *
 * **挂在 `apply` 的第一步、一个 `await` 都不隔**:index.html 每来一次请求就渲一次,而这台
 * 服务要起好几秒(已读簿、采集器、授权表、通话工人都排在前面)。晚挂一拍,那一拍里打开的
 * 页面就没有这一行、只能退回兜底 —— 早挂是白捡的。
 *
 * 地址从**环境变量**算,而不是等 `running.port`:算法与 `startFromEnv` 传给
 * `startWorkbenchServer` 的那一份是同一个函数、同一份 env,两者按构造相等;真出现端口被占,
 * 那是这台服务根本起不来,页面上有没有这一行都不改变结果。
 *
 * 露出来(而不是写在 `apply` 里)只为一件事:用例能**不起服务**就把这一行验了。
 *
 * @param ctx DSH 给的插件上下文。取不到(壳外的用例、或 DSH 那半没接上)就整块缺席 —— 页面退回兜底。
 * @param env 读 `WORKBENCH_HOST` / `WORKBENCH_PORT` 的那份环境;用例传假的。
 */
export function announceServiceOrigin(
  ctx?: Pick<DshHostContext, 'on'>,
  env: Record<string, string | undefined> = process.env,
): void {
  // 现在就算(而不是每次渲 index 时才算):env 在进程的一生里不变,而**写坏了要立刻抛**
  // —— 同 resolveWorkbenchPort / resolveWorkbenchHost 的老规矩,静默退回默认值会让人
  // 对着一个永远连不上的地址查半天。真抛在这里,`startFromEnv` 那一步本来也会抛。
  const row = serviceInjectRow(resolveWorkbenchHost(env), resolveWorkbenchPort(env))
  ctx?.on('webserver/index-inject', (table: IndexInjectGlobalRow[]) => { table.push(row) })
}

/** 正常 host 只负责把本实例服务交给唯一 QA 工厂；缺省不覆盖 HTTP 普通规矩回退。 */
export async function hostDispatchRules(input: Omit<S4WindowQaRulesInput, 'ordinaryRulesFor'> & {
  rules: NonNullable<Parameters<typeof createOrdinaryDispatchRulesFor>[0]['rules']>
}): Promise<NonNullable<Parameters<typeof startFromEnv>[2]>['dispatchRules']> {
  const rulesFor = await createS4WindowQaRules({
    env: input.env,
    tasks: input.tasks,
    projects: input.projects,
    ordinaryRulesFor: createOrdinaryDispatchRulesFor({ tasks: input.tasks, rules: input.rules })!,
  })
  return rulesFor === undefined ? undefined : { rulesFor }
}

export async function apply(ctx?: DshHostContext): Promise<void> {
  // DSH 的插件可能被重复 apply，起第二台会撞端口，这里直接复用。
  if (running !== undefined) return

  /**
   * ★ **工作台日志每行带时间**(2026-10-02,维护者拍板「诊断包加两样」第二样)。
   *
   * **第一件事**就做:它之后的每一行 `console.*`(落在 `~/.dsh/logs/web.stdout.log`)都带时间。
   * 10-02「网易云每隔 10s 自行打开」那件只能写「没查实」,一半病根是日志里那条
   * 「已完成。网易云音乐已经开始播放音乐了」**没有时间** —— 对不上任何一拍。
   *
   * 已经自己带时间的行(`[dispatch]` / `[answer]` / `[relay]` / `[开App]`)原样放过,不盖第二个
   * (判据在 `logStamp.ts` 一处)。装两遍只算一遍,所以这一行放在 `running` 那道门之后也无妨。
   */
  installLogStamp({ console, format })

  let configEditor: ConfigEditorLike | undefined
  try {
    ctx?.inject(['configEditor'], ((injected: { configEditor?: ConfigEditorLike }) => {
      if (injected?.configEditor && typeof injected.configEditor.edit === 'function') {
        configEditor = injected.configEditor
      }
    }) as (ctx: never) => void)
  } catch {
    /* 服务缺席时在线设置明确失败，离线安装仍由 Store 的纯文件路径处理。 */
  }

  const liveReconcile = (request: Parameters<typeof applyLiveModelConfig>[1]): ReturnType<typeof applyLiveModelConfig> => applyLiveModelConfig(configEditor, request)

  // 把自己的服务地址告诉页面(卡 GP)。第一步就挂,一个 await 都不隔,理由见函数注释。
  announceServiceOrigin(ctx)

  /**
   * 「等你确认」只认她本人、发版要她点头那道门的两把**进程令牌**(2026-09-28,卡 BS;
   * 整段理由与那个还没关上的洞在 `server/herself.ts`)。
   *
   * 现生、**不落盘**、重启即换。落法只有两句,但两句都要紧:
   * - 事务官那一把写进**这个进程自己的 env**:8791 跑在 DSH 进程里,事务官的 shell 工具是它的
   *   **子进程**,于是只有它继承得到;派出去的 Codex / Claude 在别的进程树里,拿不到。
   * - 工人那一把**不写进 process.env**,只在起工人时放进它的 spawn env(见下面 channelWorker),
   *   这样事务官在自己的 env 里读不到它、伪装不了「她在电话里说的那一句」。
   */
  const actorTokens = mintActorTokens()
  process.env[BUTLER_ACTOR_ENV] = actorTokens.butler

  // 已读簿(2026-09-02):把"我看过了"这个判断留在磁盘上,别随进程蒸发。
  // 装载放在 service 之前——第一条 hook/feed 上报可能在毫秒级就到,晚装载会漏判。
  const readMarks = createReadMarks({ file: defaultReadMarksFile(process.env.HOME ?? '') })
  await readMarks.load()
  /**
   * 「在等你」(2026-09-25,卡 T):别家会话停着在等他 —— 弹窗的(权限 / 提问)与没弹窗的(正文里在问他)都算。
   * 服务在下面(模型服务、授权表都接好之后)才建;会话表出视图时经这里叠一层(在等你 > 在跑 > 空闲),先占位后接线。
   */
  let waiting: WaitingService | undefined
  const service = createWorkbenchService({ readMarks, overlay: (views, nowSec) => waiting?.overlay(views, nowSec) ?? views })
  /**
   * 事务官仓库的**进程内当前值**(2026-09-17 卡 C)。
   *
   * 先按环境变量起头(它优先级最高、且 app.json 还没读到),下面读完 app.json 会补上兜底值;
   * PUT /config/paths 改了之后这里也跟着变,于是**此后新开的事务官会话**会开在新仓库里,
   * 不用重启。引导 / 授权 / 例程三块不吃这一口——它们在启动时就按当时的值接好线了,
   * 那三块要 kickstart(接口会如实回 restart_required: true)。
   */
  let butlerCwdNow = process.env.WORKBENCH_BUTLER_CWD
  // 事务官会话通道(2026-09-10)。拿不到 DSH 的 sessionController 时是 undefined,不是错误。
  const butlerSession = createButlerSessionOpener(ctx, () => butlerCwdNow, {
    target: () => modelService.target(),
    selectionOf: sessionId => dshSessionFeed?.selectionOf(sessionId),
    catalogDefault: async () => {
      const catalog = await butlerSession?.catalog?.().catch(() => undefined)
      const d = catalog?.default
      return d === undefined ? undefined : { provider: d.provider, model: d.model }
    },
  })

  // Claude 那格不归定时拉管（statusLine 推上来），所以要在这里显式给一句初始说明。
  // 不给的话界面会退回默认的"取数方式待实测"——那是错的：它的取数方式早就定了，
  // 只是还没等到 Claude Code 那头推第一条上来。
  service.setQuota('claude', { kind: 'unknown', note: '等 Claude Code statusLine 上报' })

  // 但如果上次已经收到过，就用那份最后已知值顶上——statusLine 触发得不规律，
  // 一次重启就退回"等上报"的话，Ben 会以为它坏了（实际上二十分钟前刚来过一份好数据）。
  const lastQuotaFile = defaultLastQuotaFile()
  const last = await loadLastQuota(lastQuotaFile)
  if (last.claude !== undefined) service.setQuota('claude', last.claude)

  // DeepSeek 峰谷时段(2026-09-09,借 dsh-save-money 的时间窗语义)。两件事:
  // 采集时按时段给今日消耗分账、/state 下发当前是高峰还是低谷。**只显示与分账,
  // 不自动暂停任何任务**。时间表落盘 ~/.dsh/workbench/peak-hours.json,Ben 在设置里改;
  // 装载放在采集器之前——第一轮采集就该按 Ben 的表分账,而不是先按默认表记错一轮。
  const peakSchedule = createPeakScheduleService({ file: defaultPeakScheduleFile(process.env.HOME ?? '') })
  await peakSchedule.load()
  // 消耗账本落盘:日结要拿**昨天**的峰谷两笔,而账本只活在采集循环内存里、跨天即清零。
  // 同时让当天重启后接着记,而不是重新建基线把当天前面花的钱抹掉。
  const spendLedger = createSpendLedger({ file: defaultSpendLedgerFile(process.env.HOME ?? '') })
  await spendLedger.load()

  // 采集器先建：服务要拿它的 collectOnce 做「填完 Key 立刻重采」的回调。
  // onUpdated 在服务起来之后才接得上，所以先留个可变引用。
  let pushSnapshot: () => void = () => {}
  // statusLine 最后一次把 Claude 额度推上来的时刻。桌面端不执行 statusLine
  //（anthropics/claude-code#41456），所以平时不会有；终端里跑 CLI 时会有，而且比拉取
  // 新鲜得多。只在本进程内计时：从 last-quota.json 恢复的那份没有时间，按"不新鲜"处理。
  let claudePushedAt: number | undefined
  const collector = startQuotaCollector({
    service,
    onUpdated: () => pushSnapshot(),
    claudePushedAt: () => claudePushedAt,
    // 每轮现取:Ben 在设置里改完时间表,下一轮就按新表分账,不必重启。
    peakSchedule: () => peakSchedule.get(),
    spendLedger,
    /**
     * 此刻走不走工作台中转(2026-09-18)。走中转时 DeepSeek 那一格报的是中转的今日用量,
     * **一次都不去问官方余额** —— Ben 那台机器上 `~/.dsh/.env` 里还留着一把私人 Key,
     * 于是面板上挂着一笔他此刻根本没在花的钱(见 docs/交接-0918-额度不显示旧数.md)。
     *
     * 每轮现读 model.json:他在设置里切完,下一轮就换说法,不必重启。
     */
    readRelay: () => readRelayView({
      readModelFile: async () => {
        try { return await readFile(defaultModelFile(process.env.HOME ?? ''), 'utf8') }
        catch { return undefined }
      },
      fetchUsage: options => fetchRelayUsage(options),
    }),
    // 凭据被清空时,落盘那份里同一家的记录也删掉(不然重启后它又被顶回界面上)。
    forgetLastQuota: (agent) => { void forgetLastQuota(lastQuotaFile, agent) },
  })
  quota = collector

  const home = process.env.HOME ?? ''

  /**
   * 工作台自身的开关(app.json)。**要在项目区 / 事务官之前建**——2026-09-17 卡 C 之后
   * 这两块的目录都从它读:扫描根、事务官仓库(环境变量优先)。
   * (它同时还是「允许手机在局域网访问」那个开关的落脚点,与 2026-09-11 那一版是同一个实例。)
   */
  const appConfig = createAppConfig({ file: defaultAppConfigFile(home) })
  /** 环境变量里的事务官仓库。空串按没配算——dsh-start 里留了个空值是常见事故。 */
  const envButlerCwd = process.env.WORKBENCH_BUTLER_CWD
  /** 此刻生效的三项路径(环境变量 > app.json > 默认)。 */
  const pathsNow = async () => wbPathsEffective(
    await appConfig.get(),
    { home, ...(envButlerCwd === undefined ? {} : { envButlerCwd }) },
  )
  /**
   * 扫描根走「每次现问一遍」:Ben 在设置里改完,下一次扫描就是新值,
   * 不必重启 DSH。读盘失败(app.json 正好这一瞬间被写坏)时退回默认值——
   * 绝不因为一次读配置失败让项目区整片消失(D13:降级要能继续干活)。
   */
  const scanRootsNow = async (): Promise<readonly ScanRoot[]> => {
    try { return (await pathsNow()).scan_roots }
    catch { return DEFAULT_SCAN_ROOTS(home) }
  }

  // v5 项目区(Task 7 的 ProjectsService)：真实 fs/git deps，落盘位置与凭据同一套 ~/.dsh 目录。
  /**
   * 项目区这一格里的数据从哪来(2026-09-21,见 server/projectSource.ts)。
   *
   * **启动时一律 git**:模板服务要等 `butlerCwd` 算出来之后才建得起来(下面几十行),
   * 而这中间万一有人问一次 /state,回 git 那一份(= 现状)总比回一片空白好。
   * 接线完成之后这个函数被换成"按当前模板的 `project_source` 挑"—— 模板是运行中能换的,
   * 所以这里必须是个**每次现问的函数**,不是起服务时定下的一个值。
   */
  let projectSourceNow: () => ProjectSource | undefined = () => undefined
  /**
   * 项目区能不能去看他的目录(2026-09-23 统筹从零重装自跑:新机器一起服务就把扫描根下 13 个仓库全扫了)。
   * 起服务时先放行(= 现状,没接引导的机器一直是这样);引导与授权表建起来之后换成真门(见下面)。
   */
  let scanGateNow: () => Promise<string | undefined> = async () => undefined
  const projects = createProjectsService({
    file: defaultProjectsFile(home),
    exec: gitExec,
    listDir,
    isRepo,
    codexHome: process.env.CODEX_HOME ?? `${home}/.codex`,
    codexDeps: defaultCodexSessionSourceDeps,
    home,
    scanRoots: scanRootsNow,
    // 回 undefined = 用 projectsService 自己那份 git 数据源(现状)。
    source: () => projectSourceNow(),
    scanGate: () => scanGateNow(),
  })
  const projectsFile = defaultProjectsFile(home)
  const projectNameForRoot = async (root: string): Promise<string | undefined> => {
    const state = await projects.getProjectsState()
    const repoProject = state.projects.find(project => project.path !== undefined && normalizeDir(project.path) === normalizeDir(root))
    if (repoProject !== undefined) return repoProject.name

    const stored = await loadProjectsFile(projectsFile)
    const matchingRules = stored.rules
      .filter(rule => rule.action === 'project' && rule.projectId !== undefined && isDirectoryPrefix(rule.dir, root))
      .sort((a, b) => normalizeDir(b.dir).length - normalizeDir(a.dir).length)
    const projectId = matchingRules[0]?.projectId
    return projectId === undefined ? undefined : stored.projects.find(project => project.id === projectId)?.name
  }
  // min-interval 缓存、请求驱动，不额外起定时器——只有 GET /state 真的来问才会真采一次。
  const machine = createMachineSampler(runCommand, () => Math.floor(Date.now() / 1000))
  // 未读角标(spec §R4)：同一套 runCommand，跑 lsappinfo 而不是 df/top/sysctl；
  // 同样是请求驱动 + 5s min-interval 缓存(2026-08-26 从 60s 收紧,理由见 badges.ts)，
  // 不额外起定时器。
  const badges = createBadgesSampler(runCommand, () => Math.floor(Date.now() / 1000))
  // 系统日历(spec §R3)：走 runOsascript（带 60s 超时保护），5 分钟 min-interval 缓存——
  // 请求驱动，不额外起定时器，跟 machine/badges 同一套纪律。
  const calendar = createCalendarSampler(runOsascript, () => Math.floor(Date.now() / 1000))
  // 用量采集(2026-08-25):四家本地日志,零凭据、零网络。首轮全扫约 30 秒(实测 689MB
  // 日志 29.6s),之后按文件字节偏移增量追读(实测 122ms)——所以刷新由 http 层
  // 自己那根定时器驱动,composeState 只同步读快照,绝不 await。
  const usage = createUsageCollector({
    home,
    ...(process.env.WORKBENCH_USAGE_DIAGNOSTICS === '1'
      ? { onDiagnostic: (row: UsageScanDiagnostic) => { console.info(`[usage-scan] ${JSON.stringify(row)}`) } }
      : {}),
  })
  // 任务看板(设计稿 §3.5):落盘 ~/.dsh/workbench/tasks.json,与 projects/dock/scenes 同一个目录。
  // 没有 onChanged 回调——卡片只会因为 Ben 点了什么而变,广播由 /task/* 路由自己做。
  const tasks = createTasksService({ file: defaultTasksFile(home) })
  /**
   * 协作区(2026-10-21):老冲刺 → 目标、模块 → 目标区里的分组,**一次性**。迁之前整份账备份到
   * `tasks.json.pre-collab.json`;老字段一个不删(再留一个版本只读);回退走 `POST /collab/migrate/rollback`
   * (命令行 `workbench migrate rollback`)。没有老冲刺就一个字节都不写。迁不成不挡起服务。
   */
  void tasks.migrateToGoals()
    .then((ran) => { if (ran.goals > 0) console.log(`[协作区] 老冲刺迁成目标:${ran.goals} 个目标、${ran.tasks} 张卡挂上(备份 ${ran.backup ?? ''})`) })
    .catch((error: unknown) => { console.warn(`[协作区] 老冲刺没迁成,看板照旧:${error instanceof Error ? error.message : String(error)}`) })
  /** 个人访问令牌(2026-10-21 协作区):设置页发、命令行带;盘上只有哈希。 */
  const personalTokens = createPersonalTokens({ file: defaultPersonalTokenFile(home) })
  /**
   * GitHub 设备码登录与 MCP 库本机密钥(2026-10-21 协作区全量)。令牌 / 密钥只落本机 `~/.dsh/workbench/`,不进中转。
   * client id 从 app.json 的 `github_client_id` 或 `WORKBENCH_GITHUB_CLIENT_ID` 读;都没有 = 界面如实说「还没配 GitHub 应用」。
   */
  const githubDevice = createGitHubDevice({
    file: defaultGitHubFile(home),
    clientId: async () => {
      const fromEnv = process.env.WORKBENCH_GITHUB_CLIENT_ID
      if (fromEnv !== undefined && fromEnv.trim() !== '') return fromEnv.trim()
      try {
        const raw = JSON.parse(await readFile(defaultAppConfigFile(home), 'utf8')) as Record<string, unknown>
        return typeof raw.github_client_id === 'string' && raw.github_client_id.trim() !== '' ? raw.github_client_id.trim() : undefined
      }
      catch { return undefined }
    },
  })
  const mcpSecrets = createMcpSecrets({ file: defaultMcpSecretsFile(home) })
  /**
   * ★ **一本只追加的任务日志 + 一处动作闸**(2026-10-02,卡 AG;维护者:「网易云是一个例子,
   * 你要有机制上的调整」)。在这儿造、往下传给**每一条会去动别家 App 的管线**(派活送话 / 开窗重试 /
   * 派活盯窗 / 捎话巡检),这样全进程**只有一本账、一处判据**;判据本身在 `server/actionGate.ts`。
   *
   * 「这件事收场没有」要同步答,而看板是落盘的 —— 所以这里一张小缓存:问的时候拿缓存答,
   * 顺手踢一次异步刷新(至多 2 秒一次)。第一次问必然答「查不出」→ 放行(什么都不知道时不许拦她的活);
   * 之后最多差两秒,而盯窗那几条路本来 4~8 秒一拍,够用。
   */
  /*
   * ★ **这本账落盘了**(2026-10-02,卡 AG2):一行一条 JSON,只往末尾追加 ——
   * 重启之后 `GET /jobs/:id/trace` 还查得到。写盘坏了**不吞**:日志里一行 + `persistError()` 一直说得出,
   * 那条路由的回包原样带上(`jobLog.ts` 文件头第一条)。
   */
  const jobLog = createJobLog({ file: defaultJobLogFile(home) })
  // 读回盘上那一本(读不懂的行单独丢掉,数得出丢了几行)。读不出来不挡起服务 —— 账空着也比起不来好。
  await jobLog.load().catch(() => {})
  /**
   * ★ **电脑锁着屏时排着的那几件活**(2026-10-03,卡「锁屏时窗口型的家送不进」)。
   *
   * 2026-10-03 09:04:她在手机上给 Kimi 回了一句,电脑锁着屏 —— 窗口型的家起不出窗,
   * 那句话就那么没了。这一本把「没了」改成「等着」:**落盘**(重启不丢)、**原顺序**、
   * 她一解锁就重送(`engine/lockQueue.ts` + 下面那个 `screenLockWatch`)。
   */
  /*
   * 队里自己丢掉一条(过期 / 满了 / 重送到顶)时:派活那一条把卡上「解锁就送」摘掉(2026-10-12)。
   * 那座桥(`lockQueueDispatchNow`)只在用到时现建:摘卡只要看板,引擎与 `dispatchItem` 都是用到时才取。
   */
  const lockQueue = createLockQueue({
    file: defaultLockQueueFile(home),
    onDrop: (row, why) => {
      void (lockDispatch ??= lockQueueDispatchNow()).release(row.job, LOCK_DROP_WHY_TEXT[why]).catch(() => {})
      /*
       * ★ **等它醒那一路排着的那条过期作废**(2026-10-23,卡「捎话留言等它醒」):账上补一句
       * 「那句留言放了 12 小时它都没开」(`SESSION_CLOSED_EXPIRED_SAY` 一处)。锁屏那一路排的不带
       * `reason:'closed'`,照旧不记 —— 那是锁屏队自己的账,一字不变。
       */
      if (row.reason === 'closed' && why === 'expired') {
        jobLog.append({
          job: engineJobKey(row.job),
          step: 'not_sent',
          family: row.job.family,
          action: jobGateActionOf(row.job),
          why: SESSION_CLOSED_EXPIRED_SAY,
        })
      }
    },
  })
  let lockDispatch: LockQueueDispatch | undefined
  // 读回盘上排着的那几条(上一回锁屏时排下的;读不懂的那几条丢掉)。读不出来不挡起服务。
  await lockQueue.load().catch(() => {})
  /**
   * 「这一刻锁着屏没有」那一拍(在下面接 helper 与引擎之后才建好,走可变引用的闭包)。
   * 还没建好 / 问不到 → `undefined` = **不知道**,窗口那一层照旧送(不许把「不知道」当成「锁着」)。
   */
  let screenLockWatch: ScreenLockWatch | undefined
  /**
   * 「哪条睡着的会话醒过来了」那一拍(2026-10-23,卡「捎话留言等它醒」;同上面那把锁屏的,
   * 在下面接好锁屏队 / 引擎 / 巡检之后才建好,走可变引用的闭包)。
   * 还没建好 = 不巡(行为与这张卡之前一字不差:留言照旧躺着等她自己重说)。
   */
  let sessionAwakeWatch: SessionAwakeWatch | undefined
  /**
   * 「出门时电脑不睡」那一拍(2026-10-03;同上,在下面接好 helper / 配对 / 在线设备表之后才建)。
   * 还没建好 = 这颗开关整件事没接线 → 壳那一格缺省假,行为与 2026-10-03 之前一字不差。
   */
  let awayAwakeWatch: AwayAwakeWatch | undefined
  /** 看板上那几张卡的最近一份(只取判「收场没有」要的那几格)。 */
  let jobTasks: readonly JobKeyTask[] = []
  let jobPhaseAt = 0
  let jobPhaseLoading = false
  /**
   * 此刻认得出的那几条会话(文件型 + 窗口型登记表里那几条)。两样都在下面才建好,
   * 走可变引用的闭包;还没建好时这一格是空的 —— 会话键于是答「查不出」→ 放行(不许当收场)。
   */
  let jobSessions: (() => readonly { agent: string, session_id: string }[]) | undefined
  const actionGate = createActionGate({
    /**
     * ★ 判据**一处**:`jobKey.jobPhaseOf`(事项 id 看卡;会话键先看有没有卡认领了这条会话,
     * 再看这条会话还在不在清单上)。这里只负责「同步答得出」那一半:拿缓存答、顺手踢一次异步刷新。
     */
    phaseOf: (job) => {
      const nowMs = Date.now()
      if (!jobPhaseLoading && nowMs - jobPhaseAt >= 2000) {
        jobPhaseLoading = true
        void tasks.list()
          .then((state) => {
            jobTasks = state.tasks.map(task => ({
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
      return jobPhaseOf({ job, tasks: jobTasks, sessions: jobSessions?.() ?? [] })
    },
    log: jobLog,
    now: () => new Date(),
    name: family => sessionAgentName(family),
    // ★ 计数落盘、六小时过期(2026-10-21,卡「派活按家隔离」):重启不丢,也不永久封;「重置这一家」清那一家。
    store: createGateFileStore(defaultGateFile()),
  })
  /**
   * 负责人是真的(2026-09-25,卡 N):0.2.88–0.2.98 引导落地建的卡,「你 / 同事 / 别人」只写在描述第一行、
   * 负责人那一格缺席。起服务时补一次 —— 只补缺席的(他改过的一格不碰),认不出那一行就不补。后台做,不挡起服务。
   */
  void (async () => {
    try {
      for (const task of (await tasks.list()).tasks) {
        if (task.assignee !== undefined || task.origin !== 'onboarding') continue
        const owner = ownerFromDesc(task.desc)
        if (owner === undefined) continue
        await tasks.update(task.id, { assignee: owner.assignee, ...(owner.note === undefined ? {} : { assigneeNote: owner.note }) })
      }
    }
    catch { /* 补不上就算了:卡照旧在,只是负责人那一格还空着 */ }
  })()
  /** 进度核对(2026-09-25,卡 N)。早报的钩子在它造出来之前就要挂,所以先占个位。 */
  let progress: ProgressService | undefined

  const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
  // 窗口编排(spec W1–W9):壳通道 + 贴合编排 + 场景。壳没连上时界面按 D13 显示「未接入」。
  // version:壳据服务端 hello 里的版本号判断插件换版后要不要重载页面(2026-09-14)。
  const helper = createHelperChannel({ version: PLUGIN_VERSION })
  // 窗口槽应用清单(spec S4):可增删的自定义应用,落盘 ~/.dsh/workbench/apps.json。
  // 贴合(orchestrator)与场景保存/恢复(scenes)都要认得自定义应用,同一份 registry 分别注入。
  /**
   * 钩子脚本随插件走(2026-09-25,卡 R):**每次起服务**把包里那两个脚本同步到固定位置
   * `~/.dsh/workbench/hooks/`(内容有变才覆盖,hookScripts.ts)。已经写进各家配置的命令只指这个位置,
   * 所以插件升级之后照样有效。不找开发仓库、不看 butler_cwd。
   * 放不成**不拦起服务**:这里只记一行;「接上」那一步会再试一次,还不成就回一句人话。
   * 必须在探测(clientScan)之前:「接上没有」要看这里的脚本在不在。
   */
  const hookScripts = createHookScripts({ home, moduleDir: fileURLToPath(new URL('.', import.meta.url)) })
  const hookScriptsAtStart = await hookScripts.ensure()
  if (!hookScriptsAtStart.ok) console.log(`[钩子] 起服务时没放好钩子脚本(${hookScriptsAtStart.reason}):${hookScriptsAtStart.detail}`)
  else if (hookScriptsAtStart.changed.length > 0 || hookScriptsAtStart.stale.length > 0) {
    console.log(`[钩子] 钩子脚本在 ${hookScriptsAtStart.dir}:换了 ${hookScriptsAtStart.changed.join('、') || '0 个'}`
      + `${hookScriptsAtStart.stale.length > 0 ? `;没换成、先用原来那份的:${hookScriptsAtStart.stale.join('、')}` : ''}(来源 ${hookScriptsAtStart.from})`)
  }
  /**
   * 各家客户端扫到没有、接上没有(2026-09-17「每个区域单独解锁」)。
   *
   * **在 registry 之前建**:窗位清单的默认值要读它(没扫到的那家默认不出现)。
   * 用的是登录台那一套 I/O(nodeSetupIo)与路径表(setupPaths)——探测只有这一份,
   * 体检页与看板问的是同一个人。Claude / Codex 的钩子要指着固定位置上那个脚本才算接上(卡 R):
   * 指着旧位置(开发仓库)的,界面会请他点一次「全部接上」换过来。
   */
  const hookFilePaths = setupPaths({ home, ...(envButlerCwd === undefined || envButlerCwd === '' ? {} : { repoRoot: envButlerCwd }) })
  const clientScan = createClientScan({
    io: nodeSetupIo(),
    paths: hookFilePaths,
    ...(hookScripts.hookScript === undefined ? {} : { hookScript: hookScripts.hookScript }),
    now: () => Date.now(),
  })
  /**
   * **本机装了哪几家 AI**(2026-09-27,卡 HC「不写死各家 AI」)。
   *
   * 「有哪几家该出现在界面上」的唯一出处:`/state.agents`、额度、派活对象、窗口槽、引导都读它。
   * 候选表自己从 `FAMILY_SOURCES` 长出来(有包标识的每一条),所以新写一家专门读法时这里不用改。
   */
  const installedAgents = createInstalledAgentScan({
    io: nodeSetupIo(),
    now: () => Date.now(),
    /**
     * 候选还要带上**登记表里判过是 Agent 的那几条**(2026-09-27 晚的回归):真机上 Antigravity 与
     * Grok Bot 是运行中被发现的、不在知识表里,头一版因此没报它们 —— 而「本机有哪几家」是唯一出处。
     *
     * 转发闭包(同 `pushSnapshot` / `isFirstRun` 那套"先占位后接线"):`agentDiscovery` 在下面
     * 才创建,而这一份只在真扫一轮时才被叫到,那时它早就有了。没接发现引擎的宿主一律空数组。
     */
    registryApps: () => {
      try {
        return agentDiscovery?.view().entries.map(one => ({
          id: one.id,
          ...(one.bundle_id === undefined ? {} : { bundle_id: one.bundle_id }),
          name: one.name,
          ...(one.self === true ? { self: true } : {}),
        })) ?? []
      }
      catch { return [] }
    },
  })
  /**
   * 模型从哪儿来(`~/.dsh/workbench/model.json` 的 mode,归 feat/model-relay 那张卡所有)。
   * 文件不存在就一直是 undefined,额度面板照今天的逻辑渲染 —— 这里只读,不建、不写。
   */
  const modelMode = createModelModeReader({
    readFile: async (file) => { try { return await readFile(file, 'utf8') } catch { return undefined } },
    file: defaultModelFile(home),
    now: () => Date.now(),
  })
  /**
   * 「第一次用」这一档(2026-09-18)。**与网页那边同一份真相**:引导阶段机里的 `done`
   * (网页读的是 /state.onboarding.done,见 client/emptyState.ts 的 isFirstTime)。
   *
   * 刻意不看 `first_run_done_at`:那面旗子跳过也会写,而 Ben 正是点了跳过才掉进这次反馈里。
   * 没接引导服务(没配 WORKBENCH_BUTLER_CWD)时一律回 false —— 那台服务本来就没有引导可走,
   * 不该被按在"首次"里。`onboarding` 在下面才创建,这里是转发闭包(同 pushSnapshot /
   * sendObserveTargets 那套"先占位后接线"的手法,调用发生在服务起来之后)。
   */
  const isFirstRun = (): boolean => onboarding !== undefined && !onboarding.view().done
  const registry = createAppsRegistry({
    file: defaultAppsFile(home),
    runOsascript,
    // 默认值随探测走:没扫到的那家不进清单(Ben:「没装的那家不显示、不催」)。
    // 他亲手加过 / 删过的照旧 —— 三张名单的优先级写在 appsRegistry.ts 的 baseKeyVisible。
    // 卡 HC(2026-09-27):AI 那几家的探测在 installedAgents 那一份(开集,含豆包办公 / Muse / Manus)。
    // 两份并起来 —— 老五家照旧走 clientScan(它还要回答「接上没有」),AI 那几家的「装没装」以探测为准。
    // 两份都没探出来(都 undefined)才回 undefined:那是「没查过」,清单退回全都显示。
    installedKeys: () => {
      const base = clientScan.installedKeys()
      const ai = installedAgents.installedIds()
      if (base === undefined && ai === undefined) return undefined
      return new Set<string>([...(base ?? []), ...(ai ?? [])])
    },
    // 第一次用:默认一个都不出现,他亲手加过的(enabled)才有 —— 见 baseKeyVisible。
    firstRun: isFirstRun,
  })
  const orchestrator = createOrchestrator({ helper, runCommand, sleep, registry })
  const scenes = createScenesService({
    file: defaultScenesFile(home), helper, runCommand, sleep, registry,
    // 程序化激活抑制(2026-09-09):场景恢复是我们发起的激活,先给窗位叠打标记。dock 在下面
    // 才创建,这里只是转发闭包(调用发生在 restore 时,那时 dock 早就有了,同 pushSnapshot 手法)。
    onBeforeActivate: app => dock.noteActivated(app),
  })
  // 窗位叠(spec 2026-08-24 窗位叠 v2 V1–V6):认领/整理/拖出/切换/放出全部服务端决策,
  // 落盘 ~/.dsh/workbench/dock.json。onChanged 复用 pushSnapshot 这个可变引用——
  // 跟 collector.onUpdated 同一手法,此刻服务还没起,pushSnapshot 是个空函数,
  // 真正的推送要等下面 `pushSnapshot = () => running?.broadcastState()` 赋值之后才生效。
  const dock = createDockService({
    file: defaultDockFile(home),
    helper,
    registry,
    runCommand,
    sleep,
    onChanged: () => pushSnapshot(),
    // A2(b):自愈注册成功后重发一次 observe 订阅集合——sendObserveTargets 定义在下面,
    // 这里先留一个转发闭包,真正的函数赋值在其后完成(闭包调用发生在注册成功之后,
    // 那时 sendObserveTargets 早就有定义了,跟 pushSnapshot 同样的"先占位后接线"手法)。
    onAppRegistered: () => sendObserveTargets(),
    // 第一次用:没认领过的应用只认真实拖拽,程序化移动一律不认领 —— 见 DockOptions.firstRun。
    firstRun: isFirstRun,
    // 起来之后把 current 摆回窗位(2026-09-25,卡 fix/slot-current-empty):插件重载 / 壳重启后
    // 窗口槽停在某个标签、槽里却是空的 —— 见 DockServiceOptions.keepCurrentInSlot。
    keepCurrentInSlot: true,
    // 他 ⌘Tab / 点程序坞真切到窗口槽里的某一家(普通窗口待满 1.5 秒)→ 窗口槽跟过去(2026-09-25,卡 P)。
    // 截图遮罩 / 划词浮窗这类「临时叫一下」不跟、并把放出来的那家藏回去 —— 那一半不看这个开关。
    followActivation: true,
  })
  // 今晨快报(W4):接 AiDJ 电台的今日资讯,触发规则写死在服务端(见 brief.ts 头部注释)。
  // 落盘 ~/.dsh/workbench/brief.json,与 dock/scenes/apps 同一套目录规格。
  // 往外连的几条地址(endpoints.json,2026-10-21):默认不变,可换可关,见 server/endpoints.ts。
  const endpoints = loadEndpoints(home)
  const brief = createBriefService({ file: defaultBriefFile(home), baseUrl: endpoints.aiboo_url ?? null })
  // 随手记(PRD §5.5,2026-08-25 版面重排起落盘)。纯文件服务,不需要壳/registry 那一套依赖,
  // 落盘 ~/.dsh/workbench/notes.json(与 dock.json/scenes.json 同目录同规格)。
  const notes = createNotesService({ file: defaultNotesFile(home) })

  // Claude 会话恢复(2026-09-02):hook 是推送、会话表只在内存里,重启前就在跑的会话
  // 要等下一次 hook 才会重现——真机现场:Ben 两个 Claude 会话在跑,标签一个气泡都没有。
  // 只捞"正在干活"的,已收尾的不回放;hook 已经在管的一概不碰(理由见该文件顶部)。
  //
  // 2026-09-25(卡 P)起是「跟着读」:没接 hook 的机器上 Claude 会话的状态、标题、最近在做什么都从这里来;
  // hook 在管的会话(收到过它的 hook 事件,见下面 claudeHooked)只补标题与在做什么。
  // 各家读到的会话文件都登记进 sessionDigest —— 点开一条会话(GET /sessions/digest)时按会话 id 找文件。
  const sessionDigest = createSessionDigestService({
    sessions: () => service.getState().sessions,
    // ★ 登记表里没有就按 id 去各家目录找(2026-10-13 夜,卡 W):重启后他要接着说的那条不该 404。
    // `sessionHistory` 在下面才建(它反过来要读这张登记表),这里只在点开时才调,那时早就建好了。
    locate: async (agent, sessionId) => await sessionHistory.locate(agent, sessionId),
  })
  // 手机「最近的对话」(2026-10-01):从各家的记录文件读最近 7 天,关掉的也列;窗口型那几家取登记表里那一条。
  const historyKimi = createKimiConversationReader({ dbPath: defaultKimiConversationsDb(home) })
  const sessionHistory = createSessionHistory({
    claudeHome: `${home}/.claude`,
    codexHome: process.env.CODEX_HOME ?? `${home}/.codex`,
    kimiConversations: () => historyKimi.lookup(),
    registered: () => sessionDigest.files(),
    liveSessions: () => service.getState().sessions,
    windowSessions: () => (agentDiscovery?.view().entries ?? []).flatMap(entry => entry.sessions.filter(registryOnlySession)),
    claudeNames: async () => {
      const live = await readClaudeLiveSessions(`${home}/.claude`)
      if (live === undefined) return undefined
      const names = new Map<string, string>()
      for (const [id, one] of live) if (one.name !== undefined) names.set(id, one.name)
      return names
    },
    resolveProject: cwd => resolveCodexProject(cwd, { gitCommonRoot, projectNameForRoot }),
  })
  // 点开一条对话看完整内容(往上翻分页):按 id 找记录文件,先认登记过的,再按各家目录找。
  // 对话里的附件(她贴的图、它的截图、提到的本机文件):只认这条会话里出现过的,转换在这台 Mac 上做。
  const sessionAttachments = createSessionAttachments({ locate: (agent, id) => sessionHistory.locate(agent, id) })
  const sessionTranscript = createSessionTranscript({
    locate: (agent, id) => sessionHistory.locate(agent, id),
    attachmentsOf: sessionAttachments.hitsOf,
  })
  /** 收到过 hook 事件的 Claude 会话 —— 状态听 hook 的(它能分出「等你批准」)。只在内存:重启后等它下一条 hook。 */
  const claudeHooked = new Set<string>()
  const claudeRecover = createClaudeSessionRecover(
    defaultClaudeSessionRecoverDeps(`${home}/.claude`),
    {
      applyEvent: (event) => {
        service.applyEvent(event)
        pushSnapshot()
      },
      setDetail: (sessionId, detail) => {
        if (service.setSessionDetail('claude', sessionId, detail)) pushSnapshot()
      },
      onFile: (sessionId, file, name) => sessionDigest.note('claude', sessionId, file, 'claude-transcript', name),
      knownSessionIds: () => [...claudeHooked],
      resolveProject: cwd => resolveCodexProject(cwd, { gitCommonRoot, projectNameForRoot }),
      // 钩子与文件矛盾时记一行(2026-09-25,卡 V):`[会话状态] claude/<id> 钩子在管,但文件说「…」`。
      log: line => console.log(line),
      // 卡 T:第一次见就说完了的会话照旧不回放 —— 在等他的例外(重启之后「在等你」不能看不见)。
    },
  )

  // 日结(PRD 5.7,2026-09-02 Ben 拍板:早 9 点生成昨天的)。素材全部复用现成的口子:
  // 项目线=项目区同一批扫描根,提交数=gitExec 现查,用量=collector 的按天投影,
  // 点子=随手记。生成在 daily.ts 内部走后台,这里只是接线。
  const daily = createDailyService({
    file: defaultDailyFile(home),
    usageDays: () => {
      const view = usage.view()
      return 'error' in view ? undefined : view.days
    },
    listNotes: () => notes.list(),
    // 「项目区同一批扫描根」这句话现在是字面意思:2026-09-17 起两边都问同一个 scanRootsNow。
    listRepos: async () => {
      const out: string[] = []
      for (const root of await scanRootsNow()) {
        try {
          out.push(...await findRepos(root, listDir, isRepo))
        }
        catch {
          // 单个扫描根读不了不拦别的根,先例见 projectsService.build。
        }
      }
      return out
    },
    // 峰谷两笔来自落盘账簿。那天没记过(工作台没在跑、或没填 Key)就返回 undefined,
    // 日结据此整节缺席——拿不到就留空,绝不编数。
    deepseekSpend: date => spendLedger.get(date),
    /*
     * 那天撞上限停下来问她的那几条(2026-10-04,卡「事务官上限只看钱」第 3 条)。
     * 素材就是现成的那本任务账(`jobLog`),按**本地日**切天(同日结别处),**不另起一个数据库**。
     */
    budgetStops: date => jobLog.all()
      .filter(one => one.step === 'budget_stop' && localDateStr(Date.parse(one.at)) === date)
      .map(one => ({
        ...(one.kind === undefined ? {} : { kind: one.kind }),
        ...(one.action === 'money' || one.action === 'time' ? { line: one.action } : {}),
      })),
    countCommits: async (repoPath, sinceIso, untilIso) => {
      const res = await gitExec(['log', '--oneline', `--since=${sinceIso}`, `--until=${untilIso}`], repoPath)
      if (!res.ok) return undefined
      return res.stdout.split('\n').filter(line => line !== '').length
    },
  })

  // 布局快照(2026-09-10,记忆第一族「工作台长什么样」):每天「下班」时刻把 /state 里的
  // 布局落成一份 md + 一份 html 骨架,放 ~/.dsh/workbench/snapshots/,保留 14 天。事务官的
  // 下班例程直接拿这一份,不再手抄。时刻可配(WORKBENCH_OFFWORK_AT,本机时区 HH:MM,
  // 默认 18:30);节拍挂在 http.ts 那根既有的 1 秒 tick 上,这里不起任何定时器。
  const layoutSnapshot = createLayoutSnapshotService({
    dir: defaultLayoutSnapshotsDir(home),
    ...(process.env.WORKBENCH_OFFWORK_AT === undefined
      ? {}
      : { offWorkAt: process.env.WORKBENCH_OFFWORK_AT }),
  })

  // 哨兵(2026-09-09,借鉴 dsh-sentinel 的设计,不装它):file/http/process/port 四类传感器,
  // **command 类不做**(审计结论,理由见 server/sentinel.ts 顶部)。落盘
  // ~/.dsh/workbench/sentinel.json,与 dock/notes/tasks 同一套目录规格。
  // 探测节拍挂在 http.ts 那根既有的 1 秒 tick 上,这里不起任何定时器;真实探针复用
  // 上面那个不带 cwd 的 runCommand(只跑 pgrep,不拼 shell 行)。
  const sentinel = createSentinelService({
    file: defaultSentinelFile(home),
    deps: defaultSentinelDeps(runCommand),
  })
  await sentinel.load()

  // 事务官的日常例程(2026-09-15):开工汇报 / 下班例程 / 每周知识 lint。开关与时间在
  // ~/.dsh/workbench/routines.json,最近一次的结果在 routines-state.json(重启不重跑)。
  // 记忆仓库:routines.json 的 repo,没写就用 WORKBENCH_BUTLER_CWD(事务官会话本来就开在那里);
  // 两个都没有就汇报少一句、下班例程只开会话不写文件——**不猜路径**(同 createButlerSessionOpener)。
  // 定时挂在 http.ts 那根既有的 1 秒 tick 上;composeState 由 http.ts 起服务时接上(attach)。
  // 2026-09-17(卡 C 第 3 条):环境变量优先,其次 app.json 的 butler_cwd。**启动时读一次**——
  // 例程/引导/授权三块都是在这里按它接线的,运行中改 app.json 要 kickstart 重启才切得过去
  // (PUT /config/paths 会如实回 restart_required: true,见 http.ts 那条路由与 docs/交接-0917-路径可配.md)。
  const butlerCwd = (await pathsNow()).butler_cwd
  // 事务官会话通道那一侧现在也认 app.json(上面 butlerCwdNow 的注释说明了两者的区别)。
  butlerCwdNow = butlerCwd

  /**
   * 用户层(2026-10-21,卡「分层第一刀」;`server/userLayer.ts`)。本体认用户层只有这一个加载口:
   * 起服务时把骨架补齐;**第一次**建这个目录时放进随安装包带来的起步层(运营同学那六格,
   * 构建时从仓库 `user-layer/起步/` 拷进 `lib/starter-layer/`),之后那个目录归她,本体一个字不动。
   * 网页小组件(沙箱)也住进来:老位置 `modules/` 在就整个搬进 `用户层/网页小组件/`。
   * 建不起来(盘满、权限)只记一笔,工作台照常起 —— 那几格退回本体自带的。
   *
   * 2026-10-23(分层二刀二):布局模板(`布局/*.json`)也从这个服务出。它**必须先于**
   * 布局模板服务建出来 —— 下面的模板来源(setWorkbenchTemplateSource / templates provider)
   * 读的是它。
   */
  const userLayer = createUserLayerService({
    dir: defaultUserLayerDir(home),
    starterDir: fileURLToPath(new URL('./starter-layer/', import.meta.url)),
    legacyModulesDir: defaultModulesDir(home),
    runCommand: cmd => runCommand(cmd),
    // 修复交回越界守门(2026-10-23,卡「分层自愈完善」):本体目录 = 插件自己的安装目录。
    bodyDir: fileURLToPath(new URL('.', import.meta.url)),
  })
  try {
    const made = await userLayer.ensure()
    if (made.created) console.log(`[用户层] 建了 ${userLayer.dir},放进起步层:${made.seeded.join('、') || '无'}`)
    if (made.seededLayouts.length > 0) console.log(`[用户层] 布局起步层放进 ${userLayer.dir}:${made.seededLayouts.join('、')}`)
    if (made.movedLegacyModules) console.log(`[用户层] 网页小组件从 modules/ 搬进了 ${userLayer.webWidgetsDir}`)
    if (made.note !== undefined) console.log(`[用户层] ${made.note}`)
  }
  catch (error) { console.log(`[用户层] 骨架没建起来:${(error as Error).message}`) }

  /**
   * 偏好的一次性迁移(2026-10-26,卡「用户层切割收尾」):rules.json / prompt-overrides.json(+日志)/
   * dispatch-prefs.json 从 `~/.dsh/workbench/` 搬进 `用户层/偏好/`。只拷不挪、幂等、逐份终态(`.迁过`
   * 里记名)—— 她删过的不复活;坏内容原样拷、读它的服务自己兜底;**真实失败(盘满/权限)不记终态,
   * 下次启动再试**,日志如实说,不谎称已迁。必须排在下面 promptOverrides / rules / dispatchPrefs
   * 三个服务**之前**(它们一建出来读的就是新位置)。
   */
  try {
    const moved = await migrateLegacyFilesOnce(join(userLayer.dir, '偏好'), legacyPrefsMoves(home, join(userLayer.dir, '偏好')))
    if (moved.copied.length > 0) console.log(`[用户层] 偏好从老位置一次性搬进 ${userLayer.dir}/偏好:${moved.copied.join('、')}(老文件还在、不再读)`)
    // 真实失败(盘满/权限那类)不谎称已迁:留 pending,下次启动再试;她的规矩不会在没迁成时悄悄消失。
    if (moved.failed.length > 0) console.log(`[用户层] 偏好这几份没迁成,下次启动再试:${moved.failed.join('、')}`)
    if (moved.markerError !== undefined) console.log(`[用户层] 偏好迁移:${moved.markerError}`)
  }
  catch (error) { console.log(`[用户层] 偏好迁移没跑成:${(error as Error).message}`) }

  /**
   * 模板来源(2026-10-23,分层二刀二):本体自带 product,其余从用户层 `布局/*.json` 读。
   * 深调用方(onboardingStages / productFeedback / http)拿不到服务实例,走 templates.ts
   * 这个一次性注册;source 是同步签名,读的是用户层服务每拍 scan() 刷新的那份快照
   * (先 scan 一次打底,之后 /state 每拍先扫后读,她改文件下一拍生效)。
   */
  try { await userLayer.scan() }
  catch { /* 扫不动就算了:此刻没有用户层模板,只有 product。 */ }
  setWorkbenchTemplateSource({
    all: () => [PRODUCT_TEMPLATE, ...userLayer.layoutTemplates()],
    byId: (id: string) => (id === PRODUCT_TEMPLATE.id ? PRODUCT_TEMPLATE : userLayer.layoutTemplate(id)),
  })

  // 事务官技能(记忆 / 引导 / 例程 / 截图验收)的同步在用户层服务建好之后(见下面 userLayer 那一块):
  // 用户层「技能」格里的那几件要走同一趟装进她的工作目录(2026-10-22,卡「用户层技能生效」C)。
  // 布局模板(2026-09-21)。**必须在 butlerCwd 算出来之后建** —— 建文件夹与素材那几个
  // 绝对路径都要它;没配工作目录时这两件整块缺席(不猜路径)。
  // 模板清单(2026-10-23,分层二刀二)从用户层服务的快照直读,与上面注册的全局来源是同一份。
  const template = createTemplateService({
    file: defaultTemplateFile(home),
    backupsDir: defaultTemplateBackupsDir(home),
    readLayout: () => projects.getLayout(),
    writeLayout: layout => projects.setLayout(layout),
    // 同步取值:读的是启动时算好的那一份(改 app.json 要 kickstart 才切,同 routines)。
    butlerCwd: () => butlerCwd,
    templates: () => userLayer.layoutTemplates(),
    enableApps: keys => registry.enable(keys),
    registerApp: info => registry.addResolved(info),
    // 切模板 = 可能换了数据源,扫描缓存当场作废(否则项目区最多要等一个节流周期 30 秒,
    // 那 30 秒里显示的还是上一个数据源扫出来的东西,看着像"切了没生效")。
    onApplied: () => projects.invalidateScanCache(),
  })
  await template.load()

  /**
   * 自定义模块容器(2026-09-21)。模块落 `~/.dsh/workbench/modules/`,待确认的需求落
   * `dev-tools.json` —— 与布局、模板、随手记同一个目录,同一条"用户数据在 ~/.dsh 里"的规矩。
   *
   * **`sketch` 端口这一版没接**:插件里现在没有任何一条"问一次模型"的通路,现造一条
   * 要碰凭据(model.json 里那个令牌),那是另一张卡的事。没接 = 确认卡上没有草图那一行,
   * 界面如实说一句 —— 不拿一句模板话冒充草图(D13)。
   */
  const modules = createCustomModulesService({ dir: userLayer.webWidgetsDir })
  /**
   * 事务官自己的技能(记忆 / 引导 / 例程 / 截图验收)装进她的工作目录(2026-09-25,卡 fix/evening-gaps 第 4 条)。
   * 以前只在开发仓库里有:她会话里那句「按 .dsh/skills/记忆/SKILL.md 查」在维护者机器上读不到。
   * 每次起服务同步一遍(新装装上、热更新之后升级、她改过的不动),**不等它**;理由与规矩见 server/butlerSkills.ts。
   * 用户层「技能」格里的那几件走同一趟(2026-10-22,卡「用户层技能生效」C;规矩不同:用户层是源头,不同就换)。
   */
  const syncButlerSkillsInto = (dir: string | undefined): void => {
    if (dir === undefined || dir === '') return
    void (async () => {
      const userSkills = await scanUserLayerSkills(join(userLayer.dir, '技能')).catch(() => [] as UserLayerSkill[])
      return await syncButlerSkills({ workDir: dir, manifestFile: defaultButlerSkillsManifest(home), io: nodeButlerSkillsIo(), userSkills })
    })()
      .then(outcome => console.log(`[技能] ${outcome.note}`))
      .catch(() => { /* syncButlerSkills 自己不抛 */ })
  }
  syncButlerSkillsInto(butlerCwd)
  const devToolStore = createDevToolStore({ file: defaultDevToolFile(home) })
  await devToolStore.load()

  /**
   * 她改过的提示词(2026-10-01,卡「设置里集中改提示词」;`server/promptOverrides.ts`)。
   *
   * 一张覆盖表落在**用户层**里(`~/.dsh/workbench/prompt-overrides.json`,永不上传、永不合并),
   * 装进这个进程之后,**所有**往 `~/.dsh/AGENTS.md` 写标记段的路写之前都会先问它一句:
   * 引导重跑(`onboarding.writeAgents`)、规矩表同步、进化固化技能、「接上派活技能」、
   * 切模板与发版重写那十几段、电话里往「称呼」追一条 —— 腰眼在 `wbSkillMergeInto`。
   *
   * **顺序要紧**:装在 `evolve` / `rules` / 起服务补技能**之前** —— 那几下都会写 AGENTS.md,
   * 装晚一拍她改过的那一段就会被这一次启动冲掉。
   */
  const promptOverrides = createPromptOverrideStore({
    file: defaultPromptOverridesFile(home),
    logFile: defaultPromptOverridesLogFile(home),
  })
  await promptOverrides.load()
  /**
   * 迁移 10-01 那一版她改过的**技能正文**(2026-10-02,卡「提示词页改成她的偏好页」)。
   *
   * 技能正文从此归本体(发版重写),她改的是那个环节的偏好。所以起服务这一下先把旧的那几段
   * 正文覆盖转成偏好条目;拆不成条目的原样留着、页面上提示一次 —— **不许静默丢**。
   * 幂等,跑过一次之后技能段一条正文覆盖都不剩。排在 `installPromptOverrides` **之前**:
   * 装上之后紧接着的起服务补技能那一下就会按新的偏好写,不会先写一遍旧正文。
   */
  await promptOverrides.migrateSkillBodies()
  installPromptOverrides(promptOverrides)
  const prompts = createPromptsService({
    store: promptOverrides,
    agentsFile: defaultAgentsFile(home),
    deps: { io: nodeSetupIo(), now: () => new Date() },
    // 这个模板下该有哪几段技能:还没接上的也列出来(界面上那一行说"还没接上")。
    // 环节名与例子跟着技能定义走(`opsSkills.ts` 的 `stage`),界面里不写第二份清单。
    skills: () => opsSkillsForTemplate(template.currentId()).map(one => ({
      name: one.name,
      summary: one.summary,
      ...(one.stage === undefined ? {} : { stage: one.stage }),
    })),
  })

  /**
   * 进化循环(2026-09-22,卡 ⑥;设计文档 §五)。四个口全在这里接:
   *
   * - `says`  她说过的话 ← **事项台账**(`direction:'mine'` 的卡)。为什么不读会话回合:
   *   `GET /butler/item/:id/turns` 那一份只活在 DSH 的内存里(重启就没),而这里要的是
   *   **近 14 天** —— 只有 tasks.json 真的留得住那么久。卡里那句「同一类事项建了三次以上」
   *   说的正是这一份。
   * - `skill` ← 代写技能那一套(备份 → 换段 → 写回),**没碰 opsSkills.ts 一个字**:
   *   固化出来的那几段不在那份清单里,它们走的是同一把刀的通用那一面。
   * - `tool`  ← 现有「开发一个小工具」链路的待确认仓。**预填,不自动发** ——
   *   那条链路自己还有一道「我理解的是…,它叫什么?」的门。
   * - `io`    ← node fs。**路径全是注入的**(2026-09-04 事故纪律)。
   *
   * 仓根没找到(装好的 tgz 且没配工作目录)时 `repo` 缺席 —— 技能那条路当场如实拒绝,
   * 别两条路照走。
   */
  const evolveRepo = await wbHooksResolveRepoRoot({
    moduleDir: new URL('.', import.meta.url).pathname,
    ...(butlerCwd === undefined || butlerCwd === '' ? {} : { butlerCwd }),
    exists: async (file: string) => { try { await stat(file); return true } catch { return false } },
  })
  const evolveStore = createEvolveStore({ file: defaultEvolveFile(home) })
  const evolve = createEvolveService({
    store: evolveStore,
    ...(butlerCwd === undefined || butlerCwd === '' ? {} : { workdir: butlerCwd }),
    ...(evolveRepo === undefined ? {} : { repo: evolveRepo.root }),
    io: {
      readFile: async (file) => { try { return await readFile(file, 'utf8') } catch { return undefined } },
      writeFile: async (file, text) => {
        await mkdir(dirname(file), { recursive: true })
        await writeFile(file, text, 'utf8')
      },
      removeFile: async (file) => { try { await rm(file); return true } catch { return false } },
    },
    // 2026-09-25:只数他亲口交代的、只用他那句原话(server/evolveSays.ts 文件头写了为什么)。
    says: async () => userSaysOf((await tasks.list()).tasks),
    spoken: async () => userSpokenOf((await tasks.list()).tasks),
    skill: {
      apply: async (name, body) => {
        const done = await wbSkillApply(
          { io: nodeSetupIo(), now: () => new Date() },
          { file: `${home}/.dsh/AGENTS.md`, name, body },
        )
        return done.ok ? { ok: true } : { ok: false, error: done.error }
      },
      revert: async (name) => {
        const done = await wbSkillRevert(
          { io: nodeSetupIo(), now: () => new Date() },
          { file: `${home}/.dsh/AGENTS.md`, name },
        )
        return done.ok ? { ok: true, removed: done.removed } : { ok: false, error: done.error }
      },
    },
    // 偏好那一截(2026-09-23):把关记录从每条选题的 `审核记录.jsonl` 读;没配工作目录 = 这一截不动。
    ...(butlerCwd === undefined || butlerCwd === ''
      ? {}
      : { reviews: async () => readAllTopicReviews(join(butlerCwd as string, TOPIC_DIR)) }),
    tool: async ({ request, restate }) => {
      const added = await devToolStore.add({
        id: randomUUID(),
        request,
        restate,
        module_id: newModuleId(),
        created_at: new Date().toISOString(),
      })
      return added.ok ? { ok: true } : { ok: false, ...(added.error === undefined ? {} : { error: added.error }) }
    },
  })
  await evolve.load()
  // 已经摆着的提议里,靠系统写的话凑出来的那几条当场撤下(2026-09-25,见 says / spoken 的注释)。
  await evolve.revalidate?.().catch(() => undefined)

  /**
   * 他的规矩(2026-09-24 晚,卡 K)。一张表 `~/.dsh/workbench/rules.json`,表一变就同步进
   * `~/.dsh/AGENTS.md` 的「规矩」段(wbSkillApply:段外一个字不动、写前备份、能撤)——
   * 每条新 DSH 会话第一次请求就带着。电话人设(channel.rulesBlock)、派活(/dispatch/*)、
   * 交回来自查(/butler/item/dispatch)、会话答完进不进「等我确认」(heldBack)都读这一张表。
   * 选题卡偏好(evolve 那一截)只读投影进来:设置里那张表看得全,撤那几条还走进化循环。
   */
  const rulesAgentsIo = { io: nodeSetupIo(), now: () => new Date() }
  const rules = createRulesService({
    file: defaultRulesFile(home),
    agents: {
      apply: async (body) => {
        const done = await wbSkillApply(rulesAgentsIo, { file: `${home}/.dsh/AGENTS.md`, name: RULES_BLOCK, body })
        return done.ok ? { ok: true } : { ok: false, error: done.error }
      },
      revert: async () => {
        const done = await wbSkillRevert(rulesAgentsIo, { file: `${home}/.dsh/AGENTS.md`, name: RULES_BLOCK })
        return done.ok ? { ok: true, changed: done.removed } : { ok: false, error: done.error }
      },
    },
    topicPreferences: () => (evolve.view().preferences ?? []).map(pref => ({
      id: pref.id, text: pref.text, status: pref.status, adopted_at: pref.adopted_at,
      ...(pref.verdict === undefined ? {} : { verdict: pref.verdict }),
    })),
    ...(butlerCwd === undefined || butlerCwd === ''
      ? {}
      : {
          // 「观察」那几条在事务官记忆 `docs/记忆/用户-*.md` 里(引导按称呼起的名字,通常只有一份)。
          observations: async () => {
            const dir = join(butlerCwd as string, 'docs', '记忆')
            const names = (await readdir(dir)).filter(name => name.startsWith('用户-') && name.endsWith('.md')).sort()
            return names[0] === undefined ? undefined : await readFile(join(dir, names[0]), 'utf8')
          },
        }),
  })
  await rules.load()
  // 启动时同步一次:没变就不写、不备份;表是空的且 AGENTS.md 里没有这一段就什么都不做。
  void rules.sync().then((done) => {
    if (!done.ok) console.log(`[规矩] 没同步进 AGENTS.md:${done.error ?? '原因不明'}`)
  })
  /**
   * 引导里说的分工进规矩表(2026-09-25,卡 O)。落地那一刻会做(单子上「派活分工」那一行);**这功能出现之前就已经
   * 引导完、落过地的**,启动时补一次 —— 以后每个用户都自动有,不靠统筹手加。表里已经有同标题的(统筹那条)只多记一条
   * 依据、不改字;他删过的不再加。引导没做完不动。
   */
  void (async () => {
    try {
      const archive = JSON.parse(await readFile(defaultOnboardingFile(home), 'utf8')) as { stage?: unknown, answers?: unknown }
      if (archive.stage !== 'done' || typeof archive.answers !== 'object' || archive.answers === null) return
      const division = divisionFromArchive(archive.answers, extraProjects(archive as unknown as MaterializeArchive))
      const text = division === undefined ? undefined : divisionRuleText(division)
      if (text === undefined) return
      const other = ((archive.answers as { habits?: { other?: unknown } }).habits?.other)
      const said = typeof other === 'string' ? other.slice(0, 240) : text
      const adopted = await rules.adoptTitled({ title: DIVISION_TITLE, text, said })
      if (adopted.added) console.log(`[规矩] 引导里的分工补进规矩表:${text}`)
    }
    catch { /* 没引导过 / 存档读不出来:什么都不做 */ }
  })()


  /**
   * 用自然语言改布局(2026-09-22,「非标需求由事务官直接改」第一层)。待确认的那几条
   * 落 `~/.dsh/workbench/layout-asks.json` —— 与布局、模板、随手记同一个目录。
   *
   * 快照/回退**不另起一份**:走上面那个 `template` 服务的备份栈(见 templateStore.snapshotLayout)。
   */
  const layoutAskStore = createLayoutAskStore({ file: defaultLayoutAskFile(home) })
  await layoutAskStore.load()

  /**
   * 账号数据源(2026-09-21):运营模板下项目区读工作目录下的 `账号/<名>/`。
   *
   * 「还有几件在办」问的是看板:按**项目 id** 归拢没完成的事项(`done` / `canceled` 不算)。
   * 看板读不出来就整块回空 map,那一格如实缺席 —— 不填 0(D13)。
   */
  const accountSource = createAccountSource({
    // 同步取值:读的是启动时算好的那一份(改 app.json 要 kickstart 才切,同 template / routines)。
    workdir: () => butlerCwd,
    openTasks: async () => {
      const counts = new Map<string, number>()
      const board = await tasks.list()
      for (const task of board.tasks) {
        if (task.project_id === undefined) continue
        if (task.status === 'done' || task.status === 'canceled') continue
        counts.set(task.project_id, (counts.get(task.project_id) ?? 0) + 1)
      }
      return counts
    },
    now: () => Math.floor(Date.now() / 1000),
  })
  /**
   * 接线完成:从这一刻起,项目区那一格读哪一个数据源由**当前模板的 `project_source`** 决定。
   * 回 undefined = 用 projectsService 自己那份 git 数据源(现状,一字未改)。
   */
  projectSourceNow = () => (template.current().project_source === 'accounts' ? accountSource : undefined)
   /**
   * 数据复盘:从小红书创作者中心自取(2026-09-21,决策记录 2026-09-20
   * 「数据复盘走浏览器自取」)。三件事在这里接:
   *
   * - **专用 Chrome 档案**与 Kimi 网页登录那套放在一起(`~/.dsh/workbench/login-profile-*`),
   *   登录态只在那个目录里,`credentials.json` 一个字不写;
   * - **模型**走 modelService(它在下面才建,所以这里用可变引用的闭包,同 codexReconcile
   *   那一手)。接不上 = 不生成建议,而不是生成三条正确的废话;
   * - **落盘**在 `~/.dsh/workbench/xhs-metrics.json`。
   */
  let xhsChat: ((prompt: string) => Promise<string>) | undefined
  // 会议纪要那一侧的同款可变引用(modelService 在几百行之后才建)。
  let meetingChat: ((prompt: string) => Promise<string>) | undefined
  const xhs = createXhsService({
    metricsFile: defaultXhsMetricsFile(home),
    selectorsFile: defaultXhsSelectorsFile(home),
    // 2026-09-22 多账号:一个账号一个档案,这里给的是那几个档案的**父目录**
    // (`login-profile-xhs_creator` / `-2` / `-3` … 都在它下面,见 server/xhsAccount.ts)。
    profileRoot: `${home}/.dsh/workbench`,
    peekDir: `${home}/.dsh/workbench`,
    browser: createXhsBrowser(),
    chat: async prompt => await (xhsChat?.(prompt) ?? Promise.reject(new Error('模型服务还没接上'))),
    // 运营模板下 `<工作目录>/账号/` 里那几个文件夹,拿来给每个登录档案**按名字**挂个钩。
    // 没配工作目录 / 不是运营模板 → 回空,界面上就没有那个钩子(不强绑)。
    opsAccounts: async () => butlerCwd === undefined || butlerCwd === ''
      ? []
      : await listAccountNames(accountsDir(butlerCwd)),
    onChanged: () => { pushSnapshot() },
  })
  await xhs.load()

  /**
   * 采集器(2026-09-23,用户层;`docs/设计-用户自己的那一层-2026-09-23.md`)。
   * 浏览器那一侧与创作者后台**同一份**(`createXhsBrowser`:只导航 + 读可见文字;这里连那一下切范围都不传),
   * 登录档案与它们放在同一个父目录(`login-profile-<名>`)。
   * 2026-10-26(切割收尾):**定义**搬进用户层 `用户层/采集器/`(真源;老位置 `<工作目录>/采集器/`
   * 在 load() 里一次性迁移,只拷不挪、幂等、她删过的不复活);**采回来的数据还在工作目录**
   * `数据/<名>/`(原始素材,与 账号/、选题/ 同一层)。工作目录跟着设置走(`butlerCwdNow`),
   * 所以给的取值函数;定义目录不跟工作目录走。
   */
  const collectors = createCollectorsService({
    workdir: () => butlerCwdNow,
    defsDir: join(userLayer.dir, '采集器'),
    legacyDefsDir: () => (butlerCwdNow === undefined || butlerCwdNow === '' ? undefined : join(butlerCwdNow, '采集器')),
    profileRoot: `${home}/.dsh/workbench`,
    browser: createXhsBrowser(),
    onChanged: () => { pushSnapshot() },
  })
  await collectors.load()

  /**
   * 采集类三项(2026-09-22):评论区采集 ① + 笔记采集 ② + 爆款拆解 ③。
   *
   * 依据:决策记录 2026-09-22 待拍板回复 **B1/B7**(采集类用开源项目,能采就采)、
   * **B2**(承诺维持「不点」,只采集,滚动不算点)、**C6**(拆解产物带时间戳)。
   * 选了哪个开源项目、为什么、许可证怎么判的 —— 全写在 `server/xhsNoteText.ts` 文件头,
   * 这里不重复一遍(写两份迟早漂)。
   *
   * 四条接线:
   *
   * - **浏览器**:与数据复盘**同一个专用档案**(`login-profile-xhs_creator`)。
   *   不另起一个档案、更不装第二个浏览器 —— 他已经在那个窗口里登录着了。
   * - **工作目录**:没配就 `workdir()` 回 undefined,`/collect/note` 当场如实拒绝
   *   (同 `/meeting/start`)。不猜一个路径:猜错会把别人的笔记写进他的代码仓库。
   * - **模型**:走 modelService 那家(同数据复盘、同会议纪要那条),
   *   用可变引用的闭包 —— askModel 在几百行之后才建。
   * - **拆解**:`runBreakdown` 里那几样本机工具(ffmpeg / whisper.cpp)
   *   **找不到就如实说**,不弹一句 `brew install` 让他去开终端(记忆「用户环节不走命令行」)。
   */
  let collectChat: ((prompt: string) => Promise<string>) | undefined
  const collect = createXhsCollectService({
    file: defaultCollectFile(home),
    profileDir: `${home}/.dsh/workbench/${XHS_PROFILE_NAME}`,
    workdir: () => butlerCwd,
    browser: createXhsNoteBrowser(),
    onChanged: () => { pushSnapshot() },
    tools: async () => {
      const ffmpeg = await findTool('ffmpeg')
      const whisper = await findTool('whisper-cli')
      let model = false
      try { model = (await stat(`${modelsDir(home)}/ggml-base.bin`)).size > 1_000_000 }
      catch { model = false }
      return {
        ffmpeg: ffmpeg !== undefined,
        whisper: whisper !== undefined,
        model,
        note: toolsNote({
          ...(ffmpeg === undefined ? {} : { ffmpeg }),
          ...(whisper === undefined ? {} : { whisper }),
          ...(model ? { modelFile: `${modelsDir(home)}/ggml-base.bin` } : {}),
        }, 'base'),
      }
    },
    breakdown: async (note, dir, url) => await runBreakdown(note, dir, url, {
      home,
      chat: async prompt => await (collectChat?.(prompt) ?? Promise.reject(new Error('模型服务还没接上'))),
      // 每一步都报一句:第一次要下几百兆的模型这件事,必须在界面上看得见。
      // **它不进采集记录** —— 记录记的是"做过什么",不是"做到哪一步了"。
      onStep: (line) => { collect.say(line) },
    }),
  })
  await collect.load()

  /**
   * 资讯与播客(2026-09-21,server/feed.ts)。四条依赖在这里接:
   *
   * - **搜索**:她自己的博查密钥直连,没有再走中转的 `/v1/search`(relay/server/search.cjs),
   *   都没有就如实说没配、不编条目(server/searchDirect.ts,2026-10-21 零服务器档)。
   * - **模型**(打分、写口播稿)与 `xhsChat` 同一条路,同样用可变引用的闭包
   *   —— modelService 在下面才建。
   * - **合成**走 8792 的 `/api/tts`,**经 butler.proxy**:令牌在那一层,这里碰不到,
   *   而且那条路上已经有串行队列(butler-server/server/services/ttsQueue.cjs)。
   * - **项目名单**用 `projects.getProjectsState()` —— 与项目区同一份,所以运营模板下
   *   它自然就是「账号」那一份(projectSourceNow 已经接好)。
   */
  let feedChat: ((prompt: string) => Promise<string>) | undefined
  let feedTts: ((text: string) => Promise<{ buffer: Buffer, contentType: string }>) | undefined
  // 搜索三条路(自己的博查密钥直连 → 中转 → 都没有就说没配)在 server/searchDirect.ts。
  const feedSearch = createFeedSearch({ modelFile: defaultModelFile(home), credentialFile: defaultCredentialFile(home) })
  /**
   * 资讯播客接 Aiboo 的 AIDJ 双主播节目(2026-09-22,server/aidj.ts,决策记录 B6)。
   * 它自己读自己那份偏好文件(`aidj-config.json`),不需要别的依赖 ——
   * Aiboo 的 `/api/dj/*` 现在**没有鉴权**(见设计页 1.4),所以这里也没有凭据要传。
   */
  const aidj = createAidjService({
    configFile: defaultAidjConfigFile(home),
    ...(endpoints.aiboo_url === undefined ? {} : { defaultBase: endpoints.aiboo_url }),
  })
  await aidj.load()

  /**
   * 「她要跟电话那头聊的那一条资讯」(2026-10-13,卡「播客页重做」)。
   * **同一个实例给两头**:8791 的 `POST /feed/dig/call` 往里写,通话人设(channel 的 `digBlock`)往外读。
   * 只在内存里、十分钟过期 —— 理由在 server/feedDig.ts 的文件头。
   */
  const feedDig = createFeedDigContext()

  const feed = createFeedService({
    file: defaultFeedFile(home),
    configFile: defaultFeedConfigFile(home),
    outboxDir: process.env.WORKBENCH_CHANNEL_OUTBOX_DIR?.trim() || `${home}/.dsh/workbench/channel-outbox`,
    projects: async () => (await projects.getProjectsState()).projects.map(p => ({ id: p.id, name: p.name })),
    search: feedSearch,
    /**
     * ★ 早报以 AIHOT 日报为底(2026-10-14,卡 AC):`aihot.news` 匿名只读、不要 key。先拉当天那一期,
     * 没出刊(404)退 latest;UA 带工作台版本(它建议的 `aihot-actor/<uuid>` 不带 —— 不往外送可识别的标识)。
     */
    aihotDaily: async (date) => {
      const headers = { 'user-agent': `workbench-feed/${PLUGIN_VERSION} (+https://www.aibooo.cn)`, accept: 'application/json' }
      const aihotBase = endpoints.aihot_url
      if (aihotBase === undefined) throw new Error('AIHOT 在 endpoints.json 里关掉了')
      const get = async (path: string): Promise<Response> => await fetch(`${aihotBase}${path}`, { headers, signal: AbortSignal.timeout(15_000) })
      let response = await get(`/api/v1/dailies/${date}`)
      if (response.status === 404) response = await get('/api/v1/dailies/latest')
      if (!response.ok) throw new Error(`aihot.news 回 ${response.status}`)
      return await response.json() as unknown
    },
    chat: async prompt => await (feedChat?.(prompt) ?? Promise.reject(new Error('模型服务还没接上'))),
    tts: async text => await (feedTts?.(text) ?? Promise.reject(new Error('语音后端还没接上'))),
    /**
     * 账号档案(2026-09-22 卡 ③):资讯按**这个账号的定位 / 人群 / 风格**提炼成选题。
     *
     * **只有运营模板下才回得出东西** —— 模板不是 `accounts` 时一律 undefined,
     * feed.ts 那一头照旧不提炼,做产品那一档与加这个钩子之前逐字相同。
     *
     * 路径取项目行上的 `path`(账号文件夹的落点),**不按名字去拼** ——
     * 两个同名账号在合并层是消过歧的,按名字拼会串档案。
     */
    accountProfile: async (projectId) => {
      if (template.current().project_source !== 'accounts') return undefined
      let dir: string | undefined
      try { dir = (await projects.getProjectsState()).projects.find(one => one.id === projectId)?.path }
      catch { return undefined }
      if (dir === undefined || dir === '') return undefined
      const fields = await readAccountFile(dir)
      return {
        ...(fields.定位 === undefined ? {} : { positioning: fields.定位 }),
        ...(fields.人群 === undefined ? {} : { audience: fields.人群 }),
        ...(fields.风格 === undefined ? {} : { style: fields.风格 }),
      }
    },
    // 每天跑完资讯:把当天条目推给 Aiboo 当信源;再问一句它今天那期在不在
    // (在就不自己合成单人口播 —— 那是退路)。
    aidj: {
      push: async (groups, date) => await aidj.push(groups, date),
      ready: async () => {
        const view = await aidj.program()
        return view.status === 'ready'
          ? { ready: true }
          : { ready: false, ...(view.error === undefined ? {} : { note: `Aiboo 的播客没取到:${view.error}` }) }
      },
    },
    onChanged: () => { pushSnapshot() },
  })
  await feed.load()

  /**
   * 「这台机器装好了没有」(2026-09-23 从零重装验收):没注册账号 / 引导没走完时,例程与座机主动来电
   * 的自动那一半都不动。`account` 与 `onboarding` 在下面才建,这里是转发闭包
   * (同 isFirstRun 的手法;调用发生在服务起来之后的 1 秒节拍上)。
   */
  const setupGate = createSetupGate({
    registered: async () => (await account.view()).registered,
    onboardingDone: () => (onboarding === undefined ? undefined : onboarding.view().done),
  })
  /** 从行为账里数出来的习惯(卡「数出习惯」)。行为账在后面才造,这里先留一格(同 askEventsNow 的手法)。 */
  let habits: HabitService | undefined
  /** 认风格候选那一问(卡「学风格」);`askModel` 造出来之后填上。 */
  let styleChat: ((prompt: string) => Promise<string>) | undefined
  /** 日报四段的归并与措辞那一问(卡「早报按日报规范出」);`askModel` 造出来之后填上。 */
  let dayReviewChat: ((prompt: string) => Promise<string>) | undefined
  const routines = createRoutinesService({
    setupGate: () => setupGate.reason(),
    // 她没设开工汇报时刻时,用学到的「她通常露面前 10 分钟」(`habits.briefAt`)。
    learnedMorningAt: () => habits?.briefAt(),
    configFile: defaultRoutinesFile(home),
    stateFile: defaultRoutinesStateFile(home),
    ...(butlerSession === undefined ? {} : { session: butlerSession }),
    ...(butlerCwd === undefined || butlerCwd === '' ? {} : { defaultRepo: butlerCwd }),
    // 早报之前先自取一轮 + 写三条建议。它失败不连累开工汇报(见 routines.ts 那一段)。
    beforeMorning: async () => {
      const result = await xhs.runForRoutine()
      const advice = result.advice ? ',并写了三条建议' : ''
      return `数据复盘:${result.collected.message}${advice}`
    },
    // 资讯:早报之前搜一轮,每个项目最多 3 条进汇报正文(2026-09-21)。
    // 它失败不连累开工汇报(见 routines.ts 里 feedBeforeMorning 那一段)。
    feedBeforeMorning: async () => {
      const result = await feed.run()
      return { note: result.note, groups: feed.morning(result.date) }
    },
    /**
     * 运营目标对进度(2026-09-22 卡④)。一行一个账号,三份素材都是**已有的**:
     * `账号/<名>/目标.md`(技能写的)、看板上 `published_at` 落在周期里的选题、
     * 数据复盘那一格的涨粉。没配工作目录 / 一个账号都没有 → 回空数组,早报逐字不变。
     */
    /**
     * 进度核对(2026-09-25,卡 N):早报之前按证据核一轮 —— 只念变了的;再加他自己的事与同事 / 别人的到期提醒。
     * 抛了不连累开工汇报(routines.ts 那一段)。
     */
    /**
     * 日报那四段(2026-10-13,《日报规范》):事实表从 /state 的事项卡与**这本任务账**里判,
     * 归并与措辞问一次模型(一天一份早报 = 最多一次调用)。模型没接上就按事实表排,如实注明。
     */
    dayReview: {
      jobEvents: () => jobLog.all(),
      chat: async (prompt) => {
        if (dayReviewChat === undefined) throw new Error('模型服务还没接上')
        return await dayReviewChat(prompt)
      },
    },
    progressBeforeMorning: async () => {
      const owner = ownerMorningLines((await tasks.list()).tasks, new Date())
      if (progress === undefined) return { lines: owner }
      const checked = await progress.beforeMorning()
      return { lines: [...checked.lines, ...owner], ...(checked.note === undefined ? {} : { note: checked.note }) }
    },
    goalsBeforeMorning: async () => {
      /**
       * 采集器各采一次(2026-09-23,用户层)。挂在这条钩子上是因为它与目标进度同一条纪律:
       * 早报之前做、结果一句进早报、抛了不连累早报。过闸的才采(一天一次,撞过墙当天不再试)。
       */
      let collectorLines: string[] = []
      try { collectorLines = await collectors.runForRoutine() }
      catch (error) { collectorLines = [`采集器这次没跑:${(error as Error).message}`] }
      if (butlerCwd === undefined || butlerCwd === '') return collectorLines
      const root = accountsDir(butlerCwd)
      const names = await listAccountNames(root)
      if (names.length === 0) return collectorLines
      const board = await tasks.list()
      const projectState = await projects.getProjectsState()
      const xhsView = xhs.view()
      // 采集器那几句排在目标进度前面:它们是"今早替她做了什么",目标是"她现在到哪了"。
      const lines: string[] = [...collectorLines]
      for (const name of names) {
        const read = await readAccountGoal(join(root, name))
        if (!read.exists || read.goal === undefined) {
          lines.push(composeGoalProgress({ account: name }))
          continue
        }
        // 账号 → 项目 id:运营模板下项目区列的就是这几个账号文件夹(accountSource),
        // 按名字对。对不上就没有已发布数(**不拿别的项目的卡顶**)。
        const projectId = projectState.projects.find(project => project.name === name)?.id
        const published = countPublishedInPeriod(board.tasks, projectId, read.goal.period)
        const fans = fansOfAccount(xhsView, name)
        lines.push(composeGoalProgress({
          account: name,
          goal: read.goal,
          ...(published === undefined ? {} : { published }),
          ...fans,
        }))
      }
      return lines
    },
    /**
     * 画像回写(2026-09-22 卡④):下班例程写完记忆之后,把 `经验.md` 与
     * 每条选题的 `审核记录.jsonl` 拼成 `账号.md` 里「风格与偏好(工作台学到的)」那一段。
     *
     * **一个字都不经模型**:经验是她自己认下的那句话,把关次数是数出来的。
     * 先写后说 —— 回一句人话进 run.note。
     */
    profileAfterEvening: async () => {
      if (butlerCwd === undefined || butlerCwd === '') return undefined
      const root = accountsDir(butlerCwd)
      const names = await listAccountNames(root)
      if (names.length === 0) return undefined
      const reviews = await readReviewLogs(join(butlerCwd, TOPIC_DIR))
      const date = localDateStr(Date.now())
      const written: string[] = []
      const failed: string[] = []
      for (const name of names) {
        let experiences: readonly string[] = []
        try { experiences = readExperienceLines(await readFile(join(root, name, ACCOUNT_EXPERIENCE_FILE), 'utf8')) }
        catch { experiences = [] } // 还没有经验文件是常态,不是错。
        const result = await writeAccountProfile(butlerCwd, name, { experiences, reviews, date, preferences: evolve.preferenceLines() })
        if (!result.ok) failed.push(`${name}(${result.reason ?? '写不进去'})`)
        else if (result.written === true) written.push(name)
      }
      const parts = [written.length === 0 ? '画像回写:没有要改的' : `画像回写:${written.join('、')} 的「风格与偏好」更新了`]
      if (failed.length > 0) parts.push(`没写成:${failed.join('、')}`)
      return parts.join(';')
    },
    /**
     * 下班例程第 0 步「收」(2026-09-26,设计-讨论结论都落进工作台记忆-2026-09-26 §二 0)。
     *
     * 过的是**同一道授权门**:授权表里 `read_client_files` 不是「可以」就一个字节都不拷
     * (与引导里那颗按钮同一处判据,Ben 2026-09-22 定的 C5)。授权那块没接上(没配工作目录)时
     * 回「未答」—— 最保守的那一档,也就是不收。拷法、清单怎么算在 server/memoryCollect.ts。
     */
    collectMemories: input => collectAgentMemories({
      repo: input.repo,
      home,
      date: input.date,
      clientFiles: async () => (await authorization?.get())?.read_client_files.status ?? '未答',
    }),
    /**
     * 收尾检查(2026-09-27):每 10 分钟 + 每条例程开跑前一次。仓库用例程配的那个(routines.json 的 repo,
     * 没配就退回 WORKBENCH_BUTLER_CWD);没配工作目录就什么也不做 —— 没有仓库可收尾。
     */
    closeoutMemories: async () => {
      const repo = routines.config().repo
      if (repo === undefined || repo === '') return undefined
      return (await runMemoryCloseout({ repo, git: defaultRoutineGit })).summary
    },
    // 下班例程之后扫一遍"她这两周反复在说什么"(2026-09-22,卡 ⑥)。
    // 一天的活干完了再问"要不要把它固化下来",才问得动;失败只记一句,不连累下班例程。
    // 2026-09-23:顺手把偏好那一截也学一遍(平时每次把关之后就学过了,这里是兜底)。
    // 2026-10-09:从行为账里数习惯也在这里兜一遍底(平时账里多了派活 / 拍板 / 审 / 来电就学过了)。
    // 下班例程之后那一遍把今天攒下的话、新写的「观察」送去认风格(卡「学风格」;每天有次数上限,见 styleHabits.ts)。
    afterEvening: async () => `${(await evolve.scan()).note};${(await evolve.learn()).note};${(await habits?.learn({ style: true }))?.note ?? '习惯没接上'}`,
  })
  await routines.load()

  /**
   * 座机主动来电(2026-09-21,Ben:「待确认 / 运行失败 / 完成提醒时座机响铃」)。
   *
   * 两个事实源都是**已有的**:看板(tasks.json)与例程最近一次(routines-state.json)。
   * 台账落 ~/.dsh/workbench/call-out.json —— 「打没打过」是发生过的事,重启一次就忘了
   * 等于重启一次他的手机就再响一遍(理由写在 server/callOut.ts 的文件头)。
   * 节拍挂在 http.ts 那根既有的 1 秒 tick 上,这里不起任何定时器。
   */
  /**
   * 她问你的话、要你批的事也按来电设置响(2026-09-25,卡 M)。两个经纪人在后面(统一输入框那一段)才造出来,
   * 这里先留一格,造出来之后填上(同 diagReport 的手法)。
   */
  let askEventsNow: (() => Promise<readonly CallOutEvent[]>) | undefined
  /**
   * ★ **行为账**(2026-10-09,卡「行为账」;`server/behaviorLog.ts`):`<DSH_HOME>/workbench/行为账/<年-月>.jsonl`,
   * 只在这台电脑上、留 90 天。这一张只记不学;入口都在 http 那一层(端在那儿认得出来),来电接没接从台账这里报。
   */
  const ledger = createBehaviorLog({ dir: defaultBehaviorDir(process.env) })
  /**
   * ★ **从行为账里数出习惯**(2026-10-09,卡「数出习惯」;`server/habits.ts`)。存在规矩表那一份里;
   * 进化日志写在她的工作目录(与选题偏好同一份 `进化日志.md`)。账里多了一条值得数的(派活、拍板、审、来电)就过一会儿学一遍。
   */
  const habitService = createHabitService({
    store: rules,
    behavior: ledger,
    ...(butlerCwd === undefined || butlerCwd === '' ? {} : { workdir: butlerCwd }),
    io: {
      readFile: async (file) => { try { return await readFile(file, 'utf8') } catch { return undefined } },
      writeFile: async (file, text) => {
        await mkdir(dirname(file), { recursive: true })
        await writeFile(file, text, 'utf8')
      },
    },
    morning: () => routines.config().morning,
    onChanged: () => pushSnapshot(),
    /**
     * 风格那一种(卡「学风格」):模型只从她的原话 / 观察里提候选。走下面那个 `askModel`(工作台自己的中转,V4 Flash),
     * 它在后面才造出来,先留一格(同 askEventsNow 的手法)。观察读的是事务官记忆里那份 `用户-*.md`。
     */
    style: {
      ask: async (prompt) => {
        if (styleChat === undefined) throw new Error('模型还没接上')
        return await styleChat(prompt)
      },
      ...(butlerCwd === undefined || butlerCwd === ''
        ? {}
        : {
            observations: async () => {
              const dir = join(butlerCwd as string, 'docs', '记忆')
              const names = (await readdir(dir)).filter(name => name.startsWith('用户-') && name.endsWith('.md')).sort()
              return names[0] === undefined ? undefined : await readFile(join(dir, names[0]), 'utf8')
            },
          }),
    },
  })
  habits = habitService
  const behaviorLog: BehaviorLog = {
    ...ledger,
    record: (input) => {
      ledger.record(input)
      if (HABIT_POKE_EVENTS.includes(input.事)) habitService.poke()
      if (input.事 === BEHAVIOR_EVENTS.seen) habitService.noteSeen(new Date().toISOString())
    },
  }
  void habitService.learn().then(done => console.log(`[习惯] ${done.note}`)).catch(() => undefined)
  /**
   * ★ **三件主路成没成**(2026-10-21,卡「引导三件事」;`server/firstUse.ts`):`<DSH_HOME>/workbench/first-use.json`,
   * 成与没成另记进行为账(`事:'主路'`)。首次引导「第一次有用」、首页「现在能做什么」、安装器末尾的自检都读它。
   */
  const firstUse = createFirstUseService({ file: join(dirname(defaultBehaviorDir(process.env)), 'first-use.json'), behaviorLog })
  void firstUse.ready().catch(() => undefined)
  /**
   * 偏好:办完提醒的范围 + 桌面活直派(2026-10-23,卡「分层第二刀一」;`server/dispatchPrefs.ts`)。
   * 一份小文件 `~/.dsh/workbench/dispatch-prefs.json`;座机每一拍从 `tellScope` 口现取,`/butler/item` 那道门现取 `auto_desk`。
   */
  const dispatchPrefs = createDispatchPrefsService({ file: defaultDispatchPrefsFile(home) })
  await dispatchPrefs.load()
  const callOut = createCallOutService({
    setupGate: () => setupGate.reason(),
    file: defaultCallOutFile(home),
    tasks: { list: () => tasks.list() },
    routines: () => routines.view(),
    askEvents: async () => (askEventsNow === undefined ? [] : await askEventsNow()),
    // 哪几类事项办完要告诉她(设置里的勾,每一拍现取):改了勾,下一拍就照新的。
    tellScope: () => dispatchPrefs.view().tell_scope,
    onChanged: () => pushSnapshot(),
    onSettled: (entry) => {
      const note = callSettledNoteOf(entry)
      if (note !== undefined) behaviorLog.record(note)
    },
    // 学到的「这个时段不打电话、改发消息」(卡「数出习惯」)。
    habitQuiet: nowMs => habitService.quietNow(nowMs),
    onHabitApplied: (id, itemId) => { void habitService.applied(id, itemId) },
  })
  /**
   * ★ **座机台账里那些老的会话事项 id,启动时迁一次**(2026-10-03,卡「两条接缝」;
   * 决策记录 10-03 早 ⑦ 第二条)。理由、边界与「认不出家就原样留着」都在 `server/callOutMigrate.ts`。
   *
   * 家名从哪来:**看板那几张卡自己记下的会话**(卡上认下的那条对话、挂在卡上的那几条、
   * 事务官那条会话)—— 落了盘的证据,不猜。查不到的那几行原样留着,报告里数出来。
   * 跑在 `callOut.load()` **之前**:之后那一份是从文件读出来的,迁完再读才拿得到新的 id。
   */
  const sessionFamilies = sessionFamilyMap((await tasks.list().catch(() => ({ tasks: [] }))).tasks)
  const migration = await runCallOutSessionIdMigration({
    path: defaultCallOutFile(home),
    today: new Date().toISOString().slice(0, 10),
    write: async (path, text) => { await writeFile(path, text, 'utf8') },
    familyOf: sessionId => sessionFamilies.get(sessionId),
  })
  console.log(`[workbench] ${migration.note}`)

  await callOut.load()

  /**
   * 项目锚点提供者(规格 §4.1 那条 Ben 当场点名要的接缝)。
   *
   * **今天**背后是 projectsService 的扫描结果,只取带 path 的那些;**将来**事务官 Agent
   * 梳理出正式名单后,只要换掉这个函数,图谱的生成落点一行不改
   * (`~/.dsh/workbench/projects.json` 里那个至今空着的 projects 数组正是它以后的落脚点)。
   */
  const projectAnchors = async (): Promise<readonly { id: string, name: string, path: string }[]> => {
    const state = await projects.getProjectsState()
    return state.projects
      .filter((project): project is typeof project & { path: string } => project.path !== undefined)
      .map(project => ({ id: project.id, name: project.name, path: project.path }))
  }

  // Graphify 图谱(2026-10-23,卡「系统文件夹改成Graphify图谱」):「图谱」那一格嵌
  // graphify 按项目生成的 graph.html。产物集中放在 ~/.dsh/workbench/graphify/<项目id>/;
  // graphify extract 把 graphify-out 写进被扫项目里,由服务整个挪过来。graph.html 经
  // GET /graphify/view/<项目id>/ 供格子里的 iframe 用。
  const graphify = createGraphifyService({
    dir: join(home, '.dsh', 'workbench', 'graphify'),
    projectPaths: projectAnchors,
    // 绘图组件的下载地址走 endpoints.json 的 viz_cdn_url(写 off = 不下,装的时候照实说)。
    vizUrl: () => endpoints.viz_cdn_url,
    // uv 安装脚本的下载地址走 endpoints.json 的 uv_bootstrap_url(写 off = 不下)。
    uvBootstrapUrl: () => endpoints.uv_bootstrap_url,
  })

  // Archify 产品架构图(2026-10-23,卡「图谱显示修复与Archify产品图接入」):
  // 架构图与流程图服务，官方五图已验钉 c55；离线渲染与结构化规范供 Agent 与界面共同访问。
  const archify = createArchifyService({
    homeDir: home,
    // 安装态编译后 lib/index.js 的 '../..' 会锚到包父(@ben scope),不是包根 ——
    // 资产基准从装配模块真实位置起算(源码检出锚仓库根,安装形态锚包根)。
    repoRoot: archifyAssetRootFrom(import.meta.url),
    // 项目路径登记(同 graphify 的 projectAnchors):按项目解析 --repo-root 与 Agent 取证目录
    projectPaths: async () => (await projectAnchors()).map(anchor => ({ id: anchor.id, path: anchor.path })),
  })

  // 光圈(2026-09-10,设计-事务官形态 §四 第 2 步):事务官动哪一块,那一块的边缘亮一圈。
  // 矩形来源:窗位由 http.ts 在 /slot/rect 顺手喂进来(不碰 dock 的内部状态),任务板没人上报,
  // 退回布局快照那套相对位置换算。
  // layout 取的是**迁移过的**那一份——与 /state.layout 同源,不然旧存档算出来的版面
  // 和页面上看到的对不上(migrateLayoutModules 的 WHY 见 http.ts 那一处)。
  // 窗口槽那圈原生流线光:只剩「他亲手拖进新应用、松手」那一下(卡 P 补三)。事务官动作的那一行字由页面画。
  const highlight = createHighlightService({ helper })

  /**
   * 插件进程自己的内存与事件循环(2026-10-19,卡「插件内存增长与 GC 抖动」):`/state.machine.process`、
   * 诊断包概要、每 10 分钟一行 `[内存]` 日志,以及探 8792 那条路的「是不是我自己慢」。
   * 在 butler 之前建:探测要借它的 `loopP99Ms`。热更新重载时上一份在 dispose 里关掉了。
   */
  processHealth?.close()
  processHealth = createProcessHealth()
  // 事务官本机后端(butler-server,2026-09-11):旁路服务,launchd 拉起、只听 127.0.0.1。
  // 工作台只看状态、代理、启停;启停走 launchctl(同一个不带 cwd 的 runCommand)。
  const butler = createButlerService({
    configFile: defaultButlerConfigFile(home),
    runCommand,
    // 探 /health 超时时先问一句「是不是我自己慢」(2026-10-19);那一行日志它自己 10 分钟记一次。
    loopDelayP99Ms: () => processHealth?.loopP99Ms(),
  })
  /**
   * 连接器(open-connector,卡 OC2):**默认装上**,每台机器都有
   * (维护者 09-27 11:30「到底是装还是不装?我是让你装啊」)。
   *
   * `ensure()` 在下面服务真起来之后叫一次,**游离地**在后台装(第一次要下约 230MB):
   * 不挡启动、不挡别的功能;这一次装不上就记一句人话,**下次开机再试**
   * (不自己轮询重试 —— 没网时每分钟重下一次 230MB 是害人)。
   * 安装包里不带这 229MB,所以从零装机那条线一秒都没变长。
   */
  const connector = createConnectorService({ home, onChanged: () => { pushSnapshot() } })
  /**
   * 播客合成走 8792 的 `/api/tts`(2026-09-21),**经 butler.proxy**:
   * ① 令牌在那一层(butler.json),这里碰不到;
   * ② 那条路上已经有串行队列(butler-server/server/services/ttsQueue.cjs),
   *    卡里说的「经队列串行」是它,不是我们在这儿再排一遍;
   * ③ scene 用 `dj_podcast` —— 那是 8792 认的三个场景里专给口播用的那一个。
   * 音色不指定:形象在那个场景上的绑定是权威(见 tts.cjs 的音色解析规则)。
   */
  const feedTtsImpl = async (text: string): Promise<{ buffer: Buffer, contentType: string }> => {
    const result = await butler.proxy({
      method: 'POST',
      path: '/api/tts',
      contentType: 'application/json',
      body: Buffer.from(JSON.stringify({ text, scene: 'dj_podcast' }), 'utf8'),
    })
    if (result.status !== 200) {
      // 后端的错误体是 `{ code, error, detail }`,那句 error 是写给人看的,原样转达;
      // detail 里可能有上游原话(已脱敏),接不上时它才是能查的那一句。
      let message = `语音后端回了 ${result.status}`
      try {
        const body = JSON.parse(result.body.toString('utf8')) as { error?: unknown, detail?: unknown }
        if (typeof body.error === 'string' && body.error !== '') message = body.error
        if (typeof body.detail === 'string' && body.detail !== '') message = `${message}(${body.detail})`
      }
      catch { /* 不是 JSON 就用上面那句 */ }
      throw new Error(message)
    }
    return { buffer: result.body, contentType: result.contentType ?? 'audio/mpeg' }
  }
  feedTts = feedTtsImpl

  /**
   * 会议模式(2026-09-21)。三个口在这里接上,每一个接不上都是**整块如实缺席**,不假装:
   *
   * - **转写** `transcribe`:经 butler 的代理打本机 8792 的 `/api/asr`(它内部连火山的大模型
   *   流式识别)。走代理而不是自己 fetch,是为了那把 `X-Workbench-Token` 只在 butler.ts 里存在一处。
   *   **没有用火山的「录音文件识别」**,理由在 server/meeting.ts 文件头(那两条接口只收公网 URL,
   *   等于把录音传出这台机器)。
   * - **梳理** `chat`:走 modelService 那家(同数据复盘那条,askModel 在下面才建,
   *   所以这里用可变引用的闭包,同 xhsChat 那一手)。
   * - **工作目录**:没配就 `workdir()` 回 undefined,`/meeting/start` 当场如实拒绝
   *   —— 不猜一个路径,猜错会把一整场会的录音写进别人的仓库。
   */
  const meeting = createMeetingService({
    file: defaultMeetingsFile(home),
    // 同步取值:读的是启动时算好的那一份(改 app.json 要 kickstart 才切,同 template / accountSource)。
    workdir: () => butlerCwd,
    transcribe: async (wav) => {
      const response = await butler.proxy({
        method: 'POST',
        path: '/api/asr',
        contentType: 'application/json',
        body: Buffer.from(JSON.stringify({ audio: wav.toString('base64') })),
      })
      if (response.status !== 200) {
        // 8792 的回话原样带出来(它写的是人话:没配凭据 / 太长 / 没听清),**不套一层**。
        let said = ''
        try { said = String((JSON.parse(response.body.toString('utf8')) as { error?: unknown }).error ?? '') }
        catch { said = '' }
        throw new Error(`8792 /api/asr 回了 ${response.status}${said === '' ? '' : `:${said}`}`)
      }
      const parsed = JSON.parse(response.body.toString('utf8')) as { text?: unknown }
      return typeof parsed.text === 'string' ? parsed.text : ''
    },
    chat: async prompt => await (meetingChat?.(prompt) ?? Promise.reject(new Error('模型服务还没接上'))),
    tasks,
    // 预案卡的数只从她自己的数据里来(2026-10-10):账号数据、复盘、选题池、看板。
    facts: createMeetingFacts({
      workdir: () => butlerCwd,
      topicsDir: () => (butlerCwd === undefined || butlerCwd === '' ? undefined : join(butlerCwd, TOPIC_DIR)),
      xhs: () => xhs.view(),
      tasks: async () => (await tasks.list()).tasks,
    }),
    onChange: () => pushSnapshot(),
  })

  /**
   * 通话记录(2026-10-22,决策记录同日「通电话是记录不是事项」;`server/callRecords.ts`)。
   * 一通一份 md,落在 `<工作目录>/通话/`;工作目录没配就落在工作台自己的数据目录里(不丢这一通)。
   */
  const callRecords = createCallRecordsService({
    file: defaultCallRecordsFile(home),
    workdir: () => butlerCwd,
    fallbackDir: join(home, '.dsh', 'workbench', CALL_RECORDS_DIR_NAME),
  })

  /**
   * 引导流程 + 授权表(2026-09-15,docs/设计-引导流程.md v2)。记忆在哪个仓库由 `WORKBENCH_BUTLER_CWD`
   * 说了算(事务官会话也开在那里,同一个变量,不另造一个)——没配就整块不接:/onboarding/* 404、
   * /state.onboarding 缺省、写接口不过授权表的门(老样子)。**不猜路径**:猜错会把记忆写进别的仓库。
   * onboarding.json 落 ~/.dsh/workbench/;AGENTS.md 是 ~/.dsh/AGENTS.md(只改「说话方式」标记段与首行)。
   */
  // 2026-09-17(卡 C):与事务官会话同一个来源——环境变量优先,其次 app.json。用的是上面那一次读。
  const memoryRepo = butlerCwd
  const authorization = memoryRepo === undefined || memoryRepo === ''
    ? undefined
    : createAuthorizationService({ file: defaultAuthorizationFile(memoryRepo) })
  let onboarding: OnboardingService | undefined
  let materialize: MaterializeService | undefined
  if (memoryRepo !== undefined && memoryRepo !== '' && authorization !== undefined) {
    onboarding = createOnboardingService({
      file: defaultOnboardingFile(home),
      repoRoot: memoryRepo,
      agentsFile: defaultAgentsFile(home),
      authorization,
      tasks,
      // 引导 ①′「你先用哪套布局」(2026-09-21):答完当场把布局换过去。
      // 只挑最小的两件(apply / currentId),引导不认识备份与文件夹那些细节。
      template: { apply: id => template.apply(id), currentId: () => template.currentId() },
      /**
       * 引导 ②′ 运营线(2026-09-21):账号落成 `<工作目录>/账号/<名>/账号.md` + 空的 `笔记/`,
       * 写完当场把扫描缓存作废 —— 写的正是账号数据源读的地方,所以**下一拍**项目区里就有它。
       * 工作目录就是 memoryRepo(这个分支里它非空,见外面那个 if)。
       */
      accounts: {
        write: async (account) => {
          const result = await writeAccount(
            memoryRepo,
            { name: account.name, fields: account.fields },
            { date: account.date, origin: '引导访谈' },
          )
          if (result.ok) projects.invalidateScanCache()
          return result
        },
      },
      /**
       * 窗位清单(2026-09-18,引导 ④ 习惯多问一句「你平时最常开哪几个应用」)。
       * 认名字用 `listAll()`(**不是** `list()`:首次期间后者本来就是空的,拿它认名字一个都认不出);
       * 答完写 `enabled` —— 「首次不自动认领」那条规矩下,这就是窗位清单出现的方式。
       * `installed` 是扫描结论,只进简报给模型当话头(「我看到你装了 Claude、Kimi、微信,都要吗」),
       * 没扫过就 undefined(不冒充「一家都没装」)。
       */
      apps: {
        known: () => registry.listAll(),
        enable: keys => registry.enable(keys),
        installed: () => {
          const found = clientScan.installedKeys()
          return found === undefined ? undefined : [...found]
        },
      },
      /**
       * ②′ 那一问「各家客户端里记的东西,要不要拷一份过来」(2026-09-21)。
       * 哪几家、记在哪、拷成什么样,全在 server/agentMemory.ts —— 这里只把家目录与仓库根交过去。
       */
      memories: {
        importAll: () => importAgentMemories({ home, repoRoot: memoryRepo }),
        /**
         * 设置 → 体检与修复那颗按钮先探一眼(2026-09-22):**只数不拷**,每家回一个数。
         * `files` 里那几条绝对路径**不往界面送** —— 他电脑上有哪几个项目不是这颗按钮
         * 该摊开的东西,一个数加一句「未查到」就够他决定拷不拷。
         */
        probeAll: async () => (await probeAgentMemories({ home, repoRoot: memoryRepo })).map(view => ({
          family: view.family,
          label: view.label,
          count: view.files.length,
          left: view.left,
          ...(view.skip === undefined ? {} : { skip: view.skip }),
        })),
      },
      // 引导技能(简报里给通道层工人):装机后在 ~/.dsh,开发时在仓库里。第一个读到的算。
      skillFiles: [join(home, '.dsh', 'skills', '引导', 'SKILL.md'), join(memoryRepo, '.dsh', 'skills', '引导', 'SKILL.md')],
      /**
       * 引导里他确认「是这个」的那个仓库 = 项目区的那一条(2026-09-23:「工作台」与 desktop-workbench 两行)。
       * `~/` 在这里展开成家目录 —— 项目区按绝对路径认。
       */
      projects: {
        adopt: async ({ name, path }) => {
          if (projects.adopt === undefined) throw new Error('项目区不支持认领')
          const absolute = path.startsWith('~/') ? join(home, path.slice(2)) : path
          return await projects.adopt({ name, path: absolute })
        },
      },
      // ②′ 按方案建事项时判「交接里的 0.2.80 过时了」(2026-09-24 晚):仓库现在的版本,只读。
      version: async path => await projectVersion(path.startsWith('~/') ? join(home, path.slice(2)) : path, nodeBriefIo()),
    })
    await onboarding.load()
    /**
     * 项目区的门(2026-09-23):引导**从来没做完过**、或者授权表里 read_scan_roots 不是「可以」,
     * 项目区就不去看他的目录、不自动建条目(面板上如实说那句话)。
     * 「从来没做完过」= 计划还是从开场开始的那一整遍;做完后的补问 / 重问某一段(计划只剩两步)不算没做完,
     * 否则他说一句「再加一个 XX」项目区就整片空掉。
     */
    const gateOnboarding = onboarding
    const gateAuthorization = authorization
    scanGateNow = async () => {
      const detail = gateOnboarding.detail()
      if (!detail.done && detail.plan[0] === 'opening') return '引导还没做完,还没看你的项目目录。'
      if (!(await gateAuthorization.isAllowed('read_scan_roots'))) return '还没授权看你的项目目录。在引导里答应、或者跟事务官说一声就能打开。'
      return undefined
    }
    projects.invalidateScanCache()

    /**
     * 引导落地(2026-09-24 晚,卡 feat/onboarding-materialize;设计 docs/设计-引导落地-引导结束后的样子-2026-09-24.md)。
     * 存档 → 预览「我照你说的摆好了」→ 他点「就这样」才落 → 派第一件(现有派活链路:给那张卡开一条事务官会话,点名 Codex)。
     * 窗口槽那一行用卡 C 的认领(`dock.claimPreview` 排单子时只读地问、`dock.claimEnabled` 点了「就这样」才拉;0.2.84 已合进 main)。
     */
    const ob = onboarding
    materialize = createMaterializeService({
      file: join(home, '.dsh', 'workbench', 'materialize.json'),
      // 引导里说的分工 → 规矩表「派活默认分工」(卡 O;来源「引导」,和统筹手加的那一条按标题去重)。
      rules: {
        hasDivision: () => rules.hasTitled(DIVISION_TITLE),
        adoptDivision: async input => await rules.adoptTitled({ title: DIVISION_TITLE, ...input }),
      },
      readArchive: async () => {
        try { return JSON.parse(await readFile(defaultOnboardingFile(home), 'utf8')) }
        catch { return undefined }
      },
      tasks,
      projects: {
        stored: async () => (await loadProjectsFile(projectsFile)).projects.map(one => ({
          id: one.id, name: one.name, ...(one.repoPath === undefined ? {} : { repoPath: one.repoPath }), ...(one.ddl === undefined ? {} : { ddl: one.ddl }),
          ...(one.status?.text === undefined ? {} : { status: one.status.text }),
        })),
        repos: async () => (await projects.getProjectsState()).projects.map(one => ({ id: one.id, name: one.name, ...(one.path === undefined ? {} : { path: one.path }) })),
        ...(projects.adopt === undefined ? {} : { adopt: projects.adopt }),
        setDdl: (id, ddl) => projects.setDdl(id, ddl),
        confirmStatus: (id, text) => projects.confirmStatus(id, text),
      },
      routines: { config: () => routines.config(), setConfig: patch => routines.setConfig(patch) },
      quiet: { config: () => callOut.config(), setConfig: patch => callOut.setConfig(patch) },
      feed: { config: () => feed.config(), setConfig: patch => feed.setConfig(patch) },
      apps: { enabled: async () => (await loadAppsFile(defaultAppsFile(home))).enabled },
      dock: {
        ...(dock.claimPreview === undefined ? {} : { claimPreview: () => (dock.claimPreview as NonNullable<typeof dock.claimPreview>)() }),
        ...(dock.claimEnabled === undefined ? {} : { claimEnabled: (options?: { launch?: boolean }) => (dock.claimEnabled as NonNullable<typeof dock.claimEnabled>)(options) }),
      },
      memories: { importNow: async () => { const got = await ob.importMemories(); return { ok: got.ok, note: got.note } } },
      readClientFiles: async () => (await authorization.get()).read_client_files.status,
      version: async path => await projectVersion(path, nodeBriefIo()),
      codexThread: query => findCodexThread(query, process.env.CODEX_HOME ?? `${home}/.codex`),
      // 同一套地址与钥匙(modelService.endpoint(),中转或他自己的 Key);模型名用不想的那一档(materializeModel.ts DEFAULT_EXTRACT_MODEL)。
      extract: (archive, today) => extractWithModel(archive, today, {
        endpoint: () => modelService.endpoint(),
        // own 档他自己填的模型名照用(2026-10-23,卡「事务官换Key」);relay 档 endpoint 里没有这一格,回默认那个。
        model: async () => (await modelService.endpoint()).model,
      }),
      /**
       * 第一件派活走卡 F 的 `dispatchItem`(0.2.87 合进 main):对这张已经建好的卡直接送话给那一家、收回结果才进「等我确认」,
       * 「做完叫你」是真的;送的是直接说给那一家听的那一句(agentText)。看板没接线时服务对象上没有它 → 退回老链路:
       * 给这张卡开一条事务官会话,点名那一家。
       */
      dispatch: async (input) => {
        const family = input.owner === 'codex' || input.owner === 'claude' || input.owner === 'kimi' ? input.owner : undefined
        /**
         * 派之前先按证据核一次这件事真到哪了(2026-09-25,卡 N):指令按证据写,不照引导里的旧话
         * (09-25 那一件照旧话写「架构还差一截、文案不用写」派给 Codex,他真正的下一步 —— 审文案 —— 没人管)。
         * 负责人驱动没起来时退回卡 F 的 `dispatchItem`(送引导排的那一句)。
         */
        const dispatchChecked = running?.dispatchChecked
        if (family !== undefined && dispatchChecked !== undefined) {
          await tasks.update(input.taskId, { assignee: family })
          return await dispatchChecked(input.taskId, { family })
        }
        const dispatchItem = running?.dispatchItem
        if (family !== undefined && dispatchItem !== undefined) {
          await tasks.update(input.taskId, { assignee: family })
          const got = await dispatchItem(input.taskId, { family, text: input.agentText, source: 'item' })
          return { ok: got.ok, note: got.note }
        }
        return await dispatchExistingItem({ tasks, opener: butlerSession }, input)
      },
      onApplied: async (input) => { await ob.recordMaterialized?.(input) },
      onChanged: () => pushSnapshot(),
    })
    await materialize.load()
    /**
     * 维护者 09-24 那一份存档(新版本装上之前就做完了引导):引导做完了、单子一次都没排过 —— 起服务时排一张,
     * 他明早拿手机就能在「等你确认」里点「就这样」,不用再聊一遍(「你不会让我准备再来一次吧?」)。后台排,不挡起服务。
     */
    if (ob.view().done && materialize.view() === undefined) {
      const mz = materialize
      setTimeout(() => { void mz.preview().catch(() => undefined) }, 5_000).unref?.()
    }
  }
  // 引导会话的回合表(2026-09-16,手机端引导):盯 DSH 原生事件里引导那一条会话的 user / assistant 文字。
  // 与 wireDshSessions 同一条事件总线、同一套「绝不抛」纪律;没有 ctx 时表保持空。
  // 一轮以错误结束 → 引导服务落盘「这条会话坏了」,下次续接另开一条(2026-09-23)。回调绝不抛。
  const onboardingTurns = createOnboardingTurns({
    onTurnEnd: (sessionId, outcome) => { void onboarding?.noteTurnEnd(sessionId, outcome).catch(() => {}) },
  })
  wireOnboardingTurns(ctx, onboardingTurns)

  /**
   * 通话模式(2026-09-17)。人设从 ~/.dsh/AGENTS.md 现读(引导写的那一份),上下文从看板现取——
   * 两样都不缓存:一通电话前后他手上的事可能刚变过。
   *
   * 工具通道只在 `WORKBENCH_RTC_CALLBACK_URL` 配了公网地址时才开:火山要能反向访问到 8791,
   * 本机没有公网地址。没配就不下发工具,人设里也明说这通电话记不了事项(见 server/rtcCall.ts 顶部)。
   */
  const rtcCall = createRtcCallService({
    agentsFile: defaultAgentsFile(home),
    tasks,
    ...(rtcCallbackUrlOf(process.env) === undefined ? {} : { callbackUrl: rtcCallbackUrlOf(process.env) as string }),
  })

  /**
   * 通道层(2026-09-17,docs/设计-手机通道层-2026-09-17.md)。人设与通话模式**同源**——
   * 名字、说话方式、事项摘要都从 server/rtcCall.ts 那几个纯函数取,工人一个字都不自己编。
   *
   * 凭据两条来源(2026-09-21 起):本机的环境变量 / `~/.dsh/workbench/channel.json` 优先
   * (那是"自己起了一台 livekit-server --dev"的开发机);没有就**向中转要** ——
   * 登录之后服务器下发,LiveKit 的 secret 从此不进这台机器。
   * 两条都没有时只有 /channel/status 回「没配 / 登录后可用」,签不出进房凭证——**不生成一对假的**。
   */
  /**
   * 没令牌时去补一下,那件事由 modelService 做 —— 而它在下面才建。这里只留一个口,
   * 接线在它建好之后那一行。(不这么做就得把 modelService 整个挪上来,
   * 而它依赖的几样又在别处,挪一个牵三个。)
   */
  let ensureDeviceToken: (() => Promise<{ ok: boolean, error?: string }>) | undefined
  const channelCredentials = createChannelCredentialStore({
    modelFile: defaultModelFile(home),
    ensureToken: async () => (ensureDeviceToken === undefined ? { ok: false } : ensureDeviceToken()),
    // **只写"取到没取到"**,一个值都不写(store 自己也守着这条)。
    log: line => console.log(`[channel] ${line}`),
  })
  /** 机器 id 第一次用到时定下来(server/machineId.ts);落不了盘就当没有,下次再试。 */
  const machineIdOnce = async (): Promise<string | undefined> => {
    try { return await readOrCreateMachineId(defaultMachineIdFile(home)) }
    catch { return undefined }
  }
  const channel = createChannelService({
    agentsFile: defaultAgentsFile(home),
    tasks,
    inboxName: CHANNEL_INBOX_NAME,
    rememberTool: CHANNEL_TOOL_NOTE,
    doingTool: CALL_TOOL_DOING,
    remote: channelCredentials,
    // 她自己填的识别钥匙(设置 › 各家的登录与密钥,零服务器档就靠它):有就先用,不往中转要。
    localKeys: async () => {
      const asr = volcAsrOf(await loadCredentials(defaultCredentialFile(home)))
      return asr === undefined ? {} : { volc_asr: asr }
    },
    // 他的规矩那一段(卡 K):每通电话现取,说话与全局那几条全文、其余短名。
    rulesBlock: () => rules.brief('say').text,
    sayLimit: () => rules.sayLimit(),
    /**
     * 她在资讯页上点了「打电话聊」的那一条(2026-10-13,卡「播客页重做」)。
     * **取一次就清**:它管的是接下来那一通,不是从此以后每一通 —— 工人每通电话现取人设,
     * 所以这一格一进人设,工人那边一行都不用改。
     */
    digBlock: () => feedDig.takeBlock() ?? firstUse.callBlock(),
    /**
     * 局域网主路(2026-10-21):本机房间名 `wb-local-<机器 id 前 8 位>` 与 `/channel/route` 的 `mac_id` 从机器 id 来;
     * 工人替房里的设备续期、`/channel/route` 的地址表从这台 Mac 此刻的网卡来(每次现取,换了 Wi-Fi 就跟上)。
     */
    machineId: machineIdOnce,
    lanAddresses: () => lanAddresses(),
  })

  /**
   * 本机房间的看管(2026-10-21,局域网主路卡 M1;server/localRoom.ts)。livekit-server 由 launchd 那一项
   * `ai.deepseek.livekit` 看着,这里只管两件事:① 装了二进制却没有钥匙(删过 channel.json)就补上并让它重起;
   * ② 每 30 秒看一次这台 Mac 的局域网地址,变了就 kickstart 它(不写死 node_ip,换了网卡要重起才认新地址)。
   * `/channel/status` 的 `local_room` 一格读它。没装二进制的机器上它什么都不做。
   */
  localRoom = createLocalRoomService({
    io: nodeSetupIo(),
    paths: setupPaths({ home }),
    lanAddresses: () => lanAddresses(),
    machineId: machineIdOnce,
    log: line => console.log(line),
  })
  localRoom.start()

  /**
   * 工人的常驻那一层(2026-09-17)。启动方式与 butler-server 同一套:插件按一个**固定的名字**
   * 去拉 `~/.dsh/bin/channel-start`(仓库里的 deploy/channel-start,Ben 自己 cp 过去)——
   * 插件打包进 ~/.dsh 之后不知道仓库在哪,路径全在那个脚本里。
   *
   * 传给脚本的环境变量里**只有地址,没有任何密钥**:工人的 LiveKit 凭证是向 8791 现要的,
   * DeepSeek 的 key 它自己从 credentials.json 读。
   */
  /** 见下面那段注释:等 8791 起来之后才填得上的那一格。 */
  let diagReport: NonNullable<WorkbenchServer['diag']>['report'] | undefined

  /**
   * 工人崩了又被拉起来时报一条(2026-09-22,四类自动上报里的 `crash_restart`)。
   *
   * **这里为什么要拐一个可变变量**:诊断服务是 `startWorkbenchServer` 里造的,
   * 而工人的看护比那台服务先造出来。所以先给它一个读 `diagReport` 的闭包,
   * 等 server 起来之后把那一格填进去(下面 `running` 赋值之后紧跟着那一句)。
   * 填上之前工人真崩了的话,这条就是 no-op —— 那会儿连 8791 都还没起来,
   * 也谈不上"把故障报给远处的人"。
   */
  /*
   * ★ **一条路线一条工人**(2026-10-22,局域网主路 M6;server/channelWorkerFleet.ts):本机房间有钥匙就一条,
   * 登录且中转配了云房间再一条 —— 在家的听筒与手机在本机房间,出门的手机在云房间。每条各自退避重启、各自日志、
   * 各自进程号文件,进程环境里报自己是哪条路线;哪几条该有由下面那根 30 秒的拍子问 `channel.workerRoutes()`。
   */
  /** 看管工人的那根 30 秒拍子开始了没有(下面 `watchWorkers`)。开始之前换房不去起工人(见 onRoomChanged)。 */
  let workerWatchStarted = false
  channelWorker = createChannelWorkerFleet({
    routes: options => channel.workerRoutes(options),
    make: route => channelWorkerForRoute(route, {
      env: {
        WORKBENCH_CHANNEL_WORKBENCH_URL: `http://127.0.0.1:${resolveWorkbenchPort(process.env)}`,
        // 工人自己那把身份令牌(卡 BS):**只在这里**给出去,不进 process.env —— 见 apply 开头那段。
        [WORKER_ACTOR_ENV]: actorTokens.worker,
      },
      home,
      dshEnv: process.env,
      log: line => console.log(line),
      // kickstart -k 硬杀工作台留下的孤儿工人:起新的之前先收掉(2026-10-10,见 channelWorkerReap.ts)。
      reaperFor: pidFile => createChannelWorkerReaper({
        pidFile,
        dshHome: dshHomeOf(process.env),
        log: line => console.log(line),
      }),
      onCrash: event => void diagReport?.({
        component: 'worker',
        kind: 'crash_restart',
        message: event.giving_up
          ? `通话工人(${CHANNEL_ROUTE_LABELS[event.route]})连着崩了 ${event.restarts} 次,不再自动拉起:${event.note}`
          : `通话工人(${CHANNEL_ROUTE_LABELS[event.route]})崩了第 ${event.restarts} 次,还会自动拉起:${event.note}`,
        log: [`退出:${JSON.stringify(event.exit)}`, `日志在 ${event.log_file}`],
      }),
    }),
    log: line => console.log(line),
  })

  /**
   * 在线设备表 + 传输流水(2026-09-21)。**只活在内存里**:真相在房间里,
   * 工人每次设备进出都会重报一份;工作台重启之后这张表是空的,等工人下一次上报补上
   * (`GET /devices/online` 那时如实说「工人还没报过」,不假装房里没人)。
   */
  const deviceDirectory = createDeviceDirectoryService()

  // 事务官外观的真相源(2026-09-16):~/.dsh/workbench/appearance.json,没文件就是「没存过」。
  const appearance = createAppearanceService({ file: defaultAppearanceFile(home) })
  await appearance.load()

  // 「在 Finder 里显示」(2026-09-11 图谱交互):图谱唯一的写接口,只做 `open -R` 定位。
  // 允许的范围就是项目区的扫描根——图上画的树本来就只来自这几个目录。
  //
  // ★ 2026-10-03:再加一份「界面上已经列出来的那几条确切路径」(运营同学 Air 的原件,
  // index.patch 的 index-09,逐字接入)。她那一格的素材入口点的就是这几条,而工作目录
  // 通常不在扫描根里。边界与为什么只能这样,见 server/reveal.ts 的 `listedPaths`。
  const reveal = createRevealService({
    roots: DEFAULT_SCAN_ROOTS(home).map(root => root.path),
    listedPaths: async () => {
      const view = template.view()
      return [
        ...Object.values(view.asset_dirs ?? {}),
        ...Object.values(view.asset_files ?? {}),
      ].filter(path => typeof path === 'string')
    },
    runCommand,
  })

  // 认领判定需要"壳报来的窗口移动落定到哪"——AXObserver 事件源(V8 已批),事件里只有
  // bundle_id/frame,交给 dockService 自己去查 registry 换算认领/整理/拖出。
  // C2 双保险的第二道:dock.handleMoved 内部已经把 screen_info 换算纳入 try/catch 不再抛出,
  // 这里再补一道 .catch 兜底——任何没预料到的拒绝都不能逸出这个事件回调变成
  // unhandledRejection 炸掉宿主进程。
  //
  // 悬停高亮 v1 起、Chromium AX 修复起 HelperEvent 是 moved|hover|ax_stale 的并集——这里
  // 认 moved 和 ax_stale,hover 事件原样忽略(它的广播接线在 http.ts,helper.onEvent 本就
  // 支持挂多个监听器,几条互不干扰)。
  helper.onEvent((event) => {
    if (event.kind === 'moved') {
      // dragged 缺省(旧壳)时 dock.handleMoved 按 true 走旧行为——兼容口径定义在 dock.ts。
      // pressed 缺省(旧壳)时按 false——「没有这条证据」,判定完全回到 dragged 那一档。
      void dock.handleMoved(event.bundle_id, event.frame, event.dragged, event.pressed).catch(() => {})
      return
    }
    if (event.kind === 'ax_stale') {
      // C2 同款纪律:dock.handleAxStale 内部已经把 registry.keyFor 纳入这条写队列,
      // 这里再补一道 .catch 兜底——任何没预料到的拒绝都不能逸出这个事件回调变成
      // unhandledRejection 炸掉宿主进程。
      void dock.handleAxStale(event).catch(() => {})
      return
    }
    if (event.kind === 'activation') {
      // 被叫到前面的那一家(2026-09-25,卡 P):截图遮罩把藏着的那家放出来了 → 藏回去;真切过去 → 窗口槽跟过去。
      const { kind: _kind, ...info } = event
      void dock.handleActivation?.(info)?.catch(() => {})
    }
  })
  // observe 下发(spec V2):告诉壳盯哪些 bundle 的 AXObserver。壳连上且授权时,
  // 以及窗口槽应用清单增删之后(下面 onAppsChanged),都要重发一次全量订阅集合——
  // 失败(壳没连上、还没授权)就吞掉,下一次壳状态变化/清单变化会再触发一次,不必在这里报错。
  // I4:壳对 observe 的回执里带了挂载失败的 bundle 清单(result.failed,空数组是常态)时,
  // 转呼 dock.noteObserveFailures 写一条如实的 note——不是每个应用都装得进去,得让
  // Ben 看得到"哪些拖拽认领不了",而不是拖进去发现没反应却不知道为什么。
  const sendObserveTargets = (): void => {
    void dock.observeTargets()
      .then(bundle_ids => helper.request({ op: 'observe', bundle_ids }))
      .then((res) => {
        const failed = res.failed
        // S3(review,真机截图实证):这里原来只在 failed 非空时才调 noteObserveFailures——
        // 意味着"这一轮 observe 全部成功"(failed 是空数组,或者压根没有这个字段)从来
        // 不会走到 noteObserveFailures,而清除陈旧 note 的逻辑正好就长在 noteObserveFailures
        // 里面(见 dock.ts:传空清单时,若当前 note 是上一次 observe 失败写的就清掉)——
        // 陈旧 note 因此永远等不到"这轮成功了"的信号,真机上只能靠重启工作台服务才会
        // 清掉(重启后 note 本来就是 undefined)。改成不管 failed 是不是空都调用,
        // noteObserveFailures 自己已经处理好"空清单"这个入参(不是空清单才写、是空
        // 清单就尝试清除陈旧 note),这里不用重复判断。
        const bundleIds = Array.isArray(failed) ? failed.filter((id): id is string => typeof id === 'string') : []
        // C2 同款纪律:noteObserveFailures 的 Promise 若被 `void` 直接丢弃,它自己的拒绝
        // 就跟外层这条 .then/.catch 链断了联系,再拒绝一次就是又一个未处理拒绝——必须
        // 就地挂 .catch,不能指望外层那道兜底替它接住。
        dock.noteObserveFailures(bundleIds).catch(() => {})
      })
      .catch(() => {})
  }
  /**
   * 壳上一拍是不是「连着且授权了」(2026-09-25)。壳每次被激活都会再报一遍 authorized,
   * 摆回只该在**真的(重新)连上**那一下排一次,不是他每点一下工作台就排一次。
   */
  let shellWasReady = false
  helper.onChange(() => {
    const shellReady = helper.view().authorized
    if (shellReady && !shellWasReady) {
      // 壳(重新)连上且授权:窗位上那扇窗可能已经不在原处 —— 记一笔「待摆回」(2026-09-25)。
      dock.noteShellReady?.()
    }
    shellWasReady = shellReady
    /*
     * 窗口槽成员表(2026-10-04,卡「常亮认窗口槽里的程序」):壳起来那一格缺省是空表,
     * 所以每次壳状态变化都补发一次 —— **不等授权**(同 away_awake:它只是一张名单,
     * 壳收完最多动那一条电源断言,而没授权的那台机器上她照样会点进槽里那扇窗)。
     * 平时的变化由 dock 自己在每次 dock.json 落盘后跟一发(见 dock.ts 的 persistDock)。
     */
    void dock.pushSlotApps().catch(() => {})
    if (helper.view().authorized) {
      sendObserveTargets()
      // 壳重启后呼吸圈永久消失(真机实证 2026-08-25):悬停圈只存在壳内存,壳重启即丢;
      // dock.setSlotRect 只在矩形真的变化时才推,但壳重启后页面重挂上报的还是同一个
      // 矩形,推送会被那道"没变就不推"的早退挡住。跟 sendObserveTargets 用同一个触发点
      // (壳重连且授权),C2 同款兜底:无条件重推一次,不指望矩形恰好变化。
      void dock.pushHoverZone().catch(() => {})
    }
  })

  // 手机配对与设备令牌(2026-09-11,决策记录 2026-09-11 第 1 条):devices.json 只存哈希;
  // 「允许手机在局域网访问」落 app.json,开着才另起 0.0.0.0 监听并广播 _workbench._tcp。
  const pairing = createPairingService({ file: defaultDevicesFile(home) })

  /**
   * 模型服务(2026-09-17):默认「用工作台提供的服务」,用户什么都不用填。
   * dshHome 传进去是为了切换时**顺带把 DSH 那一侧也切了**(写 settings.yaml 的 llm-pi-ai 段
   * 与 .env 的 WORKBENCH_RELAY_TOKEN);DSH_HOME 没设就按 ~/.dsh。
   * accountFile 是 feat/account-login 那张卡的产物,现在读不到也不算错(退回一个本机名字)。
   */
  /**
   * 账号搬到服务器(2026-09-21)。本机那份**一个字没改**,只是被包了一层:
   * 服务器上有账号服务就走服务器,没有(老中转、连不上)就原样退回本机。
   *
   * 先建它,因为 modelService 领设备令牌时要问它「此刻的账号会话是哪一张」——
   * 带上了,这台设备才记在账号名下,房间才由账号 id 算。
   */
  const localAccount = createAccountService({
    file: defaultAccountFile(home),
    keyFile: defaultAccountSessionKeyFile(home),
  })
  const account = createServerAccountService({
    local: localAccount,
    localFile: defaultAccountFile(home),
    sessionFile: defaultServerAccountFile(home),
    keyFile: defaultAccountSessionKeyFile(home),
    // 中转地址由 model.json 说了算(用户可以改),所以每次现读。
    relayUrl: async () => (await loadModelConfig(defaultModelFile(home))).relay_url,
    deviceName: async () => `${hostname()} 上的工作台`,
  })

  /**
   * DSH 自己的凭据服务(2026-10-01,Air 新装机引导卡在缺凭据):领到的模型令牌存进这里,立即生效,不用重启 DSH。
   * 服务缺席 / 形状变了就留 undefined —— modelService 退回「写 .env + 挑空闲时重启」那条老路。只存只删,不读值。
   */
  let dshCredentialStore: DshCredentialStore | undefined
  try {
    ctx?.inject(['credentials'], ((injected: { credentials?: { set?: (ref: string, value: string) => Promise<unknown>, unset?: (ref: string) => Promise<unknown> } }) => {
      const store = injected?.credentials
      if (typeof store?.set === 'function' && typeof store.unset === 'function') {
        dshCredentialStore = {
          set: (name, value) => (store.set as (ref: string, value: string) => Promise<unknown>)(name, value),
          unset: name => (store.unset as (ref: string) => Promise<unknown>)(name),
        }
        console.log('[模型] DSH 凭据服务接上了(领到的令牌直接存进去,不用重启)')
      }
    }) as (ctx: never) => void)
  }
  catch { /* 这一版 DSH 没有凭据服务:照旧走 .env */ }
  const modelService = createModelService({
    dshCredentials: () => dshCredentialStore,
    modelFile: defaultModelFile(home),
    credentialFile: defaultCredentialFile(home),
    dshHome: process.env.DSH_HOME ?? `${home}/.dsh`,
    accountFile: `${home}/.dsh/workbench/account.json`,
    relaySession: () => account.sessionToken(),
    /**
     * 「当前登录的账号是哪一个」(2026-09-27,卡 RM)。modelService 拿它比对
     * 「这台机器手上那把设备令牌是不是这个账号的」—— **房间名由那一列算**,
     * 对不上就是「电脑与手机在一间、座机在另一间」,提机没人接。
     */
    relayAccountScope: () => account.accountScope(),
    deviceName: async () => `${hostname()} 上的工作台`,
    /**
     * 换了一把属于别的账号的设备令牌 = **房间号换了**(卡 RM)。这时要做两件事,
     * 而且顺序是定的:
     *   ① 把手上那份通道凭据扔掉 —— 里头那个 `room` 是旧房间的名字,下一次现取才是新的;
     *   ② 让云房间那条工人跟过去 —— 它是进程启动那一下取凭证进房的,不重起就一直坐在旧房间里,
     *      座机在新房间提机它听不见(这正是 0927 座机那件事的后半段)。
     * ② 交给看管工人的那一拍(2026-10-22,卡 M6):`force` 当场重问中转,云房间换了名字那一条重起、
     * 刚登录才有云房间就补起那一条,本机房间那条不动。都**不 await**、失败只记一行。
     */
    onRoomChanged: (note) => {
      console.log(`[channel] 房间号换了(${note}):重取凭据、云房间那条工人跟过去`)
      try { channelCredentials.forget() } catch { /* 手上那份本来就可能没有 */ }
      /**
       * **拍子还没开始就不叫**。启动时的那次自检可能在 8791 听上端口之前就绑完了 ——
       * 那时起工人会让它去取一张取不到的凭证,白崩一次(崩一次要进 `crash_restart` 的账)。拍子第一下自己会取新房间。
       */
      if (!workerWatchStarted) return
      void channelWorker?.reconcile({ force: true }).catch((error: unknown) => {
        console.log(`[channel] 换房之后对工人没成:${error instanceof Error ? error.message : '未知错误'}`)
      })
    },
    liveReconcile,
    liveDocPath: () => configEditor?.documentPath,
    /**
     * 「设置模型变更 → 同一事务官入口继续说话」(2026-10-23 运行时 P1,真实 DSH 复现):
     * 模型设置的 DSH 侧目标一变,把**受这份设置控制**的会话(钉在我们维护的路由上的;
     * 「只换模型名」那一场,官方 provider 上正用被换掉的模型名的)重指到新目标 ——
     * 走 DSH `selectModel`,会话上下文保留,不新建、也不靠把旧模型留在 catalog 里凑。
     * feed 与 opener 都是后建/可缺席的,闭包惰性取。
     */
    onModelTargetChanged: async (change) => {
      const catalog = await butlerSession?.catalog?.().catch(() => undefined)
      const group = catalog?.groups?.find(g => g.id === change.provider)
      const ownModels = group?.models?.map(m => m.id) ?? []
      console.log('[model] catalog checked:', {
        provider: change.provider,
        model: change.model,
        availableModels: ownModels,
        hasTarget: change.model ? ownModels.includes(change.model) : true,
      })
      const targetModel = change.model ?? catalog?.default?.model
      if (targetModel === undefined || !ownModels.includes(targetModel)) throw new Error('MODEL_TARGET_UNAVAILABLE')
      return retargetManagedSessions({
        selections: async () => dshSessionFeed?.selections() ?? [],
        catalogDefault: async () => {
          const d = catalog?.default
          return d === undefined ? undefined : { provider: d.provider, model: d.model }
        },
        opener: butlerSession ?? {},
        change,
      })
      // 电话那条主路(工人)不吃这一声:它在**每通电话开始时**自己重读 model.json
      // (agent.ts 的每通刷新,与「认得出哪几家」同一条缝)—— 不打断在通的电话,
      // 也不擅自拉起他手动点停的工人。
    },
  })
  // 上面那个留给通道凭据的口,现在接上(2026-09-21)。**只补令牌,不碰模式与 DSH 的那两个文件**。
  ensureDeviceToken = () => modelService.ensureDeviceToken()
  /**
   * 启动时自检一次(2026-09-27,卡 RM)。09-27 之前装的机器手上那把令牌是 legacy 的
   * (那是**每一台新装机器的主路径**:装完先领令牌给引导用,登录在后面),
   * 房间与座机的对不上。更新到这一版之后,靠这一下**自己就好了** —— 用户什么都不用点。
   * 没登录、或者已经是本账号的,`bindToAccount` 一个字节都不动。**绝不抛**。
   */
  void modelService.bindToAccount().catch(() => undefined)

  /**
   * **中转上配了哪几家上游**(2026-09-26,卡 GH「中转配了哪家才出现哪家」)。
   *
   * 问的是中转的 `/health`(不含任何密钥,所以不带令牌),拿 `providers` 那一格;
   * **只在「走工作台提供的模型服务」那一档问**(他自己填 Key 直连官方时接口那只手本来就不可用)。
   * 起服务这会儿先问一次,之后 `/state` 那一拍上节流重问,设置里换模式 / 重领凭证时立刻重问。
   *
   * 取不到就按上次那份,从没取到过就当「一家都没配」—— 于是只走接口那只手的那几家(今天 = GPT)
   * 一处都不出现。线上那台中转此刻回的正是 `openai:false`。
   */
  const relayProviders = createRelayProvidersReader({
    endpoint: () => modelService.endpoint(),
    now: () => Date.now(),
  })
  // 起来就问一次:不等第一次 /state 那一拍(界面第一眼看到的名单就该是对的)。**绝不抛**。
  void relayProviders.read().catch(() => undefined)

  /**
   * 「在等你」(2026-09-25,卡 T;设计 docs/设计-Agent自动发现与统一接入-2026-09-25.md 第五节)。
   * - 读:sessionDigest 那张登记表(各家接入读到的会话文件),文件没动不读;Claude 自己记的「此刻在等什么」;Claude 子任务。
   * - 规则拿不准才问模型:**授权表 `read_session_content` 是「可以」**(卡 N 的那一项;没有这一项 / 没点头 = 只按规则),
   *   一天花费不超过 `~/.dsh/workbench/budget.json` 的 `cny`,按消息哈希只问一次。
   * - 答了往哪送 / 捎话往哪送:`sessionAnswer`。**窗口那只手 2026-09-26(卡 BR)接上了**:卡 O 已经进 main,
   *   派活那一层早就在生产里用同一套壳原语(`read_reply` 只读认记号、`send_text` 打字发送)往窗口里送话,
   *   而这一头一直空着 —— 于是「答」与「捎话」在生产上永远回「得你自己到那家里说」,那正是维护者 09-26 16:41
   *   电话里撞到的那件事(「它不能给你发信息」)。门:壳连上且**授权过辅助功能**、且这份壳会 `read_reply`;
   *   缺一样就整只手缺席(如实说,不假装送到了)。**命令行续一轮(`cli`)照旧没接**(那只手只有 Codex 有,
   *   而 `codex exec resume` 与终端里那条会抢同一份记录 —— 见 sessionAnswer.ts 那张表)。
   *   「去回答」仍用深链把那段对话开到前面。
   */
  /**
   * ★ **判断搬去 `engine/wireHands.ts` 了**(2026-10-03,卡「接缝清理」第 2 条):
   * 「包标识 → 窗位叠那一格的键」那一段反查从前没有用例够得着(交接 1002 第六节 ③),
   * 现在是纯函数、有用例钉着(`tests/engine-wire-hands.test.ts`)。这儿只剩接线。
   */
  const bringAgentToFront = async (bundleId: string): Promise<{ ok: boolean }> =>
    await bringAgentToFrontWith({
      keyFor: id => registry.keyFor(id),
      switchTo: key => dock.switchTo(key),
      // 退路与下面那一条同一只手(`open -b`),所以直接转呼它。
      openApp: id => openAgentApp(id),
    }, bundleId)
  /**
   * **把那一家的窗真正开出来**(2026-10-01,卡 AX)。`bringAgentToFront` 在窗口槽里认得它时只走
   * `dock.switchTo`(摆位,不保证开窗);这一条一定走 `open -b` —— 窗关了、只剩菜单栏图标的那一刻
   * (壳回「一扇标准窗口都没有」)靠它把窗开回来。
   */
  const openAgentApp = async (bundleId: string): Promise<{ ok: boolean }> =>
    ({ ok: (await runCommand(['open', '-b', bundleId])).ok })
  /** 深链只认这两家自己的(claude:// 与 codex://,见 sessionAnswer.ts 那张表),不经 shell。 */
  const openAgentDeepLink = async (url: string): Promise<{ ok: boolean }> =>
    ({ ok: /^(?:claude|codex):\/\//.test(url) && (await runCommand(['open', url])).ok })
  /**
   * 这一家在人话里叫什么(2026-09-28,卡 WR):**登记表里的显示名优先**。
   * `sessionAgentName` 只认写死那几家,而窗口型各家的 id 是包标识 —— 不换就会念出
   * 「你到电脑上的 com.bytedance.… 里自己说」。登记表里没有(老代码路径、用例)照旧退回它。
   */
  const relayFamilyName = (agent: string): string => {
    const name = agentDiscovery?.view().entries.find(one => one.id === agent)?.name?.trim()
    return name === undefined || name === '' ? sessionAgentName(agent) : name
  }
  /** 窗口型各家(豆包办公…)此刻那几条对话。答它那一问、为它那一问打电话,都要把它们算进来(2026-09-28 Air 维护包)。 */
  const windowSessionsNow = () => (agentDiscovery?.view().entries ?? []).flatMap(entry => entry.sessions.filter(registryOnlySession))
  /*
   * ★ **动作闸那边「这条会话收场了没有」就查这一份**(2026-10-02,卡 AG2)。
   * 与捎话候选池同一份(文件型 + 窗口型登记表里那几条)—— 两处判得不一样的话,
   * 闸会把还在的那条会话当成「没了」。
   */
  jobSessions = () => [...service.getState().sessions, ...windowSessionsNow()].map(one => ({ agent: one.agent, session_id: one.session_id }))
  /** 这条会话归哪一件事(卡上 `client_dispatch` 认下的那条);判法在 `jobKey.itemOfSession` 一处。 */
  const itemOfSessionNow = (agent: string, sessionId: string): string | undefined => itemOfSession(jobTasks, agent, sessionId)
  /**
   * ★ **这一家这台电脑上装着哪几个包、哪个开着**(窗口适配器挑包的输入;挑法在
   * `agentSources.pickFamilyPackage` 一处)。先问本机探测那一份(`installed_agents`,卡 HC),
   * 再补上登记表给的那个包 —— 两边都探不出就回 `undefined`(**「探不出」不是「一个都没装」**)。
   */
  const installedPackagesOf = (family: string): readonly { bundle_id: string, name?: string, running?: boolean }[] | undefined => {
    try {
      const probed = installedAgents.view()?.agents.find(one => one.id === family)
      const fromScan = probed?.packages ?? (probed?.bundle_id === undefined ? [] : [{ bundle_id: probed.bundle_id, name: probed.name }])
      const entry = agentDiscovery?.view().entries.find(one => one.id === family)
      const out: { bundle_id: string, name?: string, running?: boolean }[] = [...fromScan]
      if (entry?.bundle_id !== undefined && !out.some(one => one.bundle_id === entry.bundle_id)) {
        out.push({ bundle_id: entry.bundle_id, name: entry.name, ...(entry.app_running === undefined ? {} : { running: entry.app_running }) })
      }
      return out.length === 0 ? undefined : out
    }
    catch { return undefined }
  }
  /**
   * 这一家那扇窗**写得进去到什么程度**(`agentJudge.judgeStructure` 现查出来的那一格)。
   * `paste_only` = 自绘界面(读得到、写入靠粘贴);缺席 / `full` = 老样子。**一个 App 的名字都不写死**。
   */
  const structureModeOf = (family: string): StructureMode | undefined => {
    try {
      const bundles = new Set((installedPackagesOf(family) ?? []).map(one => one.bundle_id))
      const apps = agentDiscovery?.detail().apps ?? []
      return apps.find(one => bundles.has(one.bundle_id) && one.structure?.mode !== undefined)?.structure?.mode
    }
    catch { return undefined }
  }
  /**
   * **它压根没跑 → 先拉起来**(窗口适配器的 `ensureRunning`;2026-10-02 从 `dispatchClient.sendOnce` 搬过来)。
   * 拉起哪一家一律按**包标识**(`openCommandFor` → `open -b <包>`),所以运行时新接上的一家也拉得起来。
   */
  const ensureAgentRunning = async (family: string, bundleId: string): Promise<{ ok: boolean, reason?: string }> => {
    const command = openCommandFor(family, bundleId)
    if (command === undefined) return { ok: false, reason: `不知道怎么把 ${relayFamilyName(family)} 打开` }
    return await ensureRunningWith(command, bundleId, { runCommand, sleep })
  }
  /**
   * ★ **体检表上一家那几格的句柄**(2026-10-03,卡「0.4.87 启动崩溃」)。
   *
   * 体检表(`agentCaps`)在下面才建,而窗口那条通道在这儿就要接上它那两格
   * (`chat` / `collect`)—— 先占位、建完赋值,这样起服务时预热那一遍跑在建表之前也只是
   * 「这会儿问不到」(照「查不到」算),不会撞上 `const` 的暂存死区。
   *
   * **只给这一家的那几格,不给整张表**:整张表的第一件事是算「体检哪几家」,那一步会回头问
   * 引擎登记处的候选名单 —— 0.4.87 就是从那条边递归爆栈的(见下面 `capCells` 那一段)。
   */
  let capCellsOf: ((family: string) => ReturnType<AgentCaps['cellsOf']> | undefined) | undefined
  /**
   * **这件活对应看板上哪张卡**(Codex 那条通道要的两格 —— 在哪个目录干、叫什么 —— 都从这儿来)。
   * 没事项 id / 读不出看板 / 卡没了都回 `undefined`:**查不到就是查不到**,两格各自退到最保守那一档。
   */
  const codexCardOf = async (itemId: string | undefined) => {
    if (itemId === undefined || itemId.trim() === '') return undefined
    try { return (await tasks.list()).tasks.find(one => one.id === itemId) }
    catch { return undefined }
  }
  /**
   * ★ **一条引擎、一处登记**(2026-10-02,卡「引擎接线与删复制品」;
   * 设计 `docs/设计-一条引擎替八条管线-2026-10-02.md` 第三节)。
   *
   * 「往别家 AI 送一句话、把回答拿回来」从此只有这一条路:
   * 替她答 / 捎话 / 点选项 / 写面板 / 看按权限弹框 / 按停止 / 派活送话 / 新开一条 / 盯窗读回话,
   * **全部**经 `engine.run` / `engine.read`。闸(`actionGate`)与账(`jobLog`)只接在这一处。
   *
   * 三条通道:Claude 跨会话 socket、Codex `app-server`、每一家的窗口(一家一个实例,按家现造)。
   */
  /**
   * 有本机对话库的那几家(千问办公)的读法,一份两处用:发现那一边(在跑 / 做完 / 标题)与
   * 引擎里那条只读的「记录文件」通道(派活 / 捎话收回答先读它的库,读窗口兜底;2026-10-09)。
   * Claude / Kimi 收回答也走这条(2026-10-12):按记号在会话流那几条会话的记录文件里找那一轮 ——
   * 会话从 `/state.sessions` 来,文件按 `sessionHistory.locate` 找,与点开看完整对话同一份。
   */
  const recordReaders = createRecordReaders({
    home,
    transcripts: {
      sessions: () => service.getState().sessions,
      locate: (agent, id) => sessionHistory.locate(agent, id),
    },
  })
  /*
   * ★ **每一家一条窗口通道**(2026-10-21,卡「派活按家隔离」;`familyLanes.ts`):引擎里动窗口的每一下
   * (派活 / 捎话 / 替她答 / 电话里再派,全走这一条引擎)按家排队、有硬上限;「重置这一家」也清它。
   */
  const familyLanes = createFamilyLanes({
    now: () => new Date(),
    name: agent => relayFamilyName(agent),
    onJam: jam => { console.warn(`[lane] ${jam.family} · ${jam.step} · ${Math.round(jam.waitedMs / 1000)}s 没回应,判通道堵了`) },
  })
  const engineWiring = createEngineWiring({
    gate: actionGate,
    log: jobLog,
    lanes: familyLanes,
    records: recordReaders,
    name: relayFamilyName,
    // 闸上「这件事」的键:`jobKey.ts` 一处定法(引擎自己也用它)。
    gateJobOf: job => engineJobKey(job),
    /**
     * ★ **锁着屏时排进队等解锁**(2026-10-03,卡「锁屏时窗口型的家送不进」)。
     * 只排她那句话与派活(`engine.LOCK_QUEUE_KINDS` / `lockQueueable`);点键那几样不排(隔半小时那个框早不在了)。
     * 同一件派活别的手送成了,引擎经 `withdraw` 把排着的那条撤掉(2026-10-12)。
     */
    lockQueue: { add: (job, reason) => lockQueue.add(job, reason), withdraw: job => lockQueue.withdraw(job) },
    registry: {
      /** 这台电脑上探到装了的那几个包(候选名单的「在不在这台」那一格;探不出 = `undefined`,不是「一个都没装」)。 */
      installed: () => {
        try {
          const out: { bundle_id: string, running?: boolean }[] = []
          for (const one of installedAgents.view()?.agents ?? []) {
            const packages = one.packages ?? (one.bundle_id === undefined ? [] : [{ bundle_id: one.bundle_id }])
            for (const pkg of packages) {
              if (out.some(had => had.bundle_id === pkg.bundle_id)) continue
              const running = (pkg as { running?: boolean }).running
              out.push({ bundle_id: pkg.bundle_id, ...(running === undefined ? {} : { running }) })
            }
          }
          for (const entry of agentDiscovery?.view().entries ?? []) {
            if (entry.bundle_id === undefined || out.some(had => had.bundle_id === entry.bundle_id)) continue
            out.push({ bundle_id: entry.bundle_id, ...(entry.app_running === undefined ? {} : { running: entry.app_running }) })
          }
          return out.length === 0 ? undefined : out
        }
        catch { return undefined }
      },
      /**
       * **家族目录不认识、却已经认成一家**的那几条(`agentDiscovery` 判成 Agent 的陌生 App:
       * Grok Bot / Antigravity / 可灵)。身份判照旧只在 `agentDiscovery` 里对**陌生 App** 判一次;
       * 判成了就当一家喂进来,候选名单与送话都认得它 —— **这里不判、不调模型**。
       */
      extra: () => {
        try {
          return (agentDiscovery?.view().entries ?? [])
            .filter(one => one.self !== true && bindingFor(one.id) === undefined)
            .map(one => ({ family: one.id, name: one.name, ...(one.bundle_id === undefined ? {} : { bundle_id: one.bundle_id }) }))
        }
        catch { return [] }
      },
    },
    /**
     * ★ **Claude 桌面走它自己的跨会话 socket**(官方 `code.claude.com/docs/en/cross-session-messaging`)。
     * 从前往 Claude 那条会话里送一句话走的是最脆的一级(辅助功能树里找窗口 → 找那段对话 → 打字),
     * 真机日志里清一色「没在它的窗口里找到那段对话」。`locate` 要传 `sessionHistory.locate`
     * (它还认登记过的文件与别家)—— 适配器自带的那一份只扫 `~/.claude/projects`,是给脚本单跑用的。
     */
    claude: { locate: (agent, id) => sessionHistory.locate(agent, id) },
    /**
     * ★ **第三档证据:那条会话自己的记录文件**(卡 AW 三档里最硬的那一档)。
     * 窗口那一层送完说「按了发送、核不上」时,回这条会话的记录里看多没多出她那句;
     * 核上了就是 `confirmed`。窗口型那几家没有记录文件(`locate` 回不出来)→ 这一档自动缺席。
     */
    transcript: createTranscriptEvidence({
      locate: (agent, id) => sessionHistory.locate(agent, id),
      why: agent => windowUnconfirmedWhy(relayFamilyName(agent)),
    }),
    /**
     * ★ **Codex 桌面走 `codex app-server` 协议**(10-02 端到端验通:发一句、回一句,全程没碰窗口)。
     * 两格都按 `job.itemId` **查卡**(`Job` 是锁死的契约,卡上那几格不在里头):
     * - `workdir(job)` 不接上派活永远是只读的 —— 这件活在哪个目录干、许不许改文件;
     * - `title(job)` 不接上协议开的线程就没名字 —— 她的 ChatGPT App 侧栏按 `thread_name` 列
     *   (2026-10-03 拍板 ③甲,`docs/交接-1003-Codex线程起名.md`)。
     */
    codex: {
      /**
       * ★ **四档的判断搬去 `engine/wireHands.ts` 了**(2026-10-03,卡「接缝清理」第 2 条):
       * 从前只有真机那一跑的 rollout 文件作证(交接 1002 第六节 ④),现在四档各有用例。
       */
      workdir: job => codexWorkdirOf({ cards: async () => (await tasks.list()).tasks }, job),
      title: async job => (await codexCardOf(job.itemId))?.title,
    },
    /** 窗口那一条(一家一个实例;每一格都带 `family` 参数,所以一份就够)。 */
    window: {
      helper: {
        connected: () => {
          const view = helper.view()
          return view.connected && view.authorized
        },
        request: (req, timeoutMs) => helper.request(req, timeoutMs),
        supports: cap => helper.supports?.(cap) ?? false,
      },
      bundleOf: family => agentDiscovery?.view().entries.find(one => one.id === family)?.bundle_id,
      installed: installedPackagesOf,
      /**
       * ★ **认出是 AI 应用、可那扇窗读不到**的那几家(审计第二表第 7 条收成一份):
       * 从前只有派活那两处查它,答 / 捎话不查 —— 同一家 Kimi,派活当场说「读不到,派不了」,
       * 替她答却照样叫台前、照样打字、白等一圈。现在这一格在窗口这条通道上,三个入口同一句。
       */
      unreadable: () => {
        try {
          return (agentDiscovery?.view().unreadable ?? []).map(one => ({ id: one.id, name: one.name, bundle_id: one.bundle_id }))
        }
        catch { return [] }
      },
      hostIdOf: (family, sessionId) => waiting?.hostIdOf(family, sessionId),
      nameOf: relayFamilyName,
      structureMode: structureModeOf,
      /**
       * ★ **体检表上这一家那几格 —— 只问这一家**(2026-10-03,卡「0.4.87 启动崩溃」)。
       *
       * 从前这一格是 `caps: () => agentCaps.view()`(整张表),而整张表的第一件事是算
       * 「体检哪几家」(下面那个 `families`)→ `capTargetsFor` → `engineRegistry.targetsNow()`:
       * 「这一条通道会什么」于是绕一圈回去问「有哪几家」,同步递归爆栈 ——
       * 0.4.87 在维护者那台上 8791 永不响应、launchd 每 5 分钟重启一次就是它。
       * 现在只问 `cellsOf(family)`:**存在与能力分开**,这条边不存在了。
       *
       * `capCellsOf` 是下面那张体检表的句柄(它在这一行之后才建;见那一处的赋值)——
       * 起服务时预热那一遍跑在建表之前,这一格那会儿缺席,照「查不到」算,不编一个。
       */
      capCells: family => capCellsOf?.(family),
      /**
       * ★ **这一刻电脑锁着屏没有**(2026-10-03,卡「锁屏时窗口型的家送不进」)。
       *
       * 出处是壳(`ScreenLockPolicy.isLocked` 读 `CGSessionCopyCurrentDictionary()`),
       * 由下面那个 `screenLockWatch` 每 3 秒问一次、缓存着。为真时窗口这一层**一个 op 都不发**
       * (锁屏时那几家起不出窗,送 / 点 / 开窗 / 换包全是白做 —— 09:04 真机 7 秒 `open -b` 五次)。
       * `undefined` = 还没问到 / 问不到 → **照旧送**(不知道不许当成锁着)。
       */
      screenLocked: () => screenLockWatch?.locked(),
      openUrl: openAgentDeepLink,
      openApp: openAgentApp,
      bringToFront: bringAgentToFront,
      ensureRunning: ensureAgentRunning,
      // 框里她没发出去的那段字:先存后放回(卡 DB)。**收成一份**(审计第二表第 4 条)。
      saveDraft: input => saveClientDraft(input),
      draftNote: input => draftSavedNote(input),
      /** `window_wake`(把她的窗弹到眼前)这一样只存在于这一层 —— 不接在这儿就没人数得了那几回。 */
      gate: actionGate,
      gateJobOf: job => engineJobKey(job),
      now: () => new Date(),
    },
  })
  void (tasks === undefined ? Promise.resolve(0) : seedCliDispatchSessions(tasks).catch(() => 0))
  const engine = engineWiring.engine
  const engineRegistry = engineWiring.registry
  /**
   * 会话那几条路(替她答 / 捎话 / 点选项 / 写面板 / 看按权限弹框 / 「去回答」/ 「不用管这条」)。
   * **判断在这一层,动手在引擎** —— 怎么开到那一段、怎么打字、没窗口怎么开窗、过闸、落账,一样都不在这儿。
   */
  const sessionAnswer = createSessionJobs({
    engine,
    registry: engineRegistry,
    // 窗口型那几条的 `agent` 是登记表 id(字符串),不在 AgentId 那几家里 —— 答题这一路只按 id 找,放宽无妨。
    sessions: () => [...service.getState().sessions, ...windowSessionsNow() as unknown as ReturnType<typeof service.getState>['sessions']],
    /** **窗口型各家登记表里那几条对话**(2026-09-28,卡 WR):捎话候选 = 文件型那几条 + 这一份。 */
    windowSessions: () => (agentDiscovery?.view().entries ?? []).flatMap(entry => entry.sessions.filter(registryOnlySession)),
    /**
     * ★ **只有记录文件的那几条**(2026-10-13 夜,卡 X):重启后他点开的旧会话,卡 W 按 id 找到并登记在 `sessionDigest`,
     * 这里把登记表映成最简的会话视图并进捎话候选池(状态写 done:它早就不在跑了;标题用那家自己叫它的名字)。
     */
    recordedSessions: () => sessionDigest.files().map(one => ({
      agent: one.agent,
      session_id: one.session_id,
      ...(one.name === undefined ? {} : { title: one.name }),
      project: UNKNOWN_PROJECT,
      status: 'done' as const,
      elapsed_sec: 0,
      unread: false,
      updated_at: new Date(0).toISOString(),
    })),
    /**
     * ★ **CLI 派活起的会话**(2026-10-23 深夜,卡 A 硬门槛前置):命令行那只手留下的会话号
     * 写在任务 links,但不在文件型/窗口型/记录型任何一池 —— 内存镜像(cliDispatchSessions.ts)
     * 喂进来,relay 才认得;发送走 cli 通道的 `--session` 续跑(适配器那一支只接 Kimi)。
     */
    cliSessions: cliDispatchSessions,
    /** 这一家的窗口是哪个包(窗口型各家:登记表里那一条)。 */
    bundleOf: agent => agentDiscovery?.view().entries.find(one => one.id === agent)?.bundle_id,
    entryOf: (agent, sessionId) => waiting?.entryOf(agent, sessionId),
    hostIdOf: (agent, sessionId) => waiting?.hostIdOf(agent, sessionId),
    agentName: relayFamilyName,
    dismiss: async (agent, sessionId) => await waiting?.dismiss(agent, sessionId) ?? false,
    // 认批准弹窗用的那几截原字(这一步的命令 / 文件;卡 AP)。只在服务端用,不上 /state。
    approvalMarksOf: (agent, sessionId) => waiting?.verdictOf(agent, sessionId)?.marks,
    /** 这条会话归哪一件事(卡 AG2):闸的「收场了就不再动那一家」要一个键。 */
    itemOf: itemOfSessionNow,
    /**
     * ★ **替她答完,只读一眼它窗口主对话区那几行**(2026-10-13 下午,卡 C)。
     *
     * 用的是**现成的只读 op**(`agent_read`,与登记表读窗那一路同一条;一个字都不送、一颗键都不按),
     * 筛行在 `agentWindowModel.transcriptRows` 一处。读不到(壳没连上 / 没授权 / 这一家没有包)
     * 回 `undefined` —— 那时判不出哪一行是新的,`sessionJobs` 照旧按壳的回执说话。
     */
    askWindowLines: async (agent) => {
      const bundleId = agentDiscovery?.view().entries.find(one => one.id === agent)?.bundle_id
      const view = helper.view()
      if (bundleId === undefined || !view.connected || !view.authorized) return undefined
      try { return transcriptRows(parseRead(await helper.request({ op: 'agent_read', bundle_id: bundleId }, 6000))) }
      catch { return undefined }
    },
  })
  /**
   * **捎完话、那家回了就回个电话给他**(2026-09-27,卡 CB;维护者原话:「事务官得回电话给我」)。
   *
   * 轻账 + 巡检在 `server/relayWatch.ts`,这里只把三根线接上:
   * - 读那扇窗:**走引擎的 `read`**(2026-10-02):闸(`reply_watch`)、挑哪条通道、挑哪个包、
   *   豆包办公那一路多读一次整扇窗,全在引擎与适配器一处 —— 这一层从此不认识壳;
   * - 排电话:`callOut.request`(免打扰时段自动只发通知,那条规矩一个字没改);
   * - 家名:`sessionAgentName`(电话里、手机上说的是「Claude」,不是 `claude`)。
   */
  const relayWatch = createRelayWatchService({
    file: defaultRelayWatchFile(home),
    reader: createEngineRelayReader({ engine }),
    callOut: { request: input => callOut.request(input) },
    /*
     * ★ **回电标题里那一家叫什么:登记表里的显示名**(2026-10-02;审计第二表第 10 条)。
     * 从前这里是 `sessionAgentName`(只认写死那几家),而捎话回包走的是 `relayFamilyName`
     * (登记表显示名)—— 于是同一条捎话,回包里说「豆包办公」、电话标题里念出
     * 「com.work.pc.doubao」。两处收成一份,就用登记表那一份。
     */
    agentName: relayFamilyName,
    /**
     * 这条捎话归哪一件事(2026-10-02,卡 AG2):记一条的时候问一次,记进轻账 ——
     * 于是她在看板上把那件收了,巡检这就停手,不用等 20 分钟那个超时。
     */
    itemOf: itemOfSessionNow,
    jobLog,
  })
  await relayWatch.load()
  /**
   * ★ **「这一刻锁着屏没有」那一拍 + 解锁重送**(2026-10-03,卡「锁屏时窗口型的家送不进」)。
   *
   * 挂在 http 那根既有的 1 秒节拍上(内部 3 秒限频,见 `screenLockWatch.ts`)。
   * 问的是壳那条只读 op `screen_info`(它只读 NSScreen + `CGSessionCopyCurrentDictionary()`,
   * 不碰别人的窗口);老壳不报那一格 → `undefined` = 不知道 → 窗口那一层照旧送。
   */
  /** 解锁重派那一座桥(`running` 起好之后 `dispatchItem` 才有,所以每次现取)。 */
  function lockQueueDispatchNow(): LockQueueDispatch {
    return createLockQueueDispatch({
      run: async job => await engine.run(job),
      findTask: async id => (await tasks.list()).tasks.find(one => one.id === id),
      dispatchItem: async (taskId, input) => {
        const dispatchItem = running?.dispatchItem
        if (dispatchItem === undefined) return { ok: false, note: '任务看板未启用,派不了' }
        return await dispatchItem(taskId, input)
      },
      releaseCard: async (taskId, note) => {
        const block = (await tasks.list()).tasks.find(one => one.id === taskId)?.dispatch_block
        if (block === undefined) return
        const { unlock: _unlock, ...rest } = block
        void _unlock
        await tasks.update(taskId, { note, dispatchBlock: { ...rest, why: note } })
      },
    })
  }
  /**
   * ★ **解锁 / 巡登记表两拍同一套重送 deps**(2026-10-23,卡「捎话留言等它醒」收进这一处):
   * 重送就是再调一次 `engine.run` —— 落账、过闸、换包换路一样都不在这儿。两拍只差两格:
   * 解锁那一拍全送(不传);巡登记表那一拍传 `shouldSend` + 自己的 `log`(见下面那只 watch)。
   *
   * `after`:捎话送成了要**登记一条回电**(live 那条路由在 http 里登记,排队这条路得在这儿补;
   * **「留言等它醒」那一下的回电也是这一处补** —— http 那一处当场说了不登记)。
   * `from` 记 `desk`:`Job` 上没有「这一句当初是从手机还是电话来的」那一格,
   * 用的是 http 那一处同样的缺省值 —— 交接第二节写明了这是排队重送与 live 唯一的差别。
   */
  function lockDrainDeps(extra: Pick<LockQueueDrainDeps, 'shouldSend' | 'log'> = {}): LockQueueDrainDeps {
    return {
      queue: lockQueue,
      /*
       * ★ 派活那几条(2026-10-12)经 `dispatchItem` 整件重派、回到派活的正常流程(卡、盯窗、自查);
       * 重派之前按卡上的事实问一句「还在等吗」。她那句话那几样照旧再调一次引擎。见 `lockQueueDispatch.ts`。
       */
      run: async (job: Job) => await (lockDispatch ??= lockQueueDispatchNow()).run(job),
      stillWanted: async (job: Job) => await (lockDispatch ??= lockQueueDispatchNow()).stillWanted(job),
      after: async (job: Job, out: JobResult) => {
        /*
         * ★ **她当初勾了才补登记**(2026-10-04,卡 `claude/relay-nocall-noread`;判据与那三样
         * 一处写,见 `relayWatchOnDrain`)。不勾的那一句照旧重送 —— 只是不盯、不读、不回电。
         */
        if (!relayWatchOnDrain(job) || job.target.kind !== 'session') return
        await relayWatch.remember({
          agent: job.family,
          session_id: job.target.sessionId,
          title: '',
          mark: job.confirmMark !== undefined && job.confirmMark.trim() !== '' ? job.confirmMark : relayReadMark(job.text),
          from: 'desk',
          ...(out.bundle_id === undefined ? {} : { bundle_id: out.bundle_id }),
          ...(out.delivered === 'unconfirmed' ? { unconfirmed: true } : {}),
        })
      },
      warn: line => { console.log(line) },
      ...extra,
    }
  }
  screenLockWatch = createScreenLockWatch({
    ask: async () => {
      const view = helper.view()
      // 壳没连上 / 辅助功能没授权 → 问不到(`screen_info` 在授权门里面)。**不知道,不编一个**。
      if (!view.connected || !view.authorized) return undefined
      return screenLockedOf(await helper.request({ op: 'screen_info' }, 5000))
    },
    /** 解锁了:**按原顺序**一条一条重送(重送就是再调一次 `engine.run`)。 */
    drain: async () => await drainLockQueue(lockDrainDeps()),
    warn: line => { console.log(line) },
  })
  /**
   * ★ **「哪条睡着的会话醒过来了」那一拍**(2026-10-23,卡「捎话到没开着的会话留言等它醒」)。
   *
   * 与 `screenLockWatch` 同款挂在 http 那根既有的 1 秒节拍上(内部 5 秒限频,见 `sessionAwakeWatch.ts`):
   * 排着等它醒的那几条留言,哪条会话的 socket 在了就把哪条重送。`shouldSend` 只放行**目标为
   * claude 会话的捎话 / 替她答**(用 `claudeSessionOpen` 现问登记表 + socket 文件在不在)——
   * 锁屏排的那几件(派活)与别家的留言回 false,留在队里等各自那一拍(解锁那一拍 / 下一拍)。
   */
  sessionAwakeWatch = createSessionAwakeWatch({
    drain: async () => await drainLockQueue(lockDrainDeps({
      shouldSend: async (job) => {
        if (job.kind !== 'relay' && job.kind !== 'answer') return false
        if (job.family !== CLAUDE_FAMILY || job.target.kind !== 'session') return false
        return await claudeSessionOpen(join(home, '.claude'), job.target.sessionId)
      },
      log: SESSION_AWAKE_LOG,
    })),
    warn: line => { console.log(line) },
  })
  /**
   * ★ **「出门时电脑不睡」那一拍**(2026-10-03,卡「出门时电脑不睡」;**缺省关**)。
   *
   * 同样挂在 http 那根既有的 1 秒节拍上(内部 5 秒限频,见 `awayAwake.ts`)。两份现成的事实,
   * **一个新心跳都不造**:
   *   ① 在线设备表(`deviceDirectory`,工人在房里报的 —— 手机按需进房,在局域网里会把房间放掉,
   *      所以一台手机出现在这张表里就是它这会儿在外面经中转说话);
   *   ② 配对记录(`pairing.list()`)—— 认出哪一台是**手机**而不是那只常驻房间的树莓派话筒
   *      (中转签的凭证一度不带 `wb_kind`,照上报那一格判会把她在家判成出门)。
   * 读不出配对表 / 表旧了 / 没接通道层 = **不知道** → 不按住(按反了她家里那块屏整天亮着)。
   */
  awayAwakeWatch = createAwayAwakeWatch({
    settingOn: async () => (await appConfig.get()).away_keep_awake === true,
    devices: pairedKinds => deviceDirectory.view(pairedKinds),
    paired: async () => {
      try { return new Map((await pairing.list()).map(one => [one.id, one.kind ?? 'phone'] as const)) }
      // 读不出配对表(文件坏了、还没配过对):**不知道**,不拿上报里那一格当真(见上面②)。
      catch { return undefined }
    },
    send: async active => { await helper.request({ op: 'away_awake', active }) },
    connected: () => helper.view().connected,
    warn: line => { console.log(line) },
  })
  /*
   * 壳连上 / 断开 / 授权变了 → **忘掉「上次发过什么」**,下一拍把结论重发一次。
   * 光靠那一拍里的 `connected()` 不够:每 5 秒才看一眼,壳在两拍之间断开又接上就被完全错过,
   * 而那时它内存里那一格已经回到缺省的 `false`(见 `awayAwake.ts` 的 `forget` 注释)。
   * 壳弹一条系统通知也会响这个回调,那种不算(`helperChanged` 只认连法变了)。
   */
  helper.onChange(() => { awayAwakeWatch?.helperChanged({ connected: helper.connected(), authorized: helper.view().authorized }) })
  waiting = createWaitingService({
    sessions: () => service.rawSessions(),
    files: () => sessionDigest.files(),
    /**
     * 读窗口读出来的那几家(2026-09-26,卡 WS):窗口型 Agent 没有会话文件,只有壳读回来的「最新那句」——
     * 过**同一份**内容判断(同一个花费上限、同一份缓存)。登记表在下面才建好,走可变引用的闭包
     * (同上面 `sessionAnswer` 那几处);还没建好时这一路是空的,别的一字不变。
     */
    windows: () => agentDiscovery?.windows() ?? [],
    claudeLive: () => readClaudeLiveSessions(`${home}/.claude`),
    model: {
      endpoint: () => modelService.endpoint(),
      // own 档他自己填的模型名照用(2026-10-23,卡「事务官换Key」);relay 档 endpoint 里没有这一格,回 WAIT_MODEL。
      model: async () => (await modelService.endpoint()).model,
      allowed: async () => {
        if (authorization === undefined) return false
        const table = await authorization.get() as Readonly<Record<string, { status?: string } | undefined>>
        return table.read_session_content?.status === '可以'
      },
      budgetCny: () => readBudgetCny(defaultBudgetFile(home)),
    },
    // 小账本:今天问模型花了多少、他点过「不用管这条」的是哪几条(不记内容)。
    stateFile: defaultWaitingLedgerFile(home),
    onChange: () => pushSnapshot(),
    agentName: sessionAgentName,
    replyOf: (view, ask) => sessionAnswer.replyOf(view, ask),
  })
  /**
   * 数据复盘那三条建议真去调模型的地方(2026-09-21)。走 modelService 定的那一家
   * (默认是工作台自己的中转),**不另存一份令牌、也不另开一条通道**。
   * 没领到令牌 / 没填 Key 时 `ready` 是 false,这里直接抛 —— 上层据此不生成建议。
   */
  /**
   * 「问一次模型」。2026-09-21 从数据复盘那条抽出来,现在有两家在用(数据复盘的建议、
   * 会议纪要的梳理),所以 `maxTokens` 成了参数 —— 别的一个字没改。
   * 走 modelService 定的那一家(默认工作台自己的中转),**不另存一份令牌、不另开一条通道**。
   */
  const askModel = async (prompt: string, maxTokens: number): Promise<string> => {
    const endpoint = await modelService.endpoint()
    if (!endpoint.ready) throw new Error('模型服务还没接上')
    const response = await fetch(`${endpoint.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(endpoint.key === undefined ? {} : { authorization: `Bearer ${endpoint.key}` }),
      },
      body: JSON.stringify({
        // 2026-09-28(卡 BS):模型名从 `deepseek-chat` 换成 `deepseek-v4-flash` —— 中转记账认不出的名字
        // 一律按 Pro 价算(`relay/server/pricing.cjs` priceTierOf),而它转给上游的本来就是 Flash,白贵 3–4 倍。
        // 换了名字就得自己把思考关掉(照 progress.ts / waitingService.ts):这几问要的是照材料写几行字,不用想。
        // own 档他自己填的模型名压过它(2026-10-23,卡「事务官换Key」)。
        model: endpoint.model ?? DIRECT_MODEL,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: maxTokens,
        temperature: 0.4,
        thinking: { type: 'disabled' },
      }),
    })
    if (!response.ok) throw new Error(`模型服务回了 ${response.status}`)
    const json = await response.json() as { choices?: { message?: { content?: unknown } }[] }
    const content = json.choices?.[0]?.message?.content
    if (typeof content !== 'string') throw new Error('模型没回内容')
    return content
  }
  /**
   * 资讯那两件要模型干的活(2026-09-21):给条目打分、写口播稿。**max_tokens 给得多**
   * (口播稿三到六分钟 ≈ 700–1300 字,400 token 会把稿子切一半)。
   *
   * 合并 merge/sprint-2:原来这里是一段和 askModel 逐字相同的 fetch(会议那张卡把它抽成了
   * askModel),改成调 askModel —— model / max_tokens 2000 / temperature 0.4 一个字没变。
   */
  feedChat = async prompt => await askModel(prompt, 2000)
  // 建议是要贴到界面上的几行字,不需要长输出;短一点也少烧他的额度。
  xhsChat = async prompt => await askModel(prompt, 400)
  // 纪要要把一场会梳理成五段,400 不够 —— 一小时的会梳出来常有几十行。
  meetingChat = async prompt => await askModel(prompt, 2000)
  // 内容框架固定五段、每段一两句话,600 够;提示词那头反而长(整份逐字稿都在里面)。
  collectChat = async prompt => await askModel(prompt, 600)
  // 认风格候选:一批 8 句,回的只是几条 {n,id,quote},600 够。
  styleChat = async prompt => await askModel(prompt, 600)
  // 日报四段:回的是一个 JSON 数组,每段最多 5 条、每条一两句,800 够(正文还有 1200 字的闸)。
  dayReviewChat = async prompt => await askModel(prompt, 800)
  // 启动时那一遍认风格放在模型接上之后(上面那一遍认不了,只数决策习惯与改稿)。
  void habits?.learn({ style: true }).then(done => console.log(`[习惯] 风格:${done.note}`)).catch(() => undefined)

  // appConfig 在上面(项目区之前)就建好了——同一份 app.json,同一个写队列,不能建两个实例。
  /**
   * 「注册/登录那一刻自动把模型服务接上」(2026-09-18,决策记录同日「新用户零凭据」)。
   *
   * 两个依赖都在这里接,因为只有这里看得见它们:
   * - `exec` 用的是上面那个不带 cwd 的 runCommand(同 butler 的启停);
   * - `dshSessionCount` 从 service 的内存态里现数一遍 agent==='dsh' 的会话 —— **有活儿在跑就不重启**。
   *   注意 kickstart 杀的是 DSH 这个进程,而工作台插件就住在里面(同 update/apply.ts 那一下)。
   */
  const modelAutoSetup = createModelAutoSetup({
    model: modelService,
    exec: async cmd => ({ ok: (await runCommand(cmd)).ok }),
    dshSessionCount: () => service.getState().sessions.filter(session => session.agent === 'dsh').length,
  })

  /**
   * 统一输入框(2026-09-24):四个菜单、附件落处、审批。附件落进与手机「发文件」同一个收件文件夹。
   * 审批经纪人排在 DSH 审批 waterfall 的最前面(wireApprovalAnswerer),档上与手机上都能点。
   */
  const composer = createComposerService({
    choiceFile: `${home}/.dsh/workbench/composer.json`,
    inboxDir: defaultComposerInboxDir(process.env, home),
  })
  const approvals = createApprovalBroker()
  /**
   * 事务官要问的话、要批的事摆到外层(2026-09-25,卡 M;维护者点名的 bug):
   * 提问与审批两条 waterfall 都排最前面;审批配上人话,同一件事里同类的可以一次都允许。
   */
  /**
   * 「这件事里同类的都允许」落盘(卡 M 追加;统筹:DSH 重启后不能再问一遍同一类;这件事结束就作废)。
   * 读盘是异步的:读回来之前进来的审批照常问(宁可多问一次)。
   */
  const approvalGrants = createApprovalGrants({ file: defaultApprovalGrantsFile(home) })
  void approvalGrants.load()
  wireApprovalAnswerer(ctx, approvals, {
    grants: approvalGrants,
    // 学到的「这类不问,做完告诉她」(卡「数出习惯」;沾四类的照旧问)。
    habits: habitService,
    home,
    repoRootOf: path => findRepoRoot(path, home, existsSync),
    taskOf: async (sessionId) => {
      const task = (await tasks.list()).tasks.find(one => one.conversation?.session_id === sessionId)
      return task === undefined ? undefined : { id: task.id, status: task.status }
    },
  })
  const questions = createQuestionBroker()
  wireQuestionAnswerer(ctx, questions)
  askEventsNow = async () => {
    const list = (await tasks.list()).tasks
    return [
      ...askCallOutEvents(questionViews(questions.list(), list), approvalViews(approvals.list(), list)),
      /**
       * **某家会话自己停下来在等他**(2026-09-28,卡 WQ;链上第 ⑦ 环)。维护者 16:1x:
       * 「为什么有需要确认的,事务官都读到了,但是不给我打电话……这可是核心功能啊。」
       * 判据、不重复那三条都在 `server/sessionAskCalls.ts`;这里只把已有的两份事实接上:
       * 叠过「在等你」的会话表(`service.getState().sessions`,与 `/state.sessions` 同一份)与看板。
       */
      // 窗口型各家那一问(豆包办公的选择题)也打电话(2026-09-28 Air 维护包)。
      // ★ 超过一天没动的那条会话里的框不响铃(2026-10-13,统筹定):`nowMs` 就是这道筛子的开关。
      ...sessionAskCallOutEvents({ sessions: [...service.getState().sessions, ...windowSessionsNow()], tasks: list, nowMs: Date.now() }),
    ]
  }
  /**
   * 不许在他正在用的那份仓库里切分支、改文件(2026-09-25,卡 O + 统筹补充)。受保护的 = 他登记过的项目目录里是
   * git 仓库的那几个 + 工作台自己的仓库根;`.worktrees/`、`.claude/worktrees/` 底下的独立工作区与她自己的工作目录不算。
   * 名单 30 秒现取一次(项目区改了下一拍就算数)。
   */
  let guardCache: { at: number, context: GuardContext } | undefined
  wireCheckoutGuard(ctx, async () => {
    if (guardCache !== undefined && Date.now() - guardCache.at < 30_000) return guardCache.context
    const roots = new Set<string>()
    if (evolveRepo?.root !== undefined) roots.add(evolveRepo.root)
    try {
      for (const one of (await projects.getProjectsState()).projects) {
        const path = one.path
        if (path !== undefined && path !== '' && existsSync(join(path, '.git'))) roots.add(path)
      }
    }
    catch { /* 项目区读不出来:只护工作台自己的仓库 */ }
    /*
     * ★ 2026-09-28(卡 BS2,设计第五节第 1 道门):**凡 git 仓库一律只读**。
     * 往上找 `.git`(worktree 里它是一个文件,不是目录,所以只看在不在)。
     * 缓存活在这一轮的 context 里 —— 30 秒后连缓存一起丢,新建的仓库下一拍就认得。
     */
    const repoCache = new Map<string, string | null>()
    const repoRootOf = (path: string): string | undefined => {
      const seen: string[] = []
      let at = path
      for (let step = 0; step < 64; step += 1) {
        const hit = repoCache.get(at)
        if (hit !== undefined) {
          for (const one of seen) repoCache.set(one, hit)
          return hit ?? undefined
        }
        let found = false
        try { found = existsSync(join(at, '.git')) }
        catch { found = false }
        if (found) {
          for (const one of [...seen, at]) repoCache.set(one, at)
          return at
        }
        seen.push(at)
        const up = dirname(at)
        if (up === at || up === '' || up === '.') break
        at = up
      }
      for (const one of seen) repoCache.set(one, null)
      return undefined
    }
    const context: GuardContext = {
      protectedRoots: [...roots],
      ...(butlerCwdNow === undefined || butlerCwdNow === '' ? {} : { ownRoots: [butlerCwdNow] }),
      repoRootOf,
      home,
    }
    guardCache = { at: Date.now(), context }
    return context
  })

  /**
   * 进度靠证据(2026-09-25,卡 N;`server/progress.ts`)。仓库、派出去的活、各家会话 → 每张卡「现在到哪 · 依据 · 什么时候看的」。
   * - 会话正文要授权表 `read_session_content`:「可以」才读;「要问」时在外层问他一次(卡 M 的提问,`progress:access`,
   *   不走审批 —— 审批的键是「允许这一次」,这一问答了是以后都算),答了写进授权表;
   * - 模型同一套(modelService.endpoint()),花费上限与卡 O「每件事上限」同一份设置(`~/.dsh/workbench/budget.json` 的 cny,缺省 0.5 元);
   * - 「要你说一句」走卡 M 的外层提问:卡 M 合进来之后把它的 `questions` 经纪人传给这里的 `questions`(一行)。
   */
  const sessionAccessOf = async (): Promise<SessionAccess> => {
    if (authorization === undefined) return 'ask'
    const status = (await authorization.get()).read_session_content.status
    return status === '可以' ? 'allowed' : status === '不可以' ? 'denied' : 'ask'
  }
  progress = createProgressService({
    file: defaultProgressFile(home),
    now: () => new Date(),
    tasks,
    projects: async () => (await loadProjectsFile(projectsFile)).projects
      .map(one => ({ id: one.id, name: one.name, ...(one.repoPath === undefined ? {} : { path: one.repoPath }) })),
    sources: await defaultSourceDeps(),
    codexHome: process.env.CODEX_HOME ?? join(home, '.codex'),
    claudeHome: join(home, '.claude'),
    sessionAccess: sessionAccessOf,
    ...(authorization === undefined ? {} : {
      setSessionAccess: async (allowed: boolean) => {
        await authorization.set('read_session_content', allowed ? '可以' : '不可以', localDateStr(Date.now()))
      },
    }),
    // own 档他自己填的模型名照用(2026-10-23,卡「事务官换Key」);relay 档 endpoint 里没有这一格,回 PROGRESS_MODEL。
    model: { endpoint: () => modelService.endpoint(), model: async () => (await modelService.endpoint()).model },
    budgetCny: () => readBudgetCny(defaultBudgetFile(home)),
    // 外层提问(合并卡 W 接上卡 M 的那一根):「要你说一句」「看各家的对话」都摆到球下 / 手机「等你确认」里问,
    // 不只写在卡上(卡 N 交接第八节第 1 条)。
    questions,
    onChanged: () => pushSnapshot(),
  })
  await progress.load()
  /**
   * 重启前挂着的那几问**原样挂回**外层(2026-09-26,卡 U8)。0.4.1 → 0.4.2 热更新重启之后
   * 球下的「等你」从 6 变 4,少的正是两条「进度要你说一句」——提问经纪人只在内存里,
   * 而这几问原来要等下一轮进度核对(早报前 / 他手动点)才会重新挂上。这一趟不问模型、不采证据。
   * **不 await**:起服务不该等它;真挂不上,最坏也只是等下一轮核对时再挂。
   */
  void progress.resume().catch(() => { /* 挂不回来不拦起服务 */ })
  /**
   * DSH 会话里那一问跨不过重启:**让事务官重新问一遍**(2026-09-26,卡 SM 第四件)。
   *
   * 与上面那一行的区别正是卡 U8 查清的那件事:进度那几问的账在我们手上,原样挂回来就有人等;
   * `ask_user_question` 那一路等的是**那一轮 agent 的 Promise**,重启后原样挂回是更糟的谎
   * (他答了没人收)。所以这一趟不挂任何一问,只跟那条会话说一句,让她自己再问一次。
   * 判据与去重都在会话日志里(不新增文件),见 `server/dshAskResume.ts` 文件头。
   * **不 await**:同上,而且它还要等会话通道接上。
   */
  void createDshAskResume({
    sessionsDir: `${process.env.DSH_HOME ?? `${home}/.dsh`}/sessions`,
    io: {
      readdir: async (dir) => { try { return await readdir(dir) } catch { return [] } },
      readLog: async (file, compressed) => {
        try {
          const raw = await readFile(file)
          return (compressed ? decompressZstdFrames(raw) : raw).toString('utf8')
        }
        catch { return undefined }
      },
    },
    tasks: async () => (await tasks.list()).tasks,
    pending: () => questions.list(),
    say: async (sessionId, text) => (butlerSession?.say === undefined ? false : await butlerSession.say(sessionId, text)),
    ...(butlerSession?.available === undefined ? {} : { ready: () => butlerSession.available?.() === true }),
  }).resume().catch(() => { /* 催不成不拦起服务 */ })
  /**
   * 老机器上我们写的那段中转配置补齐(2026-09-24):补上 V4 Pro、给能看图的模型写 input。
   * 只动我们自己写的那段;两代运行时都是热加载,不重启。
   *
   * **写到哪儿由 `dshSettingsStore` 判**(2026-09-26,卡 U1b):0.1.7 把 `settings.yaml` 收进了
   * profile 的补丁层,这一处要是继续写死那个文件,升级之后每次开机都读不到、白跑一趟。
   * 读写不了就算了 —— 下次在设置里切一下模型服务也会补上。
   */
  void (async () => {
    try {
      const out = await createDshSettingsStore({
        dshHome: process.env.DSH_HOME ?? `${home}/.dsh`,
        log: line => console.log(`[模型] ${line}`),
      }).upgradeManagedRelay()
      if (!out.ok) console.log(`[模型] 事务官那一侧的模型服务没补上:${out.error}`)
    }
    catch { /* 还没装好(没有 profile、没有设置)就不补 */ }
  })()

  /**
   * 派活的眼睛(2026-09-25,卡 O)。**全是本机能力,路径与执行器都在这里注入**(2026-09-04 事故纪律:
   * 服务层一个字都不认 process.env.HOME)。
   *
   * - 能力体检:问 Claude / Codex 命令行登没登(只取一个布尔,输出不记不打印);看窗口只用 `focus_input`(不送字、不抢焦点);
   * - 「登录 X」:在「终端」里跑那家自己的登录命令(账号密码工作台不经手);
   * - 每件事的上限:`~/.dsh/workbench/budget.json`(卡 N 的进度评估也读这一份)。
   */
  const cliBinOf = (family: 'claude' | 'codex' | 'kimi'): string | undefined => {
    const cli = resolveAgentCli(family, {
      pathEnv: process.env.PATH,
      home,
      exists: existsSync,
      listDir: (dir) => { try { return readdirSync(dir) } catch { return [] } },
    })
    return cli.found ? cli.bin : undefined
  }
  const appInstalled = appInstalledWith(home, existsSync)
  /**
   * 起别家命令行时给它的环境(卡 O 兜底):DSH 环境里的 `ANTHROPIC_BASE_URL` 指着本机一个没人在听的端口
   * (以前 headroom 代理留下的,~/.dsh/bin/dsh-start 那一行,卡 R 删源头)就不传,别的原样。体检、登录探查、派活共用。
   */
  const cliEnv = createCliEnv({
    env: () => process.env,
    // 那个地址是不是系统登录时设进去的(卡 R 查到维护者那台是 headroom 留下的 LaunchAgent,每次登录都设一遍)。只读。
    launchdGetenv: async (key) => {
      const got = await runCommand(['launchctl', 'getenv', key]).catch(() => undefined)
      const out = got?.ok === true ? String(got.stdout ?? '').trim() : ''
      return out === '' ? undefined : out
    },
  })
  /** 登记表此刻的样子(还没起来 / 读不出来就 undefined)。 */
  const registryNow = (): ReturnType<NonNullable<typeof agentDiscovery>['view']> | undefined => {
    try { return agentDiscovery?.view() }
    catch { return undefined }
  }
  const agentCaps = createAgentCaps({
    /**
     * 体检哪几家(2026-09-25,卡 Z):**Agent 登记表里接上了、而且有本机窗口的那几家**
     * (原来是写死的 `CLIENT_DISPATCH_FAMILIES`)。发现引擎还没起来 / 没接上时退回
     * 「写过专门接法、装在这台电脑上的那几家」,行为与 09-25 之前一字不变。
     *
     * ★ 2026-10-02(卡「引擎接线与删复制品」):**候选再补上引擎登记处那一份**。
     * 候选名单只许有一份出处(`registry.targets()`)—— 派活候选、@ 候选、认家名那三处
     * 已经走它(`dispatchTargetsNow` 的 `engineTargets`),而这一处还只问发现引擎:
     * 于是一家装着、从没启动过的(登记表里一条都没有)在能力体检里整家缺席。
     */
    families: () => capTargetsFor({
      ...(registryNow() === undefined ? {} : { registry: registryNow() }),
      installed: family => appInstalled(family),
      engineTargets: engineRegistry.targetsNow().map(one => ({
        family: one.family,
        name: one.name,
        ...(one.bundle_id === undefined ? {} : { bundle_id: one.bundle_id }),
        can: one.can,
        ...(one.write === undefined ? {} : { write: one.write }),
        here: one.here,
      })),
    }),
    /**
     * 装没装。**登记表里有这一条就是装着的**(它是从正在跑的 App 里发现的)—— 运行时认出来的那一家
     * 只有包标识、没有 App 名,按 `/Applications/<名>.app` 去 stat 一定说「没装」,那就会在体检表上
     * 写成「这台电脑上没装 Foo AI」,而他分明正开着它。
     */
    installed: (family) => {
      if (registryNow()?.entries.some(one => one.id === family) === true) return true
      return appInstalled(family)
    },
    helper: () => {
      const view = helper.view()
      return {
        connected: view.connected,
        authorized: view.authorized,
        newConversation: helper.supports?.('new_conversation') ?? false,
        readReply: helper.supports?.('read_reply') ?? false,
      }
    },
    cliFound: family => cliBinOf(family) !== undefined,
    cliLogin: createCliLoginProbe({
      binOf: cliBinOf,
      exec: async (bin, args) => {
        // 同派活那一份环境:本机那个没人在听的中转地址不带(server/cliEnv.ts)。
        const env = (await cliEnv.envFor()).env
        return await new Promise((resolve) => {
        // stdin 关着(codex 在 stdin 是开着的管道时会一直等);15 秒还没回就当这次问不出来。输出只交给 cliLoginOf 取一个布尔。
        const child = execFile(bin, [...args], { timeout: 15_000, cwd: home === '' ? undefined : home, env }, (error, stdout, stderr) => {
          const code = error === null ? 0 : typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : null
          resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
        })
        child.stdin?.end()
        })
      },
    }),
    // Claude 命令行会继承的那个中转地址探得通不通(体检「能改本机文件」那一格据此说人话)。
    cliProxy: async (family) => {
      if (family !== 'claude') return undefined
      const fact = await cliEnv.check()
      return fact === undefined ? undefined : { host: fact.host, port: fact.port, local: fact.local, reachable: fact.reachable, ...(fact.source === undefined ? {} : { source: fact.source }) }
    },
    probeWindow: createWindowProbe({ request: (req, timeoutMs) => helper.request(req, timeoutMs), now: () => new Date() }),
    now: () => new Date(),
    onChanged: () => pushSnapshot(),
  })
  /*
   * 窗口那条通道从这一刻起问得到体检表上它那几格(见上面 `capCells` 那一段)。
   * **只给 `cellsOf`**:给整张表就是把「能力现查」接回「有哪几家」,那正是 0.4.87 爆栈的那条边。
   */
  capCellsOf = family => agentCaps.cellsOf(family)
  /**
   * Claude 额度「一键接上」那三只手(2026-10-03,卡「不让用户知道什么叫 setup-token」)。
   *
   * 维护者原话:「你得考虑产品化啊,你不说我咋知道要咋弄啊。」—— 她按设置里那颗「接上」,
   * 工作台自己起 `claude setup-token`、把它打印的授权链接用**默认浏览器**打开(她在那边用
   * 自己的 Claude 账号授权,账号密码工作台一个字都不经手),拿到的长期密钥直接进 0600 的凭据文件。
   * 判断、抹密钥、超时、杀进程全在 `quota/claudeSetupToken.ts`;这里只接线。
   */
  const claudeConnect = {
    // Homebrew 那两个位置也探(DSH 继承来的 PATH 里常常没有 /opt/homebrew/bin)。
    findCli: () => {
      // 顺手让那个中转地址的结论新鲜起来(异步,下面这一次用的是上一次的结论 —— 见 spawn 那段注释)。
      void cliEnv.check()
      return resolveClaudeCli({
        pathEnv: process.env.PATH,
        home,
        exists: existsSync,
        listDir: (dir) => { try { return readdirSync(dir) } catch { return [] } },
      })
    },
    /**
     * stdin 关着(它不该等我们打字 —— 授权在浏览器里完成);stdout / stderr 都读:
     * 有的版本把授权链接印在 stderr 上,而失败原因几乎总在那里。
     *
     * 环境同派活那一份(`server/cliEnv.ts`):DSH 环境里那个指向本机、没人在听的
     * `ANTHROPIC_BASE_URL` 不传,否则这条命令会连不上 Anthropic。**用的是上一次探的结论**
     * (这只手是同步的);还没探过就原样传,行为与这张卡之前一字不差。
     */
    spawn: (command: string, args: readonly string[]) => spawn(command, [...args], {
      stdio: ['ignore', 'pipe', 'pipe'] as const,
      cwd: home === '' ? undefined : home,
      env: cliEnvWith(process.env, cliEnv.fact()).env,
    }),
    /**
     * 默认浏览器开那一条链接(不带 `-a`:她平时用哪个浏览器就用哪个,登录态也在那里)。
     * 链接是**白名单过的**(只认 Claude 自家那几个域名,见 `claudeSetupToken.ts`),而且不经 shell。
     * 开不起来就抛 —— 让那一格如实说「没成」,而不是挂在「等你授权」上等五分钟。
     */
    openUrl: async (url: string) => {
      if (!(await runCommand(['open', url])).ok) throw new Error('浏览器没能打开那一页')
    },
  }
  const loginLauncher = createLoginLauncher({
    dir: `${home}/.dsh/workbench/login`,
    binOf: cliBinOf,
    writeScript: async (file, text) => {
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, text, { encoding: 'utf8', mode: 0o700 })
      await chmod(file, 0o700)
    },
    openTerminal: async file => (await runCommand(['open', '-a', 'Terminal', file])).ok,
  })
  const budgetStore = createBudgetStore(defaultBudgetFile(home))
  await budgetStore.load()

  /**
   * Agent 自动发现与统一接入(2026-09-25,卡 Q;设计 docs/设计-Agent自动发现与统一接入-2026-09-25.md)。
   *
   * 登记表落在 `~/.dsh/workbench/agents.json`;壳推来的 App 事件(起来 / 切到前台 / 退出)、壳一连上扫的那一遍、
   * 平时 10 分钟一次的巡检,都喂给它。判「回话的是 AI 还是人」走工作台的模型服务(同 askModel 那一家,
   * 计入每日额度;中转那边剩得少了就不判)。通话中整个停(工人报的 `inCall`,同通话护栏)。
   */
  const callState = createCallState()
  const judgeAgent = async (prompt: string, maxTokens: number): Promise<string> => {
    const endpoint = await modelService.endpoint()
    if (!endpoint.ready) throw new Error('模型服务还没接上')
    const response = await fetch(`${endpoint.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(endpoint.key === undefined ? {} : { authorization: `Bearer ${endpoint.key}` }),
      },
      // 判类别要稳:温度 0;不用想(2026-09-28 卡 BS,同 askModel 那一段的理由)。
      // own 档他自己填的模型名压过 DIRECT_MODEL(2026-10-23,卡「事务官换Key」)。
      body: JSON.stringify({ model: endpoint.model ?? DIRECT_MODEL, messages: [{ role: 'user', content: prompt }], max_tokens: maxTokens, temperature: 0, thinking: { type: 'disabled' } }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) throw new Error(`模型服务回了 ${response.status}`)
    const json = await response.json() as { choices?: { message?: { content?: unknown } }[] }
    const content = json.choices?.[0]?.message?.content
    if (typeof content !== 'string') throw new Error('模型没回内容')
    return content
  }
  /**
   * 后台任务挂在主会话上(2026-09-25,卡 Q;维护者:「一张卡片里有后台任务的说明,就是多一层的意思」):
   * Claude 子代理从会话记录旁边的目录读、事务官派出去的活从看板读,十五秒一遍;/state.sessions 与登记表都挂上 children。
   */
  sessionChildren = createSessionChildren({
    sessions: () => service.getState().sessions,
    fileOf: (agent, sessionId) => sessionDigest.fileOf?.(agent, sessionId),
    tasks: async () => (await tasks.list()).tasks,
    // DSH 自己的子代理(卡 U3):feed 从 `session/created` 的会话头上记下了 origin+parentSession。
    // feed 在服务起来之后才接线(见下面 wireDshSessions),走可变引用的闭包,同 itemBudget.usage。
    dshParentOf: sessionId => dshSessionFeed?.parentOf(sessionId),
    onChanged: () => pushSnapshot(),
  })
  const children = sessionChildren
  agentDiscovery = createAgentDiscovery({
    store: createFileRegistryStore(defaultAgentRegistryFile(home)),
    helper,
    judge: judgeAgent,
    remainingCny: async () => (await modelService.status()).usage?.remaining_cny,
    inCall: () => callState.inCall(),
    sessions: () => children.attach(service.getState().sessions),
    // 拿不准的那一家「XX 像是个 Agent,要接上吗?」挂进卡 M 的提问经纪人:进「等你」那一堆,电脑球下、手机「等你确认」都能答。
    asker: createBrokerAsker(questions),
    /**
     * 读窗口那条会话有没有一问在等他(2026-09-26,卡 WS):与文件型会话**同一份判断**(卡 T 的 rules/model、
     * 同一个花费上限)。按 09-26 的口径**只挂 `ask`、不改运行状态** —— 那一问进 `src/waiting.ts` 的
     * `waitingOnHim`(事务官琥珀气泡、球下「等你 n」、手机「等你确认」),不占坞上那一格的运行状态档。
     */
    askOf: (id, sessionId) => waiting?.askOf(id, sessionId),
    // 有本机对话库的那几家(千问办公):在跑 / 做完 / 标题 / 最新一句以它的库为准,读窗口退成兜底(2026-10-08)。
    records: recordReaders,
    onChanged: () => pushSnapshot(),
    log: line => console.log(line),
  })
  const discovery = agentDiscovery
  /**
   * 额度要覆盖派活名单里的每一家(卡 O):Manus、Muse 的额度只在它们自己的窗口上,壳 `read_texts` 只回命中的那一小段。
   * 读是后台的、按 10 分钟节流(挂在 /state 上泵;派活确认前按 1 分钟),设置里「重新查一遍」时现读一次。
   *
   * ★ **2026-09-26(卡 QO):开集那条路也在这里。** 登记表里新接上、还没有专门读法的那几家
   * (今天 Grok Bot、Antigravity),命中的那几小段交给模型判 —— 判模型走的是**同一支手**
   * (`judgeAgent`,工作台的模型服务),记账记在**同一份**每日上限上(登记表的 `judgeBudget`)。
   * 所以它必须建在 `agentDiscovery` 之后:那一份账本在登记表里。
   */
  const windowQuota = createWindowQuotaReader({
    request: (req, timeoutMs) => helper.request(req, timeoutMs),
    helper: () => {
      const view = helper.view()
      // `quotaPage`(2026-10-03,卡 QP):这份壳会不会那条**不抢焦点**的翻页 op。
      // 老壳没有这一格 —— 自动那一轮照旧一颗键都不按(见 agentQuota 的 `reachPage`)。
      //
      // ★ 卡「豆包闪一下 / Grok 读键字」(2026-10-03)多两格,名字就是壳 caps 里那一格:
      // `readTitles` = `read_texts` 收得了 `include_titles`(按家声明地也读键身上的字,Grok Bot);
      // `quotaFront` = `quota_page` 收得了 `front`(叫到台前闪一下、按完立刻还原,豆包)。
      // 老壳两格都没有 → 插件压根不发那两格,那两家的格子停在今天那句话上(不假装读到了)。
      //
      // ★ 卡「豆包台前点一下」(2026-10-04)再多一格:
      // `quotaClick` = `quota_page` 收得了 `click`(台前那一支第一颗键用合成点击按,豆包)。
      // 老壳没有这一格 → 声明了 `front_click` 的豆包**一下都不闪**(闪过去也只是白按一颗)。
      return { connected: view.connected, authorized: view.authorized,
               readTexts: helper.supports?.('read_texts') ?? false,
               quotaPage: helper.supports?.('quota_page') ?? false,
               readTitles: helper.supports?.('read_titles') ?? false,
               quotaFront: helper.supports?.('quota_front') ?? false,
               quotaClick: helper.supports?.('quota_click') ?? false }
    },
    judgeQuota: judgeAgent,
    judgeBudget: discovery.judgeBudget,
    // 她从窗口槽清单里删掉的那几家,额度这一路也不碰(2026-10-12):现读 apps.json,她刚删完下一轮就生效。
    disabled: async () => new Set((await loadAppsFile(defaultAppsFile(home))).disabled),
    /**
     * ★ **2026-09-27(卡 AN):Antigravity 的额度直接问它本机的语言服务。**
     * 维护者 11:15 拍板(原话「可以的」)。
     *
     * Antigravity 自己拉起的那个语言服务(127.0.0.1 上两个**随机**端口)就是它设置页
     * 「Models & Usage」那一页的来源。**它的令牌是它自己放在命令行与日志里的,我们现取现用、用完就丢**
     * —— 不进 `credentials.json`、不进日志、不进 note、不进用例夹具(纪律全文见 `quota/antigravityNative.ts` 文件头)。
     * 不出本机、不碰 Google 账号、不多花一分额度。
     *
     * 读成了就整趟不碰壳(不要辅助功能、不用把他藏起来的窗放出来、不叫模型);
     * 这条路哑掉(他把 Antigravity 关了、它换了令牌、接口改了)就**抛错退回窗口读法**那条兜底,
     * 「说明」里各自写着自己是哪一条路。别家一概回 `undefined`(照旧只走窗口读法)。
     */
    readNative: async (family, at) => {
      if (family.bundleId !== ANTIGRAVITY_BUNDLE_ID) return undefined
      const groups = await readAntigravityNative(antigravityNativeDeps())
      return antigravityNativeView({ id: family.id, title: family.title, at, groups })
    },
    now: () => new Date(),
    onChanged: () => pushSnapshot(),
    store: windowQuotaFileStore(`${home}/.dsh/workbench/window-quota.json`),
    /*
     * ★ **两条路分开**(2026-09-27,卡 BB)。读额度要翻他每一扇窗、还要把藏着的家 unhide 再藏回去
     * (卡 MQ3 / AG),窗口上的字那一下会整页换。登记表那一路靠两次读数的差判「它回了一句」,
     * 所以读额度之前与之后都跟它说一声:这几家下一拍**只重新起算** —— 读额度永远不许冒出一个气泡。
     */
    onWindowTouched: bundleIds => discovery.windowTouched(bundleIds),
    /*
     * ★ **2026-10-03(卡 QZ):额度自己读到 —— 没在跑的那一家后台起它。**
     * 维护者 10-03:「不用写原因,我要的是解决」。读数器只用这个执行器跑
     * `open -g -b <包>`(后台起它,不抢焦点)与 `open -g <深链>`;**传的是记「开App」那一行的那个** ——
     * 读额度拉起过谁、几点拉的、开没开成,`web.stdout.log` 里一行不少(2026-10-02「诊断包加两样」第一样)。
     *
     * ★ **2026-10-19:两样都只在她亲手点「读一下」时跑。** 10 分钟那一轮对没在跑的家一律不起
     * (维护者关掉的千问办公 / Muse / Grok Bot / Manus 当天被这一路一轮轮开回来);
     * 日志里再出现 `[开App] … ← open -g -b` 就只能是她点过那一格。
     */
    runCommand,
    // 起不来 / 到不了那一页 / 她正用着那家:这几句**只进日志,不进格子**(维护者 10-03 第 4 条)。
    // `console` 那一层已经替每行盖了时间(`logStamp.ts`)。
    log: line => { console.log(line) },
  })
  /**
   * ★ **2026-09-27(卡 AG 追加):额度重读改成事件触发为主、定时为辅。**
   * 维护者 10:45:「10 分钟一轮这个解法会不会太不优雅了,我听着延迟大,用户还是可感知的」。
   *
   * 额度只在他**用**那家的时候变,所以挂在同一份 App 事件上:
   * - 另一家被激活 = 上一家**失活**(他刚用完)→ 立刻重读上一家(防抖 1.2 秒,只按方子算,不叫模型);
   * - **工作台自己**被激活(他切回来看板)→ 把放了 90 秒以上的那几家补读一遍。
   * 10 分钟那一轮(`pump` / `pumpOpen`)留着兜底。
   */
  let quotaLastActive: string | undefined
  helper.onEvent((event) => {
    if (event.kind !== 'app') return
    discovery.handleAppEvent({
      event: event.event,
      bundle_id: event.bundle_id,
      ...(event.name === undefined ? {} : { name: event.name }),
      ...(event.pid === undefined ? {} : { pid: event.pid }),
    })
    if (event.event !== 'activated' || event.bundle_id === '') return
    const previous = quotaLastActive
    quotaLastActive = event.bundle_id
    if (previous !== undefined && previous !== event.bundle_id) windowQuota.nudge([previous])
    if (event.bundle_id === OWN_BUNDLE_ID) windowQuota.catchUp()
  })
  // 壳(重新)连上那一下扫一遍正在跑的 App;壳每次被激活都会再报一遍授权,那不算重新连上。
  let shellWasConnected = false
  helper.onChange(() => {
    const connected = helper.connected()
    if (connected && !shellWasConnected) discovery.helperChanged()
    shellWasConnected = connected
  })

  /**
   * 剩余额度告警(2026-10-23,卡 t-8e617888;设计 `docs/设计-剩余额度告警-2026-10-23.md`):
   * 消费 `agent_quota` 同一份统一视图,低额/耗尽各提醒一次,走收件箱 `quota` 那一档
   * (只是工作台消息,不触发手机推送/电话)。去重账落在 `~/.dsh/workbench/quota-alerts.json`,
   * 只记「哪家哪扇窗提醒到哪一级」,不记额度数值 —— 不是第二套额度账。
   */
  const quotaAlerts = createQuotaAlerts({ file: defaultQuotaAlertsFile(home) })
  await quotaAlerts.load()

  /**
   * 额度活用建议(2026-10-28,卡 t-f68365f6;任务书 `docs/交接-1028-机制退修任务书-接续对题与改派语义.md`
   * 第 10 条「额度按到期先花」):与告警同一份统一视图 + 看板 —— 重置前 6 小时某扇窗还剩一半以上,
   * 把板上「待排」的研发活列成建议走收件箱 `spend` 那一档(只提议不自动派)。去重账落在
   * `~/.dsh/workbench/quota-spend-tips.json`,只记「哪一周期递过 + 说过的话」,不是第二套额度账。
   */
  const quotaSpendTips = createQuotaSpendTips({ file: defaultQuotaSpendTipsFile(home) })
  await quotaSpendTips.load()

  const dispatchRules = await hostDispatchRules({
    env: process.env, tasks, rules,
    projects: async () => (await projects.getProjectsState()).projects,
  })

  running = await startFromEnv(service, process.env, {
    ...(dispatchRules === undefined ? {} : { dispatchRules }),
    composer,
    approvals,
    // 偏好:办完提醒的范围 + 桌面活直派(2026-10-23,卡「分层第二刀一」;设置里「派活与办完提醒」那一节)。
    dispatchPrefs,
    agentCaps,
    loginLauncher,
    // 额度里 Claude 那格那颗「接上」键(2026-10-03)。不接这三只手就没有那条路由、不画那颗键。
    claudeConnect,
    windowQuota,
    quotaAlerts,
    quotaSpendTips,
    appInstalled,
    itemBudget: {
      store: budgetStore,
      // DSH 会话 feed 在服务起来之后才接线(见下面 wireDshSessions),走可变引用的闭包。
      usage: sessionId => dshSessionFeed?.usage(sessionId),
      // 到上限先停下来问他(卡 O):走卡 M 的外层提问(电脑球下 + 手机「等你确认」,也进「等你」那一个数)。
      asker: questions,
    },
    approvalGrants,
    questions,
    // 一件事一份、进度靠证据(2026-09-25,卡 N):卡上挂「现在到哪」「现在该谁动」,负责人驱动按档位问 / 派。
    items: { progress, driveFile: defaultDriveFile(home) },
    /**
     * **一问一答当场答**(2026-10-02,卡「语音交代慢与老问上限」;判据 `server/turnIntent.ts`)。
     *
     * 走 `askModel`(工作台模型服务那一家、`deepseek-v4-flash`、**关思考**、**不带工具**),
     * 与资讯 / 小红书建议 / 会议纪要同一条通道。400 token:一两句人话够了,长了也只是念给她听着累。
     * 模型服务没接上就抛 —— 那一道岔口接住异常,照旧建卡 + 开会话(不编答案)。
     */
    quickAnswer: async prompt => await askModel(prompt, 400),
    agents: agentDiscovery,
    callState,
    sessionChildren,
    // 「等你确认」只认她本人、发版要她点头(卡 BS)。
    actorTokens,
    // 派活从头到尾由工作台自己跑(2026-09-24,卡 F):命令行那只手要的几样本机能力。
    dispatchRun: { ...createDispatchRunIo(home), envForCli: async () => await cliEnv.envFor() },
    clientScan,
    // 卡 HC:界面上有哪几家 AI,只看它(2026-09-27)。
    installedAgents,
    modelMode,
    // 中转配了哪家才出现哪家(2026-09-26,卡 GH)。
    relayProviders,
    pairing,
    // 这台 Mac 的机器 id(2026-10-21,局域网主路):`/pair/claim` 回包带上它,手机记下「我配的是哪一台」。
    machineId: machineIdOnce,
    model: modelService,
    modelAutoSetup,
    // 重启之后把引导会话先热起来(2026-09-24,维护者真机:重启完说一句,「在想…」停很久)。
    onboardingWarm: createOnboardingWarm({ file: defaultOnboardingWarmFile(home) }),
    account,
    // 首次流程那面旗子(first_run_done_at)落在同一份 app.json 上,**同一个实例**。
    appConfig,
    lan: {
      config: appConfig,
      mdns: createMdnsAdvertiser(),
      name: `工作台 · ${hostname().replace(/\.local$/, '')}`,
      version: PLUGIN_VERSION,
    },
    /**
     * 目录配置(2026-09-17 卡 C):GET/PUT /config/paths 与 GET /config/hooks。
     * onChanged 是"改完立刻生效"的全部机关——扫描缓存作废(下一次扫描用新根)、
     * 收件箱按新目录重挂监视、事务官会话的 cwd 换成新值。引导/授权/例程三块换不了,
     * 那三块在启动时就接好线了,接口会如实回 restart_required(见 http.ts 那条路由)。
     */
    paths: {
      config: appConfig,
      home,
      ...(envButlerCwd === undefined ? {} : { envButlerCwd }),
      /**
       * 钩子由工作台代写(2026-09-17 Ben 拍板)。两家配置文件的路径**从 setupPaths 里取**,
       * 跟探测(clientScan)、体检页问的是同一张路径表 —— 「判它没接上」与「替他接上」
       * 指的必须是同一个文件,否则会出现"写了但界面还说没接上"这种查不清的夹缝。
       *
       * 只有生产这一处接线。测试要验写入就自己给一份临时 HOME 下的路径(见
       * tests/server-hooks-apply.test.ts:一个字节都不碰真实家目录)。
       */
      applyHooks: {
        files: {
          claude: hookFilePaths.claudeSettings,
          codex: hookFilePaths.codexHooks,
        },
      },
      // 卡 R:与起服务那次同步、「接上没有」的判定是同一份钩子脚本(固定位置)。
      hookScripts,
      onChanged: async (next) => {
        projects.invalidateScanCache()
        butlerCwdNow = envButlerCwd !== undefined && envButlerCwd !== '' ? envButlerCwd : next.butler_cwd
        // 换了工作目录:技能也装进新的那个(事务官会话下一次就开在那里)。
        syncButlerSkillsInto(butlerCwdNow)
        pushSnapshot()
      },
    },
    // Ben 在工作台填完 Key → 立刻重采一轮 → 服务把整份快照推给展示台。
    // 不这样的话他得等最多五分钟才看得到数字变化，那体验上等于没反应。
    //
    // **清空那一下要先作废、再重采**(2026-09-18):重采要打好几家的接口,那几秒里界面上
    // 还挂着用刚删掉的 Key 取来的余额。先 forgetCredential 把那一格当场清成「还没接」。
    onCredentialsChanged: async ({ provider, cleared }) => {
      if (cleared) collector.forgetCredential(provider)
      await collector.collectOnce()
    },
    // 合并说明:main 侧新增 claudePushedAt(展示台判"多久没推"),v5 侧新增
    // 项目区/机器/角标/日历四个采样口——职责不同,并集保留。
    onQuotaPushed: (agent, entry) => {
      if (agent === 'claude') claudePushedAt = Date.now()
      void saveLastQuota(lastQuotaFile, { [agent]: entry })
    },
    projects,
    /**
     * 读一个项目的说明和最近记录(2026-09-24,已有项目拉齐):引导 ②′ 里她拿到「读目录」的点头之后自己读、
     * 两句话复述请他纠正。门(read_scan_roots、新点子那一支不读)与路径白名单在 http.ts / projectBrief.ts。
     */
    projectBrief: { io: nodeBriefIo(), home },
    machine,
    badges,
    // Codex 会话对账(2026-08-26):feed 在服务起来之后才创建,这里必须走可变引用的
    // 闭包(同 pushSnapshot 的"先占位后接线"手法),不能直接取值。
    codexReconcile: () => { codexSessionFeed?.reconcile() },
    claudeRecover: () => { claudeRecover.recover() },
    // 「在等你」(卡 T):同款请求驱动 + 限频;答了往哪送、「去回答」。
    waitingPump: () => { waiting?.pump() },
    sessionAnswer,
    calendar,
    runCommand,
    /**
     * 带 cwd 与退出码的执行器(2026-09-23,断点 B 与 C)。
     * `/feature/result`(收派活结果)、`/feature/branch`(派活前开分支)与
     * `/feature/ship`(那条闭环的前七步)靠它。
     */
    runInCwd,
    /**
     * 「改工作台自己」那条闭环上**真的会动外面的东西**的那两样(2026-09-23 接上)。
     *
     * 上一版这里是空的,`/feature/ship` 于是在真机上一律 404。拦住它的是一个取舍:
     * `/update/apply` 会把**这个进程**换掉并重启,而当时的第 ⑦ 步「等版本号变」
     * 正跑在这个进程里。统筹 09-23 拍的是:**把记录挪到更新之前,更新按下就回、不等**,
     * 由重启之后那一段收尾去对版本号(见下面的 `shipFollowUp` 与 `selfShip.ts` 文件头)。
     * 取舍定了,这里就没有再空着的理由。
     */
    selfUpdate: {
      /**
       * 发版脚本。**真的会往公网 rsync 产物的那一下**,整条链上唯一一处。
       *
       * 走 `runInCwd` 而不是另造一个执行器:退出码与合起来的 stdout+stderr 正是
       * 停下来时要原样带给她的两样,而那两样只有它给得出。
       *
       * `--skip-local-check`:发版脚本从 2026-10-03 起会在 rsync 之前把新插件装到本机并重启 ——
       * 这一下跑在工作台自己的进程里,那一重启会把它杀在第 ⑦ 步记录之前(理由全文见
       * `SELF_SHIP_SKIP_LOCAL_CHECK`)。这条路的第 ⑧ 步自己会装本机,只是装在推完之后。
       */
      publish: async input => await runInCwd({
        cmd: 'bash',
        args: [
          joinRel(input.cwd, PUBLISH_SCRIPT_REL), '--with', input.withArg, '--notes', input.notes,
          '--skip-local-check', SELF_SHIP_SKIP_LOCAL_CHECK,
        ],
        cwd: input.cwd,
      }),
      /**
       * 按一下「立即更新」。**先查一次清单再按** —— `update.apply()` 拿的是上一次检查
       * 缓存下来的那份清单,没查过它会如实回一句「还没查过有没有新版」。
       * 而这条路上刚刚才发出去一版,后台那轮自查多半还没轮到。
       *
       * `running` 是上面那个可变引用(服务是这一行之后才造出来的,同 `diagReport` 的手法)。
       * 回的只是"这条更新作业起来了没有" —— 它跑起来之后会把这个进程换掉,
       * 所以**没有任何办法在这里等到结果**(`selfShip.ts` 文件头写了为什么)。
       */
      applyUpdate: async () => {
        const update = running?.update
        if (update === undefined) return { ok: false, note: '这台机器上没启用热更新(没配 HOME?),更新按不了' }
        try { await update.check() }
        catch (error) { return { ok: false, note: `查不到有没有新版:${(error as Error).message}` } }
        const started = update.apply()
        if ('error' in started) return { ok: false, note: started.error }
        return { ok: true, note: `更新作业 ${started.id} 起来了` }
      },
      home,
    },
    /**
     * 重启之后那一句**收尾**(2026-09-23)。上面那条闭环的最后一步按下更新就回了,
     * 这一格就是它的下文:进化日志里最近那一条若标着「待重启确认」,
     * 就拿**装到盘上那一份** package.json 的版本号对一次 ——
     * 对上了改成「已生效」,对不上在收件箱里如实说一句没生效。
     *
     * **是个取值函数**:那一段要等服务起来之后才跑得了(见 `shipFollowUpNow`)。
     */
    shipFollowUp: () => shipFollowUp,
    helper,
    orchestrator,
    scenes,
    template,
    modules,
    userLayer,
    /**
     * 自定义模块的**单开来源**(2026-09-22,C7「自定义模块真边界」)。
     *
     * 只绑回环,默认 8794(工作台服务 8791,展示台 3080)。端口被占就整块缺席:
     * 窗位叠里一格自定义模块都不挂,**不会退回同源那条老路** —— 那条路就是这张卡关掉的门。
     * `WORKBENCH_MODULE_PORT` 只是为了同机跑两份(灰度实例)时不打架。
     */
    moduleOrigin: { port: moduleOriginPort(process.env) },
    devTool: { store: devToolStore, modulesDir: userLayer.webWidgetsDir },
    // 进化循环（2026-09-22，卡 ⑥）。
    evolve,
    // 他的规矩(2026-09-24 晚,卡 K)。
    rules,
    // 集中改提示词那一页(2026-10-01)。
    prompts,
    layoutAsk: layoutAskStore,
    xhs,
    collectors,
    collect,
    registry,
    dock,
    brief,
    feed,
    feedDig,
    aidj,
    daily,
    layoutSnapshot,
    usage,
    tasks,
    // 事务官会话通道(2026-09-10 事项收件箱)。接不上就是接不上——建事项照常,如实标「会话未开」。
    // 展开式写法:exactOptionalPropertyTypes 下 `undefined` 不能直接赋给可选属性。
    ...(butlerSession === undefined ? {} : { butlerSession }),
    // DSH 会话的回合(2026-09-15,GET /butler/item/:id/turns)。feed 在服务起来之后才接线(见下面
    // wireDshSessions),同 codexReconcile 走可变引用的闭包;接不上时 feed 是 undefined → 路由回 404。
    sessionTurns: (sessionId, limit) => dshSessionFeed?.turns(sessionId, limit),
    // 点开一条「某家在跑的会话」看什么(2026-09-25,卡 P)。
    sessionDigest,
    // 手机读对话(2026-10-01):各家最近的对话从记录文件读,不只这次开机以来的会话表。
    sessionLibrary: {
      history: query => sessionHistory.page(query),
      transcript: query => sessionTranscript.read(query),
      attachment: query => sessionAttachments.read(query),
      attachmentFile: query => sessionAttachments.file(query),
    },
    onAgentHook: (event) => { if (event.agent === 'claude') claudeHooked.add(event.session_id) },
    // 引导与授权表(2026-09-15):WORKBENCH_BUTLER_CWD 没配就都不接(见上面那段注释)。
    ...(onboarding === undefined ? {} : { onboarding }),
    ...(materialize === undefined ? {} : { materialize }),
    ...(authorization === undefined ? {} : { authorization }),
    appearance,
    onboardingTurns,
    routines,
    notes,
    highlight,
    peakSchedule,
    sentinel,
    callOut,
    relayWatch,
    // 动作闸与任务日志(2026-10-02,卡 AG):与捎话巡检用的是同一份。
    actionGate,
    jobLog,
    personalTokens,
    githubDevice,
    mcpSecrets,
    // 协作区跨机(2026-10-21):连法在 http.ts 里按 model.json + 账号现取;这里只开两条长轮询(加入了工作室才真拉)。
    collabRelay: { loop: true },
    /*
     * ★ **一条引擎**(2026-10-02,卡「引擎接线与删复制品」):派活送话、派活盯窗、
     * 「只盯不发」核那一眼,全走它 —— 与替她答 / 捎话用的是**同一个实例**(全进程一条引擎、一处闸、一本账)。
     */
    engine,
    engineRegistry,
    familyLanes,
    reopenApp: openAgentApp,
    /**
     * ★ **「这一刻电脑锁着屏没有」那一拍**(2026-10-03,卡「锁屏时窗口型的家送不进」):
     * 挂上 http 那根既有的 1 秒节拍(内部 3 秒限频),解锁了就把排着的那几件按原顺序重送;
     * 那一格也进 `/state.helper.screen_locked`。
     */
    ...(screenLockWatch === undefined ? {} : { screenLock: screenLockWatch }),
    /**
     * ★ **「哪条睡着的会话醒过来了」那一拍**(2026-10-23,卡「捎话留言等它醒」):
     * 挂同一根 1 秒节拍(内部 5 秒限频),那条会话的 socket 一在就把排着的留言重送。
     */
    ...(sessionAwakeWatch === undefined ? {} : { sessionAwake: sessionAwakeWatch }),
    behaviorLog,
    firstUse,
    // 手机交代只执行一次(2026-10-12):请求号台账落盘,电脑重启后手机补发也认得。
    clientKeys: createClientKeyLedger({ file: defaultClientKeysFile() }),
    habits: habitService,
    /**
     * ★ **「出门时电脑不睡」那一拍**(2026-10-03,卡「出门时电脑不睡」;缺省关):
     * 挂上同一根 1 秒节拍(内部 5 秒限频),算一次「开关开着 + 有已配对手机经中转连着」,
     * 变了就下发给壳(`away_awake`);`GET/POST /shell/away-keep-awake` 也读它。
     */
    ...(awayAwakeWatch === undefined ? {} : { awayAwake: awayAwakeWatch }),
    graphify,
    archify,
    reveal,
    onAppsChanged: sendObserveTargets,
    butler,
    connector,
    meeting,
    callRecords,
    rtcCall,
    channel,
    channelWorker,
    localRoom,
    deviceDirectory,
    processHealth,
  })

  // 这一句把上面那个闭包接通:从这一刻起,工人崩了会真的报出去(见 channelWorker 那段注释)。
  diagReport = running.diag?.report

  /**
   * 重启前「到上限了,先停下来了」那几问**原样挂回**外层(2026-09-26;跟上面 `progress.resume()` 同一个形状)。
   * 账已经在卡上(`budget.state === 'paused'` + `note` + `paused_at`),不另落文件;只读看板一眼、只挂问,
   * 不停会话、不写卡。**不 await**:起服务不该等它;挂不上也不拦起服务(卡上那三颗键还在)。
   */
  void running.itemBudget?.resume().catch(() => { /* 挂不回来不拦起服务 */ })

  /**
   * 上一次「改自己」的**收尾**(2026-09-23)。跑一次,就在这里。
   *
   * 那条闭环的最后一步(`POST /update/apply`)会把上一个进程换掉并重启 ——
   * **这个进程就是重启之后的那一个**,所以"上一版到底生没生效"只有在这里问得出来。
   *
   * 绝大多数次它什么都不做(进化日志里最近那一条不是「待重启确认」)。
   * `void` 不 await:读盘 + 读一份 package.json 而已,但没有任何理由让它拖住启动;
   * 出错一律吞掉 —— 一次收尾没做成不该让工作台起不来(下一次启动再对一次就是了)。
   */
  void (async () => {
    const projectPath = (await pathsNow()).butler_cwd
    // 没配工作仓库就没有进化日志可看。不猜一个路径(同 wbPathsDefaults 里「不猜」那条)。
    if (projectPath === undefined || projectPath === '') return
    shipFollowUp = await runSelfShipFollowUp({
      projectPath,
      readText: async one => await readFile(one, 'utf8').catch(() => undefined),
      writeText: async (one, text) => { await writeFile(one, text, 'utf8') },
      /**
       * ★ 读**装到盘上那一份**,不是 `PLUGIN_VERSION`(那是构建时注入进这段代码的)。
       * 这里问的是"这台机器上装着的是哪一版",不是"这段正在跑的代码是哪一版" ——
       * 热更新恰恰是在两者可能不等的那一刻发生的。见 `selfShipFollowUp.ts` 文件头。
       */
      runningVersion: async () => await installedPluginVersion(
        hookFilePaths.profilePluginPackageJson,
        async one => await readFile(one, 'utf8').catch(() => undefined),
      ),
      now: () => new Date(),
    })
    // 有下文了就立刻推一轮:她在手机上看到的那条「重启后见」该在这一刻有结果。
    // 直接用 running(不用 pushSnapshot):那个闭包是下面几行才接上的。
    if (shipFollowUp !== undefined) running?.broadcastState()
  })().catch(() => { /* 收尾做不成不拦启动(见上) */ })

  /**
   * 连接器:服务已经起来了,现在才去装(卡 OC2)。
   *
   * `ensure()` 自己就是游离的(内部 `void`),这里再写一次 `void` 只为把「不等它」写在脸上。
   * 第一次要下约 230MB,期间设置里那一行显示「正在装」;装不上只记一句人话,下次开机再试。
   * 已经装着的话这一趟很快(跳过 npm),顺手把三家的 MCP 配置与 launchd 项对齐一次 ——
   * 她换过端口、或者上次装到一半断了,都靠这一趟自愈。
   */
  connector.ensure()

  /**
   * 配置齐了就自动把工人拉起来 —— Ben 不该为了「手机能连上」去点一个按钮。
   * 拉不起来(脚本还没 cp 过去)也只记一行,**不拦工作台启动**。
   */
  /*
   * ★ **每 30 秒对一遍路线**(2026-09-30 Air 真机:开机时凭证还没从服务器取回来,判「没配」就再也没人拉工人;
   * 2026-10-22 卡 M6 起配好之后也一直对):本机房间(M1 装上之后)与云房间(登录之后)都可能晚来,
   * 也可能走(删了钥匙、退出登录)。该有的起、没了的停、房间换了的那条重起;崩了重起仍归那条自己的看护。
   * 一条都没有时只打一行「先不拉起」,不刷屏。没登录时「还没登录」那个答案记 5 分钟,不每拍敲中转。
   */
  let loggedNoRoute = false
  const watchWorkers = async (): Promise<void> => {
    const routes = await channelWorker?.reconcile().catch(() => undefined)
    const any = routes !== undefined && CHANNEL_ROUTES.some(route => routes[route].want === true)
    if (!any && !loggedNoRoute) {
      loggedNoRoute = true
      console.log('[channel] 还没有能进的房间(本机没有房间钥匙,云房间也还没好 —— 没登录或还没从服务器取回来),工人先不拉起;每 30 秒再看一次')
    }
    else if (any && loggedNoRoute) {
      loggedNoRoute = false
      console.log('[channel] 有房间了,工人拉起来了')
    }
  }
  workerWatchStarted = true
  void watchWorkers()
  const workerWatch = setInterval(() => { void watchWorkers() }, 30_000)
  workerWatch.unref?.()
  stopWorkerWatch = () => clearInterval(workerWatch)

  pushSnapshot = () => running?.broadcastState()
  // 登记表开始走节拍(壳连上就先扫一遍正在跑的 App)。起不来不拦工作台启动。
  void agentDiscovery?.start().catch(() => {})
  sessionChildren?.start()

  // 额度采集：在此之前没有任何人调 collectQuota，所以 /state 里四家恒为 unknown、
  // 展示台余额栏一直是"未接入"。先立刻采一轮（别让看板空等一个间隔），再转周期。
  void collector.collectOnce()

  // Codex 的额度是它自己实时写进会话文件的，五分钟一轮太慢——
  // Ben 实报「客户端 90%、展示台还挂着 91%」。盯着那个目录，他一动 Codex 就重采。
  // 这是文件事件订阅（FSEvents），不是轮询：空闲零开销。
  stopCodexWatch = watchCodexSessions(
    process.env.CODEX_HOME ?? `${process.env.HOME ?? ''}/.codex`,
    () => { void collector.collectOnce() },
  )

  // 会话区的 Codex 那一栏同理：没有 hook 能给,只能靠这份文件写入事件自己判断
  // "在跑"/"跑完了"(hooks.ts 头部注释:Codex 没有 Notification,SessionStart 之外
  // 拿不到"新开了一个会话"这种信号)。进程内直接调 service.applyEvent,不经 HTTP。
  const codexHomeForFeed = process.env.CODEX_HOME ?? `${home}/.codex`
  codexSessionFeed = startCodexSessionFeed(defaultCodexSessionFeedDeps(codexHomeForFeed), {
    codexHome: codexHomeForFeed,
    resolveProject: cwd => resolveCodexProject(cwd, { gitCommonRoot, projectNameForRoot }),
    onFile: (sessionId, file, name) => sessionDigest.note('codex', sessionId, file, 'codex-rollout', name),
    applyEvent: (event) => {
      service.applyEvent(event)
      // 跟 hook 入口（http.ts 的 /hook/:agent）同一条纪律：写了状态就要推给展示台，
      // 不然得等下一次 GET /state 轮询才看得到,那就退化成"看起来还是没接上"。
      pushSnapshot()
    },
  })

  // Kimi 会话接入(2026-09-02 规范修订,Ben 拍板:全仓库唯一获准的 60 秒轮询,
  // 理由与成本纪律见 kimiSessionFeed.ts 顶部注释)。
  // 源是 **Kimi 桌面版** 的 kimi-agent 状态目录——同日真机纠错:第一版盯的是
  // `~/.kimi-code`(CLI),Ben 用的却是 Kimi.app,跑了十分钟那边一个字节都没动。
  // 标题与归属(2026-09-09 接上):只读 daimon 的 conversations.sqlite(kimiConversations.ts,
  // 请求驱动 + 30 秒限频,不另起定时器),cwd 走与 Codex/Claude/DSH 同一条归属解析。
  // 库打不开/版本不对整条路静默退回短 id + 未归类。applyEvent 走同一条"写了就推"纪律。
  const kimiConversations = createKimiConversationReader({ dbPath: defaultKimiConversationsDb(home) })
  kimiSessionFeed = startKimiSessionFeed({
    ...defaultKimiSessionFeedDeps(defaultKimiAgentDir(home)),
    readConversations: kimiConversations.lookup,
    // 最近在做什么(2026-09-25,卡 P):读那条会话的 wire.jsonl 尾巴。
    readDigest: (file, name) => readSessionDigest({ format: 'kimi-wire', file, ...(name === undefined ? {} : { name }) }),
  }, {
    applyEvent: (event) => {
      service.applyEvent(event)
      pushSnapshot()
    },
    resolveProject: cwd => resolveCodexProject(cwd, { gitCommonRoot, projectNameForRoot }),
    onFile: (sessionId, file, name) => sessionDigest.note('kimi', sessionId, file, 'kimi-wire', name),
  })

  // DSH 自家会话接入(2026-09-09):四家里唯独 DSH 自己没有白/黄/蓝点,补上。
  // 事件与投影的可读性全部实测过,见 docs/superpowers/research/2026-09-09-DSH会话投影可读性.md。
  // 事项生命周期闭环(2026-09-16):会话结束 → 「我交给事务官」的卡从 doing 挪走
  // (done → 等我确认、error → 阻塞、aborted → 待办)。摘要取 service 里那条会话此刻的 summary。
  const butlerLifecycle = createButlerLifecycle({
    tasks,
    summaryOf: sessionId => service.getState().sessions.find(s => s.agent === 'dsh' && s.session_id === sessionId)?.summary,
    onChanged: () => pushSnapshot(),
    // 自查没过、已打回给那家的活:答完了也不进「等我确认」(卡 K,合格才叫他)。
    heldBack: id => rules.heldBack(id),
    // 这一次「被停了」是工作台自己停的(卡 O:到上限先停下来问 / 他点了「停掉这一件」):照那张单子挪、写。
    expectedAbort: sessionId => running?.itemBudget?.expectedAbort(sessionId),
    /**
     * 「要一份文件」那一类:**回执没到就不算办完**(2026-10-04,卡 `claude/phone-file-send-loop`;
     * 为什么要这一问见 `server/fileDelivery.ts` 文件头 —— 10-04 早那一件被记成了「完成 · 只是问了一句」)。
     */
    pendingDelivery: taskId => running?.fileDelivery?.pending(taskId),
    /**
     * ★ **答案来找她**(2026-10-04,卡 `claude/answer-comes-to-her`;维护者:「信息直接从
     * 正在办切到办完了,我是自己追过去点开查看的」)。判出「问一句」的那一轮,答案记进回答账
     * (→ 手机球下那一行字幕、电脑事务官页同一处)并弹一条**正文就是答案本身**的通知。
     * 实现在 `server/http.ts` 的 `deliverAnswer`(那儿才有壳与账)。
     */
    deliverAnswer: input => running?.deliverAnswer?.(input),
  })
  dshSessionFeed = wireDshSessions(ctx, {
    applyEvent: (event) => {
      service.applyEvent(event)
      // 与其它 feed 同一条"写了就推"纪律。
      pushSnapshot()
    },
    onSessionEnd: (sessionId, end) => { void butlerLifecycle.handleSessionEnd(sessionId, end) },
    // 会话动了一下(一回合开始 / 调一次模型 / 结束):上限那一层马上看一眼花了多少(卡 O)。
    onActivity: (sessionId) => { running?.itemBudget?.nudge(sessionId) },
    // 数字**不推**:投影每条事件都在变(实测一次三步会话变了三十多次),
    // 每次都推一份 WS 快照就是自造风暴。界面本来就在 1 秒轮询 /state,下一拍自然带走。
    setMetrics: (sessionId, metrics) => { service.setSessionMetrics('dsh', sessionId, metrics) },
    // 最近在做什么(2026-09-25,卡 P)。同 metrics 不推快照:工具一秒能调好几次,界面一秒一拍拉 /state。
    setDetail: (sessionId, detail) => { service.setSessionDetail('dsh', sessionId, detail) },
    resolveProject: cwd => resolveCodexProject(cwd, { gitCommonRoot, projectNameForRoot }),
  })

  // Claude 那一格同理，而且这段等待是**白等的**：桌面端每 15 分钟把新样本落到磁盘上，
  // 数字早就在那儿了，只是采集循环还要再过最多五分钟才去看一眼。盯着那份文件，
  // 它一落新样本就重采——延迟就只剩桌面端自己的采样间隔（详见 claudeDesktopWatch.ts）。
  stopClaudeUsageWatch = watchClaudeDesktopUsage(
    defaultClaudeDesktopUsageFile(),
    () => { void collector.collectOnce() },
  )
}

/**
 * DSH 自家会话的接线(2026-09-09)。**这段代码的每一行都有实测依据**,见
 * docs/superpowers/research/2026-09-09-DSH会话投影可读性.md 第六节「给实现的硬要求」:
 *
 * 1. **绝不裸取 `ctx.sessionProjections`**——实测那样写会让整棵插件树启动失败
 *    (`cannot get property "sessionProjections" without inject`),连 3080 都起不来。
 * 2. **不用模块级 `export const inject`**:注册表缺席时整个插件会被挂起(PENDING),
 *    那意味着工作台的 8791 服务也不起——直接违反架构约束 C1(Agent 层挂了看板还得活着)。
 *    嵌套 `ctx.inject` 只让这一小块延后,服务照常起。
 * 3. **apply 那一刻注册表还不在**(实测 `ctx.get('sessionProjections')` 返回 undefined,
 *    十几毫秒后 inject 回调才触发),所以只能在回调里接线。
 * 4. 一切入口 try/catch:事件回调里抛出会污染 DSH 自己的派发,投影回调里抛出会
 *    **卡死该会话的推送**(dsh-context 的 logShapes.ts 顶部为此写了整段告诫)。
 *
 * 没有 ctx(老版 DSH、或本地跑测试)时整块跳过:DSH 会话那一组保持空,与从前一样。
 */
export function wireDshSessions(
  ctx: DshHostContext | undefined,
  options: Parameters<typeof createDshSessionFeed>[0],
): DshSessionFeed | undefined {
  if (ctx === undefined || typeof ctx.on !== 'function' || typeof ctx.inject !== 'function') return undefined
  const feed = createDshSessionFeed(options)
  let restoreSelection: ((session: { id?: unknown }) => void) | undefined

  try {
    // `session/created` 只送一个 Session 对象,cwd 与出身都在它的 `header` 上(上游 core/session
    // 的 `readonly header: SessionHeader`)。0.1.7 起那上面多了 `origin: 'subagent'` 与
    // `parentSession` —— 子代理就靠这两个字段认(卡 U3 接卡 Q 的 children;落盘那份
    // `session.v4.jsonl` 的首行是同一份东西,所以判据一个)。
    ctx.on('session/created', ((session: {
      id?: unknown
      header?: { cwd?: unknown, origin?: unknown, parentSession?: unknown }
    }) => {
      try {
        const id = session?.id
        if (typeof id !== 'string' && typeof id !== 'number') return
        const header = session?.header
        restoreSelection?.(session)
        feed.handleCreated(String(id), {
          ...(typeof header?.cwd === 'string' ? { cwd: header.cwd } : {}),
          ...(typeof header?.origin === 'string' ? { origin: header.origin } : {}),
          ...(typeof header?.parentSession === 'string' ? { parentSession: header.parentSession } : {}),
        })
      }
      catch { /* 一条会话读不出来不能带走整个监听器 */ }
    }) as (...args: never[]) => void)

    ctx.on('session/event', ((session: { id?: unknown }, event: DshEventLike) => {
      try {
        const id = session?.id
        if ((typeof id !== 'string' && typeof id !== 'number') || typeof event?.type !== 'string') return
        feed.handleEvent(String(id), event)
      }
      catch { /* 同上 */ }
    }) as (...args: never[]) => void)

    ctx.on('session/disposed', ((session: { id?: unknown }) => {
      try {
        const id = session?.id
        if (typeof id !== 'string' && typeof id !== 'number') return
        feed.handleDisposed(String(id))
      }
      catch { /* 同上 */ }
    }) as (...args: never[]) => void)
  }
  catch {
    // 事件名不被这一版 DSH 认识:会话那一组保持空,不影响其余功能。
  }

  try {
    ctx.inject(['sessionProjections', 'sessions'], ((injected: {
      sessions?: { list?: () => { id?: unknown }[] }
      sessionProjections?: {
        snapshot?: (session: { id?: unknown }, keys: readonly string[]) => { values?: Record<string, unknown> }
        onChanged?: (listener: (session: { id?: unknown }, key: string, value: unknown) => void) => unknown
      }
    }) => {
      try {
        const onChanged = injected?.sessionProjections?.onChanged
        if (typeof onChanged !== 'function') return
        // 恢复会话的历史 header 可能落后于 durable model/selection，直接读现有投影。
        // 旧宿主没有快照能力时保留未知选择/请求头的既有降级，不阻塞其它会话接线。
        restoreSelection = session => {
          try {
            const id = session?.id
            if (typeof id !== 'string' && typeof id !== 'number') return
            const value = injected.sessionProjections?.snapshot?.(session, ['modelSelection']).values?.modelSelection
            if (value !== undefined) feed.handleProjection(String(id), 'modelSelection', value)
          }
          catch { /* 缺席或旧形状不能伪造选择。 */ }
        }
        for (const session of injected.sessions?.list?.() ?? []) restoreSelection(session)
        onChanged.call(injected.sessionProjections, (session, key, value) => {
          const id = session?.id
          if (typeof id !== 'string' && typeof id !== 'number') return
          feed.handleProjection(String(id), key, value)
        })
      }
      catch { /* 注册表形状变了:三个数字留空,状态点照常 */ }
    }) as (ctx: never) => void)
  }
  catch {
    // 这一版 DSH 没有投影注册表:数字留空(绝不编数),白/黄/蓝点不受影响。
  }
  /**
   * ★ 2026-09-25(卡 O 灰度实测 / 卡 M 同一天各自查出来的):这一句以前**漏了** —— 函数签名写着回 `DshSessionFeed`,
   * 却从来没把 feed 交回去(落到函数末尾 = undefined,TS 在返回类型含 undefined 时不报)。
   * 后果:模块里那个 `dshSessionFeed` 永远是 undefined —— `GET /butler/item/:id/turns` 一直 404「没有这个会话」,
   * 事项里「她说了什么」读不到(卡 M),每件事的上限也读不到会话用量(卡 O)。事件与投影一直是接上的,只是外面拿不到这个对象。
   */
  return feed
}

/**
 * 事务官会话通道(2026-09-10 事项收件箱):在 DSH 里开一条会话,并把事项文本作为第一条
 * user 消息发出去。**一事项一会话**(docs/设计-事务官形态-Siri式与手机.md §六 6.1)。
 *
 * 用的是 DSH 0.1.2-rc.1 的 host 侧业务接口 `ctx.sessionController`(与浏览器客户端走同一条路,
 * 客户端那个 `sessions.create/prompt` 只是它的 Remote 代理):
 * - `create({ cwd? }) → { sessionId }`(不传 cwd 时 DSH 用自己的 defaultCwd = 它的 process.cwd());
 * - `prompt({ requestId, sessionId, mode:'queue', content:[{type:'text',text}] }, signal) → { accepted:true }`。
 *
 * 接线纪律与 wireDshSessions 逐字同源(那一段的四条实测教训见它的头注释):
 * **绝不裸取服务、不用模块级 inject、一切入口 try/catch**。这里再多一条:
 * **拿不到服务时返回 undefined 而不是抛**——建事项那条路会如实回「会话未开」,
 * 事项照样建下来(D13:降级要说出来,不假装)。
 *
 * cwd 由 `WORKBENCH_BUTLER_CWD`(其次 app.json 的 butler_cwd,2026-09-17 卡 C)指定——
 * 想让事务官默认在哪个仓库里干活就写哪个;没配就不传,交给 DSH 自己定——
 * **不猜一个路径**,猜错会让事务官在错误的仓库里动手。
 *
 * 取 cwd 走的是一个**函数**而不是一个值:Ben 在设置里改完事务官仓库之后,
 * 此后新开的会话就开在新仓库里,不用等重启(open() 的那一刻现问一遍)。
 */
/** alignModel 要的依赖(2026-10-23):此刻目标 + 这条会话的登记 + catalog 缺省。全部由调用方注入,这里不读文件。 */
export interface ButlerAlignDeps {
  target: () => Promise<ModelRetargetChange | undefined>
  selectionOf: (sessionId: string) => { provider?: string, model?: string } | undefined
  catalogDefault: () => Promise<{ provider: string, model: string } | undefined>
}

export function createButlerSessionOpener(
  ctx: DshHostContext | undefined,
  cwdNow: () => string | undefined = () => process.env.WORKBENCH_BUTLER_CWD,
  alignDeps?: ButlerAlignDeps,
): ButlerSessionOpener | undefined {
  if (ctx === undefined || typeof ctx.inject !== 'function') return undefined

  type PromptPart = { type: 'text', text: string } | { type: 'image', mediaType: string, data: string, name?: string }
  interface SessionControllerLike {
    create: (request: { cwd?: string }) => Promise<{ sessionId: string }>
    prompt: (
      request: { requestId: string, sessionId: string, mode: 'queue' | 'steer', content: PromptPart[] },
      signal: AbortSignal,
    ) => Promise<unknown>
    /**
     * 2026-09-24:这一条会话用哪个模型(DSH 同时把它记成默认)。
     * 2026-09-28(卡 BS):`reasoningEffort` 也走这一条 —— 上游 `selectModel` 收这个字段。
     */
    selectModel?: (request: { sessionId: string, provider: string, model: string, reasoningEffort?: string }) => Promise<unknown>
    /** 2026-09-24:此刻能用的模型表。 */
    modelCatalog?: () => Promise<ModelCatalogLike>
    /** 2026-09-25(卡 O):停掉这条会话正在跑的这一回合 = DSH 底层页右下那颗停止键。 */
    cancel?: (request: { sessionId: string }) => unknown
    /**
     * 2026-10-26(卡「事务官机制A」):摘掉队列里一条还没被执行的挂起句
     * (`SessionUpdateQueueRequest`,action 只有 'remove' 这一种用法)。
     */
    updateQueue?: (request: { sessionId: string, itemId: string, action: { kind: 'remove' } }) => Promise<unknown>
  }
  /** `/permission`、`/plan` 这两条命令走 DSH 的命令服务(与它网页上那颗权限按钮同一条写路径)。 */
  interface CommandsLike {
    execute: (agent: unknown, line: string, images: readonly unknown[], signal: AbortSignal) => Promise<{ result?: { kind?: string, text?: string } } | undefined>
  }
  interface AgentsLike {
    get: (id: string) => unknown
  }
  /** 一条会话此刻在不在跑(`Agent.status`:idle / running)。读不出来回 undefined。 */
  function agentRunning(sessionId: string): boolean | undefined {
    try {
      const agent = agents?.get(sessionId) as { status?: unknown } | undefined
      if (agent === undefined) return undefined
      return agent.status === 'running'
    }
    catch { return undefined }
  }
  let controller: SessionControllerLike | undefined
  let commands: CommandsLike | undefined
  let agents: AgentsLike | undefined
  /**
   * 清旧队列要用的两个服务(2026-10-26,卡「事务官机制A」):inbox 投影 + 会话表。
   * 与命令服务同一纪律:**另起一次 inject**,缺席只让 clearQueued 返回 undefined,
   * 不连累开会话 / say / cancel 其余功能(C1)。
   */
  let inboxProjections: { snapshot?: (session: unknown, keys: readonly string[]) => { values?: Record<string, unknown> } } | undefined
  let sessionList: { list?: () => { id?: unknown }[] } | undefined

  try {
    // 嵌套 inject:注册表缺席时只让这一小块延后(甚至永远不来),8791 照常起——C1。
    ctx.inject(['sessionController'], ((injected: { sessionController?: SessionControllerLike }) => {
      try {
        const candidate = injected?.sessionController
        if (typeof candidate?.create === 'function' && typeof candidate?.prompt === 'function') {
          controller = candidate
        }
      }
      catch { /* 服务形状变了:事务官会话开不出来,收件箱如实标「会话未开」 */ }
    }) as (ctx: never) => void)
  }
  catch {
    // 这一版 DSH 没有 sessionController:同上,降级不是错误。
    return undefined
  }
  try {
    ctx.inject(['sessionProjections', 'sessions'], ((injected: {
      sessionProjections?: { snapshot?: (session: unknown, keys: readonly string[]) => { values?: Record<string, unknown> } }
      sessions?: { list?: () => { id?: unknown }[] }
    }) => {
      try {
        if (typeof injected?.sessionProjections?.snapshot === 'function') inboxProjections = injected.sessionProjections
        if (typeof injected?.sessions?.list === 'function') sessionList = injected.sessions
      }
      catch { /* 形状变了:清队列不可用,改方向如实拒 stale-queue */ }
    }) as (ctx: never) => void)
  }
  catch { /* 同上 */ }
  /**
   * 模式 = 权限(2026-09-24)要的两个服务。**另起一次 inject**:它们缺席不该连累开会话本身 ——
   * 没有命令服务时会话照开,只是权限停在 DSH 的默认(= 今天的 workspace-write,即「先问我」)。
   */
  try {
    ctx.inject(['commands', 'agents'], ((injected: { commands?: CommandsLike, agents?: AgentsLike }) => {
      try {
        if (typeof injected?.commands?.execute === 'function') commands = injected.commands
        if (typeof injected?.agents?.get === 'function') agents = injected.agents
      }
      catch { /* 形状变了:模式只落在卡上与第一句里,不落到 DSH 的权限上 */ }
    }) as (ctx: never) => void)
  }
  catch { /* 同上 */ }

  async function runCommand(sessionId: string, line: string): Promise<void> {
    if (commands === undefined || agents === undefined) return
    const agent = agents.get(sessionId)
    if (agent === undefined) return
    try { await commands.execute(agent, line, [], new AbortController().signal) }
    catch { /* 切不过去就停在默认,会话照开(见 ButlerOpenExtras 的注释) */ }
  }

  async function prompt(sessionId: string, content: PromptPart[], mode: 'queue' | 'steer' = 'queue', taskId?: string): Promise<void> {
    if (controller === undefined) throw new Error('no controller')
    await controller.prompt({
      // taskId 嵌进 requestId(落盘为这条 user 消息的 source.rpcId):清队列按它精确认这条事项
      // 自己的句(验收修复:不能只认 workbench- 前缀 —— 同会话里别的事项的句子必须保留)。
      requestId: taskId === undefined || taskId === '' ? `workbench-${randomUUID()}` : `workbench-${taskId}-${randomUUID()}`,
      sessionId,
      // queue:排进这条会话的队列,等于用户自己敲了这一句。steer 是打断正在跑的轮次
      // (这句在最近的 step 进,改方向 / 加速用);会话没在跑时 steer 也能开头。
      mode,
      content,
    }, new AbortController().signal)
  }

  /** 所有既有会话补话共用：先检查应用结果与模型，再排入原会话。 */
  async function alignModel(sessionId: string): Promise<void> {
    if (alignDeps === undefined) return
    const modelFailure = (): Error => Object.assign(new Error('Model target unavailable'), { code: 'model_alignment_failed' })
    const target = await alignDeps.target().catch(() => { throw modelFailure() })
    if (target === undefined) return
    const model = target.model ?? (await alignDeps.catalogDefault().catch(() => { throw modelFailure() }))?.model
    if (model === undefined) throw modelFailure()
    const pick = { provider: target.provider, model, ...(target.prevModel === undefined ? {} : { prevModel: target.prevModel }) }
    const selection = alignDeps.selectionOf(sessionId)
    // 登记来自上次 request/header；selectModel 后到下一回合前它可能仍是旧值。
    // 同目标也确认一次，防止失败回滚或同值重试后沿用会话内的旧 selection。
    if (!needsAlign(selection, pick) && !(selection?.provider === pick.provider && selection.model === pick.model)) return
    if (controller?.selectModel === undefined) throw Object.assign(new Error('Model selection unavailable'), { code: 'gateway/internal' })
    await controller.selectModel({ sessionId, provider: pick.provider, model: pick.model })
  }

  return {
    // 例程判「DSH 在不在线」用:注册表还没把 sessionController 送来 = 整条通道没有,跳过并记 note;
    // 送来了但这次开不成 = 「会话未开」。两种降级要分开说(D13)。
    available: () => controller !== undefined,
    // 手机端引导(2026-09-16):用户那句话排进引导会话的队列,等于他在 DSH 里自己敲的。
    // 2026-10-26(卡「事务官机制A」):第四参 {mode:'steer'} 打断在跑的轮次(改方向 / 加速),
    // 缺省 queue —— 旧调用(引导 / ItemTalk / 工人 wb_hand_to_butler)逐字不变。
    async say(sessionId: string, text: string, onRejected?: (reason: 'model' | 'host') => void, opts?: { mode?: 'queue' | 'steer', taskId?: string }): Promise<boolean> {
      if (controller === undefined) { onRejected?.('host'); return false }
      try { await alignModel(sessionId) }
      catch (error) {
        const reason = butlerSayFailureOf(error)
        if (reason !== 'session') onRejected?.(reason)
        return false
      }
      try {
        await prompt(sessionId, [{ type: 'text', text }], opts?.mode ?? 'queue', opts?.taskId)
        return true
      }
      catch (error) {
        const reason = butlerSayFailureOf(error)
        if (reason !== 'session') onRejected?.(reason)
        return false
      }
    },
    /** 这条会话此刻在不在跑(2026-10-26):回执照实说「打断 / 没在跑」,读不出回 undefined。 */
    running(sessionId: string): boolean | undefined {
      return agentRunning(sessionId)
    },
    /**
     * 清掉队列里**这条事项自己**、还没被执行的旧句(2026-10-26,卡「事务官机制A」;二轮验收修复:
     * 不能只认 `workbench-` 前缀 —— 一条会话里可能挂着多件事,只摘 `workbench-<taskId>-` 的)。
     *
     * **先留证、后动手**(顺序钉死在这):整段读出归属这条事项的句(id + 原文)后,先调
     * `evidence(texts)` 把原文写牢;回调回 false / 抛错 = 证据没落盘,**一条都不摘**,
     * 以 `refused:'evidence'` 回来(remaining 保住全部原文)。这一步防的是:updateQueue
     * 已把句从队列摘掉、进程却没来得及把原文落在任何可恢复的地方 —— 没凭据不动手。
     *
     * 留证过后逐条 `sessionController.updateQueue(remove)`;摘一条抛错就把已摘/没摘的分片
     * 真结果带回去(incomplete),原文一条不丢;重试只清 remaining。
     * 投影 / 会话表 / updateQueue 整条缺席 → undefined(=读不清),调用方据此拒发 stale-queue。
     */
    async clearQueued(sessionId: string, taskId: string, evidence: (texts: readonly string[]) => Promise<boolean>): Promise<ItemQueueClearResult | undefined> {
      if (controller === undefined || typeof controller.updateQueue !== 'function') return undefined
      if (inboxProjections?.snapshot === undefined || sessionList?.list === undefined) return undefined
      try {
        const session = sessionList.list().find(one => String(one?.id) === sessionId)
        if (session === undefined) return undefined
        const inbox = inboxProjections.snapshot(session, ['inbox']).values?.inbox as
          | { 'next-turn'?: unknown[], 'next-step'?: unknown[] }
          | undefined
        if (inbox === undefined) return undefined
        // 先整段读出归属这条事项且还没被执行的句(id + 原文):证据在动手之前就握住了。
        const mine: { id: string, text: string }[] = []
        const wanted = `workbench-${taskId}-`
        for (const column of ['next-turn', 'next-step'] as const) {
          for (const message of inbox[column] ?? []) {
            const raw = message as { id?: unknown, source?: { rpcId?: unknown }, content?: unknown }
            if (typeof raw?.id !== 'string') continue
            const rpcId = raw.source?.rpcId
            if (typeof rpcId !== 'string' || !rpcId.startsWith(wanted)) continue
            const blocks = Array.isArray(raw.content) ? raw.content : []
            const text = blocks
              .map(block => (typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text' ? String((block as { text?: unknown }).text ?? '') : ''))
              .filter(one => one.trim() !== '')
              .join('\n')
            mine.push({ id: raw.id, text: text === '' ? '(一句没带字的话)' : text })
          }
        }
        if (mine.length === 0) return { removed: [], remaining: [], incomplete: false }
        // ★ 先留证、后动手:证据写不进 = 没凭据不动手,一条都不摘。
        let evidenceOk = false
        try { evidenceOk = await evidence(mine.map(one => one.text)) }
        catch { evidenceOk = false }
        if (!evidenceOk) {
          return { removed: [], remaining: mine.map(one => one.text), incomplete: false, refused: 'evidence' }
        }
        const removed: string[] = []
        const remaining: string[] = []
        let incomplete = false
        for (const one of mine) {
          try {
            await controller.updateQueue({ sessionId, itemId: one.id, action: { kind: 'remove' } })
            removed.push(one.text)
          }
          catch {
            // 摘这条没成:原文进 remaining(证据不丢),后面的也不再试(队列可能正被别的手改)。
            remaining.push(one.text)
            incomplete = true
            break
          }
        }
        return { removed, remaining, incomplete }
      }
      catch {
        return undefined
      }
    },
    async cancel(sessionId: string): Promise<{ ok: boolean, running?: boolean, why?: string }> {
      if (controller?.cancel === undefined) return { ok: false, why: '这一版 DSH 停不了会话' }
      const running = agentRunning(sessionId)
      // 明确没在跑:没有要停的(DSH 那边对空闲的会话按停止键是空操作,也不会报「被停了」)。
      if (running === false) return { ok: true, running: false }
      try {
        await controller.cancel({ sessionId })
        return { ok: true, running: true }
      }
      catch (error) {
        // 会话没挂在内存里(not attached)= 它这会儿也没在跑。
        const message = error instanceof Error ? error.message : String(error)
        if (/not found|not attached/i.test(message)) return { ok: true, running: false }
        return { ok: false, why: message }
      }
    },
    async catalog(): Promise<ModelCatalogLike | undefined> {
      if (controller?.modelCatalog === undefined) return undefined
      try { return await controller.modelCatalog() }
      catch { return undefined }
    },
    /**
     * 给一条已在跑的会话换 provider/model(2026-10-23 运行时 P1)。
     * **不递 reasoningEffort**:这一场只挪「哪一家、哪个模型」,不动它的思考档 ——
     * 档是开会话那一件的事(butlerEffort),重指不该顺手改掉。
     * 上游 selectModel 会先校验模型在不在 catalog(`requireModel`):不在就抛,这里回 false。
     */
    async retarget(sessionId, provider, model) {
      if (controller?.selectModel === undefined) return false
      try {
        await controller.selectModel({ sessionId, provider, model })
        console.log('[model] session retarget result:', { sessionId, provider, model, ok: true })
        return true
      }
      catch (error) {
        const code = (error as any)?.code ?? (error instanceof Error ? error.name : 'unknown')
        console.error('[model] session retarget error:', { sessionId, provider, model, code })
        return false
      }
    },
    alignModel,
    async open(firstMessage: string, extras?: ButlerOpenExtras): Promise<string | undefined> {
      if (controller === undefined) return undefined
      try {
        await alignDeps?.target()
        // 开会话的这一刻才问 cwd:改完事务官仓库之后新开的会话就在新仓库里(见函数头注释)。
        const cwd = cwdNow()
        const created = await controller.create({ ...(cwd === undefined || cwd === '' ? {} : { cwd }) })
        const sessionId = created?.sessionId
        if (typeof sessionId !== 'string' || sessionId === '') return undefined
        /**
         * 统一输入框(2026-09-24)的三件,都在说第一句之前落下:模型、权限、只出方案。
         * 每一件尽力而为 —— 切不过去照样开会话、照样把原话发出去。
         */
        /**
         * 模型与思考档(2026-09-28,卡 BS):**每条会话都明写档位**,一条都不靠全局默认 ——
         * `selectModel` 会顺手把这次的选择记成全局默认(上游 `saveSelection`),
         * 靠默认就等于「上一条开了 high」漏给下一条。
         *
         * 只给了档没给模型时先问一次 catalog 拿此刻的默认模型:`selectModel` 三个字段是一套,
         * 不能只递一个档。问不到就不递 —— 宁可这一条走 DSH 的默认,也不猜一个模型名
         * (猜错 = 整条会话 UNKNOWN_MODEL,她那件事就丢了)。
         */
        if (controller.selectModel !== undefined) {
          const want = extras?.effort ?? BUTLER_EFFORT_DEFAULT
          let target = extras?.model
          if (target === undefined) {
            try {
              const catalog = await controller.modelCatalog?.()
              const fallback = catalog?.default
              if (fallback !== undefined) target = { provider: fallback.provider, id: fallback.model }
            }
            catch { target = undefined }
          }
          if (target !== undefined) {
            const pick = target
            try { await controller.selectModel({ sessionId, provider: pick.provider, model: pick.id, reasoningEffort: resolveEffort(pick.id, want) }) }
            catch { /* 那个模型此刻不可用 / 这一版 DSH 不收档:用默认的办,原话照发 */ }
          }
        }
        if (extras?.mode !== undefined) {
          await runCommand(sessionId, `/permission ${MODE_PERMISSION_PRESET[extras.mode]}`)
          if (extras.mode === 'plan') await runCommand(sessionId, '/plan')
        }
        const text: PromptPart = { type: 'text', text: firstMessage }
        const images: PromptPart[] = (extras?.images ?? []).map(one => ({ type: 'image', mediaType: one.mediaType, data: one.data, ...(one.name === undefined ? {} : { name: one.name }) }))
        if (images.length > 0) {
          try { await prompt(sessionId, [text, ...images]) }
          // 模型不收图(MODEL_DOES_NOT_SUPPORT_IMAGES)或图太大:只发文字 —— 原话里本来就写着图在哪。
          catch { await prompt(sessionId, [text]) }
        }
        else {
          await prompt(sessionId, [text])
        }
        return sessionId
      }
      catch {
        // 会话建出来了但 prompt 失败(实测最常见的一种:模型路由不可用)时同样返回 undefined:
        // 一条没人说话的空会话对 Ben 没有意义,**宁可说"会话未开"也不给他一条假的在办**(D13)。
        return undefined
      }
    },
  }
}

/**
 * 「先问我」的审批接到档上与手机上(2026-09-24,统一输入框)。
 *
 * DSH 的审批是一条 waterfall(`approval/request`):答复方按顺序看,谁答了算谁的。
 * 它自己的网页是答复方之一 —— 但他平时不开那个网页,那里的弹框等于没人看。
 * 所以我们**排在最前面**(prepend),把这一条挂进经纪人,同时把请求往后传给网页:
 * - 档上 / 手机上先点了 → 用我们的;
 * - 网页那边先答了一个**真答案**(允许 / 拒绝 / 取消)→ 用它的,我们这条撤掉;
 * - 网页那边回「没人能答」(没开网页)→ 不算数,继续等档上 / 手机上。
 * 取消(这一轮被停了)照 signal 撤掉。
 */
/**
 * 「不许在他正在用的那份仓库里切分支、改文件」那道门(2026-09-25,卡 O,`server/checkoutGuard.ts`)。
 * 挂在 DSH `tools/pre-execute`(每一次工具调用执行之前)的**最前面**:撞上了回 `deny` + 一句她读得懂的话
 * (去哪开独立工作区、派给谁),没撞上交给后面的(DSH 自己的沙箱、钩子桥)照常判。
 * 门自己坏了(名单取不到、参数读不懂)一律放行 —— 第一道门仍是 DSH 的沙箱。
 */
export function wireCheckoutGuard(ctx: DshHostContext | undefined, guard: () => Promise<GuardContext | undefined>): void {
  if (ctx === undefined || typeof ctx.on !== 'function') return
  type Decision = { kind: 'allow' } | { kind: 'deny', reason: string } | { kind: 'ask', reason?: string }
  interface ExecLike { name?: unknown, arguments?: unknown, agent?: { session?: { header?: { cwd?: unknown } } } }
  const on = ctx.on as unknown as (event: string, listener: (exec: ExecLike, next: () => Promise<Decision>) => Promise<Decision>, options?: { prepend?: boolean }) => unknown
  const argsOf = (raw: unknown): Record<string, unknown> | undefined => {
    if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) return raw as Record<string, unknown>
    if (typeof raw !== 'string') return undefined
    try {
      const parsed: unknown = JSON.parse(raw)
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined
    }
    catch { return undefined }
  }
  try {
    on('tools/pre-execute', async (exec, next) => {
      try {
        const context = await guard()
        if (context !== undefined && typeof exec?.name === 'string') {
          const cwd = exec.agent?.session?.header?.cwd
          const reason = checkoutViolation(exec.name, argsOf(exec.arguments), typeof cwd === 'string' ? cwd : undefined, context)
          if (reason !== undefined) return { kind: 'deny', reason }
        }
      }
      catch { /* 门自己坏了不挡她干活 */ }
      return await next()
    }, { prepend: true })
  }
  catch { /* 这一版 DSH 没有这个事件:门不挂,沙箱照样挡 */ }
}

export function wireApprovalAnswerer(ctx: DshHostContext | undefined, broker: ApprovalBroker, wiring: AskWiring = {}): void {
  if (ctx === undefined || typeof ctx.on !== 'function') return
  type Outcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
  interface RequestLike {
    agent?: { session?: { id?: string, header?: { cwd?: unknown } } }
    toolName?: string
    callId?: string
    reason?: string
    signal?: AbortSignal
  }
  const on = ctx.on as unknown as (event: string, listener: (req: RequestLike, next: () => Promise<Outcome>) => Promise<Outcome>, options?: { prepend?: boolean }) => unknown
  try {
    on('approval/request', async (req, next) => {
      const sessionId = req.agent?.session?.id
      if (typeof sessionId !== 'string' || sessionId === '') return await next()
      const tool = typeof req.toolName === 'string' ? req.toolName : '一个操作'
      const reason = typeof req.reason === 'string' && req.reason !== '' ? req.reason : undefined
      /**
       * 人话与「同类的」(2026-09-25,卡 M):命令在会话日志里那条 tool/call 上(审批本身不带命令)。
       * 这件事里他点过「同类的都允许」、这一条又正是那一类 → 直接放行,不再挂一条问他(卡上数「已放行 n 次」)。
       */
      const args = toolCallArgsOf(req.agent?.session, req.callId)
      const kind = args === undefined || wiring.repoRootOf === undefined
        ? undefined
        : approvalKind({ tool, args, home: wiring.home ?? homedir(), tempRoots: wiring.tempRoots ?? defaultTempRoots(), repoRootOf: wiring.repoRootOf })
      /**
       * 记在哪件事上(卡 M 追加):这条会话挂在哪件事上就按那件事认(换了会话、DSH 重启过都照样认);
       * 那件事已经收了(完成 / 取消)就不认,也顺手把它上面记的作废。查不到事项时只认这条会话上记的。
       */
      let task: { id: string, status: string } | undefined
      try { task = await wiring.taskOf?.(sessionId) }
      catch { task = undefined }
      if (task !== undefined && (task.status === 'done' || task.status === 'canceled')) {
        const ended = task.id
        wiring.grants?.prune(taskId => taskId !== ended)
        task = undefined
      }
      const scope = { sessionId, ...(task === undefined ? {} : { taskId: task.id }) }
      if (kind !== undefined && wiring.grants?.granted(scope, kind.key) === true) {
        wiring.grants.noteAllowed(scope, kind.key)
        return 'allowed-once'
      }
      /**
       * 从行为账里学到「这类不问,做完告诉她」(2026-10-09,`server/habits.ts`):她在这一类上连着原样点头。
       * 沾四类的(推送、登录、花钱、改她的设置……)`noAsk` 一律回 undefined,照旧问。
       * 放行的同时替她点上这件事的「同类都允许」—— 卡上那一行写着已放行几次、一键收回,这就是「做完告诉她」;
       * 她收回 = 纠正了,习惯那边据此撤。
       */
      const subject = approvalSubject(args)
      const learned = kind === undefined || wiring.grants === undefined
        ? undefined
        : wiring.habits?.noAsk({ kind: kind.key, ...(subject === undefined ? {} : { subject }), ...(reason === undefined ? {} : { say: reason }) })
      if (kind !== undefined && learned !== undefined && wiring.grants !== undefined) {
        wiring.grants.grant(scope, kind)
        wiring.grants.noteAllowed(scope, kind.key)
        void wiring.habits?.applied(learned, task?.id ?? sessionId).catch(() => undefined)
        return 'allowed-once'
      }
      const cwd = req.agent?.session?.header?.cwd
      const detail = describeApproval({
        tool,
        ...(reason === undefined ? {} : { reason }),
        ...(args === undefined ? {} : { args }),
        ...(kind === undefined ? {} : { kind }),
        ...(typeof cwd === 'string' && cwd !== '' ? { workspaceName: basename(cwd) } : {}),
      })
      const local = new AbortController()
      const onOuterAbort = (): void => local.abort()
      req.signal?.addEventListener('abort', onOuterAbort, { once: true })
      const asked = broker.ask({
        sessionId,
        tool,
        ...(reason === undefined ? {} : { reason }),
        signal: local.signal,
        detail,
      })
      // 往后传给 DSH 自己的网页之前,把 signal 换成合成的:我们这边先答了,网页上那个面板一起收掉(见 combineRequestSignal)。
      combineRequestSignal(req, local.signal)
      const web = next().then(outcome => outcome === 'unavailable' ? new Promise<Outcome>(() => {}) : outcome, () => new Promise<Outcome>(() => {}))
      const outcome = await Promise.race([asked.answer, web])
      // 网页先答了:把我们这一条撤掉(它会以 cancelled 收场,档上那一行随之消失);我们先答了:网页那份跟着收掉。
      local.abort()
      req.signal?.removeEventListener('abort', onOuterAbort)
      return outcome
    }, { prepend: true })
  }
  catch { /* 这一版 DSH 没有审批 waterfall:档上就没有审批那一行,照旧在 DSH 网页里点 */ }
}

/** 审批与提问两个答复方共用的几样本机能力(测试注入;生产在 apply 里接)。 */
export interface AskWiring {
  /** 「这件事里同类的都允许」记在哪。不给就没有这颗键(每条都问)。 */
  grants?: ApprovalGrants
  home?: string
  /** 临时文件夹(DSH「只改工作文件夹」本来就放行的那几处)。 */
  tempRoots?: readonly string[]
  /** 一个路径在哪个 git 仓库里。不给就不认「改某个仓库」这一类。 */
  repoRootOf?: (path: string) => string | undefined
  /** 这条会话挂在哪件事上(与它此刻的状态)。不给就只按会话记「同类的都允许」(测试;没有看板的宿主)。 */
  taskOf?: (sessionId: string) => Promise<{ id: string, status: string } | undefined>
  /** 学到的「这类不问」(`server/habits.ts`)。不给就每条都问。 */
  habits?: {
    noAsk: (input: { kind?: string, subject?: string, say?: string }) => string | undefined
    applied: (id: string, where: string) => Promise<void>
  }
}

/** `/tmp` 与本机的用户临时文件夹(与上游 dsh-sandbox 的 writableRoots 同一张表)。 */
export function defaultTempRoots(): string[] {
  const roots = new Set<string>(['/tmp', '/private/tmp'])
  try { roots.add(realpathSync.native(tmpdir())) } catch { roots.add(tmpdir()) }
  return [...roots]
}

/**
 * 事务官在 DSH 会话里问他的话,接到电脑球下与手机「等你确认」(2026-09-25,卡 M;维护者点名的 bug)。
 *
 * DSH 的提问也是一条 waterfall(`user-questions/request`,`ask_user_question` 工具发起),以前只有 DSH 自己的网页答得了
 * —— 他得点进 DSH 原始界面才看得见那个「派活前对一遍」面板,只拿手机时根本答不了。现在同审批那一路:
 * - **排在最前面**(prepend),挂进提问经纪人(/state.questions),电脑与手机都能答;
 * - 照样往后传给 DSH 网页(开发者在「看原始对话」里仍能答),哪边先答算哪边;我们先答了,网页那个面板跟着收掉;
 * - 网页那边「没人能答」(没开网页 → NO_PROVIDER)或者网页掉线 → 不算数,继续等电脑 / 手机;
 * - 网页上他点了关掉(ASK_CANCELLED)→ 照上游的意思整问作废,我们这边那一张也收掉;
 * - 这一轮被停了(signal)→ 我们这边收掉,把上游的中断原样抛回去。
 */
export function wireQuestionAnswerer(ctx: DshHostContext | undefined, broker: QuestionBroker): void {
  if (ctx === undefined || typeof ctx.on !== 'function') return
  interface Answer { answers: unknown[] }
  interface RequestLike {
    agent?: { session?: { id?: string } }
    questions?: unknown
    signal?: AbortSignal
  }
  const on = ctx.on as unknown as (event: string, listener: (req: RequestLike, next: () => Promise<Answer>) => Promise<Answer>, options?: { prepend?: boolean }) => unknown
  const never = new Promise<never>(() => {})
  try {
    on('user-questions/request', async (req, next) => {
      const sessionId = req.agent?.session?.id
      const questions = Array.isArray(req.questions) ? req.questions : []
      if (typeof sessionId !== 'string' || sessionId === '' || questions.length === 0) return await next()
      const local = new AbortController()
      const onOuterAbort = (): void => local.abort()
      req.signal?.addEventListener('abort', onOuterAbort, { once: true })
      const asked = broker.ask({ sessionId, questions, signal: local.signal })
      combineRequestSignal(req, local.signal)
      const web = next().then(
        answer => ({ from: 'web' as const, answer }),
        // 只有他在 DSH 网页上亲手关掉才算数;没人能答、网页掉线、我们自己撤的那一下都不算。
        (error: unknown) => (isUserCancel(error) ? Promise.reject(error) : never),
      )
      try {
        const winner = await Promise.race([asked.answer.then(outcome => ({ from: 'mine' as const, outcome })), web])
        if (winner.from === 'web') return winner.answer
        if (winner.outcome.kind === 'cancelled') throw questionAborted()
        return { answers: winner.outcome.answers }
      }
      finally {
        local.abort()
        req.signal?.removeEventListener('abort', onOuterAbort)
      }
    }, { prepend: true })
  }
  catch { /* 这一版 DSH 没有提问 waterfall:照旧只在 DSH 网页里答 */ }
}

/** DSH 网页上他点了关掉那一问(上游 `ASK_CANCELLED`)。跨线过来是个带 code 的对象。 */
function isUserCancel(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ASK_CANCELLED'
}

/** 这一轮被停了:照上游的说法抛回去(user-questions 认得这个形状,会把它还原成 ASK_ABORTED)。 */
function questionAborted(): Error {
  const error = new Error('ask_user_question was aborted before the user answered') as Error & { code: string }
  error.name = 'UserQuestionError'
  error.code = 'ASK_ABORTED'
  return error
}

/**
 * 派活命令行那只手的本机能力(2026-09-24,卡 F,`server/dispatchRun.ts`)。
 *
 * - **`taskpolicy -c utility` 起**:派出去的活(Codex 跑测试、编译)不能把通话那一环挤掉(卡 D 那条:
 *   CPU 满时工人判断「说完没」落后 30 秒)。卡 D 实测 `nice` 在这台 Mac 上不让 CPU,
 *   `taskpolicy -c utility` 才会把它排到后面(统筹 09-24 晚的规矩)。降的是这一个子进程,不动别的。
 * - **detached + 标准输出落文件**:工作台热更新会重启这条进程,派出去的活不能跟着死;
 *   重启之后靠卡上记的 pid 与结果文件接着收(`resume` / `alive`)。
 * - 结果文件放 `~/.dsh/workbench/dispatch/`(只放派活的 `-o` 与事件流,一件一对)。
 */
function createDispatchRunIo(home: string): NonNullable<NonNullable<Parameters<typeof startFromEnv>[2]>['dispatchRun']> {
  const resultDir = `${home}/.dsh/workbench/dispatch`
  return {
    resultDir,
    readFile: async (file) => { try { return await readFile(file, 'utf8') } catch { return undefined } },
    alive: (pid) => { try { process.kill(pid, 0); return true } catch { return false } },
    runCli: (cmd) => {
      let fd: number | undefined
      try {
        // 同步建目录:这一下在派活那条路上,只建一次,几毫秒。
        mkdirSync(resultDir, { recursive: true })
        fd = openSync(cmd.logFile, 'a')
        // 与卡 D 同一个口(`server/lowPriority.ts`):macOS 上包一层 taskpolicy -c utility,就地 exec,pid 不变。
        const low = lowPriorityCommand(cmd.bin, cmd.argv)
        const child = spawn(low.file, low.args, {
          cwd: cmd.cwd,
          detached: true,
          stdio: ['ignore', fd, fd],
          // 派活那一层备好的环境(卡 O:本机那个没人在听的中转地址不带);没给就照工作台自己的。
          env: cmd.env ?? process.env,
        })
        const exited = new Promise<{ code: number | null }>((resolve) => {
          child.once('exit', code => resolve({ code }))
          child.once('error', () => resolve({ code: null }))
        })
        child.unref()
        return child.pid === undefined ? { error: '进程没起来', exited } : { pid: child.pid, exited }
      }
      catch (error) {
        return { error: error instanceof Error ? error.message : String(error), exited: Promise.resolve({ code: null }) }
      }
      finally {
        if (fd !== undefined) { try { closeSync(fd) } catch { /* 子进程手里有一份,这边关掉无妨 */ } }
      }
    },
  }
}

/** DSH 卸载插件时调用，释放端口与 WS 连接。 */
export async function dispose(): Promise<void> {
  const server = running
  running = undefined
  quota?.stop()
  quota = undefined
  stopCodexWatch?.()
  stopCodexWatch = undefined
  stopClaudeUsageWatch?.()
  stopClaudeUsageWatch = undefined
  codexSessionFeed?.stop()
  kimiSessionFeed?.stop()
  codexSessionFeed = undefined
  // DSH 的 feed 没有定时器,不用 stop;只把引用放掉,/butler/item/:id/turns 随之回 404。
  dshSessionFeed = undefined
  await agentDiscovery?.stop()
  agentDiscovery = undefined
  sessionChildren?.stop()
  sessionChildren = undefined
  // 工人是这条进程拉起来的子进程:插件走了就把它带走,免得留下一个没人管的孤儿
  // 跟下一份插件抢同一个房间身份(理由在 server/channelWorker.ts 顶部)。
  // 「还没配好,30 秒后再看一眼」那条链也要断:不断的话卸载之后它还在问上一份 channel。
  stopWorkerWatch?.()
  stopWorkerWatch = undefined
  localRoom?.stop()
  localRoom = undefined
  await channelWorker?.dispose()
  channelWorker = undefined
  await server?.close()
  processHealth?.close()
  processHealth = undefined
}

export { createWorkbenchService } from './server/service.ts'
export { startWorkbenchServer, resolveWorkbenchPort, resolveWorkbenchHost } from './server/http.ts'
export { startQuotaCollector } from './quota/collector.ts'
export type { QuotaCollector } from './quota/collector.ts'
export type { WorkbenchServer } from './server/http.ts'
