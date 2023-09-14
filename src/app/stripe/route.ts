import type { NextApiRequest, NextApiResponse } from "next";
import { env } from "~/env.mjs";
import { prisma } from "~/server/db";
import type Stripe from "stripe";
import { buffer } from "micro";
import { match, P } from "ts-pattern";
// import {
//   handleInvoicePaid,
//   handleSubscriptionCanceled,
//   handleSubscriptionCreatedOrUpdated,
// } from "../../server/stripe/stripe-webhook-handlers";
import { stripe } from "../../server/stripe/client";

// Stripe requires the raw body to construct the event.
export const config = {
  api: {
    bodyParser: false,
  },
};

const webhookSecret = env.STRIPE_WEBHOOK_SECRET;

export default async function POST(req: NextApiRequest, res: NextApiResponse) {
  const buf = await buffer(req);
  const sig = req.headers["stripe-signature"];
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(buf, sig as string, webhookSecret);

    match(event)
      .with({ type: "invoice.paid" }, async (event) => {
        const invoice = event.data.object as Stripe.Invoice;
        const subscriptionId = invoice.subscription;
        const subscription = await stripe.subscriptions.retrieve(
          subscriptionId as string
        );
        const userId = subscription.metadata.userId;
        await prisma.user.update({
          where: {
            id: userId,
          },
          data: {
            subscription: subscription.status,
          },
        });
      })
      .with(
        {
          type: P.union(
            "customer.subscription.created",
            "customer.subscription.updated"
          ),
        },
        async () => {
          const subscription = event.data.object as Stripe.Subscription;
          const userId = subscription.metadata.userId;

          // update user with subscription data
          await prisma.user.update({
            where: {
              id: userId,
            },
            data: {
              subscription: subscription.status,
            },
          });
        }
      )
      .with({ type: "invoice.payment_failed" }, async () => {
        // TODO: Send email to user to tell them their payment failed
      })
      .with({ type: "customer.subscription.deleted" }, async () => {
        const subscription = event.data.object as Stripe.Subscription;
        const userId = subscription.metadata.userId;
        await prisma.user.update({
          where: {
            id: userId,
          },
          data: {
            subscription: null,
          },
        });
      })
      .otherwise(() => {});

    res.json({ received: true });
  } catch (err) {
    res.status(400).send(err);
    return;
  }
}
