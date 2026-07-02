import jwt from "jsonwebtoken";
import type { Response, Request } from "express";
import type { AuthPayload } from "./types.js";

const secret = process.env.JWT_SECRET ?? "dev-secret";

type OtpProofPayload = {
  phone: string;
  purpose: "register" | "login";
};

export function signToken(payload: AuthPayload): string {
  return jwt.sign(payload, secret, { expiresIn: "7d" });
}

export function signOtpProof(payload: OtpProofPayload): string {
  return jwt.sign(payload, secret, { expiresIn: "10m" });
}

export function parseAuthHeader(header?: string): string | null {
  if (!header) {
    return null;
  }
  const [prefix, token] = header.split(" ");
  if (prefix !== "Bearer" || !token) {
    return null;
  }
  return token;
}

export function verifyToken(token: string): AuthPayload {
  return jwt.verify(token, secret) as AuthPayload;
}

export function verifyOtpProof(token: string): OtpProofPayload {
  return jwt.verify(token, secret) as OtpProofPayload;
}

export function readUserFromRequest(req: Request): AuthPayload {
  const token = parseAuthHeader(req.header("authorization") || undefined);
  if (!token) {
    throw new Error("Unauthorized");
  }
  return verifyToken(token);
}

export function unauthorized(res: Response, message = "Unauthorized"): void {
  res.status(401).json({ error: message });
}
