import "dotenv/config";
import cors from "cors";
import express from "express";
import http from "node:http";
import { Server } from "socket.io";
import { parseAuthHeader, readUserFromRequest, signOtpProof, signToken, unauthorized, verifyOtpProof, verifyToken } from "./auth.js";
import { connectDatabase } from "./db.js";
import { requestOtp, verifyOtp, type OtpPurpose } from "./otp.js";
import {
  authenticate,
  createAccount,
  getPublicByUsername,
  getPublicByPhones,
  searchUsers,
  updateProfile,
  usernameAvailable,
  getAccountById,
  getPublicByIds
} from "./store.js";
import type { SignalEnvelope, StatusUpdate, BroadcastChannel, Community } from "./types.js";

const app = express();
const server = http.createServer(app);

const OTP_RESEND_COOLDOWN_MS = Number(process.env.OTP_RESEND_COOLDOWN_SEC ?? 45) * 1000;
const OTP_REQUEST_MAX_PER_HOUR = Number(process.env.OTP_REQUEST_MAX_PER_HOUR ?? 5);
const OTP_VERIFY_MAX_FAILURES = Number(process.env.OTP_VERIFY_MAX_FAILURES ?? 5);
const OTP_VERIFY_LOCKOUT_MS = Number(process.env.OTP_VERIFY_LOCKOUT_MINUTES ?? 15) * 60 * 1000;
const LOGIN_MAX_FAILURES = Number(process.env.LOGIN_MAX_FAILURES ?? 8);
const LOGIN_LOCKOUT_MS = Number(process.env.LOGIN_LOCKOUT_MINUTES ?? 15) * 60 * 1000;

const otpSendHistory = new Map<string, number[]>();
const otpVerifyFailures = new Map<string, { count: number; windowStart: number; lockedUntil: number }>();
const loginFailures = new Map<string, { count: number; windowStart: number; lockedUntil: number }>();

function keyForPhone(phone: string, purpose?: OtpPurpose): string {
  return purpose ? `${purpose}:${phone}` : phone;
}

function cleanupOtpHistory(key: string): number[] {
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  const history = (otpSendHistory.get(key) ?? []).filter((ts) => ts >= oneHourAgo);
  otpSendHistory.set(key, history);
  return history;
}

function checkOtpSendLimits(key: string): { allowed: boolean; retryAfterSec?: number; reason?: string } {
  const history = cleanupOtpHistory(key);
  const now = Date.now();

  if (history.length > 0) {
    const last = history[history.length - 1];
    const elapsed = now - last;
    if (elapsed < OTP_RESEND_COOLDOWN_MS) {
      return {
        allowed: false,
        retryAfterSec: Math.ceil((OTP_RESEND_COOLDOWN_MS - elapsed) / 1000),
        reason: "OTP resend cooldown active"
      };
    }
  }

  if (history.length >= OTP_REQUEST_MAX_PER_HOUR) {
    const oldest = history[0];
    const retryAfterMs = oldest + 60 * 60 * 1000 - now;
    return {
      allowed: false,
      retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000)),
      reason: "Hourly OTP request limit reached"
    };
  }

  return { allowed: true };
}

function markOtpSend(key: string): void {
  const history = cleanupOtpHistory(key);
  history.push(Date.now());
  otpSendHistory.set(key, history);
}

function getLockRemaining(state?: { lockedUntil: number }): number {
  if (!state) {
    return 0;
  }
  return Math.max(0, Math.ceil((state.lockedUntil - Date.now()) / 1000));
}

function recordFailure(
  map: Map<string, { count: number; windowStart: number; lockedUntil: number }>,
  key: string,
  maxFailures: number,
  lockoutMs: number
): number {
  const now = Date.now();
  const current = map.get(key);
  const base = !current || now - current.windowStart > lockoutMs
    ? { count: 0, windowStart: now, lockedUntil: 0 }
    : current;

  base.count += 1;
  if (base.count >= maxFailures) {
    base.lockedUntil = now + lockoutMs;
    base.count = 0;
    base.windowStart = now;
  }
  map.set(key, base);
  return getLockRemaining(base);
}

function clearFailures(
  map: Map<string, { count: number; windowStart: number; lockedUntil: number }>,
  key: string
): void {
  map.delete(key);
}

const clientOrigin = process.env.CLIENT_ORIGIN ?? "http://localhost:5173";
const io = new Server(server, {
  cors: {
    origin: clientOrigin,
    methods: ["GET", "POST"]
  }
});

