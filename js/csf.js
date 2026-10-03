'use strict';

/*
 * CSF reader: opens a Picanol CSF zip and routes every part to a decoder.
 * A CSF is a plain zip — no build step, no server, everything in the browser.
 */

const Csf = (() => {

  const part = (path, lower = path) => lower.toLowerCase();

  function collect(zip) {
    const files = { commserver: [], hmi: [], export: [], pattern: [], btfStartstop: [], kernel: [], memory: [], other: [] };
    zip.forEach((path, entry) => {
      if (entry.dir) return;
      const p = part(path);
      const name = path.split('/').pop();
      if (p.includes('terminal/commserver/') && (name.endsWith('.txt') || name.endsWith('.log'))) files.commserver.push(path);
      else if (p.includes('terminal/hmi/') && name.endsWith('.txt') && !name.includes('init') && !name.includes('std_out')) files.hmi.push(path);
      else if (p.startsWith('export/') && name.endsWith('.xml')) files.export.push(path);
      else if (p.includes('history/pattern/') && name.endsWith('.btf')) files.pattern.push(path);
      else if (p.includes('history/startstop/') && name.endsWith('.btf')) files.btfStartstop.push(path);
      else if (p.includes('terminal/kernel/') && name.startsWith('messages')) files.kernel.push(path);
      else if (p.includes('terminal/kernel/') && name.startsWith('dmeminfo-log.csv')) files.memory.push(path);
      else if (name.endsWith('.xml') || name.endsWith('.json') || name.endsWith('.spc') || name.endsWith('.bshc')) {
        files.other.push(path);
      }
    });
    files.commserver.sort();   // rotation files are chronological by name
    return files;
  }

  async function readAll(zip, files, group, onProgress) {
    const out = [];
    for (let i = 0; i < files[group].length; i++) {
      out.push(await zip.file(files[group][i]).async('string'));
      if (onProgress) onProgress(i + 1, files[group].length, files[group][i].split('/').pop());
    }
    return out;
  }

  /*
   * Load a CSF file and build the whole dataset.
   *   onStep(label, fraction) drives the progress bar.
   */
  async function load(file, onStep) {
    const zip = await JSZip.loadAsync(file);

    const machine = {
      serial: (file.name.match(/csf_(\d+)/) || [])[1] || '',
      created: (file.name.match(/csf_\d+_(\d{8})_(\d{6})/) || []) ,
      name: file.name,
      identity: {}, settings: [], spareParts: [], shiftRegimes: [], designs: [],
      files: { commserver: 0, hmi: 0, btf: 0, pattern: 0 },
    };
    if (machine.created[1]) {
      // DD/MM/YYYY HH:MM, read from the CSF file name.
      const d = machine.created[1], t = machine.created[2];
      machine.identity.created =
        `${d.slice(6, 8)}/${d.slice(4, 6)}/${d.slice(0, 4)} ${t.slice(0, 2)}:${t.slice(2, 4)}`;
    }

    const files = collect(zip);
    machine.files.commserver = files.commserver.length;
    machine.files.hmi = files.hmi.length;
    machine.files.btf = files.btfStartstop.length;
    machine.files.pattern = files.pattern.length;

    // A failing part must cost us that part only — never the whole archive.
    const events = [];
    const warnings = [];
    const warn = (part, err) => warnings.push({ part, message: (err && err.message) || String(err) });
    const attempt = (label, part, fn) => {
      try { fn(); } catch (err) { warn(label + ' (' + part + ')', err); }
    };

    // ── export XML: the production record ──
    onStep('Reading production export', 0.05);
    const exportText = (await readAll(zip, files, 'export', (i, n) => onStep('Reading production export', 0.05 + 0.1 * i / n))).join('\n');
    attempt('production export', 'export/*.xml', () => Decode.exportXml(exportText, events));

    // ── text logs: operator actions and settings ──
    onStep('Reading commserver logs', 0.15);
    const commText = (await readAll(zip, files, 'commserver', (i, n) => onStep('Reading commserver logs', 0.15 + 0.55 * i / n))).join('\n');
    attempt('commserver logs', 'terminal/commserver/*', () => Decode.textLog(commText, events, 'commserver'));

    onStep('Reading terminal logs', 0.7);
    const hmiText = (await readAll(zip, files, 'hmi', (i, n) => onStep('Reading terminal logs', 0.7 + 0.1 * i / n))).join('\n');
    if (hmiText) attempt('terminal logs', 'terminal/hmi/*', () => Decode.textLog(hmiText, events, 'hmi'));

    // ── identity and settings dictionary ──
    onStep('Reading machine description', 0.8);
    for (const path of files.other) {
      const name = path.split('/').pop();
      try {
        const text = await zip.file(path).async('string');
        if (name === 'machine_description.xml') machine.settings = Decode.machineDesc(text);
        else if (name === 'terminal_description.xml') machine.identity = Decode.terminalDesc(text);
        else if (name === 'manifest.json') machine.identity = { ...machine.identity, ...Decode.manifest(JSON.parse(text)) };
        else if (name.endsWith('.spc')) machine.spareParts = Decode.spareParts(text);
        else if (name.endsWith('.bshc')) machine.shiftRegimes = Decode.shiftRegimes(text);
      } catch (err) {
        warn(name, err);   // an unreadable part costs only that part
      }
    }

    // ── Jacquard design: the density sets the operator enters ──
    onStep('Reading designs', 0.82);
    machine.designs = [];
    for (let i = 0; i < files.pattern.length; i++) {
      try {
        const bytes = await zip.file(files.pattern[i]).async('uint8array');
        const design = Decode.patternDesign(bytes);
        if (design) machine.designs.push(design);
      } catch (err) {
        warn(files.pattern[i].split('/').pop(), err);
      }
      onStep('Reading designs', 0.82 + 0.03 * (i + 1) / files.pattern.length);
    }

    // ── machine health: kernel log and one sampled memory trace ──
    onStep('Checking machine health', 0.85);
    for (const path of files.kernel.slice(-3)) {
      try {
        Decode.kernelLog(await zip.file(path).async('string'), 'kernel').forEach(e => events.push(e));
      } catch (err) {
        warn(path.split('/').pop(), err);
      }
    }
    if (files.memory.length) {
      try {
        const text = await zip.file(files.memory[0]).async('string');
        machine.memory = Decode.memoryTrace(text);
      } catch (err) {
        warn('memory trace', err);
      }
    }

    // ── binary history: extends the timeline past what the export covers ──
    onStep('Decoding binary history', 0.85);
    let binary = { events: [], solved: false, coverage: 0, records: 0 };
    if (files.btfStartstop.length) {
      try {
        const blobs = [];
        for (let i = 0; i < files.btfStartstop.length; i++) {
          blobs.push(await zip.file(files.btfStartstop[i]).async('uint8array'));
          onStep('Decoding binary history', 0.85 + 0.14 * i / files.btfStartstop.length);
        }
        const raw = Decode.btfStartstopRaw(blobs);
        binary = { ...Decode.btfToEvents(raw, knownSpan(events)), records: raw.length };
        binary.files = files.btfStartstop.length;
        events.push(...binary.events);
      } catch (err) {
        warn('binary history', err);   // optional: the archive stays usable
        binary.failed = true;
      }
    }
    onStep('Building timeline', 0.99);

    machine.warnings = warnings;
    return { machine, events, binary };
  }

  function knownSpan(events) {
    let min = Infinity, max = -Infinity;
    for (const e of events) {
      const t = Date.parse(e.t);
      if (!Number.isFinite(t)) continue;
      if (t < min) min = t;
      if (t > max) max = t;
    }
    return max > min ? [min / 1000, max / 1000] : [0, 0];
  }

  return { load };
})();
