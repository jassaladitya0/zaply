import { useEffect, useMemo, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import {
  checkUsernameAvailability, login, register,
  requestOtp, searchUsers, updateProfile, verifyOtp
} from "./api";
import type { ChatMessage, OtpPurpose, PublicUser, Session, SignalPayload, SignalScope, Theme } from "./types";
import "./styles.css";

/* ─── Types ─── */
type SignalReceive = {
  fromUserId: string;
  fromUsername: string;
  envelope: {
    toUserId: string;
    type: "chat" | "offer" | "answer" | "ice" | "file-meta" | "typing";
    payload: unknown;
    expiresAt?: number;
  };
};
type ScopedOffer = { scope: SignalScope; sdp: RTCSessionDescriptionInit };
type ScopedAnswer = { scope: SignalScope; sdp: RTCSessionDescriptionInit };
type ScopedIce = { scope: SignalScope; candidate: RTCIceCandidateInit };
type FileControlMessage = { kind: "meta"; name: string; size: number; mime: string } | { kind: "done" };

/* ─── Constants ─── */
const ICE_SERVERS: RTCIceServer[] = [{ urls: (import.meta.env.VITE_STUN_URL as string) || "stun:stun.l.google.com:19302" }];
const TTL_MS = 24 * 60 * 60 * 1000;
const SIGNALING_BASE_URL = (import.meta.env.VITE_SIGNALING_BASE_URL as string) ?? "http://localhost:4000";
const THEME_OPTIONS: Theme[] = ["sand", "forest", "sunset"];

/* ─── Helpers ─── */
const AVATAR_COLORS = ["#00A884","#0B6185","#5B2C6F","#922B21","#1E8449","#D35400","#1A5276","#6C3483"];

function avatarColor(name: string) {
  let h = 0; for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}

function initials(name: string) {
  return name.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase();
}

function formatTime(ts: number) {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatDate(ts: number) {
  const d = new Date(ts), now = new Date();
  if (d.toDateString() === now.toDateString()) return "Today";
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { day: "numeric", month: "long", year: "numeric" });
}

/* ─── SVG Icons ─── */
const WaLogo = () => (
  <svg viewBox="0 0 24 24" fill="#00A884"><path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.38 1.26 4.78L2.05 22l5.5-1.44c1.35.73 2.88 1.14 4.49 1.14 5.46 0 9.91-4.45 9.91-9.91S17.5 2 12.04 2zm5.52 14.17c-.23.65-1.35 1.24-1.85 1.31-.5.07-1.13.1-1.82-.12-.42-.13-.96-.3-1.65-.58-2.9-1.26-4.8-4.18-4.95-4.38-.14-.2-1.18-1.57-1.18-3s.75-2.13.99-2.42c.24-.3.54-.37.72-.37s.36.01.51.01c.16 0 .38-.06.59.45.22.51.75 1.83.81 1.96.06.14.1.3.02.48-.09.19-.13.3-.26.47l-.39.45c-.13.14-.27.29-.12.57.15.28.68 1.12 1.46 1.82 1.01.9 1.86 1.18 2.12 1.31.27.13.43.11.59-.07.16-.18.68-.8.86-1.07.18-.28.36-.23.61-.14.25.09 1.59.75 1.86.89.27.14.45.2.52.32.06.11.06.65-.17 1.28z"/></svg>
);

const IconSearch = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20">
    <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>
  </svg>
);

const IconDots = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
    <circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/>
  </svg>
);

const IconSend = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" width="22" height="22">
    <path d="M2 21L23 12 2 3v7l15 2-15 2z"/>
  </svg>
);

const IconMic = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" width="22" height="22">
    <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm-1 1.93c-3.94-.49-7-3.85-7-7.93H2c0 4.97 3.66 9.09 8.5 9.9V22h3v-4.07c4.84-.81 8.5-4.93 8.5-9.9h-2c0 4.08-3.05 7.44-7 7.93z"/>
  </svg>
);

