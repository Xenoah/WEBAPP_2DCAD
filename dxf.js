/* dxf.js — ASCII DXF 読み込み (R12〜2018 サブセット) / 書き出し (R12)
   依存なし。ブラウザ・Node 両対応（Node はテスト用）。 */
'use strict';

/* ---------- ACI (AutoCAD Color Index) ---------- */
const ACI_BASE = {
  1: '#ff0000', 2: '#ffff00', 3: '#00ff00', 4: '#00ffff', 5: '#0000ff',
  6: '#ff00ff', 7: '#ffffff', 8: '#808080', 9: '#c0c0c0',
  250: '#333333', 251: '#505050', 252: '#696969', 253: '#828282', 254: '#bebebe', 255: '#ffffff'
};

function aciToHex(i) {
  if (ACI_BASE[i]) return ACI_BASE[i];
  if (i < 10 || i > 255) return '#ffffff';
  // 10-249: 近似計算（色相 24 分割 × 明度 5 段 × 濃淡 2）
  const hue = Math.floor((i - 10) / 10) * 15; // deg
  const rem = (i - 10) % 10;
  const shade = Math.floor(rem / 2);          // 0..4
  const dim = rem % 2;                        // 0=vivid 1=dim
  let l = [0.5, 0.42, 0.34, 0.26, 0.18][shade];
  if (dim) l *= 0.65;
  return hslToHex(hue, 1.0, Math.max(0.08, l));
}

function hslToHex(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; } else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; } else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; } else { r = c; b = x; }
  const to = v => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return '#' + to(r) + to(g) + to(b);
}

