// 九巴到站 — 出門提醒推送伺服器 (Cloudflare Worker)
//
// 需要:
//   KV 綁定 REMINDERS
//   Cron Trigger: * * * * *   (每分鐘)
//   (可選) 環境變數 ALLOWED_ORIGIN,預設 https://adrian5289.github.io
//   (可選) 密鑰 BARK_KEY:設定咗就用 Bark app 推送(冇「from ...」),唔再用 Web Push
//
// 流程:網頁 POST 一個提醒 → 每分鐘用九巴實時到站更新班次時間 →
//       到出門時間就推送通知,然後刪除提醒。
// VAPID 金鑰第一次用時自動產生,存喺 KV。

const KMB_ETA = 'https://data.etabus.gov.hk/v1/transport/kmb/stop-eta/';
const BARK_API = 'https://api.day.app/push';
const APP_URL = 'https://adrian5289.github.io/BusETA/';
const LIST_KEY = 'reminders';
const VAPID_KEY = 'vapid';
const MAX_REMINDERS = 50;
const TRACK_WINDOW = 4 * 60000;   // 同一班車嘅到站時間變動範圍
const EXPIRE_AFTER = 2 * 60000;   // 車到咗之後幾耐刪除
const PUSH_HOSTS = /(^|\.)(push\.apple\.com|googleapis\.com|mozilla\.com|mozaws\.net|notify\.windows\.com)$/;

export default {
  async fetch(req, env) {
    const origin = env.ALLOWED_ORIGIN || 'https://adrian5289.github.io';
    const cors = {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    };
    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const url = new URL(req.url);
    try {
      if (req.method === 'GET' && url.pathname === '/vapid') {
        const keys = await vapidKeys(env);
        return json({ publicKey: keys.publicKey, bark: !!env.BARK_KEY });
      }
      if (req.method === 'POST' && url.pathname === '/reminders') {
        const b = await req.json();
        let sub = b.subscription;
        if (env.BARK_KEY) sub = { endpoint: 'bark' };   // 用 Bark 就唔使瀏覽器訂閱
        else {
          if (!sub || typeof sub.endpoint !== 'string' || !sub.keys || !sub.keys.p256dh || !sub.keys.auth)
            return json({ error: 'bad subscription' }, 400);
          if (!PUSH_HOSTS.test(new URL(sub.endpoint).hostname)) return json({ error: 'unsupported push service' }, 400);
          sub = { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } };
        }
        let r;
        if (b.kind === 'alarm') {
          // 定時提醒(例如返工更份):到 at 就推送,唔跟班次
          const at = Number(b.at);
          if (!(at > Date.now() - EXPIRE_AFTER && at < Date.now() + 3 * 864e5)) return json({ error: 'bad time' }, 400);
          r = { id: crypto.randomUUID(), sub, kind: 'alarm', at,
                title: String(b.title || '').slice(0, 40), body: String(b.body || '').slice(0, 80) };
        } else {
          if (!/^[0-9A-F]{16}$/.test(b.stopId || '') || !/^[0-9A-Z]{1,5}$/.test(b.route || '')) return json({ error: 'bad stop' }, 400);
          const t = Number(b.t), buf = Number(b.buf);
          if (!(t > Date.now() - EXPIRE_AFTER) || !(buf >= 0 && buf <= 120)) return json({ error: 'bad time' }, 400);
          r = { id: crypto.randomUUID(), sub, kind: 'bus',
                stopId: b.stopId, route: b.route, stop: String(b.stop || '').slice(0, 40), t, buf };
        }
        // 每部機:一個班次提醒 + 一個定時提醒
        const list = (await loadList(env)).filter(x => !(x.sub.endpoint === r.sub.endpoint && (x.kind || 'bus') === r.kind));
        if (list.length >= MAX_REMINDERS) return json({ error: 'too many reminders' }, 429);
        list.push(r);
        await env.REMINDERS.put(LIST_KEY, JSON.stringify(list));
        return json({ id: r.id, leaveAt: r.kind === 'alarm' ? r.at : r.t - r.buf * 60000 });
      }
      const m = /^\/reminders\/([0-9a-f-]{36})$/.exec(url.pathname);
      if (req.method === 'DELETE' && m) {
        const list = await loadList(env);
        const next = list.filter(x => x.id !== m[1]);
        if (next.length !== list.length) await env.REMINDERS.put(LIST_KEY, JSON.stringify(next));
        return json({ ok: true });
      }
      if (req.method === 'GET' && url.pathname === '/') return json({ ok: true, service: 'kmb-eta-push' });
      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runReminders(env));
  },
};

async function loadList(env) {
  const raw = await env.REMINDERS.get(LIST_KEY);
  return raw ? JSON.parse(raw) : [];
}

