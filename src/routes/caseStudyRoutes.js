const express = require('express');
const router = express.Router();
const db = require('../config/db');
const authenticateToken = require('../middleware/authenticateToken');
const { GoogleGenAI } = require('@google/genai');

// 1. COLLECT ACTIVE KEYS FROM THE 30-KEY POOL
const GEMINI_KEYS = [
    process.env.GEMINI_KEY_1, process.env.GEMINI_KEY_2, process.env.GEMINI_KEY_3,
    process.env.GEMINI_KEY_4, process.env.GEMINI_KEY_5, process.env.GEMINI_KEY_6,
    process.env.GEMINI_KEY_7, process.env.GEMINI_KEY_8, process.env.GEMINI_KEY_9,
    process.env.GEMINI_KEY_10, process.env.GEMINI_KEY_11, process.env.GEMINI_KEY_12,
    process.env.GEMINI_KEY_13, process.env.GEMINI_KEY_14, process.env.GEMINI_KEY_15,
    process.env.GEMINI_KEY_16, process.env.GEMINI_KEY_17, process.env.GEMINI_KEY_18,
    process.env.GEMINI_KEY_19, process.env.GEMINI_KEY_20, process.env.GEMINI_KEY_21,
    process.env.GEMINI_KEY_22, process.env.GEMINI_KEY_23, process.env.GEMINI_KEY_24,
    process.env.GEMINI_KEY_25, process.env.GEMINI_KEY_26, process.env.GEMINI_KEY_27,
    process.env.GEMINI_KEY_28, process.env.GEMINI_KEY_29, process.env.GEMINI_KEY_30
].filter(Boolean); // .filter(Boolean) prevents crashes if you only add 15 or 20 keys for now.

let currentKeyIndex = 0;

function getNextApiKey() {
    if (GEMINI_KEYS.length === 0) {
        throw new Error('No valid GEMINI_KEY entries found in environment variables.');
    }
    const key = GEMINI_KEYS[currentKeyIndex];
    currentKeyIndex = (currentKeyIndex + 1) % GEMINI_KEYS.length;
    return key;
}

// 2. RESILIENT GENERATION ENGINE WITH FAILOVER
async function generateWithFailover(contents, model = 'gemini-3.8-flash') {
    const totalKeys = GEMINI_KEYS.length;
    let lastError = null;

    for (let attempt = 0; attempt < totalKeys; attempt++) {
        const apiKey = getNextApiKey();
        const ai = new GoogleGenAI({ apiKey });

        try {
            const result = await ai.models.generateContent({
                model: model,
                contents: contents
            });
            return result;
        } catch (error) {
            lastError = error;
            if (error.status === 429 || error.status === 503) {
                console.warn(`[AI ROTATOR] Key slot hit HTTP ${error.status}. Automatically failing over to next key...`);
                continue;
            }
            throw error;
        }
    }
    throw lastError;
}

