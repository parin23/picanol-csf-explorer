'use strict';

/*
 * Decoders: one function per CSF part. Each turns a part into flat events
 * pushed onto `out`. Nothing here knows about the DOM.
 *
 * Event shape: { t: ISO string, kind, src, ... }
 *   kind: start stop article shift power operator design setting pick yarn
 */

// ─── Yarn channel colour palette (ISYS channel colour id -> name + swatch) ───
const YARN_COLORS = {
  0:  { name: 'Not Set',  hex: '#374151' },
  1:  { name: 'Colour 1', hex: '#ef4444' },
  2:  { name: 'Colour 2', hex: '#3b82f6' },
  3:  { name: 'Colour 3', hex: '#10b981' },
  4:  { name: 'Colour 4', hex: '#f59e0b' },
  5:  { name: 'Colour 5', hex: '#a78bfa' },
  6:  { name: 'Colour 6', hex: '#06b6d4' },
  7:  { name: 'Colour 7', hex: '#f97316' },
  8:  { name: 'Colour 8', hex: '#ec4899' },
  9:  { name: 'Colour 9', hex: '#84cc16' },
  10: { name: 'Colour 10', hex: '#fbbf24' },
  11: { name: 'Colour 11', hex: '#e879f9' },
  12: { name: 'Colour 12', hex: '#67e8f9' },
  13: { name: 'Colour 13', hex: '#a3e635' },
  14: { name: 'Colour 14', hex: '#fb7185' },
  15: { name: 'Colour 15', hex: '#c084fc' },
  16: { name: 'Disabled', hex: '#1f2937' },
};

// ─── Stop reason codes (mssg_nr). Decoded big-endian from the .btf history
// and present verbatim in export/export_*.xml. ───
const STOP_REASONS = {
  50017: 'Weft change',        50019: 'Weft change',
  50207: 'Manual stop',        50956: 'Other',        50967: 'Bobbin',
  60002: 'Beam change',        60007: 'Waste yarn left', 60008: 'Waste yarn right',
  60915: 'FD anti-deux',       60917: 'FD not taken', 60918: 'FD left gripper',
  60919: 'FD after transfer',  60920: 'FD right gripper',
  61004: 'Quality stop',
};

