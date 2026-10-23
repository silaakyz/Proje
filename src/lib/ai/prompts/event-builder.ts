import type { EventConfigDraft } from "@/lib/ai/schemas/event-config";

export const EVENT_BUILDER_PROMPT_VERSION = "event-builder/2026-10-16";

/**
 * Few-shot example. Kept as typed data so `tsc` breaks the build if the schema drifts
 * away from the example the model is shown.
 */
const EXAMPLE_INPUT =
  "Ankara'da 2027 Mart ayında 2 günlük bir sağlık bilişimi kongresi. 300 kişi. " +
  "Hekimler 2.500 TL, asistan hekimler 750 TL. Sadece ikinci güne katılmak isteyenler için 1.000 TL'lik günlük bilet. " +
  "Kurum ve unvan bilgisi almak istiyorum.";

const EXAMPLE_OUTPUT: EventConfigDraft = {
  event: {
    title: "Ankara Sağlık Bilişimi Kongresi 2027",
    summary: "Mart 2027'de Ankara'da düzenlenecek iki günlük sağlık bilişimi kongresi.",
    format: "CONGRESS",
    deliveryMode: "IN_PERSON",
    primaryLanguage: "tr",
    bilingual: false,
    city: "Ankara",
    venueName: null,
    startDate: null,
    durationDays: 2,
    dailyStartTime: null,
    dailyEndTime: null,
    expectedAttendance: 300,
    capacity: null,
  },
  ticketTypes: [
    {
      key: "physician", name: "Hekim", description: null, pricing: "PAID", priceAmount: 2500,
      currency: "TRY", quantity: null, maxPerOrder: null, requiresApproval: false,
      eligibility: null, validDayIndexes: [],
    },
    {
      key: "resident_physician", name: "Asistan Hekim", description: null, pricing: "PAID", priceAmount: 750,
      currency: "TRY", quantity: null, maxPerOrder: null, requiresApproval: true,
      eligibility: "Asistanlık belgesi gereklidir.", validDayIndexes: [],
    },
    {
      key: "day_2_pass", name: "2. Gün Bileti", description: null, pricing: "PAID", priceAmount: 1000,
      currency: "TRY", quantity: null, maxPerOrder: null, requiresApproval: false,
      eligibility: null, validDayIndexes: [1],
    },
  ],
  formFields: [
    {
      key: "institution", type: "SHORT_TEXT", label: "Kurum", labelEn: null, helpText: null,
      required: true, options: null, maxLength: 150, visibleForTicketKeys: [], isSensitive: false,
      origin: "EXPLICIT", rationale: "Kullanıcı kurum bilgisini istedi.",
    },
    {
      key: "title", type: "SINGLE_SELECT", label: "Unvan", labelEn: null, helpText: null, required: true,
      options: [
        { value: "prof_dr", label: "Prof. Dr.", labelEn: null },
        { value: "doc_dr", label: "Doç. Dr.", labelEn: null },
        { value: "dr_ogr_uyesi", label: "Dr. Öğr. Üyesi", labelEn: null },
        { value: "uzm_dr", label: "Uzm. Dr.", labelEn: null },
        { value: "dr", label: "Dr.", labelEn: null },
        { value: "other", label: "Diğer", labelEn: null },
      ],
      maxLength: null, visibleForTicketKeys: [], isSensitive: false, origin: "EXPLICIT",
      rationale: "Kullanıcı unvan bilgisini istedi; tıp unvanları sabit bir listedir.",
    },
    {
      key: "residency_document", type: "FILE_UPLOAD", label: "Asistanlık belgesi", labelEn: null,
      helpText: "PDF veya görsel, en fazla 5 MB.", required: true, options: null, maxLength: null,
      visibleForTicketKeys: ["resident_physician"], isSensitive: false, origin: "INFERRED",
      rationale: "İndirimli bilet uygunluğunun doğrulanması için önerildi.",
    },
  ],
  clarifications: [
    { path: "event.startDate", question: "Kongre Mart 2027'de hangi tarihte başlıyor?", blocking: true },
  ],
  assumptions: [
    "Başlık kullanıcının açıklamasından oluşturuldu.",
    "Asistan hekim bileti belge doğrulaması gerektirdiği için onaylı satış olarak ayarlandı.",
    "Biletler aksi belirtilmediği için KDV dahil fiyat olarak yorumlandı.",
  ],
};

export function buildEventBuilderSystemPrompt(ctx: { today: string; orgName: string; baseConfig?: unknown }): string {
  return [
    `You are the event-configuration engine of a Turkish event-management platform. Today is ${ctx.today} (Europe/Istanbul). The organizer is "${ctx.orgName}".`,
    "",
    "Convert the organizer's request into the JSON object defined by the response schema.",
    "",
    "Hard rules:",
    "1. Extract, do not invent. Dates, prices, venues, quantities and times appear ONLY if the organizer stated them or they follow arithmetically. Otherwise use null and add a clarification.",
    "2. A PAID ticket without a stated price gets priceAmount = null plus a blocking clarification. Never estimate prices.",
    "3. Do not output first name, last name, e-mail, phone or any consent checkbox. The platform adds those.",
    "4. Dietary restrictions, allergies, health or accessibility needs are KVKK special-category data: isSensitive = true.",
    "5. Fields the organizer asked for are EXPLICIT. You may propose at most 3 INFERRED fields, only when they directly support something the organizer said (e.g. student-ID upload for a student ticket). Each needs a rationale.",
    "6. Attendee-facing text is in Turkish unless the event is international. Machine keys are lowercase snake_case ASCII.",
    "7. 'City' is the city name only. Never output province codes or region codes.",
    "8. Every assumption you make goes into `assumptions`, in Turkish.",
    ...(ctx.baseConfig
      ? [
          "",
          "REFINEMENT MODE: the organizer is editing an existing configuration (below). Return the COMPLETE updated configuration. Keep every key, value and ordering the organizer did not ask to change.",
          "<current_config>",
          JSON.stringify(ctx.baseConfig),
          "</current_config>",
        ]
      : []),
    "",
    "<example>",
    `<request>${EXAMPLE_INPUT}</request>`,
    `<response>${JSON.stringify(EXAMPLE_OUTPUT)}</response>`,
    "</example>",
  ].join("\n");
}
