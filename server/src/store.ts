import crypto from "node:crypto";
import { AccountModel } from "./models.js";
import type { Account, PublicUser } from "./types.js";

function hashPassword(password: string): string {
  return crypto.createHash("sha256").update(password).digest("hex");
}

export async function createAccount(input: {
  phone: string;
  username: string;
  displayName: string;
  password: string;
}): Promise<PublicUser> {
  const existingPhone = await AccountModel.findOne({ phone: input.phone }).lean();
  if (existingPhone) {
    throw new Error("Phone already registered");
  }
  const existingUsername = await AccountModel.findOne({ username: input.username }).lean();
  if (existingUsername) {
    throw new Error("Username already taken");
  }

  const account: Account = {
    userId: crypto.randomUUID(),
    phone: input.phone,
    username: input.username,
    displayName: input.displayName,
    passwordHash: hashPassword(input.password),
    theme: "sand",
    createdAt: Date.now()
  };

  await AccountModel.create(account);

  return toPublicUser(account);
}

export async function authenticate(phone: string, password: string): Promise<Account | null> {
  const account = await AccountModel.findOne({ phone }).lean<Account | null>();
  if (!account) {
    return null;
  }
  return account.passwordHash === hashPassword(password) ? account : null;
}

export async function usernameAvailable(username: string): Promise<boolean> {
  const account = await AccountModel.findOne({ username }).lean();
  return !account;
}

export async function getAccountById(userId: string): Promise<Account | null> {
  const account = await AccountModel.findOne({ userId }).lean();
  return (account as Account | null) ?? null;
}

export async function getPublicByUsername(username: string): Promise<PublicUser | null> {
  const account = (await AccountModel.findOne({ username }).lean()) as Account | null;
  return account ? toPublicUser(account) : null;
}

export async function searchUsers(query: string, exceptUserId: string): Promise<PublicUser[]> {
  const normalized = query.toLowerCase();
  const users: PublicUser[] = [];
  const accounts = (await AccountModel.find({ userId: { $ne: exceptUserId } }).limit(100).lean()) as unknown as Account[];

  for (const account of accounts) {
    const candidate = `${account.username} ${account.displayName}`.toLowerCase();
    if (candidate.includes(normalized)) {
      users.push(toPublicUser(account));
    }
  }

  return users.slice(0, 20);
}

export async function updateProfile(
  userId: string,
  patch: { displayName?: string; avatarUrl?: string; theme?: Account["theme"] }
): Promise<PublicUser> {
  const account = await AccountModel.findOne({ userId });
  if (!account) {
    throw new Error("User not found");
  }

  if (typeof patch.displayName === "string" && patch.displayName.trim()) {
    account.displayName = patch.displayName;
  }
  if (typeof patch.avatarUrl === "string") {
    account.avatarUrl = patch.avatarUrl;
  }
  if (patch.theme) {
    account.theme = patch.theme;
  }

  await account.save();
  return toPublicUser(account.toObject() as Account);
}

export function toPublicUser(account: Account): PublicUser {
  return {
    userId: account.userId,
    username: account.username,
    displayName: account.displayName,
    avatarUrl: account.avatarUrl
  };
}

export async function getPublicByPhones(phones: string[]): Promise<(PublicUser & { phone: string })[]> {
  const accounts = (await AccountModel.find({ phone: { $in: phones } }).lean()) as unknown as Account[];
  return accounts.map(acc => ({
    userId: acc.userId,
    username: acc.username,
    displayName: acc.displayName,
    avatarUrl: acc.avatarUrl,
    phone: acc.phone
  }));
}

