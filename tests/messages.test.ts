import assert from "node:assert/strict";
import { test } from "node:test";
import { aboutMessage, botSourceUrl, htmlText, releaseMessage } from "../src/messages.js";
import { release } from "./fixtures.js";

test("empty description is not invented and concrete release is linked", () => {
  const payload = { ...release(1), body: "" };
  const { text, keyboard } = releaseMessage(payload);
  assert.ok(text.includes("описание изменений не опубликовано"));
  const button = keyboard.inline_keyboard[0]?.[0];
  assert.ok(button && "url" in button);
  assert.equal(button.url, payload.html_url);
});

test("escaped entities and astral text remain within Telegram limits", () => {
  const payload = {
    ...release(1),
    name: "&".repeat(1000),
    tag_name: "<".repeat(1000),
    body: '"&<>𐀀'.repeat(10000),
  };
  const { text } = releaseMessage(payload);
  assert.ok(text.length < 4096);
  assert.ok(text.includes("&amp;"));
  assert.ok(!text.includes("𐀀\ud800"));
  assert.ok(!text.includes("<script>"));
});

test("standard emoji and control characters are removed without breaking kaomoji", () => {
  assert.equal(htmlText("🚀🇯🇵☀️1️⃣\u0000 (｡•̀ᴗ-)✧", 100), "1 (｡•̀ᴗ-)✧");
  assert.equal(htmlText("<script>&", 100), "&lt;script&gt;&amp;");
});

test("about ends with independent bot source link", () => {
  assert.ok(aboutMessage.includes("независимый проект"));
  assert.ok(aboutMessage.endsWith(`<a href="${botSourceUrl}">исходный код бота</a>`));
});
