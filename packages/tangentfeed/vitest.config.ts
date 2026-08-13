import { defineConfig, mergeConfig } from "vitest/config";
import shared from "../../vitest.shared.js";

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
