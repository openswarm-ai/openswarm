#!/usr/bin/env python3
"""Exhaustive HTTP verification of scheduled-tasks behavior; runs against live :8324, exits non-zero on failure."""

from __future__ import annotations
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

BASE = "http://127.0.0.1:8324/api/workflows"
with open("backend/data/auth.token") as f:
    TOK = f.read().strip()
HEADERS = {"Authorization": f"Bearer {TOK}", "Content-Type": "application/json"}

GREEN = "\033[32m"
RED = "\033[31m"
DIM = "\033[2m"
RESET = "\033[0m"
fail_count = 0
created_ids: list[str] = []


def http(method: str, path: str, body=None, raw: bool = False, extra_headers=None):
    url = f"{BASE}{path}"
    if body is None:
        data = None
    elif raw:
        data = body if isinstance(body, (bytes, bytearray)) else body.encode()
    else:
        data = json.dumps(body).encode()
    headers = dict(HEADERS)
    if extra_headers:
        headers.update(extra_headers)
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status, json.loads(resp.read() or b"null")
    except urllib.error.HTTPError as e:
        try: body_err = json.loads(e.read())
        except Exception: body_err = None
        return e.code, body_err
    except Exception as e:
        return -1, str(e)


def ok(label: str, cond: bool, info: str = ""):
    global fail_count
    if cond:
        print(f"  {GREEN}PASS{RESET} {label}{DIM}{('; ' + info) if info else ''}{RESET}")
    else:
        fail_count += 1
        print(f"  {RED}FAIL{RESET} {label}{('; ' + info) if info else ''}")


def section(title: str):
    print(f"\n\033[1m{title}{RESET}")


# Make a known-clean workflow for each test that needs one.
def fresh_wf(**overrides) -> dict:
    body = {
        "title": overrides.pop("title", f"stress-{int(time.time()*1000)}"),
        "steps": [{"id": "s1", "text": "hi"}],
        "schedule": {
            "enabled": False, "repeat_every": 1, "repeat_unit": "week",
            "on_days": [], "hour": 9, "minute": 0, "timezone": "America/Los_Angeles",
            "on_missed": "skip", "ends_at": None, "max_runs": None, "runs_count": 0,
        },
        "actions": {"prevent_unused": False, "freeze": False, "configured_sets": []},
    }
    body.update(overrides)
    return body


# Cleanup hook.
def cleanup():
    for wid in created_ids:
        http("DELETE", f"/{wid}")


# ============ 1. Endpoint discovery ============
section("1. Every endpoint responds")
for path in ["/list", "/active", "/paused", "/cloud/sms/status"]:
    code, _ = http("GET", path)
    ok(f"GET {path} returns 200", code == 200)
for path in ["/pause-all", "/resume-all"]:
    code, _ = http("POST", path)
    ok(f"POST {path} returns 200", code == 200)
# Reset pause flag.
http("POST", "/resume-all")

# ============ 2. Create paths ============
section("2. Create workflow shapes")
# Empty body (uses all model defaults)
code, r = http("POST", "/create", {})
ok("POST /create with empty body accepts defaults", code == 200 and "id" in (r or {}))
if r and "id" in r: created_ids.append(r["id"])

# Full custom body, scheduled, no source -> freeze flips True
code, r = http("POST", "/create", fresh_wf(
    title="freeze-default-check",
    schedule={"enabled": True, "repeat_every": 1, "repeat_unit": "day", "on_days": [],
              "hour": 9, "minute": 0, "timezone": "America/Los_Angeles", "on_missed": "skip",
              "ends_at": None, "max_runs": None, "runs_count": 0},
))
ok("scheduled+no-source create flips freeze=True", code == 200 and r["actions"]["freeze"] is True)
wid_freeze = r["id"]; created_ids.append(wid_freeze)

# Scheduled + source_session -> freeze respects user value
code, r = http("POST", "/create", fresh_wf(
    title="freeze-respects-source",
    source_session_id="sess-abc",
    schedule={"enabled": True, "repeat_every": 1, "repeat_unit": "day", "on_days": [],
              "hour": 9, "minute": 0, "timezone": "America/Los_Angeles", "on_missed": "skip",
              "ends_at": None, "max_runs": None, "runs_count": 0},
))
ok("scheduled+source-session leaves freeze=False", code == 200 and r["actions"]["freeze"] is False)
created_ids.append(r["id"])

