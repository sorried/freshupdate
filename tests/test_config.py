import pytest

from freshupdate.config import Config, ConfigurationError


@pytest.fixture(autouse=True)
def clean_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("freshupdate.config.load_dotenv", lambda: None)
    for name in (
        "BOT_TOKEN",
        "GITHUB_REPOSITORY",
        "CHECK_INTERVAL_SECONDS",
        "INCLUDE_PRERELEASES",
        "DATABASE_PATH",
        "GITHUB_TOKEN",
    ):
        monkeypatch.delenv(name, raising=False)


def test_defaults_and_secret_repr(monkeypatch: pytest.MonkeyPatch) -> None:
    token = "123456789:" + "a" * 35
    monkeypatch.setenv("BOT_TOKEN", token)
    config = Config.from_env()
    assert config.check_interval == 300
    assert config.include_prereleases
    assert token not in repr(config)


@pytest.mark.parametrize(
    "name,value",
    [
        ("BOT_TOKEN", ""),
        ("BOT_TOKEN", "invalid"),
        ("GITHUB_REPOSITORY", "../bad/path"),
        ("CHECK_INTERVAL_SECONDS", "0"),
        ("CHECK_INTERVAL_SECONDS", "bad"),
        ("INCLUDE_PRERELEASES", "yes"),
        ("DATABASE_PATH", ""),
        ("DATABASE_PATH", ":memory:"),
    ],
)
def test_invalid_configuration(name: str, value: str, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("BOT_TOKEN", "123456789:" + "a" * 35)
    monkeypatch.setenv(name, value)
    with pytest.raises(ConfigurationError):
        Config.from_env()
