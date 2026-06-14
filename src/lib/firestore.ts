/**
 * Firestore data layer — real-time streaming via onSnapshot.
 *
 * Firestore collection layout:
 *   /channels/{channelId}                — channel metadata
 *   /channels/{channelId}/messages/{id} — chat messages (last 100 kept)
 *   /channels/{channelId}/members/{uid} — active members (heartbeat-based presence)
 *
 * NOTE: This abstraction is designed to be Kafka-ready. If you add a Node.js
 * backend with KafkaJS, messages can be produced to a Kafka topic and consumed
 * by a Cloud Function that writes them to Firestore. The frontend layer here
 * would remain unchanged — it just reads from Firestore's real-time stream.
 */

import {
  collection,
  doc,
  addDoc,
  setDoc,
  deleteDoc,
  onSnapshot,
  query,
  orderBy,
  where,
  limit,
  serverTimestamp,
  Timestamp,
  getDoc,
  getDocs,
  writeBatch,
} from "firebase/firestore";
import { getDb } from "./firebase";
import { Channel, Message, ChannelMember, User, Bot, DmThread } from "./types";

function db() {
  return getDb();
}

// ── Nick colours ─────────────────────────────────────────────────────────────
const NICK_COLORS = [
  "#ff6b6b",
  "#ffa94d",
  "#ffd43b",
  "#69db7c",
  "#4dabf7",
  "#da77f2",
  "#f783ac",
  "#63e6be",
  "#74c0fc",
  "#ff8787",
  "#a9e34b",
  "#66d9e8",
];

export function getNickColor(nick: string): string {
  let hash = 0;
  for (const c of nick) hash = ((hash << 5) - hash + c.charCodeAt(0)) | 0;
  return NICK_COLORS[Math.abs(hash) % NICK_COLORS.length];
}

// ── Default channels seed ─────────────────────────────────────────────────────
const DEFAULT_CHANNELS: Omit<Channel, "memberCount">[] = [
  { id: "general", name: "#general", topic: "Welcome to 67t 🎉", createdAt: Date.now() },
  { id: "random", name: "#random", topic: "Off-topic, meme, chaos", createdAt: Date.now() },
  { id: "tech", name: "#tech", topic: "Dev talk & code snippets", createdAt: Date.now() },
  { id: "events", name: "#events", topic: "Annunci eventi e meetup", createdAt: Date.now() },
  { id: "bots", name: "#bots", topic: "Tutti i bot — DM un bot e /oper per gestirlo", createdAt: Date.now() },
];

export async function initDefaultChannels(): Promise<void> {
  const snapshot = await getDocs(collection(db(), "channels"));
  if (!snapshot.empty) return;
  const batch = writeBatch(db());
  for (const ch of DEFAULT_CHANNELS) {
    batch.set(doc(db(), "channels", ch.id), {
      name: ch.name,
      topic: ch.topic,
      memberCount: 0,
      createdAt: ch.createdAt,
    });
  }
  await batch.commit();
}

// ── Channels ──────────────────────────────────────────────────────────────────
export function subscribeToChannels(
  callback: (channels: Channel[]) => void
): () => void {
  const q = query(collection(db(), "channels"), orderBy("createdAt", "asc"));
  return onSnapshot(q, (snap) => {
    const channels: Channel[] = snap.docs.map((d) => ({
      id: d.id,
      ...(d.data() as Omit<Channel, "id">),
    }));
    callback(channels);
  });
}

export async function createChannel(
  name: string,
  topic: string
): Promise<string> {
  const id = name.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const ref = doc(db(), "channels", id);
  const existing = await getDoc(ref);
  if (existing.exists()) return id;
  await setDoc(ref, {
    name: `#${id}`,
    topic: topic || "No topic set",
    memberCount: 0,
    createdAt: Date.now(),
  });
  return id;
}

