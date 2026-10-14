import json
import sqlite3
from pathlib import Path
from typing import Any


class Database:
    def __init__(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(path, timeout=10)
        self.connection.row_factory = sqlite3.Row
        self.connection.execute("PRAGMA journal_mode=WAL")
        self.connection.execute("PRAGMA synchronous=FULL")
        self.connection.execute("PRAGMA foreign_keys=ON")
        self.connection.executescript(
            """
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
            CREATE INDEX IF NOT EXISTS command_window
                ON command_events(user_id, command, called_at);
            CREATE INDEX IF NOT EXISTS command_expiration ON command_events(called_at);
            CREATE TABLE IF NOT EXISTS metadata (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS releases (
                release_id INTEGER PRIMARY KEY,
                published_at TEXT NOT NULL,
                payload TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS deliveries (
                release_id INTEGER NOT NULL REFERENCES releases(release_id),
                user_id INTEGER NOT NULL REFERENCES users(user_id),
                state TEXT NOT NULL DEFAULT 'pending'
                    CHECK(state IN ('pending', 'sent', 'failed')),
                attempts INTEGER NOT NULL DEFAULT 0,
                next_attempt_at REAL NOT NULL DEFAULT 0,
                PRIMARY KEY(release_id, user_id)
            );
            CREATE INDEX IF NOT EXISTS delivery_queue
                ON deliveries(state, next_attempt_at);
            """
        )

    def close(self) -> None:
        self.connection.close()

    def register_user(self, user_id: int, now: float) -> None:
        with self.connection:
            self._register_user(user_id, now)

    def _register_user(self, user_id: int, now: float) -> None:
        self.connection.execute(
            """INSERT INTO users(user_id, first_seen_at, last_seen_at) VALUES (?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET last_seen_at=excluded.last_seen_at,
                is_active=1""",
            (user_id, now, now),
        )

    def check_command(self, user_id: int, command: str, now: float) -> str:
        with self.connection:
            self.connection.execute("BEGIN IMMEDIATE")
            self._register_user(user_id, now)
            jail_until = self.connection.execute(
                "SELECT jail_until FROM users WHERE user_id=?", (user_id,)
            ).fetchone()[0]
            if jail_until > now:
                return "blocked"
            self.connection.execute("UPDATE users SET jail_until=0 WHERE user_id=?", (user_id,))
            self.connection.execute(
                "DELETE FROM command_events WHERE user_id=? AND called_at<=?", (user_id, now - 60)
            )
            self.connection.execute(
                "INSERT INTO command_events VALUES (?, ?, ?)", (user_id, command, now)
            )
            count = self.connection.execute(
                "SELECT COUNT(*) FROM command_events WHERE user_id=? AND command=?",
                (user_id, command),
            ).fetchone()[0]
            if count <= 3:
                return "allowed"
            self.connection.execute(
                "UPDATE users SET jail_until=? WHERE user_id=?", (now + 300, user_id)
            )
            self.connection.execute("DELETE FROM command_events WHERE user_id=?", (user_id,))
            return "jailed"

    def cleanup(self, now: float) -> None:
        with self.connection:
            self.connection.execute("DELETE FROM command_events WHERE called_at<=?", (now - 60,))
            self.connection.execute(
                "UPDATE users SET jail_until=0 WHERE jail_until>0 AND jail_until<=?", (now,)
            )

    def deactivate_user(self, user_id: int) -> None:
        with self.connection:
            self.connection.execute("UPDATE users SET is_active=0 WHERE user_id=?", (user_id,))
            self.connection.execute(
                "UPDATE deliveries SET state='failed' WHERE user_id=? AND state='pending'",
                (user_id,),
            )

    def get_metadata(self, key: str) -> str | None:
        row = self.connection.execute("SELECT value FROM metadata WHERE key=?", (key,)).fetchone()
        return row[0] if row else None

    def ingest_releases(
        self,
        releases: list[dict[str, Any]],
        repository: str,
        cache: str,
        include_prereleases: bool,
    ) -> int:
        with self.connection:
            self.connection.execute("BEGIN IMMEDIATE")
            previous_repository = self.get_metadata("repository")
            if previous_repository is not None and previous_repository != repository:
                raise ValueError("GITHUB_REPOSITORY изменён. Используйте отдельную базу данных.")
            initialized = previous_repository is not None
            queued = 0
            for release in sorted(releases, key=lambda item: (item["published_at"], item["id"])):
                inserted = self.connection.execute(
                    "INSERT OR IGNORE INTO releases VALUES (?, ?, ?)",
                    (release["id"], release["published_at"], json.dumps(release)),
                ).rowcount
                if inserted and initialized and (include_prereleases or not release["prerelease"]):
                    self.connection.execute(
                        """INSERT INTO deliveries(release_id, user_id)
                        SELECT ?, user_id FROM users WHERE is_active=1""",
                        (release["id"],),
                    )
                    queued += 1
            self.connection.executemany(
                "INSERT OR REPLACE INTO metadata VALUES (?, ?)",
                [("repository", repository), ("github_cache", cache)],
            )
            return queued

    def next_delivery(self, now: float) -> sqlite3.Row | None:
        return self.connection.execute(
            """SELECT d.*, r.payload FROM deliveries d
            JOIN releases r USING(release_id) JOIN users u USING(user_id)
            WHERE d.state='pending' AND d.next_attempt_at<=? AND u.is_active=1
            AND NOT EXISTS (
                SELECT 1 FROM deliveries older JOIN releases previous USING(release_id)
                WHERE older.user_id=d.user_id AND older.state='pending'
                AND (previous.published_at<r.published_at OR
                    (previous.published_at=r.published_at AND older.release_id<d.release_id))
            )
            ORDER BY r.published_at, d.release_id, d.user_id LIMIT 1""",
            (now,),
        ).fetchone()

    def record_attempt(self, release_id: int, user_id: int, now: float) -> int:
        with self.connection:
            self.connection.execute(
                """UPDATE deliveries SET attempts=attempts+1, next_attempt_at=?
                WHERE release_id=? AND user_id=?""",
                (now + 60, release_id, user_id),
            )
            return self.connection.execute(
                "SELECT attempts FROM deliveries WHERE release_id=? AND user_id=?",
                (release_id, user_id),
            ).fetchone()[0]

    def finish_delivery(
        self,
        release_id: int,
        user_id: int,
        state: str,
        next_attempt_at: float = 0,
    ) -> None:
        with self.connection:
            self.connection.execute(
                """UPDATE deliveries SET state=?, next_attempt_at=?
                WHERE release_id=? AND user_id=?""",
                (state, next_attempt_at, release_id, user_id),
            )
