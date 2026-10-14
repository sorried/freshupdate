from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from conftest import release

from freshupdate.database import Database

REPOSITORY = "Snowy-Fluffy/freshGram"


def test_registration_preserves_id_and_first_seen(database: Database) -> None:
    database.register_user(123456789012, 1)
    database.deactivate_user(123456789012)
    database.register_user(123456789012, 2)
    rows = database.connection.execute("SELECT * FROM users").fetchall()
    assert len(rows) == 1
    assert dict(rows[0]) == {
        "user_id": 123456789012,
        "first_seen_at": 1,
        "last_seen_at": 2,
        "is_active": 1,
        "jail_until": 0,
    }


def test_baseline_and_chronological_queue(database: Database) -> None:
    database.register_user(1, 1)
    assert database.ingest_releases([release(1)], REPOSITORY, "{}", True) == 0
    assert database.next_delivery(1) is None
    assert (
        database.ingest_releases([release(3), release(2), release(1)], REPOSITORY, "{}", True) == 2
    )
    first = database.next_delivery(1)
    assert first["release_id"] == 2
    database.finish_delivery(2, 1, "sent")
    assert database.next_delivery(1)["release_id"] == 3
    assert database.ingest_releases([release(2), release(3)], REPOSITORY, "{}", True) == 0


def test_prereleases_not_backfilled_when_enabled(database: Database) -> None:
    database.register_user(1, 1)
    database.ingest_releases([], REPOSITORY, "{}", False)
    assert database.ingest_releases([release(1, True), release(2)], REPOSITORY, "{}", False) == 1
    assert (
        database.ingest_releases([release(1, True), release(3, True)], REPOSITORY, "{}", True) == 1
    )


def test_queue_survives_restart(tmp_path: Path) -> None:
    path = tmp_path / "bot.db"
    first = Database(path)
    first.register_user(1, 1)
    first.ingest_releases([], REPOSITORY, "{}", True)
    first.ingest_releases([release(1)], REPOSITORY, "{}", True)
    first.record_attempt(1, 1, 5)
    first.close()
    second = Database(path)
    assert second.next_delivery(10) is None
    assert second.next_delivery(65)["attempts"] == 1
    second.finish_delivery(1, 1, "sent")
    second.close()
    third = Database(path)
    assert third.next_delivery(100) is None
    third.close()


def test_command_limit_and_independent_counters(database: Database) -> None:
    for now in (1, 2, 3):
        assert database.check_command(1, "start", now) == "allowed"
        assert database.check_command(1, "about", now) == "allowed"
    assert database.check_command(1, "start", 4) == "jailed"
    assert database.check_command(1, "about", 303.99) == "blocked"
    assert database.check_command(1, "about", 304) == "allowed"


def test_sliding_window_boundary(database: Database) -> None:
    for now in (0, 10, 20):
        assert database.check_command(1, "start", now) == "allowed"
    assert database.check_command(1, "start", 60) == "allowed"
    assert database.check_command(1, "start", 61) == "jailed"


def test_jail_survives_restart_and_notifies_once(tmp_path: Path) -> None:
    path = tmp_path / "bot.db"
    first = Database(path)
    outcomes = [first.check_command(1, "about", 10) for _ in range(10)]
    assert outcomes.count("jailed") == 1
    first.close()
    second = Database(path)
    assert second.check_command(1, "start", 309) == "blocked"
    assert second.check_command(1, "start", 310) == "allowed"
    assert [second.check_command(1, "start", 311) for _ in range(3)][-1] == "jailed"
    second.close()


def test_atomic_parallel_updates(tmp_path: Path) -> None:
    path = tmp_path / "bot.db"
    Database(path).close()

    def invoke(_: int) -> str:
        connection = Database(path)
        try:
            return connection.check_command(1, "start", 100)
        finally:
            connection.close()

    with ThreadPoolExecutor(max_workers=8) as executor:
        outcomes = list(executor.map(invoke, range(20)))
    assert outcomes.count("allowed") == 3
    assert outcomes.count("jailed") == 1
    assert outcomes.count("blocked") == 16


def test_cleanup_removes_expired_events_and_jail(database: Database) -> None:
    for _ in range(4):
        database.check_command(1, "start", 1)
    database.check_command(2, "about", 1)
    database.cleanup(301)
    assert database.connection.execute("SELECT COUNT(*) FROM command_events").fetchone()[0] == 0
    assert database.connection.execute("SELECT MAX(jail_until) FROM users").fetchone()[0] == 0
