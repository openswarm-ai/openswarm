"""DashboardExportable: the bundling showcase. A dashboard's agent cards and app
cards are pulled into the closure as sessions + apps (each session pulls its
custom mode); the layout's entity-keyed dicts are rewritten local->bundle on
export and bundle->fresh-local on import via the RemapTable. Mirrors the in-app
duplicate_dashboard remap. Browser cards keep their url/tabs but get fresh ids;
after writing the dashboard we re-point each imported session at it."""
from __future__ import annotations

from datetime import datetime, timezone
from uuid import uuid4

from backend.apps.swarm.exportable import DepRef, ExportContext, RemapTable
from backend.apps.swarm.models import EntityType, Requirement


class DashboardExportable:
    type = EntityType.dashboard

    def __init__(self, did: str, name: str, data: dict):
        self.local_id = did
        self.name = name
        self.p_data = data

    @classmethod
    def load(cls, local_id: str) -> "DashboardExportable | None":
        data = p_read(local_id)
        if data is None:
            return None
        return cls(local_id, data.get("name") or "Dashboard", data)

    def serialize(self, ctx: ExportContext) -> dict:
        layout = dict(self.p_data.get("layout") or {})
        cards = {}
        for sid, card in (layout.get("cards") or {}).items():
            bid = ctx.bundle_id_for(EntityType.session, sid)
            if bid:
                cards[bid] = {**card, "session_id": bid}
        view_cards = {}
        for key, card in (layout.get("view_cards") or {}).items():
            # Keys are output_id for the primary card, `output_id#N` for extra instances of the same app; resolve the bundle id off the bare output id and rebuild the suffix.
            oid = str(card.get("output_id") or key).split("#")[0]
            bid = ctx.bundle_id_for(EntityType.app, oid)
            if bid:
                inst = int(card.get("instance") or 1)
                # parent_session_id tethers the app card to the agent that built it; it's a session id, so it remaps like spawned_by on browser cards.
                parent = card.get("parent_session_id")
                view_cards[bid if inst <= 1 else f"{bid}#{inst}"] = {
                    **card, "output_id": bid,
                    "parent_session_id": ctx.bundle_id_for(EntityType.session, parent) if parent else None,
                }
        browser_cards = {}
        for bkey, card in (layout.get("browser_cards") or {}).items():
            c = dict(card)
            spawn = c.get("spawned_by")
            c["spawned_by"] = ctx.bundle_id_for(EntityType.session, spawn) if spawn else None
            browser_cards[bkey] = c
        expanded = [b for b in (ctx.bundle_id_for(EntityType.session, s) for s in (layout.get("expanded_session_ids") or [])) if b]
        return {"name": self.p_data.get("name") or "Dashboard", "layout": {
            **layout, "cards": cards, "view_cards": view_cards,
            "browser_cards": browser_cards, "notes": layout.get("notes") or {},
            "expanded_session_ids": expanded,
        }}

    def files(self) -> dict[str, bytes]:
        return {}

    def dependencies(self) -> list[DepRef]:
        layout = self.p_data.get("layout") or {}
        deps = [DepRef(EntityType.session, sid, "has_agent") for sid in (layout.get("cards") or {})]
        p_view_oids = {str(card.get("output_id") or key).split("#")[0] for key, card in (layout.get("view_cards") or {}).items()}
        deps += [DepRef(EntityType.app, oid, "has_app") for oid in sorted(p_view_oids)]
        return deps

    def requirements(self) -> list[Requirement]:
        return []

    @classmethod
    def import_(cls, payload: dict, files: dict[str, bytes], remap: RemapTable) -> str:
        new_did = uuid4().hex
        layout = dict(payload.get("layout") or {})
        cards = {}
        for bid, card in (layout.get("cards") or {}).items():
            nsid = remap.local(bid)
            if nsid:
                cards[nsid] = {**card, "session_id": nsid}
        view_cards = {}
        for key, card in (layout.get("view_cards") or {}).items():
            bid = str(card.get("output_id") or key).split("#")[0]
            noid = remap.local(bid)
            if noid:
                inst = int(card.get("instance") or 1)
                parent = card.get("parent_session_id")
                view_cards[noid if inst <= 1 else f"{noid}#{inst}"] = {
                    **card, "output_id": noid,
                    "parent_session_id": remap.local(parent) if parent else None,
                }
        browser_cards = {}
        for p_bkey, card in (layout.get("browser_cards") or {}).items():
            nbid = "browser-" + uuid4().hex[:10]
            c = dict(card)
            c["browser_id"] = nbid
            # Re-stamp the home dashboard, else the card keeps the source's id and the anti-bleed render guard (DashboardCardLayer keepAliveHidden) hides it on the imported dashboard.
            c["dashboard_id"] = new_did
            spawn = c.get("spawned_by")
            c["spawned_by"] = remap.local(spawn) if spawn else None
            browser_cards[nbid] = c
        expanded = [e for e in (remap.local(b) for b in (layout.get("expanded_session_ids") or [])) if e]
        now = datetime.now(timezone.utc).isoformat()
        doc = {
            "id": new_did,
            "name": payload.get("name") or "Imported Dashboard",
            "auto_named": False,
            "created_at": now,
            "updated_at": now,
            "layout": {
                **layout, "cards": cards, "view_cards": view_cards,
                "browser_cards": browser_cards, "notes": layout.get("notes") or {},
                "expanded_session_ids": expanded,
            },
        }
        p_write(new_did, doc)
        p_retag_sessions(cards.keys(), new_did)
        return new_did

    @classmethod
    def rollback(cls, local_id: str) -> None:
        import os
        d = p_dash_dir()
        if d:
            p = os.path.join(d, f"{local_id}.json")
            if os.path.exists(p):
                os.remove(p)


def p_dash_dir() -> str | None:
    try:
        from backend.config.paths import DASHBOARDS_DIR
        return DASHBOARDS_DIR
    except Exception:
        return None


def p_read(did: str) -> dict | None:
    import os
    from backend.config.json_store import read_json_or_none
    d = p_dash_dir()
    return read_json_or_none(os.path.join(d, f"{did}.json")) if d else None


def p_write(did: str, doc: dict) -> None:
    import os
    from backend.config.json_store import atomic_write_json
    d = p_dash_dir()
    if d:
        atomic_write_json(os.path.join(d, f"{did}.json"), doc)


def p_retag_sessions(session_ids, dashboard_id: str) -> None:
    # Best-effort: a hiccup here must not orphan the just-written dashboard.
    from backend.apps.agents.manager.session.session_store import load_session_data, save_session
    for sid in session_ids:
        try:
            d = load_session_data(sid)
            if d is not None:
                d["dashboard_id"] = dashboard_id
                save_session(sid, d)
        except Exception:
            pass
