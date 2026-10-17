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

// 2. ULTRA-FAST FAILOVER ENGINE (Using Correct Gemini 2.0 Models)
const FREE_MODELS = ['gemini-2.0-flash', 'gemini-2.0-flash-lite'];

async function generateWithFailover(contents, preferredModel = 'gemini-2.0-flash') {
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

router.get('/quota', authenticateToken, async (req, res) => {
    res.json({ success: true, used_this_month: 0, free_remaining: 9999, is_free: true, wallet_balance: 0 });
});

// POST: Analyze Document Images
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

    const legalPrompt = `
You are a senior legal research assistant in Bangladesh analyzing legal documents (FIR, Charge Sheet, Court Order, Bail Petition, Seizure List, etc.). Include specific legal Section names and numbers where applicable.
Review the provided document image(s) thoroughly and formulate your response strictly in ${promptLang}.

CRITICAL FORMATTING RULES:
1. Deliver your response PARAGRAPH BY PARAGRAPH with double line breaks between them.
2. Use clear, UPPERCASE HEADINGS for each section (e.g., DOCUMENT CLASSIFICATION, CORE SUMMARY).
3. DO NOT use markdown asterisks (**) or hashes (#). Use clean, plain text formatting suitable for legal documentation.

Format your analysis covering:
- DOCUMENT CLASSIFICATION
- CORE SUMMARY
- RELEVANT LEGAL SECTIONS & ACTS
- STRONG POINTS
- WEAK POINTS & VULNERABILITIES
- MISSING OR REQUIRED NEXT DOCUMENTS
`;

    const imageParts = images
        .filter(img => img && img.base64)
        .map(img => {
            const base64Data = img.base64.includes(',') ? img.base64.split(',')[1] : img.base64;
            return {
                inlineData: {
                    data: base64Data,
                    mimeType: img.mimeType || 'image/jpeg'
                }
            };
        });

    if (imageParts.length === 0) {
        return res.status(400).json({ success: false, message: 'Invalid image data.' });
    }

    const contents = [{ role: 'user', parts: [{ text: legalPrompt }, ...imageParts] }];

    const result = await generateWithFailover(contents, 'gemini-2.0-flash');

    saveToCache(cacheKey, result.text);
    db.query('INSERT INTO ai_usage_logs (user_id, charged_amount) VALUES ($1, $2)', [String(userId), 0.00]).catch(() => {});

    return res.json({ success: true, analysis: result.text, charged: false });
});

// POST: Follow-up Chat & Voice
router.post('/chat', authenticateToken, async (req, res) => {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized session.' });

    const { language, previousAnalysis, chatMessages, newMessage, newAudio } = req.body;
    if (!newMessage && (!newAudio || newAudio.length === 0)) {
        return res.status(400).json({ success: false, message: 'Please provide a message or voice recording.' });
    }

    const promptLang = language === 'en' ? 'English' : 'Bengali (বাংলা)';
    let combinedPrompt = `You are a senior legal assistant in Bangladesh. Respond strictly in ${promptLang}. Do not use markdown asterisks (**) or hashes (#). Keep answers clear, direct, and practical for an advocate.\n`;

    if (previousAnalysis && !previousAnalysis.includes('GENERAL CASE DISCUSSION')) {
        combinedPrompt += `\n--- CASE SUMMARY ---\n${previousAnalysis}\n--------------------\n`;
    }

    if (chatMessages && Array.isArray(chatMessages) && chatMessages.length > 0) {
        for (const msg of chatMessages.slice(-4)) {
            if (msg?.text && !msg.text.includes('🎤')) {
                combinedPrompt += `${msg.role === 'model' ? 'Assistant' : 'Advocate'}: ${msg.text}\n`;
            }
        }
    }

    const userParts = [{ text: combinedPrompt }];
    if (newMessage && newMessage.trim()) {
        userParts.push({ text: `\nAdvocate's Question: ${newMessage.trim()}` });
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
                userParts.push({ text: '\nPlease listen to this voice inquiry and provide legal advice.' });
            }
        }
    }

    const contents = [{ role: 'user', parts: userParts }];
    const result = await generateWithFailover(contents, 'gemini-2.0-flash-lite');

    return res.json({ success: true, reply: result.text });
});

module.exports = router;