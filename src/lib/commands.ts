export interface ChatCommand {
  name: string;
  usage: string;
  desc: string;
  op?: boolean; // requires operator status
}

// Single source of truth for slash commands — powers /help and autocomplete.
export const COMMANDS: ChatCommand[] = [
  // ── User commands ──
  { name: "help", usage: "/help [comando]", desc: "Mostra i comandi (o i dettagli di uno)" },
  { name: "nick", usage: "/nick <nome>", desc: "Cambia il tuo nickname" },
  { name: "me", usage: "/me <azione>", desc: "Invia un'azione: * tu fai qualcosa" },
  { name: "join", usage: "/join #canale", desc: "Entra in un canale (o lo crea)" },
  { name: "part", usage: "/part", desc: "Esci dal canale corrente (torni a #general)" },
  { name: "topic", usage: "/topic <testo>", desc: "Cambia il topic del canale" },
  { name: "list", usage: "/list", desc: "Elenca i canali disponibili" },
  { name: "names", usage: "/names", desc: "Elenca gli utenti del canale" },
  { name: "msg", usage: "/msg <nick> <testo>", desc: "Messaggio privato a un utente" },
  { name: "clear", usage: "/clear", desc: "Pulisci la vista dei messaggi" },
  { name: "quit", usage: "/quit", desc: "Esci dalla chat" },
  { name: "oper", usage: "/oper <password>", desc: "Autenticati come operatore" },
  // ── Operator commands ──
  { name: "op", usage: "/op <nick>", desc: "Promuovi un utente a operatore", op: true },
  { name: "deop", usage: "/deop <nick>", desc: "Rimuovi l'operatore a un utente", op: true },
  { name: "voice", usage: "/voice <nick>", desc: "Dai la parola (voice) in canale moderato", op: true },
  { name: "devoice", usage: "/devoice <nick>", desc: "Togli la parola", op: true },
  { name: "mute", usage: "/mute <nick>", desc: "Silenzia un utente nel canale", op: true },
  { name: "unmute", usage: "/unmute <nick>", desc: "Riattiva un utente silenziato", op: true },
  { name: "kick", usage: "/kick <nick>", desc: "Espelli un utente dal canale", op: true },
  { name: "ban", usage: "/ban <nick>", desc: "Banna un utente (applicato dal server)", op: true },
  { name: "unban", usage: "/unban <nick>", desc: "Rimuovi un ban", op: true },
  { name: "mutechannel", usage: "/mutechannel", desc: "Modera il canale: solo gli op scrivono", op: true },
  { name: "unmutechannel", usage: "/unmutechannel", desc: "Togli la moderazione del canale", op: true },
  { name: "say", usage: "/say <bot-id> <testo>", desc: "Fai dire qualcosa a un bot", op: true },
  { name: "botoff", usage: "/botoff <bot-id>", desc: "Disattiva un bot", op: true },
  { name: "boton", usage: "/boton <bot-id>", desc: "Attiva un bot", op: true },
];

export const COMMAND_NAMES: string[] = COMMANDS.map((c) => c.name);

export function buildHelp(includeOp: boolean): string {
  const userCmds = COMMANDS.filter((c) => !c.op);
  const opCmds = COMMANDS.filter((c) => c.op);
  const fmt = (c: ChatCommand) => `  ${c.usage} — ${c.desc}`;
  let out = "👤 Comandi utente:\n" + userCmds.map(fmt).join("\n");
  if (includeOp) {
    out += "\n\n🛡️ Comandi operatore:\n" + opCmds.map(fmt).join("\n");
  } else {
    out += "\n\n(altri comandi sono riservati agli operatori — /oper <password>)";
  }
  return out + "\n\nSuggerimento: premi Tab per autocompletare un comando.";
}
