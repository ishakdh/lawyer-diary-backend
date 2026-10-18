const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const db = require('../config/db');
const { GoogleGenAI } = require('@google/genai');

let authenticateToken;
try {
    authenticateToken = require('../middleware/authenticateToken');
} catch (e) {
    authenticateToken = require('../middleware/auth');
}

// 1. COLLECT & SANITIZE ACTIVE KEYS FROM THE 30-KEY POOL
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
    process.env.GEMINI_KEY_28, process.env.GEMINI_KEY_29, process.env.GEMINI_KEY_30,
    process.env.GEMINI_API_KEY
]
    .filter(Boolean)
    .map(k => k.trim().replace(/^["']|["']$/g, ''))
    .filter(k => k.length > 10);

let currentKeyIndex = 0;
function getNextApiKey() {
    if (GEMINI_KEYS.length === 0) {
        throw new Error('No valid GEMINI_KEY entries found in environment variables.');
    }
    const key = GEMINI_KEYS[currentKeyIndex];
    currentKeyIndex = (currentKeyIndex + 1) % GEMINI_KEYS.length;
    return key;
}

const analysisCache = new Map();
const MAX_CACHE_SIZE = 200;

function getCacheKey(payload) {
    return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function saveToCache(key, value) {
    if (analysisCache.size >= MAX_CACHE_SIZE) {
        const firstKey = analysisCache.keys().next().value;
        analysisCache.delete(firstKey);
    }
    analysisCache.set(key, value);
}

// 2. ULTRA-FAST FAILOVER ENGINE (Using Updated Gemini 3 Models)
const FREE_MODELS = ['gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-3.6-flash'];

async function generateWithFailover(contents, preferredModel = 'gemini-3.8-flash') {
    const totalKeys = GEMINI_KEYS.length;
    if (totalKeys === 0) throw new Error('No Gemini API keys configured on server.');

    const modelPool = [preferredModel, ...FREE_MODELS.filter(m => m !== preferredModel)];
    let lastError = null;

    for (const modelName of modelPool) {
        for (let attempt = 0; attempt < Math.min(totalKeys, 6); attempt++) {
            const apiKey = getNextApiKey();
            if (!apiKey) continue;
            const ai = new GoogleGenAI({ apiKey });

            try {
                const result = await Promise.race([
                    ai.models.generateContent({
                        model: modelName,
                        contents: contents
                    }),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('AI_TIMEOUT')), 20000))
                ]);

                const outputText = result?.text || result?.candidates?.[0]?.content?.parts?.[0]?.text;
                if (outputText && outputText.trim().length > 0) {
                    return { text: outputText.trim() };
                }
            } catch (error) {
                lastError = error;
                console.warn(`[AI ROTATOR] Key failed on ${modelName} (${error.message}). Switching...`);
                continue;
            }
        }
    }
    throw lastError || new Error('All AI keys are busy or failed.');
}

// 3. DATABASE SETUP
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
    } catch (e) {}
})();

// GET: Fetch Quota and Wallet Balance for the Current Calendar Month
router.get('/quota', authenticateToken, async (req, res) => {
    const userId = req.user?.id;
    try {
        // 1. Calculate how many cases were analyzed THIS month
        const usageQuery = await db.query(`
            SELECT COUNT(*) as total_used 
            FROM ai_usage_logs 
            WHERE user_id = $1 
            AND EXTRACT(MONTH FROM used_at) = EXTRACT(MONTH FROM CURRENT_DATE)
            AND EXTRACT(YEAR FROM used_at) = EXTRACT(YEAR FROM CURRENT_DATE)
        `, [String(userId)]);

        const usedThisMonth = parseInt(usageQuery.rows[0].total_used) || 0;
        const freeRemaining = Math.max(0, 20 - usedThisMonth);

        // 2. Fetch current wallet balance
        const walletQuery = await db.query('SELECT balance FROM wallets WHERE user_id = $1', [userId]);
        const walletBalance = walletQuery.rows.length > 0 ? parseFloat(walletQuery.rows[0].balance) : 0.00;

        res.json({
            success: true,
            used_this_month: usedThisMonth,
            free_remaining: freeRemaining,
            wallet_balance: walletBalance
        });
    } catch (err) {
        console.error('Quota Check Error:', err);
        res.status(500).json({ success: false, message: 'Failed to fetch quota' });
    }
});