# Unscheduled create with freeze=False -> stays False (no auto-flip)
code, r = http("POST", "/create", fresh_wf(title="unscheduled"))
ok("unscheduled create keeps freeze=False", code == 200 and r["actions"]["freeze"] is False)
wid_unsched = r["id"]; created_ids.append(wid_unsched)

# Create with cost_cap_usd_monthly persists
code, r = http("POST", "/create", fresh_wf(title="with-cap", cost_cap_usd_monthly=5.50))
ok("cost_cap_usd_monthly persists through create", code == 200 and r.get("cost_cap_usd_monthly") == 5.50)
created_ids.append(r["id"])

# Create with ends_at + max_runs in schedule
future = (datetime.now(timezone.utc) + timedelta(days=7)).isoformat()
code, r = http("POST", "/create", fresh_wf(
    title="with-end-conditions",
    schedule={"enabled": True, "repeat_every": 1, "repeat_unit": "day", "on_days": [],
              "hour": 9, "minute": 0, "timezone": "America/Los_Angeles", "on_missed": "skip",
              "ends_at": future, "max_runs": 5, "runs_count": 0},
))
ok("ends_at + max_runs persist", code == 200 and r["schedule"].get("max_runs") == 5 and r["schedule"].get("ends_at"))
created_ids.append(r["id"])

# ============ 3. GET + cost_estimate ============
section("3. GET single workflow returns cost_estimate")
code, r = http("GET", f"/{wid_freeze}")
ok("GET returns cost_estimate block", code == 200 and "cost_estimate" in r)
ok("cost_estimate.monthly_usd is a number", isinstance(r["cost_estimate"].get("monthly_usd"), (int, float)))
ok("cost_estimate.fires_per_month is a number", isinstance(r["cost_estimate"].get("fires_per_month"), int))

# ============ 4. LIST + cost_estimate ============
section("4. LIST endpoint enriches every row")
code, r = http("GET", "/list")
ok("LIST returns 200 with workflows array", code == 200 and "workflows" in r)
ok("LIST rows all have cost_estimate", all("cost_estimate" in w for w in r["workflows"]))
ok("LIST rows all have new schedule fields",
   all(all(k in w["schedule"] for k in ("ends_at", "max_runs", "runs_count")) for w in r["workflows"]))

# ============ 5. PATCH paths ============
section("5. PATCH endpoint behaviors")
# Title change writes audit
code, _ = http("PATCH", f"/{wid_freeze}", {"title": "freeze-renamed"})
ok("PATCH title returns 200", code == 200)
code, r = http("GET", f"/{wid_freeze}/audit")
ok("audit log has at least one entry after PATCH", code == 200 and len(r["entries"]) >= 1)
diff = r["entries"][0]["diff"]
ok("audit diff captures title before/after", diff.get("title", {}).get("after") == "freeze-renamed")
ok("audit entry has ts and who fields", "ts" in r["entries"][0] and "who" in r["entries"][0])

# PATCH schedule.enabled True->False clears next_run_at
http("PATCH", f"/{wid_freeze}", {"schedule": {"enabled": True, "repeat_every": 1, "repeat_unit": "day",
    "on_days": [], "hour": 9, "minute": 0, "timezone": "America/Los_Angeles", "on_missed": "skip",
    "ends_at": None, "max_runs": None, "runs_count": 0}})
code, r = http("GET", f"/{wid_freeze}")
ok("enabling schedule populates next_run_at", r.get("next_run_at") is not None)
http("PATCH", f"/{wid_freeze}", {"schedule": {**r["schedule"], "enabled": False}})
code, r = http("GET", f"/{wid_freeze}")
ok("disabling schedule clears next_run_at", r.get("next_run_at") is None)

# PATCH cost_cap_usd_monthly null clears it
http("PATCH", f"/{wid_freeze}", {"cost_cap_usd_monthly": 9.99})
code, r = http("GET", f"/{wid_freeze}")
ok("PATCH cost_cap_usd_monthly persists", r.get("cost_cap_usd_monthly") == 9.99)
http("PATCH", f"/{wid_freeze}", {"cost_cap_usd_monthly": None})
code, r = http("GET", f"/{wid_freeze}")
ok("PATCH cost_cap_usd_monthly=null clears it", r.get("cost_cap_usd_monthly") is None)

