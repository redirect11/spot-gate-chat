export interface Channel {
  id: string;
  name: string;
  topic: string;
  memberCount: number;
  createdAt: number;
}

export interface Message {
  id: string;
  userId: string;
  nickname: string;
  nickColor: string;
  text: string;
  timestamp: number;
  type: "message" | "join" | "leave" | "system" | "action";
  nudge?: boolean;
}

export interface ChannelMember {
  userId: string;
  nickname: string;
  nickColor: string;
  lastSeen: number;
  isOp: boolean;
  voice?: boolean;
}

export interface DmThread {
  convoId: string;
  otherUid: string;
  otherNick: string;
  updatedAt: number;
  lastFrom: string;
}

export interface User {
  uid: string;
  nickname: string;
  nickColor: string;
}

export interface Bot {
  id: string;
  nickname: string;
  nickColor: string;
  channels: string[];
  role: string;
  enabled: boolean;
  model?: string;
  repliesEnabled?: boolean;
  trigger?: { type: string };
}
