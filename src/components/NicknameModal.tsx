"use client";

import React, { useEffect, useRef, useState } from "react";

interface Props {
  /** returns an error message if the nick can't be used, or null on success */
  onConfirm: (nickname: string) => Promise<string | null>;
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
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    const trimmed = nick.trim().replace(/\s+/g, "_").slice(0, 20);
    if (!trimmed) return;
    setSubmitting(true);
    setError(null);
    const err = await onConfirm(trimmed);
    if (err) {
      setError(err);
      setSubmitting(false);
      inputRef.current?.focus();
      inputRef.current?.select();
    }
    // on success the component unmounts (user is set)
  };

  return (
    <div className="modal-overlay">
      <div className="modal-box">
        <div className="modal-header">
          <span className="modal-title-bar">■ 67t — Set your nickname</span>
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
              onChange={(e) => {
                setNick(e.target.value);
                setError(null);
              }}
              maxLength={20}
              spellCheck={false}
              autoComplete="off"
              disabled={submitting}
            />
            {error && <p className="modal-error">{error}</p>}
            <button type="submit" className="modal-btn" disabled={submitting}>
              {submitting ? "…" : "Connect →"}
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
