"use client";

import React from "react";
import { ChannelMember } from "@/lib/types";

interface Props {
  members: ChannelMember[];
  currentUserId: string;
}

export default function UserList({ members, currentUserId }: Props) {
  const ops = members.filter((m) => m.isOp);
  const regular = members.filter((m) => !m.isOp);

  const renderMember = (m: ChannelMember) => (
    <li key={m.userId} className="user-item" title={m.nickname}>
      <span className="user-sigil">{m.isOp ? "@" : "+"}</span>
      <span
        className="user-nick"
        style={{ color: m.nickColor }}
      >
        {m.nickname}
        {m.userId === currentUserId && (
          <span className="user-you"> (you)</span>
        )}
      </span>
    </li>
  );

  return (
    <aside className="user-list">
      <div className="panel-header">
        Users{" "}
        <span className="user-count">{members.length}</span>
      </div>

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

      {members.length === 0 && (
        <p className="user-empty">No users online</p>
      )}
    </aside>
  );
}
