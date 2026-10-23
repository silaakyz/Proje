"use client";

import { Suspense, useEffect, useRef, useState, type FormEvent } from "react";
import { useSearchParams } from "next/navigation";
import { errorMessage } from "@/lib/api/client";
import { postTextStream } from "@/lib/api/stream";
import { useEvents, useOrg } from "@/lib/api/hooks";
import { EVENT_STATUS_LABEL } from "@/lib/ui/labels";
import { InlineNotice, LoadingMark } from "@/components/eip/ui";
import { RichText } from "@/components/eip/rich-text";

type Msg = { role: "user" | "assistant"; content: string };

const SUGGESTIONS = [
  "Geciken operasyon görevlerini özetle",
  "Eksik ölçüm verilerini göster",
  "Ekonomik etki hesaplaması için ne eksik?",
  "Kapı açılışından önce tamamlanması gereken kritik görevleri sırala",
];

function Assistant() {
  const params = useSearchParams();
  const { orgId } = useOrg();
  const events = useEvents();
  const [eventId, setEventId] = useState<string>(params.get("etkinlik") ?? "");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState("");
  const abort = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (eventId || !events.data?.length) return;
    setEventId((events.data.find((e) => e.status === "live") ?? events.data[0])!.id);
  }, [events.data, eventId]);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);
  useEffect(() => () => abort.current?.abort(), []);

  async function send(text: string) {
    const content = text.trim();
    if (!content || streaming) return;
    const history: Msg[] = [...messages, { role: "user", content }];
    setMessages([...history, { role: "assistant", content: "" }]);
    setDraft("");
    setError("");
    setStreaming(true);
    abort.current = new AbortController();
    try {
      await postTextStream(
        "/api/ai/assistant",
        { organizationId: orgId, eventId: eventId || null, mode: "chat", messages: history.slice(-12) },
        (t) => setMessages([...history, { role: "assistant", content: t }]),
        abort.current.signal,
      );
    } catch (e) {
      if ((e as Error)?.name === "AbortError") return;
      setMessages(history);
      setError(errorMessage(e));
    } finally {
      setStreaming(false);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    void send(draft);
  }

  const selected = events.data?.find((e) => e.id === eventId);

  return (
    <main className="assistant-page">
      <header>
        <p className="eyebrow">ETKİNLİK ASİSTANI</p>
        <h1>Bir sonraki adımı birlikte netleştirelim.</h1>
        <p>Sorularınızı doğal bir dille yazın. Asistan yalnızca kayıtlı verileri okur; öneriler resmi kayıtlara siz uygulamadan geçmez.</p>
      </header>

      <label className="assistant-context">
        <span>Bağlam</span>
        <select value={eventId} onChange={(e) => { setEventId(e.target.value); setMessages([]); }}>
          <option value="">Tüm kurum (etkinlik listesi)</option>
          {(events.data ?? []).map((e) => (
            <option value={e.id} key={e.id}>
              {e.title} · {EVENT_STATUS_LABEL[e.status]}
            </option>
          ))}
        </select>
      </label>

      {messages.length > 0 && (
        <section className="assistant-thread" aria-live="polite">
          {messages.map((m, i) => (
            <article className={`assistant-message ${m.role}`} key={i}>
              <p className="eyebrow">{m.role === "user" ? "SİZ" : "ASİSTAN"}</p>
              {m.role === "assistant" ? (
                m.content ? <RichText text={m.content} /> : <p className="muted-text"><LoadingMark /> Kayıtlar okunuyor…</p>
              ) : (
                <p>{m.content}</p>
              )}
            </article>
          ))}
          <div ref={endRef} />
        </section>
      )}

      {error && <InlineNotice tone="error">{error}</InlineNotice>}

      <form className="assistant-composer" onSubmit={submit}>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send(draft);
            }
          }}
          placeholder={selected ? `${selected.title} hakkında sorun. Örn. Açılıştan önce tamamlanması gereken kritik görevleri sırala.` : "Örn. Hangi etkinliklerin hazırlığı geride?"}
          aria-label="Asistana mesaj"
          maxLength={4000}
        />
        {streaming ? (
          <button className="outline-button" type="button" onClick={() => abort.current?.abort()}>
            Durdur
          </button>
        ) : (
          <button className="primary-button" type="submit" disabled={!draft.trim()}>
            Soruyu Gönder
          </button>
        )}
      </form>

      {messages.length === 0 && (
        <section className="assistant-suggestions">
          <p className="eyebrow">ÖNERİLEN BAŞLANGIÇLAR</p>
          <div>
            {SUGGESTIONS.map((s) => (
              <button className="outline-button" type="button" key={s} onClick={() => send(s)} disabled={streaming}>
                {s}
              </button>
            ))}
          </div>
        </section>
      )}

      <div className="assistant-disclaimer">
        Asistan kayıtlı verileri özetler; ekonomik etki rakamları tahmindir ve kayıt numarasıyla birlikte verilir. Yanıtları karar vermeden önce ilgili ekranda doğrulayın.
      </div>
    </main>
  );
}

export default function AssistantPage() {
  return (
    <Suspense>
      <Assistant />
    </Suspense>
  );
}
