# @tangentfeed/react

React hooks for tangentfeed.

```tsx
const db = useSpace({ space: "kitchen-42", transports: [broadcast()] });
const { rows } = useRows(db, "tasks");
```

Hooks: `useSpace`, `useRows`, `useRow`, `usePeers`, `useTable`.

Part of [tangentfeed](https://github.com/sreerajta/tangentfeed). MIT licensed.
