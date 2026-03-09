import Fastify from "fastify";
import cors from "@fastify/cors";
import formbody from "@fastify/formbody";
import fastifyStatic from "@fastify/static";
import dotenv from "dotenv";
import twilio from "twilio";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import OpenAI from "openai";
import nodemailer from "nodemailer";

dotenv.config();

const app = Fastify({ logger: true });

app.register(cors, { origin: true });
app.register(formbody);
app.register(fastifyStatic, {
  root: path.join(process.cwd(), "public"),
  prefix: "/",
});

const PORT = Number(process.env.PORT || 3000);
const BASE_URL = (process.env.BASE_URL || "").trim();

const COMPANY_NAME = (process.env.COMPANY_NAME || "E&E HVAC").trim();
const DIAGNOSTIC_FEE = (process.env.DIAGNOSTIC_FEE || "$99").trim();
const HOURS = (
  process.env.HOURS || "Monday through Friday, 8 AM to 6 PM"
).trim();
const SERVICE_AREAS = (
  process.env.SERVICE_AREAS || "Orlando and surrounding areas"
).trim();

const ELEVENLABS_API_KEY = (process.env.ELEVENLABS_API_KEY || "").trim();
const ELEVENLABS_VOICE_ID = (
  process.env.ELEVENLABS_VOICE_ID || "xKhbyU7E3bC6T89Kn26c"
).trim();

const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
const OPENAI_MODEL = (process.env.OPENAI_MODEL || "gpt-4o-mini").trim();

const TWILIO_ACCOUNT_SID = (process.env.TWILIO_ACCOUNT_SID || "").trim();
const TWILIO_AUTH_TOKEN = (process.env.TWILIO_AUTH_TOKEN || "").trim();
const FROM_NUMBER = (process.env.FROM_NUMBER || "").trim();

const RESEND_SMTP_USER = (process.env.RESEND_SMTP_USER || "").trim();
const RESEND_SMTP_PASS = (process.env.RESEND_SMTP_PASS || "").trim();
const CONFIRMATION_EMAIL_FROM = (
  process.env.CONFIRMATION_EMAIL_FROM || ""
).trim();

const HUBSPOT_API_KEY = (process.env.HUBSPOT_API_KEY || "").trim();

const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

const smsClient =
  TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN
    ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
    : null;

const mailTransport =
  RESEND_SMTP_USER && RESEND_SMTP_PASS
    ? nodemailer.createTransport({
        host: "smtp.resend.com",
        port: 465,
        secure: true,
        auth: {
          user: RESEND_SMTP_USER,
          pass: RESEND_SMTP_PASS,
        },
      })
    : null;

type BookingRecord = {
  id: string;
  callSid: string;
  callerPhone?: string;
  name?: string;
  issue?: string;
  time?: string;
  address?: string;
  email?: string;
  status: "pending" | "confirmed" | "cancelled" | "reschedule_requested";
  createdAt: string;
};

type Stage =
  | "normal"
  | "offer_booking"
  | "book_name"
  | "book_issue"
  | "book_time"
  | "book_address"
  | "book_email"
  | "book_confirm"
  | "reschedule_new_time";

type Session = {
  callSid: string;
  callerPhone?: string;
  stage: Stage;
  greeted: boolean;
  noSpeechCount: number;
  booking: BookingRecord;
};

type IntentResult = {
  intent:
    | "pricing_specific"
    | "pricing_broad"
    | "repair_pricing_general"
    | "availability_question"
    | "booking_request"
    | "urgent_repair"
    | "hours_question"
    | "service_area_question"
    | "cancel"
    | "reschedule"
    | "faq"
    | "other";
};

const sessions = new Map<string, Session>();
const bookings = new Map<string, BookingRecord>();

function normalizeText(text: string) {
  return text.trim().toLowerCase();
}

function getSession(callSid: string, callerPhone?: string): Session {
  const existing = sessions.get(callSid);
  if (existing) {
    if (callerPhone && !existing.callerPhone) existing.callerPhone = callerPhone;
    if (callerPhone && !existing.booking.callerPhone) {
      existing.booking.callerPhone = callerPhone;
    }
    return existing;
  }

  const booking: BookingRecord = {
    id: crypto.randomBytes(4).toString("hex"),
    callSid,
    callerPhone,
    status: "pending",
    createdAt: new Date().toISOString(),
  };

  const session: Session = {
    callSid,
    callerPhone,
    stage: "normal",
    greeted: false,
    noSpeechCount: 0,
    booking,
  };

  sessions.set(callSid, session);
  return session;
}

function resetBookingDraft(session: Session) {
  session.booking = {
    id: crypto.randomBytes(4).toString("hex"),
    callSid: session.callSid,
    callerPhone: session.callerPhone,
    status: "pending",
    createdAt: new Date().toISOString(),
  };
}

function looksLikeYes(text: string) {
  const t = normalizeText(text);
  return [
    "yes",
    "yeah",
    "yep",
    "sure",
    "okay",
    "ok",
    "please",
    "correct",
    "confirm",
    "sounds good",
    "that works",
    "go ahead",
  ].some((k) => t.includes(k));
}

function looksLikeNo(text: string) {
  const t = normalizeText(text);
  return [
    "no",
    "nope",
    "not right now",
    "maybe later",
    "not yet",
    "no thank you",
  ].some((k) => t.includes(k));
}

function looksLikeBye(text: string) {
  const t = normalizeText(text);
  return [
    "bye",
    "goodbye",
    "hang up",
    "that is all",
    "that's all",
    "thank you bye",
    "thanks bye",
  ].some((k) => t.includes(k));
}

