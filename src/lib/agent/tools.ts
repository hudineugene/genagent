import "server-only";
import { z } from "zod";
import { db } from "@/db";
import { bookings } from "@/db/schema";
import type { AgentTool } from "@/lib/llm";
import {
  CalendarError,
  addDays,
  busyIntervals,
  createEvent,
  getGoogleSettings,
  utcToZoned,
  zonedToUtc,
} from "@/lib/google/calendar";
import type { CalendarConfig } from "./types";

/**
 * Где работает агент: live — настоящий канал (запись создаётся в календаре),
 * dry — тест-чат и автотесты (свободное время читается из календаря, если он подключён, но запись не создаётся).
 */
export type ToolContext = { mode: "live" | "dry"; agentId?: string; clientId: string; conversationId?: string };

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MAX_RANGE_DAYS = 7;
const MAX_PER_DAY = 8;

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

const findSlotsInput = z.object({
  date_from: date,
  date_to: date.optional(),
  service: z.string().max(100).optional(),
  part_of_day: z.enum(["morning", "afternoon", "evening"]).optional(),
});

const bookInput = z.object({
  start: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/, "Use 'YYYY-MM-DD HH:mm'"),
  service: z.string().max(100).optional(),
  name: z.string().trim().min(1).max(100),
  phone: z.string().trim().min(5).max(40),
  comment: z.string().max(1000).optional(),
});

/** Понятное модели описание ошибки календаря. */
function explain(e: unknown): never {
  const code = e instanceof CalendarError ? e.code : "calendar_error";
  console.error("calendar tool failed", code, e instanceof Error ? e.message : e);
  throw new Error(
    `The booking calendar is unavailable right now (${code}). Apologise to the customer and hand the conversation over to a manager — do not promise a time.`,
  );
}

