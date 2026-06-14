/**
 * Claude-backed chat bot engine.
 *
 * Bots are DATA, not code: each bot is a document in /bots/{id}. This single
 * Cloud Function is the runtime — on every new chat message it loads the
 * enabled bots for that channel and runs each one. "Deploying a bot" means
 * syncing a bots/*.json file into Firestore (see scripts/deploy-bots.mjs);
 * the code here never changes when you add or tweak a bot.
 *
 * Two roles:
 *  - "moderator": classifies each message (allow/delete/warn) and acts. Invisible
 *    unless it removes/warns. Cheap model (Haiku) + structured output.
 *  - "persona":   a visible chat participant. When triggered (mention/keyword),
 *    it generates a reply with Claude and posts it as a normal message.
 */
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { defineSecret } from "firebase-functions/params";
import { setGlobalOptions, logger } from "firebase-functions/v2";
import { initializeApp } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { createHash } from "crypto";

const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");
const ADMIN_PASSWORD = defineSecret("ADMIN_PASSWORD");
const IP_SALT = defineSecret("IP_SALT");

// Co-locate with the Firestore database (europe-west8 / Milan).
setGlobalOptions({ region: "europe-west8", maxInstances: 10 });

initializeApp();
const db = getFirestore();

interface BotTrigger {
  type: "mention" | "keyword" | "all";
  keywords?: string[];
}

interface BotConfig {
  id: string;
  enabled: boolean;
  role: "moderator" | "persona";
  nickname: string;
  nickColor: string;
  channels: string[]; // ["*"] or specific channel ids
  model: string;
  systemPrompt: string;
  contextWindow?: number;
  actions?: Array<"delete" | "warn">; // moderator
  trigger?: BotTrigger; // persona
  maxReplyTokens?: number; // persona
  repliesEnabled?: boolean; // persona: false → canned reply, no Claude call
  autoReply?: string; // canned message used when replies are disabled
}

const DEFAULT_AUTOREPLY =
  "🤖 Le risposte automatiche sono temporaneamente disattivate.";

// Structured verdict for moderators — guaranteed JSON shape, no parsing.
const Verdict = z.object({
  action: z.enum(["allow", "delete", "warn"]),
  reason: z.string(),
});

