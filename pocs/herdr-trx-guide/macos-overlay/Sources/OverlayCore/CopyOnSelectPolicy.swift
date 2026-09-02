import Foundation

public enum CopyOnSelectState: String, Equatable {
    case enabled = "Enabled"
    case disabled = "Disabled"
    case unknown = "Unknown"
}

public enum CopyOnSelectPolicy {
    public static func parse(_ content: String?) -> CopyOnSelectState {
        guard let content else { return .unknown }
        var inUI = false
        var observed: CopyOnSelectState?
        for rawLine in content.components(separatedBy: .newlines) {
            let line = rawLine.split(separator: "#", maxSplits: 1).first?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if line.hasPrefix("[") {
                inUI = line == "[ui]"
                continue
            }
            guard inUI else { continue }
            switch setting(in: line) {
            case .none:
                continue
            case .some(.invalid):
                return .unknown
            case .some(.value(let state)):
                guard observed == nil else { return .unknown }
                observed = state
            }
        }
        return observed ?? .unknown
    }

    private enum ParsedSetting {
        case value(CopyOnSelectState)
        case invalid
    }

    private static func setting(in line: String) -> ParsedSetting? {
        let parts = line.split(separator: "=", maxSplits: 1).map {
            $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        }
        guard parts.first == "copy_on_select" else { return nil }
        guard parts.count == 2 else { return .invalid }
        if parts[1] == "true" {
            return .value(.enabled)
        }
        if parts[1] == "false" {
            return .value(.disabled)
        }
        return .invalid
    }
}

public enum CapturePrivacyPolicy {
    public static func mayReadPasteboardText(
        monitoringActive: Bool,
        detectorAwaitingText: Bool,
        copyOnSelect: CopyOnSelectState
    ) -> Bool {
        monitoringActive
            && detectorAwaitingText
            && copyOnSelect == .enabled
    }
}
