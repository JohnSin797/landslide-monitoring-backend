// index.js - Sensor Data Web Server (Express + Firebase Admin + Twilio)
// Receives data from ESP32, saves to Firebase, sends SMS alerts on threshold
// Uses ONLY environment variables - no serviceAccountKey.json file

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const twilio = require('twilio');

const app = express();
const port = process.env.PORT || 3000;

// ────────────────────────────────────────────────
//  Middleware
// ────────────────────────────────────────────────
app.use(cors());                        // Allow requests from Flutter & ESP32
app.use(express.json());                // Parse JSON bodies
app.use(express.urlencoded({ extended: true }));

// ────────────────────────────────────────────────
//  Firebase Admin SDK Initialization (from ENV vars only)
// ────────────────────────────────────────────────
const serviceAccount = {
  projectId: process.env.FIREBASE_PROJECT_ID,
  privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),  // Fix escaped newlines
  clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
};

if (!serviceAccount.projectId || !serviceAccount.privateKey || !serviceAccount.clientEmail) {
  console.error('Missing required Firebase credentials in .env:');
  console.error('FIREBASE_PROJECT_ID, FIREBASE_PRIVATE_KEY, FIREBASE_CLIENT_EMAIL');
  process.exit(1); // Stop server if credentials are incomplete
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://landslide-monitoring-sys-f8745-default-rtdb.asia-southeast1.firebasedatabase.app",  // Auto-built from project ID
  // or hard-code if needed: "https://landslide-monitoring-sys-f8745-default-rtdb.asia-southeast1.firebasedatabase.app"
});

const db = admin.database();
const firestore = admin.firestore();

console.log('Firebase Admin SDK initialized successfully (from environment variables)');

// ────────────────────────────────────────────────
//  Twilio Configuration
// ────────────────────────────────────────────────
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER; // e.g. +14155551234

const SOIL_THRESHOLD = 20; // Alert if soil moisture <= this value (%)

// ────────────────────────────────────────────────
//  Helper: Get user's phone number from Firestore
// ────────────────────────────────────────────────
async function getUserPhone(uid) {
  try {
    const userDoc = await firestore.collection('users').doc(uid).get();

    if (!userDoc.exists) {
      console.log(`User not found: ${uid}`);
      return null;
    }

    const phone = userDoc.data().phoneNumber;

    if (!phone || !phone.startsWith('+')) {
      console.log(`Invalid or missing phone number for user ${uid}`);
      return null;
    }

    return phone;
  } catch (error) {
    console.error('Error fetching user phone:', error);
    return null;
  }
}

// ────────────────────────────────────────────────
//  Routes
// ────────────────────────────────────────────────

// Health check / welcome route
app.get('/', (req, res) => {
  res.send('Sensor Web Server is running. POST sensor data to /sensors');
});

// ESP32 → send sensor readings

// ────────────────────────────────────────────────
//  /sensors POST route – full version
// ────────────────────────────────────────────────

