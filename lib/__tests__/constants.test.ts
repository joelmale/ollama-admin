import { describe, it, expect } from "vitest";

describe("constants", () => {
  it("has correct default values", async () => {
    const mod = await import("@/lib/constants");

    expect(mod.AUTH_DISABLED).toBe(false);
    expect(mod.CATALOG_REFRESH_ENABLED).toBe(true);
  });
});