// ─── Table-driven rules for machine/setting changes the log emits. FANCY
// variants come first: the plain id is a substring of the fancy one. ───
const SETTING_RULES = [
  { vgs: 'VGS_ID_ELO_BEAM_CHANGE_FANCY', icon: '🧶', cat: 'cloth', title: () => 'Top Beam Change', detail: () => 'New top (fancy) beam mounted.' },
  { vgs: 'VGS_ID_ELO_BEAM_CHANGE', icon: '🧶', cat: 'cloth', title: () => 'Ground Beam Change', detail: () => 'New ground beam mounted.' },
  { vgs: 'VGS_ID_PROMON_CLOTH_LENGTH', icon: '📏', cat: 'cloth', title: v => parseFloat(v) === 0 ? 'Cloth Length Counter Reset' : 'Cloth Length Set',
    detail: v => parseFloat(v) === 0 ? 'Metre counter was set to zero for a new cloth roll.' : `Value: <b>${v} m</b>` },
  { vgs: 'VGS_ID_PROMON_RESET_CURRENT_SHIFT', icon: '🔄', cat: 'cloth', title: () => 'Shift Counters Reset', detail: () => 'Production monitoring shift counters were reset.' },
  { vgs: 'VGS_ID_WARP_DETECTION_STATUS', icon: '🕸️', cat: 'setting', title: v => v === '1' ? 'Warp Detection Enabled' : 'Warp Detection Disabled' },
  { vgs: 'VGS_ID_WARP_DETECTION_DELAY_STATUS', icon: '🕸️', cat: 'setting', title: v => v === '1' ? 'Warp Detection Delay Enabled' : 'Warp Detection Delay Disabled' },
  { vgs: 'VGS_ID_WARP_DAMAGE_PROTECTION', icon: '🛡️', cat: 'setting', title: v => v === '1' ? 'Warp Damage Protection Enabled' : 'Warp Damage Protection Disabled' },
  { vgs: 'VGS_ID_WARP_BEAM_DETECTION_SENSITIVITY', icon: '⚙️', cat: 'setting', title: () => 'Warp Beam Detection Sensitivity Set', detail: v => `Value: <b>${v}%</b>` },
  { vgs: 'VGS_ID_WASTE_DETECTION_SENSITIVITY', icon: '⚙️', cat: 'setting', title: () => 'Waste Detection Sensitivity Set', detail: v => `Value: <b>${v}%</b>` },
  { vgs: 'VGS_ID_ISYS_WASTECUTTER_LEFT_MOUNTED', icon: '✂️', cat: 'setting', title: v => v === '1' ? 'Waste Cutter (Left) Mounted' : 'Waste Cutter (Left) Unmounted' },
  { vgs: 'VGS_ID_ISYS_WASTECUTTER_RIGHT_MOUNTED', icon: '✂️', cat: 'setting', title: v => v === '1' ? 'Waste Cutter (Right) Mounted' : 'Waste Cutter (Right) Unmounted' },
  { vgs: 'VGS_ID_ISYS_FABRICCUTTER_C1_MOUNTED', icon: '✂️', cat: 'setting', title: v => v === '1' ? 'Fabric Cutter (C1) Mounted' : 'Fabric Cutter (C1) Unmounted' },
  { vgs: 'VGS_ID_PROMON_PRESELECTION_UNIT', icon: '⚙️', cat: 'setting', title: () => 'Preselection Unit Set', detail: v => `Unit: <b>${v}</b>` },
  { vgs: 'VGS_ID_PROMON_PRESELECTION_STOP', icon: '⚙️', cat: 'setting', title: () => 'Preselection Stop Set', detail: v => `Value: <b>${v === '255' ? '255 (disabled)' : v}</b>` },
  { vgs: 'VGS_ID_ELO_ZERO_ADJUST', icon: '⚙️', cat: 'setting', title: () => 'Beam Zero Adjust', detail: v => `Value: <b>${v}</b>` },
  { vgs: 'VGS_ID_MACHINE_SYNCHRONIZATION_START', icon: '🔗', cat: 'design', title: () => 'Machine Synchronization Started', detail: () => 'Style synchronisation with the machine was started.' },
  { vgs: 'VGS_ID_TESTPATTERN_CHANNEL_BITMASK', icon: '🧪', cat: 'design', title: () => 'Test Pattern Channels Set', detail: v => `Channel bitmask: <b>${v}</b>` },
  { vgs: 'VGS_ID_ARTICLE_NAME', icon: '🧾', cat: 'article', title: () => 'Article Name Set', detail: v => `Article: <b>${v}</b>` },
  { vgs: 'VGS_ID_ISYS_PSO_STATUS', icon: '⚙️', cat: 'setting', title: v => v === '1' ? 'PSO Enabled' : 'PSO Disabled' },
  { vgs: 'VGS_ID_MSSG_SAFETY_FIXED', icon: '🛡️', cat: 'setting', title: () => 'Safety Message Fixed' },
];

// Consecutive pick-density changes within this window become one pick variation.
const DENSITY_GROUP_MS = 90000;
const MM_PER_INCH = 39.37;

// ─── export/export_*.xml : the production record ───
// One <data date time serial shift absolute_picks absolute_length type
// subtype1 subtype2 mssg_nr channel picks/> element per event.
function exportXml(text, out) {
  for (const m of String(text || '').matchAll(/<data ([^>]*)\/>/g)) {
    const a = {};
    for (const p of m[1].matchAll(/(\w+)="([^"]*)"/g)) a[p[1]] = p[2];
    if (!a.date || !a.time) continue;
    const t = `${a.date.replace(/\//g, '-')}T${a.time}`;
    const base = { t, src: 'export', shift: a.shift, picks: +a.absolute_picks || 0, length: +a.absolute_length || 0 };
    if (a.type === 'start') out.push({ ...base, kind: 'start' });
    else if (a.type === 'stop') out.push({
      ...base, kind: 'stop', reason: a.subtype1 || '', detail: a.subtype2 || '',
      mssg: +a.mssg_nr || 0, channel: a.channel || '', sincePicks: +a.picks || 0,
      label: STOP_REASONS[+a.mssg_nr] || a.subtype1 || 'Stop',
    });
    else if (a.type === 'article') out.push({ ...base, kind: 'article', title: a.subtype1 || '' });
    else if (a.type === 'shift') out.push({ ...base, kind: 'shift', title: a.subtype1 || '' });
    else if (a.type === 'power') out.push({ ...base, kind: 'power', title: (a.subtype1 || '') + (a.subtype2 ? ' / ' + a.subtype2 : '') });
  }
}

