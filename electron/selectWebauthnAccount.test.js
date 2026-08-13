// Run: node --test electron/test/selectWebauthnAccount.test.js
//
// ENG-269. Answering the select-webauthn-account callback with null CANCELS the WebAuthn ceremony,
// and the site reports that as its own generic error (Google: "Something went wrong"). The shipped
// handler read the accounts array off argument 2 and looked for `accountId`, but Electron passes
// `details = { relyingPartyId, accounts, frame }` and the field is `credentialId`. So it answered
// null on every sign-in while passkey CREATION, which needs no account selection, kept working:
// exactly the "I could use my fingerprint before, now it fails" report.
const test = require('node:test');
const assert = require('node:assert/strict');

/** The handler body as main.js registers it, isolated so the test drives the real shape. */
function makeHandler(log = () => {}) {
  return (event, details, callback) => {
    const accounts = (details && details.accounts) || [];
    log(details && details.relyingPartyId, accounts.length);
    // Zero credentials: do NOT take the event over. Answering null here is an explicit cancel and
    // the page shows a prompt that never appears; leaving it lets Chromium offer "Try another way".
    if (accounts.length === 0) return;
    event.preventDefault();
    if (accounts.length === 1) return callback(accounts[0].credentialId);
    callback(accounts[0].credentialId);
  };
}

function drive(details) {
  let answered = 'NOT CALLED';
  let prevented = false;
  makeHandler()({ preventDefault: () => { prevented = true; } }, details, (v) => { answered = v; });
  return { answered, prevented };
}

test('one discoverable passkey is answered with its credentialId, not null', () => {
  const r = drive({ relyingPartyId: 'google.com', accounts: [{ credentialId: 'cred-abc', name: 'eric@openswarm.com' }] });
  assert.equal(r.answered, 'cred-abc');
  assert.equal(r.prevented, true);
});

test('several passkeys still answer a real credentialId (never null)', () => {
  const r = drive({ relyingPartyId: 'google.com', accounts: [{ credentialId: 'c1' }, { credentialId: 'c2' }] });
  assert.equal(r.answered, 'c1');
});



test('a malformed details object cannot throw or hang the ceremony', () => {
  // Same reasoning as the empty list: nothing to choose means stay out of the way, so the callback
  // is never invoked and Chromium keeps ownership of the ceremony.
  for (const d of [undefined, null, {}, { accounts: undefined }]) {
    assert.equal(drive(d).answered, 'NOT CALLED', JSON.stringify(d));
    assert.equal(drive(d).prevented, false, JSON.stringify(d));
  }
});

test('the OLD signature would have cancelled every sign-in', () => {
  // Regression witness: the shipped shape, driven with the real details object.
  const old = (event, accounts, callback) => {
    event.preventDefault();
    callback((accounts && accounts[0] && accounts[0].accountId) || null);
  };
  let answered = 'NOT CALLED';
  old({ preventDefault() {} }, { relyingPartyId: 'google.com', accounts: [{ credentialId: 'cred-abc' }] },
    (v) => { answered = v; });
  assert.equal(answered, null, 'the old handler answered null even with a real passkey present');
});

test('zero credentials leaves the event alone so the site can offer another way', () => {
  // The failure this encodes: our authenticator only sees passkeys in OUR keychain access group, so
  // one made in Safari or Chrome arrives as an empty list. Cancelling it is why "Complete sign-in
  // using your passkey" sat there with no Touch ID prompt ever appearing (ENG-269, reported live).
  const r = drive({ relyingPartyId: 'google.com', accounts: [] });
  assert.equal(r.prevented, false, 'took over the event and cancelled instead of falling through');
  assert.equal(r.answered, 'NOT CALLED', 'answered the callback when it should have stayed silent');
});
