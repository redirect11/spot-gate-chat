"use client";

import React, { useEffect, useRef } from "react";
import { Message } from "@/lib/types";

interface Props {
  messages: Message[];
  channelName: string;
  topic: string;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export default function ChatArea({ messages, channelName, topic }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    // Auto-scroll only when already near the bottom
    const isNearBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (isNearBottom) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages]);

  return (
    <main className="chat-area">
      {/* Topic bar */}
      <div className="chat-topic-bar">
        <span className="chat-topic-channel">{channelName}</span>
        {topic && <span className="chat-topic-text"> — {topic}</span>}
      </div>

      {/* Rotating pixel-art Earth — subtle background, behind the text */}
      <div className="earth-bg" aria-hidden="true">
        <div className="earth-globe" />
      </div>

      {/* Messages */}
      <div className="chat-messages" ref={containerRef}>
        {messages.length === 0 && (
          <div className="chat-empty">
            No messages yet. Be the first to say something!
          </div>
        )}

        {messages.map((msg) => {
          if (msg.type === "join" || msg.type === "leave" || msg.type === "system") {
            return (
              <div key={msg.id} className="chat-line chat-line-system">
                <span className="chat-time">[{formatTime(msg.timestamp)}]</span>
                <span className="chat-system-text"> *** {msg.text}</span>
              </div>
            );
          }

          if (msg.nudge) {
            return (
              <div key={msg.id} className="chat-line chat-line-nudge">
                ⚡{" "}
                <span style={{ color: msg.nickColor }}>{msg.nickname}</span>{" "}
                ti ha mandato un trillo!
              </div>
            );
          }

          if (msg.type === "action") {
            return (
              <div key={msg.id} className="chat-line chat-line-action">
                <span className="chat-time">[{formatTime(msg.timestamp)}]</span>
                <span className="chat-action-text">
                  {" "}
                  *{" "}
                  <span style={{ color: msg.nickColor }}>{msg.nickname}</span>{" "}
                  {msg.text}
                </span>
              </div>
            );
          }

          return (
            <div key={msg.id} className="chat-line">
              <span className="chat-time">[{formatTime(msg.timestamp)}]</span>
              <span className="chat-nick-wrap">
                {" "}
                &lt;
                <span
                  className="chat-nick"
                  style={{ color: msg.nickColor }}
                >
                  {msg.nickname}
                </span>
                &gt;{" "}
              </span>
              <span className="chat-msg-text">{msg.text}</span>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>
    </main>
  );
}
