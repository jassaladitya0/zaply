import { useEffect, useMemo, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { checkUsernameAvailability, login, register, requestOtp, searchUsers, updateProfile, verifyOtp } from "./api";
import type { ChatMessage, OtpPurpose, PublicUser, Session, SignalPayload, SignalScope, Theme } from "./types";

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

type ScopedOffer = {
  scope: SignalScope;
  sdp: RTCSessionDescriptionInit;
};

type ScopedAnswer = {
  scope: SignalScope;
  sdp: RTCSessionDescriptionInit;
};

type ScopedIce = {
  scope: SignalScope;
  candidate: RTCIceCandidateInit;
};

type FileControlMessage =
  | { kind: "meta"; name: string; size: number; mime: string }
  | { kind: "done" };

function resolveIceServers(): RTCIceServer[] {
  const json = import.meta.env.VITE_RTC_ICE_SERVERS_JSON as string | undefined;
  if (json) {
    try {
      const parsed = JSON.parse(json) as RTCIceServer[];
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed;
      }
    } catch {
      // Fallback to individual env vars.
    }
  }

  const servers: RTCIceServer[] = [];
  const stunUrl = (import.meta.env.VITE_STUN_URL as string | undefined) || "stun:stun.l.google.com:19302";
  servers.push({ urls: stunUrl });

  const turnUrl = import.meta.env.VITE_TURN_URL as string | undefined;
  const turnUsername = import.meta.env.VITE_TURN_USERNAME as string | undefined;
  const turnCredential = import.meta.env.VITE_TURN_CREDENTIAL as string | undefined;
  if (turnUrl && turnUsername && turnCredential) {
    servers.push({
      urls: turnUrl,
      username: turnUsername,
      credential: turnCredential
    });
  }

  return servers;
}

const ICE_SERVERS = resolveIceServers();

const TTL_MS = 24 * 60 * 60 * 1000;
const themeOptions: Theme[] = ["sand", "forest", "sunset"];
const SIGNALING_BASE_URL = (import.meta.env.VITE_SIGNALING_BASE_URL as string | undefined) ?? "http://localhost:4000";

function createCallPeerConnection(localStream: MediaStream, onRemote: (stream: MediaStream) => void) {
  const pc = new RTCPeerConnection({
    iceServers: ICE_SERVERS
  });

  localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
  pc.ontrack = (event) => {
    onRemote(event.streams[0]);
  };
  return pc;
}

function createDataPeerConnection() {
  return new RTCPeerConnection({
    iceServers: ICE_SERVERS
  });
}

