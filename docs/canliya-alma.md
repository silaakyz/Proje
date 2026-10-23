# Canlıya alma (tek sunucu, Docker, PostgreSQL)

Bu belge uygulamayı **tek bir Linux sunucuda** çalıştırmayı anlatır: PostgreSQL 16 (pgvector), uygulama, otomatik
HTTPS (Caddy) ve günlük veritabanı yedeği aynı `docker-compose.prod.yml` dosyasıyla kalkar. Supabase veya başka
bir yönetilen servis gerekmez.

```
İnternet ──443/80──▶ caddy (HTTPS) ──▶ app (Next.js, :3000) ──▶ db (PostgreSQL 16 + pgvector)
                                                                  ▲
                                         migrate (tek seferlik) ──┤   backup (her gece pg_dump → ./backups)
```

- Dışarıya yalnızca Caddy açılır (80/443). Veritabanı ve uygulama yalnızca iç ağdadır.
- Migration'ları veritabanı süper kullanıcısı (`POSTGRES_USER`, varsayılan `eip_owner`) çalıştırır.
  Uygulama ayrı ve **en az yetkili** `eip_app` rolüyle bağlanır: tablo yapısını değiştiremez, rol veya
  veritabanı oluşturamaz (`scripts/db/app-role.mjs`).
- Uygulama her açılışta `migrate` servisi başarıyla bitmeden başlamaz.

## 1. Gerekenler

| | |
|---|---|
| Sunucu | Ubuntu 24.04 LTS (veya güncel Debian), en az 2 vCPU, 4 GB RAM, 40 GB disk. KVKK için yurt içi veri merkezi önerilir. |
| Alan adı | Örn. `etkinlik.kurum.gov.tr`; DNS **A** kaydı sunucunun IP adresini göstermeli. |
| Portlar | 22 (SSH), 80 ve 443 açık; başka port açmayın. |
| Yapay zekâ anahtarı | Gemini (Google AI Studio) veya Anthropic. Gerçek kurum verisi için **ücretli** plan önerilir: Gemini'nin ücretsiz katmanında Google istemleri kendi ürünlerini geliştirmek için kullanabilir. |

## 2. Kodu GitHub'a koyun (bir kez, kendi bilgisayarınızda)

Proje klasörü (D:\Proje) şu an bir git deposu değil. GitHub'da **özel (private)** bir depo açın, sonra:

```bash
cd D:\Proje
git init
git add -A
git status            # .env görünmemeli (.gitignore dışarıda tutar); görünürse durun
git commit -m "İlk sürüm"
git branch -M main
git remote add origin https://github.com/<kurum>/<depo>.git
git push -u origin main
```

`.env`, `.env.production`, `backups/` ve `secrets/` `.gitignore` ile dışarıda kalır. Sırları asla commit'lemeyin.

## 3. Sunucuyu hazırlayın

```bash
# Docker ve Compose eklentisi (resmi kurulum betiği)
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER && newgrp docker

# Güvenlik duvarı: yalnızca SSH ve web
sudo ufw allow OpenSSH && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw allow 443/udp
sudo ufw enable

# Kodu alın
git clone https://github.com/<kurum>/<depo>.git /opt/eip
cd /opt/eip
```

## 4. Ayarlar: `.env.production`

```bash
cp deploy/env.production.example .env.production
chmod 600 .env.production
openssl rand -hex 32     # POSTGRES_PASSWORD için
openssl rand -hex 32     # APP_DB_PASSWORD için (farklı olsun)
nano .env.production
```

Doldurulması zorunlu olanlar: `DOMAIN`, `ACME_EMAIL`, `POSTGRES_PASSWORD`, `APP_DB_PASSWORD` ve bir yapay zekâ
anahtarı (`GOOGLE_GENERATIVE_AI_API_KEY` veya `AI_PROVIDER=anthropic` + `ANTHROPIC_API_KEY`).
Şifreler bağlantı adresinin içinde kullanıldığı için `openssl rand -hex 32` ile üretilen harf-rakam değerleri kullanın.

`DEMO_EMAIL` / `DEMO_PASSWORD` **eklemeyin**: canlıda "Demo Olarak Devam Et" düğmesi görünmemeli.

Google Analytics 4 bağlanacaksa servis hesabı JSON dosyasını `secrets/ga4.json` olarak koyun ve
`GA4_SERVICE_ACCOUNT_FILE=/run/secrets/ga4.json` yazın (`secrets/` klasörü uygulamaya salt okunur bağlanır).

## 5. Başlatın

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
docker compose -f docker-compose.prod.yml --env-file .env.production ps
docker compose -f docker-compose.prod.yml --env-file .env.production logs migrate   # "migrations applied successfully" ve "created eip_app"
```

Uzun komutu kısaltmak için sunucuda bir kısayol tanımlayabilirsiniz:

```bash
echo "alias eip='docker compose -f /opt/eip/docker-compose.prod.yml --env-file /opt/eip/.env.production'" >> ~/.bashrc && source ~/.bashrc
# sonra: eip ps · eip logs -f app · eip restart app
```

Birkaç dakika içinde `https://<DOMAIN>` açılır (Caddy sertifikayı otomatik alır). Kontrol:
`curl -s https://<DOMAIN>/api/health` → `{"ok":true}`.

