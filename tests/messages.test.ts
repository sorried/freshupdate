import assert from "node:assert/strict";
import { test } from "node:test";
import { aboutmessage, botsourceurl, htmltext, releasemessage } from "../src/messages.js";
import { release } from "./fixtures.js";

test("empty description is not invented and concrete release is linked", () => {
  const payload = { ...release(1), body: "" };
  const { text, keyboard } = releasemessage(payload);
  assert.ok(text.includes("подробности доступны по кнопке ниже"));
  const button = keyboard.inline_keyboard[0]?.[0];
  assert.ok(button && "url" in button);
  assert.equal(button.url, payload.html_url);
});

test("release notification contains only version and readable unique changes", () => {
  const { text } = releasemessage({
    ...release(1),
    body: [
      "## What's Changed",
      "* **Fixed** `notifications`",
      "* **Fixed** `notifications`",
      "- Added [settings](https://example.com/settings)",
      "**Full Changelog**: https://github.com/example/app/compare/v0...v1",
      "**Full Changelog**: https://github.com/example/app/compare/v0...v1",
    ].join("\n\n"),
  });
  assert.equal(text, "(｡•̀ᴗ-)✧ <b>freshGram v1</b>\n\n- Fixed notifications\n- Added settings");
});

test("compare links alone are not presented as changes", () => {
  const { text } = releasemessage({
    ...release(1),
    body: Array(3)
      .fill("**Full Changelog**: https://github.com/example/app/compare/v0...v1")
      .join("\n\n"),
  });
  assert.ok(text.includes("подробности доступны по кнопке ниже"));
  assert.ok(!text.includes("Full Changelog"));
  assert.ok(!text.includes("https://"));
});

test("long release notes are shortened with details left behind the button", () => {
  const { text, keyboard } = releasemessage({
    ...release(1),
    body: Array.from({ length: 20 }, (_, index) => `- Change ${index}`).join("\n"),
  });
  assert.ok(text.includes("- Change 4"));
  assert.ok(!text.includes("- Change 5"));
  assert.ok(text.endsWith("…"));
  assert.equal(keyboard.inline_keyboard[0]?.length, 1);
});

test("escaped entities and astral text remain within Telegram limits", () => {
  const payload = {
    ...release(1),
    name: "&".repeat(1000),
    tag_name: "<".repeat(1000),
    body: '"&<>𐀀'.repeat(10000),
  };
  const { text } = releasemessage(payload);
  assert.ok(text.length < 4096);
  assert.ok(text.includes("&amp;"));
  assert.ok(!text.includes("𐀀\ud800"));
  assert.ok(!text.includes("<script>"));
});

test("standard emoji and control characters are removed without breaking kaomoji", () => {
  assert.equal(htmltext("🚀🇯🇵☀️1️⃣\u0000 (｡•̀ᴗ-)✧", 100), "1 (｡•̀ᴗ-)✧");
  assert.equal(htmltext("<script>&", 100), "&lt;script&gt;&amp;");
});

test("about ends with independent bot source link", () => {
  assert.ok(aboutmessage.includes("независимый проект"));
  assert.ok(aboutmessage.endsWith(`<a href="${botsourceurl}">исходный код бота</a>`));
});
