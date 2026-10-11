// src/controllers/authController.js
const db = require('../config/db');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

// Helper to format phone to clean international digits
const cleanPhone = (phone) => {
    let cleaned = phone.replace(/[^0-9]/g, '');
    if (cleaned.startsWith('0')) cleaned = '88' + cleaned;
    return cleaned;
};

// Helper: Call Meta API to send OTP
const sendWhatsAppOTP = async (phone, otpCode) => {
    const token = process.env.WHATSAPP_TOKEN;
    const phoneId = process.env.WHATSAPP_PHONE_ID;

    const url = `https://graph.facebook.com/v25.0/${phoneId}/messages`;

    // NOTE: In production, you must use a pre-approved 'AUTHENTICATION' template.
    // For your testing sandbox, we use a standard text message.
    const payload = {
        messaging_product: 'whatsapp',
        to: phone,
        type: 'text',
        text: { body: `Your Lawyer Diary verification code is: ${otpCode}. It expires in 5 minutes.` }
    };

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
    });

    if (!response.ok) {
        const errorData = await response.json();
        console.error('\n[META API ERROR]:', errorData);
        return false;
    }
    return true;
};

// Step 1: Request OTP
exports.requestOtp = async (req, res) => {
    try {
        const { phone } = req.body;
        if (!phone) return res.status(400).json({ success: false, message: 'Phone number is required.' });

        const cleanNumber = cleanPhone(phone);

        // Generate a 6-digit OTP
        const otpCode = Math.floor(100000 + Math.random() * 900000).toString();

        // Expiration time: 5 minutes from now
        const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

        // Save to DB
        await db.query(
            `INSERT INTO otp_verifications (phone, otp_code, expires_at) VALUES ($1, $2, $3)`,
            [cleanNumber, otpCode, expiresAt]
        );

        // Send via WhatsApp
        const sent = await sendWhatsAppOTP(cleanNumber, otpCode);
        if (!sent) {
            return res.status(500).json({ success: false, message: 'Failed to dispatch WhatsApp message.' });
        }

        res.status(200).json({ success: true, message: 'OTP sent successfully via WhatsApp.' });
    } catch (error) {
        console.error('Error requesting OTP:', error);
        res.status(500).json({ success: false, message: 'Server error during OTP generation.' });
    }
};

// Step 2: Verify OTP & Login/Register
exports.verifyOtp = async (req, res) => {
    try {
        const { phone, otp_code, name } = req.body;
        const cleanNumber = cleanPhone(phone);

        // Check if OTP is valid and not expired
        const otpResult = await db.query(
            `SELECT * FROM otp_verifications 
             WHERE phone = $1 AND otp_code = $2 AND expires_at > CURRENT_TIMESTAMP 
             ORDER BY created_at DESC LIMIT 1`,
            [cleanNumber, otp_code]
        );

        if (otpResult.rows.length === 0) {
            return res.status(400).json({ success: false, message: 'Invalid or expired OTP.' });
        }

        // OTP is valid. Check if user exists using phone_number.
        let userResult = await db.query(`SELECT * FROM users WHERE phone_number = $1`, [cleanNumber]);
        let user;

        if (userResult.rows.length === 0) {
            // New user: Register them
            const newUserName = name || 'New Lawyer';
            const insertResult = await db.query(
                `INSERT INTO users (full_name, phone_number) VALUES ($1, $2) RETURNING *`,
                [newUserName, cleanNumber]
            );
            user = insertResult.rows[0];
        } else {
            // Existing user: Log them in
            user = userResult.rows[0];
        }

        // Delete used OTPs for this phone to prevent reuse
        await db.query(`DELETE FROM otp_verifications WHERE phone = $1`, [cleanNumber]);

        // Generate a JWT Token for session management
        const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, { expiresIn: '7d' });

        res.status(200).json({
            success: true,
            message: 'Authentication successful.',
            user: user,
            token: token
        });
    } catch (error) {
        console.error('Error verifying OTP:', error);
        res.status(500).json({ success: false, message: 'Server error during OTP verification.' });
    }
};