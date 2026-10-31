"use server";
// Actions serveur (formulaires). Toute vérification de droits est faite dans les services appelés.
import { timingSafeEqual } from "node:crypto";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { getPool, tx } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { zonedLocalToUtc } from "@/lib/time";
import { clientKey, currentUser, RESET_LINK_COOKIE, SESSION_COOKIE, setSessionCookie } from "@/lib/session";
import { perform, safePath, str, withFlash } from "@/lib/web";
import { needsSetup, changePassword, consumePasswordReset, createPasswordReset, createSession, destroySession, rateLimit, registerUser, updateProfile, verifyLogin } from "@/lib/services/accounts";
import { createCommunity, decideMembership, removeMember, requestJoin, setRole, updateBranding, updateDiscordSettings } from "@/lib/services/community";
import {
  createChampionship,
  createRound,
  deleteSession,
  linkIracingSession,
  parseScoringForm,
  postponeRound,
  setChampionshipStatus,
  setRoundStatus,
  updateChampionship,
  updateRound,
  upsertSession,
  type ChampionshipInput,
  type SessionPlan,
} from "@/lib/services/championships";
import { acceptRules, decideRegistration, registerForChampionship, reorderReserve, withdrawRegistration } from "@/lib/services/registrations";
import { acceptOffer, checkIn, declineOffer, releaseUncheckedSeats, respond, setResponseAsOrganizer } from "@/lib/services/attendance";
import { addCorrection, applyImport, discardImport, importFile, importFromIracingApi, importManual, revokeCorrection, setResultsStatus } from "@/lib/services/results";
import { applyPenalty, decideProtest, fileProtest, revokePenalty, startReview, withdrawProtest } from "@/lib/services/stewarding";
import { requirePermission, roundIn } from "@/lib/services/context";
import { deliverPending, enqueue } from "@/lib/services/notifications";
import type { Community } from "@/lib/services/context";

// ---------- Comptes ----------
export async function loginAction(form: FormData) {
  const next = safePath(str(form, "next"), "/");
  let target = next;
  try {
    const userId = await verifyLogin(getPool(), form.get("email"), form.get("password"), await clientKey());
    await setSessionCookie(await createSession(getPool(), userId));
  } catch (e) {
    target = `/login?next=${encodeURIComponent(next)}&error=${encodeURIComponent(e instanceof AppError ? e.message : "Connexion impossible.")}`;
  }
  redirect(target);
}

export async function setupAction(form: FormData) {
  let target = "/";
  try {
    await rateLimit(getPool(), `setup:${await clientKey()}`, 10, 15);
    const expected = process.env.SETUP_TOKEN ?? "";
    const given = str(form, "token");
    if (!expected || given.length !== expected.length || !timingSafeEqual(Buffer.from(given), Buffer.from(expected))) throw new AppError("Jeton d’installation incorrect.");
    if (str(form, "password") !== str(form, "password2")) throw new AppError("Les mots de passe ne correspondent pas.");
    const slug = str(form, "slug").trim().toLowerCase();
    const userId = await tx(async (db) => {
      // Verrou : deux envois simultanés ne peuvent pas créer deux propriétaires.
      await db.query("LOCK TABLE users IN EXCLUSIVE MODE");
      if (!(await needsSetup(db))) throw new AppError("Installation déjà faite.");
      const id = await registerUser(db, { email: form.get("email"), password: form.get("password"), displayName: form.get("displayName") });
      await createCommunity(db, { slug, name: str(form, "league").trim() || slug }, id!);
      return id!;
    });
    await setSessionCookie(await createSession(getPool(), userId));
    target = `/c/${slug}/admin/settings`;
  } catch (e) {
    target = withFlash("/setup", "error", e instanceof AppError ? e.message : "Installation impossible.");
  }
  redirect(target);
}

export async function registerAccountAction(form: FormData) {
  const next = safePath(str(form, "next"), "/");
  let target = next;
  try {
    await rateLimit(getPool(), `register:${await clientKey()}`, 10, 60);
    if (str(form, "password") !== str(form, "password2")) throw new AppError("Les mots de passe ne correspondent pas.");
    const userId = await tx((db) => registerUser(db, { email: form.get("email"), password: form.get("password"), displayName: form.get("displayName") }));
    await setSessionCookie(await createSession(getPool(), userId!));
  } catch (e) {
    target = `/register?next=${encodeURIComponent(next)}&error=${encodeURIComponent(e instanceof AppError ? e.message : "Inscription impossible.")}`;
  }
  redirect(target);
}

