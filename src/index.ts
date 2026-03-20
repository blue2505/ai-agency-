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
const COMPANY_NAME = (process.env.COMPANY_NAME || "E and E HVAC").trim();
const COMPANY_EMAIL = (process.env.COMPANY_EMAIL || "").trim();
const DIAGNOSTIC_FEE = (process.env.DIAGNOSTIC_FEE || "$89").trim();
const HOURS = (process.env.HOURS || "Monday through Friday, 8 AM to 6 PM, Saturday 9 AM to 2 PM").trim();
const SERVICE_AREAS = (process.env.SERVICE_AREAS || "Orlando, Kissimmee, Winter Garden, Ocoee, Clermont, and surrounding Central Florida").trim();

const GOOGLE_CLIENT_EMAIL = (process.env.GOOGLE_CLIENT_EMAIL || "").trim();
const GOOGLE_PRIVATE_KEY = (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n").trim();
const GOOGLE_CALENDAR_ID = (process.env.GOOGLE_CALENDAR_ID || "").trim();
const TIMEZONE = (process.env.TIMEZONE || "America/New_York").trim();
const APPT_DURATION_MIN = Number(process.env.APPOINTMENT_DURATION_MINUTES || 60);

const ELEVENLABS_VOICE_ID = (process.env.ELEVENLABS_VOICE_ID || "").trim();
const ELEVENLABS_API_KEY = (process.env.ELEVENLABS_API_KEY || "").trim();
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
const OPENAI_MODEL = (process.env.OPENAI_MODEL || "gpt-4o-mini").trim();
const TWILIO_ACCOUNT_SID = (process.env.TWILIO_ACCOUNT_SID || "").trim();
const TWILIO_AUTH_TOKEN = (process.env.TWILIO_AUTH_TOKEN || "").trim();
const FROM_NUMBER = (process.env.FROM_NUMBER || "").trim();
const HUBSPOT_API_KEY = (process.env.HUBSPOT_API_KEY || "").trim();

// ─── Med Spa Config ──────────────────────────────────────────────────────────
const MEDSPA_TWILIO_NUMBER = (process.env.MEDSPA_TWILIO_NUMBER || "").trim();
const HVAC_TWILIO_NUMBER = (process.env.HVAC_TWILIO_NUMBER || "").trim();
const MEDSPA_COMPANY_NAME = (process.env.MEDSPA_COMPANY_NAME || "Luxe Glow Med Spa").trim();
const MEDSPA_AGENT_NAME = (process.env.MEDSPA_AGENT_NAME || "Sofia").trim();
const MEDSPA_HOURS = (process.env.MEDSPA_HOURS || "Monday through Saturday 9 AM to 7 PM").trim();
const MEDSPA_SERVICE_AREAS = (process.env.MEDSPA_SERVICE_AREAS || "Orlando and surrounding areas").trim();
const MEDSPA_OPENAI_VOICE = (process.env.MEDSPA_OPENAI_VOICE || "nova").trim();
const MEDSPA_EMAIL_FROM = (process.env.MEDSPA_EMAIL_FROM || "onboarding@resend.dev").trim();
const MEDSPA_ELEVENLABS_VOICE_ID = (process.env.MEDSPA_ELEVENLABS_VOICE_ID || "kPzsL2i3teMYv0FxEYQ6").trim();

const EMAIL_FROM = (process.env.EMAIL_FROM || "onboarding@resend.dev").trim();

// ─── Clients ──────────────────────────────────────────────────────────────────

const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;
const smsClient = TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN) : null;
const googleAuth = GOOGLE_CLIENT_EMAIL && GOOGLE_PRIVATE_KEY
  ? new google.auth.JWT({ email: GOOGLE_CLIENT_EMAIL, key: GOOGLE_PRIVATE_KEY, scopes: ["https://www.googleapis.com/auth/calendar"] })
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
  const session: Session = { callSid, callerPhone, history: [], booking: { phone: callerPhone }, silenceCount: 0 };
  sessions.set(callSid, session);
  return session;
}

// ─── Calendar ─────────────────────────────────────────────────────────────────

async function getCalendarBusySlots(date: Date): Promise<{ start: Date; end: Date }[]> {
  if (!calendar || !GOOGLE_CALENDAR_ID) return [];
  const dayStart = new Date(date); dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(date); dayEnd.setHours(23, 59, 59, 999);
  try {
    const res = await calendar.freebusy.query({
      requestBody: { timeMin: dayStart.toISOString(), timeMax: dayEnd.toISOString(), timeZone: TIMEZONE, items: [{ id: GOOGLE_CALENDAR_ID }] },
    });
    const busy = res.data?.calendars?.[GOOGLE_CALENDAR_ID]?.busy || [];
    return busy.map((b: any) => ({ start: new Date(b.start), end: new Date(b.end) }));
  } catch (err) { app.log.error({ err }, "freebusy query failed"); return []; }
}

function isSlotFree(proposed: Date, busy: { start: Date; end: Date }[]): boolean {
  const end = new Date(proposed.getTime() + APPT_DURATION_MIN * 60000);
  return !busy.some((s) => proposed < s.end && end > s.start);
}