/* ---------- 読み込み ---------- */
/* 戻り値: { layers: [{name,color,ltype,on,locked}], entities: [...], skipped: number } */
function parseDXF(text) {
  const lines = text.split(/\r\n|\r|\n/);
  const pairs = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i].trim(), 10);
    if (Number.isNaN(code)) continue;
    pairs.push([code, lines[i + 1]]);
  }
  const layers = [];
  const entities = [];
  let skipped = 0;
  let i = 0;
  const N = pairs.length;

  function collect(stopTypes) {
    // 現在位置から次の 0 コードまでのグループを {code:[values...]} で集める
    const g = {};
    while (i < N && pairs[i][0] !== 0) {
      const [c, v] = pairs[i];
      (g[c] || (g[c] = [])).push(v.trim());
      i++;
    }
    return g;
  }
  const num = (g, c, d = 0) => (g[c] ? parseFloat(g[c][0]) : d);
  const str = (g, c, d = '') => (g[c] ? g[c][0] : d);

  while (i < N) {
    const [code, valRaw] = pairs[i];
    const val = valRaw.trim().toUpperCase();
    if (code !== 0) { i++; continue; }
    i++;

    if (val === 'LAYER') {
      const g = collect();
      const name = str(g, 2);
      if (name && !layers.some(l => l.name === name)) {
        const colRaw = g[62] ? parseInt(g[62][0], 10) : 7;
        const flags = g[70] ? parseInt(g[70][0], 10) : 0;
        layers.push({
          name,
          color: Math.abs(colRaw) || 7,
          on: colRaw >= 0,
          locked: !!(flags & 4),
          ltype: (str(g, 6, 'CONTINUOUS') || 'CONTINUOUS').toUpperCase()
        });
      }
    } else if (val === 'LINE') {
      const g = collect();
      entities.push({ type: 'line', layer: str(g, 8, '0'), color: g[62] ? parseInt(g[62][0], 10) : 256,
        x1: num(g, 10), y1: num(g, 20), x2: num(g, 11), y2: num(g, 21) });
    } else if (val === 'CIRCLE') {
      const g = collect();
      entities.push({ type: 'circle', layer: str(g, 8, '0'), color: g[62] ? parseInt(g[62][0], 10) : 256,
        cx: num(g, 10), cy: num(g, 20), r: num(g, 40) });
    } else if (val === 'ARC') {
      const g = collect();
      entities.push({ type: 'arc', layer: str(g, 8, '0'), color: g[62] ? parseInt(g[62][0], 10) : 256,
        cx: num(g, 10), cy: num(g, 20), r: num(g, 40),
        a0: num(g, 50) * Math.PI / 180, a1: num(g, 51) * Math.PI / 180 });
    } else if (val === 'LWPOLYLINE') {
      // 10/20/42 は繰り返し出現するため順序保持で自前収集
      const pts = [];
      let closed = false, layer = '0', color = 256, cur = null;
      while (i < N && pairs[i][0] !== 0) {
        const [c, v] = pairs[i];
        const t = v.trim();
        if (c === 8) layer = t;
        else if (c === 62) color = parseInt(t, 10);
        else if (c === 70) closed = !!(parseInt(t, 10) & 1);
        else if (c === 10) { cur = { x: parseFloat(t), y: 0, bulge: 0 }; pts.push(cur); }
        else if (c === 20 && cur) cur.y = parseFloat(t);
        else if (c === 42 && cur) cur.bulge = parseFloat(t);
        i++;
      }
      if (pts.length >= 2) entities.push({ type: 'pline', layer, color, pts, closed });
    } else if (val === 'POLYLINE') {
      const g = collect();
      const layer = str(g, 8, '0');
      const color = g[62] ? parseInt(g[62][0], 10) : 256;
      const closed = !!(num(g, 70) & 1);
      const pts = [];
      // 後続の VERTEX 群 → SEQEND
      while (i < N) {
        if (pairs[i][0] === 0) {
          const t = pairs[i][1].trim().toUpperCase();
          if (t === 'VERTEX') {
            i++;
            const vg = collect();
            pts.push({ x: num(vg, 10), y: num(vg, 20), bulge: num(vg, 42) });
            continue;
          }
          if (t === 'SEQEND') { i++; collect(); break; }
          break; // SEQEND 無しの不正データ
        }
        i++;
      }
      if (pts.length >= 2) entities.push({ type: 'pline', layer, color, pts, closed });
    } else if (val === 'TEXT' || val === 'MTEXT') {
      const g = collect();
      let s = str(g, 1);
      if (val === 'MTEXT') {
        if (g[3]) s = g[3].join('') + s; // 250文字超の分割
        s = s.replace(/\\P/gi, ' ').replace(/\\[A-Za-z][^;]*;/g, '').replace(/[{}]/g, '');
      }
      if (s) entities.push({ type: 'text', layer: str(g, 8, '0'), color: g[62] ? parseInt(g[62][0], 10) : 256,
        x: num(g, 10), y: num(g, 20), h: num(g, 40, 2.5), rot: num(g, 50) * Math.PI / 180, str: s });
    } else if (val === 'POINT') {
      const g = collect();
      entities.push({ type: 'point', layer: str(g, 8, '0'), color: g[62] ? parseInt(g[62][0], 10) : 256,
        x: num(g, 10), y: num(g, 20) });
    } else if (['INSERT', 'HATCH', 'SPLINE', 'ELLIPSE', 'DIMENSION', 'SOLID', '3DFACE', 'LEADER', 'MLINE', 'REGION', 'WIPEOUT', 'IMAGE'].includes(val)) {
      collect();
      skipped++;
    } else {
      collect(); // SECTION/ENDSEC/TABLE/EOF/未知 — 読み飛ばし
    }
  }
  return { layers, entities, skipped };
}

/* ---------- 書き出し (R12 / AC1009) ---------- */
const LTYPE_DEFS = {
  CONTINUOUS: { desc: 'Solid line', pat: [] },
  DASHED:     { desc: 'Dashed __ __ __', pat: [12.7, -6.35] },
  CENTER:     { desc: 'Center ____ _ ____', pat: [31.75, -6.35, 6.35, -6.35] },
  HIDDEN:     { desc: 'Hidden __ __ __', pat: [6.35, -3.175] }
};