export const onChatMessage = onDocumentCreated(
  {
    document: "channels/{channelId}/messages/{messageId}",
    secrets: [ANTHROPIC_API_KEY],
  },
  async (event) => {
    const snap = event.data;
    if (!snap) return;
    const msg = snap.data();
    const channelId = event.params.channelId;

    // Only act on real user messages — skip system/join/leave and bot output
    // (the latter prevents infinite loops).
    if (!msg || typeof msg.text !== "string") return;
    if (msg.type !== "message") return;
    if (typeof msg.userId === "string" && msg.userId.startsWith("bot:")) return;

    // Enforce bans: silently drop any message from a banned uid or nick.
    if (await isBanned(msg.userId, msg.nickname)) {
      await snap.ref.delete();
      logger.info(`dropped message from banned user in #${channelId}`);
      return;
    }

    // IP ban: drop messages from a uid whose recorded IP hash is banned.
    const ipMap = await db.collection("ipmap").doc(msg.userId).get();
    const ipHash = ipMap.exists ? (ipMap.data()?.ipHash as string) : null;
    if (ipHash) {
      const ipBan = await db.collection("ipbans").doc(ipHash).get();
      if (ipBan.exists) {
        await snap.ref.delete();
        logger.info(`dropped message from IP-banned user in #${channelId}`);
        return;
      }
    }

    // Per-channel mute: drop messages from a muted user.
    const muteSnap = await db
      .collection("channels")
      .doc(channelId)
      .collection("mutes")
      .doc(msg.userId)
      .get();
    if (muteSnap.exists) {
      await snap.ref.delete();
      return;
    }

    // Moderated channel: only operators, voiced users (and bots) may speak.
    const chanSnap = await db.collection("channels").doc(channelId).get();
    if (chanSnap.exists && chanSnap.data()?.muted === true) {
      const memberSnap = await db
        .collection("channels")
        .doc(channelId)
        .collection("members")
        .doc(msg.userId)
        .get();
      const md = memberSnap.exists ? memberSnap.data() : null;
      const privileged = md?.isOp === true || md?.voice === true;
      if (!privileged) {
        await snap.ref.delete();
        return;
      }
    }

    const botsSnap = await db
      .collection("bots")
      .where("enabled", "==", true)
      .get();

    const bots = botsSnap.docs
      .map((d) => ({ id: d.id, ...(d.data() as Omit<BotConfig, "id">) }))
      .filter(
        (b) => b.channels?.includes("*") || b.channels?.includes(channelId)
      );

    if (bots.length === 0) return;

    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() });

    // ── Moderation first ────────────────────────────────────────────────────
    let deleted = false;
    for (const bot of bots.filter((b) => b.role === "moderator")) {
      try {
        const context = await recentContext(channelId, bot.contextWindow ?? 12);
        const res = await client.messages.parse({
          model: bot.model || "claude-haiku-4-5",
          max_tokens: 256,
          system: [
            {
              type: "text",
              text: bot.systemPrompt,
              cache_control: { type: "ephemeral" },
            },
          ],
          messages: [
            {
              role: "user",
              content:
                `Recent conversation in #${channelId}:\n${context}\n\n` +
                `Evaluate ONLY the latest message from <${msg.nickname}>: ` +
                `"${msg.text}"`,
            },
          ],
          output_config: { format: zodOutputFormat(Verdict) },
        });
        const verdict = res.parsed_output;
        if (!verdict || verdict.action === "allow") continue;
        const allowed = bot.actions ?? ["delete", "warn"];
        if (verdict.action === "delete" && allowed.includes("delete")) {
          await snap.ref.delete();
          await postSystemNotice(
            channelId,
            bot,
            `message from ${msg.nickname} removed — ${verdict.reason}`
          );
          deleted = true;
          logger.info(`[${bot.id}] deleted message in #${channelId}`);
          break;
        }
        if (verdict.action === "warn" && allowed.includes("warn")) {
          await postSystemNotice(
            channelId,
            bot,
            `${msg.nickname}: ${verdict.reason}`
          );
        }
      } catch (err) {
        logger.error(`[${bot.id}] moderation failed`, err);
      }
    }

    if (deleted) return; // don't let personas reply to a removed message

    // ── Persona replies ─────────────────────────────────────────────────────
    for (const bot of bots.filter((b) => b.role === "persona")) {
      try {
        if (!triggerMatches(bot, msg.text)) continue;
        if (bot.repliesEnabled === false) {
          await postBotMessage(channelId, bot, bot.autoReply || DEFAULT_AUTOREPLY);
          continue;
        }
        const context = await recentContext(channelId, bot.contextWindow ?? 10);
        const res = await client.messages.create({
          model: bot.model || "claude-sonnet-4-6",
          max_tokens: bot.maxReplyTokens ?? 300,
          system: [
            {
              type: "text",
              text: bot.systemPrompt,
              cache_control: { type: "ephemeral" },
            },
          ],
          messages: [
            {
              role: "user",
              content:
                `Sei "${bot.nickname}" in una chat di gruppo nel canale ` +
                `#${channelId}. Conversazione recente:\n${context}\n\n` +
                `Rispondi all'ultimo messaggio di <${msg.nickname}>: ` +
                `"${msg.text}"`,
            },
          ],
        });
        const reply = res.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("")
          .trim();
        if (reply) {
          await postBotMessage(channelId, bot, reply);
          logger.info(`[${bot.id}] replied in #${channelId}`);
        }
      } catch (err) {
        logger.error(`[${bot.id}] persona reply failed`, err);
      }
    }
  }
);

