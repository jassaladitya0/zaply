import jwt from "jsonwebtoken";
const secret = process.env.JWT_SECRET ?? "dev-secret";
export function signToken(payload) {
    return jwt.sign(payload, secret, { expiresIn: "7d" });
}
export function signOtpProof(payload) {
    return jwt.sign(payload, secret, { expiresIn: "10m" });
}
export function parseAuthHeader(header) {
    if (!header) {
        return null;
    }
    const [prefix, token] = header.split(" ");
    if (prefix !== "Bearer" || !token) {
        return null;
    }
    return token;
}
export function verifyToken(token) {
    return jwt.verify(token, secret);
}
export function verifyOtpProof(token) {
    return jwt.verify(token, secret);
}
export function readUserFromRequest(req) {
    const token = parseAuthHeader(req.header("authorization") || undefined);
    if (!token) {
        throw new Error("Unauthorized");
    }
    return verifyToken(token);
}
export function unauthorized(res, message = "Unauthorized") {
    res.status(401).json({ error: message });
}
