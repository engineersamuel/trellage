import CoreGraphics
import Darwin
import Foundation
import OverlayCore

private struct TestFailure: Error, CustomStringConvertible {
    let description: String
}

private final class TestSuite {
    private(set) var count = 0

    func check(_ condition: @autoclosure () throws -> Bool, _ name: String) throws {
        count += 1
        guard try condition() else { throw TestFailure(description: name) }
    }

    func rejects(_ name: String, _ operation: () throws -> Void) throws {
        count += 1
        do {
            try operation()
            throw TestFailure(description: name)
        } catch is TestFailure {
            throw TestFailure(description: name)
        } catch {}
    }
}

private final class ContextStub: ContextRefreshing {
    let value: SourceContext
    init(_ value: SourceContext) { self.value = value }
    func currentContext() throws -> SourceContext { value }
}

private final class StoreStub: RequestStoring {
    var written: OverlayRequest?
    var removed = false
    var removedRequestId: String?
    func write(_ request: OverlayRequest) throws -> URL {
        written = request
        return URL(fileURLWithPath: "/requests/\(request.requestId).json")
    }
    func removeIfPresent(_ url: URL) { removed = true }
    func removeRequest(requestId: String) { removedRequestId = requestId }
}

private final class HerdrStub: HerdrRequesting {
    var responses: [[String: Any]]
    var calls: [(String, [String: Any])] = []
    init(_ responses: [[String: Any]]) { self.responses = responses }
    func request(method: String, params: [String: Any]) throws -> [String: Any] {
        calls.append((method, params))
        guard !responses.isEmpty else { throw OverlayError.socket("No mock response") }
        return responses.removeFirst()
    }
}

private final class ResultHerdrStub: HerdrRequesting {
    var results: [Result<[String: Any], Error>]
    var calls: [String] = []

    init(_ results: [Result<[String: Any], Error>]) {
        self.results = results
    }

    func request(method: String, params: [String: Any]) throws -> [String: Any] {
        calls.append(method)
        return try results.removeFirst().get()
    }
}

private final class WindowStub: ForegroundWindowReading {
    var observations: [ForegroundWindowObservation]
    init(_ observations: [ForegroundWindowObservation]) {
        self.observations = observations
    }
    func frontmostKittyWindow() throws -> ForegroundWindowObservation {
        observations.removeFirst()
    }
}

private final class ProcessStub: AbsoluteProcessRunning {
    let result: BoundedProcessResult
    var invocation: (String, [String], TimeInterval, Int)?

    init(result: BoundedProcessResult) {
        self.result = result
    }

    func run(
        executable: String,
        arguments: [String],
        timeout: TimeInterval,
        maximumOutputBytes: Int
    ) throws -> BoundedProcessResult {
        invocation = (executable, arguments, timeout, maximumOutputBytes)
        return result
    }
}

private final class IdentityProofStub: WindowIdentityProving {
    let identity: SourceWindowIdentity

    init(_ identity: SourceWindowIdentity) {
        self.identity = identity
    }

    func prove() throws -> SourceWindowIdentity {
        identity
    }
}

private func snapshotResult(
    workspace: String = "w1",
    tab: String = "w1:t1",
    pane: String,
    cwd: String = "/repo"
) -> [String: Any] {
    [
        "type": "session_snapshot",
        "snapshot": [
            "focused_workspace_id": workspace,
            "focused_tab_id": tab,
            "focused_pane_id": pane,
            "workspaces": [[
                "workspace_id": workspace,
                "active_tab_id": tab,
                "focused": true,
            ]],
            "tabs": [[
                "tab_id": tab,
                "workspace_id": workspace,
                "focused": true,
            ]],
            "panes": [[
                "pane_id": pane,
                "workspace_id": workspace,
                "tab_id": tab,
                "focused": true,
                "foreground_cwd": cwd,
            ]],
        ],
    ]
}

