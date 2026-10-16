import assert from "node:assert/strict";
import { test } from "node:test";
import { readconfig } from "../src/config.js";

const token = `123456789:${"a".repeat(35)}`;

test("configuration defaults and optional GitHub token", () => {
  const config = readconfig({ BOT_TOKEN: token });
  assert.equal(config.checkinterval, 300);
  assert.equal(config.includeprereleases, true);
  assert.equal(config.githubtoken, "");
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
    assert.throws(() => readconfig({ BOT_TOKEN: token, [name]: value }));
  });
}

test("supports explicit prerelease opt-out", () => {
  assert.equal(
    readconfig({ BOT_TOKEN: token, INCLUDE_PRERELEASES: "false" }).includeprereleases,
    false,
  );
});
