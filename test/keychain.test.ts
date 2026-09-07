import { beforeEach, describe, expect, it, vi } from "vitest";
import { addSecret, fetchSecret, listSecrets, promptHiddenAnswer, removeSecret } from "../src/keychain.js";

const mockExecFile = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execFile: mockExecFile,
}));

type ExecResult = { stdout: string; stderr: string };
function ok(stdout: string): ExecResult {
  return { stdout, stderr: "" };
}

// The promisified execFile calls execFile(args..., callback)
// We need to simulate callback-style behavior
function mockResolve(result: ExecResult) {
  mockExecFile.mockImplementation((...args: unknown[]) => {
    const cb = args[args.length - 1] as (err: Error | null, result: ExecResult) => void;
    cb(null, result);
  });
}

function mockReject(err: Error) {
  mockExecFile.mockImplementation((...args: unknown[]) => {
    const cb = args[args.length - 1] as (err: Error | null, result: ExecResult | null) => void;
    cb(err, null);
  });
}

describe("fetchSecret", () => {
  beforeEach(() => {
    mockExecFile.mockReset();
  });

  it("calls security with correct arguments", async () => {
    mockResolve(ok("my-value\n"));
    await fetchSecret("my-account");
    expect(mockExecFile).toHaveBeenCalledWith(
      "security",
      ["find-generic-password", "-s", "pi-armory", "-a", "my-account", "-w"],
      expect.any(Function),
    );
  });

  it("returns trimmed stdout on success", async () => {
    mockResolve(ok("  secret-value  \n"));
    const result = await fetchSecret("my-account");
    expect(result).toBe("secret-value");
  });

  it("throws a descriptive error when the item is not found", async () => {
    mockReject(new Error("SecKeychainSearchCopyNext: The specified item could not be found."));
    await expect(fetchSecret("missing-account")).rejects.toThrow(/not found in keychain/);
  });

  it("throws a descriptive error when the keychain is locked", async () => {
    mockReject(new Error("User interaction is not allowed."));
    await expect(fetchSecret("any-account")).rejects.toThrow(/Failed to read secret/);
  });
});

describe("listSecrets", () => {
  beforeEach(() => {
    mockExecFile.mockReset();
  });

  it("probes each account with find-generic-password", async () => {
    mockResolve(ok(""));
    await listSecrets(["account-one", "account-two"]);
    expect(mockExecFile).toHaveBeenCalledWith(
      "security",
      ["find-generic-password", "-s", "pi-armory", "-a", "account-one"],
      expect.any(Function),
    );
    expect(mockExecFile).toHaveBeenCalledWith(
      "security",
      ["find-generic-password", "-s", "pi-armory", "-a", "account-two"],
      expect.any(Function),
    );
  });

  it("returns found accounts that exist in keychain", async () => {
    mockResolve(ok(""));
    const result = await listSecrets(["account-one", "account-two"]);
    expect(result.found).toEqual(["account-one", "account-two"]);
    expect(result.missing).toEqual([]);
  });

  it("returns missing accounts that don't exist in keychain", async () => {
    mockReject(new Error("item not found"));
    const result = await listSecrets(["account-one", "account-two"]);
    expect(result.found).toEqual([]);
    expect(result.missing).toEqual(["account-one", "account-two"]);
  });

  it("separates found and missing accounts", async () => {
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1] as (
        err: Error | null,
        result: { stdout: string; stderr: string } | null,
      ) => void;
      const cmdArgs = args[1] as string[];
      if (cmdArgs.includes("exists")) {
        cb(null, { stdout: "", stderr: "" });
      } else {
        cb(new Error("not found"), null);
      }
    });
    const result = await listSecrets(["exists", "missing"]);
    expect(result.found).toEqual(["exists"]);
    expect(result.missing).toEqual(["missing"]);
  });

  it("returns empty arrays for empty accounts list", async () => {
    const result = await listSecrets([]);
    expect(result.found).toEqual([]);
    expect(result.missing).toEqual([]);
    expect(mockExecFile).not.toHaveBeenCalled();
  });
});

describe("addSecret", () => {
  beforeEach(() => {
    mockExecFile.mockReset();
  });

  it("calls security with correct arguments including -U flag", async () => {
    mockResolve(ok(""));
    await addSecret("my-account", "my-value");
    expect(mockExecFile).toHaveBeenCalledWith(
      "security",
      ["add-generic-password", "-s", "pi-armory", "-a", "my-account", "-w", "my-value", "-U"],
      expect.any(Function),
    );
  });

  it("resolves without error on success", async () => {
    mockResolve(ok(""));
    await expect(addSecret("account", "value")).resolves.toBeUndefined();
  });

  it("throws a descriptive error on failure", async () => {
    mockReject(new Error("write failed"));
    await expect(addSecret("account", "value")).rejects.toThrow(/failed to add secret 'account'/);
  });
});

describe("removeSecret", () => {
  beforeEach(() => {
    mockExecFile.mockReset();
  });

  it("calls security with correct arguments", async () => {
    mockResolve(ok(""));
    await removeSecret("my-account");
    expect(mockExecFile).toHaveBeenCalledWith(
      "security",
      ["delete-generic-password", "-s", "pi-armory", "-a", "my-account"],
      expect.any(Function),
    );
  });

  it("resolves without error on success", async () => {
    mockResolve(ok(""));
    await expect(removeSecret("account")).resolves.toBeUndefined();
  });

  it("throws a descriptive error on failure", async () => {
    mockReject(new Error("item not found"));
    await expect(removeSecret("account")).rejects.toThrow(/failed to remove secret 'account'/);
  });
});

describe("promptHiddenAnswer", () => {
  beforeEach(() => {
    mockExecFile.mockReset();
  });

  it("invokes osascript with a fixed script and the account as a separate final arg", async () => {
    mockResolve(ok("my-secret\n"));
    await promptHiddenAnswer("my-account");

    expect(mockExecFile).toHaveBeenCalledOnce();
    const [cmd, cmdArgs] = mockExecFile.mock.calls[0] as [string, string[]];
    expect(cmd).toBe("osascript");
    expect(cmdArgs[0]).toBe("-e");
    expect(cmdArgs[1]).toContain("with hidden answer");
    // The account must be its own final argv entry, never concatenated/embedded into the script.
    expect(cmdArgs[cmdArgs.length - 1]).toBe("my-account");
    expect(cmdArgs[1]).not.toContain("my-account");
  });

  it("strips a single trailing newline from stdout on success", async () => {
    mockResolve(ok("super-secret-value\n"));
    const result = await promptHiddenAnswer("my-account");
    expect(result).toBe("super-secret-value");
  });

  it("returns null when the error message contains -128 (user cancelled)", async () => {
    mockReject(new Error("execution error: (-128)"));
    const result = await promptHiddenAnswer("my-account");
    expect(result).toBeNull();
  });

  it("returns null when the error message contains 'User canceled'", async () => {
    mockReject(new Error("User canceled. (-128)"));
    const result = await promptHiddenAnswer("my-account");
    expect(result).toBeNull();
  });

  it("throws a descriptive error for other failures", async () => {
    mockReject(new Error("osascript is not allowed to send Apple events"));
    await expect(promptHiddenAnswer("my-account")).rejects.toThrow(/failed to prompt for secret value/);
  });
});
