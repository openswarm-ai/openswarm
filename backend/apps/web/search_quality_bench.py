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
    ("what is the chemical symbol for tungsten", "W"),
    ("how many bones are in the adult human body", "206"),
    ("what is the capital city of australia", "Canberra"),
    ("what does HTTP status code 418 mean", "teapot"),
    ("who created the linux kernel", "Torvalds"),
    ("what is the boiling point of water in fahrenheit at sea level", "212"),
    ("what year did the berlin wall fall", "1989"),
    ("what is the largest planet in the solar system", "Jupiter"),
]

P_DOMAIN = re.compile(r"https?://([^/\s)]+)", re.I)


@typechecked
def p_domains(text: str) -> int:
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
        "domains": p_domains(text),
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


if __name__ == "__main__":
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
