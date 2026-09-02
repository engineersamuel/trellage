import CoreGraphics
import Testing
@testable import OverlayCore

@Suite struct SelectionDetectorTests {
    private let kitty = "net.kovidgoyal.kitty"
    private let window = SourceWindowIdentity(processId: 1, windowNumber: 2)

    @Test func pasteboardChangeDuringDragCompletesOnMouseUp() {
        var detector = SelectionDetector()
        #expect(detector.receive(.mouseDown(
            point: CGPoint(x: 10, y: 20),
            time: 1,
            bundleId: kitty,
            pasteboardChangeCount: 4
        )) == nil)
        #expect(detector.receive(.mouseDragged(
            point: CGPoint(x: 40, y: 50),
            time: 1.1,
            bundleId: kitty
        )) == nil)
        #expect(detector.receive(.pasteboardChanged(
            changeCount: 5,
            text: "selected",
            time: 1.2
        )) == nil)
        let candidate = detector.receive(.mouseUp(
            point: CGPoint(x: 42, y: 52),
            time: 1.25,
            bundleId: kitty,
            windowIdentity: window
        ))
        #expect(candidate?.text == "selected")
        #expect(candidate?.globalBounds == CGRect(x: 10, y: 20, width: 32, height: 32))
        #expect(candidate?.sourceWindowIdentity == window)
    }

    @Test func pasteboardChangeShortlyAfterMouseUpIsAccepted() {
        var detector = SelectionDetector()
        _ = detector.receive(.mouseDown(
            point: .zero,
            time: 1,
            bundleId: kitty,
            pasteboardChangeCount: 8
        ))
        #expect(detector.receive(.mouseUp(
            point: CGPoint(x: 20, y: 0),
            time: 1.1,
            bundleId: kitty,
            windowIdentity: window
        )) == nil)
        #expect(detector.receive(.pasteboardChanged(
            changeCount: 9,
            text: "later",
            time: 1.3
        ))?.text == "later")
    }

    @Test func rejectsSmallDragStalePasteboardAndApplicationChange() {
        var detector = SelectionDetector()
        _ = detector.receive(.mouseDown(
            point: .zero,
            time: 1,
            bundleId: kitty,
            pasteboardChangeCount: 3
        ))
        _ = detector.receive(.pasteboardChanged(changeCount: 3, text: "stale", time: 1.1))
        #expect(detector.receive(.mouseUp(
            point: CGPoint(x: 2, y: 2),
            time: 1.2,
            bundleId: kitty,
            windowIdentity: window
        )) == nil)

        _ = detector.receive(.mouseDown(
            point: .zero,
            time: 2,
            bundleId: kitty,
            pasteboardChangeCount: 3
        ))
        _ = detector.receive(.mouseDragged(
            point: CGPoint(x: 20, y: 0),
            time: 2.1,
            bundleId: "com.apple.Terminal"
        ))
        _ = detector.receive(.pasteboardChanged(changeCount: 4, text: "wrong app", time: 2.2))
        #expect(detector.receive(.mouseUp(
            point: CGPoint(x: 20, y: 0),
            time: 2.3,
            bundleId: kitty,
            windowIdentity: window
        )) == nil)
    }

    @Test func rejectsLatePasteboardChange() {
        var detector = SelectionDetector()
        _ = detector.receive(.mouseDown(
            point: .zero,
            time: 1,
            bundleId: kitty,
            pasteboardChangeCount: 1
        ))
        _ = detector.receive(.mouseUp(
            point: CGPoint(x: 20, y: 0),
            time: 1.1,
            bundleId: kitty,
            windowIdentity: window
        ))
        #expect(detector.receive(.pasteboardChanged(
            changeCount: 2,
            text: "late",
            time: 1.5
        )) == nil)
    }

    @Test func requiresMouseUpWindowIdentityAndExposesPasteboardDemand() {
        var detector = SelectionDetector()
        _ = detector.receive(.mouseDown(
            point: .zero,
            time: 1,
            bundleId: kitty,
            pasteboardChangeCount: 1
        ))
        #expect(!detector.isAwaitingPasteboardUpdate)
        _ = detector.receive(.mouseDragged(
            point: CGPoint(x: 10, y: 0),
            time: 1.05,
            bundleId: kitty
        ))
        #expect(detector.isAwaitingPasteboardUpdate)
        _ = detector.receive(.pasteboardChanged(
            changeCount: 2,
            text: "selection",
            time: 1.1
        ))
        #expect(!detector.isAwaitingPasteboardUpdate)
        #expect(detector.receive(.mouseUp(
            point: CGPoint(x: 20, y: 0),
            time: 1.2,
            bundleId: kitty,
            windowIdentity: nil
        )) == nil)

        var missingIdentity = SelectionDetector()
        _ = missingIdentity.receive(.mouseDown(
            point: .zero,
            time: 2,
            bundleId: kitty,
            pasteboardChangeCount: 2
        ))
        _ = missingIdentity.receive(.mouseUp(
            point: CGPoint(x: 20, y: 0),
            time: 2.1,
            bundleId: kitty,
            windowIdentity: nil
        ))
        #expect(!missingIdentity.isAwaitingPasteboardUpdate)
    }

    @Test func newPendingSelectionReplacesOlderSelection() {
        var store = PendingSelectionStore()
        let first = SelectionCandidate(
            text: "first",
            globalBounds: .zero,
            pasteboardChangeCount: 1,
            completedAt: 1,
            sourceWindowIdentity: window
        )
        let second = SelectionCandidate(
            text: "second",
            globalBounds: .zero,
            pasteboardChangeCount: 2,
            completedAt: 2,
            sourceWindowIdentity: window
        )
        #expect(store.replace(with: first) == nil)
        #expect(store.replace(with: second) == first)
        #expect(store.pending == second)
    }

    @Test func textValidationAcceptsLineBreaksAndRejectsControlsAndLimits() throws {
        #expect(try SelectionTextValidator.validate("one\ntwo\tthree").get() == "one\ntwo\tthree")
        #expect(throws: OverlayError.self) {
            try SelectionTextValidator.validate("bad\u{0000}value").get()
        }
        #expect(throws: OverlayError.self) {
            try SelectionTextValidator.validate(" \n ").get()
        }
        _ = try SelectionTextValidator.validate(String(repeating: "界", count: 60_000)).get()
        #expect(throws: OverlayError.self) {
            try SelectionTextValidator.validate(String(repeating: "界", count: 60_001)).get()
        }
    }
}
