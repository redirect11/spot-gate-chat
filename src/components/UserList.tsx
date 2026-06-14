"use client";

import React from "react";
import { Bot, ChannelMember } from "@/lib/types";

interface Props {
  members: ChannelMember[];
  bots?: Bot[];
  currentUserId: string;
  onUserClick?: (uid: string, nick: string) => void;
  open?: boolean;
  onClose?: () => void;
}

export default function UserList({
  members,
  bots = [],
  currentUserId,
  onUserClick,
  open = false,
  onClose,
}: Props) {
  const ops = members.filter((m) => m.isOp);
  const voiced = members.filter((m) => !m.isOp && m.voice);
  const normal = members.filter((m) => !m.isOp && !m.voice);

  const renderMember = (m: ChannelMember, sigil: string) => {
    const isSelf = m.userId === currentUserId;
    return (
      <li
        key={m.userId}
        className={`user-item${!isSelf && onUserClick ? " user-item-click" : ""}`}
        title={isSelf ? m.nickname : `${m.nickname} — clicca per messaggio privato`}
        onClick={
          !isSelf && onUserClick
            ? () => onUserClick(m.userId, m.nickname)
            : undefined
        }
      >
        <span className="user-sigil">{sigil}</span>
        <span className="user-nick" style={{ color: m.nickColor }}>
          {m.nickname}
          {isSelf && <span className="user-you"> (you)</span>}
        </span>
      </li>
    );
  };

  const total = members.length + bots.length;

  return (
    <aside className={`user-list${open ? " panel--open" : ""}`}>
      <div className="panel-header">
        Users <span className="user-count">{total}</span>
        <button className="drawer-close" onClick={onClose} aria-label="Chiudi">
          ✕
        </button>
      </div>

      {bots.length > 0 && (
        <>
          <div className="user-group-label">🤖 Bots</div>
          <ul className="user-items">
            {bots.map((b) => (
              <li
                key={`bot:${b.id}`}
                className={`user-item${onUserClick ? " user-item-click" : ""}`}
                title={`${b.nickname} — clicca per chat privata`}
                onClick={
                  onUserClick
                    ? () => onUserClick(`bot:${b.id}`, b.nickname)
                    : undefined
                }
              >
                <span className="user-sigil">@</span>
                <span className="user-nick" style={{ color: b.nickColor }}>
                  {b.nickname}
                  <span className="user-you"> (bot)</span>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      {ops.length > 0 && (
        <>
          <div className="user-group-label">@ Operators</div>
          <ul className="user-items">{ops.map((m) => renderMember(m, "@"))}</ul>
        </>
      )}

      {voiced.length > 0 && (
        <>
          <div className="user-group-label">+ Voice</div>
          <ul className="user-items">{voiced.map((m) => renderMember(m, "+"))}</ul>
        </>
      )}

      {normal.length > 0 && (
        <>
          <div className="user-group-label">Users</div>
          <ul className="user-items">{normal.map((m) => renderMember(m, "·"))}</ul>
        </>
      )}

      {total === 0 && <p className="user-empty">No users online</p>}
    </aside>
  );
}
