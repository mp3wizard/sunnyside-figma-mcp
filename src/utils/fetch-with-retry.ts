import { execFile } from "child_process";
import { promisify } from "util";
import { Logger } from "./logger.js";

const execFileAsync = promisify(execFile);

export async function fetchWithRetry<T>(url: string, options: RequestInit = {}): Promise<T> {
  try {
    const response = await fetch(url, options);

    if (!response.ok) {
      throw new Error(`Fetch failed with status ${response.status}: ${response.statusText}`);
    }
    return (await response.json()) as T;
  } catch (fetchError: any) {
    Logger.log(
      `[fetchWithRetry] Initial fetch failed for ${url}: ${fetchError.message}. Likely a corporate proxy or SSL issue. Attempting curl fallback.`,
    );

    const curlArgs = formatArgsForCurl(options.headers, url);

    try {
      // Fallback to curl for corporate networks that have proxies that sometimes block fetch
      Logger.log(`[fetchWithRetry] Executing curl with args for ${url}`);
      const { stdout, stderr } = await execFileAsync("curl", curlArgs);

      if (stderr) {
        // curl often outputs progress to stderr, so only treat as error if stdout is empty
        // or if stderr contains typical error keywords.
        if (
          !stdout ||
          stderr.toLowerCase().includes("error") ||
          stderr.toLowerCase().includes("fail")
        ) {
          throw new Error(`Curl command failed with stderr: ${stderr}`);
        }
        Logger.log(
          `[fetchWithRetry] Curl command for ${url} produced stderr (but might be informational): ${stderr}`,
        );
      }

      if (!stdout) {
        throw new Error("Curl command returned empty stdout.");
      }

      return JSON.parse(stdout) as T;
    } catch (curlError: any) {
      Logger.error(`[fetchWithRetry] Curl fallback also failed for ${url}: ${curlError.message}`);
      // Re-throw the original fetch error to give context about the initial failure
      // or throw a new error that wraps both, depending on desired error reporting.
      // For now, re-throwing the original as per the user example's spirit.
      throw fetchError;
    }
  }
}

/**
 * Builds a safe argv array for execFile("curl", args) — no shell interpolation.
 * Each header becomes two separate elements ["-H", "key: value"] so values
 * are never parsed as shell tokens.
 */
function formatArgsForCurl(headers: HeadersInit | undefined, url: string): string[] {
  const args: string[] = ["-s", "-L"];

  const addHeader = (key: string, value: string) => {
    args.push("-H", `${key}: ${value}`);
  };

  if (headers instanceof Headers) {
    headers.forEach((value, key) => addHeader(key, value));
  } else if (Array.isArray(headers)) {
    (headers as [string, string][]).forEach(([key, value]) => addHeader(key, value));
  } else if (headers) {
    Object.entries(headers as Record<string, string>).forEach(([key, value]) => addHeader(key, value));
  }

  args.push("--", url);
  return args;
}
