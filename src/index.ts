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
const HOURS = (process.env.HOURS || "Monday through Friday, 8 AM to 6 PM").trim();
const SERVICE_AREAS = (process.env.SERVICE_AREAS || "Orlando and surrounding areas").trim();

const ELEVENLABS_API_KEY = (process.env.ELEVENLABS_API_KEY || "").trim();
const ELEVENLABS_VOICE_ID =
  (process.env.ELEVENLABS_VOICE_ID || "Ib97zM6uFBc71OWgj75I").trim();

const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
const OPENAI_MODEL = (process.env.OPENAI_MODEL || "gpt-4o-mini").trim();

const TWILIO_ACCOUNT_SID = (process.env.TWILIO_ACCOUNT_SID || "").trim();
const TWILIO_AUTH_TOKEN = (process.env.TWILIO_AUTH_TOKEN || "").trim();
const FROM_NUMBER = (process.env.FROM_NUMBER || "").trim();

const EMAIL_WEBHOOK_URL = (process.env.EMAIL_WEBHOOK_URL || "").trim();

const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;
const smsClient =
  TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN
    ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
    : null;

type BookingRecord = {
  id: string;
  callSid: string;
  callerPhone?: string;
  name?: string;
  time?: string;
  address?: string;
  issue?: string;
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
  | "book_email_optional"
  | "book_confirm"
  | "cancel_lookup"
  | "reschedule_lookup"
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

function getSession(callSid: string, callerPhone?: string): Session {
  const existing = sessions.get(callSid);
  if (existing) {
    if (callerPhone && !existing.callerPhone) existing.callerPhone = callerPhone;
    if (callerPhone && !existing.booking.callerPhone) existing.booking.callerPhone = callerPhone;
    return existing;
  }

  const booking: BookingRecord = {
    id: crypto.randomBytes(4).toString("hex"),
    callSid,
    callerPhone,
    status: "pending",
    createdAt: new Date().toISOString(),
  };

  const s: Session = {
    callSid,
    callerPhone,
    stage: "normal",
    noSpeechCount: 0,
    booking,
  };

  sessions.set(callSid, s);
  return s;
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

function priceMenu() {
  return [
    `Diagnostic visit: ${DIAGNOSTIC_FEE}`,
    "Tune-up: $129",
    "Condensate drain clearing: $149",
    "Capacitor replacement: $185 to $325",
    "Thermostat installation: $199 to $399",
    "Blower motor replacement: $450 to $950",
    "Contactor replacement: $175 to $295",
    "Refrigerant service: priced after diagnosis",
    "Full system replacement: quoted after inspection",
  ].join(". ");
}

function looksLikeBookingIntent(text: string) {
  const t = text.toLowerCase();
  return [
    "book",
    "booking",
    "appointment",
    "schedule",
    "come out",
    "send someone",
    "send a technician",
    "service call",
    "have someone come",
    "set something up",
    "make an appointment",
  ].some((k) => t.includes(k));
}

function looksLikeCancelIntent(text: string) {
  const t = text.toLowerCase();
  return ["cancel", "cancel appointment", "cancel booking"].some((k) =>
    t.includes(k)
  );
}

function looksLikeRescheduleIntent(text: string) {
  const t = text.toLowerCase();
  return [
    "reschedule",
    "change appointment",
    "change booking",
    "move appointment",
    "change the time",
  ].some((k) => t.includes(k));
}

function looksLikePricingQuestion(text: string) {
  const t = text.toLowerCase();
  return (
    t.includes("price") ||
    t.includes("cost") ||
    t.includes("how much") ||
    t.includes("diagnostic") ||
    t.includes("estimate") ||
    t.includes("pricing") ||
    t.includes("service fee")
  );
}

function looksLikeHoursQuestion(text: string) {
  const t = text.toLowerCase();
  return (
    t.includes("hours") ||
    t.includes("open") ||
    t.includes("close") ||
    t.includes("when are you open")
  );
}

function looksLikeServiceAreaQuestion(text: string) {
  const t = text.toLowerCase();
  return (
    t.includes("service area") ||
    t.includes("serve") ||
    t.includes("area") ||
    t.includes("come to") ||
    t.includes("do you service")
  );
}

function looksLikeUrgentRepair(text: string) {
  const t = text.toLowerCase();
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
    t.includes("hot in here")
  );
}

function looksLikeAppointmentQuestion(text: string) {
  const t = text.toLowerCase();
  return (
    t.includes("what is the appointment for") ||
    t.includes("what's the appointment for") ||
    t.includes("what happens at the appointment") ||
    t.includes("what does the technician do") ||
    t.includes("what are they coming for") ||
    t.includes("what is included") ||
    t.includes("what does the diagnostic include") ||
    t.includes("why do i need an appointment")
  );
}

function looksLikeAvailabilityQuestion(text: string) {
  const t = text.toLowerCase();
  return (
    t.includes("availability") ||
    t.includes("today") ||
    t.includes("tomorrow") ||
    t.includes("earliest") ||
    t.includes("soonest") ||
    t.includes("when can someone come")
  );
}

function looksLikeYes(text: string) {
  const t = text.trim().toLowerCase();
  return ["yes", "yeah", "yep", "sure", "okay", "ok", "please", "correct", "confirm"].some(
    (k) => t.includes(k)
  );
}

function looksLikeNo(text: string) {
  const t = text.trim().toLowerCase();
  return ["no", "nope", "not right now", "maybe later"].some((k) => t.includes(k));
}

function looksLikeBye(text: string) {
  const t = text.trim().toLowerCase();
  return ["bye", "goodbye", "that is all", "that's all", "hang up"].some((k) =>
    t.includes(k)
  );
}

function looksLikeName(text: string) {
  const t = text.trim();
  if (!t) return false;
  if (t.length > 60) return false;

  const low = t.toLowerCase();
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
  ];
  if (bad.some((w) => low === w || low.includes(w))) return false;

  return /^[a-zA-Z][a-zA-Z\s.'-]{0,58}$/.test(t);
}

function looksLikeTime(text: string) {
  const t = text.toLowerCase();
  return (
    /\b\d{1,2}(:\d{2})?\s?(am|pm)\b/.test(t) ||
    /\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|morning|afternoon|evening)\b/.test(
      t
    )
  );
}

