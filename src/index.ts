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
import * as chrono from "chrono-node";
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

// ─── Config ───────────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT || 3000);
const BASE_URL = (process.env.BASE_URL || "").trim();
const COMPANY_NAME = (process.env.COMPANY_NAME || "E&E HVAC").trim();
const DIAGNOSTIC_FEE = (process.env.DIAGNOSTIC_FEE || "$99").trim();
const HOURS = (process.env.HOURS || "Monday through Friday, 8 AM to 6 PM").trim();
const SERVICE_AREAS = (process.env.SERVICE_AREAS || "Orlando, Kissimmee, Winter Garden, Ocoee, Clermont, and surrounding Central Florida").trim();

const GOOGLE_CLIENT_EMAIL = (process.env.GOOGLE_CLIENT_EMAIL || "").trim();
const GOOGLE_PRIVATE_KEY = (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n").trim();
const GOOGLE_CALENDAR_ID = (process.env.GOOGLE_CALENDAR_ID || "").trim();
const TIMEZONE = (process.env.TIMEZONE || "America/New_York").trim();
const APPT_DURATION_MIN = Number(process.env.APPOINTMENT_DURATION_MINUTES || 60);

const ELEVENLABS_VOICE_ID = (process.env.ELEVENLABS_VOICE_ID || "").trim();
const ELEVENLABS_API_KEY = (process.env.ELEVENLABS_API_KEY || "").trim();
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
const OPENAI_MODEL = (process.env.OPENAI_MODEL || "gpt-4o").trim();
const TWILIO_ACCOUNT_SID = (process.env.TWILIO_ACCOUNT_SID || "").trim();
const TWILIO_AUTH_TOKEN = (process.env.TWILIO_AUTH_TOKEN || "").trim();
const FROM_NUMBER = (process.env.FROM_NUMBER || "").trim();
const HUBSPOT_API_KEY = (process.env.HUBSPOT_API_KEY || "").trim();
const EMAIL_FROM = (process.env.EMAIL_FROM || "onboarding@resend.dev").trim();

// ─── Clients ──────────────────────────────────────────────────────────────────

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

const calendar = googleAuth ? google.calendar({ version: "v3", auth: googleAuth }) : null;
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

// ─── Types ────────────────────────────────────────────────────────────────────

type Message = { role: "user" | "assistant" | "system"; content: string };

type BookingData = {
  name?: string;
  phone?: string;
  email?: string;
  issue?: string;
  address?: string;
  requestedTime?: string;
  confirmedStart?: Date;
  calendarEventId?: string;
  confirmed?: boolean;
};

type Session = {
  callSid: string;
  callerPhone: string;
  history: Message[];
  booking: BookingData;
  awaitingEmailConfirm?: string;
  bookedAndDone?: boolean;
  silenceCount: number;
};

const sessions = new Map<string, Session>();

function getSession(callSid: string, callerPhone: string): Session {
  if (sessions.has(callSid)) return sessions.get(callSid)!;
  const session: Session = {
    callSid,
    callerPhone,
    history: [],
    booking: { phone: callerPhone },
    silenceCount: 0,
  };
  sessions.set(callSid, session);
  return session;
}

// ─── Calendar ─────────────────────────────────────────────────────────────────

async function getCalendarBusySlots(date: Date): Promise<{ start: Date; end: Date }[]> {
  if (!calendar || !GOOGLE_CALENDAR_ID) return [];
  const dayStart = new Date(date);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(date);
  dayEnd.setHours(23, 59, 59, 999);
  try {
    const res = await calendar.freebusy.query({
      requestBody: {
        timeMin: dayStart.toISOString(),
        timeMax: dayEnd.toISOString(),
        timeZone: TIMEZONE,
        items: [{ id: GOOGLE_CALENDAR_ID }],
      },
    });
    const busy = res.data?.calendars?.[GOOGLE_CALENDAR_ID]?.busy || [];
    return busy.map((b: any) => ({ start: new Date(b.start), end: new Date(b.end) }));
  } catch (err) {
    app.log.error({ err }, "freebusy query failed");
    return [];
  }
}

function isSlotFree(proposed: Date, busy: { start: Date; end: Date }[]): boolean {
  const end = new Date(proposed.getTime() + APPT_DURATION_MIN * 60000);
  return !busy.some((s) => proposed < s.end && end > s.start);
}

function formatTimeForSpeech(date: Date): string {
  return date.toLocaleString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: TIMEZONE,
  });
}

