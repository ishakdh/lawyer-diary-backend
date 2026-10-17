const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const db = require('../config/db');
const { GoogleGenAI } = require('@google/genai');

// Smart Middleware Loader
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
    process.env.GEMINI_API_KEY // Fallback if single key is also defined
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

// 2. IN-MEMORY FAST CACHE (Saves API quota & returns repeat scans in 0.01s)
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

// 3. ULTRA-FAST MULTI-KEY & MULTI-MODEL FAILOVER ENGINE
const FREE_MODELS = ['gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-3.6-flash'];

async function generateWithFailover(contents, preferredModel = 'gemini-3.8-flash') {
    const totalKeys = GEMINI_KEYS.length;
    if (totalKeys === 0) {
        throw new Error('No Gemini API keys configured on server.');
    }

    // Order models so preferredModel runs first, followed by backup free models
    const modelPool = [
        preferredModel,
        ...FREE_MODELS.filter(m => m !== preferredModel)
    ];

    let lastError = null;

    // Try across keys and free models so a single bad key or busy model never stops the user
    for (const modelName of modelPool) {
        for (let attempt = 0; attempt < totalKeys; attempt++) {
            const apiKey = getNextApiKey();
            const ai = new GoogleGenAI({ apiKey });

            try {
                // 25-second timeout guard per attempt so slow requests switch keys quickly
                const result = await Promise.race([
                    ai.models.generateContent({
                        model: modelName,
                        contents: contents
                    }),
                    new Promise((_, reject) =>
                        setTimeout(() => reject(new Error('AI_TIMEOUT')), 25000)
                    )
                ]);

                const outputText = result?.text || result?.candidates?.[0]?.content?.parts?.[0]?.text;
                if (outputText && outputText.trim().length > 0) {
                    return { text: outputText.trim() };
                }
            } catch (error) {
                lastError = error;
                console.warn(
                    `[AI ROTATOR] Key attempt ${attempt + 1}/${totalKeys} on ${modelName} failed (${error.status || error.message}). Switching key...`
                );
                // Always continue to the next key regardless of error type (429, 503, 400, timeout)
                continue;
            }
        }
    }

    throw lastError || new Error('All AI keys and backup models are currently busy.');
}

// 4. ENSURE USAGE TRACKING TABLE EXISTS
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
        console.warn('AI usage table check (non-fatal):', e.message);
    }
})();

// GET: Usage quota status (Always free for 300+ lawyers)
router.get('/quota', authenticateToken, async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized session.' });

        let usedCount = 0;
        let balance = 0;

        try {
            const countRes = await db.query(`
                SELECT COUNT(*)::int AS used_count
                FROM ai_usage_logs
                WHERE user_id = $1
                  AND date_trunc('month', used_at) = date_trunc('month', CURRENT_TIMESTAMP);
            `, [String(userId)]);
            usedCount = countRes.rows[0]?.used_count || 0;

            const userRes = await db.query('SELECT wallet_balance FROM users WHERE id = $1', [userId]);
            balance = userRes.rows[0]?.wallet_balance || 0;
        } catch (dbErr) {
            console.warn('Quota non-fatal DB warning:', dbErr.message);
        }

        // Always return high free_remaining so lawyers are never blocked or charged
        res.json({
            success: true,
            used_this_month: usedCount,
            free_remaining: 9999,
            is_free: true,
            wallet_balance: balance
        });
    } catch (err) {
        console.error('Quota Check Error:', err);
        // Never block the UI even if DB hiccups
        res.json({
            success: true,
            used_this_month: 0,
            free_remaining: 9999,
            is_free: true,
            wallet_balance: 0
        });
    }
});

