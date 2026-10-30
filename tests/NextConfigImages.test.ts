import { describe, expect, it } from "vitest";
import nextConfig from "../next.config";

describe("next.config images", () => {
  it("disables the image optimizer (images.unoptimized === true)", () => {
    expect(nextConfig.images?.unoptimized).toBe(true);
  });
});
