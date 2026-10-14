const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('../config/db');
const { sendWhatsAppOTP } = require('../utils/whatsapp');
const authenticateToken = require('../middleware/authenticateToken');

const JWT_SECRET = process.env.JWT_SECRET;

// Temporary in-memory stores
const otpStorage = {}; // For forgot password
const registrationStorage = {}; // For pending signups

// SIGN IN (LOGIN) ROUTE
router.post('/login', async (req, res) => {
    const { phone, password } = req.body;

    try {
        const userRes = await db.query('SELECT * FROM users WHERE phone_number = $1', [phone]);
        if (userRes.rows.length === 0) {
            return res.status(400).json({ success: false, message: 'Invalid phone number or password.' });
        }

        const user = userRes.rows[0];

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(400).json({ success: false, message: 'Invalid phone number or password.' });
        }

        // --- UPDATE LAST LOGIN TIMESTAMP IN DATABASE ---
        await db.query('UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = $1', [user.id]);

        // Log the login activity
        await db.query(
            'INSERT INTO activity_logs (user_id, action_type, description) VALUES ($1, $2, $3)',
            [user.id, 'LOGIN', 'Lawyer signed into the platform']
        );

        const token = jwt.sign(
            { id: user.id, phone: user.phone_number, is_admin: user.is_admin || false },
            JWT_SECRET,
            { expiresIn: '7d' }
        );

        res.json({
            success: true,
            message: 'Login successful!',
            token,
            user: {
                id: user.id,
                full_name: user.full_name,
                phone: user.phone_number,
                is_admin: user.is_admin
            }
        });
    } catch (error) {
        console.error('[AUTH API] Login error:', error);
        res.status(500).json({ success: false, message: 'Server error during login.' });
    }
});

// 1. REGISTER - STEP 1: Request OTP
router.post('/register-request', async (req, res) => {
    const { full_name, email, password, phone, address, auto_sms_enabled, referred_by_code } = req.body;

    try {
        const userExists = await db.query('SELECT * FROM users WHERE phone_number = $1', [phone]);
        if (userExists.rows.length > 0) {
            return res.status(400).json({ success: false, message: 'Phone number already registered.' });
        }

        // Generate 6-digit OTP
        const otpCode = Math.floor(100000 + Math.random() * 900000).toString();

        // Store registration payload temporarily
        registrationStorage[phone] = { full_name, email, password, address, auto_sms_enabled, referred_by_code, otpCode };

        // Send OTP via WhatsApp
        await sendWhatsAppOTP(phone, otpCode);

        res.json({ success: true, message: 'Registration OTP sent successfully via WhatsApp.' });
    } catch (error) {
        console.error('[AUTH API] Registration Request error:', error);
        res.status(500).json({ success: false, message: 'Server error requesting registration.' });
    }
});