// ─── terminal/commserver/*.txt and terminal/hmi/*.txt ───
// Lines look like:  D;1;info;<iso>;module.method;<message>
function textLog(text, out, src) {
  let article = '';
  let yarnBuf = [], yarnTime = null;          // buffered channel setup
  let densBuf = [], densTime = null, densLast = null;

  const flushYarn = () => {
    if (densBuf.length) {
      out.push({ t: densTime, kind: 'pick', src, values: [...densBuf], article });
      densBuf = []; densTime = null; densLast = null;
    }
    if (!yarnBuf.length) return;
    out.push({ t: yarnTime, kind: 'yarn', src, channels: [...yarnBuf] });
    yarnBuf = []; yarnTime = null;
  };
  const flushAll = ev => { flushYarn(); out.push(ev); };

  for (const line of String(text || '').split('\n')) {
    const p = line.split(';');
    if (p.length < 5) continue;
    const level = p[2], t = p[3], context = p[4];
    const msg = p.slice(5).join(';').trim();
    if (!t || !t.includes('T')) continue;
    const base = { t, src, level };

    // ── machine came online ──
    if ((msg.includes('CommServerAndMachineState') || msg.includes('VGS_ID_ELO_BEAM_CHANGE')) && msg.includes('MachineReady')) {
      flushAll({ ...base, kind: 'ready', cat: 'startup', icon: '🟢',
        title: 'Machine Online — Ready', detail: 'Communication server and machine controller fully initialised.' });
      continue;
    }

    // ── operator session ──
    if (context.includes('onLogin') && msg.includes('Logged in')) {
      const session = (msg.match(/session key: \{([^}]+)\}/) || [])[1] || '';
      flushAll({ ...base, kind: 'operator', cat: 'operator', icon: '👤', title: 'Operator Logged In', detail: session });
      continue;
    }
    if (context.includes('onLoggedOff') && msg.includes('Logging off')) {
      flushAll({ ...base, kind: 'operator', cat: 'operator', icon: '🚪', title: 'Operator Logged Off', detail: '' });
      continue;
    }

    // ── article change ──
    if (context.includes('ActivateNewProdMonArticle')) {
      const isUpdate = msg.includes('Updating current');
      const name = (msg.match(/article(?:\s+name)?\s*(?:to\s*)?:\s*(.+)$/i) || [])[1] || '';
      if (name) article = name;
      flushAll({ ...base, kind: 'articleLog', cat: 'article', icon: isUpdate ? '🔄' : '🧾',
        title: isUpdate ? 'Article Updated' : 'New Article Started', detail: name });
      continue;
    }

    // ── design file + style transfer ──
    if (context.includes('ActivateDesignFile') && msg.includes('Starting activate')) {
      flushAll({ ...base, kind: 'design', cat: 'design', icon: '🎨', title: 'Design File Activated',
        detail: (msg.match(/design file\s+(\S+\.des)/i) || [])[1] || '' });
      continue;
    }
    if (context.includes('putStyleOnMachine')) {
      flushAll({ ...base, kind: 'design', cat: 'design', icon: '📤', title: 'Style Sent to Loom',
        detail: (msg.match(/Include options:\s*(.+)/) || [])[1] || '' });
      continue;
    }

    // ── pick density changes, grouped into pick variations ──
    if (msg.includes('VGS_ID_PICK_DENSITY_PER_METER') && msg.includes('Request to change')) {
      const v = parseFloat((msg.match(/to\s+([\d.]+)$/) || [])[1]);
      if (!isNaN(v)) {
        if (densBuf.length && new Date(t) - new Date(densLast) > DENSITY_GROUP_MS) { flushYarn(); }
        if (!densBuf.length) densTime = t;
        densLast = t;
        densBuf.push(v);
      }
      continue;
    }

    // ── cloth / beam counters ──
    if (msg.includes('VGS_ID_PROMON_RESET_CLOTH_LENGTH_UNCONDITIONALLY') && msg.includes('to 1')) {
      flushAll({ ...base, kind: 'setting', cat: 'cloth', icon: '📏', title: 'Cloth Length Counter Reset',
        detail: 'Metre counter was reset to zero for new cloth roll.' });
      continue;
    }
    const meter = [
      [/VGS_ID_ELO_FANCY_RIGHT_WARP_OUT_PREDICTION_INITIAL_LENGTH/, 'Top Beam Meter Set', 1, ''],
      [/VGS_ID_ELO_RIGHT_WARP_OUT_PREDICTION_INITIAL_LENGTH/, 'Ground Beam Meter Set', 1, ''],
      [/VGS_ID_ELO_DIAMETER_OFFSET/, 'Ground Beam Diameter Set', 1000, ' mm'],
      [/VGS_ID_ELO_FANCY_DIAMETER_OFFSET/, 'Top Beam Diameter Set', 1000, ' mm'],
    ].find(([re]) => re.test(msg));
    if (meter) {
      const v = parseFloat((msg.match(/to\s+([\d.]+)$/) || [])[1]);
      flushAll({ ...base, kind: 'setting', cat: 'cloth', icon: '📏', title: meter[1],
        detail: Number.isFinite(v) ? `Value: <b>${+(v * meter[2]).toFixed(2)}${meter[3]}</b>` : '' });
      continue;
    }

    // ── settings with unit conversion ──
    const unit = [
      [/VGS_ID_PROMON_PRESELECTION_SETTING/, 'Weft Preselection Set', 1, ''],
      [/VGS_ID_REQUESTED_MACHINE_SPEED/, 'Machine Speed Set', 1, ' rpm'],
      [/VGS_ID_ELO_FANCY_REQUESTED_TENSION_TSF/, 'Top Beam Tension Set', 1 / 1000, ' kN'],
      [/VGS_ID_ELO_GROUND_REQUESTED_TENSION_TSF/, 'Ground Beam Tension Set', 1 / 1000, ' kN'],
    ].find(([re]) => re.test(msg));
    if (unit) {
      const v = parseFloat((msg.match(/to\s+([\d.]+)$/) || [])[1]);
      flushAll({ ...base, kind: 'setting', cat: 'setting', icon: '⚙️', title: unit[1],
        detail: Number.isFinite(v) ? `Value: <b>${+(v * unit[2]).toFixed(3)}${unit[3]}</b>` : '' });
      continue;
    }

    // ── table-driven machine events ──
    const rule = SETTING_RULES.find(r => msg.includes(r.vgs));
    if (rule && msg.includes('Request to change')) {
      const v = (msg.match(/to\s+([^;]+)$/) || [])[1] || '';
      flushAll({ ...base, kind: 'setting', cat: rule.cat, icon: rule.icon, title: rule.title(v),
        detail: rule.detail ? rule.detail(v) : '' });
      continue;
    }

    // ── yarn channel setup (colours + multipick) ──
    if (msg.includes('VGS_ID_ISYS_CH_X_YARN_MULTIPICK') && msg.includes('Request to change')) {
      const m = msg.match(/YARN_MULTIPICK - (\d+) - \d+ of type \w+ to (\d+)/);
      if (m) {
        if (!yarnBuf.length) yarnTime = t;
        const e = yarnBuf.find(c => c.ch === +m[1]);
        if (e) e.picks = +m[2]; else yarnBuf.push({ ch: +m[1], col: null, picks: +m[2] });
      }
      continue;
    }
    if (msg.includes('VGS_ID_ISYS_CH_X_COLOR')) {
      const m = msg.match(/COLOR - (\d+) - 0.*?to (\d+)/);
      if (m) {
        if (!yarnBuf.length) yarnTime = t;
        const e = yarnBuf.find(c => c.ch === +m[1]);
        if (e) e.col = +m[2]; else yarnBuf.push({ ch: +m[1], col: +m[2] });
      }
      continue;
    }
  }
  flushYarn();
}

