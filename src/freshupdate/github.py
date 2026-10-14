import asyncio
import json
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from typing import Any

import aiohttp


class GitHubError(RuntimeError):
    def __init__(self, message: str, retry_after: float = 0) -> None:
        super().__init__(message)
        self.retry_after = retry_after


@dataclass(frozen=True)
class ReleaseSnapshot:
    releases: list[dict[str, Any]]
    cache: str


def retry_delay(headers: Any) -> float:
    retry_after = headers.get("Retry-After", "")
    try:
        return max(0, float(retry_after))
    except ValueError:
        try:
            return max(0, parsedate_to_datetime(retry_after).timestamp() - time.time())
        except (ValueError, TypeError, OverflowError):
            try:
                return max(0, float(headers.get("X-RateLimit-Reset", "0")) - time.time())
            except ValueError:
                return 0


def validate_release(payload: Any, repository: str) -> dict[str, Any] | None:
    if not isinstance(payload, dict) or type(payload.get("draft")) is not bool:
        raise GitHubError("GitHub returned an invalid release")
    if payload["draft"]:
        return None
    if type(payload.get("id")) is not int or payload["id"] <= 0:
        raise GitHubError("GitHub returned an invalid release ID")
    if type(payload.get("prerelease")) is not bool:
        raise GitHubError("GitHub returned an invalid prerelease flag")
    for key in ("tag_name", "html_url", "published_at"):
        if not isinstance(payload.get(key), str) or not payload[key]:
            raise GitHubError("GitHub returned incomplete release metadata")
    for key in ("name", "body"):
        if payload.get(key) is not None and not isinstance(payload[key], str):
            raise GitHubError("GitHub returned invalid release text")
    prefix = f"https://github.com/{repository}/releases/tag/"
    if not payload["html_url"].startswith(prefix):
        raise GitHubError("GitHub returned an unexpected release URL")
    try:
        published = datetime.fromisoformat(payload["published_at"].replace("Z", "+00:00"))
        if published.tzinfo is None:
            raise ValueError
    except ValueError as error:
        raise GitHubError("GitHub returned an invalid publication date") from error
    return {
        "id": payload["id"],
        "tag_name": payload["tag_name"],
        "name": payload.get("name") or payload["tag_name"],
        "body": payload.get("body") or "",
        "html_url": payload["html_url"],
        "prerelease": payload["prerelease"],
        "published_at": published.astimezone(UTC).isoformat(),
    }


class GitHubClient:
    def __init__(self, session: aiohttp.ClientSession, repository: str, token: str = "") -> None:
        self.session = session
        self.repository = repository
        self.headers = {
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "freshgram-updates-notify",
        }
        if token:
            self.headers["Authorization"] = f"Bearer {token}"

    async def fetch_releases(self, previous_cache: str | None) -> ReleaseSnapshot:
        try:
            cached_pages = json.loads(previous_cache) if previous_cache else {}
        except json.JSONDecodeError as error:
            raise GitHubError("Stored GitHub cache is invalid") from error
        pages = {}
        releases = []
        page = 1
        while True:
            result = await self._fetch_page(page, cached_pages.get(str(page)))
            pages[str(page)] = result
            for payload in result["releases"]:
                release = validate_release(payload, self.repository)
                if release is not None:
                    releases.append(release)
            if not result["has_next"]:
                return ReleaseSnapshot(releases, json.dumps(pages))
            page += 1
            if page > 1000:
                raise GitHubError("GitHub pagination exceeded the safety limit")

    async def _fetch_page(self, page: int, cached: dict | None) -> dict:
        headers = self.headers.copy()
        if cached and cached.get("etag"):
            headers["If-None-Match"] = cached["etag"]
        url = f"https://api.github.com/repos/{self.repository}/releases?per_page=100&page={page}"
        for attempt in range(3):
            try:
                async with self.session.get(
                    url, headers=headers, allow_redirects=False
                ) as response:
                    if response.status == 304:
                        if cached is None:
                            raise GitHubError("GitHub returned 304 without a cached page")
                        return cached
                    if response.status in {403, 429}:
                        raise GitHubError(
                            f"GitHub API refused the request (HTTP {response.status})",
                            max(60, retry_delay(response.headers)),
                        )
                    if response.status >= 500:
                        if attempt == 2:
                            raise GitHubError(f"GitHub API unavailable (HTTP {response.status})")
                    elif response.status != 200:
                        raise GitHubError(f"GitHub API request failed (HTTP {response.status})")
                    else:
                        try:
                            payloads = await response.json()
                        except (ValueError, aiohttp.ContentTypeError) as error:
                            raise GitHubError("GitHub returned an invalid JSON response") from error
                        if not isinstance(payloads, list):
                            raise GitHubError("GitHub returned an unexpected response")
                        return {
                            "etag": response.headers.get("ETag", ""),
                            "releases": payloads,
                            "has_next": "next" in response.links,
                        }
            except (aiohttp.ClientError, TimeoutError) as error:
                if attempt == 2:
                    raise GitHubError("GitHub network request failed") from error
            await asyncio.sleep(2**attempt)
        raise GitHubError("GitHub retries exhausted")
