from pathlib import Path
from unittest.mock import patch

import pytest

from freshupdate.__main__ import instance_lock, main
from freshupdate.config import ConfigurationError


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
