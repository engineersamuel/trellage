import CoreGraphics
import Foundation

public enum SelectionDetectorInput: Equatable {
    case mouseDown(point: CGPoint, time: TimeInterval, bundleId: String?, pasteboardChangeCount: Int)
    case mouseDragged(point: CGPoint, time: TimeInterval, bundleId: String?)
    case mouseUp(
        point: CGPoint,
        time: TimeInterval,
        bundleId: String?,
        windowIdentity: SourceWindowIdentity?
    )
    case pasteboardChanged(changeCount: Int, text: String?, time: TimeInterval)
    case tick(time: TimeInterval)
    case cancel
}

public struct SelectionCandidate: Equatable {
    public let text: String
    public let globalBounds: CGRect
    public let pasteboardChangeCount: Int
    public let completedAt: TimeInterval
    public let sourceWindowIdentity: SourceWindowIdentity

    public init(
        text: String,
        globalBounds: CGRect,
        pasteboardChangeCount: Int,
        completedAt: TimeInterval,
        sourceWindowIdentity: SourceWindowIdentity
    ) {
        self.text = text
        self.globalBounds = globalBounds
        self.pasteboardChangeCount = pasteboardChangeCount
        self.completedAt = completedAt
        self.sourceWindowIdentity = sourceWindowIdentity
    }
}

public struct SelectionDetector {
    public static let kittyBundleIds: Set<String> = [
        "net.kovidgoyal.kitty",
    ]

    private struct Gesture: Equatable {
        let start: CGPoint
        var end: CGPoint
        let startedAt: TimeInterval
        let initialPasteboardCount: Int
        var validApplication: Bool
        var pasteboard: PasteboardUpdate?
        var mouseUpAt: TimeInterval?
        var mouseUpWindowIdentity: SourceWindowIdentity?
    }

    private struct PasteboardUpdate: Equatable {
        let changeCount: Int
        let text: String
        let time: TimeInterval
    }

    private var gesture: Gesture?
    public private(set) var replacementSequence = 0

    public var isAwaitingPasteboardUpdate: Bool {
        guard let gesture else { return false }
        if gesture.mouseUpAt != nil, gesture.mouseUpWindowIdentity == nil {
            return false
        }
        let distance = hypot(
            gesture.end.x - gesture.start.x,
            gesture.end.y - gesture.start.y
        )
        return gesture.validApplication
            && gesture.pasteboard == nil
            && distance >= OverlayLimits.dragThreshold
    }

    public init() {}

    public mutating func receive(_ input: SelectionDetectorInput) -> SelectionCandidate? {
        switch input {
        case .mouseDown(let point, let time, let bundleId, let pasteboardChangeCount):
            return startGesture(
                point: point,
                time: time,
                bundleId: bundleId,
                pasteboardChangeCount: pasteboardChangeCount
            )

        case .mouseDragged(let point, _, let bundleId):
            return updateGesture(point: point, bundleId: bundleId)

        case .mouseUp(let point, let time, let bundleId, let windowIdentity):
            return finishGesture(
                point: point,
                time: time,
                bundleId: bundleId,
                windowIdentity: windowIdentity
            )

        case .pasteboardChanged(let changeCount, let text, let time):
            return updatePasteboard(changeCount: changeCount, text: text, time: time)

        case .tick(let time):
            if let mouseUpAt = gesture?.mouseUpAt,
               time - mouseUpAt > OverlayLimits.pasteboardGraceInterval
            {
                gesture = nil
            }
            return nil

        case .cancel:
            gesture = nil
            return nil
        }
    }

    private mutating func startGesture(
        point: CGPoint,
        time: TimeInterval,
        bundleId: String?,
        pasteboardChangeCount: Int
    ) -> SelectionCandidate? {
        gesture = Gesture(
            start: point,
            end: point,
            startedAt: time,
            initialPasteboardCount: pasteboardChangeCount,
            validApplication: Self.kittyBundleIds.contains(bundleId ?? ""),
            pasteboard: nil,
            mouseUpAt: nil,
            mouseUpWindowIdentity: nil
        )
        return nil
    }

    private mutating func updateGesture(
        point: CGPoint,
        bundleId: String?
    ) -> SelectionCandidate? {
        guard var current = gesture, current.mouseUpAt == nil else { return nil }
        current.end = point
        current.validApplication =
            current.validApplication && Self.kittyBundleIds.contains(bundleId ?? "")
        gesture = current
        return nil
    }

    private mutating func finishGesture(
        point: CGPoint,
        time: TimeInterval,
        bundleId: String?,
        windowIdentity: SourceWindowIdentity?
    ) -> SelectionCandidate? {
        guard var current = gesture else { return nil }
        current.end = point
        current.validApplication =
            current.validApplication && Self.kittyBundleIds.contains(bundleId ?? "")
        current.mouseUpAt = time
        current.mouseUpWindowIdentity = windowIdentity
        gesture = current
        return acceptIfReady(time: time)
    }

    private mutating func updatePasteboard(
        changeCount: Int,
        text: String?,
        time: TimeInterval
    ) -> SelectionCandidate? {
        guard var current = gesture,
              changeCount > current.initialPasteboardCount,
              time >= current.startedAt,
              let text,
              case .success(let validText) = SelectionTextValidator.validate(text)
        else {
            return nil
        }
        if let mouseUpAt = current.mouseUpAt,
           time - mouseUpAt > OverlayLimits.pasteboardGraceInterval
        {
            gesture = nil
            return nil
        }
        current.pasteboard = PasteboardUpdate(
            changeCount: changeCount,
            text: validText,
            time: time
        )
        gesture = current
        return acceptIfReady(time: time)
    }

    private mutating func acceptIfReady(time: TimeInterval) -> SelectionCandidate? {
        guard let current = gesture,
              let mouseUpAt = current.mouseUpAt,
              let pasteboard = current.pasteboard,
              let sourceWindowIdentity = current.mouseUpWindowIdentity,
              current.validApplication,
              hypot(current.end.x - current.start.x, current.end.y - current.start.y)
                >= OverlayLimits.dragThreshold,
              pasteboard.time <= mouseUpAt + OverlayLimits.pasteboardGraceInterval
        else {
            return nil
        }

        gesture = nil
        replacementSequence += 1
        return SelectionCandidate(
            text: pasteboard.text,
            globalBounds: CGRect(
                x: min(current.start.x, current.end.x),
                y: min(current.start.y, current.end.y),
                width: abs(current.end.x - current.start.x),
                height: abs(current.end.y - current.start.y)
            ),
            pasteboardChangeCount: pasteboard.changeCount,
            completedAt: time,
            sourceWindowIdentity: sourceWindowIdentity
        )
    }
}

public struct PendingSelectionStore: Equatable {
    public private(set) var pending: SelectionCandidate?

    public init() {}

    @discardableResult
    public mutating func replace(with candidate: SelectionCandidate) -> SelectionCandidate? {
        let previous = pending
        pending = candidate
        return previous
    }

    public mutating func clear() {
        pending = nil
    }
}
