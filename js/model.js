'use strict';

/*
 * Model: everything the UI shows is derived here from one flat, time-sorted
 * event stream. Decoders only add events; this file never mutates them.
 */

const Model = (() => {

  const sec = (ms) => ms / 1000;
  const MIN_DATE = Date.parse('2000-01-01');   // the machine logs epoch-0 warnings while its clock is unset

  // A run is a start…stop pair; an unmatched stop still counts as downtime.
  function runs(events) {
    const out = [];
    let open = null;
    for (const e of events) {
      if (e.kind === 'start') open = { start: e, picks0: e.picks || 0, length0: e.length || 0 };
      else if (e.kind === 'stop') {
        if (open) {
          const picks = (e.picks || 0) - open.picks0;
          const metres = (e.length || 0) - open.length0;
          out.push({ ...open, stop: e, ms: Date.parse(e.t) - Date.parse(open.start.t), picks, metres });
          open = null;
        } else {
          out.push({ start: e, stop: e, ms: 0, picks: 0, metres: 0, orphan: true });
        }
      }
    }
    if (open) out.push({ ...open, stop: null, ms: 0, picks: 0, metres: 0, unclosed: true });
    return out;
  }

  function build(rawEvents, machineDesigns) {
    const usable = rawEvents.filter(e => {
      const t = Date.parse(e.t);
      return Number.isFinite(t) && t >= MIN_DATE;
    });
    const timeline = usable.slice().sort((a, b) => Date.parse(a.t) - Date.parse(b.t));

    // Binary history repeats the export period and carries no counters, so it
    // extends the visible timeline but must not take part in production maths.
    const events = usable.filter(e => e.src !== 'btf').sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
    const binaryStops = timeline.filter(e => e.kind === 'stop' && e.src === 'btf').length;

    const runList = runs(events);
    const first = events[0], last = events[events.length - 1];
    const span = first && last ? Date.parse(last.t) - Date.parse(first.t) : 0;

    const live = runList.filter(r => !r.orphan && !r.unclosed);
    const runSec = live.reduce((s, r) => s + sec(r.ms), 0);
    const stops = events.filter(e => e.kind === 'stop');

    // Downtime by reason: each stop lasts until the next start.
    const byReason = new Map();
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      if (e.kind !== 'stop') continue;
      let until = null;
      for (let j = i + 1; j < events.length; j++) {
        if (events[j].kind === 'start') { until = events[j]; break; }
        if (events[j].kind === 'stop') { until = events[j]; break; }
      }
      const ms = until ? Date.parse(until.t) - Date.parse(e.t) : 0;
      const key = e.label || e.reason || 'Stop';
      const cur = byReason.get(key) || { label: key, count: 0, sec: 0 };
      cur.count++; cur.sec += sec(ms);
      byReason.set(key, cur);
    }

    const { picks, metres } = counterDelta(events);

    // ── per day ──
    const days = new Map();
    for (const e of events) {
      const day = e.t.slice(0, 10);
      if (!days.has(day)) days.set(day, { day, events: [], run: 0, stop: 0, stops: 0, picks: 0, metres: 0, articles: 0 });
      days.get(day).events.push(e);
    }
    for (const r of runList) {
      if (r.orphan || r.unclosed) continue;
      const d = days.get(r.start.t.slice(0, 10));
      if (d) d.run += sec(r.ms);
    }
    for (const d of days.values()) Object.assign(d, counterDelta(d.events));
    for (const e of stops) {
      const d = days.get(e.t.slice(0, 10));
      if (d) d.stops++;
    }
    for (const e of events) {
      if (e.kind !== 'article') continue;
      const d = days.get(e.t.slice(0, 10));
      if (d) d.articles++;
    }

    // ── per shift ──
    const shifts = [];
    let cur = null;
    for (const e of events) {
      if (e.kind === 'shift') {
        if (cur) cur.end = e.t;
        cur = { name: e.title || '?', start: e.t, end: null, run: 0, picks: 0, metres: 0, stops: 0, articles: 0, events: [] };
        shifts.push(cur);
      }
      if (cur) {
        if (e.kind === 'article') cur.articles++;
        if (e.kind === 'stop') cur.stops++;
        cur.events.push(e);
      }
    }
    const shiftOf = t => {
      let s = null;
      for (const sh of shifts) if (sh.start <= t && (!sh.end || t < sh.end)) s = sh;
      return s;
    };
    for (const r of runList) {
      const sh = shiftOf(r.start.t);
      if (!sh) continue;
      sh.run += sec(r.ms);
      sh.events.push(r.start);
    }
    for (const sh of shifts) {
      Object.assign(sh, counterDelta(sh.events));
      delete sh.events;
    }

    // ── article runs ──
    const articles = [];
    for (const e of events) {
      if (e.kind !== 'article') continue;
      if (articles.length && !articles[articles.length - 1].end) articles[articles.length - 1].end = e.t;
      articles.push({ name: e.title, start: e.t, end: null, picks: 0, metres: 0, stops: 0, events: [e] });
    }
    if (articles.length) articles[articles.length - 1].end = last ? last.t : null;
    for (const e of events) {
      const a = articles.find(x => x.start <= e.t && (!x.end || e.t < x.end));
      if (a) a.events.push(e);
    }
    for (const a of articles) {
      Object.assign(a, counterDelta(a.events));
      a.stops = a.events.filter(e => e.kind === 'stop').length;
      a.sec = a.end ? sec(Date.parse(a.end) - Date.parse(a.start)) : 0;
      delete a.events;
    }

    // ── operator sessions ──
    const sessions = [];
    for (const e of events) {
      if (e.kind !== 'operator') continue;
      if (e.title === 'Operator Logged In') sessions.push({ start: e.t, end: null, key: e.detail });
      else if (sessions.length) sessions[sessions.length - 1].end = e.t;
    }
    for (const s of sessions) s.sec = s.end ? sec(Date.parse(s.end) - Date.parse(s.start)) : null;

    const counts = {};
    for (const e of events) counts[e.kind] = (counts[e.kind] || 0) + 1;

    // ── per weft feeder (channel) ──
    const feeders = new Map();
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      if (e.kind !== 'stop' || !e.channel) continue;
      const key = e.channel;
      const f = feeders.get(key) || { channel: key, stops: 0, sec: 0, picks: 0, reasons: {} };
      f.stops++;
      f.picks += e.sincePicks || 0;
      if (e.label) f.reasons[e.label] = (f.reasons[e.label] || 0) + 1;
      const until = events.slice(i + 1).find(x => x.kind === 'start' || x.kind === 'stop');
      if (until) f.sec += sec(Date.parse(until.t) - Date.parse(e.t));
      feeders.set(key, f);
    }

    // ── hourly production and efficiency ──
    const hours = new Map();
    const hourOf = t => {
      const d = new Date(t);
      d.setMinutes(0, 0, 0);
      return +d;
    };
    const touch = t => {
      const k = hourOf(t);
      if (!hours.has(k)) hours.set(k, { t: new Date(k).toISOString(), run: 0, stops: 0, picks: 0, metres: 0 });
      return hours.get(k);
    };
    for (const e of events) {
      if (e.kind === 'stop') touch(e.t).stops++;
    }
    for (const r of runList) {
      if (r.orphan || r.unclosed) continue;
      const h = touch(r.start.t);
      h.run += sec(r.ms);
      h.picks += Math.max(0, r.picks);
      h.metres += Math.max(0, r.metres);
    }
    const hourly = [...hours.values()]
      .sort((a, b) => a.t.localeCompare(b.t))
      .map(h => ({ ...h, stop: Math.max(0, 3600 - h.run), efficiency: h.run / 3600 }));

    // ── design density sets (the pick variation the operator entered) ──
    const designs = [];
    const seenDesign = new Set();
    for (const d of machineDesigns || []) {
      const density = d.tables.find(t => t.type === 'PickDensity');
      const speed = d.tables.find(t => t.type === 'Speed');
      if (!density || !density.values.length) continue;
      const key = d.design + '|' + density.values.join(',');
      if (seenDesign.has(key)) continue;
      seenDesign.add(key);
      designs.push({
        design: d.design,
        densities: density.values,
        unit: density.unit || 'Picks/Inch',
        lines: density.lines || density.values.length,
        speed: speed ? speed.values : [],
        jacquard: d.jacquard,
      });
    }
    designs.sort((a, b) => b.densities.length - a.densities.length || a.design.localeCompare(b.design));

    return {
      events: timeline,
      binaryStops,
      first: first ? first.t : null,
      last: last ? last.t : null,
      spanSec: sec(span),
      runSec,
      stopCount: stops.length,
      efficiency: runSec > 0 ? runSec / (runSec + byReasonSec(byReason)) : 0,
      picks, metres,
      runCount: runList.length,
      byReason: [...byReason.values()].sort((a, b) => b.sec - a.sec || b.count - a.count),
      days: [...days.values()].sort((a, b) => b.day.localeCompare(a.day)),
      shifts, articles, sessions, counts,
      feeders: [...feeders.values()].sort((a, b) => b.sec - a.sec),
      hourly, designs,
      health: events.filter(e => e.kind === 'health'),
    };
  }

  function byReasonSec(map) {
    let t = 0;
    for (const v of map.values()) t += v.sec;
    return t;
  }

  // Picks and metres come from the machine's own lifetime counters, so anything
  // woven outside a start…stop pair still counts. A bucket's production is the
  // difference between the highest and lowest counter seen inside it.
  function counterDelta(list) {
    const seen = list.filter(e => e.src === 'export' && e.picks > 0);
    if (!seen.length) return { picks: 0, metres: 0 };
    return {
      picks: Math.max(...seen.map(e => e.picks)) - Math.min(...seen.map(e => e.picks)),
      metres: Math.max(...seen.map(e => e.length)) - Math.min(...seen.map(e => e.length)),
    };
  }

  return { build };
})();
