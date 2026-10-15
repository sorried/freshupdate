import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { Bot } from "grammy";
import { readConfig } from "../src/config.js";
import { Database } from "../src/database.js";
import { isRecord } from "../src/releases.js";
import { run } from "../src/runtime.js";
import { temporaryDatabase } from "./fixtures.js";
import { botInfo, mockApi } from "./telegram.js";

test("missing token exits without stack trace", () => {
  const outcome = spawnSync(process.execPath, ["build-test/src/main.js"], {
    encoding: "utf8",
    env: { ...process.env, BOT_TOKEN: "" },
  });
  assert.equal(outcome.status, 1);
  assert.ok(outcome.stderr.includes("BOT_TOKEN"));
  assert.ok(!outcome.stderr.includes(" at "));
});

test("runtime registers exactly two commands and releases lease after graceful stop", async (context) => {
  const { path } = temporaryDatabase(context);
  const config = readConfig({ BOT_TOKEN: `123456789:${"a".repeat(35)}`, DATABASE_PATH: path });
  const controller = new AbortController();
  const bot = new Bot(config.botToken);
  const methods: string[] = [];
  mockApi(bot.api, (method, payload) => {
    methods.push(method);
    if (method === "getMe") return botInfo;
    if (method === "getWebhookInfo") return { url: "", pending_update_count: 0 };
    if (method === "setMyCommands" && isRecord(payload) && Array.isArray(payload.commands)) {
      assert.deepEqual(
        payload.commands.map((command: unknown) =>
          isRecord(command) ? command.command : undefined,
        ),
        ["start", "about"],
      );
    }
    if (method === "getUpdates") {
      controller.abort();
      return [];
    }
    return true;
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("[]");
  try {
    await run(config, controller.signal, bot);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.ok(methods.includes("getMe"));
  assert.equal(bot.isRunning(), false);
  const restored = new Database(path);
  assert.equal(restored.getMetadata("instance_owner"), undefined);
  restored.acquireLease("new", Date.now() / 1000);
  restored.close();
});

test("existing webhook is preserved and startup exits", async (context) => {
  const { path } = temporaryDatabase(context);
  const config = readConfig({ BOT_TOKEN: `123456789:${"a".repeat(35)}`, DATABASE_PATH: path });
  const bot = new Bot(config.botToken);
  const methods: string[] = [];
  mockApi(bot.api, (method) => {
    methods.push(method);
    return method === "getMe" ? botInfo : { url: "https://example.com/hook" };
  });
  await assert.rejects(run(config, new AbortController().signal, bot), /webhook/);
  assert.deepEqual(methods, ["getMe", "getWebhookInfo", "sendMessage"]);
  const restored = new Database(path);
  assert.equal(restored.getMetadata("instance_owner"), undefined);
  restored.close();
});
