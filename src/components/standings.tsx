import Link from "next/link";
import type { DriverStanding, EngineOutput, EngineRound, SessionLine, TeamStanding } from "@/lib/scoring/types";
import { Pos, Lap, labels, Pill } from "./ui";
import type { EffectiveResult } from "@/lib/scoring/types";

export function DriverTable({ rows, rounds, base, compact = false }: { rows: DriverStanding[]; rounds: EngineRound[]; base: string; compact?: boolean }) {
  if (!rows.length) return <p className="empty">Aucun pilote classé pour le moment.</p>;
  const shown = rounds.filter((r) => !r.cancelled);
  return (
    <div className="table-wrap">
      <table>
        <caption className="sr-only">Classement des pilotes</caption>
        <thead>
          <tr>
            <th scope="col">Pos.</th>
            <th scope="col">Pilote</th>
            {!compact && shown.map((r) => (
              <th key={r.id} scope="col" className="num">
                M{r.number}
              </th>
            ))}
            <th scope="col" className="num">
              Points
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => (
            <tr key={d.userId}>
              <td>
                <Pos n={d.rank} />
                {d.tied && <span className="sr-only"> ex aequo</span>}
              </td>
              <td>
                <Link href={`${base}/drivers/${d.userId}`}>{d.displayName}</Link>
                {d.category && <span className="muted"> · {d.category}</span>}
                {d.penaltyPoints > 0 && <div className="breakdown">Pénalités : −{d.penaltyPoints} pt</div>}
              </td>
              {!compact &&
                shown.map((r) => (
                  <td key={r.id} className="num" title={d.droppedRoundIds.includes(r.id) ? "Résultat retiré (joker)" : undefined}>
                    {r.id in d.roundPoints ? (
                      d.droppedRoundIds.includes(r.id) ? <s className="muted">{d.roundPoints[r.id]}</s> : d.roundPoints[r.id]
                    ) : (
                      <span className="muted">–</span>
                    )}
                  </td>
                ))}
              <td className="num">
                <span className="points">{d.points}</span>
                {d.tied && <div className="breakdown">ex aequo</div>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function TeamTable({ rows }: { rows: TeamStanding[] }) {
  if (!rows.length) return <p className="empty">Aucune équipe.</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Pos.</th>
            <th>Équipe</th>
            <th className="num">Points</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.teamId}>
              <td>
                <Pos n={t.rank} />
              </td>
              <td>{t.name}</td>
              <td className="num">
                <span className="points">{t.points}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function breakdown(l: SessionLine | undefined) {
  if (!l) return null;
  const parts = [`place ${l.positionPoints}`];
  if (l.participationPoints) parts.push(`participation ${l.participationPoints}`);
  if (l.coefficient !== 1) parts.push(`× ${l.coefficient}`);
  if (l.polePoints) parts.push(`pole +${l.polePoints}`);
  if (l.fastestLapPoints) parts.push(`meilleur tour +${l.fastestLapPoints}`);
  if (l.penaltyPoints) parts.push(`pénalité −${l.penaltyPoints}`);
  return parts.join(" · ");
}

/** Résultat d'une session avec détail des points. names : pseudo public par userId (jamais le nom iRacing). */
export function SessionResults({
  rows,
  lines,
  names,
  base,
  showPoints,
  isPublic,
}: {
  rows: EffectiveResult[];
  lines: SessionLine[];
  names: Map<string, string>;
  base: string;
  showPoints: boolean;
  isPublic: boolean;
}) {
  if (!rows.length) return <p className="empty">Résultats non publiés.</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Pos.</th>
            <th>Pilote</th>
            <th>Statut</th>
            <th className="num">Départ</th>
            <th className="num">Tours</th>
            <th className="num">Meilleur tour</th>
            <th className="num">Écart</th>
            <th className="num">Inc.</th>
            {showPoints && <th className="num">Points</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const l = r.userId ? lines.find((x) => x.userId === r.userId) : undefined;
            const name = r.userId ? (names.get(r.userId) ?? r.displayName) : isPublic ? "Invité (non inscrit)" : r.displayName;
            return (
              <tr key={r.id}>
                <td>
                  <Pos n={r.finishPosition} />
                  {r.originalPosition !== r.finishPosition && <div className="breakdown">arrivée P{r.originalPosition}</div>}
                </td>
                <td>
                  {r.userId ? <Link href={`${base}/drivers/${r.userId}`}>{name}</Link> : <span className="muted">{name}</span>}
                  {r.carClass && <span className="muted"> · {r.carClass}</span>}
                  {r.appliedPenalties.length > 0 && <div className="breakdown">Pénalité appliquée</div>}
                </td>
                <td>
                  <Pill value={r.status}>{labels[r.status]}</Pill>
                </td>
                <td className="num">{r.startPosition ?? <span className="muted">non fourni</span>}</td>
                <td className="num">{r.laps ?? <span className="muted">non fourni</span>}</td>
                <td className="num">
                  <Lap ms={r.bestLapMs} />
                </td>
                <td className="num">
                  {r.finishPosition === 1 ? "—" : r.gapLaps ? `+${r.gapLaps} t.` : r.gapMs != null ? `+${(r.gapMs / 1000).toFixed(3)} s` : <span className="muted">non fourni</span>}
                </td>
                <td className="num">{r.incidents ?? <span className="muted">non fourni</span>}</td>
                {showPoints && (
                  <td className="num">
                    {l ? (
                      <>
                        <span className="points">{l.total}</span>
                        <div className="breakdown">{breakdown(l)}</div>
                      </>
                    ) : (
                      <span className="muted">–</span>
                    )}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function nameMap(output: EngineOutput, drivers: { userId: string; displayName: string }[]) {
  void output;
  return new Map(drivers.map((d) => [d.userId, d.displayName]));
}