function looksLikeName(text: string) {
  const t = text.trim();
  if (!t || t.length > 60) return false;

  const low = t.toLowerCase();
  const obviousNonNames = [
    "price",
    "pricing",
    "availability",
    "appointment",
    "schedule",
    "today",
    "tomorrow",
    "diagnostic",
    "repair",
    "service",
    "cost",
  ];

  if (obviousNonNames.some((x) => low.includes(x))) return false;

  return /^[a-zA-Z][a-zA-Z\s.'-]{0,58}$/.test(t);
}

function looksLikeTime(text: string) {
  const t = normalizeText(text);
  return (
    /\b\d{1,2}(:\d{2})?\s?(am|pm)\b/.test(t) ||
    /\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|morning|afternoon|evening)\b/.test(
      t
    )
  );
}

function cleanTimeForConfirmation(text: string) {
  const t = text.trim();

  let cleaned = t
    .replace(/^can we do it at\s+/i, "")
    .replace(/^can we do\s+/i, "")
    .replace(/^does\s+/i, "")
    .replace(/^do(?:es)?\s+/i, "")
    .replace(/^i want\s+/i, "")
    .replace(/^let's do\s+/i, "")
    .replace(/^how about\s+/i, "")
    .replace(/^for\s+/i, "")
    .replace(/^at\s+/i, "")
    .trim();

  cleaned = cleaned.replace(/\?$/, "").trim();

  return cleaned || t;
}

function looksLikeAddress(text: string) {
  const t = text.trim();
  return t.length >= 6 && /\d/.test(t);
}

function looksLikeEmail(text: string) {
  const t = text.trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t);
}

function looksLikeCancelIntent(text: string) {
  return normalizeText(text).includes("cancel");
}

function looksLikeRescheduleIntent(text: string) {
  const t = normalizeText(text);
  return (
    t.includes("reschedule") ||
    t.includes("change appointment") ||
    t.includes("move appointment") ||
    t.includes("change booking") ||
    t.includes("change my appointment")
  );
}

function isGeneralPriceQuestion(text: string) {
  const t = normalizeText(text);
  return (
    t.includes("price") ||
    t.includes("pricing") ||
    t.includes("cost") ||
    t.includes("charge") ||
    t.includes("how much")
  );
}

function findLatestBookingByPhone(phone?: string) {
  if (!phone) return null;
  const matches = [...bookings.values()].filter((b) => b.callerPhone === phone);
  if (!matches.length) return null;
  matches.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return matches[0];
}

function ensureAudioDir() {
  const dir = path.join(process.cwd(), "public", "audio");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cacheInfo(text: string) {
  const hash = crypto.createHash("sha1").update(text).digest("hex");
  const file = `tts_${hash}.mp3`;
  return {
    abs: path.join(ensureAudioDir(), file),
    rel: `/audio/${file}`,
  };
}

async function elevenLabsTTS(text: string): Promise<string> {
  if (!ELEVENLABS_API_KEY || !ELEVENLABS_VOICE_ID) {
    throw new Error("Missing ELEVENLABS_API_KEY or ELEVENLABS_VOICE_ID");
  }

  const cache = cacheInfo(text);
  if (fs.existsSync(cache.abs)) return cache.rel;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);

  try {
    const resp = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
      {
        method: "POST",
        signal: controller.signal,
        headers: {
          "xi-api-key": ELEVENLABS_API_KEY,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify({
          text,
          model_id: "eleven_turbo_v2_5",
          optimize_streaming_latency: 4,
          output_format: "mp3_22050_32",
          voice_settings: {
            stability: 0.42,
            similarity_boost: 0.88,
            style: 0.12,
            use_speaker_boost: true,
          },
        }),
      }
    );

    if (!resp.ok) {
      const msg = await resp.text().catch(() => "");
      throw new Error(`ElevenLabs error ${resp.status}: ${msg}`);
    }

    const buf = Buffer.from(await resp.arrayBuffer());
    fs.writeFileSync(cache.abs, buf);
    return cache.rel;
  } finally {
    clearTimeout(timeout);
  }
}