async function checkAvailability(requestedText: string): Promise<{
  available: boolean;
  proposedDate?: Date;
  spokenTime?: string;
  alternativeSpoken?: string;
  alternativeDate?: Date;
}> {
  const parsed = chrono.parseDate(requestedText, new Date(), { forwardDate: true });
  if (!parsed) return { available: false };

  const busy = await getCalendarBusySlots(parsed);

  if (isSlotFree(parsed, busy)) {
    return { available: true, proposedDate: parsed, spokenTime: formatTimeForSpeech(parsed) };
  }

  for (let h = 1; h <= 8; h++) {
    const alt = new Date(parsed.getTime() + h * 3600000);
    if (alt.getHours() < 8 || alt.getHours() >= 18) continue;
    if (isSlotFree(alt, busy)) {
      return {
        available: false,
        proposedDate: parsed,
        alternativeDate: alt,
        alternativeSpoken: formatTimeForSpeech(alt),
      };
    }
  }

  return { available: false, proposedDate: parsed };
}

async function createCalendarEvent(booking: BookingData): Promise<string | null> {
  if (!calendar || !GOOGLE_CALENDAR_ID || !booking.confirmedStart) return null;
  const start = booking.confirmedStart;
  const end = new Date(start.getTime() + APPT_DURATION_MIN * 60000);
  try {
    const event = await calendar.events.insert({
      calendarId: GOOGLE_CALENDAR_ID,
      requestBody: {
        summary: `${COMPANY_NAME} – ${booking.name || "Customer"}`,
        description: `Issue: ${booking.issue || ""}\nPhone: ${booking.phone || ""}\nEmail: ${booking.email || ""}`,
        location: booking.address || "",
        start: { dateTime: start.toISOString(), timeZone: TIMEZONE },
        end: { dateTime: end.toISOString(), timeZone: TIMEZONE },
      },
    });
    app.log.info({ eventId: event.data.id }, "✅ Calendar event created");
    return event.data.id || null;
  } catch (err: any) {
    app.log.error({ err: err?.message, code: err?.code }, "❌ Calendar event failed");
    return null;
  }
}

// ─── Notifications ────────────────────────────────────────────────────────────

async function sendSmsConfirmation(booking: BookingData) {
  if (!smsClient || !FROM_NUMBER || !booking.phone) return;
  const timeStr = booking.confirmedStart
    ? formatTimeForSpeech(booking.confirmedStart)
    : booking.requestedTime || "your requested time";
  await smsClient.messages.create({
    from: FROM_NUMBER,
    to: booking.phone,
    body:
      `Hi ${booking.name || "there"}, your ${COMPANY_NAME} appointment is confirmed for ${timeStr} ` +
      `at ${booking.address || "your address"}. Issue: ${booking.issue || "HVAC service"}. ` +
      `Call or reply to change or cancel.`,
  });
  app.log.info({ to: booking.phone }, "✅ SMS sent");
}

