import AppKit
import OverlayCore

private final class PassivePanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

private final class DynamicVisualEffectView: NSVisualEffectView {
    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        layer?.borderColor = NSColor.separatorColor.withAlphaComponent(0.38).cgColor
    }
}

private final class ActionButton: NSButton {
    private var trackingAreaReference: NSTrackingArea?
    var visuallyFocused = false {
        didSet { updateAppearance() }
    }

    init(label: String, key: String) {
        super.init(frame: .zero)
        isBordered = false
        bezelStyle = .regularSquare
        wantsLayer = true
        layer?.cornerRadius = 9
        translatesAutoresizingMaskIntoConstraints = false
        heightAnchor.constraint(greaterThanOrEqualToConstant: 40).isActive = true
        setAccessibilityLabel("\(label), keyboard shortcut \(key)")

        let title = NSMutableAttributedString(
            string: "\(label)  ",
            attributes: [
                .font: NSFont.systemFont(ofSize: 13, weight: .medium),
                .foregroundColor: NSColor.labelColor,
            ]
        )
        title.append(NSAttributedString(
            string: "(\(key))",
            attributes: [
                .font: NSFont.monospacedSystemFont(ofSize: 11, weight: .medium),
                .foregroundColor: NSColor.secondaryLabelColor,
                .backgroundColor: NSColor.controlBackgroundColor.withAlphaComponent(0.65),
            ]
        ))
        attributedTitle = title
        updateAppearance()
    }

    required init?(coder: NSCoder) {
        nil
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let trackingAreaReference {
            removeTrackingArea(trackingAreaReference)
        }
        let tracking = NSTrackingArea(
            rect: bounds,
            options: [.activeAlways, .mouseEnteredAndExited, .inVisibleRect],
            owner: self
        )
        addTrackingArea(tracking)
        trackingAreaReference = tracking
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        updateAppearance()
    }

    override func mouseEntered(with event: NSEvent) {
        layer?.backgroundColor = NSColor.selectedContentBackgroundColor
            .withAlphaComponent(0.12).cgColor
    }

    override func mouseExited(with event: NSEvent) {
        updateAppearance()
    }

    override func mouseDown(with event: NSEvent) {
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.08
            animator().alphaValue = 0.72
        }
        super.mouseDown(with: event)
        alphaValue = 1
    }

    private func updateAppearance() {
        layer?.backgroundColor = visuallyFocused
            ? NSColor.selectedContentBackgroundColor.withAlphaComponent(0.10).cgColor
            : NSColor.clear.cgColor
        layer?.borderWidth = visuallyFocused ? 1 : 0
        layer?.borderColor = NSColor.keyboardFocusIndicatorColor.cgColor
    }
}

final class OverlayPanelController: NSObject {
    private let panel: NSPanel
    private let effectView: DynamicVisualEffectView
    private var contentStack: NSStackView?
    private var addButton: ActionButton?
    private var openButton: ActionButton?
    private var inputPolicy = PanelInputPolicy()
    private var actionHandler: ((OverlayAction) -> Void)?
    private(set) var state: ActionViewState = .actions

    override init() {
        panel = PassivePanel(
            contentRect: NSRect(x: 0, y: 0, width: 354, height: 56),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        effectView = DynamicVisualEffectView(frame: panel.contentView?.bounds ?? .zero)
        super.init()

        panel.level = .popUpMenu
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.hidesOnDeactivate = false
        panel.collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary, .transient]
        panel.isReleasedWhenClosed = false

        effectView.material = .popover
        effectView.blendingMode = .behindWindow
        effectView.state = .active
        effectView.wantsLayer = true
        effectView.layer?.cornerRadius = 13
        effectView.layer?.masksToBounds = true
        effectView.layer?.borderWidth = 1
        effectView.layer?.borderColor = NSColor.separatorColor.withAlphaComponent(0.38).cgColor
        effectView.autoresizingMask = [.width, .height]
        panel.contentView = effectView
        showActions()
    }

    var isVisible: Bool { panel.isVisible }

    func show(
        quartzSelectionBounds: CGRect,
        actionHandler: @escaping (OverlayAction) -> Void
    ) {
        guard let mainScreen = NSScreen.screens.first,
              let frame = PanelPlacement.frame(
                selection: PanelPlacement.appKitRect(
                    fromQuartz: quartzSelectionBounds,
                    mainDisplayHeight: mainScreen.frame.height
                ),
                panelSize: panel.frame.size,
                visibleFrames: NSScreen.screens.map(\.visibleFrame)
              )
        else {
            return
        }
        self.actionHandler = actionHandler
        showActions()
        panel.setFrame(frame, display: true)
        present()
    }

    func showAtPointer(actionHandler: @escaping (OverlayAction) -> Void) {
        let point = NSEvent.mouseLocation
        let selection = CGRect(x: point.x - 1, y: point.y - 1, width: 2, height: 2)
        guard let frame = PanelPlacement.frame(
            selection: selection,
            panelSize: panel.frame.size,
            visibleFrames: NSScreen.screens.map(\.visibleFrame)
        ) else {
            return
        }
        self.actionHandler = actionHandler
        showActions()
        panel.setFrame(frame, display: true)
        present()
    }

