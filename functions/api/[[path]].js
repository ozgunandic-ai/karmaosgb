// KARMA OSGB — R2 veri API'si (Cloudflare Pages Functions)
// Gerekli: R2 bağlantısı  BUCKET  |  ortam değişkenleri  ACCESS_TEAM_DOMAIN, ACCESS_AUD
// Her istek Cloudflare Access JWT'si ile doğrulanır; doğrulanamayan istek reddedilir.

// Bucket içinde veriler GitHub veri deposundaki düzenle 'data/' altında durur
const KOK = 'data/';

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

// ---------------------------------------------------------------------------
// Ziyaret kayıtları — salt okunur dış API:  GET /api/ziyaretler?since=<ISO>&limit=500
// Cloudflare Access oturumu yerine  Authorization: Bearer <ZIYARET_ANAHTAR>  ile korunur.
// Gerekli gizli anahtar (secret): ZIYARET_ANAHTAR   (kodda DEĞİL, Cloudflare'de tutulur)
//
// Kaynak veri 'ziyaret/<kullanici>/<yil>' belgeleridir; bir ziyaret silinince belgeden yalnızca çıkar,
// iz kalmaz. "silindi:true" ve "guncellendi" sırası için belge her yazıldığında (PUT/DELETE) eski haliyle
// karşılaştırılır ve değişen kayıtlar _ziyaret/ altında (data/ DIŞINDA; /api/doc ile erişilemez)
// zaman damgalı olay nesneleri olarak tutulur. Böylece GET yalnızca tek bir R2 list çağrısıdır.
// Kayıt sayılan ziyaret: durumu 'gerçekleşti' olan takvim girişi. Planlı/gerçekleşmedi olanlar listeye girmez;
// gerçekleşti işareti kaldırılırsa veya giriş silinirse kayıt silindi:true olarak gelir.
// ---------------------------------------------------------------------------
const IDX_SIRA = '_ziyaret/sira/';   // <damga ISO-ms>~<kayıt id>  (olay nesnesi; veri customMetadata'da)
const IDX_YAN = '_ziyaret/yan/';     // <kullanici>/<yil>.json  (belge başına: id -> son işlenen durum)
const UFUK_MS = 5000;                // yazma sırasındaki kayıtlar yarım görünmesin diye son 5 sn verilmez
const PARTI = 20;                    // bir yazmada indekslenecek en çok kayıt (alt istek sınırı için)
const ZIYARET_YOL = /^ziyaret\/([^/]+)\/(\d{4})$/;
const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ZAMAN_SIFIR = '1970-01-01T00:00:00.000Z';

async function sabitEsit(a, b) {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(String(a))),
    crypto.subtle.digest('SHA-256', enc.encode(String(b)))
  ]);
  const A = new Uint8Array(x), B = new Uint8Array(y);
  let d = 0;
  for (let i = 0; i < A.length; i++) d |= A[i] ^ B[i];
  return d === 0;
}

// null: giriş doğru | Response: reddedildi
async function anahtarDenetle(request, env) {
  if (!env.BUCKET || !env.ZIYARET_ANAHTAR) return J({ hata: 'Sunucu yapılandırması eksik (BUCKET / ZIYARET_ANAHTAR).' }, 503);
  const m = /^Bearer\s+(.+)$/i.exec(request.headers.get('Authorization') || '');
  if (!m || !(await sabitEsit(m[1].trim(), String(env.ZIYARET_ANAHTAR).trim()))) {
    return new Response(JSON.stringify({ hata: 'Yetkisiz erişim.' }), {
      status: 401,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'www-authenticate': 'Bearer' }
    });
  }
  return null;
}

// belge -> { kayitId: { t: tarih, f: firmaId } }  (yalnızca durum 'gerçekleşti')
function gerceklesenler(doc) {
  const m = {};
  const gunler = (doc && doc.gunler) || {};
  for (const t of Object.keys(gunler)) {
    const g = gunler[t] || {};
    for (const z of ['sabah', 'ogleden_sonra', 'tam_gun']) {
      for (const x of (g[z] || [])) {
        if (x && x.id && x.durum === 'gerçekleşti') m[x.id] = { t, f: x.firmaId || '' };
      }
    }
  }
  return m;
}

