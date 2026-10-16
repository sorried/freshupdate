import assert from "node:assert/strict";
import { test } from "node:test";
import { Bot } from "grammy";
import type { Update } from "grammy/types";
import { registerhandlers } from "../src/handlers.js";
import { aboutmessage, jailmessage, startmessage } from "../src/messages.js";
import { isrecord } from "../src/releases.js";
import { temporarydatabase } from "./fixtures.js";
import { botinfo, mockapi } from "./telegram.js";

function message(updateid: number, command: string, group = false): Update {
  return {
    update_id: updateid,
    message: {
      message_id: updateid,
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
  const { database } = temporarydatabase(context);
  const bot = new Bot(`123456789:${"a".repeat(35)}`, { botInfo: botinfo });
  const replies: string[] = [];
  mockapi(bot.api, (method, payload) => {
    if (method === "sendMessage" && isrecord(payload)) replies.push(String(payload.text));
    return true;
  });
  registerhandlers(bot, database);
  await Promise.all(
    Array.from({ length: 10 }, (_, index) => bot.handleUpdate(message(index, "start"))),
  );
  assert.equal(replies.length, 4);
  assert.equal(replies.filter((reply) => reply === jailmessage).length, 1);
  assert.equal(database.getuser(1)?.user_id, 1);
});

test("only start and about register users, groups ignored", async (context) => {
  const { database } = temporarydatabase(context);
  const bot = new Bot(`123456789:${"a".repeat(35)}`, { botInfo: botinfo });
  const replies: string[] = [];
  mockapi(bot.api, (method, payload) => {
    if (method === "sendMessage" && isrecord(payload)) replies.push(String(payload.text));
    return true;
  });
  registerhandlers(bot, database);
  await bot.handleUpdate(message(1, "help"));
  assert.equal(database.getuser(1), undefined);
  await bot.handleUpdate(message(2, "start", true));
  assert.equal(database.getuser(1), undefined);
  await bot.handleUpdate(message(3, "about"));
  await bot.handleUpdate(message(4, "start"));
  assert.equal(replies.length, 2);
  assert.equal(database.getuser(1)?.is_active, 1);
});

test("about button uses the command counter and ignores further blocked requests", async (context) => {
  const { database } = temporarydatabase(context);
  const bot = new Bot(`123456789:${"a".repeat(35)}`, { botInfo: botinfo });
  const replies: string[] = [];
  mockapi(bot.api, (method, payload) => {
    if (method === "sendMessage" && isrecord(payload)) replies.push(String(payload.text));
    return true;
  });
  registerhandlers(bot, database);
  for (let index = 0; index < 3; index += 1) await bot.handleUpdate(message(index, "about"));
  for (const updateid of [4, 5]) {
    const original = message(1, "start").message;
    assert.ok(original);
    await bot.handleUpdate({
      update_id: updateid,
      callback_query: {
        id: String(updateid),
        from: { id: 1, is_bot: false, first_name: "test" },
        chat_instance: "instance",
        data: "about",
        message: original,
      },
    });
  }
  assert.equal(replies.length, 3);
  assert.equal(replies.filter((reply) => reply === jailmessage).length, 0);
});

test("about and back buttons edit the original message without sending new messages", async (context) => {
  const { database } = temporarydatabase(context);
  const bot = new Bot(`123456789:${"a".repeat(35)}`, { botInfo: botinfo });
  const edits: Record<string, unknown>[] = [];
  let sent = 0;
  mockapi(bot.api, (method, payload) => {
    if (method === "sendMessage") sent += 1;
    if (method === "editMessageText" && isrecord(payload)) edits.push(payload);
    return true;
  });
  registerhandlers(bot, database);
  for (const [index, action] of ["about", "start"].entries()) {
    const original = message(42, "start").message;
    assert.ok(original);
    await bot.handleUpdate({
      update_id: index + 1,
      callback_query: {
        id: String(index),
        from: { id: 1, is_bot: false, first_name: "test" },
        chat_instance: "instance",
        data: action,
        message: original,
      },
    });
  }
  assert.equal(sent, 0);
  assert.equal(edits.length, 2);
  assert.equal(edits[0]?.text, aboutmessage);
  assert.equal(edits[1]?.text, startmessage);
  for (const edit of edits) assert.equal(edit.message_id, 42);
});
