import twilio from "twilio";

type OtpPurpose = "register" | "login";

const OTP_PROVIDER_MODE = (process.env.OTP_PROVIDER_MODE ?? "twilio").toLowerCase();
const OTP_TEST_CODE = process.env.OTP_TEST_CODE ?? "000000";

function getTwilioClient() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const verifyServiceSid = process.env.TWILIO_VERIFY_SERVICE_SID;

  if (!sid || !token || !verifyServiceSid) {
    throw new Error("Twilio Verify is not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_VERIFY_SERVICE_SID");
  }

  return {
    client: twilio(sid, token),
    verifyServiceSid
  };
}

function sanitizeOtpError(error: unknown): Error {
  if (error && typeof error === "object" && "code" in error) {
    const code = String((error as { code?: unknown }).code ?? "");
    if (code === "60203" || code === "60200") {
      return new Error("OTP rate limit reached. Please wait and try again.");
    }
    if (code === "20404") {
      return new Error("OTP service is not configured correctly.");
    }
  }
  return new Error("OTP service unavailable");
}

export async function requestOtp(phone: string): Promise<void> {
  if (OTP_PROVIDER_MODE === "test") {
    // In test mode no SMS is sent.
    return;
  }

  const { client, verifyServiceSid } = getTwilioClient();
  try {
    await client.verify.v2.services(verifyServiceSid).verifications.create({
      to: phone,
      channel: "sms"
    });
  } catch (error) {
    throw sanitizeOtpError(error);
  }
}

export async function verifyOtp(phone: string, code: string, _purpose: OtpPurpose): Promise<boolean> {
  if (OTP_PROVIDER_MODE === "test") {
    return code === OTP_TEST_CODE;
  }

  const { client, verifyServiceSid } = getTwilioClient();
  try {
    const check = await client.verify.v2.services(verifyServiceSid).verificationChecks.create({
      to: phone,
      code
    });
    return check.status === "approved";
  } catch (error) {
    throw sanitizeOtpError(error);
  }
}

export type { OtpPurpose };
