import assert from "node:assert/strict";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import { Database } from "../src/database.js";
import { release, repository, temporaryDatabase } from "./fixtures.js";

test("registration preserves ID and first seen, updates activity without duplicates", (context) => {
  const { database } = temporaryDatabase(context);
  database.registerUser(123456789012, 1);
  database.deactivateUser(123456789012);
  database.registerUser(123456789012, 2);
  assert.deepEqual(database.getUser(123456789012), {
    user_id: 123456789012,
    first_seen_at: 1,
    last_seen_at: 2,
    is_active: 1,
    jail_until: 0,
  });
  assert.equal(database.connection.prepare("SELECT * FROM users").all().length, 1);
});

test("baseline is silent, new releases ordered and duplicates ignored", (context) => {
  const { database } = temporaryDatabase(context);
  database.registerUser(1, 0);
  assert.equal(database.ingestReleases([release(1)], repository, "{}", true), 0);
  assert.equal(database.nextDelivery(1), undefined);
  assert.equal(
    database.ingestReleases([release(3), release(2), release(1)], repository, "{}", true),
    2,
  );
  assert.equal(database.claimDelivery(1)?.release_id, 2);
  assert.equal(database.nextDelivery(1), undefined);
  database.finishDelivery(2, 1, "sent");
  assert.equal(database.nextDelivery(1)?.release_id, 3);
  assert.equal(database.ingestReleases([release(2), release(3)], repository, "{}", true), 0);
});

test("prereleases are filtered without backfill when enabled later", (context) => {
  const { database } = temporaryDatabase(context);
  database.registerUser(1, 0);
  database.ingestReleases([], repository, "{}", false);
  assert.equal(database.ingestReleases([release(1, true), release(2)], repository, "{}", false), 1);
  assert.equal(
    database.ingestReleases([release(1, true), release(3, true)], repository, "{}", true),
    1,
  );
});

test("pending attempts and sent results survive restart", (context) => {
  const { database, path } = temporaryDatabase(context);
  database.registerUser(1, 0);
  database.ingestReleases([], repository, "{}", true);
  database.ingestReleases([release(1)], repository, "{}", true);
  database.claimDelivery(5);
  database.close();
  const restored = new Database(path);
  assert.equal(restored.nextDelivery(10), undefined);
  assert.equal(restored.nextDelivery(65)?.attempts, 1);
  restored.finishDelivery(1, 1, "sent");
  restored.close();
  const final = new Database(path);
  assert.equal(final.nextDelivery(100), undefined);
  final.close();
});

test("three calls per command allowed, fourth jailed for exactly 300 seconds", (context) => {
  const { database } = temporaryDatabase(context);
  for (const now of [1, 2, 3]) {
    assert.equal(database.checkCommand(1, "start", now), "allowed");
    assert.equal(database.checkCommand(1, "about", now), "allowed");
  }
  assert.equal(database.checkCommand(1, "start", 4), "jailed");
  assert.equal(database.getUser(1)?.jail_until, 304);
  assert.equal(database.checkCommand(1, "about", 303.99), "blocked");
  assert.equal(database.checkCommand(1, "about", 304), "allowed");
});

test("sliding window excludes an event exactly 60 seconds old", (context) => {
  const { database } = temporaryDatabase(context);
  for (const now of [0, 10, 20, 60])
    assert.equal(database.checkCommand(1, "start", now), "allowed");
  assert.equal(database.checkCommand(1, "start", 61), "jailed");
});

test("jail survives restart with one warning decision and permits reoffending after expiry", (context) => {
  const { database, path } = temporaryDatabase(context);
  const outcomes = Array.from({ length: 10 }, () => database.checkCommand(1, "about", 10));
  assert.equal(outcomes.filter((outcome) => outcome === "jailed").length, 1);
  database.close();
  const restored = new Database(path);
  assert.equal(restored.checkCommand(1, "start", 309), "blocked");
  assert.equal(restored.checkCommand(1, "start", 310), "allowed");
  assert.equal(restored.checkCommand(1, "start", 311), "allowed");
  assert.equal(restored.checkCommand(1, "start", 311), "allowed");
  assert.equal(restored.checkCommand(1, "start", 311), "jailed");
  restored.close();
});

