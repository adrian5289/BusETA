// BusETA 記錄器:每幾分鐘記低巴士大約幾點到站,再估計聽日班次
const KMB = 'https://data.etabus.gov.hk/v1/transport/kmb/';

// 要記錄嘅站(九巴站 ID)同路線
const STOPS = { YL292: 'C187E3771B7032EC', YL255: '8BE58FAD7E9C94C7' };
const WATCH = {
  YL292: ['68E', '68F'],            // 馬田壆
  YL255: ['E36', 'E36S', 'A36']     // 康樂路
};

// 每條線要估計嘅方向(目的地,啱其中一個就得);九巴會同時回傳兩個方向
const AIRPORT = ['機場', '國泰城'];
const HINT = {
  YL292: { '68E': ['青衣'], '68F': ['元朗公園'] },
  YL255: { E36: AIRPORT, E36S: AIRPORT, A36: AIRPORT }
};

const MATCH_MS = 4 * 60e3;   // 前後兩次見到同一架車,ETA 相差唔超過 4 分鐘
const DUE_MS = 2 * 60e3;     // 消失前 ETA 喺 2 分鐘內,當佢已經到站
const KEEP_DAYS = 60;
const LOOK_DAYS = 28;
const HK = 8 * 3600e3;

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS state (k TEXT PRIMARY KEY, v TEXT)',
  'CREATE TABLE IF NOT EXISTS arrivals (stop TEXT, route TEXT, dir TEXT, dest TEXT, arr INTEGER, day TEXT, date TEXT)',
  'CREATE INDEX IF NOT EXISTS idx_arr ON arrivals (stop, route, day, arr)'
];

function hkDate(ms) { return new Date(ms + HK); }
function dayType(ms) { const d = hkDate(ms).getUTCDay(); return d === 0 ? 'H' : d === 6 ? 'S' : 'W'; }
function dateStr(ms) { return hkDate(ms).toISOString().slice(0, 10); }
function normDest(s) { return String(s || '').replace(/[()（）\s]/g, '').replace(/循環線/g, ''); }
function destMatch(dest, hints) {
  const a = normDest(dest);
  return !a || !hints || hints.some(h => { const b = normDest(h); return a.includes(b) || b.includes(a); });
}
function hhmm(min) { const m = Math.round(min); return String(Math.floor(m / 60) % 24).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); }

async function getJson(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally { clearTimeout(t); }
}