async function speakText(
  twiml: any,
  text: string,
  fallbackVoice = "Polly.Joanna"
) {
async function speakText(
  twiml: any,
  text: string,
  fallbackVoice = "Polly.Joanna"
) {
  try {
    if (!BASE_URL.startsWith("https://")) {
      throw new Error("BASE_URL must be public HTTPS");
    }
    const audioPath = await elevenLabsTTS(text);
    twiml.play(`${BASE_URL}${audioPath}`);
  } catch (e) {
    app.log.error({ err: e }, "TTS failed, using Twilio fallback");
    twiml.say({ voice: fallbackVoice }, text);
  }
}

async function addPromptAndGather(
  twiml: any,
  text: string,
  action = "/voice-intake"
) {
const gather = twiml.gather({
  input: ["speech"],
  action: `${BASE_URL}${action}`,
  method: "POST",
  speechTimeout: 1,
  timeout: 4,
  actionOnEmptyResult: true,
  language: "en-US",
  enhanced: true,
  speechModel: "phone_call",
  profanityFilter: false,
});

const lower = text.toLowerCase();

const usePremiumVoice =
  text.length <= 140 &&
  !lower.includes("i didn't catch that") &&
  !lower.includes("please say that again") &&
  !lower.includes("please say the email") &&
  !lower.includes("say your email slowly") &&
  !lower.includes("or say skip");

try {
  if (!BASE_URL.startsWith("https://")) {
    throw new Error("BASE_URL must be public HTTPS");
  }

if (!usePremiumVoice) {
  throw new Error("Using Twilio fallback for long or low-value prompts");
}

  const audioPath = await elevenLabsTTS(text);
  gather.play(`${BASE_URL}${audioPath}`);
} catch (e) {
  app.log.error({ err: e }, "TTS skipped or failed, using Twilio voice");
  gather.say({ voice: "Polly.Joanna" }, text);
}

function getSpecificPriceReply(text: string): string | null {
  const t = normalizeText(text);

  if (
    t.includes("diagnostic") ||
    t.includes("service call") ||
    t.includes("trip fee") ||
    t.includes("appointment") ||
    t.includes("visit") ||
    t.includes("come out") ||
    t.includes("service fee")
  ) {
    return `Our diagnostic fee is ${DIAGNOSTIC_FEE}.`;
  }

  if (
    t.includes("tune up") ||
    t.includes("tune-up") ||
    t.includes("maintenance")
  ) {
    return "A standard tune-up is $129.";
  }

  if (
    t.includes("drain line") ||
    t.includes("condensate") ||
    t.includes("drain clearing") ||
    t.includes("clogged drain")
  ) {
    return "Condensate drain clearing is $149.";
  }

  if (t.includes("capacitor")) {
    return "Capacitor replacement usually ranges from $185 to $325, depending on the system.";
  }

  if (t.includes("thermostat")) {
    return "Thermostat installation typically ranges from $199 to $399, depending on the thermostat model.";
  }

  if (t.includes("blower motor") || t.includes("blower")) {
    return "Blower motor replacement usually ranges from $450 to $950, depending on the unit.";
  }

  if (t.includes("contactor")) {
    return "Contactor replacement usually ranges from $175 to $295.";
  }

  if (t.includes("refrigerant") || t.includes("freon")) {
    return "Refrigerant service is priced after diagnosis because it depends on the system and how much refrigerant is needed.";
  }

  if (
    t.includes("new unit") ||
    t.includes("replace unit") ||
    t.includes("system replacement") ||
    t.includes("full replacement")
  ) {
    return "A full system replacement is quoted after an inspection because pricing depends on system size, efficiency, and installation scope.";
  }

  return null;
}

function getSpecificPriceReplyWithBooking(text: string): string | null {
  const price = getSpecificPriceReply(text);
  if (!price) return null;
  return `${price} Would you like to make an appointment?`;
}

function getRepairPricingReply() {
  return `Repair pricing depends on what is causing the issue. We start with a diagnostic fee of ${DIAGNOSTIC_FEE}, and after the technician checks the system, they will explain the repair cost before moving forward.`;
}

function getBroadPriceMenu() {
  return "I can help with pricing. Which service are you asking about, like a diagnostic visit, tune-up, thermostat, capacitor, drain line clearing, blower motor, contactor, refrigerant service, or system replacement?";
}

function getSimpleFaqReply(text: string): string | null {
  const t = normalizeText(text);

  if (t.includes("hours") || t.includes("open") || t.includes("close")) {
    return `We are open ${HOURS}.`;
  }

  if (
    t.includes("service area") ||
    t.includes("serve") ||
    t.includes("come to") ||
    t.includes("do you service")
  ) {
    return `We service ${SERVICE_AREAS}.`;
  }

  if (
    t.includes("availability") ||
    t.includes("when can someone come") ||
    t.includes("when do you have availability")
  ) {
    return "We can help with the soonest available appointment, including same-day service when availability allows. If you'd like, I can get that started for you.";
  }

  if (t.includes("financing")) {
    return "Financing options may be available depending on the job. If you'd like, I can have someone follow up with details.";
  }

  if (t.includes("warranty")) {
    return "Warranty coverage can vary depending on the equipment and service performed, but we can definitely go over that once we know the job details.";
  }

  if (
    t.includes("same day") ||
    t.includes("today") ||
    t.includes("soonest") ||
    t.includes("earliest")
  ) {
    return "We can absolutely help with the soonest available appointment, including same-day service when availability allows.";
  }

  if (
    t.includes("emergency") ||
    t.includes("after hours") ||
    t.includes("weekend")
  ) {
    return "After-hours or weekend availability can depend on the schedule, but I can still help get your request in right away.";
  }

  if (t.includes("do you work on") || t.includes("brands")) {
    return "We work on many common residential HVAC systems and brands. If you'd like, tell me the brand and I can note it for the technician.";
  }

  return null;
}

function getFastRuleBasedReply(text: string): string | null {
  const specificPrice = getSpecificPriceReply(text);
  if (specificPrice) return specificPrice;

  const faq = getSimpleFaqReply(text);
  if (faq) return faq;

  const t = normalizeText(text);

  if (
    t.includes("how much to fix") ||
    t.includes("price to fix") ||
    t.includes("cost to fix") ||
    t.includes("repair my ac") ||
    t.includes("fix my air conditioner") ||
    t.includes("fix my ac")
  ) {
    return getRepairPricingReply();
  }

  if (isGeneralPriceQuestion(text)) {
    return getBroadPriceMenu();
  }

  if (
    t.includes("not cooling") ||
    t.includes("no ac") ||
    t.includes("broken") ||
    t.includes("blowing hot") ||
    t.includes("water leaking") ||
    t.includes("warm air") ||
    t.includes("frozen coil")
  ) {
    return "I'm sorry you're dealing with that. We can definitely help with that. Would you like me to get you scheduled?";
  }

  return null;
}

async function classifyIntent(text: string): Promise<IntentResult> {
  const lower = normalizeText(text);

  if (looksLikeCancelIntent(text)) return { intent: "cancel" };
  if (looksLikeRescheduleIntent(text)) return { intent: "reschedule" };
  if (getSpecificPriceReply(text)) return { intent: "pricing_specific" };

  if (
    lower.includes("how much to fix") ||
    lower.includes("price to fix") ||
    lower.includes("cost to fix") ||
    lower.includes("repair my ac") ||
    lower.includes("repair an ac") ||
    lower.includes("fix my air conditioner") ||
    lower.includes("fix my ac")
  ) {
    return { intent: "repair_pricing_general" };
  }

  if (
    lower.includes("book") ||
    lower.includes("schedule") ||
    lower.includes("make an appointment") ||
    lower.includes("set up an appointment")
  ) {
    return { intent: "booking_request" };
  }

  if (
    lower.includes("availability") ||
    lower.includes("when can someone come") ||
    lower.includes("when do you have availability") ||
    lower.includes("same day") ||
    lower.includes("today") ||
    lower.includes("soonest")
  ) {
    return { intent: "availability_question" };
  }

  if (
    lower.includes("hours") ||
    lower.includes("open") ||
    lower.includes("close")
  ) {
    return { intent: "hours_question" };
  }

  if (
    lower.includes("service area") ||
    lower.includes("serve") ||
    lower.includes("come to") ||
    lower.includes("do you service")
  ) {
    return { intent: "service_area_question" };
  }

  if (isGeneralPriceQuestion(text)) {
    return { intent: "pricing_broad" };
  }

  if (
    lower.includes("not cooling") ||
    lower.includes("no ac") ||
    lower.includes("broken") ||
    lower.includes("blowing hot") ||
    lower.includes("water leaking") ||
    lower.includes("warm air") ||
    lower.includes("frozen coil") ||
    lower.includes("repair")
  ) {
    return { intent: "urgent_repair" };
  }

  if (getSimpleFaqReply(text)) return { intent: "faq" };
  if (!openai) return { intent: "other" };

  try {
    const prompt = `
Classify this HVAC caller request.
Return only JSON like:
{"intent":"pricing_specific|pricing_broad|repair_pricing_general|availability_question|booking_request|urgent_repair|hours_question|service_area_question|cancel|reschedule|faq|other"}

Caller text: ${JSON.stringify(text)}
`;

    const resp = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      temperature: 0,
      max_tokens: 40,
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: prompt }],
    });

    const raw = resp.choices?.[0]?.message?.content?.trim() || "{}";
    const parsed = JSON.parse(raw) as IntentResult;
    return parsed.intent ? parsed : { intent: "other" };
  } catch {
    return { intent: "other" };
  }
}

