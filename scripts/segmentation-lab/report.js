// HTML report for the segmentation lab: for a few rides, the signals (speed, estimated power,
// heart rate, altitude) with one lane of segments per strategy. A lane's colour is the segment's
// mean effort (blue = low, red = high), its text the mean heart rate and speed, so the eye can judge
// whether a segment is one stretch of "the same feeling".

const fs = require('node:fs');
const path = require('node:path');

const W = 1180; const L = 150; const R = 12;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

function line(arr, a, b, x, y, step = 3) {
  const pts = [];
  for (let t = a; t < b; t += step) if (Number.isFinite(arr[t])) pts.push(`${x(t).toFixed(1)},${y(arr[t]).toFixed(1)}`);
  return pts.join(' ');
}

function range(arr, lo = 0.02, hi = 0.98) {
  const v = Array.from(arr).filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return [0, 1];
  return [v[Math.floor(lo * v.length)], v[Math.min(v.length - 1, Math.floor(hi * v.length))]];
}

function rideSvg(ride, sig, strategies, lineNames, win = null) {
  const T = sig.T;
  const w0 = win ? win.a : 0; const w1 = win ? win.b : T;
  const x = (t) => L + ((t - w0) / (w1 - w0)) * (W - L - R);
  const panels = [
    ['speed km/h', sig.spd, '#4aa3ff', 70], ['vpower W', sig.pwS, '#ffa94d', 70],
    ['HR bpm', sig.hrAligned, '#ff6b6b', 70], ['altitude m', sig.altS, '#9aa0a6', 60],
  ];
  let y0 = 8; const parts = []; const panelTops = [];
  const topOf = y0;
  for (const [label, arr, color, h] of panels) {
    const [lo, hi] = range(Float64Array.from(arr).slice(w0, w1));
    const y = (v) => y0 + h - 4 - ((Math.min(Math.max(v, lo), hi) - lo) / (hi - lo || 1)) * (h - 8);
    parts.push(`<rect x="${L}" y="${y0}" width="${W - L - R}" height="${h}" fill="#1b1d21" stroke="#33363c"/>`);
    parts.push(`<text x="6" y="${y0 + 16}" fill="#aab" font-size="12">${label}</text><text x="6" y="${y0 + 30}" fill="#778" font-size="10">${lo.toFixed(0)}–${hi.toFixed(0)}</text>`);
    parts.push(`<polyline points="${line(arr, w0, w1, x, y, win ? 1 : 3)}" fill="none" stroke="${color}" stroke-width="1.2"/>`);
    panelTops.push(y0);
    y0 += h + 6;
  }
  const bottomOfPanels = y0 - 6;
  // stops
  let s = w0;
  while (s < w1) {
    if (sig.stopped[s]) { let e = s; while (e < w1 && sig.stopped[e]) e += 1; parts.push(`<rect x="${x(s).toFixed(1)}" y="${topOf}" width="${Math.max(1, x(e) - x(s)).toFixed(1)}" height="${bottomOfPanels - topOf}" fill="#888" opacity="0.18"/>`); s = e; } else s += 1;
  }
  // time axis
  if (win && win.ticks) {
    for (const tick of win.ticks) {
      parts.push(`<line x1="${x(tick.sec).toFixed(1)}" x2="${x(tick.sec).toFixed(1)}" y1="${topOf}" y2="${bottomOfPanels}" stroke="#555" stroke-width="0.6"/>`);
      parts.push(`<text x="${x(tick.sec).toFixed(1)}" y="${bottomOfPanels + 12}" fill="#9ab" font-size="11" text-anchor="middle">km ${tick.label}</text>`);
    }
  } else {
    for (let m = 0; m * 60 <= T; m += 5) parts.push(`<text x="${x(m * 60).toFixed(1)}" y="${bottomOfPanels + 12}" fill="#778" font-size="10" text-anchor="middle">${m}'</text>`);
  }
  y0 = bottomOfPanels + 20;

  const effortOf = (seg) => {
    const arr = Number.isFinite(sig.hrCoverage) && sig.hrCoverage >= 0.7 ? sig.hrAligned : sig.pwS;
    let sum = 0; let n = 0;
    for (let t = seg.a; t < seg.b; t += 1) if (Number.isFinite(arr[t])) { sum += arr[t]; n += 1; }
    return n ? sum / n : NaN;
  };
  const [elo, ehi] = range(sig.hrCoverage >= 0.7 ? sig.hrAligned : sig.pwS, 0.05, 0.95);
  const laneTop = y0;
  for (const st of strategies) {
    const visible = st.segs.filter((q) => q.b > w0 && q.a < w1).map((q) => ({ ...q, a: Math.max(q.a, w0), b: Math.min(q.b, w1) }));
    parts.push(`<text x="6" y="${y0 + 17}" fill="#cde" font-size="12">${esc(st.name)} <tspan fill="#778">(${visible.length})</tspan></text>`);
    for (const seg of visible) {
      const e = effortOf(seg);
      const k = Number.isFinite(e) ? Math.min(1, Math.max(0, (e - elo) / (ehi - elo || 1))) : 0.5;
      const hue = 215 - 215 * k;
      const w = x(seg.b) - x(seg.a);
      parts.push(`<rect x="${x(seg.a).toFixed(1)}" y="${y0}" width="${Math.max(0.5, w - 1).toFixed(1)}" height="24" fill="hsl(${hue.toFixed(0)} 55% 38%)" stroke="#111" stroke-width="0.5"><title>${mmss(seg.a)}–${mmss(seg.b)} ${seg.type}</title></rect>`);
      if (w > 46) {
        let sp = 0; let c = 0;
        for (let t = seg.a; t < seg.b; t += 1) if (Number.isFinite(sig.spd[t])) { sp += sig.spd[t]; c += 1; }
        parts.push(`<text x="${(x(seg.a) + w / 2).toFixed(1)}" y="${y0 + 16}" fill="#fff" font-size="10" text-anchor="middle">${Number.isFinite(e) ? Math.round(e) : ''} · ${c ? Math.round(sp / c) : ''}</text>`);
      }
    }
    y0 += 30;
  }
  // boundary guides for the chosen strategies, drawn through the signal panels
  const colors = ['#9aa0a6', '#ff4fd8', '#5ee6a8'];
  lineNames.forEach((name, i) => {
    const st = strategies.find((q) => q.name === name);
    if (!st) return;
    for (let j = 1; j < st.segs.length; j += 1) {
      if (st.segs[j].a - st.segs[j - 1].b > 2 || st.segs[j].a < w0 || st.segs[j].a > w1) continue;
      parts.push(`<line x1="${x(st.segs[j].a).toFixed(1)}" x2="${x(st.segs[j].a).toFixed(1)}" y1="${topOf}" y2="${bottomOfPanels}" stroke="${colors[i % 3]}" stroke-dasharray="3 3" stroke-width="1" opacity="0.7"/>`);
    }
  });
  const height = y0 + 6;
  return `<svg width="${W}" height="${height}" viewBox="0 0 ${W} ${height}" xmlns="http://www.w3.org/2000/svg" font-family="sans-serif">${parts.join('')}</svg>`;
}

