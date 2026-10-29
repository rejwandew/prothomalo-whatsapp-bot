import makeWASocket, { useMultiFileAuthState, DisconnectReason, Browsers, delay } from '@whiskeysockets/baileys';
import Parser from 'rss-parser';
import fs from 'fs';
import pino from 'pino';

// 👇 YOUR NUMBER (Already linked)
const MY_PHONE_NUMBER = '8801839823498'; 

// 👇 YOUR BROTHER'S WHATSAPP NUMBER (Keep '88' at the start, no '+' sign)
const RECEIVER_NUMBER = '8801XXXXXXXXX'; 

const parser = new Parser();
const CACHE_FILE = 'sent_cache.json';

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

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            if (statusCode !== DisconnectReason.loggedOut) {
                console.log('Reconnecting socket...');
                startBot();
            } else {
                console.log('❌ Session logged out! Delete auth_info_baileys folder to re-pair.');
                process.exit(1);
            }
        }

        if (connection === 'open') {
            console.log('✅ Connected to WhatsApp!');

            try {
                // Wait 4 seconds for WhatsApp encryption keys to finish syncing
                await delay(4000);

                // Verify brother's number on WhatsApp & get his exact encrypted JID
                const [result] = await sock.onWhatsApp(RECEIVER_NUMBER);
                if (!result || !result.exists) {
                    console.error(`❌ The number ${RECEIVER_NUMBER} is not registered on WhatsApp!`);
                    process.exit(1);
                }
                const targetJid = result.jid;
                console.log('✅ Verified receiver JID:', targetJid);

                let sentCache = [];
                if (fs.existsSync(CACHE_FILE)) {
                    sentCache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
                }

                const feed = await parser.parseURL('https://www.prothomalo.com/stories.rss');
                const isFirstRun = sentCache.length === 0;
                const newItems = [];

                for (const item of feed.items.slice(0, 5).reverse()) {
                    const articleId = item.link.replace(/\/$/, '').split('/').pop();
                    if (!sentCache.includes(articleId)) {
                        newItems.push({ id: articleId, title: item.title, link: item.link });
                        sentCache.push(articleId);
                    }
                }

                if (isFirstRun && newItems.length > 0) {
                    const latest = newItems[newItems.length - 1];
                    const sentMsg = await sock.sendMessage(targetJid, {
                        text: `✅ *Prothom Alo Bot Activated!*\n\n📰 *${latest.title}*\n🔗 ${latest.link}`
                    });
                    console.log('🚀 Sent initial activation news to brother! Message ID:', sentMsg?.key?.id);
                } else if (newItems.length > 0) {
                    for (const article of newItems) {
                        await sock.sendMessage(targetJid, {
                            text: `📰 *${article.title}*\n\n🔗 ${article.link}`
                        });
                        console.log('🚀 Sent to brother:', article.title);
                        await delay(3000);
                    }
                } else {
                    console.log('📭 No new news since last check.');
                }

                if (sentCache.length > 100) sentCache = sentCache.slice(-100);
                fs.writeFileSync(CACHE_FILE, JSON.stringify(sentCache, null, 2));

            } catch (err) {
                console.error('❌ Error fetching/sending news:', err);
            }

            // Wait 8 seconds so encryption handshake with your brother completes before closing
            await delay(8000);
            sock.end(undefined);
            process.exit(0);
        }
    });
}

startBot();
