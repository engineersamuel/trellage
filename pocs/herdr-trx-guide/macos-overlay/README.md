# TRX Guide Overlay

`TRX Guide Overlay` is a local macOS menu-bar prototype. It watches for a
completed mouse-drag selection in a local Herdr pane shown by Kitty. It then
shows two actions:

```text
Add (a)   Add and open queue (o)
```

The bundle identifier is `dev.trellage.trx-guide-overlay`. The app is an
`LSUIElement`, so it has no Dock icon.

## Requirements

- macOS 14 or newer.
- Swift command-line tools for a source build.
- Local Kitty with the official bundle identifier `net.kovidgoyal.kitty`.
- A local, compatible Herdr server.
- Herdr `[ui] copy_on_select = true`. This is the default. The overlay cannot
  infer a selection if Herdr does not copy it.
- Accessibility and Input Monitoring permission for the installed app.

Remote Herdr sessions are not supported. A remote selection does not use the
local macOS pasteboard.

## Privacy and safety

- Selection text is never logged, shown in diagnostics, put in argv, put in
  the environment, or sent in a notification.
- The app pairs a Kitty drag with a new plain-text pasteboard generation. It
  rejects small drags, stale clipboard content, unsupported control
  characters, whitespace-only text, and text over 60,000 Unicode scalars.
  Pasteboard polling is stopped whenever capture monitoring is inactive. While
  active, the app observes generation counts but reads text only when a valid
  Kitty drag has crossed the distance threshold and is waiting for a pasteboard
  update. Clicks and click-holds never request pasteboard text.
- The exact frontmost Kitty window identity is captured at mouse-up. The
  asynchronous proof must return that same identity before a capture is built.
  Any intervening mouse-down, key-down, app/window focus change, pasteboard
  generation change, or capture-generation change invalidates the candidate.
- It actively proves the configured Herdr socket owns the foreground Kitty
  client. The app sets a unique short title marker through
  `client.window_title.set`, waits briefly, requires the frontmost Kitty AX
  window title to equal that marker, and clears it only while that exact window
  remains frontmost with the exact marker. If focus changes, the marker and
  source window identity are tracked. A later clear occurs only when that
  window returns with the marker; changed titles discard the tracking without
  clearing another client. If the set request may have been sent but its
  response is lost, the app retains tracking and polls for the full bounded
  render window before it can conclude that no marker appeared. It obtains
  `session.snapshot` only after proof.
- The snapshot must contain one focused workspace, tab, pane, and absolute
  working directory. A snapshot is taken before and after the active window
  proof; workspace, tab, pane, and working directory must remain identical.
  Missing, changed, or ambiguous proof fails closed.
- A newer valid capture replaces the pending panel.
- Before submission, the app repeats the Herdr and Kitty context proof. Any
  context change stops the action.
- Request JSON is written atomically under:

  ```text
  ~/Library/Application Support/Trellage/TRX Guide Overlay/requests/
  ```

  Owned directories use mode `0700`; request files use mode `0600`.
- Only an opaque
  `trellage-guide-overlay-request:v1:<lowercase UUID>` token crosses the Herdr
  action context.
- Confirmed terminal failures remove an unconsumed request file. Unknown
  completion keeps the private request and pending identity for reconciliation.
- A terminal failed log is confirmed only when its strict safe result says
  `queued: false`. Missing, malformed, or mismatched safe output remains
  unresolved because the append could already have completed.
- Before writing and at startup, stale request cleanup considers only known
  lowercase-UUID `.json` and `.partial` names. It deletes a stale entry only
  after checking the exact owned directory, regular-file type, owner, mode
  `0600`, one link, and age.
- An action timeout is not reported as an add failure. The app stores the
  request ID, exact log ID when known, action, and start time in private
  `pending-action.json`. Capture remains disabled until startup or manual
  reconciliation proves the exact log succeeded, partially succeeded, or
  failed.
- Discovery, connect, and zero-byte request-write failures are definite and
  clean the request and pending state. A partial/post-write response loss is
  unknown. After `plugin.action.invoke` returns a log ID, every log-query
  failure remains unresolved; only that exact terminal log can clear pending
  state.
