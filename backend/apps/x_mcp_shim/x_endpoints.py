"""X (Twitter) web-client constants: the public bearer + the GraphQL operation map.

The Authorization bearer below is the PUBLIC token x.com ships to every web client
(logged-in or not); it is not a secret and not per-user. Real auth is the borrowed
auth_token + ct0 cookies. The GraphQL queryIds drift whenever X redeploys its web
app: refresh them by opening x.com in the OpenSwarm browser, watching the Network
tab for /i/api/graphql/<id>/<OpName>, and pasting the new <id> here. This is the one
drift-prone surface, deliberately isolated so a refresh is a one-line edit.

Known gap: X's newest anti-automation header (x-client-transaction-id) is generated
by obfuscated client JS we don't replicate; some endpoints may 404/403 without it.
That's the X equivalent of Reddit's bearer-harvest assumption: structurally sound,
not live-proven here.
"""

# Public web-app bearer (constant across all x.com web clients; not a credential).
WEB_BEARER = (
    "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D"
    "1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA"
)

# OpName -> queryId. Drift-prone; see module docstring to refresh from a live capture.
GRAPHQL_IDS = {
    "UserByScreenName": "G3KGOASz96M-Qu0nwmGXNg",
    "UserTweets": "E3opETHurmVJflFsUBVuUQ",
    "TweetDetail": "xOhkmRac04YFZmOzU9PJHg",
    "SearchTimeline": "nKAncKPF1fV1xltvF3UUlw",
    "HomeTimeline": "uPv755D929tshj6KsxkSZg",
    "HomeLatestTimeline": "8Rfm0g9b2-9La8Rmd1IPzw",
    "Bookmarks": "j5KExFXxK0Nz1tQNXEx6KQ",
    "CreateTweet": "znq5dRMnAYIRgIBQhGCRkg",
    "DeleteTweet": "VaenaVgh5q5ih7kvyVjgtg",
    "FavoriteTweet": "lI07N6Otwv1PhnEgXILM7A",
    "UnfavoriteTweet": "ZYKSe-w7KEslx3JhSIk5LA",
    "CreateRetweet": "ojPdsZsimiJrUGLR1sjUtA",
    "DeleteRetweet": "iQtK4dl5hBmXewYZuEOKVw",
    "CreateBookmark": "aoDbu3RHznuiSkQ9aNM67Q",
    "DeleteBookmark": "Wlmlj2-xzyS1GN3a6cj-mQ",
}

# Feature flags X's GraphQL requires; a missing key 400s with "features cannot be null".
# Also drift-prone; kept broad. Refresh alongside the queryIds.
DEFAULT_FEATURES = {
    "rweb_video_screen_enabled": False,
    "profile_label_improvements_pcf_label_in_post_enabled": True,
    "responsive_web_graphql_exclude_directive_enabled": True,
    "verified_phone_label_enabled": False,
    "creator_subscriptions_tweet_preview_api_enabled": True,
    "responsive_web_graphql_timeline_navigation_enabled": True,
    "responsive_web_graphql_skip_user_profile_image_extensions_enabled": False,
    "premium_content_api_read_enabled": False,
    "communities_web_enable_tweet_community_results_fetch": True,
    "c9s_tweet_anatomy_moderator_badge_enabled": True,
    "responsive_web_grok_analyze_button_fetch_trends_enabled": False,
    "responsive_web_grok_analyze_post_followups_enabled": True,
    "responsive_web_jetfuel_frame": False,
    "responsive_web_grok_share_attachment_enabled": True,
    "articles_preview_enabled": True,
    "responsive_web_edit_tweet_api_enabled": True,
    "graphql_is_translatable_rweb_tweet_is_translatable_enabled": True,
    "view_counts_everywhere_api_enabled": True,
    "longform_notetweets_consumption_enabled": True,
    "responsive_web_twitter_article_tweet_consumption_enabled": True,
    "tweet_awards_web_tipping_enabled": False,
    "responsive_web_grok_show_grok_translated_post": False,
    "responsive_web_grok_analysis_button_from_backend": True,
    "creator_subscriptions_quote_tweet_preview_enabled": False,
    "freedom_of_speech_not_reach_fetch_enabled": True,
    "standardized_nudges_misinfo": True,
    "tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled": True,
    "longform_notetweets_rich_text_read_enabled": True,
    "longform_notetweets_inline_media_enabled": True,
    "responsive_web_grok_image_annotation_enabled": True,
    "responsive_web_enhance_cards_enabled": False,
}
