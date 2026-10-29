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

// 👇 SET TO true TO FORCE SENDING 1 NEWS RIGHT NOW EVEN IF ALREADY IN CACHE (Change to false after testing!)
const FORCE_SEND_ONE_IF_NO_NEW = true;

const parser = new Parser({
    customFields: {
        item: ['summary', 'description', 'content:encoded', 'content']
    }
});
const CACHE_FILE = 'sent_cache.json';

// Helper 1: Extract full article text from the RSS item or fetch article page
async function getFullArticleText(item) {
    const rawRssText = item['content:encoded'] || item.content || item.summary || item.description || item.contentSnippet || '';
    const cleanedRss = rawRssText
        .replace(/<[^>]*>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    if (cleanedRss.length > 250) {
        return cleanedRss;
    }

    try {
        const res = await fetch(item.link, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' }
        });
        const html = await res.text();
        const matches = [...html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)];
        const paras = matches
            .map(m => m[1].replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim())
            .filter(text => text.length > 40 && !text.includes('প্রথম আলো'));

        if (paras.length > 0) {
            return paras.join('\n\n');
        }
    } catch (e) {
        console.warn('Webpage fetch fallback warning:', e.message);
    }

    return cleanedRss || item.title;
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
    const prompt = `তুমি একজন পেশাদার সংবাদ সম্পাদক। নিচের প্রথম আলো সংবাদের মূল শিরোনাম এবং বিস্তারিত প্রতিবেদন দেওয়া হলো। 
এই প্রতিবেদনটি পড়ে এর সবগুলো গুরুত্বপূর্ণ তথ্য, প্রেক্ষাপট ও মূল বক্তব্য বজায় রেখে একটি সুন্দর, প্রাঞ্জল ও মাঝারি আকারের সারাংশ (প্রায় ১২০ থেকে ১৬০ শব্দের মধ্যে, ২টি অনুচ্ছেদে) বাংলায় লিখে দাও। 
সারাংশের ভেতর নতুন করে শিরোনাম, কোনো লিংক বা অতিরিক্ত ভূমিকা লিখবে না—শুধুমাত্র মূল সারাংশটুকু লিখবে।

শিরোনাম: ${headline}
বিস্তারিত সংবাদ:
${fullText}`;

    try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.0-flash:generateContent?key=${GEMINI_API_KEY}`;
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
            console.log('✨ Gemini 2.5 Flash summary generated!');
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

        // 3. ONCE CONNECTED: Check Prothom Alo RSS & Send New Articles
        if (connection === 'open') {
            console.log('✅ Connected to WhatsApp!');

            try {
                await delay(4000);

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

                const feed = await parser.parseURL('https://www.prothomalo.com/stories.rss');
                console.log(`📥 Fetched ${feed.items.length} stories from Prothom Alo RSS.`);

                const isFirstRun = sentCache.length === 0;
                const newItems = [];

                for (const item of feed.items.slice(0, 5).reverse()) {
                    const articleId = item.link.replace(/\/$/, '').split('/').pop();
                    if (!sentCache.includes(articleId)) {
                        const fullText = await getFullArticleText(item);
                        newItems.push({ id: articleId, title: item.title.trim(), fullText: fullText });
                        sentCache.push(articleId);
                    }
                }

                if (isFirstRun && newItems.length > 0) {
                    const latest = newItems[newItems.length - 1];
                    const summary = await summarizeWithGemini(latest.title, latest.fullText);
                    await sock.sendMessage(targetJid, {
                        text: `*${latest.title}*\n\n${summary}`
                    });
                    console.log('🚀 Sent initial detailed news:', latest.title);
                } else if (newItems.length > 0) {
                    for (const article of newItems) {
                        const summary = await summarizeWithGemini(article.title, article.fullText);
                        await sock.sendMessage(targetJid, {
                            text: `*${article.title}*\n\n${summary}`
                        });
                        console.log('🚀 Sent:', article.title);
                        await new Promise(r => setTimeout(r, 3000));
                    }
                } else if (FORCE_SEND_ONE_IF_NO_NEW && feed.items.length > 0) {
                    // Force send the #1 latest story even if it was already in sent_cache.json
                    const topItem = feed.items[0];
                    const fullText = await getFullArticleText(topItem);
                    const summary = await summarizeWithGemini(topItem.title.trim(), fullText);
                    await sock.sendMessage(targetJid, {
                        text: `*${topItem.title.trim()}*\n\n${summary}`
                    });
                    console.log('🚀 Force-sent latest detailed news for testing:', topItem.title.trim());
                } else {
                    console.log('📭 No new news since last check.');
                }

                if (sentCache.length > 100) sentCache = sentCache.slice(-100);
                fs.writeFileSync(CACHE_FILE, JSON.stringify(sentCache, null, 2));

            } catch (err) {
                console.error('Error fetching/sending news:', err);
            }

            await delay(8000);
            sock.end(undefined);
            process.exit(0);
        }
    });
}

startBot();