// Persona bots reply in 1:1 private chats too. A DM with a bot has the bot's
// "bot:<id>" id as one participant (in the convoId). The reply uses ONLY this
// conversation's recent messages as context, so each DM has its own memory.
export const onDmMessage = onDocumentCreated(
  {
    document: "dms/{convoId}/messages/{messageId}",
    secrets: [ANTHROPIC_API_KEY],
  },
  async (event) => {
    const snap = event.data;
    if (!snap) return;
    const msg = snap.data();
    if (!msg || typeof msg.text !== "string") return;
    if (typeof msg.fromUid === "string" && msg.fromUid.startsWith("bot:")) {
      return; // the bot's own message — avoid loops
    }
    const convoId = event.params.convoId;
    const botPart = convoId.split("__").find((p) => p.startsWith("bot:"));
    if (!botPart) return; // not a DM with a bot
    const botId = botPart.slice("bot:".length);
    const botSnap = await db.collection("bots").doc(botId).get();
    if (!botSnap.exists) return;
    const bot = botSnap.data() as BotConfig;
    if (!bot.enabled) return;

    // Only persona bots chat; moderators just send a canned line in DMs.
    if (bot.role !== "persona") {
      await postBotDm(
        convoId,
        bot,
        botId,
        bot.autoReply ||
          "Sono un bot di moderazione: scrivimi nei canali, non in privato."
      );
      return;
    }
    if (bot.repliesEnabled === false) {
      await postBotDm(convoId, bot, botId, bot.autoReply || DEFAULT_AUTOREPLY);
      return;
    }

    try {
      const ctxSnap = await db
        .collection("dms")
        .doc(convoId)
        .collection("messages")
        .orderBy("timestamp", "desc")
        .limit(bot.contextWindow ?? 12)
        .get();
      const context = ctxSnap.docs
        .map((d) => d.data())
        .reverse()
        .map((m) => `<${m.fromNick}> ${m.text}`)
        .join("\n");

      const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() });
      const res = await client.messages.create({
        model: bot.model || "claude-sonnet-4-6",
        max_tokens: bot.maxReplyTokens ?? 300,
        system: [
          {
            type: "text",
            text: bot.systemPrompt,
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: [
          {
            role: "user",
            content:
              `Sei "${bot.nickname}" in una chat privata 1:1 con ` +
              `<${msg.fromNick}>. Conversazione finora:\n${context}\n\n` +
              `Rispondi all'ultimo messaggio: "${msg.text}"`,
          },
        ],
      });
      const reply = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim();
      if (reply) {
        await postBotDm(convoId, bot, botId, reply);
        logger.info(`[${botId}] DM reply in ${convoId}`);
      }
    } catch (err) {
      logger.error(`[${botId}] DM reply failed`, err);
    }
  }
);

async function postBotDm(
  convoId: string,
  bot: BotConfig,
  botId: string,
  text: string
): Promise<void> {
  await db.collection("dms").doc(convoId).collection("messages").add({
    fromUid: `bot:${botId}`,
    fromNick: bot.nickname,
    fromColor: bot.nickColor,
    text,
    timestamp: FieldValue.serverTimestamp(),
  });
  await db
    .collection("dms")
    .doc(convoId)
    .set(
      {
        updatedAt: Date.now(),
        lastFrom: `bot:${botId}`,
        lastText: text.slice(0, 120),
      },
      { merge: true }
    );
}

// Auto-remove empty channels (no member active in the last ~2 min), except the
// permanent default channels. Runs on a schedule. Channels are otherwise
// persistent, so this gives IRC-like "channel disappears when everyone leaves".
const KEEP_CHANNELS = new Set([
  "general",
  "random",
  "tech",
  "events",
  "bots",
]);
export const cleanupEmptyChannels = onSchedule(
  { schedule: "every 15 minutes", region: "europe-west1" },
  async () => {
    const now = Date.now();
    const chans = await db.collection("channels").get();
    for (const ch of chans.docs) {
      if (KEEP_CHANNELS.has(ch.id)) continue;
      const members = await db
        .collection("channels")
        .doc(ch.id)
        .collection("members")
        .get();
      const active = members.docs.some(
        (m) => now - ((m.data().lastSeen as number) || 0) < 120000
      );
      if (!active) {
        await db.recursiveDelete(ch.ref);
        logger.info(`cleaned up empty channel #${ch.id}`);
      }
    }
  }
);

async function isBanned(uid?: string, nick?: string): Promise<boolean> {
  if (uid) {
    const byUid = await db.collection("bans").doc(uid).get();
    if (byUid.exists) return true;
  }
  if (nick) {
    const byNick = await db
      .collection("bans")
      .where("nick", "==", nick)
      .limit(1)
      .get();
    if (!byNick.empty) return true;
  }
  return false;
}