export async function logoutAction() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await destroySession(getPool(), token);
  jar.delete(SESSION_COOKIE);
  redirect("/");
}

export async function profileAction(form: FormData) {
  const user = await currentUser();
  if (!user) redirect("/login?next=/profile");
  let target = "/profile";
  try {
    await tx((db) =>
      updateProfile(db, user.id, {
        displayName: form.get("displayName"),
        avatarUrl: form.get("avatarUrl"),
        iracingCustId: form.get("iracingCustId"),
        preferredNumber: form.get("preferredNumber"),
        country: form.get("country"),
        privateContact: form.get("privateContact"),
      }),
    );
    target = withFlash(safePath(str(form, "back"), "/profile"), "ok", "Profil enregistré.");
  } catch (e) {
    target = withFlash("/profile", "error", e instanceof AppError ? e.message : "Erreur inattendue.");
  }
  redirect(target);
}

export async function passwordAction(form: FormData) {
  const user = await currentUser();
  if (!user) redirect("/login?next=/profile");
  let target = "/login?ok=" + encodeURIComponent("Mot de passe modifié : reconnectez-vous.");
  try {
    if (str(form, "next") !== str(form, "next2")) throw new AppError("Les mots de passe ne correspondent pas.");
    await changePassword(getPool(), user.id, form.get("current"), form.get("next"));
  } catch (e) {
    target = withFlash("/profile", "error", e instanceof AppError ? e.message : "Erreur inattendue.");
  }
  redirect(target);
}

// ---------- Communauté ----------
export async function joinAction(form: FormData) {
  await perform(form, (db, u, c) => requestJoin(db, c.id, u.id, form.get("message")), "Demande envoyée : un organisateur va l’examiner.");
}
export async function resetPasswordAction(form: FormData) {
  const token = str(form, "token");
  let target = withFlash("/profile", "ok", "Mot de passe modifié. Vous êtes connecté.");
  try {
    await rateLimit(getPool(), `reset:${await clientKey()}`, 10, 15);
    if (str(form, "next") !== str(form, "next2")) throw new AppError("Les mots de passe ne correspondent pas.");
    const userId = await tx((db) => consumePasswordReset(db, token, form.get("next")));
    await setSessionCookie(await createSession(getPool(), userId!));
  } catch (e) {
    target = withFlash(`/reset?token=${encodeURIComponent(token)}`, "error", e instanceof AppError ? e.message : "Erreur inattendue.");
  }
  redirect(target);
}

