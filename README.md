# WhatsApp-style Clone (Zaply)

This is a full-stack TypeScript app with:
- Mobile number auth + Twilio Verify OTP + unique username
- Number hidden from other users (username identity only)
- Real-time messaging via Socket.IO
- Audio/video calling via WebRTC signaling
- Real P2P file transfer (images/videos/audio/docs) via WebRTC DataChannel
- 24-hour auto-delete policy for local message history
- Themes + profile settings
- MongoDB persistence for account/profile only

## Important privacy architecture

- Server stores only account details (phone, username, profile settings, password hash) in MongoDB.
- Chat content is **not persisted in database**.
- Message text is routed live through sockets and held only in user runtime state.
- File binary data is exchanged directly between peers using WebRTC DataChannel.
- Each message envelope carries expiry and client clears history after 24h.

## Environment setup

Copy [server/.env.example](server/.env.example) to `server/.env` and configure:
- MONGODB_URI
- TWILIO_ACCOUNT_SID
- TWILIO_AUTH_TOKEN
- TWILIO_VERIFY_SERVICE_SID
- OTP_PROVIDER_MODE (twilio or test)
- OTP_TEST_CODE (used only in test mode)

Optional client TURN setup for better call/file connectivity in restricted networks:
- Copy [client/.env.example](client/.env.example) to `client/.env`
- Configure `VITE_TURN_URL`, `VITE_TURN_USERNAME`, `VITE_TURN_CREDENTIAL`

## Deploy (Render + Vercel)

1. MongoDB Atlas
- Create Atlas cluster and database user.
- Add IP access rule for deployment platforms.
- Copy connection string and set as MONGODB_URI.

2. Deploy backend on Render
- Push repository to GitHub.
- In Render, create new Web Service from repo.
- Render can auto-detect [render.yaml](render.yaml).
- Set manual env values in Render dashboard:
	- CLIENT_ORIGIN = your Vercel app URL (for example https://your-app.vercel.app)
	- MONGODB_URI = Atlas URI
	- JWT_SECRET = long random secret
	- TWILIO_ACCOUNT_SID
	- TWILIO_AUTH_TOKEN
	- TWILIO_VERIFY_SERVICE_SID
	- OTP_PROVIDER_MODE = twilio (production) or test (testing)
	- OTP_TEST_CODE = only for test mode
- After deploy, note backend URL, for example https://zaply-backend.onrender.com

3. Deploy frontend on Vercel
- In Vercel, import same repository.
- Set Root Directory to client.
- Vercel will use [client/vercel.json](client/vercel.json).
- Add frontend env vars in Vercel project:
	- VITE_API_BASE_URL = your Render backend URL
	- VITE_SIGNALING_BASE_URL = your Render backend URL
	- VITE_STUN_URL = stun:stun.l.google.com:19302
	- VITE_TURN_URL, VITE_TURN_USERNAME, VITE_TURN_CREDENTIAL (optional but recommended)

4. Twilio Verify setup
- Create Verify Service in Twilio.
- Enable SMS channel.
- Use the Verify Service SID in server env.

5. TURN for production reliability
- Configure TURN provider credentials and set them in Vercel env vars.
- Keep STUN + TURN together for better NAT traversal.

6. Final verification
- Open frontend URL and register/login with OTP.
- Test messaging, call, video, and file transfer between two real devices.
- Confirm phone numbers are not shown in UI and only usernames appear.

## Run locally

1. Install dependencies:

```bash
npm install
```

2. Start backend + frontend:

```bash
npm run dev
```

3. Open frontend: `http://localhost:5173`

Backend runs on `http://localhost:4000`.

If `MONGODB_URI` is not set locally, backend automatically starts an in-memory MongoDB instance for development.

## Production notes

- Replace basic password hashing with `argon2` or `bcrypt`.
- OTP hardening included: resend cooldown, hourly OTP cap, OTP verify lockout, login lockout.
- Twilio mode toggle included (`twilio` live mode, `test` local mode).
- Add TURN server for robust WebRTC in restricted networks.
- Use E2E encryption keys for message payloads.
- For strict 24h deletion guarantees, enforce retention at edge relay/service worker level too.
