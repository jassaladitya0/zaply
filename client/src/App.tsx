import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { io, type Socket } from "socket.io-client";
import {
  checkUsernameAvailability,
  login,
  register,
  requestOtp,
  searchUsers,
  updateProfile,
  verifyOtp,
  syncContacts,
  fetchBulkProfiles
} from "./api";
import type { ChatMessage, OtpPurpose, PublicUser, Session, SignalPayload, SignalScope, Theme } from "./types";
import "./styles.css";

/* ─── Types ─── */
export interface CallLog {
  id: string;
  userId: string;
  userName: string;
  type: "voice" | "video";
  direction: "incoming" | "outgoing" | "missed";
  ts: number;
}

type SignalReceive = {
  fromUserId: string;
  fromUsername: string;
  fromDisplayName?: string;
  fromAvatarUrl?: string;
  envelope: {
    toUserId: string;
    type: "chat" | "offer" | "answer" | "ice" | "file-meta" | "typing" | "close-call";
    payload: unknown;
    expiresAt?: number;
  };
};
type ScopedOffer = { scope: SignalScope; sdp: RTCSessionDescriptionInit };
type ScopedAnswer = { scope: SignalScope; sdp: RTCSessionDescriptionInit };
type ScopedIce = { scope: SignalScope; candidate: RTCIceCandidateInit };
type FileCtrl = { kind: "meta"; name: string; size: number; mime: string } | { kind: "done" };

interface StatusUpdate {
  id: string;
  userId: string;
  username: string;
  displayName: string;
  avatarUrl?: string;
  time: string;
  updates: { type: "text"; content: string }[];
  viewed: boolean;
}

/* ─── Config ─── */
const ICE: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:global.stun.twilio.com:3478" },
  {
    urls: "turn:openrelay.metered.ca:80",
    username: "openrelayproject",
    credential: "openrelayproject"
  },
  {
    urls: "turn:openrelay.metered.ca:443",
    username: "openrelayproject",
    credential: "openrelayproject"
  }
];
const TTL = 24 * 60 * 60 * 1000;

// Dynamically resolve backend port 4000 locally
const resolveSignalingUrl = (): string => {
  const envUrl = import.meta.env.VITE_SIGNALING_BASE_URL as string | undefined;
  if (envUrl) return envUrl;
  if (typeof window !== "undefined" && window.location) {
    const host = window.location.hostname;
    if (host && host !== "localhost" && host !== "127.0.0.1") {
      return `${window.location.protocol}//${host}:4000`;
    }
  }
  return "http://localhost:4000";
};

const API = resolveSignalingUrl();
const THEMES: Theme[] = ["sand", "forest", "sunset"];

/* ─── Utils ─── */
const COLORS = ["#4648d4", "#00628d", "#4e45d5", "#007cb1", "#ba1a1a", "#6860ef", "#07006c", "#004c6e"];
const avColor = (n: string) => {
  let h = 0;
  for (let i = 0; i < n.length; i++) h = n.charCodeAt(i) + ((h << 5) - h);
  return COLORS[Math.abs(h) % COLORS.length];
};
const initials = (n: string) =>
  n
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
const fmtTime = (ts: number) =>
  new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const fmtDate = (ts: number) => {
  const d = new Date(ts),
    n = new Date();
  if (d.toDateString() === n.toDateString()) return "Today";
  const y = new Date(n);
  y.setDate(n.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { day: "numeric", month: "long", year: "numeric" });
};

async function compressAvatar(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image(),
      url = URL.createObjectURL(file);
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = c.height = 200;
      const ctx = c.getContext("2d")!;
      const min = Math.min(img.width, img.height);
      ctx.drawImage(img, (img.width - min) / 2, (img.height - min) / 2, min, min, 0, 0, 200, 200);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL("image/jpeg", 0.8));
    };
    img.onerror = reject;
    img.src = url;
  });
}

