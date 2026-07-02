import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

let connected = false;
let memoryServer: MongoMemoryServer | null = null;

export async function connectDatabase(): Promise<void> {
  if (connected) {
    return;
  }
  let mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    memoryServer = await MongoMemoryServer.create();
    mongoUri = memoryServer.getUri();
    // Local fallback DB for development only.
    console.warn("MONGODB_URI not set. Using in-memory MongoDB for local development.");
  }
  await mongoose.connect(mongoUri);
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
