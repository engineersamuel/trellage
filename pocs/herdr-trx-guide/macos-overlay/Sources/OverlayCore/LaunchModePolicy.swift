import Foundation

public enum OverlayLaunchMode: Equatable {
    case service
    case demo
}

public struct OverlayLaunchPolicy: Equatable {
    public let mode: OverlayLaunchMode

    public init(arguments: [String]) {
        mode = arguments.dropFirst().contains("--demo") ? .demo : .service
    }

    public var usesRealServices: Bool {
        mode == .service
    }

    public var permitsCaptureMonitoring: Bool {
        mode == .service
    }

    public var permitsClipboardAccess: Bool {
        mode == .service
    }

    public var permitsRequestStorage: Bool {
        mode == .service
    }

    public var permitsQueueActions: Bool {
        mode == .service
    }
}

public enum CaptureMonitoringEligibility {
    public static func shouldStart(
        launchPolicy: OverlayLaunchPolicy,
        captureEnabled: Bool,
        startupReady: Bool,
        actionUnresolved: Bool,
        permissionsGranted: Bool,
        contextAvailable: Bool,
        copyOnSelectEnabled: Bool
    ) -> Bool {
        launchPolicy.permitsCaptureMonitoring
            && captureEnabled
            && startupReady
            && !actionUnresolved
            && permissionsGranted
            && contextAvailable
            && copyOnSelectEnabled
    }
}
