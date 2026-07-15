"""MCP tool surface for X (Twitter): the full set of things a logged-in human can do.

Reads (timeline/search/tweet/user/bookmarks/notifications) and writes (tweet with
reply+quote, delete, like, retweet, bookmark, follow, DM). A tweet `target` may be a
status URL, a numeric id, or a t-prefixed id; the read tools return ids you pass back.
"""

OBJ = "object"

TOOLS = [
    {
        "name": "x_whoami",
        "description": "Confirm the logged-in X session and return your handle + profile. Use first to verify the session is live.",
        "inputSchema": {"type": OBJ, "properties": {}},
    },
    {
        "name": "x_timeline",
        "description": "Read your home timeline (the For You or Following feed).",
        "inputSchema": {
            "type": OBJ,
            "properties": {
                "kind": {"type": "string", "enum": ["foryou", "following"], "default": "foryou"},
                "count": {"type": "integer", "default": 20, "description": "1-100"},
                "cursor": {"type": "string", "description": "Pagination cursor from a previous call."},
            },
        },
    },
    {
        "name": "x_user_tweets",
        "description": "Read a user's recent tweets and replies by @handle.",
        "inputSchema": {
            "type": OBJ,
            "properties": {
                "username": {"type": "string", "description": "Handle, with or without @."},
                "count": {"type": "integer", "default": 20},
                "cursor": {"type": "string"},
            },
            "required": ["username"],
        },
    },
    {
        "name": "x_get_tweet",
        "description": "Get a tweet plus its replies. target is a status URL, a numeric id, or a t-prefixed id.",
        "inputSchema": {
            "type": OBJ,
            "properties": {
                "target": {"type": "string"},
                "replies_limit": {"type": "integer", "default": 30},
            },
            "required": ["target"],
        },
    },
    {
        "name": "x_search",
        "description": "Search tweets. product: top, latest, people, or media.",
        "inputSchema": {
            "type": OBJ,
            "properties": {
                "query": {"type": "string"},
                "product": {"type": "string", "enum": ["top", "latest", "people", "media"], "default": "top"},
                "count": {"type": "integer", "default": 20},
                "cursor": {"type": "string"},
            },
            "required": ["query"],
        },
    },
    {
        "name": "x_get_user",
        "description": "Get a user's profile (bio, follower/following/tweet counts) by @handle.",
        "inputSchema": {
            "type": OBJ,
            "properties": {"username": {"type": "string"}},
            "required": ["username"],
        },
    },
    {
        "name": "x_bookmarks",
        "description": "List your bookmarked tweets.",
        "inputSchema": {
            "type": OBJ,
            "properties": {
                "count": {"type": "integer", "default": 20},
                "cursor": {"type": "string"},
            },
        },
    },
    {
        "name": "x_notifications",
        "description": "Read your notifications (mentions, likes, follows, replies).",
        "inputSchema": {
            "type": OBJ,
            "properties": {
                "count": {"type": "integer", "default": 20},
                "cursor": {"type": "string"},
            },
        },
    },
    {
        "name": "x_tweet",
        "description": "Post a tweet. Set reply_to to reply to a tweet, or quote_id to quote one (both accept a URL/id).",
        "inputSchema": {
            "type": OBJ,
            "properties": {
                "text": {"type": "string"},
                "reply_to": {"type": "string", "description": "Tweet URL/id to reply to."},
                "quote_id": {"type": "string", "description": "Tweet URL/id to quote."},
            },
            "required": ["text"],
        },
    },
    {
        "name": "x_delete_tweet",
        "description": "Delete one of your own tweets by URL/id.",
        "inputSchema": {
            "type": OBJ,
            "properties": {"target": {"type": "string"}},
            "required": ["target"],
        },
    },
    {
        "name": "x_like",
        "description": "Like a tweet (or unlike with unlike=true).",
        "inputSchema": {
            "type": OBJ,
            "properties": {
                "target": {"type": "string"},
                "unlike": {"type": "boolean", "default": False},
            },
            "required": ["target"],
        },
    },
    {
        "name": "x_retweet",
        "description": "Retweet a tweet (or undo with undo=true).",
        "inputSchema": {
            "type": OBJ,
            "properties": {
                "target": {"type": "string"},
                "undo": {"type": "boolean", "default": False},
            },
            "required": ["target"],
        },
    },
    {
        "name": "x_bookmark",
        "description": "Bookmark a tweet (or remove with remove=true).",
        "inputSchema": {
            "type": OBJ,
            "properties": {
                "target": {"type": "string"},
                "remove": {"type": "boolean", "default": False},
            },
            "required": ["target"],
        },
    },
    {
        "name": "x_follow",
        "description": "Follow a user by @handle (or unfollow with unfollow=true).",
        "inputSchema": {
            "type": OBJ,
            "properties": {
                "username": {"type": "string"},
                "unfollow": {"type": "boolean", "default": False},
            },
            "required": ["username"],
        },
    },
    {
        "name": "x_send_dm",
        "description": "Send a direct message. recipient is a @handle or a numeric user id.",
        "inputSchema": {
            "type": OBJ,
            "properties": {
                "recipient": {"type": "string"},
                "text": {"type": "string"},
            },
            "required": ["recipient", "text"],
        },
    },
]
