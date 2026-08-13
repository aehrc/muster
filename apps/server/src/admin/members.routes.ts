/**
 * The approval queue, revocation, and repairing an organisation nobody is left in.
 *
 * Three decisions worth stating.
 *
 * **There is no reject.** `data-model.md` names exactly three transitions - pending to
 * approved, approved to revoked, revoked to approved - so a sign-up nobody wants stays
 * pending rather than being revoked. Revocation means "this member had standing and has lost
 * it", and a bogus sign-up never had any. The admin-members wireframe shows a Reject button
 * beside Approve; the data model does not support it and `contracts/http-api.md` offers no
 * route for it, so it is not built.
 *
 * **The notification is part of the answer.** FR-003 requires the member to be told on
 * approval and on revocation. An approval whose email bounced is not the same outcome as one
 * that arrived, so the response says which (`notified`) rather than reporting plain success
 * and leaving the admin to find out at the connectathon (FR-037).
 *
 * **Reassignment adds a member; it does not transfer anything.** The spec's edge case is an
 * organisation whose last member left, with systems still enrolled and nobody able to manage
 * them. The repair is to put an approved member back in it. Nothing is moved, and no
 * organisation is ever merged into another.
 *
 * Author: John Grimes
 */

import { accountStatusSchema, reassignInputSchema } from "@muster/contracts";
import { canChangeAccountStatus, foldEmail } from "@muster/core";
import {
  addOrganisationMember,
  findAccountByEmail,
  findAccountById,
  listAccounts,
  listOrganisationMembers,
  listOrganisationsForAccounts,
  setAccountStatus,
} from "@muster/db";

import { callerId, namedOrganisation } from "./access.js";
import { requireAdmin } from "../auth/middleware.js";
import { jsonError } from "../http/errors.js";
import { parseBody } from "../http/requestBody.js";
import { adminAccountView, organisationContactsView } from "../http/views.js";
import { approvedMessage, revokedMessage } from "../mail/messages.js";

import type { MusterEnvironment, ServerContext } from "../context.js";
import type { AccountStatus } from "@muster/core";
import type { AccountRow } from "@muster/db";
import type { Context, Hono } from "hono";

/**
 * Tells a member where they now stand.
 *
 * @returns Whether the message was accepted for delivery. A failure is reported to the admin
 *   rather than failing the decision: the decision is recorded, and re-sending an email is
 *   not something the admin can do from here anyway.
 */
async function notifyDecision(
  context: ServerContext,
  account: AccountRow,
  status: AccountStatus,
): Promise<boolean> {
  const message =
    status === "approved"
      ? approvedMessage({
          to: account.email,
          displayName: account.displayName,
          publicUrl: context.config.publicUrl,
        })
      : revokedMessage({
          to: account.email,
          displayName: account.displayName,
          publicUrl: context.config.publicUrl,
        });

  try {
    await context.mail.send(message);
    return true;
  } catch (error) {
    console.error(
      JSON.stringify({
        message: "muster.mail.failed",
        purpose: `account_${status}`,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return false;
  }
}

/**
 * Applies an admin's decision about one account.
 *
 * Written once for both verbs: approval and revocation differ in the status they ask for and
 * in the message they send, and in nothing else that matters. Two copies would drift, and the
 * half that drifted would be the notification.
 */
async function decide(
  context: ServerContext,
  c: Context<MusterEnvironment>,
  accountId: string,
  status: AccountStatus,
): Promise<Response> {
  const subject = await findAccountById(context.db, accountId);
  if (subject === undefined) {
    return jsonError(c, 404, "not_found", "No account has that id");
  }
  if (!canChangeAccountStatus(subject.status, status)) {
    return jsonError(
      c,
      409,
      "illegal_transition",
      `An account cannot go from ${subject.status} to ${status}`,
    );
  }

  const decided = await setAccountStatus(context.db, {
    accountId: subject.id,
    status,
    decidedBy: callerId(c),
    now: context.clock(),
  });
  if (decided === undefined) {
    return jsonError(c, 404, "not_found", "No account has that id");
  }

  const notified = await notifyDecision(context, decided, status);
  const organisations = await listOrganisationsForAccounts(context.db, [
    decided.id,
  ]);
  return c.json({
    account: adminAccountView(
      decided,
      organisations.map((row) => ({
        id: row.organisationId,
        name: row.organisationName,
      })),
    ),
    notified,
  });
}

/**
 * Registers the member-administration routes.
 *
 * @param router - The API router.
 * @param context - The server's dependencies.
 * @example
 * ```ts
 * registerMemberRoutes(router, context);
 * ```
 */
export function registerMemberRoutes(
  router: Hono<MusterEnvironment>,
  context: ServerContext,
): void {
  /** The approval queue, or every account. */
  router.get("/admin/accounts", requireAdmin(), async (c) => {
    const requested = c.req.query("status");
    const status =
      requested === undefined
        ? undefined
        : accountStatusSchema.safeParse(requested);
    if (status !== undefined && !status.success) {
      return jsonError(
        c,
        400,
        "invalid_request",
        "status must be pending, approved or revoked",
      );
    }

    const accounts = await listAccounts(context.db, status?.data);
    const organisations = await listOrganisationsForAccounts(
      context.db,
      accounts.map((row) => row.id),
    );
    return c.json({
      accounts: accounts.map((row) =>
        adminAccountView(
          row,
          organisations
            .filter((held) => held.accountId === row.id)
            .map((held) => ({
              id: held.organisationId,
              name: held.organisationName,
            })),
        ),
      ),
    });
  });

  /** Approves an account, and tells its holder. */
  router.post(
    "/admin/accounts/:id/approve",
    requireAdmin(),
    async (c) => await decide(context, c, c.req.param("id"), "approved"),
  );

  /** Revokes a membership, and tells its holder. */
  router.post(
    "/admin/accounts/:id/revoke",
    requireAdmin(),
    async (c) => await decide(context, c, c.req.param("id"), "revoked"),
  );

  /** Puts an approved member into an organisation whose own members have all left. */
  router.post(
    "/admin/organisations/:id/reassign",
    requireAdmin(),
    async (c) => {
      const organisation = await namedOrganisation(
        context,
        c,
        c.req.param("id"),
      );
      if (organisation instanceof Response) {
        return organisation;
      }
      const body = await parseBody(c, reassignInputSchema);
      if (body instanceof Response) {
        return body;
      }

      const member = await findAccountByEmail(
        context.db,
        foldEmail(body.email),
      );
      if (member === undefined) {
        return jsonError(
          c,
          404,
          "not_found",
          "No Muster account has that address",
        );
      }
      if (member.status !== "approved" || member.emailVerifiedAt === null) {
        return jsonError(
          c,
          409,
          "invitee_not_approved",
          "Only an approved member can be made responsible for an organisation",
        );
      }

      await addOrganisationMember(context.db, {
        organisationId: organisation.id,
        accountId: member.id,
      });
      const members = await listOrganisationMembers(
        context.db,
        organisation.id,
      );
      return c.json(organisationContactsView(organisation, members));
    },
  );
}
