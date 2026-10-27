// Origin explicite derrière un proxy ; sinon Host du serveur HTTP courant.
export function isSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin || origin === "null") return false;
  try {
    const parsed = new URL(origin);
    if (!["http:", "https:"].includes(parsed.protocol)) return false;
    if (process.env.APP_ORIGIN)
      return parsed.origin === new URL(process.env.APP_ORIGIN).origin;
    return parsed.host === request.headers.get("host");
  } catch {
    return false;
  }
}
export function redirectTo(path: "/" | "/login" | "/login?error=1") {
  return new Response(null, { status: 303, headers: { Location: path } });
}