async function sendEmailConfirmation(booking: BookingData) {
  if (!resend || !booking.email) return;
  const timeStr = booking.confirmedStart
    ? formatTimeForSpeech(booking.confirmedStart)
    : booking.requestedTime || "To be confirmed";
  try {
    await resend.emails.send({
      from: EMAIL_FROM,
      to: [booking.email],
      subject: `${COMPANY_NAME} – Appointment Confirmed`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:520px;color:#222">
          <h2 style="color:#1a73e8">${COMPANY_NAME}</h2>
          <p>Hi ${booking.name || "there"},</p>
          <p>Your appointment has been confirmed. Here are the details:</p>
          <table style="width:100%;border-collapse:collapse;margin:12px 0">
            <tr style="background:#f0f4ff"><td style="padding:8px;font-weight:bold">Date &amp; Time</td><td style="padding:8px">${timeStr}</td></tr>
            <tr><td style="padding:8px;font-weight:bold">Address</td><td style="padding:8px">${booking.address || ""}</td></tr>
            <tr style="background:#f0f4ff"><td style="padding:8px;font-weight:bold">Issue</td><td style="padding:8px">${booking.issue || ""}</td></tr>
            <tr><td style="padding:8px;font-weight:bold">Phone</td><td style="padding:8px">${booking.phone || ""}</td></tr>
          </table>
          <p>A technician will follow up to confirm your appointment shortly.</p>
          <p>Thank you,<br/><strong>${COMPANY_NAME}</strong></p>
        </div>`,
    });
    app.log.info({ to: booking.email }, "✅ Email sent");
  } catch (err: any) {
    app.log.error({ err: err?.message }, "❌ Email failed");
  }
}

async function createHubSpotContact(booking: BookingData) {
  if (!HUBSPOT_API_KEY) return;
  const props: Record<string, string> = { hs_lead_status: "NEW" };
  if (booking.email) props.email = booking.email;
  if (booking.phone) props.phone = booking.phone;
  if (booking.name) {
    const parts = booking.name.trim().split(/\s+/);
    props.firstname = parts[0];
    if (parts.length > 1) props.lastname = parts.slice(1).join(" ");
  }
  try {
    const r = await fetch("https://api.hubapi.com/crm/v3/objects/contacts", {
      method: "POST",
      headers: { Authorization: `Bearer ${HUBSPOT_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ properties: props }),
    });
    if (!r.ok && r.status !== 409) app.log.error({ status: r.status }, "HubSpot failed");
    else app.log.info("✅ HubSpot contact saved");
  } catch (err: any) {
    app.log.error({ err: err?.message }, "HubSpot error");
  }
}

// ─── TTS ──────────────────────────────────────────────────────────────────────

