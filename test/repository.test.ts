import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectRepositoryType } from "../src/repository.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "pi-armory-repo-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("detectRepositoryType", () => {
  it("returns undefined when no markers exist", async () => {
    const dir = path.join(tmpDir, "plain");
    await mkdir(dir, { recursive: true });
    expect(detectRepositoryType(dir)).toBeUndefined();
  });

  it("detects a git repository", async () => {
    const dir = path.join(tmpDir, "gitrepo");
    await mkdir(path.join(dir, ".git"), { recursive: true });
    expect(detectRepositoryType(dir)).toBe("git");
  });

  it("detects a jj repository", async () => {
    const dir = path.join(tmpDir, "jjrepo");
    await mkdir(path.join(dir, ".jj"), { recursive: true });
    expect(detectRepositoryType(dir)).toBe("jj");
  });

  it("prefers jj when colocated with git", async () => {
    const dir = path.join(tmpDir, "colocated");
    await mkdir(path.join(dir, ".git"), { recursive: true });
    await mkdir(path.join(dir, ".jj"), { recursive: true });
    expect(detectRepositoryType(dir)).toBe("jj");
  });

  it("resolves jj when a nested .git sits under an ancestor .jj", async () => {
    const root = path.join(tmpDir, "jjroot");
    const nested = path.join(root, "nested", "gitsub");
    await mkdir(path.join(root, ".jj"), { recursive: true });
    await mkdir(path.join(nested, ".git"), { recursive: true });
    expect(detectRepositoryType(nested)).toBe("jj");
  });

  it("detects repository type from an ancestor root", async () => {
    const root = path.join(tmpDir, "root");
    const nested = path.join(root, "nested", "deeper");
    await mkdir(path.join(root, ".git"), { recursive: true });
    await mkdir(nested, { recursive: true });
    expect(detectRepositoryType(nested)).toBe("git");
  });

  it("returns undefined without throwing for a nonexistent path", () => {
    expect(() => detectRepositoryType(path.join(tmpDir, "does-not-exist", "deeper"))).not.toThrow();
    expect(detectRepositoryType(path.join(tmpDir, "does-not-exist", "deeper"))).toBeUndefined();
  });
});
