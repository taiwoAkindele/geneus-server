import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { FacilitySignupDecision, facilitySignupReviewToken, type ApiErrorBody } from '#shared';
import type { Sql } from '../db/client.ts';
import type { Mailer } from '../lib/email.ts';
import {
  decideSignupRequest,
  openSignupReview,
  resendSignupDecision,
  SignupRefusal,
} from '../facilities/signupRequests.ts';

const INVALID_LINK =
  'This review link is not valid. It may have expired, or your operator access may have been removed';

const refuse = (reply: FastifyReply, status: number, error: string, message: string) =>
  reply.code(status).send({ error, message } satisfies ApiErrorBody);

const TokenOnly = z.strictObject({ token: facilitySignupReviewToken });

/**
 * Deciding facility sign-up requests from the email each Geneus operator is
 * sent. The link's token is the operator's credential for that one request:
 * opening it shows the request and changes nothing; deciding and resending are
 * explicit POSTs from the page, recorded against that operator.
 */
export const registerFacilitySignupReviewRoutes = (
  app: FastifyInstance,
  sql: Sql,
  mailer: Mailer,
  appUrl: string,
) => {
  const refusal = (reply: FastifyReply, cause: unknown) => {
    if (cause instanceof SignupRefusal) {
      return refuse(reply, 409, cause.code, cause.message);
    }

    throw cause;
  };

  app.post('/facility-requests/review/open', async (request, reply) => {
    const parsed = TokenOnly.safeParse(request.body);

    if (!parsed.success) {
      return refuse(reply, 400, 'invalid_link', INVALID_LINK);
    }

    const review = await openSignupReview(sql, parsed.data.token);

    if (!review) {
      return refuse(reply, 404, 'invalid_link', INVALID_LINK);
    }

    return review;
  });

  app.post('/facility-requests/review/decide', async (request, reply) => {
    const parsed = FacilitySignupDecision.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_request',
        message: parsed.error.issues[0]?.message ?? 'Approve or reject the request',
        issues: parsed.error.issues,
      } satisfies ApiErrorBody);
    }

    try {
      const review = await decideSignupRequest(sql, mailer, appUrl, parsed.data);

      if (!review) {
        return refuse(reply, 404, 'invalid_link', INVALID_LINK);
      }

      request.log.info({ request: review.id, status: review.status }, 'facility request decided');

      return review;
    } catch (cause) {
      return refusal(reply, cause);
    }
  });

  app.post('/facility-requests/review/resend', async (request, reply) => {
    const parsed = TokenOnly.safeParse(request.body);

    if (!parsed.success) {
      return refuse(reply, 400, 'invalid_link', INVALID_LINK);
    }

    try {
      const review = await resendSignupDecision(sql, mailer, appUrl, parsed.data.token);

      if (!review) {
        return refuse(reply, 404, 'invalid_link', INVALID_LINK);
      }

      return review;
    } catch (cause) {
      return refusal(reply, cause);
    }
  });
};