app.use(
  cors({
    origin: clientOrigin
  })
);
app.use(express.json({ limit: "15mb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

app.get("/auth/username-available", async (req, res) => {
  const username = String(req.query.username ?? "").trim();
  if (!username) {
    return res.status(400).json({ error: "username is required" });
  }
  return res.json({ available: await usernameAvailable(username) });
});

app.post("/auth/request-otp", async (req, res) => {
  const phone = String(req.body?.phone ?? "").trim();
  const purpose = String(req.body?.purpose ?? "").trim() as OtpPurpose;
  if (!phone || (purpose !== "register" && purpose !== "login")) {
    return res.status(400).json({ error: "phone and valid purpose required" });
  }

  const otpKey = keyForPhone(phone, purpose);
  const limit = checkOtpSendLimits(otpKey);
  if (!limit.allowed) {
    return res.status(429).json({
      error: limit.reason ?? "Too many OTP requests",
      retryAfterSec: limit.retryAfterSec ?? 1
    });
  }

  try {
    await requestOtp(phone);
    markOtpSend(otpKey);
    return res.status(202).json({ sent: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "OTP send failed";
    return res.status(400).json({ error: message });
  }
});

app.post("/auth/verify-otp", async (req, res) => {
  const phone = String(req.body?.phone ?? "").trim();
  const purpose = String(req.body?.purpose ?? "").trim() as OtpPurpose;
  const code = String(req.body?.code ?? "").trim();
  if (!phone || !code || (purpose !== "register" && purpose !== "login")) {
    return res.status(400).json({ error: "phone, purpose, code required" });
  }

  const verifyKey = keyForPhone(phone, purpose);
  const lockSec = getLockRemaining(otpVerifyFailures.get(verifyKey));
  if (lockSec > 0) {
    return res.status(429).json({
      error: "OTP verification temporarily locked",
      retryAfterSec: lockSec
    });
  }

  try {
    const ok = await verifyOtp(phone, code, purpose);
    if (!ok) {
      const retryAfterSec = recordFailure(otpVerifyFailures, verifyKey, OTP_VERIFY_MAX_FAILURES, OTP_VERIFY_LOCKOUT_MS);
      if (retryAfterSec > 0) {
        return res.status(429).json({
          error: "Too many invalid OTP attempts",
          retryAfterSec
        });
      }
      return res.status(400).json({ error: "Invalid OTP" });
    }
    clearFailures(otpVerifyFailures, verifyKey);
    const otpProof = signOtpProof({ phone, purpose });
    return res.status(200).json({ otpProof });
  } catch (error) {
    const message = error instanceof Error ? error.message : "OTP verify failed";
    return res.status(400).json({ error: message });
  }
});

app.post("/auth/register", async (req, res) => {
  const phone = String(req.body?.phone ?? "").trim();
  const username = String(req.body?.username ?? "").trim();
  const password = String(req.body?.password ?? "").trim();
  const displayName = String(req.body?.displayName ?? username).trim();
  const otpProof = String(req.body?.otpProof ?? "").trim();

  if (!phone || !username || !password || !otpProof) {
    return res.status(400).json({ error: "phone, username, password, otpProof required" });
  }

  try {
    const proof = verifyOtpProof(otpProof);
    if (proof.phone !== phone || proof.purpose !== "register") {
      return res.status(401).json({ error: "OTP proof mismatch" });
    }

    const user = await createAccount({ phone, username, password, displayName });
    const token = signToken({ userId: user.userId, username: user.username });
    return res.status(201).json({
      token,
      user: {
        ...user,
        theme: "sand",
        statusPrivacyMode: "all",
        statusPrivacyUsers: []
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "register failed";
    return res.status(400).json({ error: message });
  }
});

app.post("/auth/login", async (req, res) => {
  const phone = String(req.body?.phone ?? "").trim();
  const password = String(req.body?.password ?? "").trim();
  const otpProof = String(req.body?.otpProof ?? "").trim();

  if (!phone || !password || !otpProof) {
    return res.status(400).json({ error: "phone, password, otpProof required" });
  }

  const loginKey = keyForPhone(phone);
  const loginLock = getLockRemaining(loginFailures.get(loginKey));
  if (loginLock > 0) {
    return res.status(429).json({
      error: "Too many failed login attempts",
      retryAfterSec: loginLock
    });
  }

  let proof;
  try {
    proof = verifyOtpProof(otpProof);
  } catch {
    return res.status(401).json({ error: "Invalid OTP proof" });
  }
  if (proof.phone !== phone || proof.purpose !== "login") {
    return res.status(401).json({ error: "OTP proof mismatch" });
  }

  const account = await authenticate(phone, password);
  if (!account) {
    const retryAfterSec = recordFailure(loginFailures, loginKey, LOGIN_MAX_FAILURES, LOGIN_LOCKOUT_MS);
    if (retryAfterSec > 0) {
      return res.status(429).json({
        error: "Too many failed login attempts",
        retryAfterSec
      });
    }
    return res.status(401).json({ error: "Invalid credentials" });
  }

  clearFailures(loginFailures, loginKey);

  const token = signToken({ userId: account.userId, username: account.username });
  return res.json({
    token,
    user: {
      userId: account.userId,
      username: account.username,
      displayName: account.displayName,
      avatarUrl: account.avatarUrl,
      theme: account.theme,
      statusPrivacyMode: account.statusPrivacyMode,
      statusPrivacyUsers: account.statusPrivacyUsers
    }
  });
});

app.get("/users/search", async (req, res) => {
  try {
    const auth = readUserFromRequest(req);
    const query = String(req.query.q ?? "").trim();
    if (!query) {
      return res.json({ users: [] });
    }
    return res.json({ users: await searchUsers(query, auth.userId) });
  } catch {
    return unauthorized(res);
  }
});

app.get("/users/by-username/:username", async (req, res) => {
  const user = await getPublicByUsername(req.params.username);
  if (!user) {
    return res.status(404).json({ error: "User not found" });
  }
  return res.json({ user });
});

app.post("/users/sync", async (req, res) => {
  try {
    const auth = readUserFromRequest(req);
    const phones = Array.isArray(req.body?.phones) ? req.body.phones.map(String) : [];
    if (phones.length === 0) {
      return res.json({ users: [] });
    }
    const matchedUsers = await getPublicByPhones(phones);
    // Exclude self if they somehow query their own phone
    const filtered = matchedUsers.filter(u => u.userId !== auth.userId);
    return res.json({ users: filtered });
  } catch {
    return unauthorized(res);
  }
});

app.post("/users/bulk", async (req, res) => {
  try {
    const auth = readUserFromRequest(req); // verify authentication
    const userIds = Array.isArray(req.body?.userIds) ? req.body.userIds.map(String) : [];
    if (userIds.length === 0) {
      return res.json({ users: [] });
    }
    const publicUsers = await getPublicByIds(userIds);
    return res.json({ users: publicUsers });
  } catch {
    return unauthorized(res);
  }
});

app.patch("/me/profile", async (req, res) => {
  try {
    const auth = readUserFromRequest(req);
    const user = await updateProfile(auth.userId, {
      displayName: req.body?.displayName,
      avatarUrl: req.body?.avatarUrl,
      theme: req.body?.theme,
      statusPrivacyMode: req.body?.statusPrivacyMode,
      statusPrivacyUsers: req.body?.statusPrivacyUsers
    });

    // Update active socket data & broadcast update to all connected clients
    const userSockets = await io.in(auth.userId).fetchSockets();
    for (const s of userSockets) {
      s.data.displayName = user.displayName;
      s.data.avatarUrl = user.avatarUrl;
    }
    io.emit("profile:update", {
      userId: auth.userId,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl
    });

    return res.json({ user });
  } catch {
    return unauthorized(res);
  }
});

const sessionsByUserId = new Map<string, Set<string>>();

const activeStatuses = new Map<string, StatusUpdate>();
const activeChannels = new Map<string, BroadcastChannel>();
const activeCommunities = new Map<string, Community>();

function cleanupStatuses() {
  const now = Date.now();
  const TTL_STATUS = 24 * 60 * 60 * 1000;
  for (const [userId, status] of activeStatuses.entries()) {
    if (now - status.timestamp > TTL_STATUS) {
      activeStatuses.delete(userId);
    }
  }
}

function cleanupExpiredEnvelope(envelope: SignalEnvelope): SignalEnvelope {
  const ttl = 24 * 60 * 60 * 1000;
  return {
    ...envelope,
    expiresAt: Date.now() + ttl
  };
}

io.use(async (socket, next) => {
  try {
    const authHeader = socket.handshake.auth?.token || parseAuthHeader(socket.handshake.headers.authorization as string | undefined);
    if (!authHeader) {
      return next(new Error("Unauthorized"));
    }
    const payload = verifyToken(authHeader);
    socket.data.userId = payload.userId;
    socket.data.username = payload.username;

    // Fetch and cache user profile information
    const account = await getAccountById(payload.userId);
    if (account) {
      socket.data.displayName = account.displayName;
      socket.data.avatarUrl = account.avatarUrl;
    }

    return next();
  } catch {
    return next(new Error("Unauthorized"));
  }
});

io.on("connection", (socket) => {
  const userId: string = socket.data.userId;
  const username: string = socket.data.username;

  if (!sessionsByUserId.has(userId)) {
    sessionsByUserId.set(userId, new Set());
  }
  sessionsByUserId.get(userId)!.add(socket.id);
  socket.join(userId);

  io.emit("presence:update", { userId, online: true });

  // Send initial list of channels and communities
  socket.emit("channels:list", Array.from(activeChannels.values()));
  socket.emit("communities:list", Array.from(activeCommunities.values()));

  socket.on("status:sync", async ({ chattedUserIds }: { chattedUserIds: string[] }) => {
    cleanupStatuses();
    const result: StatusUpdate[] = [];
    for (const [statusUserId, status] of activeStatuses.entries()) {
      if (statusUserId === userId) {
        result.push(status);
        continue;
      }
      if (!chattedUserIds.includes(statusUserId)) {
        continue;
      }
      const posterAccount = await getAccountById(statusUserId);
      if (!posterAccount) continue;

      const privacyMode = posterAccount.statusPrivacyMode || "all";
      const privacyUsers = posterAccount.statusPrivacyUsers || [];

      if (privacyMode === "hide-from" && privacyUsers.includes(userId)) {
        continue;
      }
      if (privacyMode === "share-with" && !privacyUsers.includes(userId)) {
        continue;
      }
      result.push(status);
    }
    socket.emit("status:list", result);
  });

  socket.on("status:create", ({ type, content, caption }: { type: "text" | "image" | "video"; content: string; caption?: string }) => {
    cleanupStatuses();
    let userStatus = activeStatuses.get(userId);
    if (!userStatus) {
      userStatus = {
        id: `status-user-${userId}-${Date.now()}`,
        userId,
        username,
        displayName: socket.data.displayName || username,
        avatarUrl: socket.data.avatarUrl || "",
        time: "Just now",
        timestamp: Date.now(),
        updates: []
      };
    } else {
      userStatus.timestamp = Date.now();
      userStatus.time = "Just now";
      userStatus.displayName = socket.data.displayName || username;
      userStatus.avatarUrl = socket.data.avatarUrl || "";
    }
    userStatus.updates.push({ type, content, caption });
    activeStatuses.set(userId, userStatus);
    io.emit("status:created", { userId });
  });

  socket.on("channel:create", ({ name, description, avatar }: { name: string; description: string; avatar: string }) => {
    const newChan: BroadcastChannel = {
      id: `channel-${Date.now()}`,
      name,
      description,
      creatorId: userId,
      avatar,
      messages: []
    };
    activeChannels.set(newChan.id, newChan);
    io.emit("channels:list", Array.from(activeChannels.values()));
  });

  socket.on("channel:post", ({ channelId, content }: { channelId: string; content: string }) => {
    const channel = activeChannels.get(channelId);
    if (channel && channel.creatorId === userId) {
      channel.messages.push({
        id: `msg-${Date.now()}`,
        content,
        ts: Date.now()
      });
      io.emit("channels:list", Array.from(activeChannels.values()));
    }
  });

  socket.on("community:create", ({ name, description, groups }: { name: string; description: string; groups: string[] }) => {
    const newComm: Community = {
      id: `community-${Date.now()}`,
      name,
      description,
      creatorId: userId,
      groups
    };
    activeCommunities.set(newComm.id, newComm);
    io.emit("communities:list", Array.from(activeCommunities.values()));
  });

  socket.on("signal:send", (raw: SignalEnvelope) => {
    const envelope = cleanupExpiredEnvelope(raw);
    const targetSocketIds = sessionsByUserId.get(envelope.toUserId);
    if (!targetSocketIds || targetSocketIds.size === 0) {
      socket.emit("signal:delivery", { toUserId: envelope.toUserId, delivered: false });
      return;
    }
    io.to(envelope.toUserId).emit("signal:receive", {
      fromUserId: userId,
      fromUsername: username,
      fromDisplayName: socket.data.displayName || username,
      fromAvatarUrl: socket.data.avatarUrl || "",
      envelope
    });
    socket.emit("signal:delivery", { toUserId: envelope.toUserId, delivered: true });
  });

  socket.on("disconnect", () => {
    const activeSockets = sessionsByUserId.get(userId);
    if (activeSockets) {
      activeSockets.delete(socket.id);
      if (activeSockets.size === 0) {
        sessionsByUserId.delete(userId);
        io.emit("presence:update", { userId, online: false });
      }
    }
  });
});

const port = Number(process.env.PORT ?? 4000);
connectDatabase()
  .then(() => {
    server.listen(port, () => {
      // Minimal server log for local development.
      console.log(`Server listening on http://localhost:${port}`);
    });
  })
  .catch((error) => {
    console.error("Failed to start server:", error);
    process.exit(1);
  });
