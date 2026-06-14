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
import { defineSecret } from "firebase-functions/params";
import { setGlobalOptions, logger } from "firebase-functions/v2";
import { initializeApp } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");
const ADMIN_PASSWORD = defineSecret("ADMIN_PASSWORD");

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
}

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

    // Moderated channel: only operators (and bots) may speak.
    const chanSnap = await db.collection("channels").doc(channelId).get();
    if (chanSnap.exists && chanSnap.data()?.muted === true) {
      const memberSnap = await db
        .collection("channels")
        .doc(channelId)
        .collection("members")
        .doc(msg.userId)
        .get();
      const isOp = memberSnap.exists && memberSnap.data()?.isOp === true;
      if (!isOp) {
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
    await snap.ref.set({ isOp: true }, { merge: true });
    await channelNotice(
      channelId,
      `${data?.nickname || "un utente"} è ora operatore del canale`
    );
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
