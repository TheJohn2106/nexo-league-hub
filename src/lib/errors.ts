export class AppError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}
export const forbidden = () => new AppError("Action non autorisée pour votre rôle dans cette ligue.", 403);
export const notFound = (what = "Élément") => new AppError(`${what} introuvable.`, 404);