// ─── machine_description.xml : the settings dictionary ───
function machineDesc(xml) {
  const items = [];
  for (const m of String(xml || '').matchAll(/<I ([^>]*)\/>/g)) {
    const a = {};
    for (const p of m[1].matchAll(/(\w+)="([^"]*)"/g)) a[p[1]] = p[2];
    items.push({ group: a.groupName || '', code: +a.itemCode || 0, name: a.itemName || '',
      enumName: a.itemValueEnumName || '', value: a.itemValueInt ?? a.itemValueString ?? '', visible: a.itemHMIVisible });
  }
  return items;
}

// ─── terminal_description.xml + manifest.json : identity and software ───
function terminalDesc(xml) {
  xml = String(xml || '');
  const pick = re => (xml.match(re) || [])[1] || '';
  return {
    name: pick(/terminal_description name="([^"]*)"/),
    version: pick(/<number>([^<]*)<\/number>/),
    qt: pick(/<qtVersion>([^<]*)<\/qtVersion>/),
    buildroot: pick(/<buildrootVersion>([^<]*)<\/buildrootVersion>/),
    defconfig: pick(/<defconfig>([^<]*)<\/defconfig>/),
    kernel: pick(/<linuxVersion>([^<]*)<\/linuxVersion>/).split(' ').slice(0, 3).join(' '),
  };
}

