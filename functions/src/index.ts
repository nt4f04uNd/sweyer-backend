import axios from 'axios';
import * as functions from 'firebase-functions';
import * as secrets from './secrets.json';
import { google } from 'googleapis';
import { GoogleAuth } from 'google-auth-library';

interface ArtistInfoData {
  name: string;
}

interface ArtistInfoResponse {
  imageUrl: string | null;
}

/**
 * Searches an artist and returns some information about him.
 * Currently only returns thet artist image url.
 */
export const getArtistInfoV2 = functions.https.onCall(async (data: functions.https.CallableRequest<ArtistInfoData>, context): Promise<ArtistInfoResponse> => {
  const { name } = data.data;

  if (!name) {
    throw new functions.https.HttpsError('invalid-argument', 'The `name` argument is required');
  }

  const result = await axios.get('https://api.genius.com/search', {
    params: { q: name },
    headers: {
      'Authorization': `Bearer ${secrets.genius_token}`,
      'Content-Type': 'application/json',
    }
  });
  if (result.status < 200 || result.status >= 300) {
    throw new functions.https.HttpsError('unknown', 'Genius query failed', `${result.status} ${result.statusText}`);
  }
  let imageUrl: string | null = null;
  if (result.status === 204 || result.data.response.hits.length === 0) {
    imageUrl = null;
  } else {
    imageUrl = result.data.response.hits[0].result.primary_artist.image_url;
  }
  return { imageUrl };
});

// Billing stuff
const billing = google.cloudbilling("v1").projects;
const PROJECT_ID = process.env.GCLOUD_PROJECT;
const PROJECT_NAME = `projects/${PROJECT_ID}`;

interface BillingMessage {
  costAmount: number;
  budgetAmount: number;
  currencyCode: string;
}

function setCredentialsForBilling() {
  const client = new GoogleAuth({
    scopes: [
      "https://www.googleapis.com/auth/cloud-billing",
      "https://www.googleapis.com/auth/cloud-platform",
    ],
  });

  // Set credential globally for all requests
  google.options({
    auth: client,
  });
}

/**
 * Listens to billing pubsub, and if the cost exceeds the budget,
 * it kills the billing.
 * 
 * Firebase doesn't have this as a built-in feature in the console, so this function
 * is needed to accomplish this.
 * 
 * More info about this:
 *  * guide how to disable billing - https://cloud.google.com/billing/docs/how-to/notify#test-your-cloud-function
 *  * same, but a playlist of a few videos - https://www.youtube.com/watch?v=Dk3VvRSrQIY&list=PLl-K7zZEsYLmK1tiMBeKA0iDMPDCJKM-5&index=7
 */
export const receiveBillingNoticeV2 = functions.pubsub
  .onMessagePublished<BillingMessage>('billing', async (event) => {
    const { costAmount, budgetAmount, currencyCode } = event.data.message.json;
    if (costAmount >= budgetAmount) {
      functions.logger.error(`DISABLING BILLING FOR ${PROJECT_NAME} DUE TO COST EXCEEDING LIMITATIONS. cost = ${costAmount} ${currencyCode}, budget = ${budgetAmount} ${currencyCode}`);
      await killBilling();
    } else {
      functions.logger.info(`Billing is OK costAmount=${costAmount} < budgetAmount=${budgetAmount}`);
    }
  });

/** Kills the billing for the current project */
async function killBilling() {
  setCredentialsForBilling();
  if (PROJECT_NAME) {
    const billingInfo = await billing.getBillingInfo({ name: PROJECT_NAME });
    if (billingInfo.data.billingEnabled) {
      await billing.updateBillingInfo({
        name: PROJECT_NAME,
        requestBody: {
          billingAccountName: '', // This disables billing
        },
      });
    } else {
      console.log('Already disabled billing');
    }
  }
}
