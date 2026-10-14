from conftest import release

from freshupdate.messages import ABOUT_MESSAGE, BOT_SOURCE_URL, release_message


def test_empty_description_is_not_invented() -> None:
    payload = release(1)
    payload["body"] = ""
    text, keyboard = release_message(payload)
    assert "описание изменений не опубликовано" in text
    assert keyboard.inline_keyboard[0][0].url == payload["html_url"]


def test_long_html_and_astral_characters_are_safe() -> None:
    payload = release(1)
    payload["name"] = "<b>" * 500
    payload["tag_name"] = "<&" * 500
    payload["body"] = "<script>&🚀" * 5000
    text, _ = release_message(payload)
    assert "<script>" not in text
    assert "&lt;script&gt;" in text
    assert "🚀" not in text
    assert len(text.encode("utf-16-le")) // 2 < 4096


def test_about_ends_with_bot_source() -> None:
    assert ABOUT_MESSAGE.endswith(f'<a href="{BOT_SOURCE_URL}">исходный код бота</a>')


def test_escaped_entities_stay_within_message_limit() -> None:
    payload = release(1)
    payload["name"] = "&" * 1000
    payload["tag_name"] = "<" * 1000
    payload["body"] = '"&<>' * 10000
    text, _ = release_message(payload)
    assert len(text.encode("utf-16-le")) // 2 < 4096
    assert "&amp;" in text
