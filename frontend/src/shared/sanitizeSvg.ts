const BLOCKED_TAGS = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'foreignobject',
  'use', 'image', 'animate', 'set', 'animatetransform', 'animatemotion',
]);

const EVENT_ATTR = /^on/i;
const DANGEROUS_ATTR = new Set(['href', 'xlink:href']);

export function sanitizeSvgString(raw: string): string {
  if (!raw || typeof raw !== 'string') return '';

  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(
      `<svg xmlns="http://www.w3.org/2000/svg">${raw}</svg>`,
      'image/svg+xml',
    );

    const errors = doc.querySelector('parsererror');
    if (errors) return '';

    const walk = (node: Element) => {
      const children = Array.from(node.children);
      for (const child of children) {
        if (BLOCKED_TAGS.has(child.tagName.toLowerCase())) {
          child.remove();
          continue;
        }
        for (const attr of Array.from(child.attributes)) {
          if (EVENT_ATTR.test(attr.name)) {
            child.removeAttribute(attr.name);
          }
          if (DANGEROUS_ATTR.has(attr.name.toLowerCase()) && attr.value.trim().toLowerCase().startsWith('javascript')) {
            child.removeAttribute(attr.name);
          }
        }
        walk(child);
      }
    };

    const svg = doc.documentElement;
    walk(svg);

    return svg.innerHTML;
  } catch {
    return '';
  }
}
