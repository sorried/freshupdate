import { isrecord, parserelease, type Release, releasechanges } from "./releases.js";
import { nowseconds, sleep } from "./timing.js";

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly retryafter = 0,
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

export function retrydelay(headers: Headers, now = nowseconds()): number {
  const retryafter = headers.get("Retry-After");
  if (retryafter !== null) {
    const seconds = Number(retryafter);
    if (retryafter.trim() && Number.isFinite(seconds)) return Math.max(0, seconds);
    const date = Date.parse(retryafter);
    if (Number.isFinite(date)) return Math.max(0, date / 1000 - now);
  }
  const reset = Number(headers.get("X-RateLimit-Reset"));
  return Number.isFinite(reset) ? Math.max(0, reset - now) : 0;
}

function parsecache(serialized?: string): Record<string, CachedPage> {
  if (!serialized) return {};
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new GitHubError("Stored GitHub cache is invalid");
  }
  if (!isrecord(value)) throw new GitHubError("Stored GitHub cache is invalid");
  const pages: Record<string, CachedPage> = {};
  for (const [key, page] of Object.entries(value)) {
    if (
      !/^\d+$/.test(key) ||
      !isrecord(page) ||
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
  private readonly notes = new Map<string, { expires: number; body: Promise<string> }>();

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

  async fetchreleases(previouscache?: string, signal?: AbortSignal): Promise<ReleaseSnapshot> {
    const cachedpages = parsecache(previouscache);
    const pages: Record<string, CachedPage> = {};
    const releases: Release[] = [];
    for (let page = 1; page <= 1000; page += 1) {
      const result = await this.fetchpage(page, cachedpages[String(page)], signal);
      pages[String(page)] = result;
      for (const payload of result.releases) {
        if (!isrecord(payload) || typeof payload.draft !== "boolean") {
          throw new GitHubError("GitHub returned an invalid release");
        }
        if (payload.draft) continue;
        try {
          releases.push(parserelease(payload, this.repository));
        } catch {
          throw new GitHubError("GitHub returned invalid release metadata");
        }
      }
      if (!result.has_next) return { releases, cache: JSON.stringify(pages) };
    }
    throw new GitHubError("GitHub pagination exceeded the safety limit");
  }

  async withchangelog(release: Release, signal?: AbortSignal): Promise<Release> {
    signal?.throwIfAborted();
    if (releasechanges(release.body).length) return release;
    const links = release.body.match(/https:\/\/github\.com\/[^\s<>"')\]]+/g) ?? [];
    for (const link of links) {
      const url = new URL(link);
      const prefix = `/${this.repository}/compare/`;
      if (!url.pathname.startsWith(prefix) || url.search || url.hash) continue;
      const comparison = url.pathname.slice(prefix.length);
      const refs = comparison.split("...");
      if (refs.length !== 2 || !refs[0] || !refs[1]) continue;
      try {
        if (decodeURIComponent(refs[1]) !== release.tag_name) continue;
      } catch {
        continue;
      }
      const cached = this.notes.get(comparison);
      let body = cached && cached.expires > Date.now() ? cached.body : undefined;
      if (!body) {
        body = this.fetchchangelog(comparison, signal);
        this.notes.delete(comparison);
        this.notes.set(comparison, { expires: Date.now() + 300_000, body });
        if (this.notes.size > 50) {
          const oldest = this.notes.keys().next().value;
          if (oldest !== undefined) this.notes.delete(oldest);
        }
      }
      return { ...release, body: (await body) || release.body };
    }
    return release;
  }

  private async fetchchangelog(comparison: string, signal?: AbortSignal): Promise<string> {
    try {
      const response = await this.request(
        `https://api.github.com/repos/${this.repository}/compare/${comparison}?per_page=100`,
        {
          headers: this.headers,
          redirect: "error",
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
            : AbortSignal.timeout(10_000),
        },
      );
      if (response.status !== 200) {
        await response.body?.cancel();
        return "";
      }
      const payload: unknown = await response.json();
      if (!isrecord(payload) || !Array.isArray(payload.commits)) return "";
      const changes = new Set<string>();
      for (const entry of payload.commits) {
        if (!isrecord(entry) || !isrecord(entry.commit) || typeof entry.commit.message !== "string")
          continue;
        const subject = entry.commit.message.split(/\r?\n/)[0]?.trim() ?? "";
        if (
          /^(?:merge\b|(?:beta\s+)?version\s|(?:chore|build|ci|docs)(?:\([^)]*\))?:|bump\b)/i.test(
            subject,
          )
        )
          continue;
        if (subject) changes.add(subject.replace(/\s*\[skip ci\]/gi, ""));
      }
      return [...changes].map((change) => `- ${change}`).join("\n");
    } catch {
      signal?.throwIfAborted();
      return "";
    }
  }

  private async fetchpage(
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
              Math.max(60, retrydelay(response.headers)),
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
