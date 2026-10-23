import "server-only";
import { z } from "zod";
import { ApiError } from "@/server/http";

/** Required uuid query parameter (e.g. ?organizationId=…) → 400 if missing or malformed. */
export function uuidParam(req: Request, name: string): string {
  const v = new URL(req.url).searchParams.get(name);
  const r = z.uuid().safeParse(v);
  if (!r.success) throw new ApiError(400, `Query parameter ${name} must be a UUID`);
  return r.data;
}

/** Route segment id → 400 if not a uuid (avoids a database error for garbage ids). */
export async function uuidSegment(params: Promise<Record<string, string>>, name: string): Promise<string> {
  const v = (await params)[name];
  if (!z.uuid().safeParse(v).success) throw new ApiError(400, `Bad ${name}`);
  return v!;
}

export const readJson = async (req: Request) => req.json().catch(() => null);