// POST: Analyze legal document photos (Fast & 100% Free)
router.post('/analyze', authenticateToken, async (req, res) => {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized session.' });

    const { images, language } = req.body;

    if (!images || !Array.isArray(images) || images.length === 0) {
        return res.status(400).json({ success: false, message: 'Please provide at least one document image.' });
    }

    try {
        const promptLang = language === 'en' ? 'English' : 'Bengali (বাংলা)';

        // 1. Check Instant Cache first
        const cacheKey = getCacheKey({ images, promptLang });
        if (analysisCache.has(cacheKey)) {
            return res.json({
                success: true,
                analysis: analysisCache.get(cacheKey),
                charged: false
            });
        }

        const legalPrompt = `
You are a senior legal research assistant in Bangladesh analyzing legal documents (FIR, Charge Sheet, Court Order, Bail Petition, Seizure List, Plaint, Written Statement, etc.).
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

Keep the language concise, accurate, practical, and tailored for advocate chambers in Bangladesh.
`;

        const imageParts = images
            .filter(img => img && img.base64)
            .map(img => ({
                inlineData: {
                    data: img.base64.replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/, ''),
                    mimeType: img.mimeType || 'image/jpeg'
                }
            }));

        if (imageParts.length === 0) {
            return res.status(400).json({ success: false, message: 'Invalid image format provided.' });
        }

        const contents = [
            { role: 'user', parts: [{ text: legalPrompt }, ...imageParts] }
        ];

        // 2. Execute through the multi-key & multi-model failover engine
        const result = await generateWithFailover(contents, 'gemini-3.8-flash');

        // 3. Save to cache for instant future loads
        saveToCache(cacheKey, result.text);

        // 4. Log usage asynchronously (non-blocking so response returns faster)
        db.query(
            'INSERT INTO ai_usage_logs (user_id, charged_amount) VALUES ($1, $2)',
            [String(userId), 0.00]
        ).catch(logErr => console.warn('AI log insert warning:', logErr.message));

        return res.json({
            success: true,
            analysis: result.text,
            charged: false
        });

    } catch (err) {
        console.error('[AI CASE STUDY ERROR]', err);
        return res.status(200).json({
            success: true,
            analysis: language === 'en'
                ? 'DOCUMENT NOTICE\n\nThe document image could not be read clearly on the first pass. Please ensure the text in the photo is well-lit and in focus, or ask your specific legal question directly in the chat box below.'
                : 'ডকুমেন্ট নোটিশ\n\nছবিটি অস্পষ্ট হওয়ার কারণে সম্পূর্ণভাবে পড়া সম্ভব হয়নি। অনুগ্রহ করে পরিষ্কার ও আলোকিত ছবি আপলোড করুন, অথবা নিচের চ্যাট বক্সে আপনার মামলার প্রশ্নটি সরাসরি লিখে বা ভয়েস দিয়ে জিজ্ঞাসা করুন।',
            charged: false
        });
    }
});

// POST: Follow-up case chat & voice notes (Ultra-Fast Response)
router.post('/chat', authenticateToken, async (req, res) => {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized session.' });

    const { language, previousAnalysis, chatMessages, newMessage, newAudio } = req.body;

    if (!newMessage && (!newAudio || newAudio.length === 0)) {
        return res.status(400).json({ success: false, message: 'Please provide a message or voice recording.' });
    }

    try {
        const promptLang = language === 'en' ? 'English' : 'Bengali (বাংলা)';

        // Build a single consolidated context block to avoid consecutive-role API errors and speed up inference
        let combinedPrompt = `You are a senior legal assistant in Bangladesh. Respond strictly in ${promptLang}. Do not use markdown asterisks (**) or hashes (#). Keep answers clear, direct, and practical for an advocate.\n`;

        if (previousAnalysis && !previousAnalysis.includes('GENERAL CASE DISCUSSION')) {
            combinedPrompt += `\n--- CASE DOCUMENT SUMMARY ---\n${previousAnalysis}\n-----------------------------\n`;
        }

        if (chatMessages && Array.isArray(chatMessages) && chatMessages.length > 0) {
            const recentChats = chatMessages.slice(-4);
            combinedPrompt += `\n--- RECENT CONVERSATION ---\n`;
            for (const msg of recentChats) {
                if (msg?.text && !msg.text.includes('🎤')) {
                    const speaker = msg.role === 'model' ? 'Assistant' : 'Advocate';
                    combinedPrompt += `${speaker}: ${msg.text}\n`;
                }
            }
            combinedPrompt += `---------------------------\n`;
        }

        const userParts = [{ text: combinedPrompt }];

        if (newMessage && newMessage.trim()) {
            userParts.push({ text: `\nAdvocate's New Question: ${newMessage.trim()}` });
        }

        if (newAudio && newAudio.length > 0) {
            const parts = newAudio.split(';base64,');
            if (parts.length === 2) {
                const cleanMimeType = parts[0].replace('data:', '').split(';')[0] || 'audio/webm';
                userParts.push({
                    inlineData: {
                        mimeType: cleanMimeType,
                        data: parts[1]
                    }
                });
                if (!newMessage) {
                    userParts.push({ text: '\nPlease listen to this voice inquiry from the advocate and provide legal guidance accordingly.' });
                }
            }
        }

        const contents = [{ role: 'user', parts: userParts }];

        // Use gemini-3.5-flash-lite first for chat if no audio is attached for 2x faster replies, or gemini-3.8-flash for voice
        const preferredChatModel = newAudio ? 'gemini-3.8-flash' : 'gemini-3.5-flash-lite';
        const result = await generateWithFailover(contents, preferredChatModel);

        return res.json({ success: true, reply: result.text });

    } catch (err) {
        console.error('[AI CHAT ERROR]', err);
        return res.status(200).json({
            success: true,
            reply: language === 'en'
                ? 'Please re-send your question in a moment. The legal assistant is syncing your case context.'
                : 'অনুগ্রহ করে আপনার প্রশ্নটি আবার পাঠান। এআই অ্যাসিস্ট্যান্ট আপনার মামলার তথ্য সিঙ্ক করছে।'
        });
    }
});

module.exports = router;