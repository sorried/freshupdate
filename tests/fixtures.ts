import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { Database } from "../src/database.js";
import type { Release } from "../src/releases.js";

export const repository = "Snowy-Fluffy/freshGram";

export function release(id: number, prerelease = false): Release {
  return {
    id,
    name: `freshGram v${id}`,
    tag_name: `v${id}`,
    body: "Real changes",
    published_at: `2026-10-${String(id).padStart(2, "0")}T12:00:00Z`,
    html_url: `https://github.com/${repository}/releases/tag/v${id}`,
    prerelease,
  };
}

export function temporarydatabase(context: TestContext): { database: Database; path: string } {
  const directory = mkdtempSync(join(tmpdir(), "freshupdate-test-"));
  const path = join(directory, "bot.db");
  const database = new Database(path);
  context.after(() => {
    if (database.connection.open) database.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { database, path };
}