function writeDXF(doc) {
  // doc: { layers: [{name,color,ltype,on,locked}], entities: [...] }
  const out = [];
  const w = (c, v) => { out.push(String(c), String(v)); };
  const fnum = n => {
    if (!Number.isFinite(n)) n = 0;
    let s = n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '.0');
    return s;
  };
  const deg = r => fnum((r * 180 / Math.PI + 360) % 360);

  // HEADER
  w(0, 'SECTION'); w(2, 'HEADER');
  w(9, '$ACADVER'); w(1, 'AC1009');
  w(9, '$INSUNITS'); w(70, 4); // mm
  w(0, 'ENDSEC');

  // TABLES
  w(0, 'SECTION'); w(2, 'TABLES');
  const usedLtypes = new Set(['CONTINUOUS']);
  doc.layers.forEach(l => usedLtypes.add(l.ltype || 'CONTINUOUS'));
  w(0, 'TABLE'); w(2, 'LTYPE'); w(70, usedLtypes.size);
  usedLtypes.forEach(name => {
    const def = LTYPE_DEFS[name] || LTYPE_DEFS.CONTINUOUS;
    w(0, 'LTYPE'); w(2, name); w(70, 0); w(3, def.desc); w(72, 65);
    w(73, def.pat.length); w(40, fnum(def.pat.reduce((a, b) => a + Math.abs(b), 0)));
    def.pat.forEach(d => w(49, fnum(d)));
  });
  w(0, 'ENDTAB');
  w(0, 'TABLE'); w(2, 'LAYER'); w(70, doc.layers.length);
  doc.layers.forEach(l => {
    w(0, 'LAYER'); w(2, l.name); w(70, l.locked ? 4 : 0);
    w(62, (l.on === false ? -1 : 1) * (l.color || 7));
    w(6, l.ltype || 'CONTINUOUS');
  });
  w(0, 'ENDTAB');
  w(0, 'ENDSEC');

  // ENTITIES
  w(0, 'SECTION'); w(2, 'ENTITIES');
  const common = e => {
    w(8, e.layer || '0');
    if (e.color != null && e.color !== 256) w(62, e.color);
  };
  for (const e of doc.entities) {
    if (e.type === 'line') {
      w(0, 'LINE'); common(e);
      w(10, fnum(e.x1)); w(20, fnum(e.y1)); w(30, '0.0');
      w(11, fnum(e.x2)); w(21, fnum(e.y2)); w(31, '0.0');
    } else if (e.type === 'circle') {
      w(0, 'CIRCLE'); common(e);
      w(10, fnum(e.cx)); w(20, fnum(e.cy)); w(30, '0.0'); w(40, fnum(e.r));
    } else if (e.type === 'arc') {
      w(0, 'ARC'); common(e);
      w(10, fnum(e.cx)); w(20, fnum(e.cy)); w(30, '0.0'); w(40, fnum(e.r));
      w(50, deg(e.a0)); w(51, deg(e.a1));
    } else if (e.type === 'pline') {
      w(0, 'POLYLINE'); common(e); w(66, 1); w(70, e.closed ? 1 : 0);
      for (const p of e.pts) {
        w(0, 'VERTEX'); w(8, e.layer || '0');
        w(10, fnum(p.x)); w(20, fnum(p.y)); w(30, '0.0');
        if (p.bulge) w(42, fnum(p.bulge));
      }
      w(0, 'SEQEND'); w(8, e.layer || '0');
    } else if (e.type === 'text') {
      w(0, 'TEXT'); common(e);
      w(10, fnum(e.x)); w(20, fnum(e.y)); w(30, '0.0');
      w(40, fnum(e.h)); w(1, e.str);
      if (e.rot) w(50, deg(e.rot));
    } else if (e.type === 'point') {
      w(0, 'POINT'); common(e);
      w(10, fnum(e.x)); w(20, fnum(e.y)); w(30, '0.0');
    }
  }
  w(0, 'ENDSEC');
  w(0, 'EOF');
  return out.join('\r\n') + '\r\n';
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseDXF, writeDXF, aciToHex };
}
