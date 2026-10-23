/**
 * KVKK (6698 sayılı Kanun) texts of the public registration form. The default privacy notice (aydınlatma metni) is a
 * starting point filled with the organization and event names: the organizer edits it and should have it reviewed by
 * their legal unit. Acknowledging the notice is required to register; the explicit consent (açık rıza) for e-mails
 * after the event is separate, optional and never pre-ticked.
 */
import { z } from "zod";

export function defaultPrivacyNotice(input: { organization: string; event: string; retentionDays: number; collectPhone: boolean }) {
  const data = input.collectPhone ? "ad-soyad, e-posta adresi ve telefon numarası" : "ad-soyad ve e-posta adresi";
  return [
    `KİŞİSEL VERİLERİN İŞLENMESİNE İLİŞKİN AYDINLATMA METNİ — ${input.event}`,
    "",
    `Veri sorumlusu: ${input.organization}. Bu metin, 6698 sayılı Kişisel Verilerin Korunması Kanunu'nun ("KVKK") 10. maddesi uyarınca, etkinlik kaydı sırasında işlenen kişisel verileriniz hakkında sizi bilgilendirmek amacıyla hazırlanmıştır.`,
    "",
    `İşlenen kişisel veriler: Kayıt formunda verdiğiniz ${data}; etkinlik girişinde biletinizin okutulduğu zaman.`,
    "",
    "İşleme amaçları: Etkinlik kaydınızın oluşturulması, biletinizin size iletilmesi, etkinlik girişinin yapılması, etkinliğe ilişkin zorunlu bilgilendirmelerin (saat, yer veya program değişikliği, iptal) gönderilmesi ve katılım istatistiklerinin kişiyi tanımlamayacak biçimde raporlanması.",
    "",
    "Hukuki sebepler: KVKK m. 5/2-c (bir sözleşmenin kurulması veya ifasıyla doğrudan ilgili olması: etkinlik kaydı ve girişi) ve m. 5/2-f (veri sorumlusunun meşru menfaati: etkinlik güvenliği ve organizasyonu). Etkinlik sonrası duyuru ve anket e-postaları yalnızca ayrıca açık rıza vermeniz hâlinde gönderilir (m. 5/1).",
    "",
    "Aktarım: Kişisel verileriniz yalnızca yukarıdaki amaçlarla sınırlı olarak; hizmet aldığımız barındırma (sunucu) sağlayıcısına ve e-posta gönderim hizmeti sağlayıcısına aktarılabilir. E-posta gönderim hizmeti sağlayıcısının sunucuları yurt dışında (Avrupa Birliği) bulunabileceğinden bu aktarım KVKK m. 9 kapsamında yapılır. Verileriniz bunların dışında üçüncü kişilerle paylaşılmaz ve satılmaz.",
    "",
    `Saklama süresi: Kişisel verileriniz etkinliğin bitiminden itibaren ${input.retentionDays} gün sonra silinir. Katılım sayıları kimliğinizi içermeyecek biçimde saklanabilir.`,
    "",
    "Toplama yöntemi: Verileriniz bu çevrimiçi kayıt formu aracılığıyla, elektronik ortamda otomatik yolla toplanır.",
    "",
    `Haklarınız: KVKK m. 11 uyarınca; kişisel verilerinizin işlenip işlenmediğini öğrenme, işlenmişse bilgi talep etme, işlenme amacını ve amacına uygun kullanılıp kullanılmadığını öğrenme, aktarıldığı üçüncü kişileri bilme, eksik veya yanlış işlenmişse düzeltilmesini, KVKK m. 7 çerçevesinde silinmesini veya yok edilmesini isteme, bu işlemlerin aktarıldığı üçüncü kişilere bildirilmesini isteme, münhasıran otomatik sistemlerle analiz edilmesi sonucu aleyhinize bir sonucun ortaya çıkmasına itiraz etme ve kanuna aykırı işleme sebebiyle zarara uğramanız hâlinde zararın giderilmesini talep etme haklarına sahipsiniz. Taleplerinizi ${input.organization} adresine yazılı olarak veya kayıtlı elektronik posta (KEP) ile iletebilirsiniz.`,
  ].join("\n");
}

export const defaultMarketingConsentText = (organization: string) =>
  `${organization} tarafından etkinlik sonrasında değerlendirme anketi ve gelecek etkinlik duyurularının e-posta adresime gönderilmesine açık rıza veriyorum. Bu rızayı dilediğim zaman geri alabilirim.`;

export const registrationFormSchema = z.object({
  organizationId: z.uuid(),
  enabled: z.boolean(),
  ticketType: z.string().trim().min(1).max(60),
  capacity: z.number().int().min(1).max(1_000_000).nullable(),
  opensAt: z.iso.datetime({ offset: true }).nullable(),
  closesAt: z.iso.datetime({ offset: true }).nullable(),
  collectPhone: z.boolean(),
  privacyNotice: z.string().trim().min(50, "Aydınlatma metni en az 50 karakter olmalı.").max(20_000),
  marketingConsentText: z.string().trim().min(10).max(1000).nullable(),
  retentionDays: z.number().int().min(1).max(730),
}).refine((f) => !f.opensAt || !f.closesAt || Date.parse(f.closesAt) > Date.parse(f.opensAt), { message: "Kapanış açılıştan sonra olmalı.", path: ["closesAt"] });

const PHONE = /^[+0-9 ()-]{7,25}$/;
export const registrationSubmitSchema = z.object({
  fullName: z.string().trim().min(2, "Ad soyad en az 2 karakter olmalı.").max(200),
  email: z.email("Geçerli bir e-posta adresi girin.").max(320),
  phone: z.string().trim().regex(PHONE, "Geçerli bir telefon numarası girin.").nullable().default(null),
  /** The notice version the person saw: must still be the current one. */
  noticeVersion: z.number().int().min(1),
  noticeAccepted: z.literal(true, { error: "Aydınlatma metnini okuduğunuzu onaylayın." }),
  marketingConsent: z.boolean().default(false),
});
