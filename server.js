const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');

/**
 * CONFIGURATION & DATABASE INIT
 */
const app = express();
const PORT = process.env.PORT || 3000;
const DOMAIN = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

const db = new sqlite3.Database('./database.sqlite');

// Enhanced Database Schema
db.serialize(() => {
    // Bots Table
    db.run(`CREATE TABLE IF NOT EXISTS bots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token TEXT UNIQUE,
        admin_id TEXT,
        username TEXT,
        status TEXT DEFAULT 'active',
        welcome_msg TEXT DEFAULT 'Welcome to our bot!',
        welcome_type TEXT DEFAULT 'text', -- text, photo, video, animation, audio, document
        welcome_media TEXT,               -- URL or File ID
        welcome_buttons TEXT,             -- JSON string of buttons
        parse_mode TEXT DEFAULT 'HTML',   -- HTML or Markdown
        force_channels TEXT DEFAULT '',   -- Comma separated usernames/IDs
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Users Table
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bot_token TEXT,
        user_id TEXT,
        username TEXT,
        referred_by TEXT,
        points INTEGER DEFAULT 0,
        joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(bot_token, user_id)
    )`);

    // Broadcast History
    db.run(`CREATE TABLE IF NOT EXISTS broadcast_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bot_token TEXT,
        total_targets INTEGER,
        success_count INTEGER,
        fail_count INTEGER,
        status TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});

/**
 * BOT INSTANCE MANAGER
 * Handles individual bot logic and dynamic updates
 */
class BotInstance {
    constructor(config) {
        this.config = config;
        this.bot = new Telegraf(config.token);
        this.status = config.status;
        this.setupHandlers();
    }

    async initWebhook() {
        const webhookPath = `/telegraf/${this.config.token.split(':')[1]}`;
        await this.bot.telegram.setWebhook(`${DOMAIN}${webhookPath}`);
        return webhookPath;
    }

    // Refresh settings without restarting the instance
    updateConfig(newConfig) {
        this.config = { ...this.config, ...newConfig };
    }

    setupHandlers() {
        // Middleware: Check Force Join
        this.bot.use(async (ctx, next) => {
            if (!ctx.from || !this.config.force_channels) return next();
            
            const channels = this.config.force_channels.split(',').map(c => c.trim()).filter(c => c);
            if (channels.length === 0) return next();

            // Skip check for admin or specific commands if needed
            if (ctx.message?.text === '/start' || ctx.callbackQuery?.data === 'check_join') {
                const results = await Promise.all(channels.map(async (ch) => {
                    try {
                        const member = await ctx.telegram.getChatMember(ch, ctx.from.id);
                        return ['member', 'administrator', 'creator'].includes(member.status);
                    } catch (e) {
                        console.error(`Force join check failed for ${ch}:`, e.message);
                        return true; // Assume joined if bot isn't admin in that channel to prevent lockout
                    }
                }));

                if (results.includes(false)) {
                    const keyboard = channels.map(ch => [Markup.button.url(`Join ${ch}`, `https://t.me/${ch.replace('@','')}`)]);
                    keyboard.push([Markup.button.callback('🔄 Try Again', 'check_join')]);
                    
                    const msg = "❌ **Access Denied**\n\nYou must join all our channels to use this bot.";
                    if (ctx.callbackQuery) {
                        await ctx.answerCbQuery("Still not joined!", { show_alert: true });
                    } else {
                        await ctx.reply(msg, Markup.inlineKeyboard(keyboard));
                    }
                    return;
                }
            }
            return next();
        });

        // Start Command & Referral System
        this.bot.start(async (ctx) => {
            const userId = ctx.from.id.toString();
            const username = ctx.from.username || 'User';
            const refId = ctx.startPayload;

            db.get("SELECT * FROM users WHERE bot_token = ? AND user_id = ?", [this.config.token, userId], async (err, user) => {
                if (!user) {
                    const referrer = (refId && refId !== userId) ? refId : null;
                    db.run("INSERT INTO users (bot_token, user_id, username, referred_by) VALUES (?, ?, ?, ?)", 
                        [this.config.token, userId, username, referrer]);
                    
                    if (referrer) {
                        db.run("UPDATE users SET points = points + 10 WHERE bot_token = ? AND user_id = ?", [this.config.token, referrer]);
                        try { this.bot.telegram.sendMessage(referrer, `🎁 Someone joined using your link! You earned 10 points.`); } catch(e){}
                    }

                    // Notify Admin
                    try {
                        await this.bot.telegram.sendMessage(this.config.admin_id, `🆕 <b>New User</b>\nName: ${username}\nID: <code>${userId}</code>\nRef: ${referrer || 'Direct'}`, { parse_mode: 'HTML' });
                    } catch(e){}
                }
                this.sendWelcome(ctx);
            });
        });

        // Referral Stats Command
        this.bot.command('referral', (ctx) => {
            db.get("SELECT points, (SELECT COUNT(*) FROM users WHERE referred_by = ?) as ref_count FROM users WHERE user_id = ? AND bot_token = ?", 
            [ctx.from.id, ctx.from.id, this.config.token], (err, row) => {
                const link = `https://t.me/${ctx.botInfo.username}?start=${ctx.from.id}`;
                ctx.reply(`📊 <b>Your Statistics</b>\n\nTotal Referrals: ${row?.ref_count || 0}\nPoints Earned: ${row?.points || 0}\n\n🔗 <b>Your Referral Link:</b>\n${link}`, { parse_mode: 'HTML' });
            });
        });

        // Handle Force Join "Try Again"
        this.bot.action('check_join', (ctx) => this.sendWelcome(ctx));
    }

    async sendWelcome(ctx) {
        const { welcome_msg, welcome_type, welcome_media, welcome_buttons, parse_mode } = this.config;
        
        let extra = { parse_mode: parse_mode || 'HTML' };
        if (welcome_buttons) {
            try {
                const btns = JSON.parse(welcome_buttons);
                extra.reply_markup = { inline_keyboard: btns };
            } catch (e) { console.error("Button parsing error", e); }
        }

        try {
            switch (welcome_type) {
                case 'photo': await ctx.replyWithPhoto(welcome_media, { caption: welcome_msg, ...extra }); break;
                case 'video': await ctx.replyWithVideo(welcome_media, { caption: welcome_msg, ...extra }); break;
                case 'animation': await ctx.replyWithAnimation(welcome_media, { caption: welcome_msg, ...extra }); break;
                case 'audio': await ctx.replyWithAudio(welcome_media, { caption: welcome_msg, ...extra }); break;
                case 'document': await ctx.replyWithDocument(welcome_media, { caption: welcome_msg, ...extra }); break;
                default: await ctx.reply(welcome_msg, extra);
            }
        } catch (e) {
            console.error("Welcome send error:", e.message);
            ctx.reply(welcome_msg, extra).catch(() => {});
        }
    }
}

