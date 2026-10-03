'use strict';

/*
 * UI: renders the three views from the model. No state beyond `DATA` and the
 * current filter/tab, which live here.
 */

const UI = (() => {

  let DATA = null;          // { machine, model, binary }
  let tab = 'timeline';
  let filter = 'all';
  let search = '';
  let range = { from: '', to: '' };      // production date filter
  let shiftSel = new Set();
  const collapsed = new Set();

  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  const dayOf = t => t.slice(0, 10);
  const addDays = (day, n) => {
    const t = Date.parse(day + 'T00:00:00');
    return Number.isFinite(t) ? new Date(t + n * 86400000).toISOString().slice(0, 10) : '';
  };

  // ─── formatting ───
  // Formatting that never prints NaN or Invalid Date, whatever the data holds.
  // Resolved through the namespace at call time, so file load order can never
  // bite us. Dates render DD/MM/YYYY on a 24-hour clock throughout.
  const time = t => Decode.fmtTime(t);
  const date = t => Decode.fmtDate(t);
  const clock = t => Decode.fmtClock(t);
  const dateTime = t => Decode.fmtDateTime(t);
  const dayShort = v => Decode.fmtDayShort(v);
  const dayFull = v => Decode.fmtDayFull(v);
  const dayLabel = d => Decode.fmtDayLabel(d);

  function dur(s) {
    if (!Number.isFinite(s) || s <= 0) return '—';
    const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = Math.floor(s % 60);
    return h ? `${h}h ${String(m).padStart(2, '0')}m` : m ? `${m}m ${String(x).padStart(2, '0')}s` : `${x}s`;
  }
  const num = n => (Number.isFinite(n) ? n : 0).toLocaleString('en-GB', { maximumFractionDigits: 0 });
  const pct = x => (Number.isFinite(x) ? (x * 100).toFixed(1) : '0.0') + '%';

  // ─── event → category (used by filters and colours) ───
  const CATS = [
    { key: 'ready',    label: 'Machine Status', icon: '🟢' },
    { key: 'operator', label: 'Operator Sessions', icon: '👤' },
    { key: 'article',  label: 'Articles', icon: '🧾' },
    { key: 'cloth',    label: 'Cloth / Beams', icon: '📏' },
    { key: 'design',   label: 'Design / Style', icon: '🎨' },
    { key: 'yarn',     label: 'Yarn / Weft Setup', icon: '🧵' },
    { key: 'pick',     label: 'Pick Variation', icon: '🎯' },
    { key: 'setting',  label: 'Settings', icon: '⚙️' },
    { key: 'stop',     label: 'Stops', icon: '🛑' },
  ];
  function catOf(e) {
    if (e.kind === 'stop') return 'stop';
    if (e.kind === 'start') return 'ready';
    if (e.cat) return e.cat;
    if (e.kind === 'article') return 'article';
    if (e.kind === 'articleLog') return 'article';
    if (e.kind === 'design') return 'design';
    if (e.kind === 'yarn') return 'yarn';
    if (e.kind === 'pick') return 'pick';
    return 'setting';
  }

  // ─── shell ───
  function shell() {
    $('tabs').innerHTML = [
      ['timeline', 'Timeline'], ['production', 'Production'], ['machine', 'Machine'], ['diagnostics', 'Diagnostics'],
    ].map(([k, l]) => `<button class="tab${k === tab ? ' active' : ''}" data-tab="${k}">${l}</button>`).join('');
    $('tabs').querySelectorAll('.tab').forEach(b => b.onclick = () => { tab = b.dataset.tab; render(); });

    const m = DATA && DATA.model;
    $('filters').innerHTML = ['all', ...CATS.map(c => c.key)].map(k => {
      const c = CATS.find(x => x.key === k);
      const n = k === 'all' ? (m ? m.events.length : 0) : (m ? m.events.filter(e => catOf(e) === k).length : 0);
      return `<button class="chip${k === filter ? ' active' : ''}" data-cat="${k}">
        ${c ? c.icon + ' ' + c.label : '📋 All'} <i>${num(n)}</i></button>`;
    }).join('');
    $('filters').querySelectorAll('.chip').forEach(b => b.onclick = () => { filter = b.dataset.cat; render(); });
  }

  // Typing re-renders up to 1500 cards, so wait for a pause.
  let searchTimer = null, rangeTimer = null;
  function searchInput(value) {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { search = value; render(); }, 160);
  }
  function rangeChanged(patch) {
    Object.assign(range, patch);
    clearTimeout(rangeTimer);
    rangeTimer = setTimeout(rebuild, 200);
  }
  function preset(days) {
    if (!Number.isFinite(days)) return;
    const last = DATA && DATA.model.last ? dayOf(DATA.model.last) : null;
    if (!last) return;
    range = days === 0 ? { from: '', to: '' } : { from: addDays(last, -(days - 1)), to: last };
    rebuild();
  }
  function clearFilters() {
    const last = DATA && DATA.model.last ? dayOf(DATA.model.last) : null;
    range = last ? { from: addDays(last, -6), to: last } : { from: '', to: '' };
    shiftSel.clear();
    rebuild();
  }
  function rebuild() {
    DATA.model = Model.build(DATA.events, DATA.machine.designs, { ...range, shifts: [...shiftSel] });
    render();
  }
  function toggleShift(name) {
    shiftSel.has(name) ? shiftSel.delete(name) : shiftSel.add(name);
    rebuild();
  }
  // Every shift the machine stamped in this archive, in natural order.
  function availableShifts() {
    const found = new Set();
    for (const e of DATA.events) if (e.shift && e.shift !== '?') found.add(e.shift);
    return [...found].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }

  // A panel that can be folded away; state is remembered for the session.
  function panel(id, title, body, note) {
    const open = !collapsed.has(id);
    let content = '';
    if (open) {
      try { content = body || ''; }
      catch (err) {
        console.error(id, err);
        content = `<p class="panel-error"><b>${esc(title)} could not be shown</b><span>${esc((err && err.message) || String(err))}</span></p>`;
      }
    }
    return `<section class="panel${open ? '' : ' folded'}">
      <h2><button class="fold" data-fold="${id}" aria-expanded="${open}">${esc(title)}<span class="chev">${open ? '▾' : '▸'}</span></button>${note ? `<span class="small">${note}</span>` : ''}</h2>
      ${content}</section>`;
  }
  document.addEventListener('click', e => {
    const f = e.target.closest && e.target.closest('[data-fold]');
    if (f) {
      const id = f.dataset.fold;
      collapsed.has(id) ? collapsed.delete(id) : collapsed.add(id);
      render();
    }
  });

  // Click a table header to sort. Kept deliberately small: numbers, then text.
  let sortBy = null, sortDir = 1;
  function th(label, key) {
    const active = sortBy === key;
    return `<th data-sort="${key}" class="${active ? 'sorted ' + (sortDir > 0 ? 'asc' : 'desc') : ''}">${esc(label)}${active ? (sortDir > 0 ? ' ↑' : ' ↓') : ''}</th>`;
  }
  function rows(rowsData, cells, key) {
    const sorted = sortBy ? rowsData.slice().sort((a, b) => {
      const x = a[key], y = b[key];
      const n = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
      return n * sortDir;
    }) : rowsData;
    return sorted.map(cells).join('');
  }
  function sortToggle(key) {
    sortDir = sortBy === key ? -sortDir : 1;
    sortBy = key;
    render();
  }
  document.addEventListener('click', e => {
    const t = e.target.closest && e.target.closest('th[data-sort]');
    if (t) return sortToggle(t.dataset.sort);
    const p = e.target.closest && e.target.closest('[data-preset]');
    if (p) { preset(+p.dataset.preset); return; }
    const s = e.target.closest && e.target.closest('[data-shift]');
    if (s) return s.dataset.shift === '__all' ? (shiftSel.clear(), rebuild()) : toggleShift(s.dataset.shift);
    const c = e.target.closest && e.target.closest('[data-clear]');
    if (c) return clearFilters();
  });
  document.addEventListener('change', e => {
    if (e.target.id === 'range-from') rangeChanged({ from: e.target.value });
    if (e.target.id === 'range-to') rangeChanged({ to: e.target.value });
  });
  function setStats(m, machine) {
    $('stats').innerHTML = [
      ['Events', num(m.events.length)],
      ['Runs', num(m.runCount)],
      ['Stops', num(m.stopCount)],
      ['Efficiency', m.efficiency ? pct(m.efficiency) : '—'],
      ['Picks', num(m.picks)],
      ['Cloth', num(m.metres) + ' m'],
    ].map(([k, v]) => `<div class="stat"><span>${k}</span><b>${v}</b></div>`).join('');
    $('range').textContent = m.first ? `${date(m.first)} → ${date(m.last)} · ${dur(m.spanSec)}` : '';

    const f = machine.files || {};
    $('loaded').innerHTML = machine.serial
      ? `<b>${esc(machine.serial)}</b><small>${num(f.commserver)} logs · ${num(f.hmi)} terminal · ${num(f.btf)} binary</small>`
      : '';
  }

  // ─── timeline ───
  function renderTimeline(m) {
    const q = search.trim().toLowerCase();
    const text = e => ((e.title || e.label || e.name || '') + ' ' + (e.detail || '') + ' ' + (e.values || '')).toLowerCase();
    let list = m.events.filter(e => filter === 'all' || catOf(e) === filter);
    if (q) list = list.filter(e => text(e).includes(q));

    if (!list.length) return `<div class="empty">🔍<h3>Nothing matches</h3><p>Try another filter or search.</p></div>`;

    // ponytail: the newest N events are rendered; a 3-month CSF holds ~12k of
    // them and the DOM gets slow past that. Raise TIMELINE_CAP or filter down.
    const CAP = 1500;
    const shown = list.slice(-CAP);
    const hidden = list.length - shown.length;

    const byDay = new Map();
    for (const e of shown) {
      const d = e.t.slice(0, 10);
      if (!byDay.has(d)) byDay.set(d, []);
      byDay.get(d).push(e);
    }

    let html = hidden > 0
      ? `<div class="empty small">Showing the newest ${num(shown.length)} of ${num(list.length)} events — use a filter or search to narrow it down.</div>`
      : '';
    for (const [day, evs] of [...byDay.entries()].sort((a, b) => b[0].localeCompare(a[0]))) {
      html += `<div class="day"><div class="day-head">${dayLabel(day)} <span>${evs.length} events</span></div>`;
      for (const e of evs.slice().reverse()) html += card(e);
      html += `</div>`;
    }
    return html;
  }

  function card(e) {
    const cat = catOf(e);
    if (e.kind === 'yarn') return yarnCard(e);
    if (e.kind === 'pick') return pickCard(e);

    let title = e.title || e.label || e.kind;
    let detail = e.detail || '';
    if (e.kind === 'stop') {
      title = `Stop — ${e.label || e.reason || ''}`;
      const bits = [];
      if (e.detail) bits.push(esc(e.detail));
      if (e.channel) bits.push(`channel ${e.channel}`);
      if (e.sincePicks) bits.push(`${num(e.sincePicks)} picks`);
      if (e.mssg) bits.push(`code ${e.mssg}`);
      if (e.src === 'btf') bits.push('binary history');
      detail = bits.join(' · ');
    }
    if (e.kind === 'start') { title = 'Machine Started'; detail = ''; }
    if (e.kind === 'article') { title = `Article: ${e.title || ''}`; detail = ''; }
    if (e.kind === 'shift') { title = `Shift ${e.title || ''}`; detail = ''; }
    if (e.kind === 'power') { title = `Power ${e.title || ''}`; detail = ''; }

    return `<div class="card cat-${cat}">
      <div class="ico">${CATS.find(c => c.key === cat)?.icon || '•'}</div>
      <div class="body">
        <div class="title"><span class="badge">${cat}</span>${esc(title)}</div>
        ${detail ? `<div class="detail">${detail}</div>` : ''}
      </div>
      <div class="when"><b>${time(e.t)}</b><span>${date(e.t)}</span></div>
    </div>`;
  }

  function yarnCard(e) {
    const rows = e.channels.map(c => {
      const col = Decode.YARN_COLORS[c.col] || Decode.YARN_COLORS[0];
      const picks = c.picks != null ? ` <span class="tag">${c.picks} picks</span>` : '';
      return `<div class="yarn-row"><span class="dot" style="background:${col.hex}"></span>
        <span>Channel ${c.ch}${picks}</span><b>${col.name}</b></div>`;
    }).join('');
    const swatches = e.channels.map(c => {
      const col = Decode.YARN_COLORS[c.col] || Decode.YARN_COLORS[0];
      return `<i class="sw" style="background:${col.hex}" title="Channel ${c.ch} → ${col.name}"></i>`;
    }).join('');
    return `<div class="card cat-yarn">
      <div class="ico">🧵</div>
      <div class="body">
        <div class="title"><span class="badge">weft setup</span>${e.channels.length} channels configured</div>
        <div class="sw-row">${swatches}</div>
        <div class="yarn-grid">${rows}</div>
      </div>
      <div class="when"><b>${time(e.t)}</b><span>${date(e.t)}</span></div>
    </div>`;
  }

  function pickCard(e) {
    const vals = e.values || [];
    const chips = vals.map(v => `<span class="pv">${+(v / Decode.MM_PER_INCH).toFixed(1)}</span>`).join('<i>→</i>') + '<i>picks/inch</i>';
    return `<div class="card cat-pick">
      <div class="ico">🎯</div>
      <div class="body">
        <div class="title"><span class="badge">pick var</span>${vals.length > 1 ? `Pick variation — ${vals.length} densities` : 'Pick density set'}</div>
        <div class="pv-row">${chips}</div>
        <div class="detail">Raw: ${vals.map(v => +v.toFixed(1)).join(' · ')} picks/m${e.article ? ' · during ' + esc(e.article) : ''}</div>
      </div>
      <div class="when"><b>${time(e.t)}</b><span>${date(e.t)}</span></div>
    </div>`;
  }

  // ─── production ───
  function rangeBar(m) {
    const first = m.first ? dayOf(m.first) : '';
    const last = m.last ? dayOf(m.last) : '';
    const from = range.from || first, to = range.to || last;
    const days = from && to ? Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1 : 0;
    const filtered = range.from || range.to;
    const presetBtn = (label, days_, on) => `<button class="preset${on ? ' active' : ''}" data-preset="${days_}">${label}</button>`;
    const wholeOn = !filtered;
    return `<div class="rangebar">
      <span class="range-label">Period</span>
      <input type="date" id="range-from" value="${from}" min="${first}" max="${last}">
      <span class="dash">→</span>
      <input type="date" id="range-to" value="${to}" min="${first}" max="${last}">
      <span class="presets">
        ${presetBtn('Whole range', 0, wholeOn)}
        ${presetBtn('7 days', 7, range.to === last && range.from === addDays(last, -6))}
        ${presetBtn('30 days', 30, range.to === last && range.from === addDays(last, -29))}
        ${presetBtn('90 days', 90, range.to === last && range.from === addDays(last, -89))}
      </span>
      <span class="range-info">${days} days · ${num(m.stopCount)} stops · ${num(m.picks)} picks</span>
      ${filtered || shiftSel.size ? '<button class="preset clear" data-clear="1">Reset</button>' : ''}
    </div>${shiftChips()}`;
  }

  function shiftChips() {
    const all = availableShifts();
    if (all.length < 2) return '';
    const on = n => shiftSel.has(n);
    return `<div class="shiftbar">
      <span class="range-label">Shifts</span>
      <button class="preset${shiftSel.size ? '' : ' active'}" data-shift="__all">All</button>
      ${all.map(n => `<button class="preset${on(n) ? ' active' : ''}" data-shift="${esc(n)}">${esc(n)}</button>`).join('')}
      ${shiftSel.size ? `<span class="range-info">showing ${[...shiftSel].sort().join(', ')}</span>` : ''}
    </div>`;
  }

  function renderProduction(m, machine) {
    const total = m.runSec + m.byReason.reduce((s, r) => s + r.sec, 0);
    const kpis = [
      ['Machine time', dur(m.spanSec)],
      ['Running', dur(m.runSec)],
      ['Stopped', dur(total - m.runSec)],
      ['Efficiency', m.efficiency ? pct(m.efficiency) : '—'],
      ['Picks woven', num(m.picks)],
      ['Cloth woven', num(m.metres) + ' m'],
      ['Runs', num(m.runCount)],
      ['Stops', num(m.stopCount)],
      ['Binary stops', num(m.binaryStops)],
    ].map(([k, v]) => `<div class="kpi"><span>${k}</span><b>${v}</b></div>`).join('');

    const pareto = m.byReason;
    const bars = pareto.length ? paretoChart(pareto) : '<p class="empty">No stop data.</p>';

    const feeders = rows(m.feeders, f => `
      <tr><td><b>${esc(f.channel)}</b></td><td>${f.stops}</td><td>${dur(f.sec)}</td>
      <td>${(f.sec / f.stops / 60).toFixed(1)}m</td><td>${num(f.picks)}</td>
      <td class="small">${esc(Object.entries(f.reasons).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, v]) => `${k}×${v}`).join(', '))}</td></tr>`,
      'sec');

    const dayRows = m.days.filter(d => d.run || d.stops).slice(0, 60);
    const days = rows(dayRows, d => `
      <tr><td>${dayFull(d.day)}</td><td>${dur(d.run)}</td><td>${d.stops}</td><td>${num(d.picks)}</td><td>${num(Math.round(d.metres))}</td></tr>`, 'day');

    const articles = rows(m.articles.slice(-60), a => `
      <tr><td>${esc(a.name || '—')}</td><td>${dateTime(a.start)}</td><td>${dur(a.sec)}</td>
      <td>${num(a.picks)}</td><td>${num(Math.round(a.metres))}</td><td>${a.stops}</td></tr>`, 'start').split('<tr>').reverse().join('<tr>');

    const sessions = rows(m.sessions.slice(-40), s => `
      <tr><td>${dateTime(s.start)}</td><td>${s.end ? clock(s.end) : '—'}</td>
      <td>${s.sec == null ? 'open' : dur(s.sec)}</td><td class="mono">${esc((s.key || '').slice(0, 8))}</td></tr>`, 'start');

    const shiftRows = m.shiftTotals.map(s => `
      <tr><td><b>${esc(s.name)}</b></td><td>${pct(s.efficiency)}</td><td>${dur(s.run)}</td>
      <td>${dur(s.stop)}</td><td>${num(s.picks)}</td><td>${num(Math.round(s.metres))}</td>
      <td>${s.stops}</td><td>${num(Math.round(s.picksPerHour))}</td></tr>`).join('');

    const ranked = m.articles.filter(a => a.picks > 0).sort((a, b) => b.picks - a.picks);

    return `
      ${rangeBar(m)}
      ${warningBanner(machine)}
      ${panel('overview', 'Overview', `<div class="kpis">${kpis}</div>`)}
      ${binaryNote(machine)}
      ${panel('stats', 'Stop statistics', stopStats(m), 'how long stops last and how long the machine runs between them')}
      ${panel('pareto', 'Downtime by reason', bars || '<p class="empty">No stop data.</p>', 'bars show duration, the line shows the cumulative share')}
      ${panel('heat', 'Stops by hour of day', hourHeatmap(m), 'where in the day the problems cluster')}
      ${panel('weekday', 'Stops by weekday', weekdayChart(m))}
      ${panel('gantt', 'Run and stop timeline', ganttChart(m), 'green runs, red stops — a dashed day is a fragmented day')}
      ${panel('throughput', 'Output per hour', throughputChart(m))}
      ${panel('feeder', 'Stops per weft feeder', m.feeders.length
        ? `<table><thead><tr>${th('Channel', 'channel')}${th('Stops', 'stops')}${th('Downtime', 'sec')}<th>Avg</th>${th('Picks lost', 'picks')}<th>Top reasons</th></tr></thead><tbody>${feeders}</tbody></table>
           ${feederMatrix(m)}`
        : '<p class="empty">No channel-attributed stops in this export.</p>', 'click a header to sort')}
      ${panel('shifts', 'Shift comparison', shiftRows
        ? `<table><thead><tr>${th('Shift', 'name')}${th('Efficiency', 'efficiency')}${th('Running', 'run')}<th>Stopped</th>${th('Picks', 'picks')}${th('Metres', 'metres')}${th('Stops', 'stops')}${th('Picks/h', 'picksPerHour')}</tr></thead><tbody>${shiftRows}</tbody></table>
           <p class="small">${pct(m.shiftCoverage)} of woven picks carry a shift label; the rest predate the first recorded shift.</p>`
        : '<p class="empty">No shift information in this export.</p>')}
      ${panel('warp', 'Warp stops', warpPanel(m))}
      ${panel('articles', 'Articles', ranked.length
        ? articleRanking(ranked) + `<table><thead><tr>${th('Article', 'name')}${th('Start', 'start')}${th('Duration', 'sec')}${th('Running', 'runSec')}${th('Efficiency', 'efficiency')}${th('Picks', 'picks')}${th('Metres', 'metres')}${th('Stops', 'stops')}</tr></thead><tbody>${articles}</tbody></table>`
        : '<p class="empty">No articles in this period.</p>')}
      ${panel('designs', 'Design density sets', designTable(m.designs), 'pick variation from the Jacquard pattern')}
      ${panel('days', 'Production per day',
        `<table><thead><tr>${th('Day', 'day')}${th('Running', 'run')}${th('Stops', 'stops')}${th('Picks', 'picks')}${th('Metres', 'metres')}</tr></thead><tbody>${days}</tbody></table>`)}
      ${panel('sessions', 'Operator sessions',
        `<table><thead><tr>${th('Login', 'start')}<th>Logout</th>${th('Duration', 'sec')}<th>Session</th></tr></thead><tbody>${sessions}</tbody></table>`)}`;
  }

  // ─── the individual panels ───

  function stopStats(m) {
    const s = m.stats;
    if (!s.stops) return '<p class="empty">No stops in this period.</p>';
    const longest = s.longestStop
      ? `${esc(s.longestStop.label)} — ${dur(s.longestStop.sec)} (${dateTime(s.longestStop.t)})`
      : '—';
    const cards = [
      ['MTTR (mean stop)', dur(s.mttr)],
      ['Median stop', dur(s.medianStop)],
      ['95th percentile stop', dur(s.p95Stop)],
      ['MTBF (mean run)', dur(s.mtbf)],
      ['Mean run', dur(s.meanRun)],
      ['Longest run', dur(s.longestRun)],
      ['Picks per stop', num(s.picksPerStop)],
    ].map(([k, v]) => `<div class="kpi small"><span>${k}</span><b>${v}</b></div>`).join('');
    const max = Math.max(1, ...m.histogram.map(h => h.count));
    const bars = m.histogram.map(h => `
      <div class="bar-row">
        <span class="bar-label">${h.label}</span>
        <span class="bar-track"><i style="width:${(h.count / max * 100).toFixed(1)}%"></i></span>
        <span class="bar-val">${num(h.count)}</span>
      </div>`).join('');
    return `<div class="kpis">${cards}</div>
      <p class="small">Longest stop: ${longest}</p>
      <h3>Stop duration distribution</h3>${bars}`;
  }

  function hourHeatmap(m) {
    const { reasons, hours, cell, max } = m.hourMatrix;
    if (!reasons.length || !hours.some(h => h.stops)) return '<p class="empty">No stops in this period.</p>';
    const head = `<tr><th></th>${hours.map(h => `<th class="hr">${h.hour}</th>`).join('')}<th class="hr">all</th></tr>`;
    const body = reasons.map(r => {
      const cells = hours.map(h => {
        const v = cell(h.hour, r);
        const a = v ? 0.15 + 0.85 * (v / max) : 0;
        return `<td style="background:${v ? `rgba(239,68,68,${a.toFixed(2)})` : 'var(--surface2)'}" title="${h.hour}:00 · ${esc(r)} · ${v} stop${v === 1 ? '' : 's'}">${v || ''}</td>`;
      }).join('');
      const tot = hours.reduce((s, h) => s + cell(h.hour, r), 0);
      return `<tr><th class="rl">${esc(r)}</th>${cells}<td class="tot">${tot}</td></tr>`;
    }).join('');
    const foot = `<tr><th class="rl">all</th>${hours.map(h => `<td class="tot">${h.stops || ''}</td>`).join('')}<td class="tot">${num(hours.reduce((s, h) => s + h.stops, 0))}</td></tr>`;
    return `<table class="heat"><thead>${head}</thead><tbody>${body}${foot}</tbody></table>
      <p class="small">Darker means more stops. Hover any cell for the exact count.</p>`;
  }

  function weekdayChart(m) {
    const names = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const max = Math.max(1, ...m.weekday.map(w => w.stops));
    return `<div class="weekdays">${m.weekday.map(w => `
      <div class="wd">
        <span class="wd-bar" style="height:${(w.stops / max * 100).toFixed(1)}%"><i title="${w.stops} stops"></i></span>
        <b>${names[w.day]}</b><small>${w.stops} stops</small><small>${num(w.picks)} picks</small>
      </div>`).join('')}</div>`;
  }

  function ganttChart(m) {
    if (!m.gantt.length) return '<p class="empty">No run data in this period.</p>';
    const H = 16, gap = 5;
    // The model already coalesces and caps segments per day; 60 days is more
    // than anyone scrolls.
    const MAX_DAYS = 60;
    const shown = m.gantt.slice(-MAX_DAYS);
    const H2 = shown.length * (H + gap) + 26;
    const rows = shown.map((g, i) => {
      const y = i * (H + gap) + 18;
      const segs = g.segs.map(s => {
        const x = (s.from / 86400 * 1000).toFixed(1);
        const w = Math.max(0.6, ((s.to - s.from) / 86400 * 1000)).toFixed(1);
        const fill = s.kind === 'run' ? 'var(--green)' : 'var(--red)';
        return `<rect x="${x}" y="${y}" width="${w}" height="${H}" fill="${fill}" rx="1" opacity="${s.kind === 'run' ? 0.85 : 0.95}">
          <title>${dayFull(g.day)} ${fmtClock(s.from)}–${fmtClock(s.to)} · ${s.kind === 'run' ? 'running' : 'stopped: ' + esc(s.label)}</title></rect>`;
      }).join('');
      const dropped = g.dropped || 0;
      return `${segs}<text x="0" y="${y + H - 3}" fill="var(--muted)" font-size="7">${dayShort(g.day)}${dropped > 0 ? ' +' + dropped : ''}</text>`;
    }).join('');
    const grid = [0, 6, 12, 18, 24].map(h => `<line x1="${h / 24 * 1000}" x2="${h / 24 * 1000}" y1="10" y2="${H2 - 8}" stroke="var(--border)" stroke-width="0.5"/>
      <text x="${h / 24 * 1000 + 2}" y="9" fill="var(--muted)" font-size="7">${String(h).padStart(2, '0')}:00</text>`).join('');
    return `<svg viewBox="0 0 1000 ${H2}" class="chart gantt">${grid}${rows}</svg>` +
      (m.gantt.length > shown.length ? `<p class="small">Showing the newest ${shown.length} of ${m.gantt.length} days.</p>` : '');
  }
  const fmtClock = s => `${String(Math.floor(s / 3600) % 24).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}`;

  function throughputChart(m) {
    if (!m.throughput.length) return '<p class="empty">No production in this period.</p>';
    const W = 1000, H = 150, pad = 24;
    const n = m.throughput.length;
    const bw = Math.max(1.5, (W - pad * 2) / n);
    const maxP = Math.max(1, ...m.throughput.map(h => h.picksPerHour));
    const bars = m.throughput.map((h, i) => {
      const x = pad + i * bw;
      const bh = (h.picksPerHour / maxP) * (H - 40);
      const tip = `${dateTime(h.t)} · ${num(h.picksPerHour)} picks · ${num(Math.round(h.metresPerHour))} m · ${h.stops} stops`;
      return `<g><title>${esc(tip)}</title><rect x="${x.toFixed(2)}" y="${(H - 22 - bh).toFixed(2)}" width="${(bw - 0.6).toFixed(2)}" height="${Math.max(0.5, bh).toFixed(2)}" fill="var(--amber)" rx="1"></rect>
        <text x="${(x + bw / 2).toFixed(2)}" y="${(H - 12).toFixed(2)}" fill="var(--muted)" font-size="6" text-anchor="middle" transform="rotate(-60 ${(x + bw / 2).toFixed(2)} ${(H - 12).toFixed(2)})">${dayShort(h.t.slice(0, 10))}</text></g>`;
    }).join('');
    return `<svg viewBox="0 0 ${W} ${H}" class="chart">${bars}
      <text x="${pad}" y="10" fill="var(--muted)" font-size="8">picks per hour — peak ${num(maxP)}</text></svg>`;
  }

  function paretoChart(rows) {
    const W = 1000, H = 210, padL = 46, padR = 40, padB = 66, padT = 14;
    const n = rows.length;
    const maxSec = Math.max(1, ...rows.map(r => r.sec));
    const bw = (W - padL - padR) / n;
    const plotH = H - padB - padT;
    const bars = rows.map((r, i) => {
      const h = (r.sec / maxSec) * plotH;
      const x = padL + i * bw;
      const tip = `${esc(r.label)} · ${dur(r.sec)} · ${r.count} stops · ${pct(r.cumulative)} of downtime`;
      return `<g><title>${esc(tip)}</title>
        <rect x="${(x + bw * 0.15).toFixed(1)}" y="${(padT + plotH - h).toFixed(1)}" width="${(bw * 0.7).toFixed(1)}" height="${Math.max(0.5, h).toFixed(1)}" fill="var(--red)" opacity="0.8" rx="2"></rect>
        <text x="${(x + bw / 2).toFixed(1)}" y="${H - padB + 12}" fill="var(--muted)" font-size="8" text-anchor="end" transform="rotate(-40 ${(x + bw / 2).toFixed(1)} ${H - padB + 12})">${esc(r.label)}</text>
        <text x="${(x + bw / 2).toFixed(1)}" y="${(padT + plotH - h - 3).toFixed(1)}" fill="var(--dim)" font-size="7" text-anchor="middle">${dur(r.sec)}</text>
      </g>`;
    }).join('');
    const pts = rows.map((r, i) => `${(padL + i * bw + bw / 2).toFixed(1)},${(padT + plotH - r.cumulative * plotH).toFixed(1)}`).join(' ');
    const line = `<polyline points="${pts}" fill="none" stroke="var(--amber)" stroke-width="1.5"></polyline>` +
      rows.map((r, i) => `<circle cx="${(padL + i * bw + bw / 2).toFixed(1)}" cy="${(padT + plotH - r.cumulative * plotH).toFixed(1)}" r="2.5" fill="var(--amber)"><title>${esc(r.label)}: ${pct(r.cumulative)} cumulative</title></circle>`).join('');
    const grid = [0, 0.25, 0.5, 0.75, 1].map(f => {
      const y = padT + plotH - f * plotH;
      return `<line x1="${padL}" x2="${W - padR}" y1="${y}" y2="${y}" stroke="var(--border)" stroke-width="0.5"/>
        <text x="${padL - 6}" y="${y + 3}" text-anchor="end" fill="var(--muted)" font-size="8">${f * 100}%</text>`;
    }).join('');
    return `<svg viewBox="0 0 ${W} ${H}" class="chart pareto">${grid}${bars}${line}</svg>`;
  }

  function feederMatrix(m) {
    const { reasons, max, cell } = m.feederMatrix;
    const channels = m.feederMatrix.channels;
    if (!channels.length || !reasons.length) return '';
    const head = `<tr><th class="rl"></th>${reasons.slice(0, 8).map(r => `<th class="rl2">${esc(r)}</th>`).join('')}</tr>`;
    const body = channels.map(ch => `<tr><th class="rl">ch ${esc(ch)}</th>` +
      reasons.slice(0, 8).map(r => {
        const v = cell(ch, r);
        const a = v ? 0.15 + 0.85 * (v / max) : 0;
        return `<td style="background:${v ? `rgba(239,68,68,${a.toFixed(2)})` : 'var(--surface2)'}" title="Channel ${esc(ch)} · ${esc(r)} · ${v}">${v || ''}</td>`;
      }).join('') + '</tr>').join('');
    return `<h3>Which feeder fails for what</h3>
      <table class="heat small"><thead>${head}</thead><tbody>${body}</tbody></table>`;
  }

  function warpPanel(m) {
    const w = m.warp;
    const items = [['Beam change', w.beam], ['Waste yarn left', w.wasteLeft], ['Waste yarn right', w.wasteRight], ['Other warp', w.other]];
    if (!items.some(([, v]) => v)) return '<p class="empty">No warp stops in this period.</p>';
    const total = items.reduce((a, [, v]) => a + v, 0);
    return `<div class="kpis">${items.map(([k, v]) => `
        <div class="kpi small"><span>${k}</span><b>${num(v)}</b><small>${pct(v / total)}</small></div>`).join('')}
        <div class="kpi small"><span>Total warp downtime</span><b>${dur(w.sec)}</b></div></div>
      <p class="small">Beam changes are planned work; waste-yarn stops are faults. ${pct(w.wasteLeft + w.wasteRight)} of warp stops are waste yarn.</p>`;
  }

  function articleRanking(ranked) {
    const top = ranked.slice(0, 10);
    const max = Math.max(1, ...top.map(a => a.picks));
    return `<h3>Top articles by output</h3><div class="rank">${top.map(a => `
      <div class="rank-row"><span class="rank-label">${esc(a.name || '—')}</span>
        <span class="bar-track"><i style="width:${(a.picks / max * 100).toFixed(1)}%"></i></span>
        <span class="bar-val">${num(a.picks)} · ${pct(a.efficiency)}</span></div>`).join('')}</div>`;
  }

  // Hand-drawn SVG: one bar per hour of running time, dots for stop hours.
  function hourlyChart(hours) {
    if (!hours.length) return '<p class="empty">Not enough production data.</p>';
    const W = 1000, H = 160, pad = 22;
    const n = hours.length;
    const bw = Math.max(1.5, (W - pad * 2) / n);
    const bars = hours.map((h, i) => {
      const x = pad + i * bw;
      const hh = Math.min(60, h.run / 60);
      const bh = (hh / 60) * (H - 30);
      const colour = h.efficiency >= 0.8 ? 'var(--green)' : h.efficiency >= 0.5 ? 'var(--amber)' : 'var(--red)';
      const tip = `${dateTime(h.t)} · ${hh.toFixed(0)} min running · ${h.stops} stops · ${num(h.picks)} picks`;
      return `<g><title>${esc(tip)}</title>
        <rect x="${x.toFixed(2)}" y="${(H - 20 - bh).toFixed(2)}" width="${(bw - 0.6).toFixed(2)}" height="${Math.max(0.5, bh).toFixed(2)}" fill="${colour}" rx="1">
        </rect>${h.stops ? `<circle cx="${(x + bw / 2).toFixed(2)}" cy="${(H - 22 - bh).toFixed(2)}" r="1.1" fill="var(--text)"></circle>` : ''}</g>`;
    }).join('');
    const ticks = [0, 20, 40, 60].map(v => {
      const y = H - 20 - (v / 60) * (H - 30);
      return `<line x1="${pad}" x2="${W - pad}" y1="${y}" y2="${y}" stroke="var(--border)" stroke-width="0.5"></line>
              <text x="${pad - 5}" y="${y + 3}" text-anchor="end" fill="var(--muted)" font-size="9">${v}m</text>`;
    }).join('');
    const span = `${dayShort(hours[0].t.slice(0, 10))} → ${dayShort(hours[n - 1].t.slice(0, 10))}`;
    return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Efficiency by hour">${ticks}${bars}
      <text x="${pad}" y="${H - 6}" fill="var(--muted)" font-size="9">${span}</text></svg>`;
  }

  function designTable(designs) {
    if (!designs.length) return '<p class="empty">No PickDensity table found in this CSF.</p>';
    return `<table><thead><tr><th>Design</th><th>Densities</th><th>Unit</th><th>Lines</th><th>Speed set</th><th>Jacquard</th></tr></thead><tbody>` +
      designs.map(d => `<tr>
        <td>${esc(d.design)}</td>
        <td>${d.densities.map(v => `<span class="pv">${v}</span>`).join(' ')}</td>
        <td class="small">${esc(d.unit)}</td><td>${d.lines}</td>
        <td>${d.speed.length ? d.speed.join(' / ') : '—'}</td>
        <td>${d.jacquard ? 'yes' : 'no'}</td></tr>`).join('') + '</tbody></table>';
  }

  function binaryNote(machine) {
    const b = machine.binary;
    if (!b || !b.records) return '';
    return `<section class="panel note"><h2>Binary history</h2>
      <p>Decoded ${num(b.records)} records from ${num(b.files || 0)} <code>history/startstop/*.btf</code> files
      (big-endian reason codes, ${Decode.BTF.TICKS_PER_SEC} ticks/s clock).
      ${b.solved ? 'Timestamps resolved against the export/text timeline.' : 'Could not resolve the clock for this CSF.'}</p></section>`;
  }

  // ─── machine ───
  function renderMachine(machine, model) {
    machine = machine || {};
    const id = machine.identity || {};
    const mf = machine.files || {};
    const info = [
      ['Serial', machine.serial || '—'], ['CSF file', machine.name],
      ['Created', machine.identity.created || '—'], ['Software', id.software || id.version || '—'],
      ['Machine', id.machine || '—'], ['Qt', id.qt || '—'], ['Buildroot', id.buildroot || '—'],
      ['Defconfig', id.defconfig || '—'], ['Kernel', id.kernel || '—'], ['Commit', id.commit || '—'],
    ].map(([k, v]) => `<tr><th>${k}</th><td class="mono">${esc(v)}</td></tr>`).join('');

    const groups = new Map();
    for (const s of (Array.isArray(machine.settings) ? machine.settings : [])) {
      if (!s || typeof s !== 'object') continue;
      if (!groups.has(s.group)) groups.set(s.group, []);
      groups.get(s.group).push(s);
    }
    let settings = '';
    for (const [g, items] of groups) {
      settings += `<details><summary>${esc(g || 'other')} — ${items.length} settings</summary><table><tbody>` +
        items.filter(s => s && typeof s === 'object').map(s => `<tr><td>${esc(s.code ?? '—')}</td><td>${esc(s.name || '—')}</td><td>${esc(s.enumName || s.value || '—')}</td></tr>`).join('') +
        `</tbody></table></details>`;
    }

    const parts = (Array.isArray(machine.spareParts) && machine.spareParts.length)
      ? `<table><tbody>${machine.spareParts.filter(Boolean).map(p => `<tr><td class="mono">${esc(p.id)}</td><td>${esc(p.name)}</td></tr>`).join('')}</tbody></table>`
      : '<p class="empty">None.</p>';

    const regimes = (Array.isArray(machine.shiftRegimes) && machine.shiftRegimes.length)
      ? `<table><tbody>${machine.shiftRegimes.filter(Boolean).map(r => `<tr><td>${esc(r.uid)}</td><td>${esc(r.day)}</td><td>${esc(r.hours)}</td></tr>`).join('')}</tbody></table>`
      : '<p class="empty">None.</p>';

    const mem = machine.memory;
    const memory = mem
      ? `<table class="kv"><tbody>
          <tr><th>Sampled</th><td>${num(mem.samples)} points × ${num(mem.columns)} columns</td></tr>
          <tr><th>Average memory used</th><td>${mem.avgUsed.toFixed(1)}%</td></tr>
          <tr><th>Peak memory used</th><td>${mem.maxUsed.toFixed(1)}%</td></tr>
          <tr><th>Lowest free</th><td>${num(Math.round(mem.minFreeMB))} MB</td></tr>
        </tbody></table>
        <p class="small">One trace is sampled — each CSF carries dozens of 19 MB memory logs.</p>`
      : '<p class="empty">No memory trace in this CSF.</p>';

    const health = model.health.length
      ? `<table><thead><tr><th>When</th><th>Level</th><th>Event</th><th>Detail</th></tr></thead><tbody>` +
        model.health.slice(0, 40).map(h => `<tr><td class="mono">${dateTime(h.t)}</td>
          <td class="small">${esc(h.level)}</td><td>${esc(h.title)}</td><td class="small">${esc(h.detail)}</td></tr>`).join('') +
        '</tbody></table>'
      : '<p class="empty">No kernel faults, OOMs or thermal events in the kernel log.</p>';

    return `
      ${warningBanner(machine)}
      <section class="panel"><h2>Identity</h2><table class="kv"><tbody>${info}</tbody></table>
        <p class="small">${num(model.events.length)} events · ${num(mf.commserver)} commserver logs ·
        ${num(mf.hmi)} terminal logs · ${num(mf.btf)} binary history files ·
        ${num(mf.pattern)} pattern records</p></section>
      <section class="panel"><h2>Machine health</h2>
        <div class="split">${health}<div>${memory}</div></div></section>
      <section class="panel"><h2>Settings dictionary <span class="small">${machine.settings.length} items</span></h2>${settings || '<p class="empty">None.</p>'}</section>
      <section class="panel"><h2>Shift regimes</h2>${regimes}</section>
      <section class="panel"><h2>Spare parts</h2>${parts}</section>`;
  }

  // Anything that failed to decode is reported, never swallowed silently.
  function warningBanner(machine) {
    const w = (machine && Array.isArray(machine.warnings)) ? machine.warnings.filter(x => x && x.part) : [];
    if (!w.length) return '';
    const groups = new Map();
    for (const x of w) groups.set(x.part, x.message);
    return `<section class="panel warn">
      <h2>Partly decoded <span class="small">${groups.size} part${groups.size === 1 ? '' : 's'} could not be read — everything else is complete</span></h2>
      <ul>${[...groups].map(([part, msg]) => `<li><b>${esc(part)}</b><span>${esc(msg)}</span></li>`).join('')}</ul>
    </section>`;
  }

  // ─── diagnostics: what the binary history contains ───
  function renderDiagnostics(m, machine) {
    machine = machine || {};
    const b = machine.binary || {};
    const f = machine.files || {};
    const n = v => num(typeof v === 'number' ? v : undefined);
    const rows = [
      ['history/startstop', n(f.btf), n(b.records), 'stop reason codes decoded (big-endian mssg_nr), clock 3906.25 ticks/s'],
      ['history/pattern', n(f.pattern), (Array.isArray(machine.designs) ? machine.designs : []).length, 'design index tables decoded — PickDensity, Speed, Color'],
      ['history/hour', '—', 'not decoded', 'framing and clock known; field semantics unproven, so not shown as numbers'],
      ['history/fillingstop', '—', 'not decoded', 'needs the same field mapping as history/hour'],
      ['history/insertionlog', '—', 'not decoded', 'per-pick insertion log — richest dataset, largest effort'],
      ['history/temperature, drives', '—', 'not decoded', 'sensor traces; no ground truth to validate field names'],
      ['history/message, othermessage', '—', 'not decoded', 'alarm text is not stored as plaintext'],
      ['history/useractions (.dpf)', '—', 'not decoded', 'operator action names are binary'],
    ];
    return `
      <section class="panel"><h2>Binary history in this CSF</h2>
        <table><thead><tr><th>Source</th><th>Files</th><th>Records</th><th>State</th></tr></thead><tbody>` +
        rows.map(r => `<tr><td class="mono">${esc(r[0])}</td><td>${esc(String(r[1]))}</td>
          <td>${esc(String(r[2]))}</td><td class="small">${esc(r[3])}</td></tr>`).join('') +        `</tbody></table>
        <p class="small">Decoded fields are validated against the production export; nothing is guessed.</p></section>
      <section class="panel"><h2>Decoded density sets</h2>${designTable(m.designs)}</section>`;
  }

  // ─── export ───
  function download(name, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    a.click();
    URL.revokeObjectURL(url);
  }

  function exportCsv() {
    if (!DATA) return;
    const rows = [['timestamp', 'kind', 'category', 'title', 'detail', 'mssg', 'channel', 'picks', 'metres', 'shift', 'source']];
    for (const e of DATA.model.events) {
      rows.push([dateTime(e.t), e.kind, catOf(e), e.title || e.label || '', (e.detail || '').replace(/<[^>]+>/g, ''),
        e.mssg || '', e.channel || '', e.picks || '', e.length || '', e.shift || '', e.src || '']);
    }
    download(`${DATA.machine.serial || 'csf'}-events.csv`, rows.map(r => r.join(',')).join('\n'), 'text/csv');
  }

  // ─── render ───
  const VIEWS = ['timeline', 'production', 'machine', 'diagnostics'];

  // A panel that renders must never take the view down with it: if one throws,
  // show the failure in place and keep every other panel.
  function safe(label, fn, emptyText) {
    try {
      const html = fn();
      return html || `<p class="empty">${esc(emptyText || 'Nothing to show.')}</p>`;
    } catch (err) {
      console.error(label, err);
      return `<p class="panel-error"><b>${esc(label)} could not be shown</b><span>${esc((err && err.message) || String(err))}</span></p>`;
    }
  }

  function render() {
    try { shell(); } catch (err) { console.error('shell', err); }
    const m = DATA.model;
    $('export').disabled = false;
    $('stats').style.display = '';
    try { setStats(m, DATA.machine); } catch (err) { console.error('stats', err); }
    $('search').style.display = tab === 'timeline' ? '' : 'none';
    $('filters').style.display = tab === 'timeline' ? '' : 'none';
    for (const v of VIEWS) $('view-' + v).style.display = v === tab ? '' : 'none';
    try {
      if (tab === 'timeline') $('view-timeline').innerHTML = safe('Timeline', () => renderTimeline(m), 'No events in this period.');
      if (tab === 'production') $('view-production').innerHTML = safe('Production', () => renderProduction(m, DATA.machine), 'Nothing to show.');
      if (tab === 'machine') $('view-machine').innerHTML = safe('Machine', () => renderMachine(DATA.machine, m), 'Nothing to show.');
      if (tab === 'diagnostics') $('view-diagnostics').innerHTML = safe('Diagnostics', () => renderDiagnostics(m, DATA.machine), 'Nothing to show.');
    } catch (err) {
      console.error('view', err);
    }
  }

  function reset(message) {
    DATA = null;
    $('empty').style.display = '';
    $('empty-detail').textContent = message || '';
    $('loaded').innerHTML = '';
    $('export').disabled = true;
    for (const id of ['view-timeline', 'view-production', 'view-machine', 'view-diagnostics', 'stats', 'range', 'filters', 'search']) $(id).style.display = 'none';
  }

  function set(data) {
    DATA = data;
    tab = 'timeline'; filter = 'all'; search = '';
    $('search').value = '';
    $('empty').style.display = 'none';
    // Open on the last week: a month of events is unreadable, and the presets
    // make widening it one click.
    const last = DATA.model.last ? dayOf(DATA.model.last) : null;
    range = last ? { from: addDays(last, -6), to: last } : { from: '', to: '' };
    shiftSel = new Set();
    rebuild();
  }

  async function loadFile(file) {
    reset(`Decoding ${file.name} …`);
    progress(true, 'Opening CSF');
    try {
      const res = await Csf.load(file, (label, f) => progress(true, label, f));
      res.machine.binary = res.binary;
      res.model = Model.build(res.events, res.machine.designs);
      progress(false);
      set(res);
    } catch (err) {
      console.error(err);
      progress(false);
      reset('Could not read this file: ' + err.message);
    }
  }

  function progress(show, label, f) {
    $('progress').style.display = show ? '' : 'none';
    if (label) $('progress-label').textContent = label;
    if (f != null) $('progress-bar').style.width = Math.round(f * 100) + '%';
  }

  function setTab(name) {
    if (!VIEWS.includes(name)) return;
    tab = name;
    render();
  }

  return { render, set, setTab, loadFile, reset, exportCsv, searchInput, get data() { return DATA; } };
})();
