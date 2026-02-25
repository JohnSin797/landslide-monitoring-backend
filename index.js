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

// app.post('/sensors', async (req, res) => {
//   try {
//     let { soil_moisture, vibration, tilt = 0, device_id = "ESP32_001" } = req.body;

//     if (soil_moisture === undefined) {
//       return res.status(400).json({ error: 'Missing soil_moisture' });
//     }

//     // Optional: calculate alert level
//     let alert_level = "normal";
//     if (soil_moisture <= 20) alert_level = "warning";
//     if (soil_moisture <= 10)  alert_level = "critical";

//     const reading = {
//       device_id,
//       soil_moisture: Number(soil_moisture),
//       vibration: Number(vibration) ? 1 : 0,
//       tilt: Number(tilt) ? 1 : 0,
//       alert_level,
//       timestamp: admin.database.ServerValue.TIMESTAMP
//     };

//     // Save under per-device path
//     const newRef = await db.ref(`sensors/${device_id}/readings`).push(reading);

//     console.log(`Saved reading for ${device_id} at key ${newRef.key}`);

//     // SMS logic (optional - you can keep or remove)
//     // ... your existing SMS code ...

//     res.status(200).json({
//       success: true,
//       key: newRef.key,
//       reading
//     });

//   } catch (error) {
//     console.error('Error:', error);
//     res.status(500).json({ error: 'Server error' });
//   }
// });

app.post('/sensors', async (req, res) => {
  // In your index.js - inside app.post('/sensors', async (req, res) => {
  try {
    const { 
      device_id = 'ESP32_001',
      soil_moisture_1,
      soil_moisture_2,
      soil_moisture_3,
      vibration 
    } = req.body;

    // Required fields check (at least one soil moisture)
    if (soil_moisture_1 === undefined && soil_moisture_2 === undefined && soil_moisture_3 === undefined) {
      return res.status(400).json({ error: 'Missing all soil_moisture values' });
    }

    const timestamp = admin.database.ServerValue.TIMESTAMP;

    const sensorData = {
      device_id,
      soil_moisture_1: soil_moisture_1 !== undefined ? Number(soil_moisture_1) : null,
      soil_moisture_2: soil_moisture_2 !== undefined ? Number(soil_moisture_2) : null,
      soil_moisture_3: soil_moisture_3 !== undefined ? Number(soil_moisture_3) : null,
      vibration: Number(vibration) ? 1 : 0,
      timestamp
    };

    // Save – you can choose path style
    // Option A: per device
    await db.ref(`sensors/${device_id}`).push(sensorData);

    // Option B: flat list
    // await db.ref('sensors').push(sensorData);

    console.log(`Data saved for ${device_id}:`, sensorData);

    // Your existing SMS / alert logic...
    // You can now use soil_moisture_1, _2, _3 for alert decisions

    res.status(200).json({
      success: true,
      message: 'Data received and saved'
    });

  } catch (error) {
    console.error('Error in /sensors:', error);
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