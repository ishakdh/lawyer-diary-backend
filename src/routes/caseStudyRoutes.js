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

// 1. COLLECT & SANITIZE ACTIVE KEYS
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
].filter(Boolean).map(k => k.trim().replace(/^["']|["']$/g, '')).filter(k => k.length > 10);

let currentKeyIndex = 0;
function getNextApiKey() {
    if (GEMINI_KEYS.length === 0) throw new Error('No valid GEMINI_KEY entries found.');
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

// 2. ULTRA-FAST FAILOVER ENGINE
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
                    ai.models.generateContent({ model: modelName, contents: contents }),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('AI_TIMEOUT')), 20000))
                ]);

                const outputText = result?.text || result?.candidates?.[0]?.content?.parts?.[0]?.text;
                if (outputText && outputText.trim().length > 0) return { text: outputText.trim() };
            } catch (error) {
                lastError = error;
                console.warn(`[AI ROTATOR] Key failed on ${modelName}. Switching...`);
                continue;
            }
        }
    }
    throw lastError || new Error('All AI keys are busy or failed.');
}

// 3. SAFE DATABASE TABLE CREATOR
const ensureUsageTable = async () => {
    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS ai_usage_logs (
                id SERIAL PRIMARY KEY,
                user_id VARCHAR(255),
                used_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                charged_amount NUMERIC(10,2) DEFAULT 0.00
            );
        `);
    } catch (e) {
        console.error("Failed to ensure ai_usage_logs table:", e.message);
    }
};

// GET: Fetch Quota safely
router.get('/quota', authenticateToken, async (req, res) => {
    try {
        const userId = req.user?.id;
        await ensureUsageTable();

        const usageQuery = await db.query(`
            SELECT COUNT(*) as total_used FROM ai_usage_logs
            WHERE user_id = $1 AND EXTRACT(MONTH FROM used_at) = EXTRACT(MONTH FROM CURRENT_DATE)
            AND EXTRACT(YEAR FROM used_at) = EXTRACT(YEAR FROM CURRENT_DATE)
        `, [String(userId)]);

        const usedThisMonth = parseInt(usageQuery.rows[0].total_used) || 0;
        const freeRemaining = Math.max(0, 20 - usedThisMonth);

        let walletBalance = 0.00;
        try {
            const walletQuery = await db.query('SELECT wallet_balance FROM users WHERE id = $1', [userId]);
            if (walletQuery.rows.length > 0) walletBalance = parseFloat(walletQuery.rows[0].wallet_balance) || 0.00;
        } catch (wErr) {
            console.warn('Wallet fetch warning:', wErr.message);
        }

        res.json({ success: true, used_this_month: usedThisMonth, free_remaining: freeRemaining, wallet_balance: walletBalance });
    } catch (err) {
        console.error('Quota Route Crash Protected:', err.message);
        res.json({ success: true, used_this_month: 0, free_remaining: 20, wallet_balance: 0.00 }); // Safe fallback
    }
});

// POST: Analyze Document Images Safely
router.post('/analyze', authenticateToken, async (req, res) => {
    try {
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

        await ensureUsageTable();

        const usageQuery = await db.query(`
            SELECT COUNT(*) as total_used FROM ai_usage_logs
            WHERE user_id = $1 AND EXTRACT(MONTH FROM used_at) = EXTRACT(MONTH FROM CURRENT_DATE)
            AND EXTRACT(YEAR FROM used_at) = EXTRACT(YEAR FROM CURRENT_DATE)
        `, [String(userId)]);

        const usedThisMonth = parseInt(usageQuery.rows[0].total_used) || 0;
        const isFree = usedThisMonth < 20;

        if (!isFree) {
            const walletQuery = await db.query('SELECT wallet_balance FROM users WHERE id = $1', [userId]);
            const balance = walletQuery.rows.length > 0 ? parseFloat(walletQuery.rows[0].wallet_balance) : 0;
            if (balance < 1.00) return res.status(402).json({ success: false, message: 'Free quota (20 scans) exceeded. Please top-up your wallet (1 TK required).' });
        }

        const legalPrompt = `You are a senior legal research assistant in Bangladesh analyzing legal documents. Include specific legal Section names and numbers.
Review the provided document image(s) thoroughly and formulate your response strictly in ${promptLang}.
CRITICAL RULE: DO NOT use any greetings. DO NOT say "নমস্কার", "আসসালামু আলাইকুম", or "Hello". Start directly with the analysis.
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

        // This generates the text and will safely throw to the catch block if Gemini fails
        const result = await generateWithFailover(contents, 'gemini-3.8-flash');
        saveToCache(cacheKey, result.text);

        let charged = false;
        let chargeAmount = "0.00";

        if (!isFree) {
            await db.query('UPDATE users SET wallet_balance = wallet_balance - 1.00 WHERE id = $1', [userId]);
            chargeAmount = "1.00";
            charged = true;
            await db.query(
                `INSERT INTO wallet_transactions (user_id, amount, transaction_type, description) VALUES ($1, $2, 'AI_SCAN', 'Paid AI Case Study')`,
                [String(userId), -1.00]
            ).catch(e => console.warn("Wallet log skip"));
        }

        await db.query('INSERT INTO ai_usage_logs (user_id, charged_amount) VALUES ($1, $2::numeric)', [String(userId), chargeAmount]).catch(e => console.error("Usage log error"));

        return res.json({ success: true, analysis: result.text, charged });

    } catch (err) {
        console.error('Analyze Route Crash Protected:', err.message);
        return res.status(500).json({ success: false, message: 'AI Analysis failed or timed out. Please try again.' });
    }
});

