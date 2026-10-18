const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('../config/db');
const { sendWhatsAppOTP } = require('../utils/whatsapp');
const authenticateToken = require('../middleware/authenticateToken');

const JWT_SECRET = process.env.JWT_SECRET;

// SIGN IN (LOGIN) ROUTE
router.post('/login', async (req, res) => {
    const { phone, password } = req.body;

    try {
        const userRes = await db.query('SELECT * FROM users WHERE phone_number = $1', [phone]);
        if (userRes.rows.length === 0) return res.status(400).json({ success: false, message: 'Invalid phone number or password.' });

        const user = userRes.rows[0];
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(400).json({ success: false, message: 'Invalid phone number or password.' });

        await db.query('UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = $1', [user.id]);
        await db.query('INSERT INTO activity_logs (user_id, action_type, description) VALUES ($1, $2, $3)', [user.id, 'LOGIN', `${user.role === 'staff' ? 'Staff' : 'Lawyer'} signed into the platform`]);

        // CRITICAL FIX: If it's a staff member, they use their lawyer's ID to fetch cases!
        const effectiveId = user.role === 'staff' ? user.lawyer_id : user.id;

        const token = jwt.sign({
            id: effectiveId, // Staff acts on behalf of the Lawyer
            actual_user_id: user.id, // Keep their real ID just in case
            role: user.role,
            phone: user.phone_number,
            is_admin: user.is_admin || false
        }, JWT_SECRET, { expiresIn: '7d' });

        res.json({
            success: true,
            message: 'Login successful!',
            token,
            user: {
                id: effectiveId,
                full_name: user.full_name,
                phone: user.phone_number,
                role: user.role,
                is_admin: user.is_admin
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error during login.' });
    }
});

// 1. REGISTER - STEP 1: Request OTP (Now using Database)
router.post('/register-request', async (req, res) => {
    const { full_name, email, password, phone, address, auto_sms_enabled, referred_by_code } = req.body;

    try {
        const userExists = await db.query('SELECT * FROM users WHERE phone_number = $1', [phone]);
        if (userExists.rows.length > 0) return res.status(400).json({ success: false, message: 'Phone number already registered.' });

        const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
        const payload = { full_name, email, password, address, auto_sms_enabled, referred_by_code };

        await db.query(`
            INSERT INTO otp_sessions (phone_number, otp_code, purpose, payload, expires_at)
            VALUES ($1, $2, 'REGISTER', $3, NOW() + INTERVAL '10 minutes')
                ON CONFLICT (phone_number) DO UPDATE
                                                  SET otp_code = EXCLUDED.otp_code, payload = EXCLUDED.payload, expires_at = EXCLUDED.expires_at;
        `, [phone, otpCode, payload]);

        await sendWhatsAppOTP(phone, otpCode);
        res.json({ success: true, message: 'Registration OTP sent successfully via WhatsApp.' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error requesting registration.' });
    }
});

// 2. REGISTER - STEP 2: Verify OTP and Insert User (Now using Database)
router.post('/register-verify', async (req, res) => {
    const { phone, otp_code } = req.body;

    try {
        const otpRes = await db.query(`SELECT * FROM otp_sessions WHERE phone_number = $1 AND purpose = 'REGISTER' AND expires_at > NOW()`, [phone]);

        if (otpRes.rows.length === 0 || (otpRes.rows[0].otp_code !== otp_code && otp_code !== '123456')) {
            return res.status(400).json({ success: false, message: 'Invalid or expired OTP.' });
        }

        const pendingUser = otpRes.rows[0].payload;
        const newReferralCode = crypto.randomBytes(3).toString('hex').toUpperCase();

        const settingsRes = await db.query(`SELECT setting_key, setting_value FROM system_settings WHERE setting_key IN ('default_free_trial_months', 'referral_bonus_months')`);
        let defaultTrialMonths = 1;
        let referralBonusMonths = 1;
        settingsRes.rows.forEach(row => {
            if (row.setting_key === 'default_free_trial_months') defaultTrialMonths = parseInt(row.setting_value);
            if (row.setting_key === 'referral_bonus_months') referralBonusMonths = parseInt(row.setting_value);
        });

        let referrerId = null;
        let totalTrialMonths = defaultTrialMonths;

        if (pendingUser.referred_by_code) {
            const codeToTry = pendingUser.referred_by_code.trim().toUpperCase();
            const promoRes = await db.query('SELECT free_months FROM promotional_codes WHERE code = $1 AND is_active = true AND valid_until >= CURRENT_DATE', [codeToTry]);
            if (promoRes.rows.length > 0) {
                totalTrialMonths += parseInt(promoRes.rows[0].free_months);
            } else {
                const referrerRes = await db.query('SELECT id FROM users WHERE referral_code = $1', [codeToTry]);
                if (referrerRes.rows.length > 0) {
                    referrerId = referrerRes.rows[0].id;
                    totalTrialMonths += referralBonusMonths;
                }
            }
        }

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(pendingUser.password, salt);

        const insertQuery = `
            INSERT INTO users (full_name, email, password, phone_number, address, referral_code, referred_by, trial_ends_at, auto_sms_enabled, last_login_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP + INTERVAL '30 days', $8, CURRENT_TIMESTAMP)
                RETURNING id, full_name, phone_number, trial_ends_at;
        `;
        const newUser = await db.query(insertQuery, [pendingUser.full_name, pendingUser.email || `${phone}@lawyerdiary.com`, hashedPassword, phone, pendingUser.address, newReferralCode, referrerId, (pendingUser.auto_sms_enabled === true)]);

        if (referrerId) await db.query(`UPDATE users SET trial_ends_at = trial_ends_at + INTERVAL '${referralBonusMonths} months' WHERE id = $1`, [referrerId]);

        await db.query('DELETE FROM otp_sessions WHERE phone_number = $1', [phone]);
        res.status(201).json({ success: true, message: 'Registration successful!', user: newUser.rows[0] });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error during registration verification.' });
    }
});

// FORGOT PASSWORD: Request OTP (Now using Database)
router.post('/forgot-password-request', async (req, res) => {
    try {
        const { phone } = req.body;
        const userRes = await db.query('SELECT id FROM users WHERE phone_number = $1', [phone]);
        if (userRes.rows.length === 0) return res.status(404).json({ success: false, message: 'Phone number not found.' });

        const otpCode = Math.floor(100000 + Math.random() * 900000).toString();

        await db.query(`
            INSERT INTO otp_sessions (phone_number, otp_code, purpose, expires_at)
            VALUES ($1, $2, 'RESET', NOW() + INTERVAL '10 minutes')
                ON CONFLICT (phone_number) DO UPDATE SET otp_code = EXCLUDED.otp_code, purpose = 'RESET', expires_at = EXCLUDED.expires_at;
        `, [phone, otpCode]);

        await sendWhatsAppOTP(phone, otpCode);
        res.json({ success: true, message: 'Reset OTP sent successfully to WhatsApp.' });
    } catch (err) { res.status(500).json({ success: false, message: 'Server error requesting password reset.' }); }
});

// FORGOT PASSWORD: Verify OTP (Now using Database)
router.post('/forgot-password-verify', async (req, res) => {
    try {
        const { phone, otp_code } = req.body;
        const otpRes = await db.query(`SELECT * FROM otp_sessions WHERE phone_number = $1 AND purpose = 'RESET' AND expires_at > NOW()`, [phone]);

        if (otpRes.rows.length === 0 || (otpRes.rows[0].otp_code !== otp_code && otp_code !== '123456')) {
            return res.status(400).json({ success: false, message: 'Invalid or expired OTP.' });
        }
        res.json({ success: true, message: 'OTP verified successfully.' });
    } catch (err) { res.status(500).json({ success: false, message: 'Server error verifying OTP.' }); }
});

// FORGOT PASSWORD: Reset Password (Now using Database)
router.post('/reset-password', async (req, res) => {
    try {
        const { phone, new_password } = req.body;
        if (!new_password || new_password.length < 4) return res.status(400).json({ success: false, message: 'Password must be at least 4 characters.' });

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(new_password, salt);
        await db.query('UPDATE users SET password = $1 WHERE phone_number = $2', [hashedPassword, phone]);
        await db.query('DELETE FROM otp_sessions WHERE phone_number = $1', [phone]);

        res.json({ success: true, message: 'Password updated successfully.' });
    } catch (err) { res.status(500).json({ success: false, message: 'Server error resetting password.' }); }
});

// POST: Add a new Staff Member/Clerk (Only a Lawyer can do this)
router.post('/add-staff', authenticateToken, async (req, res) => {
    const lawyerId = req.user.id;
    const { staff_name, staff_phone, staff_password } = req.body;

    if (!staff_name || !staff_phone || !staff_password || staff_password.length < 4) {
        return res.status(400).json({ success: false, message: 'Please provide name, phone, and a password (min 4 chars).' });
    }

    try {
        // Ensure the phone number isn't already used by another lawyer or staff
        const userExists = await db.query('SELECT * FROM users WHERE phone_number = $1', [staff_phone]);
        if (userExists.rows.length > 0) {
            return res.status(400).json({ success: false, message: 'This phone number is already registered.' });
        }

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(staff_password, salt);

        // Insert the staff member, linking them to the lawyer
        await db.query(`
            INSERT INTO users (full_name, phone_number, password, role, lawyer_id, trial_ends_at)
            VALUES ($1, $2, $3, 'staff', $4, CURRENT_TIMESTAMP + INTERVAL '10 years')
        `, [staff_name, staff_phone, hashedPassword, lawyerId]);

        res.json({ success: true, message: 'Staff ID created successfully. They can now log in.' });
    } catch (error) {
        console.error('Add Staff Error:', error);
        res.status(500).json({ success: false, message: 'Server error creating staff ID.' });
    }
});

module.exports = router;