require('dotenv').config(); // MUST BE LINE 1
const CONFIG = {
    API_BASE: ""
};
const path = require('path');
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const http = require('http');
const https = require('https');
const cors = require('cors');
const { Server } = require('socket.io');
const fs = require('fs').promises;
const { google } = require('googleapis');
const youtubedl = require('youtube-dl-exec');

// Run Boxedwine Upgrade once to update assets to 26R1.0
(async () => {
    try {
        const fsNormal = require('fs');
        const readmePath = path.join(__dirname, 'public', 'boxedwine', 'v1', 'readme.txt');
        let needsUpgrade = true;
        if (fsNormal.existsSync(readmePath)) {
            const content = fsNormal.readFileSync(readmePath, 'utf8');
            if (content.includes('26R1')) {
                needsUpgrade = false;
            }
        }
        if (needsUpgrade) {
            const runUpgrade = require('./upgrade-boxedwine');
            await runUpgrade();
        } else {
            console.log("Boxedwine is already upgraded to version 26R1.0 (Skipped download)");
        }
    } catch (e) {
        console.error("Auto Upgrade Error:", e);
    }
})();

// 1. Models
const User = require(path.join(__dirname, 'models', 'User.js')); 
const Division = require(path.join(__dirname, 'models', 'divisions.js'));
const IntelCache = require(path.join(__dirname, 'models', 'IntelCache.js'));
const AdminToken = require(path.join(__dirname, 'models', 'AdminToken.js'));
const FormResponse = require(path.join(__dirname, 'models', 'FormResponse.js'));

const ROBLOX_FALLBACK_IMAGE = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxNTAiIGhlaWdodD0iMTUwIiB2aWV3Qm94PSIwIDAgMjQgMjQiIGZpbGw9Im5vbmUiIHN0cm9rZT0iIzU1NTU1NSIgc3Ryb2tlLXdpZHRoPSIxLjUiPjxyZWN0IHdpZHRoPSIyNCIgaGVpZHRoPSIyNCIgcng9IjIiIGZpbGw9IiMwZDBkMGQiLz48cGF0aCBkPSJNMTggMjFhNiA2IDAgMCAwLTEyIDAiLz48Y2lyY2xlIGN4PSIxMiIgY3k9IjEwIiByPSI0Ii8+PC9zdmc+";

const rbApi = (subdomain, endpoint) => {
    // Route to Cloudflare worker on api.vanguard-terminal.me as requested
    return `https://api.vanguard-terminal.me/roblox/${subdomain}${endpoint}`;
};

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Real-time Event Broadcaster
const broadcastSecurityEvent = (type, data) => {
    io.emit('vanguard_event', { type, data, timestamp: new Date() });
};

// 2. Middleware & Cache Setup
axios.defaults.headers.common['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const axiosAgent = new https.Agent({ keepAlive: true });
axios.defaults.httpsAgent = axiosAgent;

app.use(cors());
app.use(express.json()); // Essential for POST requests
app.use(express.static(path.join(__dirname, 'public'), {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.wasm')) {
            res.setHeader('Content-Type', 'application/wasm');
            res.setHeader('Content-Encoding', 'identity');
        } else if (filePath.endsWith('.zip') || filePath.endsWith('.jsdos')) {
            res.setHeader('Content-Type', 'application/zip');
            res.setHeader('Content-Encoding', 'identity');
        }
    }
}));

// 2.5 Roblox Request Queue & Intelligence Throttling
class RobloxRequestQueue {
    constructor(batchSize = 5, delay = 1000) {
        this.queue = [];
        this.processing = false;
        this.batchSize = batchSize;
        this.delay = delay;
        // Map to track requests that are currently in-flight or in-queue to avoid duplicates
        this.pendingRequests = new Map(); // Key -> Promise
    }

    async enqueue(url, options = {}, method = 'get', body = null, retries = 5) {
        // Automatically inject Cloudflare Worker authorization secret if using the custom api
        if (url && url.includes('api.vanguard-terminal.me')) {
            options = options || {};
            options.headers = options.headers || {};
            options.headers['X-Proxy-Secret'] = process.env.PROXY_SECRET || 'V3R1745_357_Qu0d_53RV47uR!';
            options.headers['Accept'] = 'application/json';
        }

        // Create a unique key for the request to prevent duplicate bursts
        const key = `${method}:${url}:${body ? JSON.stringify(body) : ''}`;

        if (this.pendingRequests.has(key)) {
            console.log(`[QUEUE] deduplicating request: ${url}`);
            return this.pendingRequests.get(key);
        }

        const promise = new Promise((resolve, reject) => {
            this.queue.push({ url, options, method, body, resolve, reject, retries, attempt: 0 });
            this._process();
        });

        this.pendingRequests.set(key, promise);
        
        try {
            const result = await promise;
            return result;
        } finally {
            // Clean up after completion (success or failure)
            this.pendingRequests.delete(key);
        }
    }

    async _process() {
        if (this.processing || this.queue.length === 0) return;
        this.processing = true;

        const PROXY_ROTATION = ['rotunnel.com', 'roproxy.com', 'rproxy.xyz'];

        while (this.queue.length > 0) {
            const batch = this.queue.splice(0, this.batchSize);
            console.log(`[QUEUE] Processing batch of ${batch.length}. Remaining in queue: ${this.queue.length}`);

            await Promise.allSettled(batch.map(async (item) => {
                try {
                    let response;
                    if (item.method === 'get') {
                        response = await axios.get(item.url, item.options);
                    } else if (item.method === 'post') {
                        response = await axios.post(item.url, item.body, item.options);
                    }
                    item.resolve(response);
                } catch (error) {
                    const status = error.response?.status;
                    const isRetryable = status === 401 || status === 429 || (status >= 500 && status <= 504);
                    
                    if (isRetryable && item.attempt < item.retries) {
                        item.attempt++;
                        
                        // Proxy Rotation on 401 or certain 5xx errors
                        if (status === 401 || status === 502 || status === 503) {
                            for (let i = 0; i < PROXY_ROTATION.length - 1; i++) {
                                if (item.url.includes(PROXY_ROTATION[i])) {
                                    item.url = item.url.replace(PROXY_ROTATION[i], PROXY_ROTATION[i+1]);
                                    console.warn(`[QUEUE] 🔄 Proxy Rotation for ${status}: Swapped to ${PROXY_ROTATION[i+1]} [Attempt ${item.attempt}]`);
                                    break;
                                }
                            }
                        }

                        const baseDelay = status === 429 ? 12000 : 3000;
                        const backoff = baseDelay * Math.pow(2, item.attempt - 1);
                        console.warn(`[QUEUE] HTTP ${status} detected for ${item.url}. Retrying in ${backoff}ms (Attempt ${item.attempt}/${item.retries})`);
                        
                        setTimeout(() => {
                            this.queue.push(item);
                            this._process();
                        }, backoff);
                    } else {
                        if (status === 401) {
                            console.error(`[QUEUE] ❌ Periodic 401 failure persisted for ${item.url}. Request rejected.`);
                        }
                        item.reject(error);
                    }
                }
            }));

            if (this.queue.length > 0 && this.delay > 0) {
                // Wait between batches to prevent rate limits
                console.log(`[QUEUE] cooldown delay (${this.delay}ms)...`);
                await new Promise(r => setTimeout(r, this.delay));
            }
        }

        this.processing = false;
    }
}

const robloxQueue = new RobloxRequestQueue(1, 1000); // reduced batch for proxy stability