test("parallel SQLite connections produce only one jail decision", async (context) => {
  const { path } = temporaryDatabase(context);
  const moduleUrl = new URL("../src/database.js", import.meta.url).href;
  const results = await Promise.all(
    Array.from(
      { length: 8 },
      () =>
        new Promise<string[]>((resolve, reject) => {
          const worker = new Worker(
            `
      const { parentPort, workerData } = require('node:worker_threads');
      import(workerData.moduleUrl).then(({ Database }) => {
        const database = new Database(workerData.path);
        const outcomes = Array.from({ length: 3 }, () => database.checkCommand(1, 'start', 100));
        database.close();
        parentPort.postMessage(outcomes);
      });
    `,
            { eval: true, workerData: { path, moduleUrl } },
          );
          worker.once("message", resolve);
          worker.once("error", reject);
          worker.once("exit", (code) => {
            if (code !== 0) reject(new Error(`Worker exited: ${code}`));
          });
        }),
    ),
  );
  const outcomes = results.flat();
  assert.equal(outcomes.filter((outcome) => outcome === "allowed").length, 3);
  assert.equal(outcomes.filter((outcome) => outcome === "jailed").length, 1);
  assert.equal(outcomes.filter((outcome) => outcome === "blocked").length, 20);
});

test("cleanup removes expired events and jail", (context) => {
  const { database } = temporaryDatabase(context);
  for (let index = 0; index < 4; index += 1) database.checkCommand(1, "start", 1);
  database.checkCommand(2, "about", 1);
  database.cleanup(301);
  assert.equal(database.connection.prepare("SELECT * FROM command_events").all().length, 0);
  assert.equal(database.getUser(1)?.jail_until, 0);
});

test("lease prevents duplicate instances and recovers expired ownership", (context) => {
  const { database, path } = temporaryDatabase(context);
  const other = new Database(path);
  database.acquireLease("first", 1);
  assert.throws(() => other.acquireLease("second", 120));
  database.refreshLease("first", 100);
  assert.throws(() => other.acquireLease("second", 219));
  other.acquireLease("second", 220);
  assert.throws(() => database.assertLease("first", 220));
  database.releaseLease("first");
  other.assertLease("second", 221);
  other.releaseLease("second");
  database.acquireLease("third", 222);
  other.close();
});

test("repository change rolls back release ingestion and cache", (context) => {
  const { database } = temporaryDatabase(context);
  database.ingestReleases([], repository, "old", true);
  assert.throws(() => database.ingestReleases([release(1)], "other/repo", "new", true));
  assert.equal(database.getMetadata("github_cache"), "old");
  assert.equal(database.connection.prepare("SELECT * FROM releases").all().length, 0);
});

test("legacy Python payloads and timestamp formats retain queue and jail state", (context) => {
  const { database, path } = temporaryDatabase(context);
  const payload = { ...release(1), published_at: "2026-10-01T12:00:00+00:00" };
  database.connection
    .prepare("INSERT INTO users VALUES (?, ?, ?, ?, ?)")
    .run(123456789012, 1, 100, 1, 400);
  database.connection
    .prepare("INSERT INTO releases VALUES (?, ?, ?)")
    .run(1, payload.published_at, JSON.stringify(payload));
  database.connection
    .prepare("INSERT INTO deliveries VALUES (?, ?, ?, ?, ?)")
    .run(1, 123456789012, "pending", 1, 160);
  database.setMetadata("repository", repository);
  database.setMetadata("github_cache", "{}");
  database.close();
  const restored = new Database(path);
  try {
    assert.equal(restored.getUser(123456789012)?.first_seen_at, 1);
    assert.equal(restored.checkCommand(123456789012, "about", 399), "blocked");
    assert.equal(restored.checkCommand(123456789012, "about", 400), "allowed");
    assert.equal(restored.nextDelivery(159), undefined);
    assert.equal(restored.nextDelivery(160)?.attempts, 1);
    assert.equal(restored.ingestReleases([release(1)], repository, "{}", true), 0);
    restored.finishDelivery(1, 123456789012, "sent");
    assert.equal(restored.nextDelivery(400), undefined);
  } finally {
    restored.close();
  }
});
