// Watches the macOS fn/Globe key globally and prints "d"/"u" per press/release. Exists because
// libuiohook maps keycode 63 to VC_UNDEFINED, so no JS-side tap can ever see fn. Listen-only CGEvent
// tap: needs the same Input Monitoring grant the app already requests, never swallows anything.
import CoreGraphics
import Foundation
import IOKit.hid

// Permission is REPORTED, never inferred. A live process used to be the only evidence anyone had
// that the tap worked, and that read is simply wrong: tapCreate can hand back a port that never
// delivers an event, which is how a dead fn key looked identical to a key nobody pressed.
let isProbe = CommandLine.arguments.contains("--no-prompt")
var hidGranted = IOHIDCheckAccess(kIOHIDRequestTypeListenEvent) == kIOHIDAccessTypeGranted
// The probe stays silent (ENG-341 keeps the install flow prompt-free), but a user who is actually
// trying to dictate has earned the one prompt that can fix it. Without this the grant could only
// ever be discovered, never requested, so a denied machine stayed denied forever.
if !hidGranted && !isProbe {
    hidGranted = IOHIDRequestAccess(kIOHIDRequestTypeListenEvent)
}
print(hidGranted ? "p granted" : "p denied")
fflush(stdout)

// Without the grant the tap is DEAF, not absent: tapCreate happily returns a port that never
// delivers an event, which is exactly how a dead fn key passed for a live one. Refuse to run in
// that state so that "watcher alive" means "fn works" and nothing downstream has to guess.
if !hidGranted {
    print("e no-permission")
    fflush(stdout)
    exit(0)
}

var fnDown = false
// Proof the tap is on the wire at all. Without it, "no fn events" is ambiguous between a deaf tap
// and an untouched key, and that ambiguity is what made this unfixable from a log.
var wireAlive = false
var tapRef: CFMachPort?
var srcRef: CFRunLoopSource?

let callback: CGEventTapCallBack = { _, type, event, _ in
    if type == .flagsChanged {
        if !wireAlive {
            wireAlive = true
            print("w")
            fflush(stdout)
        }
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

let mask = (CGEventMask(1) << CGEventType.flagsChanged.rawValue)

// New tap first, old tap down after: a failed re-arm keeps the working tap instead of going deaf.
// The fnDown de-dupe above makes the brief two-tap overlap print nothing twice.
func armTap() -> Bool {
    guard let tap = CGEvent.tapCreate(
        tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly,
        eventsOfInterest: mask, callback: callback, userInfo: nil
    ) else { return false }
    let src = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
    CFRunLoopAddSource(CFRunLoopGetMain(), src, .commonModes)
    CGEvent.tapEnable(tap: tap, enable: true)
    if let old = tapRef { CGEvent.tapEnable(tap: old, enable: false); CFMachPortInvalidate(old) }
    if let oldSrc = srcRef { CFRunLoopRemoveSource(CFRunLoopGetMain(), oldSrc, .commonModes) }
    tapRef = tap
    srcRef = src
    return true
}

guard armTap() else {
    print("e tap-failed")
    fflush(stdout)
    exit(1)
}
print("t ok")
fflush(stdout)

// The parent pokes "r\n" when the app gains focus: another app's tap registered after ours sits
// AHEAD of ours (head-insert) and can eat fn before we see it, with no disable event to catch, so
// re-arming is the only way to win the key back (ENG-317). stdin EOF means the parent is gone;
// exiting then stops a crashed OpenSwarm from stranding a process holding a global keyboard tap.
DispatchQueue.global().async {
    while let line = readLine(strippingNewline: true) {
        if line == "r" {
            CFRunLoopPerformBlock(CFRunLoopGetMain(), CFRunLoopMode.commonModes.rawValue) {
                if !armTap() {
                    print("e rearm-failed")
                    fflush(stdout)
                }
            }
            CFRunLoopWakeUp(CFRunLoopGetMain())
        }
    }
    exit(0)
}

print("r")
fflush(stdout)
CFRunLoopRun()
