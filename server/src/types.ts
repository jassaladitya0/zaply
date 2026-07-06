export type Account = {
  userId: string;
  phone: string;
  username: string;
  displayName: string;
  passwordHash: string;
  avatarUrl?: string;
  theme: "sand" | "forest" | "sunset";
  statusPrivacyMode: "all" | "share-with" | "hide-from";
  statusPrivacyUsers: string[];
  createdAt: number;
};

export type StatusUpdate = {
  id: string;
  userId: string;
  username: string;
  displayName: string;
  avatarUrl?: string;
  time: string;
  timestamp: number;
  updates: { type: "text" | "image" | "video"; content: string; caption?: string }[];
  viewed?: boolean;
};

export type BroadcastChannel = {
  id: string;
  name: string;
  description: string;
  creatorId: string;
  avatar: string;
  messages: { id: string; content: string; ts: number }[];
};

export type Community = {
  id: string;
  name: string;
  description: string;
  creatorId: string;
  groups: string[];
};

export type PublicUser = {
  userId: string;
  username: string;
  displayName: string;
  avatarUrl?: string;
};

export type AuthPayload = {
  userId: string;
  username: string;
};

export type SignalEnvelope = {
  toUserId: string;
  type: "chat" | "offer" | "answer" | "ice" | "file-meta" | "typing" | "close-call";
  payload: unknown;
  expiresAt?: number;
};
