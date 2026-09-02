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
            contextAvailable: false,
            copyOnSelectEnabled: true
        ))
        #expect(CaptureMonitoringEligibility.shouldStart(
            launchPolicy: policy,
            captureEnabled: true,
            startupReady: true,
            actionUnresolved: false,
            permissionsGranted: true,
            contextAvailable: true,
            copyOnSelectEnabled: true
        ))
    }

    @Test func copyOnSelectMustBeExplicitlyEnabledForClipboardAccess() {
        #expect(CopyOnSelectPolicy.parse("""
        [ui]
        copy_on_select = true
        """) == .enabled)
        #expect(CopyOnSelectPolicy.parse("""
        [ui]
        copy_on_select = false
        """) == .disabled)
        #expect(CopyOnSelectPolicy.parse(nil) == .unknown)
        #expect(CopyOnSelectPolicy.parse("[ui]\n# copy_on_select = true") == .unknown)
        #expect(CopyOnSelectPolicy.parse("""
        [ui]
        copy_on_select = true
        copy_on_select = false
        """) == .unknown)
        #expect(CopyOnSelectPolicy.parse("[ui]\ncopy_on_select = maybe") == .unknown)

        #expect(!CapturePrivacyPolicy.mayReadPasteboardText(
            monitoringActive: true,
            detectorAwaitingText: true,
            copyOnSelect: .disabled
        ))
        #expect(!CapturePrivacyPolicy.mayReadPasteboardText(
            monitoringActive: true,
            detectorAwaitingText: true,
            copyOnSelect: .unknown
        ))
        #expect(CapturePrivacyPolicy.mayReadPasteboardText(
            monitoringActive: true,
            detectorAwaitingText: true,
            copyOnSelect: .enabled
        ))
        #expect(!CaptureMonitoringEligibility.shouldStart(
            launchPolicy: OverlayLaunchPolicy(arguments: ["TRXGuideOverlayApp"]),
            captureEnabled: true,
            startupReady: true,
            actionUnresolved: false,
            permissionsGranted: true,
            contextAvailable: true,
            copyOnSelectEnabled: false
        ))
    }
}
