import { type Bot, type Context, GrammyError, HttpError } from "grammy";
import { checkcommand } from "./antispam.js";
import type { Command, Database } from "./database.js";
import { ErrorReporter, ownerid } from "./errors.js";
import { GitHubClient } from "./github.js";
import {
  aboutmessage,
  jailmessage,
  releasemessage,
  startkeyboard,
  startmessage,
} from "./messages.js";

export async function replytocommand(
  context: Context,
  database: Database,
  command: Command,
  reporter = new ErrorReporter(context.api),
): Promise<void> {
  if (!context.from || context.chat?.type !== "private") return;
  const decision = checkcommand(database, context.from.id, command);
  if (decision === "blocked") return;
  const text =
    decision === "jailed" ? jailmessage : command === "start" ? startmessage : aboutmessage;
  try {
    await context.reply(text, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...(command === "start" && decision === "allowed" ? { reply_markup: startkeyboard() } : {}),
    });
  } catch (error) {
    if (decision === "jailed") await reporter.report("update", error);
    else throw error;
  }
}

export function registerhandlers(
  bot: Bot,
  database: Database,
  reporter = new ErrorReporter(bot.api),
  github = new GitHubClient("Snowy-Fluffy/freshGram"),
): void {
  bot.use(async (context, next) => {
    try {
      await next();
    } catch (error) {
      await reporter.handleupdate(context, error);
    }
  });
  bot.command("start", (context) => replytocommand(context, database, "start", reporter));
  bot.command("about", (context) => replytocommand(context, database, "about", reporter));
  bot.hears("@test_send", async (context) => {
    if (context.from?.id !== ownerid || context.chat.type !== "private") return;
    const decision = checkcommand(database, ownerid, "about");
    if (decision === "blocked") return;
    if (decision === "jailed") {
      await context.reply(jailmessage);
      return;
    }
    const snapshot = await github.fetchreleases();
    const latest = [...snapshot.releases].sort(
      (left, right) =>
        Date.parse(right.published_at) - Date.parse(left.published_at) || right.id - left.id,
    )[0];
    if (!latest) {
      await context.reply("(￣▽￣)ノ опубликованных релизов пока нет.");
      return;
    }
    const { text, keyboard } = releasemessage(await github.withchangelog(latest));
    await context.reply(`тестовое уведомление, только для владельца.\n\n${text}`, {
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
    await replytocommand(context, database, "about", reporter);
  });
  bot.catch(({ ctx, error }) => reporter.handleupdate(ctx, error));
}