private func runWindowProofChecks(_ suite: TestSuite) throws {
    let source = SourceWindowIdentity(processId: 10, windowNumber: 20)
    let other = SourceWindowIdentity(processId: 10, windowNumber: 21)
    let marker = "trxg-0123456789ab"
    let proofHerdr = HerdrStub([
        ["type": "client_window_title", "changed": true, "reason": "set"],
        ["type": "client_window_title", "changed": true, "reason": "cleared"],
    ])
    let tracker = DeferredWindowMarkerTracker()
    let identity = try ForegroundClientProof(
        herdr: proofHerdr,
        windowReader: WindowStub([
            .init(identity: source, title: "original"),
            .init(identity: source, title: marker),
            .init(identity: source, title: marker),
        ]),
        tracker: tracker,
        marker: { marker }
    ).prove()
    try suite.check(identity == source, "captured source window identity")
    try suite.check(
        proofHerdr.calls.map(\.0) == [
            "client.window_title.set",
            "client.window_title.clear",
        ],
        "active Kitty foreground proof"
    )

    let failedProofHerdr = HerdrStub([
        ["type": "client_window_title", "changed": true, "reason": "set"],
    ])
    let deferredTracker = DeferredWindowMarkerTracker()
    try suite.rejects("window marker mismatch fails closed") {
        _ = try ForegroundClientProof(
            herdr: failedProofHerdr,
            windowReader: WindowStub([
                .init(identity: source, title: "original"),
                .init(identity: other, title: marker),
                .init(identity: other, title: marker),
            ]),
            tracker: deferredTracker,
            marker: { marker },
            renderTimeout: 0.3
        ).prove()
    }

    try suite.check(
        failedProofHerdr.calls.map(\.0) == ["client.window_title.set"],
        "window proof does not clear another client"
    )
    try suite.check(
        deferredTracker.pending == .init(identity: source, marker: marker),
        "window proof tracks deferred marker"
    )
    let deferredClearHerdr = HerdrStub([
        ["type": "client_window_title", "changed": true, "reason": "cleared"],
    ])
    let reconciled = ForegroundClientProof(
        herdr: deferredClearHerdr,
        windowReader: WindowStub([
            .init(identity: source, title: marker),
        ]),
        tracker: deferredTracker,
        marker: { marker }
    ).reconcileDeferredMarker()
    try suite.check(reconciled == .cleared, "deferred exact-window marker clear")
    try suite.check(deferredTracker.pending == nil, "deferred marker tracking cleanup")

    let delayedTracker = DeferredWindowMarkerTracker()
    let delayedHerdr = ResultHerdrStub([
        .failure(OverlayError.transportAfterSend("response lost")),
        .success(["type": "client_window_title", "changed": true, "reason": "cleared"]),
    ])
    var times = [
        Date(timeIntervalSince1970: 0),
        Date(timeIntervalSince1970: 0.1),
    ]
    try suite.rejects("post-send title response loss") {
        _ = try ForegroundClientProof(
            herdr: delayedHerdr,
            windowReader: WindowStub([
                .init(identity: source, title: "original"),
                .init(identity: source, title: "original"),
                .init(identity: source, title: marker),
                .init(identity: source, title: marker),
            ]),
            tracker: delayedTracker,
            now: { times.removeFirst() },
            sleep: { _ in },
            marker: { marker },
            renderTimeout: 0.3
        ).prove()
    }
    try suite.check(
        delayedHerdr.calls == [
            "client.window_title.set",
            "client.window_title.clear",
        ],
        "delayed post-send marker safely cleared"
    )
    try suite.check(delayedTracker.pending == nil, "delayed marker tracking resolved")
}

private func runContextRaceChecks(_ suite: TestSuite) throws {
    let window = SourceWindowIdentity(processId: 1, windowNumber: 2)
    let stable = try StableHerdrContextResolver(
        herdr: HerdrStub([
            snapshotResult(pane: "w1:p1"),
            snapshotResult(pane: "w1:p1"),
        ]),
        windowProof: IdentityProofStub(window)
    ).resolve()
    try suite.check(stable.source.paneId == "w1:p1", "stable pre/post proof pane")

    let changed = StableHerdrContextResolver(
        herdr: HerdrStub([
            snapshotResult(pane: "w1:p1"),
            snapshotResult(pane: "w1:p2"),
        ]),
        windowProof: IdentityProofStub(window)
    )
    try suite.rejects("pane change across active proof") {
        _ = try changed.resolve()
    }
    try suite.check(
        !SelectionResolutionValidity.canCommit(
            startedGeneration: 4,
            currentGeneration: 5,
            mouseUpWindow: window,
            provenWindow: window
        ),
        "intervening input generation invalidation"
    )
}