export async function decideMemberAction(form: FormData) {
  await perform(form, (db, u, c) => decideMembership(db, c.id, u.id, str(form, "userId"), str(form, "decision") === "accepted" ? "accepted" : "refused"));
}
export async function setRoleAction(form: FormData) {
  await perform(form, (db, u, c) => setRole(db, c.id, u.id, str(form, "userId"), str(form, "role")), "Rôle modifié.");
}
export async function removeMemberAction(form: FormData) {
  await perform(form, (db, u, c) => removeMember(db, c.id, u.id, str(form, "userId"), form.get("reason")), "Membre retiré.");
}
/** Le lien n'est jamais mis dans l'URL de retour : il passe par un cookie httpOnly de 2 minutes, lu par la page Membres. */
export async function resetLinkAction(form: FormData) {
  await perform(
    form,
    async (db, u, c) => {
      const userId = str(form, "userId");
      const token = await createPasswordReset(db, c.id, u.id, userId);
      const h = await headers();
      const origin = process.env.APP_ORIGIN || `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host")}`;
      (await cookies()).set(RESET_LINK_COOKIE, JSON.stringify({ userId, url: new URL(`/reset?token=${token}`, origin).href }), {
        httpOnly: true,
        secure: process.env.COOKIE_SECURE !== "false",
        sameSite: "strict",
        path: `/c/${c.slug}/admin/members`,
        maxAge: 120,
      });
      return "Lien créé : copiez-le et transmettez-le au membre par un canal privé.";
    },
  );
}
export async function brandingAction(form: FormData) {
  const partners = str(form, "partners")
    .split("\n")
    .map((l) => l.split("|").map((x) => x.trim()))
    .filter((p) => p[0])
    .map(([name, url, logoUrl]) => ({ name, url: url ?? "", logoUrl: logoUrl ?? "" }));
  await perform(
    form,
    (db, u, c) =>
      updateBranding(db, c.id, u.id, {
        name: str(form, "name"),
        tagline: str(form, "tagline"),
        logoUrl: str(form, "logoUrl"),
        primaryColor: str(form, "primaryColor"),
        accentColor: str(form, "accentColor"),
        twitchUrl: str(form, "twitchUrl"),
        discordUrl: str(form, "discordUrl"),
        websiteUrl: str(form, "websiteUrl"),
        partners,
        timezone: str(form, "timezone"),
        joinPolicy: str(form, "joinPolicy"),
      }),
    "Identité de la ligue enregistrée.",
  );
}
export async function discordSettingsAction(form: FormData) {
  await perform(form, (db, u, c) => updateDiscordSettings(db, c.id, u.id, form.get("webhookUrl"), form.get("reminderHours")), "Réglages Discord enregistrés.");
}
export async function announceRoundAction(form: FormData) {
  await perform(form, async (db, u, c) => {
    await requirePermission(db, c.id, u.id, "championship.manage");
    const r = await roundIn(db, c.id, str(form, "roundId"));
    const created = await enqueue(db, c.id, "round_announcement", `announce:${r.id}:${new Date(r.starts_at).getTime()}`, { roundId: r.id });
    return created ? (c.discordConfigured ? "Annonce placée dans la file d’envoi Discord." : "Annonce enregistrée, mais Discord n’est pas configuré : rien ne sera envoyé.") : "Annonce déjà enregistrée pour cet horaire.";
  });
}
export async function deliverNowAction(form: FormData) {
  await perform(
    form,
    async (db, u, c) => {
      await requirePermission(db, c.id, u.id, "community.manage");
      const s = await tx((d) => deliverPending(d, fetch, 20, c.id));
      return `Envoyés : ${s.sent} · non envoyés (Discord non configuré) : ${s.skipped} · en échec : ${s.failed}`;
    },
    "",
    { noTx: true },
  );
}