async function runReminders(env, now = Date.now()) {
  const list = await loadList(env);
  if (!list.length) return { sent: 0 };

  // 每個站只攞一次實時到站
  const etas = {};
  await Promise.all([...new Set(list.filter(r => r.stopId).map(r => r.stopId))].map(async id => {
    try {
      const res = await fetch(KMB_ETA + id, { cf: { cacheTtl: 20 } });
      if (res.ok) etas[id] = (await res.json()).data || [];
    } catch (e) {}
  }));

  const updated = {}, removed = new Set();
  let sent = 0;
  let keys = null;
  const send = async (r, title, body) => {
    if (r.sub.endpoint === 'bark') return sendBark(env, title, body).catch(() => 0);
    if (env.BARK_KEY) return 0;
    keys = keys || await vapidKeys(env);
    return sendPush(r.sub, { title, body, tag: r.kind || 'leave', url: './' }, keys).catch(() => 0);
  };
  for (const r of list) {
    if (r.kind === 'alarm') {
      if (now > r.at + 10 * 60000) { removed.add(r.id); continue; }   // 錯過咗太耐就唔推
      if (now >= r.at) {
        const status = await send(r, r.title || '夠鐘出門!', r.body || '');
        if (status >= 200 && status < 300) sent++;
        removed.add(r.id);
      }
      continue;
    }
    const near = (etas[r.stopId] || [])
      .filter(d => d.route === r.route && d.eta)
      .map(d => new Date(d.eta).getTime())
      .filter(t => Math.abs(t - r.t) <= TRACK_WINDOW)
      .sort((a, b) => Math.abs(a - r.t) - Math.abs(b - r.t))[0];
    if (near != null && Math.abs(near - r.t) >= 30000) { r.t = near; updated[r.id] = near; }

    if (now > r.t + EXPIRE_AFTER) { removed.add(r.id); continue; }
    if (now >= r.t - r.buf * 60000) {
      const body = r.route + ' ' + hm(r.t) + ' 到站' + (r.stop ? '(' + r.stop + ')' : '');
      const status = await send(r, '夠鐘出門!', body);
      if (status >= 200 && status < 300) sent++;
      removed.add(r.id);   // 成功或者訂閱失效 (404/410) 都唔再試
    }
  }

  if (removed.size || Object.keys(updated).length) {
    // 重新讀一次再寫,避免蓋咗期間新加嘅提醒
    const fresh = await loadList(env);
    const next = fresh.filter(x => !removed.has(x.id)).map(x => (updated[x.id] ? { ...x, t: updated[x.id] } : x));
    await env.REMINDERS.put(LIST_KEY, JSON.stringify(next));
  }
  return { sent, removed: removed.size };
}

function hm(ms) {
  const d = new Date(ms + 8 * 3600e3);   // 香港時間
  return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
}

/* ================= VAPID ================= */
async function vapidKeys(env) {
  const raw = await env.REMINDERS.get(VAPID_KEY);
  if (raw) return JSON.parse(raw);
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const keys = { privateJwk: jwk, publicKey: b64u(pub) };
  await env.REMINDERS.put(VAPID_KEY, JSON.stringify(keys));
  return keys;
}

async function vapidAuth(endpoint, keys) {
  const aud = new URL(endpoint).origin;
  const enc = s => b64u(new TextEncoder().encode(JSON.stringify(s)));
  const unsigned = enc({ typ: 'JWT', alg: 'ES256' }) + '.' +
    enc({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: 'https://adrian5289.github.io/BusETA/' });
  const key = await crypto.subtle.importKey('jwk', keys.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(unsigned)));
  return 'vapid t=' + unsigned + '.' + b64u(sig) + ', k=' + keys.publicKey;
}

/* ================= Web Push 加密 (RFC 8291, aes128gcm) ================= */
async function encryptPayload(sub, payload) {
  const uaPublic = fromB64u(sub.keys.p256dh);
  const authSecret = fromB64u(sub.keys.auth);
  const as = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, as.privateKey, 256));

  const te = new TextEncoder();
  const prkKey = await hmac(authSecret, ecdh);
  const ikm = await hmac(prkKey, concat(te.encode('WebPush: info\0'), uaPublic, asPublic, [1]));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(te.encode('Content-Encoding: aes128gcm\0'), [1]))).slice(0, 16);
  const nonce = (await hmac(prk, concat(te.encode('Content-Encoding: nonce\0'), [1]))).slice(0, 12);

  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const plain = concat(te.encode(payload), [2]);   // 最後一個 record 嘅分隔符
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, plain));

  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, cipher);
}

async function sendBark(env, title, body) {
  const res = await fetch(BARK_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      device_key: env.BARK_KEY, title, body,
      group: '九巴到站', icon: APP_URL + 'BUS.jpg', url: APP_URL,
      // 好似鬧鐘咁:重要提醒(靜音 / 勿擾都會響),鈴聲連續響 30 秒
      level: 'critical', volume: 5, call: '1', sound: 'alarm',
    }),
  });
  return res.status;
}

async function sendPush(sub, data, keys) {
  const body = await encryptPayload(sub, JSON.stringify(data));
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      Authorization: await vapidAuth(sub.endpoint, keys),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: '600',
      Urgency: 'high',
    },
    body,
  });
  return res.status;
}

async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}
function concat(...parts) {
  const arrs = parts.map(p => (p instanceof Uint8Array ? p : new Uint8Array(p)));
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}
function b64u(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64u(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}