function looksLikeAddress(text: string) {
  const t = text.trim();
  return t.length >= 6 && /\d/.test(t);
}

function looksLikeEmail(text: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text.trim());
}

function looksLikeSkipEmail(text: string) {
  const t = text.toLowerCase();
  return ["skip", "no email", "no", "none", "not now"].some((k) => t.includes(k));
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

async function elevenLabsTTS(text: string): Promise<string> {
  if (!ELEVENLABS_API_KEY || !ELEVENLABS_VOICE_ID) {
    throw new Error("Missing ELEVENLABS_API_KEY or ELEVENLABS_VOICE_ID");
  }

  const body = {
    text,
    model_id: "eleven_turbo_v2_5",
    voice_settings: {
      stability: 0.42,
      similarity_boost: 0.9,
    },
  };

  const resp = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify(body),
    }
  );

  if (!resp.ok) {
    const msg = await resp.text().catch(() => "");
    throw new Error(`ElevenLabs error ${resp.status}: ${msg}`);
  }

  const buf = Buffer.from(await resp.arrayBuffer());
  const dir = ensureAudioDir();
  const file = `tts_${crypto.randomBytes(8).toString("hex")}.mp3`;
  fs.writeFileSync(path.join(dir, file), buf);

  return `/audio/${file}`;
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

function addGatherLoop(twiml: any) {
  twiml.gather({
    input: ["speech"],
    action: "/voice-intake",
    method: "POST",
    speechTimeout: "auto",
    timeout: 4,
    language: "en-US",
  });
}