function manifest(json) {
  const sw = json.tbb2 || {};
  return { software: sw.software || '', machine: sw.machine || '', commit: (sw.commit || '').slice(0, 10),
    buildDate: sw.date || '', job: sw.job || '' };
}

// ─── config/*.xml : spare parts and shift regimes ───
function spareParts(xml) {
  const parts = [];
  for (const m of String(xml || '').matchAll(/<sparePart ([^>]*)\/>/g)) {
    const a = {};
    for (const p of m[1].matchAll(/(\w+)="([^"]*)"/g)) a[p[1]] = p[2];
    parts.push({ id: a.id, name: a.name || '' });
  }
  return parts;
}

function shiftRegimes(xml) {
  const out = [];
  for (const m of String(xml || '').matchAll(/<regime ([^>]*)\/>/g)) {
    const a = {};
    for (const p of m[1].matchAll(/(\w+)="([^"]*)"/g)) a[p[1]] = p[2];
    if (a.d || a.h) out.push({ uid: a.uid, day: a.d || '', hours: a.h || '' });
  }
  return out;
}

// ─── history/pattern/*.btf : the Jacquard design, embedded as plaintext XML ───
// Carries the design's index tables. PickDensity is the "pick variation" the
// operator types on the Jacquard screen: a comma-separated set of values in the
// table's unit (Picks/Inch here), with one line per value. Designs can carry
// more than two, and can carry other tables too (Color, Speed, …).
function patternDesign(bytes) {
  if (!bytes) return null;
  const text = new TextDecoder().decode(bytes);
  const m = text.match(/<\?xml[\s\S]*?<\/design>/);
  if (!m) return null;
  const xml = m[0];
  const tables = [];
  for (const t of xml.matchAll(/<table type="([^"]+)">([\s\S]*?)<\/table>/g)) {
    const body = t[2];
    const data = (body.match(/<data>([^<]*)<\/data>/) || [])[1] || '';
    const unit = (body.match(/<indexUnit>([^<]*)<\/indexUnit>/) || [])[1] || '';
    const lines = +(body.match(/<nrOfLines>([^<]*)<\/nrOfLines>/) || [])[1] || 0;
    tables.push({
      type: t[1],
      unit,
      lines,
      values: data.split(',').map(v => v.trim()).filter(Boolean).map(Number),
    });
  }
  return {
    design: (xml.match(/<design name="([^"]*)"/) || [])[1] || '',
    jacquard: (xml.match(/<jacquard>([^<]*)<\/jacquard>/) || [])[1] === 'TRUE',
    superPattern: (xml.match(/<superPattern>([^<]*)<\/superPattern>/) || [])[1] === 'TRUE',
    tables,
  };
}

