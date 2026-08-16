"""Objective quality benchmark for keyless web search, with no third-party reference (ENG-233).

The original plan was "50 queries vs Google SERP, judged blind". Measured 2026-08-13, that
reference cannot be obtained: google.com/search returns HTTP 200 with ~92KB of JavaScript shell,
zero `<h3>`, zero `/url?q=`, zero `data-ved`. Not a captcha, not a consent wall, just no results in
the HTML. A scraper checking status codes would report success and produce an EMPTY reference arm,
which then makes our results "match Google" by construction. That is worse than no benchmark.

So this measures what can be measured without asking a competitor anything: for a corpus of fact
queries whose answers are known and stable, does our search surface the answer at all, how fast,
and from how many distinct sources.

    answered      the known answer string appears in the returned text
    latency       wall clock per query
    diversity     distinct registrable domains in the result text
    engine mix    which rung actually won, so a silent single-engine dependency is visible

Run it, do not import it:
    PYTHONPATH=$PWD backend/.venv/bin/python backend/apps/web/search_quality_bench.py
"""
import asyncio
import json
import re
import statistics
import sys
import time
from typing import Dict, List, Optional, Tuple

from typeguard import typechecked

# Fact queries with answers that do not drift. Kept boring on purpose: a benchmark whose expected
# answer changes with the news measures the news, not the search.
CORPUS: List[Tuple[str, str]] = [
    ("what year was the python programming language first released", "1991"),
    ("who wrote the book the hobbit", "Tolkien"),
    ("what is the chemical element with symbol W called", "tungsten"),
    ("how many bones are in the adult human body", "206"),
    ("what is the capital city of australia", "Canberra"),
    ("what does HTTP status code 418 mean", "teapot"),
    ("who created the linux kernel", "Torvalds"),
    ("what is the boiling point of water in fahrenheit at sea level", "212"),
    ("what year did the berlin wall fall", "1989"),
    ("what is the largest planet in the solar system", "Jupiter"),
    ("what is the speed of light in meters per second", "299,792,458"),
    ("who painted the mona lisa", "Vinci"),
    ("who wrote the play romeo and juliet", "Shakespeare"),
    ("what year did world war two end", "1945"),
    ("what is the chemical formula for table salt", "NaCl"),
    ("who wrote the theory of general relativity", "Einstein"),
    ("what is the tallest mountain on earth", "Everest"),
    ("how many continents are there", "seven"),
    ("what is the currency of japan", "yen"),
    ("what does DNA stand for", "deoxyribonucleic"),
    ("who invented the telephone", "Bell"),
    ("what gas do plants absorb from the air", "carbon dioxide"),
]

P_DOMAIN = re.compile(r"https?://([^/\s)]+)", re.I)


@typechecked
def domains_in(text: str) -> int:
    """Distinct registrable-ish domains in a result blob; a proxy for source diversity."""
    hosts = {h.lower().lstrip("www.") for h in P_DOMAIN.findall(text or "")}
    return len(hosts)


@typechecked
async def p_one(query: str, expected: str) -> Dict:
    from backend.apps.web.web import SearchBody, search

    t0 = time.perf_counter()
    try:
        out = await search(SearchBody(query=query, num_results=5))
    except Exception as exc:
        return {"query": query, "ok": False, "error": f"{type(exc).__name__}: {exc}"[:90]}
    dt = time.perf_counter() - t0
    text = str((out or {}).get("results") or "")
    return {
        "query": query,
        "ok": True,
        "seconds": round(dt, 3),
        "backend": (out or {}).get("backend") or "?",
        "answered": expected.lower() in text.lower(),
        "domains": domains_in(text),
        "chars": len(text),
    }


@typechecked
async def run(limit: Optional[int] = None) -> Dict:
    rows: List[Dict] = []
    for query, expected in CORPUS[: limit or len(CORPUS)]:
        row = await p_one(query, expected)
        rows.append(row)
        mark = "ok " if row.get("answered") else ("ERR" if not row.get("ok") else "MISS")
        print(f"  {mark} {row.get('seconds', '-'):>6}s  {row.get('backend', '-'):<10} {query[:44]}")
    good = [r for r in rows if r.get("ok")]
    answered = [r for r in good if r.get("answered")]
    lat = [r["seconds"] for r in good]
    return {
        "n": len(rows),
        "usable": len(good),
        "answered": len(answered),
        "answer_rate": round(len(answered) / len(rows), 3) if rows else 0.0,
        "median_seconds": round(statistics.median(lat), 3) if lat else None,
        "median_domains": round(statistics.median([r["domains"] for r in good]), 1) if good else None,
        "engines": sorted({r.get("backend", "?") for r in good}),
    }


# Minimum before any rate here means anything. The first pass quoted 1-in-3 off three queries.
MIN_N = 20