function formatTimeForSpeech(date: Date): string {
  return date.toLocaleString("en-US", { weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true, timeZone: TIMEZONE });
}

async function checkAvailability(requestedText: string): Promise<{ available: boolean; proposedDate?: Date; spokenTime?: string; alternativeSpoken?: string; alternativeDate?: Date }> {
  const parsed = chrono.parseDate(requestedText, new Date(), { forwardDate: true });
  if (!parsed) return { available: false };
  const busy = await getCalendarBusySlots(parsed);
  if (isSlotFree(parsed, busy)) return { available: true, proposedDate: parsed, spokenTime: formatTimeForSpeech(parsed) };
  for (let h = 1; h <= 8; h++) {
    const alt = new Date(parsed.getTime() + h * 3600000);
    if (alt.getHours() < 8 || alt.getHours() >= 18) continue;
    if (isSlotFree(alt, busy)) return { available: false, proposedDate: parsed, alternativeDate: alt, alternativeSpoken: formatTimeForSpeech(alt) };
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
  } catch (err: any) { app.log.error({ err: err?.message, code: err?.code }, "❌ Calendar event failed"); return null; }
}

// ─── Notifications ────────────────────────────────────────────────────────────

async function sendSmsConfirmation(booking: BookingData) {
  if (!smsClient || !FROM_NUMBER || !booking.phone) return;
  const timeStr = booking.confirmedStart ? formatTimeForSpeech(booking.confirmedStart) : booking.requestedTime || "your requested time";
  await smsClient.messages.create({
    from: FROM_NUMBER, to: booking.phone,
    body: `Hi ${booking.name || "there"}, your ${COMPANY_NAME} appointment is confirmed for ${timeStr} at ${booking.address || "your address"}. Issue: ${booking.issue || "HVAC service"}. Call or reply to change or cancel.`,
  });
  app.log.info({ to: booking.phone }, "✅ SMS sent");
}

async function sendEmailConfirmation(booking: BookingData) {
  if (!resend || !booking.email) return;
  const timeStr = booking.confirmedStart ? formatTimeForSpeech(booking.confirmedStart) : booking.requestedTime || "To be confirmed";
  try {
    await resend.emails.send({
      from: EMAIL_FROM, to: [booking.email],
      subject: `${COMPANY_NAME} – Appointment Confirmed`,
      html: `<div style="font-family:Arial,sans-serif;max-width:520px;color:#222">
        <h2 style="color:#1a73e8">${COMPANY_NAME}</h2>
        <p>Hi ${booking.name || "there"},</p>
        <p>Your appointment has been confirmed:</p>
        <table style="width:100%;border-collapse:collapse;margin:12px 0">
          <tr style="background:#f0f4ff"><td style="padding:8px;font-weight:bold">Date &amp; Time</td><td style="padding:8px">${timeStr}</td></tr>
          <tr><td style="padding:8px;font-weight:bold">Address</td><td style="padding:8px">${booking.address || ""}</td></tr>
          <tr style="background:#f0f4ff"><td style="padding:8px;font-weight:bold">Issue</td><td style="padding:8px">${booking.issue || ""}</td></tr>
          <tr><td style="padding:8px;font-weight:bold">Phone</td><td style="padding:8px">${booking.phone || ""}</td></tr>
        </table>
        <p>A technician will follow up shortly.</p>
        <p>Thank you,<br/><strong>${COMPANY_NAME}</strong></p>
      </div>`,
    });
    app.log.info({ to: booking.email }, "✅ Customer email sent");
  } catch (err: any) { app.log.error({ err: err?.message }, "❌ Customer email failed"); }
}

