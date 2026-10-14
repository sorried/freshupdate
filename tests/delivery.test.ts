import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import { Api, GrammyError, HttpError } from "grammy";
import { DeliveryWorker } from "../src/delivery.js";
import { isRecord } from "../src/releases.js";
import { release, repository, temporaryDatabase } from "./fixtures.js";
import { mockApi } from "./telegram.js";

function queued(context: TestContext) {
  const fixture = temporaryDatabase(context);
  for (const user of [1, 2]) fixture.database.registerUser(user, 0);
  fixture.database.ingestReleases([], repository, "{}", true);
  fixture.database.ingestReleases([release(1)], repository, "{}", true);
  return fixture;
}

function apiWithErrors(errors: (Error | undefined)[]) {
  const api = new Api(`123456789:${"a".repeat(35)}`);
  const calls: number[] = [];
  mockApi(api, (method, payload) => {
    assert.equal(method, "sendMessage");
    const error = errors.shift();
    calls.push(Number(isRecord(payload) ? payload.chat_id : 0));
    if (error) throw error;
    return true;
  });
  return { api, calls };
}

function telegramError(code: number, retryAfter?: number): GrammyError {
  return new GrammyError(
    "request failed",
    {
      ok: false,
      error_code: code,
      description: "failed",
      ...(retryAfter !== undefined ? { parameters: { retry_after: retryAfter } } : {}),
    },
    "sendMessage",
    {},
  );
}

test("blocked user does not stop broadcast to others", async (context) => {
  const { database } = queued(context);
  const { api, calls } = apiWithErrors([telegramError(403), undefined]);
  const worker = new DeliveryWorker(database, api, repository, () => 100);
  assert.equal(await worker.deliverOnce(), true);
  assert.equal(await worker.deliverOnce(), true);
  assert.equal(await worker.deliverOnce(), false);
  assert.deepEqual(calls, [1, 2]);
  assert.equal(database.getUser(1)?.is_active, 0);
  assert.equal(
    database.connection.prepare("SELECT state FROM deliveries WHERE user_id=2").pluck().get(),
    "sent",
  );
});

test("flood pause persists across database restart", async (context) => {
  const { database, path } = queued(context);
  const { api, calls } = apiWithErrors([telegramError(429, 120), undefined]);
  let now = 100;
  await new DeliveryWorker(database, api, repository, () => now).deliverOnce();
  assert.equal(database.getMetadata("telegram_resume_at"), "220");
  database.close();
  const { Database } = await import("../src/database.js");
  const restored = new Database(path);
  const worker = new DeliveryWorker(restored, api, repository, () => now);
  assert.equal(await worker.deliverOnce(), false);
  assert.equal(calls.length, 1);
  now = 220;
  assert.equal(await worker.deliverOnce(), true);
  restored.close();
});

for (const error of [new HttpError("network", new Error()), telegramError(503)]) {
  test(`temporary ${error.name} failures stop after five attempts per recipient`, async (context) => {
    const { database } = queued(context);
    const { api, calls } = apiWithErrors(Array.from({ length: 10 }, () => error));
    let now = 100;
    const worker = new DeliveryWorker(database, api, repository, () => now);
    for (let index = 0; index < 5; index += 1) {
      assert.equal(await worker.deliverOnce(), true);
      assert.equal(await worker.deliverOnce(), true);
      now += 4000;
    }
    assert.equal(await worker.deliverOnce(), false);
    assert.equal(calls.length, 10);
    assert.equal(
      database.connection.prepare("SELECT * FROM deliveries WHERE state='failed'").all().length,
      2,
    );
  });
}

test("permanent API error affects only one user", async (context) => {
  const { database } = queued(context);
  const { api, calls } = apiWithErrors([telegramError(400), undefined]);
  const worker = new DeliveryWorker(database, api, repository, () => 100);
  await worker.deliverOnce();
  await worker.deliverOnce();
  assert.equal(await worker.deliverOnce(), false);
  assert.equal(calls.length, 2);
});

test("exhausted attempt after a crash is not sent again", async (context) => {
  const { database } = queued(context);
  database.connection.prepare("UPDATE deliveries SET attempts=5").run();
  const { api, calls } = apiWithErrors([]);
  await new DeliveryWorker(database, api, repository, () => 100).deliverOnce();
  assert.equal(calls.length, 0);
});

test("unexpected programming errors are not swallowed", async (context) => {
  const { database } = queued(context);
  const { api } = apiWithErrors([new Error("bug")]);
  await assert.rejects(
    new DeliveryWorker(database, api, repository, () => 100).deliverOnce(),
    /bug/,
  );
});
