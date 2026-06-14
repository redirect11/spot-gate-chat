"use client";

import React, { useEffect, useRef, useState } from "react";

interface Props {
  onConfirm: (nickname: string) => void;
}

const ADJECTIVES = ["Dark", "Neon", "Ghost", "Fast", "Wild", "Lazy", "Rad"];
const NOUNS = ["Wolf", "Hawk", "Pixel", "Byte", "Node", "Punk", "Rider"];

function cryptoRandInt(max: number): number {
  return crypto.getRandomValues(new Uint32Array(1))[0] % max;
}

function randomNick(): string {
  const adj = ADJECTIVES[cryptoRandInt(ADJECTIVES.length)];
  const noun = NOUNS[cryptoRandInt(NOUNS.length)];
  const num = cryptoRandInt(99);
  return `${adj}${noun}${num}`;
}

export default function NicknameModal({ onConfirm }: Props) {
  const [nick, setNick] = useState(randomNick());
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = nick.trim().replace(/\s+/g, "_").slice(0, 20);
    if (trimmed) onConfirm(trimmed);
  };

  return (
    <div className="modal-overlay">
      <div className="modal-box">
        <div className="modal-header">
          <span className="modal-title-bar">
            ■ 67t — Set your nickname
          </span>
        </div>
        <div className="modal-body">
          <p className="modal-desc">
            Choose a nickname to enter the chat. Others will see you as this.
          </p>
          <form onSubmit={handleSubmit} className="modal-form">
            <label className="modal-label">Nickname:</label>
            <input
              ref={inputRef}
              className="modal-input"
              value={nick}
              onChange={(e) => setNick(e.target.value)}
              maxLength={20}
              spellCheck={false}
              autoComplete="off"
            />
            <button type="submit" className="modal-btn">
              Connect →
            </button>
          </form>
          <p className="modal-hint">Max 20 characters. No spaces.</p>
          <p className="modal-hint">
            Per la moderazione, nickname e una versione <em>hashata</em> del tuo
            IP possono essere registrati temporaneamente. Entrando, accetti.
          </p>
        </div>
      </div>
    </div>
  );
}
