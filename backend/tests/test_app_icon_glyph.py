from backend.apps.outputs.app_icon import glyph_icon


def test_an_emoji_is_an_icon_and_names_words_and_initials_are_not():
    assert glyph_icon("🚀") == "🚀"
    assert glyph_icon(" 🇫🇷 ") == "🇫🇷"
    assert glyph_icon("👨‍💻") == "👨‍💻"
    assert glyph_icon("view_quilt") is None
    assert glyph_icon("rocket") is None
    assert glyph_icon("A") is None
    assert glyph_icon("42") is None
    assert glyph_icon("") is None
    assert glyph_icon(None) is None
    assert glyph_icon({"emoji": "🚀"}) is None