// ---------- Championnats et manches ----------
function championshipForm(form: FormData, c: Community): ChampionshipInput {
  const deadline = str(form, "registrationDeadline");
  return {
    name: form.get("name"),
    slug: form.get("champSlug"),
    description: form.get("description"),
    rulesMd: form.get("rulesMd"),
    capacity: form.get("capacity"),
    registrationDeadline: deadline ? zonedLocalToUtc(deadline, c.timezone) : null,
    categories: form.get("categories"),
    cars: form.get("cars"),
    requireCategory: form.get("requireCategory"),
    requireCar: form.get("requireCar"),
    requireTeam: form.get("requireTeam"),
    numberPolicy: form.get("numberPolicy"),
    presenceDeadlineHours: form.get("presenceDeadlineHours"),
    checkinOpensMinutes: form.get("checkinOpensMinutes"),
    checkinClosesMinutes: form.get("checkinClosesMinutes"),
    offerTtlHours: form.get("offerTtlHours"),
    protestWindowHours: form.get("protestWindowHours"),
    serverInfo: form.get("serverInfo"),
    scoring: parseScoringForm(form),
  };
}
function localDate(form: FormData, key: string, c: Community) {
  try {
    return zonedLocalToUtc(str(form, key), c.timezone);
  } catch (e) {
    throw new AppError((e as Error).message);
  }
}
export async function createChampionshipAction(form: FormData) {
  await perform(
    form,
    async (db, u, c) => {
      const id = await createChampionship(db, c.id, u.id, championshipForm(form, c));
      return `/c/${c.slug}/admin/championships/${id}`;
    },
    "Championnat créé (brouillon).",
  );
}
export async function updateChampionshipAction(form: FormData) {
  await perform(form, (db, u, c) => updateChampionship(db, c.id, u.id, str(form, "championshipId"), championshipForm(form, c), form.get("newRulesVersion") === "on"), "Championnat enregistré.");
}
export async function championshipStatusAction(form: FormData) {
  await perform(form, (db, u, c) => setChampionshipStatus(db, c.id, u.id, str(form, "championshipId"), str(form, "status")), "Statut modifié.");
}
export async function createRoundAction(form: FormData) {
  await perform(
    form,
    async (db, u, c) => {
      const races = Math.min(Math.max(Number(str(form, "races") || 1), 1), 4);
      const raceDuration = Number(str(form, "raceDuration") || 45);
      const plan: SessionPlan[] = [];
      if (form.get("withPractice") === "on") plan.push({ kind: "practice", label: "Essais libres", offsetMinutes: -Number(str(form, "practiceOffset") || 45), durationMinutes: Number(str(form, "practiceDuration") || 20) });
      if (form.get("withQualifying") === "on") plan.push({ kind: "qualifying", label: "Qualifications", offsetMinutes: -Number(str(form, "qualifyingOffset") || 20), durationMinutes: Number(str(form, "qualifyingDuration") || 15) });
      for (let i = 0; i < races; i++)
        plan.push({ kind: "race", label: races > 1 ? `Course ${i + 1}` : "Course", offsetMinutes: i * (raceDuration + 15), durationMinutes: raceDuration });
      const id = await createRound(db, c.id, u.id, str(form, "championshipId"), {
        name: form.get("name"),
        track: form.get("track"),
        trackConfig: form.get("trackConfig"),
        cars: form.get("cars"),
        startsAt: localDate(form, "startsAt", c),
        capacity: form.get("capacity"),
        serverInfo: form.get("serverInfo"),
        notes: form.get("notes"),
        jokerEligible: form.get("jokerEligible") === "on",
        plan,
      });
      return `/c/${c.slug}/admin/rounds/${id}`;
    },
    "Manche créée.",
  );
}
export async function updateRoundAction(form: FormData) {
  await perform(form, (db, u, c) =>
    updateRound(db, c.id, u.id, str(form, "roundId"), {
      name: form.get("name"),
      track: form.get("track"),
      trackConfig: form.get("trackConfig"),
      cars: form.get("cars"),
      capacity: form.get("capacity"),
      serverInfo: form.get("serverInfo"),
      notes: form.get("notes"),
      jokerEligible: form.get("jokerEligible"),
    }),
  );
}
export async function postponeRoundAction(form: FormData) {
  await perform(form, (db, u, c) => postponeRound(db, c.id, u.id, str(form, "roundId"), localDate(form, "startsAt", c), form.get("reason")), "Manche reportée : l’horaire d’origine est conservé dans l’historique.");
}
export async function roundStatusAction(form: FormData) {
  const status = str(form, "status") as "scheduled" | "cancelled" | "completed" | "draft";
  if (!["scheduled", "cancelled", "completed", "draft"].includes(status)) return;
  await perform(form, (db, u, c) => setRoundStatus(db, c.id, u.id, str(form, "roundId"), status, form.get("reason")), "Statut de la manche modifié.");
}
export async function sessionAction(form: FormData) {
  await perform(form, async (db, u, c) => {
    await upsertSession(db, c.id, u.id, str(form, "roundId"), str(form, "sessionId") || null, {
      kind: form.get("kind"),
      label: form.get("label"),
      startsAt: localDate(form, "startsAt", c),
      durationMinutes: form.get("durationMinutes"),
      coefficient: form.get("coefficient"),
      awardsPoints: form.get("awardsPoints"),
      awardsPole: form.get("awardsPole"),
    });
  }, "Session enregistrée.");
}
export async function deleteSessionAction(form: FormData) {
  await perform(form, (db, u, c) => deleteSession(db, c.id, u.id, str(form, "sessionId")), "Session supprimée.");
}
export async function linkIracingAction(form: FormData) {
  await perform(form, (db, u, c) => linkIracingSession(db, c.id, u.id, str(form, "sessionId"), form.get("subsessionId"), form.get("simsessionNumber")), "Association iRacing enregistrée.");
}

// ---------- Inscriptions ----------
export async function registerChampionshipAction(form: FormData) {
  await perform(
    form,
    async (db, u, c) => {
      if (form.get("acceptRules") !== "on") throw new AppError("Vous devez accepter le règlement.");
      await registerForChampionship(db, c.id, u.id, str(form, "championshipId"), {
        category: form.get("category"),
        car: form.get("car"),
        teamId: form.get("teamId"),
        newTeamName: form.get("newTeamName"),
        raceNumber: form.get("raceNumber"),
        acceptedRulesVersion: form.get("rulesVersion"),
        note: form.get("note"),
      });
      return `/c/${c.slug}/me`;
    },
    "Inscription envoyée : elle sera validée par un organisateur.",
  );
}
export async function acceptRulesAction(form: FormData) {
  await perform(form, (db, u, c) => acceptRules(db, c.id, u.id, str(form, "championshipId"), form.get("rulesVersion")), "Nouvelle version du règlement acceptée.");
}
export async function withdrawRegistrationAction(form: FormData) {
  await perform(form, (db, u, c) => withdrawRegistration(db, c.id, u.id, str(form, "championshipId")), "Inscription retirée ; vos places futures ont été libérées.");
}
export async function decideRegistrationAction(form: FormData) {
  const d = str(form, "decision");
  if (!["accepted", "reserve", "refused"].includes(d)) return;
  await perform(form, (db, u, c) => decideRegistration(db, c.id, u.id, str(form, "registrationId"), d as "accepted", form.get("note")), "Inscription mise à jour.");
}
export async function reserveRankAction(form: FormData) {
  await perform(form, (db, u, c) => reorderReserve(db, c.id, u.id, str(form, "registrationId"), form.get("rank")), "Ordre des réservistes modifié.");
}

