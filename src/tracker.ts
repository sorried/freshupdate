import type { Database } from "./database.js";
import type { ErrorReporter } from "./errors.js";
import { type GitHubClient, GitHubError } from "./github.js";
import { nowSeconds, sleep } from "./timing.js";

export class ReleaseTracker {
  constructor(
    private readonly database: Database,
    private readonly github: GitHubClient,
    private readonly interval: number,
    private readonly includePrereleases: boolean,
    private readonly reporter?: ErrorReporter,
  ) {}

  async pollOnce(signal?: AbortSignal): Promise<number> {
    const snapshot = await this.github.fetchReleases(
      this.database.getMetadata("github_cache"),
      signal,
    );
    signal?.throwIfAborted();
    return this.database.ingestReleases(
      snapshot.releases,
      this.github.repository,
      snapshot.cache,
      this.includePrereleases,
    );
  }

  async run(signal: AbortSignal): Promise<void> {
    let failures = 0;
    while (!signal.aborted) {
      let delay = this.interval;
      this.database.cleanup(nowSeconds());
      try {
        const count = await this.pollOnce(signal);
        failures = 0;
        if (count) console.info(`Queued ${count} new releases`);
      } catch (error) {
        signal.throwIfAborted();
        if (!(error instanceof GitHubError)) throw error;
        failures = Math.min(failures + 1, 6);
        delay = Math.max(this.interval, error.retryAfter, Math.min(3600, 30 * 2 ** failures));
        console.warn(`${error.message}; retrying in ${Math.ceil(delay)} seconds`);
        await this.reporter?.report("github", error);
      }
      await sleep(delay, signal);
    }
  }
}
