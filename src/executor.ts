import { spawn } from "node:child_process";

const BASELINE_ENV_KEYS = ["PATH", "HOME", "LANG", "TERM", "USER", "SHELL", "TMPDIR"];

function buildEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of BASELINE_ENV_KEYS) {
    if (process.env[key] != null) {
      env[key] = process.env[key];
    }
  }
  return env;
}

export interface ExecuteOptions {
  cwd: string;
  signal?: AbortSignal;
  onUpdate?: (content: string) => void;
  extraEnv?: Record<string, string>;
  redact?: string[];
  /**
   * When true, a successful call resolves with stdout only (stderr is
   * excluded from the resolved value). Default behavior (false or omitted)
   * resolves with combined stdout+stderr, unchanged.
   *
   * On failure, behavior is unaffected: the rejection error always includes
   * combined stdout+stderr context regardless of this option.
   */
  stdoutOnly?: boolean;
}

function applyRedaction(text: string, redact?: string[]): string {
  if (!redact || redact.length === 0) return text;
  const uniqueSecrets = Array.from(new Set(redact.filter((secret) => !!secret)));
  // Process longest-first so overlapping secrets (e.g. "abc" and "abcdef")
  // don't leave remnants of a longer secret visible after a shorter one is
  // redacted first.
  uniqueSecrets.sort((a, b) => b.length - a.length);
  let result = text;
  for (const secret of uniqueSecrets) {
    result = result.split(secret).join("[REDACTED]");
  }
  return result;
}

function hasEffectiveRedact(redact?: string[]): boolean {
  return !!redact && redact.some((secret) => !!secret);
}

export async function executeCommand(command: string, options: ExecuteOptions): Promise<string> {
  const { cwd, signal, onUpdate, extraEnv, redact, stdoutOnly } = options;

  return new Promise<string>((resolve, reject) => {
    const proc = spawn("sh", ["-c", command], {
      cwd,
      env: { ...buildEnv(), ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });

    const stdoutDecoder = new TextDecoder("utf-8");
    const stderrDecoder = new TextDecoder("utf-8");
    let stdoutOutput = "";
    let combinedOutput = "";
    let lastFlushed = "";
    let settled = false;
    let throttleTimer: ReturnType<typeof setTimeout> | null = null;
    // When there is at least one nonempty secret to redact, streaming updates
    // are suppressed entirely to avoid disclosing a secret split across
    // chunk boundaries. Final success/error output remains fully redacted.
    const suppressUpdates = hasEffectiveRedact(redact);

    function scheduleFlush() {
      if (throttleTimer !== null || !onUpdate || settled || suppressUpdates) return;
      throttleTimer = setTimeout(() => {
        throttleTimer = null;
        if (!settled && combinedOutput !== lastFlushed) {
          lastFlushed = combinedOutput;
          onUpdate(applyRedaction(combinedOutput, redact));
        }
      }, 100);
    }

    function flushFinal() {
      if (throttleTimer !== null) {
        clearTimeout(throttleTimer);
        throttleTimer = null;
      }
      if (onUpdate && !suppressUpdates && combinedOutput !== lastFlushed) {
        lastFlushed = combinedOutput;
        onUpdate(applyRedaction(combinedOutput, redact));
      }
    }

    function handleStdout(chunk: Buffer) {
      const text = stdoutDecoder.decode(chunk, { stream: true });
      stdoutOutput += text;
      combinedOutput += text;
      if (onUpdate) scheduleFlush();
    }

    function handleStderr(chunk: Buffer) {
      const text = stderrDecoder.decode(chunk, { stream: true });
      combinedOutput += text;
      if (onUpdate) scheduleFlush();
    }

    proc.stdout.on("data", handleStdout);
    proc.stderr.on("data", handleStderr);

    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      flushFinal();
      reject(err);
    });

    if (signal) {
      if (signal.aborted) {
        settled = true;
        if (process.platform !== "win32" && proc.pid) {
          try {
            process.kill(-proc.pid, "SIGTERM");
          } catch {
            proc.kill();
          }
        } else {
          proc.kill();
        }
        reject(new Error("Command aborted"));
        return;
      }
      signal.addEventListener(
        "abort",
        () => {
          if (settled) return;
          settled = true;
          if (process.platform !== "win32" && proc.pid) {
            try {
              process.kill(-proc.pid, "SIGTERM");
            } catch {
              proc.kill();
            }
          } else {
            proc.kill();
          }
          reject(new Error("Command aborted"));
        },
        { once: true },
      );
    }

    proc.on("close", (code, killSignal) => {
      if (settled) return;
      settled = true;

      // Flush any remaining decoder state
      const remainingStdout = stdoutDecoder.decode();
      const remainingStderr = stderrDecoder.decode();
      stdoutOutput += remainingStdout;
      combinedOutput += remainingStdout + remainingStderr;
      flushFinal();

      const exitCode = code ?? (killSignal ? 1 : 0);
      if (exitCode === 0) {
        const resultText = stdoutOnly ? stdoutOutput : combinedOutput;
        resolve(applyRedaction(resultText, redact));
      } else {
        reject(new Error(`${applyRedaction(combinedOutput, redact)}\n\nCommand exited with code ${exitCode}`));
      }
    });
  });
}
