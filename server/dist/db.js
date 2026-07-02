import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
let connected = false;
let memoryServer = null;
export async function connectDatabase() {
    if (connected) {
        return;
    }
    const mongoUri = process.env.MONGODB_URI;
    if (!mongoUri) {
        if (process.env.NODE_ENV === "production") {
            throw new Error("MONGODB_URI environment variable is required in production. " +
                "Please set it in your Render dashboard under Environment Variables.");
        }
        // Local fallback: use in-memory MongoDB for development only.
        console.warn("MONGODB_URI not set. Using in-memory MongoDB for local development.");
        memoryServer = await MongoMemoryServer.create();
        await mongoose.connect(memoryServer.getUri());
        connected = true;
        return;
    }
    await mongoose.connect(mongoUri);
    connected = true;
}
export async function disconnectDatabase() {
    if (connected) {
        await mongoose.disconnect();
        connected = false;
    }
    if (memoryServer) {
        await memoryServer.stop();
        memoryServer = null;
    }
}