function ensureAudioDir() {
  const dir = path.join(process.cwd(), "public", "audio");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function elevenLabsTTS(text: string): Promise<string> {
  const hash = crypto.createHash("sha1").update(text).digest("hex");
  const file = `tts_${hash}.mp3`;
  const abs = path.join(ensureAudioDir(), file);
  const rel = `/audio/${file}`;
  if (fs.existsSync(abs)) return rel;

  const resp = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`, {
    method: "POST",
    headers: {
      "xi-api-key": ELEVENLABS_API_KEY,
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
    },
    body: JSON.stringify({
      text,
      model_id: "eleven_turbo_v2",
      voice_settings: { stability: 0.45, similarity_boost: 0.88, style: 0.08, use_speaker_boost: true },
    }),
  });

  if (!resp.ok) throw new Error(`ElevenLabs ${resp.status}: ${await resp.text()}`);
  fs.writeFileSync(abs, Buffer.from(await resp.arrayBuffer()));
  return rel;
}

async function playAudio(node: any, text: string) {
  try {
    const rel = await elevenLabsTTS(text);
    if (BASE_URL.startsWith("https://")) { node.play(`${BASE_URL}${rel}`); return; }
  } catch (e) { app.log.error({ err: e }, "ElevenLabs failed, using Polly"); }
  node.say({ voice: "Polly.Joanna" }, text);
}

async function gatherWithPrompt(twiml: any, text: string) {
  const gather = twiml.gather({
    input: "speech",
    action: BASE_URL.startsWith("https://") ? `${BASE_URL}/voice-intake` : "/voice-intake",
    method: "POST",
    speechTimeout: "auto",
    timeout: 6,
    actionOnEmptyResult: true,
    language: "en-US",
    enhanced: true,
    speechModel: "phone_call",
    profanityFilter: false,
  });
  await playAudio(gather, text);
}

// ─── System prompt ────────────────────────────────────────────────────────────

function buildSystemPrompt(): string {
  return `You are Ed, the live receptionist for ${COMPANY_NAME}, an HVAC company serving ${SERVICE_AREAS}.

Your personality:
- Warm, friendly, calm, and completely natural — like a real person on the phone
- Short conversational sentences — never robotic or stiff
- Never repeat the caller's words back awkwardly
- Never say "I heard you say" or read back raw input like form fields
- Sound genuinely helpful and caring

Company info you can share:
- Hours: ${HOURS}
- Service areas: ${SERVICE_AREAS}
- Diagnostic fee: ${DIAGNOSTIC_FEE} (mention it's waived if we do the repair same visit)
- Services: AC repair, heating repair, full diagnostics, tune-ups, preventative maintenance, thermostat installation, drain line clearing, capacitor replacement, contactor replacement, blower motor replacement, refrigerant service, full system replacement quotes, and inspections

Pricing (only share when asked):
- Diagnostic visit: ${DIAGNOSTIC_FEE}
- Tune-up / maintenance: $129
- Drain line clearing: $149  
- Capacitor replacement: $185–$325
- Thermostat install: $199–$399
- Blower motor: $450–$950
- Most repairs are quoted after the diagnostic

How to handle the booking flow (collect naturally in conversation):
1. Get their name — ask naturally, like "Sure! Who am I speaking with?"
2. Ask what's going on with the system
3. Ask what day and time works for them — then wait for [AVAILABILITY] info before confirming
4. Get the service address
5. Ask for email once, casually — "And if you'd like a confirmation email, what's the best email for you?" Accept skip/no thanks
6. Summarize warmly before confirming — say something like "Alright, so I've got [name] down for [issue] on [day] at [time] at [address]. Does that all look right?"
7. After they confirm, wrap it up warmly

Availability:
- When a [AVAILABILITY] message appears, use that information to respond naturally
- If available: confirm it naturally — "Perfect, that time works!"
- If taken: "Oh, that time is actually taken — I do have an opening at [alt time] though, would that work for you?"
- If nothing available: "Hmm, I'm not seeing anything open at that time. What else might work for you?"

Email capture:
- If they say an email address, confirm it back naturally: "Got it — so that's [email said as words], is that right?"
- If they skip, move on without asking again

After booking confirmed:
- Warmly summarize: "You're all set! I've got you down for [time]. A technician will reach out to confirm. Anything else I can help you with?"
- Keep it short and genuine

Rules:
- NEVER loop on the same question
- If they ask about services, give a friendly natural summary — don't list robotically
- Answer questions naturally and come back to the booking gently
- 1–3 sentences max unless explaining services or summarizing booking
- Sound human every single time`.trim();
}

// ─── Email parser ─────────────────────────────────────────────────────────────

function parseSpokenEmail(text: string): string | null {
  let t = text.trim().toLowerCase();
  t = t.replace(/\s+at\s+/g, "@");
  t = t.replace(/\s+dot\s+/g, ".");
  t = t.replace(/\s+underscore\s+/g, "_");
  t = t.replace(/\s+(dash|hyphen)\s+/g, "-");
  t = t.replace(/\s+/g, "");
  const digits: Record<string, string> = {
    zero:"0",one:"1",two:"2",three:"3",four:"4",
    five:"5",six:"6",seven:"7",eight:"8",nine:"9",
  };
  Object.entries(digits).forEach(([w, d]) => { t = t.replace(new RegExp(w, "g"), d); });
  t = t.replace(/[^a-z0-9@._+-]/g, "");
  return /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(t) ? t : null;
}

function emailToSpeech(email: string): string {
  return email.replace("@", " at ").replace(/\./g, " dot ");
}

function isYes(t: string) {
  return ["yes","yeah","yep","correct","that's right","sure","right","exactly","uh huh"].some((w) => t.toLowerCase().includes(w));
}
function isNo(t: string) {
  return ["no","nope","wrong","that's not","incorrect","not right"].some((w) => t.toLowerCase().includes(w));
}
function isSkip(t: string) {
  return ["skip","no email","no thanks","nope","don't","no need","not now","i don't"].some((w) => t.toLowerCase().includes(w));
}
function isBye(t: string) {
  return ["bye","goodbye","that's all","that is all","hang up","have a good"].some((w) => t.toLowerCase().includes(w));
}
function isThanks(t: string) {
  return ["thank you","thanks so much","appreciate it","perfect thanks","okay thanks","great thanks","thank you so much"].some((w) => t.toLowerCase().includes(w));
}
function isConfirm(t: string) {
  return ["confirm","that's correct","that works","sounds good","book it","go ahead","yes book","looks good","that's right","correct"].some((w) => t.toLowerCase().includes(w));
}
function hasTimeReference(t: string) {
  return /\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}(:\d{2})?\s?(am|pm)|morning|afternoon|evening|next week)\b/i.test(t);
}

// ─── Main turn handler ────────────────────────────────────────────────────────

async function handleTurn(session: Session, userSpeech: string): Promise<string> {
  if (!openai) return "I'm sorry, I'm having some trouble right now. Please call back shortly.";

  // Add to history
  session.history.push({ role: "user", content: userSpeech });

  // ── Email confirmation flow ──
  if (session.awaitingEmailConfirm) {
    if (isYes(userSpeech)) {
      session.booking.email = session.awaitingEmailConfirm;
      session.awaitingEmailConfirm = undefined;
      session.history.push({ role: "system", content: `Email confirmed and saved: ${session.booking.email}. Continue the booking — ask for service address if not yet collected.` });
    } else if (isSkip(userSpeech)) {
      session.awaitingEmailConfirm = undefined;
      session.history.push({ role: "system", content: "Caller skipped email. Do not ask for email again. Continue to service address." });
    } else if (isNo(userSpeech)) {
      session.awaitingEmailConfirm = undefined;
      session.history.push({ role: "system", content: "Email was wrong. Ask them to say it again slowly, or skip." });
    } else {
      const retry = parseSpokenEmail(userSpeech);
      if (retry) {
        session.awaitingEmailConfirm = retry;
        const reply = `Let me try that — I have ${emailToSpeech(retry)}. Is that right?`;
        session.history.push({ role: "assistant", content: reply });
        return reply;
      }
      const reply = "Sorry about that — could you say the email one more time, or just say skip if you'd rather not?";
      session.history.push({ role: "assistant", content: reply });
      return reply;
    }
  }

  // ── Detect email in speech ──
  if (!session.booking.email && !session.awaitingEmailConfirm && !isSkip(userSpeech)) {
    const foundEmail = parseSpokenEmail(userSpeech);
    if (foundEmail) {
      session.awaitingEmailConfirm = foundEmail;
      const reply = `Got it — so that's ${emailToSpeech(foundEmail)}, is that right?`;
      session.history.push({ role: "assistant", content: reply });
      return reply;
    }
  }

  // ── Availability check ──
  let availabilityNote = "";
  if (hasTimeReference(userSpeech) && !session.booking.confirmedStart) {
    session.booking.requestedTime = userSpeech;
    const avail = await checkAvailability(userSpeech);

    if (avail.available && avail.proposedDate) {
      // Store the proposed date — will be confirmed when user says confirm
      session.booking.requestedTime = userSpeech;
      // Temporarily store parsed date for later confirmation
      (session as any)._pendingDate = avail.proposedDate;
      availabilityNote = `[AVAILABILITY] The requested time (${avail.spokenTime}) is OPEN on the calendar. You can confirm this with the caller and move forward.`;
    } else if (avail.alternativeDate) {
      (session as any)._pendingDate = avail.alternativeDate;
      availabilityNote = `[AVAILABILITY] That time is NOT available. The next open slot is ${avail.alternativeSpoken}. Suggest this to the caller naturally.`;
    } else {
      (session as any)._pendingDate = null;
      availabilityNote = `[AVAILABILITY] No availability found near that time. Ask the caller to suggest a different time.`;
    }
  }

  // ── Booking confirmation ──
  if (
    isConfirm(userSpeech) &&
    !session.bookedAndDone &&
    session.booking.name &&
    (session.booking.requestedTime || (session as any)._pendingDate)
  ) {
    const pendingDate = (session as any)._pendingDate;
    if (pendingDate) {
      session.booking.confirmedStart = pendingDate;
    } else if (session.booking.requestedTime) {
      const avail = await checkAvailability(session.booking.requestedTime);
      if (avail.proposedDate) session.booking.confirmedStart = avail.proposedDate;
    }

    if (session.booking.confirmedStart) {
      session.bookedAndDone = true;
      session.booking.confirmed = true;

      // Finalize all integrations
      const [eventId] = await Promise.all([
        createCalendarEvent(session.booking).catch(() => null),
        sendSmsConfirmation(session.booking).catch((e) => app.log.error({ e }, "sms failed")),
        sendEmailConfirmation(session.booking).catch((e) => app.log.error({ e }, "email failed")),
        createHubSpotContact(session.booking).catch((e) => app.log.error({ e }, "hubspot failed")),
      ]);

      if (eventId) session.booking.calendarEventId = eventId;

      const timeStr = formatTimeForSpeech(session.booking.confirmedStart);
      const firstName = session.booking.name?.split(" ")[0] || "there";
      const reply = `You're all set, ${firstName}! I've got you scheduled for ${timeStr}. A technician will reach out to confirm everything. Is there anything else I can help you with?`;
      session.history.push({ role: "assistant", content: reply });
      return reply;
    }
  }

  // ── Build messages for OpenAI ──
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: buildSystemPrompt() },
    ...(availabilityNote ? [{ role: "system" as const, content: availabilityNote }] : []),
    ...session.history.slice(-18).map((m) => ({
      role: m.role as "user" | "assistant" | "system",
      content: m.content,
    })),
  ];

  const resp = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    temperature: 0.45,
    max_tokens: 130,
    messages,
  });

  const reply = resp.choices[0]?.message?.content?.trim() || "I'm sorry, could you say that again?";
  session.history.push({ role: "assistant", content: reply });
  return reply;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get("/health", async () => ({ ok: true, time: new Date().toISOString() }));

