import { describe, it, expect } from 'vitest';
import { DateTime } from 'luxon';
import { applyAwayMode, seededRand } from '../../server/engine/awayMode.js';

const TZ = 'America/New_York';
const at = (dateISO, hhmm) => DateTime.fromISO(`${dateISO}T${hhmm}`, { zone: TZ }).toMillis();
const zones = [{ id: 2 }, { id: 9, kind: 'fridge' }]; // 2 = plain light, 9 = appliance
const base = { enabled: true, from: '2025-07-01', to: '2025-07-31', jitterMin: 15, shortenPct: 30, quietFrom: '23:00', quietTo: '06:00', varyPct: 0, seed: 's1' };
// one assur window covering Fri Jul 4 evening → Sat Jul 5 night (a plain Shabbos)
const clusters = [{ startsAt: new Date(at('2025-07-04', '18:00')), endsAt: new Date(at('2025-07-05', '21:30')) }];
const opts = { awayMode: base, zones, tzid: TZ, clusters };

const mk = () => [
  { at: at('2025-07-04', '19:00'), zone: 2, level: 100, type: 'setLevel', source: { ruleId: 'on' } },
  { at: at('2025-07-04', '22:00'), zone: 2, level: 0, type: 'setLevel', source: { ruleId: 'off' } },
  { at: at('2025-07-04', '18:00'), zone: 9, level: 100, type: 'setLevel', source: { ruleId: 'fridge' } }, // appliance
  { at: at('2025-07-04', '20:00'), zone: 2, times: 1, type: 'flash', source: { ruleId: 'flash' } },       // reminder
  { at: at('2025-08-15', '19:00'), zone: 2, level: 100, type: 'setLevel', source: { ruleId: 'out' } },     // out of window
];
const byRule = (arr) => Object.fromEntries(arr.map((a) => [a.source.ruleId, a]));

