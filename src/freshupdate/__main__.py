import asyncio
import fcntl
import logging
import os
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

import aiohttp
from aiogram import Bot, Dispatcher
from aiogram.client.session.aiohttp import AiohttpSession
from aiogram.exceptions import TelegramAPIError
from aiogram.types import BotCommand

from freshupdate.config import Config, ConfigurationError
from freshupdate.database import Database
from freshupdate.delivery import DeliveryWorker
from freshupdate.github import GitHubClient
from freshupdate.handlers import create_router
from freshupdate.tracker import ReleaseTracker

logger = logging.getLogger(__name__)


@contextmanager
def instance_lock(database_path: Path) -> Iterator[None]:
    database_path.parent.mkdir(parents=True, exist_ok=True)
    with database_path.with_suffix(database_path.suffix + ".lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise ConfigurationError("Бот уже запущен с этой базой данных.") from error
        yield


async def run(config: Config) -> None:
    with instance_lock(config.database_path):
        database = Database(config.database_path)
        try:
            stored_repository = database.get_metadata("repository")
            if stored_repository is not None and stored_repository != config.repository:
                raise ConfigurationError("Для другого GITHUB_REPOSITORY нужна отдельная база.")
            async with (
                Bot(config.bot_token, session=AiohttpSession(timeout=30)) as bot,
                aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=30)) as session,
            ):
                identity = await bot.get_me()
                logger.info("Authenticated bot @%s (bot ID %s)", identity.username, identity.id)
                webhook = await bot.get_webhook_info()
                if webhook.url:
                    raise ConfigurationError(
                        "Настроен webhook. Отключите его перед polling-запуском."
                    )
                await bot.set_my_commands(
                    [
                        BotCommand(command="start", description="начальное меню"),
                        BotCommand(command="about", description="информация о проекте"),
                    ]
                )
                dispatcher = Dispatcher()
                dispatcher.include_router(create_router(database))
                tracker = ReleaseTracker(
                    database,
                    GitHubClient(session, config.repository, config.github_token),
                    config.check_interval,
                    config.include_prereleases,
                )
                async with asyncio.TaskGroup() as tasks:
                    polling = tasks.create_task(tracker.run())
                    delivery = tasks.create_task(DeliveryWorker(database, bot).run())
                    try:
                        await dispatcher.start_polling(
                            bot,
                            handle_as_tasks=False,
                            close_bot_session=False,
                            allowed_updates=["message", "callback_query"],
                        )
                    finally:
                        polling.cancel()
                        delivery.cancel()
        finally:
            database.close()


def main() -> None:
    os.umask(0o077)
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s"
    )
    logging.getLogger("aiogram").setLevel(logging.CRITICAL)
    try:
        asyncio.run(run(Config.from_env()))
    except ConfigurationError as error:
        logger.error("%s", error)
        raise SystemExit(1) from None
    except (TelegramAPIError, aiohttp.ClientError, TimeoutError):
        logger.error("Не удалось подключиться к API. Проверьте токен и доступ к сети.")
        raise SystemExit(1) from None
    except (OSError, sqlite3.Error, ExceptionGroup) as error:
        logger.error(
            "Приложение остановлено: %s. Проверьте хранилище и конфигурацию.", type(error).__name__
        )
        raise SystemExit(1) from None
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
