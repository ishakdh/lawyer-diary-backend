const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db = require('../config/db');
const authenticateToken = require('../middleware/authenticateToken');

const JWT_SECRET = process.env.JWT_SECRET;

// Guard: Ensure current requester is an active admin
const requireAdmin = (req, res, next) => {
    if (!req.user || !req.user.is_admin) {
        return res.status(403).json({ success: false, message: 'Access denied: Admin only.' });
    }
    next();
};

router.use(authenticateToken, requireAdmin);

// 1. Fetch Aggregated Statistics & Settings
router.get('/data', async (req, res) => {
    try {
        const statsQuery = await db.query(`
            SELECT
                COUNT(*)::int AS total_users,
                COUNT(CASE WHEN trial_ends_at > CURRENT_TIMESTAMP AND is_active = TRUE THEN 1 END)::int AS active_users,
                COUNT(CASE WHEN trial_ends_at <= CURRENT_TIMESTAMP OR is_active = FALSE THEN 1 END)::int AS inactive_users,
                COALESCE((SELECT SUM(balance) FROM users), 0)::numeric AS platform_wallet_volume
            FROM users;
        `);

        const settingsQuery = await db.query('SELECT setting_key, setting_value FROM system_settings;');
        const settingsMap = {};
        settingsQuery.rows.forEach(row => {
            settingsMap[row.setting_key] = row.setting_value;
        });

        const usersQuery = await db.query(`
            SELECT id, full_name, phone_number, is_admin, is_active, trial_ends_at, referral_code, created_at, last_login_at,
                   custom_monthly_fee, custom_annual_fee,
                   (SELECT COUNT(*)::int FROM users u2 WHERE u2.referred_by::text = users.id::text) AS total_referrals
            FROM users
            ORDER BY created_at DESC;
        `);

        res.json({
            success: true,
            stats: statsQuery.rows[0],
            settings: settingsMap,
            users: usersQuery.rows
        });
    } catch (err) {
        console.error('[ADMIN DATA ERROR]', err);
        res.status(500).json({ success: false, message: 'Server error retrieving admin data.' });
    }
});

// Save Custom Fee Structure for a Specific User
router.put('/users/:id/fees', async (req, res) => {
    try {
        const { id } = req.params;
        const { monthly, annual } = req.body;

        await db.query(
            'UPDATE users SET custom_monthly_fee = $1, custom_annual_fee = $2 WHERE id = $3',
            [monthly || null, annual || null, id]
        );
        res.json({ success: true, message: 'User custom fee structure updated.' });
    } catch (err) {
        console.error('[ADMIN FEE ERROR]', err);
        res.status(500).json({ success: false, message: 'Failed to update user fees.' });
    }
});


