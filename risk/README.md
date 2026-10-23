# KARMA OSGB Risk Değerlendirme Modülü

Sunucu gerektirmeyen web uygulaması. GitHub Pages ile yayınlanır; Excel çıktısı kullanıcının tarayıcısında üretilir.

## Dosyalar
- `index.html`            Arayüz
- `assets/xlsx-report.js` Excel üretimi/okuma (şablon XML'i doğrudan düzenler)
- `assets/jszip.min.js`   JSZip (MIT)
- `data/template.js`      Rapor şablonu (Excel çıktısının temeli)
- `data/activities.js`    Ortak faaliyet kütüphanesi (örnek veriler içerir)

## Ortak faaliyet kütüphanesini güncelleme
1. Sayfada Kütüphane sekmesinden faaliyet Excel'lerini yükleyin (maddeler 11. satırdan, B-R sütunları).
2. "activities.js'i indir" düğmesine basın.
3. İndirilen dosyayı bu depodaki `data/activities.js` üzerine yükleyin (Add file > Upload files > Commit).
Birkaç dakika içinde tüm kullanıcılar yeni kütüphaneyi görür.

## Yerelde deneme
`index.html` dosyasına çift tıklayıp tarayıcıda açabilirsiniz.
