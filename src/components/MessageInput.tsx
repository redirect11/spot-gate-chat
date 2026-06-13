"use client";

import React, { useRef, useState } from "react";

interface Props {
  channelName: string;
  onSend: (text: string) => void;
  onTyping67th: () => void;
}

export default function MessageInput({ channelName, onSend, onTyping67th }: Props) {
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const seenTrigger = useRef(false);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setText(val);

    // Detect "67th" being typed — fire once per occurrence
    if (val.toLowerCase().includes("67th")) {
      if (!seenTrigger.current) {
        seenTrigger.current = true;
        onTyping67th();
      }
    } else {
      seenTrigger.current = false;
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setText("");
    seenTrigger.current = false;
    inputRef.current?.focus();
  };

  return (
    <form className="msg-input-bar" onSubmit={handleSubmit}>
      <span className="msg-input-prefix">[{channelName}]</span>
      <input
        ref={inputRef}
        className="msg-input"
        value={text}
        onChange={handleChange}
        placeholder="Type a message... (type 67th for a surprise)"
        autoComplete="off"
        spellCheck={false}
        maxLength={500}
      />
      <button type="submit" className="msg-send-btn">
        Send
      </button>
    </form>
  );
}
