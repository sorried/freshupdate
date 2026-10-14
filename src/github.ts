import { isRecord, parseRelease, type Release } from "./releases.js";
import { nowSeconds, sleep } from "./timing.js";

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly retryAfter = 0,
  ) {
    super(message);
  }
}

interface CachedPage {
  etag: string;
  releases: unknown[];
  has_next: boolean;
}

export interface ReleaseSnapshot {
  releases: Release[];
  cache: string;
}

export function retryDelay(headers: Headers, now = nowSeconds()): number {
  const retryAfter = headers.get("Retry-After");
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (retryAfter.trim() && Number.isFinite(seconds)) return Math.max(0, seconds);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, date / 1000 - now);
  }
  const reset = Number(headers.get("X-RateLimit-Reset"));
  return Number.isFinite(reset) ? Math.max(0, reset - now) : 0;
}

function parseCache(serialized?: string): Record<string, CachedPage> {
  if (!serialized) return {};
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new GitHubError("Stored GitHub cache is invalid");
  }
  if (!isRecord(value)) throw new GitHubError("Stored GitHub cache is invalid");
  const pages: Record<string, CachedPage> = {};
  for (const [key, page] of Object.entries(value)) {
    if (
      !/^\d+$/.test(key) ||
      !isRecord(page) ||
      typeof page.etag !== "string" ||
      !Array.isArray(page.releases) ||
      typeof page.has_next !== "boolean"
    ) {
      throw new GitHubError("Stored GitHub cache is invalid");
    }
    pages[key] = { etag: page.etag, releases: page.releases, has_next: page.has_next };
  }
  return pages;
}

export class GitHubClient {
  private readonly headers: Record<string, string>;

  constructor(
    readonly repository: string,
    token = "",
    private readonly request: typeof fetch = fetch,
    private readonly wait: typeof sleep = sleep,
  ) {
    this.headers = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "freshgram-updates-notify",
    };
    if (token) this.headers.Authorization = `Bearer ${token}`;
  }

  async fetchReleases(previousCache?: string, signal?: AbortSignal): Promise<ReleaseSnapshot> {
    const cachedPages = parseCache(previousCache);
    const pages: Record<string, CachedPage> = {};
    const releases: Release[] = [];
    for (let page = 1; page <= 1000; page += 1) {
      const result = await this.fetchPage(page, cachedPages[String(page)], signal);
      pages[String(page)] = result;
      for (const payload of result.releases) {
        if (!isRecord(payload) || typeof payload.draft !== "boolean") {
          throw new GitHubError("GitHub returned an invalid release");
        }
        if (payload.draft) continue;
        try {
          releases.push(parseRelease(payload, this.repository));
        } catch {
          throw new GitHubError("GitHub returned invalid release metadata");
        }
      }
      if (!result.has_next) return { releases, cache: JSON.stringify(pages) };
    }
    throw new GitHubError("GitHub pagination exceeded the safety limit");
  }

  private async fetchPage(
    page: number,
    cached?: CachedPage,
    signal?: AbortSignal,
  ): Promise<CachedPage> {
    const headers = { ...this.headers };
    if (cached?.etag) headers["If-None-Match"] = cached.etag;
    const url = `https://api.github.com/repos/${this.repository}/releases?per_page=100&page=${page}`;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      signal?.throwIfAborted();
      const timeout = AbortSignal.timeout(30_000);
      try {
        const response = await this.request(url, {
          headers,
          redirect: "error",
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
        if (response.status === 304) {
          if (!cached) throw new GitHubError("GitHub returned 304 without a cached page");
          return cached;
        }
        if (response.status !== 200) {
          await response.body?.cancel();
          if (response.status === 403 || response.status === 429) {
            throw new GitHubError(
              `GitHub API refused request (HTTP ${response.status})`,
              Math.max(60, retryDelay(response.headers)),
            );
          }
          if (response.status < 500 || attempt === 2) {
            throw new GitHubError(`GitHub API request failed (HTTP ${response.status})`);
          }
        } else {
          let payloads: unknown;
          try {
            payloads = await response.json();
          } catch {
            throw new GitHubError("GitHub returned an invalid JSON response");
          }
          if (!Array.isArray(payloads))
            throw new GitHubError("GitHub returned an unexpected response");
          return {
            etag: response.headers.get("ETag") ?? "",
            releases: payloads,
            has_next: /rel="next"/.test(response.headers.get("Link") ?? ""),
          };
        }
      } catch (error) {
        signal?.throwIfAborted();
        if (error instanceof GitHubError) throw error;
        if (attempt === 2) throw new GitHubError("GitHub network request failed");
      }
      await this.wait(2 ** attempt, signal);
    }
    throw new GitHubError("GitHub retries exhausted");
  }
}
