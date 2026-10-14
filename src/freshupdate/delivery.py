import asyncio
import json
import logging
import time

from aiogram import Bot
from aiogram.exceptions import (
    TelegramAPIError,
    TelegramForbiddenError,
    TelegramNetworkError,
    TelegramRetryAfter,
    TelegramServerError,
)

from freshupdate.database import Database
from freshupdate.messages import release_message

logger = logging.getLogger(__name__)
MAX_ATTEMPTS = 5


class DeliveryWorker:
    def __init__(self, database: Database, bot: Bot) -> None:
        self.database = database
        self.bot = bot

    async def deliver_once(self) -> bool:
        now = time.time()
        resume_at = float(self.database.get_metadata("telegram_resume_at") or "0")
        if resume_at > now:
            return False
        delivery = self.database.next_delivery(now)
        if delivery is None:
            return False
        release_id, user_id = delivery["release_id"], delivery["user_id"]
        if delivery["attempts"] >= MAX_ATTEMPTS:
            self.database.finish_delivery(release_id, user_id, "failed")
            return True
        text, keyboard = release_message(json.loads(delivery["payload"]))
        attempts = self.database.record_attempt(release_id, user_id, now)
        try:
            await self.bot.send_message(
                user_id,
                text,
                reply_markup=keyboard,
                parse_mode="HTML",
                disable_web_page_preview=True,
            )
        except TelegramForbiddenError:
            self.database.deactivate_user(user_id)
        except TelegramRetryAfter as error:
            retry_at = time.time() + max(1, error.retry_after)
            self.database.set_metadata("telegram_resume_at", str(retry_at))
            self.database.finish_delivery(
                release_id,
                user_id,
                "failed" if attempts >= MAX_ATTEMPTS else "pending",
                retry_at,
            )
            logger.warning("Telegram flood limit; delivery paused")
        except (TelegramNetworkError, TelegramServerError):
            self.database.finish_delivery(
                release_id,
                user_id,
                "failed" if attempts >= MAX_ATTEMPTS else "pending",
                time.time() + min(3600, 30 * 2**attempts),
            )
            logger.warning("Telegram delivery failed temporarily")
        except TelegramAPIError:
            self.database.finish_delivery(release_id, user_id, "failed")
            logger.warning("Telegram rejected a delivery")
        else:
            self.database.finish_delivery(release_id, user_id, "sent")
        return True

    async def run(self) -> None:
        while True:
            delivered = await self.deliver_once()
            await asyncio.sleep(0.05 if delivered else 1)