// POST: Analyze Document Images (Checks 20-limit and charges 1 TK if exceeded)
router.post('/analyze', authenticateToken, async (req, res) => {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized session.' });

    const { images, language } = req.body;
    if (!images || !Array.isArray(images) || images.length === 0) {
        return res.status(400).json({ success: false, message: 'Please provide at least one document image.' });
    }

    const promptLang = language === 'en' ? 'English' : 'Bengali (বাংলা)';
    const cacheKey = getCacheKey({ images, promptLang });
    if (analysisCache.has(cacheKey)) {
        return res.json({ success: true, analysis: analysisCache.get(cacheKey), charged: false });
    }

    // --- QUOTA & WALLET VERIFICATION ---
    const usageQuery = await db.query(`
        SELECT COUNT(*) as total_used FROM ai_usage_logs 
        WHERE user_id = $1 
        AND EXTRACT(MONTH FROM used_at) = EXTRACT(MONTH FROM CURRENT_DATE)
        AND EXTRACT(YEAR FROM used_at) = EXTRACT(YEAR FROM CURRENT_DATE)
    `, [String(userId)]);

    const usedThisMonth = parseInt(usageQuery.rows[0].total_used) || 0;
    const isFree = usedThisMonth < 20;

    if (!isFree) {
        const walletQuery = await db.query('SELECT balance FROM wallets WHERE user_id = $1', [userId]);
        const balance = walletQuery.rows.length > 0 ? parseFloat(walletQuery.rows[0].balance) : 0;
        if (balance < 1.00) {
            return res.status(402).json({ success: false, message: 'Free quota (20 scans) exceeded. Please top-up your wallet (1 TK required).' });
        }
    }

    const legalPrompt = `You are a senior legal research assistant in Bangladesh analyzing legal documents. Include specific legal Section names and numbers.
Review the provided document image(s) thoroughly and formulate your response strictly in ${promptLang}.
CRITICAL FORMATTING RULES:
1. Deliver your response PARAGRAPH BY PARAGRAPH with double line breaks between them.
2. Use clear, UPPERCASE HEADINGS. DO NOT use markdown asterisks (**) or hashes (#).
Format your analysis covering:
- DOCUMENT CLASSIFICATION
- CORE SUMMARY
- RELEVANT LEGAL SECTIONS & ACTS
- STRONG POINTS
- WEAK POINTS & VULNERABILITIES
- MISSING OR REQUIRED NEXT DOCUMENTS`;

    const imageParts = images.filter(img => img && img.base64).map(img => {
        const base64Data = img.base64.includes(',') ? img.base64.split(',')[1] : img.base64;
        return { inlineData: { data: base64Data, mimeType: img.mimeType || 'image/jpeg' } };
    });

    const contents = [{ role: 'user', parts: [{ text: legalPrompt }, ...imageParts] }];
    const result = await generateWithFailover(contents, 'gemini-3.8-flash');
    saveToCache(cacheKey, result.text);

    // --- CHARGE WALLET & LOG USAGE (Only if successful) ---
    let charged = false;
    let chargeAmount = 0.00;

    if (!isFree) {
        await db.query('UPDATE wallets SET balance = balance - 1.00 WHERE user_id = $1', [userId]);
        chargeAmount = 1.00;
        charged = true;
    }
    await db.query('INSERT INTO ai_usage_logs (user_id, charged_amount) VALUES ($1, $2)', [String(userId), chargeAmount]).catch(console.error);

    return res.json({ success: true, analysis: result.text, charged });
});

