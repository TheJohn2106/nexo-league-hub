// Matrice des permissions, appliquée côté serveur par chaque service (jamais seulement dans l'interface).
export const roles = ["owner", "organizer", "steward", "captain", "driver"] as const;
export type Role = (typeof roles)[number];
export const roleLabels: Record<Role, string> = {
  owner: "Propriétaire",
  organizer: "Organisateur",
  steward: "Commissaire",
  captain: "Capitaine",
  driver: "Pilote",
};

export type Permission =
  | "community.manage" // identité visuelle, rôles, intégrations
  | "members.review" // adhésions
  | "championship.manage" // saisons, manches, sessions, barème
  | "registrations.review"
  | "attendance.manage" // correction de présences, retraits, places
  | "results.manage" // imports, validation, corrections
  | "protests.view"
  | "protests.decide" // décisions et pénalités
  | "audit.view"
  | "data.export"
  | "participate"; // inscription, présence, réclamation

const matrix: Record<Permission, readonly Role[]> = {
  "community.manage": ["owner"],
  "members.review": ["owner", "organizer"],
  "championship.manage": ["owner", "organizer"],
  "registrations.review": ["owner", "organizer"],
  "attendance.manage": ["owner", "organizer"],
  "results.manage": ["owner", "organizer"],
  "protests.view": ["owner", "organizer", "steward"],
  "protests.decide": ["owner", "steward"],
  "audit.view": ["owner", "organizer"],
  "data.export": ["owner", "organizer"],
  participate: ["owner", "organizer", "steward", "captain", "driver"],
};

export function can(role: Role | null | undefined, permission: Permission) {
  return !!role && matrix[permission].includes(role);
}
export function permissionMatrix() {
  return matrix;
}
