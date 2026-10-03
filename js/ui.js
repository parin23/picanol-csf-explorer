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

  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

  // ─── formatting ───
  const time = t => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const date = t => new Date(t).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  const dayLabel = d => new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  function dur(s) {
    if (!Number.isFinite(s) || s <= 0) return '—';
    const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = Math.floor(s % 60);
    return h ? `${h}h ${String(m).padStart(2, '0')}m` : m ? `${m}m ${String(x).padStart(2, '0')}s` : `${x}s`;
  }
  const num = n => (Number.isFinite(n) ? n : 0).toLocaleString('en-GB', { maximumFractionDigits: 0 });
  const pct = x => (x * 100).toFixed(1) + '%';

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
  let searchTimer = null;
  function searchInput(value) {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { search = value; render(); }, 160);
  }

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
    if (t) sortToggle(t.dataset.sort);
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

    const max = Math.max(1, ...m.byReason.map(r => r.sec));
    const bars = m.byReason.map(r => `
      <div class="bar-row">
        <span class="bar-label">${esc(r.label)}</span>
        <span class="bar-track"><i style="width:${(r.sec / max * 100).toFixed(1)}%"></i></span>
        <span class="bar-val">${dur(r.sec)} · ${r.count}×</span>
      </div>`).join('');

    const feeders = rows(m.feeders, f => `
      <tr><td><b>${esc(f.channel)}</b></td><td>${f.stops}</td><td>${dur(f.sec)}</td>
      <td>${(f.sec / f.stops / 60).toFixed(1)}m</td><td>${num(f.picks)}</td>
      <td class="small">${esc(Object.entries(f.reasons).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, v]) => `${k}×${v}`).join(', '))}</td></tr>`,
      'sec');

    const dayRows = m.days.filter(d => d.run || d.stops).slice(0, 60);
    const days = rows(dayRows, d => `
      <tr><td>${d.day}</td><td>${dur(d.run)}</td><td>${d.stops}</td><td>${num(d.picks)}</td><td>${num(Math.round(d.metres))}</td></tr>`, 'day');

    const shifts = rows(m.shifts.slice(-60), s => `
      <tr><td>${esc(s.name)}</td><td>${s.start.slice(0, 16).replace('T', ' ')}</td><td>${dur(s.run)}</td>
      <td>${num(s.picks)}</td><td>${num(Math.round(s.metres))}</td><td>${s.stops}</td></tr>`, 'start');

    const articles = rows(m.articles.slice(-60), a => `
      <tr><td>${esc(a.name || '—')}</td><td>${a.start.slice(0, 16).replace('T', ' ')}</td><td>${dur(a.sec)}</td>
      <td>${num(a.picks)}</td><td>${num(Math.round(a.metres))}</td><td>${a.stops}</td></tr>`, 'start').split('<tr>').reverse().join('<tr>');

    const sessions = rows(m.sessions.slice(-40), s => `
      <tr><td>${s.start.slice(0, 16).replace('T', ' ')}</td><td>${s.end ? s.end.slice(11, 16) : '—'}</td>
      <td>${s.sec == null ? 'open' : dur(s.sec)}</td><td class="mono">${esc((s.key || '').slice(0, 8))}</td></tr>`, 'start');

    return `
      <section class="panel"><h2>Overview</h2><div class="kpis">${kpis}</div></section>
      ${binaryNote(machine)}
      <section class="panel"><h2>Efficiency by hour</h2>${hourlyChart(m.hourly)}
        <p class="small">Bars show running minutes in each hour. Dots mark hours with stops.</p></section>
      <section class="panel"><h2>Downtime by reason</h2>${bars || '<p class="empty">No stop data.</p>'}</section>
      <section class="panel"><h2>Stops per weft feeder</h2>
        ${m.feeders.length ? `<table><thead><tr>${th('Channel', 'channel')}${th('Stops', 'stops')}${th('Downtime', 'sec')}<th>Avg</th>${th('Picks lost', 'picks')}<th>Top reasons</th></tr></thead><tbody>${feeders}</tbody></table>`
                  : '<p class="empty">No channel-attributed stops in this export.</p>'}
        <p class="small">Stops without a channel (beam, hand, bobbin) are not listed here. Click a header to sort.</p></section>
      <section class="panel"><h2>Design density sets <span class="small">pick variation from the Jacquard pattern</span></h2>
        ${designTable(m.designs)}</section>
      <section class="panel"><h2>Production per day</h2>
        <table><thead><tr>${th('Day', 'day')}${th('Running', 'run')}${th('Stops', 'stops')}${th('Picks', 'picks')}${th('Metres', 'metres')}</tr></thead><tbody>${days}</tbody></table></section>
      <section class="panel"><h2>Shifts</h2>
        <table><thead><tr>${th('Shift', 'name')}${th('Start', 'start')}${th('Running', 'run')}${th('Picks', 'picks')}${th('Metres', 'metres')}${th('Stops', 'stops')}</tr></thead><tbody>${shifts}</tbody></table></section>
      <section class="panel"><h2>Articles</h2>
        <table><thead><tr>${th('Article', 'name')}${th('Start', 'start')}${th('Duration', 'sec')}${th('Picks', 'picks')}${th('Metres', 'metres')}${th('Stops', 'stops')}</tr></thead><tbody>${articles}</tbody></table></section>
      <section class="panel"><h2>Operator sessions</h2>
        <table><thead><tr>${th('Login', 'start')}<th>Logout</th>${th('Duration', 'sec')}<th>Session</th></tr></thead><tbody>${sessions}</tbody></table></section>`;
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
      const tip = `${h.t.slice(0, 13)} · ${hh.toFixed(0)} min running · ${h.stops} stops · ${num(h.picks)} picks`;
      return `<g><title>${esc(tip)}</title>
        <rect x="${x.toFixed(2)}" y="${(H - 20 - bh).toFixed(2)}" width="${(bw - 0.6).toFixed(2)}" height="${Math.max(0.5, bh).toFixed(2)}" fill="${colour}" rx="1">
        </rect>${h.stops ? `<circle cx="${(x + bw / 2).toFixed(2)}" cy="${(H - 22 - bh).toFixed(2)}" r="1.1" fill="var(--text)"></circle>` : ''}</g>`;
    }).join('');
    const ticks = [0, 20, 40, 60].map(v => {
      const y = H - 20 - (v / 60) * (H - 30);
      return `<line x1="${pad}" x2="${W - pad}" y1="${y}" y2="${y}" stroke="var(--border)" stroke-width="0.5"></line>
              <text x="${pad - 5}" y="${y + 3}" text-anchor="end" fill="var(--muted)" font-size="9">${v}m</text>`;
    }).join('');
    const span = `${hours[0].t.slice(5, 10)} → ${hours[n - 1].t.slice(5, 10)}`;
    return `<svg viewBox="0 0 ${W} ${H}" class="chart" preserveAspectRatio="none" role="img" aria-label="Efficiency by hour">${ticks}${bars}
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
    const id = machine.identity || {};
    const info = [
      ['Serial', machine.serial || '—'], ['CSF file', machine.name],
      ['Created', machine.identity.created || '—'], ['Software', id.software || id.version || '—'],
      ['Machine', id.machine || '—'], ['Qt', id.qt || '—'], ['Buildroot', id.buildroot || '—'],
      ['Defconfig', id.defconfig || '—'], ['Kernel', id.kernel || '—'], ['Commit', id.commit || '—'],
    ].map(([k, v]) => `<tr><th>${k}</th><td class="mono">${esc(v)}</td></tr>`).join('');

    const groups = new Map();
    for (const s of machine.settings) {
      if (!groups.has(s.group)) groups.set(s.group, []);
      groups.get(s.group).push(s);
    }
    let settings = '';
    for (const [g, items] of groups) {
      settings += `<details><summary>${esc(g || 'other')} — ${items.length} settings</summary><table><tbody>` +
        items.map(s => `<tr><td>${s.code}</td><td>${esc(s.name)}</td><td>${esc(s.enumName || s.value)}</td></tr>`).join('') +
        `</tbody></table></details>`;
    }

    const parts = machine.spareParts.length
      ? `<table><tbody>${machine.spareParts.map(p => `<tr><td class="mono">${esc(p.id)}</td><td>${esc(p.name)}</td></tr>`).join('')}</tbody></table>`
      : '<p class="empty">None.</p>';

    const regimes = machine.shiftRegimes.length
      ? `<table><tbody>${machine.shiftRegimes.map(r => `<tr><td>${esc(r.uid)}</td><td>${esc(r.day)}</td><td>${esc(r.hours)}</td></tr>`).join('')}</tbody></table>`
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
        model.health.slice(0, 40).map(h => `<tr><td class="mono">${h.t.slice(0, 16).replace('T', ' ')}</td>
          <td class="small">${esc(h.level)}</td><td>${esc(h.title)}</td><td class="small">${esc(h.detail)}</td></tr>`).join('') +
        '</tbody></table>'
      : '<p class="empty">No kernel faults, OOMs or thermal events in the kernel log.</p>';

    return `
      <section class="panel"><h2>Identity</h2><table class="kv"><tbody>${info}</tbody></table>
        <p class="small">${num(model.events.length)} events · ${num(machine.files.commserver)} commserver logs ·
        ${num(machine.files.hmi)} terminal logs · ${num(machine.files.btf)} binary history files ·
        ${num(machine.files.pattern)} pattern records</p></section>
      <section class="panel"><h2>Machine health</h2>
        <div class="split">${health}<div>${memory}</div></div></section>
      <section class="panel"><h2>Settings dictionary <span class="small">${machine.settings.length} items</span></h2>${settings || '<p class="empty">None.</p>'}</section>
      <section class="panel"><h2>Shift regimes</h2>${regimes}</section>
      <section class="panel"><h2>Spare parts</h2>${parts}</section>`;
  }

  // ─── diagnostics: what the binary history contains ───
  function renderDiagnostics(m, machine) {
    const b = machine.binary || {};
    const f = machine.files || {};
    const n = v => num(typeof v === 'number' ? v : undefined);
    const rows = [
      ['history/startstop', n(f.btf), n(b.records), 'stop reason codes decoded (big-endian mssg_nr), clock 3906.25 ticks/s'],
      ['history/pattern', n(f.pattern), (machine.designs || []).length, 'design index tables decoded — PickDensity, Speed, Color'],
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
      rows.push([e.t, e.kind, catOf(e), e.title || e.label || '', (e.detail || '').replace(/<[^>]+>/g, ''),
        e.mssg || '', e.channel || '', e.picks || '', e.length || '', e.shift || '', e.src || '']);
    }
    download(`${DATA.machine.serial || 'csf'}-events.csv`, rows.map(r => r.join(',')).join('\n'), 'text/csv');
  }

  // ─── render ───
  const VIEWS = ['timeline', 'production', 'machine', 'diagnostics'];

  function render() {
    shell();
    const m = DATA.model;
    $('export').disabled = false;
    $('stats').style.display = '';
    setStats(m, DATA.machine);
    $('search').style.display = tab === 'timeline' ? '' : 'none';
    $('filters').style.display = tab === 'timeline' ? '' : 'none';
    for (const v of VIEWS) $('view-' + v).style.display = v === tab ? '' : 'none';
    if (tab === 'timeline') $('view-timeline').innerHTML = renderTimeline(m);
    if (tab === 'production') $('view-production').innerHTML = renderProduction(m, DATA.machine);
    if (tab === 'machine') $('view-machine').innerHTML = renderMachine(DATA.machine, m);
    if (tab === 'diagnostics') $('view-diagnostics').innerHTML = renderDiagnostics(m, DATA.machine);
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
    render();
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