/**
 * GLOBAL ENGINE STATE
 */
const activeInstances = {}; // token_hash -> BotInstance

async function loadBots() {
    db.all("SELECT * FROM bots", (err, rows) => {
        if (err) return;
        rows.forEach(async (row) => {
            if (row.status === 'active') {
                const instance = new BotInstance(row);
                const path = await instance.initWebhook();
                activeInstances[row.token] = instance;
                // Dynamically create the express route for this bot
                app.post(path, (req, res) => instance.bot.handleUpdate(req.body, res));
            }
        });
    });
}

/**
 * REST API ROUTES
 */
app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

// 1. Dashboard Stats
app.get('/api/stats', (req, res) => {
    const stats = {};
    db.get("SELECT COUNT(*) as total FROM bots", (err, r) => {
        stats.total_bots = r.total;
        db.get("SELECT COUNT(*) as total FROM users", (err, r2) => {
            stats.total_users = r2.total;
            db.get("SELECT COUNT(*) as total FROM users WHERE joined_at > date('now')", (err, r3) => {
                stats.today_users = r3.total;
                res.json(stats);
            });
        });
    });
});

// 2. Add/Verify Bot
app.post('/api/bots/add', async (req, res) => {
    const { token, admin_id } = req.body;
    if (!token || !admin_id) return res.status(400).json({ error: "Missing fields" });

    try {
        const temp = new Telegraf(token);
        const me = await temp.telegram.getMe();
        
        db.run(`INSERT OR REPLACE INTO bots (token, admin_id, username, status) VALUES (?, ?, ?, 'active')`,
            [token, admin_id, me.username], async function(err) {
                if (err) return res.status(500).json({ error: err.message });
                
                const instance = new BotInstance({ token, admin_id, username: me.username, status: 'active', welcome_msg: 'Welcome!' });
                const path = await instance.initWebhook();
                activeInstances[token] = instance;
                app.post(path, (req, res) => instance.bot.handleUpdate(req.body, res));
                
                res.json({ success: true, username: me.username });
            });
    } catch (e) {
        res.status(400).json({ error: "Invalid Telegram Token" });
    }
});

