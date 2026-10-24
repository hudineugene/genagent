"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { decideApproval } from "@/lib/team/approvals";

import { requireOwned } from "@/lib/access";
/** Решение по заявке из студии: ответ уходит сотруднику в его чат. */
export async function decideApprovalAction(id: string, approve: boolean, comment: string): Promise<{ error?: string }> {
  const user = await requireOwned("approval", id);
  const c = z.string().trim().max(1000).safeParse(comment);
  if (!c.success) return { error: "invalid" };
  const done = await decideApproval(id, approve, user.name, c.data);
  refresh();
  return done ? {} : { error: "already" };
}
