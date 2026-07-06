import crypto from "node:crypto";
import { AccountModel } from "./models.js";
function hashPassword(password) {
    return crypto.createHash("sha256").update(password).digest("hex");
}
export async function createAccount(input) {
    const existingPhone = await AccountModel.findOne({ phone: input.phone }).lean();
    if (existingPhone) {
        throw new Error("Phone already registered");
    }
    const existingUsername = await AccountModel.findOne({ username: input.username }).lean();
    if (existingUsername) {
        throw new Error("Username already taken");
    }
    const account = {
        userId: crypto.randomUUID(),
        phone: input.phone,
        username: input.username,
        displayName: input.displayName,
        passwordHash: hashPassword(input.password),
        theme: "sand",
        statusPrivacyMode: "all",
        statusPrivacyUsers: [],
        createdAt: Date.now()
    };
    await AccountModel.create(account);
    return toPublicUser(account);
}
export async function authenticate(phone, password) {
    const account = await AccountModel.findOne({ phone }).lean();
    if (!account) {
        return null;
    }
    return account.passwordHash === hashPassword(password) ? account : null;
}
export async function usernameAvailable(username) {
    const account = await AccountModel.findOne({ username }).lean();
    return !account;
}
export async function getAccountById(userId) {
    const account = await AccountModel.findOne({ userId }).lean();
    return account ?? null;
}
export async function getPublicByUsername(username) {
    const account = (await AccountModel.findOne({ username }).lean());
    return account ? toPublicUser(account) : null;
}
export async function searchUsers(query, exceptUserId) {
    const normalized = query.toLowerCase();
    const users = [];
    const accounts = (await AccountModel.find({ userId: { $ne: exceptUserId } }).limit(100).lean());
    for (const account of accounts) {
        const candidate = `${account.username} ${account.displayName}`.toLowerCase();
        if (candidate.includes(normalized)) {
            users.push(toPublicUser(account));
        }
    }
    return users.slice(0, 20);
}
export async function updateProfile(userId, patch) {
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
    if (patch.statusPrivacyMode) {
        account.statusPrivacyMode = patch.statusPrivacyMode;
    }
    if (Array.isArray(patch.statusPrivacyUsers)) {
        account.statusPrivacyUsers = patch.statusPrivacyUsers;
    }
    await account.save();
    const obj = account.toObject();
    return {
        ...toPublicUser(obj),
        theme: obj.theme,
        statusPrivacyMode: obj.statusPrivacyMode,
        statusPrivacyUsers: obj.statusPrivacyUsers
    };
}
export function toPublicUser(account) {
    return {
        userId: account.userId,
        username: account.username,
        displayName: account.displayName,
        avatarUrl: account.avatarUrl
    };
}
export async function getPublicByPhones(phones) {
    const accounts = (await AccountModel.find({ phone: { $in: phones } }).lean());
    return accounts.map(acc => ({
        userId: acc.userId,
        username: acc.username,
        displayName: acc.displayName,
        avatarUrl: acc.avatarUrl,
        phone: acc.phone
    }));
}
export async function getPublicByIds(userIds) {
    const accounts = (await AccountModel.find({ userId: { $in: userIds } }).lean());
    return accounts.map(toPublicUser);
}
