from collections.abc import Iterator
from pathlib import Path

import pytest

from freshupdate.database import Database


@pytest.fixture
def database(tmp_path: Path) -> Iterator[Database]:
    database = Database(tmp_path / "test.db")
    yield database
    database.close()


def release(release_id: int, prerelease: bool = False) -> dict:
    return {
        "id": release_id,
        "name": f"freshGram v{release_id}",
        "tag_name": f"v{release_id}",
        "body": "Real changes",
        "published_at": f"2026-10-{release_id:02d}T12:00:00Z",
        "html_url": f"https://github.com/Snowy-Fluffy/freshGram/releases/tag/v{release_id}",
        "prerelease": prerelease,
        "draft": False,
    }