private func runInputAndProcessChecks(_ suite: TestSuite) throws {
    let demoPolicy = OverlayLaunchPolicy(arguments: ["overlay", "--demo"])
    try suite.check(
        !demoPolicy.usesRealServices
            && !demoPolicy.permitsCaptureMonitoring
            && !demoPolicy.permitsClipboardAccess
            && !demoPolicy.permitsRequestStorage
            && !demoPolicy.permitsQueueActions,
        "demo launch isolates all real services"
    )
    let servicePolicy = OverlayLaunchPolicy(arguments: ["overlay"])
    try suite.check(
        !CaptureMonitoringEligibility.shouldStart(
            launchPolicy: servicePolicy,
            captureEnabled: true,
            startupReady: true,
            actionUnresolved: false,
            permissionsGranted: true,
            contextAvailable: false
        ),
        "capture monitoring requires configured context"
    )

    let loading = ActionStateTransition.start(.add, from: .actions)
    try suite.check(loading == .loading(.add), "action loading transition")
    try suite.check(
        ActionStateTransition.finish(.added(queueCount: 1), from: loading) == .success("Added"),
        "action success transition"
    )
    try suite.check(
        ActionStateTransition.finish(
            .unknown(requestId: "id", logId: "log"),
            from: loading
        ) == .success("Status unknown; will reconcile"),
        "action unknown transition"
    )
    try suite.check(
        ActionStateTransition.fail(from: loading) == .error("Could not add — Esc"),
        "action failure transition"
    )

    var inputPolicy = PanelInputPolicy()
    try suite.check(
        inputPolicy.decide(
            event: .down,
            keyCode: 0,
            unmodified: true,
            phase: .actions
        ) == .suppress(.add),
        "action key suppression"
    )
    try suite.check(
        inputPolicy.decide(
            event: .up,
            keyCode: 0,
            unmodified: true,
            phase: .loading
        ) == .suppress(nil),
        "matching action keyup suppression"
    )
    try suite.check(
        inputPolicy.decide(
            event: .down,
            keyCode: 11,
            unmodified: true,
            phase: .loading
        ) == .passThrough,
        "loading unrelated key passthrough"
    )

    let expectedWindow = SourceWindowIdentity(processId: 12, windowNumber: 34)
    try suite.check(
        PanelSourceFocus.isValid(
            expected: expectedWindow,
            current: expectedWindow,
            kittyIsFrontmost: true
        ),
        "source window focus retained"
    )
    try suite.check(
        !PanelSourceFocus.isValid(
            expected: expectedWindow,
            current: SourceWindowIdentity(processId: 12, windowNumber: 35),
            kittyIsFrontmost: true
        ),
        "source window loss dismissal"
    )

    let bounded = try BoundedProcessRunner().run(
        executable: "/usr/bin/yes",
        arguments: [],
        timeout: 0.05,
        maximumOutputBytes: 1024
    )
    try suite.check(
        bounded.timedOut && bounded.outputTruncated && bounded.stdout.count == 1024,
        "bounded process output and timeout"
    )
    let statusData = Data("""
    {"server":{"running":true,"compatible":true,"socket":"/local/herdr.sock"}}
    """.utf8)
    let processStub = ProcessStub(result: BoundedProcessResult(
        status: 0,
        stdout: statusData,
        stderr: Data(),
        timedOut: false,
        outputTruncated: false
    ))
    let discovered = try HerdrStatusCommand(
        runner: processStub,
        socketValidator: { $0 == "/local/herdr.sock" }
    ).socketPath(configuration: HerdrStatusConfiguration(
        binary: "/opt/herdr",
        session: "work"
    ))
    try suite.check(discovered == "/local/herdr.sock", "injectable status socket discovery")
    try suite.check(
        processStub.invocation?.1 == ["--session", "work", "status", "--json"]
            && processStub.invocation?.2 == 2
            && processStub.invocation?.3 == 256 * 1024,
        "bounded status runner arguments"
    )

    var sockets = [Int32](repeating: -1, count: 2)
    try suite.check(
        socketpair(AF_UNIX, SOCK_STREAM, 0, &sockets) == 0,
        "Unix socket pair"
    )
    defer {
        if sockets[0] >= 0 { close(sockets[0]) }
        if sockets[1] >= 0 { close(sockets[1]) }
    }
    try HerdrSocketClient.UnixSocketSafety.configureNoSigPipe(sockets[0])
    close(sockets[1])
    sockets[1] = -1
    try suite.rejects("peer-close socket write error without SIGPIPE") {
        try HerdrSocketClient.UnixSocketSafety.writeAll(
            Data("request\n".utf8),
            to: sockets[0]
        )
    }
}

