import type { Database } from "./database.js";
import type { ErrorReporter } from "./errors.js";
import { type GitHubClient, GitHubError } from "./github.js";
import { nowseconds, sleep } from "./timing.js";

export class ReleaseTracker {
  constructor(
    private readonly database: Database,
    private readonly github: GitHubClient,
    private readonly interval: number,
    private readonly includeprereleases: boolean,
    private readonly reporter?: ErrorReporter,
  ) {}

  async pollonce(signal?: AbortSignal): Promise<number> {
    const snapshot = await this.github.fetchreleases(
      this.database.getmetadata("github_cache"),
      signal,
    );
    signal?.throwIfAborted();
    return this.database.ingestreleases(
      snapshot.releases,
      this.github.repository,
      snapshot.cache,
      this.includeprereleases,
    );
  }

  async run(signal: AbortSignal): Promise<void> {
    let failures = 0;
    while (!signal.aborted) {
      let delay = this.interval;
      this.database.cleanup(nowseconds());
      try {
        const count = await this.pollonce(signal);
        failures = 0;
        if (count) console.info(`Queued ${count} new releases`);
      } catch (error) {
        signal.throwIfAborted();
        if (!(error instanceof GitHubError)) throw error;
        failures = Math.min(failures + 1, 6);
        delay = Math.max(this.interval, error.retryafter, Math.min(3600, 30 * 2 ** failures));
        console.warn(`${error.message}; retrying in ${Math.ceil(delay)} seconds`);
        await this.reporter?.report("github", error);
      }
      await sleep(delay, signal);
    }
  }
}
