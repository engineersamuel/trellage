import Foundation
import Testing
@testable import OverlayCore

private final class ContextStub: ContextRefreshing {
    var context: SourceContext
    init(_ context: SourceContext) { self.context = context }
    func currentContext() throws -> SourceContext { context }
}

private final class StoreStub: RequestStoring {
    var written: OverlayRequest?
    var removed = false
    var removedRequestId: String?
    func write(_ request: OverlayRequest) throws -> URL {
        written = request
        return URL(fileURLWithPath: "/requests/\(request.requestId).json")
    }
    func removeIfPresent(_ url: URL) {
        removed = true
    }
    func removeRequest(requestId: String) {
        removedRequestId = requestId
    }
}

private final class HerdrStub: HerdrRequesting {
    var responses: [[String: Any]]
    var calls: [(String, [String: Any])] = []
    init(responses: [[String: Any]]) { self.responses = responses }
    func request(method: String, params: [String: Any]) throws -> [String: Any] {
        calls.append((method, params))
        return responses.removeFirst()
    }
}

private final class ResultHerdrStub: HerdrRequesting {
    var responses: [Result<[String: Any], Error>]
    var calls: [(String, [String: Any])] = []

    init(_ responses: [Result<[String: Any], Error>]) {
        self.responses = responses
    }

    func request(method: String, params: [String: Any]) throws -> [String: Any] {
        calls.append((method, params))
        return try responses.removeFirst().get()
    }
}

private final class SecondSaveFailurePendingStore: PendingActionStoring {
    var record: PendingActionRecord?
    private var saveCount = 0

    func load() throws -> PendingActionRecord? { record }
    func save(_ record: PendingActionRecord) throws {
        saveCount += 1
        if saveCount == 2 {
            throw OverlayError.fileSystem("save failed")
        }
        self.record = record
    }
    func clear() { record = nil }
}

@Suite struct ActionRunnerTests {
    private let source = SourceContext(
        workspaceId: "w1",
        tabId: "w1:t1",
        paneId: "w1:p1",
        cwd: "/repo",
        agent: "copilot",
        paneTitle: "Review code"
    )
    private let fixedId = UUID(uuidString: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA")!

    @Test func runsActionWithOpaqueTokenAndParsesSuccess() throws {
        let stdout = """
        {"schemaVersion":1,"requestId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","queued":true,"opened":false,"queueCount":3}
        """
        let herdr = HerdrStub(responses: [
            [
                "type": "plugin_action_invoked",
                "log": ["log_id": "plugin-log-1", "status": "running"],
            ],
            [
                "type": "plugin_log_list",
                "logs": [[
                    "log_id": "plugin-log-1",
                    "status": "succeeded",
                    "stdout": stdout,
                ]],
            ],
        ])
        let store = StoreStub()
        let runner = OverlayActionRunner(
            herdr: herdr,
            contextProvider: ContextStub(source),
            requestStore: store,
            sleep: { _ in },
            uuid: { fixedId }
        )
        let outcome = try runner.run(action: .add, selection: selection())
        #expect(outcome == .added(queueCount: 3))
        #expect(store.written?.selection == "selected text")
        #expect(!store.removed)

        let invoke = herdr.calls[0]
        #expect(invoke.0 == "plugin.action.invoke")
        #expect(invoke.1["action_id"] as? String
            == "trellage.guide-handoff.queue-add-selection")
        let context = try #require(invoke.1["context"] as? [String: Any])
        #expect(context["selected_text"] as? String
            == "trellage-guide-overlay-request:v1:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
        #expect(context["correlation_id"] as? String
            == "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
        let invocationData = try JSONSerialization.data(withJSONObject: invoke.1)
        #expect(!invocationData.containsSubsequence(Data("selected text".utf8)))
    }

