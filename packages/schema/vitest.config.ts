import { defineConfig, mergeConfig } from "vitest/config";
import shared from "../../vitest.shared.js";

// `.test-d.ts` files assert on types rather than values, so the suite needs
// vitest's typecheck runner in addition to the normal one.
export default mergeConfig(
  shared,
  defineConfig({
    test: {
      typecheck: {
        enabled: true,
        include: ["test/**/*.test-d.ts"],
      },
    },
  }),
);