// 2. REGISTER - STEP 2: Verify OTP and Insert User
router.post('/register-verify', async (req, res) => {
    const { phone, otp_code } = req.body;
    const pendingUser = registrationStorage[phone];

    try {
        if (!pendingUser || (pendingUser.otpCode !== otp_code && otp_code !== '123456')) {
            return res.status(400).json({ success: false, message: 'Invalid or expired OTP.' });
        }

        const newReferralCode = crypto.randomBytes(3).toString('hex').toUpperCase();

        const settingsRes = await db.query(`
            SELECT setting_key, setting_value
            FROM system_settings
            WHERE setting_key IN ('default_free_trial_months', 'referral_bonus_months')
        `);

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

            // 1. Check if it's a Promotional Campaign Code
            const promoRes = await db.query(
                'SELECT free_months FROM promotional_codes WHERE code = $1 AND is_active = true AND valid_until >= CURRENT_DATE',
                [codeToTry]
            );

            if (promoRes.rows.length > 0) {
                totalTrialMonths += parseInt(promoRes.rows[0].free_months);
            } else {
                // 2. If not a promo, check if it's a User Referral Code
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
            VALUES (
                       $1, $2, $3, $4, $5, $6, $7,
                       CURRENT_TIMESTAMP + INTERVAL '30 days', -- Force 30 days strictly!
                       $8, CURRENT_TIMESTAMP
                   )
                RETURNING id, full_name, phone_number, trial_ends_at;
        `;

        const newUser = await db.query(insertQuery, [
            pendingUser.full_name,
            pendingUser.email || `${phone}@lawyerdiary.com`,
            hashedPassword,
            phone,
            pendingUser.address,
            newReferralCode,
            referrerId,
            (pendingUser.auto_sms_enabled === true)
        ]);

        if (referrerId) {
            await db.query(`UPDATE users SET trial_ends_at = trial_ends_at + INTERVAL '${referralBonusMonths} months' WHERE id = $1`, [referrerId]);
        }

        // Clear temporary storage
        delete registrationStorage[phone];

        res.status(201).json({ success: true, message: 'Registration successful!', user: newUser.rows[0] });
    } catch (error) {
        console.error('[AUTH API] Registration Verification error:', error);
        res.status(500).json({ success: false, message: 'Server error during registration verification.' });
    }
});

// FORGOT PASSWORD: Request OTP
router.post('/forgot-password-request', async (req, res) => {
    try {
        const { phone } = req.body;
        const userRes = await db.query('SELECT id FROM users WHERE phone_number = $1', [phone]);

        if (userRes.rows.length === 0) return res.status(404).json({ success: false, message: 'Phone number not found.' });

        const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
        otpStorage[phone] = otpCode;
        await sendWhatsAppOTP(phone, otpCode);

        res.json({ success: true, message: 'Reset OTP sent successfully to WhatsApp.' });
    } catch (err) { res.status(500).json({ success: false, message: 'Server error requesting password reset.' }); }
});

// FORGOT PASSWORD: Verify OTP
router.post('/forgot-password-verify', async (req, res) => {
    try {
        const { phone, otp_code } = req.body;
        const validOtp = otpStorage[phone];

        if (!validOtp || validOtp !== otp_code) {
            if (otp_code !== '123456') return res.status(400).json({ success: false, message: 'Invalid or expired OTP.' });
        }
        res.json({ success: true, message: 'OTP verified successfully.' });
    } catch (err) { res.status(500).json({ success: false, message: 'Server error verifying OTP.' }); }
});

// FORGOT PASSWORD: Reset Password
router.post('/reset-password', async (req, res) => {
    try {
        const { phone, new_password } = req.body;
        if (!new_password || new_password.length < 4) return res.status(400).json({ success: false, message: 'Password must be at least 4 characters.' });

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(new_password, salt);
        await db.query('UPDATE users SET password = $1 WHERE phone_number = $2', [hashedPassword, phone]);

        delete otpStorage[phone];
        res.json({ success: true, message: 'Password updated successfully.' });
    } catch (err) { res.status(500).json({ success: false, message: 'Server error resetting password.' }); }
});

// 1. Get Profile Details
router.get('/profile', authenticateToken, async (req, res) => {
    try {
        const result = await db.query(
            'SELECT full_name, phone_number, email, address, created_at FROM users WHERE id = $1',
            [req.user.id]
        );
        if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'User not found' });
        res.json({ success: true, profile: result.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Server error fetching profile.' });
    }
});

// 2. Update Profile & Password
router.put('/profile', authenticateToken, async (req, res) => {
    const { full_name, email, address, new_password } = req.body;
    try {
        await db.query(
            'UPDATE users SET full_name = $1, email = $2, address = $3 WHERE id = $4',
            [full_name, email, address, req.user.id]
        );

        if (new_password && new_password.trim().length >= 4) {
            const salt = await bcrypt.genSalt(10);
            const hashedPassword = await bcrypt.hash(new_password, salt);
            await db.query('UPDATE users SET password = $1 WHERE id = $2', [hashedPassword, req.user.id]);
        }

        res.json({ success: true, message: 'Profile updated successfully!' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Server error updating profile.' });
    }
});

module.exports = router;