function writeReport(args, prepared, results, tableText) {
  fs.mkdirSync(args.out, { recursive: true });
  const names = args.names ? [...results.keys()].filter((n) => args.names.includes(n)) : [...results.keys()];
  const blocks = [];
  for (const id of args.rides) {
    const entry = prepared.find((p) => p.ride.id === id);
    if (!entry) continue;
    const strategies = names.map((name) => {
      const r = results.get(name).find((x) => x.ride.id === id);
      return { name, segs: r ? r.segs : [] };
    });
    let win = null;
    if (args.fromKm != null) {
      const secOf = (km) => { const r = entry.ride.records.find((q) => q.distance >= km); return r ? Math.round(r.elapsed_time - entry.sig.t0) : null; };
      const a = secOf(args.fromKm); const b = secOf(args.toKm);
      if (a != null && b != null) {
        const ticks = [];
        for (let km = Math.ceil(args.fromKm); km <= args.toKm; km += 1) { const sec = secOf(km); if (sec != null) ticks.push({ sec, label: km }); }
        win = { a, b, ticks };
      }
    }
    const title = win ? `km ${args.fromKm}–${args.toKm}` : `${mmss(entry.sig.T)} h:m`;
    blocks.push(`<h2>Ride ${id} · ${esc(entry.ride.start.slice(0, 10))} · ${title} · HR coverage ${(100 * entry.sig.hrCoverage).toFixed(0)}%</h2>${rideSvg(entry.ride, entry.sig, strategies, args.lines, win)}`);
  }
  const html = `<!doctype html><meta charset="utf-8"><title>Segmentation lab</title>
<style>body{background:#131417;color:#dde;font-family:sans-serif;margin:18px}h2{font-size:15px;margin:22px 0 6px}pre{background:#1b1d21;padding:10px;overflow:auto;font-size:12px}svg{display:block}p{max-width:1100px;color:#aab;font-size:13px}</style>
<h1 style="font-size:18px">Segmentation lab — ${args.density} segments per moving hour</h1>
<p>Lane colour = mean effort of the segment (blue low … red high; heart rate aligned 20 s back, or estimated power when there is no heart rate); text = effort · speed km/h. Dashed vertical guides: ${args.lines.map(esc).join(', ')}. Grey bands are stops.</p>
<pre>${esc(tableText)}</pre>${blocks.join('\n')}`;
  const file = path.join(args.out, 'report.html');
  fs.writeFileSync(file, html);
  return file;
}

module.exports = { writeReport };
