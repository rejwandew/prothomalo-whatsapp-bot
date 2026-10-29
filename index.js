import makeWASocket, { useMultiFileAuthState, DisconnectReason, Browsers, delay } from '@whiskeysockets/baileys';
import Parser from 'rss-parser';
import fs from 'fs';
import pino from 'pino';

// 👇 CHANGE THIS TO YOUR WHATSAPP NUMBER (Keep '88' at the start, no '+' sign)
const MY_PHONE_NUMBER = '8801839823498'; 

// 👇 PUT YOUR BROTHER'S WHATSAPP NUMBER HERE (Keep '88' at the start, no '+' sign)
const RECEIVER_NUMBER = '8801907323903'; 

// 👇 YOUR GEMINI API KEY (Hardcoded directly)
const GEMINI_API_KEY = 'AQ.Ab8RN6JRjd1VI0vZfOsZtZZQWfY73yI8iO9fqJKoVCRKXg5ZYw';

const parser = new Parser();
const CACHE_FILE = 'sent_cache.json';

// Helper 1: Extract full article text from Prothom Alo JSON story
function extractFullArticleText(story) {
    let paragraphs = [];
    if (story.cards && Array.isArray(story.cards)) {
        for (const card of story.cards) {
            if (card['story-elements'] && Array.isArray(card['story-elements'])) {
                for (const el of card['story-elements']) {
                    if (el.type === 'text' && el.text) {
                        const cleanText = el.text
                            .replace(/<[^>]*>/g, ' ')
                            .replace(/&nbsp;/g, ' ')
                            .replace(/\s+/g, ' ')
                            .trim();
                        if (cleanText.length > 25) {
                            paragraphs.push(cleanText);
                        }
                    }
                }
            }
        }
    }
    return paragraphs.join('\n\n') || story.summary || '';
}

// Helper 2: Fallback paragraph combiner if Gemini API key has an issue
function buildFallbackSummary(fullText) {
    const paras = fullText.split('\n\n');
    let result = '';
    for (const p of paras) {
        if (result.length === 0) {
            result = p;
        } else if (result.length + p.length < 850) {
            result += '\n\n' + p;
        } else {
            break;
        }
    }
    return result || fullText.slice(0, 750);
}

