import time

from freshupdate.database import Database

JAIL_MESSAGE = "(╥﹏╥) ты временно заблокирован за спам командами. попробуй снова через 5 минут."


def check_command(database: Database, user_id: int, command: str) -> str:
    return database.check_command(user_id, command, time.time())