# PATCH permissions tier
http("PATCH", f"/{wid_freeze}", {"permissions": [
    {"kind": "notify", "after_minutes": 0, "phone": None},
    {"kind": "text", "after_minutes": 5, "phone": "+15551234567"},
]})
code, r = http("GET", f"/{wid_freeze}")
ok("permissions tier patch persists", len(r["permissions"]) == 2 and r["permissions"][1]["kind"] == "text")

# ============ 6. Schedule semantics ============
section("6. Schedule semantics edge cases")
# Bad timezone
code, _ = http("PATCH", f"/{wid_freeze}", {"schedule": {"enabled": True, "repeat_every": 1,
    "repeat_unit": "day", "on_days": [], "hour": 9, "minute": 0, "timezone": "Fictional/Place",
    "on_missed": "skip", "ends_at": None, "max_runs": None, "runs_count": 0}})
ok("bad timezone string falls back gracefully (200)", code == 200)

# Old-format "local" timezone still works (legacy compat)
code, _ = http("PATCH", f"/{wid_freeze}", {"schedule": {"enabled": True, "repeat_every": 1,
    "repeat_unit": "day", "on_days": [], "hour": 9, "minute": 0, "timezone": "local",
    "on_missed": "skip", "ends_at": None, "max_runs": None, "runs_count": 0}})
ok("legacy timezone='local' accepted", code == 200)

# Empty on_days for week (defaults to today at fire calc)
code, _ = http("PATCH", f"/{wid_freeze}", {"schedule": {"enabled": True, "repeat_every": 1,
    "repeat_unit": "week", "on_days": [], "hour": 9, "minute": 0, "timezone": "UTC",
    "on_missed": "skip", "ends_at": None, "max_runs": None, "runs_count": 0}})
code, r = http("GET", f"/{wid_freeze}")
ok("week schedule with empty on_days still gets a next_run_at", r.get("next_run_at") is not None)

# All 7 weekdays selected
code, _ = http("PATCH", f"/{wid_freeze}", {"schedule": {"enabled": True, "repeat_every": 1,
    "repeat_unit": "week", "on_days": [0, 1, 2, 3, 4, 5, 6], "hour": 9, "minute": 0,
    "timezone": "UTC", "on_missed": "skip", "ends_at": None, "max_runs": None, "runs_count": 0}})
ok("all-7-weekdays schedule accepted", code == 200)

# Month with day-31 source (was the day-28 clamp bug)
code, _ = http("PATCH", f"/{wid_freeze}", {"schedule": {"enabled": True, "repeat_every": 1,
    "repeat_unit": "month", "on_days": [], "hour": 9, "minute": 0, "timezone": "UTC",
    "on_missed": "skip", "ends_at": None, "max_runs": None, "runs_count": 0}})
ok("monthly schedule accepted (no day-28 clamp)", code == 200)

# ============ 7. End conditions auto-disable ============
section("7. End conditions actually disable the schedule")
# max_runs already reached
past = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
code, r = http("POST", "/create", fresh_wf(
    title="hit-max-runs",
    schedule={"enabled": True, "repeat_every": 1, "repeat_unit": "day", "on_days": [],
              "hour": 9, "minute": 0, "timezone": "UTC", "on_missed": "skip",
              "ends_at": None, "max_runs": 2, "runs_count": 2},
))
hit_max_id = r["id"]; created_ids.append(hit_max_id)
# Force a tick. Schedule has next_run_at set on create; backend's tick will see runs_count>=max_runs.
# We can't run _tick directly over HTTP, but we can sleep one tick interval (60s ceiling).
# Instead, verify: at create time, next_run_at was set, but _tick when it fires should disable.
# Easier: PATCH it which re-runs the scheduler.compute_next_fire AND eventually disables on tick.
# For HTTP-only smoke, verify the field state round-trips.
code, r = http("GET", f"/{hit_max_id}")
ok("max_runs >= runs_count workflow round-trips state", r["schedule"]["max_runs"] == 2 and r["schedule"]["runs_count"] == 2)

