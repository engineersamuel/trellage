import Foundation

public enum PanelInputPhase: Equatable {
    case hidden
    case actions
    case loading
    case status
    case error
}

public enum PanelKeyEvent: Equatable {
    case down
    case up
}

public enum PanelKeyCommand: Equatable {
    case add
    case addAndOpen
    case dismiss
}

public enum PanelKeyDecision: Equatable {
    case passThrough
    case dismissAndPassThrough
    case suppress(PanelKeyCommand?)
}

public struct PanelInputPolicy {
    private var suppressedKeyUps: Set<UInt16> = []

    public init() {}

    public mutating func decide(
        event: PanelKeyEvent,
        keyCode: UInt16,
        unmodified: Bool,
        phase: PanelInputPhase
    ) -> PanelKeyDecision {
        if event == .up, suppressedKeyUps.remove(keyCode) != nil {
            return .suppress(nil)
        }

        guard event == .down else {
            return .passThrough
        }
        if suppressedKeyUps.contains(keyCode) {
            return .suppress(nil)
        }

        let command = unmodified ? command(for: keyCode, phase: phase) : nil
        if let command {
            suppressedKeyUps.insert(keyCode)
            return .suppress(command)
        }
        return phase == .actions ? .dismissAndPassThrough : .passThrough
    }

    private func command(for keyCode: UInt16, phase: PanelInputPhase) -> PanelKeyCommand? {
        if keyCode == 53, phase != .hidden {
            return .dismiss
        }
        guard phase == .actions else {
            return nil
        }
        if keyCode == 0 {
            return .add
        }
        if keyCode == 31 {
            return .addAndOpen
        }
        return nil
    }
}

public enum PanelSourceFocus {
    public static func isValid(
        expected: SourceWindowIdentity,
        current: SourceWindowIdentity?,
        kittyIsFrontmost: Bool
    ) -> Bool {
        kittyIsFrontmost && current == expected
    }
}

public enum CaptureWindowIdentityProof {
    public static func matches(
        mouseUp: SourceWindowIdentity,
        proven: SourceWindowIdentity
    ) -> Bool {
        mouseUp == proven
    }
}