const IconAttach = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" width="22" height="22">
    <path d="M16.5 6v11.5c0 2.21-1.79 4-4 4s-4-1.79-4-4V5c0-1.38 1.12-2.5 2.5-2.5s2.5 1.12 2.5 2.5v10.5c0 .55-.45 1-1 1s-1-.45-1-1V6H10v9.5c0 1.38 1.12 2.5 2.5 2.5S15 16.88 15 15.5V5c0-2.21-1.79-4-4-4S7 2.79 7 5v12.5c0 3.04 2.46 5.5 5.5 5.5s5.5-2.46 5.5-5.5V6h-1.5z"/>
  </svg>
);

const IconVideo = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" width="22" height="22">
    <path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/>
  </svg>
);

const IconPhone = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" width="22" height="22">
    <path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z"/>
  </svg>
);

const IconBack = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" width="22" height="22">
    <path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/>
  </svg>
);

const IconFile = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
    <path d="M6 2c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6H6zm7 7V3.5L18.5 9H13z"/>
  </svg>
);

const IconChats = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" width="22" height="22">
    <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/>
  </svg>
);

const IconCalls = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" width="22" height="22">
    <path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z"/>
  </svg>
);

const IconSettings = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" width="22" height="22">
    <path d="M19.14,12.94c0.04-0.3,0.06-0.61,0.06-0.94c0-0.32-0.02-0.64-0.07-0.94l2.03-1.58c0.18-0.14,0.23-0.41,0.12-0.61 l-1.92-3.32c-0.12-0.22-0.37-0.29-0.59-0.22l-2.39,0.96c-0.5-0.38-1.03-0.7-1.62-0.94L14.4,2.81c-0.04-0.24-0.24-0.41-0.48-0.41 h-3.84c-0.24,0-0.43,0.17-0.47,0.41L9.25,5.35C8.66,5.59,8.12,5.92,7.63,6.29L5.24,5.33c-0.22-0.08-0.47,0-0.59,0.22L2.74,8.87 C2.62,9.08,2.66,9.34,2.86,9.48l2.03,1.58C4.84,11.36,4.8,11.69,4.8,12s0.02,0.64,0.07,0.94l-2.03,1.58 c-0.18,0.14-0.23,0.41-0.12,0.61l1.92,3.32c0.12,0.22,0.37,0.29,0.59,0.22l2.39-0.96c0.5,0.38,1.03,0.7,1.62,0.94l0.36,2.54 c0.05,0.24,0.24,0.41,0.48,0.41h3.84c0.24,0,0.44-0.17,0.47-0.41l0.36-2.54c0.59-0.24,1.13-0.56,1.62-0.94l2.39,0.96 c0.22,0.08,0.47,0,0.59-0.22l1.92-3.32c0.12-0.22,0.07-0.47-0.12-0.61L19.14,12.94z M12,15.6c-1.98,0-3.6-1.62-3.6-3.6 s1.62-3.6,3.6-3.6s3.6,1.62,3.6,3.6S13.98,15.6,12,15.6z"/>
  </svg>
);

const DoubleCheck = ({ blue }: { blue?: boolean }) => (
  <svg viewBox="0 0 18 12" fill={blue ? "#53BDEB" : "#8696A0"} width="16" height="16">
    <path d="M17.394 1L6.396 12 1 6.604l1.394-1.394 3.996 3.996L15.994 1z"/>
    <path d="M13.394 1l-7 7-1.394-1.394 7-7z" opacity="0.6"/>
  </svg>
);

