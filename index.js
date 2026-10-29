import makeWASocket, { useMultiFileAuthState, DisconnectReason, Browsers } from '@whiskeysockets/baileys';
import Parser from 'rss-parser';
import fs from 'fs';
import pino from 'pino';

// 👇 YOUR NUMBER (Already linked - do not change)
const MY_PHONE_NUMBER = '8801839823498'; 

// 👇 PUT YOUR BROTHER'S WHATSAPP NUMBER HERE (Keep '88' at the start, no '+' sign)
const RECEIVER_NUMBER = '8801907323903'; 

const parser = new Parser();
const CACHE_FILE = 'sent_cache.json';

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: Browsers.ubuntu('Chrome')
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

        // 3. ONCE CONNECTED: Check Prothom Alo & Send New Articles to Brother
        if (connection === 'open') {
            console.log('✅ Connected to WhatsApp!');

            try {
                let sentCache = [];
                if (fs.existsSync(CACHE_FILE)) {
                    sentCache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
                }

                const feed = await parser.parseURL('https://www.prothomalo.com/stories.rss');
                const isFirstRun = sentCache.length === 0;
                const newItems = [];

                // Check the latest 5 articles from the feed
                for (const item of feed.items.slice(0, 5).reverse()) {
                    const articleId = item.link.replace(/\/$/, '').split('/').pop();
                    if (!sentCache.includes(articleId)) {
                        newItems.push({ id: articleId, title: item.title, link: item.link });
                        sentCache.push(articleId);
                    }
                }

                if (isFirstRun && newItems.length > 0) {
                    // On First Run, save current articles and send 1 welcome news item so he isn't spammed
                    const latest = newItems[newItems.length - 1];
                    await sock.sendMessage(`${RECEIVER_NUMBER}@s.whatsapp.net`, {
                        text: `✅ *Prothom Alo Bot Activated!*\n\n📰 *${latest.title}*\n🔗 ${latest.link}`
                    });
                    console.log('Sent initial activation news to brother!');
                } else if (newItems.length > 0) {
                    for (const article of newItems) {
                        await sock.sendMessage(`${RECEIVER_NUMBER}@s.whatsapp.net`, {
                            text: `📰 *${article.title}*\n\n🔗 ${article.link}`
                        });
                        console.log('Sent to brother:', article.title);
                        await new Promise(r => setTimeout(r, 2000));
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

            // Wait 5 seconds for messages to deliver, then exit cleanly
            setTimeout(() => process.exit(0), 5000);
        }
    });
}

startBot();
