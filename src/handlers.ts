import { type Bot, type Context, GrammyError, HttpError } from "grammy";
import { checkCommand } from "./antispam.js";
import type { Command, Database } from "./database.js";
import { aboutMessage, jailMessage, startKeyboard, startMessage } from "./messages.js";

export async function replyToCommand(
  context: Context,
  database: Database,
  command: Command,
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
    if (!(error instanceof GrammyError || error instanceof HttpError)) throw error;
    console.warn("Telegram rejected a command reply");
  }
}

export function registerHandlers(bot: Bot, database: Database): void {
  bot.command("start", (context) => replyToCommand(context, database, "start"));
  bot.command("about", (context) => replyToCommand(context, database, "about"));
  bot.callbackQuery("about", async (context) => {
    if (context.chat?.type !== "private") return;
    try {
      await context.answerCallbackQuery();
    } catch (error) {
      if (!(error instanceof GrammyError || error instanceof HttpError)) throw error;
      console.warn("Telegram rejected a callback acknowledgement");
    }
    await replyToCommand(context, database, "about");
  });
  bot.catch(({ error }) => {
    if (!(error instanceof GrammyError || error instanceof HttpError)) throw error;
    console.warn("Telegram update request failed");
  });
}
