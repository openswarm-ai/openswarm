/*
 * Default search suggestions.
 *
 * Zensical's search modal (a Preact component living in an open shadow root on a
 * <div> appended to <body>) shows nothing until you type. This sprinkles a small
 * curated list of "suggested pages" into the modal whenever the query is empty —
 * the command-palette behaviour you get from most search modals.
 *
 * It only ever *adds* nodes (reusing the modal's own class names so they inherit
 * its native styling) and re-attaches them after Preact re-renders. Everything is
 * wrapped in try/catch so a future Zensical change can, at worst, fall back to the
 * stock empty state — it can never break the real search.
 */
(function () {
  "use strict";

  // Curated entries shown on an empty query. `href` is resolved against the
  // site's base, so these work from any (including deeply nested) page.
  var SUGGESTIONS = [
    { title: "Documentation home", path: ["Home"], href: "index.html" },
    { title: "API Reference", path: ["reference"], href: "reference/index.html" },
    { title: "Guides", path: ["guides"], href: "guides/index.html" },
    { title: "Frontend reference", path: ["frontend"], href: "frontend/index.html" },
    { title: "Implementation plan", path: ["guides"], href: "guides/implementation_plan.html" }
  ];

  var MARK = "data-os-suggest";

  function siteBase() {
    try {
      var cfg = JSON.parse(document.getElementById("__config").textContent);
      return String(cfg.base || ".").replace(/\/?$/, "/");
    } catch (e) {
      return "./";
    }
  }
  var BASE = siteBase();

  function resolve(p) {
    try {
      return new URL(BASE + p, location.href).href;
    } catch (e) {
      return p;
    }
  }

  function el(doc, tag, cls) {
    var n = doc.createElement(tag);
    if (cls) n.className = cls;
    n.setAttribute(MARK, "");
    return n;
  }

  // Mirror the result-item markup the bundle emits: <ol class="b"> of
  // <li><a class="a"><div class="B"><h2 class="x">title</h2>
  // <menu class="t"><li>path…</li></menu></div></a></li>.
  function buildNodes(doc) {
    var frag = doc.createDocumentFragment();

    var heading = el(doc, "h3", "A");
    heading.style.opacity = "0.6";
    heading.textContent = "Suggested pages";
    frag.appendChild(heading);

    var ol = el(doc, "ol", "b");
    SUGGESTIONS.forEach(function (s) {
      var li = el(doc, "li");
      var a = el(doc, "a", "a");
      a.href = resolve(s.href);

      var wrap = el(doc, "div", "B");
      var h2 = el(doc, "h2", "x");
      h2.textContent = s.title;
      var menu = el(doc, "menu", "t");
      (s.path || []).forEach(function (seg) {
        var pli = el(doc, "li");
        pli.textContent = seg;
        menu.appendChild(pli);
      });

      wrap.appendChild(h2);
      wrap.appendChild(menu);
      a.appendChild(wrap);
      li.appendChild(a);
      ol.appendChild(li);
    });
    frag.appendChild(ol);
    return frag;
  }

  function wire(host) {
    var root = host.shadowRoot;
    if (!root || root.__osSuggestWired) return;
    var input = root.querySelector("input[role=combobox]");
    if (!input) return;
    root.__osSuggestWired = true;

    var doc = host.ownerDocument || document;
    var observer;
    var scheduled = false;

    // `.e` is the modal's dialog container; its last child is the scrollable
    // results body where real results render, so we slot suggestions in there.
    function dialog() {
      return root.querySelector(".e");
    }
    function body() {
      var d = dialog();
      return (d && d.lastElementChild) || d;
    }
    function isEmpty() {
      return !input.value || !input.value.trim();
    }

    function apply() {
      try {
        var parent = body();
        if (!parent) return;
        var present = root.querySelector("ol[" + MARK + "]");
        if (isEmpty()) {
          if (!present) {
            if (observer) observer.disconnect();
            parent.appendChild(buildNodes(doc));
            reobserve();
          }
        } else if (present) {
          if (observer) observer.disconnect();
          root.querySelectorAll("[" + MARK + "]").forEach(function (n) {
            if (n.tagName !== "STYLE") n.remove();
          });
          reobserve();
        }
      } catch (e) {
        /* never break native search */
      }
    }

    function schedule() {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(function () {
        scheduled = false;
        apply();
      });
    }

    function reobserve() {
      var d = dialog();
      if (!observer || !d) return;
      observer.observe(d, { childList: true, subtree: true });
    }

    // A little extra room so the suggestion-only state reads as intentional.
    var style = doc.createElement("style");
    style.setAttribute(MARK, "");
    style.textContent =
      "h3[" + MARK + "]{margin:0;padding:.5em .8em .25em;font-weight:600}" +
      "[" + MARK + "] a{cursor:pointer}";
    root.appendChild(style);

    input.addEventListener("input", schedule, true);

    observer = new MutationObserver(schedule);
    reobserve();

    schedule();
    setTimeout(apply, 60);
    setTimeout(apply, 300);
  }

  function scan() {
    try {
      var kids = document.body ? document.body.children : [];
      for (var i = 0; i < kids.length; i++) {
        var node = kids[i];
        if (node.shadowRoot && node.shadowRoot.querySelector &&
            node.shadowRoot.querySelector("input[role=combobox]")) {
          wire(node);
        }
      }
    } catch (e) {
      /* ignore */
    }
  }

  function start() {
    scan();
    // The overlay is created during bundle init; watch <body> for it (cheap:
    // direct-children mutations only) and retry a few times as a safety net.
    try {
      new MutationObserver(scan).observe(document.body, { childList: true });
    } catch (e) {
      /* ignore */
    }
    setTimeout(scan, 300);
    setTimeout(scan, 1200);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