async function firmaAdiOku(env, f) {
  if (!f || !temizYol('firmalar/' + f)) return '(silinmiş firma)';
  const o = await env.BUCKET.get(KOK + 'firmalar/' + f + '.json');
  if (!o) return '(silinmiş firma)';
  try {
    const d = JSON.parse(await o.text());
    return ((d.kisaAd && String(d.kisaAd).trim()) || d.unvan || '').slice(0, 200);
  } catch (e) { return ''; }
}

async function kullaniciOku(env, ku) {
  if (!temizYol('users/' + ku)) return {};
  const o = await env.BUCKET.get(KOK + 'users/' + ku + '.json');
  if (!o) return {};
  try {
    const d = JSON.parse(await o.text());
    return { eposta: String(d.eposta || '').slice(0, 200), unvan: d.unvan || '' };
  } catch (e) { return {}; }
}

// Bir ziyaret belgesinin son hâlini indekse yansıtır. b.k: bu istekte kalan R2 alt isteği bütçesi.
// Döner: { kalan: 0 } bitti | { kalan: n>0 } n kayıt sonraya kaldı | { kalan: -1 } bütçe yetmedi
async function ziyaretIndeksle(env, ku, yil, doc, b) {
  const yanAnahtar = IDX_YAN + ku + '/' + yil + '.json';
  const yeni = gerceklesenler(doc);
  for (let deneme = 0; deneme < 3; deneme++) {
    if (b.k < 6) return { kalan: -1 };
    b.k--;
    const yo = await env.BUCKET.get(yanAnahtar);
    let yan = { k: {} };
    if (yo) { try { yan = JSON.parse(await yo.text()); } catch (e) { yan = { k: {} }; } }
    if (!yan || !yan.k) yan = { k: {} };
    const eski = yan.k;

    const degisen = [];
    for (const id of Object.keys(yeni)) {
      const e = eski[id];
      if (!e || e.x || e.t !== yeni[id].t || e.f !== yeni[id].f) degisen.push({ id, tur: 'u', t: yeni[id].t, f: yeni[id].f });
    }
    for (const id of Object.keys(eski)) {
      if (!eski[id].x && !yeni[id]) degisen.push({ id, tur: 's', t: eski[id].t, f: eski[id].f });
    }
    if (!degisen.length) return { kalan: 0 };

    // kullanıcı(1) + firmalar(F) + olay yazma(C) + eski silme(1) + yan yazma(1) <= bütçe
    const farkliFirma = (l) => new Set(l.map((x) => x.f)).size;
    const secilen = degisen.slice(0, PARTI);
    while (secilen.length > 1 && 3 + farkliFirma(secilen) + secilen.length > b.k) secilen.pop();
    if (3 + farkliFirma(secilen) + secilen.length > b.k) return { kalan: -1 };

    const firmalar = [...new Set(secilen.map((x) => x.f))];
    const firmaAd = {};
    await Promise.all(firmalar.map(async (f) => { firmaAd[f] = await firmaAdiOku(env, f); }));
    const u = await kullaniciOku(env, ku);
    b.k -= firmalar.length + 1;
    const tur = u.unvan === 'İşyeri Hekimi' ? 'işyeri hekimi ziyareti' : 'iş güvenliği uzmanı ziyareti';

    const t0 = Date.now();   // her kayda ayrı milisaniye: since/sonraki sayfalamasında eşitlik olmasın
    const yazilan = [];
    secilen.forEach((x, i) => { x.damga = new Date(t0 + i).toISOString(); yazilan.push(IDX_SIRA + x.damga + '~' + x.id); });
    await Promise.all(secilen.map((x, i) => env.BUCKET.put(yazilan[i], '', {
      customMetadata: { j: encodeURIComponent(JSON.stringify({ f: firmaAd[x.f], e: u.eposta || '', t: x.t, y: tur, x: x.tur === 's' ? 1 : 0 })) }
    })));
    b.k -= secilen.length;

    const eskiAnahtar = [];
    for (const x of secilen) {
      if (eski[x.id]) eskiAnahtar.push(IDX_SIRA + eski[x.id].s + '~' + x.id);
      yan.k[x.id] = x.tur === 'u' ? { s: x.damga, t: x.t, f: x.f } : { s: x.damga, t: x.t, f: x.f, x: 1 };
    }
    // eşzamanlı iki yazma aynı yan kaydı ezmesin diye koşullu yaz
    const sonuc = await env.BUCKET.put(yanAnahtar, JSON.stringify(yan), {
      onlyIf: yo ? { etagMatches: yo.etag } : { etagDoesNotMatch: '*' },
      httpMetadata: { contentType: 'application/json' }
    });
    b.k--;
    if (!sonuc) { await env.BUCKET.delete(yazilan); b.k--; continue; }   // çakışma: yazdıklarımızı geri al, yeniden dene
    if (eskiAnahtar.length) { await env.BUCKET.delete(eskiAnahtar); b.k--; }
    return { kalan: degisen.length - secilen.length };
  }
  return { kalan: -1 };
}

