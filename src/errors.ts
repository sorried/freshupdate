import type { Api, Context } from "grammy";
import { GrammyError, HttpError } from "grammy";

export const ownerid = 994782321;
export const failuremessage = "(╥﹏╥) что-то пошло не так. попробуй немного позже.";

export class ErrorReporter {
  private readonly lastreports = new Map<string, number>();
  private pauseduntil = 0;

  constructor(
    private readonly api: Pick<Api, "sendMessage">,
    private readonly secrets: readonly string[] = [],
    private readonly now: () => number = Date.now,
  ) {}

  async report(scope: string, error: unknown): Promise<void> {
    const now = this.now();
    if (now < this.pauseduntil || now - (this.lastreports.get(scope) ?? -Infinity) < 300_000)
      return;
    this.lastreports.set(scope, now);
    let details =
      error instanceof GrammyError
        ? `telegram ${error.error_code}: ${error.description}`
        : error instanceof HttpError
          ? "telegram network request failed"
          : error instanceof Error
            ? (error.stack ?? error.message)
            : "unknown error";
    for (const secret of this.secrets) {
      if (secret) details = details.replaceAll(secret, "[redacted]");
    }
    details = details
      .replace(
        /\b\d{5,}:[A-Za-z0-9_-]{20,}\b|\bgh[pousr]_[A-Za-z0-9_]+\b|github_pat_[A-Za-z0-9_]+/g,
        "[redacted]",
      )
      .replace(/\b(Bearer|token)\s+\S+/gi, "$1 [redacted]");
    details = details.replace(
      /\p{Extended_Pictographic}|\p{Regional_Indicator}|\uFE0F|\u200D|\u20E3/gu,
      "",
    );
    console.warn(`Application error: ${scope}`);
    try {
      await this.api.sendMessage(ownerid, `(╥﹏╥) ошибка: ${scope}\n\n${details.slice(0, 3000)}`, {
        link_preview_options: { is_disabled: true },
      });
    } catch (notificationerror) {
      if (notificationerror instanceof GrammyError && notificationerror.error_code === 429) {
        this.pauseduntil = now + Math.max(1, notificationerror.parameters.retry_after ?? 60) * 1000;
      }
      console.warn("Owner error notification could not be delivered");
    }
  }

  async handleupdate(context: Context, error: unknown): Promise<void> {
    await this.report("update", error);
    if (context.chat?.type !== "private" || context.from?.id === ownerid) return;
    try {
      await context.reply(failuremessage);
    } catch {
      console.warn("Generic error reply could not be delivered");
    }
  }
}
