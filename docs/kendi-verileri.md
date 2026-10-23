# Kendi verileriniz (Excel / CSV)

Etkinlik → **Analizler** → "Kendi verileriniz" bölümünden kurumun kendi tablolarını analize ekleyebilirsiniz.

## Nasıl çalışır

1. **Dosya yükleme** (kurum sahibi / yönetici): `.xlsx`, `.xlsm` veya `.csv`, en fazla 6 MB. Eski `.xls` dosyalarını
   Excel'de "Farklı Kaydet → Excel Çalışma Kitabı (.xlsx)" ile kaydedin. Birden fazla sayfa varsa ilk dolu sayfa okunur;
   diğer sayfalar tek tıkla ayrı tablo olarak eklenir. Gizli sayfalar okunmaz.
2. **Okuma**: başlık satırı (üstteki başlık / boş satırlar atlanarak) bulunur; her sütunun türü (sayı, tarih,
   evet/hayır, metin) belirlenir. Türkçe sayı ("1.234,5") ve tarih ("23.10.2026") biçimleri tanınır.
   "Toplam" satırları ve TOPLA/SUM gibi formüllerin sonuçları iki kez sayılmasın diye alınmaz.
3. **Kişisel veri**: ad-soyad, e-posta, telefon, T.C. kimlik, adres, IBAN gibi sütunlar (başlığından veya içeriğinden
   anlaşılarak) **kaydedilmeden önce** atılır; hangi sütunların atıldığı ekranda yazılır.
4. **Anlamlandırma**: her sütun için bir anlam önerilir — başlık kurallarıyla, yapay zekâ açıksa ek olarak modelle.
   Model yalnızca sütun adlarını ve özet istatistikleri görür, satırları görmez. Öneriler sütun türüyle
   uyuşmuyorsa kullanılmaz.
5. **Onay**: kişi eşleştirmeyi kontrol edip onaylar. Yalnızca onaylanmış tablolar metriklere, Analizler'e,
   Asistan'a ve rapora girer.
6. **Yorum**: "Yorumla" düğmesi, tablodan hesaplanan rakamlarla (toplamlar, dağılım, beslenen metrikler) kısa bir
   değerlendirme yazdırır; model yeni sayı üretmemekle yükümlüdür. Eşleştirme veya veri değişirse yorumun
   güncel olmadığı gösterilir.

## Hangi metrikleri besler

Sütun anlamları (`src/lib/datasets/measures.ts`) katalogdaki metriklere bağlıdır; örnekler:

| Tablo türü | Sütun anlamları | Metrikler |
|---|---|---|
| Atık / karbon | toplam atık, geri dönüşüm, CO₂e, faaliyet × emisyon faktörü | katılımcı başına atık, geri dönüşüm oranı, karbon ayak izi |
| Olay / şikâyet | olay sayısı, şikâyet, çözüm süresi | 1000 kişi başına olay / şikâyet, ortalama çözüm süresi |
| Oturumlar | kayıtlı, katılan, kapasite, puan, zamanında başladı | oturum katılım / doluluk, oturum memnuniyeti, programa uyum |
| Kayıt / giriş | başlayan / tamamlanan kayıt, bekleme listesi, kapıdan kayıt, erken kayıt, bekleme süresi | tamamlama oranı, dönüşüm, payları, check-in süresi |
| Yayın / etkileşim | izleyici, eşzamanlı izleyici, izleme dakikası, soru-cevap, anket | sanal katılım, ortalama izleme, etkileşim oranları |
| Esnaf / tedarik | etkinlik ve normal gün satışı, zamanında teslim | esnaf satış değişimi, tedarikçi dakikliği |

"Gelen" (katılımcı) sayısı check-in kayıtlarıdır; check-in yoksa yüklenen ziyaretçi sayımı kullanılır ve metriğin
notunda bu belirtilir.

## Model ayarı

`.env` içindeki `AI_MODEL_DATA_ANALYSIS` boş bırakılırsa varsayılan model kullanılır (Gemini: gemini-3.8-flash).
Yapay zekâ anahtarı yoksa eşleştirme yalnızca başlık kurallarıyla yapılır ve "Yorumla" düğmesi görünmez.
