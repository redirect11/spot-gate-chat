"use client";

import React, { useRef, useState } from "react";
import { COMMANDS } from "@/lib/commands";

interface Props {
  channelName: string;
  onSend: (text: string) => void;
  onTyping67th: () => void;
  isAdmin?: boolean;
}

export default function MessageInput({
  channelName,
  onSend,
  onTyping67th,
  isAdmin = false,
}: Props) {
  const [text, setText] = useState("");
  // operator commands are hidden from non-operators
  const allowed = COMMANDS.filter((c) => isAdmin || !c.op);
  const allowedNames = allowed.map((c) => c.name);
  const inputRef = useRef<HTMLInputElement>(null);
  const seenTrigger = useRef(false);
  const cycleBase = useRef<string | null>(null);
  const cycleIdx = useRef(0);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setText(val);
    cycleBase.current = null; // editing restarts Tab cycling

    if (val.toLowerCase().includes("67t")) {
      if (!seenTrigger.current) {
        seenTrigger.current = true;
        onTyping67th();
      }
    } else {
      seenTrigger.current = false;
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Tab") return;
    if (!text.startsWith("/")) return;
    const token = text.slice(1);
    if (token.includes(" ")) return; // past the command word
    e.preventDefault();

    const cur = token.toLowerCase();
    let base = cycleBase.current;
    let matches = base !== null ? allowedNames.filter((n) => n.startsWith(base!)) : [];
    if (base === null || !matches.includes(cur)) {
      base = cur;
      cycleBase.current = base;
      matches = allowedNames.filter((n) => n.startsWith(base!));
      cycleIdx.current = 0;
    } else {
      cycleIdx.current = (cycleIdx.current + 1) % matches.length;
    }
    if (matches.length === 0) return;
    setText("/" + matches[cycleIdx.current]);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setText("");
    seenTrigger.current = false;
    cycleBase.current = null;
    inputRef.current?.focus();
  };

  const prefixMatch = text.match(/^\/(\S*)$/);
  const suggestions = prefixMatch
    ? allowed.filter((c) => c.name.startsWith(prefixMatch[1].toLowerCase())).slice(0, 6)
    : [];

  const pick = (name: string) => {
    setText("/" + name + " ");
    cycleBase.current = null;
    inputRef.current?.focus();
  };

  return (
    <div className="msg-input-wrap">
      {suggestions.length > 0 && (
        <div className="cmd-suggest">
          {suggestions.map((c) => (
            <button
              key={c.name}
              type="button"
              className="cmd-suggest-item"
              onMouseDown={(e) => {
                e.preventDefault();
                pick(c.name);
              }}
              title={c.desc}
            >
              <span className="cmd-suggest-name">{c.usage}</span>
              {c.op && <span className="cmd-suggest-op">op</span>}
            </button>
          ))}
        </div>
      )}
      <form className="msg-input-bar" onSubmit={handleSubmit}>
        <span className="msg-input-prefix">[{channelName}]</span>
        <input
          ref={inputRef}
          className="msg-input"
          value={text}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder="Scrivi un messaggio o /help per i comandi…"
          autoComplete="off"
          spellCheck={false}
          maxLength={500}
        />
        <button type="submit" className="msg-send-btn">
          Send
        </button>
      </form>
    </div>
  );
}
