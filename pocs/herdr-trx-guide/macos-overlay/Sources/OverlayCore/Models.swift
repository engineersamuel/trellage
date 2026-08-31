import CoreGraphics
import Foundation

public enum OverlayLimits {
    public static let maximumUnicodeScalars = 60_000
    public static let dragThreshold: CGFloat = 6
    public static let pasteboardGraceInterval: TimeInterval = 0.35
    public static let socketMaximumBytes = 16 * 1024 * 1024
    public static let actionTimeout: TimeInterval = 15
}

public struct SourceContext: Codable, Equatable, Sendable {
    public let workspaceId: String
    public let tabId: String
    public let paneId: String
    public let cwd: String
    public let agent: String?
    public let paneTitle: String?

    public init(
        workspaceId: String,
        tabId: String,
        paneId: String,
        cwd: String,
        agent: String? = nil,
        paneTitle: String? = nil
    ) {
        self.workspaceId = workspaceId
        self.tabId = tabId
        self.paneId = paneId
        self.cwd = cwd
        self.agent = agent
        self.paneTitle = paneTitle
    }
}

public struct CapturedSelection: Equatable, Sendable {
    public let text: String
    public let globalBounds: CGRect
    public let pasteboardChangeCount: Int
    public let capturedAt: Date
    public let source: SourceContext

    public init(
        text: String,
        globalBounds: CGRect,
        pasteboardChangeCount: Int,
        capturedAt: Date,
        source: SourceContext
    ) {
        self.text = text
        self.globalBounds = globalBounds
        self.pasteboardChangeCount = pasteboardChangeCount
        self.capturedAt = capturedAt
        self.source = source
    }

}

public struct SourceWindowIdentity: Equatable, Sendable {
    public let processId: Int32
    public let windowNumber: Int

    public init(processId: Int32, windowNumber: Int) {
        self.processId = processId
        self.windowNumber = windowNumber
    }
}

public struct OverlayRequest: Codable, Equatable, Sendable {
    public let schemaVersion: Int
    public let requestId: String
    public let selection: String
    public let capturedAt: String
    public let source: SourceContext

    public init(
        schemaVersion: Int = 1,
        requestId: String,
        selection: String,
        capturedAt: String,
        source: SourceContext
    ) {
        self.schemaVersion = schemaVersion
        self.requestId = requestId
        self.selection = selection
        self.capturedAt = capturedAt
        self.source = source
    }
}

public struct SafeActionResult: Codable, Equatable, Sendable {
    public let schemaVersion: Int
    public let requestId: String
    public let queued: Bool
    public let opened: Bool
    public let queueCount: Int

    public init(
        schemaVersion: Int,
        requestId: String,
        queued: Bool,
        opened: Bool,
        queueCount: Int
    ) {
        self.schemaVersion = schemaVersion
        self.requestId = requestId
        self.queued = queued
        self.opened = opened
        self.queueCount = queueCount
    }
}

public enum OverlayAction: Equatable, Sendable {
    case add
    case addAndOpen

    public var actionId: String {
        switch self {
        case .add:
            return "trellage.guide-handoff.queue-add-selection"
        case .addAndOpen:
            return "trellage.guide-handoff.queue-add-selection-open"
        }
    }
}

public enum ActionOutcome: Equatable, Sendable {
    case added(queueCount: Int)
    case addedButNotOpened(queueCount: Int)
    case unknown(requestId: String, logId: String?)
}

public enum ActionViewState: Equatable, Sendable {
    case actions
    case loading(OverlayAction)
    case success(String)
    case error(String)
}

public enum ActionStateTransition {
    public static func start(_ action: OverlayAction, from state: ActionViewState) -> ActionViewState {
        guard state == .actions else { return state }
        return .loading(action)
    }

    public static func finish(_ outcome: ActionOutcome, from state: ActionViewState) -> ActionViewState {
        guard case .loading = state else { return state }
        switch outcome {
        case .added:
            return .success("Added")
        case .addedButNotOpened:
            return .success("Added; queue did not open")
        case .unknown:
            return .success("Status unknown; will reconcile")
        }
    }

    public static func fail(from state: ActionViewState) -> ActionViewState {
        guard case .loading = state else { return state }
        return .error("Could not add — Esc")
    }
}

public enum OverlayError: Error, Equatable, LocalizedError {
    case invalidText(String)
    case invalidContext(String)
    case contextChanged
    case invalidConfiguration(String)
    case processFailed(String)
    case socket(String)
    case transportBeforeSend(String)
    case transportAfterSend(String)
    case invalidResponse(String)
    case actionFailed(String)
    case fileSystem(String)

    public var errorDescription: String? {
        switch self {
        case .invalidText(let message),
             .invalidContext(let message),
             .invalidConfiguration(let message),
             .processFailed(let message),
             .socket(let message),
             .transportBeforeSend(let message),
             .transportAfterSend(let message),
             .invalidResponse(let message),
             .actionFailed(let message),
             .fileSystem(let message):
            return message
        case .contextChanged:
            return "Herdr focus changed before submission"
        }
    }

}

public struct PendingActionRecord: Codable, Equatable, Sendable {
    public let schemaVersion: Int
    public let requestId: String
    public let logId: String?
    public let action: String
    public let createdAt: String

    public init(
        schemaVersion: Int = 1,
        requestId: String,
        logId: String?,
        action: String,
        createdAt: String
    ) {
        self.schemaVersion = schemaVersion
        self.requestId = requestId
        self.logId = logId
        self.action = action
        self.createdAt = createdAt
    }

    public var overlayAction: OverlayAction? {
        switch action {
        case "add":
            return .add
        case "addAndOpen":
            return .addAndOpen
        default:
            return nil
        }
    }
}
