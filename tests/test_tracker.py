from unittest.mock import AsyncMock

import pytest
from conftest import release

from freshupdate.database import Database
from freshupdate.github import GitHubError, ReleaseSnapshot
from freshupdate.tracker import ReleaseTracker


async def test_tracker_baseline_new_releases_and_duplicates(database: Database) -> None:
    database.register_user(1, 0)
    github = AsyncMock()
    github.repository = "Snowy-Fluffy/freshGram"
    github.fetch_releases.side_effect = [
        ReleaseSnapshot([release(1)], "{}"),
        ReleaseSnapshot([release(3), release(2), release(1)], "{}"),
        ReleaseSnapshot([release(3), release(2), release(1)], "{}"),
    ]
    tracker = ReleaseTracker(database, github, 300, True)
    assert await tracker.poll_once() == 0
    assert await tracker.poll_once() == 2
    assert await tracker.poll_once() == 0


async def test_api_failure_does_not_initialize_database(database: Database) -> None:
    github = AsyncMock()
    github.fetch_releases.side_effect = GitHubError("failure")
    with pytest.raises(GitHubError):
        await ReleaseTracker(database, github, 300, True).poll_once()
    assert database.get_metadata("repository") is None
