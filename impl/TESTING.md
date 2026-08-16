# Testing this, step by step

No thinking required. Copy each block, paste it, look at what it says.

Every command below was run before this was written, so they work as printed.
Paths assume you start from the repository root:

```bash
cd ~/tangentfeed/tangentfeed-v0.1.0
```

---

## Level 1 — does the Dart implementation work at all?

**Two minutes. No Flutter, no browser, no server.**

```bash
cd impl/dart
dart pub get
dart test
```

**What you should see:** a long list of green lines ending in

```
All tests passed!
```

**What it means:** the Dart implementation passed the same 118 checks the
TypeScript one is held to — clocks, canonical JSON, merge in five different
orderings, real SQLite storage, and decrypting data the TypeScript
implementation encrypted.

If this fails, stop here and send me the output. Nothing below will work.

```bash
cd ../..
```

---

## Level 2 — two Flutter apps syncing with each other

**Ten minutes. This is the real test.** You will need **three terminal
windows**. Keep all three open.

### Terminal 1 — the signaling server

This is the matchmaker. It introduces two peers and then gets out of the way;
your data never goes through it.

```bash
cd ~/tangentfeed/tangentfeed-v0.1.0
npm install
npm run build -w packages/signaling-server
node packages/signaling-server/bin/server.mjs
```

**You should see:**

```
tangentfeed signaling server listening on ws://0.0.0.0:8787
```

**Leave this running.** Do not close it.

### Terminal 2 — the first app

```bash
cd ~/tangentfeed/tangentfeed-v0.1.0/impl/flutter/example
flutter pub get
flutter run -d chrome
```

A Chrome window opens with a task list. Under the title it will say:

```
no peers yet — open a second window
```

That is correct. There is nobody to talk to yet.

**Leave this running.**

### Terminal 3 — the second app

```bash
cd ~/tangentfeed/tangentfeed-v0.1.0/impl/flutter/example
flutter run -d chrome
```

A second Chrome window opens.

### Now the actual test

Put the two windows side by side.

1. Within a few seconds, both should change to **`synced with 1 peer(s)`**.
2. Type `buy milk` in the **left** window, press Enter.
3. **It should appear in the right window**, on its own, within a second.
4. Tick the checkbox on the **right**. It should tick itself on the left.
5. Delete it on either side. It vanishes from both.

**If all five happened: it works.** Dart wrote an operation, sent it over a
real WebRTC data channel, and another replica merged it.

### The interesting test — offline

This is the part the whole project exists for.

1. In the **left** Chrome window, open DevTools (`Cmd+Option+I`).
2. Go to the **Network** tab, set throttling to **Offline**.
3. Add `written while offline` in the **left** window. The right window will
   *not* see it. Correct.
4. Add `also offline` in the **right** window. The left will not see it either.
5. Set throttling back to **No throttling**.
6. **Within a few seconds both windows should show both tasks.**

That is convergence after a partition, which is the thing that is genuinely
hard and the reason for all the clock machinery.

---

## Level 3 — Flutter talking to the browser implementation

**Five more minutes.** This proves the Dart and TypeScript implementations
actually interoperate, rather than each being self-consistent.

Keep the signaling server running in Terminal 1.

### Build and serve the browser demo

In a new terminal:

```bash
cd ~/tangentfeed/tangentfeed-v0.1.0
npm run build
npm run build -w @tangentfeed/demo
cd apps/demo/dist
python3 -m http.server 8080
```

Then open **http://localhost:8080/webrtc.html** in a Chrome tab.

### Connect them

In the browser demo page:

- **Space:** `kitchen-42`
- **Signaling:** `ws://localhost:8787`
- Leave the passphrase empty
- Click connect

The Flutter app from Level 2 is already using the space `kitchen-42` and that
same signaling URL, so they will find each other.

**Add a task in the Flutter window. It should appear in the browser demo, and
the reverse.**

If that works, a Dart implementation and a TypeScript implementation are
merging each other's operations over a real peer-to-peer connection.

---

## Level 4 — your iPhone

**Fifteen minutes.** This is the most valuable test, because it is the only
one that exercises **sqflite** — the storage binding that has never run
anywhere. The app shows which storage it is using, so you can see it.

### Before you start

Your **iPhone and your Mac must be on the same Wi-Fi network.** Not "the phone
is on 5GHz and the Mac is on ethernet" — the same network.

### Step 1 — find your Mac's address

```bash
ipconfig getifaddr en0
```

Write down what it prints. When this guide was written it was `192.168.0.103`;
yours will differ. Below, wherever you see `YOUR_MAC_IP`, use that number.

### Step 2 — start the signaling server, listening beyond localhost

In Terminal 1:

```bash
cd ~/tangentfeed/tangentfeed-v0.1.0
node packages/signaling-server/bin/server.mjs
```

