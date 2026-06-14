"use client";

import React, { useState } from "react";
import { Channel, DmThread } from "@/lib/types";

interface Props {
  channels: Channel[];
  currentChannelId: string;
  onSelect: (channelId: string) => void;
  onCreateChannel: (name: string, topic: string) => void;
  unread?: Record<string, number>;
  dmThreads?: DmThread[];
  activeDmUid?: string | null;
  onSelectDm?: (uid: string, nick: string) => void;
  open?: boolean;
  onClose?: () => void;
}

export default function ChannelList({
  channels,
  currentChannelId,
  onSelect,
  onCreateChannel,
  unread = {},
  dmThreads = [],
  activeDmUid = null,
  onSelectDm,
  open = false,
  onClose,
}: Props) {
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState("");
  const [newTopic, setNewTopic] = useState("");

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    const name = newName.trim().replace(/^#+/, "").replace(/\s+/g, "-");
    if (!name) return;
    onCreateChannel(name, newTopic.trim());
    setNewName("");
    setNewTopic("");
    setShowNew(false);
  };

  return (
    <aside className={`channel-list${open ? " panel--open" : ""}`}>
      <div className="panel-header">
        Channels
        <button className="drawer-close" onClick={onClose} aria-label="Chiudi">
          ✕
        </button>
      </div>

      <ul className="channel-items">
        {channels.map((ch) => (
          <li
            key={ch.id}
            className={`channel-item${
              ch.id === currentChannelId && !activeDmUid
                ? " channel-item-active"
                : ""
            }`}
            onClick={() => onSelect(ch.id)}
            title={ch.topic}
          >
            <span className="channel-name">{ch.name}</span>
            {unread[ch.id] > 0 && ch.id !== currentChannelId ? (
              <span className="channel-unread">{unread[ch.id]}</span>
            ) : (
              ch.memberCount > 0 && (
                <span className="channel-count">{ch.memberCount}</span>
              )
            )}
          </li>
        ))}
      </ul>

      {dmThreads.length > 0 && (
        <>
          <div className="panel-header">✉️ Privati</div>
          <ul className="channel-items">
            {dmThreads.map((t) => (
              <li
                key={t.convoId}
                className={`channel-item${
                  t.otherUid === activeDmUid ? " channel-item-active" : ""
                }`}
                onClick={() => onSelectDm?.(t.otherUid, t.otherNick)}
                title={t.otherNick}
              >
                <span className="channel-name">@{t.otherNick}</span>
                {unread[`dm:${t.otherUid}`] > 0 &&
                  t.otherUid !== activeDmUid && (
                    <span className="channel-unread">
                      {unread[`dm:${t.otherUid}`]}
                    </span>
                  )}
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="channel-new-section">
        {!showNew ? (
          <button className="channel-new-btn" onClick={() => setShowNew(true)}>
            + Join / New Channel
          </button>
        ) : (
          <form className="channel-new-form" onSubmit={handleCreate}>
            <input
              className="channel-new-input"
              placeholder="#channel-name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              autoFocus
              maxLength={32}
            />
            <input
              className="channel-new-input"
              placeholder="Topic (optional)"
              value={newTopic}
              onChange={(e) => setNewTopic(e.target.value)}
              maxLength={80}
            />
            <div className="channel-new-actions">
              <button type="submit" className="channel-new-confirm">
                Create
              </button>
              <button
                type="button"
                className="channel-new-cancel"
                onClick={() => setShowNew(false)}
              >
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>
    </aside>
  );
}
