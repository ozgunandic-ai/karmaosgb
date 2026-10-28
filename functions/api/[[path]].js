// KARMA OSGB — R2 veri API'si (Cloudflare Pages Functions)
// Gerekli: R2 bağlantısı  BUCKET  |  ortam değişkenleri  ACCESS_TEAM_DOMAIN, ACCESS_AUD
// Her istek Cloudflare Access JWT'si ile doğrulanır; doğrulanamayan istek reddedilir.

const J = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
});

const b64u = (s) => {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
};

let jwks = { t: 0, keys: null };
async function anahtarlar(team) {
  if (jwks.keys && Date.now() - jwks.t < 3600e3) return jwks.keys;
  const r = await fetch('https://' + team + '/cdn-cgi/access/certs');
  if (!r.ok) throw new Error('certs');
  const j = await r.json();
  jwks = { t: Date.now(), keys: j.keys };
  return j.keys;
}

async function dogrula(request, env) {
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) return null;
  const [h, p, s] = token.split('.');
  if (!h || !p || !s) return null;
  const dec = new TextDecoder();
  const header = JSON.parse(dec.decode(b64u(h)));
  const payload = JSON.parse(dec.decode(b64u(p)));
  if (!payload.exp || payload.exp * 1000 < Date.now()) return null;
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(env.ACCESS_AUD)) return null;
  if (payload.iss !== 'https://' + env.ACCESS_TEAM_DOMAIN) return null;
  const jwk = (await anahtarlar(env.ACCESS_TEAM_DOMAIN)).find((k) => k.kid === header.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64u(s), new TextEncoder().encode(h + '.' + p));
  return ok ? (payload.email || payload.sub || 'bilinmiyor') : null;
}

// "firmalar/abc" gibi yolları denetler; geçersizse null döner
function temizYol(p) {
  if (!p || p.length > 300) return null;
  if (/[\\\x00-\x1f]/.test(p)) return null;
  const parcalar = p.split('/');
  if (parcalar.some((x) => x === '' || x === '.' || x === '..')) return null;
  if (parcalar[0] === '_yedek') return null;
  return p;
}

export async function onRequest({ request, env }) {
  if (!env.BUCKET || !env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) {
    return J({ r2: true, ok: false, hata: 'Sunucu yapılandırması eksik (BUCKET / ACCESS ayarları).' }, 503);
  }
  let kullanici = null;
  try { kullanici = await dogrula(request, env); } catch (e) { kullanici = null; }
  if (!kullanici) return J({ r2: true, ok: false, hata: 'Yetkisiz erişim. Lütfen sayfayı yenileyip giriş yapın.' }, 401);

  const method = request.method;
  // Başka sitelerden gelen istekleri engellemek için yazma isteklerinde özel başlık şart
  if (method !== 'GET' && request.headers.get('X-Karma') !== '1') return J({ hata: 'Geçersiz istek' }, 400);

  let yol = new URL(request.url).pathname.split('/').filter(Boolean).slice(1); // 'api' sonrası
  try { yol = yol.map(decodeURIComponent); } catch (e) { return J({ hata: 'Geçersiz yol' }, 400); }
  const islem = yol.shift();
  const kalan = yol.join('/');

  if (islem === 'ping' && method === 'GET') return J({ r2: true, ok: true, kullanici });

  if (islem === 'doc') {
    const p = temizYol(kalan);
    if (!p) return J({ hata: 'Geçersiz yol' }, 400);
    const key = p + '.json';
    if (method === 'GET') {
      const o = await env.BUCKET.get(key);
      if (!o) return J({ hata: 'Bulunamadı' }, 404);
      return new Response(o.body, { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
    }
    if (method === 'PUT') {
      const metin = await request.text();
      try { JSON.parse(metin); } catch (e) { return J({ hata: 'Geçersiz JSON' }, 400); }
      await env.BUCKET.put(key, metin, { httpMetadata: { contentType: 'application/json' }, customMetadata: { yazan: String(kullanici).slice(0, 100) } });
      return J({ ok: true });
    }
    if (method === 'DELETE') {
      await env.BUCKET.delete(key);
      return J({ ok: true });
    }
    return J({ hata: 'Yöntem desteklenmiyor' }, 405);
  }

  if (islem === 'list' && method === 'GET') {
    const p = temizYol(kalan);
    if (!p) return J({ hata: 'Geçersiz yol' }, 400);
    const ids = [];
    let cursor;
    do {
      const r = await env.BUCKET.list({ prefix: p + '/', delimiter: '/', cursor });
      for (const o of r.objects) {
        const ad = o.key.slice(p.length + 1);
        if (ad.endsWith('.json')) ids.push(ad.slice(0, -5));
      }
      cursor = r.truncated ? r.cursor : undefined;
    } while (cursor);
    return J({ ids });
  }

  if (islem === 'getmany' && method === 'POST') {
    let g;
    try { g = await request.json(); } catch (e) { return J({ hata: 'Geçersiz JSON' }, 400); }
    const yollar = (g && g.paths) || [];
    if (!Array.isArray(yollar) || yollar.length > 40) return J({ hata: 'En fazla 40 kayıt' }, 400);
    const docs = {};
    await Promise.all(yollar.map(async (p) => {
      const t = temizYol(p);
      if (!t) { docs[p] = null; return; }
      const o = await env.BUCKET.get(t + '.json');
      if (!o) { docs[p] = null; return; }
      try { docs[p] = JSON.parse(await o.text()); } catch (e) { docs[p] = null; }
    }));
    return J({ docs });
  }

  return J({ hata: 'Bulunamadı' }, 404);
}
