import assert from "node:assert/strict";
import { test } from "node:test";
import { GitHubClient, GitHubError, retrydelay } from "../src/github.js";
import { releasemessage } from "../src/messages.js";
import { parserelease } from "../src/releases.js";
import { release, repository } from "./fixtures.js";

function response(
  status: number,
  payload?: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(status === 304 ? null : (JSON.stringify(payload) ?? ""), { status, headers });
}

function client(replies: (Response | Error)[]): {
  github: GitHubClient;
  calls: RequestInit[];
  delays: number[];
} {
  const calls: RequestInit[] = [];
  const delays: number[] = [];
  const request: typeof fetch = async (_url, options) => {
    calls.push(options ?? {});
    const reply = replies.shift();
    if (reply instanceof Error) throw reply;
    if (!reply) throw new Error("No mocked response");
    return reply;
  };
  const github = new GitHubClient(repository, "", request, async (seconds) => {
    delays.push(seconds);
  });
  return { github, calls, delays };
}

function published(id: number): object {
  return { ...release(id), draft: false };
}

test("ETag caching and pagination preserve unchanged pages", async () => {
  const { github, calls } = client([
    response(200, [published(2)], {
      ETag: '"one"',
      Link: '<https://api.github.com/page2>; rel="next"',
    }),
    response(200, [published(1)], { ETag: '"two"' }),
    response(304),
    response(200, [published(1), published(3)], { ETag: '"three"' }),
  ]);
  const first = await github.fetchreleases();
  const second = await github.fetchreleases(first.cache);
  assert.deepEqual(
    second.releases.map((item) => item.id),
    [2, 1, 3],
  );
  assert.equal(new Headers(calls[2]?.headers).get("If-None-Match"), '"one"');
});

for (const status of [403, 429]) {
  test(`HTTP ${status} preserves rate limit delay and is not an empty result`, async () => {
    const { github, calls } = client([response(status, undefined, { "Retry-After": "120" })]);
    await assert.rejects(
      github.fetchreleases(),
      (error: unknown) => error instanceof GitHubError && error.retryafter === 120,
    );
    assert.equal(calls.length, 1);
  });
}

for (const payload of [null, {}, "", [null], [{ draft: false }]]) {
  test(`invalid GitHub payload ${JSON.stringify(payload)} fails`, async () => {
    await assert.rejects(client([response(200, payload)]).github.fetchreleases(), GitHubError);
  });
}

test("empty list is valid but empty body is an error", async () => {
  assert.deepEqual((await client([response(200, [])]).github.fetchreleases()).releases, []);
  await assert.rejects(client([new Response("")]).github.fetchreleases(), GitHubError);
});

test("304 without cached page fails", async () => {
  await assert.rejects(client([response(304)]).github.fetchreleases(), GitHubError);
});

test("network retries are bounded and exponential", async () => {
  const { github, calls, delays } = client([new TypeError(), new Error(), new TypeError()]);
  await assert.rejects(github.fetchreleases(), GitHubError);
  assert.equal(calls.length, 3);
  assert.deepEqual(delays, [1, 2]);
});

test("server error recovers and final server error fails", async () => {
  const recovering = client([response(503), response(200, [published(1)])]);
  assert.equal((await recovering.github.fetchreleases()).releases.length, 1);
  const failing = client([response(500), response(502), response(503)]);
  await assert.rejects(failing.github.fetchreleases(), GitHubError);
  assert.deepEqual(failing.delays, [1, 2]);
});

for (const [key, value] of [
  ["html_url", "https://evil.example/release"],
  ["id", true],
  ["id", 9007199254740992],
  ["published_at", "invalid"],
  ["published_at", "2026-10-01"],
  ["body", []],
  ["prerelease", "false"],
] as const) {
  test(`invalid release field ${key}: ${JSON.stringify(value)}`, () => {
    assert.throws(() => parserelease({ ...release(1), [key]: value }, repository));
  });
}

test("drafts ignored and missing descriptions not invented", async () => {
  const { github } = client([
    response(200, [{ draft: true }, { ...published(1), body: null, name: null }]),
  ]);
  assert.equal((await github.fetchreleases()).releases[0]?.body, "");
});

