YouTube Gemini Summarizer / YouTube Gemini Özetleyici

---

## Türkçe

Bu Opera/Chrome uzantısı YouTube video sayfasındaki içeriği (başlık + açıklama + mümkünse transkript) alır ve Gemini ile özetler. Sonuç, sayfada sağdan açılan bir panelde (drawer) gösterilir.

### Kurulum (Developer Mode ile manuel yükleme)

Chrome
1. `chrome://extensions` sayfasını açın.
2. Sağ üstten **Developer mode** (Geliştirici modu) açın.
3. **Load unpacked** (Paketlenmemiş uzantı yükle) tıklayın.
4. Bu projenin klasörünü seçin (içinde `manifest.json` olmalı).

Opera
1. `opera://extensions` sayfasını açın.
2. **Developer mode** (Geliştirici modu) açın.
3. **Load unpacked** (Paketlenmemiş uzantı yükle) tıklayın.
4. Bu projenin klasörünü seçin.

Not: Kodda değişiklik yaptıktan sonra uzantılar sayfasında **Reload** ile yeniden yükleyin.

### Ayarlar
- Uzantı > Seçenekler kısmından sadece `API Key (Google AI Studio)` girmeniz yeterli.
- `Özet Formatı` ile çıktı tipini seçebilirsiniz: `Özet` veya `Detaylı Özet`.

### Model
- Varsayılan: Otomatik (hesabınıza uygun bir modeli ListModels ile bulup kullanır).
- İsterseniz Ayarlar ekranında listeden bir modeli manuel seçebilirsiniz.

### Kullanım
- YouTube'da bir video açın (watch, shorts veya live sayfası olabilir).
- Uzantı ikonuna tıklayın ve "Videoyu Gemini ile Özetle" düğmesine basın.
- Sonuç, sayfada sağdan açılan panelde (drawer) gösterilir.
- Drawer dışına tıklarsanız panel kapanır (Kapat butonu da vardır).

### Video kartları (YouTube geneli)
- YouTube ana sayfa, abonelikler, arama, kanal listeleri gibi video kartı olan sayfalarda kartın üzerinde "Özetle" butonu görünür.
- Buton kart üzerinde sağ üstte konumlanır ve tek tıkla özet başlatır.
- Buton `watch`, `shorts` ve `live` video bağlantılarını destekler.

### Notlar
- Güvenlik: API anahtarını uzantıda saklamak kolaydır ama daha az güvenlidir.
- Bu sürümde `API Endpoint` ayarı yoktur. Proxy veya özel endpoint istiyorsanız `background.js` içinde istek atılan kısmı uyarlamanız gerekir.

### Yayınlama (Opera Add-ons)

Bu repo içinde mağaza başvurusu için hazır metin şablonları var:
- Kısa özet: `store/SUMMARY.txt`
- Açıklama: `store/DESCRIPTION.md`
- Checklist: `store/PUBLISHING_CHECKLIST.md`
- Gizlilik: `PRIVACY.md`

Gerekli varlıklar
- İkon: en az 128×128 (mağaza yüklemesi için). Kaynak SVG: `assets/icon-source.svg` (PNG’ye çevirip kullanabilirsiniz).
- Screenshot: önerilen 612×408 (max 800×600). En az 1–2 adet.

Paketleme
1. Proje klasörünü ZIP’leyin.
2. Opera Add-ons “Upload Extension” formuna ZIP’i yükleyin.
3. Kategori olarak genelde `Productivity` veya `Reference` uygun olur.

---

## English

This Opera/Chrome extension summarizes YouTube videos using Gemini. It reads the current YouTube page (title + description + transcript when available) and shows the result in an in-page right-side drawer.

### Install (manual load via Developer Mode)

Chrome
1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this project folder (it must contain `manifest.json`).

Opera
1. Open `opera://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this project folder.

Note: After making code changes, go to the extensions page and click **Reload**.

### Settings
- Add your `API Key (Google AI Studio)` in the extension Options.
- Choose one of two output modes: `Summary` or `Detailed Summary`.

### Model
- Default: Automatic (uses ListModels to pick a compatible model for your key).
- Optional: pick a model manually from the Settings list.

### Usage
- Open any YouTube video page (watch, shorts, or live).
- Click the extension icon and press “Summarize with Gemini”.
- The summary is shown in a right-side drawer.
- Clicking outside the drawer closes it.

### Video cards across YouTube
- On pages with video cards (Home, Subscriptions, Search, many Channel lists), a “Summarize” button is shown on each supported card.
- The button is placed near the top-right area of the card and starts summarization in one click.
- It supports `watch`, `shorts`, and `live` links.

### Notes
- Security: storing an API key in an extension is convenient but less secure.
- This version does not expose an `API Endpoint` setting. If you need a proxy/custom endpoint, adjust the request logic in `background.js`.

### Publishing (Opera Add-ons)

Store listing templates:
- Summary: `store/SUMMARY.txt`
- Description: `store/DESCRIPTION.md`
- Checklist: `store/PUBLISHING_CHECKLIST.md`
- Privacy: `PRIVACY.md`