async function sendCallSummaryToCompany(session: Session) {
  if (!resend || !COMPANY_EMAIL) return;
  const b = session.booking;
  const timeStr = b.confirmedStart ? formatTimeForSpeech(b.confirmedStart) : b.requestedTime || "Not scheduled";
  const transcript = session.history
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => `<tr style="background:${m.role === "user" ? "#f9f9f9" : "#fff"}">
      <td style="padding:6px 10px;font-weight:bold;color:${m.role === "user" ? "#333" : "#1a73e8"};white-space:nowrap">${m.role === "user" ? "Caller" : "Ed"}</td>
      <td style="padding:6px 10px">${m.content}</td>
    </tr>`)
    .join("");

  try {
    await resend.emails.send({
      from: EMAIL_FROM,
      to: [COMPANY_EMAIL],
      subject: `📞 Call Summary — ${b.name || "Unknown Caller"} — ${new Date().toLocaleDateString()}`,
      html: `<div style="font-family:Arial,sans-serif;max-width:620px;color:#222">
        <h2 style="color:#1a73e8">📞 Call Summary — ${new Date().toLocaleString()}</h2>
        <h3 style="margin-bottom:4px">Caller Info</h3>
        <table style="width:100%;border-collapse:collapse;margin-bottom:16px">
          <tr style="background:#f0f4ff"><td style="padding:7px;font-weight:bold">Name</td><td style="padding:7px">${b.name || "Not provided"}</td></tr>
          <tr><td style="padding:7px;font-weight:bold">Phone</td><td style="padding:7px">${b.phone || "Unknown"}</td></tr>
          <tr style="background:#f0f4ff"><td style="padding:7px;font-weight:bold">Email</td><td style="padding:7px">${b.email || "Not provided"}</td></tr>
        </table>
        <h3 style="margin-bottom:4px">Appointment Details</h3>
        <table style="width:100%;border-collapse:collapse;margin-bottom:16px">
          <tr style="background:#f0f4ff"><td style="padding:7px;font-weight:bold">Issue</td><td style="padding:7px">${b.issue || "Not specified"}</td></tr>
          <tr><td style="padding:7px;font-weight:bold">Time</td><td style="padding:7px">${timeStr}</td></tr>
          <tr style="background:#f0f4ff"><td style="padding:7px;font-weight:bold">Address</td><td style="padding:7px">${b.address || "Not provided"}</td></tr>
          <tr><td style="padding:7px;font-weight:bold">Booked</td><td style="padding:7px">${b.confirmed ? "✅ Yes" : "❌ No — caller did not complete booking"}</td></tr>
          <tr style="background:#f0f4ff"><td style="padding:7px;font-weight:bold">Calendar</td><td style="padding:7px">${b.calendarEventId ? "✅ Event created" : "❌ Not added"}</td></tr>
        </table>
        <h3 style="margin-bottom:4px">Full Call Transcript</h3>
        <table style="width:100%;border-collapse:collapse;font-size:13px;line-height:1.6">${transcript}</table>
        <p style="color:#aaa;font-size:11px;margin-top:20px">Powered by ${COMPANY_NAME} AI Agent</p>
      </div>`,
    });
    app.log.info({ to: COMPANY_EMAIL }, "✅ Call summary sent to company");
  } catch (err: any) { app.log.error({ err: err?.message }, "❌ Call summary failed"); }
}