app.post("/voice-webhook", async (req: any, reply: any) => {
  const VR = twilio.twiml.VoiceResponse;
  const twiml = new VR();
  const callSid = (req.body?.CallSid || "").toString();
  const callerPhone = (req.body?.From || "").toString().trim();
  getSession(callSid, callerPhone);
  await gatherWithPrompt(twiml, `Thank you for calling ${COMPANY_NAME}. This is Ed, how can I help you today?`);
  reply.type("text/xml");
  return reply.send(twiml.toString());
});

app.post("/voice-intake", async (req: any, reply: any) => {
  const VR = twilio.twiml.VoiceResponse;
  const twiml = new VR();

  try {
    const speech = (req.body?.SpeechResult ?? "").toString().trim();
    const callSid = (req.body?.CallSid || "").toString();
    const callerPhone = (req.body?.From || "").toString().trim();
    const session = getSession(callSid, callerPhone);

    app.log.info({ speech }, "incoming speech");

    // No speech
    if (!speech) {
      session.silenceCount += 1;
      if (session.silenceCount >= 3) {
        await playAudio(twiml, "I'm sorry I couldn't hear you. Feel free to call us back anytime. Have a great day!");
        twiml.hangup();
        reply.type("text/xml");
        return reply.send(twiml.toString());
      }
      const prompts = [
        "I'm sorry, I didn't catch that. Could you say that again?",
        "Still having trouble hearing you — could you speak a little louder?",
      ];
      await gatherWithPrompt(twiml, prompts[Math.min(session.silenceCount - 1, prompts.length - 1)]);
      reply.type("text/xml");
      return reply.send(twiml.toString());
    }

    session.silenceCount = 0;

    // Goodbye
    if (isBye(speech)) {
      await playAudio(twiml, `Thank you for calling ${COMPANY_NAME}. Have a wonderful day!`);
      twiml.hangup();
      reply.type("text/xml");
      return reply.send(twiml.toString());
    }

    // Thanks after booking
    if (isThanks(speech) && session.bookedAndDone) {
      await playAudio(twiml, `Of course! We look forward to seeing you. Have a great day!`);
      twiml.hangup();
      reply.type("text/xml");
      return reply.send(twiml.toString());
    }

    const responseText = await handleTurn(session, speech);
    await gatherWithPrompt(twiml, responseText);

    reply.type("text/xml");
    return reply.send(twiml.toString());
  } catch (err) {
    app.log.error({ err }, "voice-intake error");
    await gatherWithPrompt(twiml, "I'm sorry, I had a little trouble there. Could you say that again?");
    reply.type("text/xml");
    return reply.send(twiml.toString());
  }
});

app.setErrorHandler((err, _req, reply) => {
  app.log.error({ err }, "global error");
  reply.status(200).type("text/xml").send(
    `<Response><Say voice="Polly.Joanna">I'm sorry, something went wrong. Please try again.</Say><Redirect method="POST">/voice-webhook</Redirect></Response>`
  );
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen({ port: PORT, host: "0.0.0.0" }).then(() => {
  console.log(`✅ ${COMPANY_NAME} AI Agent running on port ${PORT}`);
  console.log(`📅 Calendar: ${calendar ? "✅ connected" : "❌ not configured"}`);
  console.log(`📧 Resend:   ${resend ? "✅ connected" : "❌ not configured"}`);
  console.log(`💬 SMS:      ${smsClient ? "✅ connected" : "❌ not configured"}`);
  console.log(`📊 HubSpot:  ${HUBSPOT_API_KEY ? "✅ connected" : "❌ not configured"}`);
  console.log(`🔊 Voice:    ${ELEVENLABS_VOICE_ID ? "✅ ElevenLabs" : "⚠️  Polly fallback"}`);
}).catch((err) => { console.error(err); process.exit(1); });