async function getState(db, k) {
  const row = await db.prepare('SELECT v FROM state WHERE k = ?').bind(k).first();
  return row ? JSON.parse(row.v) : null;
}
function setState(db, k, v) {
  return db.prepare('INSERT INTO state (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
    .bind(k, JSON.stringify(v));
}

async function ensureSchema(db) {
  await db.batch(SCHEMA.map(s => db.prepare(s)));
}

async function collect(env) {
  const db = env.DB;
  await ensureSchema(db);
  const now = Date.now();
  const pending = (await getState(db, 'pending')) || [];

  const fresh = [], failed = new Set(), seen = new Set();
  await Promise.all(Object.keys(WATCH).map(async code => {
    const id = STOPS[code];
    try {
      const json = await getJson(KMB + 'stop-eta/' + id);
      for (const d of json.data || []) {
        if (!d.eta || !WATCH[code].includes(d.route)) continue;
        const eta = Date.parse(d.eta);
        const key = code + '|' + d.route + '|' + d.dir + '|' + eta;
        if (seen.has(key)) continue;
        seen.add(key);
        fresh.push({ stop: code, route: d.route, dir: d.dir, dest: d.dest_tc, eta });
      }
    } catch (e) { failed.add(code); }
  }));

  // 對返上一次見到嘅車;消失咗而 ETA 又差唔多到,就當佢已經到站
  const used = new Set(), arrived = [], keep = [];
  for (const p of pending) {
    if (failed.has(p.stop)) { keep.push(p); continue; }
    let best = -1, bestD = Infinity;
    fresh.forEach((f, i) => {
      if (used.has(i) || f.stop !== p.stop || f.route !== p.route || f.dir !== p.dir) return;
      const d = Math.abs(f.eta - p.eta);
      if (d <= MATCH_MS && d < bestD) { bestD = d; best = i; }
    });
    if (best >= 0) used.add(best);
    else if (p.eta <= now + DUE_MS) arrived.push({ ...p, arr: Math.min(p.eta, now) });
  }

  const ops = arrived.map(a => db.prepare(
    'INSERT INTO arrivals (stop, route, dir, dest, arr, day, date) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(a.stop, a.route, a.dir, a.dest || '', a.arr, dayType(a.arr), dateStr(a.arr)));
  ops.push(setState(db, 'pending', fresh.concat(keep)));
  ops.push(setState(db, 'lastRun', { ts: now, recorded: arrived.length, failed: [...failed] }));
  const h = hkDate(now);
  if (h.getUTCHours() === 4 && h.getUTCMinutes() < 5) {
    ops.push(db.prepare('DELETE FROM arrivals WHERE arr < ?').bind(now - KEEP_DAYS * 864e5));
  }
  await db.batch(ops);
  return arrived.length;
}

// 將過去同類日子嘅到站時間分組,估計每班車大約幾點到
// 方向:有指定 dir 就用;否則揀目的地啱 HINT 嗰個;都冇就揀記錄最多嗰個
async function predict(db, stop, route, day, now, wantDir) {
  const all = (await db.prepare(
    'SELECT arr, date, dir, dest FROM arrivals WHERE stop = ? AND route = ? AND day = ? AND arr >= ? ORDER BY arr'
  ).bind(stop, route, day, now - LOOK_DAYS * 864e5).all()).results || [];
  let dir = wantDir;
  if (!dir) {
    const hint = (HINT[stop] || {})[route];
    const count = {};
    for (const r of all) if (!hint || destMatch(r.dest, hint)) count[r.dir] = (count[r.dir] || 0) + 1;
    dir = Object.keys(count).sort((a, b) => count[b] - count[a])[0] || null;
  }
  const rows = dir ? all.filter(r => r.dir === dir) : [];
  const dest = rows.length ? rows[rows.length - 1].dest : '';
  const days = new Set(rows.map(r => r.date)).size;
  const pts = rows.map(r => ({ m: ((r.arr + HK) % 864e5) / 60e3, date: r.date })).sort((a, b) => a.m - b.m);

  const clusters = [];
  let cur = null;
  for (const p of pts) {
    if (!cur || p.m - cur[cur.length - 1].m > 4 || p.m - cur[0].m > 10) { cur = [p]; clusters.push(cur); }
    else cur.push(p);
  }
  const need = Math.max(2, Math.ceil(days * 0.4));
  const slots = [];
  for (const c of clusters) {
    const byDate = {};
    for (const p of c) if (!(p.date in byDate)) byDate[p.date] = p.m;
    const ms = Object.values(byDate).sort((a, b) => a - b);
    if (ms.length < need) continue;
    slots.push({ t: hhmm(ms[Math.floor(ms.length / 2)]), min: hhmm(ms[0]), max: hhmm(ms[ms.length - 1]), n: ms.length });
  }
  return { stop, route, dir, dest, day, days, slots };
}

const CORS = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json; charset=utf-8' };
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: CORS });

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(collect(env));
  },

  async fetch(req, env) {
    const url = new URL(req.url);
    const db = env.DB;
    if (!db) return json({ error: '未連接 D1 資料庫(綁定名稱要係 DB)' }, 500);
    try {
      await ensureSchema(db);
      const now = Date.now();
      if (url.pathname === '/predict') {
        const stop = url.searchParams.get('stop');
        const routes = (url.searchParams.get('route') || '').split(',').filter(Boolean);
        const when = url.searchParams.get('day') || 'tomorrow';
        const day = ['W', 'S', 'H'].includes(when) ? when : dayType(now + (when === 'today' ? 0 : 864e5));
        const dir = ['O', 'I'].includes(url.searchParams.get('dir')) ? url.searchParams.get('dir') : null;
        if (!stop || !routes.length) return json({ error: '要提供 stop 同 route' }, 400);
        const out = {};
        for (const r of routes) out[r] = await predict(db, stop, r, day, now, dir);
        return json({ day, routes: out });
      }
      if (url.pathname === '/run') {
        const n = await collect(env);
        return json({ ok: true, recorded: n });
      }
      if (url.pathname === '/status') {
        const c = await db.prepare('SELECT COUNT(*) AS n, COUNT(DISTINCT date) AS d FROM arrivals').first();
        return json({ arrivals: c.n, days: c.d, lastRun: await getState(db, 'lastRun') });
      }
      return json({ ok: true, name: 'BusETA 記錄器', try: ['/status', '/run', '/predict?stop=YL292&route=68E,68F', '/predict?stop=YL255&route=E36,E36S,A36'] });
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500);
    }
  }
};
