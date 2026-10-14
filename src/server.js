// src/server.js
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
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

// Trust Coolify reverse proxy so rate-limiting sees real user IPs
app.set('trust proxy', 1);

// 2. Security Headers
app.use(helmet());

// 3. Strict CORS Configuration
const allowedOrigins = [
    'https://app.lawyer.trvnx.com',
    'http://localhost:5173',
    'http://localhost:3000'
];

app.use(cors({
    origin: function (origin, callback) {
        // Allow requests with no origin (like mobile apps, curl, or server-to-server healthchecks)
        if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error('Blocked by CORS policy'));
        }
    },
    credentials: true
}));

// 4. Rate Limiters (Stop Brute-Force & DDoS)
const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 300, // Limit each IP to 300 requests per 15 mins
    message: { success: false, message: 'Too many requests, please try again later.' }
});
app.use('/api', globalLimiter);

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 20, // Strict limit for login/signup attempts
    message: { success: false, message: 'Too many login attempts, please wait 15 minutes.' }
});
app.use('/api/auth', authLimiter);

// 5. Body size limits
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ limit: '15mb', extended: true }));

// 6. Admin Protection Middleware for Gateway Saving
const verifyAdmin = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ success: false, message: 'Unauthorized: No token provided' });
        }

        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        // Verify user is actually an admin in the database
        const userCheck = await db.query('SELECT role, is_admin FROM users WHERE id = $1', [decoded.id]);
        const user = userCheck.rows[0];

        if (!user || (user.role !== 'admin' && user.role !== 'superadmin' && !user.is_admin)) {
            return res.status(403).json({ success: false, message: 'Forbidden: Admin access required' });
        }

        req.user = decoded;
        next();
    } catch (err) {
        return res.status(401).json({ success: false, message: 'Invalid or expired token' });
    }
};

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

// 1. GET ROUTE: Fetches gateways for BOTH Admin Panel and Top-Up Modal
app.get('/api/gateways', async (req, res) => {
    try {
        const result = await db.query('SELECT id, provider, account_number, account_type, is_active FROM payment_gateways WHERE is_active = true ORDER BY id ASC');
        res.json({ success: true, gateways: result.rows });
    } catch (err) {
        console.error("GET Gateways Error:", err);
        res.status(500).json({ success: false, message: 'Failed to fetch gateways' });
    }
});

// 2. POST ROUTE: Protected so ONLY Admin can save gateways
app.post('/api/gateways/save', verifyAdmin, async (req, res) => {
    const { gateways } = req.body;
    if (!Array.isArray(gateways)) {
        return res.status(400).json({ success: false, message: 'Invalid gateway data' });
    }

    try {
        await db.query('DELETE FROM payment_gateways');

        for (const g of gateways) {
            if (g.account_number && g.account_number.trim() !== '') {
                await db.query(
                    'INSERT INTO payment_gateways (provider, account_number, account_type, is_active) VALUES ($1, $2, $3, $4)',
                    [g.provider, g.account_number.trim(), g.account_type, true]
                );
            }
        }
        res.json({ success: true, message: 'Gateways saved securely' });
    } catch (err) {
        console.error("POST Gateways Error:", err);
        res.status(500).json({ success: false, message: 'Failed to save gateways' });
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});