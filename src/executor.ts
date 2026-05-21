import { spawn } from "node:child_process";

export interface ExecuteOptions {
  cwd: string;
  signal?: AbortSignal;
  onUpdate?: (content: string) => void;
}

export async function executeCommand(command: string, options: ExecuteOptions): Promise<string> {
  const { cwd, signal, onUpdate } = options;

  return new Promise<string>((resolve, reject) => {
    const proc = spawn("sh", ["-c", command], {
      cwd,
      env: process.env,
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
          onUpdate(output);
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
        onUpdate(output);
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
        resolve(output);
      } else {
        reject(new Error(`${output}\n\nCommand exited with code ${exitCode}`));
      }
    });
  });
}