// POST: Follow-up Chat & Voice (Charges 1 TK ONLY if it's a brand new discussion without a document)
router.post('/chat', authenticateToken, async (req, res) => {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized session.' });

    const { language, previousAnalysis, chatMessages, newMessage, newAudio } = req.body;
    if (!newMessage && (!newAudio || newAudio.length === 0)) {
        return res.status(400).json({ success: false, message: 'Please provide a message or voice recording.' });
    }

    // Check if this is a brand new case discussion (no document scanned first)
    const isNewDiscussion = !previousAnalysis || previousAnalysis.trim() === '';
    let isFree = true;

    // --- QUOTA & WALLET VERIFICATION (Only charge for new discussions, follow-ups are free) ---
    if (isNewDiscussion) {
        const usageQuery = await db.query(`
            SELECT COUNT(*) as total_used FROM ai_usage_logs 
            WHERE user_id = $1 
            AND EXTRACT(MONTH FROM used_at) = EXTRACT(MONTH FROM CURRENT_DATE)
            AND EXTRACT(YEAR FROM used_at) = EXTRACT(YEAR FROM CURRENT_DATE)
        `, [String(userId)]);

        const usedThisMonth = parseInt(usageQuery.rows[0].total_used) || 0;
        isFree = usedThisMonth < 20;

        if (!isFree) {
            const walletQuery = await db.query('SELECT balance FROM wallets WHERE user_id = $1', [userId]);
            const balance = walletQuery.rows.length > 0 ? parseFloat(walletQuery.rows[0].balance) : 0;
            if (balance < 1.00) {
                return res.status(402).json({ success: false, message: 'Free quota (20 cases) exceeded. Please top-up your wallet (1 TK required).' });
            }
        }
    }

    const promptLang = language === 'en' ? 'English' : 'Bengali (বাংলা)';
    let combinedPrompt = `You are a senior legal assistant in Bangladesh. Respond strictly in ${promptLang}. Do not use markdown asterisks (**) or hashes (#). Keep answers clear, direct, and practical for an advocate.\n`;

    if (!isNewDiscussion) combinedPrompt += `\n--- CASE SUMMARY ---\n${previousAnalysis}\n--------------------\n`;

    if (chatMessages && Array.isArray(chatMessages)) {
        for (const msg of chatMessages.slice(-4)) {
            if (msg?.text && !msg.text.includes('🎤')) combinedPrompt += `${msg.role === 'model' ? 'Assistant' : 'Advocate'}: ${msg.text}\n`;
        }
    }

    const userParts = [{ text: combinedPrompt }];
    if (newMessage && newMessage.trim()) userParts.push({ text: `\nAdvocate's Question: ${newMessage.trim()}` });

    if (newAudio && newAudio.length > 0) {
        const parts = newAudio.split(';base64,');
        if (parts.length === 2) {
            userParts.push({ inlineData: { mimeType: parts[0].replace('data:', '').split(';')[0] || 'audio/mp4', data: parts[1] } });
            if (!newMessage) userParts.push({ text: '\nPlease listen to this voice inquiry and provide legal advice.' });
        }
    }

    const contents = [{ role: 'user', parts: userParts }];
    const result = await generateWithFailover(contents, 'gemini-3.5-flash-lite');

    // --- CHARGE WALLET & LOG USAGE (Only if successful new discussion) ---
    let charged = false;
    if (isNewDiscussion) {
        let chargeAmount = 0.00;
        if (!isFree) {
            await db.query('UPDATE wallets SET balance = balance - 1.00 WHERE user_id = $1', [userId]);
            chargeAmount = 1.00;
            charged = true;
        }
        await db.query('INSERT INTO ai_usage_logs (user_id, charged_amount) VALUES ($1, $2)', [String(userId), chargeAmount]).catch(console.error);
    }

    return res.json({ success: true, reply: result.text, charged });
});

module.exports = router;