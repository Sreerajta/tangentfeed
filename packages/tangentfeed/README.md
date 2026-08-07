# tangentfeed

Batteries-included entry point.

```ts
import { openSpace, broadcast } from "tangentfeed";

const db = await openSpace({ space: "kitchen-42", transports: [broadcast()] });
await db.insert("tasks", { title: "Buy oat milk", done: false });
```

See the [project README](https://github.com/sreerajta/tangentfeed) for the full guide.

Part of [tangentfeed](https://github.com/sreerajta/tangentfeed). MIT licensed.
