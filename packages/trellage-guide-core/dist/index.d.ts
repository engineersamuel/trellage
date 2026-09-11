export * from "./conversation.js";
export * from "./conversation-sanitization.js";
export type ProfileGuideIdentity = {
    readonly surface: "native";
    readonly launcher: string;
    readonly profile: string;
} | {
    readonly surface: "sandbox";
    readonly profile: string;
};
export interface ProfileGuidePrerequisite {
    readonly id: string;
    readonly description: string;
}
export interface ProfileGuideWorkflow {
    readonly id: string;
    readonly description: string;
    readonly skill?: string;
    readonly launchAgent?: string;
    readonly examples: ReadonlyArray<string>;
    readonly promptTemplate: string;
}
export type ProfileGuideGoalController = "codex-goal" | "claude-goal" | "graph-of-loops";
export interface ProfileGuideGoalExecution {
    readonly controller: ProfileGuideGoalController;
    readonly workflowIds: ReadonlyArray<string>;
}
export interface ProfileGuideV1 {
    readonly schemaVersion: 1;
    readonly capabilities: ReadonlyArray<string>;
    readonly bestFor: ReadonlyArray<string>;
    readonly avoidFor: ReadonlyArray<string>;
    readonly prerequisites: ReadonlyArray<ProfileGuidePrerequisite>;
    readonly workflows: ReadonlyArray<ProfileGuideWorkflow>;
    readonly goalExecution?: ProfileGuideGoalExecution;
}
export interface ProfileGuideDocument {
    readonly guide: ProfileGuideV1;
    readonly body: string;
}
export interface LoadedProfileGuide extends ProfileGuideDocument {
    readonly identity: ProfileGuideIdentity;
    readonly key: string;
    readonly relativePath: string;
}
export interface ProfileGuideCoverage {
    readonly missing: ReadonlyArray<string>;
    readonly unexpected: ReadonlyArray<string>;
}
export declare class ProfileGuideValidationError extends Error {
    readonly path: string;
    constructor(path: string, message: string);
}
export declare const isLaunchAgentIdentifier: (value: string) => boolean;
export declare const isProfileGuideGoalController: (value: unknown) => value is ProfileGuideGoalController;
/** Shared binding rules for authored guides and their independently validated JSON projections. */
export declare const profileGuideGoalExecutionProblem: (execution: ProfileGuideGoalExecution, guideWorkflows: ReadonlyArray<ProfileGuideWorkflow>, identity?: ProfileGuideIdentity, harness?: string) => string | undefined;
export declare const parseProfileGuide: (path: string, source: string) => ProfileGuideDocument;
export declare const profileGuideIdentityKey: (identity: ProfileGuideIdentity) => string;
export declare const profileGuideRelativePath: (identity: ProfileGuideIdentity) => string;
export declare const parseProfileGuideIdentity: (relativePath: string) => ProfileGuideIdentity;
export declare const validateProfileGuideCoverage: (expected: ReadonlyArray<ProfileGuideIdentity>, actualRelativePaths: ReadonlyArray<string>) => ProfileGuideCoverage;
export declare const loadProfileGuide: (root: string, identity: ProfileGuideIdentity) => Promise<LoadedProfileGuide>;
export declare const loadProfileGuideRegistry: (root: string, identities: ReadonlyArray<ProfileGuideIdentity>) => Promise<ReadonlyMap<string, LoadedProfileGuide>>;
export declare const discoverProfileGuideRelativePaths: (root: string) => Promise<ReadonlyArray<string>>;
