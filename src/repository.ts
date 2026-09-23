import { existsSync } from "node:fs";
import path from "node:path";

export type RepositoryType = "git" | "jj";

/**
 * Detects the repository type of the workspace rooted at `cwd`, walking up
 * through ancestor directories until a `.jj` or `.git` marker is found.
 * Jujutsu takes precedence when a directory contains both (colocated repos).
 * Filesystem errors and missing markers both yield `undefined` (non-match);
 * this never throws.
 */
export function detectRepositoryType(cwd: string): RepositoryType | undefined {
  try {
    let dir = path.resolve(cwd);
    let sawGit = false;
    for (;;) {
      if (existsSync(path.join(dir, ".jj"))) return "jj";
      if (!sawGit && existsSync(path.join(dir, ".git"))) {
        sawGit = true;
      }

      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return sawGit ? "git" : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Checks whether a tool's `when` condition matches the detected repository type.
 * An absent `when` always matches (unconditional tool).
 */
export function toolConditionMatches(when: RepositoryType | undefined, repoType: RepositoryType | undefined): boolean {
  return when === undefined || when === repoType;
}
