import { type Bot, type Context, GrammyError, HttpError } from "grammy";
import { checkCommand } from "./antispam.js";
import type { Command, Database } from "./database.js";
import { ErrorReporter, ownerId } from "./errors.js";
import { GitHubClient } from "./github.js";
import {
  aboutMessage,
  jailMessage,
  releaseMessage,
  startKeyboard,
  startMessage,
} from "./messages.js";

export async function replyToCommand(
  context: Context,
  database: Database,
  command: Command,
  reporter = new ErrorReporter(context.api),
): Promise<void> {
  if (!context.from || context.chat?.type !== "private") return;
  const decision = checkCommand(database, context.from.id, command);
  if (decision === "blocked") return;
  const text =
    decision === "jailed" ? jailMessage : command === "start" ? startMessage : aboutMessage;
  try {
    await context.reply(text, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...(command === "start" && decision === "allowed" ? { reply_markup: startKeyboard() } : {}),
    });
  } catch (error) {
    if (decision === "jailed") await reporter.report("update", error);
    else throw error;
  }
}

export function registerHandlers(
  bot: Bot,
  database: Database,
  reporter = new ErrorReporter(bot.api),
  github = new GitHubClient("Snowy-Fluffy/freshGram"),
): void {
  bot.use(async (context, next) => {
    try {
      await next();
    } catch (error) {
      await reporter.handleUpdate(context, error);
    }
  });
  bot.command("start", (context) => replyToCommand(context, database, "start", reporter));
  bot.command("about", (context) => replyToCommand(context, database, "about", reporter));
  bot.hears("@test_send", async (context) => {
    if (context.from?.id !== ownerId || context.chat.type !== "private") return;
    const decision = checkCommand(database, ownerId, "about");
    if (decision === "blocked") return;
    if (decision === "jailed") {
      await context.reply(jailMessage);
      return;
    }
    const snapshot = await github.fetchReleases();
    const latest = [...snapshot.releases].sort(
      (left, right) =>
        Date.parse(right.published_at) - Date.parse(left.published_at) || right.id - left.id,
    )[0];
    if (!latest) {
      await context.reply("(￣▽￣)ノ опубликованных релизов пока нет.");
      return;
    }
    const { text, keyboard } = releaseMessage(latest);
    await context.reply(`(｡•̀ᴗ-)✧ тестовое уведомление, только для владельца.\n\n${text}`, {
      parse_mode: "HTML",
      reply_markup: keyboard,
      link_preview_options: { is_disabled: true },
    });
  });
  bot.callbackQuery("about", async (context) => {
    if (context.chat?.type !== "private") return;
    try {
      await context.answerCallbackQuery();
    } catch (error) {
      if (!(error instanceof GrammyError || error instanceof HttpError)) throw error;
      await reporter.report("callback", error);
    }
    await replyToCommand(context, database, "about", reporter);
  });
  bot.catch(({ ctx, error }) => reporter.handleUpdate(ctx, error));
}