## 6. İlk hesap ve kurum

`https://<DOMAIN>/giris?durum=kayit` adresinden (giriş sayfasındaki "Kayıt Olun") kayıt olun. Ardından açılan
Kurulum sayfasında kurum adı ve türü sorulur; bu hesap kurumun **sahibi** olur. Ekip arkadaşlarını Ekip sayfasından davet edin.

Sunuma hazır örnek veri istiyorsanız (canlı kurumdan ayrı bir hesapla):

```bash
eip run --rm -e DEMO_EMAIL=demo@kurum.gov.tr -e DEMO_PASSWORD='<güçlü şifre>' migrate npm run demo:seed
```

## 7. Güncelleme

```bash
cd /opt/eip
git pull
eip up -d --build        # yeni imaj, migration'lar ve rol yetkileri otomatik; ardından uygulama yeniden başlar
eip logs --tail 50 migrate app
```

Migration'lar tek işlemde (transaction) uygulanır: hata olursa hiçbiri uygulanmaz, yeni uygulama sürümü başlatılmaz
ve `eip logs migrate` hatayı açıkça gösterir. Güncellemelerden önce elle yedek alın (aşağıda).

## 8. Yedekleme ve geri yükleme

`backup` servisi her gece `BACKUP_HOUR` saatinde (varsayılan 03:00) `./backups/eip-YYYYmmdd-HHMM.dump` dosyası
üretir ve `BACKUP_KEEP_DAYS` günden (varsayılan 14) eski olanları siler.

```bash
# Hemen bir yedek
eip run --rm -e BACKUP_NOW=1 backup

# Yedekleri sunucu dışına da kopyalayın (aynı diskte duran yedek, disk arızasında kaybolur), örn. kendi bilgisayarınıza:
scp kullanici@sunucu:/opt/eip/backups/eip-*.dump .
```

Geri yükleme (mevcut verinin üzerine yazar):

```bash
eip stop app
eip exec -T db pg_restore -U eip_owner -d eip --clean --if-exists --no-owner < backups/eip-20261023-0300.dump
eip run --rm migrate      # şemayı doğrular ve eip_app yetkilerini yeniden verir
eip start app
```

Ayda bir, bir yedeği boş bir veritabanına geri yükleyip açılıyor mu deneyin.

## 9. İzleme ve sorun giderme

| Ne | Komut |
|---|---|
| Servislerin durumu | `eip ps` (app satırında `healthy` görünmeli) |
| Uygulama günlüğü | `eip logs -f app` |
| Migration hatası | `eip logs migrate` |
| HTTPS / sertifika | `eip logs caddy` |
| Veritabanına bağlanmak | `eip exec db psql -U eip_owner -d eip` |
| Dış veri kaynaklarını elle çekmek | `eip run --rm migrate npm run connectors:pull` |

Dış veri kaynakları (hava kalitesi, Brevo, GA4, Meta, YouTube, basın) uygulama çalıştığı sürece
`CONNECTORS_SYNC_INTERVAL_MINUTES` aralığıyla kendiliğinden çekilir; ayrı bir zamanlayıcı gerekmez.

## 10. Güvenlik özeti

- Sunucuya yalnızca SSH anahtarıyla girin (`PasswordAuthentication no`), işletim sistemi güncellemelerini açık tutun
  (`sudo apt install unattended-upgrades`).
- `.env.production` yalnızca sunucuda durur (`chmod 600`); GitHub'a gitmez.
- Uygulama veritabanına süper kullanıcı olarak değil `eip_app` olarak bağlanır; veritabanı portu dışarı açık değildir.
- HTTPS zorunludur (HSTS); oturum çerezleri HTTPS üzerinde `Secure` ve `HttpOnly` gönderilir.
- Herkese açık anket bağlantıları hız sınırına tabidir; sınır sayaçları da PostgreSQL'dedir.

## Yönetilen PostgreSQL kullanılacaksa

Veritabanını ayrı bir yönetilen servisten (bulut sağlayıcının PostgreSQL hizmeti) almak isterseniz:

- PostgreSQL 15+ ve `vector` (pgvector) eklentisi desteklenmeli.
- `bootstrap.sql` rol, şema ve eklenti oluşturur; `app-role.mjs` **BYPASSRLS** yetkili bir rol oluşturur. Bazı
  yönetilen servisler bunlara izin vermez. Önce `npm run db:preflight` ile kontrol edin; gerekirse servisin yönetici
  kullanıcısıyla bir kez elle hazırlanır.
- `docker-compose.prod.yml`'den `db` ve `backup` servislerini çıkarın; `migrate` için `DATABASE_URL`/`DIRECT_URL`'i
  servisin yönetici bağlantısına, `app` için `DATABASE_URL`'i `eip_app` bağlantısına (SSL ile) çevirin. Yedekleme
  servisin kendi yedekleme özelliğiyle yapılır.
