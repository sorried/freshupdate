from unittest.mock import AsyncMock

import pytest
from aiogram.exceptions import (
    TelegramBadRequest,
    TelegramForbiddenError,
    TelegramNetworkError,
    TelegramRetryAfter,
    TelegramServerError,
)
from aiogram.methods import SendMessage
from conftest import release

from freshupdate.database import Database
from freshupdate.delivery import DeliveryWorker


@pytest.fixture
def queued(database: Database) -> Database:
    for user in (1, 2):
        database.register_user(user, 0)
    database.ingest_releases([], "Snowy-Fluffy/freshGram", "{}", True)
    database.ingest_releases([release(1)], "Snowy-Fluffy/freshGram", "{}", True)
    return database


def api_method() -> SendMessage:
    return SendMessage(chat_id=1, text="test")


async def test_blocked_user_does_not_stop_broadcast(queued: Database) -> None:
    bot = AsyncMock()
    bot.send_message.side_effect = [TelegramForbiddenError(api_method(), "blocked"), None]
    worker = DeliveryWorker(queued, bot)
    assert await worker.deliver_once()
    assert await worker.deliver_once()
    assert not await worker.deliver_once()
    assert (
        queued.connection.execute("SELECT is_active FROM users WHERE user_id=1").fetchone()[0] == 0
    )
    assert (
        queued.connection.execute("SELECT state FROM deliveries WHERE user_id=2").fetchone()[0]
        == "sent"
    )


async def test_flood_limit_is_persisted(queued: Database, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("freshupdate.delivery.time.time", lambda: 100)
    bot = AsyncMock()
    bot.send_message.side_effect = TelegramRetryAfter(api_method(), "flood", retry_after=120)
    worker = DeliveryWorker(queued, bot)
    assert await worker.deliver_once()
    assert queued.get_metadata("telegram_resume_at") == "220"
    assert not await DeliveryWorker(queued, bot).deliver_once()
    assert bot.send_message.call_count == 1
    monkeypatch.setattr("freshupdate.delivery.time.time", lambda: 220)
    bot.send_message.side_effect = None
    assert await worker.deliver_once()


@pytest.mark.parametrize("error_type", [TelegramNetworkError, TelegramServerError])
async def test_transient_failure_and_bounded_retries(
    queued: Database,
    monkeypatch: pytest.MonkeyPatch,
    error_type: type,
) -> None:
    now = 100
    monkeypatch.setattr("freshupdate.delivery.time.time", lambda: now)
    bot = AsyncMock()
    bot.send_message.side_effect = error_type(api_method(), "failed")
    worker = DeliveryWorker(queued, bot)
    for _ in range(5):
        assert await worker.deliver_once()
        assert await worker.deliver_once()
        now += 4000
    assert not await worker.deliver_once()
    assert bot.send_message.call_count == 10
    assert (
        queued.connection.execute(
            "SELECT COUNT(*) FROM deliveries WHERE state='failed'"
        ).fetchone()[0]
        == 2
    )


async def test_permanent_error_isolated(queued: Database) -> None:
    bot = AsyncMock()
    bot.send_message.side_effect = [TelegramBadRequest(api_method(), "bad request"), None]
    worker = DeliveryWorker(queued, bot)
    await worker.deliver_once()
    await worker.deliver_once()
    assert not await worker.deliver_once()
    assert bot.send_message.call_count == 2


async def test_exhausted_attempt_after_crash_is_not_retried(queued: Database) -> None:
    queued.connection.execute("UPDATE deliveries SET attempts=5")
    queued.connection.commit()
    bot = AsyncMock()
    await DeliveryWorker(queued, bot).deliver_once()
    bot.send_message.assert_not_called()
