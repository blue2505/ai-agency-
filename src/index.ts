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
import { google } from "googleapis";
import chrono from "chrono-node";
import { Resend } from "resend";

dotenv.config();

const app = Fastify({ logger: true });

app.register(cors, { origin: true });
app.register(formbody);
app.register(fastifyStatic, {
  root: path.join(process.cwd(), "public"),
  prefix: "/",
  decorateReply: false,
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

const GOOGLE_CLIENT_EMAIL = (process.env.GOOGLE_CLIENT_EMAIL || "").trim();
const GOOGLE_PRIVATE_KEY = (process.env.GOOGLE_PRIVATE_KEY || "")
  .replace(/\\n/g, "\n")
  .trim();
const GOOGLE_CALENDAR_ID = (process.env.GOOGLE_CALENDAR_ID || "").trim();
const TIMEZONE = (process.env.TIMEZONE || "America/New_York").trim();
const APPOINTMENT_DURATION_MINUTES = Number(
  process.env.APPOINTMENT_DURATION_MINUTES || 60
);

const ELEVENLABS_API_KEY = (process.env.ELEVENLABS_API_KEY || "").trim();
const ELEVENLABS_VOICE_ID = (process.env.ELEVENLABS_VOICE_ID || "").trim();

const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
const OPENAI_MODEL = (process.env.OPENAI_MODEL || "gpt-4o-mini").trim();

const TWILIO_ACCOUNT_SID = (process.env.TWILIO_ACCOUNT_SID || "").trim();
const TWILIO_AUTH_TOKEN = (process.env.TWILIO_AUTH_TOKEN || "").trim();
const FROM_NUMBER = (process.env.FROM_NUMBER || "").trim();

const EMAIL_WEBHOOK_URL = (process.env.EMAIL_WEBHOOK_URL || "").trim();
const HUBSPOT_API_KEY = (process.env.HUBSPOT_API_KEY || "").trim();

const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;
const smsClient =
  TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN
    ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
    : null;

const googleAuth =
  GOOGLE_CLIENT_EMAIL && GOOGLE_PRIVATE_KEY
    ? new google.auth.JWT({
        email: GOOGLE_CLIENT_EMAIL,
        key: GOOGLE_PRIVATE_KEY,
        scopes: ["https://www.googleapis.com/auth/calendar"],
      })
    : null;

const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

const EMAIL_FROM = process.env.EMAIL_FROM || "";

const calendar =
  googleAuth ? google.calendar({ version: "v3", auth: googleAuth }) : null;

type BookingStatus =
  | "pending"
  | "confirmed"
  | "cancelled"
  | "reschedule_requested";

type BookingRecord = {
  id: string;
  callSid: string;
  callerPhone?: string;
  name?: string;
  time?: string;
  address?: string;
  issue?: string;
  email?: string;
  status: BookingStatus;
  createdAt: string;
};

type Stage =
  | "normal"
  | "offer_booking"
  | "book_name"
  | "book_issue"
  | "book_time"
  | "book_address"
  | "book_email_optional"
  | "book_confirm"
  | "reschedule_new_time";

type Session = {
  callSid: string;
  callerPhone?: string;
  stage: Stage;
  noSpeechCount: number;
  booking: BookingRecord;
};

const sessions = new Map<string, Session>();
const bookings = new Map<string, BookingRecord>();

function normalizeText(text: string) {
  return text.trim().toLowerCase();
}

function getAbsoluteUrl(route: string) {
  return BASE_URL.startsWith("https://") ? `${BASE_URL}${route}` : route;
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
  ].some((k) => t.includes(k));
}

function looksLikeNo(text: string) {
  const t = normalizeText(text);
  return [
    "no",
    "nope",
    "not right now",
    "maybe later",
    "don't",
    "do not",
  ].some((k) => t.includes(k));
}

function looksLikeThanks(text: string) {
  const t = text.trim().toLowerCase();
  return [
    "thank you",
    "thanks",
    "thank you so much",
    "thanks so much",
    "appreciate it",
    "perfect thank you",
    "okay thank you"
  ].some((k) => t.includes(k));
}

function looksLikeBye(text: string) {
  const t = normalizeText(text);
  return ["bye", "goodbye", "that is all", "that's all", "hang up"].some((k) =>
    t.includes(k)
  );
}

function looksLikeName(text: string) {
  const t = text.trim();
  if (!t || t.length > 60) return false;

  const low = normalizeText(text);
  const bad = [
    "yes",
    "yeah",
    "yep",
    "no",
    "nope",
    "book",
    "appointment",
    "schedule",
    "tomorrow",
    "today",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "help",
    "service",
    "repair",
    "technician",
    "availability",
    "pricing",
  ];

  if (bad.some((w) => low === w || low.includes(w))) return false;
  return /^[a-zA-Z][a-zA-Z\s.'-]{0,58}$/.test(t);
}

function looksLikeTime(text: string) {
  const t = normalizeText(text);
  return (
    /\b\d{1,2}(:\d{2})?\s?(am|pm)\b/.test(t) ||
    /\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|morning|afternoon|evening)\b/.test(
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

function spokenEmailToText(input: string) {
  let t = input.trim().toLowerCase();

  const replacements: Array<[RegExp, string]> = [
    [/\s+at\s+/g, "@"],
    [/\s+dot\s+/g, "."],
    [/\s+underscore\s+/g, "_"],
    [/\s+dash\s+/g, "-"],
    [/\s+hyphen\s+/g, "-"],
    [/\s+plus\s+/g, "+"],
    [/\s+period\s+/g, "."],
    [/\s+/g, ""],
  ];

  for (const [pattern, value] of replacements) {
    t = t.replace(pattern, value);
  }

  const wordToDigit: Record<string, string> = {
    zero: "0",
    one: "1",
    two: "2",
    three: "3",
    four: "4",
    five: "5",
    six: "6",
    seven: "7",
    eight: "8",
    nine: "9",
  };

  Object.entries(wordToDigit).forEach(([word, digit]) => {
    t = t.replace(new RegExp(word, "g"), digit);
  });

  return t;
}

function looksLikeEmail(text: string) {
  const normalized = spokenEmailToText(text);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized);
}

function looksLikeSkipEmail(text: string) {
  const t = normalizeText(text);
  return [
    "skip",
    "no email",
    "don't send email",
    "do not send email",
    "no thanks",
    "not now",
  ].some((k) => t.includes(k));
}

function looksLikeBookingIntent(text: string) {
  const t = normalizeText(text);
  return [
    "book",
    "booking",
    "appointment",
    "schedule",
    "set up",
    "set something up",
    "make an appointment",
    "make appointment",
    "come out",
    "send someone",
    "send a technician",
    "service call",
    "have someone come out",
    "have somebody come out",
    "can someone come",
    "i need someone to come",
    "i want someone to come",
    "i want to make an appointment",
    "i need an appointment",
    "can i book",
    "can i schedule"
  ].some((k) => t.includes(k));
}

function looksLikeCancelIntent(text: string) {
  const t = normalizeText(text);
  return ["cancel", "cancel appointment", "cancel booking"].some((k) =>
    t.includes(k)
  );
}

function looksLikeRescheduleIntent(text: string) {
  const t = normalizeText(text);
  return [
    "reschedule",
    "change appointment",
    "change booking",
    "move appointment",
    "change the time",
  ].some((k) => t.includes(k));
}

function looksLikeHoursQuestion(text: string) {
  const t = normalizeText(text);
  return (
    t.includes("hours") ||
    t.includes("open") ||
    t.includes("close") ||
    t.includes("when are you open")
  );
}

function looksLikeServiceAreaQuestion(text: string) {
  const t = normalizeText(text);
  return (
    t.includes("service area") ||
    t.includes("serve") ||
    t.includes("area") ||
    t.includes("come to") ||
    t.includes("do you service")
  );
}

function looksLikeUrgentRepair(text: string) {
  const t = normalizeText(text);
  return (
    t.includes("not working") ||
    t.includes("broken") ||
    t.includes("no ac") ||
    t.includes("ac is out") ||
    t.includes("air conditioner") ||
    t.includes("unit is out") ||
    t.includes("repair") ||
    t.includes("leak") ||
    t.includes("blowing hot") ||
    t.includes("not cooling") ||
    t.includes("not heating") ||
    t.includes("hot in here") ||
    t.includes("warm air") ||
    t.includes("water leaking") ||
    t.includes("frozen coil")
  );
}

function looksLikeAvailabilityQuestion(text: string) {
  const t = normalizeText(text);
  return (
    t.includes("availability") ||
    t.includes("today") ||
    t.includes("tomorrow") ||
    t.includes("earliest") ||
    t.includes("soonest") ||
    t.includes("when can someone come")
  );
}

function looksLikePricingQuestion(text: string) {
  const t = normalizeText(text);
  return (
    t.includes("price") ||
    t.includes("pricing") ||
    t.includes("cost") ||
    t.includes("how much") ||
    t.includes("quote") ||
    t.includes("estimate") ||
    t.includes("fee") ||
    t.includes("charge") ||
    t.includes("rates")
  );
}

function isBroadPricingQuestion(text: string) {
  const t = normalizeText(text);
  return (
    t.includes("prices") ||
    t.includes("pricing") ||
    t.includes("what do you charge") ||
    t.includes("how much do you charge") ||
    t.includes("price list") ||
    t.includes("rates") ||
    t === "pricing" ||
    t === "prices"
  );
}

function getSpecificPriceReply(text: string): string | null {
  const t = normalizeText(text);

  if (
    t.includes("diagnostic") ||
    t.includes("service call") ||
    t.includes("trip fee")
  ) {
    return `Our diagnostic fee is ${DIAGNOSTIC_FEE}.`;
  }

  if (t.includes("tune up") || t.includes("tune-up") || t.includes("maintenance")) {
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
    return "Refrigerant service is priced after diagnosis because it depends on the system, the refrigerant type, and how much is needed.";
  }

  if (
    t.includes("new unit") ||
    t.includes("replace unit") ||
    t.includes("system replacement") ||
    t.includes("full replacement") ||
    t.includes("new system")
  ) {
    return "A full system replacement is quoted after an inspection because pricing depends on system size, efficiency, and installation scope.";
  }

  return null;
}

function getBroadPricingReply() {
  return `We can definitely help with pricing. A few common examples are a diagnostic at ${DIAGNOSTIC_FEE}, a tune-up at $129, drain clearing at $149, and some repairs like capacitors or contactors vary depending on the system. If you want a specific price, tell me which service you're asking about.`;
}

function getRepairPricingReply() {
  return `Repair pricing depends on what is causing the issue. We start with a diagnostic fee of ${DIAGNOSTIC_FEE}, and after the technician checks the system, they will explain the repair cost before moving forward.`;
}

function getSimpleFaqReply(text: string): string | null {
  const t = normalizeText(text);

  if (t.includes("financing")) {
    return "Financing options may be available depending on the job. If you'd like, I can have someone follow up with details after an inspection or estimate.";
  }

  if (t.includes("warranty")) {
    return "Warranty coverage can vary depending on the equipment and the service performed, but we can definitely go over that once we know the job details.";
  }

  if (
    t.includes("same day") ||
    t.includes("today") ||
    t.includes("soonest") ||
    t.includes("earliest")
  ) {
    return "We can absolutely check for the soonest available appointment, including same-day service when availability allows.";
  }

  if (t.includes("emergency") || t.includes("after hours") || t.includes("weekend")) {
    return "Availability after hours or on weekends can depend on the day and schedule, but I can still help get your request in and have someone follow up as quickly as possible.";
  }

  if (t.includes("maintenance plan") || t.includes("membership")) {
    return "We can help with ongoing system maintenance as well. If you'd like, I can have someone follow up with the current maintenance options.";
  }

  if (t.includes("do you work on") || t.includes("brands")) {
    return "We work on many common residential HVAC systems and brands. If you want, tell me the brand or issue and I can note that for the technician.";
  }

  if (t.includes("install") || t.includes("inspection")) {
    return "Yes, we help with inspections, repairs, and installation-related requests as well.";
  }

  return null;
}

function findLatestBookingByPhone(phone?: string) {
  if (!phone) return null;
  const all = [...bookings.values()].filter((b) => b.callerPhone === phone);
  if (!all.length) return null;
  all.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return all[0];
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
  const cache = cacheInfo(text);

  if (fs.existsSync(cache.abs)) {
    return cache.rel;
  }

  const resp = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${process.env.ELEVENLABS_VOICE_ID}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": process.env.ELEVENLABS_API_KEY!,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_turbo_v2",
        voice_settings: {
          stability: 0.42,
          similarity_boost: 0.9,
          style: 0.1,
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
}

async function speak(twiml: any, text: string) {
  try {
    const audioPath = await elevenLabsTTS(text);

    if (BASE_URL.startsWith("https://")) {
      twiml.play(`${BASE_URL}${audioPath}`);
      return;
    }
  } catch (e) {
    app.log.error({ err: e }, "ElevenLabs failed; falling back to Polly");
  }

  twiml.say({ voice: "Polly.Joanna" }, text);
}

async function addPromptAndGather(
  twiml: any,
  text: string,
  action = "/voice-intake"
) {
  const gather = twiml.gather({
    input: "speech",
    action: getAbsoluteUrl(action),
    method: "POST",
    speechTimeout: "auto",
    timeout: 5,
    actionOnEmptyResult: true,
    language: "en-US",
    enhanced: true,
    speechModel: "phone_call",
    profanityFilter: false,
  });

  try {
    const audioPath = await elevenLabsTTS(text);

    if (BASE_URL.startsWith("https://")) {
      gather.play(`${BASE_URL}${audioPath}`);
      return;
    }
  } catch (e) {
    app.log.error({ err: e }, "ElevenLabs gather audio failed");
  }

  gather.say({ voice: "Polly.Joanna" }, text);
}

async function assistantReply(userText: string) {
  if (!openai) {
    return "I can help with scheduling, pricing, service areas, hours, and general HVAC questions. What can I help you with today?";
  }

  const system = `
You are the live office receptionist for ${COMPANY_NAME}.

Company information:
- Hours: ${HOURS}
- Service areas: ${SERVICE_AREAS}
- Diagnostic fee: ${DIAGNOSTIC_FEE}

Your tone:
- Warm, calm, natural, polished, and human
- Sound like a real front desk person answering the phone
- Keep it conversational, not robotic
- Do not say "I am listening"
- Keep responses concise and easy to hear over the phone

Guidelines:
- If the caller asks a specific price, answer only that specific price
- If the caller asks broad pricing, answer briefly and naturally
- If the caller has a repair issue, sound empathetic and helpful
- If appropriate, offer to schedule service
- If unsure, ask one short clarifying question
- Never awkwardly repeat the caller's exact sentence back to them
- Keep replies to one short sentence when possible.
- Use two short sentences max unless necessary.
- Sound warm and human, like a real receptionist.
- Do not repeat the caller's exact words back to them.
- If the caller is clearly asking to book, move them forward quickly.
- If the caller says thank you after booking, respond warmly and end the call.
`;

  const resp = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    temperature: 0.25,
    max_tokens: 80,
    messages: [
      { role: "system", content: system },
      { role: "user", content: userText },
    ],
  });

  return (
    resp.choices?.[0]?.message?.content?.trim() ||
    "I'm sorry, could you repeat that for me?"
  );
}

async function createCalendarBooking(booking: BookingRecord) {
  app.log.info(
    {
      hasCalendar: !!calendar,
      calendarId: GOOGLE_CALENDAR_ID,
      bookingTime: booking.time,
      bookingName: booking.name,
      bookingAddress: booking.address,
      timezone: TIMEZONE,
    },
    "createCalendarBooking called"
  );

  if (!calendar || !GOOGLE_CALENDAR_ID || !booking.time) {
    app.log.error(
      {
        hasCalendar: !!calendar,
        calendarId: GOOGLE_CALENDAR_ID,
        bookingTime: booking.time,
      },
      "Calendar prerequisites missing"
    );
    return null;
  }

  const start = chrono.parseDate(booking.time, new Date(), {
    forwardDate: true,
  });

  app.log.info(
    { parsedStart: start ? start.toISOString() : null },
    "parsed calendar start"
  );

  if (!start) {
    app.log.error({ bookingTime: booking.time }, "Could not parse booking time");
    return null;
  }

  const end = new Date(start.getTime() + APPOINTMENT_DURATION_MINUTES * 60000);

  try {
    const event = await calendar.events.insert({
      calendarId: GOOGLE_CALENDAR_ID,
      requestBody: {
        summary: `${COMPANY_NAME} Service Appointment`,
        description: `Customer: ${booking.name || ""}
Issue: ${booking.issue || ""}
Phone: ${booking.callerPhone || ""}
Email: ${booking.email || ""}`,
        location: booking.address || "",
        start: {
          dateTime: start.toISOString(),
          timeZone: TIMEZONE,
        },
        end: {
          dateTime: end.toISOString(),
          timeZone: TIMEZONE,
        },
      },
    });

    app.log.info(
      {
        eventId: event.data.id,
        htmlLink: event.data.htmlLink,
        start: event.data.start,
        end: event.data.end,
      },
      "calendar event created"
    );

    return event.data;
  } catch (err) {
    app.log.error({ err }, "Calendar booking failed inside createCalendarBooking");
    return null;
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
  if (!resend || !booking.email) {
    app.log.info(
      {
        hasResend: !!resend,
        bookingEmail: booking.email || null,
      },
      "Skipping email confirmation"
    );
    return;
  }

  try {
    const result = await resend.emails.send({
      from: EMAIL_FROM,
      to: booking.email,
      subject: `${COMPANY_NAME} Appointment Confirmation`,
      text: `Hello ${booking.name || ""},

Your appointment request has been scheduled.

Time: ${booking.time || ""}
Address: ${booking.address || ""}
Issue: ${booking.issue || ""}

Someone from our office will follow up shortly.

Thank you,
${COMPANY_NAME}`,
    });

    app.log.info({ result, to: booking.email }, "Email confirmation sent");
  } catch (err) {
    app.log.error({ err, to: booking.email }, "Email send failed");
  }
}

async function createHubSpotContact(booking: BookingRecord) {
  if (!HUBSPOT_API_KEY) return;

  const properties: Record<string, string> = {};

  if (booking.email) properties.email = booking.email;
  if (booking.callerPhone) properties.phone = booking.callerPhone;

  if (booking.name) {
    const parts = booking.name.trim().split(/\s+/);
    properties.firstname = parts[0] || "";
    if (parts.length > 1) {
      properties.lastname = parts.slice(1).join(" ");
    }
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

async function answerQuestionDuringBooking(text: string) {
  if (looksLikePricingQuestion(text)) {
    const specificPrice = getSpecificPriceReply(text);
    if (specificPrice) return specificPrice;
    if (isBroadPricingQuestion(text)) return getBroadPricingReply();
    return "I can definitely help with pricing. Which service are you asking about?";
  }

  if (looksLikeHoursQuestion(text)) {
    return `We are open ${HOURS}.`;
  }

  if (looksLikeServiceAreaQuestion(text)) {
    return `We service ${SERVICE_AREAS}.`;
  }

  if (looksLikeAvailabilityQuestion(text)) {
    return "We can help request the soonest available appointment, including same-day service when available.";
  }

  const faqReply = getSimpleFaqReply(text);
  if (faqReply) return faqReply;

  return assistantReply(
    `The caller is already in the booking process and asked this side question: ${text}. Answer naturally and briefly like a real HVAC office receptionist.`
  );
}

async function warmCommonAudio() {
const phrases = [
  `Hello, this is ${COMPANY_NAME}, how can I help you?`,
  `Absolutely. Our diagnostic fee is ${DIAGNOSTIC_FEE}. Are you okay to proceed with the appointment?`,
  "Perfect. What name should I put the appointment under?",
  "Thank you. What issue are you having with the system today?",
  "What day and time would you like for the appointment?",
  "What is the full service address including street name, city, and zip code?",
  "If you'd like an email confirmation too, please say your email slowly, for example anna at gmail dot com, or say skip.",
  "Please say confirm to finalize, change to edit it, or cancel to cancel it.",
  "No problem at all. What else can I help you with today?",
  "You're all set. Your appointment request has been scheduled, and someone from our office will follow up shortly."
];

  await Promise.all(
    phrases.map((text) =>
      elevenLabsTTS(text).catch((err) => {
        app.log.error({ err, text }, "Warmup phrase failed");
      })
    )
  );
}

app.get("/health", async () => ({ ok: true }));

app.post("/voice-webhook", async (req: any, reply: any) => {
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const twiml = new VoiceResponse();

  const callSid = (req.body?.CallSid || "NO_CALLSID").toString();
  const callerPhone = (req.body?.From || "").toString().trim();
  getSession(callSid, callerPhone);

  await addPromptAndGather(
    twiml,
    `Hello, this is ${COMPANY_NAME}, how can I help you?`
  );

  reply.type("text/xml");
  return reply.send(twiml.toString());
  });


app.post("/voice-intake", async (req: any, reply: any) => {
  console.log("VOICE BODY:", req.body);

  const VoiceResponse = twilio.twiml.VoiceResponse;
  const twiml = new VoiceResponse();

  try {
    const speech = (req.body?.SpeechResult ?? "").toString().trim();
    const callSid = (req.body?.CallSid || "NO_CALLSID").toString();
    const callerPhone = (req.body?.From || "").toString().trim();
    const session = getSession(callSid, callerPhone);

    app.log.info({ callSid, speech, stage: session.stage }, "Speech captured");

    if (!speech) {
      session.noSpeechCount += 1;

      if (session.noSpeechCount >= 2) {
        await speak(
          twiml,
          "I'm sorry, I didn't catch anything. Please call us back when you're ready. Thank you."
        );
        twiml.hangup();
        reply.type("text/xml");
        return reply.send(twiml.toString());
      }

      await addPromptAndGather(
        twiml,
        "I'm sorry, I didn't catch that. Could you say that one more time?"
      );
      reply.type("text/xml");
      return reply.send(twiml.toString());
    }

    session.noSpeechCount = 0;

    if (looksLikeThanks(speech)) {
      await speak(
        twiml,
        `You're welcome. Thank you for calling ${COMPANY_NAME}. Have a great day.`
      );
      twiml.hangup();
      reply.type("text/xml");
      return reply.send(twiml.toString());
    }

    if (looksLikeBye(speech)) {
      await speak(twiml, `Thank you for calling ${COMPANY_NAME}. Have a great day.`);
      twiml.hangup();
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
        `No problem. I have your appointment under ${latest.name || "your name"} marked as cancelled. What else can I help you with?`
      );
      session.stage = "normal";
      reply.type("text/xml");
      return reply.send(twiml.toString());
    }

    if (looksLikeRescheduleIntent(speech)) {
      const latest = findLatestBookingByPhone(session.callerPhone);

      if (!latest || latest.status === "cancelled") {
        await addPromptAndGather(
          twiml,
          "I don't see an active appointment to change under this phone number right now. Would you like to schedule a new one instead?"
        );
        session.stage = "offer_booking";
        reply.type("text/xml");
        return reply.send(twiml.toString());
      }

      session.booking = { ...latest };
      session.stage = "reschedule_new_time";
      await addPromptAndGather(
        twiml,
        `Of course. I have your current appointment request for ${latest.time || "the requested time"}. What new day and time would you prefer?`
      );
      reply.type("text/xml");
      return reply.send(twiml.toString());
    }

    if (session.stage === "offer_booking") {
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
          "No problem at all. What else can I help you with today?"
        );
        reply.type("text/xml");
        return reply.send(twiml.toString());
      }

      const offerReply = await answerQuestionDuringBooking(speech);
      await addPromptAndGather(
        twiml,
        `${offerReply} Would you like me to get that scheduled for you?`
      );
      reply.type("text/xml");
      return reply.send(twiml.toString());
    }

    if (session.stage === "book_name") {
      if (!looksLikeName(speech)) {
        await addPromptAndGather(
          twiml,
          "I'm sorry, I didn't catch the name. What name should I put the appointment under?"
        );
        reply.type("text/xml");
        return reply.send(twiml.toString());
      }

      session.booking.name = speech;
      session.stage = "book_issue";
      await addPromptAndGather(
        twiml,
        "Thank you. What issue are you having with the system today?"
      );
      reply.type("text/xml");
      return reply.send(twiml.toString());
    }

    if (session.stage === "book_issue") {
      session.booking.issue = speech;
      session.stage = "book_time";
      await addPromptAndGather(
        twiml,
        "What day and time would you like for the appointment?"
      );
      reply.type("text/xml");
      return reply.send(twiml.toString());
    }

    if (session.stage === "book_time") {
      session.booking.time = speech;
      session.stage = "book_address";
      await addPromptAndGather(
        twiml,
        "What is the full service address including street name, city, and zip code?"
      );
      reply.type("text/xml");
      return reply.send(twiml.toString());
    }

    if (session.stage === "book_address") {
      if (!looksLikeAddress(speech)) {
        await addPromptAndGather(
          twiml,
          "Please give me the full service address including street name, city, and zip code."
        );
        reply.type("text/xml");
        return reply.send(twiml.toString());
      }

      session.booking.address = speech.trim();
      session.stage = "book_email_optional";
      await addPromptAndGather(
        twiml,
        "If you'd like an email confirmation too, please say your email slowly, for example anna at gmail dot com, or say skip."
      );
      reply.type("text/xml");
      return reply.send(twiml.toString());
    }

    if (session.stage === "book_email_optional") {
      if (looksLikeSkipEmail(speech)) {
        session.stage = "book_confirm";
        await addPromptAndGather(
          twiml,
          "Please say confirm to finalize, change to edit it, or cancel to cancel it."
        );
        reply.type("text/xml");
        return reply.send(twiml.toString());
      }

      const possibleEmail = spokenEmailToText(speech);
      if (!looksLikeEmail(possibleEmail)) {
        await addPromptAndGather(
          twiml,
          "I didn't catch a valid email. Please say it again slowly, for example anna at gmail dot com, or say skip."
        );
        reply.type("text/xml");
        return reply.send(twiml.toString());
      }

      session.booking.email = possibleEmail;
      session.stage = "book_confirm";
      await addPromptAndGather(
        twiml,
        "Please say confirm to finalize, change to edit it, or cancel to cancel it."
      );
      reply.type("text/xml");
      return reply.send(twiml.toString());
    }

    if (session.stage === "book_confirm") {
      const t = normalizeText(speech);

      if (t.includes("change") || t.includes("edit") || t.includes("reschedule")) {
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

        await createCalendarBooking(session.booking).catch((err) => {
          app.log.error({ err }, "Calendar booking failed");
        });

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

        await speak(
          twiml,
          "You're all set. Your appointment request has been scheduled, and someone from our office will follow up shortly. Thank you for calling. Have a great day."
        );
        twiml.hangup();

        reply.type("text/xml");
        return reply.send(twiml.toString());
      }

      await addPromptAndGather(
        twiml,
        "Please say confirm to finalize, change to edit it, or cancel to cancel it."
      );
      reply.type("text/xml");
      return reply.send(twiml.toString());
    }

    if (session.stage === "reschedule_new_time") {
      session.booking.time = speech;
      session.booking.status = "reschedule_requested";
      bookings.set(session.booking.id, { ...session.booking });

      await maybeSendSmsConfirmation(session.booking).catch((err) => {
        app.log.error({ err }, "SMS reschedule confirmation failed");
      });

      await addPromptAndGather(
        twiml,
        `Perfect. I updated that appointment request to ${session.booking.time}. Someone from ${COMPANY_NAME} will confirm the change shortly. What else can I help you with?`
      );
      session.stage = "normal";
      reply.type("text/xml");
      return reply.send(twiml.toString());
    }

    if (looksLikeBookingIntent(speech)) {
      resetBookingDraft(session);
      session.stage = "offer_booking";
      await addPromptAndGather(
        twiml,
        `Absolutely. Our diagnostic fee is ${DIAGNOSTIC_FEE}. Are you okay to proceed with the appointment?`
      );
      reply.type("text/xml");
      return reply.send(twiml.toString());
    }

    if (looksLikePricingQuestion(speech)) {
      const specificPrice = getSpecificPriceReply(speech);

      if (specificPrice) {
        await addPromptAndGather(twiml, specificPrice);
        reply.type("text/xml");
        return reply.send(twiml.toString());
      }

      await addPromptAndGather(twiml, getBroadPricingReply());
      reply.type("text/xml");
      return reply.send(twiml.toString());
    }

    if (looksLikeHoursQuestion(speech)) {
      await addPromptAndGather(twiml, `We are open ${HOURS}.`);
      reply.type("text/xml");
      return reply.send(twiml.toString());
    }

    if (looksLikeServiceAreaQuestion(speech)) {
      await addPromptAndGather(twiml, `We service ${SERVICE_AREAS}.`);
      reply.type("text/xml");
      return reply.send(twiml.toString());
    }

    const faqReply = getSimpleFaqReply(speech);
    if (faqReply) {
      await addPromptAndGather(twiml, faqReply);
      reply.type("text/xml");
      return reply.send(twiml.toString());
    }

    if (looksLikeUrgentRepair(speech)) {
      session.stage = "offer_booking";
      await addPromptAndGather(
        twiml,
        `I'm sorry you're dealing with that. We can definitely help. Our diagnostic fee is ${DIAGNOSTIC_FEE}. Are you okay to proceed with the appointment?`
      );
      reply.type("text/xml");
      return reply.send(twiml.toString());
    }

    const aiReply = await assistantReply(speech);

    await addPromptAndGather(
      twiml,
      aiReply || "I can help with appointments, pricing, service areas, and HVAC issues. What would you like help with?"
    );

    reply.type("text/xml");
    return reply.send(twiml.toString());
  } catch (err) {
    app.log.error({ err }, "voice-intake crashed");

    await addPromptAndGather(
      twiml,
      "I can help with appointments, pricing, service areas, and HVAC issues. What would you like help with?"
    );

    reply.type("text/xml");
    return reply.send(twiml.toString());
  }
});

app.setErrorHandler((err, _req, reply) => {
  app.log.error({ err }, "Global error handler");
  try {
    const VR = twilio.twiml.VoiceResponse;
    const twiml = new VR();
    twiml.say({ voice: "Polly.Joanna" }, "I'm sorry, please try again.");
    twiml.redirect({ method: "POST" }, "/voice-webhook");
    reply.status(200).type("text/xml").send(twiml.toString());
  } catch {
    reply.status(200).type("text/xml").send("<Response><Say>Okay.</Say></Response>");
  }
});

app.listen({ port: PORT, host: "0.0.0.0" })
  .then(() => {
    console.log(`Server listening on ${PORT}`);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
