import makeWASocket, { useMultiFileAuthState, DisconnectReason, Browsers, delay } from '@whiskeysockets/baileys';
import Parser from 'rss-parser';
import fs from 'fs';
import pino from 'pino';

// Master safety timer: Forces clean exit at 2.5 minutes so GitHub actions always commits cache
setTimeout(() => {
    console.log('⏱️ Safety limit reached. Exiting cleanly to save cache...');
    process.exit(0);
}, 150000);

const MY_PHONE_NUMBER = '8801839823498';
const RECEIVER_NUMBER = '8801907323903';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const FORCE_SEND_ONE_IF_NO_NEW = false;

const parser = new Parser({
    timeout: 10000,
    customFields: {
        item: ['summary', 'description', 'content:encoded', 'content']
    }
});
const CACHE_FILE = 'sent_cache.json';
const LOG_FILE = 'SENT_LOG.md';
let isJobDone = false;

// Instant RSS text extraction (Solution A)
function extractRssText(item) {
    const rawRssText = item['content:encoded'] || item.content || item.summary || item.description || item.contentSnippet || '';
    return rawRssText
        .replace(/<[^>]*>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim() || item.title;
}

// Fast Summarizer using Your Exact Active Groq Models (3,000 free summaries/day)
async function summarizeWithGemini(headline, fullText) {
    const systemPrompt = 'তুমি একজন পেশাদার বাংলা সংবাদ সম্পাদক। তোমার কাজ হলো সংবাদের মূল তথ্য বজায় রেখে প্রাঞ্জল বাংলায় সারাংশ লেখা।';
    const prompt = `নিচের প্রথম আলো সংবাদের মূল শিরোনাম এবং বিস্তারিত প্রতিবেদন দেওয়া হলো। 
এই প্রতিবেদনটি পড়ে এর সবগুলো গুরুত্বপূর্ণ তথ্য, প্রেক্ষাপট ও মূল বক্তব্য বজায় রেখে একটি সুন্দর, প্রাঞ্জল ও মাঝারি আকারের সারাংশ (প্রায় ১২০ থেকে ১৬০ শব্দের মধ্যে, ২টি অনুচ্ছেদে) বাংলায় লিখে দাও। 
সারাংশের ভেতর নতুন করে শিরোনাম, কোনো লিংক বা অতিরিক্ত ভূমিকা লিখবে না—শুধুমাত্র মূল সারাংশটুকু লিখবে।

শিরোনাম: ${headline}
বিস্তারিত সংবাদ:
${fullText}`;

    const apiKey = (process.env.GEMINI_API_KEY || '').trim();

    // 1. Primary Engine: Your exact active Groq models
    const groqModels = [
        'openai/gpt-oss-120b',
        'qwen/qwen3.8-27b',
        'openai/gpt-oss-20b'
    ];

    for (const modelName of groqModels) {
        try {
            const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`
                },
                body: JSON.stringify({
                    model: modelName,
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: prompt }
                    ],
                    temperature: 0.3,
                    max_tokens: 900
                }),
                signal: AbortSignal.timeout(25000)
            });

            const data = await response.json();
            if (!response.ok || data.error) {
                console.warn(`⚠️ [Groq: ${modelName}] Error:`, data?.error?.message || response.status);
                continue;
            }

            const rawContent = data?.choices?.[0]?.message?.content?.trim() || '';
            // Remove internal <think>...</think> reasoning tags if present
            const cleanSummary = rawContent.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

            if (cleanSummary && cleanSummary.length > 40) {
                console.log(`✨ Summary generated via Groq [${modelName}]!`);
                return `${cleanSummary}\n\n_🤖 Model: ${modelName}_`;
            } else {
                console.warn(`⚠️ [Groq: ${modelName}] returned empty text.`);
            }
        } catch (err) {
            console.warn(`⚠️ [Groq: ${modelName}] Request failed:`, err.message);
        }
    }

    // 2. Emergency Backup: Keyless AI (Only runs if all 3 Groq models fail)
    try {
        console.log('🔄 Trying keyless AI backup...');
        await new Promise(r => setTimeout(r, 3000));
        const response = await fetch('https://text.pollinations.ai/openai', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'openai',
                seed: Math.floor(Math.random() * 100000),
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: prompt }
                ],
                temperature: 0.3
            }),
            signal: AbortSignal.timeout(30000)
        });

        if (response.ok) {
            const rawText = await response.text();
            let aiSummary = '';
            try {
                const data = JSON.parse(rawText);
                aiSummary = data?.choices?.[0]?.message?.content?.trim() || '';
            } catch {
                aiSummary = rawText.trim();
            }
            const clean = aiSummary.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
            if (clean && clean.length > 50 && !clean.startsWith('<!DOCTYPE')) {
                console.log('✨ Summary generated via Keyless Backup AI!');
                return `${clean}\n\n_🤖 Model: Backup AI_`;
            }
        }
    } catch (err) {
        console.warn('⚠️ [Keyless Backup] failed:', err.message);
    }

    // 3. Final Fallback: Raw RSS Text
    console.log('❌ All AI models failed. Using fallback RSS text.');
    const paras = fullText.split('\n\n');
    let result = '';
    for (const p of paras) {
        if (result.length === 0) result = p;
        else if (result.length + p.length < 850) result += '\n\n' + p;
        else break;
    }
    const fallbackText = result || fullText.slice(0, 750);
    return `${fallbackText}\n\n_⚠️ Fallback: Raw RSS Text_`;
}




// Record sent articles into SENT_LOG.md
function logSentArticle(headline) {
    const bdTime = new Date().toLocaleString('en-GB', { timeZone: 'Asia/Dhaka' });
    const header = !fs.existsSync(LOG_FILE)
        ? `# 📊 Prothom Alo Sent News Log\n\n| Date & Time (BDT) | Headline Sent to Brother |\n| :--- | :--- |\n`
        : '';
    fs.appendFileSync(LOG_FILE, `${header}| ${bdTime} | ${headline.replace(/\|/g, '-')} |\n`);
}

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: Browsers.ubuntu('Chrome'),
        syncFullHistory: false,
        connectTimeoutMs: 20000
    });

    sock.ev.on('creds.update', saveCreds);
    let pairingRequested = false;

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr && !sock.authState.creds.registered && !pairingRequested) {
            pairingRequested = true;
            setTimeout(async () => {
                try {
                    const code = await sock.requestPairingCode(MY_PHONE_NUMBER);
                    console.log('\n=========================================');
                    console.log('🔗 YOUR WHATSAPP PAIRING CODE:', code);
                    console.log('=========================================\n');
                } catch (err) {
                    console.error('Pairing code error:', err);
                }
            }, 3000);
        }

        if (connection === 'close') {
            if (isJobDone) return;
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            if (statusCode !== DisconnectReason.loggedOut) {
                console.log('Reconnecting socket...');
                startBot();
            } else {
                console.log('Session logged out.');
                process.exit(1);
            }
        }

        if (connection === 'open') {
            if (isJobDone) return;
            isJobDone = true;

            console.log('✅ Connected to WhatsApp!');

            try {
                await delay(3000);

                const [result] = await sock.onWhatsApp(RECEIVER_NUMBER);
                if (!result || !result.exists) {
                    console.error(`❌ Number ${RECEIVER_NUMBER} not on WhatsApp!`);
                    process.exit(1);
                }
                const targetJid = result.jid;

                let sentCache = [];
                if (fs.existsSync(CACHE_FILE)) {
                    sentCache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
                }

                const feed = await parser.parseURL('https://www.prothomalo.com/stories.rss');
                console.log(`📥 Fetched ${feed.items.length} stories from RSS.`);

                if (sentCache.length <= 5 && feed.items.length > 5) {
                    for (const oldItem of feed.items.slice(5)) {
                        const oldId = oldItem.link.replace(/\/$/, '').split('/').pop();
                        if (!sentCache.includes(oldId)) sentCache.push(oldId);
                    }
                }

                const isFirstRun = sentCache.length === 0;
                const newItems = [];

                for (const item of feed.items.slice(0, 15).reverse()) {
                    const articleId = item.link.replace(/\/$/, '').split('/').pop();
                    if (!sentCache.includes(articleId)) {
                        const snippet = extractRssText(item);
                        newItems.push({ id: articleId, title: item.title.trim(), snippet });
                        sentCache.push(articleId);
                    }
                }

                if (sentCache.length > 200) sentCache = sentCache.slice(-200);
                fs.writeFileSync(CACHE_FILE, JSON.stringify(sentCache, null, 2));

                // Solution C: Cap at max 3 articles per run
                const itemsToProcess = isFirstRun && newItems.length > 0 
                    ? [newItems[newItems.length - 1]] 
                    : newItems.slice(-3);

                if (itemsToProcess.length > 0) {
                    console.log(`🆕 Sending ${itemsToProcess.length} new article(s)...`);
                    for (const article of itemsToProcess) {
                        const summary = await summarizeWithGemini(article.title, article.snippet);
                        await sock.sendMessage(targetJid, {
                            text: `*${article.title}*\n\n${summary}`
                        });
                        logSentArticle(article.title);
                        console.log('🚀 Sent:', article.title);
                        await delay(3500);
                    }
                } else if (FORCE_SEND_ONE_IF_NO_NEW && feed.items.length > 0) {
                    const topItem = feed.items[0];
                    const snippet = extractRssText(topItem);
                    const summary = await summarizeWithGemini(topItem.title.trim(), snippet);
                    await sock.sendMessage(targetJid, {
                        text: `*${topItem.title.trim()}*\n\n${summary}`
                    });
                    logSentArticle(topItem.title.trim());
                    console.log('🚀 Force-sent latest test news:', topItem.title.trim());
                } else {
                    console.log('📭 No new news since last check.');
                }

            } catch (err) {
                console.error('Error in news pipeline:', err);
            }

            await delay(4000);
            sock.end(undefined);
            process.exit(0);
        }
    });
}

startBot();
