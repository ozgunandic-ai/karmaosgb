// KARMA OSGB — günlük yedek Worker'ı (Cloudflare Workers, ücretsiz plan uyumlu)
// R2'deki  data/  klasörünü  _yedek/YYYY-MM-DD/  altına kopyalar, eski yedekleri siler.
// Ücretsiz plandaki istek sınırına takılmamak için işi her 5 dakikada küçük parçalar hâlinde yapar.
// Gerekli: R2 bağlantısı  BUCKET  (karma-veri)   |   Cron: */5 * * * *

const KAYNAK = 'data/';
const YEDEK = '_yedek/';
const DURUM = '_yedek/_durum.json';
const SAKLA_GUN = 5;   // kaç günlük yedek tutulsun
const PARTI = 20;      // her çalışmada kopyalanacak dosya sayısı (kopya = 2 istek, sınır 50)

async function durumOku(env) {
  const o = await env.BUCKET.get(DURUM);
  if (!o) return null;
  try { return JSON.parse(await o.text()); } catch (e) { return null; }
}

async function durumYaz(env, d) {
  await env.BUCKET.put(DURUM, JSON.stringify(d), { httpMetadata: { contentType: 'application/json' } });
}

// Eski günlerin yedeklerini siler. Bitti ise true döner (istek sınırı için sınırlı sayıda adım atar).
async function temizle(env, bugun) {
  const esik = new Date(Date.now() - SAKLA_GUN * 864e5).toISOString().slice(0, 10);
  let adim = 0;
  const gunler = await env.BUCKET.list({ prefix: YEDEK, delimiter: '/' });
  adim++;
  const eskiler = (gunler.delimitedPrefixes || []).filter((p) => {
    const g = p.slice(YEDEK.length, -1);
    return /^\d{4}-\d{2}-\d{2}$/.test(g) && g < esik;
  });
  for (const p of eskiler) {
    while (adim < 40) {
      const r = await env.BUCKET.list({ prefix: p, limit: 1000 });
      adim++;
      if (!r.objects.length) break;
      await env.BUCKET.delete(r.objects.map((o) => o.key));
      adim++;
      if (!r.truncated) break;
    }
    if (adim >= 40) return false;
  }
  return true;
}

async function calistir(env) {
  const bugun = new Date().toISOString().slice(0, 10); // UTC günü
  let d = await durumOku(env);
  if (!d || d.gun !== bugun) d = { gun: bugun, cursor: null, kopya: 0, bitti: false, temiz: false };

  if (d.bitti) {
    if (!d.temiz) {
      d.temiz = await temizle(env, bugun);
      await durumYaz(env, d);
    }
    return;
  }

  const r = await env.BUCKET.list({ prefix: KAYNAK, limit: PARTI, cursor: d.cursor || undefined });
  await Promise.all(r.objects.map(async (o) => {
    const k = await env.BUCKET.get(o.key);
    if (!k) return;
    await env.BUCKET.put(YEDEK + bugun + '/' + o.key.slice(KAYNAK.length), k.body, { httpMetadata: k.httpMetadata });
  }));
  d.kopya += r.objects.length;
  if (r.truncated) { d.cursor = r.cursor; } else { d.cursor = null; d.bitti = true; }
  await durumYaz(env, d);
}

export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(calistir(env)); },
  async fetch() { return new Response('Bulunamadı', { status: 404 }); }
};
