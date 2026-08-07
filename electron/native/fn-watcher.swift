// Watches the macOS fn/Globe key globally and prints "d"/"u" per press/release. Exists because
// libuiohook maps keycode 63 to VC_UNDEFINED, so no JS-side tap can ever see fn. Listen-only CGEvent
// tap: needs the same Input Monitoring grant the app already requests, never swallows anything.
import CoreGraphics
import Foundation

var fnDown = false

let callback: CGEventTapCallBack = { _, type, event, _ in
    if type == .flagsChanged {
        let keycode = event.getIntegerValueField(.keyboardEventKeycode)
        if keycode == 63 {
            let down = event.flags.contains(.maskSecondaryFn)
            if down != fnDown {
                fnDown = down
                print(down ? "d" : "u")
                fflush(stdout)
            }
        }
    } else if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        // macOS pauses slow taps; re-enable or fn goes silently dead until relaunch.
        if let tap = tapRef { CGEvent.tapEnable(tap: tap, enable: true) }
    }
    return Unmanaged.passUnretained(event)
}

var tapRef: CFMachPort?
let mask = (CGEventMask(1) << CGEventType.flagsChanged.rawValue)
guard let tap = CGEvent.tapCreate(
    tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly,
    eventsOfInterest: mask, callback: callback, userInfo: nil
) else {
    print("e tap-failed")
    fflush(stdout)
    exit(1)
}
tapRef = tap
let src = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
CFRunLoopAddSource(CFRunLoopGetCurrent(), src, .commonModes)
CGEvent.tapEnable(tap: tap, enable: true)
print("r")
fflush(stdout)
CFRunLoopRun()
