import Testing
@testable import OverlayCore

@Suite struct LaunchModePolicyTests {
    @Test func demoDisablesEveryRealIntegrationSurface() {
        let policy = OverlayLaunchPolicy(arguments: ["TRXGuideOverlayApp", "--demo"])
        #expect(policy.mode == .demo)
        #expect(!policy.usesRealServices)
        #expect(!policy.permitsCaptureMonitoring)
        #expect(!policy.permitsClipboardAccess)
        #expect(!policy.permitsRequestStorage)
        #expect(!policy.permitsQueueActions)
    }

    @Test func normalLaunchEnablesServicePolicy() {
        let policy = OverlayLaunchPolicy(arguments: ["TRXGuideOverlayApp"])
        #expect(policy.mode == .service)
        #expect(policy.usesRealServices)
        #expect(policy.permitsCaptureMonitoring)
        #expect(policy.permitsClipboardAccess)
        #expect(policy.permitsRequestStorage)
        #expect(policy.permitsQueueActions)
    }

    @Test func monitoringRequiresUsableContext() {
        let policy = OverlayLaunchPolicy(arguments: ["TRXGuideOverlayApp"])
        #expect(!CaptureMonitoringEligibility.shouldStart(
            launchPolicy: policy,
            captureEnabled: true,
            startupReady: true,
            actionUnresolved: false,
            permissionsGranted: true,
            contextAvailable: false
        ))
        #expect(CaptureMonitoringEligibility.shouldStart(
            launchPolicy: policy,
            captureEnabled: true,
            startupReady: true,
            actionUnresolved: false,
            permissionsGranted: true,
            contextAvailable: true
        ))
    }
}