// Example of what should be inside your backend adminRoutes.js
router.put('/settings', authenticateToken, async (req, res) => {
    try {
        const { subscription_tiers, payment_gateways, default_free_trial_months, referral_reward_referrer_months, referral_reward_referee_months } = req.body;

        // Save logic to database...

        res.json({ success: true, message: 'Settings updated successfully' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Server error updating settings' });
    }
});

// 3. User Management: Toggle Admin, Toggle Active Status, Delete
router.patch('/users/:id/toggle-admin', async (req, res) => {
    try {
        const { id } = req.params;
        await db.query('UPDATE users SET is_admin = NOT is_admin WHERE id = $1', [id]);
        res.json({ success: true, message: 'User role updated.' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to update user role.' });
    }
});

router.patch('/users/:id/toggle-status', async (req, res) => {
    try {
        const { id } = req.params;
        await db.query('UPDATE users SET is_active = NOT is_active WHERE id = $1', [id]);
        res.json({ success: true, message: 'User status updated.' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to update user status.' });
    }
});

router.delete('/users/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await db.query('DELETE FROM users WHERE id = $1', [id]);
        res.json({ success: true, message: 'User deleted successfully.' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to delete user.' });
    }
});

// 4. Mirror (Impersonate) User Account Without Login Credentials
router.post('/impersonate/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const userRes = await db.query('SELECT id, phone_number, is_admin FROM users WHERE id = $1', [id]);

        if (userRes.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Target user not found.' });
        }

        const targetUser = userRes.rows[0];

        // Issue a normal lawyer session token for the target user
        const mirrorToken = jwt.sign(
            { id: targetUser.id, phone: targetUser.phone_number, is_admin: false, is_mirror: true },
            JWT_SECRET,
            { expiresIn: '2h' }
        );

        res.json({ success: true, token: mirrorToken });
    } catch (err) {
        console.error('[IMPERSONATE ERROR]', err);
        res.status(500).json({ success: false, message: 'Failed to establish mirror session.' });
    }
});

// 5. Financial Ledger & Income Stats
router.get('/finance', async (req, res) => {
    try {
        const { start_date, end_date } = req.query;
        let dateFilter = '';
        let queryParams = [];

        if (start_date && end_date) {
            dateFilter = 'AND p.created_at >= $1 AND p.created_at <= $2::timestamp + interval \'1 day\'';
            queryParams = [start_date, end_date];
        }

        // Aggregate Stats
        const statsRes = await db.query(`
            SELECT
                COALESCE(SUM(CASE WHEN created_at >= CURRENT_DATE THEN amount ELSE 0 END), 0) as today,
                COALESCE(SUM(CASE WHEN created_at >= CURRENT_DATE - INTERVAL '15 days' THEN amount ELSE 0 END), 0) as last_15_days,
                COALESCE(SUM(CASE WHEN date_trunc('month', created_at) = date_trunc('month', CURRENT_DATE) THEN amount ELSE 0 END), 0) as this_month
            FROM subscription_payments p
        `);

        // Transaction Table
        const tableRes = await db.query(`
            SELECT p.*, u.full_name, u.phone_number
            FROM subscription_payments p
                     JOIN users u ON p.user_id = u.id
            WHERE 1=1 ${dateFilter}
            ORDER BY p.created_at DESC
        `, queryParams);

        res.json({ success: true, stats: statsRes.rows[0], transactions: tableRes.rows });
    } catch(err) {
        console.error('[FINANCE ERROR]', err);
        res.status(500).json({ success: false });
    }
});

// 6. Create Sub-Admin with Roles
router.post('/create-sub-admin', async (req, res) => {
    try {
        const { full_name, phone, password, permissions } = req.body;

        // Hash password
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        await db.query(`
            INSERT INTO users (full_name, phone_number, password, is_admin, admin_permissions, is_active, last_login_at)
            VALUES ($1, $2, $3, true, $4, true, CURRENT_TIMESTAMP)
        `, [full_name, phone, hashedPassword, permissions]);

        res.json({ success: true, message: 'Sub-Admin created successfully.' });
    } catch(err) {
        console.error('[CREATE ADMIN ERROR]', err);
        res.status(500).json({ success: false, message: 'Failed to create sub-admin. Phone may already exist.' });
    }
});

// Fetch Detailed Advocate Profile, Recharge History & Activity Logs
router.get('/users/:id/details', async (req, res) => {
    try {
        const { id } = req.params;

        // 1. Fetch user information
        const userRes = await db.query(`
            SELECT id, full_name, phone_number, is_admin, is_active, trial_ends_at, created_at, last_login_at
            FROM users
            WHERE id = $1::uuid;
        `, [id]);

        if (userRes.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Lawyer not found.' });
        }

        const user = userRes.rows[0];

        // 2. FIXED: Get active client/case count from the 'cases' table using chamber_owner_id
        let activeClients = 0;
        let inactiveClients = 0;
        try {
            const clientCounts = await db.query(`
                SELECT
                    COUNT(DISTINCT client_name)::int AS active
                FROM cases
                WHERE chamber_owner_id = $1::uuid;
            `, [id]);
            if (clientCounts.rows.length > 0) {
                activeClients = clientCounts.rows[0].active || 0;
            }
        } catch (e) {
            console.warn('[VIEW MODAL] Client count fallback:', e.message);
        }

        // 3. Fetch recharge/subscription payments history
        let payments = [];
        try {
            const payRes = await db.query(`
                SELECT id, amount, gateway_used, transaction_id, created_at, 'RECHARGE' as type
                FROM subscription_payments
                WHERE user_id = $1::uuid;
            `, [id]);
            payments = payRes.rows;
        } catch (e) {}

        // 4. Fetch general activity logs
        let logs = [];
        try {
            const logRes = await db.query(`
                SELECT id, action_type, description, created_at, 'ACTIVITY' as type
                FROM activity_logs
                WHERE user_id = $1::uuid
                ORDER BY created_at DESC;
            `, [id]);
            logs = logRes.rows;
        } catch (e) {}

        const combinedActivity = [...payments, ...logs].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

        res.json({
            success: true,
            user: {
                ...user,
                active_clients: activeClients,
                inactive_clients: inactiveClients
            },
            recharges: combinedActivity
        });
    } catch (err) {
        console.error('[ADMIN USER DETAILS ERROR]', err);
        res.status(500).json({ success: false, message: 'Server error retrieving lawyer details.' });
    }
});

// Update Sub-Admin Details & Permissions
router.put('/admins/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { full_name, phone, permissions } = req.body;

        await db.query(`
            UPDATE users
            SET full_name = $1, phone_number = $2, admin_permissions = $3
            WHERE id = $4::uuid AND is_admin = true
        `, [full_name, phone, permissions, id]);

        res.json({ success: true, message: 'Admin updated successfully.' });
    } catch (err) {
        console.error('[UPDATE ADMIN ERROR]', err);
        res.status(500).json({ success: false, message: 'Failed to update admin profile.' });
    }
});

// --- AUTO-CREATE PROMOTIONAL CODES TABLE ---
(async () => {
    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS promotional_codes (
                id SERIAL PRIMARY KEY,
                code VARCHAR(50) UNIQUE NOT NULL,
                free_months INT NOT NULL DEFAULT 1,
                valid_until DATE NOT NULL,
                is_active BOOLEAN DEFAULT true,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
    } catch (e) { console.warn('Promo table check:', e.message); }
})();

// --- PROMOTIONAL CODES MANAGEMENT ---
router.get('/promos', async (req, res) => {
    try {
        const result = await db.query('SELECT * FROM promotional_codes ORDER BY created_at DESC');
        res.json({ success: true, promos: result.rows });
    } catch (err) { res.status(500).json({ success: false }); }
});

router.post('/promos', async (req, res) => {
    try {
        const { code, valid_until, free_months } = req.body;
        await db.query(
            'INSERT INTO promotional_codes (code, valid_until, free_months) VALUES (UPPER($1), $2, $3)',
            [code, valid_until, free_months]
        );
        res.json({ success: true, message: 'Promo code added!' });
    } catch (err) { res.status(500).json({ success: false, message: 'Code might already exist.' }); }
});

router.delete('/promos/:id', async (req, res) => {
    try {
        await db.query('DELETE FROM promotional_codes WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false }); }
});

module.exports = router;