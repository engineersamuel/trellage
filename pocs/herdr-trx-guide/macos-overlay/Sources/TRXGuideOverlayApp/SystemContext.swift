import AppKit
import ApplicationServices
import Foundation
import OverlayCore

enum PermissionStatus {
    static var accessibilityGranted: Bool {
        AXIsProcessTrusted()
    }

    static var inputMonitoringGranted: Bool {
        CGPreflightListenEventAccess()
    }

    static func request() {
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        _ = AXIsProcessTrustedWithOptions(options)
        _ = CGRequestListenEventAccess()
    }
}

enum CopyOnSelectStatus: String {
    case enabled = "Enabled"
    case disabled = "Disabled"
    case unknown = "Unknown"

    static func inspect() -> CopyOnSelectStatus {
        let url = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".config/herdr/config.toml")
        guard let content = try? String(contentsOf: url, encoding: .utf8) else {
            return .enabled
        }

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
            if compact == "copy_on_select=false" {
                return .disabled
            }
            if compact == "copy_on_select=true" {
                return .enabled
            }
        }
        return .enabled
    }
}

struct FocusedKittyWindow {
    let title: String
    let identity: SourceWindowIdentity
}

enum KittyAccessibility {
    static func focusedWindow() throws -> FocusedKittyWindow {
        guard PermissionStatus.accessibilityGranted,
              let application = NSWorkspace.shared.frontmostApplication,
              let bundleId = application.bundleIdentifier,
              SelectionDetector.kittyBundleIds.contains(bundleId)
        else {
            throw OverlayError.invalidContext("Kitty is not the trusted frontmost application")
        }

        let element = AXUIElementCreateApplication(application.processIdentifier)
        var windowValue: CFTypeRef?
        guard AXUIElementCopyAttributeValue(
            element,
            kAXFocusedWindowAttribute as CFString,
            &windowValue
        ) == .success,
              let windowValue,
              CFGetTypeID(windowValue) == AXUIElementGetTypeID()
        else {
            throw OverlayError.invalidContext("Kitty focused window is unavailable")
        }

        var titleValue: CFTypeRef?
        let window = unsafeBitCast(windowValue, to: AXUIElement.self)
        guard AXUIElementCopyAttributeValue(
            window,
            kAXTitleAttribute as CFString,
            &titleValue
        ) == .success,
              let title = titleValue as? String
        else {
            throw OverlayError.invalidContext("Kitty focused window title is unavailable")
        }
        var numberValue: CFTypeRef?
        guard AXUIElementCopyAttributeValue(
            window,
            "AXWindowNumber" as CFString,
            &numberValue
        ) == .success,
              let windowNumber = numberValue as? NSNumber
        else {
            throw OverlayError.invalidContext("Kitty focused window identity is unavailable")
        }
        return FocusedKittyWindow(
            title: title,
            identity: SourceWindowIdentity(
                processId: application.processIdentifier,
                windowNumber: windowNumber.intValue
            )
        )
    }
}

private final class KittyWindowReader: ForegroundWindowReading {
    func frontmostKittyWindow() throws -> ForegroundWindowObservation {
        let window = try KittyAccessibility.focusedWindow()
        return ForegroundWindowObservation(
            identity: window.identity,
            title: window.title
        )
    }
}

private final class RediscoveringHerdrClient: HerdrRequesting {
    private let discovery: HerdrStatusDiscovery

    init(discovery: HerdrStatusDiscovery) {
        self.discovery = discovery
    }

    func request(method: String, params: [String: Any]) throws -> [String: Any] {
        try HerdrSocketClient(socketPath: discovery.socketPath()).request(
            method: method,
            params: params
        )
    }
}

final class LiveContextProvider: ContextRefreshing {
    private let discovery: HerdrStatusDiscovery
    private let markerTracker = DeferredWindowMarkerTracker()

    init(discovery: HerdrStatusDiscovery) {
        self.discovery = discovery
    }

    func currentContext() throws -> SourceContext {
        try currentProvenContext().source
    }

    func currentProvenContext() throws -> StableProvenContext {
        let socket = try discovery.socketPath()
        let client = HerdrSocketClient(socketPath: socket)
        let resolved = try StableHerdrContextResolver(
            herdr: client,
            windowProof: ForegroundClientProof(
                herdr: client,
                windowReader: KittyWindowReader(),
                tracker: markerTracker
            )
        ).resolve()
        guard try KittyAccessibility.focusedWindow().identity == resolved.window else {
            throw OverlayError.invalidContext("Kitty focus changed during Herdr context capture")
        }
        return resolved
    }

    func client() -> HerdrRequesting {
        RediscoveringHerdrClient(discovery: discovery)
    }

    func reconcileDeferredMarker() {
        _ = ForegroundClientProof(
            herdr: RediscoveringHerdrClient(discovery: discovery),
            windowReader: KittyWindowReader(),
            tracker: markerTracker
        ).reconcileDeferredMarker()
    }

    var hasDeferredMarker: Bool {
        markerTracker.pending != nil
    }
}