// ── Messages ──────────────────────────────────────────────────────────────────
export function subscribeToMessages(
  channelId: string,
  callback: (messages: Message[]) => void
): () => void {
  const q = query(
    collection(db(), "channels", channelId, "messages"),
    orderBy("timestamp", "asc"),
    limit(200)
  );
  return onSnapshot(q, (snap) => {
    const messages: Message[] = snap.docs.map((d) => {
      const data = d.data();
      return {
        id: d.id,
        userId: data.userId ?? "",
        nickname: data.nickname ?? "unknown",
        nickColor: data.nickColor ?? "#c9d1d9",
        text: data.text ?? "",
        timestamp:
          data.timestamp instanceof Timestamp
            ? data.timestamp.toMillis()
            : data.timestamp ?? Date.now(),
        type: data.type ?? "message",
      };
    });
    callback(messages);
  });
}

export async function sendMessage(
  channelId: string,
  user: User,
  text: string
): Promise<void> {
  await addDoc(collection(db(), "channels", channelId, "messages"), {
    userId: user.uid,
    nickname: user.nickname,
    nickColor: user.nickColor,
    text,
    timestamp: serverTimestamp(),
    type: "message",
  });
}

async function sendSystemMessage(
  channelId: string,
  text: string,
  type: "join" | "leave" | "system"
): Promise<void> {
  await addDoc(collection(db(), "channels", channelId, "messages"), {
    userId: "system",
    nickname: "***",
    nickColor: "#8b949e",
    text,
    timestamp: serverTimestamp(),
    type,
  });
}

// ── Presence / Members ────────────────────────────────────────────────────────
export function subscribeToMembers(
  channelId: string,
  callback: (members: ChannelMember[]) => void
): () => void {
  const q = query(collection(db(), "channels", channelId, "members"));
  return onSnapshot(q, (snap) => {
    const now = Date.now();
    const members: ChannelMember[] = snap.docs
      .map((d) => ({ userId: d.id, ...(d.data() as Omit<ChannelMember, "userId">) }))
      // consider a user online if seen in the last 60 seconds
      .filter((m) => now - m.lastSeen < 60_000)
      .sort((a, b) => (b.isOp ? 1 : 0) - (a.isOp ? 1 : 0));
    callback(members);
  });
}

export async function joinChannel(
  channelId: string,
  user: User
): Promise<void> {
  await setDoc(doc(db(), "channels", channelId, "members", user.uid), {
    nickname: user.nickname,
    nickColor: user.nickColor,
    lastSeen: Date.now(),
    isOp: false,
    voice: false,
  });
  await sendSystemMessage(
    channelId,
    `${user.nickname} has joined ${channelId === "general" ? "#general" : `#${channelId}`}`,
    "join"
  );
}

export async function leaveChannel(
  channelId: string,
  user: User
): Promise<void> {
  await deleteDoc(doc(db(), "channels", channelId, "members", user.uid));
  await sendSystemMessage(
    channelId,
    `${user.nickname} has left`,
    "leave"
  );
}

export async function heartbeat(channelId: string, uid: string): Promise<void> {
  const ref = doc(db(), "channels", channelId, "members", uid);
  const snap = await getDoc(ref);
  if (snap.exists()) {
    await setDoc(ref, { lastSeen: Date.now() }, { merge: true });
  }
}

// ── mIRC-style command helpers ────────────────────────────────────────────────
export async function setChannelTopic(
  channelId: string,
  topic: string
): Promise<void> {
  await setDoc(
    doc(db(), "channels", channelId),
    { topic: topic || "No topic set" },
    { merge: true }
  );
}

export async function sendActionMessage(
  channelId: string,
  user: User,
  text: string
): Promise<void> {
  await addDoc(collection(db(), "channels", channelId, "messages"), {
    userId: user.uid,
    nickname: user.nickname,
    nickColor: user.nickColor,
    text,
    timestamp: serverTimestamp(),
    type: "action",
  });
}

export async function renameMember(
  channelId: string,
  uid: string,
  nickname: string,
  nickColor: string
): Promise<void> {
  const ref = doc(db(), "channels", channelId, "members", uid);
  const snap = await getDoc(ref);
  if (snap.exists()) {
    await setDoc(ref, { nickname, nickColor }, { merge: true });
  }
}

