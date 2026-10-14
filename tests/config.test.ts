import assert from "node:assert/strict";
import { test } from "node:test";
import { readConfig } from "../src/config.js";

const token = `123456789:${"a".repeat(35)}`;

test("configuration defaults and optional GitHub token", () => {
  const config = readConfig({ BOT_TOKEN: token });
  assert.equal(config.checkInterval, 300);
  assert.equal(config.includePrereleases, true);
  assert.equal(config.githubToken, "");
});

for (const [name, value] of [
  ["BOT_TOKEN", ""],
  ["BOT_TOKEN", "invalid"],
  ["GITHUB_REPOSITORY", "../bad/path"],
  ["CHECK_INTERVAL_SECONDS", "0"],
  ["CHECK_INTERVAL_SECONDS", "bad"],
  ["CHECK_INTERVAL_SECONDS", "1.5"],
  ["CHECK_INTERVAL_SECONDS", "9007199254740992"],
  ["INCLUDE_PRERELEASES", "yes"],
  ["DATABASE_PATH", ""],
  ["DATABASE_PATH", ":memory:"],
] as const) {
  test(`rejects invalid ${name}: ${value}`, () => {
    assert.throws(() => readConfig({ BOT_TOKEN: token, [name]: value }));
  });
}

test("supports explicit prerelease opt-out", () => {
  assert.equal(
    readConfig({ BOT_TOKEN: token, INCLUDE_PRERELEASES: "false" }).includePrereleases,
    false,
  );
});
