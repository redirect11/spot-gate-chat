"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { signInAnonymously } from "firebase/auth";
import { httpsCallable } from "firebase/functions";
import { getFirebaseAuth, getAppFunctions } from "@/lib/firebase";
import {
  getNickColor,
  initDefaultChannels,
  subscribeToChannels,
  subscribeToMessages,
  subscribeToMembers,
  sendMessage,
  joinChannel,
  leaveChannel,
  createChannel,
  heartbeat,
  setChannelTopic,
  sendActionMessage,
  renameMember,
  announce,
  subscribeToBots,
  sendDm,
  sendNudge,
  subscribeDmMessages,
  subscribeDmThreads,
} from "@/lib/firestore";
import { Bot, Channel, ChannelMember, DmThread, Message, User } from "@/lib/types";
import {
  notify,
  beep,
  msnNudge,
  requestNotificationPermission,
} from "@/lib/notifications";
import { COMMANDS, buildHelp } from "@/lib/commands";

import Logo67th from "./Logo67th";
import NicknameModal from "./NicknameModal";
import ChannelList from "./ChannelList";
import ChatArea from "./ChatArea";
import UserList from "./UserList";
import MessageInput from "./MessageInput";

const STORAGE_KEY = "67th_user";

// Safari (private mode, "Prevent cross-site tracking", partitioned/blocked
// storage) can THROW on localStorage access. If unguarded, the bootstrap effect
// throws before setLoading(false) runs and the app hangs on the loading screen,
// so the nickname modal never appears. These helpers never throw.
function safeGetItem(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function safeSetItem(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable — continue in-memory only */
  }
}

