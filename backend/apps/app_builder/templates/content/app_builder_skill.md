# App Builder — Platform Reference

You are building an **App**: a self-contained web app served in an iframe.
The app you're working in is the source of truth — every file you write
here is served directly to the live preview.

---

## File conventions

| File | Required | Purpose |
|------|----------|---------|
| `index.html` | **Yes** | Entry point. Must be a complete HTML document. This is the ONLY file the preview iframe loads — never rename it. |
| `meta.json` | **Yes** | `{"name":"…","description":"…"}` — displayed in the UI header. Always write this. |
| `backend.py` | Optional | Server-side Python executed before rendering. |
| Everything else | Optional | JS, CSS, images, subdirectories — referenced from `index.html` via relative paths. |

### ⚠️ Do NOT

- Name the main HTML file anything other than `index.html` — the platform
  will not find it and the preview will be blank.
- Assume any external server or API is available unless the user provides one.

---

## backend.py

Optional server-side Python that runs before the frontend renders.
It must assign its result to a global `result` dict.

```python
import json

result = {
    "items": ["alpha", "beta", "gamma"],
    "timestamp": "2024-01-01T00:00:00Z",
}
```

---

## Multi-file projects

Split code across files for organization. All files are served from the
app root, so relative imports work naturally:

```
app/
├── index.html
├── meta.json
├── styles/
│   └── main.css
├── components/
│   └── Chart.js
└── utils/
    └── helpers.js
```

Reference from `index.html`:

```html
<link rel="stylesheet" href="./styles/main.css">
<script type="module" src="./components/Chart.js"></script>
```

ES module imports between JS files:

```javascript
// components/Chart.js
import { formatNumber } from '../utils/helpers.js';
```

---

## Using React

React 18 is available via esm.sh CDN — no build step needed:

```html
<script type="importmap">
{
  "imports": {
    "react": "https://esm.sh/react@18",
    "react-dom/client": "https://esm.sh/react-dom@18/client"
  }
}
</script>
<div id="root"></div>
<script type="module">
import React from 'react';
import { createRoot } from 'react-dom/client';

function App() {
  return React.createElement('div', null,
    React.createElement('h1', null, 'Hello')
  );
}

createRoot(document.getElementById('root')).render(
  React.createElement(App)
);
</script>
```

Other CDN libraries work too — use `https://esm.sh/` or `https://cdn.jsdelivr.net/npm/` for any npm package.

---

## Design guidelines

- **Dark theme by default** — use dark backgrounds (#0f1117, #1a1d27) with
  light text (#e2e8f0) unless the user requests otherwise.
- **Modern aesthetics** — rounded corners (8-12px), subtle borders, box shadows,
  smooth transitions (0.15-0.3s ease).
- **Responsive** — use flexbox/grid, test at different sizes.
- **Typography** — system font stack for UI, monospace for code/data.
- **Color accents** — use a single accent color with variations for hover/active states.
- **Spacing** — consistent padding (12-20px), adequate whitespace between sections.
- **Interactivity** — hover effects, focus states, loading indicators where appropriate.

---

## Complete minimal example

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>My App</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #0f1117;
      color: #e2e8f0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .card {
      background: #1a1d27;
      border: 1px solid #2e3248;
      border-radius: 12px;
      padding: 32px;
      max-width: 480px;
      width: 100%;
    }
    h1 { font-size: 1.5rem; margin-bottom: 8px; }
    p { color: #8892a4; line-height: 1.6; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Hello</h1>
    <p>Describe what you want to build and the agent will update this app.</p>
  </div>
</body>
</html>
```
