import re
from datetime import datetime
from html import escape
from typing import Any

from aiogram.types import InlineKeyboardButton, InlineKeyboardMarkup

SOURCE_URL = "https://github.com/Snowy-Fluffy/freshGram"
BOT_SOURCE_URL = "https://github.com/sorried/freshupdate"

START_MESSAGE = (
    "(￣▽￣)ノ <b>привет! это freshGram updates notify.</b>\n\n"
    "я слежу за новыми релизами freshGram и автоматически сообщаю о них здесь. "
    "ты уже зарегистрирован: дополнительных действий не требуется.\n\n"
    "уведомления будут приходить о новых публикациях, а не обо всех старых версиях. "
    "бот независимый и не связан с командой freshGram."
)

ABOUT_MESSAGE = (
    "(｡•̀ᴗ-)✧ <b>о freshGram</b>\n\n"
    "freshGram - форк Telegram Desktop. он сочетает material design-оформление "
    "materialgram с возможностями AyuGram Desktop.\n\n"
    "в документации описаны гибкий ghost mode, локальная история изменений "
    "и удалённых сообщений, настройка шрифтов и внешнего вида.\n\n"
    f'<a href="{SOURCE_URL}">исходный проект</a>\n'
    f'<a href="{SOURCE_URL}/releases">все релизы</a>\n\n'
    "этот бот - независимый проект, который уведомляет о новых релизах.\n\n"
    f'<a href="{BOT_SOURCE_URL}">исходный код бота</a>'
)


def start_keyboard() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [
                InlineKeyboardButton(text="исходный проект", url=SOURCE_URL),
                InlineKeyboardButton(text="все релизы", url=f"{SOURCE_URL}/releases"),
            ],
            [InlineKeyboardButton(text="о проекте", callback_data="about")],
        ]
    )


def plain_text(value: str, limit: int) -> str:
    value = re.sub(r"[\U0001F000-\U0001FAFF\u2600-\u27BF\uFE0F\u200D\u20E3]", "", value)
    value = "".join(
        character for character in value if character.isprintable() or character == "\n"
    )
    value = value.strip()
    return value if len(value) <= limit else value[: limit - 1].rstrip() + "…"


def html_text(value: str, limit: int) -> str:
    characters = []
    length = 0
    for character in plain_text(value, limit):
        escaped = escape(character, quote=False)
        units = len(escaped.encode("utf-16-le")) // 2
        if length + units > limit - 1:
            return "".join(characters) + "…"
        characters.append(escaped)
        length += units
    return "".join(characters)


def release_message(release: dict[str, Any]) -> tuple[str, InlineKeyboardMarkup]:
    title = html_text(release["name"], 300)
    version = html_text(release["tag_name"], 200)
    description = html_text(release["body"], 1800) or "описание изменений не опубликовано."
    published = datetime.fromisoformat(release["published_at"].replace("Z", "+00:00"))
    release_url = release["html_url"]
    repository_url = release_url.split("/releases/tag/", 1)[0]
    text = (
        f"(｡•̀ᴗ-)✧ <b>новый релиз freshGram!</b>\n\n<b>{title}</b>\n"
        f"версия: <code>{version}</code>\n"
        f"опубликован: {published:%d.%m.%Y %H:%M} utc\n\n{description}\n\n"
        "полное описание и файлы доступны по кнопке ниже."
    )
    keyboard = InlineKeyboardMarkup(
        inline_keyboard=[
            [
                InlineKeyboardButton(text="открыть релиз", url=release_url),
                InlineKeyboardButton(text="все релизы", url=f"{repository_url}/releases"),
            ],
        ]
    )
    return text, keyboard