async function assistantReply(userText: string) {
  const fastReply = getFastRuleBasedReply(userText);
  if (fastReply) return fastReply;

  if (!openai) {
    return "I can help with scheduling, pricing, service areas, hours, and general HVAC questions. What can I help you with today?";
  }

  try {
    const system = `
You are the live office receptionist for ${COMPANY_NAME}.

Company information:
- Hours: ${HOURS}
- Service areas: ${SERVICE_AREAS}
- Diagnostic fee: ${DIAGNOSTIC_FEE}
- Pricing:
  - Tune-up: $129
  - Condensate drain clearing: $149
  - Capacitor replacement: $185 to $325
  - Thermostat installation: $199 to $399
  - Blower motor replacement: $450 to $950
  - Contactor replacement: $175 to $295
  - Refrigerant service: priced after diagnosis
  - Full system replacement: quoted after inspection

Style:
- Warm, natural, concise, human
- Sound like a real office receptionist
- Keep responses short and clear for phone
- Answer the caller's question directly
- If they ask generally about pricing, ask which service they mean
- If they ask for a specific price, answer only that service
- If they ask yes plus another question, answer the question first
- After giving a specific price, offer to make an appointment
- Never repeat the caller's exact wording awkwardly
- Never say "I am listening"
- Never sound robotic
`;

    const resp = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      temperature: 0.25,
      max_tokens: 90,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userText },
      ],
    });

    return (
      resp.choices?.[0]?.message?.content?.trim() ||
      "I'm sorry, could you repeat that for me?"
    );
  } catch {
    return "I can help with scheduling, pricing, hours, and service areas. What would you like to know?";
  }
}

async function maybeSendSmsConfirmation(booking: BookingRecord) {
  if (!smsClient || !FROM_NUMBER || !booking.callerPhone) return;

  const text =
    `Thanks for calling ${COMPANY_NAME}. ` +
    `Your appointment request is confirmed for ${booking.time || "the requested time"} ` +
    `at ${booking.address || "the service address"} under ${booking.name || "your name"}. ` +
    `Issue: ${booking.issue || "HVAC service request"}. ` +
    `Reply or call us if you need to change or cancel.`;

  await smsClient.messages.create({
    from: FROM_NUMBER,
    to: booking.callerPhone,
    body: text,
  });
}

async function maybeSendEmailConfirmation(booking: BookingRecord) {
  if (!mailTransport || !CONFIRMATION_EMAIL_FROM || !booking.email) return;

  const subject = `${COMPANY_NAME} Appointment Request Confirmation`;

  const text =
    `Thank you for contacting ${COMPANY_NAME}.\n\n` +
    `Your appointment request details are below:\n` +
    `Name: ${booking.name || "N/A"}\n` +
    `Issue: ${booking.issue || "HVAC service request"}\n` +
    `Requested time: ${booking.time || "N/A"}\n` +
    `Service address: ${booking.address || "N/A"}\n\n` +
    `If you need to make changes, please reply to this email or call us.\n\n` +
    `${COMPANY_NAME}`;

  await mailTransport.sendMail({
    from: CONFIRMATION_EMAIL_FROM,
    to: booking.email,
    subject,
    text,
  });
}

async function createHubSpotContact(booking: BookingRecord) {
  app.log.info(
    {
      hasHubSpotKey: !!HUBSPOT_API_KEY,
      name: booking.name,
      email: booking.email,
      phone: booking.callerPhone,
      issue: booking.issue,
      time: booking.time,
      address: booking.address,
    },
    "createHubSpotContact called"
  );
  if (!HUBSPOT_API_KEY) return;

  const properties: Record<string, string> = {};

  if (booking.email) {
    properties.email = booking.email;
  }

  if (booking.name) {
    const parts = booking.name.trim().split(/\s+/);
    properties.firstname = parts[0] || "";
    if (parts.length > 1) {
      properties.lastname = parts.slice(1).join(" ");
    }
  }

  if (booking.callerPhone) {
    properties.phone = booking.callerPhone;
  }

   properties.hs_lead_status = "NEW";

const resp = await fetch("https://api.hubapi.com/crm/v3/objects/contacts", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${HUBSPOT_API_KEY}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ properties }),
});

const respText = await resp.text().catch(() => "");
app.log.info({ status: resp.status, body: respText }, "HubSpot response");

