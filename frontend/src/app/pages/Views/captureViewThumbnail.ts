import { toJpeg } from 'html-to-image';

const CAPTURE_WIDTH = 1280;
const CAPTURE_HEIGHT = 800;
const JPEG_QUALITY = 0.7;
const LOAD_TIMEOUT_MS = 4000;

// Normalize agent-written `./foo` and `/foo` references against workspace keys (which are root-relative).
function lookupFile(href: string, files: Record<string, string>): string | null {
  const candidates = [href, href.replace(/^\.\//, ''), href.replace(/^\//, '')];
  for (const k of candidates) {
    if (k in files) return files[k];
  }
  return null;
}

/** Inline local CSS/JS into a single srcdoc; external URLs are left as-is. */
function inlineResources(html: string, files: Record<string, string>): string {
  let result = html;

  result = result.replace(
    /<link\s+(?=[^>]*rel=["']stylesheet["'])([^>]*)\/?>/gi,
    (match, attrs: string) => {
      const hrefMatch = attrs.match(/href=["']([^"']+)["']/);
      if (!hrefMatch) return match;
      const href = hrefMatch[1];
      if (/^(https?:)?\/\//.test(href)) return match;
      const content = lookupFile(href, files);
      if (content == null) return match;
      return `<style>\n${content}\n</style>`;
    },
  );

  result = result.replace(
    /<script\s+([^>]*)><\/script>/gi,
    (match, attrs: string) => {
      const srcMatch = attrs.match(/src=["']([^"']+)["']/);
      if (!srcMatch) return match;
      const src = srcMatch[1];
      if (/^(https?:)?\/\//.test(src)) return match;
      const content = lookupFile(src, files);
      if (content == null) return match;
      const typeMatch = attrs.match(/type=["']([^"']+)["']/);
      const typeAttr = typeMatch ? ` type="${typeMatch[1]}"` : '';
      return `<script${typeAttr}>\n${content}\n</script>`;
    },
  );

  return result;
}

function buildSrcdoc(
  frontendCode: string,
  inputData: Record<string, any>,
): string {
  const inputJson = JSON.stringify(inputData);
  const injection = `<script>
window.OUTPUT_INPUT = ${inputJson};
window.OUTPUT_BACKEND_RESULT = null;
</script>`;

  if (frontendCode.includes('</head>')) {
    return frontendCode.replace('</head>', `${injection}\n</head>`);
  }
  if (frontendCode.includes('<body')) {
    return frontendCode.replace('<body', `${injection}\n<body`);
  }
  return `${injection}\n${frontendCode}`;
}

/** Render a view in a hidden iframe and return a base64 JPEG thumbnail, or null on failure. */
export async function captureViewThumbnail(
  frontendCode: string,
  inputData: Record<string, any> = {},
  files?: Record<string, string>,
): Promise<string | null> {
  if (!frontendCode.trim()) return null;

  const html = files ? inlineResources(frontendCode, files) : frontendCode;

  const container = document.createElement('div');
  Object.assign(container.style, {
    position: 'fixed',
    left: '-9999px',
    top: '-9999px',
    width: `${CAPTURE_WIDTH}px`,
    height: `${CAPTURE_HEIGHT}px`,
    overflow: 'hidden',
    zIndex: '-1',
    opacity: '0',
    pointerEvents: 'none',
  });

  const iframe = document.createElement('iframe');
  iframe.sandbox.add('allow-scripts', 'allow-same-origin');
  Object.assign(iframe.style, {
    width: `${CAPTURE_WIDTH}px`,
    height: `${CAPTURE_HEIGHT}px`,
    border: 'none',
    background: '#fff',
  });

  container.appendChild(iframe);
  document.body.appendChild(container);

  try {
    const srcdoc = buildSrcdoc(html, inputData);

    await new Promise<void>((resolve) => {
      iframe.addEventListener('load', () => resolve(), { once: true });
      iframe.srcdoc = srcdoc;
    });

    await new Promise((r) => setTimeout(r, LOAD_TIMEOUT_MS));

    const body = iframe.contentDocument?.body;
    if (!body) return null;

    const dataUrl = await toJpeg(body, {
      quality: JPEG_QUALITY,
      width: CAPTURE_WIDTH,
      height: CAPTURE_HEIGHT,
      backgroundColor: '#ffffff',
      skipFonts: true,
    });

    return dataUrl;
  } catch (err) {
    console.warn('Thumbnail capture failed:', err);
    return null;
  } finally {
    document.body.removeChild(container);
  }
}
