import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { temporarydatabase } from "./fixtures.js";
import { botinfo } from "./telegram.js";

test("webhook authenticates requests, validates payloads and handles duplicate updates", {
  timeout: 15000,
}, async (context) => {
  const { path } = temporarydatabase(context);
  const secret = "a".repeat(64);
  const moduleurl = new URL("../src/webhook.js", import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    const { Bot: botclass } = await import('grammy');
    botclass.prototype.init = async function () {
      this.botInfo = ${JSON.stringify(botinfo)};
      this.api.config.use(async () => ({ ok: true, result: true }));
    };
    globalThis.fetch = async () => new Response('[]');
    await import(${JSON.stringify(moduleurl)});
  `,
    ],
    {
      env: {
        ...process.env,
        BOT_TOKEN: `123456789:${"a".repeat(35)}`,
        DATABASE_PATH: path,
        API_SECRET: secret,
        API_PORT: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  context.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await once(child, "exit");
    }
  });
  const url = await new Promise<string>((resolve, reject) => {
    let output = "";
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      const match = output.match(/Webhook API listening on (127\.0\.0\.1:\d+)/);
      if (match) resolve(`http://${match[1]}/updates`);
    });
    child.once("error", reject);
    child.once("exit", () => reject(new Error(`Webhook exited before readiness: ${output}`)));
  });
  const headers = { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" };
  assert.equal((await fetch(url, { method: "POST", body: "{}" })).status, 401);
  assert.equal((await fetch(url, { headers })).status, 404);
  assert.equal(
    (
      await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${secret}` },
        body: "{}",
      })
    ).status,
    415,
  );
  for (const body of ["{", "{}", '{"update_id":"invalid"}']) {
    assert.equal((await fetch(url, { method: "POST", headers, body })).status, 400);
  }
  assert.equal(
    (await fetch(url, { method: "POST", headers, body: "x".repeat(131073) })).status,
    413,
  );
  for (let attempt = 0; attempt < 2; attempt += 1) {
    assert.equal(
      (await fetch(url, { method: "POST", headers, body: '{"update_id":1}' })).status,
      204,
    );
  }
  child.kill("SIGTERM");
  const [code] = await once(child, "exit");
  assert.equal(code, 0);
});
