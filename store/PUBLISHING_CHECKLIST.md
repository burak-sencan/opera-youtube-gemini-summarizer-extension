# Opera Add-ons Yayınlama Checklist

## Zorunlu / Önerilen Dosyalar
- [ ] `manifest.json` doğrulandı (MV3, izinler mantıklı)
- [ ] İkon hazır (en az 128×128) ve mağazaya yüklenecek
- [ ] 1–2 ekran görüntüsü (önerilen 612×408; max 800×600)
- [ ] Kısa özet (1 cümle)
- [ ] Uzun açıklama
- [ ] Gizlilik politikası bağlantısı (önerilir)
- [ ] Destek sayfası (opsiyonel ama önerilir)

## Mağaza Alanları (Öneri)
- **Category**: Productivity veya Reference
- **Summary**: `store/SUMMARY.txt`
- **Description**: `store/DESCRIPTION.md`

## Test
- [ ] YouTube watch sayfasında özet alma
- [ ] Video kartı olan sayfalarda (ana sayfa/abonelikler/arama/kanal listeleri) “Özetle” butonu görünmesi
- [ ] Drawer dışına tıklayınca kapanma
- [ ] Rate limit durumunda başka modele geçiş

## Paketleme
- [ ] Proje klasörünü ZIP’le (node_modules yok)
- [ ] Opera Add-ons Upload formunda ZIP’i yükle