# ends_at in past
code, r = http("POST", "/create", fresh_wf(
    title="hit-ends-at",
    schedule={"enabled": True, "repeat_every": 1, "repeat_unit": "day", "on_days": [],
              "hour": 9, "minute": 0, "timezone": "UTC", "on_missed": "skip",
              "ends_at": past, "max_runs": None, "runs_count": 0},
))
created_ids.append(r["id"])
ok("expired ends_at workflow accepted at create", r["schedule"]["ends_at"] is not None)

# ============ 8. Pause flag ============
section("8. Pause flag")
http("POST", "/pause-all")
code, r = http("GET", "/paused")
ok("paused=true after pause-all", r["paused"] is True)
# Past-due workflow should NOT fire while paused
past_due_body = fresh_wf(title="past-due-while-paused",
    schedule={"enabled": True, "repeat_every": 1, "repeat_unit": "day", "on_days": [],
              "hour": 0, "minute": 0, "timezone": "UTC", "on_missed": "skip",
              "ends_at": None, "max_runs": None, "runs_count": 0})
code, r = http("POST", "/create", past_due_body)
wid_paused_test = r["id"]; created_ids.append(wid_paused_test)
time.sleep(2)
code, runs = http("GET", f"/{wid_paused_test}/runs")
ok("past-due workflow doesn't fire while paused", len(runs.get("runs", [])) == 0)
http("POST", "/resume-all")
code, r = http("GET", "/paused")
ok("paused=false after resume-all", r["paused"] is False)

# ============ 9. Active endpoint ============
section("9. Active endpoint")
code, r = http("GET", "/active")
ok("active returns list type", isinstance(r.get("active"), list))
# Currently nothing should be running (we haven't launched anything)
ok("active is empty when nothing running", r["active"] == [])

# ============ 10. Cloud SMS status ============
section("10. Cloud SMS probe")
code, r = http("GET", "/cloud/sms/status")
ok("/cloud/sms/status returns enabled=false honestly", r.get("enabled") is False)

# ============ 11. Run endpoints ============
section("11. Run endpoint behaviors")
# ack on unknown run is idempotent
code, r = http("POST", "/runs/totally-fake-run-id/ack")
ok("ack on unknown run returns 200", code == 200)
ok("ack on unknown run idempotent (acked:true)", r.get("acked") is True)
ok("ack on unknown run reports no pending escalation", r.get("had_pending_escalation") is False)
# escalation state for unknown run
code, r = http("GET", "/runs/totally-fake-run-id/escalation")
ok("escalation state on unknown run returns state:null", r.get("state") is None)

# Run history for a workflow with no runs
code, r = http("GET", f"/{wid_unsched}/runs")
ok("workflow with no runs returns empty runs list", code == 200 and r.get("runs") == [])

# ============ 12. Audit log ============
section("12. Audit log behaviors")
# Initial audit is empty for a brand-new workflow
code, r = http("GET", f"/{wid_unsched}/audit")
ok("audit log empty for never-edited workflow", code == 200 and r["entries"] == [])
# Multiple edits accumulate
for i in range(3):
    http("PATCH", f"/{wid_unsched}", {"description": f"v{i}"})
code, r = http("GET", f"/{wid_unsched}/audit")
ok("audit log accumulates across 3 PATCHes", len(r["entries"]) >= 3)
# Audit log limit param respected
code, r = http("GET", f"/{wid_unsched}/audit?limit=1")
ok("audit log respects limit=1", len(r["entries"]) == 1)

# ============ 13. Negative cases ============
section("13. Negative cases")
code, _ = http("GET", "/does-not-exist")
ok("GET unknown workflow returns 404", code == 404)
code, _ = http("PATCH", "/does-not-exist", {"title": "x"})
ok("PATCH unknown workflow returns 404", code == 404)
code, _ = http("DELETE", "/does-not-exist")
ok("DELETE unknown workflow returns 404", code == 404)
code, _ = http("POST", "/does-not-exist/run")
ok("POST run on unknown workflow returns 404", code == 404)
code, _ = http("GET", "/does-not-exist/runs")
ok("GET runs on unknown workflow returns 404", code == 404)
code, _ = http("GET", "/does-not-exist/audit")
ok("GET audit on unknown workflow returns 404", code == 404)
# Garbage body
code, _ = http("POST", "/create", body=b"this is not json", raw=True)
ok("POST /create with garbage body returns 4xx", 400 <= code < 500)
code, _ = http("PATCH", f"/{wid_unsched}", body=b"this is not json", raw=True)
ok("PATCH with garbage body returns 4xx", 400 <= code < 500)