// 3. ENSURE USAGE TRACKING TABLE SUPPORTS YOUR INTEGER IDs
(async () => {
    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS ai_usage_logs (
                                                         id SERIAL PRIMARY KEY,
                                                         user_id VARCHAR(255),
                used_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                charged_amount NUMERIC(10,2) DEFAULT 0.00
                );
        `);
        await db.query(`ALTER TABLE ai_usage_logs ALTER COLUMN user_id TYPE VARCHAR(255);`);
    } catch (e) {
        console.warn('AI usage table check:', e.message);
    }
})();

// GET: Usage quota status for the current month
router.get('/quota', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized session.' });

        const countRes = await db.query(`
            SELECT COUNT(*)::int AS used_count
            FROM ai_usage_logs
            WHERE user_id = $1
              AND date_trunc('month', used_at) = date_trunc('month', CURRENT_TIMESTAMP);
        `, [userId]);

        const usedCount = countRes.rows[0].used_count || 0;
        const freeRemaining = Math.max(0, 10 - usedCount);

        const userRes = await db.query('SELECT wallet_balance FROM users WHERE id = $1', [userId]);
        const balance = userRes.rows[0]?.wallet_balance || 0;

        res.json({
            success: true,
            used_this_month: usedCount,
            free_remaining: freeRemaining,
            is_free: freeRemaining > 0,
            wallet_balance: balance
        });
    } catch (err) {
        console.error("Quota Check DB Error:", err);
        res.status(500).json({ success: false, message: 'Database error checking quota' });
    }
});

// POST: Analyze legal document photos
router.post('/analyze', authenticateToken, async (req, res) => {
    const userId = req.user.id;
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized session.' });

    const { images, language } = req.body;

    if (!images || images.length === 0) {
        return res.status(400).json({ success: false, message: 'Please provide at least one image.' });
    }

    try {
        const countRes = await db.query(`
            SELECT COUNT(*)::int AS used_count
            FROM ai_usage_logs
            WHERE user_id = $1
              AND date_trunc('month', used_at) = date_trunc('month', CURRENT_TIMESTAMP);
        `, [userId]);

        const usedCount = countRes.rows[0].used_count || 0;
        let chargedAmount = 0.00;

        if (usedCount >= 10) {
            const balRes = await db.query('SELECT wallet_balance FROM users WHERE id = $1', [userId]);
            const currentBal = Number(balRes.rows[0]?.wallet_balance || 0);

            if (currentBal < 1.00) {
                return res.status(402).json({
                    success: false,
                    message: 'Monthly 10 free AI analyses reached. Please top up your wallet (minimum ৳1 balance required).'
                });
            }
            await db.query('UPDATE users SET wallet_balance = wallet_balance - 1.00 WHERE id = $1', [userId]);
            chargedAmount = 1.00;
        }

        const promptLang = language === 'en' ? 'English' : 'Bengali (বাংলা)';
        const legalPrompt = `
You are a senior legal research assistant in Bangladesh analyzing legal documents (FIR, Charge Sheet, Court Order, Bail Petition, Seizure List, etc.).
Review the provided document image(s) thoroughly and formulate your response strictly in ${promptLang}.

CRITICAL FORMATTING RULES:
1. Deliver your response PARAGRAPH BY PARAGRAPH with double line breaks between them.
2. Use clear, UPPERCASE HEADINGS for each section (e.g., DOCUMENT CLASSIFICATION, CORE SUMMARY).
3. DO NOT use markdown asterisks (**) or hashes (#). Use clean, plain text formatting suitable for legal documentation.

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

        // Execute request through the failover engine
        const result = await generateWithFailover(contents, 'gemini-3.8-flash');

        await db.query(
            'INSERT INTO ai_usage_logs (user_id, charged_amount) VALUES ($1, $2)',
            [userId, chargedAmount]
        );

        res.json({
            success: true,
            analysis: result.text,
            charged: chargedAmount > 0
        });

    } catch (err) {
        console.error('[AI CASE STUDY ERROR]', err);
        // NEW ERROR MESSAGE AS REQUESTED
        if (err.status === 429 || err.status === 503) {
            res.status(err.status).json({ success: false, message: 'The server is overloaded, Please try again after 1 minute' });
        } else {
            res.status(500).json({ success: false, message: 'AI processing failed. Please check image clarity and try again.' });
        }
    }
});

// POST: Follow-up case chat & voice notes
router.post('/chat', authenticateToken, async (req, res) => {
    const userId = req.user.id;
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized session.' });

    const { language, previousAnalysis, chatMessages, newMessage, newAudio } = req.body;

    if (!newMessage && (!newAudio || newAudio.length === 0)) {
        return res.status(400).json({ success: false, message: 'Please provide a message or voice recording.' });
    }

    try {
        const promptLang = language === 'en' ? 'English' : 'Bengali (বাংলা)';
        const contents = [];

        // 1. Rehydrate context
        let contextText = `You are a senior legal assistant in Bangladesh. Respond strictly in ${promptLang}.\n`;
        if (previousAnalysis && !previousAnalysis.includes('GENERAL CASE DISCUSSION')) {
            contextText += `\nHere is the document summary generated earlier:\n${previousAnalysis}`;
        }
        contents.push({ role: 'user', parts: [{ text: contextText }] });

        // 2. Retain recent conversational context
        if (chatMessages && Array.isArray(chatMessages)) {
            const recentChats = chatMessages.slice(-2);
            for (const msg of recentChats) {
                if (msg.text && !msg.text.includes('🎤')) {
                    contents.push({
                        role: msg.role === 'model' ? 'model' : 'user',
                        parts: [{ text: msg.text }]
                    });
                }
            }
        }

        // 3. Attach new text or voice data
        const newParts = [];
        if (newMessage) {
            newParts.push({ text: newMessage });
        }

        if (newAudio && newAudio.length > 0) {
            const parts = newAudio.split(';base64,');
            if (parts.length === 2) {
                const cleanMimeType = parts[0].replace('data:', '').split(';')[0];
                newParts.push({
                    inlineData: {
                        mimeType: cleanMimeType,
                        data: parts[1]
                    }
                });
                if (!newMessage) {
                    newParts.push({ text: 'Please analyze this voice inquiry from the advocate and advise accordingly.' });
                }
            }
        }

        contents.push({ role: 'user', parts: newParts });

        // 4. Execute chat request through key failover pool
        const result = await generateWithFailover(contents, 'gemini-3.8-flash');

        res.json({ success: true, reply: result.text });

    } catch (err) {
        console.error('[AI CHAT ERROR]', err);
        // NEW ERROR MESSAGE AS REQUESTED
        if (err.status === 429 || err.status === 503) {
            res.status(err.status).json({ success: false, message: 'The server is overloaded, Please try again after 1 minute' });
        } else {
            res.status(500).json({ success: false, message: 'Chat execution failed. Please try again.' });
        }
    }
});

module.exports = router;