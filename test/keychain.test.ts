import { beforeEach, describe, expect, it, vi } from "vitest";
import { addSecret, fetchSecret, listSecrets, removeSecret } from "../src/keychain.js";

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
    await expect(fetchSecret("missing-account")).rejects.toThrow(/failed to fetch secret 'missing-account'/);
  });

  it("throws a descriptive error when the keychain is locked", async () => {
    mockReject(new Error("SecKeychainOpen: A keychain with the specified name could not be found."));
    await expect(fetchSecret("any-account")).rejects.toThrow(/failed to fetch secret 'any-account'/);
  });
});

describe("listSecrets", () => {
  beforeEach(() => {
    mockExecFile.mockReset();
  });

  it("calls security dump-keychain", async () => {
    mockResolve(ok(""));
    await listSecrets();
    expect(mockExecFile).toHaveBeenCalledWith("security", ["dump-keychain"], expect.any(Function));
  });

  it("returns account names matching service pi-armory", async () => {
    const dumpOutput = [
      'keychain: "/test.keychain"',
      "version: 512",
      'class: "genp"',
      "attributes:",
      '    0x00000007 <blob>="pi-armory"',
      '    "acct"<blob>="account-one"',
      '    "svce"<blob>="pi-armory"',
      'keychain: "/test.keychain"',
      "version: 512",
      'class: "genp"',
      "attributes:",
      '    0x00000007 <blob>="other-service"',
      '    "acct"<blob>="account-two"',
      '    "svce"<blob>="other-service"',
      'keychain: "/test.keychain"',
      "version: 512",
      'class: "genp"',
      "attributes:",
      '    "acct"<blob>="account-three"',
      '    "svce"<blob>="pi-armory"',
    ].join("\n");
    mockResolve(ok(dumpOutput));
    const result = await listSecrets();
    expect(result).toEqual(["account-one", "account-three"]);
  });

  it("returns empty array when no pi-armory entries exist", async () => {
    const dumpOutput = [
      'keychain: "/test.keychain"',
      'class: "genp"',
      "attributes:",
      '    "acct"<blob>="account-two"',
      '    "svce"<blob>="other-service"',
    ].join("\n");
    mockResolve(ok(dumpOutput));
    const result = await listSecrets();
    expect(result).toEqual([]);
  });

  it("returns empty array for empty dump output", async () => {
    mockResolve(ok(""));
    const result = await listSecrets();
    expect(result).toEqual([]);
  });

  it("throws a descriptive error on execFile failure", async () => {
    mockReject(new Error("permission denied"));
    await expect(listSecrets()).rejects.toThrow(/failed to list secrets/);
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
