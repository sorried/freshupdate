from unittest.mock import AsyncMock, MagicMock

from aiogram import Bot, Dispatcher
from aiogram.types import Update

from freshupdate.database import Database
from freshupdate.handlers import create_router, reply_to_command


def message(user_id=1, chat_type="private"):
    incoming = MagicMock()
    incoming.from_user.id = user_id
    incoming.chat.type = chat_type
    incoming.answer = AsyncMock()
    return incoming


async def test_one_jail_reply_and_no_more_responses(database: Database) -> None:
    incoming = message()
    for _ in range(10):
        await reply_to_command(incoming, database, "start")
    assert incoming.answer.call_count == 4
    replies = [call.args[0] for call in incoming.answer.call_args_list]
    assert sum("спам" in reply for reply in replies) == 1
    assert database.connection.execute("SELECT user_id FROM users").fetchone()[0] == 1


async def test_about_registers_user_and_groups_are_ignored(database: Database) -> None:
    await reply_to_command(message(2), database, "about")
    group = message(3, "group")
    await reply_to_command(group, database, "start")
    group.answer.assert_not_called()
    assert database.connection.execute("SELECT user_id FROM users").fetchone()[0] == 2


async def test_real_router_dispatches_only_two_commands(database: Database) -> None:
    bot = Bot("123456789:" + "a" * 35)
    bot.session = AsyncMock()
    dispatcher = Dispatcher()
    dispatcher.include_router(create_router(database))
    for update_id, command in enumerate(("start", "about", "help"), 1):
        update = Update.model_validate(
            {
                "update_id": update_id,
                "message": {
                    "message_id": update_id,
                    "date": 100,
                    "chat": {"id": 1, "type": "private"},
                    "from": {"id": 1, "is_bot": False, "first_name": "test"},
                    "text": f"/{command}",
                    "entities": [{"type": "bot_command", "offset": 0, "length": len(command) + 1}],
                },
            }
        )
        await dispatcher.feed_update(bot, update)
    assert bot.session.call_count == 2


async def test_about_button_shares_command_limit(database: Database) -> None:
    for _ in range(3):
        await reply_to_command(message(), database, "about")
    bot = Bot("123456789:" + "a" * 35)
    bot.session = AsyncMock()
    dispatcher = Dispatcher()
    dispatcher.include_router(create_router(database))
    for update_id in (1, 2):
        update = Update.model_validate(
            {
                "update_id": update_id,
                "callback_query": {
                    "id": str(update_id),
                    "from": {"id": 1, "is_bot": False, "first_name": "test"},
                    "chat_instance": "instance",
                    "data": "about",
                    "message": {"message_id": 1, "date": 100, "chat": {"id": 1, "type": "private"}},
                },
            }
        )
        await dispatcher.feed_update(bot, update)
    assert bot.session.call_count == 3