// Google Sheets Auth Helper
const getSheetsClient = () => {
    try {
        const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
        let privateKey = process.env.GOOGLE_PRIVATE_KEY;

        if (!clientEmail || !privateKey) {
            console.warn("⚠️ Google Sheets credentials missing in .env");
            return null;
        }

        // Robust key cleaning
        privateKey = privateKey.trim();
        
        // Remove wrapping quotes if they exist (supports single and double)
        if ((privateKey.startsWith('"') && privateKey.endsWith('"')) ||
            (privateKey.startsWith("'") && privateKey.endsWith("'"))) {
            privateKey = privateKey.substring(1, privateKey.length - 1);
        }
        
        // Convert literal \n strings to actual newlines
        privateKey = privateKey.replace(/\\n/g, '\n');

        if (!privateKey.includes("BEGIN PRIVATE KEY")) {
            console.warn("⚠️ GOOGLE_PRIVATE_KEY is invalid. It doesn't contain the PEM header.");
            return null;
        }

        console.log(`[SHEETS] Attempting Uplink. Email: ${clientEmail.substring(0, 15)}... Key Length: ${privateKey.length}`);

        const auth = new google.auth.GoogleAuth({
            credentials: {
                client_email: clientEmail,
                private_key: privateKey
            },
            scopes: ['https://www.googleapis.com/auth/spreadsheets']
        });

        const sheets = google.sheets({ version: 'v4', auth });
        return sheets;
    } catch (err) {
        console.error("Sheets Init Error:", err.message);
        return null;
    }
};

const groupCache = new Map();
const CACHE_TTL = 300000; // 5 minutes in ms

// 3. Webhook Logger Utility
const logAction = async (user, action, details, color = 3447003) => {
    try {
        if (!process.env.DISCORD_WEBHOOK_URL) return;
        
        const operative = user && user.username ? user.username : (user && user.id ? `ID: ${user.id}` : "Unknown System");
        const scope = user && user.scope ? user.scope : "N/A";

        await axios.post(process.env.DISCORD_WEBHOOK_URL, {
            embeds: [{
                title: "VANGUARD AUDIT LOG",
                fields: [
                    { name: "OPERATIVE", value: `**${operative}**`, inline: true },
                    { name: "UNIT_SCOPE", value: scope, inline: true },
                    { name: "ACTION", value: `\`${action}\``, inline: true },
                    { name: "DETAILS", value: details }
                ],
                color: color,
                timestamp: new Date(),
                footer: { text: "GSMC Operational Intelligence | Audit Protocol" }
            }]
        });

        // Broadcast to all connected terminals
        broadcastSecurityEvent('AUDIT_LOG', {
            operative,
            scope,
            action,
            details,
            color
        });
    } catch (err) {
        console.error("Audit Log Failed:", err.message);
    }
};

// 4. Tier Limiter Middleware (Must be defined before routes)
const protectTier = (requiredTier) => {
    return (req, res, next) => {
        const authHeader = req.header('Authorization');
        const token = authHeader ? authHeader.replace('Bearer ', '') : req.header('x-auth-token');

        if (!token) return res.status(401).json({ message: "No token, access denied." });

        if (token === process.env.INTERNAL_BOT_API_KEY) {
            req.user = { id: 'SYSTEM_BOT', username: 'SYSTEM_BOT', tier: 5, unitScope: 'ALL' };
            req.userTier = 5;
            return next();
        }

        try {
            const decoded = jwt.verify(token, process.env.JWT_SECRET);
            
            // Legacy token handling: if username is missing, we still allow but logAction will show ID
            req.user = decoded;
            req.userTier = decoded.tier;

            if (req.user.tier < requiredTier) {
                return res.status(403).json({ 
                    message: `Access Denied: Requires Tier ${requiredTier}. Your Tier: ${req.user.tier}` 
                });
            }
            next();
        } catch (err) {
            res.status(401).json({ message: "Token is not valid or expired." });
        }
    };
};

// 4. Database Connection
if (!process.env.MONGODB_URI) {
    console.error("❌ CRITICAL: MONGODB_URI is missing in environment variables!");
} else {
    console.log("📡 Attempting MongoDB Uplink...");
    mongoose.connect(process.env.MONGODB_URI)
    .then(async () => {
        console.log("✅ MongoDB Connected Successfully");
        
        // Bootstrap Default User if Empty
        try {
            const count = await User.countDocuments();
            if (count === 0) {
                console.log("🚀 Bootstrapping default CBRN Admin...");
                await User.create({
                    username: "CBRN_Admin",
                    password: "CBRN123", // No longer hashing default bootstrap
                    tier: 5,
                    unitScope: "CBRN"
                });
                console.log("✅ Created default account: CBRN_Admin / CBRN123");
            }

            // Bootstrap GSMC Sub-Divisions
            const gsmcDiv = await Division.findOne({ name: "GSMC" });
            const gsmcSubUnits = [
                { name: "TEMS", groupId: 683312869 },
                { name: "6AAU", groupId: 503205291 },
                { name: "AMC", groupId: 1111522787 },
                { name: "MEDSOC", groupId: 842973315 },
                { name: "MEI", groupId: 940557434 },
                { name: "NS", groupId: 1008942731 }
            ];

            if (!gsmcDiv) {
                console.log("🚀 Initializing GSMC Sub-Division Database...");
                await Division.create({ name: "GSMC", subUnits: gsmcSubUnits });
            } else {
                // Update existing subunit IDs if they changed
                let changed = false;
                gsmcSubUnits.forEach(newSub => {
                    const existing = gsmcDiv.subUnits.find(s => s.name === newSub.name);
                    if (!existing || existing.groupId !== newSub.groupId) {
                        if (!existing) gsmcDiv.subUnits.push(newSub);
                        else existing.groupId = newSub.groupId;
                        changed = true;
                    }
                });
                if (changed) {
                    await gsmcDiv.save();
                    console.log("✅ GSMC Sub-Divisions Synchronized.");
                }
            }
        } catch (bootErr) {
            console.error("❌ Bootstrap Error:", bootErr.message);
        }
    })
    .catch(err => {
        console.error("❌ MongoDB Connection Error:", err.message);
        console.error("Check if your Mongo Atlas whitelist includes IP 0.0.0.0/0");
    });
}

// 🩺 Debug: Database Status
app.get('/system/status', (req, res) => {
    res.json({
        database: mongoose.connection.readyState === 1 ? "ONLINE" : "OFFLINE",
        uptime: process.uptime(),
        env: process.env.NODE_ENV || "development"
    });
});

// --- ROUTES ---

