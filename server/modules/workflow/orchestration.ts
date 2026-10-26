import type { RuntimeContext, WorkflowOrchestrationExports } from "../../types/runtime-context.ts";
import type { Lang } from "../../types/lang.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFile, execFileSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import {
  CLI_OUTPUT_DEDUP_WINDOW_MS,
  readNonNegativeIntEnv,
  REVIEW_MAX_MEMO_ITEMS_PER_DEPT,
  REVIEW_MAX_MEMO_ITEMS_PER_ROUND,
  REVIEW_MAX_REMEDIATION_REQUESTS,
  REVIEW_MAX_REVISION_SIGNALS_PER_DEPT_PER_ROUND,
  REVIEW_MAX_REVISION_SIGNALS_PER_ROUND,
  REVIEW_MAX_ROUNDS,
} from "../../db/runtime.ts";
import {
  BUILTIN_GOOGLE_CLIENT_ID,
  BUILTIN_GOOGLE_CLIENT_SECRET,
  decryptSecret,
  encryptSecret,
} from "../../oauth/helpers.ts";
import { notifyTaskStatus } from "../../gateway/client.ts";
import { createWsHub } from "../../ws/hub.ts";

import { initializeWorkflowMeetingTools } from "./orchestration/meetings.ts";
import { createExecutionStartTaskTools } from "./orchestration/execution-start-task.ts";
import { createPlannedApprovalTools } from "./orchestration/planned-approval.ts";
import { createPlanningArchiveTools } from "./orchestration/planning-archive-tools.ts";
import { createProgressNotifyTools } from "./orchestration/progress-notify-tools.ts";
import { createReviewFinalizeTools } from "./orchestration/review-finalize-tools.ts";
import { createRunCompleteHandler } from "./orchestration/run-complete-handler.ts";
import { createReportWorkflowTools } from "./orchestration/report-workflow-tools.ts";
import { createSessionReviewTools } from "./orchestration/session-review-tools.ts";
import {
  extractReportDesignParentTaskId,
  extractReportPathByLabel,
  isPresentationReportTask,
  isReportDesignCheckpointTask,
  isReportRequestTask,
  REPORT_DESIGN_TASK_PREFIX,
  REPORT_FLOW_PREFIX,
  readReportFlowValue,
  upsertReportFlowValue,
} from "./orchestration/report-flow-helpers.ts";

interface AgentRow {
  id: string;
  name: string;
  name_ko: string;
  role: string;
  personality: string | null;
  status: string;
  department_id: string | null;
  current_task_id: string | null;
  avatar_emoji: string;
  cli_provider: string | null;
  oauth_account_id: string | null;
  api_provider_id: string | null;
  api_model: string | null;
  cli_model: string | null;
  cli_reasoning_level: string | null;
}

type MeetingTranscriptEntry = {
  speaker_agent_id: string;
  speaker: string;
  department: string;
  role: string;
  content: string;
};

