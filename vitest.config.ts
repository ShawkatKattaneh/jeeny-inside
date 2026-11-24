import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["{engine,shared,server,client}/**/*.test.{ts,tsx}"],
    environment: "node",
  },
});