// Public wrapper to post a "*** …" system line to a channel.
export async function announce(
  channelId: string,
  text: string
): Promise<void> {
  await sendSystemMessage(channelId, text, "system");
}

// ── Private messages (DMs) ────────────────────────────────────────────────────
function dmId(a: string, b: string): string {
  return [a, b].sort().join("__");
}

export async function sendDm(
  me: User,
  otherUid: string,
  otherNick: string,
  text: string
): Promise<void> {
  const id = dmId(me.uid, otherUid);
  await setDoc(
    doc(db(), "dms", id),
    {
      participants: [me.uid, otherUid].sort(),
      nicks: { [me.uid]: me.nickname, [otherUid]: otherNick },
      updatedAt: Date.now(),
      lastFrom: me.uid,
      lastText: text.slice(0, 120),
    },
    { merge: true }
  );
  await addDoc(collection(db(), "dms", id, "messages"), {
    fromUid: me.uid,
    fromNick: me.nickname,
    fromColor: me.nickColor,
    text,
    timestamp: serverTimestamp(),
  });
}

export async function sendNudge(
  me: User,
  otherUid: string,
  otherNick: string
): Promise<void> {
  const id = dmId(me.uid, otherUid);
  await setDoc(
    doc(db(), "dms", id),
    {
      participants: [me.uid, otherUid].sort(),
      nicks: { [me.uid]: me.nickname, [otherUid]: otherNick },
      updatedAt: Date.now(),
      lastFrom: me.uid,
      lastText: "⚡ Trillo!",
    },
    { merge: true }
  );
  await addDoc(collection(db(), "dms", id, "messages"), {
    fromUid: me.uid,
    fromNick: me.nickname,
    fromColor: me.nickColor,
    text: "⚡ Trillo!",
    kind: "nudge",
    timestamp: serverTimestamp(),
  });
}

export function subscribeDmMessages(
  convoId: string,
  callback: (messages: Message[]) => void
): () => void {
  const q = query(
    collection(db(), "dms", convoId, "messages"),
    orderBy("timestamp", "asc"),
    limit(200)
  );
  return onSnapshot(q, (snap) => {
    const messages: Message[] = snap.docs.map((d) => {
      const data = d.data();
      return {
        id: d.id,
        userId: data.fromUid ?? "",
        nickname: data.fromNick ?? "unknown",
        nickColor: data.fromColor ?? "#c9d1d9",
        text: data.text ?? "",
        timestamp:
          data.timestamp instanceof Timestamp
            ? data.timestamp.toMillis()
            : data.timestamp ?? Date.now(),
        type: "message",
        nudge: data.kind === "nudge",
      };
    });
    callback(messages);
  });
}

export function subscribeDmThreads(
  myUid: string,
  callback: (threads: DmThread[]) => void
): () => void {
  const q = query(
    collection(db(), "dms"),
    where("participants", "array-contains", myUid)
  );
  return onSnapshot(q, (snap) => {
    const threads: DmThread[] = snap.docs
      .map((d) => {
        const data = d.data();
        const other =
          (data.participants as string[] | undefined)?.find(
            (p) => p !== myUid
          ) ?? "";
        return {
          convoId: d.id,
          otherUid: other,
          otherNick: (data.nicks ?? {})[other] ?? "?",
          updatedAt: data.updatedAt ?? 0,
          lastFrom: data.lastFrom ?? "",
        };
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);
    callback(threads);
  });
}

// ── Bots ──────────────────────────────────────────────────────────────────────
// Live list of enabled bots from the /bots registry (public-read). The UI shows
// these as members of the channels they operate in.
export function subscribeToBots(callback: (bots: Bot[]) => void): () => void {
  // returns all bots (incl. disabled) so operators can reconfigure them
  return onSnapshot(collection(db(), "bots"), (snap) => {
    const bots: Bot[] = snap.docs.map((d) => ({
      id: d.id,
      ...(d.data() as Omit<Bot, "id">),
    }));
    callback(bots);
  });
}