    func dismiss() {
        panel.orderOut(nil)
        actionHandler = nil
    }

    func contains(quartzPoint: CGPoint) -> Bool {
        guard let mainScreen = NSScreen.screens.first else { return false }
        let point = PanelPlacement.appKitPoint(
            fromQuartz: quartzPoint,
            mainDisplayHeight: mainScreen.frame.height
        )
        return panel.frame.contains(point)
    }

    func handleKey(type: CGEventType, keyCode: CGKeyCode, flags: CGEventFlags) -> Bool {
        let event: PanelKeyEvent = type == .keyDown ? .down : .up
        let modifiers: CGEventFlags = [
            .maskCommand,
            .maskControl,
            .maskAlternate,
            .maskShift,
            .maskSecondaryFn,
        ]
        let decision = inputPolicy.decide(
            event: event,
            keyCode: UInt16(keyCode),
            unmodified: flags.intersection(modifiers).isEmpty,
            phase: inputPhase
        )
        switch decision {
        case .passThrough:
            return false
        case .dismissAndPassThrough:
            dismiss()
            return false
        case .suppress(let command):
            if command == .dismiss {
                dismiss()
            } else if command == .add {
                invoke(.add)
            } else if command == .addAndOpen {
                invoke(.addAndOpen)
            }
            return true
        }
    }

    func showLoading(for action: OverlayAction) {
        state = ActionStateTransition.start(action, from: state)
        showStatus(action == .add ? "Adding…" : "Adding and opening…")
    }

    func showOutcome(_ outcome: ActionOutcome) {
        state = ActionStateTransition.finish(outcome, from: state)
        if case .success(let message) = state {
            showStatus(message)
        }
    }

    func showError() {
        state = ActionStateTransition.fail(from: state)
        if case .error(let message) = state {
            showStatus(message)
        }
    }

    private func present() {
        let reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        panel.alphaValue = reduceMotion ? 1 : 0
        effectView.layer?.setAffineTransform(
            reduceMotion ? .identity : CGAffineTransform(scaleX: 0.98, y: 0.98)
        )
        panel.orderFrontRegardless()
        guard !reduceMotion else { return }
        let scale = CABasicAnimation(keyPath: "transform.scale")
        scale.fromValue = 0.98
        scale.toValue = 1
        scale.duration = 0.12
        scale.timingFunction = CAMediaTimingFunction(name: .easeOut)
        effectView.layer?.add(scale, forKey: "overlayEntranceScale")
        effectView.layer?.setAffineTransform(.identity)
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.12
            context.timingFunction = CAMediaTimingFunction(name: .easeOut)
            panel.animator().alphaValue = 1
        }
    }

    private func showActions() {
        state = .actions
        replaceContent()
        let add = ActionButton(label: "Add", key: "a")
        let open = ActionButton(label: "Add and open queue", key: "o")
        add.target = self
        add.action = #selector(addPressed)
        open.target = self
        open.action = #selector(openPressed)
        add.widthAnchor.constraint(greaterThanOrEqualToConstant: 104).isActive = true
        open.widthAnchor.constraint(greaterThanOrEqualToConstant: 218).isActive = true
        let stack = NSStackView(views: [add, open])
        stack.orientation = .horizontal
        stack.spacing = 6
        stack.distribution = .fillProportionally
        install(stack)
        contentStack = stack
        addButton = add
        openButton = open
        addButton?.visuallyFocused = true
    }

    private func showStatus(_ message: String) {
        replaceContent()
        let label = NSTextField(labelWithString: message)
        label.font = .systemFont(ofSize: 13, weight: .medium)
        label.textColor = .labelColor
        label.alignment = .center
        label.setAccessibilityRole(.staticText)
        label.setAccessibilityLabel(message)
        install(label)
    }

    private func replaceContent() {
        effectView.subviews.forEach { $0.removeFromSuperview() }
        contentStack = nil
        addButton = nil
        openButton = nil
    }

    private func install(_ view: NSView) {
        view.translatesAutoresizingMaskIntoConstraints = false
        effectView.addSubview(view)
        NSLayoutConstraint.activate([
            view.leadingAnchor.constraint(equalTo: effectView.leadingAnchor, constant: 8),
            view.trailingAnchor.constraint(equalTo: effectView.trailingAnchor, constant: -8),
            view.topAnchor.constraint(equalTo: effectView.topAnchor, constant: 8),
            view.bottomAnchor.constraint(equalTo: effectView.bottomAnchor, constant: -8),
        ])
    }

    private func invoke(_ action: OverlayAction) {
        guard state == .actions else { return }
        actionHandler?(action)
    }

    @objc private func addPressed() {
        invoke(.add)
    }

    @objc private func openPressed() {
        invoke(.addAndOpen)
    }

    private var inputPhase: PanelInputPhase {
        guard isVisible else { return .hidden }
        switch state {
        case .actions:
            return .actions
        case .loading:
            return .loading
        case .success:
            return .status
        case .error:
            return .error
        }
    }
}