// 3. Update Bot Settings (Hot-Reload)
app.post('/api/bots/update', (req, res) => {
    const { token, welcome_msg, welcome_type, welcome_media, welcome_buttons, force_channels, parse_mode } = req.body;
    
    db.run(`UPDATE bots SET welcome_msg=?, welcome_type=?, welcome_media=?, welcome_buttons=?, force_channels=?, parse_mode=? WHERE token=?`,
    [welcome_msg, welcome_type, welcome_media, welcome_buttons, force_channels, parse_mode, token], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        
        // Hot-reload instance
        if (activeInstances[token]) {
            activeInstances[token].updateConfig(req.body);
        }
        res.json({ success: true });
    });
});

// 4. Advanced Broadcast Engine
app.post('/api/bots/broadcast', (req, res) => {
    const { token, message, type, media, buttons } = req.body;
    const instance = activeInstances[token];
    if (!instance) return res.status(404).json({ error: "Bot not active" });

    db.all("SELECT user_id FROM users WHERE bot_token = ?", [token], async (err, users) => {
        if (!users || users.length === 0) return res.json({ success: true, count: 0 });

        let success = 0;
        let fail = 0;
        
        let extra = { parse_mode: 'HTML' };
        if (buttons) {
            try { extra.reply_markup = { inline_keyboard: JSON.parse(buttons) }; } catch(e){}
        }

        // Process in background to prevent timeout
        res.json({ success: true, total: users.length, status: "Started" });

        for (const user of users) {
            try {
                switch (type) {
                    case 'photo': await instance.bot.telegram.sendPhoto(user.user_id, media, { caption: message, ...extra }); break;
                    case 'video': await instance.bot.telegram.sendVideo(user.user_id, media, { caption: message, ...extra }); break;
                    case 'animation': await instance.bot.telegram.sendAnimation(user.user_id, media, { caption: message, ...extra }); break;
                    case 'document': await instance.bot.telegram.sendDocument(user.user_id, media, { caption: message, ...extra }); break;
                    default: await instance.bot.telegram.sendMessage(user.user_id, message, extra);
                }
                success++;
            } catch (e) {
                fail++;
            }
            // Small delay to avoid flood limits
            await new Promise(r => setTimeout(r, 50)); 
        }

        db.run("INSERT INTO broadcast_logs (bot_token, total_targets, success_count, fail_count, status) VALUES (?, ?, ?, ?, 'completed')",
            [token, users.length, success, fail]);
    });
});

// 5. Bot Lifecycle Control
app.post('/api/bots/control', async (req, res) => {
    const { token, action } = req.body;
    const instance = activeInstances[token];

    if (action === 'stop') {
        if (instance) {
            await instance.bot.telegram.deleteWebhook();
            delete activeInstances[token];
        }
        db.run("UPDATE bots SET status = 'stopped' WHERE token = ?", [token]);
    } else if (action === 'start' || action === 'restart') {
        db.get("SELECT * FROM bots WHERE token = ?", [token], async (err, row) => {
            if (instance) await instance.bot.telegram.deleteWebhook();
            const newInst = new BotInstance(row);
            const path = await newInst.initWebhook();
            activeInstances[token] = newInst;
            app.post(path, (req, res) => newInst.bot.handleUpdate(req.body, res));
            db.run("UPDATE bots SET status = 'active' WHERE token = ?", [token]);
        });
    } else if (action === 'delete') {
        if (instance) await instance.bot.telegram.deleteWebhook();
        delete activeInstances[token];
        db.run("DELETE FROM bots WHERE token = ?", [token]);
        db.run("DELETE FROM users WHERE bot_token = ?", [token]);
    }
    res.json({ success: true });
});

// 6. Get Bots List
app.get('/api/bots', (req, res) => {
    db.all(`SELECT b.*, 
        (SELECT COUNT(*) FROM users u WHERE u.bot_token = b.token) as total_users,
        (SELECT points FROM users u WHERE u.bot_token = b.token ORDER BY points DESC LIMIT 1) as top_points
        FROM bots b`, (err, rows) => {
        res.json(rows || []);
    });
});

/**
 * STARTUP
 */
app.listen(PORT, () => {
    console.log(`>>> Platform running on ${DOMAIN}`);
    loadBots();
});

// Error Handling
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
