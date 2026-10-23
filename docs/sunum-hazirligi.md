# MVP sunumu: kurulum ve akış

Arayüz, Figma Make dosyasındaki ("Design Live Event OS Platform") tasarımın Next.js'e taşınmış hâlidir.
Bütün ekranlar gerçek API'ye bağlıdır; örnek veri, `npm run demo:seed` ile uygulamanın kendi servisleri
üzerinden veritabanına yazılır.

## 1. Bir kez yapılacaklar

Uygulama yalnızca PostgreSQL kullanır: hesaplar, oturumlar, hız sınırları ve bütün veriler aynı
veritabanındadır. Supabase veya Upstash gerekmez.

1. **PostgreSQL (pgvector ile):** En kolayı Docker Desktop. `.env` dosyasına bir `POSTGRES_PASSWORD`
   yazın, ardından `docker compose up -d db` (veya `npm run db:up`). Bu, yalnızca bu bilgisayardan
   erişilebilen `localhost:5432` üzerinde `eip` adlı bir veritabanı açar.
2. **`.env` dosyası** (örnekleri `.env.example` içinde):
   - `DATABASE_URL=postgresql://eip:<POSTGRES_PASSWORD ile aynı>@localhost:5432/eip`
     (şifrede `@`, `#`, `ı` gibi karakterler varsa yüzde kodlaması yapın: `@` → `%40`).
   - **Yapay zekâ (ücretsiz: Gemini):** `AI_PROVIDER=google` ve `GOOGLE_GENERATIVE_AI_API_KEY`.
     Anahtarı https://aistudio.google.com adresinde Google hesabıyla giriş yapıp **Get API key → Create API key**
     ile alın; kart bilgisi gerekmez. Plan önerisi, Asistan ve Raporlar bu anahtarla çalışır. Ücretsiz katmanda
     günlük istek sınırı vardır (bir plan önerisi yaklaşık 4 istek); sınır dolunca ekran bunu söyler. Ücretsiz
     katmanda Google gönderilen metinleri ürünlerini geliştirmek için kullanabilir; uygulama kişisel veri göndermez,
     ama plan metnine de kişisel bilgi yazmayın. Claude kullanmak isterseniz `AI_PROVIDER=anthropic` ve
     `ANTHROPIC_API_KEY` girin.
   - `DEMO_EMAIL` ve `DEMO_PASSWORD`: giriş sayfasındaki **Demo Olarak Devam Et** düğmesi bu hesapla
     oturum açar. Şifre tarayıcıya hiç gönderilmez. Boş bırakılırsa düğme görünmez.
   - Artık kullanılmayanlar (silebilirsiniz): `NEXT_PUBLIC_SUPABASE_URL`,
     `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, `UPSTASH_REDIS_REST_URL`,
     `UPSTASH_REDIS_REST_TOKEN`, `PUBLIC_SURVEY_RATE_LIMIT`.
3. **Bağımlılıklar:** `npm install` (Supabase ve Upstash paketleri kaldırıldı).
4. **Veritabanı şeması:** `npm run db:preflight` (yalnızca okur) → engel yoksa `npm run drizzle:migrate`.
   Bu komut önce `scripts/db/bootstrap.sql` dosyasını (pgvector, roller, hesap/oturum tabloları), sonra
   0000–0008 migration'larını uygular. Tekrar çalıştırmak güvenlidir.
5. **Örnek veri:** `npm run demo:seed`. `DEMO_EMAIL` hesabı yoksa `DEMO_PASSWORD` ile kendisi oluşturur,
   ardından örnek kurumu ve etkinlikleri yazar. Bir kez çalışır; tekrar çalıştırırsanız
   "already has the demo events" deyip hiçbir şeyi değiştirmez. Oluşanlar:
   - **Kordon Gastronomi Festivali:** canlı, bugün başlar. 4.820 bilet, 3.175 giriş, 41 iptal,
     420 anket yanıtı, kayıtlı bir etki hesaplaması ve onay bekleyen bir görev kartı.
   - **OZBDA Gençlik ve Teknoloji Haftası:** taslak; KPI ve anket önerileri onay bekliyor.
   - **Ege Kitap Günleri:** tamamlanmış, anketi kapalı.
   - **Kış Sokak Müziği Buluşması:** plan önerisi olmadan oluşturulmuş taslak etkinlik.

   Sentetik anket yanıtları ve planlar sunum için yazılmış örnek verilerdir. Çarpan katsayısı ve
   deadweight/displacement/leakage değerleri **uydurulmaz**; bu yüzden etki hesabı "Harcama"
   seviyesinde kalır. Sunumda bu değerleri kaynaklarıyla siz girerseniz üst seviyeler açılır.

Supabase'deki mevcut veriler yeni veritabanına **taşınmaz**; yeni veritabanı boş başlar ve örnek veri
`demo:seed` ile gelir. Supabase hesaplarının şifreleri de taşınamaz: herkes yeniden kayıt olur.

## 2. Sunum günü

- Docker Desktop açık olsun (`docker compose up -d db`), sonra `npm run dev` → http://localhost:3000 →
  **Demo Olarak Devam Et**.
- Kamera ve panoya kopyalama yalnızca `localhost` veya HTTPS altında çalışır. Telefonla aynı ağdan
  bağlanacaksanız `npx next dev --experimental-https` kullanın.
- Herkese açık anket ve giriş denemeleri veritabanındaki sayaçlarla sınırlandırılır (dakikada 10 hatalı
  giriş denemesi gibi); ayrı bir ayar gerekmez.
- Bir hesabın şifresini unutursanız: `npm run auth:set-password -- adres@ornek.com`.

## 3. Önerilen akış (yaklaşık 10 dakika)

1. **Panel:** canlı etkinlik, anlık katılım sayacı, görev dağılımı ve bekleyen öneriler.
2. **Yeni Etkinlik:** "Örnek metni kullan" → **Plan Önerisi Hazırla**. Önizleme canlı dolar, ardından
   etkinlik profili kartı gelir → **Planı Onayla ve Oluştur**. Görev, KPI ve anket kartları birkaç saniye
   içinde Öneriler sekmesine düşer; maddeleri işaretleyip **Seçilenleri Uygula**.
3. **Kordon Gastronomi Festivali → Görevler:** bir görevi sürükleyip tamamlandıya taşıyın.
4. **Katılımcılar:** 5 bilet oluşturun, ikisini seçip **Yazdırılabilir Biletler** ile QR'ları gösterin.
5. **Check-in:** **Kamerayı Başlat** ile basılı bir QR'ı okutun veya bilet numarasını elle girin.
   Aynı bileti ikinci kez okutunca "zaten kullanıldı" uyarısı çıkar; Panel'deki sayaç anında artar.
6. **Anketler:** **Bağlantıyı Paylaş** → QR'ı telefonla okutup anonim anketi doldurun.
7. **Etki:** hazırlık kontrolleri, kayıtlı hesaplama ve kategori dağılımı. Hesaplama tahmindir ve
   değiştirilemez bir kayıt olarak saklanır.
8. **Asistan / Raporlar:** asistan yalnızca kayıtlı verileri okur ve hiçbir kaydı değiştirmez.
   Raporlar sekmesinde yönetim özeti taslağı hazırlanır.

## 4. Sorun giderme

| Belirti | Neden / çözüm |
|---|---|
| "Demo Olarak Devam Et" görünmüyor | `.env` dosyasında `DEMO_EMAIL` ve `DEMO_PASSWORD` yok; ekledikten sonra sunucuyu yeniden başlatın |
| Demo girişinde "E-posta veya şifre hatalı" | Hesap yok (`npm run demo:seed` çalıştırın) veya `.env` şifresi hesabınkinden farklı (`npm run auth:set-password -- <DEMO_EMAIL>`) |
| Sayfalar "DATABASE_URL is not set" / bağlantı hatası veriyor | `.env` içinde `DATABASE_URL` yok veya PostgreSQL çalışmıyor (`docker compose up -d db`) |
| Plan önerisinde "hizmet yapılandırılmamış" | `GOOGLE_GENERATIVE_AI_API_KEY` (veya Claude için `ANTHROPIC_API_KEY`) boş; ekledikten sonra sunucuyu yeniden başlatın |
| Anket bağlantısı veya giriş 503 veriyor (`next start`) | Veritabanına ulaşılamıyor; PostgreSQL'in çalıştığını kontrol edin |
| Kamera açılmıyor | Tarayıcı izni verilmemiş veya sayfa HTTPS/localhost değil |
