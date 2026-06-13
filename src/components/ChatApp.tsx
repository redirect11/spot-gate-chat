"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { signInAnonymously } from "firebase/auth";
import { getFirebaseAuth } from "@/lib/firebase";
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
} from "@/lib/firestore";
import { Channel, ChannelMember, Message, User } from "@/lib/types";

import Logo67th from "./Logo67th";
import NicknameModal from "./NicknameModal";
import ChannelList from "./ChannelList";
import ChatArea from "./ChatArea";
import UserList from "./UserList";
import MessageInput from "./MessageInput";

const STORAGE_KEY = "67th_user";

export default function ChatApp() {
  const [user, setUser] = useState<User | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [currentChannelId, setCurrentChannelId] = useState("general");
  const [messages, setMessages] = useState<Message[]>([]);
  const [members, setMembers] = useState<ChannelMember[]>([]);
  const [logoTriggered, setLogoTriggered] = useState(false);
  const [loading, setLoading] = useState(true);

  // Refs for cleanup
  const channelUnsub = useRef<(() => void) | null>(null);
  const membersUnsub = useRef<(() => void) | null>(null);
  const msgUnsub = useRef<(() => void) | null>(null);
  const heartbeatInterval = useRef<ReturnType<typeof setInterval> | null>(null);
  const prevChannelRef = useRef<string | null>(null);

  // ── Bootstrap ───────────────────────────────────────────────────────────────
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
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
      localStorage.setItem(STORAGE_KEY, JSON.stringify(u));
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

    // Join new channel
    joinChannel(currentChannelId, user).catch(() => {});

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

  // ── Handlers ────────────────────────────────────────────────────────────────
  const handleNicknameConfirm = async (nickname: string) => {
    const nickColor = getNickColor(nickname);
    let uid = `anon_${crypto.randomUUID()}`;

    try {
      const auth = getFirebaseAuth();
      const cred = await signInAnonymously(auth);
      uid = cred.user.uid;
    } catch {
      // Firebase not configured
    }

    const u: User = { uid, nickname, nickColor };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(u));
    setUser(u);
  };

  const handleSend = async (text: string) => {
    if (!user) return;
    try {
      await sendMessage(currentChannelId, user, text);
    } catch {
      console.error("Failed to send message");
    }
  };

  const handleSelectChannel = useCallback((channelId: string) => {
    setCurrentChannelId(channelId);
  }, []);

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

  return (
    <div className="app-root">
      {/* Header */}
      <header className="app-header">
        <h1 className="app-title">
          <Logo67th triggered={logoTriggered} onAnimationEnd={handleLogoAnimEnd} />
        </h1>
        <div className="app-header-info">
          <span className="app-nick" style={{ color: user.nickColor }}>
            {user.nickname}
          </span>
          <span className="app-status"> ● online</span>
        </div>
      </header>

      {/* Three-column body */}
      <div className="app-body">
        <ChannelList
          channels={channels}
          currentChannelId={currentChannelId}
          onSelect={handleSelectChannel}
          onCreateChannel={handleCreateChannel}
        />

        <div className="app-center">
          <ChatArea
            messages={messages}
            channelName={currentChannel?.name ?? `#${currentChannelId}`}
            topic={currentChannel?.topic ?? ""}
          />
          <MessageInput
            channelName={currentChannel?.name ?? `#${currentChannelId}`}
            onSend={handleSend}
            onTyping67th={() => setLogoTriggered(true)}
          />
        </div>

        <UserList members={members} currentUserId={user.uid} />
      </div>
    </div>
  );
}
