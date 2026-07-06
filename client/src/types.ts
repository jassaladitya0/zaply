export type Theme = "sand" | "forest" | "sunset";
export type OtpPurpose = "register" | "login";
export type SignalScope = "call" | "file";

export type PublicUser = {
  userId: string;
  username: string;
  displayName: string;
  avatarUrl?: string;
};

export type Session = {
  token: string;
  user: PublicUser & {
    theme?: Theme;
    statusPrivacyMode?: "all" | "share-with" | "hide-from";
    statusPrivacyUsers?: string[];
  };
};

export interface StatusUpdate {
  id: string;
  userId: string;
  username: string;
  displayName: string;
  avatarUrl?: string;
  time: string;
  timestamp: number;
  updates: { type: "text" | "image" | "video"; content: string; caption?: string }[];
  viewed?: boolean;
}

export interface BroadcastChannel {
  id: string;
  name: string;
  description: string;
  creatorId: string;
  avatar: string;
  messages: { id: string; content: string; ts: number }[];
}

export interface Community {
  id: string;
  name: string;
  description: string;
  creatorId: string;
  groups: string[];
}

export type ChatMessage = {
  id: string;
  fromUserId: string;
  toUserId: string;
  kind: "text" | "file-meta";
  content: string;
  ts: number;
  expiresAt: number;
  downloadUrl?: string;
};

export type SignalPayload = {
  toUserId: string;
  type: "chat" | "offer" | "answer" | "ice" | "file-meta" | "typing" | "close-call";
  payload: unknown;
};
