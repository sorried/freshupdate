import assert from "node:assert/strict";
import { test } from "node:test";
import { GitHubClient } from "../src/github.js";
import { ReleaseTracker } from "../src/tracker.js";
import { release, repository, temporarydatabase } from "./fixtures.js";

test("tracker initializes silently and queues only new releases", async (context) => {
  const { database } = temporarydatabase(context);
  database.registeruser(1, 0);
  const replies = [[release(1)], [release(3), release(2), release(1)], [release(3), release(2)]];
  const request: typeof fetch = async () =>
    new Response(JSON.stringify(replies.shift()?.map((item) => ({ ...item, draft: false }))));
  const tracker = new ReleaseTracker(
    database,
    new GitHubClient(repository, "", request),
    300,
    true,
  );
  assert.equal(await tracker.pollonce(), 0);
  assert.equal(await tracker.pollonce(), 2);
  assert.equal(await tracker.pollonce(), 0);
});

test("API failures do not initialize or overwrite cache", async (context) => {
  const { database } = temporarydatabase(context);
  const request: typeof fetch = async () => new Response("", { status: 403 });
  const tracker = new ReleaseTracker(
    database,
    new GitHubClient(repository, "", request),
    300,
    true,
  );
  await assert.rejects(tracker.pollonce());
  assert.equal(database.getmetadata("repository"), undefined);
  database.ingestreleases([], repository, "{}", true);
  await assert.rejects(tracker.pollonce());
  assert.equal(database.getmetadata("github_cache"), "{}");
});

test("failure on later page rolls back the whole snapshot", async (context) => {
  const { database } = temporarydatabase(context);
  const replies = [
    new Response(JSON.stringify([{ ...release(1), draft: false }]), {
      headers: { Link: '<https://api.github.com/page2>; rel="next"' },
    }),
    new Response("", { status: 403 }),
  ];
  const request: typeof fetch = async () => {
    const reply = replies.shift();
    assert.ok(reply);
    return reply;
  };
  await assert.rejects(
    new ReleaseTracker(database, new GitHubClient(repository, "", request), 300, true).pollonce(),
  );
  assert.equal(database.getmetadata("repository"), undefined);
  assert.equal(database.connection.prepare("SELECT * FROM releases").all().length, 0);
});