export function calendarTools(cal: CalendarConfig, ctx: ToolContext): AgentTool[] {
  const serviceOf = (name?: string) => {
    if (!name?.trim()) return null;
    const n = name.trim().toLowerCase();
    return cal.services.find((s) => s.name.toLowerCase() === n) ?? cal.services.find((s) => s.name.toLowerCase().includes(n) || n.includes(s.name.toLowerCase())) ?? null;
  };
  const durationOf = (name?: string) => serviceOf(name)?.minutes ?? cal.slotMinutes;

  /** Занятость календаря. В тестовом режиме без подключённого календаря всё рабочее время считается свободным. */
  async function busy(from: Date, to: Date) {
    const connected = Boolean(cal.calendarId) && Boolean(await getGoogleSettings());
    if (!connected) {
      if (ctx.mode === "dry") return [];
      throw new CalendarError(cal.calendarId ? "google_not_configured" : "calendar_not_set");
    }
    try {
      return await busyIntervals(cal.calendarId, from, to);
    } catch (e) {
      explain(e);
    }
  }

  /** Возможные начала записей в рабочие часы дня (UTC, мс) без учёта занятости. */
  function daySlots(day: string, minutes: number) {
    const { weekday } = utcToZoned(zonedToUtc(day, "12:00", cal.timezone), cal.timezone);
    if (!cal.workDays.includes(weekday)) return [];
    const open = zonedToUtc(day, cal.workStart, cal.timezone).getTime();
    const close = zonedToUtc(day, cal.workEnd, cal.timezone).getTime();
    const step = Math.min(minutes, 30) * 60_000;
    const earliest = Date.now() + cal.minNoticeHours * 3600_000;
    const latest = Date.now() + cal.horizonDays * 86400_000;
    const out: number[] = [];
    for (let t = open; t + minutes * 60_000 <= close; t += step) {
      if (t >= earliest && t <= latest) out.push(t);
    }
    return out;
  }

  const overlaps = (start: number, minutes: number, list: { start: number; end: number }[]) =>
    list.some((b) => start < b.end && start + minutes * 60_000 > b.start);

  const hoursText = () =>
    `${cal.workDays.map((d) => DAY_NAMES[d]).join(", ")} ${cal.workStart}–${cal.workEnd} (${cal.timezone})`;

  const findFreeSlots: AgentTool = {
    name: "find_free_slots",
    description:
      "Find free appointment times in the business calendar. Call it before offering any time to the customer — never invent times. " +
      `Dates are local to ${cal.timezone}. Returns free start times per day (up to ${MAX_RANGE_DAYS} days per call); if the range is fully booked, it also reports the next day with free time.`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["date_from"],
      properties: {
        date_from: { type: "string", description: "First day to check, YYYY-MM-DD" },
        date_to: { type: "string", description: `Last day to check, YYYY-MM-DD (default: date_from + 2 days, max ${MAX_RANGE_DAYS} days)` },
        service: { type: "string", description: "Service name — determines the appointment length" },
        part_of_day: { type: "string", enum: ["morning", "afternoon", "evening"], description: "Optional preference" },
      },
    },
    parse: findSlotsInput,
    async run(raw) {
      const input = raw as z.infer<typeof findSlotsInput>;
      const minutes = durationOf(input.service);
      const today = utcToZoned(new Date(), cal.timezone).date;
      const from = input.date_from < today ? today : input.date_from;
      let to = input.date_to ?? addDays(from, 2);
      if (to < from) to = from;
      if (to > addDays(from, MAX_RANGE_DAYS - 1)) to = addDays(from, MAX_RANGE_DAYS - 1);

      const fits = (t: number) => {
        if (!input.part_of_day) return true;
        const h = Number(utcToZoned(new Date(t), cal.timezone).time.slice(0, 2));
        return input.part_of_day === "morning" ? h < 12 : input.part_of_day === "afternoon" ? h >= 12 && h < 17 : h >= 17;
      };

      // Занятость берём одним запросом на весь диапазон (плюс две недели вперёд для подсказки о ближайшем свободном дне).
      const searchEnd = addDays(to, 14);
      const list = await busy(zonedToUtc(from, "00:00", cal.timezone), zonedToUtc(addDays(searchEnd, 1), "00:00", cal.timezone));
      const freeOn = (day: string) => daySlots(day, minutes).filter((t) => fits(t) && !overlaps(t, minutes, list));

      const lines: string[] = [];
      for (let day = from; day <= to; day = addDays(day, 1)) {
        const free = freeOn(day);
        if (!free.length) continue;
        // Если свободных окон много — показываем равномерную выборку, а не только утро.
        const pick = free.length <= MAX_PER_DAY ? free : Array.from({ length: MAX_PER_DAY }, (_, i) => free[Math.round((i * (free.length - 1)) / (MAX_PER_DAY - 1))]);
        const wd = DAY_NAMES[utcToZoned(new Date(pick[0]), cal.timezone).weekday];
        lines.push(`${day} (${wd}): ${pick.map((t) => utcToZoned(new Date(t), cal.timezone).time).join(", ")}`);
      }

      const head = `Appointment length: ${minutes} min. Working hours: ${hoursText()}.`;
      if (lines.length) return `${head}\nFree start times:\n${lines.join("\n")}`;

      for (let day = addDays(to, 1); day <= searchEnd; day = addDays(day, 1)) {
        const free = freeOn(day);
        if (free.length) {
          const wd = DAY_NAMES[utcToZoned(new Date(free[0]), cal.timezone).weekday];
          return `${head}\nNo free time between ${from} and ${to}. Nearest day with free time: ${day} (${wd}), e.g. ${free
            .slice(0, 4)
            .map((t) => utcToZoned(new Date(t), cal.timezone).time)
            .join(", ")}.`;
        }
      }
      return `${head}\nNo free time between ${from} and ${searchEnd}. Offer to pass the request to a manager.`;
    },
  };

  const bookAppointment: AgentTool = {
    name: "book_appointment",
    description:
      "Book an appointment in the business calendar. Call it only after the customer has confirmed the exact day, time, service, name and phone. " +
      "The time must be one returned by find_free_slots. Tell the customer the booking is confirmed only if this tool succeeds.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["start", "name", "phone"],
      properties: {
        start: { type: "string", description: `Local start time in ${cal.timezone}, format 'YYYY-MM-DD HH:mm'` },
        service: { type: "string", description: "Service name" },
        name: { type: "string", description: "Customer name" },
        phone: { type: "string", description: "Customer phone number" },
        comment: { type: "string", description: "Anything else the business should know" },
      },
    },
    parse: bookInput,
    async run(raw) {
      const input = raw as z.infer<typeof bookInput>;
      const service = serviceOf(input.service);
      const minutes = service?.minutes ?? cal.slotMinutes;
      const [day, time] = input.start.split(" ");
      const start = zonedToUtc(day, time, cal.timezone).getTime();

      if (!daySlots(day, minutes).includes(start)) {
        return `This time cannot be booked: it is outside working hours (${hoursText()}), too soon (min ${cal.minNoticeHours} h notice), too far ahead (max ${cal.horizonDays} days) or not on the ${Math.min(minutes, 30)}-minute grid. Call find_free_slots and offer another time.`;
      }
      const list = await busy(new Date(start), new Date(start + minutes * 60_000));
      if (overlaps(start, minutes, list)) {
        return "This time has just been taken. Call find_free_slots and offer the customer other options.";
      }

      const end = start + minutes * 60_000;
      const serviceName = service?.name ?? input.service?.trim() ?? "";
      const summary = `${serviceName || "Запись"} — ${input.name}`;
      const confirmed = `Booked: ${day} ${time}–${utcToZoned(new Date(end), cal.timezone).time} (${cal.timezone})${serviceName ? `, ${serviceName}` : ""}, ${input.name}, ${input.phone}.`;
      if (ctx.mode === "dry") return confirmed;

      let event: { id: string; link: string | null };
      try {
        event = await createEvent(cal.calendarId, {
          summary,
          description: [`Телефон: ${input.phone}`, input.comment?.trim() && `Комментарий: ${input.comment.trim()}`, "Записано AI-агентом (GenAgent)"]
            .filter(Boolean)
            .join("\n"),
          start: new Date(start),
          end: new Date(end),
          timeZone: cal.timezone,
        });
      } catch (e) {
        explain(e);
      }
      if (ctx.agentId) {
        await db.insert(bookings).values({
          agentId: ctx.agentId,
          clientId: ctx.clientId,
          conversationId: ctx.conversationId ?? null,
          calendarId: cal.calendarId,
          eventId: event.id,
          eventLink: event.link,
          startsAt: new Date(start),
          endsAt: new Date(end),
          service: serviceName,
          name: input.name,
          phone: input.phone,
          comment: input.comment?.trim() ?? "",
        });
      }
      return confirmed;
    },
  };

  return [findFreeSlots, bookAppointment];
}

/** Проверка доступа к календарю из конструктора: читаем занятость на ближайшую неделю. */
export async function checkCalendarAccess(calendarId: string) {
  if (!(await getGoogleSettings())) return { ok: false as const, code: "google_not_configured" };
  try {
    const now = new Date();
    const busyList = await busyIntervals(calendarId, now, new Date(now.getTime() + 7 * 86400_000));
    return { ok: true as const, busy: busyList.length };
  } catch (e) {
    return { ok: false as const, code: e instanceof CalendarError ? e.code : "calendar_error" };
  }
}
