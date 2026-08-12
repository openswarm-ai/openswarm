// Run: node --test (via frontend/scripts/run-tests.mjs)
//
// Stock Material Alerts were leaking through: a saturated blue/green/red block with white text, in a
// product whose whole surface language is warm paper and glass. There were 15 call sites and most
// passed no styling at all, so fixing them one by one would have left the next one to regress. The
// fix is a theme-level override; this pins it, because the failure mode is silent (it still renders,
// it just looks like someone else's app).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { lightTokens, darkTokens } from '@/shared/styles/claudeTokens';
import { alertStyleOverrides } from '@/shared/styles/alertOverrides.ts';

const MATERIAL_DEFAULTS = ['rgb(2, 136, 209)', '#0288d1', 'rgb(46, 125, 50)', '#2e7d32', 'rgb(211, 47, 47)', '#d32f2f'];

for (const [name, tokens] of [['light', lightTokens], ['dark', darkTokens]] as const) {
  test(`${name}: every Alert variant uses the app surface, not a Material colour`, () => {
    const o = alertStyleOverrides(tokens) as Record<string, any>;
    assert.equal(o.root.backgroundColor, tokens.bg.elevated);
    assert.equal(o.root.color, tokens.text.primary);
    for (const v of ['filledInfo', 'filledSuccess', 'filledWarning', 'filledError']) {
      assert.equal(o[v].backgroundColor, tokens.bg.elevated, `${v} is not on the app surface`);
      assert.equal(o[v].color, tokens.text.primary, `${v} text is not an app token`);
      assert.ok(!MATERIAL_DEFAULTS.includes(String(o[v].backgroundColor)), `${v} kept a Material colour`);
    }
  });

  test(`${name}: severity still reads, through the icon`, () => {
    const o = alertStyleOverrides(tokens) as Record<string, any>;
    const icon = (v: string) => o[v]['& .MuiAlert-icon'].color;
    assert.equal(icon('standardError'), tokens.status.error);
    assert.equal(icon('standardWarning'), tokens.status.warning);
    assert.equal(icon('standardSuccess'), tokens.status.success);
    assert.equal(icon('standardInfo'), tokens.status.info);
    // Meaning must survive the calming: the four severities cannot collapse to one colour.
    const distinct = new Set([icon('standardError'), icon('standardWarning'), icon('standardSuccess'), icon('standardInfo')]);
    assert.equal(distinct.size, 4, 'severities became indistinguishable');
  });
}