app.post('/sensors', async (req, res) => {
  try {
    const {
      device_id = 'ESP32_001',
      soil_moisture_1,
      soil_moisture_2,
      soil_moisture_3,
      tilt = 0,           // degrees
      vibration = 0       // in g
    } = req.body;

    // Basic validation – at least one soil moisture value
    if (
      soil_moisture_1 === undefined &&
      soil_moisture_2 === undefined &&
      soil_moisture_3 === undefined
    ) {
      return res.status(400).json({ error: 'Missing all soil_moisture values' });
    }

    // Convert to numbers
    const sm1 = Number(soil_moisture_1) || 0;
    const sm2 = Number(soil_moisture_2) || 0;
    const sm3 = Number(soil_moisture_3) || 0;
    const tiltDeg = Number(tilt);
    const vibG = Number(vibration);

    // ─── Alert Level Calculation ────────────────────────────────────────

    let alertLevel = 1;
    let alertMessage = "Normal but Monitored";

    // Count conditions that indicate increased risk
    let riskCount = 0;

    // Soil moisture risk
    if (sm1 > 60) riskCount++;
    if (sm2 > 65) riskCount++;
    if (sm3 > 65) riskCount++;

    // Tilt risk
    if (tiltDeg > 2) riskCount++;

    // Vibration risk
    if (vibG > 0.03) riskCount++;

    // Level 2 – Intermediate Warning
    // At least 3 risk indicators
    if (riskCount >= 3) {
      alertLevel = 2;
      alertMessage = "Intermediate Warning";
    }

    // Level 3 – Critical / Imminent Failure
    // Any of these serious conditions
    if (
      (sm1 > 75 && sm2 > 80 && sm3 > 85) ||     // all soil very high
      (tiltDeg > 5 && vibG > 0.08) ||           // tilt + vibration critical
      (sm1 > 75 && tiltDeg > 5) ||              // soil + tilt critical
      vibG > 0.20                               // extreme vibration
    ) {
      alertLevel = 3;
      alertMessage = "Critical - Imminent Failure";
    }

    // Prepare data to save
    const reading = {
      device_id,
      soil_moisture_1: sm1,
      soil_moisture_2: sm2,
      soil_moisture_3: sm3,
      tilt: tiltDeg,
      vibration: vibG,
      alert_level: alertLevel,
      alert_message: alertMessage,
      timestamp: admin.database.ServerValue.TIMESTAMP
    };

    // Save to Realtime Database
    const newRef = await db.ref(`sensors/${device_id}/readings`).push(reading);
    console.log(`Saved reading for ${device_id} at key ${newRef.key} - Level ${alertLevel}`);

    // ─── Send SMS to all subscribed users ──────────────────────────────
    let smsCount = 0;

    if (alertLevel >= 2) {
      // Check cooldown (optional – prevents spam)
      const deviceRef = admin.firestore().collection('devices').doc(device_id);
      const deviceSnap = await deviceRef.get();
      const lastAlert = deviceSnap.data()?.lastAlertSent?.toMillis() || 0;

      const cooldownMinutes = 15;
      if (Date.now() - lastAlert < cooldownMinutes * 60 * 1000) {
        console.log(`Alert skipped – last sent < ${cooldownMinutes} min ago`);
      } else {
        // Get all subscribers
        const subsSnap = await admin.firestore()
          .collection('devices')
          .doc(device_id)
          .collection('alert_subscribers')
          .get();

        if (!subsSnap.empty) {
          const smsPromises = [];

          subsSnap.forEach((doc) => {
            const sub = doc.data();
            const phone = sub.phoneNumber;

            if (phone && phone.startsWith('+')) {
              const msg = `${alertMessage} (Level ${alertLevel}) – Device: ${device_id}\n` +
                          `Soil: ${sm1}% / ${sm2}% / ${sm3}%\n` +
                          `Tilt: ${tiltDeg}° | Vibration: ${vibG}g`;

              smsPromises.push(
                twilioClient.messages.create({
                  body: msg,
                  from: TWILIO_PHONE_NUMBER,
                  to: phone
                })
                .then(() => {
                  smsCount++;
                  console.log(`SMS sent to ${phone}`);
                })
                .catch(err => {
                  console.error(`SMS failed to ${phone}:`, err.message);
                })
              );
            }
          });

          await Promise.all(smsPromises);

          // Update last alert time
          await deviceRef.set({
            lastAlertSent: admin.firestore.FieldValue.serverTimestamp()
          }, { merge: true });
        } else {
          console.log(`No subscribers found for ${device_id}`);
        }
      }
    }

    // Send response back to ESP32
    res.status(200).json({
      success: true,
      alert_level: alertLevel,
      alert_message: alertMessage,
      sms_sent_count: smsCount
    });

  } catch (error) {
    console.error('Error processing /sensors:', error);
    res.status(500).json({ error: 'Server error', details: error.message });
  }
});

// Manual trigger SMS alert (for testing)
app.post('/alert', async (req, res) => {
  const { uid, message, deviceId = 'manual' } = req.body;

  if (!uid || !message) {
    return res.status(400).json({ error: 'Missing uid or message' });
  }

  const phone = await getUserPhone(uid);

  if (!phone) {
    return res.status(404).json({ error: 'User phone not found' });
  }

  try {
    await twilioClient.messages.create({
      body: message,
      from: TWILIO_PHONE_NUMBER,
      to: phone
    });

    console.log(`Manual SMS sent to ${phone} for user ${uid}`);
    res.json({ success: true, sentTo: phone });
  } catch (error) {
    console.error('Twilio error:', error);
    res.status(500).json({ error: 'Failed to send SMS', details: error.message });
  }
});

// Start server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
  console.log(`URL: http://localhost:${port}`);
  console.log('Ready to receive data from ESP32');
});