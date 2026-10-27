// Saisie masquée d’un mot de passe en terminal, ou lecture de NEXO_OWNER_PASSWORD (scripts d’administration).
import { createInterface } from "node:readline/promises";

export async function askPassword() {
  if (process.env.NEXO_OWNER_PASSWORD) return process.env.NEXO_OWNER_PASSWORD;
  if (!process.stdin.isTTY) throw new Error("Définissez NEXO_OWNER_PASSWORD ou lancez la commande dans un terminal interactif.");
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  // Masque la saisie.
  const write = (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput.bind(rl);
  let hidden = false;
  (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => write(hidden ? "" : s);
  const prompt = async (q: string) => {
    process.stdout.write(q);
    hidden = true;
    const a = await rl.question("");
    hidden = false;
    process.stdout.write("\n");
    return a;
  };
  const a = await prompt("Mot de passe (10 caractères min., lettres et chiffres) : ");
  const b = await prompt("Confirmation : ");
  rl.close();
  if (a !== b) throw new Error("Les mots de passe ne correspondent pas.");
  return a;
}