/* ─── Main App ─── */
export function App() {
  /* Auth */
  const [session, setSession] = useState<Session | null>(null);
  const [phone, setPhone] = useState("");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [otpCode, setOtpCode] = useState("");
  const [otpProof, setOtpProof] = useState("");
  const [otpStatus, setOtpStatus] = useState<string | null>(null);
  const [otpRetry, setOtpRetry] = useState(0);
  const [authMode, setAuthMode] = useState<"login" | "register">("register");
  const [unameOk, setUnameOk] = useState<boolean | null>(null);
  const [authErr, setAuthErr] = useState<string | null>(null);

  /* App Views & States */
  const [activeNav, setActiveNav] = useState<"chats" | "status" | "calls" | "channels" | "communities" | "settings">("chats");
  const [selectedUser, setSelectedUser] = useState<PublicUser | null>(null);
  const [query, setQuery] = useState("");
  const [text, setText] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [online, setOnline] = useState<Set<string>>(new Set());
  const [unread, setUnread] = useState<Record<string, number>>({});
  const [filterPill, setFilterPill] = useState<"all" | "unread">("all");
  
  // Settings view states
  const [selectedSettingsPage, setSelectedSettingsPage] = useState<"profile" | "privacy" | "chats" | "notifications" | "help">("profile");
  const [editName, setEditName] = useState("");
  const [editingName, setEditingName] = useState(false);
  const [editAbout, setEditAbout] = useState("Focusing on deep work 🚀");
  const [editingAbout, setEditingAbout] = useState(false);
  const [readReceipts, setReadReceipts] = useState(true);

  // WebRTC call states
  const [inCall, setInCall] = useState(false);
  const [incomingFrom, setIncomingFrom] = useState<string | null>(null);
  const [callHistory, setCallHistory] = useState<CallLog[]>([]);

  // Status updates states
  const [statuses, setStatuses] = useState<StatusUpdate[]>([
    {
      id: "status-sarah",
      userId: "user-sarah",
      username: "sarah_j",
      displayName: "Sarah Jenkins",
      avatarUrl: "https://lh3.googleusercontent.com/aida-public/AB6AXuDaNicjQ2uU_2o1X50ieyztYRbIUcQHB_ElE_GIUhymbQcLgx5HcGsFS6E_d-aodrm3mcv9Vc8bxgl3C-aqtiqmL3wiU8JJXi2kFEN9dHcJpyl-fZU0gmTNeKOn_6fbApAd28RnL782ybMTIgwLQNE-Tmb-vB9u8rOevFkujYbH8eGiVgZReepROh9FIGncrsFg2DU1oNdbKsoByP3Ec2bE3il4C400i2On-N6QwjEU3cMjzUloIvFZ",
      time: "10:45 AM",
      updates: [
        { type: "text", content: "Working on the new design system! 🚀" },
        { type: "text", content: "Tailwind v4 is absolutely amazing!" }
      ],
      viewed: false
    },
    {
      id: "status-design",
      userId: "user-design",
      username: "design_team",
      displayName: "Design Team Sync",
      avatarUrl: "https://lh3.googleusercontent.com/aida-public/AB6AXuArk495R1WV2-mzZZmaYiBQARHXHB7nRXv0l4sb1NjqZ8Omb9aLxB8mXrvJ_F_DI4PrMJY_eoINdTvrx9D6Ln-pxWMrZDFvcZSRUjYtHGEdmHp3MaW3WVEkcbdM2W2xrA5KsO1vHpjEHG16cEkGfGVMD-MdwA5wn7lHbTXPAhzoUFu5HnCtgUxstUF1OHLCqfFN9o9xeGKqtK75XdUiVQrjVYBon5q07ELdLtQngt-BQE2iCTK80UeV",
      time: "9:12 AM",
      updates: [
        { type: "text", content: "Prototype design files are ready for review." }
      ],
      viewed: false
    },
    {
      id: "status-mike",
      userId: "user-mike",
      username: "mike_t",
      displayName: "Mike Thompson",
      avatarUrl: "https://lh3.googleusercontent.com/aida-public/AB6AXuAw3k7iPIh2ASkC-VP4QSdl5nOmOTBVK67zmxhHkYKOkUZjEKhkx4i7S7ovBsBy0It8LuNUVoQtzKe1elhapm42Q0o5gLyCUHaF5rAdIE8JHCGMna05XXfHFXCO927Op4BGLrtyyZU_A2izQfK16ugPtGGcF0JzLGE08CExskfKdDyzUBrj5oWSGRTyUTb1WMi0fyrNtTr5duYbkQDcmN8uM3dQ0g4Skza94kodApxp863epm7nGSUj",
      time: "Yesterday",
      updates: [
        { type: "text", content: "Out of office for the weekend! 🏕️" }
      ],
      viewed: true
    }
  ]);
  const [selectedStatus, setSelectedStatus] = useState<StatusUpdate | null>(null);
  const [activeStatusIndex, setActiveStatusIndex] = useState(0);
  const [showAddStatusModal, setShowAddStatusModal] = useState(false);
  const [newStatusText, setNewStatusText] = useState("");

  // Channels mock data
  const [selectedChannel, setSelectedChannel] = useState<any | null>(null);
  const channelsList = [
    {
      id: "ch-whatsapp",
      name: "WhatsApp News",
      avatar: "chat",
      description: "Official announcements, updates, and feature rollouts from the WhatsApp team.",
      messages: [
        { id: "ch-m1", content: "Welcome to the WhatsApp News official channel! You'll receive important release updates here.", ts: Date.now() - 3600000 * 28 },
        { id: "ch-m2", content: "📣 We are introducing support for custom color themes. Explore dynamic indigo interfaces starting today!", ts: Date.now() - 3600000 * 2 }
      ]
    },
    {
      id: "ch-vite",
      name: "Vite JS Updates",
      avatar: "hub",
      description: "Development updates, community plugins, and tools in the Vite workspace ecosystem.",
      messages: [
        { id: "ch-m3", content: "Vite 6 is now generally available! Experience the next generation of fast builds.", ts: Date.now() - 3600000 * 18 }
      ]
    }
  ];

  // Communities mock data
  const [selectedCommunity, setSelectedCommunity] = useState<any | null>(null);
  const communitiesList = [
    {
      id: "comm-design",
      name: "Design Community",
      description: "Collaborate on prototypes, UX research, style systems, and layouts.",
      groups: ["Core UI Sync", "Material Tokens Forum", "Creative Feedback Showcase"]
    },
    {
      id: "comm-dev",
      name: "Development Guild",
      description: "System design, peer reviews, signaling code architecture, and WebRTC.",
      groups: ["Vite & React Hub", "Mongoose DB Schemas", "WebSockets Lab"]
    }
  ];

  const addCallLog = useCallback((uid: string, name: string, type: "voice" | "video", direction: "incoming" | "outgoing" | "missed") => {
    const newLog: CallLog = {
      id: crypto.randomUUID(),
      userId: uid,
      userName: name,
      type,
      direction,
      ts: Date.now()
    };
    setCallHistory((prev) => [newLog, ...prev]);
  }, []);

  /* Local Address Book & Sync */
  const [contacts, setContacts] = useState<PublicUser[]>([]);
  const [addressBook, setAddressBook] = useState<Record<string, string>>({}); // phone -> contactName
  const [phoneToUser, setPhoneToUser] = useState<Record<string, string>>({}); // phone -> userId
  const [userToPhone, setUserToPhone] = useState<Record<string, string>>({}); // userId -> phone
  const [showSyncModal, setShowSyncModal] = useState(false);
  const [newContactName, setNewContactName] = useState("");
  const [newContactPhone, setNewContactPhone] = useState("");

  /* Refs */
  const socketRef = useRef<Socket | null>(null);
  const localVidRef = useRef<HTMLVideoElement | null>(null);
  const remoteVidRef = useRef<HTMLVideoElement | null>(null);
  const callPcRef = useRef<RTCPeerConnection | null>(null);
  const filePcRef = useRef<RTCPeerConnection | null>(null);
  const fileChanRef = useRef<RTCDataChannel | null>(null);
  const pendingFileRef = useRef<File | null>(null);
  const filePeerRef = useRef<string | null>(null);
  const incomingFileRef = useRef<{ name: string; mime: string; chunks: ArrayBuffer[]; from: string } | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const feedRef = useRef<HTMLDivElement | null>(null);
  const selectedRef = useRef<PublicUser | null>(null);

  // Keep selectedRef in sync
  useEffect(() => {
    selectedRef.current = selectedUser;
  }, [selectedUser]);

  /* ─── Load from localStorage ─── */
  useEffect(() => {
    const s = localStorage.getItem("zaply-session");
    if (s) setSession(JSON.parse(s));
    const c = localStorage.getItem("zaply-contacts");
    if (c) setContacts(JSON.parse(c));
    const ab = localStorage.getItem("zaply-address-book");
    if (ab) setAddressBook(JSON.parse(ab));
    const p2u = localStorage.getItem("zaply-phone-to-user");
    if (p2u) setPhoneToUser(JSON.parse(p2u));
    const u2p = localStorage.getItem("zaply-user-to-phone");
    if (u2p) setUserToPhone(JSON.parse(u2p));
    const ch = localStorage.getItem("zaply-call-history");
    if (ch) setCallHistory(JSON.parse(ch));
    const m = localStorage.getItem("zaply-messages");
    if (m) {
      const parsed: ChatMessage[] = JSON.parse(m);
      const now = Date.now();
      setMessages(parsed.filter((msg) => msg.expiresAt > now));
    }
    const sab = localStorage.getItem("zaply-about");
    if (sab) setEditAbout(sab);
  }, []);

  /* ─── Save contacts & messages ─── */
  useEffect(() => {
    if (contacts.length) localStorage.setItem("zaply-contacts", JSON.stringify(contacts));
  }, [contacts]);
  useEffect(() => {
    localStorage.setItem("zaply-messages", JSON.stringify(messages));
  }, [messages]);
  useEffect(() => {
    localStorage.setItem("zaply-address-book", JSON.stringify(addressBook));
  }, [addressBook]);
  useEffect(() => {
    localStorage.setItem("zaply-phone-to-user", JSON.stringify(phoneToUser));
  }, [phoneToUser]);
  useEffect(() => {
    localStorage.setItem("zaply-user-to-phone", JSON.stringify(userToPhone));
  }, [userToPhone]);
  useEffect(() => {
    localStorage.setItem("zaply-call-history", JSON.stringify(callHistory));
  }, [callHistory]);

  /* ─── OTP countdown ─── */
  useEffect(() => {
    if (otpRetry <= 0) return;
    const t = setTimeout(() => setOtpRetry((x) => Math.max(0, x - 1)), 1000);
    return () => clearTimeout(t);
  }, [otpRetry]);
  useEffect(() => {
    setOtpCode("");
    setOtpProof("");
    setOtpStatus(null);
    setOtpRetry(0);
  }, [authMode, phone]);

  /* ─── Notification Permission & Profile Sync ─── */
  useEffect(() => {
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission();
    }
  }, []);

  useEffect(() => {
    if (session && contacts.length > 0) {
      const ids = contacts.map((c) => c.userId);
      fetchBulkProfiles(ids, session.token)
        .then((fresh) => {
          setContacts((prev) => {
            // Keep only the contacts that exist on the server (handles db wipes)
            const next = prev
              .filter((u) => fresh.some((f) => f.userId === u.userId))
              .map((u) => {
                const match = fresh.find((f) => f.userId === u.userId);
                return match ? { ...u, displayName: match.displayName, avatarUrl: match.avatarUrl } : u;
              });
            localStorage.setItem("zaply-contacts", JSON.stringify(next));
            return next;
          });
        })
        .catch((err) => console.error("Error bulk syncing contact profiles:", err));
    }
  }, [session]);

  /* ─── Status Auto-Progression Timer ─── */
  useEffect(() => {
    if (!selectedStatus) return;
    const interval = setInterval(() => {
      if (activeStatusIndex < selectedStatus.updates.length - 1) {
        setActiveStatusIndex((prev) => prev + 1);
      } else {
        // Mark as viewed
        setStatuses((prev) =>
          prev.map((s) => (s.id === selectedStatus.id ? { ...s, viewed: true } : s))
        );
        setSelectedStatus(null);
        setActiveStatusIndex(0);
      }
    }, 4500);
    return () => clearInterval(interval);
  }, [selectedStatus, activeStatusIndex]);

  /* ─── Socket Connection ─── */
  useEffect(() => {
    if (!session) {
      socketRef.current?.disconnect();
      socketRef.current = null;
      return;
    }
    localStorage.setItem("zaply-session", JSON.stringify(session));

    const sock = io(API, { auth: { token: session.token }, transports: ["websocket", "polling"] });
    socketRef.current = sock;

    sock.on("presence:update", ({ userId, online: on }: { userId: string; online: boolean }) => {
      setOnline((prev) => {
        const s = new Set(prev);
        on ? s.add(userId) : s.delete(userId);
        return s;
      });
    });

    sock.on("profile:update", ({ userId, displayName, avatarUrl }: { userId: string; displayName: string; avatarUrl: string }) => {
      setContacts((prev) => {
        const next = prev.map((u) => (u.userId === userId ? { ...u, displayName, avatarUrl } : u));
        localStorage.setItem("zaply-contacts", JSON.stringify(next));
        return next;
      });
    });

    sock.on("signal:receive", async (pkt: SignalReceive) => {
      const { fromUserId, fromUsername, fromDisplayName, fromAvatarUrl, envelope } = pkt;

      // Update local contacts cache with sender details
      setContacts((prev) => {
        const existing = prev.find((u) => u.userId === fromUserId);
        const resolvedDisp = fromDisplayName || fromUsername;
        if (existing) {
          if (existing.displayName === resolvedDisp && existing.avatarUrl === fromAvatarUrl) return prev;
          const next = prev.map((u) =>
            u.userId === fromUserId ? { ...u, displayName: resolvedDisp, avatarUrl: fromAvatarUrl } : u
          );
          localStorage.setItem("zaply-contacts", JSON.stringify(next));
          return next;
        }
        const newUser = { userId: fromUserId, username: fromUsername, displayName: resolvedDisp, avatarUrl: fromAvatarUrl };
        const next = [newUser, ...prev];
        localStorage.setItem("zaply-contacts", JSON.stringify(next));
        return next;
      });

      if (envelope.type === "chat") {
        const payloadStr = String(envelope.payload);
        let msgContent = payloadStr;
        let isFile = false;
        let downloadUrl = "";

        try {
          if (payloadStr.startsWith('{"type":"file"')) {
            const parsed = JSON.parse(payloadStr);
            isFile = true;
            msgContent = `${parsed.name} (${Math.round(parsed.size / 1024)} KB)`;
            downloadUrl = parsed.data;
          }
        } catch {
          // treat as text
        }

        const msg: ChatMessage = {
          id: crypto.randomUUID(),
          fromUserId,
          toUserId: session.user.userId,
          kind: isFile ? "file-meta" : "text",
          content: msgContent,
          downloadUrl: downloadUrl || undefined,
          ts: Date.now(),
          expiresAt: envelope.expiresAt ?? Date.now() + TTL
        };
        setMessages((prev) => [...prev, msg]);
        if (selectedRef.current?.userId !== fromUserId) {
          setUnread((p) => ({ ...p, [fromUserId]: (p[fromUserId] ?? 0) + 1 }));
        }

        // Trigger Web Notification if user is off-tab
        if (document.visibilityState !== "visible" && "Notification" in window && Notification.permission === "granted") {
          const senderName = fromDisplayName || fromUsername;
          new Notification(senderName, {
            body: isFile ? `📎 Sent a file: ${msgContent}` : msgContent,
            tag: fromUserId
          });
        }
      }

      if (envelope.type === "file-meta") {
        const meta = envelope.payload as { name: string; size: number; mime: string };
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            fromUserId,
            toUserId: session.user.userId,
            kind: "file-meta",
            content: `${meta.name} (${Math.round(meta.size / 1024)} KB)`,
            ts: Date.now(),
            expiresAt: Date.now() + TTL
          }
        ]);
      }

      if (envelope.type === "close-call") {
        endCall(true);
      }

      if (envelope.type === "offer") {
        const p = envelope.payload as ScopedOffer & { video?: boolean };
        if (p.scope === "call") {
          setIncomingFrom(fromUserId);
          const isVideo = p.video ?? true;
          const callerName = fromDisplayName || fromUsername;
          addCallLog(fromUserId, callerName, isVideo ? "video" : "voice", "incoming");

          try {
            const stream = await getMedia(isVideo);
            const pc = makePc();
            callPcRef.current = pc;
            stream.getTracks().forEach((t) => pc.addTrack(t, stream));
            pc.ontrack = (e) => {
              if (remoteVidRef.current) remoteVidRef.current.srcObject = e.streams[0];
            };
            pc.onicecandidate = (e) => {
              if (e.candidate) {
                send({ toUserId: fromUserId, type: "ice", payload: { scope: "call", candidate: e.candidate } });
              }
            };
            await pc.setRemoteDescription(new RTCSessionDescription(p.sdp));
            const ans = await pc.createAnswer();
            await pc.setLocalDescription(ans);
            send({ toUserId: fromUserId, type: "answer", payload: { scope: "call", sdp: ans } });
          } catch (e) {
            console.error("call answer failed", e);
          }
        }
        if (p.scope === "file") {
          filePeerRef.current = fromUserId;
          const pc = makePc();
          filePcRef.current = pc;
          pc.ondatachannel = (e) => setupFileChan(e.channel, session.user.userId);
          pc.onicecandidate = (e) => {
            if (e.candidate) {
              send({ toUserId: fromUserId, type: "ice", payload: { scope: "file", candidate: e.candidate } });
            }
          };
          await pc.setRemoteDescription(new RTCSessionDescription(p.sdp));
          const ans = await pc.createAnswer();
          await pc.setLocalDescription(ans);
          send({ toUserId: fromUserId, type: "answer", payload: { scope: "file", sdp: ans } });
        }
      }

      if (envelope.type === "answer") {
        const p = envelope.payload as ScopedAnswer;
        if (p.scope === "call" && callPcRef.current) {
          await callPcRef.current.setRemoteDescription(new RTCSessionDescription(p.sdp));
        }
        if (p.scope === "file" && filePcRef.current) {
          await filePcRef.current.setRemoteDescription(new RTCSessionDescription(p.sdp));
        }
      }
      if (envelope.type === "ice") {
        const p = envelope.payload as ScopedIce;
        if (p.scope === "call" && callPcRef.current) {
          await callPcRef.current.addIceCandidate(new RTCIceCandidate(p.candidate));
        }
        if (p.scope === "file" && filePcRef.current) {
          await filePcRef.current.addIceCandidate(new RTCIceCandidate(p.candidate));
        }
      }
    });

    return () => {
      sock.disconnect();
    };
  }, [session, addCallLog]);

  /* ─── TTL cleanup ─── */
  useEffect(() => {
    const t = setInterval(() => {
      const now = Date.now();
      setMessages((p) => p.filter((m) => m.expiresAt > now));
    }, 60_000);
    return () => clearInterval(t);
  }, []);

  /* ─── Scroll to bottom ─── */
  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight, behavior: "smooth" });
  }, [messages.length, selectedUser, activeNav]);

  /* ─── Helpers ─── */
  const send = useCallback((payload: SignalPayload) => {
    socketRef.current?.emit("signal:send", payload);
  }, []);
  const makePc = () => new RTCPeerConnection({ iceServers: ICE });

  async function getMedia(video: boolean) {
    if (localStreamRef.current) return localStreamRef.current;
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video, audio: true });
      localStreamRef.current = s;
      if (localVidRef.current) localVidRef.current.srcObject = s;
      return s;
    } catch {
      throw new Error("Camera/mic permission denied. Please allow access.");
    }
  }

  function setupFileChan(chan: RTCDataChannel, myId: string) {
    fileChanRef.current = chan;
    chan.binaryType = "arraybuffer";
    chan.onopen = () => sendPendingFile();
    chan.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        const ctrl = JSON.parse(ev.data) as FileCtrl;
        if (ctrl.kind === "meta") {
          incomingFileRef.current = { name: ctrl.name, mime: ctrl.mime, chunks: [], from: filePeerRef.current ?? "?" };
        }
        if (ctrl.kind === "done" && incomingFileRef.current) {
          const inc = incomingFileRef.current;
          const blob = new Blob(inc.chunks, { type: inc.mime || "application/octet-stream" });
          const url = URL.createObjectURL(blob);
          setMessages((p) => [
            ...p,
            {
              id: crypto.randomUUID(),
              fromUserId: inc.from,
              toUserId: myId,
              kind: "file-meta",
              content: inc.name,
              downloadUrl: url,
              ts: Date.now(),
              expiresAt: Date.now() + TTL
            }
          ]);
          incomingFileRef.current = null;
        }
      } else if (ev.data instanceof ArrayBuffer && incomingFileRef.current) {
        incomingFileRef.current.chunks.push(ev.data);
      }
    };
  }

  async function sendPendingFile() {
    const f = pendingFileRef.current,
      c = fileChanRef.current;
    if (!f || !c || c.readyState !== "open") return;
    c.send(JSON.stringify({ kind: "meta", name: f.name, size: f.size, mime: f.type || "application/octet-stream" } satisfies FileCtrl));
    const chunk = 16 * 1024;
    for (let i = 0; i < f.size; i += chunk) {
      c.send(await f.slice(i, i + chunk).arrayBuffer());
    }
    c.send(JSON.stringify({ kind: "done" } satisfies FileCtrl));
    pendingFileRef.current = null;
  }

  async function doFileShare(file: File) {
    if (!session || !selectedUser) return;
    if (file.size > 12 * 1024 * 1024) {
      alert("File is too large. Maximum size is 12MB.");
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const base64Data = reader.result as string;
      const filePayload = {
        type: "file",
        name: file.name,
        size: file.size,
        mime: file.type || "application/octet-stream",
        data: base64Data
      };
      const jsonPayload = JSON.stringify(filePayload);

      const localMsg: ChatMessage = {
        id: crypto.randomUUID(),
        fromUserId: session.user.userId,
        toUserId: selectedUser.userId,
        kind: "file-meta",
        content: `${file.name} (${Math.round(file.size / 1024)} KB)`,
        downloadUrl: base64Data,
        ts: Date.now(),
        expiresAt: Date.now() + TTL
      };

      setMessages((prev) => [...prev, localMsg]);
      send({ toUserId: selectedUser.userId, type: "chat", payload: jsonPayload });
    };
    reader.onerror = () => {
      alert("Failed to read file.");
    };
    reader.readAsDataURL(file);
  }

  async function doCall(video: boolean, targetUser = selectedUser) {
    if (!session || !targetUser) {
      alert("Select a user first");
      return;
    }
    try {
      addCallLog(targetUser.userId, getResolvedName(targetUser), video ? "video" : "voice", "outgoing");
      const stream = await getMedia(video);
      const pc = makePc();
      callPcRef.current = pc;
      stream.getTracks().forEach((t) => pc.addTrack(t, stream));
      pc.ontrack = (e) => {
        if (remoteVidRef.current) remoteVidRef.current.srcObject = e.streams[0];
      };
      pc.onicecandidate = (e) => {
        if (e.candidate) {
          send({ toUserId: targetUser.userId, type: "ice", payload: { scope: "call", candidate: e.candidate } });
        }
      };
      const off = await pc.createOffer();
      await pc.setLocalDescription(off);
      send({ toUserId: targetUser.userId, type: "offer", payload: { scope: "call", sdp: off, video } });
      setInCall(true);
    } catch (e) {
      alert(e instanceof Error ? e.message : "Call failed");
    }
  }

  function endCall(isRemote = false) {
    if (!isRemote) {
      const peerId = incomingFrom || selectedRef.current?.userId;
      if (peerId) {
        send({ toUserId: peerId, type: "close-call", payload: {} });
      }
    }
    if (incomingFrom) {
      setCallHistory((prev) => {
        const idx = prev.findIndex((l) => l.userId === incomingFrom && l.direction === "incoming");
        if (idx !== -1) {
          const next = [...prev];
          next[idx] = { ...next[idx], direction: "missed" };
          return next;
        }
        return prev;
      });
    }
    callPcRef.current?.close();
    callPcRef.current = null;
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = null;
    setInCall(false);
    setIncomingFrom(null);
  }

  function sendMsg() {
    if (!session || !selectedUser || !text.trim()) return;
    const msg: ChatMessage = {
      id: crypto.randomUUID(),
      fromUserId: session.user.userId,
      toUserId: selectedUser.userId,
      kind: "text",
      content: text.trim(),
      ts: Date.now(),
      expiresAt: Date.now() + TTL
    };
    setMessages((p) => [...p, msg]);
    send({ toUserId: selectedUser.userId, type: "chat", payload: text.trim() });
    setText("");
  }

  /* ─── Address Book Handlers ─── */
  const syncWithServer = useCallback(
    async (currentAddressBook: Record<string, string>) => {
      if (!session) return;
      const phones = Object.keys(currentAddressBook);
      if (phones.length === 0) return;
      try {
        const matched = await syncContacts(phones, session.token);
        setPhoneToUser((prev) => {
          const next = { ...prev };
          matched.forEach((u) => {
            next[u.phone] = u.userId;
          });
          return next;
        });
        setUserToPhone((prev) => {
          const next = { ...prev };
          matched.forEach((u) => {
            next[u.userId] = u.phone;
          });
          return next;
        });
        setContacts((prev) => {
          let updated = [...prev];
          matched.forEach((u) => {
            if (!updated.find((c) => c.userId === u.userId)) {
              updated = [u, ...updated];
            }
          });
          return updated;
        });
      } catch (err) {
        console.error("Sync error:", err);
      }
    },
    [session]
  );

  const addContact = (name: string, phoneStr: string) => {
    const formatted = phoneStr.trim();
    if (!formatted || !name.trim()) return;
    setAddressBook((prev) => {
      const next = { ...prev, [formatted]: name.trim() };
      void syncWithServer(next);
      return next;
    });
    setNewContactName("");
    setNewContactPhone("");
  };

  const getResolvedName = useCallback(
    (user: Pick<PublicUser, "userId" | "displayName">) => {
      const p = userToPhone[user.userId];
      if (p && addressBook[p]) return addressBook[p];
      return user.displayName;
    },
    [userToPhone, addressBook]
  );

  const getResolvedPhone = useCallback(
    (userId: string) => {
      const p = userToPhone[userId];
      if (p && addressBook[p]) return p;
      return null;
    },
    [userToPhone, addressBook]
  );

  const syncFromDevice = async () => {
    try {
      if (!("contacts" in navigator && "ContactsManager" in window)) {
        alert("Your browser does not support native contact picking. Please add contacts manually below.");
        return;
      }
      // @ts-ignore
      const deviceContacts = await navigator.contacts.select(["name", "tel"], { multiple: true });
      if (deviceContacts && deviceContacts.length > 0) {
        const addedBook: Record<string, string> = { ...addressBook };
        deviceContacts.forEach((c: any) => {
          const name = c.name?.[0] || "Unknown Contact";
          const rawPhone = c.tel?.[0] || "";
          const cleanPhone = rawPhone.replace(/[^\d+]/g, "");
          if (cleanPhone) {
            addedBook[cleanPhone] = name;
          }
        });
        setAddressBook(addedBook);
        void syncWithServer(addedBook);
        alert(`Successfully imported ${deviceContacts.length} contacts!`);
      }
    } catch (err) {
      alert("Could not access device contacts. Please use manual contact management.");
      setShowSyncModal(true);
    }
  };

  async function doSearch(q: string) {
    setQuery(q);
    if (!session || !q.trim()) return;
    try {
      const res = await searchUsers(q, session.token);
      res.forEach((u) => {
        setContacts((prev) => {
          if (prev.find((c) => c.userId === u.userId)) return prev;
          return [u, ...prev];
        });
      });
    } catch {
      /* ignore */
    }
  }

  function selectUser(u: PublicUser) {
    setSelectedUser(u);
    setUnread((p) => ({ ...p, [u.userId]: 0 }));
    setContacts((prev) => [u, ...prev.filter((c) => c.userId !== u.userId)]);
  }

  /* Auth handlers */
  async function doRequestOtp() {
    if (!phone.trim()) {
      setAuthErr("Phone number required");
      return;
    }
    setAuthErr(null);
    try {
      await requestOtp(phone, authMode as OtpPurpose);
      setOtpStatus("OTP sent! Use 000000 in test mode.");
    } catch (e) {
      const m = e instanceof Error ? e.message : "Failed";
      const r = /try again in (\d+)s/i.exec(m);
      if (r) setOtpRetry(Number(r[1]));
      setAuthErr(m);
    }
  }

  async function doVerifyOtp() {
    if (!phone.trim() || !otpCode.trim()) {
      setAuthErr("Phone and OTP required");
      return;
    }
    setAuthErr(null);
    try {
      const p = await verifyOtp(phone, authMode as OtpPurpose, otpCode);
      setOtpProof(p);
      setOtpStatus("✓ Phone verified");
    } catch (e) {
      setAuthErr(e instanceof Error ? e.message : "OTP failed");
    }
  }

  async function doAuth(e: React.FormEvent) {
    e.preventDefault();
    setAuthErr(null);
    if (!otpProof) {
      setAuthErr("Please verify OTP first");
      return;
    }
    try {
      const next =
        authMode === "register"
          ? await register({ phone, username, displayName: displayName || username, password, otpProof })
          : await login({ phone, password, otpProof });
      setSession(next);
    } catch (e) {
      setAuthErr(e instanceof Error ? e.message : "Auth failed");
    }
  }

  async function checkUname() {
    if (!username.trim()) {
      setUnameOk(null);
      return;
    }
    setUnameOk(await checkUsernameAvailability(username));
  }

  /* Profile updates */
  async function saveDisplayName() {
    if (!session || !editName.trim()) return;
    const user = await updateProfile(session.token, { displayName: editName.trim() });
    setSession({ ...session, user: { ...session.user, ...user } });
    setEditingName(false);
  }

  async function saveAbout() {
    if (!session || !editAbout.trim()) return;
    localStorage.setItem("zaply-about", editAbout.trim());
    setEditingAbout(false);
  }

  async function uploadAvatar(file: File) {
    if (!session) return;
    try {
      const b64 = await compressAvatar(file);
      const user = await updateProfile(session.token, { avatarUrl: b64 });
      setSession({ ...session, user: { ...session.user, ...user } });
    } catch (e) {
      alert("Failed to upload photo");
    }
  }

  const handleAddStatus = () => {
    if (!newStatusText.trim() || !session) return;
    const myId = session.user.userId;
    setStatuses((prev) => {
      const existing = prev.find((s) => s.userId === myId);
      if (existing) {
        return [
          {
            ...existing,
            time: "Just now",
            updates: [...existing.updates, { type: "text", content: newStatusText.trim() }],
            viewed: false
          },
          ...prev.filter((s) => s.userId !== myId)
        ];
      } else {
        return [
          {
            id: `status-me-${Date.now()}`,
            userId: myId,
            username: session.user.username,
            displayName: "My Status",
            avatarUrl: session.user.avatarUrl,
            time: "Just now",
            viewed: false,
            updates: [{ type: "text", content: newStatusText.trim() }]
          },
          ...prev
        ];
      }
    });
    setNewStatusText("");
    setShowAddStatusModal(false);
  };

  /* Computed lists */
  const activeMessages = useMemo(() => {
    if (!session || !selectedUser) return [] as ChatMessage[];
    return messages.filter(
      (m) =>
        (m.fromUserId === session.user.userId && m.toUserId === selectedUser.userId) ||
        (m.fromUserId === selectedUser.userId && m.toUserId === session.user.userId)
    );
  }, [messages, selectedUser, session]);

  const grouped = useMemo(() => {
    const g: { date: string; msgs: ChatMessage[] }[] = [];
    let last = "";
    for (const m of activeMessages) {
      const d = fmtDate(m.ts);
      if (d !== last) {
        g.push({ date: d, msgs: [] });
        last = d;
      }
      g[g.length - 1].msgs.push(m);
    }
    return g;
  }, [activeMessages]);

  const filteredContacts = useMemo(() => {
    if (filterPill === "unread") return contacts.filter((u) => (unread[u.userId] ?? 0) > 0);
    return contacts;
  }, [contacts, filterPill, unread]);

  const lastMsg = (uid: string) => {
    const all = messages.filter((m) => m.fromUserId === uid || m.toUserId === uid);
    return all[all.length - 1] ?? null;
  };

  /* ─── AUTH SCREEN ─── */
  if (!session) {
    return (
      <div className="flex items-center justify-center min-h-screen w-full bg-surface-container-low font-body-md p-6 select-none">
        <div className="w-full max-w-md bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-xl p-8 animate-in fade-in zoom-in-95 duration-200">
          <div className="flex items-center gap-3 mb-2 justify-center">
            <span className="material-symbols-outlined text-primary text-4xl" style={{ fontVariationSettings: "'FILL' 1" }}>
              chat
            </span>
            <h1 className="font-headline-xl text-3xl text-on-surface">Zaply</h1>
          </div>
          <p className="text-on-surface-variant text-body-md text-center mb-8">
            Connect securely and chat in real-time
          </p>

          <div className="flex bg-surface-container-low rounded-xl p-1 mb-6">
            <button
              type="button"
              className={`flex-1 py-2 text-label-md rounded-lg transition-colors ${authMode === "register" ? "bg-primary text-on-primary shadow-sm" : "text-on-surface-variant hover:text-on-surface"}`}
              onClick={() => setAuthMode("register")}
            >
              Register
            </button>
            <button
              type="button"
              className={`flex-1 py-2 text-label-md rounded-lg transition-colors ${authMode === "login" ? "bg-primary text-on-primary shadow-sm" : "text-on-surface-variant hover:text-on-surface"}`}
              onClick={() => setAuthMode("login")}
            >
              Login
            </button>
          </div>

          <form className="space-y-4" onSubmit={doAuth}>
            <div className="flex flex-col gap-1.5">
              <label className="text-label-sm text-on-surface-variant uppercase tracking-wider">Mobile Number</label>
              <input
                className="w-full bg-surface-container-low border border-outline-variant/60 rounded-xl px-4 py-2.5 text-body-md text-on-surface placeholder:text-on-surface-variant/50 focus:border-primary focus:ring-0 focus:outline-none transition-colors"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+91 98765 43210"
                required
              />
            </div>

            {authMode === "register" && (
              <>
                <div className="flex flex-col gap-1.5">
                  <label className="text-label-sm text-on-surface-variant uppercase tracking-wider">Username</label>
                  <input
                    className="w-full bg-surface-container-low border border-outline-variant/60 rounded-xl px-4 py-2.5 text-body-md text-on-surface placeholder:text-on-surface-variant/50 focus:border-primary focus:ring-0 focus:outline-none transition-colors"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    onBlur={checkUname}
                    placeholder="unique_username"
                    required
                  />
                  {unameOk !== null && (
                    <span className={`text-[11px] font-semibold ${unameOk ? "text-primary" : "text-error"}`}>
                      {unameOk ? "✓ Username is available" : "✗ Username already taken"}
                    </span>
                  )}
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-label-sm text-on-surface-variant uppercase tracking-wider">Display Name</label>
                  <input
                    className="w-full bg-surface-container-low border border-outline-variant/60 rounded-xl px-4 py-2.5 text-body-md text-on-surface placeholder:text-on-surface-variant/50 focus:border-primary focus:ring-0 focus:outline-none transition-colors"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder="Your Name"
                    required
                  />
                </div>
              </>
            )}

            <div className="flex flex-col gap-1.5">
              <label className="text-label-sm text-on-surface-variant uppercase tracking-wider">Password</label>
              <input
                type="password"
                className="w-full bg-surface-container-low border border-outline-variant/60 rounded-xl px-4 py-2.5 text-body-md text-on-surface placeholder:text-on-surface-variant/50 focus:border-primary focus:ring-0 focus:outline-none transition-colors"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                required
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-label-sm text-on-surface-variant uppercase tracking-wider">OTP Code</label>
              <div className="flex gap-2">
                <input
                  className="flex-1 bg-surface-container-low border border-outline-variant/60 rounded-xl px-4 py-2.5 text-body-md text-on-surface placeholder:text-on-surface-variant/50 focus:border-primary focus:ring-0 focus:outline-none transition-colors"
                  value={otpCode}
                  onChange={(e) => setOtpCode(e.target.value)}
                  placeholder="000000"
                  maxLength={6}
                />
                <button
                  type="button"
                  className="px-4 bg-surface hover:bg-surface-container border border-outline-variant text-primary text-label-md rounded-xl active:scale-95 transition-all disabled:opacity-50"
                  disabled={otpRetry > 0}
                  onClick={() => void doRequestOtp()}
                >
                  {otpRetry > 0 ? `Wait ${otpRetry}s` : "Request"}
                </button>
                <button
                  type="button"
                  className="px-4 bg-surface hover:bg-surface-container border border-outline-variant text-on-surface-variant text-label-md rounded-xl active:scale-95 transition-all"
                  onClick={() => void doVerifyOtp()}
                >
                  Verify
                </button>
              </div>
              <div className="text-[12px] font-semibold mt-1">
                {otpProof ? (
                  <span className="text-primary">✓ Phone verified successfully</span>
                ) : otpStatus ? (
                  <span className="text-on-surface-variant">{otpStatus}</span>
                ) : (
                  <span className="text-on-surface-variant/40">Verify OTP to enable submission</span>
                )}
              </div>
            </div>

            {authErr && (
              <div className="bg-error-container/30 border border-error/20 rounded-xl p-3 text-label-md text-error">
                {authErr}
              </div>
            )}

            <button
              type="submit"
              className="w-full bg-primary hover:bg-primary-container text-on-primary font-semibold py-3 rounded-xl shadow-lg transition-all hover:shadow-xl active:scale-[0.98] mt-2 disabled:opacity-50 disabled:cursor-not-allowed"
              disabled={!otpProof}
            >
              {authMode === "register" ? "Create Account" : "Sign In"}
            </button>
          </form>
        </div>
      </div>
    );
  }

  /* ─── MAIN APP SCREEN ─── */
  return (
    <div className="flex h-screen w-full overflow-hidden bg-background font-body-md text-on-surface select-none">
      
      {/* ─── SIDEBAR RAIL ─── */}
      <aside className="fixed left-0 top-0 h-full w-[80px] flex flex-col items-center py-6 border-r border-outline-variant bg-surface-container-lowest z-20 shrink-0">
        <div className="mb-8">
          <span className="material-symbols-outlined text-primary text-4xl" style={{ fontVariationSettings: "'FILL' 1" }}>
            chat
          </span>
        </div>
        
        <nav className="flex flex-col gap-5 items-center flex-1">
          <button
            onClick={() => { setActiveNav("chats"); setSelectedStatus(null); setSelectedChannel(null); setSelectedCommunity(null); }}
            className={`p-3 rounded-xl transition-all scale-95 active:scale-90 flex items-center justify-center ${activeNav === "chats" ? "bg-primary text-on-primary shadow-md" : "text-on-surface-variant hover:bg-surface-container"}`}
            title="Chats"
          >
            <span className="material-symbols-outlined" style={activeNav === "chats" ? { fontVariationSettings: "'FILL' 1" } : undefined}>chat</span>
          </button>
          
          <button
            onClick={() => { setActiveNav("status"); setSelectedUser(null); setSelectedChannel(null); setSelectedCommunity(null); }}
            className={`p-3 rounded-xl transition-all scale-95 active:scale-90 flex items-center justify-center ${activeNav === "status" ? "bg-primary text-on-primary shadow-md" : "text-on-surface-variant hover:bg-surface-container"}`}
            title="Status Updates"
          >
            <span className="material-symbols-outlined" style={activeNav === "status" ? { fontVariationSettings: "'FILL' 1" } : undefined}>circle_notifications</span>
          </button>
          
          <button
            onClick={() => { setActiveNav("calls"); setSelectedUser(null); setSelectedStatus(null); setSelectedChannel(null); setSelectedCommunity(null); }}
            className={`p-3 rounded-xl transition-all scale-95 active:scale-90 flex items-center justify-center ${activeNav === "calls" ? "bg-primary text-on-primary shadow-md" : "text-on-surface-variant hover:bg-surface-container"}`}
            title="Call Logs"
          >
            <span className="material-symbols-outlined" style={activeNav === "calls" ? { fontVariationSettings: "'FILL' 1" } : undefined}>call</span>
          </button>
          
          <button
            onClick={() => { setActiveNav("channels"); setSelectedUser(null); setSelectedStatus(null); setSelectedCommunity(null); }}
            className={`p-3 rounded-xl transition-all scale-95 active:scale-90 flex items-center justify-center ${activeNav === "channels" ? "bg-primary text-on-primary shadow-md" : "text-on-surface-variant hover:bg-surface-container"}`}
            title="Channels"
          >
            <span className="material-symbols-outlined" style={activeNav === "channels" ? { fontVariationSettings: "'FILL' 1" } : undefined}>groups</span>
          </button>
          
          <button
            onClick={() => { setActiveNav("communities"); setSelectedUser(null); setSelectedStatus(null); setSelectedChannel(null); }}
            className={`p-3 rounded-xl transition-all scale-95 active:scale-90 flex items-center justify-center ${activeNav === "communities" ? "bg-primary text-on-primary shadow-md" : "text-on-surface-variant hover:bg-surface-container"}`}
            title="Communities"
          >
            <span className="material-symbols-outlined" style={activeNav === "communities" ? { fontVariationSettings: "'FILL' 1" } : undefined}>hub</span>
          </button>
        </nav>
        
        <div className="mt-auto flex flex-col gap-4 items-center">
          <button
            onClick={() => { setActiveNav("settings"); setSelectedUser(null); setSelectedStatus(null); setSelectedChannel(null); setSelectedCommunity(null); }}
            className={`p-3 rounded-xl transition-all scale-95 active:scale-90 flex items-center justify-center ${activeNav === "settings" ? "bg-primary text-on-primary shadow-md" : "text-on-surface-variant hover:bg-surface-container"}`}
            title="Settings"
          >
            <span className="material-symbols-outlined" style={activeNav === "settings" ? { fontVariationSettings: "'FILL' 1" } : undefined}>settings</span>
          </button>
          
          <div
            onClick={() => { setActiveNav("settings"); setSelectedSettingsPage("profile"); setSelectedUser(null); setSelectedStatus(null); setSelectedChannel(null); setSelectedCommunity(null); }}
            className="w-10 h-10 rounded-full overflow-hidden border border-outline-variant cursor-pointer hover:border-primary transition-all duration-150 relative shrink-0"
            title="Profile"
          >
            {session.user.avatarUrl ? (
              <img className="w-full h-full object-cover" src={session.user.avatarUrl} alt="User Avatar" />
            ) : (
              <div
                className="w-full h-full text-[13px] font-bold text-white flex items-center justify-center"
                style={{ backgroundColor: avColor(session.user.displayName) }}
              >
                {initials(session.user.displayName)}
              </div>
            )}
          </div>
        </div>
      </aside>

      {/* ─── SUB-SIDEBAR (MIDDLE COLUMN) ─── */}
      <div className="ml-[80px] w-[350px] flex flex-col bg-surface border-r border-outline-variant h-full z-10 shrink-0">
        
        {/* Chats Navigation Pane */}
        {activeNav === "chats" && (
          <>
            <header className="h-16 flex items-center justify-between px-6 border-b border-outline-variant bg-surface-container-low/40">
              <h1 className="font-headline-lg text-[22px] font-bold text-on-surface">Chats</h1>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setShowSyncModal(true)}
                  className="p-1.5 hover:bg-surface-container rounded-full text-on-surface-variant/80 hover:text-on-surface transition-colors"
                  title="Add Contacts"
                >
                  <span className="material-symbols-outlined text-[20px]">add_circle</span>
                </button>
                <button
                  onClick={syncFromDevice}
                  className="p-1.5 hover:bg-surface-container rounded-full text-on-surface-variant/80 hover:text-on-surface transition-colors"
                  title="Sync Contacts"
                >
                  <span className="material-symbols-outlined text-[20px]">sync</span>
                </button>
              </div>
            </header>
            
            {/* Search Input */}
            <div className="px-4 py-3">
              <div className="relative flex items-center bg-surface-container-low rounded-xl px-3 py-2 border border-transparent focus-within:border-primary/50 focus-within:bg-surface-container-lowest transition-all gap-2 shadow-sm">
                <span className="material-symbols-outlined text-on-surface-variant text-[18px]">search</span>
                <input
                  className="bg-transparent border-none focus:ring-0 p-0 text-body-md w-full placeholder:text-on-surface-variant/50 focus:outline-none"
                  value={query}
                  onChange={(e) => void doSearch(e.target.value)}
                  placeholder="Search users to start chat..."
                  type="text"
                />
              </div>
            </div>

            {/* Filter Pills */}
            <div className="flex gap-2 px-4 pb-2 border-b border-outline-variant/30 overflow-x-auto no-scrollbar">
              <button
                className={`px-4 py-1.5 rounded-full text-[13px] font-semibold transition-all ${filterPill === "all" ? "bg-primary-container/10 text-primary border border-primary/20" : "bg-surface-container-low text-on-surface-variant border border-transparent hover:bg-surface-container"}`}
                onClick={() => setFilterPill("all")}
              >
                All
              </button>
              <button
                className={`px-4 py-1.5 rounded-full text-[13px] font-semibold transition-all ${filterPill === "unread" ? "bg-primary-container/10 text-primary border border-primary/20" : "bg-surface-container-low text-on-surface-variant border border-transparent hover:bg-surface-container"}`}
                onClick={() => setFilterPill("unread")}
              >
                Unread
                {Object.values(unread).reduce((a, b) => a + b, 0) > 0 && (
                  <span className="ml-1 bg-primary text-on-primary text-[10px] px-1.5 py-0.5 rounded-full">
                    {Object.values(unread).reduce((a, b) => a + b, 0)}
                  </span>
                )}
              </button>
            </div>

            {/* Contacts list */}
            <div className="flex-1 overflow-y-auto chat-scroll py-1 bg-surface-container-low/10">
              {filteredContacts.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 px-6 text-center">
                  <span className="material-symbols-outlined text-on-surface-variant/30 text-5xl mb-3">chat_bubble</span>
                  <p className="text-on-surface-variant text-body-md">No chats found</p>
                  <span className="text-[12px] text-on-surface-variant/60 mt-1">Search for a unique username or phone number above to start a chat.</span>
                </div>
              ) : (
                filteredContacts.map((u) => {
                  const lm = lastMsg(u.userId);
                  const isSelected = selectedUser?.userId === u.userId;
                  const uUnread = unread[u.userId] ?? 0;
                  const isOnline = online.has(u.userId);
                  const resolvedName = getResolvedName(u);

                  return (
                    <div
                      key={u.userId}
                      onClick={() => selectUser(u)}
                      className={`flex items-center px-4 py-3 cursor-pointer transition-all border-b border-outline-variant/10 ${isSelected ? "bg-surface-container" : "hover:bg-surface-container-low/60"}`}
                    >
                      <div className="relative shrink-0">
                        <div
                          className="w-12 h-12 rounded-full overflow-hidden border border-outline-variant flex items-center justify-center font-bold text-white text-md"
                          style={{ backgroundColor: u.avatarUrl ? undefined : avColor(resolvedName) }}
                        >
                          {u.avatarUrl ? (
                            <img className="w-full h-full object-cover" src={u.avatarUrl} alt={resolvedName} />
                          ) : (
                            initials(resolvedName)
                          )}
                        </div>
                        {isOnline && (
                          <span className="absolute bottom-0 right-0 w-3 h-3 bg-primary border-2 border-surface rounded-full"></span>
                        )}
                      </div>
                      
                      <div className="ml-3 flex-1 min-w-0">
                        <div className="flex justify-between items-baseline">
                          <h3 className="font-semibold text-on-surface truncate text-body-md">{resolvedName}</h3>
                          {lm && <span className="text-[11px] text-on-surface-variant/75">{fmtTime(lm.ts)}</span>}
                        </div>
                        <div className="flex justify-between items-center mt-0.5">
                          <p className="text-[13px] text-on-surface-variant truncate pr-2 flex-1">
                            {lm ? (lm.kind === "file-meta" ? `📎 ${lm.content}` : lm.content) : `@${u.username}`}
                          </p>
                          {uUnread > 0 && (
                            <span className="bg-primary text-on-primary font-semibold text-[10px] h-5 min-w-5 px-1.5 flex items-center justify-center rounded-full shrink-0 shadow-sm animate-pulse">
                              {uUnread}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </>
        )}

        {/* Status Navigation Pane */}
        {activeNav === "status" && (
          <>
            <header className="h-16 flex items-center justify-between px-6 border-b border-outline-variant bg-surface-container-low/40">
              <h1 className="font-headline-lg text-[22px] font-bold text-on-surface">Status</h1>
              <button
                onClick={() => setShowAddStatusModal(true)}
                className="p-1.5 hover:bg-surface-container rounded-full text-on-surface-variant/80 hover:text-on-surface transition-colors"
                title="Post status"
              >
                <span className="material-symbols-outlined text-[20px]">add_circle</span>
              </button>
            </header>

            <div className="flex-1 overflow-y-auto chat-scroll">
              {/* My Status */}
              <div
                onClick={() => setShowAddStatusModal(true)}
                className="p-4 flex items-center gap-3 hover:bg-surface-container-low cursor-pointer transition-colors border-b border-outline-variant/30"
              >
                <div className="relative w-12 h-12">
                  <div
                    className="w-full h-full rounded-full overflow-hidden border border-outline-variant flex items-center justify-center font-bold text-white text-md shrink-0"
                    style={{ backgroundColor: session.user.avatarUrl ? undefined : avColor(session.user.displayName) }}
                  >
                    {session.user.avatarUrl ? (
                      <img className="w-full h-full object-cover" src={session.user.avatarUrl} alt="My avatar" />
                    ) : (
                      initials(session.user.displayName)
                    )}
                  </div>
                  <div className="absolute -bottom-1 -right-1 bg-primary text-on-primary rounded-full w-5 h-5 flex items-center justify-center border-2 border-surface shadow-sm">
                    <span className="material-symbols-outlined text-[14px]">add</span>
                  </div>
                </div>
                <div className="flex flex-col">
                  <span className="font-semibold text-body-md text-on-surface">My Status</span>
                  <span className="text-[12px] text-on-surface-variant">Share a text update</span>
                </div>
              </div>

              {/* Status Lists */}
              <div className="py-2">
                {/* Recent updates */}
                {statuses.filter((s) => !s.viewed && s.userId !== session.user.userId).length > 0 && (
                  <>
                    <div className="px-4 py-2">
                      <h2 className="text-[11px] text-primary font-bold uppercase tracking-wider">Recent Updates</h2>
                    </div>
                    <div className="flex flex-col">
                      {statuses
                        .filter((s) => !s.viewed && s.userId !== session.user.userId)
                        .map((s) => (
                          <div
                            key={s.id}
                            onClick={() => { setSelectedStatus(s); setActiveStatusIndex(0); }}
                            className="px-4 py-3 flex items-center gap-3 hover:bg-surface-container-low cursor-pointer transition-colors border-b border-outline-variant/10"
                          >
                            <div className="status-ring-new w-12 h-12 shrink-0">
                              <div className="inner-avatar w-full h-full overflow-hidden border-2 border-white flex items-center justify-center font-bold text-white text-sm" style={{ backgroundColor: s.avatarUrl ? undefined : avColor(s.displayName) }}>
                                {s.avatarUrl ? <img className="w-full h-full object-cover rounded-full" src={s.avatarUrl} alt={s.displayName} /> : initials(s.displayName)}
                              </div>
                            </div>
                            <div className="flex flex-col flex-1 pb-1">
                              <div className="flex justify-between items-center">
                                <span className="font-semibold text-body-md text-on-surface">{s.displayName}</span>
                                <span className="text-[11px] text-on-surface-variant">{s.time}</span>
                              </div>
                              <span className="text-[12px] text-on-surface-variant truncate">{s.updates[s.updates.length - 1].content}</span>
                            </div>
                          </div>
                        ))}
                    </div>
                  </>
                )}

                {/* Viewed updates */}
                {statuses.filter((s) => s.viewed && s.userId !== session.user.userId).length > 0 && (
                  <>
                    <div className="px-4 py-2 mt-4">
                      <h2 className="text-[11px] text-on-surface-variant font-bold uppercase tracking-wider">Viewed Updates</h2>
                    </div>
                    <div className="flex flex-col">
                      {statuses
                        .filter((s) => s.viewed && s.userId !== session.user.userId)
                        .map((s) => (
                          <div
                            key={s.id}
                            onClick={() => { setSelectedStatus(s); setActiveStatusIndex(0); }}
                            className="px-4 py-3 flex items-center gap-3 hover:bg-surface-container-low cursor-pointer transition-colors border-b border-outline-variant/10 opacity-70"
                          >
                            <div className="status-ring-viewed w-12 h-12 shrink-0">
                              <div className="inner-avatar w-full h-full overflow-hidden border-2 border-white flex items-center justify-center font-bold text-white text-sm" style={{ backgroundColor: s.avatarUrl ? undefined : avColor(s.displayName) }}>
                                {s.avatarUrl ? <img className="w-full h-full object-cover rounded-full" src={s.avatarUrl} alt={s.displayName} /> : initials(s.displayName)}
                              </div>
                            </div>
                            <div className="flex flex-col flex-1 pb-1">
                              <div className="flex justify-between items-center">
                                <span className="font-semibold text-body-md text-on-surface">{s.displayName}</span>
                                <span className="text-[11px] text-on-surface-variant">{s.time}</span>
                              </div>
                              <span className="text-[12px] text-on-surface-variant truncate">{s.updates[s.updates.length - 1].content}</span>
                            </div>
                          </div>
                        ))}
                    </div>
                  </>
                )}
              </div>
            </div>
          </>
        )}

        {/* Calls Log Pane */}
        {activeNav === "calls" && (
          <>
            <header className="h-16 flex items-center justify-between px-6 border-b border-outline-variant bg-surface-container-low/40">
              <h1 className="font-headline-lg text-[22px] font-bold text-on-surface">Calls</h1>
              {callHistory.length > 0 && (
                <button
                  onClick={() => { if (confirm("Clear call history?")) setCallHistory([]); }}
                  className="p-1.5 hover:bg-surface-container rounded-full text-error/80 hover:text-error transition-colors"
                  title="Clear calls log"
                >
                  <span className="material-symbols-outlined text-[20px]">delete_sweep</span>
                </button>
              )}
            </header>

            <div className="flex-1 overflow-y-auto chat-scroll py-1 bg-surface-container-low/10">
              {callHistory.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
                  <span className="material-symbols-outlined text-on-surface-variant/30 text-5xl mb-3">call</span>
                  <p className="text-on-surface-variant text-body-md">No calls log found</p>
                  <span className="text-[12px] text-on-surface-variant/60 mt-1">Select a contact and click call to start voice or video.</span>
                </div>
              ) : (
                callHistory.map((log) => {
                  const matchedUser = contacts.find((c) => c.userId === log.userId);
                  const isOnline = online.has(log.userId);
                  const resolvedName = matchedUser ? getResolvedName(matchedUser) : log.userName;
                  const avatarUser = matchedUser || { displayName: log.userName, avatarUrl: "" };

                  return (
                    <div
                      key={log.id}
                      className="flex items-center px-4 py-3 border-b border-outline-variant/10 hover:bg-surface-container-low/60 transition-colors"
                    >
                      <div className="shrink-0 relative">
                        <div
                          className="w-12 h-12 rounded-full overflow-hidden border border-outline-variant flex items-center justify-center font-bold text-white text-md shrink-0"
                          style={{ backgroundColor: avatarUser.avatarUrl ? undefined : avColor(resolvedName) }}
                        >
                          {avatarUser.avatarUrl ? (
                            <img className="w-full h-full object-cover" src={avatarUser.avatarUrl} alt={resolvedName} />
                          ) : (
                            initials(resolvedName)
                          )}
                        </div>
                        {isOnline && (
                          <span className="absolute bottom-0 right-0 w-3 h-3 bg-primary border-2 border-surface rounded-full"></span>
                        )}
                      </div>
                      
                      <div className="ml-3 flex-1 min-w-0">
                        <div className="flex justify-between items-baseline">
                          <span className="font-semibold text-body-md text-on-surface truncate">{resolvedName}</span>
                          <span className="text-[11px] text-on-surface-variant/75">{fmtTime(log.ts)}</span>
                        </div>
                        <div className="flex items-center gap-1.5 mt-0.5">
                          {log.direction === "outgoing" && (
                            <span className="material-symbols-outlined text-[15px] text-primary">call_made</span>
                          )}
                          {log.direction === "incoming" && (
                            <span className="material-symbols-outlined text-[15px] text-primary-container">call_received</span>
                          )}
                          {log.direction === "missed" && (
                            <span className="material-symbols-outlined text-[15px] text-error">call_missed</span>
                          )}
                          <span className="text-[12px] text-on-surface-variant">
                            {log.direction} • {log.type === "video" ? "Video" : "Voice"}
                          </span>
                        </div>
                      </div>

                      <div className="flex gap-1.5 ml-2">
                        <button
                          onClick={() => {
                            if (matchedUser) { setSelectedUser(matchedUser); doCall(false, matchedUser); }
                            else { doCall(false, { userId: log.userId, username: log.userName.toLowerCase(), displayName: log.userName }); }
                          }}
                          className="p-2 hover:bg-surface-container rounded-full text-on-surface-variant hover:text-primary transition-colors flex items-center justify-center"
                          title="Voice Call"
                        >
                          <span className="material-symbols-outlined text-[20px]">call</span>
                        </button>
                        <button
                          onClick={() => {
                            if (matchedUser) { setSelectedUser(matchedUser); doCall(true, matchedUser); }
                            else { doCall(true, { userId: log.userId, username: log.userName.toLowerCase(), displayName: log.userName }); }
                          }}
                          className="p-2 hover:bg-surface-container rounded-full text-on-surface-variant hover:text-primary transition-colors flex items-center justify-center"
                          title="Video Call"
                        >
                          <span className="material-symbols-outlined text-[20px]">videocam</span>
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </>
        )}

        {/* Channels Pane */}
        {activeNav === "channels" && (
          <>
            <header className="h-16 flex items-center justify-between px-6 border-b border-outline-variant bg-surface-container-low/40">
              <h1 className="font-headline-lg text-[22px] font-bold text-on-surface">Channels</h1>
            </header>
            
            <div className="flex-1 overflow-y-auto chat-scroll py-1 bg-surface-container-low/10">
              <div className="px-4 py-2">
                <span className="text-[12px] text-on-surface-variant/70">Follow channels to stay updated on topics you care about.</span>
              </div>
              
              <div className="flex flex-col mt-2">
                {channelsList.map((ch) => (
                  <div
                    key={ch.id}
                    onClick={() => setSelectedChannel(ch)}
                    className={`flex items-center px-4 py-3.5 cursor-pointer border-b border-outline-variant/10 transition-colors ${selectedChannel?.id === ch.id ? "bg-surface-container" : "hover:bg-surface-container-low/60"}`}
                  >
                    <div className="w-11 h-11 bg-primary-container/10 border border-primary/20 rounded-xl flex items-center justify-center text-primary shrink-0">
                      <span className="material-symbols-outlined text-2xl">{ch.avatar}</span>
                    </div>
                    <div className="ml-3 flex-1 min-w-0">
                      <h3 className="font-semibold text-on-surface text-body-md truncate">{ch.name}</h3>
                      <p className="text-[12px] text-on-surface-variant truncate mt-0.5">{ch.description}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

        {/* Communities Pane */}
        {activeNav === "communities" && (
          <>
            <header className="h-16 flex items-center justify-between px-6 border-b border-outline-variant bg-surface-container-low/40">
              <h1 className="font-headline-lg text-[22px] font-bold text-on-surface">Communities</h1>
            </header>

            <div className="flex-1 overflow-y-auto chat-scroll py-1 bg-surface-container-low/10">
              <div className="px-4 py-2">
                <span className="text-[12px] text-on-surface-variant/70">Connect related groups and structure your chat networks.</span>
              </div>

              <div className="flex flex-col mt-2">
                {communitiesList.map((comm) => (
                  <div
                    key={comm.id}
                    onClick={() => setSelectedCommunity(comm)}
                    className={`flex items-center px-4 py-3.5 cursor-pointer border-b border-outline-variant/10 transition-colors ${selectedCommunity?.id === comm.id ? "bg-surface-container" : "hover:bg-surface-container-low/60"}`}
                  >
                    <div className="w-11 h-11 bg-secondary-container/10 border border-secondary/20 rounded-xl flex items-center justify-center text-secondary shrink-0">
                      <span className="material-symbols-outlined text-2xl">hub</span>
                    </div>
                    <div className="ml-3 flex-1 min-w-0">
                      <h3 className="font-semibold text-on-surface text-body-md truncate">{comm.name}</h3>
                      <p className="text-[12px] text-on-surface-variant truncate mt-0.5">{comm.description}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

        {/* Settings Pane */}
        {activeNav === "settings" && (
          <>
            <header className="h-16 flex items-center justify-between px-6 border-b border-outline-variant bg-surface-container-low/40">
              <h1 className="font-headline-lg text-[22px] font-bold text-on-surface">Settings</h1>
            </header>

            <div className="flex-1 overflow-y-auto chat-scroll py-2 bg-surface-container-low/10">
              <nav className="flex flex-col gap-1 px-2">
                <button
                  onClick={() => setSelectedSettingsPage("profile")}
                  className={`flex items-center px-4 py-3 gap-3.5 rounded-xl text-left transition-all ${selectedSettingsPage === "profile" ? "bg-primary-container/10 border-l-4 border-primary text-primary" : "text-on-surface-variant hover:bg-surface-container"}`}
                >
                  <span className="material-symbols-outlined">person</span>
                  <div>
                    <p className="font-semibold text-body-md text-on-surface">Profile</p>
                    <p className="text-[11px] text-on-surface-variant/80">Name, avatar, about status</p>
                  </div>
                </button>

                <button
                  onClick={() => setSelectedSettingsPage("privacy")}
                  className={`flex items-center px-4 py-3 gap-3.5 rounded-xl text-left transition-all ${selectedSettingsPage === "privacy" ? "bg-primary-container/10 border-l-4 border-primary text-primary" : "text-on-surface-variant hover:bg-surface-container"}`}
                >
                  <span className="material-symbols-outlined">lock</span>
                  <div>
                    <p className="font-semibold text-body-md text-on-surface">Privacy</p>
                    <p className="text-[11px] text-on-surface-variant/80">Read receipts, contacts</p>
                  </div>
                </button>

                <button
                  onClick={() => setSelectedSettingsPage("chats")}
                  className={`flex items-center px-4 py-3 gap-3.5 rounded-xl text-left transition-all ${selectedSettingsPage === "chats" ? "bg-primary-container/10 border-l-4 border-primary text-primary" : "text-on-surface-variant hover:bg-surface-container"}`}
                >
                  <span className="material-symbols-outlined">palette</span>
                  <div>
                    <p className="font-semibold text-body-md text-on-surface">Appearance</p>
                    <p className="text-[11px] text-on-surface-variant/80">Color palette, dark mode</p>
                  </div>
                </button>

                <button
                  onClick={() => setSelectedSettingsPage("notifications")}
                  className={`flex items-center px-4 py-3 gap-3.5 rounded-xl text-left transition-all ${selectedSettingsPage === "notifications" ? "bg-primary-container/10 border-l-4 border-primary text-primary" : "text-on-surface-variant hover:bg-surface-container"}`}
                >
                  <span className="material-symbols-outlined">notifications</span>
                  <div>
                    <p className="font-semibold text-body-md text-on-surface">Notifications</p>
                    <p className="text-[11px] text-on-surface-variant/80">Sounds, alert banners</p>
                  </div>
                </button>

                <button
                  onClick={() => setSelectedSettingsPage("help")}
                  className={`flex items-center px-4 py-3 gap-3.5 rounded-xl text-left transition-all ${selectedSettingsPage === "help" ? "bg-primary-container/10 border-l-4 border-primary text-primary" : "text-on-surface-variant hover:bg-surface-container"}`}
                >
                  <span className="material-symbols-outlined">help</span>
                  <div>
                    <p className="font-semibold text-body-md text-on-surface">Help</p>
                    <p className="text-[11px] text-on-surface-variant/80">Support center, contact details</p>
                  </div>
                </button>

                <div className="border-t border-outline-variant/30 my-4 mx-2"></div>

                <button
                  onClick={() => {
                    localStorage.removeItem("zaply-session");
                    setSession(null);
                  }}
                  className="flex items-center px-4 py-3.5 gap-3.5 rounded-xl text-left text-error hover:bg-error-container/10 transition-all font-semibold"
                >
                  <span className="material-symbols-outlined">logout</span>
                  Logout Account
                </button>
              </nav>
            </div>
          </>
        )}
      </div>

      {/* ─── MAIN CANVAS (RIGHT COLUMN) ─── */}
      <main className="flex-1 h-full bg-surface-container-low flex flex-col relative overflow-hidden">
        
        {/* Dynamic content rendering based on activeNav */}
        {activeNav === "chats" && (
          <>
            {!selectedUser ? (
              /* Empty state chats screen */
              <div className="flex-1 flex flex-col items-center justify-center text-center p-8 select-none">
                <div className="mb-8 relative">
                  <div className="w-64 h-64 bg-surface-container rounded-full flex items-center justify-center relative overflow-hidden shadow-inner">
                    <span className="material-symbols-outlined text-outline-variant text-[120px] relative z-10" style={{ fontVariationSettings: "'FILL' 0, 'wght' 100" }}>
                      laptop_mac
                    </span>
                  </div>
                  <div className="absolute bottom-4 right-0 bg-surface-container-lowest p-3 rounded-2xl border border-outline-variant shadow-lg transform translate-x-4">
                    <span className="material-symbols-outlined text-primary text-[36px]" style={{ fontVariationSettings: "'FILL' 1" }}>
                      smartphone
                    </span>
                  </div>
                </div>
                
                <h2 className="font-headline-xl text-3xl font-bold text-on-surface mb-2">WhatsApp for Windows</h2>
                <p className="max-w-md text-on-surface-variant/80 leading-relaxed mb-6 text-body-md">
                  Send and receive messages without keeping your phone online. Use WhatsApp on up to 4 linked devices and 1 phone at the same time.
                </p>
                
                <div className="flex flex-col items-center gap-3">
                  <button
                    onClick={() => setShowSyncModal(true)}
                    className="bg-primary hover:bg-primary-container text-on-primary font-semibold py-2.5 px-10 rounded-full transition-all hover:shadow-lg active:scale-95 text-body-md"
                  >
                    Get Started
                  </button>
                  <div className="flex items-center gap-1.5 text-on-surface-variant/60 text-label-sm">
                    <span className="material-symbols-outlined text-[16px]">lock</span>
                    Your personal messages are end-to-end encrypted
                  </div>
                </div>

                <footer className="absolute bottom-6 left-0 right-0 text-center text-label-sm text-on-surface-variant/40 flex items-center justify-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-primary animate-pulse"></span>
                  Ready
                </footer>
              </div>
            ) : (
              /* Active Chat interface */
              <div className="flex-1 flex flex-col h-full bg-surface-container-low relative">
                {/* Chat Header */}
                <header className="h-16 flex items-center justify-between px-6 border-b border-outline-variant/60 bg-surface-container-lowest z-10 shrink-0 shadow-sm">
                  <div className="flex items-center min-w-0">
                    <button
                      onClick={() => setSelectedUser(null)}
                      className="p-1.5 hover:bg-surface-container rounded-full text-on-surface-variant mr-2 flex items-center justify-center"
                      title="Back to list"
                    >
                      <span className="material-symbols-outlined">arrow_back</span>
                    </button>
                    
                    <div className="relative shrink-0">
                      <div
                        className="w-10 h-10 rounded-full overflow-hidden border border-outline-variant flex items-center justify-center font-bold text-white text-sm"
                        style={{ backgroundColor: selectedUser.avatarUrl ? undefined : avColor(getResolvedName(selectedUser)) }}
                      >
                        {selectedUser.avatarUrl ? (
                          <img className="w-full h-full object-cover" src={selectedUser.avatarUrl} alt={getResolvedName(selectedUser)} />
                        ) : (
                          initials(getResolvedName(selectedUser))
                        )}
                      </div>
                      {online.has(selectedUser.userId) && (
                        <span className="absolute bottom-0 right-0 w-2.5 h-2.5 bg-primary border-2 border-surface-container-lowest rounded-full"></span>
                      )}
                    </div>

                    <div className="ml-3 min-w-0">
                      <h2 className="font-semibold text-on-surface truncate text-body-md leading-tight">{getResolvedName(selectedUser)}</h2>
                      <p className="text-[11px] text-on-surface-variant/80 truncate leading-none mt-0.5">
                        {online.has(selectedUser.userId) ? (
                          <span className="text-primary font-bold">online</span>
                        ) : getResolvedPhone(selectedUser.userId) ? (
                          `${getResolvedPhone(selectedUser.userId)} • @${selectedUser.username}`
                        ) : (
                          `@${selectedUser.username}`
                        )}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => void doCall(true)}
                      className="p-2 hover:bg-surface-container rounded-full text-on-surface-variant hover:text-primary transition-colors flex items-center justify-center"
                      title="Video Call"
                    >
                      <span className="material-symbols-outlined text-[20px]">videocam</span>
                    </button>
                    <button
                      onClick={() => void doCall(false)}
                      className="p-2 hover:bg-surface-container rounded-full text-on-surface-variant hover:text-primary transition-colors flex items-center justify-center"
                      title="Voice Call"
                    >
                      <span className="material-symbols-outlined text-[20px]">call</span>
                    </button>
                  </div>
                </header>

                {/* Messages Feed */}
                <div ref={feedRef} className="flex-1 overflow-y-auto chat-scroll px-8 py-4 space-y-4 flex flex-col bg-surface-container-low/40">
                  {grouped.length === 0 ? (
                    <div className="flex-1 flex items-center justify-center py-12">
                      <span className="bg-surface-container-lowest text-on-surface-variant/80 text-[13px] border border-outline-variant/30 px-4 py-2 rounded-2xl shadow-sm">
                        👋 Say hello to {getResolvedName(selectedUser)}!
                      </span>
                    </div>
                  ) : (
                    grouped.map((g) => (
                      <div key={g.date} className="flex flex-col space-y-3">
                        <div className="flex justify-center my-2">
                          <span className="bg-surface-container-lowest text-on-surface-variant/90 border border-outline-variant/40 px-3.5 py-1 rounded-full text-[11px] font-semibold shadow-sm">
                            {g.date}
                          </span>
                        </div>
                        
                        {g.msgs.map((m) => {
                          const isMe = m.fromUserId === session.user.userId;
                          return (
                            <div key={m.id} className={`flex w-full ${isMe ? "justify-end" : "justify-start"}`}>
                              <div className={`flex flex-col gap-1 max-w-[65%] ${isMe ? "items-end animate-in slide-in-from-right-4 duration-150" : "items-start animate-in slide-in-from-left-4 duration-150"}`}>
                                <div className={`px-4 py-2.5 shadow-sm text-body-md ${isMe ? "bg-primary text-on-primary rounded-2xl rounded-tr-none" : "bg-surface-container-lowest text-on-surface rounded-2xl rounded-tl-none border border-outline-variant/30"}`}>
                                  {m.kind === "file-meta" ? (
                                    (() => {
                                      const isImage = m.downloadUrl && m.downloadUrl.startsWith("data:image/");
                                      return (
                                        <div className="flex flex-col gap-2">
                                          {isImage ? (
                                            <img className="max-w-full max-h-60 rounded-lg shadow-sm border border-outline-variant/10 object-cover" src={m.downloadUrl} alt={m.content} />
                                          ) : (
                                            <div className="flex items-center gap-2">
                                              <span className="material-symbols-outlined text-2xl">description</span>
                                              <span className="font-semibold truncate">{m.content}</span>
                                            </div>
                                          )}
                                          {m.downloadUrl && (
                                            <a
                                              href={m.downloadUrl}
                                              download={m.content.split(" (")[0]}
                                              target="_blank"
                                              rel="noreferrer"
                                              className={`text-[12px] font-bold mt-1 inline-flex items-center gap-1 ${isMe ? "text-on-primary/90 hover:text-white" : "text-primary hover:text-primary-container"}`}
                                            >
                                              <span className="material-symbols-outlined text-[16px]">download</span>
                                              Download file
                                            </a>
                                          )}
                                        </div>
                                      );
                                    })()
                                  ) : (
                                    <span className="whitespace-pre-wrap">{m.content}</span>
                                  )}
                                  
                                  <div className={`flex items-center justify-end gap-1 mt-1.5 text-[10px] ${isMe ? "text-on-primary/70" : "text-on-surface-variant/60"}`}>
                                    <span>{fmtTime(m.ts)}</span>
                                    {isMe && (
                                      <span className="material-symbols-outlined text-[14px]">done_all</span>
                                    )}
                                  </div>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    ))
                  )}
                </div>

                {/* Input Area */}
                <div className="h-20 shrink-0 flex items-center gap-3 px-6 py-4 border-t border-outline-variant/60 bg-surface-container-lowest">
                  <label className="p-2 hover:bg-surface-container text-on-surface-variant hover:text-primary rounded-full cursor-pointer transition-colors flex items-center justify-center" title="Attach file">
                    <span className="material-symbols-outlined text-2xl">attach_file</span>
                    <input
                      type="file"
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) doFileShare(f);
                        e.target.value = "";
                      }}
                    />
                  </label>
                  
                  <div className="flex-1 bg-surface-container-low rounded-xl px-4 py-2 border border-transparent focus-within:border-primary/50 focus-within:bg-surface-container-lowest transition-all">
                    <input
                      className="w-full bg-transparent border-none text-body-md focus:outline-none placeholder:text-on-surface-variant/40"
                      value={text}
                      onChange={(e) => setText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          sendMsg();
                        }
                      }}
                      placeholder="Type a message..."
                    />
                  </div>

                  <button
                    onClick={text.trim() ? sendMsg : () => void doCall(false)}
                    className="w-12 h-12 bg-primary hover:bg-primary-container text-on-primary rounded-full shadow-lg active:scale-95 transition-all flex items-center justify-center shrink-0"
                    title={text.trim() ? "Send message" : "Voice call"}
                  >
                    <span className="material-symbols-outlined text-2xl">
                      {text.trim() ? "send" : "mic"}
                    </span>
                  </button>
                </div>
              </div>
            )}
          </>
        )}

        {/* Status view right canvas screen */}
        {activeNav === "status" && (
          <div className="flex-1 flex h-full items-center justify-center relative">
            {!selectedStatus ? (
              <div className="flex flex-col items-center justify-center p-8 text-center select-none">
                <span className="material-symbols-outlined text-outline-variant text-[100px] mb-4" style={{ fontVariationSettings: "'FILL' 0, 'wght' 100" }}>
                  circle_notifications
                </span>
                <h2 className="font-headline-lg text-[22px] font-bold text-on-surface">Status Viewer</h2>
                <p className="max-w-xs text-on-surface-variant text-body-md mt-1.5 leading-relaxed">
                  Select a contact update on the left menu to view their shared status.
                </p>
              </div>
            ) : (
              /* High quality Status Viewer */
              <div className="absolute inset-0 bg-inverse-surface z-30 flex flex-col items-center justify-center">
                {/* Horizontal indicators */}
                <div className="status-progress-container">
                  {selectedStatus.updates.map((_, i) => {
                    let w = "0%";
                    if (i < activeStatusIndex) w = "100%";
                    if (i === activeStatusIndex) w = "100%"; // Auto animated
                    return (
                      <div key={i} className="progress-bar-bg">
                        <div
                          className="progress-bar-fill"
                          style={{
                            width: w,
                            transition: i === activeStatusIndex ? "width 4.5s linear" : undefined
                          }}
                        ></div>
                      </div>
                    );
                  })}
                </div>

                {/* Header info */}
                <div className="absolute top-8 left-0 right-0 px-6 flex items-center justify-between z-40">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-full border-2 border-white overflow-hidden flex items-center justify-center font-bold text-white text-sm shrink-0 bg-primary">
                      {selectedStatus.avatarUrl ? <img className="w-full h-full object-cover" src={selectedStatus.avatarUrl} alt="" /> : initials(selectedStatus.displayName)}
                    </div>
                    <div className="text-white">
                      <p className="font-semibold text-body-md leading-tight">{selectedStatus.displayName}</p>
                      <p className="text-[11px] opacity-75 mt-0.5">{selectedStatus.time}</p>
                    </div>
                  </div>
                  <button
                    onClick={() => { setSelectedStatus(null); setActiveStatusIndex(0); }}
                    className="p-1.5 bg-black/35 hover:bg-black/50 text-white rounded-full transition-colors flex items-center justify-center"
                    title="Close"
                  >
                    <span className="material-symbols-outlined text-2xl">close</span>
                  </button>
                </div>

                {/* Left/Right click triggers */}
                <div className="absolute inset-0 flex z-20">
                  <div
                    onClick={() => {
                      if (activeStatusIndex > 0) setActiveStatusIndex(activeStatusIndex - 1);
                    }}
                    className="w-1/3 h-full cursor-pointer"
                  ></div>
                  <div
                    onClick={() => {
                      if (activeStatusIndex < selectedStatus.updates.length - 1) {
                        setActiveStatusIndex(activeStatusIndex + 1);
                      } else {
                        setSelectedStatus(null);
                        setActiveStatusIndex(0);
                      }
                    }}
                    className="w-2/3 h-full cursor-pointer"
                  ></div>
                </div>

                {/* Status central content */}
                <div className="z-10 max-w-lg px-8 text-center text-white flex flex-col justify-center items-center h-full">
                  <div className="p-8 rounded-3xl bg-primary/20 backdrop-blur-md border border-white/10 shadow-2xl">
                    <h2 className="text-headline-lg font-headline-lg font-bold leading-snug">
                      {selectedStatus.updates[activeStatusIndex].content}
                    </h2>
                  </div>
                </div>

                {/* Status Reply bar */}
                <div className="absolute bottom-8 left-0 right-0 flex justify-center px-8 z-40">
                  <div className="w-full max-w-md bg-black/40 backdrop-blur-md rounded-2xl px-4 py-3 flex items-center gap-3 border border-white/10 shadow-lg">
                    <input
                      className="flex-1 bg-transparent border-none text-white text-body-md focus:outline-none placeholder:text-white/40"
                      placeholder="Reply to status..."
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          alert("Status reply sent!");
                          setSelectedStatus(null);
                          setActiveStatusIndex(0);
                        }
                      }}
                    />
                    <button className="text-white hover:text-primary transition-colors flex items-center justify-center">
                      <span className="material-symbols-outlined text-2xl">send</span>
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Call Logs right canvas screen */}
        {activeNav === "calls" && (
          <div className="flex-1 flex h-full items-center justify-center text-center p-8 select-none">
            <div className="max-w-xs">
              <span className="material-symbols-outlined text-outline-variant text-[100px] mb-4" style={{ fontVariationSettings: "'FILL' 0, 'wght' 100" }}>
                phone_callback
              </span>
              <h2 className="font-headline-lg text-[22px] font-bold text-on-surface">Calls History</h2>
              <p className="text-on-surface-variant text-body-md mt-1.5 leading-relaxed">
                Review call notifications, incoming requests, and connect WebRTC voice/video calls directly from the left contacts lists.
              </p>
            </div>
          </div>
        )}

        {/* Channels right canvas screen */}
        {activeNav === "channels" && (
          <div className="flex-1 flex h-full bg-surface-container-low">
            {!selectedChannel ? (
              <div className="flex-1 flex flex-col items-center justify-center text-center p-8 select-none">
                <span className="material-symbols-outlined text-outline-variant text-[100px] mb-4" style={{ fontVariationSettings: "'FILL' 0, 'wght' 100" }}>
                  groups
                </span>
                <h2 className="font-headline-lg text-[22px] font-bold text-on-surface">Channel Broadcasts</h2>
                <p className="max-w-xs text-on-surface-variant text-body-md mt-1.5 leading-relaxed">
                  Join discussions and receive updates. Followed channels will show their broadcast messages here.
                </p>
              </div>
            ) : (
              /* Channel chat UI */
              <div className="flex-1 flex flex-col h-full bg-surface-container-low">
                <header className="h-16 flex items-center px-6 border-b border-outline-variant bg-surface-container-lowest shrink-0 shadow-sm">
                  <div className="w-9 h-9 bg-primary-container/10 border border-primary/20 rounded-xl flex items-center justify-center text-primary shrink-0">
                    <span className="material-symbols-outlined text-xl">{selectedChannel.avatar}</span>
                  </div>
                  <div className="ml-3">
                    <h2 className="font-semibold text-on-surface text-body-md leading-none">{selectedChannel.name}</h2>
                    <p className="text-[11px] text-on-surface-variant mt-0.5 leading-none">{selectedChannel.description}</p>
                  </div>
                </header>
                
                <div className="flex-1 overflow-y-auto chat-scroll px-8 py-6 space-y-4 bg-surface-container-low/40">
                  {selectedChannel.messages.map((m: any) => (
                    <div key={m.id} className="flex justify-start">
                      <div className="bg-surface-container-lowest text-on-surface border border-outline-variant/30 px-4 py-3 rounded-2xl rounded-tl-none shadow-sm max-w-xl">
                        <p className="text-body-md whitespace-pre-wrap">{m.content}</p>
                        <div className="text-[10px] text-on-surface-variant/50 mt-1 text-right">
                          {new Date(m.ts).toLocaleDateString()}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
                
                <div className="p-4 bg-surface-container-lowest border-t border-outline-variant/60 flex justify-center shrink-0">
                  <span className="text-label-sm text-on-surface-variant/60 italic">This is a read-only broadcast channel</span>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Communities right canvas screen */}
        {activeNav === "communities" && (
          <div className="flex-1 flex h-full bg-surface-container-low">
            {!selectedCommunity ? (
              <div className="flex-1 flex flex-col items-center justify-center text-center p-8 select-none">
                <span className="material-symbols-outlined text-outline-variant text-[100px] mb-4" style={{ fontVariationSettings: "'FILL' 0, 'wght' 100" }}>
                  hub
                </span>
                <h2 className="font-headline-lg text-[22px] font-bold text-on-surface">Community Hub</h2>
                <p className="max-w-xs text-on-surface-variant text-body-md mt-1.5 leading-relaxed">
                  Organize sub-discussion categories, directories, and link related WhatsApp groups under one parent community.
                </p>
              </div>
            ) : (
              /* Community detail display */
              <div className="flex-1 flex flex-col h-full bg-surface-container-low">
                <header className="h-16 flex items-center px-6 border-b border-outline-variant bg-surface-container-lowest shrink-0 shadow-sm">
                  <div className="w-9 h-9 bg-secondary-container/10 border border-secondary/20 rounded-xl flex items-center justify-center text-secondary shrink-0">
                    <span className="material-symbols-outlined text-xl">hub</span>
                  </div>
                  <div className="ml-3">
                    <h2 className="font-semibold text-on-surface text-body-md leading-none">{selectedCommunity.name}</h2>
                    <p className="text-[11px] text-on-surface-variant mt-0.5 leading-none">{selectedCommunity.description}</p>
                  </div>
                </header>

                <div className="flex-1 overflow-y-auto chat-scroll p-8">
                  <div className="max-w-xl mx-auto space-y-6">
                    <h3 className="text-label-sm text-primary font-bold uppercase tracking-wider">Subgroups in this community</h3>
                    <div className="grid gap-3">
                      {selectedCommunity.groups.map((groupName: string) => (
                        <div
                          key={groupName}
                          onClick={() => alert(`Opening group: ${groupName}`)}
                          className="flex items-center justify-between p-4 bg-surface-container-lowest hover:bg-surface-container border border-outline-variant/30 rounded-2xl cursor-pointer transition-colors shadow-sm"
                        >
                          <div className="flex items-center gap-3">
                            <span className="material-symbols-outlined text-on-surface-variant">forum</span>
                            <span className="font-semibold text-body-md text-on-surface">{groupName}</span>
                          </div>
                          <span className="material-symbols-outlined text-on-surface-variant text-sm">arrow_forward_ios</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Settings detailed screens */}
        {activeNav === "settings" && (
          <div className="flex-1 h-full bg-surface-container-low overflow-y-auto chat-scroll p-8">
            {selectedSettingsPage === "profile" && (
              <div className="max-w-2xl mx-auto space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-250">
                <div className="flex flex-col items-center gap-5 w-full">
                  <label className="relative group cursor-pointer">
                    <div className="w-36 h-36 rounded-full overflow-hidden border-4 border-white shadow-xl flex items-center justify-center text-white text-3xl font-bold bg-primary">
                      {session.user.avatarUrl ? (
                        <img className="w-full h-full object-cover" src={session.user.avatarUrl} alt="Change Avatar" />
                      ) : (
                        initials(session.user.displayName)
                      )}
                    </div>
                    <div className="absolute inset-0 bg-primary/45 rounded-full flex flex-col items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                      <span className="material-symbols-outlined text-white text-3xl">photo_camera</span>
                      <span className="text-white text-[10px] font-bold uppercase mt-1">Change photo</span>
                    </div>
                    <input
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) void uploadAvatar(f);
                        e.target.value = "";
                      }}
                    />
                  </label>
                  <p className="text-on-surface-variant text-body-md text-center max-w-xs">
                    This avatar photo is visible to your linked WhatsApp contacts.
                  </p>
                </div>

                <div className="space-y-4">
                  <div className="bg-surface-container-lowest p-6 rounded-2xl border border-outline-variant/55 shadow-sm">
                    <div className="flex justify-between items-center mb-1">
                      <span className="text-primary font-bold text-[12px] uppercase tracking-wider">Your Display Name</span>
                      <button
                        onClick={() => {
                          if (editingName) void saveDisplayName();
                          else { setEditName(session.user.displayName); setEditingName(true); }
                        }}
                        className="p-1 hover:bg-primary-container/10 rounded-lg transition-colors text-primary flex items-center justify-center"
                        title={editingName ? "Save name" : "Edit name"}
                      >
                        <span className="material-symbols-outlined text-lg">{editingName ? "save" : "edit"}</span>
                      </button>
                    </div>
                    {editingName ? (
                      <div className="flex gap-2">
                        <input
                          className="flex-1 bg-surface-container-low border border-outline-variant/60 rounded-xl px-4 py-2.5 text-body-md text-on-surface focus:border-primary focus:outline-none"
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          autoFocus
                          onKeyDown={(e) => e.key === "Enter" && void saveDisplayName()}
                        />
                        <button
                          onClick={() => setEditingName(false)}
                          className="px-3 border border-outline-variant rounded-xl text-on-surface-variant hover:bg-surface-container transition-colors"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <p className="font-semibold text-body-lg text-on-surface">{session.user.displayName}</p>
                    )}
                    <p className="mt-3 text-[11px] text-on-surface-variant leading-relaxed">
                      This is not your pin or password. This name is visible to your WhatsApp contacts.
                    </p>
                  </div>

                  <div className="bg-surface-container-lowest p-6 rounded-2xl border border-outline-variant/55 shadow-sm">
                    <div className="flex justify-between items-center mb-1">
                      <span className="text-primary font-bold text-[12px] uppercase tracking-wider">About Status</span>
                      <button
                        onClick={() => {
                          if (editingAbout) void saveAbout();
                          else setEditingAbout(true);
                        }}
                        className="p-1 hover:bg-primary-container/10 rounded-lg transition-colors text-primary flex items-center justify-center"
                        title={editingAbout ? "Save about" : "Edit about"}
                      >
                        <span className="material-symbols-outlined text-lg">{editingAbout ? "save" : "edit"}</span>
                      </button>
                    </div>
                    {editingAbout ? (
                      <div className="flex gap-2">
                        <input
                          className="flex-1 bg-surface-container-low border border-outline-variant/60 rounded-xl px-4 py-2.5 text-body-md text-on-surface focus:border-primary focus:outline-none"
                          value={editAbout}
                          onChange={(e) => setEditAbout(e.target.value)}
                          autoFocus
                          onKeyDown={(e) => e.key === "Enter" && void saveAbout()}
                        />
                        <button
                          onClick={() => setEditingAbout(false)}
                          className="px-3 border border-outline-variant rounded-xl text-on-surface-variant hover:bg-surface-container transition-colors"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <p className="font-semibold text-body-lg text-on-surface">{editAbout}</p>
                    )}
                  </div>

                  <div className="bg-surface-container-lowest p-6 rounded-2xl border border-outline-variant/55 shadow-sm flex items-center justify-between">
                    <div>
                      <span className="text-on-surface-variant font-bold text-[11px] uppercase tracking-wider block">Username</span>
                      <span className="font-semibold text-body-md text-on-surface mt-1 block">@{session.user.username}</span>
                    </div>
                    <span className="material-symbols-outlined text-on-surface-variant/40">alternate_email</span>
                  </div>

                  <div className="bg-surface-container-lowest p-6 rounded-2xl border border-outline-variant/55 shadow-sm flex items-center justify-between">
                    <div>
                      <span className="text-on-surface-variant font-bold text-[11px] uppercase tracking-wider block">Phone Number</span>
                      <span className="font-semibold text-body-md text-on-surface mt-1 block">{phone || "No phone linked"}</span>
                    </div>
                    <span className="material-symbols-outlined text-on-surface-variant/40">phone</span>
                  </div>
                </div>
              </div>
            )}

            {selectedSettingsPage === "privacy" && (
              <div className="max-w-2xl mx-auto space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-250">
                <div className="bg-surface-container-lowest rounded-2xl border border-outline-variant/55 shadow-sm overflow-hidden">
                  <div className="p-5 border-b border-outline-variant/20 bg-surface-container-low/20">
                    <h3 className="font-bold text-[12px] text-primary uppercase tracking-wider">Who can see my personal info</h3>
                  </div>
                  
                  <div className="divide-y divide-outline-variant/15">
                    <div className="flex items-center justify-between p-4 hover:bg-surface-container-low/40 transition-colors cursor-pointer">
                      <div>
                        <p className="font-semibold text-body-md text-on-surface">Last seen and online</p>
                        <p className="text-[11px] text-on-surface-variant">Everyone</p>
                      </div>
                      <span className="material-symbols-outlined text-on-surface-variant/50 text-sm">arrow_forward_ios</span>
                    </div>
                    
                    <div className="flex items-center justify-between p-4 hover:bg-surface-container-low/40 transition-colors cursor-pointer">
                      <div>
                        <p className="font-semibold text-body-md text-on-surface">Profile photo</p>
                        <p className="text-[11px] text-on-surface-variant">My contacts</p>
                      </div>
                      <span className="material-symbols-outlined text-on-surface-variant/50 text-sm">arrow_forward_ios</span>
                    </div>

                    <div className="flex items-center justify-between p-4 hover:bg-surface-container-low/40 transition-colors cursor-pointer">
                      <div>
                        <p className="font-semibold text-body-md text-on-surface">About</p>
                        <p className="text-[11px] text-on-surface-variant">My contacts</p>
                      </div>
                      <span className="material-symbols-outlined text-on-surface-variant/50 text-sm">arrow_forward_ios</span>
                    </div>

                    <div className="flex items-center justify-between p-4 hover:bg-surface-container-low/40 transition-colors cursor-pointer">
                      <div>
                        <p className="font-semibold text-body-md text-on-surface">Status</p>
                        <p className="text-[11px] text-on-surface-variant">My contacts</p>
                      </div>
                      <span className="material-symbols-outlined text-on-surface-variant/50 text-sm">arrow_forward_ios</span>
                    </div>
                  </div>
                </div>

                <div className="bg-surface-container-lowest rounded-2xl border border-outline-variant/55 shadow-sm p-5 flex items-center justify-between">
                  <div>
                    <p className="font-semibold text-body-md text-on-surface">Read receipts</p>
                    <p className="text-[11px] text-on-surface-variant max-w-sm mt-0.5">
                      If turned off, you won't send or receive read receipts. Read receipts are always active for group chats.
                    </p>
                  </div>
                  <label className="relative inline-flex items-center cursor-pointer select-none">
                    <input
                      checked={readReceipts}
                      onChange={(e) => setReadReceipts(e.target.checked)}
                      className="sr-only peer"
                      type="checkbox"
                    />
                    <div className="w-11 h-6 bg-surface-container rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-primary"></div>
                  </label>
                </div>

                <div className="bg-surface-container-lowest rounded-2xl border border-outline-variant/55 shadow-sm p-4 flex items-center justify-between hover:bg-surface-container cursor-pointer transition-colors">
                  <div>
                    <p className="font-semibold text-body-md text-on-surface">Blocked contacts</p>
                    <p className="text-[11px] text-on-surface-variant">0 contacts blocked</p>
                  </div>
                  <span className="material-symbols-outlined text-on-surface-variant/50 text-sm">arrow_forward_ios</span>
                </div>
              </div>
            )}

            {selectedSettingsPage === "chats" && (
              <div className="max-w-2xl mx-auto space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-250">
                <div className="bg-surface-container-lowest rounded-2xl border border-outline-variant/55 shadow-sm p-6">
                  <h3 className="font-bold text-[12px] text-primary uppercase tracking-wider mb-2">Display Theme</h3>
                  <div className="flex gap-3 mt-4">
                    {THEMES.map((t) => {
                      const isThemeActive = session.user.theme === t;
                      return (
                        <button
                          key={t}
                          className={`px-6 py-2.5 rounded-xl border text-[13px] font-semibold transition-all hover:shadow-md ${isThemeActive ? "bg-primary-container/10 border-primary text-primary shadow-sm" : "bg-transparent border-outline-variant text-on-surface-variant hover:bg-surface-container"}`}
                          onClick={async () => {
                            const u = await updateProfile(session.token, { theme: t });
                            setSession({ ...session, user: { ...session.user, ...u } });
                          }}
                        >
                          {t.charAt(0).toUpperCase() + t.slice(1)} Theme
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="bg-surface-container-lowest rounded-2xl border border-outline-variant/55 shadow-sm p-6">
                  <h3 className="font-bold text-[12px] text-primary uppercase tracking-wider mb-1">Chat Wallpaper</h3>
                  <p className="text-[11px] text-on-surface-variant">Configure standard chat background styles.</p>
                  
                  <div className="grid grid-cols-4 gap-3 mt-4">
                    <div className="aspect-square bg-background rounded-xl border border-outline-variant cursor-pointer hover:border-primary transition-all"></div>
                    <div className="aspect-square bg-surface-container-low rounded-xl border border-outline-variant cursor-pointer hover:border-primary transition-all"></div>
                    <div className="aspect-square bg-surface-container rounded-xl border border-outline-variant cursor-pointer hover:border-primary transition-all"></div>
                    <div className="aspect-square bg-primary-container/10 rounded-xl border border-outline-variant cursor-pointer hover:border-primary transition-all"></div>
                  </div>
                </div>
              </div>
            )}

            {selectedSettingsPage === "notifications" && (
              <div className="max-w-2xl mx-auto space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-250">
                <div className="bg-surface-container-lowest rounded-2xl border border-outline-variant/55 shadow-sm overflow-hidden">
                  <div className="p-5 border-b border-outline-variant/20 bg-surface-container-low/20">
                    <h3 className="font-bold text-[12px] text-primary uppercase tracking-wider">Alert Configurations</h3>
                  </div>
                  
                  <div className="p-6 space-y-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="font-semibold text-body-md text-on-surface">Conversation Tones</p>
                        <p className="text-[11px] text-on-surface-variant">Play sounds for incoming and outgoing messages.</p>
                      </div>
                      <input type="checkbox" defaultChecked className="rounded text-primary focus:ring-primary w-5 h-5" />
                    </div>

                    <div className="flex items-center justify-between pt-4 border-t border-outline-variant/10">
                      <div>
                        <p className="font-semibold text-body-md text-on-surface">Desktop Alerts</p>
                        <p className="text-[11px] text-on-surface-variant">Show message notifications in system notification drawer.</p>
                      </div>
                      <input type="checkbox" defaultChecked className="rounded text-primary focus:ring-primary w-5 h-5" />
                    </div>
                  </div>
                </div>
              </div>
            )}

            {selectedSettingsPage === "help" && (
              <div className="max-w-2xl mx-auto space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-250">
                <div className="bg-surface-container-lowest rounded-2xl border border-outline-variant/55 shadow-sm p-6 text-center space-y-4">
                  <span className="material-symbols-outlined text-primary text-5xl">help_center</span>
                  <h3 className="font-bold text-body-lg text-on-surface">Need Help with Zaply?</h3>
                  <p className="text-on-surface-variant text-body-md max-w-sm mx-auto leading-relaxed">
                    Check out documentation, find answers in help center channels, or contact support directly on local dev loops.
                  </p>
                  <button
                    onClick={() => alert("Connecting support center...")}
                    className="bg-primary hover:bg-primary-container text-on-primary font-semibold py-2 px-8 rounded-full transition-all inline-block active:scale-95"
                  >
                    Contact Support
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </main>

      {/* ─── Call Overlay (Preserves calls functions) ─── */}
      {(inCall || incomingFrom) && (
        <div className="fixed inset-0 bg-black/90 z-50 flex flex-col items-center justify-center gap-6 p-6 select-none animate-in fade-in duration-300">
          <div className="text-center text-white">
            <span className="material-symbols-outlined text-5xl text-primary animate-bounce">phone_in_talk</span>
            <p className="text-lg font-bold mt-3">
              {incomingFrom ? `Incoming call from ${contacts.find((u) => u.userId === incomingFrom)?.displayName ?? incomingFrom}` : `Calling ${selectedUser?.displayName ?? ""}`}
            </p>
            <p className="text-sm opacity-60 mt-1">WebRTC Session Active</p>
          </div>
          
          <div className="flex gap-6 max-w-3xl w-full justify-center">
            <div className="relative aspect-[3/4] w-64 bg-black border-2 border-primary rounded-2xl overflow-hidden shadow-2xl">
              <video ref={localVidRef} autoPlay playsInline muted className="w-full h-full object-cover transform -scale-x-100" />
              <span className="absolute bottom-3 left-3 bg-black/40 text-white text-xs px-2 py-1 rounded-md">You</span>
            </div>
            <div className="relative aspect-[3/4] w-[350px] bg-black border-2 border-outline-variant/20 rounded-2xl overflow-hidden shadow-2xl">
              <video ref={remoteVidRef} autoPlay playsInline className="w-full h-full object-cover" />
              <span className="absolute bottom-3 left-3 bg-black/40 text-white text-xs px-2 py-1 rounded-md">Remote</span>
            </div>
          </div>
          
          <div className="flex gap-4">
            {incomingFrom && (
              <button
                className="bg-primary hover:bg-primary-container text-on-primary font-semibold px-8 py-3 rounded-full transition-all shadow-lg active:scale-95 flex items-center gap-2"
                onClick={() => void doCall(true)}
              >
                <span className="material-symbols-outlined">call</span>
                Accept Call
              </button>
            )}
            <button
              className="bg-error hover:bg-red-700 text-on-error font-semibold px-8 py-3 rounded-full transition-all shadow-lg active:scale-95 flex items-center gap-2"
              onClick={() => endCall()}
            >
              <span className="material-symbols-outlined">call_end</span>
              End Connection
            </button>
          </div>
        </div>
      )}

      {/* ─── Sync / Manual Contacts Modal ─── */}
      {showSyncModal && (
        <div
          className="fixed inset-0 bg-black/50 z-40 flex items-center justify-center p-6 animate-in fade-in duration-200 select-none"
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowSyncModal(false);
          }}
        >
          <div className="w-full max-w-lg bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-2xl overflow-hidden">
            <header className="h-16 flex items-center justify-between px-6 border-b border-outline-variant bg-surface-container-low/40">
              <h2 className="font-bold text-body-lg text-on-surface">Address Book</h2>
              <button
                onClick={() => setShowSyncModal(false)}
                className="p-1 hover:bg-surface-container rounded-full text-on-surface-variant flex items-center justify-center"
              >
                <span className="material-symbols-outlined">close</span>
              </button>
            </header>
            
            <div className="p-6 space-y-6">
              <div className="flex flex-col gap-3">
                <h3 className="text-label-sm text-primary font-bold uppercase tracking-wider">Add New Contact</h3>
                <input
                  className="w-full bg-surface-container-low border border-outline-variant/60 rounded-xl px-4 py-2 text-body-md text-on-surface placeholder:text-on-surface-variant/40 focus:border-primary focus:outline-none"
                  placeholder="Contact Name (e.g. Dad)"
                  value={newContactName}
                  onChange={(e) => setNewContactName(e.target.value)}
                />
                <input
                  className="w-full bg-surface-container-low border border-outline-variant/60 rounded-xl px-4 py-2 text-body-md text-on-surface placeholder:text-on-surface-variant/40 focus:border-primary focus:outline-none"
                  placeholder="Phone Number (e.g. +91 98050 35450)"
                  value={newContactPhone}
                  onChange={(e) => setNewContactPhone(e.target.value)}
                />
                <button
                  className="w-full bg-primary hover:bg-primary-container text-on-primary font-semibold py-2.5 rounded-xl shadow-md transition-all active:scale-95 text-body-md"
                  onClick={() => addContact(newContactName, newContactPhone)}
                >
                  Add & Synchronize
                </button>
              </div>

              <div className="border-t border-outline-variant/30 pt-4">
                <h3 className="text-label-sm text-primary font-bold uppercase tracking-wider mb-3">
                  Saved Contacts ({Object.keys(addressBook).length})
                </h3>
                
                <div className="space-y-2.5 max-h-52 overflow-y-auto chat-scroll pr-1">
                  {Object.keys(addressBook).length === 0 ? (
                    <p className="text-on-surface-variant/60 text-body-md italic text-center py-4">No manual contacts saved yet.</p>
                  ) : (
                    Object.entries(addressBook).map(([ph, name]) => {
                      const matchedUserId = phoneToUser[ph];
                      return (
                        <div
                          key={ph}
                          className="flex justify-between items-center bg-surface-container-low/40 border border-outline-variant/30 p-3.5 rounded-xl shadow-sm"
                        >
                          <div className="flex flex-col min-w-0 pr-3">
                            <span className="font-semibold text-body-md text-on-surface truncate">{name}</span>
                            <span className="text-[12px] text-on-surface-variant mt-0.5">{ph}</span>
                            {matchedUserId ? (
                              <span className="text-[10px] text-primary font-bold mt-1 inline-flex items-center gap-0.5">
                                <span className="material-symbols-outlined text-[12px]">done</span>
                                Registered on Zaply
                              </span>
                            ) : (
                              <span className="text-[10px] text-on-surface-variant/40 mt-1">Not registered</span>
                            )}
                          </div>
                          
                          <button
                            className="p-1 hover:bg-error-container/10 text-on-surface-variant hover:text-error rounded-full transition-colors flex items-center justify-center shrink-0"
                            onClick={() => {
                              setAddressBook((prev) => {
                                const next = { ...prev };
                                delete next[ph];
                                return next;
                              });
                            }}
                            title="Delete contact"
                          >
                            <span className="material-symbols-outlined text-[18px]">delete</span>
                          </button>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ─── Add Status Modal ─── */}
      {showAddStatusModal && (
        <div
          className="fixed inset-0 bg-black/50 z-40 flex items-center justify-center p-6 animate-in fade-in duration-200 select-none"
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowAddStatusModal(false);
          }}
        >
          <div className="w-full max-w-md bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-2xl overflow-hidden">
            <header className="h-16 flex items-center justify-between px-6 border-b border-outline-variant bg-surface-container-low/40">
              <h2 className="font-bold text-body-lg text-on-surface">Post Status Update</h2>
              <button
                onClick={() => setShowAddStatusModal(false)}
                className="p-1 hover:bg-surface-container rounded-full text-on-surface-variant flex items-center justify-center"
              >
                <span className="material-symbols-outlined">close</span>
              </button>
            </header>
            
            <div className="p-6 space-y-4">
              <textarea
                className="w-full bg-surface-container-low border border-outline-variant/60 rounded-xl px-4 py-3 text-body-md text-on-surface placeholder:text-on-surface-variant/40 focus:border-primary focus:outline-none min-h-24 resize-none"
                placeholder="What's on your mind? (e.g. Off to code! 🧑‍💻)"
                value={newStatusText}
                onChange={(e) => setNewStatusText(e.target.value)}
              />
              
              <button
                onClick={handleAddStatus}
                className="w-full bg-primary hover:bg-primary-container text-on-primary font-semibold py-2.5 rounded-xl shadow-md transition-all active:scale-95 text-body-md"
              >
                Post Status
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