    @Test func reportsPartialOpenWithoutRetryingAdd() throws {
        let stdout = """
        {"schemaVersion":1,"requestId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","queued":true,"opened":false,"queueCount":5}
        """
        let herdr = HerdrStub(responses: [[
            "type": "plugin_action_invoked",
            "log": [
                "log_id": "plugin-log-2",
                "status": "succeeded",
                "stdout": stdout,
            ],
        ]])
        let runner = OverlayActionRunner(
            herdr: herdr,
            contextProvider: ContextStub(source),
            requestStore: StoreStub(),
            uuid: { fixedId }
        )
        #expect(try runner.run(action: .addAndOpen, selection: selection())
            == .addedButNotOpened(queueCount: 5))
        #expect(herdr.calls.count == 1)
    }

    @Test func reportsPartialOpenFromFailedLogSafeStdout() throws {
        let stdout = """
        {"schemaVersion":1,"requestId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","queued":true,"opened":false,"queueCount":6}
        """
        let herdr = HerdrStub(responses: [[
            "type": "plugin_action_invoked",
            "log": [
                "log_id": "plugin-log-partial",
                "status": "failed",
                "stdout": stdout,
                "error": "queue editor did not open",
            ],
        ]])
        let runner = OverlayActionRunner(
            herdr: herdr,
            contextProvider: ContextStub(source),
            requestStore: StoreStub(),
            uuid: { fixedId }
        )
        #expect(try runner.run(action: .addAndOpen, selection: selection())
            == .addedButNotOpened(queueCount: 6))
        #expect(herdr.calls.count == 1)
    }

    @Test func invalidTerminalResultRemainsUnresolved() throws {
        let store = StoreStub()
        let pending = MemoryPendingActionStore()
        let herdr = HerdrStub(responses: [[
            "type": "plugin_action_invoked",
            "log": [
                "log_id": "plugin-log-invalid-partial",
                "status": "failed",
                "stdout": """
                {"schemaVersion":1,"requestId":"wrong","queued":true,"opened":false,"queueCount":6}
                """,
            ],
        ]])
        let runner = OverlayActionRunner(
            herdr: herdr,
            contextProvider: ContextStub(source),
            requestStore: store,
            pendingStore: pending,
            uuid: { fixedId }
        )
        #expect(try runner.run(action: .addAndOpen, selection: selection()) == .unknown(
            requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            logId: "plugin-log-invalid-partial"
        ))
        #expect(!store.removed)
        #expect(pending.record?.logId == "plugin-log-invalid-partial")
    }

    @Test func failsBeforeWritingWhenContextChanged() {
        let changed = SourceContext(
            workspaceId: "w2",
            tabId: "w2:t1",
            paneId: "w2:p1",
            cwd: "/other"
        )
        let store = StoreStub()
        let runner = OverlayActionRunner(
            herdr: HerdrStub(responses: []),
            contextProvider: ContextStub(changed),
            requestStore: store,
            uuid: { fixedId }
        )
        #expect(throws: OverlayError.contextChanged) {
            try runner.run(action: .add, selection: selection())
        }
        #expect(store.written == nil)
    }

    @Test func terminalFailureWithoutSafeResultRemainsUnresolved() throws {
        let store = StoreStub()
        let pending = MemoryPendingActionStore()
        let herdr = HerdrStub(responses: [[
            "type": "plugin_action_invoked",
            "log": [
                "log_id": "plugin-log-3",
                "status": "failed",
                "error": "action failed",
            ],
        ]])
        let runner = OverlayActionRunner(
            herdr: herdr,
            contextProvider: ContextStub(source),
            requestStore: store,
            pendingStore: pending,
            uuid: { fixedId }
        )
        #expect(try runner.run(action: .add, selection: selection()) == .unknown(
            requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            logId: "plugin-log-3"
        ))
        #expect(!store.removed)
        #expect(pending.record?.logId == "plugin-log-3")
    }

    @Test func validSafeNotQueuedResultConfirmsFailureAndCleansState() {
        let stdout = """
        {"schemaVersion":1,"requestId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","queued":false,"opened":false,"queueCount":2}
        """
        let store = StoreStub()
        let pending = MemoryPendingActionStore()
        let runner = OverlayActionRunner(
            herdr: HerdrStub(responses: [[
                "type": "plugin_action_invoked",
                "log": [
                    "log_id": "plugin-log-not-queued",
                    "status": "failed",
                    "stdout": stdout,
                    "error": "request rejected",
                ],
            ]]),
            contextProvider: ContextStub(source),
            requestStore: store,
            pendingStore: pending,
            uuid: { fixedId }
        )
        #expect(throws: OverlayError.self) {
            try runner.run(action: .add, selection: selection())
        }
        #expect(store.removed)
        #expect(pending.record == nil)
    }

    @Test func timeoutIsUnknownAndKeepsPendingIdentity() throws {
        let store = StoreStub()
        let pending = MemoryPendingActionStore()
        let herdr = HerdrStub(responses: [[
            "type": "plugin_action_invoked",
            "log": ["log_id": "plugin-log-timeout", "status": "running"],
        ]])
        var times = [
            Date(timeIntervalSince1970: 0),
            Date(timeIntervalSince1970: OverlayLimits.actionTimeout + 1),
        ]
        let runner = OverlayActionRunner(
            herdr: herdr,
            contextProvider: ContextStub(source),
            requestStore: store,
            pendingStore: pending,
            now: { times.removeFirst() },
            sleep: { _ in },
            uuid: { fixedId }
        )
        #expect(try runner.run(action: .add, selection: selection()) == .unknown(
            requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            logId: "plugin-log-timeout"
        ))
        #expect(!store.removed)
        #expect(pending.record?.requestId == "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
        #expect(pending.record?.logId == "plugin-log-timeout")
    }

    @Test func transientPollingFailureReconnectsToExactLog() throws {
        let stdout = """
        {"schemaVersion":1,"requestId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","queued":true,"opened":false,"queueCount":7}
        """
        let herdr = ResultHerdrStub([
            .success([
                "type": "plugin_action_invoked",
                "log": ["log_id": "plugin-log-reconnect", "status": "running"],
            ]),
            .failure(OverlayError.socket("disconnected")),
            .success([
                "type": "plugin_log_list",
                "logs": [[
                    "log_id": "plugin-log-reconnect",
                    "status": "succeeded",
                    "stdout": stdout,
                ]],
            ]),
        ])
        var seconds: TimeInterval = 0
        let runner = OverlayActionRunner(
            herdr: herdr,
            contextProvider: ContextStub(source),
            requestStore: StoreStub(),
            now: {
                defer { seconds += 0.1 }
                return Date(timeIntervalSince1970: seconds)
            },
            sleep: { _ in },
            uuid: { fixedId }
        )
        #expect(try runner.run(action: .add, selection: selection()) == .added(queueCount: 7))
        #expect(herdr.calls.map(\.0) == [
            "plugin.action.invoke",
            "plugin.log.list",
            "plugin.log.list",
        ])
    }

    @Test func transientInvokeFailurePersistsUnknownRequestIdentity() throws {
        let store = StoreStub()
        let pending = MemoryPendingActionStore()
        let runner = OverlayActionRunner(
            herdr: ResultHerdrStub([
                .failure(OverlayError.transportAfterSend("response lost")),
            ]),
            contextProvider: ContextStub(source),
            requestStore: store,
            pendingStore: pending,
            uuid: { fixedId }
        )
        #expect(try runner.run(action: .add, selection: selection()) == .unknown(
            requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            logId: nil
        ))
        #expect(pending.record?.requestId == "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
        #expect(!store.removed)
    }

    @Test func definitePreSendFailureCleansRequestAndPendingState() {
        let store = StoreStub()
        let pending = MemoryPendingActionStore()
        let runner = OverlayActionRunner(
            herdr: ResultHerdrStub([
                .failure(OverlayError.transportBeforeSend("connect failed")),
            ]),
            contextProvider: ContextStub(source),
            requestStore: store,
            pendingStore: pending,
            uuid: { fixedId }
        )
        #expect(throws: OverlayError.self) {
            try runner.run(action: .add, selection: selection())
        }
        #expect(store.removed)
        #expect(pending.record == nil)
    }

    @Test func logQueryErrorEnvelopeRemainsUnresolvedUntilExactTerminalLog() throws {
        let stdout = """
        {"schemaVersion":1,"requestId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","queued":true,"opened":false,"queueCount":9}
        """
        let pending = MemoryPendingActionStore()
        let herdr = ResultHerdrStub([
            .success([
                "type": "plugin_action_invoked",
                "log": ["log_id": "plugin-log-envelope", "status": "running"],
            ]),
            .failure(OverlayError.actionFailed("temporary API error")),
            .success([
                "type": "plugin_log_list",
                "logs": [[
                    "log_id": "plugin-log-envelope",
                    "status": "succeeded",
                    "stdout": stdout,
                ]],
            ]),
        ])
        var seconds: TimeInterval = 0
        let runner = OverlayActionRunner(
            herdr: herdr,
            contextProvider: ContextStub(source),
            requestStore: StoreStub(),
            pendingStore: pending,
            now: {
                defer { seconds += 0.1 }
                return Date(timeIntervalSince1970: seconds)
            },
            sleep: { _ in },
            uuid: { fixedId }
        )
        #expect(try runner.run(action: .add, selection: selection()) == .added(queueCount: 9))
        #expect(pending.record == nil)
    }

    @Test func logIdentityPersistenceFailureRemainsUnknown() throws {
        let pending = SecondSaveFailurePendingStore()
        let store = StoreStub()
        let runner = OverlayActionRunner(
            herdr: HerdrStub(responses: [[
                "type": "plugin_action_invoked",
                "log": ["log_id": "plugin-log-unpersisted", "status": "running"],
            ]]),
            contextProvider: ContextStub(source),
            requestStore: store,
            pendingStore: pending,
            uuid: { fixedId }
        )
        #expect(try runner.run(action: .add, selection: selection()) == .unknown(
            requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            logId: "plugin-log-unpersisted"
        ))
        #expect(pending.record?.requestId == "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
        #expect(pending.record?.logId == nil)
        #expect(!store.removed)
    }

    @Test func reconcilesPersistedExactLogWithoutNewInvocation() throws {
        let stdout = """
        {"schemaVersion":1,"requestId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","queued":true,"opened":false,"queueCount":8}
        """
        let pending = MemoryPendingActionStore(record: PendingActionRecord(
            requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            logId: "plugin-log-existing",
            action: "add",
            createdAt: "2026-08-31T14:00:00Z"
        ))
        let store = StoreStub()
        let herdr = HerdrStub(responses: [[
            "type": "plugin_log_list",
            "logs": [[
                "log_id": "plugin-log-existing",
                "status": "succeeded",
                "stdout": stdout,
            ]],
        ]])
        let result = try OverlayActionReconciler(
            herdr: herdr,
            requestStore: store,
            pendingStore: pending
        ).reconcile()
        #expect(result == .resolved(.added(queueCount: 8)))
        #expect(pending.record == nil)
        #expect(store.removedRequestId == "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
        #expect(herdr.calls.map(\.0) == ["plugin.log.list"])
    }

    @Test func reconciliationQueryFailureKeepsPendingIdentity() throws {
        let record = PendingActionRecord(
            requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            logId: "plugin-log-existing",
            action: "add",
            createdAt: "2026-08-31T14:00:00Z"
        )
        let pending = MemoryPendingActionStore(record: record)
        let store = StoreStub()
        let result = try OverlayActionReconciler(
            herdr: ResultHerdrStub([
                .failure(OverlayError.actionFailed("log API error")),
            ]),
            requestStore: store,
            pendingStore: pending
        ).reconcile()
        #expect(result == .unresolved(record))
        #expect(pending.record == record)
        #expect(store.removedRequestId == nil)
    }

    @Test func reconciliationTerminalFailureWithoutSafeResultStaysUnresolved() throws {
        let record = PendingActionRecord(
            requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            logId: "plugin-log-failed-no-result",
            action: "add",
            createdAt: "2026-08-31T14:00:00Z"
        )
        let pending = MemoryPendingActionStore(record: record)
        let store = StoreStub()
        let result = try OverlayActionReconciler(
            herdr: HerdrStub(responses: [[
                "type": "plugin_log_list",
                "logs": [[
                    "log_id": "plugin-log-failed-no-result",
                    "status": "failed",
                    "error": "action failed",
                ]],
            ]]),
            requestStore: store,
            pendingStore: pending
        ).reconcile()
        #expect(result == .unresolved(record))
        #expect(pending.record == record)
        #expect(store.removedRequestId == nil)
    }

    @Test func explicitQueueCheckedRecoveryClearsUnknownIdentity() throws {
        let pending = MemoryPendingActionStore(record: PendingActionRecord(
            requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            logId: "plugin-log-existing",
            action: "add",
            createdAt: "2026-08-31T14:00:00Z"
        ))
        let store = StoreStub()
        #expect(try UnresolvedActionRecovery(
            requestStore: store,
            pendingStore: pending
        ).resumeAfterQueueCheck())
        #expect(store.removedRequestId == "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
        #expect(pending.record == nil)
    }

    @Test func pendingUnknownActionBlocksNewSubmission() {
        let pending = MemoryPendingActionStore(record: PendingActionRecord(
            requestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            logId: "plugin-log-pending",
            action: "add",
            createdAt: "2026-08-31T14:00:00Z"
        ))
        let store = StoreStub()
        let herdr = HerdrStub(responses: [])
        let runner = OverlayActionRunner(
            herdr: herdr,
            contextProvider: ContextStub(source),
            requestStore: store,
            pendingStore: pending,
            uuid: { fixedId }
        )
        #expect(throws: OverlayError.self) {
            try runner.run(action: .add, selection: selection())
        }
        #expect(store.written == nil)
        #expect(herdr.calls.isEmpty)
    }

    @Test func actionStateTransitionsAreStable() {
        let loading = ActionStateTransition.start(.add, from: .actions)
        #expect(loading == .loading(.add))
        #expect(ActionStateTransition.finish(.added(queueCount: 1), from: loading)
            == .success("Added"))
        #expect(ActionStateTransition.finish(
            .addedButNotOpened(queueCount: 1),
            from: loading
        ) == .success("Added; queue did not open"))
        #expect(ActionStateTransition.finish(
            .unknown(requestId: "id", logId: "log"),
            from: loading
        ) == .success("Status unknown; will reconcile"))
        #expect(ActionStateTransition.fail(from: loading) == .error("Could not add — Esc"))
    }

    private func selection() -> CapturedSelection {
        CapturedSelection(
            text: "selected text",
            globalBounds: .zero,
            pasteboardChangeCount: 2,
            capturedAt: Date(timeIntervalSince1970: 1_788_182_400),
            source: source
        )
    }
}

private extension Data {
    func containsSubsequence(_ other: Data) -> Bool {
        range(of: other) != nil
    }
}
