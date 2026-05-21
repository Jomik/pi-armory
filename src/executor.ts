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
}

function applyRedaction(text: string, redact?: string[]): string {
  if (!redact || redact.length === 0) return text;
  let result = text;
  for (const secret of redact) {
    if (!secret) continue;
    result = result.split(secret).join("[REDACTED]");
  }
  return result;
}

export async function executeCommand(command: string, options: ExecuteOptions): Promise<string> {
  const { cwd, signal, onUpdate, extraEnv, redact } = options;

  return new Promise<string>((resolve, reject) => {
    const proc = spawn("sh", ["-c", command], {
      cwd,
      env: { ...buildEnv(), ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });

    const decoder = new TextDecoder("utf-8");
    let output = "";
    let lastFlushed = "";
    let settled = false;
    let throttleTimer: ReturnType<typeof setTimeout> | null = null;

    function scheduleFlush() {
      if (throttleTimer !== null || !onUpdate || settled) return;
      throttleTimer = setTimeout(() => {
        throttleTimer = null;
        if (!settled && output !== lastFlushed) {
          lastFlushed = output;
          onUpdate(applyRedaction(output, redact));
        }
      }, 100);
    }

    function flushFinal() {
      if (throttleTimer !== null) {
        clearTimeout(throttleTimer);
        throttleTimer = null;
      }
      if (onUpdate && output !== lastFlushed) {
        lastFlushed = output;
        onUpdate(applyRedaction(output, redact));
      }
    }

    function handleData(chunk: Buffer) {
      output += decoder.decode(chunk, { stream: true });
      if (onUpdate) scheduleFlush();
    }

    proc.stdout.on("data", handleData);
    proc.stderr.on("data", handleData);

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
      output += decoder.decode();
      flushFinal();

      const exitCode = code ?? (killSignal ? 1 : 0);
      if (exitCode === 0) {
        resolve(applyRedaction(output, redact));
      } else {
        reject(new Error(`${applyRedaction(output, redact)}\n\nCommand exited with code ${exitCode}`));
      }
    });
  });
}
