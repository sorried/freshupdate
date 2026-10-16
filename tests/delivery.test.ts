import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import { Api, GrammyError, HttpError } from "grammy";
import { DeliveryWorker } from "../src/delivery.js";
import { ownerid } from "../src/errors.js";
import { GitHubClient } from "../src/github.js";
import { isrecord } from "../src/releases.js";
import { release, repository, temporarydatabase } from "./fixtures.js";
import { mockapi } from "./telegram.js";

function queued(context: TestContext) {
  const fixture = temporarydatabase(context);
  for (const user of [1, 2]) fixture.database.registeruser(user, 0);
  fixture.database.ingestreleases([], repository, "{}", true);
  fixture.database.ingestreleases([release(1)], repository, "{}", true);
  return fixture;
}

function apiwitherrors(errors: (Error | undefined)[]) {
  const api = new Api(`123456789:${"a".repeat(35)}`);
  const calls: number[] = [];
  mockapi(api, (method, payload) => {
    assert.equal(method, "sendMessage");
    if (isrecord(payload) && payload.chat_id === ownerid) return true;
    const error = errors.shift();
    calls.push(Number(isrecord(payload) ? payload.chat_id : 0));
    if (error) throw error;
    return true;
  });
  return { api, calls };
}

function telegramerror(code: number, retryafter?: number): GrammyError {
  return new GrammyError(
    "request failed",
    {
      ok: false,
      error_code: code,
      description: "failed",
      ...(retryafter !== undefined ? { parameters: { retry_after: retryafter } } : {}),
    },
    "sendMessage",
    {},
  );
}

test("blocked user does not stop broadcast to others", async (context) => {
  const { database } = queued(context);
  const { api, calls } = apiwitherrors([telegramerror(403), undefined]);
  const worker = new DeliveryWorker(database, api, repository, () => 100);
  assert.equal(await worker.deliveronce(), true);
  assert.equal(await worker.deliveronce(), true);
  assert.equal(await worker.deliveronce(), false);
  assert.deepEqual(calls, [1, 2]);
  assert.equal(database.getuser(1)?.is_active, 0);
  assert.equal(
    database.connection.prepare("SELECT state FROM deliveries WHERE user_id=2").pluck().get(),
    "sent",
  );
});

test("broadcast resolves release changelog once for multiple recipients", async (context) => {
  const { database } = temporarydatabase(context);
  for (const user of [1, 2]) database.registeruser(user, 0);
  database.ingestreleases([], repository, "{}", true);
  database.ingestreleases(
    [
      {
        ...release(1),
        body: `**Full Changelog**: https://github.com/${repository}/compare/v0...v1`,
      },
    ],
    repository,
    "{}",
    true,
  );
  let requests = 0;
  const request: typeof fetch = async () => {
    requests += 1;
    return new Response(
      JSON.stringify({ commits: [{ commit: { message: "Fix saved media crash" } }] }),
    );
  };
  const api = new Api(`123456789:${"a".repeat(35)}`);
  const messages: string[] = [];
  mockapi(api, (_method, payload) => {
    if (isrecord(payload)) messages.push(String(payload.text));
    return true;
  });
  const worker = new DeliveryWorker(
    database,
    api,
    repository,
    () => 100,
    undefined,
    new GitHubClient(repository, "", request),
  );
  await worker.deliveronce();
  await worker.deliveronce();
  assert.equal(requests, 1);
  assert.equal(messages.length, 2);
  for (const message of messages) assert.ok(message.includes("- Fix saved media crash"));
});

test("flood pause persists across database restart", async (context) => {
  const { database, path } = queued(context);
  const { api, calls } = apiwitherrors([telegramerror(429, 120), undefined]);
  let now = 100;
  await new DeliveryWorker(database, api, repository, () => now).deliveronce();
  assert.equal(database.getmetadata("telegram_resume_at"), "220");
  database.close();
  const { Database: databaseclass } = await import("../src/database.js");
  const restored = new databaseclass(path);
  const worker = new DeliveryWorker(restored, api, repository, () => now);
  assert.equal(await worker.deliveronce(), false);
  assert.equal(calls.length, 1);
  now = 220;
  assert.equal(await worker.deliveronce(), true);
  restored.close();
});

for (const error of [new HttpError("network", new Error()), telegramerror(503)]) {
  test(`temporary ${error.name} failures stop after five attempts per recipient`, async (context) => {
    const { database } = queued(context);
    const { api, calls } = apiwitherrors(Array.from({ length: 10 }, () => error));
    let now = 100;
    const worker = new DeliveryWorker(database, api, repository, () => now);
    for (let index = 0; index < 5; index += 1) {
      assert.equal(await worker.deliveronce(), true);
      assert.equal(await worker.deliveronce(), true);
      now += 4000;
    }
    assert.equal(await worker.deliveronce(), false);
    assert.equal(calls.length, 10);
    assert.equal(
      database.connection.prepare("SELECT * FROM deliveries WHERE state='failed'").all().length,
      2,
    );
  });
}

test("permanent API error affects only one user", async (context) => {
  const { database } = queued(context);
  const { api, calls } = apiwitherrors([telegramerror(400), undefined]);
  const worker = new DeliveryWorker(database, api, repository, () => 100);
  await worker.deliveronce();
  await worker.deliveronce();
  assert.equal(await worker.deliveronce(), false);
  assert.equal(calls.length, 2);
});

test("exhausted attempt after a crash is not sent again", async (context) => {
  const { database } = queued(context);
  database.connection.prepare("UPDATE deliveries SET attempts=5").run();
  const { api, calls } = apiwitherrors([]);
  await new DeliveryWorker(database, api, repository, () => 100).deliveronce();
  assert.equal(calls.length, 0);
});

test("unexpected programming errors are not swallowed", async (context) => {
  const { database } = queued(context);
  const { api } = apiwitherrors([new Error("bug")]);
  await assert.rejects(
    new DeliveryWorker(database, api, repository, () => 100).deliveronce(),
    /bug/,
  );
});