// /api/doc yazma/silme sonrası çağrılır; indeks hatası kullanıcının kaydını asla bozmaz
async function ziyaretIzle(env, p, veri) {
  const m = ZIYARET_YOL.exec(p);
  if (!m) return;
  try { await ziyaretIndeksle(env, m[1], m[2], veri, { k: 40 }); } catch (e) { console.error('ziyaret indeks hatası', e); }
}

// beklenmeyen hata Cloudflare'in düz '1101' sayfası yerine nedenini gösteren JSON olarak dönsün
async function guvenli(fn) {
  try { return await fn(); } catch (e) {
    console.error('ziyaretler hata', e);
    return J({ hata: 'Sunucu hatası', ayrinti: String((e && e.message) || e).slice(0, 300) }, 500);
  }
}

async function ziyaretlerGet(request, env, url) {
  const red = await anahtarDenetle(request, env);
  if (red) return red;
  let since = ZAMAN_SIFIR;
  const sp = url.searchParams.get('since');
  if (sp) {
    const d = new Date(sp);
    if (isNaN(d.getTime())) return J({ hata: 'since geçerli bir ISO tarih olmalı' }, 400);
    since = d.toISOString();
    if (!ISO_MS.test(since)) return J({ hata: 'since geçerli bir ISO tarih olmalı' }, 400);
  }
  let limit = parseInt(url.searchParams.get('limit') || '500', 10);
  if (!(limit >= 1)) limit = 500;
  limit = Math.min(limit, 500);

  const ufuk = new Date(Date.now() - UFUK_MS).toISOString();
  // since + '~~': aynı damgalı anahtarlar ('damga~id'; id harf/rakam/_/-) bunun öncesinde kalır -> since SONRASI (>) döner
  const r = await env.BUCKET.list({ prefix: IDX_SIRA, startAfter: IDX_SIRA + since + '~~', limit, include: ['customMetadata'] });
  const kayitlar = [];
  for (const o of r.objects) {
    const damga = o.key.slice(IDX_SIRA.length, IDX_SIRA.length + 24);
    if (damga > ufuk) break;
    const id = o.key.slice(IDX_SIRA.length + 25);
    let m = {};
    try { m = JSON.parse(decodeURIComponent((o.customMetadata || {}).j || '')); } catch (e) { m = {}; }
    kayitlar.push({
      id,
      firma_kisaltma: m.f || '',
      personel_eposta: m.e || '',
      tarih: m.t || '',
      sure_dakika: null,      // uygulamada ziyaret süresi tutulmuyor
      tur: m.y || '',
      not: '',                // uygulamada not ziyarete değil firmaya bağlı ("Ziyaret detayı"); ziyaret başına not yok
      guncellendi: damga,
      silindi: m.x === 1
    });
  }
  return J({ kayitlar, sonraki: kayitlar.length ? kayitlar[kayitlar.length - 1].guncellendi : since });
}

