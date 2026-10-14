import os
import re
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv


class ConfigurationError(ValueError):
    pass


@dataclass(frozen=True)
class Config:
    bot_token: str = field(repr=False)
    repository: str = "Snowy-Fluffy/freshGram"
    check_interval: int = 300
    include_prereleases: bool = True
    database_path: Path = Path("data/bot.db")
    github_token: str = field(default="", repr=False)

    @classmethod
    def from_env(cls) -> "Config":
        load_dotenv()
        token = os.getenv("BOT_TOKEN", "").strip()
        if not re.fullmatch(r"[1-9]\d{4,}:[A-Za-z0-9_-]{30,}", token):
            raise ConfigurationError("BOT_TOKEN отсутствует или имеет неверный формат.")
        repository = os.getenv("GITHUB_REPOSITORY", "Snowy-Fluffy/freshGram").strip()
        if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
            raise ConfigurationError("GITHUB_REPOSITORY должен иметь формат owner/repository.")
        try:
            interval = int(os.getenv("CHECK_INTERVAL_SECONDS", "300"))
        except ValueError as error:
            raise ConfigurationError("CHECK_INTERVAL_SECONDS должен быть целым числом.") from error
        if interval < 1:
            raise ConfigurationError("CHECK_INTERVAL_SECONDS должен быть больше нуля.")
        prereleases = os.getenv("INCLUDE_PRERELEASES", "true").strip().lower()
        if prereleases not in {"true", "false"}:
            raise ConfigurationError("INCLUDE_PRERELEASES должен быть true или false.")
        database = os.getenv("DATABASE_PATH", "data/bot.db").strip()
        if not database or database == ":memory:":
            raise ConfigurationError("DATABASE_PATH должен указывать на постоянный файл SQLite.")
        return cls(
            token,
            repository,
            interval,
            prereleases == "true",
            Path(database),
            os.getenv("GITHUB_TOKEN", "").strip(),
        )
