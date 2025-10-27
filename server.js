const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
require('dotenv').config();
const mongoose = require('mongoose');

const app = express();
const PORT = process.env.PORT || 3000;

// Local fallback storage for sensor data
const localDataStore = {
    sensorData: []
};

// Function to get the current IST date and time
function getISTDateTime() {
    return new Date().toLocaleString('en-US', {
        timeZone: 'Asia/Kolkata',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    }).replace(/(\d+)\/(\d+)\/(\d+)/, '$3-$1-$2');
}

// Connect to MongoDB via mongoose
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/aquaponics_db';
mongoose.connect(MONGODB_URI, {
    // mongoose v8+ no need for useNewUrlParser/useUnifiedTopology options
}).then(() => {
    console.log('✅ Connected to MongoDB');
}).catch(err => {
    console.error('MongoDB connection error:', err.message || err);
});

// Define schema & model (available whether or not connection succeeds)
const sensorSchema = new mongoose.Schema({
    waterLevel: { type: Number, required: true },
    temperatureCelsius: { type: Number, required: true },
    temperatureFahrenheit: { type: Number, required: true },
    istTimestamp: { type: String, required: true }
}, { timestamps: true });

let SensorData;
try {
    SensorData = mongoose.model('SensorData', sensorSchema);
} catch (e) {
    // in case model is already compiled in hot-reload environments
    SensorData = mongoose.models.SensorData || mongoose.model('SensorData', sensorSchema);
}

// Middleware
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type'],
    credentials: true
}));
app.use(bodyParser.json());

// Root endpoint
app.get('/', (req, res) => {
    res.send('Welcome to Water Level and Temperature Monitoring System API');
});

// Helper to check DB connection
function isDbConnected() {
    return mongoose.connection && mongoose.connection.readyState === 1; // 1 = connected
}

// POST endpoint for sensor data
app.post('/api/sensor-data', async (req, res) => {
    console.log('Received data:', req.body);

    const {
        waterLevel,
        temperatureCelsius,
        temperatureFahrenheit
    } = req.body;

    if (waterLevel === undefined || waterLevel === null ||
        temperatureCelsius === undefined || temperatureCelsius === null ||
        temperatureFahrenheit === undefined || temperatureFahrenheit === null) {
        return res.status(400).json({
            success: false,
            message: 'Missing required fields: waterLevel, temperatureCelsius, or temperatureFahrenheit'
        });
    }

    const entry = {
        waterLevel: Number(waterLevel),
        temperatureCelsius: Number(temperatureCelsius),
        temperatureFahrenheit: Number(temperatureFahrenheit),
        timestamp: getISTDateTime(),
        id: Date.now().toString()
    };

    // Try saving to DB if connected, otherwise store locally
    if (isDbConnected()) {
        try {
            const doc = await SensorData.create({
                waterLevel: entry.waterLevel,
                temperatureCelsius: entry.temperatureCelsius,
                temperatureFahrenheit: entry.temperatureFahrenheit,
                istTimestamp: entry.timestamp
            });

            const newData = {
                waterLevel: doc.waterLevel,
                temperatureCelsius: doc.temperatureCelsius,
                temperatureFahrenheit: doc.temperatureFahrenheit,
                timestamp: doc.istTimestamp,
                id: doc._id.toString()
            };

            return res.status(200).json({
                success: true,
                message: 'Data stored successfully (db)',
                latestData: newData
            });
        } catch (error) {
            console.error('Error saving to DB:', error);
            // fallthrough to store locally
        }
    } else {
        console.warn('DB not connected — falling back to local store');
    }

    // Fallback: store locally
    try {
        localDataStore.sensorData.unshift(entry);
        if (localDataStore.sensorData.length > 100) {
            localDataStore.sensorData = localDataStore.sensorData.slice(0, 100);
        }

        return res.status(200).json({
            success: true,
            message: 'Data stored locally (fallback)',
            latestData: entry
        });
    } catch (error) {
        console.error('Error storing locally:', error);
        return res.status(500).json({
            success: false,
            message: error.message || 'Error storing data'
        });
    }
});

// GET endpoint for sensor data
app.get('/api/sensor-data', async (req, res) => {
    const limit = parseInt(req.query.limit, 10) || 10;

    // Prefer DB if connected
    if (isDbConnected()) {
        try {
            const docs = await SensorData.find()
                .sort({ createdAt: -1 })
                .limit(limit)
                .lean();

            const data = docs.map(doc => ({
                waterLevel: doc.waterLevel,
                temperatureCelsius: doc.temperatureCelsius,
                temperatureFahrenheit: doc.temperatureFahrenheit,
                timestamp: doc.istTimestamp,
                id: doc._id.toString()
            }));

            return res.status(200).json({ success: true, data });
        } catch (error) {
            console.error('Error fetching data from DB:', error);
            // fallback to local below
        }
    } else {
        console.warn('DB not connected — returning local store data');
    }

    // Fallback to local store
    try {
        const data = localDataStore.sensorData.slice(0, limit);
        return res.status(200).json({ success: true, data });
    } catch (error) {
        console.error('Error fetching local data:', error);
        return res.status(500).json({
            success: false,
            message: 'Error retrieving data'
        });
    }
});

// GET endpoint for latest reading
app.get('/api/sensor-data/latest', async (req, res) => {
    if (isDbConnected()) {
        try {
            const doc = await SensorData.findOne().sort({ createdAt: -1 }).lean();
            if (doc) {
                return res.status(200).json({
                    success: true,
                    data: {
                        waterLevel: doc.waterLevel,
                        temperatureCelsius: doc.temperatureCelsius,
                        temperatureFahrenheit: doc.temperatureFahrenheit,
                        timestamp: doc.istTimestamp,
                        id: doc._id.toString()
                    }
                });
            }
            // else fallthrough to local
        } catch (error) {
            console.error('Error fetching latest from DB:', error);
            // fallthrough to local
        }
    } else {
        console.warn('DB not connected — returning latest from local store if available');
    }

    if (localDataStore.sensorData.length > 0) {
        return res.status(200).json({
            success: true,
            data: localDataStore.sensorData[0]
        });
    }

    return res.status(404).json({
        success: false,
        message: 'No data available'
    });
});

// Start server
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

// Here are proper curl commands for your API.  
// No changes to server.js.

// #### POST sensor data
// curl -X POST http://localhost:3000/api/sensor-data \
//   -H "Content-Type: application/json" \
//   -d '{"waterLevel": 12.5, "temperatureCelsius": 28.3, "temperatureFahrenheit": 82.9}'