async function assistantReply(userText: string) {
  if (!openai) {
    return "I can help with scheduling, pricing, service areas, cancellations, and general HVAC questions. What would you like help with?";
  }

  const system = `
You are the warm, professional office receptionist for ${COMPANY_NAME}.

Company information:
- Hours: ${HOURS}
- Service areas: ${SERVICE_AREAS}
- Diagnostic fee: ${DIAGNOSTIC_FEE}
- Pricing examples: ${priceMenu()}

Rules:
- Sound human, warm, and concise.
- Do not say "I am listening".
- If asked about pricing, mention a few specific example prices.
- If asked about an appointment, explain it clearly.
- If asked about scheduling, cancellations, or rescheduling, be helpful.
- Ask only one short follow-up when needed.
- Keep responses phone-friendly and short.
`;

  const resp = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    temperature: 0.3,
    max_tokens: 140,
    messages: [
      { role: "system", content: system },
      { role: "user", content: userText },
    ],
  });

  return (
    resp.choices?.[0]?.message?.content?.trim() ||
    "Could you repeat that for me?"
  );
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
  if (!EMAIL_WEBHOOK_URL || !booking.email) return;

  await fetch(EMAIL_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      to: booking.email,
      subject: `${COMPANY_NAME} appointment confirmation`,
      message:
        `Your appointment request has been confirmed.\n\n` +
        `Name: ${booking.name || ""}\n` +
        `Time: ${booking.time || ""}\n` +
        `Address: ${booking.address || ""}\n` +
        `Issue: ${booking.issue || ""}\n\n` +
        `If you need to change or cancel, please reply or call us.`,
      booking,
    }),
  }).catch((err) => {
    app.log.error({ err }, "Email webhook failed");
  });
}

async function answerQuestionDuringBooking(text: string) {
  if (looksLikeAppointmentQuestion(text)) {
    return `The appointment is for an HVAC diagnostic visit. A technician comes out, checks the system, identifies the issue, and explains the recommended repair or next step. The diagnostic fee is ${DIAGNOSTIC_FEE}.`;
  }

  if (looksLikePricingQuestion(text)) {
    return `${priceMenu()}.`;
  }

  if (looksLikeHoursQuestion(text)) {
    return `We are open ${HOURS}.`;
  }

  if (looksLikeServiceAreaQuestion(text)) {
    return `We service ${SERVICE_AREAS}.`;
  }

  if (looksLikeAvailabilityQuestion(text)) {
    return `We can request the soonest available appointment, including same day or next day when available.`;
  }

  return assistantReply(
    `The caller is already in the booking process and asked this side question: ${text}. Answer briefly and naturally, then stop.`
  );
}

app.get("/health", async () => ({ ok: true }));