export function initializeWorkflowPartC(ctx: RuntimeContext): WorkflowOrchestrationExports {
  const __ctx: RuntimeContext = ctx;
  const db = __ctx.db;
  const ensureOAuthActiveAccount = __ctx.ensureOAuthActiveAccount;
  const getActiveOAuthAccountIds = __ctx.getActiveOAuthAccountIds;
  const logsDir = __ctx.logsDir;
  const nowMs = __ctx.nowMs;
  const CLI_STATUS_TTL = __ctx.CLI_STATUS_TTL;
  const CLI_TOOLS = __ctx.CLI_TOOLS;
  const MODELS_CACHE_TTL = __ctx.MODELS_CACHE_TTL;
  const activeProcesses = __ctx.activeProcesses;
  const analyzeSubtaskDepartment = __ctx.analyzeSubtaskDepartment;
  const appendTaskLog = __ctx.appendTaskLog;
  const broadcast = __ctx.broadcast;
  const buildCliFailureMessage = __ctx.buildCliFailureMessage;
  const buildDirectReplyPrompt = __ctx.buildDirectReplyPrompt;
  const buildTaskExecutionPrompt = __ctx.buildTaskExecutionPrompt;
  const buildAvailableSkillsPromptBlock =
    __ctx.buildAvailableSkillsPromptBlock ||
    ((provider: string) => `[Available Skills][provider=${provider || "unknown"}][unavailable]`);
  const cachedCliStatus = __ctx.cachedCliStatus;
  const cachedModels = __ctx.cachedModels;
  const chooseSafeReply = __ctx.chooseSafeReply;
  const cleanupWorktree = __ctx.cleanupWorktree;
  const createWorktree = __ctx.createWorktree;
  const detectAllCli = __ctx.detectAllCli;
  const ensureClaudeMd = __ctx.ensureClaudeMd;
  const execWithTimeout = __ctx.execWithTimeout;
  const fetchClaudeUsage = __ctx.fetchClaudeUsage;
  const fetchCodexUsage = __ctx.fetchCodexUsage;
  const fetchGeminiUsage = __ctx.fetchGeminiUsage;
  const generateProjectContext = __ctx.generateProjectContext;
  const getAgentDisplayName = __ctx.getAgentDisplayName;
  const getDecryptedOAuthToken = __ctx.getDecryptedOAuthToken;
  const getNextOAuthLabel = __ctx.getNextOAuthLabel;
  const getOAuthAccounts = __ctx.getOAuthAccounts;
  const getPreferredOAuthAccounts = __ctx.getPreferredOAuthAccounts;
  const getProviderModelConfig = __ctx.getProviderModelConfig;
  const getRecentChanges = __ctx.getRecentChanges;
  const getRecentConversationContext = __ctx.getRecentConversationContext;
  const getTaskContinuationContext = __ctx.getTaskContinuationContext;
  const hasExplicitWarningFixRequest = __ctx.hasExplicitWarningFixRequest;
  const hasStructuredJsonLines = __ctx.hasStructuredJsonLines;
  const getNextHttpAgentPid = __ctx.getNextHttpAgentPid;
  const interruptPidTree = __ctx.interruptPidTree;
  const isPidAlive = __ctx.isPidAlive;
  const killPidTree = __ctx.killPidTree;
  const launchHttpAgent = __ctx.launchHttpAgent;
  const launchApiProviderAgent = __ctx.launchApiProviderAgent;
  const mergeWorktree = __ctx.mergeWorktree;
  const mergeToDevAndCreatePR = __ctx.mergeToDevAndCreatePR;
  const recoverTaskWorktree = __ctx.recoverTaskWorktree;
  const keepBranchForManualReview = __ctx.keepBranchForManualReview;
  const normalizeOAuthProvider = __ctx.normalizeOAuthProvider;
  const randomDelay = __ctx.randomDelay;
  const recordTaskCreationAudit = __ctx.recordTaskCreationAudit;
  const setTaskCreationAuditCompletion = __ctx.setTaskCreationAuditCompletion;
  const refreshGoogleToken = __ctx.refreshGoogleToken;
  const rollbackTaskWorktree = __ctx.rollbackTaskWorktree;
  const runAgentOneShot = __ctx.runAgentOneShot;
  const seedApprovedPlanSubtasks = __ctx.seedApprovedPlanSubtasks;
  const spawnCliAgent = __ctx.spawnCliAgent;
  const stopRequestModeByTask = __ctx.stopRequestModeByTask;
  const stopRequestedTasks = __ctx.stopRequestedTasks;
  const taskWorktrees = __ctx.taskWorktrees;
  const wsClients = __ctx.wsClients;
  const readTimeoutMsEnv = __ctx.readTimeoutMsEnv;
  const TASK_RUN_IDLE_TIMEOUT_MS = __ctx.TASK_RUN_IDLE_TIMEOUT_MS;
  const TASK_RUN_HARD_TIMEOUT_MS = __ctx.TASK_RUN_HARD_TIMEOUT_MS;
  const isGitRepo = __ctx.isGitRepo;
  const getWorktreeDiffSummary = __ctx.getWorktreeDiffSummary;
  const hasVisibleDiffSummary = __ctx.hasVisibleDiffSummary;
  const MVP_CODE_REVIEW_POLICY_BASE_LINES = __ctx.MVP_CODE_REVIEW_POLICY_BASE_LINES;
  const EXECUTION_CONTINUITY_POLICY_LINES = __ctx.EXECUTION_CONTINUITY_POLICY_LINES;
  const WARNING_FIX_OVERRIDE_LINE = __ctx.WARNING_FIX_OVERRIDE_LINE;
  const buildMvpCodeReviewPolicyBlock = __ctx.buildMvpCodeReviewPolicyBlock;
  const CONTEXT_IGNORE_DIRS = __ctx.CONTEXT_IGNORE_DIRS;
  const CONTEXT_IGNORE_FILES = __ctx.CONTEXT_IGNORE_FILES;
  const buildFileTree = __ctx.buildFileTree;
  const detectTechStack = __ctx.detectTechStack;
  const getKeyFiles = __ctx.getKeyFiles;
  const buildProjectContextContent = __ctx.buildProjectContextContent;
  const buildAgentArgs = __ctx.buildAgentArgs;
  const ANSI_ESCAPE_REGEX = __ctx.ANSI_ESCAPE_REGEX;
  const CLI_SPINNER_LINE_REGEX = __ctx.CLI_SPINNER_LINE_REGEX;
  const cliOutputDedupCache = __ctx.cliOutputDedupCache;
  const shouldSkipDuplicateCliOutput = __ctx.shouldSkipDuplicateCliOutput;
  const clearCliOutputDedup = __ctx.clearCliOutputDedup;
  const normalizeStreamChunk = __ctx.normalizeStreamChunk;
  const extractLatestProjectMemoBlock = __ctx.extractLatestProjectMemoBlock;
  const sleepMs = __ctx.sleepMs;
  const localeInstruction = __ctx.localeInstruction;
  const normalizeConversationReply = __ctx.normalizeConversationReply;
  const isInternalWorkNarration = __ctx.isInternalWorkNarration;
  const fallbackTurnReply = __ctx.fallbackTurnReply;
  const summarizeForMeetingBubble = __ctx.summarizeForMeetingBubble;
  const isMvpDeferralSignal = __ctx.isMvpDeferralSignal;
  const isHardBlockSignal = __ctx.isHardBlockSignal;
  const hasApprovalAgreementSignal = __ctx.hasApprovalAgreementSignal;
  const isDeferrableReviewHold = __ctx.isDeferrableReviewHold;
  const classifyMeetingReviewDecision = __ctx.classifyMeetingReviewDecision;
  const wantsReviewRevision = __ctx.wantsReviewRevision;
  const findLatestTranscriptContentByAgent = __ctx.findLatestTranscriptContentByAgent;
  const formatMeetingTranscript = __ctx.formatMeetingTranscript;
  const buildMeetingPrompt = __ctx.buildMeetingPrompt;
  const findExplicitDepartmentByMention = __ctx.findExplicitDepartmentByMention;
  const plannerSubtaskRoutingInFlight = __ctx.plannerSubtaskRoutingInFlight;
  const normalizeDeptAliasToken = __ctx.normalizeDeptAliasToken;
  const normalizePlannerTargetDeptId = __ctx.normalizePlannerTargetDeptId;
  const parsePlannerSubtaskAssignments = __ctx.parsePlannerSubtaskAssignments;
  const rerouteSubtasksByPlanningLeader = __ctx.rerouteSubtasksByPlanningLeader;
  const createSubtaskFromCli = __ctx.createSubtaskFromCli;
  const completeSubtaskFromCli = __ctx.completeSubtaskFromCli;
  const seedReviewRevisionSubtasks = __ctx.seedReviewRevisionSubtasks;
  const codexThreadToSubtask = __ctx.codexThreadToSubtask;
  const parseAndCreateSubtasks = __ctx.parseAndCreateSubtasks;
  const ANTIGRAVITY_ENDPOINTS = __ctx.ANTIGRAVITY_ENDPOINTS;
  const ANTIGRAVITY_DEFAULT_PROJECT = __ctx.ANTIGRAVITY_DEFAULT_PROJECT;
  const copilotTokenCache = __ctx.copilotTokenCache;
  const antigravityProjectCache = __ctx.antigravityProjectCache;
  const oauthProviderPrefix = __ctx.oauthProviderPrefix;
  const getOAuthAccountDisplayName = __ctx.getOAuthAccountDisplayName;
  const getOAuthAutoSwapEnabled = __ctx.getOAuthAutoSwapEnabled;
  const oauthDispatchCursor = __ctx.oauthDispatchCursor;
  const rotateOAuthAccounts = __ctx.rotateOAuthAccounts;
  const prioritizeOAuthAccount = __ctx.prioritizeOAuthAccount;
  const markOAuthAccountFailure = __ctx.markOAuthAccountFailure;
  const markOAuthAccountSuccess = __ctx.markOAuthAccountSuccess;
  const exchangeCopilotToken = __ctx.exchangeCopilotToken;
  const loadCodeAssistProject = __ctx.loadCodeAssistProject;
  const parseHttpAgentSubtasks = __ctx.parseHttpAgentSubtasks;
  const parseSSEStream = __ctx.parseSSEStream;
  const parseGeminiSSEStream = __ctx.parseGeminiSSEStream;
  const resolveCopilotModel = __ctx.resolveCopilotModel;
  const resolveAntigravityModel = __ctx.resolveAntigravityModel;
  const executeCopilotAgent = __ctx.executeCopilotAgent;
  const executeAntigravityAgent = __ctx.executeAntigravityAgent;
  const jsonHasKey = __ctx.jsonHasKey;
  const fileExistsNonEmpty = __ctx.fileExistsNonEmpty;
  const readClaudeToken = __ctx.readClaudeToken;
  const readCodexTokens = __ctx.readCodexTokens;
  const GEMINI_OAUTH_CLIENT_ID = __ctx.GEMINI_OAUTH_CLIENT_ID;
  const GEMINI_OAUTH_CLIENT_SECRET = __ctx.GEMINI_OAUTH_CLIENT_SECRET;
  const readGeminiCredsFromKeychain = __ctx.readGeminiCredsFromKeychain;
  const readGeminiCredsFromFile = __ctx.readGeminiCredsFromFile;
  const readGeminiCreds = __ctx.readGeminiCreds;
  const freshGeminiToken = __ctx.freshGeminiToken;
  const geminiProjectCache = __ctx.geminiProjectCache;
  const GEMINI_PROJECT_TTL = __ctx.GEMINI_PROJECT_TTL;
  const getGeminiProjectId = __ctx.getGeminiProjectId;
  const detectCliTool = __ctx.detectCliTool;
  const DEPT_KEYWORDS = __ctx.DEPT_KEYWORDS;
  const detectLang = (...args: any[]) => __ctx.detectLang(...args);
  const detectTargetDepartments = (...args: any[]) => __ctx.detectTargetDepartments(...args);
  const findTeamLeader = (...args: any[]) => __ctx.findTeamLeader(...args);
  const formatTaskSubtaskProgressSummary = (...args: any[]) => __ctx.formatTaskSubtaskProgressSummary(...args);
  const getDeptName = (...args: any[]) => __ctx.getDeptName(...args);
  const getDeptRoleConstraint = (...args: any[]) => __ctx.getDeptRoleConstraint(...args);
  const getPreferredLanguage = (...args: any[]) => __ctx.getPreferredLanguage(...args);
  const getRoleLabel = (...args: any[]) => __ctx.getRoleLabel(...args);
  const l = (...args: any[]) => __ctx.l(...args);
  const pickL = (...args: any[]) => __ctx.pickL(...args);
  const prettyStreamJson = (...args: any[]) => __ctx.prettyStreamJson(...args);
  const processSubtaskDelegations = (...args: any[]) => __ctx.processSubtaskDelegations(...args);
  const recoverCrossDeptQueueAfterMissingCallback = (...args: any[]) =>
    __ctx.recoverCrossDeptQueueAfterMissingCallback(...args);
  const refreshCliUsageData = (...args: any[]) => __ctx.refreshCliUsageData(...args);
  const resolveLang = (...args: any[]) => __ctx.resolveLang(...args);
  const resolveProjectPath = (...args: any[]) => __ctx.resolveProjectPath(...args);
  const sendAgentMessage = (...args: any[]) => __ctx.sendAgentMessage(...args);

  // ---------------------------------------------------------------------------
  // Helpers: progress timers, CEO notifications
  // ---------------------------------------------------------------------------

  // Track progress report timers so we can cancel them when tasks finish
  const progressTimers = new Map<string, ReturnType<typeof setInterval>>();

  // Cross-department sequential queue: when a cross-dept task finishes,
  // trigger the next department in line (instead of spawning all simultaneously).
  // Key: cross-dept task ID → callback to start next department
  const crossDeptNextCallbacks = new Map<string, () => void>();

  // Subtask delegation sequential queue: delegated task ID → callback to start next delegation
  const subtaskDelegationCallbacks = new Map<string, () => void>();
  const subtaskDelegationDispatchInFlight = new Set<string>();

  // Map delegated task ID → original subtask ID for completion tracking
  const delegatedTaskToSubtask = new Map<string, string>();
  const subtaskDelegationCompletionNoticeSent = new Set<string>();

  // Review consensus workflow state: task_id → current review round
  const reviewRoundState = new Map<string, number>();
  const reviewInFlight = new Set<string>();
  const meetingPresenceUntil = new Map<string, number>();
  const meetingSeatIndexByAgent = new Map<string, number>();
  const meetingPhaseByAgent = new Map<string, "kickoff" | "review">();
  const meetingTaskIdByAgent = new Map<string, string>();
  type MeetingReviewDecision = "reviewing" | "approved" | "hold";
  const meetingReviewDecisionByAgent = new Map<string, MeetingReviewDecision>();
  const projectReviewGateNotifiedAt = new Map<string, number>();
  const REVIEW_MEETING_ONESHOT_TIMEOUT_MS = (() => {
    const raw = process.env.REVIEW_MEETING_ONESHOT_TIMEOUT_MS?.trim();
    if (!raw) return 65_000;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) return 65_000;
    // Primary unit is milliseconds.
    // Backward compatibility:
    // - 65 -> 65 seconds
    // - 65000 -> 65000 ms
    const interpreted = parsed <= 600 ? parsed * 1000 : parsed;
    return Math.max(5_000, Math.round(interpreted));
  })();

  interface TaskExecutionSessionState {
    sessionId: string;
    taskId: string;
    agentId: string;
    provider: string;
    openedAt: number;
    lastTouchedAt: number;
  }

  const taskExecutionSessions = new Map<string, TaskExecutionSessionState>();

  type ReviewRoundMode = "parallel_remediation" | "merge_synthesis" | "final_decision";

  function ensureTaskExecutionSession(taskId: string, agentId: string, provider: string): TaskExecutionSessionState {
    return sessionReviewTools.ensureTaskExecutionSession(taskId, agentId, provider);
  }

  function endTaskExecutionSession(taskId: string, reason: string): void {
    sessionReviewTools.endTaskExecutionSession(taskId, reason);
  }

  function getTaskStatusById(taskId: string): string | null {
    return sessionReviewTools.getTaskStatusById(taskId);
  }

  function isTaskWorkflowInterrupted(taskId: string): boolean {
    return sessionReviewTools.isTaskWorkflowInterrupted(taskId);
  }

  function clearTaskWorkflowState(taskId: string): void {
    sessionReviewTools.clearTaskWorkflowState(taskId);
  }

  function getReviewRoundMode(round: number): ReviewRoundMode {
    return sessionReviewTools.getReviewRoundMode(round);
  }

  function scheduleNextReviewRound(taskId: string, taskTitle: string, currentRound: number, lang: Lang): void {
    sessionReviewTools.scheduleNextReviewRound(taskId, taskTitle, currentRound, lang);
  }

  function getProjectReviewGateSnapshot(projectId: string): {
    activeTotal: number;
    activeReview: number;
    rootReviewTotal: number;
    ready: boolean;
  } {
    return sessionReviewTools.getProjectReviewGateSnapshot(projectId);
  }

  const progressNotifyTools = createProgressNotifyTools({
    db,
    progressTimers,
    findTeamLeader,
    resolveLang,
    sendAgentMessage,
    pickL,
    l,
    randomUUID,
    nowMs,
    broadcast,
  });

  const planningArchiveTools = createPlanningArchiveTools({
    db,
    nowMs,
    randomUUID,
    appendTaskLog,
    sendAgentMessage,
    broadcast,
    pickL,
    l,
    resolveLang,
    runAgentOneShot,
    normalizeConversationReply,
    findTeamLeader,
    getDeptName,
    getAgentDisplayName,
  });

  function pickDesignCheckpointAgent(): AgentRow | null {
    return reportWorkflowTools.pickDesignCheckpointAgent();
  }

  function emitTaskReportEvent(taskId: string): void {
    reportWorkflowTools.emitTaskReportEvent(taskId);
  }

  function shouldDeferTaskReportUntilPlanningArchive(task: {
    source_task_id?: string | null;
    department_id?: string | null;
  }): boolean {
    return reportWorkflowTools.shouldDeferTaskReportUntilPlanningArchive(task);
  }

  function completeTaskWithoutReview(
    task: {
      id: string;
      title: string;
      description: string | null;
      department_id: string | null;
      source_task_id: string | null;
      assigned_agent_id: string | null;
    },
    note: string,
  ): void {
    reportWorkflowTools.completeTaskWithoutReview(task, note);
  }

  function startReportDesignCheckpoint(task: {
    id: string;
    title: string;
    description: string | null;
    project_id?: string | null;
    project_path: string | null;
    assigned_agent_id: string | null;
  }): boolean {
    return reportWorkflowTools.startReportDesignCheckpoint(task);
  }

  function resumeReportAfterDesignCheckpoint(parentTaskId: string, triggerTaskId: string): void {
    reportWorkflowTools.resumeReportAfterDesignCheckpoint(parentTaskId, triggerTaskId);
  }

  function startProgressTimer(taskId: string, taskTitle: string, departmentId: string | null): void {
    progressNotifyTools.startProgressTimer(taskId, taskTitle, departmentId);
  }

  function stopProgressTimer(taskId: string): void {
    progressNotifyTools.stopProgressTimer(taskId);
  }

  // ---------------------------------------------------------------------------
  // Send CEO notification for all significant workflow events (B4)
  // ---------------------------------------------------------------------------
  function notifyCeo(content: string, taskId: string | null = null, messageType: string = "status_update"): void {
    progressNotifyTools.notifyCeo(content, taskId, messageType);
  }

  function cleanArchiveText(value: unknown): string {
    return planningArchiveTools.cleanArchiveText(value);
  }

  function clipArchiveText(value: unknown, maxChars = 1800): string {
    return planningArchiveTools.clipArchiveText(value, maxChars);
  }

  function buildFallbackPlanningArchive(
    rootTask: Record<string, unknown>,
    entries: Array<Record<string, unknown>>,
    lang: string,
  ): string {
    return planningArchiveTools.buildFallbackPlanningArchive(rootTask, entries, lang);
  }

  async function archivePlanningConsolidatedReport(rootTaskId: string): Promise<void> {
    await planningArchiveTools.archivePlanningConsolidatedReport(rootTaskId);
  }

  const { startTaskExecutionForAgent } = createExecutionStartTaskTools({
    nowMs,
    db,
    logsDir,
    appendTaskLog,
    broadcast,
    ensureTaskExecutionSession,
    resolveLang,
    notifyTaskStatus,
    resolveProjectPath,
    createWorktree,
    getDeptRoleConstraint,
    getRecentConversationContext,
    getTaskContinuationContext,
    getRecentChanges,
    ensureClaudeMd,
    pickL,
    l,
    buildAvailableSkillsPromptBlock,
    buildTaskExecutionPrompt,
    hasExplicitWarningFixRequest,
    getNextHttpAgentPid,
    launchApiProviderAgent,
    launchHttpAgent,
    getProviderModelConfig,
    spawnCliAgent,
    handleTaskRunComplete,
    notifyCeo,
    startProgressTimer,
  });

  const workflowMeetingTools = initializeWorkflowMeetingTools(
    Object.assign(Object.create(__ctx), {
      progressTimers,
      reviewRoundState,
      reviewInFlight,
      meetingPresenceUntil,
      meetingSeatIndexByAgent,
      meetingPhaseByAgent,
      meetingTaskIdByAgent,
      meetingReviewDecisionByAgent,
      getTaskStatusById,
      getReviewRoundMode,
      scheduleNextReviewRound,
      startTaskExecutionForAgent,
      startProgressTimer,
      stopProgressTimer,
      notifyCeo,
      reviewMeetingOneShotTimeoutMs: REVIEW_MEETING_ONESHOT_TIMEOUT_MS,
    }),
  );
  const {
    getLeadersByDepartmentIds,
    getAllActiveTeamLeaders,
    getTaskRelatedDepartmentIds,
    getTaskReviewLeaders,
    beginMeetingMinutes,
    appendMeetingMinuteEntry,
    finishMeetingMinutes,
    normalizeRevisionMemoNote,
    reserveReviewRevisionMemoItems,
    loadRecentReviewRevisionMemoItems,
    collectRevisionMemoItems,
    collectPlannedActionItems,
    appendTaskProjectMemo,
    appendTaskReviewFinalMemo,
    markAgentInMeeting,
    isAgentInMeeting,
    callLeadersToCeoOffice,
    dismissLeadersFromCeoOffice,
    emitMeetingSpeech,
    startReviewConsensusMeeting,
  } = workflowMeetingTools;

  const { startPlannedApprovalMeeting } = createPlannedApprovalTools({
    reviewInFlight,
    reviewRoundState,
    db,
    getTaskReviewLeaders,
    resolveProjectPath,
    resolveLang,
    beginMeetingMinutes,
    isTaskWorkflowInterrupted,
    getTaskStatusById,
    finishMeetingMinutes,
    dismissLeadersFromCeoOffice,
    clearTaskWorkflowState,
    getAgentDisplayName,
    getDeptName,
    getRoleLabel,
    sendAgentMessage,
    emitMeetingSpeech,
    appendMeetingMinuteEntry,
    callLeadersToCeoOffice,
    notifyCeo,
    pickL,
    l,
    buildMeetingPrompt,
    runAgentOneShot,
    chooseSafeReply,
    sleepMs,
    randomDelay,
    collectPlannedActionItems,
    appendTaskProjectMemo,
    appendTaskLog,
    reviewMeetingOneShotTimeoutMs: REVIEW_MEETING_ONESHOT_TIMEOUT_MS,
  });

  const sessionReviewTools = createSessionReviewTools({
    taskExecutionSessions,
    nowMs,
    randomUUID,
    stopRequestedTasks,
    stopRequestModeByTask,
    clearCliOutputDedup,
    crossDeptNextCallbacks,
    subtaskDelegationCallbacks,
    subtaskDelegationDispatchInFlight,
    delegatedTaskToSubtask,
    subtaskDelegationCompletionNoticeSent,
    reviewRoundState,
    reviewInFlight,
    appendTaskLog,
    notifyCeo,
    pickL,
    l,
    db,
    finishReview: (...args: any[]) => (finishReview as any)(...args),
    randomDelay,
    startPlannedApprovalMeeting: (...args: any[]) => (startPlannedApprovalMeeting as any)(...args),
  });

  const reportWorkflowTools = createReportWorkflowTools({
    db,
    broadcast,
    appendTaskLog,
    nowMs,
    resolveLang,
    pickL,
    l,
    sendAgentMessage,
    findTeamLeader,
    getAgentDisplayName,
    setTaskCreationAuditCompletion,
    reviewRoundState,
    reviewInFlight,
    endTaskExecutionSession,
    notifyTaskStatus,
    refreshCliUsageData,
    archivePlanningConsolidatedReport,
    crossDeptNextCallbacks,
    recoverCrossDeptQueueAfterMissingCallback,
    subtaskDelegationCallbacks,
    randomUUID,
    REPORT_DESIGN_TASK_PREFIX,
    REPORT_FLOW_PREFIX,
    extractReportPathByLabel,
    upsertReportFlowValue,
    readReportFlowValue,
    recordTaskCreationAudit,
    startTaskExecutionForAgent,
    getDeptName,
    randomDelay,
    notifyCeo,
  });

  // ---------------------------------------------------------------------------
  // Run completion handler — enhanced with review flow + CEO reporting
  // ---------------------------------------------------------------------------
  const runCompleteHandler = createRunCompleteHandler({
    activeProcesses,
    stopProgressTimer,
    db,
    stopRequestedTasks,
    stopRequestModeByTask,
    appendTaskLog,
    clearTaskWorkflowState,
    codexThreadToSubtask,
    nowMs,
    logsDir,
    broadcast,
    processSubtaskDelegations,
    taskWorktrees,
    cleanupWorktree,
    findTeamLeader,
    getAgentDisplayName,
    pickL,
    l,
    notifyCeo,
    sendAgentMessage,
    resolveLang,
    formatTaskSubtaskProgressSummary,
    crossDeptNextCallbacks,
    recoverCrossDeptQueueAfterMissingCallback,
    subtaskDelegationCallbacks,
    finishReview,
    reconcileDelegatedSubtasksAfterRun,
    completeTaskWithoutReview,
    isReportDesignCheckpointTask,
    extractReportDesignParentTaskId,
    resumeReportAfterDesignCheckpoint,
    isPresentationReportTask,
    readReportFlowValue,
    startReportDesignCheckpoint,
    upsertReportFlowValue,
    isReportRequestTask,
    notifyTaskStatus,
    prettyStreamJson,
    getWorktreeDiffSummary,
    hasVisibleDiffSummary,
  });

  function handleTaskRunComplete(taskId: string, exitCode: number): void {
    runCompleteHandler.handleTaskRunComplete(taskId, exitCode);
  }

  const reviewFinalizeTools = createReviewFinalizeTools({
    db,
    nowMs,
    logsDir,
    broadcast,
    appendTaskLog,
    getPreferredLanguage,
    pickL,
    l,
    resolveLang,
    getProjectReviewGateSnapshot,
    projectReviewGateNotifiedAt,
    notifyCeo,
    taskWorktrees,
    mergeToDevAndCreatePR,
    recoverTaskWorktree,
    keepBranchForManualReview,
    mergeWorktree,
    cleanupWorktree,
    findTeamLeader,
    getAgentDisplayName,
    setTaskCreationAuditCompletion,
    endTaskExecutionSession,
    notifyTaskStatus,
    refreshCliUsageData,
    shouldDeferTaskReportUntilPlanningArchive,
    emitTaskReportEvent,
    formatTaskSubtaskProgressSummary,
    reviewRoundState,
    reviewInFlight,
    archivePlanningConsolidatedReport,
    crossDeptNextCallbacks,
    recoverCrossDeptQueueAfterMissingCallback,
    subtaskDelegationCallbacks,
    startReviewConsensusMeeting,
    processSubtaskDelegations,
  });

  function reconcileDelegatedSubtasksAfterRun(taskId: string, exitCode: number): void {
    reviewFinalizeTools.reconcileDelegatedSubtasksAfterRun(taskId, exitCode);
  }

  function finishReview(
    taskId: string,
    taskTitle: string,
    options?: { bypassProjectDecisionGate?: boolean; trigger?: string },
  ): void {
    reviewFinalizeTools.finishReview(taskId, taskTitle, options);
  }

  return {
    crossDeptNextCallbacks,
    subtaskDelegationCallbacks,
    subtaskDelegationDispatchInFlight,
    delegatedTaskToSubtask,
    subtaskDelegationCompletionNoticeSent,
    meetingPresenceUntil,
    meetingSeatIndexByAgent,
    meetingPhaseByAgent,
    meetingTaskIdByAgent,
    meetingReviewDecisionByAgent,
    taskExecutionSessions,
    ensureTaskExecutionSession,
    endTaskExecutionSession,
    isTaskWorkflowInterrupted,
    clearTaskWorkflowState,
    startProgressTimer,
    stopProgressTimer,
    notifyCeo,
    archivePlanningConsolidatedReport,
    isAgentInMeeting,
    startTaskExecutionForAgent,
    startPlannedApprovalMeeting,
    scheduleNextReviewRound,
    handleTaskRunComplete,
    finishReview,
  };
}
