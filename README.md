# Picanol CSF Explorer

Reads a Picanol CSF archive (the zip a machine exports for support) and turns it
into a readable production timeline, downtime analysis, machine profile and a
binary-format inspector.

Everything runs in the browser. No backend, no build step, no server.

## Use it

Open `index.html`, or publish the folder as-is on GitHub Pages. Drop a `.zip`
CSF onto the page (or click to browse).

| Tab | What you get |
| --- | --- |
| **Timeline** | every decoded event grouped by day, with category filters, search and CSV export |
| **Production** | efficiency KPIs, efficiency-by-hour chart, downtime by reason, **stops per weft feeder**, **design density sets**, per-day / shift / article / operator tables — all sortable |
| **Machine** | serial, software versions, kernel health, memory trace, the 148-item settings dictionary, shift regimes, spare parts |
| **Diagnostics** | which binary history formats are decoded, which are not, and why |

Keyboard: `1`–`4` switch tabs, `/` focuses search, `t` toggles the theme.

## What a CSF contains

| Part | Status |
| --- | --- |
`export/export_*.xml` | the production record — starts, stops with reason codes and channels, articles, shifts, power events, lifetime pick and metre counters |
`terminal/commserver/*.txt`, `terminal/hmi/*.txt` | operator logins, article and design changes, machine setting changes (including pick-density variations) |
`machine_description.xml` | the settings dictionary: 148 named items in 18 groups with enum mappings |
`terminal_description.xml`, `manifest.json` | software, Qt, buildroot, kernel, commit |
`config/*.xml` | spare parts, shift regimes, taskbar, scheduled tasks |
`terminal/kernel/*` | kernel log (faults, OOMs, thermal, reboots) and memory traces |
`history/pattern/*.btf` | **decoded** — the Jacquard design, including its density sets |
`history/startstop/*.btf` | **decoded** — binary stop history, roughly 3× the coverage of the export |
other `history/*.btf`, `*.dpf`, `*.bsty` | framing known, fields not yet proven (see Diagnostics) |

### Pick variation — where the densities really live

When an article weaves two or more densities, the machine logs only the
*current* one (`VGS_ID_PICK_DENSITY_PER_METER - 0 - 0`). The full set is an
**index table inside the design**, in `history/pattern/*.btf`:

```xml
<table type="PickDensity">
  <nrOfLines>2</nrOfLines>
  <data>36.00,82.00</data>
  <attribs><indexUnit>Picks/Inch</indexUnit></attribs>
</table>
```

Any number of values is supported, and a design may carry other tables too
(`Color`, `Speed`). Those are shown under **Design density sets** and in
Diagnostics.

## The binary history

`history/startstop/*.btf` was reverse engineered far enough to be useful:

- **Framing** — `17 01` magic, 2-byte record count, a length-prefixed 12-character
  signature, then records framed by `03 00 01` plus a one-byte type id.
- **Mixed endianness** — counters are little-endian, but the Picanol reason codes
  (`msgsr`-class ids, `mssg_nr`) are **big-endian uint16** at record offset +38.
  Those decode to exactly the codes in the export XML — 60002 beam change, 60917
  FD not taken, 60918 FD left gripper, 50207 manual stop, 50967 bobbin — and the
  frequency ranking matches.
- **Clock** — a big-endian uint32 at record offset +4 counting **3906.25 ticks/s**
  (256 µs per tick) and wrapping every 2³² ticks (12.72 days). The rate comes from
  `history/hour` records being exactly 14,062,500 ticks (one hour) apart.

Binary stops carry no counters, so they extend the timeline but are kept out of
the production arithmetic — the export is authoritative there.

Decoded fields are always validated against the production export. Where a format
could not be proven (`history/hour`, `fillingstop`, `temperature`, `drives`,
`insertionlog`, `message`, `useractions`), it is listed as undecoded rather than
guessed at.

## Layout

```
index.html      shell, tabs, drop zone, keyboard shortcuts
app.css         theme and components
js/csf.js       CSF anatomy: opens the zip, routes each part to a decoder
js/decode.js    all decoders, including the .btf reader
js/model.js     one flat event stream + every number the UI shows
js/ui.js        rendering, sorting, charts and CSV export
selftest.html   open it in a browser to check the decoders and the model
```

Decoders only push events onto one time-sorted array; everything else is derived
from it, so adding a decoder enriches every view at once.

## Checking it

Open `selftest.html` — 51 assertions covering the export parser, the log parser
(including pick-variation grouping of 36 and 82 picks/inch), the binary framing
and endianness, design index tables, kernel and memory parsing, production
arithmetic, and robustness against junk input.