It says `listening on ws://0.0.0.0:8787`. The `0.0.0.0` matters: it means it
accepts connections from your phone and not only from the Mac.

**Check it from the phone before going further.** In Safari on the iPhone open:

```
http://YOUR_MAC_IP:8787
```

Anything other than "cannot connect" is fine — an error page means the phone
reached the server, which is all you need to know. If it *cannot* connect, your
Mac's firewall is blocking it: **System Settings → Network → Firewall**, either
turn it off or allow incoming connections for `node`.

### Step 3 — plug in the iPhone and run

```bash
cd ~/tangentfeed/tangentfeed-v0.1.0/impl/flutter/example
flutter devices
```

Your iPhone should be listed. If not: unlock it, and if it asks **Trust This
Computer**, say yes.

```bash
flutter run -d iphone
```

The first run takes a few minutes.

**On signing:** Xcode needs a free Apple ID to put an app on a real phone. If
the build complains about signing, run `open ios/Runner.xcworkspace`, click
**Runner** in the left sidebar, go to **Signing & Capabilities**, tick
**Automatically manage signing**, and pick your Apple ID under Team. Then close
Xcode and run `flutter run -d iphone` again.

**On first launch the phone will ask for Local Network permission. Say yes.**
Without it nothing will connect, and iOS only asks once.

### Step 4 — connect the phone

In the app on your phone:

- **Signaling server:** `ws://YOUR_MAC_IP:8787` — not localhost
- **Space:** `kitchen-42`
- Tap **Connect**

The status line should show `waiting for a peer  ·  storage: sqflite`.

**`storage: sqflite` is the thing to notice.** That is the binding no test has
ever covered.

### Step 5 — the test

Start a second peer on the Mac, in another terminal:

```bash
cd ~/tangentfeed/tangentfeed-v0.1.0/impl/flutter/example
flutter run -d chrome
```

In the Chrome window set the signaling server to `ws://YOUR_MAC_IP:8787` (the
same address the phone is using, not localhost) and the same space, then
Connect.

Both should say `synced with 1 peer(s)`.

1. Add a task **on the phone**. It appears in Chrome.
2. Tick it **in Chrome**. It ticks on the phone.
3. **Force-quit the app on the phone** (swipe up), reopen it, tap Connect.
   **Your tasks are still there.** That is sqflite persisting to disk — the
   in-memory build would have come back empty.
4. Put the phone in **Airplane Mode**. Add a task on the phone and another in
   Chrome. Neither sees the other.
5. Turn Airplane Mode off. **Within a few seconds both have both tasks.**

Step 3 proves the storage binding. Step 5 proves offline convergence on a real
device over a real network.

---

## If something goes wrong

**`flutter run -d chrome` says no devices**
Run `flutter devices`. If Chrome is not listed, run `flutter config
--enable-web`, then try again.

**The app says `error: ...` under the title**
Almost always the signaling server. Check Terminal 1 is still running and still
says `listening on ws://0.0.0.0:8787`.

**Both windows say `no peers yet` forever**
They are in different spaces, or pointed at different signaling servers. Both
are hardcoded in `impl/flutter/example/lib/main.dart` as `_space` and
`_signaling`; make sure you did not change one.

**`npm install` fails on better-sqlite3**
It compiles native code. `xcode-select --install`, then try again.

**Level 1 passes but Level 2 does not**
That is a transport problem, not a protocol problem — the protocol is what
Level 1 tests. Say so when you report it; it narrows the search a lot.

---

## iPhone-specific problems

**The app never asks for Local Network permission, and nothing connects**
iOS asks once and remembers. Delete the app from the phone and run again, or
**Settings → Privacy & Security → Local Network** and enable it there.

**`failed: ...` right after tapping Connect**
You used `localhost`. On the phone, localhost is the phone. Use
`ws://YOUR_MAC_IP:8787`.

**Safari on the phone cannot reach `http://YOUR_MAC_IP:8787`**
The Mac's firewall is blocking it, or the two devices are on different
networks. Fix that before anything else — nothing will work until that URL
responds.

**Xcode signing errors**
`open ios/Runner.xcworkspace` → Runner → Signing & Capabilities → tick
Automatically manage signing → choose your Apple ID. A free account works; the
app expires after seven days, which is irrelevant for a test.

---

## What this does not test

Being straight with you about what is left:

- **A real network path.** Both peers are on one Wi-Fi network, so WebRTC does
  the easy thing and connects directly. NAT traversal between two networks —
  where it actually gets hard, and where you would need a TURN server — is
  untested.
- **Android.** Nothing here has run on it. The code has no iOS-specific parts,
  but that is an argument, not evidence.
- **Scale.** A handful of tasks between two peers. Not thousands of operations,
  not many peers, not compaction.
