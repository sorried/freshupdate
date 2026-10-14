import { InlineKeyboard } from "grammy";
import type { Release } from "./releases.js";

export const sourceUrl = "https://github.com/Snowy-Fluffy/freshGram";
export const botSourceUrl = "https://github.com/sorried/freshupdate";
export const startMessage =
  "(￣▽￣)ノ <b>привет! это freshGram updates notify.</b>\n\n" +
  "я слежу за новыми релизами freshGram и автоматически сообщаю о них здесь. " +
  "ты уже зарегистрирован: дополнительных действий не требуется.\n\n" +
  "уведомления будут приходить о новых публикациях, а не обо всех старых версиях. " +
  "бот независимый и не связан с командой freshGram.";
export const aboutMessage =
  "(｡•̀ᴗ-)✧ <b>о freshGram</b>\n\n" +
  "freshGram - форк Telegram Desktop. он сочетает material design-оформление " +
  "materialgram с возможностями AyuGram Desktop.\n\n" +
  "в документации описаны гибкий ghost mode, локальная история изменений " +
  "и удалённых сообщений, настройка шрифтов и внешнего вида.\n\n" +
  `<a href="${sourceUrl}">исходный проект</a>\n` +
  `<a href="${sourceUrl}/releases">все релизы</a>\n\n` +
  "этот бот - независимый проект, который уведомляет о новых релизах.\n\n" +
  `<a href="${botSourceUrl}">исходный код бота</a>`;
export const jailMessage =
  "(╥﹏╥) ты временно заблокирован за спам командами. попробуй снова через 5 минут.";

export function startKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .url("исходный проект", sourceUrl)
    .url("все релизы", `${sourceUrl}/releases`)
    .row()
    .text("о проекте", "about");
}

export function htmlText(value: string, limit: number): string {
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

export function releaseMessage(release: Release): { text: string; keyboard: InlineKeyboard } {
  const title = htmlText(release.name, 300);
  const version = htmlText(release.tag_name, 200);
  const description = htmlText(release.body, 1800) || "описание изменений не опубликовано.";
  const published = new Date(release.published_at).toISOString().slice(0, 16).replace("T", " ");
  const repositoryUrl = release.html_url.split("/releases/tag/")[0];
  const text =
    `(｡•̀ᴗ-)✧ <b>новый релиз freshGram!</b>\n\n<b>${title}</b>\n` +
    `версия: <code>${version}</code>\nопубликован: ${published} utc\n\n${description}\n\n` +
    "полное описание и файлы доступны по кнопке ниже.";
  const keyboard = new InlineKeyboard()
    .url("открыть релиз", release.html_url)
    .url("все релизы", `${repositoryUrl}/releases`);
  return { text, keyboard };
}
