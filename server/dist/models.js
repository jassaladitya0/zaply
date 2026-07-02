import mongoose, { Schema } from "mongoose";
const accountSchema = new Schema({
    userId: { type: String, required: true, unique: true, index: true },
    phone: { type: String, required: true, unique: true, index: true },
    username: { type: String, required: true, unique: true, index: true },
    displayName: { type: String, required: true },
    passwordHash: { type: String, required: true },
    avatarUrl: { type: String, required: false },
    theme: { type: String, enum: ["sand", "forest", "sunset"], default: "sand", required: true },
    createdAt: { type: Number, required: true }
}, {
    versionKey: false,
    collection: "accounts"
});
export const AccountModel = mongoose.models.Account ?? mongoose.model("Account", accountSchema);
