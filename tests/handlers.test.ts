import assert from "node:assert/strict";
import { test } from "node:test";
import { Bot } from "grammy";
import type { Update } from "grammy/types";
import { registerHandlers } from "../src/handlers.js";
import { isRecord } from "../src/releases.js";
import { temporaryDatabase } from "./fixtures.js";
import { botInfo, mockApi } from "./telegram.js";

function message(updateId: number, command: string, group = false): Update {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 100,
      chat: group
        ? { id: -1, type: "group", title: "test" }
        : { id: 1, type: "private", first_name: "test" },
      from: { id: 1, is_bot: false, first_name: "test" },
      text: `/${command}`,
      entities: [{ type: "bot_command", offset: 0, length: command.length + 1 }],
    },
  };
}

test("parallel command handling sends one jail warning then remains silent", async (context) => {
  const { database } = temporaryDatabase(context);
  const bot = new Bot(`123456789:${"a".repeat(35)}`, { botInfo });
  const replies: string[] = [];
  mockApi(bot.api, (method, payload) => {
    if (method === "sendMessage" && isRecord(payload)) replies.push(String(payload.text));
    return true;
  });
  registerHandlers(bot, database);
  await Promise.all(
    Array.from({ length: 10 }, (_, index) => bot.handleUpdate(message(index, "start"))),
  );
  assert.equal(replies.length, 4);
  assert.equal(replies.filter((reply) => reply.includes("спам")).length, 1);
  assert.equal(database.getUser(1)?.user_id, 1);
});

test("only start and about register users, groups ignored", async (context) => {
  const { database } = temporaryDatabase(context);
  const bot = new Bot(`123456789:${"a".repeat(35)}`, { botInfo });
  const replies: string[] = [];
  mockApi(bot.api, (method, payload) => {
    if (method === "sendMessage" && isRecord(payload)) replies.push(String(payload.text));
    return true;
  });
  registerHandlers(bot, database);
  await bot.handleUpdate(message(1, "help"));
  assert.equal(database.getUser(1), undefined);
  await bot.handleUpdate(message(2, "start", true));
  assert.equal(database.getUser(1), undefined);
  await bot.handleUpdate(message(3, "about"));
  await bot.handleUpdate(message(4, "start"));
  assert.equal(replies.length, 2);
  assert.equal(database.getUser(1)?.is_active, 1);
});

test("about button uses the command counter and ignores further blocked requests", async (context) => {
  const { database } = temporaryDatabase(context);
  const bot = new Bot(`123456789:${"a".repeat(35)}`, { botInfo });
  const replies: string[] = [];
  mockApi(bot.api, (method, payload) => {
    if (method === "sendMessage" && isRecord(payload)) replies.push(String(payload.text));
    return true;
  });
  registerHandlers(bot, database);
  for (let index = 0; index < 3; index += 1) await bot.handleUpdate(message(index, "about"));
  for (const updateId of [4, 5]) {
    const original = message(1, "start").message;
    assert.ok(original);
    await bot.handleUpdate({
      update_id: updateId,
      callback_query: {
        id: String(updateId),
        from: { id: 1, is_bot: false, first_name: "test" },
        chat_instance: "instance",
        data: "about",
        message: original,
      },
    });
  }
  assert.equal(replies.length, 4);
  assert.equal(replies.filter((reply) => reply.includes("спам")).length, 1);
});
