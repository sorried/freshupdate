import { type Api, GrammyError, HttpError } from "grammy";
import type { Database } from "./database.js";
import { ErrorReporter } from "./errors.js";
import { GitHubClient } from "./github.js";
import { releasemessage } from "./messages.js";
import { parserelease } from "./releases.js";
import { telegramsignal } from "./telegram-signal.js";
import { nowseconds, sleep } from "./timing.js";

export const maxattempts = 5;

export class DeliveryWorker {
  constructor(
    private readonly database: Database,
    private readonly api: Pick<Api, "sendMessage">,
    private readonly repository: string,
    private readonly now: () => number = nowseconds,
    private readonly reporter = new ErrorReporter(api),
    private readonly github = new GitHubClient(repository),
  ) {}

  async deliveronce(signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted();
    const now = this.now();
    if (Number(this.database.getmetadata("telegram_resume_at") ?? "0") > now) return false;
    const delivery = this.database.claimdelivery(now);
    if (!delivery) return false;
    const { release_id: releaseid, user_id: userid, attempts } = delivery;
    if (attempts > maxattempts) {
      this.database.finishdelivery(releaseid, userid, "failed");
      return true;
    }
    const payload: unknown = JSON.parse(delivery.payload);
    const release = await this.github.withchangelog(parserelease(payload, this.repository), signal);
    const { text, keyboard } = releasemessage(release);
    try {
      await this.api.sendMessage(
        userid,
        text,
        {
          reply_markup: keyboard,
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        },
        signal ? telegramsignal(signal) : undefined,
      );
      this.database.finishdelivery(releaseid, userid, "sent");
    } catch (error) {
      signal?.throwIfAborted();
      const state = attempts >= maxattempts ? "failed" : "pending";
      if (error instanceof GrammyError && error.error_code === 403) {
        this.database.deactivateuser(userid);
      } else if (error instanceof GrammyError && error.error_code === 429) {
        const retryat = this.now() + Math.max(1, error.parameters.retry_after ?? 60);
        this.database.pausedelivery(releaseid, userid, state, retryat);
        console.warn("Telegram flood limit; delivery paused");
      } else if (
        error instanceof HttpError ||
        (error instanceof GrammyError && error.error_code >= 500)
      ) {
        this.database.finishdelivery(
          releaseid,
          userid,
          state,
          this.now() + Math.min(3600, 30 * 2 ** attempts),
        );
        console.warn("Telegram delivery failed temporarily");
      } else if (error instanceof GrammyError) {
        this.database.finishdelivery(releaseid, userid, "failed");
        console.warn("Telegram rejected a delivery");
      } else {
        throw error;
      }
      await this.reporter.report("delivery", error);
    }
    return true;
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const delivered = await this.deliveronce(signal);
      await sleep(delivered ? 0.05 : 1, signal);
    }
  }
}
