"""Dependency-free SVG charts for the winv2 perf baseline.

No matplotlib/pandas (not in the bundled env). Reads baseline_startup.csv and
writes two self-contained SVGs that render in a browser, GitHub, or Notion:
  baseline_startup.svg  - backend-http-ready per launch (warm vs cold)
  baseline_phases.svg   - where the time goes (app-launch / first-paint / backend)
Run: python make_graphs.py
"""
import csv
import os

HERE = os.path.dirname(os.path.abspath(__file__))
CSV = os.path.join(HERE, "baseline_startup.csv")

WARM = "#2e9e5b"
COLD = "#d64545"
INK = "#1a1d27"
MUTE = "#8892a4"
GRID = "#e2e6ef"


def rows():
    with open(CSV, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def bars_chart(data):
    w, h = 900, 420
    pad_l, pad_b, pad_t, pad_r = 60, 90, 50, 20
    plot_w = w - pad_l - pad_r
    plot_h = h - pad_t - pad_b
    vals = [int(r["backend_http_ready_ms"]) for r in data]
    vmax = max(vals)
    n = len(data)
    bw = plot_w / n * 0.7
    gap = plot_w / n
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" font-family="Segoe UI, sans-serif">']
    out.append(f'<text x="{pad_l}" y="28" font-size="17" font-weight="600" fill="{INK}">'
               'backend-http-ready per launch (ms) - lower is better</text>')
    # y gridlines
    for frac in (0, 0.25, 0.5, 0.75, 1.0):
        yv = vmax * frac
        y = pad_t + plot_h - plot_h * frac
        out.append(f'<line x1="{pad_l}" y1="{y:.0f}" x2="{w-pad_r}" y2="{y:.0f}" stroke="{GRID}"/>')
        out.append(f'<text x="{pad_l-8}" y="{y+4:.0f}" font-size="11" fill="{MUTE}" text-anchor="end">{yv/1000:.0f}s</text>')
    for i, r in enumerate(data):
        v = int(r["backend_http_ready_ms"])
        bh = plot_h * v / vmax
        x = pad_l + i * gap + (gap - bw) / 2
        y = pad_t + plot_h - bh
        color = COLD if r["class"] == "cold" else WARM
        out.append(f'<rect x="{x:.1f}" y="{y:.1f}" width="{bw:.1f}" height="{bh:.1f}" fill="{color}" rx="2"/>')
        out.append(f'<text x="{x+bw/2:.1f}" y="{y-5:.1f}" font-size="10" fill="{INK}" text-anchor="middle">{v/1000:.0f}s</text>')
        out.append(f'<text x="{x+bw/2:.1f}" y="{h-pad_b+16:.0f}" font-size="9" fill="{MUTE}" '
                   f'text-anchor="end" transform="rotate(-40 {x+bw/2:.1f} {h-pad_b+16:.0f})">{r["version"]}</text>')
    out.append(f'<rect x="{w-200}" y="{pad_t}" width="12" height="12" fill="{WARM}"/>'
               f'<text x="{w-184}" y="{pad_t+11}" font-size="12" fill="{INK}">warm</text>')
    out.append(f'<rect x="{w-130}" y="{pad_t}" width="12" height="12" fill="{COLD}"/>'
               f'<text x="{w-114}" y="{pad_t+11}" font-size="12" fill="{INK}">cold (post-update)</text>')
    out.append('</svg>')
    return "\n".join(out)


def phases_chart(data):
    warm = [r for r in data if r["class"] == "warm"]
    cold = [r for r in data if r["class"] == "cold"]

    def med(rows_, key):
        xs = sorted(int(r[key]) for r in rows_)
        return xs[len(xs) // 2] if xs else 0

    cases = [
        ("typical warm launch", med(warm, "app_launch_ms"), med(warm, "first_paint_ms"), med(warm, "backend_http_ready_ms")),
        ("typical cold launch", med(cold, "app_launch_ms"), med(cold, "first_paint_ms"), med(cold, "backend_http_ready_ms")),
    ]
    w, h = 900, 260
    pad_l, pad_r, pad_t = 170, 30, 50
    plot_w = w - pad_l - pad_r
    vmax = max(c[3] for c in cases)
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" font-family="Segoe UI, sans-serif">']
    out.append(f'<text x="20" y="28" font-size="17" font-weight="600" fill="{INK}">'
               'where startup time goes (backend dwarfs the shell)</text>')
    row_h = 46
    for i, (label, al, fp, br) in enumerate(cases):
        y = pad_t + i * (row_h + 26)
        out.append(f'<text x="20" y="{y+row_h/2+4:.0f}" font-size="13" fill="{INK}">{label}</text>')
        # backend is the full bar; app-launch+first-paint are the tiny left slice
        bw_backend = plot_w * br / vmax
        out.append(f'<rect x="{pad_l}" y="{y}" width="{bw_backend:.1f}" height="{row_h}" fill="{COLD if i==1 else WARM}" rx="3"/>')
        shell = al + fp
        bw_shell = plot_w * shell / vmax
        out.append(f'<rect x="{pad_l}" y="{y}" width="{max(bw_shell,2):.1f}" height="{row_h}" fill="{INK}" rx="3"/>')
        out.append(f'<text x="{pad_l+bw_backend+8:.0f}" y="{y+row_h/2+4:.0f}" font-size="12" fill="{INK}">'
                   f'backend {br/1000:.1f}s  (shell {shell/1000:.2f}s)</text>')
    out.append(f'<text x="20" y="{h-12}" font-size="11" fill="{MUTE}">'
               'dark = electron shell (app-launch + first-paint); colored = python backend</text>')
    out.append('</svg>')
    return "\n".join(out)


def boot_chart():
    """Before/after grouped bars for the boot-phase breakdown (profile_boot.py)."""
    path = os.path.join(HERE, "boot_breakdown.csv")
    with open(path, newline="", encoding="utf-8") as f:
        data = list(csv.DictReader(f))
    w, h = 900, 360
    pad_l, pad_r, pad_t, pad_b = 60, 30, 50, 120
    plot_w = w - pad_l - pad_r
    plot_h = h - pad_t - pad_b
    vmax = max(max(int(r["before_ms"]), int(r["after_ms"])) for r in data)
    n = len(data)
    group = plot_w / n
    bw = group * 0.34
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" font-family="Segoe UI, sans-serif">']
    out.append(f'<text x="{pad_l}" y="28" font-size="17" font-weight="600" fill="{INK}">'
               'warm boot breakdown: before vs after (ms) - the service lifespan was the bottleneck</text>')
    for frac in (0, 0.5, 1.0):
        y = pad_t + plot_h - plot_h * frac
        out.append(f'<line x1="{pad_l}" y1="{y:.0f}" x2="{w-pad_r}" y2="{y:.0f}" stroke="{GRID}"/>')
        out.append(f'<text x="{pad_l-8}" y="{y+4:.0f}" font-size="11" fill="{MUTE}" text-anchor="end">{vmax*frac/1000:.1f}s</text>')
    for i, r in enumerate(data):
        bx = pad_l + i * group + group / 2
        for j, (key, color, lab) in enumerate((("before_ms", COLD, "before"), ("after_ms", WARM, "after"))):
            v = int(r[key])
            bh = plot_h * v / vmax
            x = bx + (j - 1) * bw - bw * 0.05
            y = pad_t + plot_h - bh
            out.append(f'<rect x="{x:.1f}" y="{y:.1f}" width="{bw:.1f}" height="{bh:.1f}" fill="{color}" rx="2"/>')
            out.append(f'<text x="{x+bw/2:.1f}" y="{y-4:.1f}" font-size="10" fill="{INK}" text-anchor="middle">{v/1000:.1f}s</text>')
        out.append(f'<text x="{bx:.1f}" y="{h-pad_b+18:.0f}" font-size="10" fill="{MUTE}" text-anchor="end" '
                   f'transform="rotate(-25 {bx:.1f} {h-pad_b+18:.0f})">{r["phase"]}</text>')
    out.append(f'<rect x="{w-200}" y="{pad_t}" width="12" height="12" fill="{COLD}"/><text x="{w-184}" y="{pad_t+11}" font-size="12" fill="{INK}">before</text>')
    out.append(f'<rect x="{w-120}" y="{pad_t}" width="12" height="12" fill="{WARM}"/><text x="{w-104}" y="{pad_t+11}" font-size="12" fill="{INK}">after</text>')
    out.append('</svg>')
    return "\n".join(out)


def appbuilder_chart():
    """Horizontal bars for the App Builder create-path breakdown. Returns None
    if the measurement CSV hasn't been generated yet."""
    path = os.path.join(HERE, "appbuilder_breakdown.csv")
    if not os.path.exists(path):
        return None
    with open(path, newline="", encoding="utf-8") as f:
        raw = list(csv.DictReader(f))
    # Keep only real timing phases (drop the boolean/skipped/-1 rows).
    data = [r for r in raw if r["ms"].lstrip("-").isdigit() and int(r["ms"]) >= 0
            and not r["phase"].strip().startswith("->")]
    if not data:
        return None
    w = 980
    row_h, gap, pad_t, pad_l, pad_r = 30, 14, 56, 320, 90
    h = pad_t + len(data) * (row_h + gap) + 30
    vmax = max(int(r["ms"]) for r in data) or 1
    plot_w = w - pad_l - pad_r
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" font-family="Segoe UI, sans-serif">']
    out.append(f'<text x="20" y="30" font-size="17" font-weight="600" fill="{INK}">'
               'App Builder "create app -> live preview" breakdown (ms)</text>')
    for i, r in enumerate(data):
        v = int(r["ms"])
        y = pad_t + i * (row_h + gap)
        bw = max(plot_w * v / vmax, 1)
        # download/npm = cold cost (red-ish), everything else = warm/per-app (green)
        cold = ("npm" in r["phase"]) or ("cold" in r["phase"])
        color = COLD if cold else WARM
        out.append(f'<text x="{pad_l-10}" y="{y+row_h*0.68:.0f}" font-size="12" fill="{INK}" text-anchor="end">{r["phase"]}</text>')
        out.append(f'<rect x="{pad_l}" y="{y}" width="{bw:.1f}" height="{row_h}" fill="{color}" rx="3"/>')
        label = f'{v/1000:.2f}s' if v >= 1000 else f'{v}ms'
        out.append(f'<text x="{pad_l+bw+8:.0f}" y="{y+row_h*0.68:.0f}" font-size="12" fill="{INK}">{label}</text>')
    out.append(f'<text x="20" y="{h-10}" font-size="11" fill="{MUTE}">'
               'green = warm/per-app cost; red = cold one-time download (npm with no archive)</text>')
    out.append('</svg>')
    return "\n".join(out)


def main():
    data = rows()
    open(os.path.join(HERE, "baseline_startup.svg"), "w", encoding="utf-8").write(bars_chart(data))
    open(os.path.join(HERE, "baseline_phases.svg"), "w", encoding="utf-8").write(phases_chart(data))
    open(os.path.join(HERE, "boot_breakdown.svg"), "w", encoding="utf-8").write(boot_chart())
    wrote = "baseline_startup.svg + baseline_phases.svg + boot_breakdown.svg"
    ab = appbuilder_chart()
    if ab:
        open(os.path.join(HERE, "appbuilder_breakdown.svg"), "w", encoding="utf-8").write(ab)
        wrote += " + appbuilder_breakdown.svg"
    print("wrote " + wrote)


if __name__ == "__main__":
    main()