app.post("/voice-webhook", async (req: any, reply: any) => {
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const twiml = new VoiceResponse();

  const callSid = (req.body?.CallSid || "NO_CALLSID").toString();
  const callerPhone = (req.body?.From || "").toString().trim();
  getSession(callSid, callerPhone);

  await speak(
    twiml,
    `Thank you for calling ${COMPANY_NAME}. This is the office. How can I help you today?`
  );
  addGatherLoop(twiml);

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
        await speak(
          twiml,
          "I didn't catch anything. Please call us back when you're ready. Thank you."
        );
        twiml.hangup();
        reply.type("text/xml");
        return reply.send(twiml.toString());
      }

      await speak(twiml, "Sorry, I didn't catch that. Could you say that one more time?");
      addGatherLoop(twiml);
      reply.type("text/xml");
      return reply.send(twiml.toString());
    }

    session.noSpeechCount = 0;

    if (looksLikeBye(speech)) {
      await speak(twiml, `Thank you for calling ${COMPANY_NAME}. Have a great day.`);
      twiml.hangup();
      reply.type("text/xml");
      return reply.send(twiml.toString());
    }

    if (looksLikeCancelIntent(speech)) {
      session.stage = "cancel_lookup";
      await speak(
        twiml,
        "I can help with that. Let me look up your latest appointment request from this phone number."
      );

      const latest = findLatestBookingByPhone(session.callerPhone);
      if (!latest || latest.status === "cancelled") {
        await speak(
          twiml,
          "I do not see an active appointment on this number right now. What else can I help you with today?"
        );
        session.stage = "normal";
        addGatherLoop(twiml);
        reply.type("text/xml");
        return reply.send(twiml.toString());
      }

      latest.status = "cancelled";
      bookings.set(latest.id, latest);

      await speak(
        twiml,
        `Your appointment under ${latest.name || "your name"} has been cancelled. What else can I help you with?`
      );
      session.stage = "normal";
      addGatherLoop(twiml);
      reply.type("text/xml");
      return reply.send(twiml.toString());
    }

    if (looksLikeRescheduleIntent(speech)) {
      const latest = findLatestBookingByPhone(session.callerPhone);

      if (!latest || latest.status === "cancelled") {
        await speak(
          twiml,
          "I do not see an active appointment to change on this number right now. Would you like to schedule a new one?"
        );
        session.stage = "offer_booking";
        addGatherLoop(twiml);
        reply.type("text/xml");
        return reply.send(twiml.toString());
      }

      session.booking = { ...latest };
      session.stage = "reschedule_new_time";
      await speak(
        twiml,
        `Of course. Your current appointment is for ${latest.time || "the requested time"}. What new day and time would you prefer?`
      );
      addGatherLoop(twiml);
      reply.type("text/xml");
      return reply.send(twiml.toString());
    }

    if (session.stage === "offer_booking") {
      if (looksLikeYes(speech)) {
        session.stage = "book_name";
        resetBookingDraft(session);
        await speak(twiml, "Perfect. What name should I put the appointment under?");
        addGatherLoop(twiml);
        reply.type("text/xml");
        return reply.send(twiml.toString());
      }

      if (looksLikeNo(speech)) {
        session.stage = "normal";
        await speak(twiml, "No problem. What else can I help you with today?");
        addGatherLoop(twiml);
        reply.type("text/xml");
        return reply.send(twiml.toString());
      }

      const offerReply = await answerQuestionDuringBooking(speech);
      await speak(twiml, `${offerReply} Would you like me to get that scheduled for you?`);
      addGatherLoop(twiml);
      reply.type("text/xml");
      return reply.send(twiml.toString());
    }

    if (session.stage === "book_name") {
      if (looksLikePricingQuestion(speech) || looksLikeAppointmentQuestion(speech) || looksLikeHoursQuestion(speech) || looksLikeServiceAreaQuestion(speech)) {
        const sideReply = await answerQuestionDuringBooking(speech);
        await speak(twiml, `${sideReply} When you're ready, what name should I put the appointment under?`);
        addGatherLoop(twiml);
        reply.type("text/xml");
        return reply.send(twiml.toString());
      }

      if (!looksLikeName(speech)) {
        await speak(
          twiml,
          "Sorry, I did not catch the name. What name should I put the appointment under?"
        );
        addGatherLoop(twiml);
        reply.type("text/xml");
        return reply.send(twiml.toString());
      }

      session.booking.name = speech;
      session.stage = "book_issue";
      await speak(twiml, "Thank you. What issue are you having with the system?");
      addGatherLoop(twiml);
      reply.type("text/xml");
      return reply.send(twiml.toString());
    }

    if (session.stage === "book_issue") {
      if (!speech || speech.length < 3) {
        await speak(twiml, "Could you briefly tell me what is going on with the system?");
        addGatherLoop(twiml);
        reply.type("text/xml");
        return reply.send(twiml.toString());
      }

      session.booking.issue = speech;
      session.stage = "book_time";
      await speak(twiml, "Got it. What day and time works best for you?");
      addGatherLoop(twiml);
      reply.type("text/xml");
      return reply.send(twiml.toString());
    }

    if (session.stage === "book_time") {
      if (looksLikePricingQuestion(speech) || looksLikeAppointmentQuestion(speech) || looksLikeHoursQuestion(speech) || looksLikeServiceAreaQuestion(speech)) {
        const sideReply = await answerQuestionDuringBooking(speech);
        await speak(twiml, `${sideReply} What day and time would you like for the appointment?`);
        addGatherLoop(twiml);
        reply.type("text/xml");
        return reply.send(twiml.toString());
      }

      if (!looksLikeTime(speech)) {
        await speak(
          twiml,
          "Got it. What day and approximate time would you prefer for the appointment?"
        );
        addGatherLoop(twiml);
        reply.type("text/xml");
        return reply.send(twiml.toString());
      }

      session.booking.time = speech;
      session.stage = "book_address";
      await speak(twiml, "Thank you. What is the service address?");
      addGatherLoop(twiml);
      reply.type("text/xml");
      return reply.send(twiml.toString());
    }

    if (session.stage === "book_address") {
      if (!looksLikeAddress(speech)) {
        await speak(twiml, "Please give me the full service address, including the street number.");
        addGatherLoop(twiml);
        reply.type("text/xml");
        return reply.send(twiml.toString());
      }

      session.booking.address = speech;
      session.stage = "book_email_optional";
      await speak(
        twiml,
        "Perfect. If you'd like an email confirmation too, you can say the email now, or say skip."
      );
      addGatherLoop(twiml);
      reply.type("text/xml");
      return reply.send(twiml.toString());
    }

    if (session.stage === "book_email_optional") {
      if (looksLikeSkipEmail(speech)) {
        session.stage = "book_confirm";
        await speak(
          twiml,
          `Perfect. I have your appointment request under ${session.booking.name}, for ${session.booking.time}, at ${session.booking.address}, regarding ${session.booking.issue}. The diagnostic fee is ${DIAGNOSTIC_FEE}. Say confirm to finalize, or say change if you want to edit it.`
        );
        addGatherLoop(twiml);
        reply.type("text/xml");
        return reply.send(twiml.toString());
      }

      if (!looksLikeEmail(speech)) {
        await speak(
          twiml,
          "I didn't catch a valid email. You can say the email again, or say skip."
        );
        addGatherLoop(twiml);
        reply.type("text/xml");
        return reply.send(twiml.toString());
      }

      session.booking.email = speech.trim();
      session.stage = "book_confirm";
      await speak(
        twiml,
        `Perfect. I have your appointment request under ${session.booking.name}, for ${session.booking.time}, at ${session.booking.address}, regarding ${session.booking.issue}. The diagnostic fee is ${DIAGNOSTIC_FEE}. Say confirm to finalize, or say change if you want to edit it.`
      );
      addGatherLoop(twiml);
      reply.type("text/xml");
      return reply.send(twiml.toString());
    }

    if (session.stage === "book_confirm") {
      const t = speech.toLowerCase();

      if (t.includes("change") || t.includes("edit") || t.includes("reschedule")) {
        session.stage = "book_time";
        await speak(twiml, "No problem. What day and time would you like instead?");
        addGatherLoop(twiml);
        reply.type("text/xml");
        return reply.send(twiml.toString());
      }

      if (t.includes("cancel")) {
        session.stage = "normal";
        resetBookingDraft(session);
        await speak(twiml, "No problem. I cancelled that request. What else can I help you with?");
        addGatherLoop(twiml);
        reply.type("text/xml");
        return reply.send(twiml.toString());
      }

      if (t.includes("confirm") || looksLikeYes(speech)) {
        session.booking.status = "confirmed";
        bookings.set(session.booking.id, { ...session.booking });

        await maybeSendSmsConfirmation(session.booking).catch((err) => {
          app.log.error({ err }, "SMS confirmation failed");
        });

        await maybeSendEmailConfirmation(session.booking);

        await speak(
          twiml,
          `Confirmed. Your request is under ${session.booking.name} for ${session.booking.time} at ${session.booking.address}. I also sent a confirmation ${session.booking.email ? "by text and email" : "by text"}. Someone from ${COMPANY_NAME} will follow up shortly. What else can I help you with?`
        );

        session.stage = "normal";
        addGatherLoop(twiml);
        reply.type("text/xml");
        return reply.send(twiml.toString());
      }

      await speak(twiml, 'Please say "confirm" to finalize, say "change" to edit it, or say "cancel" to cancel it.');
      addGatherLoop(twiml);
      reply.type("text/xml");
      return reply.send(twiml.toString());
    }

    if (session.stage === "reschedule_new_time") {
      if (!looksLikeTime(speech)) {
        await speak(twiml, "What new day and approximate time would you prefer?");
        addGatherLoop(twiml);
        reply.type("text/xml");
        return reply.send(twiml.toString());
      }

      session.booking.time = speech;
      session.booking.status = "reschedule_requested";
      bookings.set(session.booking.id, { ...session.booking });

      await maybeSendSmsConfirmation(session.booking).catch((err) => {
        app.log.error({ err }, "SMS reschedule confirmation failed");
      });

      await speak(
        twiml,
        `Perfect. I updated the appointment request to ${session.booking.time}. Someone from ${COMPANY_NAME} will confirm the change shortly. What else can I help you with?`
      );
      session.stage = "normal";
      addGatherLoop(twiml);
      reply.type("text/xml");
      return reply.send(twiml.toString());
    }

    if (looksLikeBookingIntent(speech)) {
      resetBookingDraft(session);
      session.stage = "book_name";
      await speak(twiml, "Absolutely. Let's get that scheduled. What name should I put the appointment under?");
      addGatherLoop(twiml);
      reply.type("text/xml");
      return reply.send(twiml.toString());
    }

    if (looksLikePricingQuestion(speech)) {
      await speak(twiml, priceMenu());
      addGatherLoop(twiml);
      reply.type("text/xml");
      return reply.send(twiml.toString());
    }

    if (looksLikeHoursQuestion(speech)) {
      await speak(twiml, `We are open ${HOURS}.`);
      addGatherLoop(twiml);
      reply.type("text/xml");
      return reply.send(twiml.toString());
    }

    if (looksLikeServiceAreaQuestion(speech)) {
      await speak(twiml, `We service ${SERVICE_AREAS}.`);
      addGatherLoop(twiml);
      reply.type("text/xml");
      return reply.send(twiml.toString());
    }

    if (looksLikeUrgentRepair(speech)) {
      session.stage = "offer_booking";
      await speak(
        twiml,
        "I'm sorry you're dealing with that. We can help with that. Would you like me to get you scheduled?"
      );
      addGatherLoop(twiml);
      reply.type("text/xml");
      return reply.send(twiml.toString());
    }

    const aiReply = await assistantReply(speech);
    await speak(twiml, aiReply);
    addGatherLoop(twiml);

    reply.type("text/xml");
    return reply.send(twiml.toString());
  } catch (err) {
    app.log.error({ err }, "voice-intake crashed");
    twiml.say({ voice: "Polly.Joanna" }, "Sorry, please repeat that.");
    addGatherLoop(twiml);
    reply.type("text/xml");
    return reply.send(twiml.toString());
  }
});

app.setErrorHandler((err, _req, reply) => {
  app.log.error({ err }, "Global error handler");
  try {
    const VR = twilio.twiml.VoiceResponse;
    const twiml = new VR();
    twiml.say({ voice: "Polly.Joanna" }, "Sorry, please try again.");
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
