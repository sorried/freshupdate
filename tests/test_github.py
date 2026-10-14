import json
from unittest.mock import AsyncMock, MagicMock

import aiohttp
import pytest
from conftest import release

from freshupdate.github import GitHubClient, GitHubError, retry_delay, validate_release


def response(status: int, payload: object = None, headers: dict | None = None, next_page=False):
    reply = MagicMock()
    reply.status = status
    reply.headers = headers or {}
    reply.links = {"next": {}} if next_page else {}
    reply.json = AsyncMock(return_value=payload)
    reply.__aenter__ = AsyncMock(return_value=reply)
    reply.__aexit__ = AsyncMock(return_value=False)
    return reply


def client(*replies):
    session = MagicMock()
    session.get.side_effect = replies
    return GitHubClient(session, "Snowy-Fluffy/freshGram")


async def test_etag_and_pagination_preserve_cached_pages() -> None:
    github = client(
        response(200, [release(2)], {"ETag": '"one"'}, True),
        response(200, [release(1)], {"ETag": '"two"'}),
        response(304),
        response(200, [release(1), release(3)], {"ETag": '"three"'}),
    )
    first = await github.fetch_releases(None)
    second = await github.fetch_releases(first.cache)
    assert [item["id"] for item in second.releases] == [2, 1, 3]
    assert github.session.get.call_args_list[2].kwargs["headers"]["If-None-Match"] == '"one"'
    assert json.loads(second.cache)["2"]["etag"] == '"three"'


@pytest.mark.parametrize("status", [403, 429])
async def test_rate_limits_are_not_empty_results(status: int) -> None:
    github = client(response(status, headers={"Retry-After": "120"}))
    with pytest.raises(GitHubError) as failure:
        await github.fetch_releases(None)
    assert failure.value.retry_after == 120
    assert github.session.get.call_count == 1


@pytest.mark.parametrize("payload", [None, {}, "", [None], [{"draft": False}]])
async def test_invalid_responses_fail(payload: object) -> None:
    with pytest.raises(GitHubError):
        await client(response(200, payload)).fetch_releases(None)


async def test_empty_list_is_valid() -> None:
    assert (await client(response(200, [])).fetch_releases(None)).releases == []


async def test_304_requires_cached_page() -> None:
    with pytest.raises(GitHubError):
        await client(response(304)).fetch_releases(None)


async def test_network_retries_are_bounded(monkeypatch: pytest.MonkeyPatch) -> None:
    sleep = AsyncMock()
    monkeypatch.setattr("freshupdate.github.asyncio.sleep", sleep)
    github = client(
        aiohttp.ClientConnectionError(), TimeoutError(), aiohttp.ClientConnectionError()
    )
    with pytest.raises(GitHubError):
        await github.fetch_releases(None)
    assert github.session.get.call_count == 3
    assert [call.args[0] for call in sleep.call_args_list] == [1, 2]


async def test_server_error_recovers(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("freshupdate.github.asyncio.sleep", AsyncMock())
    github = client(response(503), response(200, [release(1)]))
    assert len((await github.fetch_releases(None)).releases) == 1


@pytest.mark.parametrize(
    "key,value",
    [
        ("html_url", "https://evil.example/release"),
        ("id", True),
        ("published_at", "not-a-date"),
        ("published_at", "2026-10-01"),
        ("body", []),
        ("prerelease", "false"),
    ],
)
def test_untrusted_release_fields(key: str, value: object) -> None:
    payload = release(1)
    payload[key] = value
    with pytest.raises(GitHubError):
        validate_release(payload, "Snowy-Fluffy/freshGram")


def test_drafts_ignored() -> None:
    assert validate_release({"draft": True}, "Snowy-Fluffy/freshGram") is None


def test_rate_limit_reset_and_http_date(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("freshupdate.github.time.time", lambda: 0)
    assert retry_delay({"X-RateLimit-Reset": "120"}) == 120
    assert retry_delay({"Retry-After": "Thu, 01 Jan 1970 00:02:00 GMT"}) == 120
    assert retry_delay({"Retry-After": "bad", "X-RateLimit-Reset": "bad"}) == 0
