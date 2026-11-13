import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILD_FILE, readBuildId } from "../build-id";

describe("readBuildId", () => {
  it("finds the deploy's build file above the compiled code", () => {
    const root = mkdtempSync(join(tmpdir(), "build-id-"));
    const dist = join(root, "packages", "backend", "dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(root, BUILD_FILE), "abc123-xyz\n");
    expect(readBuildId(dist, {})).toBe("abc123-xyz");
  });

  it("is null without one, and MISSIVE_BUILD wins when set", () => {
    const dir = mkdtempSync(join(tmpdir(), "build-id-"));
    expect(readBuildId(dir, {})).toBeNull();
    expect(readBuildId(dir, { MISSIVE_BUILD: "from-env" })).toBe("from-env");
  });
});