// İlk kurulumda (ve nadiren, yarım kalan indekslemeyi tamamlamak için) mevcut ziyaret belgelerini indeksler.
// POST /api/ziyaretler/yenile[?devam=<anahtar>]  -> bitti:false dönerse dönen "devam" ile tekrar çağırın.
async function ziyaretlerYenile(request, env, url) {
  const red = await anahtarDenetle(request, env);
  if (red) return red;
  const b = { k: 44 };
  const ONEK = KOK + 'ziyaret/';
  let devam = url.searchParams.get('devam') || '';
  let son = devam, islenen = 0, bitti = true;
  dis: while (true) {
    b.k--;
    const r = await env.BUCKET.list({ prefix: ONEK, startAfter: devam || undefined, limit: 100 });
    for (const o of r.objects) {
      const m = /^data\/ziyaret\/([^/]+)\/(\d{4})\.json$/.exec(o.key);
      if (!m) { son = o.key; continue; }
      if (b.k < 10) { bitti = false; break dis; }
      b.k--;
      const d = await env.BUCKET.get(o.key);
      let doc = null;
      if (d) { try { doc = JSON.parse(await d.text()); } catch (e) { doc = null; } }
      if (doc) {
        while (true) {
          const s = await ziyaretIndeksle(env, m[1], m[2], doc, b);
          if (s.kalan === 0) break;
          if (s.kalan < 0) { bitti = false; break dis; }
        }
      }
      son = o.key; islenen++;
    }
    if (!r.truncated) break;
    devam = son;
  }
  return J({ islenen, bitti, devam: bitti ? null : son });
}

export async function onRequest({ request, env }) {
  // Dış sistemler için Bearer anahtarlı uç noktalar: Cloudflare Access JWT denetiminden ÖNCE ele alınır
  {
    const u0 = new URL(request.url);
    const y0 = u0.pathname.split('/').filter(Boolean);
    if (y0[0] === 'api' && y0[1] === 'ziyaretler') {
      if (y0.length === 2) return request.method === 'GET' ? guvenli(() => ziyaretlerGet(request, env, u0)) : J({ hata: 'Yöntem desteklenmiyor' }, 405);
      if (y0.length === 3 && y0[2] === 'yenile') return request.method === 'POST' ? guvenli(() => ziyaretlerYenile(request, env, u0)) : J({ hata: 'Yöntem desteklenmiyor' }, 405);
    }
  }
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
    const key = KOK + p + '.json';
    if (method === 'GET') {
      const o = await env.BUCKET.get(key);
      if (!o) return J({ hata: 'Bulunamadı' }, 404);
      return new Response(o.body, { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
    }
    if (method === 'PUT') {
      const metin = await request.text();
      let veri;
      try { veri = JSON.parse(metin); } catch (e) { return J({ hata: 'Geçersiz JSON' }, 400); }
      await env.BUCKET.put(key, metin, { httpMetadata: { contentType: 'application/json' }, customMetadata: { yazan: String(kullanici).slice(0, 100) } });
      await ziyaretIzle(env, p, veri);
      return J({ ok: true });
    }
    if (method === 'DELETE') {
      await env.BUCKET.delete(key);
      await ziyaretIzle(env, p, null);
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
      const r = await env.BUCKET.list({ prefix: KOK + p + '/', delimiter: '/', cursor });
      for (const o of r.objects) {
        const ad = o.key.slice(KOK.length + p.length + 1);
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
      const o = await env.BUCKET.get(KOK + t + '.json');
      if (!o) { docs[p] = null; return; }
      try { docs[p] = JSON.parse(await o.text()); } catch (e) { docs[p] = null; }
    }));
    return J({ docs });
  }

  return J({ hata: 'Bulunamadı' }, 404);
}