test("rate limit supports seconds, HTTP dates and reset timestamps", () => {
  assert.equal(retrydelay(new Headers({ "Retry-After": "120" }), 0), 120);
  assert.equal(retrydelay(new Headers({ "Retry-After": "Thu, 01 Jan 1970 00:02:00 GMT" }), 0), 120);
  assert.equal(retrydelay(new Headers({ "X-RateLimit-Reset": "120" }), 0), 120);
  assert.equal(retrydelay(new Headers({ "Retry-After": "bad", "X-RateLimit-Reset": "bad" }), 0), 0);
});

test("abort cancels requests without retry", async () => {
  const controller = new AbortController();
  controller.abort();
  const { github, calls } = client([]);
  await assert.rejects(github.fetchreleases(undefined, controller.signal));
  assert.equal(calls.length, 0);
});

test("corrupt cache is rejected before network request", async () => {
  for (const cache of ["bad", "null", '{"1":{"etag":1}}']) {
    const { github, calls } = client([]);
    await assert.rejects(github.fetchreleases(cache), GitHubError);
    assert.equal(calls.length, 0);
  }
});

test("release body is preferred without fetching comparison", async () => {
  const { github, calls } = client([]);
  const payload = {
    ...release(1),
    body: "- Fixed saved media\n\n**Full Changelog**: https://github.com/example/app/compare/v0...v1",
  };
  assert.deepEqual(await github.withchangelog(payload), payload);
  assert.equal(calls.length, 0);
});

test("release changelog link supplies cached commit subjects and removes release noise", async () => {
  const urls: string[] = [];
  const request: typeof fetch = async (url) => {
    urls.push(String(url));
    return response(200, {
      commits: [
        { commit: { message: "Fix crash on saved media\n\nTechnical details" } },
        { commit: { message: "Fix crash on saved media" } },
        { commit: { message: "Keep deleted message author tags" } },
        { commit: { message: "Beta version 7.5.1." } },
        { commit: { message: "ci: build release" } },
        { commit: { message: "Merge branch 'main'" } },
      ],
    });
  };
  const github = new GitHubClient(repository, "", request);
  const payload = {
    ...release(1),
    body: Array(3)
      .fill(`**Full Changelog**: https://github.com/${repository}/compare/v0...v1`)
      .join("\n\n"),
  };
  const enriched = await github.withchangelog(payload);
  assert.equal(enriched.body, "- Fix crash on saved media\n- Keep deleted message author tags");
  assert.ok(releasemessage(enriched).text.includes("Fix crash on saved media"));
  await github.withchangelog(payload);
  assert.deepEqual(urls, [
    `https://api.github.com/repos/${repository}/compare/v0...v1?per_page=100`,
  ]);
});

test("comparison must belong to release repository and target tag", async () => {
  const { github, calls } = client([]);
  for (const url of [
    "https://evil.example/compare/v0...v1",
    "https://github.com/another/project/compare/v0...v1",
    `https://github.com/${repository}/compare/v0...v2`,
    `https://github.com/${repository}/compare/v0...%invalid`,
  ]) {
    const payload = { ...release(1), body: `**Full Changelog**: ${url}` };
    assert.deepEqual(await github.withchangelog(payload), payload);
  }
  assert.equal(calls.length, 0);
});

test("unavailable or malformed comparisons do not break release notifications", async () => {
  const payload = {
    ...release(1),
    body: `**Full Changelog**: https://github.com/${repository}/compare/v0...v1`,
  };
  for (const reply of [
    response(429),
    response(404),
    response(200, {}),
    response(200, { commits: [null] }),
    new TypeError("offline"),
  ]) {
    const { github } = client([reply]);
    assert.deepEqual(await github.withchangelog(payload), payload);
  }
});

test("changelog requests honor cancellation", async () => {
  const controller = new AbortController();
  const request: typeof fetch = async () => {
    controller.abort();
    throw new Error("aborted");
  };
  const github = new GitHubClient(repository, "", request);
  await assert.rejects(
    github.withchangelog(
      { ...release(1), body: `https://github.com/${repository}/compare/v0...v1` },
      controller.signal,
    ),
  );
});
