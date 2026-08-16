# tangentfeed_flutter

Flutter bindings for [`tangentfeed`](../dart): sqflite storage and a WebRTC
transport.

No protocol logic lives here. The engine, merge and replication are in the pure
Dart package and are covered by the conformance vectors; this package only
teaches them to speak sqflite and WebRTC.

## Install

```yaml
dependencies:
  tangentfeed:
    git:
      url: https://github.com/Sreerajta/tangentfeed.git
      path: impl/dart
  tangentfeed_flutter:
    git:
      url: https://github.com/Sreerajta/tangentfeed.git
      path: impl/flutter
```

## Use

```dart
import 'package:tangentfeed/tangentfeed.dart';
import 'package:tangentfeed_flutter/tangentfeed_flutter.dart';

final db = await openSpace(
  space: 'kitchen-42',
  storage: await SqliteAdapter.open(
    await SqfliteDriver.openNamed('tangentfeed.db'),
  ),
  transports: [
    ({required space, required deviceId}) async {
      final t = WebRTCTransport(
        space: space,
        deviceId: deviceId,
        signalingUrl: 'ws://192.168.1.10:8787',
      );
      await t.start();
      return t;
    },
  ],
);

await db.insert('tasks', {'title': 'Buy oat milk', 'done': false});
```

`example/` is a runnable two-peer app. `../TESTING.md` walks through proving it
on an iPhone.

## iOS setup

Three entries in `Info.plist`, none optional, all of which fail silently if
missing:

```xml
<key>NSLocalNetworkUsageDescription</key>
<string>Sync with peers on your local network.</string>

<!-- The WebRTC framework links these APIs even if you never use them -->
<key>NSCameraUsageDescription</key><string>Not used.</string>
<key>NSMicrophoneUsageDescription</key><string>Not used.</string>

<!-- Only if your signaling server is plain ws:// on the LAN -->
<key>NSAppTransportSecurity</key>
<dict><key>NSAllowsLocalNetworking</key><true/></dict>
```

iOS asks for local network permission once. Decline it and nothing connects,
with no second prompt.

Minimum deployment target is iOS 13, set in `ios/Podfile`.

## Signaling

The WebRTC transport needs a signaling server to introduce peers. It is a blind
relay — it never sees your data — and one ships with the protocol repository:

```bash
npx @tangentfeed/signaling-server        # listens on :8787
```

On a device, point at the host machine's LAN address. `localhost` on a phone is
the phone.

## Status

Both seams have been run on an iPhone against a browser peer: writes and
updates in both directions, convergence after the phone went offline with
writes on both sides, and data surviving an app restart.

Still untested: peers on different networks, so NAT traversal and TURN are
unproven. And crash-atomicity on the sqflite path specifically — the pure Dart
package proves it for `package:sqlite3` with an injected mid-batch failure, and
sqflite has no equivalent.

## License

MIT
