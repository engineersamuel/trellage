import AppKit
import CoreGraphics
import Foundation

final class EventTapMonitor {
    typealias MouseHandler = (CGEventType, CGPoint, String?) -> Void
    typealias KeyHandler = (CGEventType, CGKeyCode, CGEventFlags) -> Bool

    private var tap: CFMachPort?
    private var source: CFRunLoopSource?
    private let mouseHandler: MouseHandler
    private let keyHandler: KeyHandler

    init(mouseHandler: @escaping MouseHandler, keyHandler: @escaping KeyHandler) {
        self.mouseHandler = mouseHandler
        self.keyHandler = keyHandler
    }

    deinit {
        stop()
    }

    func start() -> Bool {
        stop()
        let types: [CGEventType] = [
            .leftMouseDown,
            .leftMouseDragged,
            .leftMouseUp,
            .keyDown,
            .keyUp,
        ]
        let mask = types.reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << $1.rawValue) }
        guard let tap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .defaultTap,
            eventsOfInterest: mask,
            callback: eventTapCallback,
            userInfo: Unmanaged.passUnretained(self).toOpaque()
        ) else {
            return false
        }
        let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
        self.tap = tap
        self.source = source
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        return true
    }

    func stop() {
        if let source {
            CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes)
        }
        if let tap {
            CFMachPortInvalidate(tap)
        }
        source = nil
        tap = nil
    }

    fileprivate func handle(
        type: CGEventType,
        event: CGEvent
    ) -> Unmanaged<CGEvent>? {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let tap {
                CGEvent.tapEnable(tap: tap, enable: true)
            }
            return Unmanaged.passUnretained(event)
        }

        if type == .leftMouseDown || type == .leftMouseDragged || type == .leftMouseUp {
            let bundleId = NSWorkspace.shared.frontmostApplication?.bundleIdentifier
            mouseHandler(type, event.location, bundleId)
            return Unmanaged.passUnretained(event)
        }

        if type == .keyDown || type == .keyUp {
            let keyCode = CGKeyCode(event.getIntegerValueField(.keyboardEventKeycode))
            if keyHandler(type, keyCode, event.flags) {
                return nil
            }
        }
        return Unmanaged.passUnretained(event)
    }
}

private let eventTapCallback: CGEventTapCallBack = { _, type, event, userInfo in
    guard let userInfo else {
        return Unmanaged.passUnretained(event)
    }
    let monitor = Unmanaged<EventTapMonitor>.fromOpaque(userInfo).takeUnretainedValue()
    return monitor.handle(type: type, event: event)
}
