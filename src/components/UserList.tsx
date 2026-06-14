"use client";

import React from "react";
import { Bot, ChannelMember } from "@/lib/types";

interface Props {
  members: ChannelMember[];
  bots?: Bot[];
  currentUserId: string;
  open?: boolean;
  onClose?: () => void;
}

export default function UserList({
  members,
  bots = [],
  currentUserId,
  open = false,
  onClose,
}: Props) {
  const ops = members.filter((m) => m.isOp);
  const regular = members.filter((m) => !m.isOp);

  const renderMember = (m: ChannelMember) => (
    <li key={m.userId} className="user-item" title={m.nickname}>
      <span className="user-sigil">{m.isOp ? "@" : "+"}</span>
      <span className="user-nick" style={{ color: m.nickColor }}>
        {m.nickname}
        {m.userId === currentUserId && <span className="user-you"> (you)</span>}
      </span>
    </li>
  );

  const total = members.length + bots.length;

  return (
    <aside className={`user-list${open ? " panel--open" : ""}`}>
      <div className="panel-header">
        Users{" "}
        <span className="user-count">{total}</span>
        <button className="drawer-close" onClick={onClose} aria-label="Chiudi">
          ✕
        </button>
      </div>

      {bots.length > 0 && (
        <>
          <div className="user-group-label">🤖 Bots</div>
          <ul className="user-items">
            {bots.map((b) => (
              <li key={`bot:${b.id}`} className="user-item" title={b.nickname}>
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
          <ul className="user-items">{ops.map(renderMember)}</ul>
        </>
      )}

      {regular.length > 0 && (
        <>
          <div className="user-group-label">+ Users</div>
          <ul className="user-items">{regular.map(renderMember)}</ul>
        </>
      )}

      {total === 0 && <p className="user-empty">No users online</p>}
    </aside>
  );
}