# Seconds between queries. Without this the benchmark trips the engines' own anti-automation walls
# and then measures ITSELF. Measured 2026-08-13: a fast sequential pass reported ddg 7/22, and the
# "misses" all came back with chars=0 (nothing returned, not wrong results); the same queries
# answered correctly after a 90s pause (1,721 and 1,899 chars). The benchmark was throttled, and it
# reported that as a quality score.
PACE_SECONDS = 4.0

# Above this share of empty responses the run is measuring the wall, not the engine, so it must
# refuse to publish a rate rather than publish a false one.
THROTTLED_ABOVE = 0.3


@typechecked
async def p_run_engine(name: str, query: str, expected: str, limit: int) -> Dict:
    """One engine, one query. Never raises: an engine that dies is a datum, not a crash."""
    t0 = time.perf_counter()
    try:
        if name == "ddg":
            from backend.apps.agents.tools.web import WebSearchTool
            text = await WebSearchTool.search_ddg(query, limit)
        elif name == "bing":
            from backend.apps.agents.tools.search.search_bing import search_bing
            text = (await search_bing(query, limit)).results
        elif name == "brave":
            from backend.apps.agents.tools.search.search_brave import search_brave
            text = (await search_brave(query, limit)).results
        else:
            raise ValueError(f"unknown engine {name}")
    except Exception as exc:
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"[:80], "answered": False}
    dt = time.perf_counter() - t0
    text = str(text or "")
    return {
        "ok": bool(text.strip()),
        "seconds": round(dt, 3),
        "answered": expected.lower() in text.lower(),
        "domains": domains_in(text),
        "chars": len(text),
    }


@typechecked
async def run_per_engine(engines: Optional[List[str]] = None, limit: int = 5) -> Dict:
    names = engines or ["ddg", "bing", "brave"]
    out: Dict[str, Dict] = {}
    for name in names:
        rows: List[Dict] = []
        print(f"\n=== {name} ===")
        for i, (query, expected) in enumerate(CORPUS):
            if i:
                await asyncio.sleep(PACE_SECONDS)
            row = await p_run_engine(name, query, expected, limit)
            rows.append(row)
            mark = "ok  " if row["answered"] else ("ERR " if not row["ok"] else "MISS")
            print(f"  {mark} {row.get('seconds', '-'):>6}  {query[:52]}")
        usable = [r for r in rows if r["ok"]]
        answered = [r for r in rows if r["answered"]]
        lat = [r["seconds"] for r in usable]
        empty = len(rows) - len(usable)
        throttled = bool(rows) and (empty / len(rows)) > THROTTLED_ABOVE
        out[name] = {
            "n": len(rows),
            "usable": len(usable),
            "answered": len(answered),
            # A rate computed over a throttled run is a measurement of the wall. Say so instead of
            # publishing a number someone will quote.
            "answer_rate": (None if throttled
                            else round(len(answered) / len(rows), 3) if rows else 0.0),
            "throttled": throttled,
            "empty_responses": empty,
            "median_seconds": round(statistics.median(lat), 3) if lat else None,
        }
    return out


if __name__ == "__main__":
    # `--per-engine` measures each rung separately; the default still measures the cascade.
    if "--per-engine" in sys.argv:
        summary = asyncio.run(run_per_engine())
        print()
        print(json.dumps(summary, indent=2))
        scored = {k: v for k, v in summary.items() if not v["throttled"]}
        for name, v in summary.items():
            if v["throttled"]:
                print(f"  {name:<10} THROTTLED ({v['empty_responses']}/{v['n']} empty), no rate reported")
        if not scored:
            print("FAIL: every engine was throttled; this run measured the anti-automation wall")
            sys.exit(1)
        best = max(scored.values(), key=lambda v: v["answer_rate"])["answer_rate"]
        for name, v in sorted(scored.items(), key=lambda kv: -kv[1]["answer_rate"]):
            gap = round(best - v["answer_rate"], 3)
            print(f"  {name:<10} {v['answered']}/{v['n']}  rate={v['answer_rate']:<6} "
                  f"{'ok' if gap <= 0.1 else f'BEHIND BEST BY {gap}'}")
        sys.exit(0)
    summary = asyncio.run(run())
    print()
    print(json.dumps(summary, indent=2))
    # A benchmark that cannot fail is not a benchmark. These are the thresholds; N is stated so a
    # shrunken corpus cannot pass by measuring less.
    if summary["n"] < 10:
        print("FAIL: corpus shrank below 10 queries; the rates would not mean anything")
        sys.exit(1)
    if summary["answer_rate"] < 0.7:
        print(f"FAIL: answer rate {summary['answer_rate']} below the 0.70 threshold")
        sys.exit(1)
    print(f"PASS: {summary['answered']}/{summary['n']} answered, median {summary['median_seconds']}s")
