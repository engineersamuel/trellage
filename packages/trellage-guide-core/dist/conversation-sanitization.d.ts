import type { ConversationSnapshot } from "./conversation.js";
export interface ConversationTextSanitization {
    readonly text: string;
    readonly credentialsRedacted: boolean;
    readonly controlsRemoved: boolean;
}
export declare const sanitizeConversationText: (text: string) => ConversationTextSanitization;
export declare const sanitizeConversationSnapshot: (snapshot: ConversationSnapshot) => ConversationSnapshot;