function triggerMatches(bot: BotConfig, text: string): boolean {
  const t = bot.trigger ?? { type: "mention" };
  const lower = text.toLowerCase();
  if (t.type === "all") return true;
  if (t.type === "keyword") {
    return (t.keywords ?? []).some((k) => lower.includes(k.toLowerCase()));
  }
  // default: mention by nickname
  return lower.includes(bot.nickname.toLowerCase());
}

async function recentContext(
  channelId: string,
  limit: number
): Promise<string> {
  const snap = await db
    .collection("channels")
    .doc(channelId)
    .collection("messages")
    .orderBy("timestamp", "desc")
    .limit(limit)
    .get();
  return snap.docs
    .map((d) => d.data())
    .reverse()
    .map((m) => `<${m.nickname}> ${m.text}`)
    .join("\n");
}

async function postSystemNotice(
  channelId: string,
  bot: BotConfig,
  text: string
): Promise<void> {
  await db.collection("channels").doc(channelId).collection("messages").add({
    userId: `bot:${bot.id}`,
    nickname: bot.nickname,
    nickColor: bot.nickColor,
    text,
    timestamp: FieldValue.serverTimestamp(),
    type: "system",
  });
}

async function postBotMessage(
  channelId: string,
  bot: BotConfig,
  text: string
): Promise<void> {
  await db.collection("channels").doc(channelId).collection("messages").add({
    userId: `bot:${bot.id}`,
    nickname: bot.nickname,
    nickColor: bot.nickColor,
    text,
    timestamp: FieldValue.serverTimestamp(),
    type: "message",
  });
}

async function channelNotice(channelId: string, text: string): Promise<void> {
  await db.collection("channels").doc(channelId).collection("messages").add({
    userId: "system",
    nickname: "***",
    nickColor: "#8b949e",
    text,
    timestamp: FieldValue.serverTimestamp(),
    type: "system",
  });
}

// Records a salted hash of the caller's IP, keyed by their client uid, so that
// IP bans can survive a uid/nick change. Only the hash is stored (never the raw
// IP). Called by the client on entry.
export const recordPresence = onCall(
  { region: "europe-west8", secrets: [IP_SALT] },
  async (req) => {
    const uid = (req.data || {})?.uid;
    if (!uid || typeof uid !== "string") {
      throw new HttpsError("invalid-argument", "uid mancante");
    }
    const fwd = req.rawRequest.headers["x-forwarded-for"];
    const ip =
      (Array.isArray(fwd) ? fwd[0] : (fwd || "").split(",")[0]).trim() ||
      req.rawRequest.ip ||
      "";
    const ipHash = createHash("sha256")
      .update(`${IP_SALT.value()}|${ip}`)
      .digest("hex")
      .slice(0, 32);
    await db
      .collection("ipmap")
      .doc(uid)
      .set({ ipHash, at: FieldValue.serverTimestamp() }, { merge: true });
    return { ok: true };
  }
);

// Reserve a unique nickname for a uid. Reservations go stale after 12h so
// abandoned nicks free up; the same uid can always refresh its own. Throws
// "already-exists" if another (active) user holds the nick.
export const claimNick = onCall({ region: "europe-west8" }, async (req) => {
  const data = (req.data || {}) as {
    uid?: string;
    nick?: string;
    oldNick?: string;
  };
  const uid = data.uid;
  let nick = (data.nick || "").trim().slice(0, 20);
  if (!uid || typeof uid !== "string" || !nick) {
    throw new HttpsError("invalid-argument", "uid e nick richiesti");
  }
  const lower = nick.toLowerCase();
  const STALE_MS = 12 * 60 * 60 * 1000;
  const ref = db.collection("nicks").doc(lower);

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) {
      const d = snap.data();
      const at =
        d?.at && typeof d.at.toMillis === "function" ? d.at.toMillis() : 0;
      const fresh = Date.now() - at < STALE_MS;
      if (d?.uid !== uid && fresh) {
        throw new HttpsError("already-exists", "Nickname già in uso");
      }
    }
    tx.set(ref, { uid, nickname: nick, at: FieldValue.serverTimestamp() });
  });

  // release the previous reservation when changing nick
  if (data.oldNick && data.oldNick.toLowerCase() !== lower) {
    const oldRef = db.collection("nicks").doc(data.oldNick.toLowerCase());
    const oldSnap = await oldRef.get();
    if (oldSnap.exists && oldSnap.data()?.uid === uid) {
      await oldRef.delete().catch(() => {});
    }
  }
  return { ok: true, nick };
});

