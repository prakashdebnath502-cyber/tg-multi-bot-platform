const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DOMAIN = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

// --- DATABASE INITIALIZATION ---
const db = new sqlite3.Database('./database.sqlite');
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS bots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token TEXT UNIQUE,
        admin_id TEXT,
        username TEXT,
        status TEXT DEFAULT 'active',
        welcome_msg TEXT DEFAULT 'Welcome to the bot!',
        welcome_type TEXT DEFAULT 'text',
        welcome_media TEXT,
        welcome_buttons TEXT,
        parse_mode TEXT DEFAULT 'HTML',
        force_channels TEXT DEFAULT ''
    )`);

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
});

// --- BOT INSTANCE CLASS ---
const activeInstances = {};

class BotInstance {
    constructor(config) {
        this.config = config;
        this.bot = new Telegraf(config.token);
        this.setupHandlers();
    }

    async init() {
        const secretPath = `/telegraf/${this.config.token.split(':')[1]}`;
        await this.bot.telegram.setWebhook(`${DOMAIN}${secretPath}`);
        return secretPath;
    }

    updateConfig(newConfig) {
        this.config = { ...this.config, ...newConfig };
    }

    setupHandlers() {
        // Force Join Middleware
        this.bot.use(async (ctx, next) => {
            if (!ctx.from || !this.config.force_channels) return next();
            const channels = this.config.force_channels.split(',').map(c => c.trim()).filter(c => c);
            if (channels.length === 0 || ctx.callbackQuery?.data === 'check_join' || ctx.message?.text === '/start') return next();

            for (const ch of channels) {
                try {
                    const member = await ctx.telegram.getChatMember(ch, ctx.from.id);
                    if (['left', 'kicked'].includes(member.status)) {
                        return ctx.reply(`❌ Join our channels to use this bot:\n${channels.join('\n')}`, 
                            Markup.inlineKeyboard([[Markup.button.callback("🔄 I have joined", "check_join")]]));
                    }
                } catch (e) { console.error("FJ Error", e.message); }
            }
            return next();
        });

        this.bot.start(async (ctx) => {
            const userId = ctx.from.id.toString();
            const refId = ctx.startPayload;
            
            db.run("INSERT OR IGNORE INTO users (bot_token, user_id, username, referred_by) VALUES (?, ?, ?, ?)", 
                [this.config.token, userId, ctx.from.username || 'User', refId], (err) => {
                if (!err && refId && refId !== userId) {
                    db.run("UPDATE users SET points = points + 10 WHERE bot_token = ? AND user_id = ?", [this.config.token, refId]);
                }
            });

            this.sendWelcome(ctx);
        });

        this.bot.action('check_join', (ctx) => this.sendWelcome(ctx));
    }

    async sendWelcome(ctx) {
        const { welcome_msg, welcome_type, welcome_media, welcome_buttons, parse_mode } = this.config;
        let extra = { parse_mode: parse_mode || 'HTML' };
        if (welcome_buttons) {
            try { extra.reply_markup = { inline_keyboard: JSON.parse(welcome_buttons) }; } catch(e){}
        }

        try {
            if (welcome_type === 'photo') await ctx.replyWithPhoto(welcome_media, { caption: welcome_msg, ...extra });
            else if (welcome_type === 'video') await ctx.replyWithVideo(welcome_media, { caption: welcome_msg, ...extra });
            else if (welcome_type === 'animation') await ctx.replyWithAnimation(welcome_media, { caption: welcome_msg, ...extra });
            else await ctx.reply(welcome_msg, extra);
        } catch (e) { ctx.reply(welcome_msg, extra).catch(() => {}); }
    }
}

// --- API ROUTES ---
app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

app.get('/api/stats', (req, res) => {
    db.get("SELECT COUNT(*) as b, (SELECT COUNT(*) FROM users) as u FROM bots", (err, row) => {
        res.json({ total_bots: row.b, total_users: row.u, today_users: 0 });
    });
});

app.get('/api/bots', (req, res) => {
    db.all("SELECT *, (SELECT COUNT(*) FROM users WHERE bot_token = bots.token) as total_users FROM bots", (err, rows) => {
        res.json(rows || []);
    });
});

app.get('/api/users', (req, res) => {
    db.all("SELECT * FROM users ORDER BY joined_at DESC LIMIT 100", (err, rows) => res.json(rows || []));
});

app.post('/api/bots/add', async (req, res) => {
    const { token, admin_id } = req.body;
    try {
        const temp = new Telegraf(token);
        const me = await temp.telegram.getMe();
        db.run("INSERT INTO bots (token, admin_id, username) VALUES (?, ?, ?)", [token, admin_id, me.username], async (err) => {
            if (err) return res.status(400).json({ error: "Duplicate Bot" });
            const inst = new BotInstance({ token, admin_id, username: me.username });
            const path = await inst.init();
            app.post(path, (req, res) => inst.bot.handleUpdate(req.body, res));
            activeInstances[token] = inst;
            res.json({ success: true });
        });
    } catch (e) { res.status(400).json({ error: "Invalid Token" }); }
});

app.post('/api/bots/update', (req, res) => {
    const c = req.body;
    db.run(`UPDATE bots SET welcome_msg=?, welcome_type=?, welcome_media=?, welcome_buttons=?, force_channels=? WHERE token=?`,
    [c.welcome_msg, c.welcome_type, c.welcome_media, c.welcome_buttons, c.force_channels, c.token], () => {
        if (activeInstances[c.token]) activeInstances[c.token].updateConfig(c);
        res.json({ success: true });
    });
});

app.post('/api/bots/control', (req, res) => {
    const { token, action } = req.body;
    if (action === 'delete') {
        db.run("DELETE FROM bots WHERE token = ?", [token]);
        delete activeInstances[token];
    }
    res.json({ success: true });
});

// --- STARTUP ---
db.all("SELECT * FROM bots WHERE status = 'active'", (err, rows) => {
    if (rows) rows.forEach(async row => {
        const inst = new BotInstance(row);
        const path = await inst.init();
        app.post(path, (req, res) => inst.bot.handleUpdate(req.body, res));
        activeInstances[row.token] = inst;
    });
});

app.listen(PORT, () => console.log(`Dashboard Live: ${DOMAIN}`));
