import Foundation

public struct ForegroundWindowObservation: Equatable, Sendable {
    public let identity: SourceWindowIdentity
    public let title: String

    public init(identity: SourceWindowIdentity, title: String) {
        self.identity = identity
        self.title = title
    }
}

public protocol ForegroundWindowReading {
    func frontmostKittyWindow() throws -> ForegroundWindowObservation
}

public enum WindowMarkerLeaseKind: Equatable, Sendable {
    case acknowledged
    case indeterminate
}

public struct DeferredWindowMarker: Equatable, Sendable {
    public let identity: SourceWindowIdentity
    public let marker: String
    public let kind: WindowMarkerLeaseKind

    public init(
        identity: SourceWindowIdentity,
        marker: String,
        kind: WindowMarkerLeaseKind = .indeterminate
    ) {
        self.identity = identity
        self.marker = marker
        self.kind = kind
    }
}

public final class DeferredWindowMarkerTracker {
    private let lock = NSLock()
    private var stored: DeferredWindowMarker?

    public init() {}

    public var pending: DeferredWindowMarker? {
        lock.lock()
        defer { lock.unlock() }
        return stored
    }

    public func deferMarker(_ marker: DeferredWindowMarker) {
        lock.lock()
        stored = marker
        lock.unlock()
    }

    public func clear(ifMatching marker: DeferredWindowMarker) {
        lock.lock()
        if stored == marker {
            stored = nil
        }
        lock.unlock()
    }
}

public enum DeferredMarkerReconciliation: Equatable {
    case none
    case waiting
    case cleared
    case discarded
}

public final class ForegroundClientProof: WindowIdentityProving {
    private let herdr: HerdrRequesting
    private let windowReader: ForegroundWindowReading
    private let tracker: DeferredWindowMarkerTracker
    private let now: () -> Date
    private let sleep: (TimeInterval) -> Void
    private let marker: () -> String
    private let renderTimeout: TimeInterval

    public init(
        herdr: HerdrRequesting,
        windowReader: ForegroundWindowReading,
        tracker: DeferredWindowMarkerTracker,
        now: @escaping () -> Date = Date.init,
        sleep: @escaping (TimeInterval) -> Void = Thread.sleep,
        marker: @escaping () -> String = ForegroundClientProof.makeMarker,
        renderTimeout: TimeInterval = 0.3
    ) {
        self.herdr = herdr
        self.windowReader = windowReader
        self.tracker = tracker
        self.now = now
        self.sleep = sleep
        self.marker = marker
        self.renderTimeout = renderTimeout
    }

    public func prove() throws -> SourceWindowIdentity {
        guard tracker.pending == nil else {
            throw OverlayError.invalidContext("A prior window proof marker is unresolved")
        }
        let expectedMarker = try validatedMarker()
        let sourceWindow = try windowReader.frontmostKittyWindow()
        var proofError: Error?
        var setWasAcknowledged = false
        var unacknowledgedSetMayHaveApplied = false

        do {
            let set = try herdr.request(
                method: "client.window_title.set",
                params: ["title": expectedMarker]
            )
            try HerdrResponseParser.windowTitleChange(set, expectedReason: "set")
            setWasAcknowledged = true
            try awaitExactTitle(expectedMarker, sourceIdentity: sourceWindow.identity)
        } catch {
            proofError = error
            unacknowledgedSetMayHaveApplied = Self.setMayHaveBeenApplied(error)
        }

        if unacknowledgedSetMayHaveApplied {
            do {
                try pollUnacknowledgedSet(DeferredWindowMarker(
                    identity: sourceWindow.identity,
                    marker: expectedMarker,
                    kind: .indeterminate
                ))
            } catch {
                if proofError == nil {
                    proofError = error
                }
            }
        } else if setWasAcknowledged {
            do {
                try clearAcknowledgedLeaseIfSafe(DeferredWindowMarker(
                    identity: sourceWindow.identity,
                    marker: expectedMarker,
                    kind: .acknowledged
                ))
            } catch {
                if proofError == nil {
                    proofError = error
                }
            }
        }
        if let proofError {
            throw proofError
        }
        return sourceWindow.identity
    }

