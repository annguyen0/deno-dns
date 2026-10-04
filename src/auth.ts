import { getKv } from "./kv.ts";

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 ngày

// --- PBKDF2 Password Hashing ---

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const encoder = new TextEncoder();
  const passwordKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"],
  );

  const keyBuffer = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt,
      iterations: 100_000,
      hash: "SHA-256",
    },
    passwordKey,
    256,
  );

  const saltHex = Array.from(salt)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const hashHex = Array.from(new Uint8Array(keyBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return `${saltHex}:${hashHex}`;
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  try {
    const parts = stored.split(":");
    if (parts.length !== 2) return false;
    const [saltHex, expectedHash] = parts;

    const salt = new Uint8Array(
      saltHex.match(/.{1,2}/g)!.map((byte) => parseInt(byte, 16)),
    );

    const encoder = new TextEncoder();
    const passwordKey = await crypto.subtle.importKey(
      "raw",
      encoder.encode(password),
      { name: "PBKDF2" },
      false,
      ["deriveBits"],
    );

    const keyBuffer = await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        salt,
        iterations: 100_000,
        hash: "SHA-256",
      },
      passwordKey,
      256,
    );

    const actualHash = Array.from(new Uint8Array(keyBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    return actualHash === expectedHash;
  } catch {
    return false;
  }
}

// --- Password & Setup Management ---

export async function isSetupNeeded(): Promise<boolean> {
  const envPassword = Deno.env.get("ADMIN_PASSWORD");
  if (envPassword && envPassword.trim().length > 0) {
    return false;
  }
  const stored = await getKv().get<string>(["auth", "password_hash"]);
  return !stored.value;
}

export async function checkAdminPassword(password: string): Promise<boolean> {
  const envPassword = Deno.env.get("ADMIN_PASSWORD");
  if (envPassword && envPassword.trim().length > 0) {
    return password === envPassword.trim();
  }

  const stored = await getKv().get<string>(["auth", "password_hash"]);
  if (!stored.value) {
    return false;
  }

  return await verifyPassword(password, stored.value);
}

export async function setAdminPassword(password: string): Promise<void> {
  const hash = await hashPassword(password);
  await getKv().set(["auth", "password_hash"], hash);
}

// --- Session Management ---

export async function createSession(): Promise<
  { sessionId: string; expiresAt: number }
> {
  const sessionId = crypto.randomUUID();
  const expiresAt = Date.now() + SESSION_TTL_MS;
  await getKv().set(["sessions", sessionId], { expiresAt }, {
    expireIn: SESSION_TTL_MS,
  });
  return { sessionId, expiresAt };
}

export async function verifySession(
  sessionId: string | null,
): Promise<boolean> {
  if (!sessionId) return false;
  const session = await getKv().get<{ expiresAt: number }>([
    "sessions",
    sessionId,
  ]);
  if (!session.value) return false;
  if (session.value.expiresAt < Date.now()) {
    await getKv().delete(["sessions", sessionId]);
    return false;
  }
  return true;
}

export async function deleteSession(sessionId: string | null): Promise<void> {
  if (!sessionId) return;
  await getKv().delete(["sessions", sessionId]);
}

// Helper to extract session ID from request (cookie or Bearer header)
export function getSessionIdFromRequest(req: Request): string | null {
  const authHeader = req.headers.get("authorization");
  if (authHeader && authHeader.startsWith("Bearer ")) {
    return authHeader.substring(7).trim();
  }

  const cookieHeader = req.headers.get("cookie");
  if (cookieHeader) {
    const match = cookieHeader.match(/doh_session=([a-zA-Z0-9_-]+)/);
    if (match) return match[1];
  }

  return null;
}

export async function authenticateRequest(req: Request): Promise<boolean> {
  const sessionId = getSessionIdFromRequest(req);
  return await verifySession(sessionId);
}