export function App() {
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
  const [users, setUsers] = useState<PublicUser[]>([]);
  const [selectedUser, setSelectedUser] = useState<PublicUser | null>(null);
  const [query, setQuery] = useState("");
  const [text, setText] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [incomingCallFrom, setIncomingCallFrom] = useState<string | null>(null);

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

  useEffect(() => {
    const saved = localStorage.getItem("zaply-session");
    if (saved) {
      setSession(JSON.parse(saved));
    }
  }, []);

  const activeOtpPurpose: OtpPurpose = mode === "register" ? "register" : "login";

  useEffect(() => {
    setOtpCode("");
    setOtpProof("");
    setOtpStatus(null);
    setOtpRetryAfterSec(0);
  }, [mode, phone]);

  useEffect(() => {
    if (otpRetryAfterSec <= 0) {
      return;
    }
    const timer = window.setTimeout(() => setOtpRetryAfterSec((x) => Math.max(0, x - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [otpRetryAfterSec]);

  useEffect(() => {
    if (!session) {
      socketRef.current?.disconnect();
      socketRef.current = null;
      return;
    }

    localStorage.setItem("zaply-session", JSON.stringify(session));
    const socket = io(SIGNALING_BASE_URL, {
      auth: { token: session.token }
    });
    socketRef.current = socket;

    socket.on("signal:receive", async (packet: SignalReceive) => {
      const { fromUserId, envelope } = packet;

      if (envelope.type === "chat") {
        const content = String(envelope.payload);
        setMessages((prev) =>
          prev.concat({
            id: crypto.randomUUID(),
            fromUserId,
            toUserId: session.user.userId,
            kind: "text",
            content,
            ts: Date.now(),
            expiresAt: envelope.expiresAt ?? Date.now() + TTL_MS
          })
        );
      }

      if (envelope.type === "file-meta") {
        const metadata = envelope.payload as { name: string; size: number; mime: string };
        setMessages((prev) =>
          prev.concat({
            id: crypto.randomUUID(),
            fromUserId,
            toUserId: session.user.userId,
            kind: "file-meta",
            content: `${metadata.name} (${Math.round(metadata.size / 1024)} KB)` ,
            ts: Date.now(),
            expiresAt: envelope.expiresAt ?? Date.now() + TTL_MS
          })
        );
      }

      if (envelope.type === "offer") {
        const payload = envelope.payload as ScopedOffer;
        if (payload.scope === "call") {
          setIncomingCallFrom(fromUserId);
          await ensureLocalMedia(true);
          const pc = createCallPeerConnection(localStreamRef.current!, setRemoteStream);
          callPcRef.current = pc;
          pc.onicecandidate = (event) => {
            if (event.candidate) {
              sendSignal({ toUserId: fromUserId, type: "ice", payload: { scope: "call", candidate: event.candidate } });
            }
          };
          await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          sendSignal({ toUserId: fromUserId, type: "answer", payload: { scope: "call", sdp: answer } });
        }

        if (payload.scope === "file") {
          filePeerUserIdRef.current = fromUserId;
          const pc = createDataPeerConnection();
          filePcRef.current = pc;
          pc.ondatachannel = (event) => {
            setupFileChannel(event.channel, session.user.userId);
          };
          pc.onicecandidate = (event) => {
            if (event.candidate) {
              sendSignal({ toUserId: fromUserId, type: "ice", payload: { scope: "file", candidate: event.candidate } });
            }
          };
          await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          sendSignal({ toUserId: fromUserId, type: "answer", payload: { scope: "file", sdp: answer } });
        }
      }

      if (envelope.type === "answer") {
        const payload = envelope.payload as ScopedAnswer;
        if (payload.scope === "call" && callPcRef.current) {
          await callPcRef.current.setRemoteDescription(new RTCSessionDescription(payload.sdp));
        }
        if (payload.scope === "file" && filePcRef.current) {
          await filePcRef.current.setRemoteDescription(new RTCSessionDescription(payload.sdp));
        }
      }

      if (envelope.type === "ice") {
        const payload = envelope.payload as ScopedIce;
        if (payload.scope === "call" && callPcRef.current) {
          await callPcRef.current.addIceCandidate(new RTCIceCandidate(payload.candidate));
        }
        if (payload.scope === "file" && filePcRef.current) {
          await filePcRef.current.addIceCandidate(new RTCIceCandidate(payload.candidate));
        }
      }
    });

    return () => {
      socket.disconnect();
    };
  }, [session]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const now = Date.now();
      setMessages((prev) => prev.filter((m) => m.expiresAt > now));
    }, 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const activeMessages = useMemo(() => {
    if (!session || !selectedUser) {
      return [] as ChatMessage[];
    }
    return messages.filter(
      (m) =>
        (m.fromUserId === session.user.userId && m.toUserId === selectedUser.userId) ||
        (m.fromUserId === selectedUser.userId && m.toUserId === session.user.userId)
    );
  }, [messages, selectedUser, session]);

  async function ensureLocalMedia(video: boolean) {
    if (localStreamRef.current) {
      return localStreamRef.current;
    }
    const stream = await navigator.mediaDevices.getUserMedia({ video, audio: true });
    localStreamRef.current = stream;
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = stream;
    }
    return stream;
  }

  function setRemoteStream(stream: MediaStream) {
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = stream;
    }
  }

  function sendSignal(payload: SignalPayload) {
    socketRef.current?.emit("signal:send", payload);
  }

  function setupFileChannel(channel: RTCDataChannel, currentUserId: string) {
    fileChannelRef.current = channel;
    channel.binaryType = "arraybuffer";

    channel.onopen = () => {
      void sendPendingFileIfAny();
    };

    channel.onmessage = (event) => {
      if (typeof event.data === "string") {
        const control = JSON.parse(event.data) as FileControlMessage;
        if (control.kind === "meta") {
          incomingTransferRef.current = {
            name: control.name,
            mime: control.mime,
            chunks: [],
            fromUserId: filePeerUserIdRef.current ?? "unknown"
          };
        }
        if (control.kind === "done" && incomingTransferRef.current) {
          const incoming = incomingTransferRef.current;
          const blob = new Blob(incoming.chunks, { type: incoming.mime || "application/octet-stream" });
          const downloadUrl = URL.createObjectURL(blob);
          setMessages((prev) =>
            prev.concat({
              id: crypto.randomUUID(),
              fromUserId: incoming.fromUserId,
              toUserId: currentUserId,
              kind: "file-meta",
              content: `${incoming.name} (${Math.round(blob.size / 1024)} KB)`,
              downloadUrl,
              ts: Date.now(),
              expiresAt: Date.now() + TTL_MS
            })
          );
          incomingTransferRef.current = null;
        }
        return;
      }

      if (event.data instanceof ArrayBuffer && incomingTransferRef.current) {
        incomingTransferRef.current.chunks.push(event.data);
      }
    };
  }

  async function sendPendingFileIfAny() {
    const file = pendingOutgoingFileRef.current;
    const channel = fileChannelRef.current;
    if (!file || !channel || channel.readyState !== "open") {
      return;
    }

    channel.send(
      JSON.stringify({
        kind: "meta",
        name: file.name,
        size: file.size,
        mime: file.type || "application/octet-stream"
      } satisfies FileControlMessage)
    );

    const chunkSize = 16 * 1024;
    for (let offset = 0; offset < file.size; offset += chunkSize) {
      const chunk = file.slice(offset, offset + chunkSize);
      channel.send(await chunk.arrayBuffer());
    }
    channel.send(JSON.stringify({ kind: "done" } satisfies FileControlMessage));
    pendingOutgoingFileRef.current = null;
  }

  function resetFilePeer() {
    fileChannelRef.current?.close();
    filePcRef.current?.close();
    fileChannelRef.current = null;
    filePcRef.current = null;
  }

  async function startFilePeerOffer(targetUserId: string) {
    resetFilePeer();
    filePeerUserIdRef.current = targetUserId;
    const pc = createDataPeerConnection();
    filePcRef.current = pc;
    const channel = pc.createDataChannel("file");
    setupFileChannel(channel, session!.user.userId);
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        sendSignal({ toUserId: targetUserId, type: "ice", payload: { scope: "file", candidate: event.candidate } });
      }
    };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendSignal({ toUserId: targetUserId, type: "offer", payload: { scope: "file", sdp: offer } });
  }

  async function handleAuthSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!otpProof) {
      setError("Verify OTP first");
      return;
    }
    try {
      const next =
        mode === "register"
          ? await register({ phone, username, displayName: displayName || username, password, otpProof })
          : await login({ phone, password, otpProof });
      setSession(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Auth failed");
    }
  }

  async function handleSearch() {
    if (!session || !query.trim()) {
      setUsers([]);
      return;
    }
    const result = await searchUsers(query, session.token);
    setUsers(result);
  }

  function handleSendMessage() {
    if (!session || !selectedUser || !text.trim()) {
      return;
    }
    const msg: ChatMessage = {
      id: crypto.randomUUID(),
      fromUserId: session.user.userId,
      toUserId: selectedUser.userId,
      kind: "text",
      content: text,
      ts: Date.now(),
      expiresAt: Date.now() + TTL_MS
    };
    setMessages((prev) => prev.concat(msg));
    sendSignal({ toUserId: selectedUser.userId, type: "chat", payload: text });
    setText("");
  }

  function handleFileShare(file: File) {
    if (!session || !selectedUser) {
      return;
    }
    const msg: ChatMessage = {
      id: crypto.randomUUID(),
      fromUserId: session.user.userId,
      toUserId: selectedUser.userId,
      kind: "file-meta",
      content: `${file.name} (${Math.round(file.size / 1024)} KB)`,
      ts: Date.now(),
      expiresAt: Date.now() + TTL_MS
    };
    setMessages((prev) => prev.concat(msg));

    pendingOutgoingFileRef.current = file;
    filePeerUserIdRef.current = selectedUser.userId;

    if (fileChannelRef.current?.readyState === "open") {
      void sendPendingFileIfAny();
      return;
    }

    void startFilePeerOffer(selectedUser.userId);
  }

  async function startCall(video: boolean) {
    if (!session || !selectedUser) {
      return;
    }
    const stream = await ensureLocalMedia(video);
    const pc = createCallPeerConnection(stream, setRemoteStream);
    callPcRef.current = pc;
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        sendSignal({ toUserId: selectedUser.userId, type: "ice", payload: { scope: "call", candidate: event.candidate } });
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendSignal({ toUserId: selectedUser.userId, type: "offer", payload: { scope: "call", sdp: offer } });
  }

  function endCall() {
    callPcRef.current?.close();
    callPcRef.current = null;
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
    setIncomingCallFrom(null);
  }

  async function handleRequestOtp() {
    try {
      if (!phone.trim()) {
        setError("Phone is required for OTP");
        return;
      }
      setError(null);
      await requestOtp(phone, activeOtpPurpose);
      setOtpStatus("OTP sent successfully.");
      setOtpRetryAfterSec(0);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to send OTP";
      const match = /try again in (\d+)s/i.exec(message);
      if (match) {
        setOtpRetryAfterSec(Number(match[1]));
      }
      setError(message);
    }
  }

  async function handleVerifyOtp() {
    try {
      if (!phone.trim() || !otpCode.trim()) {
        setError("Phone and OTP code are required");
        return;
      }
      setError(null);
      const proof = await verifyOtp(phone, activeOtpPurpose, otpCode);
      setOtpProof(proof);
      setOtpStatus("Phone verification complete.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "OTP verification failed");
    }
  }

  async function applyTheme(theme: Theme) {
    if (!session) {
      return;
    }
    await updateProfile(session.token, { theme });
    const next = { ...session, user: { ...session.user, theme } };
    setSession(next);
  }

  async function checkUsername() {
    if (!username.trim()) {
      setUsernameAvailable(null);
      return;
    }
    const available = await checkUsernameAvailability(username);
    setUsernameAvailable(available);
  }

  if (!session) {
    return (
      <main className="shell">
        <section className="auth-card">
          <h1>Zaply</h1>
          <p>Privacy-first messenger with username identity.</p>
          <div className="tabs">
            <button className={mode === "register" ? "active" : ""} onClick={() => setMode("register")}>Register</button>
            <button className={mode === "login" ? "active" : ""} onClick={() => setMode("login")}>Login</button>
          </div>
          <form onSubmit={handleAuthSubmit}>
            <label>
              Mobile Number
              <input value={phone} onChange={(e) => setPhone(e.target.value)} required />
            </label>
            {mode === "register" && (
              <label>
                Username (unique)
                <input value={username} onBlur={checkUsername} onChange={(e) => setUsername(e.target.value)} required />
              </label>
            )}
            {mode === "register" && usernameAvailable !== null && (
              <small className={usernameAvailable ? "ok" : "bad"}>{usernameAvailable ? "Username available" : "Username already in use"}</small>
            )}
            {mode === "register" && (
              <label>
                Display Name
                <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} required />
              </label>
            )}
            <label>
              Password
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </label>
            <label>
              OTP Code
              <input value={otpCode} onChange={(e) => setOtpCode(e.target.value)} placeholder="6-digit OTP" required />
            </label>
            <div className="otp-row">
              <button type="button" disabled={otpRetryAfterSec > 0} onClick={() => void handleRequestOtp()}>
                {otpRetryAfterSec > 0 ? `Request OTP (${otpRetryAfterSec}s)` : "Request OTP"}
              </button>
              <button type="button" onClick={() => void handleVerifyOtp()}>Verify OTP</button>
            </div>
            <small className={otpProof ? "ok" : "bad"}>{otpStatus ?? (otpProof ? "OTP verified" : "OTP not verified")}</small>
            {error && <p className="bad">{error}</p>}
            {!otpProof && <p className="bad">Verify OTP before submitting.</p>}
            <button type="submit">{mode === "register" ? "Create Account" : "Sign In"}</button>
          </form>
        </section>
      </main>
    );
  }

  return (
    <main className={`app theme-${session.user.theme ?? "sand"}`}>
      <aside className="left-pane">
        <h2>@{session.user.username}</h2>
        <input
          placeholder="Search users by username"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyUp={handleSearch}
        />
        <ul>
          {users.map((u) => (
            <li key={u.userId} className={selectedUser?.userId === u.userId ? "active" : ""} onClick={() => setSelectedUser(u)}>
              <span>{u.displayName}</span>
              <small>@{u.username}</small>
            </li>
          ))}
        </ul>
        <div className="settings">
          <p>Theme</p>
          <div className="chips">
            {themeOptions.map((t) => (
              <button key={t} onClick={() => applyTheme(t)}>{t}</button>
            ))}
          </div>
          <button onClick={() => { localStorage.removeItem("zaply-session"); setSession(null); }}>Logout</button>
        </div>
      </aside>

      <section className="chat-pane">
        <header>
          {selectedUser ? <h3>{selectedUser.displayName} (@{selectedUser.username})</h3> : <h3>Select a user</h3>}
          <div className="call-actions">
            <button disabled={!selectedUser} onClick={() => startCall(false)}>Audio Call</button>
            <button disabled={!selectedUser} onClick={() => startCall(true)}>Video Call</button>
            <button onClick={endCall}>End</button>
          </div>
        </header>

        <div className="messages">
          {activeMessages.map((m) => (
            <article key={m.id} className={m.fromUserId === session.user.userId ? "me" : "them"}>
              <p>{m.content}</p>
              {m.downloadUrl && (
                <a href={m.downloadUrl} download target="_blank" rel="noreferrer">
                  Download file
                </a>
              )}
              <time>{new Date(m.ts).toLocaleTimeString()}</time>
            </article>
          ))}
        </div>

        <footer>
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Type a message" />
          <input
            type="file"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) {
                handleFileShare(file);
              }
            }}
          />
          <button onClick={handleSendMessage}>Send</button>
        </footer>

        <div className="call-stage">
          <video ref={localVideoRef} autoPlay playsInline muted />
          <video ref={remoteVideoRef} autoPlay playsInline />
        </div>
        {incomingCallFrom && <p className="incoming">Incoming call from {incomingCallFrom}</p>}
      </section>
    </main>
  );
}
