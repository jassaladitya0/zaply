import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { io, type Socket } from "socket.io-client";
import { checkUsernameAvailability, login, register, requestOtp, searchUsers, updateProfile, verifyOtp, syncContacts } from "./api";
import type { ChatMessage, OtpPurpose, PublicUser, Session, SignalPayload, SignalScope, Theme } from "./types";
import "./styles.css";

/* ─── Types ─── */
type SignalReceive = { fromUserId: string; fromUsername: string; envelope: { toUserId: string; type: "chat"|"offer"|"answer"|"ice"|"file-meta"|"typing"; payload: unknown; expiresAt?: number } };
type ScopedOffer = { scope: SignalScope; sdp: RTCSessionDescriptionInit };
type ScopedAnswer = { scope: SignalScope; sdp: RTCSessionDescriptionInit };
type ScopedIce = { scope: SignalScope; candidate: RTCIceCandidateInit };
type FileCtrl = { kind: "meta"; name: string; size: number; mime: string } | { kind: "done" };

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
const API = (import.meta.env.VITE_SIGNALING_BASE_URL as string) ?? "http://localhost:4000";
const THEMES: Theme[] = ["sand", "forest", "sunset"];

/* ─── Utils ─── */
const COLORS = ["#00A884","#0B6185","#5B2C6F","#922B21","#1E8449","#D35400","#1A5276","#6C3483"];
const avColor = (n: string) => { let h = 0; for (let i = 0; i < n.length; i++) h = n.charCodeAt(i)+((h<<5)-h); return COLORS[Math.abs(h)%COLORS.length]; };
const initials = (n: string) => n.split(" ").map(w=>w[0]).join("").slice(0,2).toUpperCase();
const fmtTime = (ts: number) => new Date(ts).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"});
const fmtDate = (ts: number) => { const d=new Date(ts),n=new Date(); if(d.toDateString()===n.toDateString()) return "Today"; const y=new Date(n); y.setDate(n.getDate()-1); if(d.toDateString()===y.toDateString()) return "Yesterday"; return d.toLocaleDateString([],{day:"numeric",month:"long",year:"numeric"}); };

async function compressAvatar(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => {
      const c = document.createElement("canvas"); c.width = c.height = 200;
      const ctx = c.getContext("2d")!;
      const min = Math.min(img.width, img.height);
      ctx.drawImage(img, (img.width-min)/2, (img.height-min)/2, min, min, 0, 0, 200, 200);
      URL.revokeObjectURL(url); resolve(c.toDataURL("image/jpeg", 0.8));
    };
    img.onerror = reject; img.src = url;
  });
}

/* ─── Icons ─── */
const I = {
  WA: () => <svg viewBox="0 0 24 24" fill="#00A884" width="36" height="36"><path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.38 1.26 4.78L2.05 22l5.5-1.44c1.35.73 2.88 1.14 4.49 1.14 5.46 0 9.91-4.45 9.91-9.91S17.5 2 12.04 2zm5.52 14.17c-.23.65-1.35 1.24-1.85 1.31-.5.07-1.13.1-1.82-.12-.42-.13-.96-.3-1.65-.58-2.9-1.26-4.8-4.18-4.95-4.38-.14-.2-1.18-1.57-1.18-3s.75-2.13.99-2.42c.24-.3.54-.37.72-.37s.36.01.51.01c.16 0 .38-.06.59.45.22.51.75 1.83.81 1.96.06.14.1.3.02.48-.09.19-.13.3-.26.47l-.39.45c-.13.14-.27.29-.12.57.15.28.68 1.12 1.46 1.82 1.01.9 1.86 1.18 2.12 1.31.27.13.43.11.59-.07.16-.18.68-.8.86-1.07.18-.28.36-.23.61-.14.25.09 1.59.75 1.86.89.27.14.45.2.52.32.06.11.06.65-.17 1.28z"/></svg>,
  Search: () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>,
  Dots: () => <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/></svg>,
  Send: () => <svg viewBox="0 0 24 24" fill="currentColor" width="22" height="22"><path d="M2 21L23 12 2 3v7l15 2-15 2z"/></svg>,
  Mic: () => <svg viewBox="0 0 24 24" fill="currentColor" width="22" height="22"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm-1 1.93c-3.94-.49-7-3.85-7-7.93H2c0 4.97 3.66 9.09 8.5 9.9V22h3v-4.07c4.84-.81 8.5-4.93 8.5-9.9h-2c0 4.08-3.05 7.44-7 7.93z"/></svg>,
  Attach: () => <svg viewBox="0 0 24 24" fill="currentColor" width="22" height="22"><path d="M16.5 6v11.5c0 2.21-1.79 4-4 4s-4-1.79-4-4V5c0-1.38 1.12-2.5 2.5-2.5s2.5 1.12 2.5 2.5v10.5c0 .55-.45 1-1 1s-1-.45-1-1V6H10v9.5c0 1.38 1.12 2.5 2.5 2.5S15 16.88 15 15.5V5c0-2.21-1.79-4-4-4S7 2.79 7 5v12.5c0 3.04 2.46 5.5 5.5 5.5s5.5-2.46 5.5-5.5V6h-1.5z"/></svg>,
  Video: () => <svg viewBox="0 0 24 24" fill="currentColor" width="22" height="22"><path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/></svg>,
  Phone: () => <svg viewBox="0 0 24 24" fill="currentColor" width="22" height="22"><path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z"/></svg>,
  Back: () => <svg viewBox="0 0 24 24" fill="currentColor" width="22" height="22"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>,
  Settings: () => <svg viewBox="0 0 24 24" fill="currentColor" width="22" height="22"><path d="M19.14,12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94L14.4,2.81c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41L9.25,5.35C8.66,5.59,8.12,5.92,7.63,6.29L5.24,5.33c-.22-.08-.47 0-.59.22L2.74,8.87c-.12.22-.07.47.12.61l2.03,1.58C4.84,11.36,4.8,11.69,4.8,12s.02.64.07.94l-2.03,1.58c-.18.14-.23.41-.12.61l1.92,3.32c.12.22.37.29.59.22l2.39-.96c.5.38,1.03.7,1.62.94l.36,2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24,1.13-.56,1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61L19.14,12.94zM12,15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6,3.6-3.6 3.6,1.62,3.6,3.6S13.98,15.6,12,15.6z"/></svg>,
  File: () => <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><path d="M6 2c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6H6zm7 7V3.5L18.5 9H13z"/></svg>,
  Camera: () => <svg viewBox="0 0 24 24" fill="currentColor" width="22" height="22"><path d="M12 15.2c1.77 0 3.2-1.43 3.2-3.2S13.77 8.8 12 8.8 8.8 10.23 8.8 12s1.43 3.2 3.2 3.2zM20 4h-3.17L15 2H9L7.17 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4V6h4.05l1.83-2h4.24l1.83 2H20v12z"/></svg>,
  EditPen: () => <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>,
  Logout: () => <svg viewBox="0 0 24 24" fill="currentColor" width="22" height="22"><path d="M17 7l-1.41 1.41L18.17 11H8v2h10.17l-2.58 2.58L17 17l5-5zM4 5h8V3H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h8v-2H4V5z"/></svg>,
  Check: ({ blue }: { blue?: boolean }) => <svg viewBox="0 0 18 12" fill={blue?"#53BDEB":"#8696A0"} width="16" height="12"><path d="M17.394 1L6.396 12 1 6.604l1.394-1.394 3.996 3.996L15.994 1z"/><path d="M13.394 1l-7 7-1.394-1.394 7-7z" opacity="0.7"/></svg>,
  Chats: () => <svg viewBox="0 0 24 24" fill="currentColor" width="22" height="22"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>,
  Calls: () => <svg viewBox="0 0 24 24" fill="currentColor" width="22" height="22"><path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z"/></svg>,
};

