import logging

from aiogram import F, Router
from aiogram.exceptions import TelegramAPIError
from aiogram.filters import Command
from aiogram.filters.command import CommandObject
from aiogram.types import CallbackQuery, ErrorEvent, Message

from freshupdate.antispam import JAIL_MESSAGE, check_command
from freshupdate.database import Database
from freshupdate.messages import ABOUT_MESSAGE, START_MESSAGE, start_keyboard

logger = logging.getLogger(__name__)


async def reply_to_command(message: Message, database: Database, command: str) -> None:
    if message.from_user is None or message.chat.type != "private":
        return
    decision = check_command(database, message.from_user.id, command)
    if decision == "blocked":
        return
    text = (
        JAIL_MESSAGE
        if decision == "jailed"
        else (START_MESSAGE if command == "start" else ABOUT_MESSAGE)
    )
    try:
        await message.answer(
            text,
            parse_mode="HTML",
            disable_web_page_preview=True,
            reply_markup=start_keyboard() if command == "start" and decision == "allowed" else None,
        )
    except TelegramAPIError:
        logger.warning("Telegram rejected a command reply")


def create_router(database: Database) -> Router:
    router = Router()

    @router.message(Command("start", "about"), F.chat.type == "private")
    async def command_handler(message: Message, command: CommandObject) -> None:
        await reply_to_command(message, database, command.command)

    @router.callback_query(F.data == "about", F.message.chat.type == "private")
    async def about_callback(query: CallbackQuery) -> None:
        decision = check_command(database, query.from_user.id, "about")
        try:
            await query.answer()
            if decision != "blocked":
                await query.bot.send_message(
                    query.from_user.id,
                    JAIL_MESSAGE if decision == "jailed" else ABOUT_MESSAGE,
                    parse_mode="HTML",
                    disable_web_page_preview=True,
                )
        except TelegramAPIError:
            logger.warning("Telegram rejected an information reply")

    @router.errors()
    async def handle_error(event: ErrorEvent) -> bool:
        logger.error("Update handling failed: %s", type(event.exception).__name__)
        return True

    return router