if (!resp.ok) {
  throw new Error(`HubSpot create failed ${resp.status}: ${respText}`);
}
}

async function warmCommonAudio() {
  const phrases = [
    `Hi, this is ${COMPANY_NAME}. How can I help you today?`,
    "How can I help you?",
    "I'm sorry, could you say that one more time?",
    "Perfect. What name should I put the appointment under?",
    "Thank you. What issue are you having with the system?",
    "Got it. What day and time works best for you?",
    "Thank you. What is the service address?",
    "Thanks. If you'd like an email confirmation, please say your email address now, or say skip.",
    "Please say confirm to finalize, say change to edit it, or say cancel to cancel it.",
    `Thank you for calling ${COMPANY_NAME}. Have a great day.`,
    `We are open ${HOURS}.`,
    `We service ${SERVICE_AREAS}.`,
    getRepairPricingReply(),
    getBroadPriceMenu(),
    `Our diagnostic fee is ${DIAGNOSTIC_FEE}.`,
  ];

  for (const phrase of phrases) {
    try {
      await elevenLabsTTS(phrase);
    } catch (err) {
      app.log.error({ err, phrase }, "Audio warmup failed");
    }
  }
}

app.get("/health", async () => ({ ok: true }));

app.post("/voice-webhook", async (req: any, reply: any) => {
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const twiml = new VoiceResponse();

  const callSid = (req.body?.CallSid || "NO_CALLSID").toString();
  const callerPhone = (req.body?.From || "").toString().trim();
  const session = getSession(callSid, callerPhone);

  if (!session.greeted) {
    session.greeted = true;
    await addPromptAndGather(
      twiml,
      `Hi, this is ${COMPANY_NAME}. How can I help you today?`
    );
  } else {
    await addPromptAndGather(twiml, "How can I help you?");
  }

  reply.type("text/xml");
  return reply.send(twiml.toString());
});

