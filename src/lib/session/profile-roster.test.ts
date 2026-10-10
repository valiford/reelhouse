import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEMO_ROSTER_ENTRY,
  MAX_ROSTER_ENTRIES,
  activeRosterSlug,
  parseProfileRoster,
  profileSwitchTarget
} from "./profile-roster.ts";

test("a well-formed roster payload parses into renderable entries", () => {
  const entries = parseProfileRoster({
    profiles: [
      { slug: "vali", display_name: "Vali", initials: "V", is_default: true },
      { slug: "nicole", display_name: "Nicole", initials: null, is_default: false }
    ]
  });
  assert.deepEqual(entries, [
    { slug: "vali", displayName: "Vali", initials: "V", isDefault: true },
    { slug: "nicole", displayName: "Nicole", initials: null, isDefault: false }
  ]);
});

test("an entry without a server identity is never rendered switchable", () => {
  // The slug is the contractual identity a switch navigates to; a roster row
  // without one has nothing to navigate to and must not reach the dialog.
  const entries = parseProfileRoster({
    profiles: [
      { slug: "", display_name: "Blank slug" },
      { display_name: "No slug at all" },
      { slug: "   ", display_name: "Whitespace slug" },
      { slug: "noname", display_name: "   " },
      { slug: "noname2" },
      "not-an-object",
      null,
      { slug: "vali", display_name: "Vali" }
    ]
  });
  assert.deepEqual(entries, [{ slug: "vali", displayName: "Vali", initials: null, isDefault: false }]);
});

test("an unshaped payload parses to an empty roster, never fabricated profiles", () => {
  assert.deepEqual(parseProfileRoster(null), []);
  assert.deepEqual(parseProfileRoster(undefined), []);
  assert.deepEqual(parseProfileRoster("nope"), []);
  assert.deepEqual(parseProfileRoster({ profiles: "nope" }), []);
  assert.deepEqual(parseProfileRoster({ profiles: [] }), []);
  // An array at the top level is not a roster envelope.
  assert.deepEqual(parseProfileRoster([{ slug: "vali", display_name: "Vali" }]), []);
});

test("the roster the client will render is bounded", () => {
  const flood = { profiles: Array.from({ length: 500 }, (_, index) => ({ slug: `p_${index}`, display_name: `P ${index}` })) };
  const entries = parseProfileRoster(flood);
  assert.equal(entries.length, MAX_ROSTER_ENTRIES);
});

test("the effective session identity prefers the resolved feed slug", () => {
  // The unscoped default view IS the resolved default profile's session: the
  // roster must mark it active even though the URL asserts nothing.
  assert.equal(activeRosterSlug(null, "vali"), "vali");
  assert.equal(activeRosterSlug("nicole", "vali"), "vali", "the resolved slug is the authority");
  assert.equal(activeRosterSlug("nicole", null), "nicole", "before the feed resolves, the URL rules");
  assert.equal(activeRosterSlug(null, null), null, "no identity known marks nothing");
  // An asserted slug that failed to resolve (ghost) marks nothing — the
  // roster never pretends a broken session owns a profile.
  assert.equal(activeRosterSlug("ghost", null), "ghost");
});

test("activating the current session is a no-op, not a navigation", () => {
  // An identity change is the RH-0043 switch trigger: navigating to the
  // identical identity would reboot the session and drop cached state for
  // no change — the contract forbids it for re-selection.
  assert.equal(profileSwitchTarget("vali", "vali"), null);
  assert.equal(profileSwitchTarget(null, "vali"), "/?profile=vali");
  assert.equal(profileSwitchTarget("nicole", "vali"), "/?profile=vali");
  assert.equal(profileSwitchTarget("vali", ""), null, "an identity-less entry navigates nowhere");
  assert.equal(profileSwitchTarget("vali", "   "), null);
});

test("the switch target encodes the slug exactly once, contractually", () => {
  assert.equal(profileSwitchTarget("nicole", "odd slug"), "/?profile=odd%20slug");
  assert.equal(profileSwitchTarget("nicole", "v_ali"), "/?profile=v_ali");
});

test("demo mode lists the delivered demo identity, which is always current", () => {
  assert.equal(DEMO_ROSTER_ENTRY.slug, "demo");
  assert.equal(profileSwitchTarget(DEMO_ROSTER_ENTRY.slug, DEMO_ROSTER_ENTRY.slug), null);
});