/* ─── Main Component ─── */
export function App() {
  /* Auth state */
  const [session, setSession] = useState<Session | null>(null);
  const [phone, setPhone] = useState("");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [otpCode, setOtpCode] = useState("");
  const [otpProof, setOtpProof] = useState("");
  const [otpStatus, setOtpStatus] = useState<string | null>(null);
  const [otpRetryAfterSec, setOtpRetryAfterSec] = useState(0);
  const [mode, setMode] = useState<"login" | "register">("register");
  const [usernameAvailable, setUsernameAvailable] = useState<boolean | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);

  /* App state */
  const [contacts, setContacts] = useState<PublicUser[]>([]);
  const [selectedUser, setSelectedUser] = useState<PublicUser | null>(null);
  const [query, setQuery] = useState("");
  const [text, setText] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [onlineUsers, setOnlineUsers] = useState<Set<string>>(new Set());
  const [unreadCounts, setUnreadCounts] = useState<Record<string, number>>({});
  const [activeNav, setActiveNav] = useState<"chats" | "calls" | "settings">("chats");
  const [filterPill, setFilterPill] = useState<"all" | "unread">("all");
  const [incomingCallFrom, setIncomingCallFrom] = useState<string | null>(null);

  /* Refs */
  const socketRef = useRef<Socket | null>(null);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const callPcRef = useRef<RTCPeerConnection | null>(null);
  const filePcRef = useRef<RTCPeerConnection | null>(null);
  const fileChannelRef = useRef<RTCDataChannel | null>(null);
  const pendingOutgoingFileRef = useRef<File | null>(null);
  const filePeerUserIdRef = useRef<string | null>(null);
  const incomingTransferRef = useRef<{ name: string; mime: string; chunks: ArrayBuffer[]; fromUserId: string } | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const feedRef = useRef<HTMLDivElement | null>(null);

  /* ─── Load session ─── */
  useEffect(() => {
    const saved = localStorage.getItem("zaply-session");
    if (saved) setSession(JSON.parse(saved));
  }, []);

  /* ─── OTP countdown ─── */
  useEffect(() => {
    if (otpRetryAfterSec <= 0) return;
    const t = window.setTimeout(() => setOtpRetryAfterSec(x => Math.max(0, x - 1)), 1000);
    return () => clearTimeout(t);
  }, [otpRetryAfterSec]);

  /* ─── Reset OTP on mode/phone change ─── */
  useEffect(() => {
    setOtpCode(""); setOtpProof(""); setOtpStatus(null); setOtpRetryAfterSec(0);
  }, [mode, phone]);

  /* ─── Socket setup ─── */
  useEffect(() => {
    if (!session) { socketRef.current?.disconnect(); socketRef.current = null; return; }
    localStorage.setItem("zaply-session", JSON.stringify(session));

    const socket = io(SIGNALING_BASE_URL, { auth: { token: session.token } });
    socketRef.current = socket;

    socket.on("presence:update", ({ userId, online }: { userId: string; online: boolean }) => {
      setOnlineUsers(prev => {
        const next = new Set(prev);
        online ? next.add(userId) : next.delete(userId);
        return next;
      });
    });

    socket.on("signal:receive", async (packet: SignalReceive) => {
      const { fromUserId, fromUsername, envelope } = packet;

      if (envelope.type === "chat") {
        const content = String(envelope.payload);
        const msg: ChatMessage = {
          id: crypto.randomUUID(), fromUserId,
          toUserId: session.user.userId, kind: "text", content,
          ts: Date.now(), expiresAt: envelope.expiresAt ?? Date.now() + TTL_MS
        };
        setMessages(prev => [...prev, msg]);
        setContacts(prev => {
          if (prev.find(u => u.userId === fromUserId)) return prev;
          return [...prev, { userId: fromUserId, username: fromUsername, displayName: fromUsername }];
        });
        setUnreadCounts(prev => {
          const sel = selectedUser; // capture
          if (sel?.userId === fromUserId) return prev;
          return { ...prev, [fromUserId]: (prev[fromUserId] ?? 0) + 1 };
        });
      }

      if (envelope.type === "file-meta") {
        const meta = envelope.payload as { name: string; size: number; mime: string };
        setMessages(prev => [...prev, {
          id: crypto.randomUUID(), fromUserId, toUserId: session.user.userId,
          kind: "file-meta", content: `${meta.name} (${Math.round(meta.size / 1024)} KB)`,
          ts: Date.now(), expiresAt: Date.now() + TTL_MS
        }]);
      }

      if (envelope.type === "offer") {
        const payload = envelope.payload as ScopedOffer;
        if (payload.scope === "call") {
          setIncomingCallFrom(fromUserId);
          await ensureLocalMedia(true);
          const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
          callPcRef.current = pc;
          localStreamRef.current?.getTracks().forEach(t => pc.addTrack(t, localStreamRef.current!));
          pc.ontrack = e => { if (remoteVideoRef.current) remoteVideoRef.current.srcObject = e.streams[0]; };
          pc.onicecandidate = e => { if (e.candidate) sendSignal({ toUserId: fromUserId, type: "ice", payload: { scope: "call", candidate: e.candidate } }); };
          await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          sendSignal({ toUserId: fromUserId, type: "answer", payload: { scope: "call", sdp: answer } });
        }
        if (payload.scope === "file") {
          filePeerUserIdRef.current = fromUserId;
          const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
          filePcRef.current = pc;
          pc.ondatachannel = e => setupFileChannel(e.channel, session.user.userId);
          pc.onicecandidate = e => { if (e.candidate) sendSignal({ toUserId: fromUserId, type: "ice", payload: { scope: "file", candidate: e.candidate } }); };
          await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          sendSignal({ toUserId: fromUserId, type: "answer", payload: { scope: "file", sdp: answer } });
        }
      }

      if (envelope.type === "answer") {
        const p = envelope.payload as ScopedAnswer;
        if (p.scope === "call" && callPcRef.current) await callPcRef.current.setRemoteDescription(new RTCSessionDescription(p.sdp));
        if (p.scope === "file" && filePcRef.current) await filePcRef.current.setRemoteDescription(new RTCSessionDescription(p.sdp));
      }

      if (envelope.type === "ice") {
        const p = envelope.payload as ScopedIce;
        if (p.scope === "call" && callPcRef.current) await callPcRef.current.addIceCandidate(new RTCIceCandidate(p.candidate));
        if (p.scope === "file" && filePcRef.current) await filePcRef.current.addIceCandidate(new RTCIceCandidate(p.candidate));
      }
    });

    return () => { socket.disconnect(); };
  }, [session]);

  /* ─── Message TTL cleanup ─── */
  useEffect(() => {
    const t = setInterval(() => { const now = Date.now(); setMessages(prev => prev.filter(m => m.expiresAt > now)); }, 60_000);
    return () => clearInterval(t);
  }, []);

  /* ─── Scroll to bottom on new messages ─── */
  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, selectedUser]);

  /* ─── Helpers ─── */
  const activeMessages = useMemo(() => {
    if (!session || !selectedUser) return [] as ChatMessage[];
    return messages.filter(m =>
      (m.fromUserId === session.user.userId && m.toUserId === selectedUser.userId) ||
      (m.fromUserId === selectedUser.userId && m.toUserId === session.user.userId)
    );
  }, [messages, selectedUser, session]);

  function sendSignal(payload: SignalPayload) { socketRef.current?.emit("signal:send", payload); }

  async function ensureLocalMedia(video: boolean) {
    if (localStreamRef.current) return localStreamRef.current;
    const stream = await navigator.mediaDevices.getUserMedia({ video, audio: true });
    localStreamRef.current = stream;
    if (localVideoRef.current) localVideoRef.current.srcObject = stream;
    return stream;
  }

  function setupFileChannel(channel: RTCDataChannel, currentUserId: string) {
    fileChannelRef.current = channel;
    channel.binaryType = "arraybuffer";
    channel.onopen = () => { void sendPendingFileIfAny(); };
    channel.onmessage = (event) => {
      if (typeof event.data === "string") {
        const ctrl = JSON.parse(event.data) as FileControlMessage;
        if (ctrl.kind === "meta") incomingTransferRef.current = { name: ctrl.name, mime: ctrl.mime, chunks: [], fromUserId: filePeerUserIdRef.current ?? "unknown" };
        if (ctrl.kind === "done" && incomingTransferRef.current) {
          const inc = incomingTransferRef.current;
          const blob = new Blob(inc.chunks, { type: inc.mime || "application/octet-stream" });
          const url = URL.createObjectURL(blob);
          setMessages(prev => [...prev, {
            id: crypto.randomUUID(), fromUserId: inc.fromUserId, toUserId: currentUserId,
            kind: "file-meta", content: inc.name, downloadUrl: url,
            ts: Date.now(), expiresAt: Date.now() + TTL_MS
          }]);
          incomingTransferRef.current = null;
        }
        return;
      }
      if (event.data instanceof ArrayBuffer && incomingTransferRef.current) incomingTransferRef.current.chunks.push(event.data);
    };
  }

  async function sendPendingFileIfAny() {
    const file = pendingOutgoingFileRef.current, channel = fileChannelRef.current;
    if (!file || !channel || channel.readyState !== "open") return;
    channel.send(JSON.stringify({ kind: "meta", name: file.name, size: file.size, mime: file.type || "application/octet-stream" } satisfies FileControlMessage));
    const chunkSize = 16 * 1024;
    for (let offset = 0; offset < file.size; offset += chunkSize) {
      channel.send(await file.slice(offset, offset + chunkSize).arrayBuffer());
    }
    channel.send(JSON.stringify({ kind: "done" } satisfies FileControlMessage));
    pendingOutgoingFileRef.current = null;
  }

  async function startFilePeerOffer(targetUserId: string) {
    fileChannelRef.current?.close(); filePcRef.current?.close();
    filePeerUserIdRef.current = targetUserId;
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS }); filePcRef.current = pc;
    const channel = pc.createDataChannel("file"); setupFileChannel(channel, session!.user.userId);
    pc.onicecandidate = e => { if (e.candidate) sendSignal({ toUserId: targetUserId, type: "ice", payload: { scope: "file", candidate: e.candidate } }); };
    const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
    sendSignal({ toUserId: targetUserId, type: "offer", payload: { scope: "file", sdp: offer } });
  }

  function handleFileShare(file: File) {
    if (!session || !selectedUser) return;
    setMessages(prev => [...prev, {
      id: crypto.randomUUID(), fromUserId: session.user.userId, toUserId: selectedUser.userId,
      kind: "file-meta", content: `${file.name} (${Math.round(file.size / 1024)} KB)`,
      ts: Date.now(), expiresAt: Date.now() + TTL_MS
    }]);
    pendingOutgoingFileRef.current = file;
    filePeerUserIdRef.current = selectedUser.userId;
    if (fileChannelRef.current?.readyState === "open") { void sendPendingFileIfAny(); return; }
    void startFilePeerOffer(selectedUser.userId);
  }

  async function startCall(video: boolean) {
    if (!session || !selectedUser) return;
    const stream = await ensureLocalMedia(video);
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS }); callPcRef.current = pc;
    stream.getTracks().forEach(t => pc.addTrack(t, stream));
    pc.ontrack = e => { if (remoteVideoRef.current) remoteVideoRef.current.srcObject = e.streams[0]; };
    pc.onicecandidate = e => { if (e.candidate) sendSignal({ toUserId: selectedUser.userId, type: "ice", payload: { scope: "call", candidate: e.candidate } }); };
    const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
    sendSignal({ toUserId: selectedUser.userId, type: "offer", payload: { scope: "call", sdp: offer } });
  }

  function endCall() {
    callPcRef.current?.close(); callPcRef.current = null;
    localStreamRef.current?.getTracks().forEach(t => t.stop()); localStreamRef.current = null;
    setIncomingCallFrom(null);
  }

  function handleSendMessage() {
    if (!session || !selectedUser || !text.trim()) return;
    const msg: ChatMessage = {
      id: crypto.randomUUID(), fromUserId: session.user.userId, toUserId: selectedUser.userId,
      kind: "text", content: text, ts: Date.now(), expiresAt: Date.now() + TTL_MS
    };
    setMessages(prev => [...prev, msg]);
    sendSignal({ toUserId: selectedUser.userId, type: "chat", payload: text });
    setText("");
  }

  async function handleSearch(q: string) {
    setQuery(q);
    if (!session || !q.trim()) return;
    const result = await searchUsers(q, session.token);
    result.forEach(u => {
      setContacts(prev => prev.find(c => c.userId === u.userId) ? prev : [...prev, u]);
    });
  }

  function selectUser(u: PublicUser) {
    setSelectedUser(u);
    setUnreadCounts(prev => ({ ...prev, [u.userId]: 0 }));
  }

  /* ─── Auth handlers ─── */
  async function handleRequestOtp() {
    if (!phone.trim()) { setAuthError("Phone number required"); return; }
    setAuthError(null);
    try {
      await requestOtp(phone, mode as OtpPurpose);
      setOtpStatus("OTP sent! Enter 000000 in test mode.");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed";
      const m = /try again in (\d+)s/i.exec(msg);
      if (m) setOtpRetryAfterSec(Number(m[1]));
      setAuthError(msg);
    }
  }

  async function handleVerifyOtp() {
    if (!phone.trim() || !otpCode.trim()) { setAuthError("Phone and OTP required"); return; }
    setAuthError(null);
    try {
      const proof = await verifyOtp(phone, mode as OtpPurpose, otpCode);
      setOtpProof(proof); setOtpStatus("Phone verified ✓");
    } catch (err) { setAuthError(err instanceof Error ? err.message : "OTP failed"); }
  }

  async function handleAuthSubmit(e: React.FormEvent) {
    e.preventDefault(); setAuthError(null);
    if (!otpProof) { setAuthError("Please verify OTP first"); return; }
    try {
      const next = mode === "register"
        ? await register({ phone, username, displayName: displayName || username, password, otpProof })
        : await login({ phone, password, otpProof });
      setSession(next);
    } catch (err) { setAuthError(err instanceof Error ? err.message : "Auth failed"); }
  }

  async function checkUsername() {
    if (!username.trim()) { setUsernameAvailable(null); return; }
    setUsernameAvailable(await checkUsernameAvailability(username));
  }

  /* ─── Filter contacts ─── */
  const filteredContacts = useMemo(() => {
    if (filterPill === "unread") return contacts.filter(u => (unreadCounts[u.userId] ?? 0) > 0);
    return contacts;
  }, [contacts, filterPill, unreadCounts]);

  const lastMsgForUser = (userId: string) => {
    const msgs = messages.filter(m => m.fromUserId === userId || m.toUserId === userId);
    return msgs[msgs.length - 1] ?? null;
  };

  /* ─── Group messages by date ─── */
  const groupedMessages = useMemo(() => {
    const groups: { date: string; messages: ChatMessage[] }[] = [];
    let lastDate = "";
    for (const msg of activeMessages) {
      const d = formatDate(msg.ts);
      if (d !== lastDate) { groups.push({ date: d, messages: [] }); lastDate = d; }
      groups[groups.length - 1].messages.push(msg);
    }
    return groups;
  }, [activeMessages]);

  /* ─── AUTH SCREEN ─── */
  if (!session) {
    return (
      <div className="auth-shell">
        <div className="auth-box">
          <div className="auth-logo">
            <WaLogo />
            <h1>Zaply</h1>
          </div>
          <p className="auth-subtitle">Privacy-first messenger</p>

          <div className="auth-tabs">
            <button className={mode === "register" ? "active" : ""} onClick={() => setMode("register")}>Register</button>
            <button className={mode === "login" ? "active" : ""} onClick={() => setMode("login")}>Login</button>
          </div>

          <form className="auth-form" onSubmit={handleAuthSubmit}>
            <div className="form-group">
              <label>Mobile Number</label>
              <input value={phone} onChange={e => setPhone(e.target.value)} placeholder="+91 98765 43210" required />
            </div>

            {mode === "register" && (
              <>
                <div className="form-group">
                  <label>Username</label>
                  <input value={username} onChange={e => setUsername(e.target.value)} onBlur={checkUsername} placeholder="unique_username" required />
                  {usernameAvailable !== null && (
                    <span className={`username-hint ${usernameAvailable ? "ok" : "bad"}`}>
                      {usernameAvailable ? "✓ Available" : "✗ Already taken"}
                    </span>
                  )}
                </div>
                <div className="form-group">
                  <label>Display Name</label>
                  <input value={displayName} onChange={e => setDisplayName(e.target.value)} placeholder="Your Name" required />
                </div>
              </>
            )}

            <div className="form-group">
              <label>Password</label>
              <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••" required />
            </div>

            <div className="form-group">
              <label>OTP Code</label>
              <div className="otp-row">
                <input value={otpCode} onChange={e => setOtpCode(e.target.value)} placeholder="000000" maxLength={6} />
                <button type="button" className="btn-ghost" disabled={otpRetryAfterSec > 0} onClick={() => void handleRequestOtp()}>
                  {otpRetryAfterSec > 0 ? `Wait ${otpRetryAfterSec}s` : "Send OTP"}
                </button>
                <button type="button" className="btn-ghost" onClick={() => void handleVerifyOtp()}>Verify</button>
              </div>
              <div className={`otp-status ${otpProof ? "verified" : "unverified"}`}>
                {otpProof ? "✓ Phone verified" : (otpStatus ?? "OTP not verified")}
              </div>
            </div>

            {authError && <div className="auth-error">{authError}</div>}

            <button type="submit" className="btn-primary">
              {mode === "register" ? "Create Account" : "Sign In"}
            </button>
          </form>
        </div>
      </div>
    );
  }

  /* ─── MAIN APP ─── */
  const isChatOpen = !!selectedUser;

  return (
    <div className={`app-layout ${isChatOpen ? "chat-open" : ""}`}>
      {/* Incoming call banner */}
      {incomingCallFrom && (
        <div style={{ position: "fixed", top: 0, left: 0, right: 0, zIndex: 999, background: "#005C4B", padding: "12px 20px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ color: "white", fontWeight: 500 }}>📞 Incoming call from {contacts.find(u => u.userId === incomingCallFrom)?.displayName ?? incomingCallFrom}</span>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn-primary" style={{ padding: "6px 16px", margin: 0 }} onClick={() => void startCall(true)}>Accept</button>
            <button className="btn-ghost" style={{ padding: "6px 16px" }} onClick={endCall}>Decline</button>
          </div>
        </div>
      )}

      {/* ─── LEFT PANEL ─── */}
      <div className="left-panel">
        {/* Header */}
        <div className="left-header">
          <div className="chat-avatar user-avatar" style={{ background: avatarColor(session.user.displayName) }}>
            {initials(session.user.displayName)}
          </div>
          <span className="left-header-title">Zaply</span>
          <div className="header-actions">
            <button className="icon-btn" title="Settings" onClick={() => setActiveNav("settings")}><IconSettings /></button>
            <button className="icon-btn" title="Menu"><IconDots /></button>
          </div>
        </div>

        {/* Search */}
        <div className="search-bar">
          <div className="search-input-wrap">
            <IconSearch />
            <input
              value={query}
              onChange={e => void handleSearch(e.target.value)}
              placeholder="Search or start new chat"
            />
          </div>
        </div>

        {/* Filter pills */}
        <div className="filter-pills">
          <button className={`pill ${filterPill === "all" ? "active" : ""}`} onClick={() => setFilterPill("all")}>All</button>
          <button className={`pill ${filterPill === "unread" ? "active" : ""}`} onClick={() => setFilterPill("unread")}>Unread</button>
        </div>

        {/* Chat list */}
        <div className="chat-list">
          {filteredContacts.length === 0 ? (
            <div className="empty-chat-list">
              <WaLogo />
              <p>Search for users to start chatting</p>
            </div>
          ) : (
            filteredContacts.map(u => {
              const last = lastMsgForUser(u.userId);
              const unread = unreadCounts[u.userId] ?? 0;
              const online = onlineUsers.has(u.userId);
              return (
                <div key={u.userId} className={`chat-item ${selectedUser?.userId === u.userId ? "active" : ""}`} onClick={() => selectUser(u)}>
                  <div className="chat-avatar" style={{ background: avatarColor(u.displayName) }}>
                    {initials(u.displayName)}
                    {online && <span className="online-dot" />}
                  </div>
                  <div className="chat-info">
                    <div className="chat-info-top">
                      <span className="chat-name">{u.displayName}</span>
                      {last && <span className="chat-time">{formatTime(last.ts)}</span>}
                    </div>
                    <div className="chat-preview">
                      <span className="chat-last-msg">{last ? (last.kind === "file-meta" ? "📎 " + last.content : last.content) : `@${u.username}`}</span>
                      {unread > 0 && <span className="unread-badge">{unread}</span>}
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Bottom Nav */}
        <div className="bottom-nav">
          <div className="bottom-nav-items">
            <button className={`nav-item ${activeNav === "chats" ? "active" : ""}`} onClick={() => setActiveNav("chats")}>
              <IconChats /><span>Chats</span>
            </button>
            <button className={`nav-item ${activeNav === "calls" ? "active" : ""}`} onClick={() => setActiveNav("calls")}>
              <IconCalls /><span>Calls</span>
            </button>
            <button className={`nav-item ${activeNav === "settings" ? "active" : ""}`} onClick={() => setActiveNav("settings")}>
              <IconSettings /><span>Settings</span>
            </button>
          </div>
        </div>
      </div>

      {/* ─── RIGHT PANEL ─── */}
      <div className="right-panel">
        {!selectedUser ? (
          <div className="welcome-screen">
            <WaLogo />
            <h2>Zaply Web</h2>
            <p>Send and receive messages without keeping your phone online.</p>
            <p style={{ fontSize: 12, marginTop: 8, color: "var(--text-muted)" }}>
              Logged in as @{session.user.username}
            </p>
            {/* Theme switcher */}
            <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
              {THEME_OPTIONS.map(t => (
                <button key={t} className="pill" onClick={async () => {
                  await updateProfile(session.token, { theme: t });
                  setSession({ ...session, user: { ...session.user, theme: t } });
                }}>
                  {t}
                </button>
              ))}
            </div>
            <button className="btn-ghost" style={{ marginTop: 12 }} onClick={() => { localStorage.removeItem("zaply-session"); setSession(null); }}>
              Logout
            </button>
            {/* Hidden video elements for calls */}
            <video ref={localVideoRef} autoPlay playsInline muted style={{ display: "none" }} />
            <video ref={remoteVideoRef} autoPlay playsInline style={{ display: "none" }} />
          </div>
        ) : (
          <>
            {/* Chat Header */}
            <div className="chat-header">
              <button className="icon-btn back-btn" onClick={() => setSelectedUser(null)}><IconBack /></button>
              <div className="chat-avatar" style={{ background: avatarColor(selectedUser.displayName), width: 40, height: 40 }}>
                {initials(selectedUser.displayName)}
              </div>
              <div className="chat-header-info">
                <div className="chat-header-name">{selectedUser.displayName}</div>
                <div className={`chat-header-status ${onlineUsers.has(selectedUser.userId) ? "online" : ""}`}>
                  {onlineUsers.has(selectedUser.userId) ? "online" : `@${selectedUser.username}`}
                </div>
              </div>
              <div className="chat-header-actions">
                <button className="icon-btn" title="Video Call" onClick={() => void startCall(true)}><IconVideo /></button>
                <button className="icon-btn" title="Voice Call" onClick={() => void startCall(false)}><IconPhone /></button>
                <button className="icon-btn" title="End Call" onClick={endCall} style={{ fontSize: 12, color: "#FF6B6B" }}>✕</button>
                <button className="icon-btn"><IconDots /></button>
              </div>
            </div>

            {/* Chat Feed */}
            <div className="chat-feed" ref={feedRef}>
              {groupedMessages.length === 0 && (
                <div className="empty-chat">
                  <p>No messages yet. Say hello! 👋</p>
                </div>
              )}
              {groupedMessages.map(group => (
                <div key={group.date}>
                  <div className="date-anchor"><span>{group.date}</span></div>
                  {group.messages.map(msg => {
                    const isMe = msg.fromUserId === session.user.userId;
                    return (
                      <div key={msg.id} className={`msg-row ${isMe ? "outgoing" : "incoming"}`}>
                        <div className="msg-bubble">
                          {msg.kind === "file-meta" ? (
                            <div className="msg-file">
                              <div className="msg-file-icon"><IconFile /></div>
                              <div>
                                <span className="msg-text">{msg.content}</span>
                                {msg.downloadUrl && (
                                  <div><a href={msg.downloadUrl} download target="_blank" rel="noreferrer">Download</a></div>
                                )}
                              </div>
                            </div>
                          ) : (
                            <span className="msg-text">{msg.content}</span>
                          )}
                          <div className="msg-meta">
                            <span className="msg-time">{formatTime(msg.ts)}</span>
                            {isMe && <div className="msg-ticks"><DoubleCheck blue /></div>}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ))}
              {/* Hidden video elements */}
              <video ref={localVideoRef} autoPlay playsInline muted style={{ display: "none" }} />
              <video ref={remoteVideoRef} autoPlay playsInline style={{ display: "none" }} />
            </div>

            {/* Input Dock */}
            <div className="input-dock">
              <div className="input-wrap">
                <label className="file-label" title="Attach file">
                  <IconAttach />
                  <input type="file" onChange={e => { const f = e.target.files?.[0]; if (f) handleFileShare(f); e.target.value = ""; }} />
                </label>
                <input
                  value={text}
                  onChange={e => setText(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && !e.shiftKey && (e.preventDefault(), handleSendMessage())}
                  placeholder="Type a message"
                />
              </div>
              <button className="send-btn" onClick={text.trim() ? handleSendMessage : () => void startCall(false)} title={text.trim() ? "Send" : "Voice Call"}>
                {text.trim() ? <IconSend /> : <IconMic />}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