// crypto.randomUUID exists only in secure contexts and Safari 15.4+. Fall back
// to getRandomValues (universally supported) so connecting never throws.
function safeUUID(): string {
  try {
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
      return crypto.randomUUID();
    }
  } catch {
    /* fall through */
  }
  const b = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export default function ChatApp() {
  const [user, setUser] = useState<User | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [currentChannelId, setCurrentChannelId] = useState("general");
  const [messages, setMessages] = useState<Message[]>([]);
  const [members, setMembers] = useState<ChannelMember[]>([]);
  const [bots, setBots] = useState<Bot[]>([]);
  const [logoTriggered, setLogoTriggered] = useState(false);
  const [loading, setLoading] = useState(true);
  // Mobile off-canvas drawers (ignored on desktop where panels are always shown)
  const [leftOpen, setLeftOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);
  // Local-only notices (/help, /list, /names, unknown command) + /clear cutoff
  const [localNotices, setLocalNotices] = useState<Message[]>([]);
  const [clearedAt, setClearedAt] = useState(0);
  const noticeSeq = useRef(0);
  // Notifications: channels the user has entered + per-channel unread counts
  const [joinedChannels, setJoinedChannels] = useState<string[]>(["general"]);
  const [unread, setUnread] = useState<Record<string, number>>({});
  const seenIds = useRef<Map<string, Set<string>>>(new Map());
  const currentChannelIdRef = useRef(currentChannelId);
  currentChannelIdRef.current = currentChannelId;
  // Operator (admin) state — password held in-session, re-checked server-side
  const [isAdmin, setIsAdmin] = useState(false);
  const adminPwdRef = useRef<string | null>(null);
  // Private messages (DMs)
  const [dmThreads, setDmThreads] = useState<DmThread[]>([]);
  const [currentDm, setCurrentDm] = useState<{ uid: string; nick: string } | null>(null);
  const [dmMessages, setDmMessages] = useState<Message[]>([]);
  // locally-closed DMs (otherUid -> updatedAt at close); reappear on newer msg
  const [closedDms, setClosedDms] = useState<Record<string, number>>({});
  const [shaking, setShaking] = useState(false);
  const dmSeenMsgIds = useRef<Set<string>>(new Set());

  const triggerNudge = useCallback(() => {
    msnNudge();
    setShaking(true);
    setTimeout(() => setShaking(false), 800);
  }, []);
  const dmSeen = useRef<Map<string, number>>(new Map()); // convoId -> last updatedAt seen
  const currentDmRef = useRef<{ uid: string; nick: string } | null>(null);
  currentDmRef.current = currentDm;

  // Refs for cleanup
  const channelUnsub = useRef<(() => void) | null>(null);
  const membersUnsub = useRef<(() => void) | null>(null);
  const msgUnsub = useRef<(() => void) | null>(null);
  const heartbeatInterval = useRef<ReturnType<typeof setInterval> | null>(null);
  const prevChannelRef = useRef<string | null>(null);
  // Tracks the channel we've already announced a join for, so the effect
  // re-running for the same channel doesn't post a duplicate "X has joined".
  const joinedChannelRef = useRef<string | null>(null);

  // ── Bootstrap ───────────────────────────────────────────────────────────────
  useEffect(() => {
    const saved = safeGetItem(STORAGE_KEY);
    if (saved) {
      try {
        const parsed = JSON.parse(saved) as User;
        rehydrateUser(parsed);
      } catch {
        setLoading(false);
      }
    } else {
      setLoading(false);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // ^ empty deps intentional: runs once on mount; rehydrateUser is defined below
  //   and depends on Firebase which must only run client-side

  const rehydrateUser = async (saved: User) => {
    try {
      const auth = getFirebaseAuth();
      await signInAnonymously(auth);
      const uid = auth.currentUser?.uid ?? saved.uid;
      const u: User = { ...saved, uid };
      setUser(u);
      safeSetItem(STORAGE_KEY, JSON.stringify(u));
      // refresh our nick reservation (best-effort)
      httpsCallable(getAppFunctions(), "claimNick")({
        uid,
        nick: u.nickname,
        oldNick: u.nickname,
      }).catch(() => {});
    } catch {
      // Firebase not configured — run in demo mode
      setUser(saved);
    } finally {
      setLoading(false);
    }
  };

  // ── Auth + channel init ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!user) return;
    let cancelled = false;

    (async () => {
      try {
        await initDefaultChannels();
      } catch {
        // offline or not configured — ignore
      }

      if (cancelled) return;

      channelUnsub.current = subscribeToChannels((chs) => {
        setChannels(chs);
      });
    })();

    return () => {
      cancelled = true;
      channelUnsub.current?.();
    };
  }, [user]);

  // ── Switch channel ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!user) return;

    const prev = prevChannelRef.current;

    // Leave previous channel
    if (prev && prev !== currentChannelId) {
      leaveChannel(prev, user).catch(() => {});
    }

    prevChannelRef.current = currentChannelId;

    // Unsubscribe old listeners
    msgUnsub.current?.();
    membersUnsub.current?.();
    if (heartbeatInterval.current) clearInterval(heartbeatInterval.current);

    setMessages([]);
    setMembers([]);
    setLocalNotices([]);
    setClearedAt(0);

    // Join new channel — guard so a re-run for the same channel doesn't
    // produce a duplicate join message.
    if (joinedChannelRef.current !== currentChannelId) {
      joinedChannelRef.current = currentChannelId;
      joinChannel(currentChannelId, user).catch(() => {});
    }

    // Subscribe to messages + members
    msgUnsub.current = subscribeToMessages(currentChannelId, setMessages);
    membersUnsub.current = subscribeToMembers(currentChannelId, setMembers);

    // Heartbeat every 30 s
    heartbeatInterval.current = setInterval(() => {
      heartbeat(currentChannelId, user.uid).catch(() => {});
    }, 30_000);

    return () => {
      msgUnsub.current?.();
      membersUnsub.current?.();
      if (heartbeatInterval.current) clearInterval(heartbeatInterval.current);
    };
  }, [user, currentChannelId]);

  // ── Cleanup on unmount ──────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      if (user && prevChannelRef.current) {
        leaveChannel(prevChannelRef.current, user).catch(() => {});
      }
    };
  }, [user]);

  // ── Notifications ─────────────────────────────────────────────────────────────
  // Remember every channel the user enters, and clear its unread badge when it
  // becomes the active channel.
  useEffect(() => {
    setJoinedChannels((prev) =>
      prev.includes(currentChannelId) ? prev : [...prev, currentChannelId]
    );
    setUnread((prev) =>
      prev[currentChannelId] ? { ...prev, [currentChannelId]: 0 } : prev
    );
  }, [currentChannelId]);

  // Ask for browser-notification permission once the user is in.
  useEffect(() => {
    if (user) requestNotificationPermission();
  }, [user]);

  // Restore operator status within the session (re-verified by the server on use).
  useEffect(() => {
    try {
      const pwd = sessionStorage.getItem("67th_oper");
      if (pwd) {
        adminPwdRef.current = pwd;
        setIsAdmin(true);
      }
    } catch {
      /* sessionStorage unavailable */
    }
  }, []);

  // Live list of bots (shown as channel members).
  useEffect(() => {
    if (!user) return;
    const unsub = subscribeToBots(setBots);
    return () => unsub();
  }, [user]);

  // Record a salted IP hash (server-side) so bans can survive uid/nick changes.
  useEffect(() => {
    if (!user) return;
    httpsCallable(getAppFunctions(), "recordPresence")({ uid: user.uid }).catch(
      () => {}
    );
  }, [user]);

  // DM threads (private message list) + notifications for new incoming DMs.
  useEffect(() => {
    if (!user) return;
    const unsub = subscribeDmThreads(user.uid, (threads) => {
      setDmThreads(threads);
      for (const t of threads) {
        const prev = dmSeen.current.get(t.convoId);
        if (prev === undefined) {
          dmSeen.current.set(t.convoId, t.updatedAt);
          continue; // baseline — don't notify existing threads
        }
        if (t.updatedAt > prev) {
          dmSeen.current.set(t.convoId, t.updatedAt);
          const viewing = currentDmRef.current?.uid === t.otherUid;
          if (t.lastFrom !== user.uid && !viewing) {
            setUnread((u) => ({
              ...u,
              [`dm:${t.otherUid}`]: (u[`dm:${t.otherUid}`] || 0) + 1,
            }));
            beep(); // audible blip for incoming PMs
            if (typeof document !== "undefined" && document.hidden) {
              notify(`@${t.otherNick}`, "Nuovo messaggio privato");
            }
          }
        }
      }
    });
    return () => unsub();
  }, [user]);

  // Subscribe to the open DM's messages (+ detect incoming nudges/trilli).
  useEffect(() => {
    if (!user || !currentDm) {
      setDmMessages([]);
      return;
    }
    const convoId = [user.uid, currentDm.uid].sort().join("__");
    dmSeenMsgIds.current = new Set();
    let baselined = false;
    const unsub = subscribeDmMessages(convoId, (msgs) => {
      if (!baselined) {
        msgs.forEach((m) => dmSeenMsgIds.current.add(m.id));
        baselined = true;
      } else {
        for (const m of msgs) {
          if (!dmSeenMsgIds.current.has(m.id)) {
            dmSeenMsgIds.current.add(m.id);
            if (m.nudge && m.userId !== user.uid) triggerNudge();
          }
        }
      }
      setDmMessages(msgs);
    });
    setUnread((u) =>
      u[`dm:${currentDm.uid}`] ? { ...u, [`dm:${currentDm.uid}`]: 0 } : u
    );
    return () => unsub();
  }, [user, currentDm, triggerNudge]);

  // Background-subscribe to every entered channel to detect new chat messages
  // (only real messages/actions from other people — not system/join/leave or
  // the user's own). Increments the unread badge and, when the tab is hidden,
  // fires a browser notification. The active channel never notifies.
  useEffect(() => {
    if (!user) return;
    const unsubs = joinedChannels.map((cid) =>
      subscribeToMessages(cid, (msgs) => {
        const seen = seenIds.current.get(cid);
        if (!seen) {
          // First snapshot for this channel = baseline; don't notify history.
          seenIds.current.set(cid, new Set(msgs.map((m) => m.id)));
          return;
        }
        const fresh = msgs.filter((m) => !seen.has(m.id));
        fresh.forEach((m) => seen.add(m.id));
        if (cid === currentChannelIdRef.current) return; // user is viewing it
        const notifiable = fresh.filter(
          (m) =>
            (m.type === "message" || m.type === "action") &&
            m.userId !== user.uid
        );
        if (notifiable.length === 0) return;
        setUnread((prev) => ({
          ...prev,
          [cid]: (prev[cid] || 0) + notifiable.length,
        }));
        if (typeof document !== "undefined" && document.hidden) {
          const last = notifiable[notifiable.length - 1];
          notify(`#${cid}`, `<${last.nickname}> ${last.text}`);
        }
      })
    );
    return () => unsubs.forEach((u) => u());
  }, [user, joinedChannels]);

  // Reflect total unread in the tab title.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const total = Object.values(unread).reduce((a, b) => a + b, 0);
    document.title =
      total > 0 ? `(${total}) 67t — mIRC-style chat` : "67t — mIRC-style chat";
  }, [unread]);

  // ── Handlers ────────────────────────────────────────────────────────────────
  const handleNicknameConfirm = async (
    nickname: string
  ): Promise<string | null> => {
    const nickColor = getNickColor(nickname);
    let uid = `anon_${safeUUID()}`;

    try {
      const auth = getFirebaseAuth();
      const cred = await signInAnonymously(auth);
      uid = cred.user.uid;
    } catch {
      // Firebase not configured
    }

    // Server confirms the nickname is free (unique) before we register.
    try {
      await httpsCallable(getAppFunctions(), "claimNick")({ uid, nick: nickname });
    } catch {
      return "Nickname già in uso — scegline un altro.";
    }

    const u: User = { uid, nickname, nickColor };
    safeSetItem(STORAGE_KEY, JSON.stringify(u));
    setUser(u);
    return null;
  };

  const pushNotice = useCallback((text: string) => {
    setLocalNotices((prev) => [
      ...prev,
      {
        id: `local_${Date.now()}_${noticeSeq.current++}`,
        userId: "system",
        nickname: "***",
        nickColor: "#8b949e",
        text,
        timestamp: Date.now(),
        type: "system",
      },
    ]);
  }, []);

  const changeNick = async (raw: string) => {
    if (!user) return;
    const nick = raw.trim().replace(/\s+/g, "_").slice(0, 20);
    if (!nick) {
      pushNotice("Uso: /nick <nuovo_nome>");
      return;
    }
    if (nick === user.nickname) return;
    try {
      await httpsCallable(getAppFunctions(), "claimNick")({
        uid: user.uid,
        nick,
        oldNick: user.nickname,
      });
    } catch {
      pushNotice("Nickname già in uso — scegline un altro.");
      return;
    }
    const nickColor = getNickColor(nick);
    const old = user.nickname;
    const updated: User = { ...user, nickname: nick, nickColor };
    safeSetItem(STORAGE_KEY, JSON.stringify(updated));
    await renameMember(currentChannelId, user.uid, nick, nickColor).catch(
      () => {}
    );
    await announce(
      currentChannelId,
      `${old} ora è conosciuto come ${nick}`
    ).catch(() => {});
    setUser(updated);
  };

  const adminCall = async (action: string, args: Record<string, string>) => {
    const fn = httpsCallable(getAppFunctions(), "adminCommand");
    await fn({ password: adminPwdRef.current ?? "", action, args });
  };

  const handleQuit = async () => {
    if (user && prevChannelRef.current) {
      await leaveChannel(prevChannelRef.current, user).catch(() => {});
    }
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* storage unavailable */
    }
    joinedChannelRef.current = null;
    prevChannelRef.current = null;
    setUser(null);
  };

  const handleCommand = async (raw: string) => {
    if (!user) return;
    const body = raw.slice(1).trim();
    const parts = body.split(/\s+/);
    const cmd = (parts.shift() || "").toLowerCase();
    const arg = body.slice(cmd.length).trim();

    switch (cmd) {
      case "help": {
        const which = parts[0]?.replace(/^\//, "").toLowerCase();
        if (which) {
          const c = COMMANDS.find((x) => x.name === which);
          // don't reveal operator commands to non-operators
          pushNotice(
            c && (!c.op || isAdmin)
              ? `${c.usage} — ${c.desc}${c.op ? " (operatore)" : ""}`
              : `Comando sconosciuto: /${which}`
          );
        } else {
          pushNotice(buildHelp(isAdmin));
        }
        break;
      }
      case "me":
        if (arg) await sendActionMessage(currentChannelId, user, arg).catch(() => {});
        else pushNotice("Uso: /me <azione>");
        break;
      case "nick":
        await changeNick(arg);
        break;
      case "join": {
        const name = (parts[0] || arg).replace(/^#+/, "");
        if (name) await handleCreateChannel(name, "");
        else pushNotice("Uso: /join #canale");
        break;
      }
      case "part":
      case "leave":
        if (currentChannelId !== "general") setCurrentChannelId("general");
        else pushNotice("Sei già in #general");
        break;
      case "topic":
        if (arg) {
          await setChannelTopic(currentChannelId, arg).catch(() => {});
          await announce(
            currentChannelId,
            `${user.nickname} ha cambiato il topic in: ${arg}`
          ).catch(() => {});
        } else {
          pushNotice("Uso: /topic <testo>");
        }
        break;
      case "list":
        pushNotice(
          channels.length
            ? "Canali: " + channels.map((c) => c.name).join(", ")
            : "Nessun canale."
        );
        break;
      case "names":
      case "users":
        pushNotice(
          `Utenti online (${members.length}): ` +
            members.map((m) => m.nickname).join(", ")
        );
        break;
      case "clear":
        setClearedAt(Date.now());
        setLocalNotices([]);
        break;
      case "quit":
        await handleQuit();
        break;

      // ── Operator commands ──────────────────────────────────────────────────
      case "oper": {
        const pwd = arg.trim();
        if (!pwd) {
          pushNotice("Uso: /oper <password>");
          break;
        }
        try {
          const fn = httpsCallable(getAppFunctions(), "adminCommand");
          await fn({ password: pwd, action: "verify" });
          adminPwdRef.current = pwd;
          setIsAdmin(true);
          try {
            sessionStorage.setItem("67th_oper", pwd);
          } catch {
            /* ignore */
          }
          pushNotice("✅ Sei ora operatore. Comandi: /botoff /boton /say /kick");
        } catch {
          pushNotice("❌ Password operatore errata.");
        }
        break;
      }
      case "boton":
      case "botoff": {
        if (!isAdmin) {
          pushNotice("Comando riservato agli operatori — /oper <password>");
          break;
        }
        const id = parts[0];
        if (!id) {
          pushNotice(`Uso: /${cmd} <bot-id>`);
          break;
        }
        try {
          await adminCall(cmd === "boton" ? "bot.enable" : "bot.disable", {
            botId: id,
          });
          pushNotice(
            `Bot "${id}" ${cmd === "boton" ? "attivato" : "disattivato"}.`
          );
        } catch {
          pushNotice("Operazione fallita.");
        }
        break;
      }
      case "botreply": {
        if (!isAdmin) {
          pushNotice("Comando riservato agli operatori — /oper <password>");
          break;
        }
        const id = parts[0];
        const mode = (parts[1] || "").toLowerCase();
        if (!id || (mode !== "on" && mode !== "off")) {
          pushNotice("Uso: /botreply <bot-id> on|off");
          break;
        }
        try {
          await adminCall(mode === "on" ? "bot.repliesOn" : "bot.repliesOff", {
            botId: id,
          });
          pushNotice(
            `Risposte AI di "${id}" ${mode === "on" ? "attivate" : "disattivate"}.`
          );
        } catch {
          pushNotice("Operazione fallita.");
        }
        break;
      }
      case "say": {
        if (!isAdmin) {
          pushNotice("Comando riservato agli operatori — /oper <password>");
          break;
        }
        const id = parts[0];
        const text = arg.slice((id || "").length).trim();
        if (!id || !text) {
          pushNotice("Uso: /say <bot-id> <testo>");
          break;
        }
        try {
          await adminCall("bot.say", {
            botId: id,
            channelId: currentChannelId,
            text,
          });
        } catch {
          pushNotice("Operazione fallita.");
        }
        break;
      }
      case "kick": {
        if (!isAdmin) {
          pushNotice("Comando riservato agli operatori — /oper <password>");
          break;
        }
        const nick = parts[0];
        if (!nick) {
          pushNotice("Uso: /kick <nick>");
          break;
        }
        const target = members.find(
          (m) => m.nickname.toLowerCase() === nick.toLowerCase()
        );
        if (!target) {
          pushNotice(`Utente "${nick}" non trovato in questo canale.`);
          break;
        }
        try {
          await adminCall("kick", {
            channelId: currentChannelId,
            uid: target.userId,
            nick: target.nickname,
          });
        } catch {
          pushNotice("Kick fallito.");
        }
        break;
      }
      case "ban": {
        if (!isAdmin) {
          pushNotice("Comando riservato agli operatori — /oper <password>");
          break;
        }
        const nick = parts[0];
        if (!nick) {
          pushNotice("Uso: /ban <nick>");
          break;
        }
        // ban works even if the user isn't currently in the member list
        const target = members.find(
          (m) => m.nickname.toLowerCase() === nick.toLowerCase()
        );
        try {
          await adminCall("ban", {
            channelId: currentChannelId,
            uid: target?.userId ?? "",
            nick: target?.nickname ?? nick,
          });
          pushNotice(`🔨 ${nick} bannato.`);
        } catch {
          pushNotice("Ban fallito.");
        }
        break;
      }
      case "unban": {
        if (!isAdmin) {
          pushNotice("Comando riservato agli operatori — /oper <password>");
          break;
        }
        const nick = parts[0];
        if (!nick) {
          pushNotice("Uso: /unban <nick>");
          break;
        }
        try {
          await adminCall("unban", { nick });
          pushNotice(`${nick} sbannato.`);
        } catch {
          pushNotice("Unban fallito.");
        }
        break;
      }
      case "op":
      case "deop":
      case "mute":
      case "unmute":
      case "voice":
      case "devoice": {
        if (!isAdmin) {
          pushNotice("Comando riservato agli operatori — /oper <password>");
          break;
        }
        const nick = parts[0];
        if (!nick) {
          pushNotice(`Uso: /${cmd} <nick>`);
          break;
        }
        const target = members.find(
          (m) => m.nickname.toLowerCase() === nick.toLowerCase()
        );
        if (!target) {
          pushNotice(`Utente "${nick}" non trovato in questo canale.`);
          break;
        }
        try {
          await adminCall(cmd, {
            channelId: currentChannelId,
            uid: target.userId,
            nick: target.nickname,
          });
        } catch {
          pushNotice(`Operazione /${cmd} fallita.`);
        }
        break;
      }
      case "msg":
      case "query": {
        const nick = parts[0];
        const text = arg.slice((nick || "").length).trim();
        if (!nick) {
          pushNotice("Uso: /msg <nick> <testo>");
          break;
        }
        const target = members.find(
          (m) => m.nickname.toLowerCase() === nick.toLowerCase()
        );
        if (!target) {
          pushNotice(
            `Utente "${nick}" non presente in questo canale — apri un DM da chi è online.`
          );
          break;
        }
        if (target.userId === user.uid) {
          pushNotice("Non puoi scriverti da solo.");
          break;
        }
        openDm(target.userId, target.nickname);
        if (text) {
          try {
            await sendDm(user, target.userId, target.nickname, text);
          } catch {
            pushNotice("Invio DM fallito.");
          }
        }
        break;
      }
      case "mutechannel":
      case "unmutechannel": {
        if (!isAdmin) {
          pushNotice("Comando riservato agli operatori — /oper <password>");
          break;
        }
        try {
          await adminCall(
            cmd === "mutechannel" ? "channel.mute" : "channel.unmute",
            { channelId: currentChannelId }
          );
        } catch {
          pushNotice("Operazione fallita.");
        }
        break;
      }

      default:
        pushNotice(`Comando sconosciuto: /${cmd} — scrivi /help`);
    }
  };

  const handleSend = async (text: string) => {
    if (!user) return;
    if (text.startsWith("/")) {
      await handleCommand(text);
      return;
    }
    if (currentDm) {
      try {
        await sendDm(user, currentDm.uid, currentDm.nick, text);
      } catch {
        console.error("Failed to send DM");
      }
      return;
    }
    try {
      await sendMessage(currentChannelId, user, text);
    } catch {
      console.error("Failed to send message");
    }
  };

  const handleSelectChannel = useCallback((channelId: string) => {
    setCurrentChannelId(channelId);
    setCurrentDm(null); // leaving DM view
    setLeftOpen(false); // close the drawer after picking a channel on mobile
  }, []);

  const openDm = useCallback((uid: string, nick: string) => {
    setCurrentDm({ uid, nick });
    setClosedDms((p) => {
      if (p[uid] === undefined) return p;
      const next = { ...p };
      delete next[uid]; // reopening clears the closed flag
      return next;
    });
    setLeftOpen(false);
  }, []);

  const closeDm = useCallback((uid: string, updatedAt: number) => {
    setClosedDms((p) => ({ ...p, [uid]: updatedAt || Date.now() }));
    setCurrentDm((cur) => (cur?.uid === uid ? null : cur));
  }, []);

  const handleNudge = useCallback(async () => {
    if (!user || !currentDm) return;
    triggerNudge();
    try {
      await sendNudge(user, currentDm.uid, currentDm.nick);
    } catch {
      /* ignore */
    }
  }, [user, currentDm, triggerNudge]);

  const handleCreateChannel = async (name: string, topic: string) => {
    try {
      const id = await createChannel(name, topic);
      setCurrentChannelId(id);
    } catch {
      console.error("Failed to create channel");
    }
  };

  const handleLogoAnimEnd = useCallback(() => setLogoTriggered(false), []);

  // ── Render ──────────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="app-loading">
        <Logo67th triggered={false} onAnimationEnd={() => {}} />
        <span className="loading-dots">connecting…</span>
      </div>
    );
  }

  if (!user) {
    return <NicknameModal onConfirm={handleNicknameConfirm} />;
  }

  const currentChannel =
    channels.find((c) => c.id === currentChannelId) ?? null;

  // Merge live messages with local-only notices, drop anything before /clear.
  const displayMessages = [...messages, ...localNotices]
    .filter((m) => m.timestamp > clearedAt)
    .sort((a, b) => a.timestamp - b.timestamp);

  // Bots that operate in the current channel — shown as members.
  const channelBots = bots.filter(
    (b) => b.channels?.includes("*") || b.channels?.includes(currentChannelId)
  );

  // Active view: a channel, or a private conversation (DM).
  const viewMessages = currentDm ? dmMessages : displayMessages;
  const viewName = currentDm
    ? `@${currentDm.nick}`
    : currentChannel?.name ?? `#${currentChannelId}`;
  const viewTopic = currentDm
    ? "conversazione privata — visibile solo a voi due"
    : currentChannel?.topic ?? "";

  // DM list shown in the sidebar = real threads (minus locally-closed ones)
  // + the currently-open one (even before the first message, like an mIRC
  // query window — local only).
  const visibleThreads = dmThreads.filter((t) => {
    const cl = closedDms[t.otherUid];
    return cl === undefined || t.updatedAt > cl;
  });
  const dmList: DmThread[] =
    currentDm && !visibleThreads.some((t) => t.otherUid === currentDm.uid)
      ? [
          {
            convoId: `local_${currentDm.uid}`,
            otherUid: currentDm.uid,
            otherNick: currentDm.nick,
            updatedAt: Date.now(),
            lastFrom: "",
          },
          ...visibleThreads,
        ]
      : visibleThreads;

  return (
    <div className={`app-root${shaking ? " app-shake" : ""}`}>
      {/* Header */}
      <header className="app-header">
        <button
          className="app-menu-btn app-menu-left"
          onClick={() => setLeftOpen(true)}
          aria-label="Apri canali"
        >
          ☰
        </button>

        <h1 className="app-title">
          <Logo67th triggered={logoTriggered} onAnimationEnd={handleLogoAnimEnd} />
        </h1>

        <div className="app-header-info">
          <span className="app-nick" style={{ color: user.nickColor }}>
            {user.nickname}
          </span>
          <span className="app-status"> ● online</span>
        </div>

        <button
          className="app-menu-btn app-menu-right"
          onClick={() => setRightOpen(true)}
          aria-label="Apri utenti"
        >
          ♟ {members.length + channelBots.length}
        </button>
      </header>

      {/* Three-column body */}
      <div className="app-body">
        {(leftOpen || rightOpen) && (
          <div
            className="drawer-backdrop"
            onClick={() => {
              setLeftOpen(false);
              setRightOpen(false);
            }}
          />
        )}

        <ChannelList
          channels={channels}
          currentChannelId={currentChannelId}
          onSelect={handleSelectChannel}
          onCreateChannel={handleCreateChannel}
          unread={unread}
          dmThreads={dmList}
          activeDmUid={currentDm?.uid ?? null}
          onSelectDm={openDm}
          onCloseDm={closeDm}
          open={leftOpen}
          onClose={() => setLeftOpen(false)}
        />

        <div className="app-center">
          <ChatArea
            messages={viewMessages}
            channelName={viewName}
            topic={viewTopic}
          />
          <MessageInput
            channelName={viewName}
            onSend={handleSend}
            onTyping67th={() => setLogoTriggered(true)}
            isAdmin={isAdmin}
            onNudge={currentDm ? handleNudge : undefined}
          />
        </div>

        <UserList
          members={members}
          bots={channelBots}
          currentUserId={user.uid}
          onUserClick={(uid, nick) => {
            openDm(uid, nick);
            setRightOpen(false);
          }}
          open={rightOpen}
          onClose={() => setRightOpen(false)}
        />
      </div>
    </div>
  );
}
