import { NextApiRequest, NextApiResponse } from 'next';

import { now, randomId } from '../../../utils/api-helpers';

import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  // https://github.com/stripe/stripe-node#configuration
  apiVersion: '2020-08-27',
});
import * as admin from 'firebase-admin';
import * as firebaseTools from 'firebase-tools';

const FIREBASE_PROJECT_ID: string = process.env.FIREBASE_PROJECT_ID!;
const FIREBASE_TOKEN: string = process.env.FIREBASE_TOKEN!;

import algoliasearch from 'algoliasearch';
const client = algoliasearch(
  process.env.ALGOLIA_APP_ID!,
  process.env.ALGOLIA_SECRET_KEY!
);
const indexProducts = client.initIndex(process.env.INDEX_PRODUCTS!);

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    }),
  });
}

const firestore = admin.firestore();
const storage = admin.storage();
const auth = admin.auth();

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method === 'POST') {
    try {
      const { email, password, name, address, geoloc } = req.body;
      const uid = `u_${randomId(20)}`;
      await auth.createUser({
        uid,
        email,
        emailVerified: false,
        password,
        displayName: name,
      });

      const customerPromise = stripe.customers.create({
        email,
        name,
        metadata: {
          uid,
        },
      });

      const accountPromise = stripe.accounts.create({
        type: 'express',
        country: 'FR',
        email,
        business_type: 'individual',
        individual: {
          email,
        },
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
        metadata: {
          uid,
        },
      });

      const [customer, account] = await Promise.all([
        customerPromise,
        accountPromise,
      ]);

      const user: IUser = {
        id: uid,
        email,
        name,
        address,
        geoloc,
        stripe: {
          customerId: customer.id,
          accountId: account.id,
          transfers: account.capabilities.transfers === 'active',
        },
        created: now(),
      };
      await firestore.doc(`users/${user.id}`).set(user);
      res.status(200).json(user);
    } catch (err) {
      res.status(500).json({ statusCode: 500, message: err.message });
    }
  } else if (req.method === 'DELETE') {
    try {
      let user: IUser;
      try {
        const { uid } = await auth.verifyIdToken(
          req.headers.token as string,
          true
        );
        user = (await firestore.doc(`users/${uid}`).get()).data() as IUser;
      } catch (error) {
        return res.status(401).json({ error: error.message });
      }

      // Check if the account has a zero balance before deleting the rest of the data.
      await stripe.accounts.del(user.stripe.accountId);

      const promises = [];

      promises.push(stripe.customers.del(user.stripe.customerId));
      promises.push(
        indexProducts.deleteBy({
          filters: `user.id:${user.id}`,
        })
      );
      promises.push(auth.deleteUser(user.id));
      promises.push(
        storage.bucket().deleteFiles({
          prefix: `users/${user.id}`,
        })
      );
      promises.push(
        firebaseTools.firestore.delete(`users/${user.id}`, {
          project: FIREBASE_PROJECT_ID,
          recursive: true,
          yes: true,
          token: FIREBASE_TOKEN,
        })
      );

      await Promise.all(promises);
      res.status(200).json({
        id: user.id,
        delete: true,
      });
    } catch (err) {
      res.status(500).json({ statusCode: 500, message: err.message });
    }
  } else {
    res.setHeader('Allow', 'POST,DELETE');
    res.status(405).end('Method Not Allowed');
  }
}