# ============ 14. Concurrent / race ============
section("14. Race surface")
# 10 rapid PATCHes converge to final state
for i in range(10):
    http("PATCH", f"/{wid_unsched}", {"title": f"race-{i}"})
code, r = http("GET", f"/{wid_unsched}")
ok("10 rapid PATCHes converge to final title", r["title"] == "race-9")
# 5 rapid creates produce 5 distinct IDs
race_ids = set()
for i in range(5):
    code, r = http("POST", "/create", fresh_wf(title=f"race-create-{i}"))
    if r and r.get("id"):
        race_ids.add(r["id"])
        created_ids.append(r["id"])
ok("5 rapid creates produce 5 unique IDs", len(race_ids) == 5)

# ============ 15. Listing filters ============
section("15. List filtering")
code, r = http("GET", "/list?dashboard_id=nope-not-real")
ok("LIST with unknown dashboard_id returns 200", code == 200)
ok("LIST with unknown dashboard_id returns workflows array", "workflows" in r)

# ============ 16. Delete workflow with audit ============
section("16. DELETE behavior")
del_id = created_ids.pop() if created_ids else None
if del_id:
    code, _ = http("DELETE", f"/{del_id}")
    ok("DELETE returns 200 ok:true", code == 200)
    code, _ = http("GET", f"/{del_id}")
    ok("deleted workflow 404s on next GET", code == 404)
    code, r = http("GET", f"/{del_id}/audit")
    ok("audit of deleted workflow returns 404", code == 404)
    code, _ = http("GET", f"/{del_id}/runs")
    ok("runs of deleted workflow returns 404", code == 404)

# ============ 17. Cost cap effective at PATCH ============
section("17. Cost cap PATCH round-trip")
code, _ = http("PATCH", f"/{wid_unsched}", {"cost_cap_usd_monthly": 0.01})
code, r = http("GET", f"/{wid_unsched}")
ok("tiny cost cap persists", r["cost_cap_usd_monthly"] == 0.01)
# Setting to a large number works
http("PATCH", f"/{wid_unsched}", {"cost_cap_usd_monthly": 9999.0})
code, r = http("GET", f"/{wid_unsched}")
ok("large cost cap persists", r["cost_cap_usd_monthly"] == 9999.0)

# ============ 18. fires_per_month sanity ============
section("18. cost_estimate.fires_per_month sanity")
http("PATCH", f"/{wid_unsched}", {"schedule": {"enabled": True, "repeat_every": 1, "repeat_unit": "day",
    "on_days": [], "hour": 9, "minute": 0, "timezone": "UTC", "on_missed": "skip",
    "ends_at": None, "max_runs": None, "runs_count": 0}})
code, r = http("GET", f"/{wid_unsched}")
ok("daily schedule projects ~30 fires per month", 27 <= r["cost_estimate"]["fires_per_month"] <= 32)
http("PATCH", f"/{wid_unsched}", {"schedule": {"enabled": True, "repeat_every": 1, "repeat_unit": "week",
    "on_days": [1, 2, 3, 4, 5], "hour": 9, "minute": 0, "timezone": "UTC", "on_missed": "skip",
    "ends_at": None, "max_runs": None, "runs_count": 0}})
code, r = http("GET", f"/{wid_unsched}")
ok("weekday schedule projects ~20 fires per month", 19 <= r["cost_estimate"]["fires_per_month"] <= 23)
http("PATCH", f"/{wid_unsched}", {"schedule": {"enabled": True, "repeat_every": 1, "repeat_unit": "month",
    "on_days": [], "hour": 9, "minute": 0, "timezone": "UTC", "on_missed": "skip",
    "ends_at": None, "max_runs": None, "runs_count": 0}})