    public func reconcileDeferredMarker() -> DeferredMarkerReconciliation {
        guard let deferred = tracker.pending else {
            return .none
        }
        let current: ForegroundWindowObservation
        do {
            current = try windowReader.frontmostKittyWindow()
        } catch {
            return .waiting
        }
        guard current.identity == deferred.identity else {
            return .waiting
        }
        if deferred.kind == .indeterminate, current.title != deferred.marker {
            tracker.clear(ifMatching: deferred)
            return .discarded
        }
        do {
            let cleared = try herdr.request(
                method: "client.window_title.clear",
                params: [:]
            )
            try HerdrResponseParser.windowTitleChange(cleared, expectedReason: "cleared")
            tracker.clear(ifMatching: deferred)
            return .cleared
        } catch {
            return .waiting
        }
    }

    public static func makeMarker() -> String {
        let compact = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
        return "trxg-\(compact.prefix(12))"
    }

    private func validatedMarker() throws -> String {
        let value = marker()
        guard value.range(of: #"^trxg-[0-9a-f]{12}$"#, options: .regularExpression) != nil else {
            throw OverlayError.invalidContext("Window proof marker is invalid")
        }
        return value
    }

    private func awaitExactTitle(
        _ expectedMarker: String,
        sourceIdentity: SourceWindowIdentity
    ) throws {
        let deadline = now().addingTimeInterval(renderTimeout)
        while true {
            let current = try windowReader.frontmostKittyWindow()
            guard current.identity == sourceIdentity else {
                throw OverlayError.invalidContext("Kitty focus changed during window proof")
            }
            if current.title == expectedMarker {
                return
            }
            if now() >= deadline {
                break
            }
            sleep(0.05)
        }
        throw OverlayError.invalidContext("Kitty did not render the exact Herdr window proof")
    }

    private func clearIndeterminateMarkerIfSafe(
        _ deferred: DeferredWindowMarker
    ) throws {
        let current: ForegroundWindowObservation
        do {
            current = try windowReader.frontmostKittyWindow()
        } catch {
            tracker.deferMarker(deferred)
            return
        }
        guard current.identity == deferred.identity else {
            tracker.deferMarker(deferred)
            return
        }
        guard current.title == deferred.marker else {
            tracker.clear(ifMatching: deferred)
            return
        }
        do {
            let cleared = try herdr.request(
                method: "client.window_title.clear",
                params: [:]
            )
            try HerdrResponseParser.windowTitleChange(cleared, expectedReason: "cleared")
            tracker.clear(ifMatching: deferred)
        } catch {
            tracker.deferMarker(deferred)
            throw error
        }
    }

    private func pollUnacknowledgedSet(_ deferred: DeferredWindowMarker) throws {
        tracker.deferMarker(deferred)
        let deadline = now().addingTimeInterval(renderTimeout)
        var sourceStayedFrontmost = true
        while true {
            do {
                let current = try windowReader.frontmostKittyWindow()
                if current.identity != deferred.identity {
                    sourceStayedFrontmost = false
                } else if current.title == deferred.marker {
                    try clearIndeterminateMarkerIfSafe(deferred)
                    return
                }
            } catch {
                sourceStayedFrontmost = false
            }
            if now() >= deadline {
                break
            }
            sleep(0.05)
        }
        if sourceStayedFrontmost {
            tracker.clear(ifMatching: deferred)
        }
    }

    private func clearAcknowledgedLeaseIfSafe(
        _ deferred: DeferredWindowMarker
    ) throws {
        let current: ForegroundWindowObservation
        do {
            current = try windowReader.frontmostKittyWindow()
        } catch {
            tracker.deferMarker(deferred)
            return
        }
        guard current.identity == deferred.identity else {
            tracker.deferMarker(deferred)
            return
        }
        do {
            let cleared = try herdr.request(
                method: "client.window_title.clear",
                params: [:]
            )
            try HerdrResponseParser.windowTitleChange(cleared, expectedReason: "cleared")
            tracker.clear(ifMatching: deferred)
        } catch {
            tracker.deferMarker(deferred)
            throw error
        }
    }

    private static func setMayHaveBeenApplied(_ error: Error) -> Bool {
        guard let overlayError = error as? OverlayError else { return false }
        switch overlayError {
        case .transportAfterSend, .invalidResponse:
            return true
        default:
            return false
        }
    }
}

public extension HerdrResponseParser {
    static func windowTitleChange(
        _ result: [String: Any],
        expectedReason: String
    ) throws {
        guard result["type"] as? String == "client_window_title",
              result["changed"] as? Bool == true,
              result["reason"] as? String == expectedReason
        else {
            throw OverlayError.invalidContext("Herdr could not update its foreground client title")
        }
    }
}
