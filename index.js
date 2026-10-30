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
const GEMINI_API_KEY = 'AQ.Ab8RN6JRjd1VI0vZfOsZtZZQWfY73yI8iO9fqJKoVCRKXg5ZYw';
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

// Fast Gemini Summarizer with 12s timeout per model
async function summarizeWithGemini(headline, fullText) {
    const prompt = `তুমি একজন পেশাদার সংবাদ সম্পাদক। নিচের প্রথম আলো সংবাদের মূল শিরোনাম এবং বিস্তারিত প্রতিবেদন দেওয়া হলো। 
এই প্রতিবেদনটি পড়ে এর সবগুলো গুরুত্বপূর্ণ তথ্য, প্রেক্ষাপট ও মূল বক্তব্য বজায় রেখে একটি সুন্দর, প্রাঞ্জল ও মাঝারি আকারের সারাংশ (প্রায় ১২০ থেকে ১৬০ শব্দের মধ্যে, ২টি অনুচ্ছেদে) বাংলায় লিখে দাও। 
সারাংশের ভেতর নতুন করে শিরোনাম, কোনো লিংক বা অতিরিক্ত ভূমিকা লিখবে না—শুধুমাত্র মূল সারাংশটুকু লিখবে।

শিরোনাম: ${headline}
বিস্তারিত সংবাদ:
${fullText}`;

    const candidateModels = [
        'gemini-3.8-flash',
        'gemini-3.6-flash',
        'gemini-flash-latest',
        'gemini-2.5-flash'
    ];

    for (const modelName of candidateModels) {
        try {
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${GEMINI_API_KEY}`;
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: { temperature: 0.3 }
                }),
                signal: AbortSignal.timeout(12000)
            });

            const data = await response.json();
            if (data.error) continue;

            const aiSummary = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
            if (aiSummary) {
                console.log(`✨ Gemini summary generated using [${modelName}]!`);
                return aiSummary;
            }
        } catch (err) {
            // Try next model
        }
    }

    // Fallback if Gemini fails
    const paras = fullText.split('\n\n');
    let result = '';
    for (const p of paras) {
        if (result.length === 0) result = p;
        else if (result.length + p.length < 850) result += '\n\n' + p;
        else break;
    }
    return result || fullText.slice(0, 750);
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
