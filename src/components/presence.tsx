import { acceptOfferAction, checkInAction, declineOfferAction, respondAction } from "@/app/actions";
import { Hidden, Pill, When } from "./ui";

export interface PresenceRow {
  id: string;
  startsAt: string | Date;
  response: string;
  seat: string;
  waitlistPosition: number | null;
  offerExpiresAt: string | Date | null;
  checkedInAt: string | Date | null;
  presenceDeadlineHours: number;
  checkinOpensMinutes: number;
  checkinClosesMinutes: number;
  status: string;
}

/** Boutons de présence, offre de place et pointage pour une manche (mobile d'abord). */
export function PresenceControls({ slug, back, r, tz }: { slug: string; back: string; r: PresenceRow; tz: string }) {
  const start = new Date(r.startsAt).getTime();
  const now = Date.now();
  const deadline = start - r.presenceDeadlineHours * 3600000;
  const opens = start - r.checkinOpensMinutes * 60000;
  const closes = start - r.checkinClosesMinutes * 60000;
  const hidden = { slug, back, roundId: r.id };
  const started = now >= start;
  return (
    <div className="stack">
      <div className="row">
        <Pill value={r.response} />
        {r.seat !== "none" && <Pill value={r.seat}>{r.seat === "waitlist" ? `Liste d’attente n°${r.waitlistPosition}` : undefined}</Pill>}
        {r.checkedInAt && <span className="pill ok">Pointé</span>}
      </div>
      {!started && (
        <>
          <form action={respondAction} className="presence" aria-label="Ma présence">
            <Hidden values={hidden} />
            {(
              [
                ["yes", "Présent", "ok"],
                ["maybe", "Incertain", ""],
                ["no", "Absent", "danger"],
              ] as const
            ).map(([v, label, tone]) => (
              <button
                key={v}
                className={`btn ${r.response === v ? tone || "primary" : ""}`}
                name="response"
                value={v}
                aria-pressed={r.response === v}
                disabled={v !== "no" && now > deadline}
              >
                {label}
              </button>
            ))}
          </form>
          <small className="muted" style={{ display: "block" }}>
            Réponse avant le <When date={new Date(deadline)} tz={tz} />
            {now > deadline && " — délai dépassé : vous pouvez encore vous déclarer absent."}
          </small>
        </>
      )}
      {r.seat === "offered" && (
        <div className="notice warn stack">
          <strong>Une place vous est proposée.</strong>
          <span>
            Acceptez avant le <When date={r.offerExpiresAt} tz={tz} />, sinon elle passe au suivant.
          </span>
          <div className="row">
            <form action={acceptOfferAction}>
              <Hidden values={hidden} />
              <button className="btn ok">Accepter la place</button>
            </form>
            <form action={declineOfferAction}>
              <Hidden values={hidden} />
              <button className="btn danger">Décliner</button>
            </form>
          </div>
        </div>
      )}
      {r.seat === "confirmed" && !r.checkedInAt && now >= opens && now <= closes && (
        <form action={checkInAction}>
          <Hidden values={hidden} />
          <button className="btn primary" style={{ width: "100%" }}>
            Je suis là : pointer
          </button>
        </form>
      )}
      {r.seat === "confirmed" && !r.checkedInAt && now < opens && (
        <small className="muted" style={{ display: "block" }}>
          Pointage ouvert du <When date={new Date(opens)} tz={tz} /> au <When date={new Date(closes)} tz={tz} />.
        </small>
      )}
    </div>
  );
}
