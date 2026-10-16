import { InlineKeyboard } from "grammy";
import { type Release, releasechanges } from "./releases.js";

export const sourceurl = "https://github.com/Snowy-Fluffy/freshGram";
export const botsourceurl = "https://github.com/sorried/freshupdate";
export const startmessage =
  "(￣▽￣)ノ <b>привет! это freshGram updates notify.</b>\n\n" +
  "я слежу за новыми релизами freshGram и автоматически сообщаю о них здесь. " +
  "подписка на обновления включена: когда выйдет новая версия, я пришлю её номер, " +
  "список изменений и ссылку на релиз. ничего дополнительно настраивать не нужно.\n\n" +
  "старые версии присылать не буду, только новые публикации. " +
  "бот независимый и не связан с командой freshGram.";
export const aboutmessage =
  "(｡•̀ᴗ-)✧ <b>о freshGram</b>\n\n" +
  "freshGram - форк Telegram Desktop. он сочетает material design-оформление " +
  "materialgram с возможностями AyuGram Desktop.\n\n" +
  "в документации описаны гибкий ghost mode, локальная история изменений " +
  "и удалённых сообщений, настройка шрифтов и внешнего вида.\n\n" +
  `<a href="${sourceurl}">исходный проект</a>\n` +
  `<a href="${sourceurl}/releases">все релизы</a>\n\n` +
  "этот бот - независимый проект, который уведомляет о новых релизах.\n\n" +
  `<a href="${botsourceurl}">исходный код бота</a>`;
export const jailmessage =
  "(￣▽￣) немного притормозим: команды приходят слишком часто. " +
  "сделаем паузу на 5 минут, после неё меню снова будет доступно. " +
  "подписка остаётся включённой, уведомления об обновлениях продолжат приходить.";

export function startkeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .url("исходный проект", sourceurl)
    .url("все релизы", `${sourceurl}/releases`)
    .row()
    .text("о проекте", "about");
}

export function htmltext(value: string, limit: number): string {
  const plain = value
    .replace(/\p{Extended_Pictographic}|\p{Regional_Indicator}|\uFE0F|\u200D|\u20E3/gu, "")
    .replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, (character) => (character === "\n" ? "\n" : ""))
    .trim();
  let text = "";
  for (const character of plain) {
    const escaped = character
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
    if (text.length + escaped.length > limit - 1) return `${text}…`;
    text += escaped;
  }
  return text;
}

export function releasemessage(release: Release): { text: string; keyboard: InlineKeyboard } {
  const version = htmltext(release.tag_name, 200);
  const changes = releasechanges(release.body);
  const summary = changes
    .slice(0, 5)
    .map((change) => `- ${change}`)
    .join("\n");
  const description = summary
    ? htmltext(`${summary}${changes.length > 5 ? "\n…" : ""}`, 900)
    : "вышло обновление. подробности доступны по кнопке ниже.";
  const text = `(｡•̀ᴗ-)✧ <b>freshGram ${version}</b>\n\n${description}`;
  const keyboard = new InlineKeyboard().url("открыть релиз", release.html_url);
  return { text, keyboard };
}
