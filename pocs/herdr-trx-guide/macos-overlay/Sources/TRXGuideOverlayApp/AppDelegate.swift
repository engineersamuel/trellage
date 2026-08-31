import AppKit
import Foundation
import OverlayCore

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private let panelController = OverlayPanelController()
    private let launchPolicy = OverlayLaunchPolicy(arguments: CommandLine.arguments)
    private lazy var pasteboard = NSPasteboard.general
    private lazy var requestStore = PrivateRequestStore(
        applicationSupportDirectory: ApplicationConfig.supportDirectory
    )
    private lazy var pendingStore = PrivatePendingActionStore(
        applicationSupportDirectory: ApplicationConfig.supportDirectory
    )
    private var detector = SelectionDetector()
    private var eventMonitor: EventTapMonitor?
    private var pasteboardTimer: Timer?
    private var markerTimer: Timer?
    private var observedPasteboardCount = 0
    private var captureEnabled = false
    private var captureGeneration = 0
    private var resolvingGeneration: Int?
    private var resolvingWindowIdentity: SourceWindowIdentity?
    private var currentSelection: CapturedSelection?
    private var panelWindowIdentity: SourceWindowIdentity?
    private var contextProvider: LiveContextProvider?
    private var statusDiscovery: HerdrStatusDiscovery?
    private var statusItem: NSStatusItem?
    private var statusMessage = "Starting"
    private var startupReady = false
    private var actionUnresolved = false
    private var reconciliationInProgress = false
    private var actionInProgress = false
    private var markerReconciliationInProgress = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        guard launchPolicy.usesRealServices else {
            showTestOverlay()
            return
        }
        captureEnabled =
            UserDefaults.standard.object(forKey: "captureEnabled") as? Bool ?? true
        configureService()
        configureStatusItem()
        configureMonitoring()
        NSWorkspace.shared.notificationCenter.addObserver(
            self,
            selector: #selector(frontmostApplicationChanged),
            name: NSWorkspace.didActivateApplicationNotification,
            object: nil
        )
    }

    func applicationWillTerminate(_ notification: Notification) {
        eventMonitor?.stop()
        pasteboardTimer?.invalidate()
        markerTimer?.invalidate()
        NSWorkspace.shared.notificationCenter.removeObserver(self)
    }

    func menuWillOpen(_ menu: NSMenu) {
        updateCaptureMonitoring()
        rebuildMenu(menu)
    }

    private func configureService() {
        do {
            try requestStore.cleanupStale(now: Date(), maximumAge: 24 * 60 * 60)
        } catch {
            statusMessage = "Startup cleanup failed"
            actionUnresolved = true
            return
        }
        do {
            let config = try ApplicationConfig.load()
            let discovery = HerdrStatusDiscovery(config: config)
            statusDiscovery = discovery
            contextProvider = LiveContextProvider(discovery: discovery)
            statusMessage = "Configured"
            prepareStartupState()
        } catch {
            statusMessage = "Install required"
            startupReady = true
        }
    }

    private func configureStatusItem() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        item.button?.image = NSImage(
            systemSymbolName: "text.badge.plus",
            accessibilityDescription: "TRX Guide Overlay"
        )
        item.button?.toolTip = "TRX Guide Overlay"
        let menu = NSMenu()
        menu.delegate = self
        item.menu = menu
        statusItem = item
        rebuildMenu(menu)
    }

    private func configureMonitoring() {
        eventMonitor = EventTapMonitor(
            mouseHandler: { [weak self] type, point, bundleId in
                self?.handleMouse(type: type, point: point, bundleId: bundleId)
            },
            keyHandler: { [weak self] type, keyCode, flags in
                guard let self else { return false }
                if type == .keyDown {
                    self.invalidatePendingSelectionResolution()
                }
                let wasVisible = self.panelController.isVisible
                let suppress = self.panelController.handleKey(
                    type: type,
                    keyCode: keyCode,
                    flags: flags
                )
                if wasVisible, !self.panelController.isVisible {
                    self.currentSelection = nil
                    self.panelWindowIdentity = nil
                    if !self.actionInProgress, !self.actionUnresolved {
                        DispatchQueue.main.async {
                            self.updateCaptureMonitoring()
                        }
                    }
                }
                return suppress
            }
        )
        markerTimer = Timer.scheduledTimer(
            withTimeInterval: 0.25,
            repeats: true
        ) { [weak self] _ in
            self?.reconcileDeferredWindowMarker()
        }
        updateCaptureMonitoring()
    }

    private func updateCaptureMonitoring() {
        eventMonitor?.stop()
        stopPasteboardPolling()
        guard startupReady else {
            statusMessage = "Checking pending action"
            return
        }
        guard !actionUnresolved else {
            statusMessage = "Action status unknown"
            return
        }
        guard captureEnabled else {
            statusMessage = "Capture disabled"
            return
        }
        guard contextProvider != nil else {
            statusMessage = "Install required"
            return
        }
        guard PermissionStatus.accessibilityGranted, PermissionStatus.inputMonitoringGranted else {
            statusMessage = "Permissions required"
            return
        }
        guard CaptureMonitoringEligibility.shouldStart(
            launchPolicy: launchPolicy,
            captureEnabled: captureEnabled,
            startupReady: startupReady,
            actionUnresolved: actionUnresolved,
            permissionsGranted: true,
            contextAvailable: contextProvider != nil
        ) else {
            statusMessage = "Capture unavailable"
            return
        }
        guard eventMonitor?.start() == true else {
            statusMessage = "Event tap unavailable"
            return
        }
        startPasteboardPolling()
        statusMessage = "Capture ready"
    }

    private func handleMouse(type: CGEventType, point: CGPoint, bundleId: String?) {
        let time = ProcessInfo.processInfo.systemUptime
        if type == .leftMouseDown {
            invalidatePendingSelectionResolution()
        }
        if panelController.isVisible, panelController.contains(quartzPoint: point) {
            return
        }
        if type == .leftMouseDown, panelController.isVisible,
           !panelController.contains(quartzPoint: point)
        {
            panelController.dismiss()
            currentSelection = nil
            panelWindowIdentity = nil
            if !actionInProgress, !actionUnresolved {
                DispatchQueue.main.async { [weak self] in
                    self?.updateCaptureMonitoring()
                }
            }
        }

        let candidate: SelectionCandidate?
        switch type {
        case .leftMouseDown:
            candidate = detector.receive(.mouseDown(
                point: point,
                time: time,
                bundleId: bundleId,
                pasteboardChangeCount: pasteboard.changeCount
            ))
        case .leftMouseDragged:
            candidate = detector.receive(.mouseDragged(
                point: point,
                time: time,
                bundleId: bundleId
            ))
        case .leftMouseUp:
            candidate = detector.receive(.mouseUp(
                point: point,
                time: time,
                bundleId: bundleId,
                windowIdentity: try? KittyAccessibility.focusedWindow().identity
            ))
        default:
            candidate = nil
        }
        if let candidate {
            resolve(candidate)
        }
    }

    private func pollPasteboard() {
        invalidateResolutionIfSourceChanged()
        dismissPanelIfSourceWindowWasLost()
        let time = ProcessInfo.processInfo.systemUptime
        let count = pasteboard.changeCount
        if count != observedPasteboardCount {
            observedPasteboardCount = count
            guard detector.isAwaitingPasteboardUpdate else { return }
            let candidate = detector.receive(.pasteboardChanged(
                changeCount: count,
                text: pasteboard.string(forType: .string),
                time: time
            ))
            if let candidate {
                resolve(candidate)
            }
        } else {
            _ = detector.receive(.tick(time: time))
        }
    }

    private func resolve(_ candidate: SelectionCandidate) {
        guard captureEnabled,
              startupReady,
              !actionUnresolved,
              !actionInProgress,
              let contextProvider
        else {
            return
        }
        captureGeneration += 1
        let generation = captureGeneration
        resolvingGeneration = generation
        resolvingWindowIdentity = candidate.sourceWindowIdentity
        panelController.dismiss()
        currentSelection = nil
        panelWindowIdentity = nil

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            do {
                let proven = try contextProvider.currentProvenContext()
                DispatchQueue.main.async {
                    guard let self else {
                        return
                    }
                    let valid = SelectionResolutionValidity.canCommit(
                        startedGeneration: generation,
                        currentGeneration: self.captureGeneration,
                        mouseUpWindow: candidate.sourceWindowIdentity,
                        provenWindow: proven.window
                    ) && self.pasteboard.changeCount == candidate.pasteboardChangeCount
                    guard valid else {
                        if generation == self.captureGeneration {
                            self.invalidatePendingSelectionResolution()
                        }
                        return
                    }
                    self.resolvingGeneration = nil
                    self.resolvingWindowIdentity = nil
                    let selection = CapturedSelection(
                        text: candidate.text,
                        globalBounds: candidate.globalBounds,
                        pasteboardChangeCount: candidate.pasteboardChangeCount,
                        capturedAt: Date(),
                        source: proven.source
                    )
                    self.currentSelection = selection
                    self.panelWindowIdentity = proven.window
                    self.statusMessage = "Capture ready"
                    self.panelController.show(
                        quartzSelectionBounds: candidate.globalBounds
                    ) { [weak self] action in
                        self?.submit(action)
                    }
                }
            } catch {
                DispatchQueue.main.async { [weak self] in
                    guard generation == self?.captureGeneration else { return }
                    self?.resolvingGeneration = nil
                    self?.resolvingWindowIdentity = nil
                    self?.statusMessage = "Context unavailable"
                }
            }
        }
    }

    private func submit(_ action: OverlayAction) {
        guard let selection = currentSelection,
              let contextProvider,
              !actionInProgress
        else {
            panelController.showError()
            return
        }
        actionInProgress = true
        stopPasteboardPolling()
        let generation = captureGeneration
        panelController.showLoading(for: action)

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            do {
                let runner = OverlayActionRunner(
                    herdr: contextProvider.client(),
                    contextProvider: contextProvider,
                    requestStore: self.requestStore,
                    pendingStore: self.pendingStore
                )
                let outcome = try runner.run(action: action, selection: selection)
                DispatchQueue.main.async {
                    guard generation == self.captureGeneration else { return }
                    self.panelController.showOutcome(outcome)
                    self.actionInProgress = false
                    self.currentSelection = nil
                    self.panelWindowIdentity = nil
                    if case .unknown = outcome {
                        self.actionUnresolved = true
                        self.statusMessage = "Action status unknown"
                    } else {
                        self.statusMessage = "Last action succeeded"
                    }
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.9) { [weak self] in
                        guard generation == self?.captureGeneration else { return }
                        self?.panelController.dismiss()
                        if self?.actionUnresolved == true {
                            self?.updateCaptureMonitoring()
                            self?.reconcilePendingAction()
                        } else {
                            self?.updateCaptureMonitoring()
                        }
                    }
                }
            } catch {
                DispatchQueue.main.async {
                    guard generation == self.captureGeneration else { return }
                    self.actionInProgress = false
                    self.panelController.showError()
                    self.statusMessage = "Last action failed"
                    if self.captureEnabled, !self.actionUnresolved {
                        self.startPasteboardPolling()
                    }
                }
            }
        }
    }

    private func rebuildMenu(_ menu: NSMenu) {
        menu.removeAllItems()

        let toggle = NSMenuItem(
            title: "Enable capture",
            action: #selector(toggleCapture),
            keyEquivalent: ""
        )
        toggle.target = self
        toggle.state = captureEnabled ? .on : .off
        toggle.isEnabled = startupReady && !actionUnresolved && !actionInProgress
        menu.addItem(toggle)
        menu.addItem(.separator())
        menu.addItem(diagnosticItem("Status: \(statusMessage)"))
        menu.addItem(diagnosticItem(
            "Accessibility: \(PermissionStatus.accessibilityGranted ? "Granted" : "Required")"
        ))
        menu.addItem(diagnosticItem(
            "Input Monitoring: \(PermissionStatus.inputMonitoringGranted ? "Granted" : "Required")"
        ))
        menu.addItem(diagnosticItem("Herdr copy_on_select: \(CopyOnSelectStatus.inspect().rawValue)"))
        if actionUnresolved {
            menu.addItem(diagnosticItem("Check the queue before resuming capture."))
            let retry = NSMenuItem(
                title: "Retry action reconciliation",
                action: #selector(retryReconciliation),
                keyEquivalent: ""
            )
            retry.target = self
            retry.isEnabled = !reconciliationInProgress
            menu.addItem(retry)
            let recover = NSMenuItem(
                title: "I checked the queue — resume capture",
                action: #selector(resumeAfterQueueCheck),
                keyEquivalent: ""
            )
            recover.target = self
            recover.isEnabled = !reconciliationInProgress
            menu.addItem(recover)
        }

        let permissions = NSMenuItem(
            title: "Request permissions",
            action: #selector(requestPermissions),
            keyEquivalent: ""
        )
        permissions.target = self
        menu.addItem(permissions)
        menu.addItem(.separator())

        let test = NSMenuItem(
            title: "Show test overlay",
            action: #selector(showTestOverlay),
            keyEquivalent: ""
        )
        test.target = self
        menu.addItem(test)
        menu.addItem(.separator())

        let quit = NSMenuItem(
            title: "Quit TRX Guide Overlay",
            action: #selector(quit),
            keyEquivalent: "q"
        )
        quit.target = self
        menu.addItem(quit)
    }

    private func diagnosticItem(_ title: String) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.isEnabled = false
        return item
    }

    @objc private func toggleCapture() {
        captureEnabled.toggle()
        UserDefaults.standard.set(captureEnabled, forKey: "captureEnabled")
        if !captureEnabled {
            panelController.dismiss()
            currentSelection = nil
            panelWindowIdentity = nil
        }
        updateCaptureMonitoring()
    }

    @objc private func requestPermissions() {
        PermissionStatus.request()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            self?.updateCaptureMonitoring()
        }
    }

    @objc private func showTestOverlay() {
        panelController.showAtPointer { [weak self] action in
            self?.panelController.showLoading(for: action)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { [weak self] in
                self?.panelController.showOutcome(
                    action == .add ? .added(queueCount: 1) : .addedButNotOpened(queueCount: 1)
                )
            }
        }
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }

    @objc private func frontmostApplicationChanged() {
        invalidateResolutionIfSourceChanged()
        dismissPanelIfSourceWindowWasLost()
    }

    @objc private func retryReconciliation() {
        reconcilePendingAction()
    }

    @objc private func resumeAfterQueueCheck() {
        do {
            guard try UnresolvedActionRecovery(
                requestStore: requestStore,
                pendingStore: pendingStore
            ).resumeAfterQueueCheck() else {
                statusMessage = "No pending action to recover"
                return
            }
            actionUnresolved = false
            startupReady = true
            statusMessage = "Capture resumed after queue check"
            updateCaptureMonitoring()
        } catch {
            statusMessage = "Could not recover pending action"
        }
    }

    private func dismissPanelIfSourceWindowWasLost() {
        guard panelController.isVisible, let expected = panelWindowIdentity else { return }
        let bundleId = NSWorkspace.shared.frontmostApplication?.bundleIdentifier
        let kittyIsFrontmost = SelectionDetector.kittyBundleIds.contains(bundleId ?? "")
        let current = try? KittyAccessibility.focusedWindow().identity
        guard PanelSourceFocus.isValid(
            expected: expected,
            current: current,
            kittyIsFrontmost: kittyIsFrontmost
        ) else {
            panelController.dismiss()
            currentSelection = nil
            panelWindowIdentity = nil
            statusMessage = "Source window changed"
            return
        }
    }

    private func invalidatePendingSelectionResolution() {
        guard resolvingGeneration != nil else { return }
        captureGeneration += 1
        resolvingGeneration = nil
        resolvingWindowIdentity = nil
        statusMessage = "Selection changed before proof"
    }

    private func invalidateResolutionIfSourceChanged() {
        guard let expected = resolvingWindowIdentity else { return }
        let bundleId = NSWorkspace.shared.frontmostApplication?.bundleIdentifier
        let kittyIsFrontmost = SelectionDetector.kittyBundleIds.contains(bundleId ?? "")
        let current = try? KittyAccessibility.focusedWindow().identity
        guard PanelSourceFocus.isValid(
            expected: expected,
            current: current,
            kittyIsFrontmost: kittyIsFrontmost
        ) else {
            invalidatePendingSelectionResolution()
            return
        }
    }

    private func prepareStartupState() {
            guard let contextProvider else {
                startupReady = true
                return
            }
            reconciliationInProgress = true
            DispatchQueue.global(qos: .utility).async { [weak self] in
                guard let self else { return }
                do {
                    let pending = try self.pendingStore.load()
                    if pending == nil {
                        DispatchQueue.main.async {
                            self.reconciliationInProgress = false
                            self.startupReady = true
                            self.statusMessage = "Herdr ready"
                            self.updateCaptureMonitoring()
                        }
                        return
                    }
                    let result = try OverlayActionReconciler(
                        herdr: contextProvider.client(),
                        requestStore: self.requestStore,
                        pendingStore: self.pendingStore
                    ).reconcile()
                    DispatchQueue.main.async {
                        self.applyReconciliation(result)
                    }
                } catch {
                    DispatchQueue.main.async {
                        self.reconciliationInProgress = false
                        self.actionUnresolved = true
                        self.statusMessage = "Startup state requires attention"
                        self.updateCaptureMonitoring()
                    }
                }
            }
        }

    private func reconcilePendingAction() {
            guard !reconciliationInProgress, let contextProvider else { return }
            reconciliationInProgress = true
            DispatchQueue.global(qos: .utility).async { [weak self] in
                guard let self else { return }
                let result: ActionReconciliationResult
                do {
                    result = try OverlayActionReconciler(
                        herdr: contextProvider.client(),
                        requestStore: self.requestStore,
                        pendingStore: self.pendingStore
                    ).reconcile()
                } catch {
                    result = (try? self.pendingStore.load()).map(
                        ActionReconciliationResult.unresolved
                    ) ?? .failed
                }
                DispatchQueue.main.async {
                    self.applyReconciliation(result)
                }
            }
        }

    private func applyReconciliation(_ result: ActionReconciliationResult) {
            reconciliationInProgress = false
            startupReady = true
            switch result {
            case .none:
                actionUnresolved = false
                statusMessage = "Capture ready"
            case .resolved(let outcome):
                actionUnresolved = false
                switch outcome {
                case .added:
                    statusMessage = "Previous action added"
                case .addedButNotOpened:
                    statusMessage = "Added; queue did not open"
                case .unknown:
                    actionUnresolved = true
                    statusMessage = "Action status unknown"
                }
            case .failed:
                actionUnresolved = false
                statusMessage = "Previous action failed"
            case .unresolved:
                actionUnresolved = true
                statusMessage = "Action status unknown"
            }
            updateCaptureMonitoring()
    }

    private func startPasteboardPolling() {
        guard pasteboardTimer == nil else { return }
        observedPasteboardCount = pasteboard.changeCount
        pasteboardTimer = Timer.scheduledTimer(
            withTimeInterval: 0.05,
            repeats: true
        ) { [weak self] _ in
            self?.pollPasteboard()
        }
    }

    private func stopPasteboardPolling() {
        pasteboardTimer?.invalidate()
        pasteboardTimer = nil
        _ = detector.receive(.cancel)
    }

    private func reconcileDeferredWindowMarker() {
        guard !markerReconciliationInProgress,
              let contextProvider,
              contextProvider.hasDeferredMarker
        else {
            return
        }
        markerReconciliationInProgress = true
        DispatchQueue.global(qos: .utility).async { [weak self] in
            contextProvider.reconcileDeferredMarker()
            DispatchQueue.main.async {
                self?.markerReconciliationInProgress = false
            }
        }
    }
}
