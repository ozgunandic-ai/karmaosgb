// KARMA OSGB — Ziyaret Edilmeyen Firma Bildirimi
// Bu betik GitHub Actions tarafından her Cuma 17:00 Türkiye saatinde (14:00 UTC)
// çalıştırılır. Veri deposunun kendi içinde (actions/checkout sonrası) doğrudan
// dosya sisteminden okur; ayrıca bir API isteği gerekmez.
//
// Yerel test için:
//   TEST_BUGUN=2026-09-25 DRY_RUN=1 node ziyaret-bildirimi.mjs
// (TEST_BUGUN verilmezse gerçek "bugün" kullanılır; DRY_RUN=1 verilirse mail
// gönderilmez, yalnızca konsola yazdırılır.)

import fs from 'node:fs';
import path from 'node:path';

const KOK = process.env.VERI_KOK || path.join(process.cwd(), '..', 'data');
const KURU_CALISTIR = String(process.env.DRY_RUN || '') === '1';
const SABIT_ALICI = process.env.SABIT_ALICI || 'info@karmaisg.com';

const BUGUN = process.env.TEST_BUGUN
  ? new Date(process.env.TEST_BUGUN + 'T14:00:00Z')
  : new Date();

function isoTarih(d) {
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
}

function haftaninPazartesisi(d) {
  const gun = d.getUTCDay(); // 0=Pazar,1=Pazartesi,...,5=Cuma,6=Cumartesi
  const fark = gun === 0 ? -6 : (1 - gun);
  const pzt = new Date(d);
  pzt.setUTCDate(d.getUTCDate() + fark);
  return pzt;
}

const GUN_ADI = { 1: 'Pazartesi', 2: 'Salı', 3: 'Çarşamba', 4: 'Perşembe', 5: 'Cuma' };
const ZAMAN_ETIKET = { sabah: 'Öğleden önce', ogleden_sonra: 'Öğleden sonra', tam_gun: 'Tüm gün' };

function oku(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}

function firmalarYukle() {
  const dizin = path.join(KOK, 'firmalar');
  const map = new Map();
  if (!fs.existsSync(dizin)) return map;
  for (const dosya of fs.readdirSync(dizin)) {
    if (!dosya.endsWith('.json')) continue;
    const veri = oku(path.join(dizin, dosya));
    if (veri) map.set(dosya.replace(/\.json$/, ''), veri);
  }
  return map;
}

function haftaGunleriHesapla(bugun) {
  const pzt = haftaninPazartesisi(bugun);
  const gunler = [];
  for (let i = 0; i < 5; i++) {
    const g = new Date(pzt);
    g.setUTCDate(pzt.getUTCDate() + i);
    gunler.push(isoTarih(g));
  }
  return gunler;
}

function kullaniciIcinSatirlarBul(ku, yil, haftaGunleri, firmalarMap) {
  const ziyaret = oku(path.join(KOK, 'ziyaret', ku, yil + '.json'));
  if (!ziyaret || !ziyaret.gunler) return [];
  const satirlar = [];
  for (const tarihISO of haftaGunleri) {
    const gun = ziyaret.gunler[tarihISO];
    if (!gun) continue;
    const haftaGunuNo = new Date(tarihISO + 'T00:00:00Z').getUTCDay();
    const gunAdi = GUN_ADI[haftaGunuNo] || tarihISO;
    for (const zamanKey of ['sabah', 'ogleden_sonra', 'tam_gun']) {
      for (const giris of (gun[zamanKey] || [])) {
        if (giris.durum !== 'gerçekleşti') {
          const firma = firmalarMap.get(giris.firmaId);
          satirlar.push({
            tarihISO, gunAdi,
            tarihGoruntu: tarihISO.split('-').reverse().join('.'),
            zaman: ZAMAN_ETIKET[zamanKey] || zamanKey,
            firmaAdi: firma ? firma.unvan : '(silinmiş firma)',
            durum: giris.durum === 'gerçekleşmedi' ? 'Gerçekleşmedi' : 'Durum girilmedi'
          });
        }
      }
    }
  }
  return satirlar;
}

function epostaGovdesi(kullanici, satirlar) {
  const liste = satirlar.map(function (s) {
    return '- ' + s.gunAdi + ' (' + s.tarihGoruntu + ') — ' + s.firmaAdi + ' — ' + s.zaman + ' — ' + s.durum;
  }).join('\n');
  return 'Sayın ' + (kullanici.adSoyad || kullanici.kullanici) + ',\n\n' +
    'Bu hafta aşağıdaki firma ziyaretleri "gerçekleşti" olarak işaretlenmedi:\n\n' +
    liste +
    '\n\nBu bildirim KARMA OSGB Doküman Yönetimi tarafından otomatik olarak gönderilmiştir.';
}

async function transporterOlustur() {
  const nodemailer = await import('nodemailer');
  return nodemailer.default.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || 'false') === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
}

async function ana() {
  const firmalarMap = firmalarYukle();
  const kullanicilarDizin = path.join(KOK, 'users');
  if (!fs.existsSync(kullanicilarDizin)) { console.log('Kullanıcı verisi bulunamadı (' + kullanicilarDizin + '); çıkılıyor.'); return; }

  const yil = BUGUN.getUTCFullYear();
  const haftaGunleri = haftaGunleriHesapla(BUGUN);
  console.log('Kontrol edilen hafta:', haftaGunleri.join(', '));

  const gonderilecekler = [];
  for (const dosya of fs.readdirSync(kullanicilarDizin)) {
    if (!dosya.endsWith('.json')) continue;
    const ku = dosya.replace(/\.json$/, '');
    const kullanici = oku(path.join(kullanicilarDizin, dosya));
    if (!kullanici || kullanici.aktif === false) continue;
    const satirlar = kullaniciIcinSatirlarBul(ku, yil, haftaGunleri, firmalarMap);
    if (satirlar.length) gonderilecekler.push({ ku, kullanici, satirlar });
  }

  if (!gonderilecekler.length) { console.log('Bu hafta bildirilecek ziyaret yok.'); return; }

  let transporter = null;
  if (!KURU_CALISTIR) transporter = await transporterOlustur();

  for (const { ku, kullanici, satirlar } of gonderilecekler) {
    const aliciSet = new Set([SABIT_ALICI]);
    if (kullanici.eposta) aliciSet.add(kullanici.eposta);
    const alicilar = Array.from(aliciSet).join(', ');
    const govde = epostaGovdesi(kullanici, satirlar);

    if (KURU_CALISTIR) {
      console.log('--- KURU ÇALIŞTIRMA (mail gönderilmedi) ---');
      console.log('Kullanıcı:', ku, '| Alıcılar:', alicilar);
      console.log(govde);
      console.log('-------------------------------------------');
      continue;
    }

    try {
      await transporter.sendMail({
        from: process.env.MAIL_FROM || process.env.SMTP_USER,
        to: alicilar,
        subject: 'ZİYARET EDİLMEYEN FİRMA BİLDİRİMİ',
        text: govde
      });
      console.log('Gönderildi:', ku, '->', alicilar);
    } catch (err) {
      console.error('HATA (' + ku + '):', err.message);
      process.exitCode = 1;
    }
  }
}

ana().catch(function (err) { console.error(err); process.exit(1); });