app.post("/voice-intake", async (req: any, reply: any) => {
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const twiml = new VoiceResponse();

  try {
    const speech = ((req.body?.SpeechResult || "") as string).trim();
    const callSid = (req.body?.CallSid || "NO_CALLSID").toString();
    const callerPhone = (req.body?.From || "").toString().trim();
    const session = getSession(callSid, callerPhone);

    app.log.info({ callSid, speech, stage: session.stage }, "Speech captured");

    if (!speech) {
      session.noSpeechCount += 1;

      if (session.noSpeechCount >= 2) {
        await speakText(
          twiml,
          "I'm sorry, I didn't catch anything. Please call us back when you're ready. Thank you."
        );
        twiml.hangup();
        reply.type("text/xml");
        return reply.send(twiml.toString());
      }

      await addPromptAndGather(
        twiml,
        "I'm sorry, could you say that one more time?"
      );
      reply.type("text/xml");
      return reply.send(twiml.toString());
    }

    session.noSpeechCount = 0;

    if (looksLikeBye(speech)) {
      await speakText(
        twiml,
        `Thank you for calling ${COMPANY_NAME}. Have a great day.`
      );
      twiml.hangup();
      reply.type("text/xml");
      return reply.send(twiml.toString());
    }

    if (session.stage === "offer_booking") {
      const specificPrice = getSpecificPriceReply(speech);
      const wantsGeneralPrice = isGeneralPriceQuestion(speech);
      const questionIntent = await classifyIntent(speech);

      if (specificPrice) {
        await addPromptAndGather(
          twiml,
          `${specificPrice} Would you like to make an appointment?`
        );
        reply.type("text/xml");
        return reply.send(twiml.toString());
      }

      if (
        wantsGeneralPrice &&
        questionIntent.intent !== "pricing_specific"
      ) {
        await addPromptAndGather(twiml, getBroadPriceMenu());
        reply.type("text/xml");
        return reply.send(twiml.toString());
      }

      if (questionIntent.intent === "availability_question") {
        await addPromptAndGather(
          twiml,
          "We can help with the soonest available appointment, including same-day service when availability allows. Would you like me to get that started?"
        );
        reply.type("text/xml");
        return reply.send(twiml.toString());
      }

      if (questionIntent.intent === "hours_question") {
        await addPromptAndGather(
          twiml,
          `We are open ${HOURS}. Would you like me to help get that scheduled?`
        );
        reply.type("text/xml");
        return reply.send(twiml.toString());
      }

      if (questionIntent.intent === "service_area_question") {
        await addPromptAndGather(
          twiml,
          `We service ${SERVICE_AREAS}. Would you like me to help get that scheduled?`
        );
        reply.type("text/xml");
        return reply.send(twiml.toString());
      }

      if (questionIntent.intent === "repair_pricing_general") {
        await addPromptAndGather(
          twiml,
          `${getRepairPricingReply()} Would you like to make an appointment?`
        );
        reply.type("text/xml");
        return reply.send(twiml.toString());
      }

      if (questionIntent.intent === "faq") {
        await addPromptAndGather(
          twiml,
          `${getSimpleFaqReply(speech)} Would you like me to help get that scheduled?`
        );
        reply.type("text/xml");
        return reply.send(twiml.toString());
      }

      if (looksLikeYes(speech)) {
        session.stage = "book_name";
        resetBookingDraft(session);
        await addPromptAndGather(
          twiml,
          "Perfect. What name should I put the appointment under?"
        );
        reply.type("text/xml");
        return reply.send(twiml.toString());
      }

      if (looksLikeNo(speech)) {
        session.stage = "normal";
        await addPromptAndGather(
          twiml,
          "No problem. What else can I help you with today?"
        );
        reply.type("text/xml");
        return reply.send(twiml.toString());
      }

      const fallbackReply = await assistantReply(speech);
      await addPromptAndGather(
        twiml,
        `${fallbackReply} Would you like me to help get that scheduled?`
      );
      reply.type("text/xml");
      return reply.send(twiml.toString());
    }

    if (session.stage === "book_name") {
      const subjectChangeIntent = await classifyIntent(speech);

      if (
        subjectChangeIntent.intent !== "other" &&
        subjectChangeIntent.intent !== "booking_request"
      ) {
        const answer =
          subjectChangeIntent.intent === "pricing_specific"
            ? getSpecificPriceReply(speech)
            : subjectChangeIntent.intent === "repair_pricing_general"
              ? getRepairPricingReply()
              : subjectChangeIntent.intent === "availability_question"
                ? "We can help with the soonest available appointment, including same-day service when availability allows."
                : subjectChangeIntent.intent === "hours_question"
                  ? `We are open ${HOURS}.`
                  : subjectChangeIntent.intent === "service_area_question"
                    ? `We service ${SERVICE_AREAS}.`
                    : getSimpleFaqReply(speech) || (await assistantReply(speech));

        await addPromptAndGather(
          twiml,
          `${answer} When you're ready, what name should I put the appointment under?`
        );
        reply.type("text/xml");
        return reply.send(twiml.toString());
      }

      if (!looksLikeName(speech)) {
        await addPromptAndGather(
          twiml,
          "I'm sorry, what name should I put the appointment under?"
        );
        reply.type("text/xml");
        return reply.send(twiml.toString());
      }

      session.booking.name = speech;
      session.stage = "book_issue";
      await addPromptAndGather(
        twiml,
        "Thank you. What issue are you having with the system?"
      );
      reply.type("text/xml");
      return reply.send(twiml.toString());
    }

    if (session.stage === "book_issue") {
      const subjectChangeIntent = await classifyIntent(speech);

      if (
        subjectChangeIntent.intent === "pricing_specific" ||
        subjectChangeIntent.intent === "repair_pricing_general" ||
        subjectChangeIntent.intent === "availability_question" ||
        subjectChangeIntent.intent === "hours_question" ||
        subjectChangeIntent.intent === "service_area_question" ||
        subjectChangeIntent.intent === "faq"
      ) {
        const answer =
          subjectChangeIntent.intent === "pricing_specific"
            ? getSpecificPriceReply(speech)
            : subjectChangeIntent.intent === "repair_pricing_general"
              ? getRepairPricingReply()
              : subjectChangeIntent.intent === "availability_question"
                ? "We can help with the soonest available appointment, including same-day service when availability allows."
                : subjectChangeIntent.intent === "hours_question"
                  ? `We are open ${HOURS}.`
                  : subjectChangeIntent.intent === "service_area_question"
                    ? `We service ${SERVICE_AREAS}.`
                    : getSimpleFaqReply(speech);

        await addPromptAndGather(
          twiml,
          `${answer} Also, what issue are you having with the system?`
        );
        reply.type("text/xml");
        return reply.send(twiml.toString());
      }

      session.booking.issue = speech;
      session.stage = "book_time";
      await addPromptAndGather(
        twiml,
        "Got it. What day and time works best for you?"
      );
      reply.type("text/xml");
      return reply.send(twiml.toString());
    }

    if (session.stage === "book_time") {
      const subjectChangeIntent = await classifyIntent(speech);

      if (
        subjectChangeIntent.intent === "pricing_specific" ||
        subjectChangeIntent.intent === "repair_pricing_general" ||
        subjectChangeIntent.intent === "availability_question" ||
        subjectChangeIntent.intent === "hours_question" ||
        subjectChangeIntent.intent === "service_area_question" ||
        subjectChangeIntent.intent === "faq"
      ) {
        const answer =
          subjectChangeIntent.intent === "pricing_specific"
            ? getSpecificPriceReply(speech)
            : subjectChangeIntent.intent === "repair_pricing_general"
              ? getRepairPricingReply()
              : subjectChangeIntent.intent === "availability_question"
                ? "We can help with the soonest available appointment, including same-day service when availability allows."
                : subjectChangeIntent.intent === "hours_question"
                  ? `We are open ${HOURS}.`
                  : subjectChangeIntent.intent === "service_area_question"
                    ? `We service ${SERVICE_AREAS}.`
                    : getSimpleFaqReply(speech);

        await addPromptAndGather(
          twiml,
          `${answer} What day and time would you like?`
        );
        reply.type("text/xml");
        return reply.send(twiml.toString());
      }

      if (!looksLikeTime(speech)) {
        await addPromptAndGather(
          twiml,
          "What day and approximate time would you prefer?"
        );
        reply.type("text/xml");
        return reply.send(twiml.toString());
      }

      session.booking.time = speech;
      session.stage = "book_address";
      await addPromptAndGather(
        twiml,
        "Thank you. What is the service address?"
      );
      reply.type("text/xml");
      return reply.send(twiml.toString());
    }

    if (session.stage === "book_address") {
      const subjectChangeIntent = await classifyIntent(speech);

      if (
        subjectChangeIntent.intent === "pricing_specific" ||
        subjectChangeIntent.intent === "repair_pricing_general" ||
        subjectChangeIntent.intent === "availability_question" ||
        subjectChangeIntent.intent === "hours_question" ||
        subjectChangeIntent.intent === "service_area_question" ||
        subjectChangeIntent.intent === "faq"
      ) {
        const answer =
          subjectChangeIntent.intent === "pricing_specific"
            ? getSpecificPriceReply(speech)
            : subjectChangeIntent.intent === "repair_pricing_general"
              ? getRepairPricingReply()
              : subjectChangeIntent.intent === "availability_question"
                ? "We can help with the soonest available appointment, including same-day service when availability allows."
                : subjectChangeIntent.intent === "hours_question"
                  ? `We are open ${HOURS}.`
                  : subjectChangeIntent.intent === "service_area_question"
                    ? `We service ${SERVICE_AREAS}.`
                    : getSimpleFaqReply(speech);

        await addPromptAndGather(
          twiml,
          `${answer} What is the service address?`
        );
        reply.type("text/xml");
        return reply.send(twiml.toString());
      }

      if (!looksLikeAddress(speech)) {
        await addPromptAndGather(
          twiml,
          "Please give me the full service address, including the street number."
        );
        reply.type("text/xml");
        return reply.send(twiml.toString());
      }

      session.booking.address = speech;
      session.stage = "book_email";
      await addPromptAndGather(
        twiml,
        "Thanks. If you'd like an email confirmation, please say your email address now, or say skip."
      );
      reply.type("text/xml");
      return reply.send(twiml.toString());
    }

    if (session.stage === "book_email") {
      const t = normalizeText(speech);
      const wantsSkipEmail =
      t.includes("skip") ||
      t.includes("no email") ||
      t.includes("don't send email") ||
      t.includes("do not send email") ||
      t.includes("no thanks") ||
      t.includes("no thank you");

        if (wantsSkipEmail) {
        session.stage = "book_confirm";
        await addPromptAndGather(
          twiml,
          `I have your appointment request under ${session.booking.name}, for ${session.booking.time}, at ${session.booking.address}, regarding ${session.booking.issue}. The diagnostic fee is ${DIAGNOSTIC_FEE}. Please say confirm to finalize, say change if you want to edit it, or say cancel if you do not want it.`
        );
        reply.type("text/xml");
        return reply.send(twiml.toString());
      }

      if (!looksLikeEmail(speech)) {
        await addPromptAndGather(
          twiml,
          "Please say the email address again, or say skip if you do not want email confirmation."
        );
        reply.type("text/xml");
        return reply.send(twiml.toString());
      }

      session.booking.email = speech.trim();
      session.stage = "book_confirm";
      await addPromptAndGather(
        twiml,
        `Perfect. I have your appointment request under ${session.booking.name}, for ${session.booking.time}, at ${session.booking.address}, regarding ${session.booking.issue}. The diagnostic fee is ${DIAGNOSTIC_FEE}. Please say confirm to finalize, say change if you want to edit it, or say cancel if you do not want it.`
      );
      reply.type("text/xml");
      return reply.send(twiml.toString());
    }

    if (session.stage === "book_confirm") {
      const t = normalizeText(speech);

      if (
        t.includes("change") ||
        t.includes("edit") ||
        t.includes("reschedule")
      ) {
        session.stage = "book_time";
        await addPromptAndGather(
          twiml,
          "Of course. What day and time would you like instead?"
        );
        reply.type("text/xml");
        return reply.send(twiml.toString());
      }

      if (t.includes("cancel")) {
        session.stage = "normal";
        resetBookingDraft(session);
        await addPromptAndGather(
          twiml,
          "No problem. I cancelled that request. What else can I help you with?"
        );
        reply.type("text/xml");
        return reply.send(twiml.toString());
      }

      if (t.includes("confirm") || looksLikeYes(speech)) {
        session.booking.status = "confirmed";
        bookings.set(session.booking.id, { ...session.booking });

        await maybeSendSmsConfirmation(session.booking).catch((err) => {
          app.log.error({ err }, "SMS confirmation failed");
        });

        await maybeSendEmailConfirmation(session.booking).catch((err) => {
          app.log.error({ err }, "Email confirmation failed");
        });

        await createHubSpotContact(session.booking).catch((err) => {
        app.log.error({ err }, "HubSpot contact creation failed");
        });

        session.stage = "normal";
        await addPromptAndGather(
          twiml,
          `You're all set. I have your request under ${session.booking.name} for ${session.booking.time} at ${session.booking.address}. Someone from ${COMPANY_NAME} will follow up shortly. What else can I help you with today?`
        );
        reply.type("text/xml");
        return reply.send(twiml.toString());
      }

      const subjectChangeIntent = await classifyIntent(speech);
      if (
        subjectChangeIntent.intent === "pricing_specific" ||
        subjectChangeIntent.intent === "repair_pricing_general" ||
        subjectChangeIntent.intent === "availability_question" ||
        subjectChangeIntent.intent === "hours_question" ||
        subjectChangeIntent.intent === "service_area_question" ||
        subjectChangeIntent.intent === "faq"
      ) {
        const answer =
          subjectChangeIntent.intent === "pricing_specific"
            ? getSpecificPriceReply(speech)
            : subjectChangeIntent.intent === "repair_pricing_general"
              ? getRepairPricingReply()
              : subjectChangeIntent.intent === "availability_question"
                ? "We can help with the soonest available appointment, including same-day service when availability allows."
                : subjectChangeIntent.intent === "hours_question"
                  ? `We are open ${HOURS}.`
                  : subjectChangeIntent.intent === "service_area_question"
                    ? `We service ${SERVICE_AREAS}.`
                    : getSimpleFaqReply(speech);

        await addPromptAndGather(
          twiml,
          `${answer} To finish the appointment request, please say confirm, say change, or say cancel.`
        );
        reply.type("text/xml");
        return reply.send(twiml.toString());
      }

      await addPromptAndGather(
        twiml,
        "Please say confirm to finalize, say change to edit it, or say cancel to cancel it."
      );
      reply.type("text/xml");
      return reply.send(twiml.toString());
    }

    if (looksLikeCancelIntent(speech)) {
      const latest = findLatestBookingByPhone(session.callerPhone);

      if (!latest || latest.status === "cancelled") {
        await addPromptAndGather(
          twiml,
          "I don't see an active appointment request under this phone number right now. What else can I help you with today?"
        );
        session.stage = "normal";
        reply.type("text/xml");
        return reply.send(twiml.toString());
      }

      latest.status = "cancelled";
      bookings.set(latest.id, latest);

      await addPromptAndGather(
        twiml,
        "No problem. I have that appointment marked as cancelled. What else can I help you with?"
      );
      session.stage = "normal";
      reply.type("text/xml");
      return reply.send(twiml.toString());
    }

    if (looksLikeRescheduleIntent(speech)) {
      const latest = findLatestBookingByPhone(session.callerPhone);

      if (!latest || latest.status === "cancelled") {
        session.stage = "offer_booking";
        await addPromptAndGather(
          twiml,
          "I don't see an active appointment to change under this number right now. Would you like to schedule a new one?"
        );
        reply.type("text/xml");
        return reply.send(twiml.toString());
      }

      session.booking = { ...latest };
      session.stage = "reschedule_new_time";
      await addPromptAndGather(
        twiml,
        "Of course. What new day and time would you prefer?"
      );
      reply.type("text/xml");
      return reply.send(twiml.toString());
    }

    if (session.stage === "reschedule_new_time") {
      if (!looksLikeTime(speech)) {
        await addPromptAndGather(
          twiml,
          "What new day and approximate time would you prefer?"
        );
        reply.type("text/xml");
        return reply.send(twiml.toString());
      }

      session.booking.time = speech;
      session.booking.status = "reschedule_requested";
      bookings.set(session.booking.id, { ...session.booking });

      await maybeSendSmsConfirmation(session.booking).catch((err) => {
        app.log.error({ err }, "SMS reschedule confirmation failed");
      });

      await maybeSendEmailConfirmation(session.booking).catch((err) => {
        app.log.error({ err }, "Email reschedule confirmation failed");
      });

      session.stage = "normal";
      await addPromptAndGather(
        twiml,
        `Perfect. I updated that appointment request to ${session.booking.time}. Someone from ${COMPANY_NAME} will confirm the change shortly. What else can I help you with?`
      );
      reply.type("text/xml");
      return reply.send(twiml.toString());
    }

    const intent = await classifyIntent(speech);

    if (intent.intent === "availability_question") {
      session.stage = "offer_booking";
      await addPromptAndGather(
        twiml,
        "We can help with the soonest available appointment, including same-day service when availability allows. If you'd like, I can get that started for you."
      );
      reply.type("text/xml");
      return reply.send(twiml.toString());
    }

    if (intent.intent === "pricing_specific") {
      session.stage = "offer_booking";
      await addPromptAndGather(
        twiml,
        getSpecificPriceReplyWithBooking(speech) ||
          "Which service are you asking about?"
      );
      reply.type("text/xml");
      return reply.send(twiml.toString());
    }

    if (intent.intent === "repair_pricing_general") {
      session.stage = "offer_booking";
      await addPromptAndGather(
        twiml,
        `${getRepairPricingReply()} Would you like to make an appointment?`
      );
      reply.type("text/xml");
      return reply.send(twiml.toString());
    }

    if (intent.intent === "pricing_broad") {
      await addPromptAndGather(twiml, getBroadPriceMenu());
      reply.type("text/xml");
      return reply.send(twiml.toString());
    }

    if (intent.intent === "hours_question") {
      await addPromptAndGather(twiml, `We are open ${HOURS}.`);
      reply.type("text/xml");
      return reply.send(twiml.toString());
    }

    if (intent.intent === "service_area_question") {
      await addPromptAndGather(twiml, `We service ${SERVICE_AREAS}.`);
      reply.type("text/xml");
      return reply.send(twiml.toString());
    }

    if (intent.intent === "booking_request") {
      resetBookingDraft(session);
      session.stage = "book_name";
      await addPromptAndGather(
        twiml,
        "Absolutely. What name should I put the appointment under?"
      );
      reply.type("text/xml");
      return reply.send(twiml.toString());
    }

    if (intent.intent === "urgent_repair") {
      session.stage = "offer_booking";
      await addPromptAndGather(
        twiml,
        "I'm sorry you're dealing with that. We can help with that. Would you like me to get you scheduled?"
      );
      reply.type("text/xml");
      return reply.send(twiml.toString());
    }

    if (intent.intent === "faq") {
      await addPromptAndGather(
        twiml,
        getSimpleFaqReply(speech) || "How can I help you?"
      );
      reply.type("text/xml");
      return reply.send(twiml.toString());
    }

    const aiReply = await assistantReply(speech);
    await addPromptAndGather(twiml, aiReply);
    reply.type("text/xml");
    return reply.send(twiml.toString());
  } catch (err) {
    app.log.error({ err }, "voice-intake crashed");
    await addPromptAndGather(
      twiml,
      "I'm sorry, could you repeat that for me?"
    );
    reply.type("text/xml");
    return reply.send(twiml.toString());
  }
});

