# TURN: connecting peers on different networks

Every sync test in this repository so far — including the iPhone run — had both
peers on one local network, where ICE finds a direct path immediately. That is
the easy case. Two users in different places is the normal case in production,
and it is where WebRTC gets hard.

## What actually happens

A peer-to-peer connection needs each side to learn an address the other can
reach. Three outcomes, in the order ICE tries them:

| Path | Needs | Works when |
|---|---|---|
| **Host** | nothing | Both peers on the same network — every test so far |
| **Server reflexive** | STUN | Ordinary home routers on both ends |
| **Relayed** | **TURN** | Symmetric NAT, strict corporate firewalls, some mobile carriers |

STUN only *tells you your own public address*. It cannot forward anything. When
both peers are behind NAT that assigns a different external port per
destination — symmetric NAT, common on mobile networks — the address STUN
reports is useless to the other side, and the connection fails.

TURN relays the traffic. It is a real server carrying real bandwidth, which is
why there is no free public one and why this project does not ship a default.

**Roughly 10–20% of connections need TURN.** Without one, that fraction of your
users see sync silently never working.

## Configuring it

Both transports take ICE servers. Credentials come from your TURN provider.

**TypeScript**

```ts
import { openSpace, webrtc } from "tangentfeed";

const db = await openSpace({
  space: "kitchen-42",
  transports: [
    webrtc({
      signaling: "wss://signal.example.com",
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        {
          urls: "turn:turn.example.com:3478",
          username: "…",
          credential: "…",
        },
      ],
    }),
  ],
});
```

**Flutter**

```dart
final transport = WebRTCTransport(
  space: space,
  deviceId: deviceId,
  signalingUrl: 'wss://signal.example.com',
  iceServers: [
    {'urls': 'stun:stun.l.google.com:19302'},
    {
      'urls': 'turn:turn.example.com:3478',
      'username': '…',
      'credential': '…',
    },
  ],
);
```

Omit `iceServers` and you get `DEFAULT_ICE_SERVERS`: public STUN, no TURN.
Enough for two laptops on one Wi-Fi, not enough for the internet.

## Running one

**coturn** is the standard open-source server. On a Debian host:

```bash
apt install coturn
```

`/etc/turnserver.conf`, minimally:

```
listening-port=3478
tls-listening-port=5349

realm=turn.example.com
server-name=turn.example.com

# Long-term credentials. Static ones are fine to start; rotate to the
# time-limited scheme below before anything real.
lt-cred-mech
user=tangentfeed:CHANGE_THIS

# Relay only. Without these a TURN server is an open proxy into your network.
no-multicast-peers
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255

cert=/etc/letsencrypt/live/turn.example.com/fullchain.pem
pkey=/etc/letsencrypt/live/turn.example.com/privkey.pem
```

Open UDP and TCP **3478** and **5349**, plus the UDP relay range
(`min-port`/`max-port`, default 49152–65535).

**The `denied-peer-ip` lines are not optional.** A TURN server without them
will relay traffic to your private network on behalf of anyone who can
authenticate, which turns it into a pivot into everything else you run.

### Credentials

Static credentials in an app bundle are credentials you have published. For
anything real, use coturn's time-limited scheme: the server holds one shared
secret, and your backend hands each client a username of `<expiry>:<user>` with
an HMAC-SHA1 password derived from it. Set `use-auth-secret` and
`static-auth-secret` instead of `lt-cred-mech` and `user`.

That requires a backend endpoint, which is a real dependency for a design that
otherwise needs no server — worth knowing before you promise "serverless".

## Verifying it works

The failure mode is silence: everything looks fine on your LAN and never
connects for a user elsewhere. Two ways to check.

**Trickle ICE.** Open <https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/>,
enter your TURN URL and credentials, and gather. You should see candidates of
type `relay`. If you only see `host` and `srflx`, TURN is not working —
credentials, firewall, or the relay port range.

**Force it.** Set `iceTransportPolicy: "relay"` in `rtcConfig`, which makes ICE
use *only* TURN. If sync still works, the relay path is genuinely functioning.
If it fails, it was silently falling back to a direct path on your network and
would have failed for a real user.

```ts
webrtc({
  signaling: "wss://signal.example.com",
  iceServers: [{ urls: "turn:turn.example.com:3478", username: "…", credential: "…" }],
  rtcConfig: { iceTransportPolicy: "relay" },
})
```

## Status in this project

**Untested.** No TURN server has been run against either implementation, and no
cross-network sync has been demonstrated. The configuration surface exists and
the defaults are sane, but until someone runs the forced-relay test above,
treat cross-network sync as unproven — the audit in
`docs/PRODUCTION-READINESS.md` says the same.