// ---------- Présences ----------
export async function respondAction(form: FormData) {
  await perform(form, async (db, u, c) => {
    const out = await respond(db, c.id, u.id, str(form, "roundId"), str(form, "response"));
    const mine = (await db.query("SELECT seat, waitlist_position FROM attendances WHERE round_id=$1 AND user_id=$2", [str(form, "roundId"), u.id])).rows[0];
    if (mine?.seat === "confirmed") return "Présence enregistrée : votre place est confirmée.";
    if (mine?.seat === "waitlist") return `Présence enregistrée : vous êtes n°${mine.waitlist_position} en liste d’attente.`;
    if (mine?.seat === "offered") return "Une place vous est proposée : acceptez-la ci-dessous.";
    return out ? "Réponse enregistrée." : "Réponse enregistrée.";
  });
}
export async function acceptOfferAction(form: FormData) {
  await perform(form, (db, u, c) => acceptOffer(db, c.id, u.id, str(form, "roundId")), "Place acceptée : vous êtes confirmé.");
}
export async function declineOfferAction(form: FormData) {
  await perform(form, async (db, u, c) => {
    await declineOffer(db, c.id, u.id, str(form, "roundId"));
  }, "Place déclinée : elle passe au suivant.");
}
export async function checkInAction(form: FormData) {
  await perform(form, (db, u, c) => checkIn(db, c.id, u.id, str(form, "roundId")), "Pointage enregistré. Bonne course !");
}
export async function overrideResponseAction(form: FormData) {
  await perform(form, async (db, u, c) => {
    await setResponseAsOrganizer(db, c.id, u.id, str(form, "roundId"), str(form, "userId"), str(form, "response"), form.get("reason"));
  }, "Présence corrigée (tracée dans l’historique).");
}
export async function releaseUncheckedAction(form: FormData) {
  await perform(form, async (db, u, c) => {
    const r = await releaseUncheckedSeats(db, c.id, u.id, str(form, "roundId"));
    return `${r.released.length} place(s) non pointée(s) libérée(s) ; ${r.offers.length} offre(s) envoyée(s) à la liste d’attente.`;
  });
}

