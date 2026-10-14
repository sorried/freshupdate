import asyncio
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from freshupdate import config as config_module
from freshupdate.__main__ import instance_lock, main, run
from freshupdate.config import Config, ConfigurationError
from freshupdate.database import Database


def test_single_instance_lock(tmp_path: Path) -> None:
    path = tmp_path / "bot.db"
    with instance_lock(path):
        with pytest.raises(ConfigurationError):
            with instance_lock(path):
                pytest.fail("second instance acquired the lock")
    with instance_lock(path):
        pass


def test_missing_token_exits_cleanly(caplog: pytest.LogCaptureFixture) -> None:
    with patch("freshupdate.__main__.Config.from_env", side_effect=ConfigurationError("BOT_TOKEN")):
        with pytest.raises(SystemExit) as exit_code:
            main()
    assert exit_code.value.code == 1
    assert "BOT_TOKEN" in caplog.text


async def test_runtime_closes_sessions_and_cancels_workers(tmp_path: Path) -> None:
    bot = AsyncMock()
    bot.get_me.return_value = MagicMock(username="testbot", id=123)
    bot.get_webhook_info.return_value = MagicMock(url="")
    bot.__aenter__.return_value = bot
    session = AsyncMock()
    session.__aenter__.return_value = session
    dispatcher = MagicMock()
    dispatcher.start_polling = AsyncMock()
    stopped = []

    async def worker() -> None:
        try:
            await asyncio.Future()
        finally:
            stopped.append(True)

    async def polling(*args, **kwargs) -> None:
        await asyncio.sleep(0)

    dispatcher.start_polling.side_effect = polling
    path = tmp_path / "bot.db"
    with (
        patch("freshupdate.__main__.Bot", return_value=bot),
        patch("freshupdate.__main__.aiohttp.ClientSession", return_value=session),
        patch("freshupdate.__main__.Dispatcher", return_value=dispatcher),
        patch("freshupdate.__main__.ReleaseTracker.run", side_effect=worker),
        patch("freshupdate.__main__.DeliveryWorker.run", side_effect=worker),
    ):
        await run(Config("123456789:" + "a" * 35, database_path=path))
    assert len(stopped) == 2
    bot.__aexit__.assert_awaited_once()
    session.__aexit__.assert_awaited_once()
    commands = bot.set_my_commands.call_args.args[0]
    assert [command.command for command in commands] == ["start", "about"]
    database = Database(path)
    database.register_user(1, 0)
    database.close()


def test_dotenv_is_loaded_from_working_directory(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.chdir(tmp_path)
    token = "123456789:" + "a" * 35
    (tmp_path / ".env").write_text(f"BOT_TOKEN={token}\nCHECK_INTERVAL_SECONDS=450\n")
    monkeypatch.delenv("BOT_TOKEN", raising=False)
    monkeypatch.delenv("CHECK_INTERVAL_SECONDS", raising=False)
    try:
        assert config_module.Config.from_env().check_interval == 450
        assert config_module.Config.from_env().bot_token == token
    finally:
        monkeypatch.delenv("BOT_TOKEN", raising=False)
        monkeypatch.delenv("CHECK_INTERVAL_SECONDS", raising=False)
