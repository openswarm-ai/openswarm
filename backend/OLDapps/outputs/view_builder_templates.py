"""Default template files seeded into new App Builder workspaces."""

import os

_SKILL_PATH = os.path.join(os.path.dirname(__file__), "view_builder_skill.md")

with open(_SKILL_PATH) as _f:
    VIEW_BUILDER_SKILL = _f.read()

VIEW_TEMPLATE_INDEX = """\
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
    const input = window.OUTPUT_INPUT || {};
    const result = window.OUTPUT_BACKEND_RESULT || null;
  </script>
</body>
</html>
"""

VIEW_TEMPLATE_SCHEMA = """\
{
  "type": "object",
  "properties": {},
  "required": []
}
"""

VIEW_TEMPLATE_META = """\
{
  "name": "",
  "description": ""
}
"""

VIEW_TEMPLATE_FILES = {
    "index.html": VIEW_TEMPLATE_INDEX,
    "schema.json": VIEW_TEMPLATE_SCHEMA,
    "meta.json": VIEW_TEMPLATE_META,
}
