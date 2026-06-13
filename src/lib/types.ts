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
  type: "message" | "join" | "leave" | "system";
}

export interface ChannelMember {
  userId: string;
  nickname: string;
  nickColor: string;
  lastSeen: number;
  isOp: boolean;
}

export interface User {
  uid: string;
  nickname: string;
  nickColor: string;
}
