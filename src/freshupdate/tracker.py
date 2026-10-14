import asyncio
import logging
import time

from freshupdate.database import Database
from freshupdate.github import GitHubClient, GitHubError

logger = logging.getLogger(__name__)


class ReleaseTracker:
    def __init__(
        self,
        database: Database,
        github: GitHubClient,
        interval: int,
        include_prereleases: bool,
    ) -> None:
        self.database = database
        self.github = github
        self.interval = interval
        self.include_prereleases = include_prereleases

    async def poll_once(self) -> int:
        snapshot = await self.github.fetch_releases(self.database.get_metadata("github_cache"))
        return self.database.ingest_releases(
            snapshot.releases,
            self.github.repository,
            snapshot.cache,
            self.include_prereleases,
        )

    async def run(self) -> None:
        failures = 0
        while True:
            self.database.cleanup(time.time())
            try:
                count = await self.poll_once()
                failures = 0
                delay = self.interval
                if count:
                    logger.info("Queued %s new releases", count)
            except GitHubError as error:
                failures = min(failures + 1, 6)
                delay = max(self.interval, error.retry_after, min(3600, 30 * 2**failures))
                logger.warning("%s; retrying in %.0f seconds", error, delay)
            await asyncio.sleep(delay)