async function createHubSpotContact(booking: BookingData) {
  if (!HUBSPOT_API_KEY) return;
  const props: Record<string, string> = { hs_lead_status: "NEW" };
  if (booking.email) props.email = booking.email;
  if (booking.phone) props.phone = booking.phone;
  if (booking.name) { const p = booking.name.trim().split(/\s+/); props.firstname = p[0]; if (p.length > 1) props.lastname = p.slice(1).join(" "); }
  try {
    const r = await fetch("https://api.hubapi.com/crm/v3/objects/contacts", {
      method: "POST",
      headers: { Authorization: `Bearer ${HUBSPOT_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ properties: props }),
    });
    if (!r.ok && r.status !== 409) app.log.error({ status: r.status }, "HubSpot failed");
    else app.log.info("✅ HubSpot contact saved");
  } catch (err: any) { app.log.error({ err: err?.message }, "HubSpot error"); }
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
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 3000);
  const resp = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`, {
    signal: controller.signal,
    method: "POST",
    headers: { "xi-api-key": ELEVENLABS_API_KEY, "Content-Type": "application/json", Accept: "audio/mpeg" },
    body: JSON.stringify({
      text,
      model_id: "eleven_flash_v2_5",
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
    speechTimeout: "2",
    timeout: 2,
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

Company info:
- Hours: ${HOURS}
- Service areas: ${SERVICE_AREAS}
- Diagnostic fee: ${DIAGNOSTIC_FEE} (waived if repair is done same visit)
- Services: AC repair, heating repair, full diagnostics, tune-ups, preventative maintenance, thermostat installation, drain line clearing, capacitor replacement, contactor replacement, blower motor replacement, refrigerant service, full system replacement quotes, and inspections

Pricing (only share when asked):
- Diagnostic visit: ${DIAGNOSTIC_FEE}
- Tune-up: $129
- Drain line clearing: $149
- Capacitor: $185–$325
- Thermostat install: $199–$399
- Blower motor: $450–$950
- Most repairs quoted after diagnostic

Booking — collect naturally in conversation:
1. Name — ask like "Sure, who am I speaking with?"
2. What the issue is
3. Preferred day and time — check availability first before confirming
4. Service address
5. Email — ask once casually, accept skip

When [AVAILABILITY] info is provided:
- If open: confirm naturally — "Perfect, that time works great!"
- If taken: "That time is actually booked — I do have an opening at [alt time] though, would that work?"
- If nothing: "I'm not seeing anything at that time — what else might work for you?"

After collecting name, issue, address and time:
- Summarize warmly: "Alright, so I've got you down for [issue] on [day] at [time] at [address] — does everything look good?"
- Once they say yes/confirm/sounds good — finalize it

After booking:
- "You're all set! I've got you scheduled for [time]. A technician will reach out shortly. Anything else I can help with?"

Rules:
- NEVER ask the same question twice
- Answer questions naturally and return to booking gently
- 1–3 sentences max unless explaining services
- Sound human every single time
- If they ask what services you offer, give a warm friendly summary — never a robotic list

- Always respond in English only`.trim();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseSpokenEmail(text: string): string | null {
  let t = text.trim().toLowerCase();
  t = t.replace(/\s+at\s+/g, "@").replace(/\s+dot\s+/g, ".").replace(/\s+underscore\s+/g, "_").replace(/\s+(dash|hyphen)\s+/g, "-").replace(/\s+/g, "");
  const digits: Record<string, string> = { zero:"0",one:"1",two:"2",three:"3",four:"4",five:"5",six:"6",seven:"7",eight:"8",nine:"9" };
  Object.entries(digits).forEach(([w, d]) => { t = t.replace(new RegExp(w, "g"), d); });
  t = t.replace(/[^a-z0-9@._+-]/g, "");
  return /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(t) ? t : null;
}

function emailToSpeech(email: string): string {
  return email.replace("@", " at ").replace(/\./g, " dot ");
}

function isYes(t: string) { return ["yes","yeah","yep","correct","that's right","sure","right","exactly","uh huh","looks good","sounds good","that works"].some((w) => t.toLowerCase().includes(w)); }
function isSkip(t: string) { return ["skip","no email","no thanks","don't","no need","not now","i don't"].some((w) => t.toLowerCase().includes(w)); }
function isNo(t: string) { return ["no","nope","wrong","that's not","incorrect","not right"].some((w) => t.toLowerCase().includes(w)); }
function isBye(t: string) { return ["bye","goodbye","that's all","that is all","hang up","have a good"].some((w) => t.toLowerCase().includes(w)); }
function isThanks(t: string) { return ["thank you","thanks so much","appreciate it","perfect thanks","okay thanks","great thanks","thank you so much"].some((w) => t.toLowerCase().includes(w)); }
function hasTimeReference(t: string) { return /\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}(:\d{2})?\s?(am|pm)|morning|afternoon|evening|next week)\b/i.test(t); }

// ─── Main AI turn ─────────────────────────────────────────────────────────────

async function handleTurn(session: Session, userSpeech: string): Promise<string> {
  if (!openai) return "I'm sorry, I'm having some trouble right now. Please call back shortly.";

  session.history.push({ role: "user", content: userSpeech });

  // Email confirmation flow
  if (session.awaitingEmailConfirm) {
    if (isYes(userSpeech)) {
      session.booking.email = session.awaitingEmailConfirm;
      session.awaitingEmailConfirm = undefined;
      session.history.push({ role: "system", content: `Email confirmed and saved: ${session.booking.email}. Continue booking — ask for service address if not yet collected.` });
    } else if (isSkip(userSpeech)) {
      session.awaitingEmailConfirm = undefined;
      session.history.push({ role: "system", content: "Caller skipped email. Do not ask again. Continue to service address." });
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
      const reply = "Sorry about that — could you say the email one more time, or just say skip?";
      session.history.push({ role: "assistant", content: reply });
      return reply;
    }
  }

  // Detect email in speech
  if (!session.booking.email && !session.awaitingEmailConfirm && !isSkip(userSpeech)) {
    const foundEmail = parseSpokenEmail(userSpeech);
    if (foundEmail) {
      session.awaitingEmailConfirm = foundEmail;
      const reply = `Got it — so that's ${emailToSpeech(foundEmail)}, is that right?`;
      session.history.push({ role: "assistant", content: reply });
      return reply;
    }
  }

  // Availability check
  let availabilityNote = "";
  if (hasTimeReference(userSpeech) && !session.booking.confirmedStart) {
    session.booking.requestedTime = userSpeech;
    const avail = await checkAvailability(userSpeech);
    if (avail.available && avail.proposedDate) {
      (session as any)._pendingDate = avail.proposedDate;
      availabilityNote = `[AVAILABILITY] The requested time (${avail.spokenTime}) is OPEN. Confirm this with the caller and move forward.`;
    } else if (avail.alternativeDate) {
      (session as any)._pendingDate = avail.alternativeDate;
      availabilityNote = `[AVAILABILITY] That time is NOT available. Next open slot is ${avail.alternativeSpoken}. Suggest this naturally.`;
    } else {
      (session as any)._pendingDate = null;
      availabilityNote = `[AVAILABILITY] No availability found. Ask for a different time.`;
    }
  }

  // Auto-confirm booking when all info collected and caller agrees
  const callerAgreed = isYes(userSpeech) || userSpeech.toLowerCase().includes("confirm") || userSpeech.toLowerCase().includes("book it") || userSpeech.toLowerCase().includes("go ahead");

  if (
    callerAgreed &&
    !session.bookedAndDone &&
    session.booking.name &&
    session.booking.issue &&
    session.booking.address &&
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

      const [eventId] = await Promise.all([
        createCalendarEvent(session.booking).catch(() => null),
        sendSmsConfirmation(session.booking).catch((e) => app.log.error({ e }, "sms failed")),
        sendEmailConfirmation(session.booking).catch((e) => app.log.error({ e }, "email failed")),
        createHubSpotContact(session.booking).catch((e) => app.log.error({ e }, "hubspot failed")),
      ]);

      if (eventId) session.booking.calendarEventId = eventId as string;

      const timeStr = formatTimeForSpeech(session.booking.confirmedStart);
      const firstName = session.booking.name?.split(" ")[0] || "there";
      const reply = `You're all set, ${firstName}! I've got you scheduled for ${timeStr}. A technician will reach out to confirm. Is there anything else I can help you with?`;
      session.history.push({ role: "assistant", content: reply });
      return reply;
    }
  }

  // Build messages for OpenAI
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: buildSystemPrompt() },
    ...(availabilityNote ? [{ role: "system" as const, content: availabilityNote }] : []),
    ...session.history.slice(-18).map((m) => ({ role: m.role as "user" | "assistant" | "system", content: m.content })),
  ];

  const resp = await openai.chat.completions.create({ model: OPENAI_MODEL, temperature: 0.4, max_tokens: 80, messages });
  const reply = resp.choices[0]?.message?.content?.trim() || "I'm sorry, could you say that again?";
  session.history.push({ role: "assistant", content: reply });
  return reply;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get("/health", async () => ({ ok: true, time: new Date().toISOString() }));

// Pre-cache common phrases at startup
async function warmupAudio() {
  if (!ELEVENLABS_API_KEY || !ELEVENLABS_VOICE_ID) return;
  if (!BASE_URL.startsWith("https://")) return;
  
  const phrases = [
    `Thank you for calling ${COMPANY_NAME}, this is Ed, how can I help you today?`,
    "Sure, who am I speaking with?",
    "What seems to be the issue with your system today?",
    "What day and time works best for you?",
    "And what is the service address?",
    "Could you share your email for a confirmation, or just say skip?",
    "You are all set! A technician will reach out shortly. Anything else?",
    "I am sorry, I did not catch that. Could you say that again?",
    "Thank you for calling. Have a wonderful day!",
    "Let me get that scheduled for you.",
  ];

  app.log.info("Warming up audio cache...");
  for (const phrase of phrases) {
    try {
      await elevenLabsTTS(phrase);
      app.log.info({ phrase: phrase.slice(0, 40) }, "Cached phrase");
    } catch (e) {
      app.log.error({ err: e }, "Warmup failed for phrase");
    }
  }
  app.log.info("Audio warmup complete!");
}

app.post("/voice-webhook", async (req: any, reply: any) => {
  const VR = twilio.twiml.VoiceResponse;
  const twiml = new VR();
  const calledNumber = (req.body?.To || "").toString().trim();
  const callSid = (req.body?.CallSid || "").toString();
  const callerPhone = (req.body?.From || "").toString().trim();

 app.log.info({ calledNumber, MEDSPA_TWILIO_NUMBER }, "Number detection debug"); 
 if (calledNumber === MEDSPA_TWILIO_NUMBER) {
    getMedSpaSession(callSid, callerPhone);
    await medSpaGather(twiml, `Thank you for calling ${MEDSPA_COMPANY_NAME}, this is ${MEDSPA_AGENT_NAME}! How can I help you today?`);
  } else {
    getSession(callSid, callerPhone);
    await gatherWithPrompt(twiml, `Thank you for calling ${COMPANY_NAME}, this is Ed, how can I help you today?`);
  }

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
        sendCallSummaryToCompany(session).catch(() => {});
        await playAudio(twiml, "I'm sorry I couldn't hear you. Feel free to call us back anytime. Have a great day!");
        twiml.hangup();
        reply.type("text/xml");
        return reply.send(twiml.toString());
      }
      const prompts = ["I'm sorry, I didn't catch that. Could you say that again?", "Still having trouble hearing you — could you speak a little louder?"];
      await gatherWithPrompt(twiml, prompts[Math.min(session.silenceCount - 1, prompts.length - 1)]);
      reply.type("text/xml");
      return reply.send(twiml.toString());
    }

    session.silenceCount = 0;

    // Goodbye
    if (isBye(speech)) {
      sendCallSummaryToCompany(session).catch(() => {});
      await playAudio(twiml, `Thank you for calling ${COMPANY_NAME}. Have a wonderful day!`);
      twiml.hangup();
      reply.type("text/xml");
      return reply.send(twiml.toString());
    }

    // Thanks after booking done
    if (isThanks(speech) && session.bookedAndDone) {
      sendCallSummaryToCompany(session).catch(() => {});
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



// ─── Med Spa TTS (OpenAI Nova) ────────────────────────────────────────────────
async function medSpaTTS(text: string): Promise<string> {
  const hash = crypto.createHash("sha1").update(`sofia_${text}`).digest("hex");
  const file = `tts_${hash}.mp3`;
  const abs = path.join(ensureAudioDir(), file);
  const rel = `/audio/${file}`;
  if (fs.existsSync(abs)) return rel;
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 8000);
  const resp = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${MEDSPA_ELEVENLABS_VOICE_ID}`, {
    signal: controller.signal,
    method: "POST",
    headers: {
      "xi-api-key": ELEVENLABS_API_KEY,
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
    },
    body: JSON.stringify({
      text,
      model_id: "eleven_flash_v2_5",
      voice_settings: { stability: 0.45, similarity_boost: 0.88, style: 0.08, use_speaker_boost: true },
    }),
  });
  if (!resp.ok) throw new Error(`ElevenLabs ${resp.status}: ${await resp.text()}`);
  fs.writeFileSync(abs, Buffer.from(await resp.arrayBuffer()));
  return rel;
}

async function medSpaPlay(twiml: any, text: string) {
  try {
    const rel = await medSpaTTS(text);
    if (BASE_URL.startsWith("https://")) { twiml.play(`${BASE_URL}${rel}`); return; }
  } catch (e) { app.log.error({ err: e, voiceId: MEDSPA_ELEVENLABS_VOICE_ID }, "Sofia ElevenLabs failed - falling back to Polly"); }
  twiml.say({ voice: "Polly.Joanna" }, text);
}

async function medSpaGather(twiml: any, text: string) {
  const gather = twiml.gather({
    input: "speech",
    action: BASE_URL.startsWith("https://") ? `${BASE_URL}/medspa-intake` : "/medspa-intake",
    method: "POST",
    speechTimeout: "2",
    timeout: 2,
    actionOnEmptyResult: true,
    language: "en-US",
    enhanced: true,
    speechModel: "phone_call",
    profanityFilter: false,
  });
  await medSpaPlay(gather, text);
}

function buildMedSpaPrompt(): string {
  return `You are ${MEDSPA_AGENT_NAME}, the live receptionist at ${MEDSPA_COMPANY_NAME}, a luxury med spa in ${MEDSPA_SERVICE_AREAS}.

Your personality:
- Warm, elegant, and professional like a real high end spa receptionist
- Short conversational sentences, never robotic
- Genuinely interested in helping the caller feel comfortable
- Sound like a real person, not a bot
- Maximum 2 sentences unless listing services or explaining pricing

Hours: ${MEDSPA_HOURS}
Location: ${MEDSPA_SERVICE_AREAS}

Services and pricing we offer:
- Botox: $12 per unit, average treatment $250 to $400
- Lip Fillers: starting at $599
- Cheek Fillers: starting at $699
- Microneedling: $299 per session
- Chemical Peel: $149 to $299 depending on depth
- Laser Hair Removal: starting at $99 per area
- HydraFacial: $199 per session
- IV Therapy: starting at $149
- Body Contouring: starting at $499
- Free consultation for all new clients

CRITICAL RULES:
- If caller asks what services we offer, list ALL services with prices naturally
- If caller asks about a specific service, explain it warmly and mention the price
- NEVER treat a question as a booking stage answer
- If caller asks a question during booking flow, answer it first then return to booking
- Never say a question back as if it were a service name
- If someone says "what services do you offer" respond with the full list
- Answer ANY question naturally and intelligently
- If asked about pain say treatments are well tolerated and comfort is a priority
- If asked about results say results vary but most clients see great improvement
- Never make medical claims or guarantees
- Always recommend a free consultation for specific concerns
- NEVER ask the same question twice
- Sound human every single time

Booking flow:
1. Get their name naturally
2. Ask what service they are interested in
3. Get preferred day and time
4. Confirm all details warmly before finalizing`.trim();
}

type MedSpaStage = "normal" | "book_name" | "book_service" | "book_time" | "book_confirm";

type MedSpaSession = {
  callSid: string;
  callerPhone: string;
  stage: MedSpaStage;
  silenceCount: number;
  bookedAndDone: boolean;
  history: { role: string; content: string }[];
  booking: { name?: string; service?: string; time?: string; };
};

const medSpaSessions = new Map<string, MedSpaSession>();

function getMedSpaSession(callSid: string, callerPhone: string): MedSpaSession {
  const existing = medSpaSessions.get(callSid);
  if (existing) return existing;
  const session: MedSpaSession = {
    callSid, callerPhone, stage: "normal",
    silenceCount: 0, bookedAndDone: false, history: [], booking: {},
  };
  medSpaSessions.set(callSid, session);
  return session;
}

async function handleMedSpaTurn(session: MedSpaSession, userSpeech: string): Promise<string> {
  if (!openai) return "I can help you book an appointment or answer any questions. What can I help you with today?";

  session.history.push({ role: "user", content: userSpeech });

  const t = userSpeech.toLowerCase();

  // Booking intent detected
  if (!session.bookedAndDone && (
    t.includes("book") || t.includes("appointment") ||
    t.includes("schedule") || t.includes("come in") ||
    t.includes("visit") || t.includes("consultation")
  ) && session.stage === "normal") {
    session.stage = "book_name";
    session.booking = {};
    const reply = "I would love to get that set up for you! Who am I speaking with?";
    session.history.push({ role: "assistant", content: reply });
    return reply;
  }

  // Booking flow stages
  if (session.stage === "book_name") {
    session.booking.name = userSpeech.trim();
    session.stage = "book_service";
    const reply = `Lovely to meet you, ${session.booking.name}! What service are you interested in today?`;
    session.history.push({ role: "assistant", content: reply });
    return reply;
  }

  if (session.stage === "book_service") {
    const isQuestion = t.includes("what") || t.includes("how") || t.includes("do you") || 
                       t.includes("offer") || t.includes("price") || t.includes("cost") ||
                       t.includes("which") || t.includes("tell me") || t.includes("?");
    
    if (isQuestion) {
      // Answer the question then ask again
      session.history.push({ role: "user", content: userSpeech });
      const messages: any[] = [
        { role: "system", content: buildMedSpaPrompt() },
        ...session.history.slice(-10).map(m => ({ role: m.role, content: m.content })),
        { role: "system", content: "The caller asked a question during booking. Answer it warmly and naturally, then gently ask what service they are interested in." }
      ];
      const resp = await openai.chat.completions.create({ model: OPENAI_MODEL, temperature: 0.3, max_tokens: 120, messages });
      const reply = resp.choices[0]?.message?.content?.trim() || "Great question! We offer Botox, fillers, microneedling, HydraFacials, laser hair removal, IV therapy and body contouring. What service interests you?";
      session.history.push({ role: "assistant", content: reply });
      return reply;
    }
    
    session.booking.service = userSpeech.trim();
    session.stage = "book_time";
    const reply = `Wonderful choice! What day and time works best for you?`;
    session.history.push({ role: "assistant", content: reply });
    return reply;
  }

  if (session.stage === "book_time") {
    session.booking.time = userSpeech.trim();
    session.stage = "book_confirm";
    const reply = `Perfect! Just to confirm — ${session.booking.name}, ${session.booking.service}, ${session.booking.time}. Does everything look good?`;
    session.history.push({ role: "assistant", content: reply });
    return reply;
  }

  if (session.stage === "book_confirm") {
    if (["yes","yeah","correct","confirm","sure","sounds good","looks good","perfect","that's right"].some(w => t.includes(w))) {
      // Book calendar
      if (calendar && GOOGLE_CALENDAR_ID && session.booking.time) {
        const start = chrono.parseDate(session.booking.time, new Date(), { forwardDate: true });
        if (start) {
          const end = new Date(start.getTime() + 60 * 60000);
          calendar.events.insert({
            calendarId: GOOGLE_CALENDAR_ID,
            requestBody: {
              summary: `${MEDSPA_COMPANY_NAME} - ${session.booking.service} - ${session.booking.name}`,
              description: `Client: ${session.booking.name}\nService: ${session.booking.service}\nPhone: ${session.callerPhone}`,
              start: { dateTime: start.toISOString(), timeZone: TIMEZONE },
              end: { dateTime: end.toISOString(), timeZone: TIMEZONE },
            },
          }).then(e => app.log.info({ id: e.data.id }, "Med spa calendar booked"))
            .catch(e => app.log.error({ e }, "Med spa calendar failed"));
        }
      }
      // Send company email
      if (resend && COMPANY_EMAIL) {
        resend.emails.send({
          from: MEDSPA_EMAIL_FROM,
          to: [COMPANY_EMAIL],
          subject: `New Appointment - ${MEDSPA_COMPANY_NAME}`,
          text: `New appointment!\n\nClient: ${session.booking.name}\nService: ${session.booking.service}\nTime: ${session.booking.time}\nPhone: ${session.callerPhone}`,
        }).catch(() => {});
      }
      session.bookedAndDone = true;
      session.stage = "normal";
      const firstName = session.booking.name?.split(" ")[0] || "there";
      const reply = `You are all set, ${firstName}! Your ${session.booking.service} appointment is confirmed for ${session.booking.time}. We look forward to seeing you at ${MEDSPA_COMPANY_NAME}. Is there anything else I can help you with?`;
      session.history.push({ role: "assistant", content: reply });
      return reply;
    }
    if (["no","wrong","change","different"].some(w => t.includes(w))) {
      session.stage = "book_name";
      session.booking = {};
      const reply = "No problem at all! Let me start fresh. Who am I speaking with?";
      session.history.push({ role: "assistant", content: reply });
      return reply;
    }
  }

  // General AI conversation for anything else
  const messages: any[] = [
    { role: "system", content: buildMedSpaPrompt() },
    ...session.history.slice(-16).map(m => ({ role: m.role, content: m.content })),
  ];

  const resp = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    temperature: 0.35,
    max_tokens: 80,
    messages,
  });

  const reply = resp.choices[0]?.message?.content?.trim() || "I'm sorry, could you say that again?";
  session.history.push({ role: "assistant", content: reply });
  return reply;
}

async function bookMedSpaCalendar(booking: MedSpaSession["booking"], callerPhone: string) {
  if (!calendar || !GOOGLE_CALENDAR_ID || !booking.time) return null;
  const start = chrono.parseDate(booking.time, new Date(), { forwardDate: true });
  if (!start) return null;
  const end = new Date(start.getTime() + 60 * 60000);
  try {
    const event = await calendar.events.insert({
      calendarId: GOOGLE_CALENDAR_ID,
      requestBody: {
        summary: `${MEDSPA_COMPANY_NAME} - ${booking.service || "Appointment"} - ${booking.name || ""}`,
        description: `Client: ${booking.name}\nService: ${booking.service}\nPhone: ${callerPhone}`,
        start: { dateTime: start.toISOString(), timeZone: TIMEZONE },
        end: { dateTime: end.toISOString(), timeZone: TIMEZONE },
      },
    });
    app.log.info({ eventId: event.data.id }, "Med spa calendar event created");
    return event.data;
  } catch (err) {
    app.log.error({ err }, "Med spa calendar booking failed");
    return null;
  }
}

// ─── Med Spa Routes ───────────────────────────────────────────────────────────


// ─── Med Spa Routes (same structure as HVAC) ──────────────────────────────────

app.post("/medspa-webhook", async (req: any, reply: any) => {
  const VR = twilio.twiml.VoiceResponse;
  const twiml = new VR();
  const callSid = (req.body?.CallSid || "").toString();
  const callerPhone = (req.body?.From || "").toString().trim();
  getMedSpaSession(callSid, callerPhone);
  const gather = twiml.gather({
    input: "speech",
    action: BASE_URL.startsWith("https://") ? `${BASE_URL}/medspa-intake` : "/medspa-intake",
    method: "POST",
    speechTimeout: "auto",
    timeout: 8,
    actionOnEmptyResult: true,
    language: "en-US",
    enhanced: true,
    speechModel: "phone_call",
    profanityFilter: false,
  });
  const greetingText = `Thank you for calling ${MEDSPA_COMPANY_NAME}, this is ${MEDSPA_AGENT_NAME}! How can I help you today?`;
  medSpaTTS(greetingText).catch(() => {});
  gather.say({ voice: "Polly.Joanna" }, greetingText);
  reply.type("text/xml");
  return reply.send(twiml.toString());
});

app.post("/medspa-intake", async (req: any, reply: any) => {
  const VR = twilio.twiml.VoiceResponse;
  const twiml = new VR();
  try {
    const speech = (req.body?.SpeechResult ?? "").toString().trim();
    const callSid = (req.body?.CallSid || "").toString();
    const callerPhone = (req.body?.From || "").toString().trim();
    const session = getMedSpaSession(callSid, callerPhone);

    app.log.info({ speech, stage: session.stage }, "Med spa speech");

    if (!speech) {
      session.silenceCount += 1;
      if (session.silenceCount >= 3) {
        await medSpaPlay(twiml, `Thank you for calling ${MEDSPA_COMPANY_NAME}. Please call us back anytime. Have a beautiful day!`);
        twiml.hangup();
        reply.type("text/xml");
        return reply.send(twiml.toString());
      }
      await medSpaGather(twiml, "I am sorry, I did not catch that. Could you say that again?");
      reply.type("text/xml");
      return reply.send(twiml.toString());
    }

    session.silenceCount = 0;

    if (isBye(speech)) {
      await medSpaPlay(twiml, `Thank you for calling ${MEDSPA_COMPANY_NAME}. Have a beautiful day!`);
      twiml.hangup();
      reply.type("text/xml");
      return reply.send(twiml.toString());
    }

    if (isThanks(speech) && session.bookedAndDone) {
      await medSpaPlay(twiml, `Of course! We look forward to seeing you. Have a wonderful day!`);
      twiml.hangup();
      reply.type("text/xml");
      return reply.send(twiml.toString());
    }

    const responseText = await handleMedSpaTurn(session, speech);
    await medSpaGather(twiml, responseText);
    reply.type("text/xml");
    return reply.send(twiml.toString());
  } catch (err) {
    app.log.error({ err }, "medspa-intake error");
    await medSpaGather(twiml, "I am sorry, I had a little trouble. Could you say that again?");
    reply.type("text/xml");
    return reply.send(twiml.toString());
  }
});



// ─── Start ────────────────────────────────────────────────────────────────────

app.listen({ port: PORT, host: "0.0.0.0" }).then(() => {
  console.log(`✅ ${COMPANY_NAME} AI Agent running on port ${PORT}`);
  warmupAudio().catch(() => {});
  // Warmup Sofia phrases
  const sofiaWarmup = [
    `Thank you for calling ${MEDSPA_COMPANY_NAME}, this is ${MEDSPA_AGENT_NAME}! How can I help you today?`,
    "I would love to get that scheduled for you! What is your name?",
    "What service are you interested in today?",
    "What day and time works best for you?",
    "Just to confirm, does everything look good?",
    `You are all set! We look forward to seeing you at ${MEDSPA_COMPANY_NAME}!`,
    "I am sorry, I did not catch that. Could you say that again?",
    `Thank you for calling ${MEDSPA_COMPANY_NAME}. Have a beautiful day!`,
  ];
  Promise.all(sofiaWarmup.map(p => medSpaTTS(p).catch(() => {}))).then(() => {
    app.log.info("Sofia audio warmup complete!");
  });
  console.log(`📅 Calendar: ${calendar ? "✅ connected" : "❌ not configured"}`);
  console.log(`📧 Resend:   ${resend ? "✅ connected" : "❌ not configured"}`);
  console.log(`💬 SMS:      ${smsClient ? "✅ connected" : "❌ not configured"}`);
  console.log(`📊 HubSpot:  ${HUBSPOT_API_KEY ? "✅ connected" : "❌ not configured"}`);
  console.log(`📬 Company email: ${COMPANY_EMAIL || "❌ COMPANY_EMAIL not set"}`);
  console.log(`🔊 Voice:    ${ELEVENLABS_VOICE_ID ? "✅ ElevenLabs Flash" : "⚠️  Polly fallback"}`);
}).catch((err) => { console.error(err); process.exit(1); });

