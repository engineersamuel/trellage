import Foundation

public protocol ContextRefreshing {
    func currentContext() throws -> SourceContext
}

public final class MemoryPendingActionStore: PendingActionStoring {
    public var record: PendingActionRecord?

    public init(record: PendingActionRecord? = nil) {
        self.record = record
    }

    public func load() throws -> PendingActionRecord? { record }
    public func save(_ record: PendingActionRecord) throws { self.record = record }
    public func clear() { record = nil }
}

public enum ActionResultMapper {
    public static func outcome(
        from log: HerdrResponseParser.PluginLog,
        action: OverlayAction,
        requestId: String
    ) throws -> ActionOutcome {
        guard let stdout = log.stdout else {
            throw OverlayError.invalidResponse(
                "Terminal plugin log has no safe action result"
            )
        }
        let result = try HerdrResponseParser.safeActionResult(
            stdout: stdout,
            requestId: requestId
        )
        guard result.queued else {
            throw OverlayError.actionFailed(
                log.error ?? "Herdr did not add the selection"
            )
        }
        if action == .addAndOpen && !result.opened {
            return .addedButNotOpened(queueCount: result.queueCount)
        }
        return .added(queueCount: result.queueCount)
    }
}

public final class OverlayActionRunner {
    private let herdr: HerdrRequesting
    private let contextProvider: ContextRefreshing
    private let requestStore: RequestStoring
    private let pendingStore: PendingActionStoring
    private let now: () -> Date
    private let sleep: (TimeInterval) -> Void
    private let uuid: () -> UUID

    public init(
        herdr: HerdrRequesting,
        contextProvider: ContextRefreshing,
        requestStore: RequestStoring,
        pendingStore: PendingActionStoring = MemoryPendingActionStore(),
        now: @escaping () -> Date = Date.init,
        sleep: @escaping (TimeInterval) -> Void = Thread.sleep,
        uuid: @escaping () -> UUID = UUID.init
    ) {
        self.herdr = herdr
        self.contextProvider = contextProvider
        self.requestStore = requestStore
        self.pendingStore = pendingStore
        self.now = now
        self.sleep = sleep
        self.uuid = uuid
    }

    public func run(action: OverlayAction, selection: CapturedSelection) throws -> ActionOutcome {
        guard try pendingStore.load() == nil else {
            throw OverlayError.actionFailed("A previous action still has unknown status")
        }
        guard try contextProvider.currentContext() == selection.source else {
            throw OverlayError.contextChanged
        }

        let startedAt = now()
        let requestId = uuid().uuidString.lowercased()
        let request = OverlayRequest(
            requestId: requestId,
            selection: selection.text,
            capturedAt: Self.timestamp(selection.capturedAt),
            source: selection.source
        )
        let requestURL = try requestStore.write(request)
        var pending = PendingActionRecord(
            requestId: requestId,
            logId: nil,
            action: action.storageName,
            createdAt: Self.timestamp(startedAt)
        )
        var submissionMayHaveStarted = false

        do {
            try pendingStore.save(pending)
            submissionMayHaveStarted = true
            let invoked = try herdr.request(
                method: "plugin.action.invoke",
                params: invocationParams(
                    action: action,
                    requestId: requestId,
                    source: selection.source
                )
            )
            var log = try HerdrResponseParser.invokedLog(from: invoked)
            pending = PendingActionRecord(
                requestId: requestId,
                logId: log.logId,
                action: action.storageName,
                createdAt: pending.createdAt
            )
            try pendingStore.save(pending)

            let deadline = startedAt.addingTimeInterval(OverlayLimits.actionTimeout)
            while log.status == "running" {
                if now() >= deadline {
                    return .unknown(requestId: requestId, logId: log.logId)
                }
                sleep(0.1)
                do {
                    let listed = try herdr.request(
                        method: "plugin.log.list",
                        params: ["plugin_id": "trellage.guide-handoff", "limit": 100]
                    )
                    if let updated = try HerdrResponseParser.exactLog(
                        id: log.logId,
                        from: listed
                    ) {
                        log = updated
                    }
                } catch {
                    continue
                }
            }

            let outcome = try ActionResultMapper.outcome(
                from: log,
                action: action,
                requestId: requestId
            )
            pendingStore.clear()
            return outcome
        } catch where Self.shouldPreserveUnknown(
            error,
            submissionMayHaveStarted: submissionMayHaveStarted,
            logId: pending.logId
        ) {
            return .unknown(requestId: requestId, logId: pending.logId)
        } catch {
            pendingStore.clear()
            requestStore.removeIfPresent(requestURL)
            throw error
        }
    }