// ─── history/manualactions/*.dpf : help pages the operator opened ───
// The action names are binary, but the manual references they carry are text.
function manualActions(bytes) {
  if (!bytes) return { pages: [], chapters: [] };
  const text = new TextDecoder().decode(bytes);
  const pages = [...text.matchAll(/helptext\/(\d+)\.html/g)].map(m => +m[1]);
  const chapters = [...text.matchAll(/([A-Za-z0-9_]+)\/([a-z0-9_]+)\/[^"]{0,40}\.html/g)].map(m => m[1] + '/' + m[2]);
  return { pages: [...new Set(pages)], chapters: [...new Set(chapters)] };
}

// ─── terminal/kernel/messages* : events worth showing a support engineer ───
const KERNEL_FLAGS = [
  [/\b(Oops|kernel panic|BUG:|Unable to handle)\b/i, 'error', 'Kernel fault'],
  [/\b(segfault|general protection fault|traps:)\b/i, 'error', 'Segfault'],
  [/\b(Out of memory|oom-killer|Killed process)\b/i, 'error', 'Out of memory'],
  [/\b(thermal|overheat|throttl)\w*/i, 'warn', 'Thermal event'],
  [/\b(watchdog|I\/O error|read-only file system)\b/i, 'warn', 'Hardware warning'],
  [/\b(reboot|shutdown|systemd\[1\]: Reboot)\b/i, 'info', 'Reboot'],
];
function kernelLog(text, src) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    for (const [re, level, title] of KERNEL_FLAGS) {
      if (re.test(line)) {
        out.push({ kind: 'health', src, level, title, detail: line.trim().slice(0, 160) });
        break;
      }
    }
  }
  return out;
}

// ─── terminal/kernel/dmeminfo-log.csv : one sampled memory trace ───
// ponytail: only one trace is read (each file is ~19 MB and a CSF carries dozens).
function memoryTrace(text) {
  const lines = String(text || '').split('\n').filter(Boolean);
  if (lines.length < 2) return null;
  const head = lines[0].split(/[;,\t]/).map(s => s.trim().toLowerCase());
  const rows = lines.slice(1, 20001).map(l => l.split(/[;,\t]/).map(Number));
  const col = name => head.findIndex(h => h.includes(name));
  const pick = col('free'), total = col('total'), avail = col('available') >= 0 ? col('available') : pick;
  const series = [];
  for (const r of rows) {
    if (!Number.isFinite(r[pick]) || !Number.isFinite(r[total])) continue;
    series.push({ free: r[pick], total: r[total], used: 100 * (1 - (r[avail] || r[pick]) / r[total]) });
  }
  if (!series.length) return null;
  const used = series.map(s => s.used);
  return {
    samples: series.length,
    columns: head.length,
    avgUsed: used.reduce((a, b) => a + b, 0) / used.length,
    maxUsed: Math.max(...used),
    minFreeMB: Math.min(...series.map(s => s.free)) / 1024,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
//  .btf binary history
// ═══════════════════════════════════════════════════════════════════════════
// Format recovered from the CSF files:
//   file  : 17 01 <count:2> 06 ec … <len> "<12-char signature>" … records
//   record: 03 00 01 <type:1> <clock:4> … fields …
// Fields are a mix of little-endian counters and big-endian 16-bit codes; the
// reason codes (Picanol mssg_nr) are big-endian at +38 and verify against the
// codes in export/export_*.xml. <clock> is a big-endian uint32 that counts
// 3906.25 ticks/second and wraps every 2^32 ticks (12.72 days); history/hour
// records are exactly 14_062_500 ticks (1 h) apart, which fixes the rate.
//
// ponytail: only startstop is decoded. The other 35 history types share the
// framing but their fields are still unidentified — add them here as they are.
const BTF = {
  TICKS_PER_SEC: 3906.25,   // 256 µs per tick
  WRAP: 2 ** 32,
  CODE_OFFSET: 38,          // big-endian uint16 stop reason (mssg_nr)
  CLOCK_OFFSET: 4,          // big-endian uint32 tick counter
  MARKER: [0x03, 0x00, 0x01],
};

// Record boundaries: the 03 00 01 marker starts every record.
function btfRecords(bytes) {
  const recs = [];
  if (!bytes) return recs;
  for (let i = 0; i + 3 <= bytes.length; i++) {
    if (bytes[i] === BTF.MARKER[0] && bytes[i + 1] === BTF.MARKER[1] && bytes[i + 2] === BTF.MARKER[2]) recs.push(i);
  }
  const out = [];
  for (let k = 0; k < recs.length; k++) out.push(bytes.subarray(recs[k], recs[k + 1] ?? bytes.length));
  return out;
}

function be16(b, o) { return (b[o] << 8) | b[o + 1]; }
function be32(b, o) { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; }

// Raw startstop records: { clock, code }. Duplicated history folders mean the
// same record can appear in several files, so dedupe on the clock value.
function btfStartstopRaw(bytesList) {
  const seen = new Map();
  for (const bytes of bytesList) {
    for (const r of btfRecords(bytes)) {
      if (r.length < BTF.CODE_OFFSET + 2) continue;
      const code = be16(r, BTF.CODE_OFFSET);
      if (code < 50000 || code > 62000) continue;          // not a reason code
      const clock = be32(r, BTF.CLOCK_OFFSET);
      if (!seen.has(clock)) seen.set(clock, code);
    }
  }
  return [...seen.entries()].sort((a, b) => a[0] - b[0]).map(([clock, code]) => ({ clock, code }));
}

/*
 * Turn raw clocks into wall-clock time. The counter wraps, so each record may
 * belong to any 12.72-day cycle. Pick the cycle that puts the most records
 * inside the period the plain-text parts already cover — that both resolves the
 * wrap count and anchors the epoch.
 */
function btfToEvents(raw, knownMin, knownMax) {
  if (!raw.length || !knownMin || !knownMax) return { events: [], solved: false };
  const { TICKS_PER_SEC: R, WRAP: W } = BTF;
  const spanTicks = (knownMax - knownMin) * R;
  const cycles = Math.max(0, Math.round(spanTicks / W));
  const vMax = raw[raw.length - 1].clock;

  let best = null;
  for (let k = 0; k <= cycles + 2; k++) {
    const c0 = vMax + k * W - R * knownMax;   // newest record == newest known event
    let inside = 0;
    for (const r of raw) {
      const t = (r.clock + k * W - c0) / R;
      if (t >= knownMin - 3600 && t <= knownMax + 3600) inside++;
    }
    if (!best || inside > best.inside) best = { inside, c0, k };
  }
  const events = raw.map(r => {
    const secs = (r.clock + best.k * W - best.c0) / R;
    return {
      t: new Date(secs * 1000).toISOString().slice(0, 23),
      kind: 'stop', src: 'btf', mssg: r.code,
      label: STOP_REASONS[r.code] || 'Stop',
      sincePicks: 0, picks: 0, length: 0,
    };
  }).filter(e => {
    const t = Date.parse(e.t) / 1000;                 // keep seconds: span is in seconds
    return t >= knownMin - 3600 && t <= knownMax + 3600;
  });
  return { events, solved: events.length > 0, coverage: best.inside / raw.length };
}

// Everything the rest of the app reaches for, in one place.
const Decode = {
  YARN_COLORS, STOP_REASONS, SETTING_RULES, MM_PER_INCH, DENSITY_GROUP_MS, BTF,
  exportXml, textLog, machineDesc, terminalDesc, manifest, spareParts, shiftRegimes,
  btfRecords, btfStartstopRaw, btfToEvents,
  patternDesign, manualActions, kernelLog, memoryTrace,
};
