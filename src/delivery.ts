import { type Api, GrammyError, HttpError } from "grammy";
import type { Database } from "./database.js";
import { ErrorReporter } from "./errors.js";
import { releaseMessage } from "./messages.js";
import { parseRelease } from "./releases.js";
import { telegramSignal } from "./telegram-signal.js";
import { nowSeconds, sleep } from "./timing.js";

export const maxAttempts = 5;

export class DeliveryWorker {
  constructor(
    private readonly database: Database,
    private readonly api: Pick<Api, "sendMessage">,
    private readonly repository: string,
    private readonly now: () => number = nowSeconds,
    private readonly reporter = new ErrorReporter(api),
  ) {}

  async deliverOnce(signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted();
    const now = this.now();
    if (Number(this.database.getMetadata("telegram_resume_at") ?? "0") > now) return false;
    const delivery = this.database.claimDelivery(now);
    if (!delivery) return false;
    const { release_id: releaseId, user_id: userId, attempts } = delivery;
    if (attempts > maxAttempts) {
      this.database.finishDelivery(releaseId, userId, "failed");
      return true;
    }
    const payload: unknown = JSON.parse(delivery.payload);
    const { text, keyboard } = releaseMessage(parseRelease(payload, this.repository));
    try {
      await this.api.sendMessage(
        userId,
        text,
        {
          reply_markup: keyboard,
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        },
        signal ? telegramSignal(signal) : undefined,
      );
      this.database.finishDelivery(releaseId, userId, "sent");
    } catch (error) {
      signal?.throwIfAborted();
      const state = attempts >= maxAttempts ? "failed" : "pending";
      if (error instanceof GrammyError && error.error_code === 403) {
        this.database.deactivateUser(userId);
      } else if (error instanceof GrammyError && error.error_code === 429) {
        const retryAt = this.now() + Math.max(1, error.parameters.retry_after ?? 60);
        this.database.pauseDelivery(releaseId, userId, state, retryAt);
        console.warn("Telegram flood limit; delivery paused");
      } else if (
        error instanceof HttpError ||
        (error instanceof GrammyError && error.error_code >= 500)
      ) {
        this.database.finishDelivery(
          releaseId,
          userId,
          state,
          this.now() + Math.min(3600, 30 * 2 ** attempts),
        );
        console.warn("Telegram delivery failed temporarily");
      } else if (error instanceof GrammyError) {
        this.database.finishDelivery(releaseId, userId, "failed");
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
      const delivered = await this.deliverOnce(signal);
      await sleep(delivered ? 0.05 : 1, signal);
    }
  }
}
