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

// 1. Models
const User = require(path.join(__dirname, 'models', 'User.js')); 
const Division = require(path.join(__dirname, 'models', 'divisions.js'));
const IntelCache = require(path.join(__dirname, 'models', 'IntelCache.js'));

const rbApi = (subdomain, endpoint) => {
    // Using rotunnel.com as per commander directive for enhanced rate-limit bypass
    return `https://${subdomain}.rotunnel.com${endpoint}`;
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
app.use(express.static(path.join(__dirname, 'public')));

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

            if (this.queue.length > 0) {
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
                    const thumb = thumbRes.data?.data?.find(t => t.targetId === o.id);
                    outfits.push({
                        id: o.id,
                        name: o.name || "UNNAMED OUTFIT",
                        thumbnail: (thumb && thumb.state === 'Completed') ? thumb.imageUrl : "https://tr.rbxcdn.com/38c6edcf096a30366bc90e9d68a2d1d4/150/150/Avatar/Png"
                    });
                });
            } catch(e) {
                 chunk.forEach(o => outfits.push({ id: o.id, name: o.name || "UNNAMED OUTFIT", thumbnail: "https://tr.rbxcdn.com/38c6edcf096a30366bc90e9d68a2d1d4/150/150/Avatar/Png" }));
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
                const thumb = outfitThumbRes.data?.data?.find(t => t.targetId === o.id);
                let img = (thumb && thumb.state === 'Completed' && thumb.imageUrl) 
                    ? thumb.imageUrl 
                    : "https://tr.rbxcdn.com/38c6edcf096a30366bc90e9d68a2d1d4/150/150/Avatar/Png";
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
                const thumb = thumbRes.data?.data?.find(t => t.targetId === a.id);
                return {
                    id: a.id,
                    name: a.name || "UNNAMED COMPONENT",
                    assetType: a.assetType ? a.assetType.name : "UNKNOWN",
                    thumbnail: (thumb && thumb.state === 'Completed') ? thumb.imageUrl : "https://tr.rbxcdn.com/38c6edcf096a30366bc90e9d68a2d1d4/150/150/Avatar/Png"
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
    const { url, type, resolution } = req.body;
    if (!url) {
        return res.status(400).json({ success: false, message: "Media URL is required." });
    }

    console.log(`[TOOLKIT] Media download request received for: ${url} (Type: ${type}, Resolution: ${resolution})`);

    const COBALT_SERVERS = [
        'https://api.cobalt.tools/api/json',
        'https://cobalt.api.ryg.me/api/json'
    ];

    let lastError = null;

    for (const serverUrl of COBALT_SERVERS) {
        try {
            console.log(`[TOOLKIT] Attempting conversion on Cobalt server: ${serverUrl}`);
            const payload = {
                url: url,
                videoQuality: resolution || "720",
                isAudioOnly: type === "mp3"
            };

            const response = await axios.post(serverUrl, payload, {
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) VanguardTerminal/4.2.0'
                },
                timeout: 15000
            });

            if (response.data && (response.data.url || response.data.picker || response.data.status === 'stream')) {
                console.log(`[TOOLKIT] Tactical Uplink Succeeded on ${serverUrl}`);
                logAction(req.user, "MEDIA_EXPORT", `**URL:** ${url}\n**Type:** ${type.toUpperCase()}\n**Qual:** ${resolution || 'N/A'}`);
                return res.json({
                    success: true,
                    data: response.data
                });
            } else if (response.data && response.data.text) {
                console.warn(`[TOOLKIT] Server returned error status: ${response.data.text}`);
                lastError = response.data.text;
            } else {
                console.warn(`[TOOLKIT] Unexpected payload structure:`, response.data);
                lastError = "Invalid response schema.";
            }
        } catch (err) {
            console.warn(`[TOOLKIT] Server ${serverUrl} failed:`, err.message);
            lastError = err.response?.data?.text || err.message;
        }
    }

    // Attempted all servers, none succeeded
    res.status(502).json({
        success: false,
        message: `Tactical conversion rejected on all servers. Detail: ${lastError || "Unknown connection error"}`
    });
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

// --- DOOM SIMULATION ENVIRONMENT UPLINK ---
app.get('/cdn.dos.zone_custom_dos_doom.jsdos', (req, res) => {
    res.sendFile(path.join(__dirname, 'cdn.dos.zone_custom_dos_doom.jsdos'));
});

const PORT = process.env.PORT || 3000;

if (require.main === module) {
    server.listen(PORT, '0.0.0.0', () => {
        console.log(`GSMC Terminal active on port ${PORT}`);
    });
}

module.exports = app;