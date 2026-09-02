const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
const webpush = require('web-push');

admin.initializeApp();

const VAPID_PUBLIC_KEY = defineSecret('VAPID_PUBLIC_KEY');
const VAPID_PRIVATE_KEY = defineSecret('VAPID_PRIVATE_KEY');

const userNames = { A: 'Tomo', B: 'Veron' };

// Fires on every write to the shared household document. Sends a push to
// whichever of the two people did NOT make the change, using whatever push
// subscription they saved when they tapped "Enable Notifications".
exports.notifyOnCalendarChange = onDocumentWritten(
  {
    document: 'households/{householdId}',
    secrets: [VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY],
  },
  async (event) => {
    const after = event.data && event.data.after ? event.data.after.data() : null;
    if (!after) return; // document was deleted, nothing to notify

    const modifiedBy = after.lastModifiedBy;
    if (modifiedBy !== 'A' && modifiedBy !== 'B') return;

    const otherUser = modifiedBy === 'A' ? 'B' : 'A';
    const subscription = after.pushSubscriptions && after.pushSubscriptions[otherUser];
    if (!subscription) return; // other person hasn't enabled notifications on any device

    webpush.setVapidDetails(
      'mailto:borromeoveronica980@gmail.com',
      VAPID_PUBLIC_KEY.value(),
      VAPID_PRIVATE_KEY.value()
    );

    const payload = JSON.stringify({
      title: 'Shared Calendar',
      body: `${userNames[modifiedBy]} just updated the calendar`,
      url: './',
      icon: './icon-192.png',
      badge: './favicon-32.png',
    });

    try {
      await webpush.sendNotification(subscription, payload);
    } catch (err) {
      console.error('Push failed:', err.statusCode, err.body);
      // Subscription is dead (app uninstalled, permission revoked, etc.) — clean it up
      // so future writes don't keep failing against it.
      if (err.statusCode === 410 || err.statusCode === 404) {
        await event.data.after.ref.update({
          [`pushSubscriptions.${otherUser}`]: admin.firestore.FieldValue.delete(),
        });
      }
    }
  }
);