// Discord Bot Linking Route
app.post('/api/v1/generate-token', async (req, res) => {
    const overrideKey = req.header('x-override-key');
    if (!overrideKey || overrideKey !== process.env.OVERRIDE_KEY) {
        return res.status(401).json({ error: 'Invalid override key.' });
    }

    const { targetUser, assignedTier, scope } = req.body;
    if (!targetUser || !assignedTier || !scope) {
        return res.status(400).json({ error: 'Missing targetUser, assignedTier, or scope payload' });
    }

    try {
        const token = 'TOKEN-TIER' + assignedTier + '-' + Math.random().toString(36).substring(2, 8).toUpperCase();
        
        const adminToken = new AdminToken({
            token,
            assignedTier: Number(assignedTier),
            targetUser,
            scope
        });
        await adminToken.save();

        return res.status(200).json({ token, targetUser, assignedTier, scope });
    } catch (err) {
        console.error('[GENERATE TOKEN ERROR]:', err);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/v1/link-discord', async (req, res) => {
    const authHeader = req.header('Authorization');
    
    // 1. Validate internal API Key
    if (!authHeader || authHeader !== `Bearer ${process.env.INTERNAL_BOT_API_KEY}`) {
        return res.status(401).json({ error: 'Unauthorized: Invalid internal API key.' });
    }

    const { token, discordId } = req.body;
    if (!token || !discordId) {
        return res.status(400).json({ error: 'Missing token or discordId payload' });
    }

    try {
        // 2. Validate token
        const tokenRecord = await AdminToken.findOne({ token });
        if (!tokenRecord) {
            return res.status(404).json({ error: 'Invalid activation token.' });
        }
        if (tokenRecord.isUsed) {
            return res.status(400).json({ error: 'Token has already been used.' });
        }

        // 3. Ensure discordId isn't already bound
        const existingUser = await User.findOne({ discordUserId: discordId });
        if (existingUser) {
            return res.status(409).json({ error: `Discord account is already bound to profile: ${existingUser.username}` });
        }

        // 4. Locate the profile tied to the token
        let userProfile = await User.findOne({ username: tokenRecord.targetUser });
        let generatedPassword = null;
        if (!userProfile) {
            // Generate a real password and hash it
            generatedPassword = Math.random().toString(36).substring(2, 10).toUpperCase() + Math.random().toString(36).substring(2, 5);
            const hashedPassword = await bcrypt.hash(generatedPassword, 10);
            
            // Auto-deploy profile if not found to ensure tokens always work
            userProfile = new User({
                username: tokenRecord.targetUser,
                password: hashedPassword,
                tier: tokenRecord.assignedTier,
                unitScope: tokenRecord.scope || 'Field Ops',
                discordUserId: discordId
            });
        } else {
            // Bind discordId and update tier
            userProfile.discordUserId = discordId;
            userProfile.tier = tokenRecord.assignedTier;
            userProfile.unitScope = tokenRecord.scope || userProfile.unitScope;
        }

    // 5. Flip token status
    tokenRecord.isUsed = true;
    tokenRecord.linkedAt = new Date();

    // Atomic save for both documents
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        await userProfile.save({ session });
        await tokenRecord.save({ session });
        await session.commitTransaction();
    } catch (saveError) {
        await session.abortTransaction();
        throw saveError;
    } finally {
        session.endSession();
    }

    return res.status(200).json({ 
        username: userProfile.username, 
        newTier: userProfile.tier,
        temporaryPassword: generatedPassword
    });

    } catch (err) {
        console.error('[LINK DISCORD ERROR]:', err);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

// Auth Verification for Frontend
app.get('/auth/verify', protectTier(2), (req, res) => {
    res.json({ success: true, tier: req.user.tier, unitScope: req.user.scope });
});

// Login (The JWT "Badge" Generator)
app.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        console.log(`[AUTH] Login attempt for: ${username}`);

        const userData = await User.findOne({ username });
        if (!userData) {
            console.warn(`[AUTH] User not found: ${username}`);
            return res.status(400).json({ message: "User not found" });
        }

        // Support both hashed legacy passwords and new plain text passwords
        let isMatch = false;
        if (userData.password.startsWith('$2a$') || userData.password.startsWith('$2b$')) {
            // Likely a hash
            isMatch = await bcrypt.compare(password, userData.password);
        } else {
            // Direct comparison
            isMatch = (password === userData.password);
        }

        if (!isMatch) {
            console.warn(`[AUTH] Invalid credentials for: ${username}`);
            return res.status(400).json({ message: "Invalid credentials" });
        }

        const token = jwt.sign(
            { 
                id: userData._id, 
                username: userData.username, 
                tier: userData.tier, 
                scope: userData.unitScope 
            },
            process.env.JWT_SECRET,
            { expiresIn: '8h' }
        );

        // Discord Webhook Notification
        try {
            await axios.post(process.env.DISCORD_WEBHOOK_URL, {
                embeds: [{
                    title: "GSMC System Access",
                    description: `**Officer:** ${username}\n**Access Tier:** ${userData.tier}\n**Scope:** ${userData.unitScope}`,
                    color: userData.tier === 5 ? 15158332 : 3447003,
                    timestamp: new Date()
                }]
            });
        } catch (webhookErr) { console.error("Webhook Failed"); }

        broadcastSecurityEvent('SESSION_ESTABLISHED', {
            username: userData.username,
            tier: userData.tier,
            scope: userData.unitScope
        });

        res.json({ 
            message: `Welcome back, ${username}`, 
            token, 
            tier: userData.tier,
            unitScope: userData.unitScope
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Safe, Explicit Roblox API Proxy Route to Cloudflare Worker
app.get('/api/proxy/roblox', async (req, res) => {
    try {
        const targetUrl = `https://api.vanguard-terminal.me/roblox/${req.query.subdomain}/${req.query.endpoint}`;

        const response = await fetch(targetUrl, {
            method: 'GET',
            headers: {
                'X-Proxy-Secret': process.env.PROXY_SECRET || 'V3R1745_357_Qu0d_53RV47uR!',
                'Accept': 'application/json'
            }
        });

        const data = await response.json();
        return res.status(response.status).json(data);
    } catch (err) {
        console.error(`[Roblox Worker Proxy Error]:`, err);
        return res.status(500).json({ error: err.message });
    }
});



app.get('/group-info/:groupId', protectTier(2), async (req, res) => {
    const { groupId } = req.params;

    if (!groupId || !/^\d+$/.test(groupId)) {
        return res.status(400).json({ 
            error: 'Invalid Group ID', 
            details: 'Numeric ID required.' 
        });
    }

    // 1. Check Cache
    const cached = groupCache.get(groupId);
    if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
        console.log(`[INTEL] Cache Hit: ${groupId}`);
        return res.json(cached.data);
    }

    try {
        console.log(`[INTEL] Fetching Roblox Data: ${groupId}`);
        // 1. Fetch main group metadata using the controlled queue
        const groupRes = await robloxQueue.enqueue(rbApi('groups', `/v1/groups/${groupId}`), { timeout: 15000 });
        const data = groupRes.data;

        // 2. Fetch roles (ranks) using the controlled queue
        const rolesRes = await robloxQueue.enqueue(rbApi('groups', `/v1/groups/${groupId}/roles`), { timeout: 15000 });
        const roles = rolesRes.data.roles.sort((a, b) => b.rank - a.rank); // Sort by rank level desc

        const result = {
            name: data.name,
            memberCount: data.memberCount,
            description: data.description,
            owner: data.owner ? {
                username: data.owner.username,
                userId: data.owner.userId
            } : { username: "None", userId: 0 },
            shout: data.shout ? data.shout.body : null,
            roles: roles.map(r => ({ name: r.name, rank: r.rank, memberCount: r.memberCount }))
        };

        // Audit Log
        logAction(req.user, "UNIT_INTEL_LOOKUP", `**Target Unit:** ${data.name}\n**ID:** ${groupId}`);

        // Cache result
        groupCache.set(groupId, {
            timestamp: Date.now(),
            data: result
        });

        res.json(result);

    } catch (error) {
        if (error.response?.status === 429) {
            console.warn(`[INTEL] ⚠️ Roblox Rate Limit (429) on Intel.`);
            return res.status(429).json({ 
                error: 'Uplink Congested', 
                message: 'Roblox is limiting requests. Please try again in a few minutes.' 
            });
        }
        const requestUrl = error.config?.url || "Unknown URL";
        console.error(`Group API Error [${requestUrl}]:`, error.message);
        if (error.response) {
            console.error('Response Data:', JSON.stringify(error.response.data));
        }
        res.status(500).json({ 
            error: 'Failed to fetch unit data', 
            message: error.message,
            debug_url: requestUrl
        });
    }
});



// Unified Verification Route
app.get('/verify-member/:unitName/:username', protectTier(2), async (req, res) => {
    try {
        const { unitName, username } = req.params;
        if (!username || !username.trim()) {
            return res.status(404).json({ message: "Not in group or name typo" });
        }
        console.log(`Scanning for Unit: "${unitName}"`);

        // 1. Roblox RESOLUTION (Exact -> Fuzzy Fallback)
        console.log(`[SCAN] Resolving Roblox Identity: "${username}"`);
        let userData;
        try {
            // PHASE A: Exact Username Lookup (Robust & High Rate Limit)
            const exactRes = await robloxQueue.enqueue(
                rbApi('users', '/v1/usernames/users'), 
                { timeout: 15000 }, 
                'post', 
                {
                    usernames: [username.trim()],
                    excludeBannedUsers: false
                }
            );
            
            userData = exactRes.data.data[0];

            // PHASE B: Fuzzy Search Fallback (Only if exact fails)
            if (!userData) {
                console.log(`[SCAN] No exact match for "${username}". Attempting fuzzy search...`);
                // limit=1 is more economical for fuzzy search
                const searchRes = await robloxQueue.enqueue(rbApi('users', `/v1/users/search?keyword=${encodeURIComponent(username.trim())}&limit=1`), { timeout: 15000 });
                userData = searchRes.data.data[0];
            }
        } catch (rbErr) {
            const status = rbErr.response?.status;
            const requestUrl = rbErr.config?.url || "Unknown URL";
            
            if (status === 429) {
                console.warn(`[SCAN] ⚠️ Roblox Rate Limit (429) Enforced.`);
                return res.status(429).json({ message: "Uplink Congested" });
            }
            if (status === 400) {
                console.warn(`[SCAN] Roblox API rejected request (400): Malformed username "${username}"`);
                return res.status(404).json({ message: "Not in group or name typo" });
            }
            console.error(`[SCAN] Roblox API Error: ${status || rbErr.message} at ${requestUrl}`);
            if (rbErr.response) {
                console.error('Response Data:', JSON.stringify(rbErr.response.data));
            }
            return res.status(500).json({ message: `Uplink Error ${status || ''}`, debug_url: requestUrl });
        }

        if (!userData) {
            console.warn(`[SCAN] Roblox Keyword NOT FOUND: "${username}"`);
            return res.status(404).json({ message: "Not in group or name typo" });
        }
        
        // 1.5 Find Target Unit
        let unit = null;
        try {
            const Division = mongoose.model('Division'); // Ensure access to model
            const division = await Division.findOne({ "subUnits.name": unitName });
            unit = division?.subUnits.find(u => u.name === unitName);
            
            if (!unit && /^\d+$/.test(unitName)) {
                unit = { name: "Direct Uplink", groupId: parseInt(unitName) };
            }
        } catch (dbErr) {
            console.error(`[SCAN] Database Error: ${dbErr.message}`);
        }

        if (!unit) {
            return res.status(404).json({ message: "Unit Not Configured" });
        }

        const rbId = userData.id;
        const robloxUsername = userData.name; // This is the REAL current username
        console.log(`[SCAN] ✅ Found: ${username} -> ${rbId} (${robloxUsername})`);

        // Audit Log
        logAction(req.user, "PERSONNEL_SCAN", `**Subject:** ${robloxUsername}\n**Unit:** ${unitName}\n**ID:** ${rbId}`);

        // 2. Rank Check (Enhanced for all Sub-Divisions)
        let groupData = null;
        let nsGroupData = null;
        let subDivisions = [];
        const NS_GROUP_ID = "1008942731";

        try {
            const rbRes = await robloxQueue.enqueue(rbApi('groups', `/v1/users/${rbId}/groups/roles`));
            const groups = rbRes.data.data;
            
            groupData = groups.find(g => g.group.id == unit.groupId);
            if (!groupData) {
                return res.status(404).json({ message: "Not in group or name typo" });
            }
            nsGroupData = groups.find(g => g.group.id == NS_GROUP_ID);

            // Fetch all known subunits from DB to map them
            const allDivs = await mongoose.model('Division').find({});
            const subUnitList = allDivs.flatMap(d => d.subUnits);

            const groupIds = [...new Set(groups.map(g => g.group?.id))].filter(id => id).slice(0, 100).join(',');
            let iconsMap = {};
            if (groupIds) {
                try {
                    const iconRes = await robloxQueue.enqueue(rbApi('thumbnails', `/v1/groups/icons?groupIds=${groupIds}&size=150x150&format=Png&isCircular=false`), { timeout: 15000 });
                    iconRes.data?.data?.forEach(i => {
                        if (i.targetId) iconsMap[i.targetId] = i.imageUrl;
                    });
                } catch (iconErr) {
                    console.warn(`[SCAN] Failed to fetch group icons: ${iconErr.response?.status || iconErr.message}`);
                }
            }

            groups.forEach(g => {
                const matchedSub = subUnitList.find(s => s.groupId == g.group.id);
                if (matchedSub) {
                    let displayName = matchedSub.name;
                    if (displayName.toUpperCase() === "GENERAL STAFF") displayName = "GSMC";
                    
                    subDivisions.push({
                        name: displayName,
                        rank: g.role.name,
                        rankId: g.role.rank,
                        icon: iconsMap[g.group.id] || ""
                    });
                }
            });

        } catch (roleErr) {
            console.error(`[SCAN] Roblox Roles API Error: ${roleErr.message}`);
        }

        // --- ROWIFI VERIFICATION ---
let discordInfo = "Not Linked";

try {
    const guildId = process.env.DISCORD_GUILD_ID;
    const apiKey = (process.env.ROWIFI_API_KEY || "").trim();

    if (guildId && apiKey) {
        // 1. Reverse Lookup (Roblox ID -> Discord Candidates)
        const reverseRes = await axios.get(
            `https://api.rowifi.xyz/v3/guilds/${guildId}/members/roblox/${rbId}`,
            { 
                headers: { 
                    'Authorization': `Bot ${apiKey}` 
                } 
            }
        );

        const data = reverseRes.data;
        let candidates = [];

        if (Array.isArray(data)) {
            candidates = data.map(x => (typeof x === 'object' ? String(x.discord_id) : String(x)));
        } else if (data && data.discord_ids) {
            candidates = data.discord_ids.map(String);
        }

        if (candidates.length > 0) {
            for (const did of candidates) {
                try {
                    const memberRes = await axios.get(
                        `https://api.rowifi.xyz/v3/guilds/${guildId}/members/${did}`,
                        { headers: { 'Authorization': `Bot ${apiKey}` } }
                    );
                    
                    if (String(memberRes.data?.roblox_id) === String(rbId)) {
                        discordInfo = did;
                        console.log(`✅ Verified Link: ${robloxUsername} -> ${did}`);
                        break;
                    }
                } catch (memberErr) {
                    continue;
                }
            }
        }
    } else {
        console.warn("⚠️ RoWifi Integration skipped: Missing Guild ID or API Key");
    }

} catch (err) {
    if (err.response?.status === 401) {
        console.error("❌ 401: Authorization failed. Ensure your key is correct.");
    } else if (err.response?.status === 404) {
        console.log(`ℹ️ No candidates found for ${robloxUsername}`);
    } else {
        console.error(`❌ RoWifi Error: ${err.message}`);
    }
}
// --- END ROWIFI BLOCK ---
        // --- NEW RANK LOGIC (Discord Parity) ---
        let officerStatus = "Enlisted";
        if (groupData) {
            const rankId = groupData.role.rank;
            if (rankId >= 218) officerStatus = "CO";
            else if (rankId >= 213) officerStatus = "NCO";
        }

        let nsStatus = "Enlisted";
        if (nsGroupData) {
            const rankId = nsGroupData.role.rank;
            if (rankId >= 202) nsStatus = "CO";
            else if (rankId >= 9) nsStatus = "NCO";
        }

        // 4. Final Response
        const payload = {
            officer: robloxUsername,
            robloxId: rbId,
            discordId: discordInfo, 
            unit: unitName,
            rank: groupData ? groupData.role.name : "UNASSIGNED",
            rankId: groupData ? groupData.role.rank : 0,
            nsRank: nsGroupData ? nsGroupData.role.name : "—",
            status: officerStatus,
            nsStatus: nsStatus,
            subDivisions: subDivisions
        };

        broadcastSecurityEvent('SCAN_RESULT', payload);
        res.json(payload);

    } catch (err) {
        console.error("Route Error:", err.message);
        res.status(500).json({ error: "Internal System Error: " + err.message });
    }
});

// --- DEEP INTEL ROUTE ---
app.get('/deep-intel/:username', protectTier(2), async (req, res) => {
    try {
        const { username } = req.params;
        const forceRefresh = req.query.refresh === 'true';

        if (!username || !username.trim()) {
            return res.status(404).json({ message: "Not in group or name typo" });
        }

        // 1. Resolve Identity First to get UserId
        let userData;
        try {
            const exactRes = await robloxQueue.enqueue(
                rbApi('users', '/v1/usernames/users'), 
                { timeout: 15000 },
                'post',
                {
                    usernames: [username.trim()],
                    excludeBannedUsers: false
                }
            );
            userData = exactRes.data.data[0];
        } catch (identErr) {
            if (identErr.response?.status === 400) return res.status(404).json({ message: "Not in group or name typo" });
            throw identErr;
        }
        if (!userData) return res.status(404).json({ message: "Not in group or name typo" });

        const userId = userData.id;

        // 2. Check Cache
        const cached = await IntelCache.findOne({ userId });
        if (cached && !forceRefresh) {
            console.log(`[INTEL] Serving Cached Data for: ${userData.name}`);
            return res.json(cached);
        }

        console.log(`[INTEL] Initiating Deep Recon for: ${userData.name} (Force: ${forceRefresh})`);
        
        // Recon Suppression Removed as per Command Directive (Testing RoTunnel)
        const badgePinpointPromise = (async () => {
            let total = 0;
            let cursor = "";
            let attempts = 0;
            let sampleBadges = [];
            const startTime = Date.now();

            try {
                while (attempts < 150) { 
                    const badgeUrl = rbApi('badges', `/v1/users/${userId}/badges?limit=100&cursor=${cursor}`);
                    const res = await robloxQueue.enqueue(badgeUrl, { timeout: 15000 });
                    const data = res.data;
                    if (!data) break;

                    const pageData = data.data || [];
                    if (attempts === 0) sampleBadges = pageData;
                    
                    total += pageData.length;
                    cursor = data.nextPageCursor;
                    
                    if (!cursor || pageData.length < 100) return { count: total, complete: true, sample: sampleBadges };
                    attempts++;
                }
                return { count: total, complete: false, sample: sampleBadges };
            } catch (e) {
                const failingUrl = e.config?.url || "Unknown";
                console.warn(`[INTEL] Badge Walker interrupted at ${total} [URL: ${failingUrl}]:`, e.message);
                return { count: total, complete: false, sample: sampleBadges };
            }
        })();

        const pinpointResult = await badgePinpointPromise;
        const finalBadgeCount = pinpointResult.complete ? pinpointResult.count : `${pinpointResult.count}+`;

        // 3. Fetch Core Data
        const [groupsRes, detailedRes, rotectorRes] = await Promise.all([
            robloxQueue.enqueue(rbApi('groups', `/v1/users/${userId}/groups/roles`), { timeout: 10000 }).catch(() => ({ data: { data: [] } })),
            robloxQueue.enqueue(rbApi('users', `/v1/users/${userId}`), { timeout: 10000 }).catch(() => ({ data: {} })),
            axios.get(`https://roscoe.rotector.com/v1/users/${userId}`, { timeout: 8000 }).catch(() => ({ data: null }))
        ]);

        // 4. Fetch ALL Outfits (Max 500 for high-volume personnel)
        let allRawOutfits = [];
        let outfitCursor = "";
        try {
            for(let i=0; i<10; i++) { // Fetch up to 500 outfits (10 pages of 50)
                const oRes = await robloxQueue.enqueue(rbApi('avatar', `/v1/users/${userId}/outfits?isEditable=true&itemsPerPage=50&cursor=${outfitCursor}`), { timeout: 10000 });
                allRawOutfits = allRawOutfits.concat(oRes.data.data || []);
                outfitCursor = oRes.data.nextPageCursor;
                if(!outfitCursor) break;
            }
        } catch(oErr) {
            console.warn("[INTEL] Outfit scan partial failure:", oErr.message);
        }

        const [avatarRes, bustRes] = await Promise.all([
            robloxQueue.enqueue(rbApi('thumbnails', `/v1/users/avatar?userIds=${userId}&size=420x420&format=Png&isCircular=false`)).catch(() => ({ data: { data: [{ imageUrl: "" }] } })),
            robloxQueue.enqueue(rbApi('thumbnails', `/v1/users/avatar-bust?userIds=${userId}&size=150x150&format=Png&isCircular=false`)).catch(() => ({ data: { data: [{ imageUrl: "" }] } }))
        ]);

        const groups = groupsRes.data?.data || [];
        const badgesSample = (pinpointResult.sample || []).slice(0, 24);
        
        // Process Icons
        let groupIcons = {};
        let badgeIcons = {};
        const groupIds = groups.map(g => g.group?.id).filter(id => id).slice(0, 100).join(',');
        const badgeIds = badgesSample.map(b => b.id).filter(id => id).slice(0, 50).join(',');

        if (groupIds) {
            const gIconRes = await robloxQueue.enqueue(rbApi('thumbnails', `/v1/groups/icons?groupIds=${groupIds}&size=150x150&format=Png&isCircular=false`)).catch(() => null);
            gIconRes?.data?.data?.forEach(i => groupIcons[i.targetId] = i.imageUrl);
        }
        if (badgeIds) {
            const bIconRes = await robloxQueue.enqueue(rbApi('thumbnails', `/v1/badges/icons?badgeIds=${badgeIds}&size=150x150&format=Png&isCircular=false`)).catch(() => null);
            bIconRes?.data?.data?.forEach(i => badgeIcons[i.targetId] = i.imageUrl);
        }

        // Process ALL Outfits thumbnails (Batching)
        // We can't batch more than 100 in thumbnails API
        let outfits = [];
        const outfitChunks = [];
        for (let i = 0; i < allRawOutfits.length; i += 100) {
            outfitChunks.push(allRawOutfits.slice(i, i + 100));
        }

        for (const chunk of outfitChunks) {
            const ids = chunk.map(o => o.id).join(',');
            try {
                const thumbRes = await robloxQueue.enqueue(rbApi('thumbnails', `/v1/users/outfits?userOutfitIds=${ids}&size=150x150&format=Png&isCircular=false`), { timeout: 15000 });
                chunk.forEach(o => {
                    const thumb = thumbRes.data?.data?.find(t => String(t.targetId) === String(o.id));
                    outfits.push({
                        id: o.id,
                        name: o.name || "UNNAMED OUTFIT",
                        thumbnail: (thumb && thumb.imageUrl) ? thumb.imageUrl : ROBLOX_FALLBACK_IMAGE
                    });
                });
            } catch(e) {
                 chunk.forEach(o => outfits.push({ id: o.id, name: o.name || "UNNAMED OUTFIT", thumbnail: ROBLOX_FALLBACK_IMAGE }));
            }
        }

        const condoKeywords = ["condo", "inappropriate", "banned", "blacklisted"];
        const isCondo = badgesSample.some(b => condoKeywords.some(kw => b.name.toLowerCase().includes(kw) || (b.description && b.description.toLowerCase().includes(kw))));

        const intelData = {
            userId: userId,
            username: userData.name,
            displayName: userData.displayName,
            created: detailedRes.data.created,
            description: detailedRes.data.description,
            isBanned: detailedRes.data.isBanned,
            avatar: avatarRes.data?.data?.[0]?.imageUrl || "",
            bust: bustRes.data?.data?.[0]?.imageUrl || "",
            outfits: outfits,
            groups: groups.map(g => ({
                id: g.group.id,
                name: g.group.name,
                rank: g.role.name,
                rankId: g.role.rank,
                icon: groupIcons[g.group.id] || ""
            })),
            badges: badgesSample.map(b => ({
                name: b.name,
                icon: badgeIcons[b.id] || ""
            })),
            badgeCount: finalBadgeCount,
            isCondoUser: isCondo,
            rotector: rotectorRes.data?.data || null,
            lastScanned: new Date()
        };

        // Update Cache
        await IntelCache.findOneAndUpdate({ userId }, intelData, { upsert: true, new: true });

        logAction(req.user, "DEEP_INTEL_SCRAPE", `**Subject:** ${userData.name}\n**ID:** ${userId}\n**Action:** ${forceRefresh ? "Full Refresh" : "First Scan"}`);
        res.json(intelData);

    } catch (err) {
        console.error("Deep Intel Error:", err.message);
        res.status(500).json({ message: "Uplink Failed" });
    }
});

// --- SINGLE OUTFIT RECON (Used by Bulk Sequential) ---
app.get('/outfits/:username', protectTier(2), async (req, res) => {
    try {
        const username = req.params.username.trim();
        const cursor = req.query.cursor || "";
        console.log(`[RECON] Fetching outfits for: ${username} (Cursor: ${cursor || 'START'})`);

        // 1. Resolve Identity
        const resolveRes = await robloxQueue.enqueue(
            rbApi('users', '/v1/usernames/users'),
            { timeout: 15000 },
            'post',
            { usernames: [username], excludeBannedUsers: false }
        );

        const user = resolveRes.data.data?.[0];
        if (!user) return res.status(404).json({ message: "Subject not found." });

        // 2. Fetch Outfits (Increased to 50 per page)
        const outfitRes = await robloxQueue.enqueue(
            rbApi('avatar', `/v1/users/${user.id}/outfits?isEditable=true&itemsPerPage=50&cursor=${cursor}`),
            { timeout: 10000 }
        );

        const rawOutfits = outfitRes.data?.data || [];
        const nextPageCursor = outfitRes.data?.nextPageCursor || null;
        const outfitIds = rawOutfits.map(o => o.id).join(',');

        let outfits = [];
        if (outfitIds) {
            const outfitThumbRes = await robloxQueue.enqueue(
                rbApi('thumbnails', `/v1/users/outfits?userOutfitIds=${outfitIds}&size=150x150&format=Png&isCircular=false`),
                { timeout: 15000 }
            );

            outfits = rawOutfits.map(o => {
                const thumb = outfitThumbRes.data?.data?.find(t => String(t.targetId) === String(o.id));
                let img = (thumb && thumb.imageUrl) 
                    ? thumb.imageUrl 
                    : ROBLOX_FALLBACK_IMAGE;
                return { id: o.id, name: o.name || "UNNAMED OUTFIT", thumbnail: img };
            });
        }

        res.json({
            username: user.name,
            displayName: user.displayName,
            userId: user.id,
            outfits: outfits,
            nextPageCursor: nextPageCursor
        });
    } catch (err) {
        const status = err.response?.status || 500;
        const msg = status === 429 ? "Uplink Congested (Rate Limit)" : "Uplink Failed";
        const details = err.response?.data ? JSON.stringify(err.response.data) : err.message;
        
        console.error(`[RECON] Failed for ${req.params.username}:`, {
            status,
            message: err.message,
            roblox_details: details
        });

        res.status(status).json({ 
            message: msg, 
            details: details,
            error_code: status
        });
    }
});

// --- OUTFIT ASSET INSPECTION (TECHNICAL RECON) ---
app.get('/api/outfit-details/:outfitId', protectTier(2), async (req, res) => {
    try {
        const { outfitId } = req.params;
        console.log(`[RECON] Technical Inspection initiated for Outfit: ${outfitId}`);

        // 1. Fetch Outfit Configuration
        const configRes = await robloxQueue.enqueue(
            rbApi('avatar', `/v1/outfits/${outfitId}/details`),
            { timeout: 10000 }
        );

        const data = configRes.data;
        if (!data) return res.status(404).json({ message: "Outfit configuration redacted or lost." });

        const assets = data.assets || [];
        const assetIds = assets.map(a => a.id).join(',');

        let resolvedAssets = [];
        if (assetIds) {
            // 2. Fetch Asset Thumbnails for visual identification
            const thumbRes = await robloxQueue.enqueue(
                rbApi('thumbnails', `/v1/assets?assetIds=${assetIds}&size=150x150&format=Png&isCircular=false`),
                { timeout: 10000 }
            );

            resolvedAssets = assets.map(a => {
                const thumb = thumbRes.data?.data?.find(t => String(t.targetId) === String(a.id));
                return {
                    id: a.id,
                    name: a.name || "UNNAMED COMPONENT",
                    assetType: a.assetType ? a.assetType.name : "UNKNOWN",
                    thumbnail: (thumb && thumb.imageUrl) ? thumb.imageUrl : ROBLOX_FALLBACK_IMAGE
                };
            });
        }

        // 3. Final Manifest
        res.json({
            outfitId,
            name: data.name || "CLASS-X UNKNOWN",
            assets: resolvedAssets,
            lastInspection: new Date()
        });

        // Audit Log
        logAction(req.user, "OUTFT_INSPECTION", `**Outfit:** ${data.name || outfitId}\n**Asset Count:** ${resolvedAssets.length}`);

    } catch (err) {
        console.error(`[RECON] Technical failure on Outfit ${req.params.outfitId}:`, err.message);
        res.status(err.response?.status || 500).json({ message: "Technical Uplink Failed", error: err.message });
    }
});

// --- BULK OUTFITS ROUTE (DEPRECATED IN FAVOR OF SEQUENTIAL CLIENT LOOP) ---
app.post('/bulk-outfits', protectTier(2), async (req, res) => {
    // Keeping for backward compatibility but client will now use /outfits/:username in a loop for progress bars
    res.status(410).json({ message: "Route deprecated. Use sequential uplink for progress tracking." });
});

// Form Webhook Endpoint
app.post('/api/v1/webhook/forms', async (req, res) => {
    try {
        const { formType, responses } = req.body;
        if (!formType || !responses) {
            return res.status(400).json({ error: 'Missing formType or responses' });
        }
        
        const newForm = new FormResponse({
            formType: formType.toLowerCase(),
            responses
        });
        await newForm.save();
        
        if (process.env.ADMIN_DISCORD_ID && process.env.DISCORD_BOT_TOKEN) {
            try {
                const dmRes = await axios.post('https://discord.com/api/v10/users/@me/channels', 
                    { recipient_id: process.env.ADMIN_DISCORD_ID }, 
                    { headers: { Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` } }
                );
                const channelId = dmRes.data.id;
                
                let desc = '';
                for (const [key, val] of Object.entries(responses)) {
                    desc += `**${key}**: ${val}\n`;
                }

                await axios.post(`https://discord.com/api/v10/channels/${channelId}/messages`, 
                    {
                        embeds: [{
                            title: `📄 New Form Submitted [${formType.toUpperCase()}]`,
                            description: desc.substring(0, 4000),
                            color: 0x00ff88,
                            timestamp: new Date().toISOString()
                        }]
                    },
                    { headers: { Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` } }
                );
            } catch (dmErr) {
                console.error('[DISCORD DM ERROR]', dmErr?.response?.data || dmErr.message);
            }
        }

        res.status(201).json({ success: true, message: 'Form submitted successfully.' });
    } catch (err) {
        console.error('[FORM WEBHOOK ERROR]', err);
        res.status(500).json({ error: 'Internal server error processing form.' });
    }
});


// Bot User Info Route
app.get('/api/v1/bot/user/:discordId', async (req, res) => {
    const authHeader = req.header('Authorization');
    if (!authHeader || authHeader !== `Bearer ${process.env.INTERNAL_BOT_API_KEY}`) {
        return res.status(401).json({ error: 'Unauthorized: Invalid internal API key.' });
    }
    try {
        const user = await User.findOne({ discordUserId: req.params.discordId });
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        res.json({ tier: user.tier, username: user.username });
    } catch (err) {
        console.error('[BOT API] Error fetching user:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Bot Pull Responses Route
app.get('/api/v1/bot/forms', async (req, res) => {

    const authHeader = req.header('Authorization');
    if (!authHeader || authHeader !== `Bearer ${process.env.INTERNAL_BOT_API_KEY}`) {
        return res.status(401).json({ error: 'Unauthorized: Invalid internal API key.' });
    }

    const { type, newest } = req.query;
    
    if (!type) return res.status(400).json({ error: 'Missing form type.' });

    try {
        const isNewest = newest === 'true';
        let query = FormResponse.find({ formType: type.toLowerCase() }).sort({ submittedAt: -1 });
        
        if (isNewest) {
            query = query.limit(1);
        } else {
            query = query.limit(10);
        }

        const forms = await query.exec();
        return res.json({ success: true, forms });
    } catch (err) {
        console.error('[BOT FORM PULL ERROR]', err);
        res.status(500).json({ error: 'Internal server error pulling forms.' });
    }
});

// Create User (Register)
app.post('/register', async (req, res) => {
    try {
        const { username, password, tier, division, unitScope } = req.body;
        
        // Storing as plain text as requested for admin oversight
        const newUser = new User({ 
            username: username, 
            password: password, 
            tier: tier, 
            division: division, 
            unitScope: unitScope 
        });
        await newUser.save();
        res.status(201).json({ message: "Operative created." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- ORBAT SYNC ROUTE ---
app.post('/sync-to-orbat', protectTier(3), async (req, res) => {
    try {
        const { officer, robloxId, discordId, unitId, rank, nsRank } = req.body;
        const sheets = getSheetsClient();
        
        if (!sheets) {
            return res.status(500).json({ message: "ORBAT Uplink Offline (Auth Error)" });
        }

        // Determine which sheet to write to
        let rawId = null;
        if (unitId === "288142915") rawId = process.env.GOOGLE_SHEET_ID_GSMC;
        else if (unitId === "423217030") rawId = process.env.GOOGLE_SHEET_ID_CBRN;
        else if (unitId === "1008942731") rawId = process.env.GOOGLE_SHEET_ID_NS;

        // Auto-extract ID if user provided full URL
        const spreadsheetId = rawId?.match(/\/d\/([a-zA-Z0-9-_]+)/)?.[1] || rawId?.trim();

        if (!spreadsheetId) {
            console.error(`[ORBAT] No Sheet ID found for Unit: ${unitId}`);
            return res.status(400).json({ message: "Target ORBAT Not Configured" });
        }

        console.log(`[ORBAT] Attempting Sync to: ${spreadsheetId.substring(0, 10)}... for ${officer}`);

        // Layout: A: Username, B: Roblox ID, C: Discord ID, D: Group Rank, E: NS Rank
        const values = [[
            officer, 
            String(robloxId), 
            String(discordId || "N/A"), 
            String(rank || "—"), 
            String(nsRank || "—")
        ]];

        await sheets.spreadsheets.values.append({
            spreadsheetId,
            range: 'ORBAT!A:E',
            valueInputOption: 'RAW',
            resource: { values }
        });

        // Audit Log
        logAction(req.user, "ORBAT_SYNC", `**Officer:** ${officer}\n**Target Unit:** ${unitId}\n**Sheet ID:** ${spreadsheetId.substring(0, 15)}...`, 15158332);

        res.json({ success: true, message: "Uplink Successful" });
    } catch (err) {
        console.error("ORBAT Sync Error:", err.message);
        if (err.response?.data) console.error("Sheets API Details:", JSON.stringify(err.response.data));
        res.status(500).json({ error: "Sync Failed", details: err.message });
    }
});

// --- DISCORD INTELLIGENCE ROUTE ---
app.get('/discord-intel/:code', async (req, res) => {
    try {
        const { code } = req.params;
        // Fetch invite data with member counts
        const response = await axios.get(`https://discord.com/api/v10/invites/${code}?with_counts=true&with_expiration=true`);
        res.json(response.data);
    } catch (err) {
        console.error(`[DISCORD] Failed to fetch intel for ${req.params.code}:`, err.message);
        res.status(err.response?.status || 500).json({ 
            message: "Discord Uplink Failed", 
            error: err.response?.data || err.message 
        });
    }
});

// --- ACCOUNT MANAGEMENT (TIER 3+) ---
app.get('/admin/users', protectTier(3), async (req, res) => {
    try {
        const overrideKey = req.header('x-override-key');
        const masterKey = process.env.OVERRIDE_KEY;
        const showPasswords = masterKey && overrideKey === masterKey;

        const projection = showPasswords ? '' : '-password';
        const users = await User.find({}, projection);
        
        // Map users to include a "passwordStatus" for frontend indicator
        const sanitizedUsers = users.map(u => {
            const userObj = u.toObject();
            if (!showPasswords) {
                userObj.password = "[SECURED]";
            }
            return userObj;
        });

        res.json(sanitizedUsers);
    } catch (err) {
        res.status(500).json({ error: "Failed to retrieve personnel files." });
    }
});

app.post('/admin/users', protectTier(3), async (req, res) => {
    try {
        const { username, password, tier, unitScope } = req.body;
        
        // Security Check: You can only create users with a tier strictly LOWER than yours
        if (tier >= req.user.tier) {
            return res.status(403).json({ message: "Security Violation: Cannot create an operative with equal or higher clearance." });
        }

        const existing = await User.findOne({ username });
        if (existing) return res.status(400).json({ message: "Username already active in sector." });

        const newUser = new User({
            username,
            password: password, // Storing as plain text
            tier: parseInt(tier),
            unitScope
        });

        await newUser.save();
        logAction(req.user, "USER_DEPLOYED", `**New Unit:** ${username}\n**Clearance:** Tier ${tier}\n**Scope:** ${unitScope}`, 3066993);
        
        res.status(201).json({ message: "Operative deployed successfully." });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/admin/users/:id', protectTier(3), async (req, res) => {
    try {
        const targetId = req.params.id;
        const targetUser = await User.findById(targetId);

        if (!targetUser) return res.status(404).json({ message: "Target not found." });

        // Security Check: You can only delete users with a tier strictly LOWER than yours
        if (targetUser.tier >= req.user.tier) {
            return res.status(403).json({ message: "Security Violation: Cannot decommission higher or equal clearance personnel." });
        }

        await User.findByIdAndDelete(targetId);
        logAction(req.user, "USER_DECOMMISSIONED", `**Target:** ${targetUser.username}\n**Clearance:** Tier ${targetUser.tier}`, 15158332);
        
        res.json({ message: "Operative decommissioned." });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- TOOLKIT MEDIA DOWNLOADER ---
app.post('/api/toolkit/yt-download', protectTier(2), async (req, res) => {
    const { url, isAudioOnly, browser } = req.body;
    if (!url) {
        return res.status(400).json({ success: false, message: "Media URL is required." });
    }

    try {
        console.log(`[TOOLKIT] Initiating local yt-dlp extraction for URL: ${url} (isAudioOnly: ${isAudioOnly})`);
        
        const fsSync = require('fs');
        const hasCookiesFile = fsSync.existsSync(path.join(__dirname, 'cookies.txt')) || fsSync.existsSync('./cookies.txt');

        const options = {
            dumpSingleJson: true,
            noWarnings: true,
            preferFreeFormats: true,
            format: isAudioOnly ? 'bestaudio[ext=m4a]/bestaudio/best' : 'bv*+ba/b'
        };

        if (hasCookiesFile) {
            options.cookies = './cookies.txt';
        } else {
            let browserVal = browser;
            if (!browserVal) {
                if (process.platform === 'win32') {
                    browserVal = 'chrome';
                } else if (process.platform === 'linux') {
                    browserVal = 'firefox';
                }
            }
            if (browserVal) {
                options.cookiesFromBrowser = browserVal;
            }
        }

        const output = await youtubedl(url, options);

        let directUrl = output.url;
        if (!directUrl && output.formats) {
            // Find the highest quality stream that contains both a video codec AND an audio codec combined
            const combinedStream = [...output.formats]
                .reverse()
                .find(f => f.vcodec !== 'none' && f.acodec !== 'none' && f.url);
            
            directUrl = combinedStream ? combinedStream.url : output.formats[output.formats.length - 1].url;
        }

        if (!directUrl) {
            return res.status(500).json({ success: false, message: "Could not resolve a direct media stream URL." });
        }

        logAction(req.user, "MEDIA_EXPORT", `**URL:** ${url}\n**Type:** ${isAudioOnly ? 'AUDIO (MP3)' : 'VIDEO (MP4)'}\n**Title:** ${output.title || 'N/A'}`);

        res.json({
            status: "redirect",
            url: directUrl,
            title: output.title || "download"
        });
    } catch (err) {
        console.error(`[TOOLKIT] Local extraction failure:`, err.message);
        let errorMsg = `Extraction failed: ${err.message}`;
        const lowerErr = err.message ? err.message.toLowerCase() : "";
        if (lowerErr.includes("sign in") || lowerErr.includes("bot") || lowerErr.includes("confirm you")) {
            errorMsg += " Authentication wall encountered. Drop a Netscape-formatted 'cookies.txt' file into your toolkit backend root folder to bypass.";
        }
        res.status(500).json({
            success: false,
            message: errorMsg
        });
    }
});

// --- BOXEDWINE GAME DOWNLOADER PROTOCOLS ---
const GAMES_DIR = path.join(__dirname, 'public', 'boxedwine', 'games');
const activeDownloads = {};

// Ensure games directory exists
const fsExtra = require('fs');
if (!fsExtra.existsSync(GAMES_DIR)) {
    fsExtra.mkdirSync(GAMES_DIR, { recursive: true });
}

// 1. List games inside the VM storage
app.get('/api/games', async (req, res) => {
    try {
        const files = await fs.readdir(GAMES_DIR);
        const zips = files.filter(f => f.toLowerCase().endsWith('.zip'));
        const gamesList = [];
        
        for (const file of zips) {
            const stats = await fs.stat(path.join(GAMES_DIR, file));
            gamesList.push({
                name: file,
                size: (stats.size / (1024 * 1024)).toFixed(1) + " MB",
                sizeInBytes: stats.size,
                downloadedAt: stats.mtime
            });
        }
        res.json({ games: gamesList });
    } catch (err) {
        res.status(500).json({ error: "Failed to list games", details: err.message });
    }
});

// 2. Download status
app.get('/api/games/download-status', (req, res) => {
    res.json(activeDownloads);
});

// 3. Delete downloaded game
app.delete('/api/games/:filename', async (req, res) => {
    try {
        const filename = req.params.filename;
        if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
            return res.status(400).json({ error: "Invalid filename" });
        }
        const filePath = path.join(GAMES_DIR, filename);
        await fs.unlink(filePath);
        res.json({ success: true, message: `Removed ${filename}` });
    } catch (err) {
        res.status(500).json({ error: "Failed to delete game", details: err.message });
    }
});

// 4. Download a game from URL directly to server storage
app.post('/api/games/download', async (req, res) => {
    const { url, filename } = req.body;
    if (!url) {
        return res.status(400).json({ error: "URL is required" });
    }
    
    let targetName = filename ? filename.trim() : "";
    if (!targetName) {
        try {
            const parsed = new URL(url);
            const pathname = parsed.pathname;
            const lastPart = pathname.substring(pathname.lastIndexOf('/') + 1);
            targetName = lastPart ? decodeURIComponent(lastPart) : "game.zip";
        } catch (e) {
            targetName = "game.zip";
        }
    }
    
    if (!targetName.toLowerCase().endsWith('.zip')) {
        targetName += ".zip";
    }
    
    if (targetName.includes('..') || targetName.includes('/') || targetName.includes('\\')) {
        return res.status(400).json({ error: "Invalid target filename" });
    }
    
    const targetPath = path.join(GAMES_DIR, targetName);
    
    if (activeDownloads[targetName] && activeDownloads[targetName].status === 'downloading') {
        return res.status(400).json({ error: `Download of ${targetName} is already in progress` });
    }
    
    activeDownloads[targetName] = {
        progress: 0,
        total: 0,
        downloaded: 0,
        status: 'queued',
        error: null
    };
    
    res.json({ 
        success: true, 
        message: `Download of '${targetName}' initiated in background on VM server.`,
        targetFile: targetName
    });
    
    (async () => {
        try {
            activeDownloads[targetName].status = 'downloading';
            
            const response = await axios({
                method: 'get',
                url: url,
                responseType: 'stream',
                timeout: 300000 
            });
            
            const totalBytes = parseInt(response.headers['content-length'] || '0', 10);
            activeDownloads[targetName].total = totalBytes;
            
            const writer = require('fs').createWriteStream(targetPath);
            let downloadedBytes = 0;
            
            response.data.on('data', (chunk) => {
                downloadedBytes += chunk.length;
                activeDownloads[targetName].downloaded = downloadedBytes;
                if (totalBytes > 0) {
                    activeDownloads[targetName].progress = Math.round((downloadedBytes / totalBytes) * 100);
                } else {
                    activeDownloads[targetName].progress = -1; 
                }
            });
            
            response.data.pipe(writer);
            
            await new Promise((resolve, reject) => {
                writer.on('finish', resolve);
                writer.on('error', (err) => {
                    writer.close();
                    reject(err);
                });
            });
            
            activeDownloads[targetName].status = 'completed';
            activeDownloads[targetName].progress = 100;
            console.log(`[DOWNLOAD] Successfully downloaded game zip to server storage: ${targetName}`);
        } catch (downloadErr) {
            console.error(`[DOWNLOAD] Failed downloading ${targetName}:`, downloadErr.message);
            activeDownloads[targetName].status = 'failed';
            activeDownloads[targetName].error = downloadErr.message;
            try {
                const fsSync = require('fs');
                if (fsSync.existsSync(targetPath)) {
                    fsSync.unlinkSync(targetPath);
                }
            } catch (cleanupErr) {}
        }
    })();
});

// --- SYSTEM LOGS ---
app.get('/health', (req, res) => {
    res.json({
        status: "OPERATIONAL",
        uptime: process.uptime(),
        database: mongoose.connection.readyState === 1 ? "ONLINE" : "OFFLINE",
        timestamp: new Date().toISOString()
    });
});

app.get('/system/version-log', async (req, res) => {
    try {
        const data = await fs.readFile(path.join(__dirname, 'version-log.json'), 'utf8');
        res.json(JSON.parse(data));
    } catch (err) {
        res.json([{ version: "V.1", date: "Unknown", notes: ["System Active"] }]);
    }
});

// --- EMULATOR GAME ENVIRONMENT UPLINKS ---
app.get('/cdn.dos.zone_custom_dos_doom.jsdos', (req, res) => {
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Encoding', 'identity');
    res.sendFile(path.join(__dirname, 'cdn.dos.zone_custom_dos_doom.jsdos'));
});

app.get('/cdn.dos.zone_custom_dos_nethack.jsdos', (req, res) => {
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Encoding', 'identity');
    res.sendFile(path.join(__dirname, 'public', 'cdn.dos.zone_custom_dos_nethack.jsdos'));
});

app.get('/cdn.dos.zone_custom_dos_tetris____.jsdos', (req, res) => {
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Encoding', 'identity');
    res.sendFile(path.join(__dirname, 'public', 'cdn.dos.zone_custom_dos_tetris____.jsdos'));
});

const PORT = process.env.PORT || 3000;

if (require.main === module) {
    server.listen(PORT, '0.0.0.0', () => {
        console.log(`GSMC Terminal active on port ${PORT}`);
    });
}

module.exports = app;