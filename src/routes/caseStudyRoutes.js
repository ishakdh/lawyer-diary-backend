const express = require('express');
const router = express.Router();
const db = require('../config/db');
const authenticateToken = require('../middleware/authenticateToken');

// 1. IMPORT THE NEW SDK
const { GoogleGenAI } = require('@google/genai');

// 2. INITIALIZE WITH YOUR API KEY (Let the SDK handle the API version)
const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY
});

// Ensure usage tracking table exists
(async () => {
    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS ai_usage_logs (
                                                         id SERIAL PRIMARY KEY,
                                                         user_id UUID,
                                                         used_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                                                         charged_amount NUMERIC(10,2) DEFAULT 0.00
                );
        `);
    } catch (e) {
        console.warn('AI usage table check:', e.message);
    }
})();

// GET usage quota status for the current month
router.get('/quota', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const countRes = await db.query(`
            SELECT COUNT(*)::int AS used_count
            FROM ai_usage_logs
            WHERE user_id = $1::uuid
              AND date_trunc('month', used_at) = date_trunc('month', CURRENT_TIMESTAMP);
        `, [userId]);

        const usedCount = countRes.rows[0].used_count || 0;
        const freeRemaining = Math.max(0, 10 - usedCount);

        const userRes = await db.query('SELECT wallet_balance FROM users WHERE id = $1::uuid', [userId]);
        const balance = userRes.rows[0]?.wallet_balance || 0;

        res.json({
            success: true,
            used_this_month: usedCount,
            free_remaining: freeRemaining,
            is_free: freeRemaining > 0,
            wallet_balance: balance
        });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// POST analyze document photos
router.post('/analyze', authenticateToken, async (req, res) => {
    const userId = req.user.id;
    const { images, language } = req.body;

    if (!images || images.length === 0) {
        return res.status(400).json({ success: false, message: 'Please provide at least one image.' });
    }

    try {
        const countRes = await db.query(`
            SELECT COUNT(*)::int AS used_count
            FROM ai_usage_logs
            WHERE user_id = $1::uuid
              AND date_trunc('month', used_at) = date_trunc('month', CURRENT_TIMESTAMP);
        `, [userId]);

        const usedCount = countRes.rows[0].used_count || 0;
        let chargedAmount = 0.00;

        if (usedCount >= 10) {
            const balRes = await db.query('SELECT wallet_balance FROM users WHERE id = $1::uuid', [userId]);
            const currentBal = Number(balRes.rows[0]?.wallet_balance || 0);

            if (currentBal < 1.00) {
                return res.status(402).json({
                    success: false,
                    message: 'Monthly 10 free AI analyses reached. Please top up your wallet (minimum ৳1 balance required).'
                });
            }
            await db.query('UPDATE users SET wallet_balance = wallet_balance - 1.00 WHERE id = $1::uuid', [userId]);
            chargedAmount = 1.00;
        }

        const promptLang = language === 'en' ? 'English' : 'Bengali (বাংলা)';
        const legalPrompt = `
You are a senior legal research assistant in Bangladesh analyzing legal documents (FIR, Charge Sheet, Court Order, Bail Petition, Seizure List, etc.).
Review the provided document image(s) thoroughly and formulate your response strictly in ${promptLang}.

CRITICAL FORMATTING RULES:
1. Deliver your response PARAGRAPH BY PARAGRAPH with double line breaks between them.
2. Use clear, UPPERCASE HEADINGS for each section (e.g., DOCUMENT CLASSIFICATION, CORE SUMMARY).
3. DO NOT use markdown asterisks (**) or hashes (#). Use clean, plain text formatting that looks highly professional, lucrative, and easy to read on a mobile device.

Format your analysis covering:
- DOCUMENT CLASSIFICATION
- CORE SUMMARY
- STRONG POINTS
- WEAK POINTS & VULNERABILITIES
- MISSING OR REQUIRED NEXT DOCUMENTS

Keep the language professional, practical, and tailored for advocate chambers in Bangladesh.
`;

        const imageParts = images.map(img => ({
            inlineData: {
                data: img.base64.replace(/^data:image\/[a-z]+;base64,/, ''),
                mimeType: img.mimeType || 'image/jpeg'
            }
        }));

        const contents = [
            { role: 'user', parts: [{ text: legalPrompt }, ...imageParts] }
        ];

        let result;
        let maxRetries = 2;
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                // CHANGED TO gemini-1.5-flash
                result = await ai.models.generateContent({
                    model: 'gemini-3.8-flash',
                    contents: contents
                });
                break;
            } catch (error) {
                if (error.status === 503 && attempt < maxRetries) {
                    const waitTime = (attempt + 1) * 2000;
                    console.log(`[AI 503 OVERLOAD] Google server busy. Retrying in ${waitTime/1000}s...`);
                    await new Promise(resolve => setTimeout(resolve, waitTime));
                } else {
                    throw error;
                }
            }
        }

        await db.query(
            'INSERT INTO ai_usage_logs (user_id, charged_amount) VALUES ($1::uuid, $2)',
            [userId, chargedAmount]
        );

        res.json({
            success: true,
            analysis: result.text,
            charged: chargedAmount > 0
        });
    } catch (err) {
        console.error('[AI CASE STUDY ERROR]', err);
        if (err.status === 503) {
            res.status(503).json({ success: false, message: 'Google AI servers are currently overloaded. Please try again in a few minutes.' });
        } else {
            res.status(500).json({ success: false, message: 'AI processing failed. Check API key and image clarity.' });
        }
    }
});

// POST follow-up chat
router.post('/chat', authenticateToken, async (req, res) => {
    const { images, language, previousAnalysis, chatMessages, newMessage, newAudio } = req.body;

    // ALLOW chat even if there are no images, as long as there is text/audio
    if ((!images || images.length === 0) && !newMessage && !newAudio) {
        return res.status(400).json({ success: false, message: 'Invalid request data. Please provide text or audio.' });
    }

    try {
        const promptLang = language === 'en' ? 'English' : 'Bengali (বাংলা)';
        const legalPrompt = `
You are a senior legal research assistant in Bangladesh.
Formulate your response strictly in ${promptLang}.

CRITICAL FORMATTING RULES:
1. Deliver your response PARAGRAPH BY PARAGRAPH with double line breaks between them.
2. Use clear, UPPERCASE HEADINGS if sections are needed.
3. DO NOT use markdown asterisks (**) or hashes (#). Keep the text clean, lucrative, and easy to read on a mobile screen.
`;

        const contents = [];
        const initialParts = [{ text: legalPrompt }];

        // Only attach images if they exist
        if (images && images.length > 0) {
            const imageParts = images.map(img => ({
                inlineData: {
                    data: img.base64.replace(/^data:image\/[a-z]+;base64,/, ''),
                    mimeType: img.mimeType || 'image/jpeg'
                }
            }));
            initialParts.push(...imageParts);
        }

        contents.push({ role: 'user', parts: initialParts });

        // Push previous analysis only if it's a real document analysis
        if (previousAnalysis && !previousAnalysis.includes("GENERAL CASE DISCUSSION")) {
            contents.push({ role: 'model', parts: [{ text: previousAnalysis }] });
        }

        if (chatMessages && Array.isArray(chatMessages)) {
            for (const msg of chatMessages) {
                if (msg.text !== '🎤 Voice Message sent') {
                    contents.push({ role: msg.role === 'model' ? 'model' : 'user', parts: [{ text: msg.text }] });
                }
            }
        }

        const newParts = [];

        if (newMessage) {
            newParts.push({ text: newMessage });
        }

        if (newAudio && newAudio.length > 0) {
            const parts = newAudio.split(';base64,');
            if (parts.length === 2) {
                const rawMimeType = parts[0].replace('data:', '');
                const cleanMimeType = rawMimeType.split(';')[0];
                const base64Data = parts[1];

                newParts.push({
                    inlineData: {
                        mimeType: cleanMimeType,
                        data: base64Data
                    }
                });

                if (!newMessage) {
                    newParts.push({ text: `Please listen to this voice message from the lawyer and provide legal advice in ${promptLang} based on the context.` });
                }
            }
        }

        contents.push({ role: 'user', parts: newParts });

        let result;
        let maxRetries = 2;
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                result = await ai.models.generateContent({
                    model: 'gemini-3.8-flash',
                    contents: contents
                });
                break;
            } catch (error) {
                if (error.status === 503 && attempt < maxRetries) {
                    const waitTime = (attempt + 1) * 2000;
                    console.log(`[AI CHAT 503 OVERLOAD] Google server busy. Retrying in ${waitTime/1000}s...`);
                    await new Promise(resolve => setTimeout(resolve, waitTime));
                } else {
                    throw error;
                }
            }
        }

        res.json({ success: true, reply: result.text });

    } catch (err) {
        console.error('[AI CHAT ERROR]', err);
        if (err.status === 503) {
            res.status(503).json({ success: false, message: 'Google AI servers are currently overloaded. Please try again in a few minutes.' });
        } else {
            res.status(500).json({ success: false, message: 'Chat failed. Check backend logs.' });
        }
    }
});

module.exports = router;