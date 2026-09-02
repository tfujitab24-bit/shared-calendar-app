const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
const webpush = require('web-push');

admin.initializeApp();
const db = admin.firestore();

const VAPID_PUBLIC_KEY = defineSecret('VAPID_PUBLIC_KEY');
const VAPID_PRIVATE_KEY = defineSecret('VAPID_PRIVATE_KEY');

const userNames = { A: 'Tomo', B: 'Veron' };
const VAPID_CONTACT = 'mailto:borromeoveronica980@gmail.com';

// The family is in Tokyo. Japan uses a fixed UTC+9 with no daylight saving, so a
// Tokyo wall-clock time (what the calendar stores) maps to an exact UTC instant
// by subtracting 9 hours — no timezone library needed.
const TOKYO_UTC_OFFSET_HOURS = 9;

// Fire a reminder when an event starts within this many minutes...
const REMINDER_LEAD_MIN = 60;
// ...checked on a 5-minute schedule, so anything 45–60 min out gets exactly one
// reminder (dedup handles the overlapping ticks). A wider window survives a brief
// scheduler outage without double-reminding.
const REMINDER_WINDOW_MIN = 15;

function configureWebPush() {
  webpush.setVapidDetails(
    VAPID_CONTACT,
    VAPID_PUBLIC_KEY.value(),
    VAPID_PRIVATE_KEY.value()
  );
}

// Sends one push. If the subscription is dead (app uninstalled, permission
// revoked) it's removed from the household doc so we stop retrying it. That
// cleanup write deliberately leaves lastModifiedAt untouched — see the guard in
// notifyOnCalendarChange.
async function sendPush(householdRef, userKey, subscription, payload) {
  try {
    await webpush.sendNotification(subscription, JSON.stringify(payload));
  } catch (err) {
    console.error(`Push to ${userKey} failed:`, err.statusCode, err.body);
    if (err.statusCode === 410 || err.statusCode === 404) {
      await householdRef.update({
        [`pushSubscriptions.${userKey}`]: admin.firestore.FieldValue.delete(),
      });
    }
  }
}

// Best-effort parse of the free-text time field ("3:00 PM – 4:00 PM", or just
// "3:00 PM") into 24h hours/minutes for the start. Returns null for all-day
// events (empty time) and anything unparseable — both are skipped by design.
function parseStartTime(timeStr) {
  if (!timeStr) return null;
  const firstToken = String(timeStr).split(/[–-]/)[0].trim();
  const m = firstToken.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const period = (m[3] || '').toUpperCase();
  if (period === 'PM' && h !== 12) h += 12;
  if (period === 'AM' && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return { h, min, label: firstToken };
}

// Fires on every write to the shared household document. Sends a push to
// whichever of the two people did NOT make the change.
exports.notifyOnCalendarChange = onDocumentWritten(
  {
    document: 'households/{householdId}',
    secrets: [VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY],
  },
  async (event) => {
    const before = event.data && event.data.before ? event.data.before.data() : null;
    const after = event.data && event.data.after ? event.data.after.data() : null;
    if (!after) return; // document was deleted, nothing to notify

    // Only a genuine calendar edit bumps lastModifiedAt — the client sets it with
    // a server timestamp on every user change. Saving a push subscription, the
    // dead-subscription cleanup above, and reminder bookkeeping all leave it
    // alone, so those writes must not trigger a "just updated the calendar" push.
    const beforeAt =
      before && before.lastModifiedAt && before.lastModifiedAt.toMillis
        ? before.lastModifiedAt.toMillis()
        : 0;
    const afterAt =
      after.lastModifiedAt && after.lastModifiedAt.toMillis
        ? after.lastModifiedAt.toMillis()
        : 0;
    if (afterAt <= beforeAt) return;

    const modifiedBy = after.lastModifiedBy;
    if (modifiedBy !== 'A' && modifiedBy !== 'B') return;

    const otherUser = modifiedBy === 'A' ? 'B' : 'A';
    const subscription = after.pushSubscriptions && after.pushSubscriptions[otherUser];
    if (!subscription) return; // other person hasn't enabled notifications on any device

    configureWebPush();
    await sendPush(event.data.after.ref, otherUser, subscription, {
      title: 'Shared Calendar',
      body: `${userNames[modifiedBy]} just updated the calendar`,
      url: './',
      icon: './icon-192.png',
      badge: './favicon-32.png',
    });
  }
);

// Runs every 5 minutes and pushes a reminder to both people ~1 hour before any
// confirmed, timed event. All-day events (no time) are skipped. Which events
// have already been reminded is tracked in reminderState/{householdId} — a
// separate collection so this bookkeeping never trips notifyOnCalendarChange.
exports.remindUpcomingEvents = onSchedule(
  {
    schedule: 'every 5 minutes',
    timeZone: 'Asia/Tokyo',
    secrets: [VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY],
  },
  async () => {
    const now = Date.now();
    const households = await db.collection('households').get();
    if (households.empty) return;

    configureWebPush();

    for (const householdDoc of households.docs) {
      const data = householdDoc.data() || {};
      const events = Array.isArray(data.events) ? data.events : [];
      const subs = data.pushSubscriptions || {};
      const recipients = ['A', 'B'].filter((u) => subs[u]);
      if (recipients.length === 0) continue;

      const stateRef = db.collection('reminderState').doc(householdDoc.id);
      const stateSnap = await stateRef.get();
      const reminded = new Set(
        (stateSnap.exists && stateSnap.data().remindedEventIds) || []
      );

      const stillRelevant = new Set();
      const toNotify = [];

      for (const e of events) {
        if (e.status && e.status !== 'confirmed') continue;
        const parsed = parseStartTime(e.time);
        if (!parsed) continue; // all-day or unparseable — skipped by design

        const startMs = Date.UTC(
          e.year,
          e.month,
          e.day,
          parsed.h - TOKYO_UTC_OFFSET_HOURS,
          parsed.min
        );
        const minutesUntil = (startMs - now) / 60000;

        // Keep tracking anything that hasn't already started over an hour ago, so
        // the reminded list can be pruned of stale/deleted events below.
        if (minutesUntil > -60) stillRelevant.add(String(e.id));

        if (
          minutesUntil <= REMINDER_LEAD_MIN &&
          minutesUntil > REMINDER_LEAD_MIN - REMINDER_WINDOW_MIN &&
          !reminded.has(String(e.id))
        ) {
          toNotify.push({ event: e, label: parsed.label });
        }
      }

      for (const { event: e, label } of toNotify) {
        const payload = {
          title: '⏰ Upcoming event',
          body: `${e.title} starts in 1 hour (${label})`,
          url: './',
          icon: './icon-192.png',
          badge: './favicon-32.png',
        };
        for (const u of recipients) {
          await sendPush(householdDoc.ref, u, subs[u], payload);
        }
        reminded.add(String(e.id));
        stillRelevant.add(String(e.id));
      }

      const nextReminded = [...reminded].filter((id) => stillRelevant.has(id));
      if (!stateSnap.exists || nextReminded.length !== reminded.size) {
        await stateRef.set({
          remindedEventIds: nextReminded,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
    }
  }
);
