import mongoose from "mongoose";
let connected = false;
export async function connectDatabase() {
    if (connected) {
        return;
    }
    const mongoUri = process.env.MONGODB_URI;
    if (!mongoUri) {
        throw new Error("MONGODB_URI is required");
    }
    await mongoose.connect(mongoUri);
    connected = true;
}
