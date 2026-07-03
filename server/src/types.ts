export type Account = {
  userId: string;
  phone: string;
  username: string;
  displayName: string;
  passwordHash: string;
  avatarUrl?: string;
  theme: "sand" | "forest" | "sunset";
  createdAt: number;
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