private func runTransportRecoveryChecks(
    _ suite: TestSuite,
    source: SourceContext,
    capture: CapturedSelection
) throws {
    let requestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    let fixedId = UUID(uuidString: requestId)!

    let definiteStore = StoreStub()
    let definitePending = MemoryPendingActionStore()
    let definiteRunner = OverlayActionRunner(
        herdr: ResultHerdrStub([
            .failure(OverlayError.transportBeforeSend("connect failed")),
        ]),
        contextProvider: ContextStub(source),
        requestStore: definiteStore,
        pendingStore: definitePending,
        uuid: { fixedId }
    )
    try suite.rejects("definite pre-send invoke failure") {
        _ = try definiteRunner.run(action: .add, selection: capture)
    }
    try suite.check(
        definiteStore.removed && definitePending.record == nil,
        "definite pre-send cleanup"
    )

    let unknownStore = StoreStub()
    let unknownPending = MemoryPendingActionStore()
    let unknownRunner = OverlayActionRunner(
        herdr: ResultHerdrStub([
            .failure(OverlayError.transportAfterSend("response lost")),
        ]),
        contextProvider: ContextStub(source),
        requestStore: unknownStore,
        pendingStore: unknownPending,
        uuid: { fixedId }
    )
    try suite.check(
        try unknownRunner.run(action: .add, selection: capture)
            == .unknown(requestId: requestId, logId: nil),
        "post-write invoke failure is unknown"
    )
    try suite.check(
        !unknownStore.removed && unknownPending.record?.requestId == requestId,
        "unknown invoke state persists"
    )
    try suite.check(
        try UnresolvedActionRecovery(
            requestStore: unknownStore,
            pendingStore: unknownPending
        ).resumeAfterQueueCheck(),
        "explicit queue-checked recovery"
    )
    try suite.check(
        unknownStore.removedRequestId == requestId && unknownPending.record == nil,
        "explicit recovery clears pending state"
    )

    let failedLogStore = StoreStub()
    let failedLogPending = MemoryPendingActionStore()
    let failedLogRunner = OverlayActionRunner(
        herdr: HerdrStub([[
            "type": "plugin_action_invoked",
            "log": [
                "log_id": "plugin-log-no-safe-result",
                "status": "failed",
                "error": "action failed",
            ],
        ]]),
        contextProvider: ContextStub(source),
        requestStore: failedLogStore,
        pendingStore: failedLogPending,
        uuid: { fixedId }
    )
    try suite.check(
        try failedLogRunner.run(action: .add, selection: capture)
            == .unknown(requestId: requestId, logId: "plugin-log-no-safe-result"),
        "failed terminal log without safe result is unresolved"
    )
    try suite.check(
        !failedLogStore.removed && failedLogPending.record?.logId == "plugin-log-no-safe-result",
        "unproven failed log retains pending state"
    )
}