    private func invocationParams(
        action: OverlayAction,
        requestId: String,
        source: SourceContext
    ) -> [String: Any] {
        var context: [String: Any] = [
            "workspace_id": source.workspaceId,
            "tab_id": source.tabId,
            "focused_pane_id": source.paneId,
            "focused_pane_cwd": source.cwd,
            "invocation_source": "trellage-guide-overlay",
            "correlation_id": requestId,
            "selected_text": "trellage-guide-overlay-request:v1:\(requestId)",
        ]
        if let agent = source.agent {
            context["focused_pane_agent"] = agent
        }
        return ["action_id": action.actionId, "context": context]
    }

    private static func timestamp(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }

    fileprivate static func isUncertainInitialInvoke(_ error: Error) -> Bool {
        guard let overlayError = error as? OverlayError else { return false }
        switch overlayError {
        case .transportAfterSend, .invalidResponse:
            return true
        default:
            return false
        }
    }

    private static func shouldPreserveUnknown(
        _ error: Error,
        submissionMayHaveStarted: Bool,
        logId: String?
    ) -> Bool {
        if isUncertainInitialInvoke(error) {
            return true
        }
        if logId != nil {
            if let overlayError = error as? OverlayError,
               case .actionFailed = overlayError
            {
                return false
            }
            return true
        }
        guard submissionMayHaveStarted, let overlayError = error as? OverlayError else {
            return false
        }
        if case .fileSystem = overlayError {
            return true
        }
        return false
    }
}

public enum ActionReconciliationResult: Equatable {
    case none
    case resolved(ActionOutcome)
    case failed
    case unresolved(PendingActionRecord)
}

public final class OverlayActionReconciler {
    private let herdr: HerdrRequesting
    private let requestStore: RequestStoring
    private let pendingStore: PendingActionStoring

    public init(
        herdr: HerdrRequesting,
        requestStore: RequestStoring,
        pendingStore: PendingActionStoring
    ) {
        self.herdr = herdr
        self.requestStore = requestStore
        self.pendingStore = pendingStore
    }

    public func reconcile() throws -> ActionReconciliationResult {
        guard var pending = try pendingStore.load() else {
            return .none
        }
        guard let action = pending.overlayAction else {
            pendingStore.clear()
            requestStore.removeRequest(requestId: pending.requestId)
            return .failed
        }

        let listed: [String: Any]
        do {
            listed = try herdr.request(
                method: "plugin.log.list",
                params: ["plugin_id": "trellage.guide-handoff", "limit": 100]
            )
        } catch {
            return .unresolved(pending)
        }

        let log: HerdrResponseParser.PluginLog?
        do {
            if let logId = pending.logId {
                log = try HerdrResponseParser.exactLog(id: logId, from: listed)
            } else {
                log = try HerdrResponseParser.logMatching(
                    requestId: pending.requestId,
                    from: listed
                )
                if let log {
                    pending = PendingActionRecord(
                        requestId: pending.requestId,
                        logId: log.logId,
                        action: pending.action,
                        createdAt: pending.createdAt
                    )
                    try pendingStore.save(pending)
                }
            }
        } catch {
            return .unresolved(pending)
        }

        guard let log, log.status != "running" else {
            return .unresolved(pending)
        }
        do {
            let outcome = try ActionResultMapper.outcome(
                from: log,
                action: action,
                requestId: pending.requestId
            )
            pendingStore.clear()
            requestStore.removeRequest(requestId: pending.requestId)
            return .resolved(outcome)
        } catch where OverlayActionRunner.isUncertainInitialInvoke(error) {
            return .unresolved(pending)
        } catch {
            pendingStore.clear()
            requestStore.removeRequest(requestId: pending.requestId)
            return .failed
        }
    }
}

public final class UnresolvedActionRecovery {
    private let requestStore: RequestStoring
    private let pendingStore: PendingActionStoring

    public init(
        requestStore: RequestStoring,
        pendingStore: PendingActionStoring
    ) {
        self.requestStore = requestStore
        self.pendingStore = pendingStore
    }

    @discardableResult
    public func resumeAfterQueueCheck() throws -> Bool {
        guard let pending = try pendingStore.load() else {
            return false
        }
        requestStore.removeRequest(requestId: pending.requestId)
        pendingStore.clear()
        return true
    }
}

private extension OverlayAction {
    var storageName: String {
        switch self {
        case .add:
            return "add"
        case .addAndOpen:
            return "addAndOpen"
        }
    }
}
