import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Sqlite from "better-sqlite3";
import type { Release } from "./releases.js";

export type Command = "start" | "about";
export type CommandDecision = "allowed" | "blocked" | "jailed";
export type DeliveryState = "pending" | "sent" | "failed";

export interface User {
  user_id: number;
  first_seen_at: number;
  last_seen_at: number;
  is_active: number;
  jail_until: number;
}

export interface Delivery {
  release_id: number;
  user_id: number;
  state: DeliveryState;
  attempts: number;
  next_attempt_at: number;
  payload: string;
}

export class Database {
  readonly connection: Sqlite.Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.connection = new Sqlite(path, { timeout: 10_000 });
    this.connection.pragma("journal_mode=WAL");
    this.connection.pragma("synchronous=FULL");
    this.connection.pragma("foreign_keys=ON");
    this.connection.exec(`
      CREATE TABLE IF NOT EXISTS users (
        user_id INTEGER PRIMARY KEY,
        first_seen_at REAL NOT NULL,
        last_seen_at REAL NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1,
        jail_until REAL NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS command_events (
        user_id INTEGER NOT NULL REFERENCES users(user_id),
        command TEXT NOT NULL,
        called_at REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS command_window ON command_events(user_id, command, called_at);
      CREATE INDEX IF NOT EXISTS command_expiration ON command_events(called_at);
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS releases (
        release_id INTEGER PRIMARY KEY,
        published_at TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS deliveries (
        release_id INTEGER NOT NULL REFERENCES releases(release_id),
        user_id INTEGER NOT NULL REFERENCES users(user_id),
        state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending', 'sent', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at REAL NOT NULL DEFAULT 0,
        PRIMARY KEY(release_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS delivery_queue ON deliveries(state, next_attempt_at);
    `);
  }

  close(): void {
    this.connection.close();
  }

  getUser(userId: number): User | undefined {
    return this.connection
      .prepare<[number], User>("SELECT * FROM users WHERE user_id=?")
      .get(userId);
  }

  registerUser(userId: number, now: number): void {
    if (!Number.isSafeInteger(userId) || userId < 1) throw new Error("Invalid Telegram user ID");
    this.connection
      .prepare(`
      INSERT INTO users(user_id, first_seen_at, last_seen_at) VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET last_seen_at=excluded.last_seen_at, is_active=1
    `)
      .run(userId, now, now);
  }

  checkCommand(userId: number, command: Command, now: number): CommandDecision {
    return this.connection
      .transaction((): CommandDecision => {
        this.registerUser(userId, now);
        if ((this.getUser(userId)?.jail_until ?? 0) > now) return "blocked";
        this.connection.prepare("UPDATE users SET jail_until=0 WHERE user_id=?").run(userId);
        this.connection
          .prepare("DELETE FROM command_events WHERE user_id=? AND called_at<=?")
          .run(userId, now - 60);
        this.connection
          .prepare("INSERT INTO command_events VALUES (?, ?, ?)")
          .run(userId, command, now);
        const count =
          this.connection
            .prepare<[number, string], { count: number }>(
              "SELECT COUNT(*) AS count FROM command_events WHERE user_id=? AND command=?",
            )
            .get(userId, command)?.count ?? 0;
        if (count <= 3) return "allowed";
        this.connection
          .prepare("UPDATE users SET jail_until=? WHERE user_id=?")
          .run(now + 300, userId);
        this.connection.prepare("DELETE FROM command_events WHERE user_id=?").run(userId);
        return "jailed";
      })
      .immediate();
  }

  cleanup(now: number): void {
    this.connection
      .transaction(() => {
        this.connection.prepare("DELETE FROM command_events WHERE called_at<=?").run(now - 60);
        this.connection
          .prepare("UPDATE users SET jail_until=0 WHERE jail_until>0 AND jail_until<=?")
          .run(now);
      })
      .immediate();
  }

  deactivateUser(userId: number): void {
    this.connection
      .transaction(() => {
        this.connection.prepare("UPDATE users SET is_active=0 WHERE user_id=?").run(userId);
        this.connection
          .prepare("UPDATE deliveries SET state='failed' WHERE user_id=? AND state='pending'")
          .run(userId);
      })
      .immediate();
  }

  getMetadata(key: string): string | undefined {
    return this.connection
      .prepare<[string], { value: string }>("SELECT value FROM metadata WHERE key=?")
      .get(key)?.value;
  }

  setMetadata(key: string, value: string): void {
    this.connection.prepare("INSERT OR REPLACE INTO metadata VALUES (?, ?)").run(key, value);
  }

  ingestReleases(
    releases: Release[],
    repository: string,
    cache: string,
    includePrereleases: boolean,
  ): number {
    return this.connection
      .transaction(() => {
        const previousRepository = this.getMetadata("repository");
        if (previousRepository !== undefined && previousRepository !== repository) {
          throw new Error("Для другого GITHUB_REPOSITORY нужна отдельная база данных.");
        }
        let queued = 0;
        const ordered = [...releases].sort(
          (left, right) =>
            Date.parse(left.published_at) - Date.parse(right.published_at) || left.id - right.id,
        );
        for (const release of ordered) {
          const inserted = this.connection
            .prepare("INSERT OR IGNORE INTO releases VALUES (?, ?, ?)")
            .run(release.id, release.published_at, JSON.stringify(release)).changes;
          if (
            inserted &&
            previousRepository !== undefined &&
            (includePrereleases || !release.prerelease)
          ) {
            this.connection
              .prepare(`INSERT INTO deliveries(release_id, user_id)
            SELECT ?, user_id FROM users WHERE is_active=1`)
              .run(release.id);
            queued += 1;
          }
        }
        this.setMetadata("repository", repository);
        this.setMetadata("github_cache", cache);
        return queued;
      })
      .immediate();
  }

  nextDelivery(now: number): Delivery | undefined {
    return this.connection
      .prepare<[number], Delivery>(`
      SELECT d.*, r.payload FROM deliveries d
      JOIN releases r USING(release_id) JOIN users u USING(user_id)
      WHERE d.state='pending' AND d.next_attempt_at<=? AND u.is_active=1
      AND NOT EXISTS (
        SELECT 1 FROM deliveries older JOIN releases previous USING(release_id)
        WHERE older.user_id=d.user_id AND older.state='pending'
        AND (julianday(previous.published_at)<julianday(r.published_at) OR
          (julianday(previous.published_at)=julianday(r.published_at) AND older.release_id<d.release_id))
      ) ORDER BY julianday(r.published_at), d.release_id, d.user_id LIMIT 1
    `)
      .get(now);
  }

  claimDelivery(now: number): Delivery | undefined {
    return this.connection
      .transaction(() => {
        const delivery = this.nextDelivery(now);
        if (!delivery) return undefined;
        this.connection
          .prepare(`UPDATE deliveries SET attempts=attempts+1, next_attempt_at=?
        WHERE release_id=? AND user_id=?`)
          .run(now + 60, delivery.release_id, delivery.user_id);
        return { ...delivery, attempts: delivery.attempts + 1, next_attempt_at: now + 60 };
      })
      .immediate();
  }

  finishDelivery(releaseId: number, userId: number, state: DeliveryState, nextAttemptAt = 0): void {
    this.connection
      .prepare(`UPDATE deliveries SET state=?, next_attempt_at=?
      WHERE release_id=? AND user_id=?`)
      .run(state, nextAttemptAt, releaseId, userId);
  }

  pauseDelivery(releaseId: number, userId: number, state: DeliveryState, retryAt: number): void {
    this.connection
      .transaction(() => {
        this.setMetadata("telegram_resume_at", String(retryAt));
        this.finishDelivery(releaseId, userId, state, retryAt);
      })
      .immediate();
  }

  acquireLease(owner: string, now: number): void {
    this.connection
      .transaction(() => {
        const expires = Number(this.getMetadata("instance_expires_at") ?? "0");
        if (expires > now) throw new Error("Бот уже запущен с этой базой данных.");
        this.setMetadata("instance_owner", owner);
        this.setMetadata("instance_expires_at", String(now + 120));
      })
      .immediate();
  }

  refreshLease(owner: string, now: number): void {
    this.connection
      .transaction(() => {
        this.assertLease(owner, now);
        this.setMetadata("instance_expires_at", String(now + 120));
      })
      .immediate();
  }

  assertLease(owner: string, now: number): void {
    if (
      this.getMetadata("instance_owner") !== owner ||
      Number(this.getMetadata("instance_expires_at") ?? "0") <= now
    ) {
      throw new Error("Application instance lease expired");
    }
  }

  releaseLease(owner: string): void {
    this.connection
      .transaction(() => {
        if (this.getMetadata("instance_owner") === owner) {
          this.connection
            .prepare("DELETE FROM metadata WHERE key IN ('instance_owner', 'instance_expires_at')")
            .run();
        }
      })
      .immediate();
  }
}