app.setErrorHandler(async (err, _req, reply) => {
  app.log.error({ err }, "Global error handler");
  try {
    const VR = twilio.twiml.VoiceResponse;
    const twiml = new VR();
    const gather = twiml.gather({
      input: ["speech"],
      action: "/voice-intake",
      method: "POST",
      speechTimeout: "auto",
      timeout: 2,
      actionOnEmptyResult: true,
      language: "en-US",
      enhanced: true,
      speechModel: "phone_call",
    });

    try {
      if (!BASE_URL.startsWith("https://")) {
        throw new Error("BASE_URL must be public HTTPS");
      }
      const audioPath = await elevenLabsTTS(
        "I'm sorry, please try again. How can I help you?"
      );
      gather.play(`${BASE_URL}${audioPath}`);
      } 
      catch {
      gather.say(
        { voice: "Polly.Joanna" },
        "I'm sorry, please try again. How can I help you?"
      );
    }

    reply.status(200).type("text/xml").send(twiml.toString());
  } catch {
    reply
      .status(200)
      .type("text/xml")
      .send("<Response><Say>Okay.</Say></Response>");
  }
});

app.listen({ port: PORT, host: "0.0.0.0" })
  .then(async () => {
    console.log(`Server listening on ${PORT}`);
    if (
      ELEVENLABS_API_KEY &&
      ELEVENLABS_VOICE_ID &&
      BASE_URL.startsWith("https://")
    ) {
      warmCommonAudio().catch((err) => {
        app.log.error({ err }, "Warmup failed");
      });
    }
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
