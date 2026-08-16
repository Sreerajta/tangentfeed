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

## What this does not test

Being straight with you about the gaps:

- **sqflite storage.** The example app uses in-memory storage so it can run in
  Chrome. The SQLite adapter is tested in Level 1, but the *sqflite* binding
  specifically has never been run. It needs `flutter run -d macos` or a phone.
- **A real network.** Both peers are on one machine. NAT traversal, which is
  where WebRTC actually gets hard, is untested.
- **Phones.** Nothing here has run on iOS or Android.
