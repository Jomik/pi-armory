import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

const SERVICE = "pi-armory";

/**
 * Fetches a secret from the macOS keychain under service "pi-armory".
 * @param account - The keychain account name
 * @returns The password value, trimmed
 */
export async function fetchSecret(account: string): Promise<string> {
  try {
    const { stdout } = await execFile("security", ["find-generic-password", "-s", SERVICE, "-a", account, "-w"]);
    return stdout.trim();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("could not be found")) {
      throw new Error(`Secret '${account}' not found in keychain. Add it with: /armory secrets`);
    }
    throw new Error(`Failed to read secret '${account}' from keychain: ${msg}`);
  }
}

/**
 * Lists secret account names by probing the keychain for each known account.
 * Returns only accounts that actually exist in the keychain.
 */
export async function listSecrets(accounts: string[]): Promise<{ found: string[]; missing: string[] }> {
  const found: string[] = [];
  const missing: string[] = [];

  await Promise.all(
    accounts.map(async (account) => {
      try {
        await execFile("security", ["find-generic-password", "-s", SERVICE, "-a", account]);
        found.push(account);
      } catch {
        missing.push(account);
      }
    }),
  );

  return { found: found.sort(), missing: missing.sort() };
}

/**
 * Adds or updates a secret in the macOS keychain under service "pi-armory".
 * Uses -U flag to update if the item already exists.
 * @param account - The keychain account name
 * @param value - The secret value to store
 */
export async function addSecret(account: string, value: string): Promise<void> {
  try {
    await execFile("security", ["add-generic-password", "-s", SERVICE, "-a", account, "-w", value, "-U"]);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`pi-armory: failed to add secret '${account}': ${msg}`);
  }
}

/**
 * Removes a secret from the macOS keychain under service "pi-armory".
 * @param account - The keychain account name
 */
export async function removeSecret(account: string): Promise<void> {
  try {
    await execFile("security", ["delete-generic-password", "-s", SERVICE, "-a", account]);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`pi-armory: failed to remove secret '${account}': ${msg}`);
  }
}
