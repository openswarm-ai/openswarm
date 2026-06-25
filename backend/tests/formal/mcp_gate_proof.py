"""Formal proof (Z3 / SMT) of the MCP dispatch-gate security invariant.

The product rule "MCP tools are reachable only after MCPActivate" is enforced at
dispatch in agent_manager.build_mcp_servers: for a gated session a server is
forwarded to the model only if its sanitized name is in session.active_mcps.

tests/test_v2_invariants.py::test_mcp_gate_only_forwards_activated_servers
SAMPLES that contract (400 random cases). This SMT proof is exhaustive over the
modeled domain: we assert the negation of each property and ask Z3 for a
counterexample. `unsat` means none can exist, so the property is a theorem,
true for every possible input, not just the ones a test happened to try.

Not wired into prod or CI. Run manually:
    pip install z3-solver && python backend/tests/formal/mcp_gate_proof.py
"""

from z3 import And, Bool, Implies, Not, Or, Solver, sat, unsat


def forwarded(installed, allowed, denied, active_is_none, active_t):
    """Faithful model of the gate decision for one arbitrary server `t`
    (agent_manager.py:165-203). A server ships to the model iff it is an
    installed+configured MCP tool, passes the permission gate, isn't fully
    denied, and EITHER the session is legacy (active_mcps is None) OR the
    server is in active_mcps. Proving it for an arbitrary symbolic `t` proves
    it for all servers."""
    return And(installed, allowed, Not(denied), Or(active_is_none, active_t))


def buggy_forwarded(installed, allowed, denied, active_is_none, active_t):
    """The same gate with the activation check dropped, used to show the proof
    has teeth: Z3 must be able to refute the no-leak property for this variant."""
    return And(installed, allowed, Not(denied))


def prove(name: str, claim) -> bool:
    """`claim` should be valid (true for every input). Proven by showing its
    negation is unsatisfiable."""
    s = Solver()
    s.add(Not(claim))
    if s.check() == unsat:
        print(f"  PROVED:  {name}")
        return True
    print(f"  FAILED:  {name}  counterexample: {s.model()}")
    return False


def main() -> None:
    installed = Bool("installed")
    allowed = Bool("allowed")
    denied = Bool("denied")
    active_is_none = Bool("active_is_none")  # legacy session (no activation gate)
    active_t = Bool("active_t")              # server t is in active_mcps
    fwd = forwarded(installed, allowed, denied, active_is_none, active_t)
    gated = Not(active_is_none)

    print("Proving MCP dispatch-gate invariants (exhaustive over all inputs):")
    ok = True
    # A. No leak: a gated session never forwards a non-activated server.
    ok &= prove("gated  =>  (forwarded(t) -> activated(t))",
                Implies(And(gated, fwd), active_t))
    # B. Empty activation => zero servers (no t is active, so none ship).
    ok &= prove("gated & !activated(t)  =>  !forwarded(t)",
                Implies(And(gated, Not(active_t)), Not(fwd)))
    # C. The permission gate still binds: a denied server is never forwarded.
    ok &= prove("denied(t)  =>  !forwarded(t)", Implies(denied, Not(fwd)))

    # Teeth: the buggy gate (activation check dropped) MUST be refutable, else the proof above would be vacuous.
    print("Sanity-checking the proof has teeth (a buggy gate must be refuted):")
    bug = buggy_forwarded(installed, allowed, denied, active_is_none, active_t)
    s = Solver()
    s.add(Not(Implies(And(gated, bug), active_t)))
    assert s.check() == sat, "buggy gate should leak but Z3 couldn't refute it"
    print(f"  REFUTED (as expected): a gate without the activation check leaks; "
          f"counterexample = {s.model()}")

    print("\nALL GATE PROPERTIES PROVED" if ok else "\nPROOF FAILED")
    raise SystemExit(0 if ok else 1)


if __name__ == "__main__":
    main()
