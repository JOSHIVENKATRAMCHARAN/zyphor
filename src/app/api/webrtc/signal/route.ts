import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { checkRateLimit } from "@/lib/rate-limit";
import { getClientIp, isSameOrigin, isValidChannelId, isValidSignalName, noStoreJson } from "@/lib/security";

type SignalRow = {
  id: string;
  channel_id: string;
  sender: string;
  type: string;
  data: string;
  timestamp: bigint;
};

const ALLOWED_SIGNAL_SENDERS = new Set(["host", "client"]);
const ALLOWED_SIGNAL_TYPES = new Set(["offer", "answer", "candidate"]);
const MAX_SIGNAL_DATA_BYTES = 200_000;

function safeStringifySignalData(value: unknown): { ok: true; data: string } | { ok: false; error: string } {
  if (typeof value === "string") {
    if (value.length > MAX_SIGNAL_DATA_BYTES) {
      return { ok: false, error: "Signal payload is too large." };
    }
    return { ok: true, data: value };
  }

  try {
    const data = JSON.stringify(value);
    if (data.length > MAX_SIGNAL_DATA_BYTES) {
      return { ok: false, error: "Signal payload is too large." };
    }
    return { ok: true, data };
  } catch {
    return { ok: false, error: "Signal payload is not serializable." };
  }
}

// POST: Save a new signaling message
export async function POST(req: NextRequest) {
  try {
    if (!isSameOrigin(req)) {
      return noStoreJson({ error: "Invalid request origin" }, { status: 403 });
    }

    let body: any;
    try {
      body = await req.json();
    } catch {
      return noStoreJson({ error: "Invalid JSON body" }, { status: 400 });
    }

    const { channelId, sender, type, data } = body || {};

    if (typeof channelId !== "string" || !isValidChannelId(channelId)) {
      return noStoreJson({ error: "Invalid channel id" }, { status: 400 });
    }
    if (typeof sender !== "string" || !isValidSignalName(sender) || !ALLOWED_SIGNAL_SENDERS.has(sender)) {
      return noStoreJson({ error: "Invalid sender" }, { status: 400 });
    }
    if (typeof type !== "string" || !isValidSignalName(type) || !ALLOWED_SIGNAL_TYPES.has(type)) {
      return noStoreJson({ error: "Invalid signal type" }, { status: 400 });
    }
    if (data === undefined || data === null) {
      return noStoreJson({ error: "Missing required fields" }, { status: 400 });
    }

    const payload = safeStringifySignalData(data);
    if (!payload.ok) {
      return noStoreJson({ error: payload.error }, { status: 413 });
    }

    const ip = getClientIp(req);
    const allowed = await checkRateLimit(`${ip}:${channelId}:${sender}`, "webrtc_signal_post", 300, 5);
    if (!allowed) {
      return noStoreJson({ error: "Rate limit exceeded" }, { status: 429 });
    }

    const timestamp = BigInt(Date.now());

    const signal = await prisma.signal.create({
      data: {
        channel_id: channelId,
        sender,
        type,
        data: payload.data,
        timestamp
      }
    });

    return noStoreJson({ success: true, id: signal.id });
  } catch (error) {
    console.error("Error saving signal:", error);
    return noStoreJson(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

function parseSignalData(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return data;
  }
}

// GET: Retrieve signaling messages for a channel
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const channelId = searchParams.get("channelId");
    const lastIdRaw = searchParams.get("lastId");
    
    if (!channelId || !isValidChannelId(channelId)) {
      return noStoreJson(
        { error: "Valid channelId is required" },
        { status: 400 }
      );
    }

    const lastId = lastIdRaw && /^\d{1,20}$/.test(lastIdRaw) ? BigInt(lastIdRaw) : BigInt(0);

    const ip = getClientIp(req);
    const allowed = await checkRateLimit(`${ip}:${channelId}`, "webrtc_signal_get", 1800, 5);
    if (!allowed) {
      return noStoreJson({ error: "Rate limit exceeded" }, { status: 429 });
    }

    const signals = await prisma.signal.findMany({
      where: {
        channel_id: channelId,
        ...(lastId > 0 ? { timestamp: { gt: lastId } } : {}),
      },
      orderBy: { timestamp: 'asc' },
      take: 250,
    }) as SignalRow[];

    const parsedSignals = signals.map((signal: SignalRow) => ({
      id: signal.timestamp.toString(),
      channel_id: signal.channel_id,
      sender: signal.sender,
      type: signal.type,
      data: parseSignalData(signal.data),
    }));

    return noStoreJson({ signals: parsedSignals });
  } catch (error) {
    console.error("Error retrieving signals:", error);
    return noStoreJson(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
