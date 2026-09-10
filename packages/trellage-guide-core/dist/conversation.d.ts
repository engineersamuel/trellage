export declare enum ConversationSurface {
    Host = "host",
    Native = "native",
    Sandbox = "sandbox"
}
export declare enum ConversationAgent {
    Copilot = "copilot",
    Codex = "codex",
    Claude = "claude"
}
export declare enum ConversationRole {
    User = "user",
    Assistant = "assistant"
}
export interface ConversationSource {
    readonly serverId: string;
    readonly surface: ConversationSurface;
    readonly agent: ConversationAgent;
    readonly sessionId: string;
    readonly workspaceId: string;
    readonly paneId: string;
    readonly cwd: string;
    readonly tabId?: string;
    readonly profile?: string;
    readonly containerId?: string;
    readonly invocationId?: string;
}
export interface ConversationMessage {
    readonly id: string;
    readonly role: ConversationRole;
    readonly text: string;
    readonly recordIndex: number;
}
export interface ConversationSnapshot {
    readonly schemaVersion: 1;
    readonly id: string;
    readonly source: ConversationSource;
    readonly capturedAt: string;
    readonly cutoff: {
        readonly messageId: string;
        readonly recordIndex: number;
    };
    readonly revision: string;
    readonly messages: ReadonlyArray<ConversationMessage>;
    readonly coverage: {
        readonly complete: boolean;
        readonly notices: ReadonlyArray<string>;
    };
}
export declare enum ContinuationOutcome {
    Recommendations = "recommendations",
    NeedsClarification = "needs-clarification",
    NoFurtherAction = "no-further-action"
}
export declare enum ActionImportance {
    Required = "required",
    Optional = "optional"
}
export declare enum ActionAccess {
    ReadOnly = "read-only",
    Write = "write",
    Unknown = "unknown"
}
export interface NextAction {
    readonly id: string;
    readonly rank: number;
    readonly title: string;
    readonly brief: string;
    readonly whyNow: string;
    readonly expectedOutput: string;
    readonly evidenceIds: ReadonlyArray<string>;
    readonly importance: ActionImportance;
    readonly profileRef: string;
    readonly workflowId: string;
    readonly dependsOn: ReadonlyArray<string>;
    readonly access: ActionAccess;
}
export interface ContinuationAssessment {
    readonly schemaVersion: 1;
    readonly outcome: ContinuationOutcome;
    readonly goal: string;
    readonly reportedProgress: ReadonlyArray<string>;
    readonly unresolvedWork: ReadonlyArray<string>;
    readonly blockers: ReadonlyArray<string>;
    readonly actions: ReadonlyArray<NextAction>;
    readonly questions: ReadonlyArray<string>;
}
export interface ConversationSummary {
    readonly key: string;
    readonly text: string;
    readonly evidenceIds: ReadonlyArray<string>;
}
export declare enum ContinuationPlacementKind {
    CurrentWorkspacePane = "current-workspace-pane",
    NewTab = "new-tab",
    NewWorktree = "new-worktree",
    ExistingWorktree = "existing-worktree"
}
export type ContinuationPlacement = {
    readonly kind: ContinuationPlacementKind.CurrentWorkspacePane;
    readonly direction: "right" | "down";
} | {
    readonly kind: ContinuationPlacementKind.NewTab;
} | {
    readonly kind: ContinuationPlacementKind.NewWorktree;
    readonly branch: string;
    readonly baseRef: string;
} | {
    readonly kind: ContinuationPlacementKind.ExistingWorktree;
    readonly path: string;
};
export declare enum ContinuationActionStatus {
    Draft = "draft",
    Prepared = "prepared",
    Waiting = "waiting",
    Launching = "launching",
    Launched = "launched",
    Failed = "failed",
    Unknown = "unknown"
}
export interface ContinuationLaunchReceipt {
    readonly attemptId: string;
    readonly status: ContinuationActionStatus;
    readonly paneId?: string;
    readonly workspaceId?: string;
    readonly cwd?: string;
    readonly message?: string;
}
export interface ContinuationPromptCandidate {
    readonly id: string;
    readonly title: string;
    readonly prompt: string;
    readonly notes: string;
}
export interface ContinuationActionDraft {
    readonly actionId: string;
    readonly brief: string;
    readonly selected: boolean;
    readonly status: ContinuationActionStatus;
    readonly prompt?: string;
    readonly candidates?: ReadonlyArray<ContinuationPromptCandidate>;
    /** The explicitly chosen candidate origin, retained after outgoing prompt edits. */
    readonly selectedCandidateId?: string;
    readonly profileRef?: string;
    readonly workflowId?: string;
    readonly placement?: ContinuationPlacement;
    readonly prerequisitesConfirmed?: boolean;
    readonly sharedWriteConfirmed?: boolean;
    readonly uncommittedChangesConfirmed?: boolean;
    readonly launch?: ContinuationLaunchReceipt;
}
export interface ContinuationDraft {
    readonly schemaVersion: 1;
    readonly id: string;
    readonly revision: number;
    readonly snapshot: ConversationSnapshot;
    readonly model: string;
    readonly effort: string;
    readonly summaries: ReadonlyArray<ConversationSummary>;
    readonly assessment?: ContinuationAssessment;
    readonly actions: ReadonlyArray<ContinuationActionDraft>;
}
export declare const conversationLimits: Readonly<{
    snapshotBytes: number;
    draftBytes: number;
    messageBytes: number;
    messageCount: 100000;
    identifierChars: 256;
    pathChars: 4096;
    actionCount: 5;
    briefChars: 16000;
    promptChars: 64000;
    promptCandidateCount: 3;
    promptCandidateTitleChars: 200;
    promptCandidateNotesChars: 1000;
    summaryCount: 512;
    summaryChars: 16000;
    evidenceCount: 100000;
    noticeCount: 64;
    noticeChars: 2000;
    journalBytes: number;
    journalEventBytes: 8192;
}>;
export declare class ConversationValidationError extends Error {
    readonly field: string;
    constructor(field: string, message: string);
}
export declare const validateConversationSource: (value: unknown) => ConversationSource;
/** Identity is not a cwd lookup: every bound pane, session, and surface field participates. */
export declare const conversationSourceKey: (source: ConversationSource) => string;
export declare const validateConversationSnapshot: (value: unknown) => ConversationSnapshot;
export declare const validateContinuationAssessment: (value: unknown, snapshot: ConversationSnapshot, catalogRefs: ReadonlyMap<string, ReadonlySet<string>>) => ContinuationAssessment;
export declare const validateContinuationDraft: (value: unknown) => ContinuationDraft;
