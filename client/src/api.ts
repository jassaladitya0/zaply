import type { OtpPurpose, PublicUser, Session, Theme } from "./types";

const resolveApiBase = (): string => {
  const envUrl = import.meta.env.VITE_API_BASE_URL as string | undefined;
  if (envUrl) {
    return envUrl;
  }
  if (typeof window !== "undefined" && window.location) {
    const host = window.location.hostname;
    if (host && host !== "localhost" && host !== "127.0.0.1") {
      return `${window.location.protocol}//${host}:4000`;
    }
  }
  return "http://localhost:4000";
};

const API_BASE = resolveApiBase();

async function request<T>(path: string, options: RequestInit = {}, token?: string): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((options.headers as Record<string, string> | undefined) ?? {})
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers
  });

  const data = await response.json();
  if (!response.ok) {
    const retrySuffix = typeof data.retryAfterSec === "number" ? ` (try again in ${data.retryAfterSec}s)` : "";
    throw new Error(`${data.error ?? "Request failed"}${retrySuffix}`);
  }
  return data as T;
}

export async function register(input: {
  phone: string;
  username: string;
  password: string;
  displayName: string;
  otpProof: string;
}): Promise<Session> {
  return request<Session>("/auth/register", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export async function login(input: { phone: string; password: string; otpProof: string }): Promise<Session> {
  return request<Session>("/auth/login", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export async function requestOtp(phone: string, purpose: OtpPurpose): Promise<void> {
  await request<{ sent: boolean }>("/auth/request-otp", {
    method: "POST",
    body: JSON.stringify({ phone, purpose })
  });
}

export async function verifyOtp(phone: string, purpose: OtpPurpose, code: string): Promise<string> {
  const result = await request<{ otpProof: string }>("/auth/verify-otp", {
    method: "POST",
    body: JSON.stringify({ phone, purpose, code })
  });
  return result.otpProof;
}

export async function checkUsernameAvailability(username: string): Promise<boolean> {
  const result = await request<{ available: boolean }>(`/auth/username-available?username=${encodeURIComponent(username)}`);
  return result.available;
}

export async function searchUsers(query: string, token: string): Promise<PublicUser[]> {
  const result = await request<{ users: PublicUser[] }>(`/users/search?q=${encodeURIComponent(query)}`, {}, token);
  return result.users;
}

export async function updateProfile(
  token: string,
  patch: {
    displayName?: string;
    avatarUrl?: string;
    theme?: Theme;
    statusPrivacyMode?: "all" | "share-with" | "hide-from";
    statusPrivacyUsers?: string[];
  }
): Promise<PublicUser & { theme?: Theme; statusPrivacyMode?: "all" | "share-with" | "hide-from"; statusPrivacyUsers?: string[] }> {
  const result = await request<{ user: PublicUser & { theme?: Theme; statusPrivacyMode?: "all" | "share-with" | "hide-from"; statusPrivacyUsers?: string[] } }>(
    "/me/profile",
    {
      method: "PATCH",
      body: JSON.stringify(patch)
    },
    token
  );
  return result.user;
}

export async function syncContacts(phones: string[], token: string): Promise<(PublicUser & { phone: string })[]> {
  const result = await request<{ users: (PublicUser & { phone: string })[] }>(
    "/users/sync",
    {
      method: "POST",
      body: JSON.stringify({ phones })
    },
    token
  );
  return result.users;
}

export async function fetchBulkProfiles(userIds: string[], token: string): Promise<PublicUser[]> {
  const result = await request<{ users: PublicUser[] }>(
    "/users/bulk",
    {
      method: "POST",
      body: JSON.stringify({ userIds })
    },
    token
  );
  return result.users;
}