describe('applyAwayMode', () => {
  it('is a no-op when disabled or unconfigured', () => {
    const a = mk();
    expect(applyAwayMode(a, { ...opts, awayMode: { ...base, enabled: false } })).toBe(a);
    expect(applyAwayMode(a, { ...opts, awayMode: null })).toBe(a);
  });

  it('is deterministic — same seed/inputs give identical timestamps', () => {
    const r1 = applyAwayMode(mk(), opts).map((x) => `${x.zone}:${x.at}:${x.type}`).sort();
    const r2 = applyAwayMode(mk(), opts).map((x) => `${x.zone}:${x.at}:${x.type}`).sort();
    expect(r1).toEqual(r2);
    // a different seed generally shifts things
    const r3 = applyAwayMode(mk(), { ...opts, awayMode: { ...base, seed: 'other' } }).map((x) => `${x.zone}:${x.at}`).sort();
    expect(r3).not.toEqual(r1.map((s) => s.split(':').slice(0, 2).join(':')));
  });

  it('never touches appliances, reminders, or out-of-window actions', () => {
    const out = byRule(applyAwayMode(mk(), opts));
    expect(out.fridge.at).toBe(at('2025-07-04', '18:00'));
    expect(out.flash.at).toBe(at('2025-07-04', '20:00'));
    expect(out.out.at).toBe(at('2025-08-15', '19:00'));
  });

  it('jitters within ±jitterMin and keeps lights on for LESS time', () => {
    const out = byRule(applyAwayMode(mk(), opts));
    const jit = Math.abs(out.on.at - at('2025-07-04', '19:00'));
    expect(jit).toBeLessThanOrEqual(15 * 60_000);
    const origDur = at('2025-07-04', '22:00') - at('2025-07-04', '19:00');
    const newDur = out.off.at - out.on.at;
    expect(newDur).toBeLessThanOrEqual(origDur);   // shortened (or equal)
    expect(newDur).toBeGreaterThanOrEqual(5 * 60_000); // but never below the 5-min floor
  });

  it('keeps a midnight-crossing on/off pair atomic and ordered (never a stuck-ON)', () => {
    // ON Fri 23:00, OFF Sat 00:40 — different local days, ONE lit period.
    // The old per-calendar-day grouping could drop the OFF alone (light stuck
    // ON all night) or jitter the two independently into inverted order.
    const acts = () => [
      { at: at('2025-07-04', '23:00'), zone: 2, level: 100, type: 'setLevel', source: { ruleId: 'on' } },
      { at: at('2025-07-05', '00:40'), zone: 2, level: 0, type: 'setLevel', source: { ruleId: 'off' } },
    ];
    // quiet hours disabled (empty window) so the 23:00 turn-on isn't suppressed
    const am = { ...base, quietFrom: '03:00', quietTo: '03:00', varyPct: 50 };
    for (const s of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
      const out = applyAwayMode(acts(), { ...opts, awayMode: { ...am, seed: s } });
      const on = out.find((a) => a.source.ruleId === 'on');
      const off = out.find((a) => a.source.ruleId === 'off');
      expect(Boolean(on)).toBe(Boolean(off));            // both survive or both drop
      if (on) expect(off.at).toBeGreaterThan(on.at);     // order can never invert
    }
  });

  it('caps daytime lit periods but keeps evening ones on longer', () => {
    const sunset = at('2025-07-05', '20:30'); // evening begins ~19:00
    const sunsetMs = () => sunset;
    const acts = [
      { at: at('2025-07-05', '08:00'), zone: 2, level: 100, type: 'setLevel', source: { ruleId: 'dayOn' } },
      { at: at('2025-07-05', '17:00'), zone: 2, level: 0, type: 'setLevel', source: { ruleId: 'dayOff' } },   // 9h daytime
      { at: at('2025-07-05', '19:15'), zone: 2, level: 100, type: 'setLevel', source: { ruleId: 'eveOn' } },
      { at: at('2025-07-05', '21:00'), zone: 2, level: 0, type: 'setLevel', source: { ruleId: 'eveOff' } },   // 1h45 evening
    ];
    const out = byRule(applyAwayMode(acts, { ...opts, sunsetMs, awayMode: { ...base, jitterMin: 0 } }));
    const dayDur = out.dayOff.at - out.dayOn.at;
    const eveDur = out.eveOff.at - out.eveOn.at;
    expect(dayDur).toBeLessThanOrEqual(120 * 60_000);  // daytime capped to <=2h (was 9h)
    expect(eveDur).toBeGreaterThan(90 * 60_000);        // evening kept most of its 1h45
  });

  it('drops turn-ONs that land in quiet hours', () => {
    const acts = [
      { at: at('2025-07-05', '03:00'), zone: 2, level: 100, type: 'setLevel', source: { ruleId: 'lateOn' } },
      { at: at('2025-07-05', '03:30'), zone: 2, level: 0, type: 'setLevel', source: { ruleId: 'lateOff' } },
    ];
    const out = applyAwayMode(acts, opts);
    expect(out.some((a) => a.source.ruleId === 'lateOn')).toBe(false); // 3am turn-on suppressed
  });

  it('some zone-nights go dark when varyPct > 0 (deterministic)', () => {
    // find a date this seed drops, to prove the vary path works and is stable
    let dropped = null;
    for (let day = 1; day <= 28 && !dropped; day++) {
      const d = `2025-07-${String(day).padStart(2, '0')}`;
      if (seededRand('s1', 'vary', '2', d) < 0.5) dropped = d;
    }
    expect(dropped).toBeTruthy();
    const acts = [{ at: at(dropped, '20:00'), zone: 2, level: 100, type: 'setLevel', source: { ruleId: 'x' } }];
    const varyClusters = [{ startsAt: new Date(at(dropped, '18:00')), endsAt: new Date(at(dropped, '23:59')) }];
    const out = applyAwayMode(acts, { awayMode: { ...base, varyPct: 50 }, zones, tzid: TZ, clusters: varyClusters });
    expect(out).toHaveLength(0);
  });

  // Open-ended window (`to: null`) — the vacation-home case, "away until I
  // turn it off". It must behave exactly like a window whose end is far in the
  // future, and it must never be treated as "unconfigured".
  describe('open-ended window (to: null)', () => {
    const openEnded = { ...base, to: null };
    const openOpts = { ...opts, awayMode: openEnded };

    it('still transforms — a missing `to` is not "unconfigured"', () => {
      const a = mk();
      const out = applyAwayMode(a, openOpts);
      expect(out).not.toBe(a); // not the identity no-op
      const on = byRule(out).on;
      expect(on.at).not.toBe(at('2025-07-04', '19:00')); // jittered like normal
    });

    it('a missing `from` IS still unconfigured', () => {
      const a = mk();
      expect(applyAwayMode(a, { ...opts, awayMode: { ...base, from: null, to: null } })).toBe(a);
    });

    it('matches a far-future bounded window exactly', () => {
      const bounded = applyAwayMode(mk(), { ...opts, awayMode: { ...base, to: '2099-12-31' } });
      const open = applyAwayMode(mk(), openOpts);
      const key = (arr) => arr.map((x) => `${x.zone}:${x.at}:${x.type}`).sort();
      expect(key(open)).toEqual(key(bounded));
    });

    it('covers clusters far beyond any fixed end date', () => {
      // a cluster years after `from` is still inside an open-ended window
      const future = [{ startsAt: new Date(at('2031-03-07', '18:00')), endsAt: new Date(at('2031-03-08', '21:30')) }];
      const acts = [
        { at: at('2031-03-07', '19:00'), zone: 2, level: 100, type: 'setLevel', source: { ruleId: 'on' } },
        { at: at('2031-03-07', '22:00'), zone: 2, level: 0, type: 'setLevel', source: { ruleId: 'off' } },
      ];
      const out = applyAwayMode(acts, { awayMode: openEnded, zones, tzid: TZ, clusters: future });
      expect(byRule(out).on.at).not.toBe(at('2031-03-07', '19:00')); // transformed
      // the same actions under a window that ENDED in 2025 pass through untouched
      const bounded = applyAwayMode(acts, { awayMode: base, zones, tzid: TZ, clusters: future });
      expect(byRule(bounded).on.at).toBe(at('2031-03-07', '19:00'));
    });

    it('still ignores anything before `from`', () => {
      const early = [{ startsAt: new Date(at('2025-06-06', '18:00')), endsAt: new Date(at('2025-06-07', '21:30')) }];
      const acts = [{ at: at('2025-06-06', '19:00'), zone: 2, level: 100, type: 'setLevel', source: { ruleId: 'early' } }];
      const out = applyAwayMode(acts, { awayMode: openEnded, zones, tzid: TZ, clusters: early });
      expect(byRule(out).early.at).toBe(at('2025-06-06', '19:00')); // untouched
    });
  });
});
