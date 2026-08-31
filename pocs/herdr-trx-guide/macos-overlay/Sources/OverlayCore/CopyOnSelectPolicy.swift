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
        for rawLine in content.components(separatedBy: .newlines) {
            let line = rawLine.split(separator: "#", maxSplits: 1).first?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if line.hasPrefix("[") {
                inUI = line == "[ui]"
                continue
            }
            guard inUI else { continue }
            let compact = line.replacingOccurrences(of: " ", with: "").lowercased()
            if compact == "copy_on_select=true" {
                return .enabled
            }
            if compact == "copy_on_select=false" {
                return .disabled
            }
        }
        return .unknown
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
