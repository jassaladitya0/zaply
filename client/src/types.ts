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
  user: PublicUser & { theme?: Theme };
};

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
