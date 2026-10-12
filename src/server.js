// src/server.js
const express = require('express');
const cors = require('cors');
require('dotenv').config();

// 1. Initialize background jobs
require('./cron/reminders');
require('./cron/subscriptions');

const db = require('./config/db');

// Import Routes
const authRoutes = require('./routes/authRoutes');
const caseRoutes = require('./routes/caseRoutes');
const hearingRoutes = require('./routes/hearingRoutes');
const walletRoutes = require('./routes/walletRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const adminRoutes = require('./routes/adminRoutes');
const paymentRoutes = require('./routes/paymentRoutes');
const caseStudyRoutes = require('./routes/caseStudyRoutes');

const app = express();

app.use(cors());

// IMPORTANT: Body size limits MUST be here, before the routes.
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Apply Routes
app.use('/api/auth', authRoutes);
app.use('/api/cases', caseRoutes);
app.use('/api/hearings', hearingRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/payment', paymentRoutes);
app.use('/api/case-study', caseStudyRoutes);

app.get('/', (req, res) => {
    res.status(200).send('Backend is running perfectly!');
});

// Health Check Endpoint
app.get('/api/health', (req, res) => {
    res.status(200).json({ status: 'OK', message: 'Lawyer Diary API is running smoothly' });
});

// Database Connection Test Endpoint
app.get('/api/db-test', async (req, res) => {
    try {
        const result = await db.query('SELECT NOW()');
        res.status(200).json({ success: true, message: 'Database connection successful!', time: result.rows[0].now });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 1. GET ROUTE: Fetches gateways for BOTH Admin Panel and Top-Up Modal
app.get('/api/gateways', async (req, res) => {
    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS payment_gateways (
                id SERIAL PRIMARY KEY,
                provider VARCHAR(50),
                account_number VARCHAR(50),
                account_type VARCHAR(50),
                is_active BOOLEAN DEFAULT true
            );
        `);
        const result = await db.query('SELECT * FROM payment_gateways ORDER BY id ASC');
        res.json({ success: true, gateways: result.rows });
    } catch (err) {
        console.error("GET Gateways Error:", err);
        res.status(500).json({ success: false, message: 'Failed to fetch gateways' });
    }
});

// 2. POST ROUTE: Admin saves all gateways
app.post('/api/gateways/save', async (req, res) => {
    const { gateways } = req.body;
    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS payment_gateways (
                id SERIAL PRIMARY KEY,
                provider VARCHAR(50),
                account_number VARCHAR(50),
                account_type VARCHAR(50),
                is_active BOOLEAN DEFAULT true
            );
        `);

        await db.query('DELETE FROM payment_gateways');

        for (const g of gateways) {
            if (g.account_number && g.account_number.trim() !== '') {
                await db.query(
                    'INSERT INTO payment_gateways (provider, account_number, account_type, is_active) VALUES ($1, $2, $3, $4)',
                    [g.provider, g.account_number, g.account_type, true]
                );
            }
        }
        res.json({ success: true, message: 'Gateways saved successfully' });
    } catch (err) {
        console.error("POST Gateways Error:", err);
        res.status(500).json({ success: false, message: 'Failed to save gateways' });
    }
});

// --- 1-CLICK DATABASE FIX ROUTE ---
app.get('/api/fix-gateways', async (req, res) => {
    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS payment_gateways (
                                                            id SERIAL PRIMARY KEY,
                                                            provider VARCHAR(50),
                account_number VARCHAR(50),
                account_type VARCHAR(50),
                is_active BOOLEAN DEFAULT true
                );
        `);

        await db.query('DELETE FROM payment_gateways');

        await db.query(`INSERT INTO payment_gateways (provider, account_number, account_type) VALUES ('bKash', '01611444463', 'Merchant (Make Payment)')`);
        await db.query(`INSERT INTO payment_gateways (provider, account_number, account_type) VALUES ('Nagad', '01611444463', 'Merchant (Make Payment)')`);
        await db.query(`INSERT INTO payment_gateways (provider, account_number, account_type) VALUES ('bKash', '01684161644', 'Personal (Send Money)')`);
        await db.query(`INSERT INTO payment_gateways (provider, account_number, account_type) VALUES ('Nagad', '01684161644', 'Personal (Send Money)')`);

        res.send(`<h1 style="color: green; font-family: sans-serif; text-align: center; margin-top: 50px;">✅ Database Fixed! All 4 Gateways Injected Successfully.</h1><p style="text-align: center; font-family: sans-serif;">You can now close this tab, go back to Lawyer Diary, and click the <b>+ Top Up</b> button!</p>`);
    } catch (err) {
        res.send(`<h1 style="color: red;">Error: ${err.message}</h1>`);
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});