- For an unrecoverable unknown result, the status menu requires the explicit
  **I checked the queue — resume capture** action. It removes the private
  pending request only after you confirm that you checked the queue.

The app uses only the local Herdr Unix-domain socket. It runs the absolute
Herdr binary recorded by the installer only for `herdr status --json`, which
discovers that socket. Standard output and error are drained concurrently with
fixed caps. The process has a short timeout and is terminated and reaped by its
exact PID. The app never invokes a shell.
Every Unix socket enables and verifies `SO_NOSIGPIPE` immediately after
creation, before connect or write, so a peer close becomes a transport error
instead of terminating the app.
Capture event taps and pasteboard polling do not start until private
configuration has produced a usable context provider.

## Build and test

```sh
./scripts/test.sh
./scripts/build.sh
```

The command-line-tools installation on this host contains Swift Testing in a
nonstandard developer-framework directory. `Package.swift` adds only those
local framework search paths. `scripts/test.sh` runs `swift test` and a
dependency-free executable test runner. The runner provides explicit output
for command-line-tools versions whose `swift test` driver builds Swift Testing
tests but does not list their results.

The release app is assembled at:

```text
build/TRX Guide Overlay.app
```

The build script validates `Info.plist`, applies an ad-hoc signature, and runs
strict `codesign` verification. No Xcode project or `xcodebuild` is used.

## Demo

```sh
./scripts/demo.sh
```

This opens the app and shows the compact panel at the pointer. Demo actions do
not discover Herdr, create event taps, poll or read the pasteboard, initialize
request storage, invoke queue actions, or change the queue. `--demo` shows only
fixture UI and then idles safely. The normal menu-bar item also has **Show test
overlay**.

## Install

Make sure `herdr` is on `PATH`, then run:

```sh
./scripts/install.sh
```

For a named local Herdr session:

```sh
./scripts/install.sh --session SESSION_NAME
```

The installer writes only these owned locations:

```text
~/Applications/TRX Guide Overlay.app
~/Library/Application Support/Trellage/TRX Guide Overlay/
~/Library/LaunchAgents/dev.trellage.trx-guide-overlay.plist
```

The app-support configuration is mode `0600`; its directory is mode `0700`.
The LaunchAgent runs only the installed app executable.

After the first install, use the menu-bar item:

1. Select **Request permissions**.
2. Enable the installed app in **System Settings → Privacy & Security →
   Accessibility**.
3. Enable it in **Input Monitoring**.
4. Start the app again if macOS requests it.

Ad-hoc signing is suitable for this local prototype. Rebuilding the binary can
cause macOS to ask for permission again.

## Use

1. Keep Kitty frontmost with a focused local Herdr pane.
2. Drag over text.
3. Press `a`, press `o`, or click an action.
4. Press Escape or click outside to dismiss without adding.

The panel is nonactivating. Only unmodified `a`, `o`, and Escape key-down
events, repeated events in the same key press, and their matching key-up events
are suppressed. An unrelated key dismisses the action row and passes through.
During loading or result display, unrelated keys pass through. The panel
dismisses when Kitty or the proven source window loses focus.

## Diagnostics

The menu reports:

- capture enabled or disabled;
- Accessibility state;
- Input Monitoring state;
- detected `copy_on_select` state;
- the last safe capture or action status.

If no panel appears:

1. Confirm both permissions.
2. Confirm `copy_on_select` is not false in `~/.config/herdr/config.toml`.
3. Confirm `herdr status --json` reports a running compatible server.
4. Confirm Kitty is frontmost.
5. Confirm Herdr has a foreground Kitty client. The app must be able to set,
   observe, and clear its temporary `trxg-…` title marker.

The active marker proof intentionally prefers false negatives to sending text
to the wrong client.

## Lifecycle

```sh
./scripts/start.sh
./scripts/stop.sh
./scripts/uninstall.sh
```

Uninstall removes only the app bundle, its LaunchAgent, and its owned
application-support directory.
