import { describe, expect, it } from "vitest";
import { executeCommand } from "../src/executor.js";

describe("executeCommand", () => {
  it("returns stdout on success", async () => {
    const result = await executeCommand("echo hello", { cwd: process.cwd() });
    expect(result.trim()).toBe("hello");
  });

  it("includes stderr in output on success", async () => {
    const result = await executeCommand("echo err >&2 && echo ok", { cwd: process.cwd() });
    expect(result).toContain("err");
    expect(result).toContain("ok");
  });

  it("throws with output and exit code on non-zero exit", async () => {
    await expect(executeCommand("echo failing && exit 1", { cwd: process.cwd() })).rejects.toThrow(
      /Command exited with code 1/,
    );
  });

  it("includes command output in error on non-zero exit", async () => {
    await expect(executeCommand("echo failing && exit 1", { cwd: process.cwd() })).rejects.toThrow(/failing/);
  });

  it("throws 'Command aborted' when signal is aborted", async () => {
    const controller = new AbortController();
    const promise = executeCommand("sleep 10", { cwd: process.cwd(), signal: controller.signal });
    controller.abort();
    await expect(promise).rejects.toThrow("Command aborted");
  });

  it("throws immediately if signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(executeCommand("echo hi", { cwd: process.cwd(), signal: controller.signal })).rejects.toThrow(
      "Command aborted",
    );
  });

  it("calls onUpdate with progressive output", async () => {
    const updates: string[] = [];
    const result = await executeCommand("echo line1 && sleep 0.15 && echo line2", {
      cwd: process.cwd(),
      onUpdate: (content) => updates.push(content),
    });
    expect(result).toContain("line1");
    expect(result).toContain("line2");
    // At least one intermediate and one final update
    expect(updates.length).toBeGreaterThanOrEqual(1);
    // Final update should contain all output
    expect(updates[updates.length - 1]).toContain("line1");
  });
});
