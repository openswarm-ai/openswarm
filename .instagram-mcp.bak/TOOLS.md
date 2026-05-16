# instagram-mcp-buddy — Tool reference

Tools registered at the MCP server depend on which feature flags are enabled in the current npm build. As of v0.1.x, **18 of 34** tools ship enabled — the read-only baseline. The rest light up as Meta App Review clears the corresponding permissions.

Legend:

- **always-on** — registered in every build, including v0.1.0.
- **publishing** — gated on the `publishing` flag (Meta `instagram_business_content_publish`).
- **commentModeration** — gated on the `commentModeration` flag (write half of `instagram_business_manage_comments`).
- **messaging** — gated on the `messaging` flag (`instagram_business_manage_messages`).

---

## Auth

### `instagram_connect`  · always-on  · destructive
Sign in to Instagram. Opens the browser, runs OAuth, stores the long-lived token in the OS keychain. Returns the connected `username`, `ig_user_id`, `granted_scopes`, and the list of `enabled_features` in this build.

### `instagram_logout`  · always-on  · destructive
Clear the stored access token from this machine.

### `instagram_status`  · always-on  · read-only, idempotent
Report whether Instagram is connected and which capabilities are available. Safe to call before `instagram_connect`. Agents should hit this first.

---

## Account

### `instagram_who_am_i`  · always-on  · read-only, idempotent
Authenticated account profile: `ig_user_id`, `username`, `name`, `account_type`, follower / follows / media counts, profile picture, biography, website.

---

## Media

### `instagram_get_media`  · always-on  · read-only, idempotent
Full details for one of your posts: like / comment counts, caption, permalink, timestamp, comment-enabled flag.

### `instagram_list_recent_media`  · always-on  · read-only, idempotent
Your posts in reverse chronological order, paginated with `after_cursor`.

### `instagram_delete_media`  · publishing  · destructive
Permanently delete one of your posts. Irreversible — agents should confirm with the user first.

### `instagram_toggle_comments`  · commentModeration  · destructive
Enable or disable comments on a post.

---

## Insights

### `instagram_get_media_insights`  · always-on  · read-only, idempotent
Per-post analytics. Auto-selects the metric set for the media type (IMAGE / VIDEO / REELS / CAROUSEL).

### `instagram_get_story_insights`  · always-on  · read-only, idempotent
Story metrics (views, reach, replies, navigation, exits, profile activity). Call within 24h — Story insights expire when the story does.

### `instagram_get_account_insights`  · always-on  · read-only, idempotent
Account-level analytics over a date range (≤30 days): reach, profile views, accounts engaged, total interactions, follows/unfollows, link taps, website clicks.

### `instagram_get_audience_insights`  · always-on  · read-only, idempotent
Audience demographics: city / country / age / gender / age_gender breakdowns. Requires ≥100 followers.

---

## Comments

### `instagram_list_comments`  · always-on  · read-only, idempotent
Paginated top-level comments on one of your posts.

### `instagram_list_comment_replies`  · always-on  · read-only, idempotent
Replies (child comments) on a parent comment.

### `instagram_reply_to_comment`  · commentModeration  · destructive
Post a reply on a comment.

### `instagram_delete_comment`  · commentModeration  · destructive
Delete a comment. Any comment on your media, or any comment you authored.

### `instagram_hide_comment`  · commentModeration  · destructive
Hide or unhide a comment (keeps the comment but suppresses it for other viewers).

---

## Hashtags

### `instagram_search_hashtag`  · always-on  · read-only, idempotent
Resolve a hashtag name to its Graph API id. **Counts toward Meta's limit of 30 unique hashtag searches per 7-day rolling window per account.** Cache the returned id.

### `instagram_get_hashtag_top_media`  · always-on  · read-only, idempotent
Highest-performing public posts for a hashtag, ranked by Instagram.

### `instagram_get_hashtag_recent_media`  · always-on  · read-only, idempotent
Most recent public posts (last 24h) tagged with the hashtag.

---

## Discovery

### `instagram_business_discovery`  · always-on  · read-only, idempotent
Look up a public Business or Creator account by username. Optionally fetches their recent media. Use for competitor research, partner vetting, audience analysis. Personal accounts are not accessible.

---

## Mentions

### `instagram_get_mentioned_comment`  · always-on  · read-only, idempotent
Read a comment that @-mentioned your account. Production usage receives ids via the `mentions` webhook.

### `instagram_get_mentioned_media`  · always-on  · read-only, idempotent
Read a public post that @-tagged your account.

---

## Publishing

### `instagram_publish_image`  · publishing  · destructive
Single image post in one call. JPEG/PNG, ≤8MB, aspect ratio 4:5 to 1.91:1, HTTPS. Returns `media_id` and `permalink`.

### `instagram_publish_carousel`  · publishing  · destructive
2–10 mixed image / video children, assembled into a CAROUSEL container and published.

### `instagram_publish_reel`  · publishing  · destructive
Reel: MP4, ≤100MB, ≤90s, H.264 + AAC, HTTPS. Reels can take several minutes to process — polls up to `IG_REEL_TIMEOUT_MS`.

### `instagram_publish_story_image`  · publishing  · destructive
Image Story. Expires 24h after publishing.

### `instagram_publish_story_video`  · publishing  · destructive
Video Story (≤60s). Expires 24h after publishing.

---

## Containers (low-level publishing)

For agents that need to schedule. Containers expire 24h after creation.

### `instagram_create_container`  · publishing  · destructive
Create a media container without publishing.

### `instagram_get_container_status`  · publishing  · read-only, idempotent
Poll container processing status: IN_PROGRESS / FINISHED / ERROR / EXPIRED / PUBLISHED.

### `instagram_publish_container`  · publishing  · destructive
Publish a FINISHED container.

---

## Direct Messages

### `instagram_list_conversations`  · messaging  · read-only, idempotent
Recent DM conversations.

### `instagram_list_messages`  · messaging  · read-only, idempotent
Messages in a conversation, newest first.

### `instagram_send_message`  · messaging  · destructive
Send a DM. **Meta Messenger Platform constraint:** free-form messages are only allowed within 24h of the recipient's last message to your account. Outside that window requires a `message_tag` (only `HUMAN_AGENT` is supported, and itself requires special permission).
