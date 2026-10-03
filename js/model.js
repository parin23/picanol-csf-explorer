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

  function build(rawEvents, machineDesigns, range) {
    // Only well-formed event objects take part; anything else is ignored rather
    // than allowed to abort the whole build.
    const list = (Array.isArray(rawEvents) ? rawEvents : []).filter(e => e && typeof e === 'object');
    const from = range && range.from ? Date.parse(range.from + 'T00:00:00') : -Infinity;
    const to = range && range.to ? Date.parse(range.to + 'T23:59:59.999') : Infinity;
    const wantedShifts = new Set((range && range.shifts) || []);
    const inRange = e => {
      const t = Date.parse(e.t);
      if (!Number.isFinite(t) || t < MIN_DATE || t < from || t > to) return false;
      // With a shift filter on, only records the machine stamped with a shift count.
      return wantedShifts.size ? (e.shift ? wantedShifts.has(e.shift) : false) : true;
    };

    const usable = list.filter(inRange);
    // Sort once on a pre-parsed timestamp: comparing Date.parse() results inside
    // the comparator re-parses both strings on every one of ~n·log n comparisons,
    // which dominates the build on large archives.
    const decorated = usable.map(e => ({ e, t: Date.parse(e.t) }));
    decorated.sort((a, b) => a.t - b.t);
    const timeline = decorated.map(d => d.e);

    // Binary history repeats the export period and carries no counters, so it
    // extends the visible timeline but must not take part in production maths.
    const events = decorated.filter(d => d.e.src !== 'btf').map(d => d.e);
    const binaryStops = timeline.filter(e => e.kind === 'stop' && e.src === 'btf').length;

    const runList = runs(events);
    const first = events[0], last = events[events.length - 1];
    const span = first && last ? Date.parse(last.t) - Date.parse(first.t) : 0;

    const live = runList.filter(r => !r.orphan && !r.unclosed);
    const runSec = live.reduce((s, r) => s + sec(r.ms), 0);
    const stops = events.filter(e => e.kind === 'stop');

    // Stop durations are needed by several sections, so derive them once here.
    // One pass backwards gives every event's successor in O(1) each — a forward
    // scan per stop would be quadratic and stalls on big archives.
    // For each event, the next event that is a production boundary (start/stop).
    // One backward pass: successor[i] must be the next *boundary*, not merely
    // events[i + 1] — article and setting records sit between them.
    const successorIdx = new Array(events.length).fill(-1);
    {
      let next = -1;
      for (let i = events.length - 1; i >= 0; i--) {
        successorIdx[i] = next;
        const k = events[i].kind;
        if (k === 'start' || k === 'stop') next = i;
      }
    }
    const successor = successorIdx.map(i => (i >= 0 ? events[i] : null));

    // Downtime by reason: each stop lasts until the next start. Reuses the
    // successor map — a fresh scan per stop is quadratic and stalls big archives.
    const byReason = new Map();
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      if (e.kind !== 'stop') continue;
      const until = successor[i];
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
      sh.efficiency = sh.run && sh.end ? sh.run / sec(Date.parse(sh.end) - Date.parse(sh.start)) : 0;
      sh.picksPerHour = sh.run ? sh.picks / (sh.run / 3600) : 0;
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
      const c = counterDelta(a.events);
      a.picks = c.picks;
      a.metres = c.metres;
      a.stops = a.events.filter(e => e.kind === 'stop').length;
      a.sec = a.end ? sec(Date.parse(a.end) - Date.parse(a.start)) : 0;
      a.run = a.events.filter(e => e.kind === 'start').length;   // placeholder, replaced below
      delete a.events;
    }
    // Article efficiency: running time inside the article window over its length.
    for (const a of articles) {
      let run = 0;
      for (const r of runList) {
        if (r.orphan || r.unclosed) continue;
        if (r.start.t >= a.start && (!a.end || r.start.t < a.end)) run += sec(r.ms);
      }
      a.runSec = run;
      a.efficiency = a.sec ? run / a.sec : 0;
      a.picksPerHour = run ? a.picks / (run / 3600) : 0;
      delete a.run;
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

    const stopDurations = [];
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      if (e.kind !== 'stop') continue;
      const until = successor[i];
      stopDurations.push({
        sec: until ? sec(Date.parse(until.t) - Date.parse(e.t)) : 0,
        label: e.label || e.reason || 'Stop',
        channel: e.channel || '',
        shift: e.shift || '',
        t: e.t,
        picks: e.sincePicks || 0,
      });
    }

    // ── per weft feeder (channel) ──
    const feeders = new Map();
    for (const s of stopDurations) {
      if (!s.channel) continue;
      const f = feeders.get(s.channel) || { channel: s.channel, stops: 0, sec: 0, picks: 0, reasons: {} };
      f.stops++;
      f.sec += s.sec;
      f.picks += s.picks;
      f.reasons[s.label] = (f.reasons[s.label] || 0) + 1;
      feeders.set(s.channel, f);
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

    // Shift totals come from the shift field on every export record, which is
    // always present — unlike the shift *events*, which are only logged when
    // the terminal happens to report them.
    const shiftTotals = new Map();
    // Times are already sorted, so "shift in force at t" is a binary search.
    const shiftTimes = [], shiftNames = [];
    for (const e of events) {
      if (!e.shift || e.kind === 'shift') continue;
      shiftTimes.push(Date.parse(e.t));
      shiftNames.push(e.shift);
    }
    const shiftAt = t => {
      let lo = 0, hi = shiftTimes.length - 1, best = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (shiftTimes[mid] <= t) { best = mid; lo = mid + 1; } else hi = mid - 1;
      }
      return best < 0 ? '' : shiftNames[best];
    };
    for (const e of events) {
      if (e.kind === 'shift' || !e.shift) continue;
      const s = shiftTotals.get(e.shift) || { name: e.shift, events: [], stops: 0, run: 0, stop: 0, picks: 0, metres: 0, first: e.t, last: e.t };
      s.events.push(e);
      if (e.kind === 'stop') s.stops++;
      if (e.t > s.last) s.last = e.t;
      shiftTotals.set(e.shift, s);
    }
    for (const r of runList) {
      if (r.orphan || r.unclosed) continue;
      const name = r.start.shift || shiftAt(r.start.t);
      const s = shiftTotals.get(name);
      if (!s) continue;
      s.run += sec(r.ms);
      s.picks += Math.max(0, r.picks);
      s.metres += Math.max(0, r.metres);
    }
    for (const d of stopDurations) {
      const s = shiftTotals.get(d.shift);
      if (s) s.stop += d.sec;
    }
    for (const s of shiftTotals.values()) delete s.events;
    const attributedPicks = [...shiftTotals.values()].reduce((a, s) => a + s.picks, 0);
    for (const s of shiftTotals.values()) {
      s.efficiency = (s.run + s.stop) ? s.run / (s.run + s.stop) : 0;
      s.picksPerHour = s.run ? s.picks / (s.run / 3600) : 0;
      s.metresPerHour = s.run ? s.metres / (s.run / 3600) : 0;
      delete s.events;
    }

    const pareto = [];
    let cum = 0;
    const reasonTotal = [...byReason.values()].reduce((s, r) => s + r.sec, 0);
    for (const r of [...byReason.values()].sort((a, b) => b.sec - a.sec || b.count - a.count)) {
      cum += r.sec;
      pareto.push({ ...r, cumulative: reasonTotal ? cum / reasonTotal : 0 });
    }

    const designs = [];
    const seenDesign = new Set();
    for (const d of (Array.isArray(machineDesigns) ? machineDesigns : [])) {
      if (!d || !Array.isArray(d.tables)) continue;
      const density = d.tables.find(t => t && t.type === 'PickDensity');
      const speed = d.tables.find(t => t && t.type === 'Speed');
      if (!density || !Array.isArray(density.values) || !density.values.length) continue;
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

    // ── stop and run duration statistics ──
    const runDurations = live.map(r => sec(r.ms));

    const quantile = (arr, q) => {
      if (!arr.length) return 0;
      const s = arr.slice().sort((a, b) => a - b);
      return s[Math.min(s.length - 1, Math.floor(q * s.length))];
    };
    const total = a => a.reduce((x, y) => x + y, 0);
    const mean = a => (a.length ? total(a) / a.length : 0);

    const HISTOGRAM = [
      { label: '0–10 s', min: 0, max: 10 },
      { label: '10–30 s', min: 10, max: 30 },
      { label: '30 s–1 m', min: 30, max: 60 },
      { label: '1–5 m', min: 60, max: 300 },
      { label: '5–30 m', min: 300, max: 1800 },
      { label: '30 m+', min: 1800, max: Infinity },
    ];
    const histogram = HISTOGRAM.map(b => ({
      ...b,
      count: stopDurations.filter(s => s.sec >= b.min && s.sec < b.max).length,
    }));
    const longest = stopDurations.slice().sort((a, b) => b.sec - a.sec)[0] || null;

    const stats = {
      stops: stopDurations.length,
      mttr: mean(stopDurations.map(s => s.sec)),
      medianStop: quantile(stopDurations.map(s => s.sec), 0.5),
      p95Stop: quantile(stopDurations.map(s => s.sec), 0.95),
      mtbf: stops.length > 1 ? runSec / (stops.length - 1) : runSec,
      meanRun: mean(runDurations),
      medianRun: quantile(runDurations, 0.5),
      longestRun: runDurations.reduce((a, b) => b > a ? b : a, 0),
      longestStop: longest,
      picksPerStop: stops.length ? picks / stops.length : 0,
    };

    // ── hour of day × reason, and weekday profile ──
    const reasons = [...byReason.keys()];
    const hourReasons = new Map();
    const hoursOfDay = Array.from({ length: 24 }, (_, h) => ({ hour: h, stops: 0, picks: 0 }));
    const weekdays = Array.from({ length: 7 }, (_, d) => ({ day: d, stops: 0, picks: 0, run: 0 }));
    for (const s of stopDurations) {
      const d = new Date(s.t);
      const h = d.getHours();
      hoursOfDay[h].stops++;
      weekdays[(d.getDay() + 6) % 7].stops++;
      const key = `${h}|${s.label}`;
      hourReasons.set(key, (hourReasons.get(key) || 0) + 1);
    }
    for (const h of hourly) {
      const d = new Date(h.t);
      hoursOfDay[d.getHours()].picks += h.picks;
      weekdays[(d.getDay() + 6) % 7].picks += h.picks;
      weekdays[(d.getDay() + 6) % 7].run += h.run;
    }
    const hourMatrix = {
      hours: hoursOfDay,
      reasons: [...reasons],
      cell: (h, r) => hourReasons.get(`${h}|${r}`) || 0,
      max: Math.max(1, ...hourReasons.values()),
    };

    // ── feeder × reason matrix ──
    const feederReasons = new Map();
    for (const s of stopDurations) {
      if (!s.channel) continue;
      feederReasons.set(`${s.channel}|${s.label}`, (feederReasons.get(`${s.channel}|${s.label}`) || 0) + 1);
    }
    const feederMatrix = {
      channels: [...feeders.keys()],
      reasons: [...reasons],
      max: Math.max(1, ...feederReasons.values()),
      cell: (ch, r) => feederReasons.get(`${ch}|${r}`) || 0,
    };

    // ── warp stops split by cause ──
    const warp = { beam: 0, wasteLeft: 0, wasteRight: 0, other: 0, sec: 0 };
    for (const s of stopDurations) {
      if (s.label !== 'Beam change' && !s.label.startsWith('Waste yarn')) continue;
      warp.sec += s.sec;
      if (s.label === 'Beam change') warp.beam++;
      else if (s.label === 'Waste yarn left') warp.wasteLeft++;
      else if (s.label === 'Waste yarn right') warp.wasteRight++;
      else warp.other++;
    }

    // ── throughput: picks and metres per hour ──
    const throughput = hourly.map(h => ({ ...h, picksPerHour: h.picks, metresPerHour: h.metres }));

    // ── gantt: run/stop segments per day ──
    const gantt = [];
    for (const [day, d] of [...days.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const dayEvents = d.events.filter(e => e.kind === 'start' || e.kind === 'stop');
      if (dayEvents.length < 2) continue;
      const base = Date.parse(day + 'T00:00:00');
      const raw = [];
      for (let i = 0; i < dayEvents.length - 1; i++) {
        const a = dayEvents[i], b = dayEvents[i + 1];
        const from = (Date.parse(a.t) - base) / 1000;
        const to = (Date.parse(b.t) - base) / 1000;
        if (to <= 0 || from >= 86400) continue;
        const kind = a.kind === 'start' ? 'run' : 'stop';
        const last = raw[raw.length - 1];
        // Coalesce touching segments of the same kind: a fragmented day would
        // otherwise emit tens of thousands of near-zero slivers.
        if (last && last.kind === kind && last.to >= from - 1) {
          last.to = Math.max(last.to, Math.min(to, 86400));
          if (kind === 'stop' && a.label) last.label = a.label;
        } else {
          raw.push({ kind, from, to: Math.min(to, 86400), label: kind === 'stop' ? (a.label || '') : '' });
        }
      }
      // ponytail: a day that fragments thousands of times cannot be drawn or
      // read. Keep the longest few and report how many were dropped.
      const MAX_SEGMENTS_PER_DAY = 400;
      let segs = raw, dropped = 0;
      if (raw.length > MAX_SEGMENTS_PER_DAY) {
        segs = raw.slice().sort((x, y) => (y.to - y.from) - (x.to - x.from)).slice(0, MAX_SEGMENTS_PER_DAY)
          .sort((x, y) => x.from - y.from);
        dropped = raw.length - segs.length;
      }
      gantt.push({ day, segs, dropped, run: d.run, stops: d.stops });
    }

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
      byReason: pareto,
      days: [...days.values()].sort((a, b) => b.day.localeCompare(a.day)),
      shifts, articles, sessions, counts,
      feeders: [...feeders.values()].sort((a, b) => b.sec - a.sec),
      hourly, designs,
      health: events.filter(e => e.kind === 'health'),
      stats, histogram, hourMatrix, feederMatrix, warp, throughput, gantt,
      weekday: weekdays,
      shiftTotals: [...shiftTotals.values()].filter(s => s.name && s.name !== '?').sort((a, b) => b.picks - a.picks),
      shiftCoverage: picks ? attributedPicks / picks : 0,
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
    const seen = list.filter(e => e.src === 'export' && Number.isFinite(e.picks));
    if (!seen.length) return { picks: 0, metres: 0 };
    // Reduced by hand: Math.max(...array) blows the stack on long archives.
    let minP = Infinity, maxP = -Infinity, minM = Infinity, maxM = -Infinity;
    for (const e of seen) {
      if (e.picks < minP) minP = e.picks;
      if (e.picks > maxP) maxP = e.picks;
      const m = Number.isFinite(e.length) ? e.length : 0;
      if (m < minM) minM = m;
      if (m > maxM) maxM = m;
    }
    return { picks: maxP - minP, metres: maxM - minM };
  }

  return { build };
})();