// ---------- Résultats ----------
export async function importFileAction(form: FormData) {
  await perform(form, async (db, u, c) => {
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) throw new AppError("Choisissez un fichier.");
    if (file.size > 5_000_000) throw new AppError("Fichier trop volumineux (5 Mo maximum).");
    const out = await importFile(db, c.id, u.id, str(form, "sessionId"), file.name, await file.text());
    if (out.status === "failed") throw new AppError(`Import refusé : ${out.error}`);
    return `/c/${c.slug}/admin/imports/${out.importId}${out.duplicate ? "?dup=1" : ""}`;
  }, "Aperçu prêt : vérifiez puis validez.");
}
export async function importApiAction(form: FormData) {
  await perform(
    form,
    async (_db, u, c) => {
      const out = await importFromIracingApi(getPool(), c.id, u.id, str(form, "sessionId"));
      if (out.status === "failed") throw new AppError(`Réponse iRacing non exploitable : ${out.error}`);
      return `/c/${c.slug}/admin/imports/${out.importId}${out.duplicate ? "?dup=1" : ""}`;
    },
    "Résultat iRacing récupéré : vérifiez puis validez.",
    { noTx: true },
  );
}
export async function importManualAction(form: FormData) {
  await perform(form, async (db, u, c) => {
    const ids = form.getAll("userId").map(String);
    const rows = ids
      .map((userId, i) => ({
        userId,
        position: Number(form.getAll("position")[i]),
        status: String(form.getAll("status")[i]) as "classified",
        laps: String(form.getAll("laps")[i] ?? "") === "" ? null : Number(form.getAll("laps")[i]),
        bestLap: String(form.getAll("bestLap")[i] ?? ""),
        totalTime: String(form.getAll("totalTime")[i] ?? ""),
        incidents: String(form.getAll("incidents")[i] ?? "") === "" ? null : Number(form.getAll("incidents")[i]),
        carClass: String(form.getAll("carClass")[i] ?? ""),
      }))
      .filter((r) => r.position > 0);
    let out;
    try {
      out = await importManual(db, c.id, u.id, str(form, "sessionId"), rows);
    } catch (e) {
      throw e instanceof AppError ? e : new AppError((e as Error).message);
    }
    if (out.status === "failed") throw new AppError(String(out.error));
    return `/c/${c.slug}/admin/imports/${out.importId}`;
  }, "Saisie enregistrée en aperçu : vérifiez puis validez.");
}
export async function applyImportAction(form: FormData) {
  await perform(form, async (db, u, c) => {
    const matches: Record<string, string> = {};
    for (const [k, v] of form.entries()) if (k.startsWith("match:")) matches[k.slice(6)] = String(v);
    await applyImport(db, c.id, u.id, str(form, "importId"), { final: form.get("final") === "on", matches, saveIracingIds: form.get("saveIds") === "on" });
    return `/c/${c.slug}/admin/rounds/${str(form, "roundId")}#resultats`;
  }, "Résultats validés : classements recalculés.");
}
export async function discardImportAction(form: FormData) {
  await perform(form, async (db, u, c) => {
    await discardImport(db, c.id, u.id, str(form, "importId"));
    return `/c/${c.slug}/admin/rounds/${str(form, "roundId")}`;
  }, "Aperçu abandonné (conservé dans l’historique).");
}
export async function resultsStatusAction(form: FormData) {
  await perform(form, (db, u, c) => setResultsStatus(db, c.id, u.id, str(form, "sessionId"), str(form, "final") === "1"), "Statut des résultats modifié.");
}
export async function correctionAction(form: FormData) {
  await perform(form, (db, u, c) => addCorrection(db, c.id, u.id, str(form, "resultId"), str(form, "field"), form.get("value"), form.get("reason")), "Correction enregistrée ; classement recalculé.");
}
export async function revokeCorrectionAction(form: FormData) {
  await perform(form, (db, u, c) => revokeCorrection(db, c.id, u.id, str(form, "correctionId")), "Correction annulée.");
}

// ---------- Réclamations et pénalités ----------
export async function fileProtestAction(form: FormData) {
  await perform(form, async (db, u, c) => {
    await fileProtest(db, c.id, u.id, str(form, "sessionId"), {
      againstUserId: str(form, "againstUserId") || null,
      lap: form.get("lap"),
      description: form.get("description"),
      videoUrl: form.get("videoUrl"),
    });
  }, "Réclamation déposée : les commissaires vont l’examiner.");
}
export async function withdrawProtestAction(form: FormData) {
  await perform(form, (db, u, c) => withdrawProtest(db, c.id, u.id, str(form, "protestId")), "Réclamation retirée.");
}
export async function reviewProtestAction(form: FormData) {
  await perform(form, (db, u, c) => startReview(db, c.id, u.id, str(form, "protestId")), "Réclamation en cours d’examen.");
}
export async function decideProtestAction(form: FormData) {
  await perform(form, async (db, u, c) => {
    const kind = str(form, "penaltyKind");
    await decideProtest(db, c.id, u.id, str(form, "protestId"), {
      outcome: str(form, "outcome"),
      decision: form.get("decision"),
      penalty: kind && kind !== "none" ? { userId: form.get("penaltyUserId"), kind, value: form.get("penaltyValue"), scope: form.get("penaltyScope"), reason: form.get("decision") } : null,
    });
  }, "Décision enregistrée.");
}
export async function penaltyAction(form: FormData) {
  await perform(form, async (db, u, c) => {
    await applyPenalty(db, c.id, u.id, str(form, "sessionId"), { userId: form.get("userId"), kind: form.get("kind"), value: form.get("value"), scope: form.get("scope"), reason: form.get("reason") });
  }, "Pénalité appliquée ; classement recalculé.");
}
export async function revokePenaltyAction(form: FormData) {
  await perform(form, (db, u, c) => revokePenalty(db, c.id, u.id, str(form, "penaltyId"), form.get("reason")), "Pénalité annulée.");
}
