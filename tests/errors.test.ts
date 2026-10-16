import assert from "node:assert/strict";
import { test } from "node:test";
import { Api, Bot, GrammyError } from "grammy";
import { ErrorReporter, failuremessage, ownerid } from "../src/errors.js";
import { GitHubClient } from "../src/github.js";
import { registerhandlers } from "../src/handlers.js";
import { isrecord } from "../src/releases.js";
import { release, repository, temporarydatabase } from "./fixtures.js";
import { botinfo, mockapi } from "./telegram.js";

const token = `123456789:${"a".repeat(35)}`;

test("owner reports redact secrets, remain plain text and throttle parallel failures", async () => {
  const api = new Api(token);
  const reports: Record<string, unknown>[] = [];
  mockapi(api, (_method, payload) => {
    assert.ok(isrecord(payload));
    reports.push(payload);
    return true;
  });
  let now = 0;
  const reporter = new ErrorReporter(api, [token, "private-github-secret"], () => now);
  const error = new Error(`${token} private-github-secret <b>failure</b>`);
  await Promise.all(Array.from({ length: 10 }, () => reporter.report("update", error)));
  assert.equal(reports.length, 1);
  assert.equal(reports[0]?.chat_id, ownerid);
  assert.ok(!String(reports[0]?.text).includes(token));
  assert.ok(!String(reports[0]?.text).includes("private-github-secret"));
  assert.ok(String(reports[0]?.text).includes("<b>failure</b>"));
  assert.equal(reports[0]?.parse_mode, undefined);
  now = 300_000;
  await reporter.report("update", error);
  assert.equal(reports.length, 2);
});

test("failed owner notification never recurses", async () => {
  const api = new Api(token);
  let calls = 0;
  mockapi(api, () => {
    calls += 1;
    throw new Error("offline");
  });
  await new ErrorReporter(api).report("update", new Error("failure"));
  assert.equal(calls, 1);
});

test("only owner receives details while user gets generic failure", async (context) => {
  const { database } = temporarydatabase(context);
  database.close();
  const bot = new Bot(token, { botInfo: botinfo });
  const replies: Record<string, unknown>[] = [];
  mockapi(bot.api, (_method, payload) => {
    assert.ok(isrecord(payload));
    replies.push(payload);
    return true;
  });
  registerhandlers(bot, database);
  await bot.handleUpdate({
    update_id: 1,
    message: {
      message_id: 1,
      date: 100,
      chat: { id: 1, type: "private", first_name: "test" },
      from: { id: 1, is_bot: false, first_name: "test" },
      text: "/start",
      entities: [{ type: "bot_command", offset: 0, length: 6 }],
    },
  });
  assert.equal(replies.length, 2);
  assert.equal(replies[0]?.chat_id, ownerid);
  assert.equal(replies[1]?.chat_id, 1);
  assert.equal(replies[1]?.text, failuremessage);
});

test("Telegram payload and nested network errors are not leaked to owner", async () => {
  const api = new Api(token);
  const replies: string[] = [];
  mockapi(api, (_method, payload) => {
    assert.ok(isrecord(payload));
    replies.push(String(payload.text));
    return true;
  });
  const error = new GrammyError(
    "failed",
    { ok: false, error_code: 400, description: "bad request" },
    "sendMessage",
    { text: "private user message", chat_id: 123 },
  );
  await new ErrorReporter(api).report("delivery", error);
  assert.ok(!replies[0]?.includes("private user message"));
});

test("test_send accepts only exact owner trigger in private and never queues a broadcast", async (context) => {
  const { database } = temporarydatabase(context);
  const bot = new Bot(token, { botInfo: botinfo });
  const replies: Record<string, unknown>[] = [];
  let requests = 0;
  const request: typeof fetch = async () => {
    requests += 1;
    return new Response(
      JSON.stringify([
        { ...release(2), draft: false },
        { ...release(1), draft: false },
      ]),
    );
  };
  mockapi(bot.api, (_method, payload) => {
    assert.ok(isrecord(payload));
    replies.push(payload);
    return true;
  });
  registerhandlers(
    bot,
    database,
    new ErrorReporter(bot.api),
    new GitHubClient(repository, "", request),
  );
  for (const [id, text, group] of [
    [1, "@test_send", false],
    [ownerid, "/test_send", false],
    [ownerid, "@test_send", true],
    [ownerid, "@test_send", false],
  ] as const) {
    await bot.handleUpdate({
      update_id: replies.length + 1,
      message: {
        message_id: 1,
        date: 100,
        chat: group
          ? { id: -1, type: "group", title: "group" }
          : { id, type: "private", first_name: "test" },
        from: { id, is_bot: false, first_name: "test" },
        text,
      },
    });
  }
  assert.equal(requests, 1);
  assert.equal(replies.length, 1);
  assert.equal(replies[0]?.chat_id, ownerid);
  assert.ok(String(replies[0]?.text).includes("freshGram v2"));
  assert.equal(database.connection.prepare("SELECT * FROM deliveries").all().length, 0);
  assert.equal(database.getmetadata("repository"), undefined);
});

test("owner flood limit pauses reports across all error scopes", async () => {
  const api = new Api(token);
  let calls = 0;
  let now = 0;
  mockapi(api, () => {
    calls += 1;
    throw new GrammyError(
      "flood",
      { ok: false, error_code: 429, description: "flood", parameters: { retry_after: 120 } },
      "sendMessage",
      {},
    );
  });
  const reporter = new ErrorReporter(api, [], () => now);
  await reporter.report("update", new Error("failed"));
  await reporter.report("delivery", new Error("failed"));
  assert.equal(calls, 1);
  now = 120_000;
  await reporter.report("delivery", new Error("failed"));
  assert.equal(calls, 2);
});

test("blocked owner cannot use test_send to bypass jail or query GitHub", async (context) => {
  const { database } = temporarydatabase(context);
  for (let index = 0; index < 4; index += 1)
    database.checkcommand(ownerid, "about", Date.now() / 1000);
  const bot = new Bot(token, { botInfo: botinfo });
  let calls = 0;
  let requests = 0;
  mockapi(bot.api, () => {
    calls += 1;
    return true;
  });
  const request: typeof fetch = async () => {
    requests += 1;
    return new Response("[]");
  };
  registerhandlers(
    bot,
    database,
    new ErrorReporter(bot.api),
    new GitHubClient(repository, "", request),
  );
  await bot.handleUpdate({
    update_id: 1,
    message: {
      message_id: 1,
      date: 100,
      chat: { id: ownerid, type: "private", first_name: "test" },
      from: { id: ownerid, is_bot: false, first_name: "test" },
      text: "@test_send",
    },
  });
  assert.equal(calls, 0);
  assert.equal(requests, 0);
});
