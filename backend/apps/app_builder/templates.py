"""Default template files seeded into new App Builder workspaces."""

import os

_SKILL_PATH = os.path.join(os.path.dirname(__file__), "app_builder_skill.md")

with open(_SKILL_PATH) as _f:
    APP_BUILDER_SKILL = _f.read()

APP_BUILDER_TEMPLATE_INDEX = """\
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>App</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0f1117;
      color: #e2e8f0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .container {
      background: #1a1d27;
      border: 1px solid #2e3248;
      border-radius: 12px;
      padding: 32px;
      max-width: 600px;
      width: 100%;
      text-align: center;
    }
    h1 { font-size: 1.5rem; font-weight: 600; margin-bottom: 8px; }
    p { color: #8892a4; font-size: 0.95rem; line-height: 1.6; }
  </style>
</head>
<body>
  <div class="container">
    <h1 id="title">Ready</h1>
    <p id="desc">Describe what you want to build and the agent will update this app.</p>
  </div>
  <script>
    const input = window.APP_BUILDER_INPUT || {};
    const result = window.APP_BUILDER_BACKEND_RESULT || null;
  </script>
</body>
</html>
"""

APP_BUILDER_TEMPLATE_SCHEMA = """\
{
  "type": "object",
  "properties": {},
  "required": []
}
"""

APP_BUILDER_TEMPLATE_META = """\
{
  "name": "",
  "description": ""
}
"""

APP_BUILDER_TEMPLATE_FILES = {
    "index.html": APP_BUILDER_TEMPLATE_INDEX,
    "schema.json": APP_BUILDER_TEMPLATE_SCHEMA,
    "meta.json": APP_BUILDER_TEMPLATE_META,
}