// POST: Follow-up Chat & Voice Safely
router.post('/chat', authenticateToken, async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized session.' });

        const { language, previousAnalysis, chatMessages, newMessage, newAudio } = req.body;
        if (!newMessage && (!newAudio || newAudio.length === 0)) return res.status(400).json({ success: false, message: 'Please provide a message or voice recording.' });

        await ensureUsageTable();
        const isNewDiscussion = !previousAnalysis || previousAnalysis.trim() === '';
        let isFree = true;

        if (isNewDiscussion) {
            const usageQuery = await db.query(`SELECT COUNT(*) as total_used FROM ai_usage_logs WHERE user_id = $1 AND EXTRACT(MONTH FROM used_at) = EXTRACT(MONTH FROM CURRENT_DATE) AND EXTRACT(YEAR FROM used_at) = EXTRACT(YEAR FROM CURRENT_DATE)`, [String(userId)]);
            const usedThisMonth = parseInt(usageQuery.rows[0].total_used) || 0;
            isFree = usedThisMonth < 20;

            if (!isFree) {
                const walletQuery = await db.query('SELECT wallet_balance FROM users WHERE id = $1', [userId]);
                const balance = walletQuery.rows.length > 0 ? parseFloat(walletQuery.rows[0].wallet_balance) : 0;
                if (balance < 1.00) return res.status(402).json({ success: false, message: 'Free quota (20 cases) exceeded. Please top-up your wallet (1 TK required).' });
            }
        }

        const promptLang = language === 'en' ? 'English' : 'Bengali (বাংলা)';
        let combinedPrompt = `You are a senior legal assistant in Bangladesh. Respond strictly in ${promptLang}. 
CRITICAL RULE: Absolutely NO greetings. DO NOT say "নমস্কার", "আসসালামু আলাইকুম", "হ্যালো", or "Greetings". DO NOT address the user with polite phrases like "সিনিয়র আইনজীবী মহোদয়".
Start your response DIRECTLY with the legal advice or answer.
Keep answers clear, direct, including section of law, and practical for an advocate.
Do not use markdown asterisks (**) or hashes (#).\n`;

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

        const result = await generateWithFailover([{ role: 'user', parts: userParts }], 'gemini-3.5-flash-lite');

        let charged = false;
        if (isNewDiscussion) {
            let chargeAmount = "0.00";
            if (!isFree) {
                await db.query('UPDATE users SET wallet_balance = wallet_balance - 1.00 WHERE id = $1', [userId]);
                chargeAmount = "1.00";
                charged = true;
                await db.query(`INSERT INTO wallet_transactions (user_id, amount, transaction_type, description) VALUES ($1, $2, 'AI_CHAT', 'Paid AI Case Discussion')`, [String(userId), -1.00]).catch(e=>e);
            }
            await db.query('INSERT INTO ai_usage_logs (user_id, charged_amount) VALUES ($1, $2::numeric)', [String(userId), chargeAmount]).catch(e=>e);
        }

        return res.json({ success: true, reply: result.text, charged });

    } catch (err) {
        console.error('Chat Route Crash Protected:', err.message);
        return res.status(500).json({ success: false, message: 'AI Chat failed to respond. Please try again.' });
    }
});

module.exports = router;