private func runTests() throws -> Int {
    let suite = TestSuite()
    let kitty = "net.kovidgoyal.kitty"
    let sourceWindow = SourceWindowIdentity(processId: 1, windowNumber: 2)

    var detector = SelectionDetector()
    _ = detector.receive(.mouseDown(
        point: CGPoint(x: 10, y: 10),
        time: 1,
        bundleId: kitty,
        pasteboardChangeCount: 1
    ))
    try suite.check(!detector.isAwaitingPasteboardUpdate, "mouse-down does not request pasteboard text")
    _ = detector.receive(.mouseDragged(
        point: CGPoint(x: 20, y: 20),
        time: 1.05,
        bundleId: kitty
    ))
    try suite.check(detector.isAwaitingPasteboardUpdate, "threshold drag requests pasteboard text")
    _ = detector.receive(.pasteboardChanged(changeCount: 2, text: "selected", time: 1.1))
    let duringDrag = detector.receive(.mouseUp(
        point: CGPoint(x: 30, y: 25),
        time: 1.2,
        bundleId: kitty,
        windowIdentity: sourceWindow
    ))
    try suite.check(duringDrag?.text == "selected", "pasteboard update during drag")
    try suite.check(
        duringDrag?.globalBounds == CGRect(x: 10, y: 10, width: 20, height: 15),
        "drag bounds"
    )
    try suite.check(
        duringDrag?.sourceWindowIdentity == sourceWindow,
        "mouse-up source window identity"
    )

    detector = SelectionDetector()
    _ = detector.receive(.mouseDown(
        point: .zero,
        time: 2,
        bundleId: kitty,
        pasteboardChangeCount: 2
    ))
    _ = detector.receive(.mouseUp(
        point: CGPoint(x: 20, y: 0),
        time: 2.1,
        bundleId: kitty,
        windowIdentity: sourceWindow
    ))
    try suite.check(
        detector.receive(.pasteboardChanged(
            changeCount: 3,
            text: "after",
            time: 2.3
        ))?.text == "after",
        "pasteboard update after mouse up"
    )

    detector = SelectionDetector()
    _ = detector.receive(.mouseDown(
        point: .zero,
        time: 3,
        bundleId: kitty,
        pasteboardChangeCount: 3
    ))
    _ = detector.receive(.pasteboardChanged(changeCount: 4, text: "small", time: 3.1))
    try suite.check(
        detector.receive(.mouseUp(
            point: CGPoint(x: 2, y: 2),
            time: 3.2,
            bundleId: kitty,
            windowIdentity: sourceWindow
        )) == nil,
        "small drag rejection"
    )

    try suite.check(
        try SelectionTextValidator.validate("one\ntwo\tthree").get() == "one\ntwo\tthree",
        "valid selection text"
    )
    try suite.rejects("control character rejection") {
        _ = try SelectionTextValidator.validate("bad\u{0000}").get()
    }
    try suite.rejects("Unicode scalar limit") {
        _ = try SelectionTextValidator.validate(String(repeating: "界", count: 60_001)).get()
    }

    var pending = PendingSelectionStore()
    let first = SelectionCandidate(
        text: "first",
        globalBounds: .zero,
        pasteboardChangeCount: 1,
        completedAt: 1,
        sourceWindowIdentity: sourceWindow
    )
    let second = SelectionCandidate(
        text: "second",
        globalBounds: .zero,
        pasteboardChangeCount: 2,
        completedAt: 2,
        sourceWindowIdentity: sourceWindow
    )
    _ = pending.replace(with: first)
    try suite.check(pending.replace(with: second) == first, "pending capture replacement")

    let main = CGRect(x: 0, y: 0, width: 1200, height: 800)
    let left = CGRect(x: -1000, y: 0, width: 1000, height: 700)
    try suite.check(
        PanelPlacement.frame(
            selection: CGRect(x: 500, y: 300, width: 100, height: 20),
            panelSize: CGSize(width: 300, height: 56),
            visibleFrames: [main]
        ) == CGRect(x: 400, y: 328, width: 300, height: 56),
        "panel placement above"
    )
    try suite.check(
        PanelPlacement.frame(
            selection: CGRect(x: 5, y: 760, width: 30, height: 20),
            panelSize: CGSize(width: 300, height: 56),
            visibleFrames: [main]
        ) == CGRect(x: 0, y: 696, width: 300, height: 56),
        "panel flip and clamp"
    )
    try suite.check(
        PanelPlacement.frame(
            selection: CGRect(x: -950, y: 100, width: 40, height: 20),
            panelSize: CGSize(width: 300, height: 56),
            visibleFrames: [main, left]
        ) == CGRect(x: -1000, y: 128, width: 300, height: 56),
        "multi-display placement"
    )

    let envelope = try HerdrEnvelope.makeRequest(
        id: "request-1",
        method: "session.snapshot",
        params: [:]
    )
    try suite.check(envelope.last == 0x0A, "newline-delimited socket request")
    let response = Data(#"{"id":"request-1","result":{"type":"ok"}}"#.utf8)
    try suite.check(
        try HerdrEnvelope.parseResponse(data: response, expectedId: "request-1")["type"]
            as? String == "ok",
        "socket response envelope"
    )
    try suite.rejects("socket response ID rejection") {
        _ = try HerdrEnvelope.parseResponse(data: response, expectedId: "wrong")
    }

    let snapshot: [String: Any] = [
        "type": "session_snapshot",
        "snapshot": [
            "focused_workspace_id": "w1",
            "focused_tab_id": "w1:t1",
            "focused_pane_id": "w1:p1",
            "workspaces": [[
                "workspace_id": "w1",
                "active_tab_id": "w1:t1",
                "focused": true,
            ]],
            "tabs": [[
                "tab_id": "w1:t1",
                "workspace_id": "w1",
                "focused": true,
            ]],
            "panes": [[
                "pane_id": "w1:p1",
                "workspace_id": "w1",
                "tab_id": "w1:t1",
                "focused": true,
                "foreground_cwd": "/repo",
                "agent": "copilot",
                "terminal_title_stripped": "Review code",
            ]],
        ],
    ]
    let source = try HerdrResponseParser.sourceContext(from: snapshot)
    try suite.check(source.cwd == "/repo" && source.paneId == "w1:p1", "focused Herdr context")
    try runWindowProofChecks(suite)
    try runContextRaceChecks(suite)

    let stdout = """
    {"schemaVersion":1,"requestId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","queued":true,"opened":false,"queueCount":4}
    """
    let safe = try HerdrResponseParser.safeActionResult(
        stdout: stdout,
        requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    )
    try suite.check(safe.queued && safe.queueCount == 4, "safe plugin stdout")
    try suite.rejects("strict plugin stdout keys") {
        _ = try HerdrResponseParser.safeActionResult(
            stdout: """
            {"schemaVersion":1,"requestId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","queued":true,"opened":false,"queueCount":4,"extra":true}
            """,
            requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        )
    }

    let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
        .appendingPathComponent(".build/test-runner-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: root) }
    let privateStore = PrivateRequestStore(applicationSupportDirectory: root)
    let request = OverlayRequest(
        requestId: "11111111-1111-4111-8111-111111111111",
        selection: "private",
        capturedAt: "2026-08-31T12:00:00.000Z",
        source: source
    )
    let requestURL = try privateStore.write(request)
    var fileStatus = stat()
    _ = lstat(requestURL.path, &fileStatus)
    try suite.check((fileStatus.st_mode & 0o777) == 0o600, "private request mode")
    let decoded = try JSONDecoder().decode(OverlayRequest.self, from: Data(contentsOf: requestURL))
    try suite.check(decoded == request, "request JSON encoding")
    let stalePartial = requestURL.deletingLastPathComponent().appendingPathComponent(
        ".22222222-2222-4222-8222-222222222222.33333333-3333-4333-8333-333333333333.partial"
    )
    try Data("partial".utf8).write(to: stalePartial)
    chmod(stalePartial.path, 0o600)
    try FileManager.default.setAttributes(
        [.modificationDate: Date(timeIntervalSinceNow: -(48 * 60 * 60))],
        ofItemAtPath: stalePartial.path
    )
    try privateStore.cleanupStale(now: Date(), maximumAge: 24 * 60 * 60)
    try suite.check(
        !FileManager.default.fileExists(atPath: stalePartial.path),
        "validated stale partial cleanup"
    )
    let unsafeStale = requestURL.deletingLastPathComponent().appendingPathComponent(
        "55555555-5555-4555-8555-555555555555.json"
    )
    try Data("unsafe".utf8).write(to: unsafeStale)
    chmod(unsafeStale.path, 0o644)
    try FileManager.default.setAttributes(
        [.modificationDate: Date(timeIntervalSinceNow: -(48 * 60 * 60))],
        ofItemAtPath: unsafeStale.path
    )
    try privateStore.cleanupStale(now: Date(), maximumAge: 24 * 60 * 60)
    try suite.check(
        FileManager.default.fileExists(atPath: unsafeStale.path),
        "unsafe stale request is not deleted"
    )
    let privatePending = PrivatePendingActionStore(applicationSupportDirectory: root)
    let persistedPending = PendingActionRecord(
        requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        logId: "plugin-log-persisted",
        action: "add",
        createdAt: "2026-08-31T14:00:00Z"
    )
    try privatePending.save(persistedPending)
    try suite.check(try privatePending.load() == persistedPending, "private pending identity")
    privatePending.clear()

    let actionHerdr = HerdrStub([
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
    let actionStore = StoreStub()
    let runner = OverlayActionRunner(
        herdr: actionHerdr,
        contextProvider: ContextStub(source),
        requestStore: actionStore,
        sleep: { _ in },
        uuid: { UUID(uuidString: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA")! }
    )
    let capture = CapturedSelection(
        text: "selected text",
        globalBounds: .zero,
        pasteboardChangeCount: 1,
        capturedAt: Date(),
        source: source
    )
    try suite.check(
        try runner.run(action: .addAndOpen, selection: capture)
            == .addedButNotOpened(queueCount: 4),
        "partial action success"
    )
    let context = actionHerdr.calls.first?.1["context"] as? [String: Any]
    try suite.check(
        context?["selected_text"] as? String
            == "trellage-guide-overlay-request:v1:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "opaque request token"
    )
    try suite.check(actionHerdr.calls.count == 2, "exact log polling without action retry")

    let failedPartialHerdr = HerdrStub([[
        "type": "plugin_action_invoked",
        "log": [
            "log_id": "plugin-log-partial",
            "status": "failed",
            "stdout": stdout,
            "error": "queue editor did not open",
        ],
    ]])
    let failedPartialRunner = OverlayActionRunner(
        herdr: failedPartialHerdr,
        contextProvider: ContextStub(source),
        requestStore: StoreStub(),
        uuid: { UUID(uuidString: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA")! }
    )
    try suite.check(
        try failedPartialRunner.run(action: .addAndOpen, selection: capture)
            == .addedButNotOpened(queueCount: 4),
        "failed log partial action success"
    )
    try suite.check(failedPartialHerdr.calls.count == 1, "partial success has no add retry")

    let timeoutStore = StoreStub()
    let timeoutPending = MemoryPendingActionStore()
    var timeoutDates = [
        Date(timeIntervalSince1970: 0),
        Date(timeIntervalSince1970: OverlayLimits.actionTimeout + 1),
    ]
    let timeoutRunner = OverlayActionRunner(
        herdr: HerdrStub([[
            "type": "plugin_action_invoked",
            "log": ["log_id": "plugin-log-timeout", "status": "running"],
        ]]),
        contextProvider: ContextStub(source),
        requestStore: timeoutStore,
        pendingStore: timeoutPending,
        now: { timeoutDates.removeFirst() },
        sleep: { _ in }
    )
    let unknown = try timeoutRunner.run(action: .add, selection: capture)
    try suite.check(
        unknown == .unknown(
            requestId: timeoutPending.record?.requestId ?? "",
            logId: "plugin-log-timeout"
        ),
        "action timeout has unknown status"
    )
    try suite.check(!timeoutStore.removed, "unknown action keeps request for reconciliation")
    try suite.check(timeoutPending.record?.logId == "plugin-log-timeout", "pending log identity")
    let reconcilePending = MemoryPendingActionStore(record: PendingActionRecord(
        requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        logId: "plugin-log-reconcile",
        action: "add",
        createdAt: "2026-08-31T14:00:00Z"
    ))
    let reconcileStore = StoreStub()
    let reconcileResult = try OverlayActionReconciler(
        herdr: HerdrStub([[
            "type": "plugin_log_list",
            "logs": [[
                "log_id": "plugin-log-reconcile",
                "status": "succeeded",
                "stdout": stdout,
            ]],
        ]]),
        requestStore: reconcileStore,
        pendingStore: reconcilePending
    ).reconcile()
    try suite.check(
        reconcileResult == .resolved(.added(queueCount: 4)),
        "exact pending log reconciliation"
    )
    try suite.check(reconcilePending.record == nil, "resolved pending identity cleanup")
    try runTransportRecoveryChecks(suite, source: source, capture: capture)

    let changed = SourceContext(
        workspaceId: "w2",
        tabId: "w2:t1",
        paneId: "w2:p1",
        cwd: "/other"
    )
    let unwritten = StoreStub()
    let changedRunner = OverlayActionRunner(
        herdr: HerdrStub([]),
        contextProvider: ContextStub(changed),
        requestStore: unwritten
    )
    try suite.rejects("context stability") {
        _ = try changedRunner.run(action: .add, selection: capture)
    }
    try suite.check(unwritten.written == nil, "context failure before request write")

    try runInputAndProcessChecks(suite)
    return suite.count
}

do {
    let count = try runTests()
    print("OverlayCoreTestRunner: \(count) checks passed")
    if let socket = ProcessInfo.processInfo.environment["HERDR_SOCKET_PATH"] {
        let result = try HerdrSocketClient(socketPath: socket).request(
            method: "session.snapshot",
            params: [:]
        )
        _ = try HerdrResponseParser.sourceContext(from: result)
        print("OverlayCoreTestRunner: live Herdr socket probe passed")
    }
} catch {
    FileHandle.standardError.write(Data("OverlayCoreTestRunner failed: \(error)\n".utf8))
    exit(1)
}