// Helper 3: Summarize full news in Bangla using Gemini 2.5 Flash
async function summarizeWithGemini(headline, fullText) {
    const prompt = `তুমি একজন পেশাদার সংবাদ সম্পাদক। নিচের প্রথম আলো সংবাদের মূল শিরোনাম এবং সম্পূর্ণ বিস্তারিত প্রতিবেদন দেওয়া হলো। 
এই সম্পূর্ণ প্রতিবেদনটি পড়ে এর সবগুলো গুরুত্বপূর্ণ তথ্য, প্রেক্ষাপট ও মূল বক্তব্য বজায় রেখে একটি সুন্দর, প্রাঞ্জল ও মাঝারি আকারের সারাংশ (প্রায় ১২০ থেকে ১৬০ শব্দের মধ্যে, ২টি অনুচ্ছেদে) বাংলায় লিখে দাও। 
সারাংশের ভেতর নতুন করে শিরোনাম, কোনো লিংক বা অতিরিক্ত ভূমিকা লিখবে না—শুধুমাত্র মূল সারাংশটুকু লিখবে।

শিরোনাম: ${headline}
বিস্তারিত সংবাদ:
${fullText}`;

    try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { temperature: 0.3 }
            })
        });

        const data = await response.json();

        if (data.error) {
            console.warn('⚠️ Gemini API Warning:', data.error.message);
            return buildFallbackSummary(fullText);
        }

        const aiSummary = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        if (aiSummary) {
            return aiSummary;
        }
    } catch (err) {
        console.error('Gemini API Error:', err);
    }

    return buildFallbackSummary(fullText);
}

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: Browsers.ubuntu('Chrome'),
        syncFullHistory: false
    });

    sock.ev.on('creds.update', saveCreds);

    let pairingRequested = false;

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        // 1. FIRST-TIME SETUP: Generate 8-Digit Pairing Code in GitHub Logs
        if (qr && !sock.authState.creds.registered && !pairingRequested) {
            pairingRequested = true;
            setTimeout(async () => {
                try {
                    const code = await sock.requestPairingCode(MY_PHONE_NUMBER);
                    console.log('\n=========================================');
                    console.log('🔗 YOUR WHATSAPP PAIRING CODE:', code);
                    console.log('👉 Open WhatsApp -> Linked Devices -> Link with phone number instead');
                    console.log('👉 Enter this code on your phone within 60 seconds!');
                    console.log('=========================================\n');
                } catch (err) {
                    console.error('Failed to request pairing code:', err);
                }
            }, 3000);
        }

        // 2. RECONNECT AUTOMATICALLY RIGHT AFTER PAIRING
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            if (statusCode !== DisconnectReason.loggedOut) {
                console.log('Reconnecting socket...');
                startBot();
            } else {
                console.log('Session logged out. Delete auth_info_baileys folder to re-pair.');
                process.exit(1);
            }
        }

        // 3. ONCE CONNECTED: Check Prothom Alo & Send New Articles
        if (connection === 'open') {
            console.log('✅ Connected to WhatsApp!');

            try {
                // Wait 4 seconds for WhatsApp encryption keys to sync
                await delay(4000);

                // Verify brother's WhatsApp JID so messages never get dropped
                const [result] = await sock.onWhatsApp(RECEIVER_NUMBER);
                if (!result || !result.exists) {
                    console.error(`❌ The number ${RECEIVER_NUMBER} is not registered on WhatsApp!`);
                    process.exit(1);
                }
                const targetJid = result.jid;

                let sentCache = [];
                if (fs.existsSync(CACHE_FILE)) {
                    sentCache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
                }

                // Fetch full stories from Prothom Alo API so we have the full body text to summarize
                const response = await fetch('https://www.prothomalo.com/api/v1/stories?limit=5', {
                    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
                });
                const data = await response.json();
                const stories = data.items || [];

                const isFirstRun = sentCache.length === 0;
                const newItems = [];

                // Check the latest 5 articles from the feed
                for (const item of stories.slice(0, 5).reverse()) {
                    const story = item.story || item;
                    const articleUrl = story.url || story.slug || story.id;
                    const articleId = String(articleUrl).replace(/\/$/, '').split('/').pop();
                    const title = story.headline ? story.headline.trim() : '';
                    const fullText = extractFullArticleText(story);

                    if (articleId && title && fullText && !sentCache.includes(articleId)) {
                        newItems.push({ id: articleId, title: title, fullText: fullText });
                        sentCache.push(articleId);
                    }
                }

                if (isFirstRun && newItems.length > 0) {
                    // On First Run, save current articles and send 1 welcome news item so you aren't spammed
                    const latest = newItems[newItems.length - 1];
                    const summary = await summarizeWithGemini(latest.title, latest.fullText);
                    await sock.sendMessage(targetJid, {
                        text: `*${latest.title}*\n\n${summary}`
                    });
                    console.log('Sent initial activation news!');
                } else if (newItems.length > 0) {
                    for (const article of newItems) {
                        const summary = await summarizeWithGemini(article.title, article.fullText);
                        await sock.sendMessage(targetJid, {
                            text: `*${article.title}*\n\n${summary}`
                        });
                        console.log('Sent:', article.title);
                        await new Promise(r => setTimeout(r, 3000));
                    }
                } else {
                    console.log('📭 No new news since last check.');
                }

                // Keep only the last 100 IDs in cache
                if (sentCache.length > 100) sentCache = sentCache.slice(-100);
                fs.writeFileSync(CACHE_FILE, JSON.stringify(sentCache, null, 2));

            } catch (err) {
                console.error('Error fetching/sending news:', err);
            }

            // Wait 8 seconds for messages to deliver, then exit cleanly
            await delay(8000);
            sock.end(undefined);
            process.exit(0);
        }
    });
}

startBot();
