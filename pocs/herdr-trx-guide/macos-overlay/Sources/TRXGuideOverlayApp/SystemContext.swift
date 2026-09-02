import AppKit
import ApplicationServices
import Foundation
import OverlayCore

@_silgen_name("_AXUIElementGetWindow")
private func AXUIElementGetWindow(
    _ element: AXUIElement,
    _ windowId: UnsafeMutablePointer<CGWindowID>
) -> AXError

enum PermissionStatus {
    private static let accessibilitySettingsURL =
        "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
    private static let inputMonitoringSettingsURL =
        "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent"

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
        openRequiredSettings()
    }

    static func openAccessibilitySettings() {
        openSettings(accessibilitySettingsURL)
    }

    static func openInputMonitoringSettings() {
        openSettings(inputMonitoringSettingsURL)
    }

    private static func openRequiredSettings() {
        if !accessibilityGranted {
            openAccessibilitySettings()
        } else if !inputMonitoringGranted {
            openInputMonitoringSettings()
        }
    }

    private static func openSettings(_ value: String) {
        guard let url = URL(string: value) else { return }
        NSWorkspace.shared.open(url)
    }
}

enum CopyOnSelectInspection {
    static func inspect() -> CopyOnSelectState {
        let url = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".config/herdr/config.toml")
        guard let content = try? String(contentsOf: url, encoding: .utf8) else {
            return .unknown
        }
        return CopyOnSelectPolicy.parse(content)
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
        var windowId = CGWindowID(0)
        let windowError = AXUIElementGetWindow(window, &windowId)
        guard windowError == .success, windowId != 0 else {
            throw OverlayError.invalidContext("Kitty focused window identity is unavailable")
        }

        return FocusedKittyWindow(
            title: title,
            identity: SourceWindowIdentity(
                processId: application.processIdentifier,
                windowNumber: Int(windowId)
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
