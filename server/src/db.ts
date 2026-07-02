import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

let connected = false;
let memoryServer: MongoMemoryServer | null = null;

export async function connectDatabase(): Promise<void> {
  if (connected) {
    return;
  }
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    // In production (Render), always require MONGODB_URI.
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "[STARTUP ERROR] MONGODB_URI environment variable is not set. " +
        "Go to Render Dashboard → zaply-backend → Environment → Add MONGODB_URI."
      );
    }
    // Local development fallback only.
    console.warn("[DEV] MONGODB_URI not set. Using in-memory MongoDB.");
    memoryServer = await MongoMemoryServer.create();
    await mongoose.connect(memoryServer.getUri());
    connected = true;
    return;
  }

  console.log("[DB] Connecting to MongoDB...");
  try {
    await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 10000 });
    console.log("[DB] Connected to MongoDB successfully.");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `[STARTUP ERROR] Failed to connect to MongoDB: ${msg}\n` +
      "Check: 1) MONGODB_URI is correct  2) Atlas Network Access allows 0.0.0.0/0"
    );
  }
  connected = true;
}

export async function disconnectDatabase(): Promise<void> {
  if (connected) {
    await mongoose.disconnect();
    connected = false;
  }
  if (memoryServer) {
    await memoryServer.stop();
    memoryServer = null;
  }
}
