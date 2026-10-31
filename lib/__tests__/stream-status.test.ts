import { describe, expect, it } from "vitest";
import { streamStatusCode } from "@/lib/stream-status";

describe("streamStatusCode", () => {
  it.each([
    [false, false, 200],
    [false, true, 499],
    [true, false, 502],
    [true, true, 502],
  ])("failed=%s clientGone=%s -> %s", (failed, clientGone, expected) => {
    expect(streamStatusCode(failed, clientGone)).toBe(expected);
  });
});
