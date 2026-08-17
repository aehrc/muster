import { accountStatusSchema, addMemberRequestSchema } from "@muster/contracts";
import { applyStatusChange } from "@muster/core";
import {
  findAccountById,
  findOrganisationById,
  insertOrganisationMember,
  listAccountsByStatus,
  listOrganisationContacts,
  updateAccountStatus,
} from "@muster/db";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

import { parseBody } from "../auth/routes.ts";
import {
  refusalError,
  requireAdmin,
  requireGrantableAccount,
} from "../auth/sessions.ts";
import { accountView } from "../http/views.ts";
import { approvalMessage, revocationMessage } from "../mail/messages.ts";

import type { AppEnvironment } from "../app.ts";
import type { AccountView } from "@muster/contracts";
import type { StatusAction } from "@muster/core";
import type { Context } from "hono";

/**
 * Membership administration: the approval queue, approval, revocation, and
 * rescuing an organisation whose members have all left.
 *
 * Approval is the decision Muster is built around - an approved member's
 * clients are the ones Muster later vouches for - so it is a deliberate act by
 * an admin, it is standing rather than per event, it is revocable, and both
 * directions are notified (FR-002, FR-003, FR-004).
 *
 * @author John Grimes
 */

/**
 * Applies an admin's decision about an account's status.
 *
 * The transition is decided by the pure rules, so approving an already approved
 * account is a conflict rather than a second approval email, and the message
 * only goes out when something actually changed.
 *
 * @param context - the request being answered
 * @param action - the change the admin asked for
 * @returns the updated account
 * @throws {HTTPException} 403 when the caller is not an admin, 404 when there is
 *   no such account, 409 when the transition is not one the rules allow
 */
const decide = async (
  context: Context<AppEnvironment>,
  action: StatusAction,
): Promise<AccountView> => {
  const admin = await requireAdmin(context);
  const sql = context.get("sql");
  const account = await findAccountById(sql, context.req.param("id") ?? "");
  if (account === undefined) {
    throw new HTTPException(404, { message: "No such account." });
  }

  const result = applyStatusChange(account.status, action);
  if (!result.ok) {
    throw refusalError(result.refusal);
  }
  const updated = await updateAccountStatus(sql, {
    accountId: account.id,
    status: result.status,
    decidedBy: admin.id,
    decidedAt: new Date(),
  });
  if (updated === undefined) {
    throw new HTTPException(404, { message: "No such account." });
  }

  // FR-003: the member is told, in both directions.
  const config = context.get("config");
  await context
    .get("mail")
    .send(
      result.status === "approved"
        ? approvalMessage(config, updated.email)
        : revocationMessage(config, updated.email),
    );
  return accountView(updated);
};

/**
 * Builds the approval, revocation and reassignment routes.
 *
 * @returns the routes, to be mounted under `/api`
 * @example
 * ```ts
 * app.route("/api", createMembersRoutes());
 * ```
 */
export const createMembersRoutes = (): Hono<AppEnvironment> => {
  const routes = new Hono<AppEnvironment>();

  routes.get("/admin/accounts", async (context) => {
    await requireAdmin(context);
    const status = accountStatusSchema
      .catch("pending")
      .parse(context.req.query("status"));
    const accounts = await listAccountsByStatus(context.get("sql"), status);
    return context.json({ accounts: accounts.map(accountView) });
  });

  routes.post("/admin/accounts/:id/approve", async (context) =>
    context.json({ account: await decide(context, "approve") }),
  );

  routes.post("/admin/accounts/:id/revoke", async (context) =>
    context.json({ account: await decide(context, "revoke") }),
  );

  // The spec's edge case: an organisation's last member left, so its systems
  // are listed and unmanageable. An admin puts a member back in rather than
  // anything being deleted or recreated.
  routes.post("/admin/organisations/:id/reassign", async (context) => {
    const body = await parseBody(context, addMemberRequestSchema);
    await requireAdmin(context);
    const sql = context.get("sql");
    const organisationId = context.req.param("id");
    const organisation = await findOrganisationById(sql, organisationId);
    if (organisation === undefined) {
      throw new HTTPException(404, { message: "No such organisation." });
    }
    const account = await requireGrantableAccount(context, body.email);
    await insertOrganisationMember(sql, {
      organisationId,
      accountId: account.id,
    });
    return context.json({
      contacts: await listOrganisationContacts(sql, organisationId),
    });
  });

  return routes;
};