// First person to enter a channel (when no operator is present) becomes its
// operator — classic IRC behaviour. Op status is set here by the admin SDK so
// clients can't grant it to themselves (security rules forbid that).
export const onMemberJoin = onDocumentCreated(
  "channels/{channelId}/members/{uid}",
  async (event) => {
    const snap = event.data;
    if (!snap) return;
    const data = snap.data();
    if (data?.isOp === true) return;
    const channelId = event.params.channelId;
    const ops = await db
      .collection("channels")
      .doc(channelId)
      .collection("members")
      .where("isOp", "==", true)
      .limit(1)
      .get();
    if (!ops.empty) return; // a channel operator already exists
    // Promote silently — the @ badge in the user list already shows op status,
    // and a chat notice here reads as a duplicate "join" line. Manual /op still
    // announces (see the "op" admin action).
    await snap.ref.set({ isOp: true }, { merge: true });
  }
);

// ── Operator (admin) gatekeeper ──────────────────────────────────────────────
// mIRC-style: the client sends an oper password with each privileged command;
// this function verifies it against the ADMIN_PASSWORD secret and performs the
// action with admin rights (bypassing security rules). Identity is the password
// — there is no account system. Use a long, secret password.
export const adminCommand = onCall(
  { region: "europe-west8", secrets: [ADMIN_PASSWORD] },
  async (req) => {
    const data = (req.data || {}) as {
      password?: string;
      action?: string;
      args?: Record<string, string>;
    };
    if (!data.password || data.password !== ADMIN_PASSWORD.value()) {
      throw new HttpsError("permission-denied", "Password operatore errata");
    }
    const args = data.args || {};

    switch (data.action) {
      case "verify":
        return { ok: true };

      case "bot.enable":
      case "bot.disable": {
        if (!args.botId)
          throw new HttpsError("invalid-argument", "botId mancante");
        await db
          .collection("bots")
          .doc(args.botId)
          .set({ enabled: data.action === "bot.enable" }, { merge: true });
        return { ok: true };
      }

      case "bot.repliesOn":
      case "bot.repliesOff": {
        if (!args.botId)
          throw new HttpsError("invalid-argument", "botId mancante");
        await db
          .collection("bots")
          .doc(args.botId)
          .set(
            { repliesEnabled: data.action === "bot.repliesOn" },
            { merge: true }
          );
        return { ok: true };
      }

      case "bot.create": {
        if (!args.botId || !args.nickname)
          throw new HttpsError("invalid-argument", "id e nickname richiesti");
        const id = args.botId.toLowerCase().replace(/[^a-z0-9_-]/g, "");
        if (!id) throw new HttpsError("invalid-argument", "id non valido");
        const existing = await db.collection("bots").doc(id).get();
        if (existing.exists)
          throw new HttpsError("already-exists", "bot già esistente");
        const role = args.role === "moderator" ? "moderator" : "persona";
        await db
          .collection("bots")
          .doc(id)
          .set({
            enabled: true,
            role,
            nickname: args.nickname.slice(0, 40),
            nickColor: "#58a6ff",
            // moderators auto-join every channel; personas are invited per-channel
            channels: role === "moderator" ? ["*"] : [],
            model:
              role === "moderator"
                ? "claude-haiku-4-5"
                : "claude-sonnet-4-6",
            contextWindow: role === "moderator" ? 12 : 10,
            repliesEnabled: true,
            trigger: { type: "mention" },
            maxReplyTokens: 300,
            actions: role === "moderator" ? ["delete", "warn"] : [],
            systemPrompt:
              role === "moderator"
                ? "Sei un moderatore di chat. Valuta solo l'ultimo messaggio: 'delete' per spam/insulti gravi/hate/link malevoli, 'warn' per derive lievi, altrimenti 'allow'. Nel dubbio allow. reason: una frase in italiano."
                : `Sei ${args.nickname}, un assistente AI amichevole in una chat. Rispondi in modo conciso e utile (1-4 frasi), in italiano o nella lingua dell'utente. Scrivi solo il testo della risposta, senza prefissi tipo <nome>.`,
          });
        return { ok: true, id };
      }

      case "bot.joinChannel":
      case "bot.leaveChannel": {
        if (!args.botId || !args.channelId)
          throw new HttpsError("invalid-argument", "botId e channelId richiesti");
        const op =
          data.action === "bot.joinChannel"
            ? FieldValue.arrayUnion(args.channelId)
            : FieldValue.arrayRemove(args.channelId);
        await db
          .collection("bots")
          .doc(args.botId)
          .set({ channels: op }, { merge: true });
        return { ok: true };
      }

      case "bot.set": {
        if (!args.botId || !args.field)
          throw new HttpsError("invalid-argument", "botId e field richiesti");
        const value = args.value ?? "";
        const on = value === "on" || value === "true";
        const updates: Record<string, unknown> = {};
        switch (args.field) {
          case "replies":
            updates.repliesEnabled = on;
            break;
          case "enabled":
            updates.enabled = on;
            break;
          case "prompt":
            updates.systemPrompt = value;
            break;
          case "autoreply":
            updates.autoReply = value;
            break;
          case "model":
            updates.model = value;
            break;
          case "nick":
            updates.nickname = value.slice(0, 40);
            break;
          case "trigger":
            updates.trigger = { type: value === "all" ? "all" : "mention" };
            break;
          case "channels":
            updates.channels =
              value.trim() === "*"
                ? ["*"]
                : value
                    .split(",")
                    .map((s) => s.trim().replace(/^#/, ""))
                    .filter(Boolean);
            break;
          default:
            throw new HttpsError("invalid-argument", "campo sconosciuto");
        }
        await db.collection("bots").doc(args.botId).set(updates, { merge: true });
        return { ok: true };
      }

      case "bot.say": {
        if (!args.botId || !args.channelId || !args.text)
          throw new HttpsError("invalid-argument", "parametri mancanti");
        const botSnap = await db.collection("bots").doc(args.botId).get();
        if (!botSnap.exists)
          throw new HttpsError("not-found", "bot inesistente");
        const bot = botSnap.data() as BotConfig;
        await postBotMessage(args.channelId, bot, String(args.text).slice(0, 500));
        return { ok: true };
      }

      case "kick": {
        if (!args.channelId || !args.uid)
          throw new HttpsError("invalid-argument", "parametri mancanti");
        await db
          .collection("channels")
          .doc(args.channelId)
          .collection("members")
          .doc(args.uid)
          .delete();
        await db
          .collection("channels")
          .doc(args.channelId)
          .collection("messages")
          .add({
            userId: "system",
            nickname: "***",
            nickColor: "#8b949e",
            text: `${args.nick || "un utente"} è stato espulso da un operatore`,
            timestamp: FieldValue.serverTimestamp(),
            type: "leave",
          });
        return { ok: true };
      }

      case "ban": {
        if (!args.uid && !args.nick)
          throw new HttpsError("invalid-argument", "uid o nick richiesto");
        const banId = args.uid || args.nick;
        await db
          .collection("bans")
          .doc(banId)
          .set({
            uid: args.uid || "",
            nick: args.nick || "",
            bannedAt: FieldValue.serverTimestamp(),
          });
        // also ban the user's recorded IP hash, if known (stickier ban)
        if (args.uid) {
          const ipm = await db.collection("ipmap").doc(args.uid).get();
          const ipHash = ipm.exists ? (ipm.data()?.ipHash as string) : null;
          if (ipHash) {
            await db.collection("ipbans").doc(ipHash).set({
              uid: args.uid,
              nick: args.nick || "",
              bannedAt: FieldValue.serverTimestamp(),
            });
          }
        }
        // remove from the channel + wipe their recent messages there
        if (args.channelId && args.uid) {
          await db
            .collection("channels")
            .doc(args.channelId)
            .collection("members")
            .doc(args.uid)
            .delete()
            .catch(() => {});
          const recent = await db
            .collection("channels")
            .doc(args.channelId)
            .collection("messages")
            .where("userId", "==", args.uid)
            .limit(50)
            .get();
          if (!recent.empty) {
            const batch = db.batch();
            recent.docs.forEach((d) => batch.delete(d.ref));
            await batch.commit();
          }
        }
        if (args.channelId) {
          await db
            .collection("channels")
            .doc(args.channelId)
            .collection("messages")
            .add({
              userId: "system",
              nickname: "***",
              nickColor: "#8b949e",
              text: `${args.nick || "un utente"} è stato bannato da un operatore`,
              timestamp: FieldValue.serverTimestamp(),
              type: "leave",
            });
        }
        return { ok: true };
      }

      case "unban": {
        const ident = args.nick || args.uid;
        if (!ident)
          throw new HttpsError("invalid-argument", "uid o nick richiesto");
        await db.collection("bans").doc(ident).delete().catch(() => {});
        const byNick = await db
          .collection("bans")
          .where("nick", "==", ident)
          .get();
        if (!byNick.empty) {
          const batch = db.batch();
          byNick.docs.forEach((d) => batch.delete(d.ref));
          await batch.commit();
        }
        // also lift any IP ban tied to this nick
        const ipByNick = await db
          .collection("ipbans")
          .where("nick", "==", ident)
          .get();
        if (!ipByNick.empty) {
          const batch = db.batch();
          ipByNick.docs.forEach((d) => batch.delete(d.ref));
          await batch.commit();
        }
        return { ok: true };
      }

      case "op":
      case "deop": {
        if (!args.channelId || !args.uid)
          throw new HttpsError("invalid-argument", "parametri mancanti");
        const grant = data.action === "op";
        await db
          .collection("channels")
          .doc(args.channelId)
          .collection("members")
          .doc(args.uid)
          .set({ isOp: grant }, { merge: true });
        await channelNotice(
          args.channelId,
          grant
            ? `${args.nick || "un utente"} è ora operatore`
            : `${args.nick || "un utente"} non è più operatore`
        );
        return { ok: true };
      }

      case "voice":
      case "devoice": {
        if (!args.channelId || !args.uid)
          throw new HttpsError("invalid-argument", "parametri mancanti");
        const grant = data.action === "voice";
        await db
          .collection("channels")
          .doc(args.channelId)
          .collection("members")
          .doc(args.uid)
          .set({ voice: grant }, { merge: true });
        await channelNotice(
          args.channelId,
          grant
            ? `${args.nick || "un utente"} ha ora la parola (voice +)`
            : `${args.nick || "un utente"} non ha più la parola`
        );
        return { ok: true };
      }

      case "mute":
      case "unmute": {
        if (!args.channelId || !args.uid)
          throw new HttpsError("invalid-argument", "parametri mancanti");
        const ref = db
          .collection("channels")
          .doc(args.channelId)
          .collection("mutes")
          .doc(args.uid);
        if (data.action === "mute") {
          await ref.set({
            nick: args.nick || "",
            mutedAt: FieldValue.serverTimestamp(),
          });
          await channelNotice(
            args.channelId,
            `${args.nick || "un utente"} è stato silenziato da un operatore`
          );
        } else {
          await ref.delete().catch(() => {});
          await channelNotice(
            args.channelId,
            `${args.nick || "un utente"} può di nuovo scrivere`
          );
        }
        return { ok: true };
      }

      case "channel.mute":
      case "channel.unmute": {
        if (!args.channelId)
          throw new HttpsError("invalid-argument", "channelId mancante");
        const muted = data.action === "channel.mute";
        await db
          .collection("channels")
          .doc(args.channelId)
          .set({ muted }, { merge: true });
        await channelNotice(
          args.channelId,
          muted
            ? "Canale moderato: solo gli operatori possono scrivere"
            : "Canale non più moderato"
        );
        return { ok: true };
      }

      default:
        throw new HttpsError("invalid-argument", "azione sconosciuta");
    }
  }
);
