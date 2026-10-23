# Veri kaynakları — kurulum

Etkinlik → **Veri Kaynakları** sekmesinden her etkinlik için hangi hesabın okunacağı ayarlanır. Servislerin erişim
anahtarları ise yalnızca sunucudaki `.env` dosyasında durur (veritabanına veya tarayıcıya gitmez). `.env` değişince
`npm run dev` / `npm start` yeniden başlatılmalıdır.

Kaynaklar etkinlik başlangıcından 60 gün önce ile bitişinden 30 gün sonrası arasında, uygulama açıkken
`CONNECTORS_SYNC_INTERVAL_MINUTES` (varsayılan 60) dakikada bir kendiliğinden çekilir. Bilgisayar sürekli açık
değilse Windows Görev Zamanlayıcı'ya `npm run connectors:pull` komutunu ekleyebilirsiniz (proje klasöründe çalışmalı).

| Kaynak | Anahtar | Nereden alınır | Etkinlik ayarı |
|---|---|---|---|
| Hava kalitesi (Open-Meteo) | gerekmez | — | şehir (boşsa etkinlik profilindeki şehir) veya koordinat |
| Basın taraması (GDELT, Google News) | gerekmez | — | aranacak ifadeler (boşsa etkinlik adı) |
| E-posta (Brevo) | `BREVO_API_KEY` | app.brevo.com → SMTP & API → API Keys → "Generate a new API key" | kampanya kimlikleri (kampanya adresindeki sayı) |
| Web sitesi (GA4) | `GA4_SERVICE_ACCOUNT_FILE` | aşağıda | mülk kimliği, açılış sayfası yolu, kayıt olayı adı |
| Instagram + Facebook (Meta) | `META_ACCESS_TOKEN` | aşağıda | Instagram işletme hesabı kimliği, Facebook sayfa kimliği, hashtag'ler |
| YouTube | `YOUTUBE_API_KEY` | console.cloud.google.com → API'ler → "YouTube Data API v3" etkinleştir → Kimlik bilgileri → API anahtarı | video bağlantıları veya kanal kimliği |
| Sponsor / lead | — | sekmedeki şablonla CSV | — |

**Google Analytics 4**
1. console.cloud.google.com → yeni proje → "Google Analytics Data API"yi etkinleştirin.
2. IAM → Hizmet hesapları → hesap oluşturun → Anahtarlar → JSON anahtar indirin. Dosyayı proje klasörünün **dışına**
   koyun (örn. `D:\anahtarlar\ga4.json`) ve `.env`'e `GA4_SERVICE_ACCOUNT_FILE=D:\anahtarlar\ga4.json` yazın.
3. Google Analytics → Yönetici → Mülk erişim yönetimi → hizmet hesabının e-postasını **Görüntüleyici** olarak ekleyin.
4. Mülk kimliği: Yönetici → Mülk ayarları (yalnızca rakamlar).

**Meta (Instagram + Facebook)**
1. Instagram hesabı **işletme / içerik üreticisi** hesabı olmalı ve bir Facebook sayfasına bağlı olmalı.
2. developers.facebook.com → uygulama oluşturun; Graph API Explorer'da sayfanızı seçip şu izinlerle **Sayfa erişim
   belirteci** alın: `instagram_basic`, `instagram_manage_insights`, `pages_read_engagement`, `read_insights`.
   Kısa ömürlü belirteci uzun ömürlüye çevirin (Access Token Debugger → "Extend").
3. Instagram işletme hesabı kimliği: Explorer'da `me/accounts?fields=instagram_business_account`.
4. Hashtag araması son 24 saati döndürür ve Meta haftada 30 farklı hashtag'e izin verir; anılma sayısı düzenli
   çekimlerle birikir.

**Notlar**
- Open-Meteo ücretsiz kullanımı ticari olmayan amaçlarla ve günde 10.000 istekle sınırlıdır; ticari kullanımda
  abonelik gerekir. Veri Copernicus CAMS modelidir, istasyon ölçümü değildir.
- E-posta açılma oranı Apple Mail gizlilik koruması nedeniyle şişebilir; tıklama oranını birincil alın.
- Basın taraması aday getirir; yalnızca sizin onayladığınız haberler sayılır.
- Lead CSV'sine ad, e-posta veya telefon koymayın; bu sütunlar yüklemede otomatik atılır. Takma bir lead kimliği kullanın.