/* ─── Avatar Component ─── */
function Avatar({ user, size = 49, showDot = false, online = false, resolvedName }: { user: Pick<PublicUser,"displayName"|"avatarUrl">, size?: number, showDot?: boolean, online?: boolean, resolvedName?: string }) {
  const name = resolvedName || user.displayName;
  return (
    <div className="chat-avatar" style={{ width: size, height: size, fontSize: size * 0.4, background: user.avatarUrl ? undefined : avColor(name) }}>
      {user.avatarUrl ? <img src={user.avatarUrl} alt={name} /> : initials(name)}
      {showDot && online && <span className="online-dot" />}
    </div>
  );
}


/* ─── Main App ─── */
export function App() {
  /* Auth */
  const [session, setSession] = useState<Session | null>(null);
  const [phone, setPhone] = useState(""); const [username, setUsername] = useState(""); const [displayName, setDisplayName] = useState(""); const [password, setPassword] = useState("");
  const [otpCode, setOtpCode] = useState(""); const [otpProof, setOtpProof] = useState(""); const [otpStatus, setOtpStatus] = useState<string|null>(null); const [otpRetry, setOtpRetry] = useState(0);
  const [authMode, setAuthMode] = useState<"login"|"register">("register"); const [unameOk, setUnameOk] = useState<boolean|null>(null); const [authErr, setAuthErr] = useState<string|null>(null);

  /* App */
  const [contacts, setContacts] = useState<PublicUser[]>([]);
  const [selectedUser, setSelectedUser] = useState<PublicUser|null>(null);
  const [query, setQuery] = useState(""); const [text, setText] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [online, setOnline] = useState<Set<string>>(new Set());
  const [unread, setUnread] = useState<Record<string,number>>({});
  const [filterPill, setFilterPill] = useState<"all"|"unread">("all");
  const [showSettings, setShowSettings] = useState(false);
  const [editName, setEditName] = useState(""); const [editingName, setEditingName] = useState(false);
  const [inCall, setInCall] = useState(false); const [incomingFrom, setIncomingFrom] = useState<string|null>(null);
  const [activeNav, setActiveNav] = useState<"chats"|"calls"|"settings">("chats");

  /* Local Address Book & Sync */
  const [addressBook, setAddressBook] = useState<Record<string, string>>({}); // phone -> contactName
  const [phoneToUser, setPhoneToUser] = useState<Record<string, string>>({}); // phone -> userId
  const [userToPhone, setUserToPhone] = useState<Record<string, string>>({}); // userId -> phone
  const [showSyncModal, setShowSyncModal] = useState(false);
  const [newContactName, setNewContactName] = useState("");
  const [newContactPhone, setNewContactPhone] = useState("");

  /* Refs */
  const socketRef = useRef<Socket|null>(null);
  const localVidRef = useRef<HTMLVideoElement|null>(null);
  const remoteVidRef = useRef<HTMLVideoElement|null>(null);
  const callPcRef = useRef<RTCPeerConnection|null>(null);
  const filePcRef = useRef<RTCPeerConnection|null>(null);
  const fileChanRef = useRef<RTCDataChannel|null>(null);
  const pendingFileRef = useRef<File|null>(null);
  const filePeerRef = useRef<string|null>(null);
  const incomingFileRef = useRef<{name:string;mime:string;chunks:ArrayBuffer[];from:string}|null>(null);
  const localStreamRef = useRef<MediaStream|null>(null);
  const feedRef = useRef<HTMLDivElement|null>(null);
  const selectedRef = useRef<PublicUser|null>(null);

  // Keep selectedRef in sync
  useEffect(() => { selectedRef.current = selectedUser; }, [selectedUser]);

  /* ─── Load from localStorage ─── */
  useEffect(() => {
    const s = localStorage.getItem("zaply-session"); if (s) setSession(JSON.parse(s));
    const c = localStorage.getItem("zaply-contacts"); if (c) setContacts(JSON.parse(c));
    const ab = localStorage.getItem("zaply-address-book"); if (ab) setAddressBook(JSON.parse(ab));
    const p2u = localStorage.getItem("zaply-phone-to-user"); if (p2u) setPhoneToUser(JSON.parse(p2u));
    const u2p = localStorage.getItem("zaply-user-to-phone"); if (u2p) setUserToPhone(JSON.parse(u2p));
    const m = localStorage.getItem("zaply-messages"); if (m) {
      const parsed: ChatMessage[] = JSON.parse(m);
      const now = Date.now();
      setMessages(parsed.filter(msg => msg.expiresAt > now));
    }
  }, []);

  /* ─── Save contacts & messages ─── */
  useEffect(() => { if (contacts.length) localStorage.setItem("zaply-contacts", JSON.stringify(contacts)); }, [contacts]);
  useEffect(() => { localStorage.setItem("zaply-messages", JSON.stringify(messages)); }, [messages]);
  useEffect(() => { localStorage.setItem("zaply-address-book", JSON.stringify(addressBook)); }, [addressBook]);
  useEffect(() => { localStorage.setItem("zaply-phone-to-user", JSON.stringify(phoneToUser)); }, [phoneToUser]);
  useEffect(() => { localStorage.setItem("zaply-user-to-phone", JSON.stringify(userToPhone)); }, [userToPhone]);

  /* ─── OTP countdown ─── */
  useEffect(() => { if (otpRetry <= 0) return; const t = setTimeout(() => setOtpRetry(x=>Math.max(0,x-1)),1000); return ()=>clearTimeout(t); }, [otpRetry]);
  useEffect(() => { setOtpCode(""); setOtpProof(""); setOtpStatus(null); setOtpRetry(0); }, [authMode, phone]);

  /* ─── Socket ─── */
  useEffect(() => {
    if (!session) { socketRef.current?.disconnect(); socketRef.current=null; return; }
    localStorage.setItem("zaply-session", JSON.stringify(session));

    const sock = io(API, { auth: { token: session.token }, transports: ["websocket","polling"] });
    socketRef.current = sock;

    sock.on("presence:update", ({ userId, online: on }: {userId:string;online:boolean}) => {
      setOnline(prev => { const s=new Set(prev); on?s.add(userId):s.delete(userId); return s; });
    });

    sock.on("signal:receive", async (pkt: SignalReceive) => {
      const { fromUserId, fromUsername, envelope } = pkt;

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
        setMessages(prev=>[...prev,msg]);
        setContacts(prev => {
          if (prev.find(u=>u.userId===fromUserId)) return prev;
          const newUser = { userId: fromUserId, username: fromUsername, displayName: fromUsername };
          const next = [newUser, ...prev];
          localStorage.setItem("zaply-contacts", JSON.stringify(next));
          return next;
        });
        if (selectedRef.current?.userId !== fromUserId) setUnread(p=>({...p,[fromUserId]:(p[fromUserId]??0)+1}));
      }

      if (envelope.type === "file-meta") {
        const meta = envelope.payload as {name:string;size:number;mime:string};
        setMessages(prev=>[...prev,{ id:crypto.randomUUID(), fromUserId, toUserId:session.user.userId, kind:"file-meta", content:`${meta.name} (${Math.round(meta.size/1024)} KB)`, ts:Date.now(), expiresAt:Date.now()+TTL }]);
      }

      if (envelope.type === "offer") {
        const p = envelope.payload as ScopedOffer;
        if (p.scope === "call") {
          setIncomingFrom(fromUserId);
          try {
            const stream = await getMedia(true);
            const pc = makePc(); callPcRef.current=pc;
            stream.getTracks().forEach(t=>pc.addTrack(t,stream));
            pc.ontrack=e=>{if(remoteVidRef.current)remoteVidRef.current.srcObject=e.streams[0]};
            pc.onicecandidate=e=>{if(e.candidate)send({toUserId:fromUserId,type:"ice",payload:{scope:"call",candidate:e.candidate}})};
            await pc.setRemoteDescription(new RTCSessionDescription(p.sdp));
            const ans=await pc.createAnswer(); await pc.setLocalDescription(ans);
            send({toUserId:fromUserId,type:"answer",payload:{scope:"call",sdp:ans}});
          } catch(e){ console.error("call answer failed",e); }
        }
        if (p.scope === "file") {
          filePeerRef.current=fromUserId;
          const pc=makePc(); filePcRef.current=pc;
          pc.ondatachannel=e=>setupFileChan(e.channel,session.user.userId);
          pc.onicecandidate=e=>{if(e.candidate)send({toUserId:fromUserId,type:"ice",payload:{scope:"file",candidate:e.candidate}})};
          await pc.setRemoteDescription(new RTCSessionDescription(p.sdp));
          const ans=await pc.createAnswer(); await pc.setLocalDescription(ans);
          send({toUserId:fromUserId,type:"answer",payload:{scope:"file",sdp:ans}});
        }
      }

      if (envelope.type === "answer") {
        const p=envelope.payload as ScopedAnswer;
        if(p.scope==="call"&&callPcRef.current) await callPcRef.current.setRemoteDescription(new RTCSessionDescription(p.sdp));
        if(p.scope==="file"&&filePcRef.current) await filePcRef.current.setRemoteDescription(new RTCSessionDescription(p.sdp));
      }
      if (envelope.type === "ice") {
        const p=envelope.payload as ScopedIce;
        if(p.scope==="call"&&callPcRef.current) await callPcRef.current.addIceCandidate(new RTCIceCandidate(p.candidate));
        if(p.scope==="file"&&filePcRef.current) await filePcRef.current.addIceCandidate(new RTCIceCandidate(p.candidate));
      }
    });

    return ()=>{sock.disconnect();};
  }, [session]);

  /* ─── TTL cleanup ─── */
  useEffect(() => { const t=setInterval(()=>{ const now=Date.now(); setMessages(p=>p.filter(m=>m.expiresAt>now)); },60_000); return()=>clearInterval(t); }, []);

  /* ─── Scroll to bottom ─── */
  useEffect(() => { feedRef.current?.scrollTo({top:feedRef.current.scrollHeight,behavior:"smooth"}); }, [messages.length, selectedUser]);

  /* ─── Helpers ─── */
  const send = useCallback((payload: SignalPayload) => { socketRef.current?.emit("signal:send",payload); }, []);
  const makePc = () => new RTCPeerConnection({iceServers: ICE});

  async function getMedia(video: boolean) {
    if (localStreamRef.current) return localStreamRef.current;
    try {
      const s = await navigator.mediaDevices.getUserMedia({video,audio:true});
      localStreamRef.current=s; if(localVidRef.current) localVidRef.current.srcObject=s; return s;
    } catch {
      throw new Error("Camera/mic permission denied. Please allow access.");
    }
  }

  function setupFileChan(chan: RTCDataChannel, myId: string) {
    fileChanRef.current=chan; chan.binaryType="arraybuffer";
    chan.onopen=()=>sendPendingFile();
    chan.onmessage=ev=>{
      if(typeof ev.data==="string"){
        const ctrl=JSON.parse(ev.data) as FileCtrl;
        if(ctrl.kind==="meta") incomingFileRef.current={name:ctrl.name,mime:ctrl.mime,chunks:[],from:filePeerRef.current??"?"};
        if(ctrl.kind==="done"&&incomingFileRef.current){
          const inc=incomingFileRef.current;
          const blob=new Blob(inc.chunks,{type:inc.mime||"application/octet-stream"});
          const url=URL.createObjectURL(blob);
          setMessages(p=>[...p,{id:crypto.randomUUID(),fromUserId:inc.from,toUserId:myId,kind:"file-meta",content:inc.name,downloadUrl:url,ts:Date.now(),expiresAt:Date.now()+TTL}]);
          incomingFileRef.current=null;
        }
      } else if(ev.data instanceof ArrayBuffer&&incomingFileRef.current) incomingFileRef.current.chunks.push(ev.data);
    };
  }

  async function sendPendingFile() {
    const f=pendingFileRef.current, c=fileChanRef.current;
    if(!f||!c||c.readyState!=="open") return;
    c.send(JSON.stringify({kind:"meta",name:f.name,size:f.size,mime:f.type||"application/octet-stream"} satisfies FileCtrl));
    const chunk=16*1024;
    for(let i=0;i<f.size;i+=chunk) c.send(await f.slice(i,i+chunk).arrayBuffer());
    c.send(JSON.stringify({kind:"done"} satisfies FileCtrl));
    pendingFileRef.current=null;
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

      setMessages(prev => [...prev, localMsg]);
      send({ toUserId: selectedUser.userId, type: "chat", payload: jsonPayload });
    };
    reader.onerror = () => {
      alert("Failed to read file.");
    };
    reader.readAsDataURL(file);
  }

  async function doCall(video: boolean) {
    if(!session||!selectedUser){alert("Select a user first");return;}
    try {
      const stream=await getMedia(video);
      const pc=makePc(); callPcRef.current=pc;
      stream.getTracks().forEach(t=>pc.addTrack(t,stream));
      pc.ontrack=e=>{if(remoteVidRef.current)remoteVidRef.current.srcObject=e.streams[0]};
      pc.onicecandidate=e=>{if(e.candidate)send({toUserId:selectedUser.userId,type:"ice",payload:{scope:"call",candidate:e.candidate}})};
      const off=await pc.createOffer(); await pc.setLocalDescription(off);
      send({toUserId:selectedUser.userId,type:"offer",payload:{scope:"call",sdp:off}});
      setInCall(true);
    } catch(e){ alert(e instanceof Error ? e.message : "Call failed"); }
  }

  function endCall() {
    callPcRef.current?.close(); callPcRef.current=null;
    localStreamRef.current?.getTracks().forEach(t=>t.stop()); localStreamRef.current=null;
    setInCall(false); setIncomingFrom(null);
  }

  function sendMsg() {
    if(!session||!selectedUser||!text.trim()) return;
    const msg: ChatMessage = {id:crypto.randomUUID(),fromUserId:session.user.userId,toUserId:selectedUser.userId,kind:"text",content:text.trim(),ts:Date.now(),expiresAt:Date.now()+TTL};
    setMessages(p=>[...p,msg]);
    send({toUserId:selectedUser.userId,type:"chat",payload:text.trim()});
    setText("");
  }

  /* ─── Address Book Handlers ─── */
  const syncWithServer = useCallback(async (currentAddressBook: Record<string, string>) => {
    if (!session) return;
    const phones = Object.keys(currentAddressBook);
    if (phones.length === 0) return;
    try {
      const matched = await syncContacts(phones, session.token);
      setPhoneToUser(prev => {
        const next = { ...prev };
        matched.forEach(u => { next[u.phone] = u.userId; });
        return next;
      });
      setUserToPhone(prev => {
        const next = { ...prev };
        matched.forEach(u => { next[u.userId] = u.phone; });
        return next;
      });
      setContacts(prev => {
        let updated = [...prev];
        matched.forEach(u => {
          if (!updated.find(c => c.userId === u.userId)) {
            updated = [u, ...updated];
          }
        });
        return updated;
      });
    } catch (err) {
      console.error("Sync error:", err);
    }
  }, [session]);

  const addContact = (name: string, phoneStr: string) => {
    const formatted = phoneStr.trim();
    if (!formatted || !name.trim()) return;
    setAddressBook(prev => {
      const next = { ...prev, [formatted]: name.trim() };
      void syncWithServer(next);
      return next;
    });
    setNewContactName("");
    setNewContactPhone("");
  };

  const getResolvedName = useCallback((user: Pick<PublicUser, "userId" | "displayName">) => {
    const p = userToPhone[user.userId];
    if (p && addressBook[p]) return addressBook[p];
    return user.displayName;
  }, [userToPhone, addressBook]);

  const getResolvedPhone = useCallback((userId: string) => {
    const p = userToPhone[userId];
    if (p && addressBook[p]) return p;
    return null;
  }, [userToPhone, addressBook]);

  const syncFromDevice = async () => {
    try {
      if (!('contacts' in navigator && 'ContactsManager' in window)) {
        alert("Your browser does not support native contact picking. Please add contacts manually below.");
        return;
      }
      // @ts-ignore
      const deviceContacts = await navigator.contacts.select(['name', 'tel'], { multiple: true });
      if (deviceContacts && deviceContacts.length > 0) {
        const addedBook: Record<string, string> = { ...addressBook };
        deviceContacts.forEach((c: any) => {
          const name = c.name?.[0] || "Unknown Contact";
          const rawPhone = c.tel?.[0] || "";
          // Strip non-numeric characters except +
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
      alert(
        "Could not access device contacts.\n\n" +
        "Common reasons:\n" +
        "1. Permission was denied/blocked.\n" +
        "2. Browser context restriction.\n\n" +
        "Please use the 'Manage Manual Contacts' button to add contacts manually without any permissions!"
      );
      setShowSyncModal(true);
    }
  };

  async function doSearch(q: string) {
    setQuery(q); if(!session||!q.trim()) return;
    try {
      const res = await searchUsers(q, session.token);
      res.forEach(u=>{ setContacts(prev=>{ if(prev.find(c=>c.userId===u.userId)) return prev; return [u,...prev]; }); });
    } catch { /* ignore */ }
  }

  function selectUser(u: PublicUser) {
    setSelectedUser(u); setUnread(p=>({...p,[u.userId]:0}));
    // Move to top of contacts
    setContacts(prev=>[u,...prev.filter(c=>c.userId!==u.userId)]);
  }

  /* Auth handlers */
  async function doRequestOtp() {
    if(!phone.trim()){setAuthErr("Phone number required");return;} setAuthErr(null);
    try { await requestOtp(phone, authMode as OtpPurpose); setOtpStatus("OTP sent! Use 000000 in test mode."); }
    catch(e){ const m=e instanceof Error?e.message:"Failed"; const r=/try again in (\d+)s/i.exec(m); if(r) setOtpRetry(Number(r[1])); setAuthErr(m); }
  }

  async function doVerifyOtp() {
    if(!phone.trim()||!otpCode.trim()){setAuthErr("Phone and OTP required");return;} setAuthErr(null);
    try { const p=await verifyOtp(phone,authMode as OtpPurpose,otpCode); setOtpProof(p); setOtpStatus("✓ Phone verified"); }
    catch(e){ setAuthErr(e instanceof Error?e.message:"OTP failed"); }
  }

  async function doAuth(e: React.FormEvent) {
    e.preventDefault(); setAuthErr(null);
    if(!otpProof){setAuthErr("Please verify OTP first");return;}
    try {
      const next = authMode==="register"
        ? await register({phone,username,displayName:displayName||username,password,otpProof})
        : await login({phone,password,otpProof});
      setSession(next);
    } catch(e){ setAuthErr(e instanceof Error?e.message:"Auth failed"); }
  }

  async function checkUname() {
    if(!username.trim()){setUnameOk(null);return;} setUnameOk(await checkUsernameAvailability(username));
  }

  /* Profile update */
  async function saveDisplayName() {
    if(!session||!editName.trim()) return;
    const user = await updateProfile(session.token,{displayName:editName.trim()});
    setSession({...session,user:{...session.user,...user}});
    setEditingName(false);
  }

  async function uploadAvatar(file: File) {
    if(!session) return;
    try {
      const b64 = await compressAvatar(file);
      const user = await updateProfile(session.token,{avatarUrl:b64});
      setSession({...session,user:{...session.user,...user}});
    } catch(e){ alert("Failed to upload photo"); }
  }

  /* Computed */
  const activeMessages = useMemo(()=>{
    if(!session||!selectedUser) return [] as ChatMessage[];
    return messages.filter(m=>(m.fromUserId===session.user.userId&&m.toUserId===selectedUser.userId)||(m.fromUserId===selectedUser.userId&&m.toUserId===session.user.userId));
  },[messages,selectedUser,session]);

  const grouped = useMemo(()=>{
    const g: {date:string;msgs:ChatMessage[]}[]=[];
    let last="";
    for(const m of activeMessages){ const d=fmtDate(m.ts); if(d!==last){g.push({date:d,msgs:[]});last=d;} g[g.length-1].msgs.push(m); }
    return g;
  },[activeMessages]);

  const filteredContacts = useMemo(()=>{ if(filterPill==="unread") return contacts.filter(u=>(unread[u.userId]??0)>0); return contacts; },[contacts,filterPill,unread]);

  const lastMsg = (uid: string) => { const all=messages.filter(m=>m.fromUserId===uid||m.toUserId===uid); return all[all.length-1]??null; };

  /* ─── AUTH SCREEN ─── */
  if(!session) return (
    <div className="auth-shell">
      <div className="auth-box">
        <div className="auth-logo"><I.WA/><h1>Zaply</h1></div>
        <p className="auth-subtitle">Privacy-first messenger</p>
        <div className="auth-tabs">
          <button className={authMode==="register"?"active":""} onClick={()=>setAuthMode("register")}>Register</button>
          <button className={authMode==="login"?"active":""} onClick={()=>setAuthMode("login")}>Login</button>
        </div>
        <form className="auth-form" onSubmit={doAuth}>
          <div className="form-group"><label>Mobile Number</label><input value={phone} onChange={e=>setPhone(e.target.value)} placeholder="+91 98765 43210" required/></div>
          {authMode==="register"&&<>
            <div className="form-group"><label>Username</label><input value={username} onChange={e=>setUsername(e.target.value)} onBlur={checkUname} placeholder="unique_username" required/>
              {unameOk!==null&&<span className={`username-hint ${unameOk?"ok":"bad"}`}>{unameOk?"✓ Available":"✗ Already taken"}</span>}</div>
            <div className="form-group"><label>Display Name</label><input value={displayName} onChange={e=>setDisplayName(e.target.value)} placeholder="Your Name" required/></div>
          </>}
          <div className="form-group"><label>Password</label><input type="password" value={password} onChange={e=>setPassword(e.target.value)} placeholder="••••••••" required/></div>
          <div className="form-group"><label>OTP Code</label>
            <div className="otp-row">
              <input value={otpCode} onChange={e=>setOtpCode(e.target.value)} placeholder="000000" maxLength={6}/>
              <button type="button" className="btn-ghost" disabled={otpRetry>0} onClick={()=>void doRequestOtp()}>{otpRetry>0?`Wait ${otpRetry}s`:"Send OTP"}</button>
              <button type="button" className="btn-ghost" onClick={()=>void doVerifyOtp()}>Verify</button>
            </div>
            <div className={`otp-status ${otpProof?"verified":"unverified"}`}>{otpProof?"✓ Phone verified":(otpStatus??"OTP not verified")}</div>
          </div>
          {authErr&&<div className="auth-error">{authErr}</div>}
          <button type="submit" className="btn-primary">{authMode==="register"?"Create Account":"Sign In"}</button>
        </form>
      </div>
    </div>
  );

  /* ─── MAIN APP ─── */
  return (
    <div className={`app-layout ${selectedUser?"chat-open":""}`}>

      {/* ─── Call Overlay ─── */}
      {(inCall||incomingFrom)&&(
        <div className="call-overlay">
          <p style={{color:"white",fontSize:18,fontWeight:500}}>
            {incomingFrom?`📞 Incoming call from ${contacts.find(u=>u.userId===incomingFrom)?.displayName??incomingFrom}`:`📞 Calling ${selectedUser?.displayName??""}`}
          </p>
          <div style={{display:"flex",gap:16}}>
            <video ref={localVidRef} autoPlay playsInline muted/>
            <video ref={remoteVidRef} autoPlay playsInline className="remote"/>
          </div>
          <div style={{display:"flex",gap:12}}>
            {incomingFrom&&<button className="btn-primary" onClick={()=>void doCall(true)}>Accept</button>}
            <button className="btn-ghost" style={{color:"#FF6B6B",borderColor:"#FF6B6B"}} onClick={endCall}>End Call</button>
          </div>
        </div>
      )}

      {/* ─── Settings Overlay ─── */}
      {showSettings&&(
        <div className="settings-overlay" onClick={e=>{if(e.target===e.currentTarget)setShowSettings(false)}}>
          <div className="settings-panel">
            <div className="settings-header">
              <button className="icon-btn" onClick={()=>setShowSettings(false)}><I.Back/></button>
              <h2>Settings</h2>
            </div>
            <div className="settings-body">
              {/* Profile Section */}
              <div className="profile-section">
                <label className="profile-avatar-wrap">
                  <div className="profile-avatar" style={{background:session.user.avatarUrl?undefined:avColor(session.user.displayName)}}>
                    {session.user.avatarUrl?<img src={session.user.avatarUrl} alt=""/>:initials(session.user.displayName)}
                  </div>
                  <div className="profile-avatar-edit">
                    <I.Camera/><span>Change<br/>photo</span>
                    <input type="file" accept="image/*" onChange={e=>{const f=e.target.files?.[0];if(f)void uploadAvatar(f);e.target.value="";}}/>
                  </div>
                </label>
                <div className="profile-name">{session.user.displayName}</div>
                <div className="profile-username">@{session.user.username}</div>
              </div>

              {/* Name Edit */}
              <div className="settings-section">
                <div className="settings-section-title">PROFILE</div>
                {editingName?(
                  <div className="settings-edit-row">
                    <input className="settings-edit-input" value={editName} onChange={e=>setEditName(e.target.value)} autoFocus onKeyDown={e=>e.key==="Enter"&&void saveDisplayName()}/>
                    <button className="save-btn" onClick={()=>void saveDisplayName()}>Save</button>
                    <button className="icon-btn" onClick={()=>setEditingName(false)}>✕</button>
                  </div>
                ):(
                  <div className="settings-item" onClick={()=>{setEditName(session.user.displayName);setEditingName(true);}}>
                    <div className="settings-item-icon"><I.EditPen/></div>
                    <div className="settings-item-info">
                      <div className="settings-item-label">Name</div>
                      <div className="settings-item-value">{session.user.displayName}</div>
                    </div>
                  </div>
                )}
                <div className="settings-item">
                  <div className="settings-item-icon" style={{color:"var(--text-secondary)"}}>@</div>
                  <div className="settings-item-info">
                    <div className="settings-item-label">Username</div>
                    <div className="settings-item-value">{session.user.username}</div>
                  </div>
                </div>
                <div className="settings-item">
                  <div className="settings-item-icon"><I.Phone/></div>
                  <div className="settings-item-info">
                    <div className="settings-item-label">Phone</div>
                    <div className="settings-item-value">{phone||"—"}</div>
                  </div>
                </div>
              </div>

              {/* Theme */}
              <div className="settings-section">
                <div className="settings-section-title">APPEARANCE</div>
                <div className="theme-chips">
                  {THEMES.map(t=>(
                    <button key={t} className={`theme-chip ${session.user.theme===t?"active":""}`} onClick={async()=>{
                      const u=await updateProfile(session.token,{theme:t});
                      setSession({...session,user:{...session.user,...u}});
                    }}>{t}</button>
                  ))}
                </div>
              </div>

              {/* Sync Contacts Section */}
              <div className="settings-section">
                <div className="settings-section-title">CONTACTS</div>
                <div style={{ padding: "0 24px 12px" }}>
                  <button className="btn-primary" style={{ width: "100%", margin: "8px 0" }} onClick={syncFromDevice}>
                    Sync from Device Contacts
                  </button>
                  <button className="btn-ghost" style={{ width: "100%" }} onClick={() => setShowSyncModal(true)}>
                    Manage Manual Contacts ({Object.keys(addressBook).length})
                  </button>
                </div>
              </div>

              {/* Logout */}
              <div className="settings-section">
                <button className="logout-btn" onClick={()=>{localStorage.removeItem("zaply-session");setSession(null);setShowSettings(false);}}>
                  <I.Logout/> Logout
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ─── LEFT PANEL ─── */}
      <div className="left-panel">
        {/* Header */}
        <div className="left-header">
          <div onClick={()=>setShowSettings(true)} style={{cursor:"pointer"}}>
            <Avatar user={session.user} size={40}/>
          </div>
          <span className="left-header-title">Zaply</span>
          <div className="header-actions">
            <button className="icon-btn" title="Settings" onClick={()=>setShowSettings(true)}><I.Settings/></button>
            <button className="icon-btn"><I.Dots/></button>
          </div>
        </div>

        {/* Search */}
        <div className="search-bar">
          <div className="search-input-wrap">
            <I.Search/>
            <input value={query} onChange={e=>void doSearch(e.target.value)} placeholder="Search users to chat"/>
          </div>
        </div>

        {/* Pills */}
        <div className="filter-pills">
          <button className={`pill ${filterPill==="all"?"active":""}`} onClick={()=>setFilterPill("all")}>All</button>
          <button className={`pill ${filterPill==="unread"?"active":""}`} onClick={()=>setFilterPill("unread")}>
            Unread{Object.values(unread).reduce((a,b)=>a+b,0)>0?` (${Object.values(unread).reduce((a,b)=>a+b,0)})`:``}
          </button>
        </div>

        {/* Chat List */}
        <div className="chat-list">
          {filteredContacts.length===0?(
            <div className="empty-chat-list">
              <I.WA/>
              <p>Search for users above to start chatting</p>
            </div>
          ):filteredContacts.map(u=>{
            const lm=lastMsg(u.userId), u_unread=unread[u.userId]??0, isOnline=online.has(u.userId);
            const resolvedName = getResolvedName(u);
            const resolvedPhone = getResolvedPhone(u.userId);
            return (
              <div key={u.userId} className={`chat-item ${selectedUser?.userId===u.userId?"active":""}`} onClick={()=>selectUser(u)}>
                <Avatar user={u} size={49} showDot online={isOnline} resolvedName={resolvedName}/>
                <div className="chat-info">
                  <div className="chat-info-top">
                    <span className="chat-name">{resolvedName}</span>
                    {lm&&<span className="chat-time">{fmtTime(lm.ts)}</span>}
                  </div>
                  <div className="chat-preview">
                    <span className="chat-last-msg">{lm?(lm.kind==="file-meta"?"📎 "+lm.content:lm.content): resolvedPhone ? resolvedPhone : `@${u.username}`}</span>
                    {u_unread>0&&<span className="unread-badge">{u_unread}</span>}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Bottom Nav (mobile) */}
        <div className="bottom-nav">
          <div className="bottom-nav-items">
            <button className={`nav-item ${activeNav==="chats"?"active":""}`} onClick={()=>setActiveNav("chats")}><I.Chats/><span>Chats</span></button>
            <button className={`nav-item ${activeNav==="calls"?"active":""}`} onClick={()=>{setActiveNav("calls");}}><I.Calls/><span>Calls</span></button>
            <button className={`nav-item ${activeNav==="settings"?"active":""}`} onClick={()=>{setActiveNav("settings");setShowSettings(true);}}><I.Settings/><span>Settings</span></button>
          </div>
        </div>
      </div>

      {/* ─── RIGHT PANEL ─── */}
      <div className="right-panel">
        {!selectedUser?(
          <div className="welcome-screen">
            <I.WA/>
            <h2>Zaply Web</h2>
            <p>Click on a chat or search for a user to start messaging</p>
            <p style={{fontSize:13,color:"var(--text-muted)"}}>Logged in as @{session.user.username}</p>
          </div>
        ):<>
          {/* Chat Header */}
          <div className="chat-header">
            <button className="icon-btn back-btn" onClick={()=>setSelectedUser(null)}><I.Back/></button>
            <Avatar user={selectedUser} size={40} showDot online={online.has(selectedUser.userId)} resolvedName={getResolvedName(selectedUser)}/>
            <div className="chat-header-info">
              <div className="chat-header-name">{getResolvedName(selectedUser)}</div>
              <div className={`chat-header-status ${online.has(selectedUser.userId)?"online":""}`}>
                {online.has(selectedUser.userId) ? "online" : getResolvedPhone(selectedUser.userId) ? `${getResolvedPhone(selectedUser.userId)} • @${selectedUser.username}` : `@${selectedUser.username}`}
              </div>
            </div>
            <div className="chat-header-actions">
              <button className="icon-btn" title="Video Call" onClick={()=>void doCall(true)}><I.Video/></button>
              <button className="icon-btn" title="Voice Call" onClick={()=>void doCall(false)}><I.Phone/></button>
              <button className="icon-btn"><I.Dots/></button>
            </div>
          </div>

          {/* Feed */}
          <div className="chat-feed" ref={feedRef}>
            {grouped.length===0&&<div className="empty-chat"><p>👋 Say hello to {getResolvedName(selectedUser)}!</p></div>}
            {grouped.map(g=>(
              <div key={g.date}>
                <div className="date-anchor"><span>{g.date}</span></div>
                {g.msgs.map(m=>{
                  const isMe=m.fromUserId===session.user.userId;
                  return (
                    <div key={m.id} className={`msg-row ${isMe?"outgoing":"incoming"}`}>
                      <div className="msg-bubble">
                        {m.kind==="file-meta"?(
                          (() => {
                            const isImage = m.downloadUrl && m.downloadUrl.startsWith("data:image/");
                            return (
                              <div className="msg-file" style={{ flexDirection: isImage ? "column" : "row", alignItems: "flex-start", gap: 10 }}>
                                {isImage ? (
                                  <img src={m.downloadUrl} alt={m.content} style={{ maxWidth: "100%", maxHeight: "240px", borderRadius: "8px", display: "block", marginBottom: "4px" }} />
                                ) : (
                                  <div className="msg-file-icon"><I.File/></div>
                                )}
                                <div className="msg-file-info" style={{ minWidth: 0 }}>
                                  <span className="msg-file-name" style={{ fontWeight: 500 }}>{m.content}</span>
                                  {m.downloadUrl&&<a href={m.downloadUrl} download={m.content.split(" (")[0]} target="_blank" rel="noreferrer" style={{ display: "inline-block", marginTop: "4px", fontSize: "12px" }}>⬇ Download</a>}
                                </div>
                              </div>
                            );
                          })()
                        ):<span className="msg-text">{m.content}</span>}
                        <div className="msg-meta">
                          <span className="msg-time">{fmtTime(m.ts)}</span>
                          {isMe&&<I.Check blue/>}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>

          {/* Input Dock */}
          <div className="input-dock">
            <label className="file-label" title="Attach file">
              <I.Attach/>
              <input type="file" onChange={e=>{const f=e.target.files?.[0];if(f)doFileShare(f);e.target.value="";}}/>
            </label>
            <div className="input-wrap">
              <input
                value={text}
                onChange={e=>setText(e.target.value)}
                onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();sendMsg();}}}
                placeholder="Type a message"
              />
            </div>
            <button className="send-btn" onClick={text.trim()?sendMsg:()=>void doCall(false)} title={text.trim()?"Send message":"Voice call"}>
              {text.trim()?<I.Send/>:<I.Mic/>}
            </button>
          </div>
        </>}
      </div>

      {/* ─── Sync / Manual Contacts Modal ─── */}
      {showSyncModal && (
        <div className="settings-overlay" onClick={e => { if (e.target === e.currentTarget) setShowSyncModal(false); }}>
          <div className="settings-panel" style={{ background: "var(--header-bg)" }}>
            <div className="settings-header">
              <button className="icon-btn" onClick={() => setShowSyncModal(false)}><I.Back /></button>
              <h2>Address Book</h2>
            </div>
            <div className="settings-body" style={{ padding: "16px 20px" }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 20 }}>
                <h3 style={{ fontSize: 13, color: "var(--green)" }}>ADD NEW CONTACT</h3>
                <input
                  className="settings-edit-input"
                  style={{ borderRadius: 6 }}
                  placeholder="Contact Name (e.g. Dad)"
                  value={newContactName}
                  onChange={e => setNewContactName(e.target.value)}
                />
                <input
                  className="settings-edit-input"
                  style={{ borderRadius: 6 }}
                  placeholder="Phone Number (e.g. 9805035450)"
                  value={newContactPhone}
                  onChange={e => setNewContactPhone(e.target.value)}
                />
                <button className="btn-primary" onClick={() => addContact(newContactName, newContactPhone)}>
                  Add & Sync
                </button>
              </div>

              <h3 style={{ fontSize: 13, color: "var(--green)", marginBottom: 10 }}>SAVED CONTACTS ({Object.keys(addressBook).length})</h3>
              <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: "calc(100vh - 320px)", overflowY: "auto" }}>
                {Object.keys(addressBook).length === 0 ? (
                  <p style={{ color: "var(--text-muted)", fontSize: 13 }}>No contacts saved yet.</p>
                ) : (
                  Object.entries(addressBook).map(([ph, name]) => {
                    const matchedUserId = phoneToUser[ph];
                    return (
                      <div key={ph} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: "var(--panel-bg)", padding: "10px 12px", borderRadius: 8 }}>
                        <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                          <span style={{ fontWeight: 500, fontSize: 15 }}>{name}</span>
                          <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>{ph}</span>
                          {matchedUserId ? (
                            <span style={{ fontSize: 11, color: "var(--teal)", fontWeight: 500 }}>✓ Registered on Zaply</span>
                          ) : (
                            <span style={{ fontSize: 11, color: "var(--text-muted)" }}>Not registered</span>
                          )}
                        </div>
                        <button className="icon-btn" style={{ color: "#FF6B6B" }} onClick={() => {
                          setAddressBook(prev => {
                            const next = { ...prev };
                            delete next[ph];
                            return next;
                          });
                        }}>✕</button>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