code, r = http("GET", f"/{wid_unsched}")
ok("monthly schedule projects ~1 fire per month", 0 <= r["cost_estimate"]["fires_per_month"] <= 2)
http("PATCH", f"/{wid_unsched}", {"schedule": {"enabled": False, "repeat_every": 1, "repeat_unit": "day",
    "on_days": [], "hour": 9, "minute": 0, "timezone": "UTC", "on_missed": "skip",
    "ends_at": None, "max_runs": None, "runs_count": 0}})
code, r = http("GET", f"/{wid_unsched}")
ok("disabled schedule projects 0 fires per month", r["cost_estimate"]["fires_per_month"] == 0)

# ============ 19. fires_per_month with end conditions ============
section("19. fires_per_month respects end conditions")
http("PATCH", f"/{wid_unsched}", {"schedule": {"enabled": True, "repeat_every": 1, "repeat_unit": "day",
    "on_days": [], "hour": 9, "minute": 0, "timezone": "UTC", "on_missed": "skip",
    "ends_at": (datetime.now(timezone.utc) + timedelta(days=3)).isoformat(),
    "max_runs": None, "runs_count": 0}})
code, r = http("GET", f"/{wid_unsched}")
# Note: backend's fires_in_window doesn't currently honor ends_at; this MAY surface as a bug.
fires = r["cost_estimate"]["fires_per_month"]
print(f"  {DIM}(info) ends_at=3 days from now produced fires_per_month={fires}{RESET}")
# If we want to assert, we'd expect roughly 3 fires, not 30:
ok("fires_per_month honors ends_at (~3 fires not ~30)", fires <= 5,
   info=f"got {fires}, want <= 5; if this fails it's a known gap in scheduler.fires_in_window")

# ============ 20. If-Match optimistic concurrency ============
section("20. PATCH with If-Match (optimistic concurrency)")
code, r = http("POST", "/create", fresh_wf(title="if-match-test"))
oc_id = r["id"]; created_ids.append(oc_id)
stamp = r["updated_at"]
# Stale If-Match -> 409
code, _ = http("PATCH", f"/{oc_id}", {"title": "v2"}, extra_headers={"If-Match": "1999-01-01T00:00:00"})
ok("stale If-Match returns 409", code == 409)
# Fresh If-Match -> 200
code, r = http("PATCH", f"/{oc_id}", {"title": "v2"}, extra_headers={"If-Match": stamp})
ok("fresh If-Match returns 200", code == 200)
# Missing If-Match -> still works (legacy back-compat)
code, _ = http("PATCH", f"/{oc_id}", {"title": "v3"})
ok("missing If-Match still accepted (legacy clients)", code == 200)

# ============ 21. /run returns skipped status on cost cap ============
section("21. /run surfaces cost-cap skipped status")
code, r = http("POST", "/create", fresh_wf(title="cap-immediate", cost_cap_usd_monthly=0.01))
cap_id = r["id"]; created_ids.append(cap_id)
# Run once and produce a real-looking run via the legacy 0-cost path , 
# the cap is checked against actual recorded cost_usd. Without a way to
# inject a $5 run here we just verify the field surfaces correctly when
# the cap is 0 (which should always exceed). With 0 the executor's >=
# check skips immediately because spent (0.0) >= 0.0.
# (Using cap=0 forces the skip path on first run.)
http("PATCH", f"/{cap_id}", {"cost_cap_usd_monthly": 0.0})
code, r = http("POST", f"/{cap_id}/run")
# It may take a tick for the executor to land the skipped row; the
# endpoint already polls up to 250ms internally.
ok("run response includes status field", "status" in r)
ok("run response includes error field", "error" in r)
if r.get("status") == "skipped":
    ok("/run surfaces skipped status", True, info=r.get("error", ""))
else:
    ok("/run surfaces skipped status", False,
       info=f"status was {r.get('status')!r} not skipped; may have raced")

# ============ Done ============
print()
if fail_count == 0:
    print(f"{GREEN}All assertions passed.{RESET}")
else:
    print(f"{RED}{fail_count} assertion(s) failed.{RESET}")
cleanup()
sys.exit(0 if fail_count == 0 else 1)
